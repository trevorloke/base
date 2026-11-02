// shift.turfs.set { shift_id, turf_ids }   the shift's turfs, all of them (desk)
//
// Area: shifts (the first segment, lib/perms.js). Turfs added: everyone on
// the shift now (assigned or confirmed) with an app sign-in gets them.
// Turfs taken off: what this shift put on phones comes back off — never a
// turf given by hand, never one another shift of theirs still holds.
import { z } from 'zod';
import { httpError } from '../../actions/util.js';
import { ACTIVE, putOn, takeOff, userForPerson } from './walkers.js';

const DESK = ['manager', 'treasurer', 'staff'];

export const actions = {
  'shift.turfs.set': {
    roles: DESK,
    input: z.object({ shift_id: z.uuid(), turf_ids: z.array(z.uuid()).max(20) }),
    handler: async (tx, ctx, input, emit) => {
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
      return { shift_id: shift.id, turf_ids: turfIds };
    },
  },
};
