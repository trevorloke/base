// Whose base.win calendar a write touched (lib/hooks.js events, inside the
// write and under the campaign's lock). It never calls Google: it marks
// links dirty and makes sure a push runs soon (push.js).
//
// In order: quiet writes and those of no watched kind cost one Set lookup;
// one read of the campaign; google_grant events (whatever else is linked —
// the first link of a campaign is made here); then, only with the switch on
// and someone linked, the people each event touches.
//
// The membership entity is shared with paid memberships (ext/membership,
// ext/payments): only member.* and permission.* actions count.
import { newId } from '../../lib/events.js';
import { enqueueJob } from '../../lib/jobs.js';
import { campaignOf, ensurePush, ensureSweep, PURPOSE, SAID } from './push.js';

const QUIET = new Set(['sample.load', 'sample.clear']);
const WATCH = new Set(['shift', 'shift_assignment', 'workspace', 'filing_dates', 'membership', 'candidate', 'person', 'google_grant']);
const EVERYONE = new Set(['workspace', 'filing_dates', 'candidate']);
const jobsOff = () => process.env.STARBASE_JOBS === 'off';

const counts = (ev, action) => {
  if (!WATCH.has(ev.entityType)) return false;
  if (ev.entityType === 'person') return ev.op === 'void' || Object.hasOwn(ev.payload || {}, 'email');
  if (ev.entityType === 'membership') return /^(member|permission)\./.test(action);
  return true;
};

const linkOf = async (tx, ws, userId) => (await tx.query(
  'select state from gcal_links where workspace_id = $1 and user_id = $2', [ws, userId],
)).rows[0] || null;

// A link that can't be kept up any more. With jobs, 'stopping' (GSI's job
// or gcal.stop deletes the calendar); without, what gcal.stop would leave.
const stopLink = async (tx, emit, ws, userId) => {
  if (!jobsOff()) {
    const n = await tx.query(
      `update gcal_links set state = 'stopping', dirty_at = null, updated_at = now()
        where workspace_id = $1 and user_id = $2 and state <> 'stopping' and state <> 'left'`, [ws, userId],
    );
    if (n.affectedRows) emit('gcal_link', userId, 'update', { state: 'stopping' });
    return;
  }
  const member = (await tx.query('select 1 from memberships where workspace_id = $1 and user_id = $2', [ws, userId])).rows[0];
  if (member) {
    const n = await tx.query(
      `update gcal_links set state = 'left', said = $3, dirty_at = null, updated_at = now()
        where workspace_id = $1 and user_id = $2 and state <> 'left'`, [ws, userId, SAID.left],
    );
    await tx.query('delete from gcal_items where workspace_id = $1 and user_id = $2', [ws, userId]);
    if (n.affectedRows) emit('gcal_link', userId, 'update', { state: 'left' });
  } else {
    const n = await tx.query('delete from gcal_links where workspace_id = $1 and user_id = $2', [ws, userId]);
    if (n.affectedRows) emit('gcal_link', userId, 'void', {});
  }
};

const grantEvent = async (tx, meta, ev, on) => {
  const ws = meta.workspaceId;
  const p = ev.payload || {};
  const userId = p.user_id;
  if (!userId) return false;
  const has = ev.op !== 'void' && Array.isArray(p.purposes) && p.purposes.includes(PURPOSE);
  const link = await linkOf(tx, ws, userId);
  if (!has) {
    // GSI took the purpose away (disconnect, forget, leaving): GSI's job
    // calls cleanUp while the token still works. Never 'reconnect'.
    if (link) await stopLink(tx, meta.emit, ws, userId);
    return false;
  }
  if (p.state === 'reconnect') {
    if (link?.state === 'ok') {
      const said = (await tx.query('select said from google_grants where user_id = $1', [userId])).rows[0]?.said || SAID.reconnect;
      await tx.query(`update gcal_links set state = 'reconnect', said = $3, updated_at = now() where workspace_id = $1 and user_id = $2`, [ws, userId, said]);
      meta.emit('gcal_link', userId, 'update', { state: 'reconnect' });
    }
    return false;
  }
  if (!link) {
    const member = (await tx.query('select 1 from memberships where workspace_id = $1 and user_id = $2', [ws, userId])).rows[0];
    if (!on || !member) return false;
    await tx.query(`insert into gcal_links (workspace_id, user_id, state, dirty_at) values ($1, $2, 'ok', now())`, [ws, userId]);
    meta.emit('gcal_link', userId, 'create', { state: 'ok' });
    return true;
  }
  if (link.state === 'reconnect' || link.state === 'ok') {
    await tx.query(`update gcal_links set state = 'ok', said = null, dirty_at = now(), updated_at = now() where workspace_id = $1 and user_id = $2`, [ws, userId]);
    if (link.state !== 'ok') meta.emit('gcal_link', userId, 'update', { state: 'ok' });
    return true;
  }
  return false;
};

// Linked users whose login email is one of these persons'.
const usersOfPersons = async (tx, ws, personIds) => (personIds.length ? (await tx.query(
  `select l.user_id from gcal_links l join users u on u.id = l.user_id
    where l.workspace_id = $1 and exists (
      select 1 from persons p where p.workspace_id = $1 and lower(p.email) = lower(u.email) and p.id = any($2::uuid[]))`,
  [ws, personIds],
)).rows.map((r) => r.user_id) : []);

