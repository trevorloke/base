// "Only part of it": a booking's own hours inside its shift — the plan (what
// the person said they'll do), never a record of who came. Both null is the
// whole shift, as every booking made before this was.
//
// shift.hours { shift_id, from, to }      the caller's own booking — any
//     role that may "Count me in" (shift.join's list), and offline through
//     the outbox. 409 only for "you're not on this shift" (the outbox drops
//     exactly those); a shift that is over is a 400.
// shift.setHours { id, from, to }          the desk, for someone's booking
//     (an assignment id) — also after the shift, to correct the plan.
//
// from, to: ISO instants (never 'HH:MM': inside a shift that runs past
// midnight a clock time could be either day), or both null for the whole
// shift. They must lie inside the shift, at least half an hour apart; the
// shift must have an end. Exactly its start to its end is stored as null.
// The event is shift_assignment update { arrive_at, leave_at } — no status,
// so walk lists (ext/shiftturfs) are left as they are. Who may run these is
// their roles and lib/perms.js alone: neither handler checks a role.
import { z } from 'zod';
import { httpError } from '../../actions/util.js';
import { HALF_HOUR } from './rules.js';

const ALL_ROLES = ['manager', 'treasurer', 'staff', 'volunteer'];
const DESK = ['manager', 'treasurer', 'staff'];
// Holding a spot, as the core counts room (actions/field.js).
const HOLD = ['assigned', 'confirmed', 'completed'];
const ms = (v) => (v ? new Date(v).getTime() : null);
const instant = () => z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, 'expected ISO timestamp').nullable();
const hoursInput = { from: instant(), to: instant() };

export const NOT_ON = 'you’re not on this shift';
const NO_END = 'this shift has no end time — it’s the whole thing';
const INSIDE = 'pick a time inside the shift, at least half an hour';

// The caller's booking on a shift: among those holding a spot that belong to
// anyone on the list with the login email, the oldest person's first. One
// rule for this action and for GET /shifts' my_arrive_at / my_leave_at (a
// lateral join there): the same SQL, with that query's own references.
export const myBookingSql = (ws, shift, email) => `select a.id, a.arrive_at, a.leave_at
  from shift_assignments a join persons p on p.id = a.person_id
 where a.workspace_id = ${ws} and a.shift_id = ${shift} and a.status in ('assigned', 'confirmed', 'completed')
   and p.deleted_at is null and ${email} <> '' and lower(p.email) = ${email}
 order by p.created_at, a.created_at limit 1`;
export const myBooking = async (tx, ctx, shiftId) => (await tx.query(
  myBookingSql('$1', '$2', '$3::text'), [ctx.workspaceId, shiftId, String(ctx.user?.email || '').trim().toLowerCase()],
)).rows[0] || null;

// The hours to store for `from`–`to` on `shift`: { arrive_at, leave_at }.
export const fitInShift = (shift, from, to) => {
  if ((from === null) !== (to === null)) throw httpError(400, INSIDE);
  if (from === null) return { arrive_at: null, leave_at: null };
  if (!shift.ends_at) throw httpError(400, NO_END);
  const f = Date.parse(from);
  const t = Date.parse(to);
  const S = ms(shift.starts_at);
  const E = ms(shift.ends_at);
  if (Number.isNaN(f) || Number.isNaN(t) || f < S || t > E || t - f < HALF_HOUR) throw httpError(400, INSIDE);
  if (f === S && t === E) return { arrive_at: null, leave_at: null };
  return { arrive_at: new Date(f).toISOString(), leave_at: new Date(t).toISOString() };
};

const save = async (tx, ws, id, hours, emit, extra = {}) => {
  await tx.query('update shift_assignments set arrive_at = $3, leave_at = $4 where id = $1 and workspace_id = $2',
    [id, ws, hours.arrive_at, hours.leave_at]);
  emit('shift_assignment', id, 'update', { ...hours, ...extra });
};

export const hoursActions = {
  'shift.hours': {
    roles: ALL_ROLES,
    input: z.object({ shift_id: z.uuid(), ...hoursInput }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      const shift = (await tx.query(
        `select id, starts_at, ends_at, coalesce(ends_at, starts_at) < now() as over
           from shifts where id = $1 and workspace_id = $2 and deleted_at is null`,
        [input.shift_id, ws],
      )).rows[0];
      const mine = shift && await myBooking(tx, ctx, shift.id);
      if (!mine) throw httpError(409, NOT_ON);
      if (shift.over) throw httpError(400, 'that shift is over');
      const hours = fitInShift(shift, input.from, input.to);
      await save(tx, ws, mine.id, hours, emit, { self: true });
      return { assignment: { id: mine.id, shift_id: shift.id, ...hours } };
    },
  },

  'shift.setHours': {
    roles: DESK,
    input: z.object({ id: z.uuid(), ...hoursInput }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      const row = (await tx.query(
        `select a.id, a.shift_id, a.status, s.starts_at, s.ends_at
           from shift_assignments a join shifts s on s.id = a.shift_id and s.deleted_at is null
          where a.id = $1 and a.workspace_id = $2`,
        [input.id, ws],
      )).rows[0];
      if (!row) throw httpError(404, 'assignment not found');
      if (!HOLD.includes(row.status)) throw httpError(409, 'they’re not on this shift');
      const hours = fitInShift(row, input.from, input.to);
      await save(tx, ws, row.id, hours, emit);
      return { assignment: { id: row.id, shift_id: row.shift_id, ...hours } };
    },
  },
};
