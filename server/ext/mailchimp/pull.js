// Mailchimp → base.win: who left there, and whose address died there.
//
//   unsubscribed  → email is off here for everyone with that address
//                   (emailOff: off the newsletter list, or do-not-email, and
//                   a no on the consent record, source mailchimp-unsubscribe)
//                   — unless they have said yes HERE THEMSELVES since they
//                   left there (the website's box, their own link): a newer
//                   yes of their own is never undone by an older no.
//   cleaned       → the address goes on the suppression list (ext/mail): it
//                   bounced for good at Mailchimp; nothing emails it again.
// Only addresses this campaign holds are touched: nothing is kept about a
// stranger. Each change is on the event log as the system (mailchimp.pull),
// and none of them is told back to Mailchimp (optout.js skips this action).
//
// Three ways in, one rule — base.win reads the member itself and acts on
// that answer, never on a webhook's word:
//   the member job   a webhook was a hint about one address (webhook.js)
//   the daily job    everything changed since the last pull, less an hour;
//                    once a week, and the first time, everyone unsubscribed
//                    or cleaned — someone added here after they left there
//                    is found then
//   Pull now, and the start of every sync: everyone, now
import { runAction } from '../../lib/events.js';
import { enqueueJob } from '../../lib/jobs.js';
import { stillOn, suppress } from '../mail/webhook.js';
import { emailOff } from '../site/consent.js';
import { audienceId, lower, mailchimp, mailchimpOn, MailchimpError, memberHash, pages } from './mailchimp.js';

export const PULL_ACTION = 'mailchimp.pull';
export const PULL_JOB = 'mailchimp.pull';
export const MEMBER_JOB = 'mailchimp.member';
export const OPTOUT_JOB = 'mailchimp.optout';

const DAY_MS = 86400_000;
const SLACK_MS = 3600_000; // "since the last pull, less an hour": clocks differ, and a change may land late
const FULL_EVERY_MS = 7 * DAY_MS;
const DAILY_AT = '10:17:00'; // UTC: the small hours in British Columbia
const TOGETHER = 25; // addresses to one write, so the campaign's lock is never held long

// A member as Mailchimp answers it → what base.win reads of it.
const memberOf = (m, status = null) => ({ email: lower(m?.email_address), status: m?.status || status, changedAt: m?.last_changed || null });
// One member, read now. null: Mailchimp has no such address in the audience.
export const readMember = async (audience, email) => {
  try {
    return memberOf(await mailchimp('GET', `/lists/${audience}/members/${memberHash(email)}`, {
      query: { fields: 'email_address,status,unsubscribe_reason,last_changed' }, timeoutMs: 10_000,
    }));
  } catch (e) {
    if (e instanceof MailchimpError && e.httpStatus === 404) return null;
    throw e;
  }
};

// Of these addresses, the ones email is still on for here…
const stillOnAmong = async (db, ws, emails) => (emails.length ? (await db.query(
  `select e as email from unnest($2::text[]) e
    where exists (select 1 from subscriptions s where s.workspace_id = $1 and s.email = e and s.status <> 'unsubscribed')
       or (not exists (select 1 from subscriptions s where s.workspace_id = $1 and s.email = e)
           and exists (select 1 from persons p where p.workspace_id = $1 and lower(p.email) = e and p.deleted_at is null
                         and not (p.tags @> '"do-not-email"'::jsonb)))`, [ws, emails],
)).rows.map((r) => r.email) : []);
// …and the ones held here that aren't on the suppression list.
const HELD = `(exists (select 1 from persons p where p.workspace_id = $1 and lower(p.email) = e and p.deleted_at is null)
            or exists (select 1 from subscriptions s where s.workspace_id = $1 and s.email = e))`;
const heldUnsuppressed = async (db, ws, emails) => (emails.length ? (await db.query(
  `select e as email from unnest($2::text[]) e
    where ${HELD} and not exists (select 1 from email_suppressions x where x.workspace_id = $1 and x.email = e and x.lifted_at is null)`, [ws, emails],
)).rows.map((r) => r.email) : []);

// When the person last said yes to email here THEMSELVES: a yes on the
// consent record with the words they saw — a box they ticked on the
// campaign's website, or their own link from an email. An address the team
// typed in or imported is the team's word, not theirs, and never undoes
// their no.
const latestOwnYes = async (tx, ws, email) => (await tx.query(
  `select max(created_at) as at from consent_events
    where workspace_id = $1 and channel = 'email' and granted and wording is not null and address = $2`, [ws, email],
)).rows[0]?.at || null;
const after = (a, b) => new Date(a).getTime() > new Date(b).getTime();

