// base.win → Mailchimp: someone said no here, so Mailchimp stops emailing
// them too. An events hook reads every write as it commits and queues a job
// for the addresses it turned off:
//   a subscription ended     (their unsubscribe link, a ladder's or a
//                            blast's, the desk's Remove)
//   a person was tagged      do-not-email or do-not-contact — or, already
//                            tagged, was given another address
//   an address was suppressed  (it bounced for good, or reported spam)
// The job looks the member up and, only if Mailchimp would still email them
// ("subscribed"), marks them unsubscribed there. An address Mailchimp does
// not have is never added to say no for it; one it cleaned or archived is
// left as it is. base.win never moves anyone in Mailchimp to subscribed —
// not here, not anywhere (a sync adds new addresses and never changes one
// already there).
// One address Mailchimp will not change never holds up the others: they are
// told, and the job keeps only who is still to tell — which is what Settings
// → Services counts, with Mailchimp's own words for why.
// What happened before Mailchimp was connected is not sent by itself
// (INTEGRATIONS.md says so): a list sent from here never includes them.
import { enqueueJob } from '../../lib/jobs.js';
import { audienceId, keyFor, lower, mailchimp, mailchimpOn, MailchimpError, memberHash } from './mailchimp.js';
import { OPTOUT_JOB, PULL_ACTION, readMember } from './pull.js';

const NO_EMAIL = 'do-not-email';
const NO_CONTACT = 'do-not-contact';
// Writes that never speak for a person: the sample campaign's made-up people.
const QUIET = new Set(['sample.load', 'sample.clear']);
const PER_JOB = 50;

const parseJ = (v) => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };
// A do-not tag counts whatever its capitals, as everywhere else (lib/reach.js).
const off = (tags) => Array.isArray(tags) && tags.some((t) => [NO_EMAIL, NO_CONTACT].includes(String(t).toLowerCase()));

// What was last written down about a person before this write: whether they
// were tagged do-not-email or do-not-contact, and their address. Read from
// the event log, where every change to a person's tags carries all of them
// and every change of address the new one — this write's own events join
// the log only after the hooks. (No "order by … limit": a person has a
// handful of these, found through the log's index by person.)
const before = async (tx, ws, personId) => {
  const rows = (await tx.query(
    `select seq, jsonb_typeof(payload->'tags') = 'array' as has_tags, payload->'tags' as tags,
            (payload->'email') is not null as has_email, payload->>'email' as email
       from events where workspace_id = $1 and entity_type = 'person' and entity_id = $2
        and (jsonb_typeof(payload->'tags') = 'array' or (payload->'email') is not null)`, [ws, personId],
  )).rows.sort((a, b) => Number(a.seq) - Number(b.seq));
  return { off: off(parseJ(rows.filter((r) => r.has_tags).at(-1)?.tags)), email: lower(rows.filter((r) => r.has_email).at(-1)?.email) };
};

// The person's address, when this write is what turned email off for it:
// the tag was put on (their own link, the desk, an import, a merge), or
// someone already tagged was given another address. Decided from what the
// person carried before the write and what they carry after it — never from
// the consent record, which is one line per person: a no from last year,
// with another address or under a tag the desk has since lifted, says
// nothing about today's.
// A change that says nothing new (another tag beside it, the same address
// again) is told to nobody: someone who has since said yes in Mailchimp
// itself is never taken off there by an edit here.
// `known`: what this write has already been seen to leave, by person.
const newlyOff = async (tx, ws, e, known) => {
  const p = e.payload || {};
  const fresh = e.op === 'create'; // someone new: all there is to know is in the event
  // Most writes cost nothing here: tags with neither of the two, or — for
  // someone already on file — no word on tags or on the address at all.
  if ((Array.isArray(p.tags) || fresh) ? !off(p.tags) : !p.email) return null;
  const row = (await tx.query('select email, tags from persons where id = $1 and workspace_id = $2 and deleted_at is null', [e.entityId, ws])).rows[0];
  const email = lower(row?.email);
  if (!email || !off(parseJ(row.tags))) return null;
  const was = fresh ? null : known.get(e.entityId) || await before(tx, ws, e.entityId);
  known.set(e.entityId, { off: true, email });
  return was?.off && was.email === email ? null : email;
};

