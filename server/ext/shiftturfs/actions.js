// shift.turfs.set { shift_id, turf_ids }   the shift's turfs, all of them (desk)
// shift.place { id, to?, job? }            the crew board: where one person on
//                                          the shift walks, and their job (desk)
//
// Area: shifts (the first segment, lib/perms.js) — and Map & turfs too, since
// putting a turf on a shift hands out its walk list (as turf.assign does): a
// volunteer granted Shifts alone can't give anyone a turf. Turfs added: everyone on
// the shift now (assigned or confirmed) with an app sign-in gets them.
// Turfs taken off: what this shift put on phones comes back off — never a
// turf given by hand, never one another shift of theirs still holds.
import { z } from 'zod';
import { httpError } from '../../actions/util.js';
import { areasFor } from '../../lib/perms.js';
import { ACTIVE, placeAssignment, putOn, setJob, takeOff, unplaceFrom, userForPerson } from './walkers.js';

const DESK = ['manager', 'treasurer', 'staff'];

export const actions = {
  'shift.turfs.set': {
    roles: DESK,
    input: z.object({ shift_id: z.uuid(), turf_ids: z.array(z.uuid()).max(20) }),
    handler: async (tx, ctx, input, emit) => {
      if (!areasFor(ctx).includes('map')) throw httpError(403, 'giving out walk lists needs Map & turfs');
      const ws = ctx.workspaceId;
      const shift = (await tx.query(
        'select id from shifts where id = $1 and workspace_id = $2 and deleted_at is null for update',
        [input.shift_id, ws],
      )).rows[0];
      if (!shift) throw httpError(404, 'shift not found');
      const want = [...new Set(input.turf_ids)];
      if (want.length) {
        const live = (await tx.query(
          'select id from turfs where workspace_id = $1 and deleted_at is null and id = any($2::uuid[])', [ws, want],
        )).rows;
        if (live.length !== want.length) throw httpError(400, 'turf not found');
      }
      const had = (await tx.query(
        'select turf_id from shift_turfs where workspace_id = $1 and shift_id = $2', [ws, shift.id],
      )).rows.map((r) => r.turf_id);
      const added = want.filter((t) => !had.includes(t));
      const removed = had.filter((t) => !want.includes(t));
      // In the campaign's turf order (as the Map lists them).
      const turfIds = want.length ? (await tx.query(
        'select id from turfs where workspace_id = $1 and id = any($2::uuid[]) order by created_at, id', [ws, want],
      )).rows.map((r) => r.id) : [];
      emit('shift', shift.id, 'update', { turf_ids: turfIds });

      // Off: each walker this shift put on a turf it no longer carries.
      if (removed.length) {
        const held = (await tx.query(
          `select distinct assignment_id from shift_turf_walkers
           where workspace_id = $1 and shift_id = $2 and turf_id = any($3::uuid[])`,
          [ws, shift.id, removed],
        )).rows;
        for (const h of held) await takeOff(tx, ws, { assignmentId: h.assignment_id, turfIds: removed }, emit);
        await tx.query('delete from shift_turfs where workspace_id = $1 and shift_id = $2 and turf_id = any($3::uuid[])',
          [ws, shift.id, removed]);
      }
      // On: everyone on the shift now gets the new ones.
      if (added.length) {
        for (const t of added) {
          await tx.query(
            'insert into shift_turfs (workspace_id, shift_id, turf_id) values ($1, $2, $3) on conflict do nothing',
            [ws, shift.id, t],
          );
        }
        const onShift = (await tx.query(
          `select id, person_id from shift_assignments
           where workspace_id = $1 and shift_id = $2 and status = any($3::text[]) order by created_at, id`,
          [ws, shift.id, ACTIVE],
        )).rows;
        for (const a of onShift) {
          const userId = await userForPerson(tx, ws, a.person_id);
          if (userId) await putOn(tx, ws, { assignmentId: a.id, shiftId: shift.id, userId, turfIds: added }, emit);
        }
      }
      // Whoever the crew board had put on a turf taken off: not placed now,
      // so every turf the shift still carries.
      if (removed.length) await unplaceFrom(tx, ws, { turfIds: removed, shiftId: shift.id }, emit);
      return { shift_id: shift.id, turf_ids: turfIds };
    },
  },

  // The crew board: where someone on the shift walks, and their job.
  //   to   'every' — not placed: every turf the shift carries (the default)
  //        'none'  — no walk list from this shift (a driver, the office)
  //        a turf id — only that one of the shift's turfs
  //   job  'lead' (team lead), 'driver', or null for neither
  // Moving walk lists needs Map & turfs, as shift.turfs.set does; a job alone
  // doesn't. Phones follow at once (walkers.js placeAssignment).
  'shift.place': {
    roles: DESK,
    input: z.object({
      id: z.uuid(),
      to: z.union([z.enum(['every', 'none']), z.uuid()]).optional(),
      job: z.enum(['lead', 'driver']).nullable().optional(),
    }).refine((v) => v.to !== undefined || v.job !== undefined, 'where to put them, or their job'),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      const assignment = (await tx.query(
        `select a.id, a.shift_id, a.person_id, a.status from shift_assignments a
         join shifts s on s.id = a.shift_id and s.deleted_at is null
         where a.id = $1 and a.workspace_id = $2 for update of a`,
        [input.id, ws],
      )).rows[0];
      if (!assignment) throw httpError(404, 'not on this shift any more');
      const out = { id: assignment.id, shift_id: assignment.shift_id };
      if (input.to !== undefined) {
        if (!areasFor(ctx).includes('map')) throw httpError(403, 'giving out walk lists needs Map & turfs');
        if (input.to !== 'every' && input.to !== 'none') {
          const carried = (await tx.query(
            'select 1 from shift_turfs where workspace_id = $1 and shift_id = $2 and turf_id = $3',
            [ws, assignment.shift_id, input.to],
          )).rows[0];
          if (!carried) throw httpError(400, 'that turf isn’t on this shift');
        }
        const moved = await placeAssignment(tx, ws, { assignment, to: input.to }, emit);
        out.to = input.to;
        out.added = moved.added;
        out.removed = moved.removed;
      }
      if (input.job !== undefined) {
        await setJob(tx, ws, { assignment, job: input.job });
        out.job = input.job;
      }
      // No status in it: the assignment hook leaves it be (the walk lists
      // moved above).
      emit('shift_assignment', assignment.id, 'update', {
        ...(input.to !== undefined ? { placed: input.to } : {}),
        ...(input.job !== undefined ? { job: input.job } : {}),
      });
      return out;
    },
  },
};
