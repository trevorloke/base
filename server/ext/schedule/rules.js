// What every way of scheduling shares — the core's shift.create and
// shift.update (actions/field.js) and this feature's own actions: the
// campaign's clock, a saved place, a made name. No outside calls.
import { addDays, dayOf, instantOf, isClock, isDay, wallClock } from '@starbase/shared/dayparts';
import { kindOf, madeTitle } from '@starbase/shared/shiftkinds';
import { z } from 'zod';
import { DEFAULT_TZ } from '../../lib/org.js';
import { httpError } from '../../actions/util.js';

export const tzOf = (ctx) => ctx.workspace?.settings?.tz || DEFAULT_TZ;

// Inputs said the way the screens say them: a day and clock times on the
// campaign's clock. The server works out the moments.
export const dayInput = () => z.string().refine(isDay, 'a day, as YYYY-MM-DD');
export const clockInput = () => z.string().refine(isClock, 'a time, as HH:MM');
export const needInput = () => z.number().int().positive().max(999);
// How long, in minutes: a quarter hour to a day. The only way to say a
// shift runs past midnight — an end clock time before the start is a typo.
// Made by tap, a shift is at most a day long. A shift being changed may keep
// a longer length the long form gave it (a 32-hour sign blitz weekend).
export const minutesInput = (max = 1440) => z.number().int().min(15).max(max);
export const LONGEST_KEPT = 31 * 1440;
export const BOTH_ENDS = 'say how long, or when it ends — not both';

// `minutes` of elapsed time after a moment: the end of a shift said by its
// length — never worked out again from a clock time, so a night the clocks
// go back is still that many minutes.
export const plusMinutes = (at, minutes) => new Date(Date.parse(at) + minutes * 60e3).toISOString();

const pad = (n) => String(n).padStart(2, '0');
const clock = (w) => `${pad(w.hour)}:${pad(w.minute)}`;
const daysApart = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);

// A shift's start and end on the campaign's clock: { day, start, end, span }
// — end null when it has none; span: the days from its start to its end
// (0 unless it runs past midnight).
export const clockTimes = (shift, tz) => {
  const s = wallClock(shift.starts_at, tz);
  const e = shift.ends_at ? wallClock(shift.ends_at, tz) : null;
  return { day: s.day, start: clock(s), end: e ? clock(e) : null, span: e ? daysApart(s.day, e.day) : 0 };
};

// The same shift on `day` (its own clock times, both ends — the same local
// time, never "+24 hours"), or with other clock times: { starts_at, ends_at }.
// end: 'HH:MM' on the start's day, null for no end, undefined to keep its own;
// or minutes: how long from the (new) start, past midnight if need be.
export const movedTimes = (shift, { day, start, end, minutes }, tz) => {
  const at = clockTimes(shift, tz);
  const onDay = day ?? at.day;
  const out = { starts_at: instantOf(onDay, start ?? at.start, tz) };
  if (minutes !== undefined) out.ends_at = plusMinutes(out.starts_at, minutes);
  else if (end === null) out.ends_at = null;
  else if (end !== undefined) out.ends_at = instantOf(onDay, end, tz);
  else out.ends_at = at.end ? instantOf(addDays(onDay, at.span), at.end, tz) : null;
  return out;
};

export const endsAfterStart = (starts, ends) => !ends || new Date(ends) > new Date(starts);
export const END_FIRST = 'the end has to be after the start';

// A booking's own hours (shift.hours — ./hours.js) always fit their shift.
// After a shift's start or end changes, in the same write: on the same
// start day, hours that still overlap the shift by half an hour or more
// are narrowed to that overlap (the whole shift: back to null, the whole
// shift); hours on a shift moved to another day, overlapping less, or on a
// shift with no end any more are cleared. Each booking changed gets its
// shift_assignment update event. `before`: the shift as it was.
export const HALF_HOUR = 30 * 60e3;
const ms = (v) => (v ? new Date(v).getTime() : null);
export const fitHours = async (tx, ws, shiftId, emit, { before, tz }) => {
  const s = (await tx.query('select starts_at, ends_at from shifts where id = $1 and workspace_id = $2', [shiftId, ws])).rows[0];
  if (!s) return 0;
  const S = ms(s.starts_at);
  const E = ms(s.ends_at);
  if (ms(before.starts_at) === S && ms(before.ends_at) === E) return 0;
  const own = (await tx.query(
    'select id, arrive_at, leave_at from shift_assignments where workspace_id = $1 and shift_id = $2 and arrive_at is not null order by id',
    [ws, shiftId],
  )).rows;
  const sameDay = dayOf(before.starts_at, tz) === dayOf(s.starts_at, tz);
  let changed = 0;
  for (const r of own) {
    let next = [null, null];
    if (E !== null && sameDay) {
      const a = Math.max(S, ms(r.arrive_at));
      const l = Math.min(E, ms(r.leave_at));
      if (l - a >= HALF_HOUR && !(a === S && l === E)) next = [a, l];
    }
    if (next[0] === ms(r.arrive_at) && next[1] === ms(r.leave_at)) continue;
    const [arrive, leave] = next.map((v) => (v === null ? null : new Date(v).toISOString()));
    await tx.query('update shift_assignments set arrive_at = $3, leave_at = $4 where id = $1 and workspace_id = $2', [r.id, ws, arrive, leave]);
    emit('shift_assignment', r.id, 'update', { arrive_at: arrive, leave_at: leave });
    changed += 1;
  }
  return changed;
};

// A saved place still on the list, or a plain refusal.
export const livePlace = async (tx, ws, id) => {
  const place = (await tx.query(
    'select id, name, lat, lng from places where id = $1 and workspace_id = $2 and deleted_at is null', [id, ws],
  )).rows[0];
  if (!place) throw httpError(400, 'that place isn’t on the list any more');
  return place;
};

// For a canvass the turf IS the place: its turfs' names are the words shown.
export const turfWords = async (tx, ws, turfIds) => (await tx.query(
  'select name from turfs where workspace_id = $1 and deleted_at is null and id = any($2::uuid[]) order by created_at, id', [ws, turfIds],
)).rows.map((r) => r.name).join(', ').slice(0, 400);

// The name a shift gets when nobody typed one: its kind and its place.
export const titleFor = (shift) => madeTitle(kindOf(shift).code, shift.location);

// Many rows, a few to a statement: `each(part)` for every `size` of them, in
// order. No statement is ever a very large message (two hundred shifts with
// their instructions in one would be).
export const inParts = async (list, size, each) => {
  for (let i = 0; i < list.length; i += size) await each(list.slice(i, i + size));
};
