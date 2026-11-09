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

// Where the crew board put this assignment (shift_crew): null when it
// hasn't — they walk every turf the shift carries.
export const pickOf = async (tx, ws, assignmentId) => {
  const row = (await tx.query(
    'select placed, turf_id from shift_crew where workspace_id = $1 and assignment_id = $2', [ws, assignmentId],
  )).rows[0];
  return row?.placed ? { placed: row.placed, turfId: row.turf_id || null } : null;
};

// The turfs this assignment may walk, narrowing turfIds (null = all the
// shift's): placed on one turf, only that one; placed on none, nothing.
const allowedBy = (pick, turfIds) => {
  if (!pick) return turfIds;
  if (pick.placed === 'none' || !pick.turfId) return [];
  return turfIds ? turfIds.filter((t) => t === pick.turfId) : [pick.turfId];
};

// Put userId on the shift's turfs (or only turfIds of them) for this
// assignment — never past where the crew board placed them (pickOf).
// Answers the turf ids newly on their phone.
export const putOn = async (tx, ws, { assignmentId, shiftId, userId, turfIds: asked = null }, emit) => {
  if (!assignmentId || !shiftId || !userId) return [];
  const turfIds = allowedBy(await pickOf(tx, ws, assignmentId), asked);
  if (turfIds && !turfIds.length) return [];
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

// The crew board puts an assignment somewhere: 'every' (not placed — every
// turf the shift carries, the rule before the board), 'none' (no walk list
// from this shift: a driver, the office) or one of the shift's turf ids.
// Phones follow at once for someone active with an app sign-in: what this
// shift gave on turfs they no longer walk comes back off (never a turf
// given by hand, never one another of their shifts holds — takeOff), and
// the turf they walk now goes on. Answers the turf ids added and removed.
export const placeAssignment = async (tx, ws, { assignment, to }, emit) => {
  const placed = to === 'every' ? null : to === 'none' ? 'none' : 'turf';
  const turfId = placed === 'turf' ? to : null;
  await tx.query(
    `insert into shift_crew (assignment_id, workspace_id, shift_id, placed, turf_id, updated_at)
     values ($1, $2, $3, $4, $5, now())
     on conflict (assignment_id) do update set placed = excluded.placed, turf_id = excluded.turf_id, updated_at = now()`,
    [assignment.id, ws, assignment.shift_id, placed, turfId],
  );
  if (!ACTIVE.includes(assignment.status)) return { added: [], removed: [] };
  const shiftTurfs = (await tx.query(
    'select turf_id from shift_turfs where workspace_id = $1 and shift_id = $2', [ws, assignment.shift_id],
  )).rows.map((r) => r.turf_id);
  const walk = placed === null ? shiftTurfs : placed === 'none' ? [] : [turfId];
  const drop = shiftTurfs.filter((t) => !walk.includes(t));
  const removed = drop.length ? await takeOff(tx, ws, { assignmentId: assignment.id, turfIds: drop }, emit) : [];
  const userId = walk.length ? await userForPerson(tx, ws, assignment.person_id) : null;
  const added = userId
    ? await putOn(tx, ws, { assignmentId: assignment.id, shiftId: assignment.shift_id, userId, turfIds: walk }, emit)
    : [];
  return { added, removed };
};

// A turf left a shift (or was deleted): whoever the crew board had put on it
// is not placed any more — they walk every turf their shift still carries.
// shiftId narrows it to one shift's crew. Run after shift_turfs is updated.
export const unplaceFrom = async (tx, ws, { turfIds, shiftId = null }, emit) => {
  if (!turfIds?.length) return;
  const rows = (await tx.query(
    `update shift_crew set placed = null, turf_id = null, updated_at = now()
     where workspace_id = $1 and placed = 'turf' and turf_id = any($2::uuid[]) ${shiftId ? 'and shift_id = $3' : ''}
     returning assignment_id`,
    shiftId ? [ws, turfIds, shiftId] : [ws, turfIds],
  )).rows;
  for (const { assignment_id: id } of rows) {
    const a = (await tx.query(
      `select a.id, a.shift_id, a.person_id from shift_assignments a
       where a.id = $1 and a.workspace_id = $2 and a.status = any($3::text[])`,
      [id, ws, ACTIVE],
    )).rows[0];
    if (!a) continue;
    const userId = await userForPerson(tx, ws, a.person_id);
    if (userId) await putOn(tx, ws, { assignmentId: a.id, shiftId: a.shift_id, userId }, emit);
  }
};

// A job on the crew: 'lead' (team lead), 'driver', or null.
export const setJob = (tx, ws, { assignment, job }) => tx.query(
  `insert into shift_crew (assignment_id, workspace_id, shift_id, job, updated_at)
   values ($1, $2, $3, $4, now())
   on conflict (assignment_id) do update set job = excluded.job, updated_at = now()`,
  [assignment.id, ws, assignment.shift_id, job],
);

// A membership the desk gave or took by hand is the desk's from now on: no
// shift takes it back, and none holds a membership that's gone.
export const handOver = (tx, ws, turfId, userIds) => tx.query(
  'delete from shift_turf_walkers where workspace_id = $1 and turf_id = $2 and user_id = any($3::uuid[])',
  [ws, turfId, userIds],
);