// What Mailchimp says about one address, taken here (inside a write; every
// check is made again under the campaign's lock). → 'unsubscribed' |
// 'cleaned' | null (nothing to do)
const takeMember = async (tx, emit, ws, m) => {
  if (m.status === 'unsubscribed') {
    if (!(await stillOn(tx, ws, m.email))) return null;
    const yes = await latestOwnYes(tx, ws, m.email);
    if (yes && m.changedAt && !after(m.changedAt, yes)) return null;
    const who = (await tx.query(
      'select id from persons where workspace_id = $1 and lower(email) = $2 and deleted_at is null order by created_at, id limit 1', [ws, m.email],
    )).rows[0];
    await emailOff(tx, ws, { personId: who?.id || null, email: m.email, source: 'mailchimp-unsubscribe' }, emit);
    return 'unsubscribed';
  }
  if (m.status === 'cleaned') {
    const cur = (await tx.query('select lifted_at from email_suppressions where workspace_id = $1 and email = $2', [ws, m.email])).rows[0];
    // The desk put the address back after Mailchimp cleaned it: the desk's word stands.
    if (cur?.lifted_at && m.changedAt && !after(m.changedAt, cur.lifted_at)) return null;
    const changed = await suppress(tx, emit, ws, { email: m.email, reason: 'bounce', source: 'mailchimp', detail: 'Mailchimp cleaned it: it bounced for good there' });
    return changed ? 'cleaned' : null;
  }
  return null;
};

// Members as Mailchimp has them, taken in: first narrowed to the addresses
// a change could matter for (two reads), then a few to a write.
export const takeIn = async (db, ws, members) => {
  const by = new Map(members.filter((m) => m.email).map((m) => [m.email, m]));
  const of = (status) => [...by.values()].filter((m) => m.status === status).map((m) => m.email);
  const todo = [...await stillOnAmong(db, ws, of('unsubscribed')), ...await heldUnsuppressed(db, ws, of('cleaned'))].map((e) => by.get(e));
  const out = { unsubscribed: 0, cleaned: 0 };
  for (let i = 0; i < todo.length; i += TOGETHER) {
    const part = todo.slice(i, i + TOGETHER);
    const { result } = await runAction(db, { workspaceId: ws, actorId: null, action: PULL_ACTION }, async (tx, emit) => {
      const did = [];
      for (const m of part) did.push(await takeMember(tx, emit, ws, m));
      return did;
    });
    for (const d of result) if (d) out[d] += 1;
  }
  return out;
};

const plural = (n, one, many) => `${n.toLocaleString('en-CA')} ${n === 1 ? one : many}`;
const wordsFor = (out) => [
  out.unsubscribed ? `${out.unsubscribed.toLocaleString('en-CA')} unsubscribed` : null,
  out.cleaned ? plural(out.cleaned, 'dead address', 'dead addresses') : null,
].filter(Boolean).join(' · ') || 'Nothing new';
const said = (db, ws, ok, note) => db.query(
  `insert into mailchimp_state (workspace_id, pull_ok, pull_note) values ($1, $2, $3)
   on conflict (workspace_id) do update set pull_ok = excluded.pull_ok, pull_note = excluded.pull_note`, [ws, ok, String(note).slice(0, 300)],
);

