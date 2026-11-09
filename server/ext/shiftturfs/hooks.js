// The events hook: every write's events, inside its transaction (lib/events.js
// runAction), before they are chained. What the core emits, and what follows:
//
//   shift_assignment create   shift.assign { id, shift_id, person_id } (no
//                             status: the column's default, 'assigned');
//                             shift.join { …, status: 'confirmed', self: true };
//                             the sample { shift_id, person_id, sample: true }
//                             → on the shift's turfs, if it has any
//   shift_assignment update   shift.join { status: 'confirmed', self: true },
//                             shift.leave { status: 'declined', self: true },
//                             shift.setStatus { status }
//                             → assigned / confirmed: on; declined / no_show: off
//   shift_assignment void     shift.unassign (the row is already deleted;
//                             payload {}, entityId = the assignment id), the
//                             sample clearing → off (and off the crew board)
//   shift_assignment update   shift.place { placed, job } (no status): the
//                             action itself moved the walk lists
//   turf void                 turf.delete → the turf leaves every shift (the
//                             crew placed on it: not placed again)
//   turf update               turf.assign { assigned } / turf.unassign
//                             { unassigned } by hand → that membership is the
//                             desk's from now on (handOver)
//   membership create         someone joined the campaign → the turfs of the
//                             shifts they were already booked on
//   membership void           member.remove (it took their turfs) → forget
//                             what their shifts held
// "self" means the signed-in person acted for themselves (meta.actorId);
// otherwise the shift's person is matched to an app sign-in by login email.
import { loginEmail } from '../../lib/viewer.js';
import { ACTIVE, GONE, handOver, putOn, takeOff, unplaceFrom, userForPerson } from './walkers.js';

const hasTurfs = async (tx, ws, shiftId) => Boolean((await tx.query(
  'select 1 from shift_turfs where workspace_id = $1 and shift_id = $2 limit 1', [ws, shiftId],
)).rows[0]);

const onAssignment = async (tx, meta, e) => {
  const ws = meta.workspaceId;
  const p = e.payload || {};
  if (e.op === 'void') {
    await takeOff(tx, ws, { assignmentId: e.entityId }, meta.emit);
    await tx.query('delete from shift_crew where workspace_id = $1 and assignment_id = $2', [ws, e.entityId]);
    return;
  }
  if (e.op === 'create') {
    // The sample's shifts and shifts with no turfs cost one lookup.
    if (!p.shift_id || !(await hasTurfs(tx, ws, p.shift_id))) return;
    const status = p.status ?? 'assigned';
    if (!ACTIVE.includes(status)) return;
    const userId = p.self ? meta.actorId : await userForPerson(tx, ws, p.person_id);
    if (userId) await putOn(tx, ws, { assignmentId: e.entityId, shiftId: p.shift_id, userId }, meta.emit);
    return;
  }
  if (e.op !== 'update' || typeof p.status !== 'string') return;
  const row = (await tx.query(
    'select shift_id, person_id, status from shift_assignments where id = $1 and workspace_id = $2',
    [e.entityId, ws],
  )).rows[0];
  if (!row) return;
  if (ACTIVE.includes(p.status)) {
    // Already on the shift (assigned → confirmed): whatever it put on their
    // phone is there, or the desk took it off by hand and it stays off.
    if (typeof p.from === 'string' && ACTIVE.includes(p.from)) return;
    if (!(await hasTurfs(tx, ws, row.shift_id))) return;
    const userId = p.self ? meta.actorId : await userForPerson(tx, ws, row.person_id);
    if (userId) await putOn(tx, ws, { assignmentId: e.entityId, shiftId: row.shift_id, userId }, meta.emit);
  } else if (GONE.includes(p.status)) {
    await takeOff(tx, ws, { assignmentId: e.entityId }, meta.emit);
  }
};

