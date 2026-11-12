// What every way of scheduling shares — the core's shift.create and
// shift.update (actions/field.js) and this feature's own actions: the
// campaign's clock, a saved place, a made name. No outside calls.
import { addDays, instantOf, isClock, isDay, wallClock } from '@starbase/shared/dayparts';
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
// end: 'HH:MM' on the start's day, null for no end, undefined to keep its own.
export const movedTimes = (shift, { day, start, end }, tz) => {
  const at = clockTimes(shift, tz);
  const onDay = day ?? at.day;
  const out = { starts_at: instantOf(onDay, start ?? at.start, tz) };
  if (end === null) out.ends_at = null;
  else if (end !== undefined) out.ends_at = instantOf(onDay, end, tz);
  else out.ends_at = at.end ? instantOf(addDays(onDay, at.span), at.end, tz) : null;
  return out;
};

export const endsAfterStart = (starts, ends) => !ends || new Date(ends) > new Date(starts);
export const END_FIRST = 'the end has to be after the start';

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
