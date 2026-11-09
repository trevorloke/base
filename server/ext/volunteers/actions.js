// shift.add { shift_id, person_id, to?, job? }   the desk puts someone on a
// shift in one step — from the crew board's tray (dropped on a turf, on
// "No walk list" or on the crew) or the roster's "Put on a shift":
//   - booked with the core's own shift.assign (room, the same person twice
//     and who may are its rules); someone who couldn't make it or didn't
//     show is booked again (shift.setStatus → assigned)
//   - placed where it was dropped (shift.place's rules: a turf of the shift,
//     'none', or 'every' — the default), with a job if one was given
//   - their open "Wants to volunteer" requests are done: they're scheduled
//     ("On Saturday canvass, Nov 14")
// The walk lists follow the shift's hook (ext/shiftturfs), which reads the
// placement written here.
import { z } from 'zod';
import { httpError } from '../../actions/util.js';
import { areasFor } from '../../lib/perms.js';

const DESK = ['manager', 'treasurer', 'staff'];
// On the shift, holding a spot: booked, confirmed, or checked in ("Here") —
// the core's rule for room (actions/field.js).
const HOLD = ['assigned', 'confirmed', 'completed'];

const dayWords = (iso, tz) => {
  try {
    return new Date(iso).toLocaleDateString('en-CA', { timeZone: tz || 'America/Vancouver', month: 'short', day: 'numeric' });
  } catch {
    return String(iso).slice(0, 10);
  }
};

export const actions = {
  'shift.add': {
    roles: DESK,
    input: z.object({
      shift_id: z.uuid(),
      person_id: z.uuid(),
      to: z.union([z.enum(['every', 'none']), z.uuid()]).optional(),
      job: z.enum(['lead', 'driver']).nullable().optional(),
    }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      const { ACTIONS } = await import('../../actions/index.js');
      const shift = (await tx.query(
        'select id, title, starts_at from shifts where id = $1 and workspace_id = $2 and deleted_at is null',
        [input.shift_id, ws],
      )).rows[0];
      if (!shift) throw httpError(404, 'shift not found');
      const to = input.to ?? 'every';
      if (to !== 'every') {
        if (!areasFor(ctx).includes('map')) throw httpError(403, 'giving out walk lists needs Map & turfs');
        if (to !== 'none') {
          const carried = (await tx.query(
            'select 1 from shift_turfs where workspace_id = $1 and shift_id = $2 and turf_id = $3', [ws, shift.id, to],
          )).rows[0];
          if (!carried) throw httpError(400, 'that turf isn’t on this shift');
        }
      }
      // Booked: new, or again after "Can't make it" / a no-show.
      const had = (await tx.query(
        'select id, status from shift_assignments where workspace_id = $1 and shift_id = $2 and person_id = $3',
        [ws, shift.id, input.person_id],
      )).rows[0];
      if (had && HOLD.includes(had.status)) throw httpError(409, 'already on this shift');
      let assignmentId;
      if (had) {
        assignmentId = had.id;
      } else {
        const r = await ACTIONS['shift.assign'].handler(tx, ctx, { shift_id: shift.id, person_id: input.person_id }, emit);
        assignmentId = r.assignment.id;
      }
      // Placed before the walk lists go out (the hook runs after this
      // handler and reads it).
      const placed = to === 'every' ? null : to === 'none' ? 'none' : 'turf';
      await tx.query(
        `insert into shift_crew (assignment_id, workspace_id, shift_id, placed, turf_id, job, updated_at)
         values ($1, $2, $3, $4, $5, $6, now())
         on conflict (assignment_id) do update set placed = excluded.placed, turf_id = excluded.turf_id,
           job = coalesce(excluded.job, shift_crew.job), updated_at = now()`,
        [assignmentId, ws, shift.id, placed, placed === 'turf' ? to : null, input.job ?? null],
      );
      if (had) await ACTIONS['shift.setStatus'].handler(tx, ctx, { id: assignmentId, status: 'assigned' }, emit);
      if (to !== 'every' || input.job != null) {
        emit('shift_assignment', assignmentId, 'update', { placed: to, ...(input.job != null ? { job: input.job } : {}) });
      }

      // Asked to volunteer → scheduled.
      const note = `On ${shift.title}, ${dayWords(shift.starts_at, ctx.workspace?.settings?.tz)}`;
      const closed = (await tx.query(
        `update door_requests set done_at = now(), done_by = $3, done_note = $4
         where workspace_id = $1 and person_id = $2 and kind = 'volunteer' and done_at is null
         returning id, done_at`,
        [ws, input.person_id, ctx.user.id, note],
      )).rows;
      for (const r of closed) emit('door_request', r.id, 'update', { done_at: r.done_at, done_note: note });

      return {
        assignment: { id: assignmentId, shift_id: shift.id, person_id: input.person_id, status: 'assigned' },
        to,
        job: input.job ?? null,
        requests_done: closed.length,
      };
    },
  },
};