const usersOfShifts = async (tx, ws, shiftIds) => (shiftIds.length ? (await tx.query(
  `select l.user_id from gcal_links l join users u on u.id = l.user_id
    where l.workspace_id = $1 and exists (
      select 1 from persons p join shift_assignments a on a.person_id = p.id and a.workspace_id = $1
       where p.workspace_id = $1 and lower(p.email) = lower(u.email) and a.shift_id = any($2::uuid[]))`,
  [ws, shiftIds],
)).rows.map((r) => r.user_id) : []);

const usersOfEmails = async (tx, ws, emails) => (emails.length ? (await tx.query(
  `select l.user_id from gcal_links l join users u on u.id = l.user_id
    where l.workspace_id = $1 and lower(u.email) = any($2::text[])`,
  [ws, emails.map((e) => String(e).toLowerCase())],
)).rows.map((r) => r.user_id) : []);

// Someone taken off the team: their calendar here is deleted. On no other
// campaign here, GSI's own hook deletes the grant and its job calls cleanUp;
// on another, gcal.stop deletes it through the grant from there.
const removed = async (tx, meta, userId) => {
  const ws = meta.workspaceId;
  if (!(await linkOf(tx, ws, userId))) return;
  const elsewhere = (await tx.query('select 1 from memberships where user_id = $1 limit 1', [userId])).rows[0];
  const has = Boolean((await tx.query('select 1 from google_grants where user_id = $1 and $2 = any(purposes)', [userId, PURPOSE])).rows[0]);
  if (!has && !jobsOff()) {
    // Nothing can reach the calendar: forgotten, as gcal.stop would.
    await tx.query('delete from gcal_links where workspace_id = $1 and user_id = $2', [ws, userId]);
    meta.emit('gcal_link', userId, 'void', {});
    return;
  }
  await stopLink(tx, meta.emit, ws, userId);
  if (has && elsewhere && !jobsOff()) await enqueueJob(tx, { workspaceId: ws, kind: 'gcal.stop', key: `gcal-stop-${newId()}` });
};

export const events = async (tx, meta, evs) => {
  if (QUIET.has(meta.action) || String(meta.action).startsWith('gcal.')) return;
  const mine = evs.filter((ev) => counts(ev, meta.action));
  if (!mine.length) return;
  const ws = meta.workspaceId;
  const c = (await tx.query(
    `select coalesce((settings->'gcal'->>'on')::boolean, false) as on,
            exists (select 1 from gcal_links where workspace_id = $1) as linked
       from workspaces where id = $1`, [ws],
  )).rows[0];
  if (!c) return;
  let push = false;
  for (const ev of mine) if (ev.entityType === 'google_grant') push = (await grantEvent(tx, meta, ev, c.on)) || push;
  const rest = mine.filter((ev) => ev.entityType !== 'google_grant');
  const users = new Set();
  if (rest.length && c.linked) {
    const persons = []; const shifts = []; const emails = [];
    let everyone = false;
    for (const ev of rest) {
      const p = ev.payload || {};
      if (ev.entityType === 'membership') {
        if (ev.op === 'void' && meta.action === 'member.remove') await removed(tx, meta, ev.entityId);
        else users.add(ev.entityId);
      } else if (!c.on) continue;
      else if (EVERYONE.has(ev.entityType)) everyone = true;
      else if (ev.entityType === 'shift') shifts.push(ev.entityId);
      else if (ev.entityType === 'shift_assignment') {
        let person = p.person_id || null;
        if (!person && ev.op === 'update') person = (await tx.query('select person_id from shift_assignments where id = $1 and workspace_id = $2', [ev.entityId, ws])).rows[0]?.person_id;
        // shift.unassign deletes the row first: its create event says whose.
        if (!person && ev.op === 'void') {
          person = (await tx.query(
            `select payload->>'person_id' as person_id from events
              where workspace_id = $1 and entity_type = 'shift_assignment' and entity_id = $2 and op = 'create' limit 1`,
            [ws, ev.entityId],
          )).rows[0]?.person_id;
        }
        if (person) persons.push(person);
      } else if (ev.entityType === 'person') {
        if (p.email) emails.push(p.email);
        if (ev.op === 'void') persons.push(ev.entityId);
      }
    }
    if (c.on) {
      if (everyone) for (const r of (await tx.query('select user_id from gcal_links where workspace_id = $1', [ws])).rows) users.add(r.user_id);
      for (const u of await usersOfShifts(tx, ws, shifts)) users.add(u);
      for (const u of await usersOfPersons(tx, ws, persons)) users.add(u);
      for (const u of await usersOfEmails(tx, ws, emails)) users.add(u);
    } else users.clear();
  }
  if (users.size) {
    const n = await tx.query(
      `update gcal_links set dirty_at = now() where workspace_id = $1 and user_id = any($2::uuid[]) and state = 'ok'`, [ws, [...users]],
    );
    if (n.affectedRows) push = true;
  }
  if (push && c.on) {
    await ensurePush(tx, ws);
    await ensureSweep(tx, ws, (await campaignOf(tx, ws)).tz);
  }
};