export const onEvents = async (tx, meta, events) => {
  if (!mailchimpOn()) return;
  const action = String(meta.action || '');
  // What Mailchimp itself said needs no telling back.
  if (action === PULL_ACTION || QUIET.has(action)) return;
  const ws = meta.workspaceId;
  const emails = new Set();
  const known = new Map();
  for (const e of events) {
    const p = e.payload || {};
    if (e.entityType === 'subscription' && (e.op === 'void' || p.status === 'unsubscribed')) {
      emails.add(lower(p.email || (await tx.query('select email from subscriptions where id = $1 and workspace_id = $2', [e.entityId, ws])).rows[0]?.email));
    } else if (e.entityType === 'email_suppression' && (e.op === 'create' || e.op === 'update') && p.source !== 'mailchimp') {
      emails.add(lower(p.email));
    } else if (e.entityType === 'person' && (e.op === 'create' || e.op === 'update')) {
      emails.add(await newlyOff(tx, ws, e, known) || '');
    }
  }
  emails.delete('');
  const all = [...emails];
  // No key: telling Mailchimp twice is harmless, and a job key can be used only once.
  for (let i = 0; i < all.length; i += PER_JOB) {
    await enqueueJob(tx, { workspaceId: ws, kind: OPTOUT_JOB, payload: { emails: all.slice(i, i + PER_JOB) } });
  }
};

// A refusal about this one member (Mailchimp answered, and said no to the
// change) — not Mailchimp failing to answer, and not the key being refused.
const aboutThisOne = (e) => e instanceof MailchimpError && !e.retryable && ![401, 403].includes(e.httpStatus);

// payload { emails }. Safe to run again from the start: someone already
// unsubscribed there is found so and left alone.
// skip_merge_validation: an audience may insist on a field of its own (a
// last name, say) and refuse any change to a member without it. A no is
// never held back by that.
export const runOptoutJob = async (db, job) => {
  if (!mailchimpOn()) return;
  const audience = await audienceId();
  const emails = job.payload?.emails || [];
  const left = []; // who Mailchimp has still not been told about
  let why = null;
  for (const [i, email] of emails.entries()) {
    try {
      const m = await readMember(audience, email);
      if (m?.status !== 'subscribed') continue;
      try {
        await mailchimp('PATCH', `/lists/${audience}/members/${memberHash(email)}`, {
          query: { skip_merge_validation: true }, body: { status: 'unsubscribed' },
          idempotencyKey: keyFor('optout', job.id, lower(email)), timeoutMs: 10_000,
        });
      } catch (e) {
        if (!aboutThisOne(e)) throw e;
        // Only this one: the others are still told.
        left.push(email);
        why ||= e;
      }
    } catch (e) {
      // Mailchimp isn't answering (or refuses the key): everyone not yet told waits.
      left.push(...emails.slice(i));
      why = e;
      break;
    }
  }
  if (!why) return;
  // Kept on the job: only who is still to tell, so a later try asks about
  // nobody twice and the count on Settings → Services is the count.
  if (left.length !== emails.length) await db.query('update jobs set payload = $2 where id = $1', [job.id, JSON.stringify({ ...job.payload, emails: left })]);
  throw why;
};

// How many unsubscribes Mailchimp has not been told yet (it didn't answer,
// or refused): Settings → Services says so…
const WAITING = "kind = $2 and (status = 'failed' or (status = 'pending' and attempts > 0))";
export const optoutsWaiting = async (q, ws) => (await q.query(
  `select coalesce(sum(jsonb_array_length(payload->'emails')), 0)::int as n from jobs where workspace_id = $1 and ${WAITING}`, [ws, OPTOUT_JOB],
)).rows[0].n;
// …and why, in Mailchimp's words: what it last answered about one of them.
// (Only its words: anything else that stopped a job is not for this screen.)
export const optoutsWhy = async (q, ws) => {
  const said = (await q.query(
    `select last_error from jobs where workspace_id = $1 and ${WAITING} and last_error is not null
      order by coalesce(done_at, started_at) desc nulls last limit 1`, [ws, OPTOUT_JOB],
  )).rows[0]?.last_error;
  return said && /^Mailchimp\b/.test(said) ? said.slice(0, 300) : null;
};
