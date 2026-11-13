// Stopping: base.win deletes its calendar from the person's Google account
// before it lets go, whenever it can.
//
//   gcal.stop   every 'stopping' link of the campaign (one person's Stop, the
//               switch going off, someone removed who is on another campaign
//               here): DELETE the calendar with a usable grant (this
//               campaign's, else another where they are still a member),
//               then the link goes; with no link left on this server, the
//               Calendar purpose leaves the grant (GSI's dropPurpose, which
//               revokes only when nothing else is left). No usable grant:
//               'left' for a member (the card says so), else forgotten.
//   cleanUp     GSI's onRevoke for 'calendar.mine': called by GSI's job with
//               the token before it is revoked or forgotten, whatever took
//               the purpose away; fetch null when the token can't be used.
import { runAction } from '../../lib/events.js';
import { enqueueJob } from '../../lib/jobs.js';
import { dropPurpose, googleFetch, grantFor } from '../../lib/google/tokens.js';
import { calBase } from './google.js';
import { PURPOSE, SAID } from './push.js';

const MAX_ATTEMPTS = 5; // lib/jobs.js
const RUN_MS = 60_000;
const RUN_CALLS = 200;
const enc = encodeURIComponent;
const done = (status) => (status >= 200 && status < 300) || status === 404 || status === 410;

const isMember = async (q, ws, userId) => Boolean((await q.query(
  'select 1 from memberships where workspace_id = $1 and user_id = $2', [ws, userId],
)).rows[0]);

// The link goes (its items with it), on the campaign's log.
export const forgetLink = (db, ws, userId, action) => runAction(db, { workspaceId: ws, actorId: userId, action }, async (tx, emit) => {
  const n = await tx.query('delete from gcal_links where workspace_id = $1 and user_id = $2', [ws, userId]);
  if (n.affectedRows) emit('gcal_link', userId, 'void', {});
});

// Base.win can't reach the calendar: a member is told; anyone else's link
// is forgotten. Inside a write already (q is a tx), the caller emits.
export const leaveLink = async (db, ws, userId, action) => {
  if (await isMember(db, ws, userId)) {
    await runAction(db, { workspaceId: ws, actorId: null, action }, async (tx, emit) => {
      const n = await tx.query(
        `update gcal_links set state = 'left', said = $3, dirty_at = null, busy_until = null, updated_at = now()
          where workspace_id = $1 and user_id = $2 and state <> 'left'`,
        [ws, userId, SAID.left],
      );
      await tx.query('delete from gcal_items where workspace_id = $1 and user_id = $2', [ws, userId]);
      if (n.affectedRows) emit('gcal_link', userId, 'update', { state: 'left' });
    });
  } else {
    await forgetLink(db, ws, userId, action);
    console.warn('gcal: calendar left in Google for a removed member');
  }
};

// A grant that can still reach Google for this person: this campaign's,
// else one through another campaign they are still on.
const usableGrant = async (db, ws, userId) => {
  const here = await grantFor(db, { userId, workspaceId: ws }, PURPOSE);
  if (here?.state === 'ok') return here;
  if (!here) return null;
  const others = (await db.query('select workspace_id from memberships where user_id = $1 and workspace_id <> $2', [userId, ws])).rows;
  for (const o of others) {
    const g = await grantFor(db, { userId, workspaceId: o.workspace_id }, PURPOSE);
    if (g?.state === 'ok') return g;
  }
  return null;
};

const stopRun = async (db, job) => {
  const ws = job.workspace_id;
  const last = Number(job.attempts) >= MAX_ATTEMPTS;
  const started = Date.now();
  let calls = 0;
  let retry = false;
  const links = (await db.query(
    `select user_id, calendar_id from gcal_links where workspace_id = $1 and state = 'stopping' order by updated_at`, [ws],
  )).rows;
  for (const link of links) {
    if (calls >= RUN_CALLS || Date.now() - started >= RUN_MS) {
      await db.transaction((tx) => enqueueJob(tx, { workspaceId: ws, kind: 'gcal.stop', runAt: new Date(Date.now() + 1000).toISOString(), key: `gcal-stop-${job.id}-more` }));
      break;
    }
    const grant = await usableGrant(db, ws, link.user_id);
    if (!grant) { await leaveLink(db, ws, link.user_id, 'gcal.stop'); continue; }
    if (link.calendar_id) {
      calls += 1;
      const r = await googleFetch(db, grant, `${calBase()}/calendars/${enc(link.calendar_id)}`, { method: 'DELETE' }, { retry: 'auth-only' });
      if (!r.ok && !done(r.status)) {
        const transient = !r.trouble || ['unavailable', 'paused', 'client'].includes(r.trouble.code);
        if (transient && !last) { retry = true; continue; }
        await leaveLink(db, ws, link.user_id, 'gcal.stop');
        continue;
      }
    }
    await forgetLink(db, ws, link.user_id, 'gcal.stop');
    const more = (await db.query('select 1 from gcal_links where user_id = $1 limit 1', [link.user_id])).rows[0];
    if (!more) await dropPurpose(db, { workspaceId: ws, actorId: link.user_id }, grant, PURPOSE);
  }
  if (retry) throw new Error('gcal: Google didn’t answer; trying again');
};

export const stopJobs = { 'gcal.stop': (db, job) => ({ later: stopRun(db, job) }) };

// GSI's onRevoke. db is the plain database from GSI's job; GSI calls it with
// a transaction (and fetch null) only on a server that runs no jobs, inside
// the write that took the purpose away — there the hook (hook.js) has
// already said what happened on the log, so this only tidies the rows.
export const cleanUp = async (db, { userId, fetch }) => {
  const inWrite = typeof db.transaction !== 'function';
  const links = (await db.query('select workspace_id, calendar_id from gcal_links where user_id = $1', [userId])).rows;
  for (const link of links) {
    const ws = link.workspace_id;
    if (inWrite) {
      if (link.calendar_id && await isMember(db, ws, userId)) {
        await db.query(`update gcal_links set state = 'left', said = $3, dirty_at = null where workspace_id = $1 and user_id = $2`, [ws, userId, SAID.left]);
        await db.query('delete from gcal_items where workspace_id = $1 and user_id = $2', [ws, userId]);
      } else await db.query('delete from gcal_links where workspace_id = $1 and user_id = $2', [ws, userId]);
      continue;
    }
    if (link.calendar_id && fetch) {
      // A timeout or a 5xx throws: GSI's job is tried again.
      const r = await fetch(`${calBase()}/calendars/${enc(link.calendar_id)}`, { method: 'DELETE' });
      if (r.status >= 500) throw new Error(`gcal: Google answered ${r.status} deleting a calendar`);
      if (!done(r.status)) { await leaveLink(db, ws, userId, 'gcal.cleanup'); continue; }
    } else if (link.calendar_id) {
      await leaveLink(db, ws, userId, 'gcal.cleanup');
      continue;
    }
    await forgetLink(db, ws, userId, 'gcal.cleanup');
  }
};