const onTurf = async (tx, meta, e) => {
  const ws = meta.workspaceId;
  const p = e.payload || {};
  if (e.op === 'void') {
    await tx.query('delete from shift_turf_walkers where workspace_id = $1 and turf_id = $2', [ws, e.entityId]);
    await tx.query('delete from shift_turfs where workspace_id = $1 and turf_id = $2', [ws, e.entityId]);
    // Whoever the crew board put on it is back to "not placed": every turf
    // their shift still carries.
    await unplaceFrom(tx, ws, { turfIds: [e.entityId] }, meta.emit);
    return;
  }
  if (e.op !== 'update') return;
  const byHand = [p.assigned, p.unassigned].flat().filter((v) => typeof v === 'string');
  if (byHand.length) await handOver(tx, ws, e.entityId, byHand);
};

const onMembership = async (tx, meta, e) => {
  const ws = meta.workspaceId;
  if (e.op === 'void') {
    await tx.query('delete from shift_turf_walkers where workspace_id = $1 and user_id = $2', [ws, e.entityId]);
    return;
  }
  if (e.op !== 'create') return;
  // Booked before they had a sign-in: their upcoming shifts' turfs now.
  const booked = (await tx.query(
    `select distinct a.id, a.shift_id from users u
     join persons p on p.workspace_id = $1 and p.deleted_at is null and p.email is not null and lower(p.email) = lower(u.email)
     join shift_assignments a on a.person_id = p.id and a.workspace_id = $1 and a.status in ('assigned', 'confirmed')
     join shifts s on s.id = a.shift_id and s.deleted_at is null and coalesce(s.ends_at, s.starts_at) >= now()
     where u.id = $2 and exists (select 1 from shift_turfs st where st.shift_id = a.shift_id)`,
    [ws, e.entityId],
  )).rows;
  for (const b of booked) {
    await putOn(tx, ws, { assignmentId: b.id, shiftId: b.shift_id, userId: e.entityId }, meta.emit);
  }
};

// A shift called off: what it put on phones comes back off (never a turf
// given by hand, never one another shift still holds — takeOff decides).
const onShift = async (tx, meta, e) => {
  if (e.op !== 'void') return;
  const ws = meta.workspaceId;
  const held = (await tx.query(
    'select distinct assignment_id from shift_turf_walkers where workspace_id = $1 and shift_id = $2', [ws, e.entityId],
  )).rows;
  for (const h of held) await takeOff(tx, ws, { assignmentId: h.assignment_id }, meta.emit);
  await tx.query('delete from shift_crew where workspace_id = $1 and shift_id = $2', [ws, e.entityId]);
};

export const onShiftEvents = async (tx, meta, events) => {
  for (const e of events) {
    if (e.entityType === 'shift') await onShift(tx, meta, e);
    else if (e.entityType === 'shift_assignment') await onAssignment(tx, meta, e);
    else if (e.entityType === 'turf') await onTurf(tx, meta, e);
    else if (e.entityType === 'membership') await onMembership(tx, meta, e);
  }
};

// Today (GET /api/brief): the turfs of the shifts it lists (the next five)
// and of the caller's own upcoming ones, names only — so "Your next shift"
// reads "Saturday canvass · Newton block", on the phone's kept copy too.
export const briefShiftTurfs = async (db, ctx, body) => {
  const ids = (body.shifts || []).map((s) => s.id);
  const email = loginEmail(ctx);
  const { rows } = await db.query(
    `select st.shift_id, t.id, t.name from shift_turfs st
     join turfs t on t.id = st.turf_id and t.deleted_at is null
     join shifts s on s.id = st.shift_id and s.deleted_at is null
     where st.workspace_id = $1 and (st.shift_id = any($2::uuid[]) or (
       $3::text <> '' and s.starts_at >= now() and exists (
         select 1 from shift_assignments a join persons p on p.id = a.person_id
         where a.shift_id = s.id and a.workspace_id = s.workspace_id and a.status in ('assigned', 'confirmed')
           and p.deleted_at is null and lower(p.email) = $3::text)))
     order by t.created_at, t.id`,
    [ctx.workspaceId, ids, email],
  );
  const out = {};
  for (const r of rows) (out[r.shift_id] ||= []).push({ id: r.id, name: r.name });
  body.shiftTurfs = out;
};
