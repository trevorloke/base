// Putting a shift's walkers on its turfs, and taking them off again.
//
// A turf membership (turf_members) is either given by hand (turf.assign) or
// held by one or more shifts (a shift_turf_walkers row per assignment). The
// rules:
//   putOn    a membership this shift makes is the shift's (a walker row);
//            one another shift already holds is shared (a walker row too,
//            nothing new on the phone); one given by hand stays the desk's
//            (no row — no shift ever takes it back).
//   takeOff  this assignment's walker rows go; the membership goes with
//            them only when no other shift still holds it — so leaving one
//            of two Saturday shifts on Newton block keeps Newton block.
// A shift that is already over gives no walk lists.
//
// Every write is an insert … on conflict do nothing or a delete: this runs
// inside the action's transaction, and an error would refuse the action.
export const ACTIVE = ['assigned', 'confirmed'];
export const GONE = ['declined', 'no_show'];

// The app sign-in of a shift's person: their email is a member's login email
// (lower-cased, as MINE_ON_SHIFT and selfPerson match them). Null when they
// have none — they are on the shift, and the desk puts them on the turf by hand.
export const userForPerson = async (tx, ws, personId) => {
  if (!personId) return null;
  const row = (await tx.query(
    `select u.id from persons p
     join users u on lower(u.email) = lower(p.email)
     join memberships m on m.user_id = u.id and m.workspace_id = $1
     where p.id = $2 and p.workspace_id = $1 and p.deleted_at is null and p.email is not null
     limit 1`,
    [ws, personId],
  )).rows[0];
  return row?.id || null;
};

const addWalker = (tx, ws, { assignmentId, shiftId, turfId, userId }) => tx.query(
  `insert into shift_turf_walkers (workspace_id, assignment_id, shift_id, turf_id, user_id)
   values ($1, $2, $3, $4, $5) on conflict do nothing`,
  [ws, assignmentId, shiftId, turfId, userId],
);

// Put userId on the shift's turfs (or only turfIds of them) for this
// assignment. Answers the turf ids newly on their phone.
export const putOn = async (tx, ws, { assignmentId, shiftId, userId, turfIds = null }, emit) => {
  if (!assignmentId || !shiftId || !userId) return [];
  const turfs = (await tx.query(
    `select st.turf_id from shift_turfs st
     join shifts s on s.id = st.shift_id and s.deleted_at is null and coalesce(s.ends_at, s.starts_at) >= now()
     join turfs t on t.id = st.turf_id and t.deleted_at is null
     where st.workspace_id = $1 and st.shift_id = $2 ${turfIds ? 'and st.turf_id = any($3::uuid[])' : ''}
     order by t.created_at, t.id`,
    turfIds ? [ws, shiftId, turfIds] : [ws, shiftId],
  )).rows;
  const added = [];
  for (const { turf_id: turfId } of turfs) {
    const n = await tx.query(
      'insert into turf_members (workspace_id, turf_id, user_id) values ($1, $2, $3) on conflict do nothing',
      [ws, turfId, userId],
    );
    if (n.affectedRows === 1) {
      await addWalker(tx, ws, { assignmentId, shiftId, turfId, userId });
      emit('turf', turfId, 'update', { member_added: userId, via_shift: shiftId });
      added.push(turfId);
      continue;
    }
    // Already on it. Held by another shift: this one shares it. Given by
    // hand: it stays the desk's.
    const held = (await tx.query(
      'select 1 from shift_turf_walkers where workspace_id = $1 and turf_id = $2 and user_id = $3 limit 1',
      [ws, turfId, userId],
    )).rows[0];
    if (held) await addWalker(tx, ws, { assignmentId, shiftId, turfId, userId });
  }
  return added;
};

// Take back what this assignment holds (or only on turfIds). Answers the
// turf ids that left the walker's phone.
export const takeOff = async (tx, ws, { assignmentId, turfIds = null }, emit) => {
  if (!assignmentId) return [];
  const rows = (await tx.query(
    `select turf_id, user_id, shift_id from shift_turf_walkers
     where workspace_id = $1 and assignment_id = $2 ${turfIds ? 'and turf_id = any($3::uuid[])' : ''}`,
    turfIds ? [ws, assignmentId, turfIds] : [ws, assignmentId],
  )).rows;
  const removed = [];
  for (const r of rows) {
    await tx.query('delete from shift_turf_walkers where assignment_id = $1 and turf_id = $2', [assignmentId, r.turf_id]);
    // Another of their shifts still holds this turf (it gave it, or shares
    // it): the walk list stays.
    const still = (await tx.query(
      `select 1 from shift_turf_walkers w join shift_assignments a on a.id = w.assignment_id
       where w.workspace_id = $1 and w.turf_id = $2 and w.user_id = $3
         and a.status not in ('declined', 'no_show') limit 1`,
      [ws, r.turf_id, r.user_id],
    )).rows[0];
    if (still) continue;
    // Nothing holds it now: any row left names a booking that is gone.
    await tx.query('delete from shift_turf_walkers where workspace_id = $1 and turf_id = $2 and user_id = $3',
      [ws, r.turf_id, r.user_id]);
    const n = await tx.query('delete from turf_members where workspace_id = $1 and turf_id = $2 and user_id = $3',
      [ws, r.turf_id, r.user_id]);
    if (n.affectedRows > 0) {
      emit('turf', r.turf_id, 'update', { member_removed: r.user_id, via_shift: r.shift_id });
      removed.push(r.turf_id);
    }
  }
  return removed;
};

// A membership the desk gave or took by hand is the desk's from now on: no
// shift takes it back, and none holds a membership that's gone.
export const handOver = (tx, ws, turfId, userIds) => tx.query(
  'delete from shift_turf_walkers where workspace_id = $1 and turf_id = $2 and user_id = any($3::uuid[])',
  [ws, turfId, userIds],
);