// Read who left and whose address died, and take it in. → { unsubscribed,
// cleaned }: how many addresses were turned off here.
export const pull = async (db, ws, { full = false } = {}) => {
  const audience = await audienceId();
  const state = (await db.query('select * from mailchimp_state where workspace_id = $1', [ws])).rows[0];
  const known = state?.audience_id === audience && state.pulled_through && state.full_at;
  const everything = full || !known || Date.now() - new Date(state.full_at).getTime() > FULL_EVERY_MS;
  // As Mailchimp writes a time: 2026-11-10T17:35:00+00:00.
  const since = everything ? null : new Date(new Date(state.pulled_through).getTime() - SLACK_MS).toISOString().replace(/\.\d{3}Z$/, '+00:00');
  const started = new Date().toISOString();
  const out = { unsubscribed: 0, cleaned: 0 };
  for (const status of ['unsubscribed', 'cleaned']) {
    const rows = await pages(`/lists/${audience}/members`, 'members', {
      status, since_last_changed: since, fields: 'members.email_address,members.status,members.last_changed,total_items',
    });
    const got = await takeIn(db, ws, rows.map((m) => memberOf(m, status)).filter((m) => m.status === status));
    out.unsubscribed += got.unsubscribed;
    out.cleaned += got.cleaned;
  }
  await db.query(
    `insert into mailchimp_state (workspace_id, audience_id, pulled_through, full_at, pulled_at, pull_ok, pull_note)
     values ($1, $2, $3, $4, now(), true, $5)
     on conflict (workspace_id) do update set audience_id = excluded.audience_id, pulled_through = excluded.pulled_through,
       full_at = coalesce(excluded.full_at, case when mailchimp_state.audience_id = excluded.audience_id then mailchimp_state.full_at end),
       pulled_at = excluded.pulled_at, pull_ok = true, pull_note = excluded.pull_note`,
    [ws, audience, started, everything ? started : null, wordsFor(out)],
  );
  // Mailchimp is answering: an unsubscribe that could not be told to it earlier goes again.
  await db.query(
    `update jobs set status = 'pending', attempts = 0, run_at = now(), last_error = null, done_at = null
      where workspace_id = $1 and kind = $2 and status = 'failed'`, [ws, OPTOUT_JOB],
  );
  return out;
};

// ── The daily pull ──
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
// The next three days, each queued once (a key a campaign day): a run queues
// them before it does anything else, so one bad day never ends them.
export const queueDays = async (q, ws) => {
  for (let n = 1; n <= 3; n += 1) {
    const day = dayOf(Date.now() + n * DAY_MS);
    await enqueueJob(q, { workspaceId: ws, kind: PULL_JOB, runAt: `${day}T${DAILY_AT}Z`, payload: { day }, key: `${PULL_JOB}:${day}` });
  }
};
// Whether a pull is under way (or due): Pull now's "Pulling…".
export const pulling = async (q, ws) => (await q.query(
  `select 1 from jobs where workspace_id = $1 and kind = $2 and (status = 'running' or (status = 'pending' and run_at <= now())) limit 1`, [ws, PULL_JOB],
)).rows.length > 0;

// payload { day } (the daily one) or { full: true } (Pull now).
export const runPullJob = async (db, job) => {
  const ws = job.workspace_id;
  // Mailchimp was taken away: nothing to do, and no more days are queued.
  if (!mailchimpOn()) return;
  await queueDays(db, ws);
  try {
    await pull(db, ws, { full: Boolean(job.payload?.full) });
  } catch (e) {
    // Said on Settings → Services; the job runner tries again by itself.
    await said(db, ws, false, e instanceof MailchimpError ? e.message : 'The pull stopped part-way; it will be tried again');
    throw e;
  }
};

// ── One address a webhook was about ──
// An address changed in Mailchimp (upemail): noted on the log for the
// person who had the old one, once — and only when Mailchimp itself has the
// new address. The person here is not changed.
const noteAddress = async (db, ws, audience, { was, now }) => {
  if (!(await readMember(audience, now))) return;
  const people = (await db.query(
    'select id from persons where workspace_id = $1 and lower(email) = $2 and deleted_at is null order by created_at, id limit 20', [ws, was],
  )).rows;
  if (!people.length) return;
  await runAction(db, { workspaceId: ws, actorId: null, action: PULL_ACTION }, async (tx, emit) => {
    for (const p of people) {
      const seen = (await tx.query(
        `select 1 from events where workspace_id = $1 and entity_type = 'mailchimp_address' and entity_id = $2 and payload->>'now' = $3 limit 1`, [ws, p.id, now],
      )).rows.length;
      if (!seen) emit('mailchimp_address', p.id, 'update', { was, now });
    }
  });
};

// payload { email } or { was, now }.
export const runMemberJob = async (db, job) => {
  if (!mailchimpOn()) return;
  const p = job.payload || {};
  const audience = await audienceId();
  if (p.was && p.now) { await noteAddress(db, job.workspace_id, audience, { was: lower(p.was), now: lower(p.now) }); return; }
  const m = p.email ? await readMember(audience, p.email) : null;
  if (m) await takeIn(db, job.workspace_id, [m]);
};
