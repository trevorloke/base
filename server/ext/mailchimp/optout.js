// base.win → Mailchimp: someone said no here, so Mailchimp stops emailing
// them too. An events hook reads every write as it commits and queues a job
// for the addresses it turned off:
//   a subscription ended     (their unsubscribe link, a ladder's or a
//                            blast's, the desk's Remove)
//   a person was tagged      do-not-email or do-not-contact
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

// The person's address, when this write is what turned email off for them.
// A later change to someone already do-not-email carries the tag again and
// says nothing new: the consent record already has their no from before
// this write (now() is this write's start; its own rows come after).
const newlyOff = async (tx, ws, personId, given) => {
  const email = lower(given || (await tx.query('select email from persons where id = $1 and workspace_id = $2 and deleted_at is null', [personId, ws])).rows[0]?.email);
  if (!email) return null;
  const before = (await tx.query(
    `select granted from consent_events where workspace_id = $1 and person_id = $2 and channel = 'email' and created_at < now()
      order by created_at desc, id desc limit 1`, [ws, personId],
  )).rows[0];
  return before && before.granted === false ? null : email;
};

export const onEvents = async (tx, meta, events) => {
  if (!mailchimpOn()) return;
  const action = String(meta.action || '');
  // What Mailchimp itself said needs no telling back.
  if (action === PULL_ACTION || QUIET.has(action)) return;
  const ws = meta.workspaceId;
  const emails = new Set();
  for (const e of events) {
    const p = e.payload || {};
    if (e.entityType === 'subscription' && (e.op === 'void' || p.status === 'unsubscribed')) {
      emails.add(lower(p.email || (await tx.query('select email from subscriptions where id = $1 and workspace_id = $2', [e.entityId, ws])).rows[0]?.email));
    } else if (e.entityType === 'email_suppression' && (e.op === 'create' || e.op === 'update') && p.source !== 'mailchimp') {
      emails.add(lower(p.email));
    } else if (e.entityType === 'person' && (e.op === 'create' || e.op === 'update') && Array.isArray(p.tags)
      && (p.tags.includes(NO_EMAIL) || p.tags.includes(NO_CONTACT))) {
      emails.add(await newlyOff(tx, ws, e.entityId, p.email) || '');
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
