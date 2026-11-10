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
// What happened before Mailchimp was connected is not sent by itself
// (INTEGRATIONS.md says so): a list sent from here never includes them.
import { enqueueJob } from '../../lib/jobs.js';
import { audienceId, lower, mailchimp, mailchimpOn, memberHash } from './mailchimp.js';
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
const newlyOff = async (tx, ws, personId) => {
  const email = lower((await tx.query('select email from persons where id = $1 and workspace_id = $2 and deleted_at is null', [personId, ws])).rows[0]?.email);
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
      emails.add(await newlyOff(tx, ws, e.entityId) || '');
    }
  }
  emails.delete('');
  const all = [...emails];
  // No key: telling Mailchimp twice is harmless, and a job key can be used only once.
  for (let i = 0; i < all.length; i += PER_JOB) {
    await enqueueJob(tx, { workspaceId: ws, kind: OPTOUT_JOB, payload: { emails: all.slice(i, i + PER_JOB) } });
  }
};

// payload { emails }. Safe to run again from the start: someone already
// unsubscribed there is found so and left alone.
export const runOptoutJob = async (db, job) => {
  if (!mailchimpOn()) return;
  const audience = await audienceId();
  for (const email of job.payload?.emails || []) {
    const m = await readMember(audience, email);
    if (m?.status !== 'subscribed') continue;
    await mailchimp('PATCH', `/lists/${audience}/members/${memberHash(email)}`, {
      body: { status: 'unsubscribed' }, idempotencyKey: `base-mc-optout-${memberHash(email)}`, timeoutMs: 10_000,
    });
  }
};

// How many unsubscribes Mailchimp has not been told yet (it didn't answer,
// or refused): Settings → Services says so.
export const optoutsWaiting = async (q, ws) => (await q.query(
  `select coalesce(sum(jsonb_array_length(payload->'emails')), 0)::int as n from jobs
    where workspace_id = $1 and kind = $2 and (status = 'failed' or (status = 'pending' and attempts > 0))`, [ws, OPTOUT_JOB],
)).rows[0].n;
