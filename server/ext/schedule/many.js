// Many shifts in one write — each of these is ONE transaction under the
// campaign's lock, with the ordinary event per shift and per booking that
// walk lists, ladders, follow-ups and the roster read (a loop of calls from
// the browser would take the lock each time and could stop half-way):
//
// shift.createMany { kind, place_id? | turf_ids? | location?, days, start,
//     end | minutes, repeat?, name?, instructions?, link?, need?, capacity?,
//     public?, drop_in? }
//   Every chosen day ('YYYY-MM-DD'), at start–end ('HH:MM') on the
//   campaign's clock — and each again weekly: repeat { weeks: n } (n weeks
//   in all) or { until: day }. At most 200 shifts and 26 weeks a call.
//   minutes in place of end: how long (15 to 1440) — elapsed time from the
//   start, so it may run past midnight (an end before the start may not).
//   Several times a day (a morning and an afternoon canvass): slots:
//   [{ start, end | minutes }, …] in place of start and end — still one write.
//   drop_in: "Drop in any time" (words only).
//   Where: a saved place, the turfs (for a canvass the turf IS the place:
//   its walk list comes with the shift and its name is the name — needs
//   Map & turfs, as shift.turfs.set does), or words. The name is made from
//   kind and place unless one is typed (name). A day that already has a
//   live shift of that kind at that place and start is skipped and said so
//   (skipped). A call that repeats makes one repeating slot a time
//   (series_id).
//   → { shifts: [{ id, title, day, starts_at, ends_at, series_id }],
//   skipped: [{ day, start }], series_id } — series_id: the repeating slot
//   made, when the call made exactly one.
//
// shift.copyWeek { from, to, with_people? }
//   The week holding `from` onto the week holding `to`: the same kind,
//   place, local times (never "+168 hours"), name, turfs, target, limit,
//   on-the-website and drop-in. What is already there is not made twice, and nothing is
//   copied into the past. with_people: everyone holding a spot (booked,
//   confirmed, checked in — not "can't make it", not a no-show) arrives on
//   the matching shift as booked ('assigned'), never past its limit, for the
//   whole shift (their own hours are next week's question).
//   → { shifts, already, past, booked, full, no_turfs? }
//
// shift.series.update { id, patch }
//   A repeating slot from this shift on: shift.update's patch on this one
//   and the following ones not changed on their own. A day moves each by
//   as many days. All or nothing. → { changed: [id…], left }
//
// shift.series.cancel { id }
//   Calls off this one and the following ones nobody holds a spot on, and
//   answers with those that still have people. → { called_off: [id…],
//   kept: [{ id, title, starts_at, booked }] }
import { z } from 'zod';
import { addDays, fmtIn, instantOf, weekStart, zonedISO } from '@starbase/shared/dayparts';
import {
  MAX_SHIFTS, MAX_WEEKS, SHIFT_KIND_CODES, madeTitle, repeatDays, shiftKind,
} from '@starbase/shared/shiftkinds';
import { httpError } from '../../actions/util.js';
import { newId } from '../../lib/events.js';
import { areasFor } from '../../lib/perms.js';
import { cacheClear } from '../site/cache.js';
import {
  BOTH_ENDS, END_FIRST, clockInput, clockTimes, dayInput, inParts, livePlace, minutesInput, movedTimes, needInput, plusMinutes,
  turfWords, tzOf,
} from './rules.js';

const DESK = ['manager', 'treasurer', 'staff'];
// Holding a spot, as the core counts room (actions/field.js).
const HOLD = ['assigned', 'confirmed', 'completed'];
const iso = (v) => (v instanceof Date ? v.toISOString() : v);
const daysApart = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);
const words = (v) => String(v || '').trim().toLowerCase();
// The same place: the same saved place, else the same words.
const sameWhere = (a, b) => (a.place_id && b.place_id ? a.place_id === b.place_id : words(a.location) === words(b.location));
// The public website shows shifts: its drawn pages are stale after these.
const clearSite = async (db, ctx, result) => { cacheClear(ctx.workspaceId); return { result }; };

// The live turfs among these ids, in the campaign's order. Putting a turf
// on a shift hands out its walk list, so it needs Map & turfs.
const turfsFor = async (tx, ctx, ids) => {
  const want = [...new Set(ids || [])];
  if (!want.length) return [];
  if (!areasFor(ctx).includes('map')) throw httpError(403, 'giving out walk lists needs Map & turfs');
  const live = (await tx.query(
    'select id from turfs where workspace_id = $1 and deleted_at is null and id = any($2::uuid[]) order by created_at, id', [ctx.workspaceId, want],
  )).rows.map((r) => r.id);
  if (live.length !== want.length) throw httpError(400, 'turf not found');
  return live;
};

// Rows go in many to a statement — a few statements however many shifts
// (the campaign's lock is held meanwhile: a city's door-knocks wait on it).
const insertShifts = (tx, ws, userId, list) => inParts(list, 25, (part) => tx.query(
  `insert into shifts (id, workspace_id, title, role, location, starts_at, ends_at, instructions, link, capacity, created_by,
                       kind, place_id, need, title_custom, series_id, public, drop_in)
   select x.id, $1, x.title, x.role, x.location, x.starts_at, x.ends_at, x.instructions, x.link, x.capacity, $2,
          x.kind, x.place_id, x.need, x.title_custom, x.series_id, coalesce(x.public, false), x.drop_in
     from jsonb_to_recordset($3::jsonb) as x(id uuid, title text, role text, location text, starts_at timestamptz, ends_at timestamptz,
          instructions text, link text, capacity int, kind text, place_id uuid, need int, title_custom boolean, series_id uuid, public boolean,
          drop_in boolean)`,
  [ws, userId, JSON.stringify(part)],
));
// shift_turfs is ext/shiftturfs' table: a new shift has nobody on it yet,
// so there are no walk lists to hand out — its hook does that per booking.
const insertTurfs = (tx, ws, pairs) => inParts(pairs, 200, (part) => tx.query(
  `insert into shift_turfs (workspace_id, shift_id, turf_id)
   select $1, x.shift_id, x.turf_id from jsonb_to_recordset($2::jsonb) as x(shift_id uuid, turf_id uuid) on conflict do nothing`,
  [ws, JSON.stringify(part)],
));

// The times a call asks for, soonest first: its start and end (or length),
// or its slots — one way or the other, each ending after it starts, no two
// starting together (they would be the same shift twice). Checked here, not
// in the input's schema, as shift.update checks its own.
const slotsOf = (input) => {
  const one = input.start !== undefined || input.end !== undefined || input.minutes !== undefined;
  if (one === Boolean(input.slots)) throw httpError(400, 'say when: a start and an end, or slots — one or the other');
  const slots = (input.slots || [{ start: input.start, end: input.end, minutes: input.minutes }])
    .map(({ start, end, minutes }) => ({ start, end, minutes }));
  if (slots.some((s) => s.end !== undefined && s.minutes !== undefined)) throw httpError(400, BOTH_ENDS);
  if (slots.some((s) => s.start === undefined || (s.end === undefined && s.minutes === undefined))) {
    throw httpError(400, 'say when: a start and an end');
  }
  slots.sort((a, b) => a.start.localeCompare(b.start));
  if (slots.some((s) => s.end !== undefined && s.end <= s.start)) throw httpError(400, END_FIRST);
  if (new Set(slots.map((s) => s.start)).size !== slots.length) throw httpError(400, 'two of those times start together');
  return slots;
};

// What a new shift's event says: what was stored, nothing empty.
const createPayload = (s) => Object.fromEntries(Object.entries({
  id: s.id, title: s.title, kind: s.kind, role: s.role, place_id: s.place_id, location: s.location,
  starts_at: s.starts_at, ends_at: s.ends_at, instructions: s.instructions, link: s.link, capacity: s.capacity, need: s.need,
  public: s.public || null, drop_in: s.drop_in || null, series_id: s.series_id,
}).filter(([, v]) => v !== null && v !== undefined));

export const manyActions = {
  'shift.createMany': {
    roles: DESK,
    input: z.object({
      kind: z.enum(SHIFT_KIND_CODES),
      place_id: z.uuid().nullish(),
      turf_ids: z.array(z.uuid()).max(20).optional(),
      location: z.string().trim().max(400).nullish(),
      days: z.array(dayInput()).min(1).max(31),
      start: clockInput().optional(),
      end: clockInput().optional(),
      minutes: minutesInput().optional(),
      slots: z.array(z.object({ start: clockInput(), end: clockInput().optional(), minutes: minutesInput().optional() })).min(1).max(8).optional(),
      repeat: z.union([
        z.object({ weeks: z.number().int().min(1).max(MAX_WEEKS) }),
        z.object({ until: dayInput() }),
      ]).nullish(),
      name: z.string().trim().min(1).max(300).nullish(),
      instructions: z.string().max(4000).nullish(),
      link: z.string().max(1000).nullish(),
      need: needInput().nullish(),
      capacity: z.number().int().positive().nullish(),
      public: z.boolean().optional(),
      drop_in: z.boolean().optional(),
    }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      const tz = tzOf(ctx);
      const slots = slotsOf(input);
      const first = [...input.days].sort()[0];
      if (input.repeat?.until && input.repeat.until > addDays(first, MAX_WEEKS * 7 - 1)) {
        throw httpError(400, `${MAX_WEEKS} weeks at most — pick an earlier last day`);
      }
      const days = repeatDays(input.days, input.repeat);
      const total = days.length * slots.length;
      if (total > MAX_SHIFTS) throw httpError(400, `That would make ${total} shifts — ${MAX_SHIFTS} at most at a time`);

      const kind = shiftKind(input.kind);
      const place = input.place_id ? await livePlace(tx, ws, input.place_id) : null;
      const turfIds = await turfsFor(tx, ctx, input.turf_ids);
      const location = input.location || place?.name || (turfIds.length ? await turfWords(tx, ws, turfIds) : null) || null;
      const where = { place_id: place?.id || null, location };

      // Each day's moments on the campaign's clock, and which are taken.
      const want = days.flatMap((day) => slots.map((slot) => {
        const startsAt = instantOf(day, slot.start, tz);
        const endsAt = slot.minutes !== undefined ? plusMinutes(startsAt, slot.minutes) : instantOf(day, slot.end, tz);
        return { day, slot, starts_at: startsAt, ends_at: endsAt };
      }));
      const there = (await tx.query(
        `select place_id, location, starts_at, series_id from shifts
          where workspace_id = $1 and deleted_at is null and kind = $2
            and starts_at in (select value::timestamptz from jsonb_array_elements_text($3::jsonb))`,
        [ws, kind.code, JSON.stringify(want.map((w) => w.starts_at))],
      )).rows.filter((s) => sameWhere(s, where));
      const taken = new Map(there.map((s) => [new Date(s.starts_at).getTime(), s]));
      const isTaken = (w) => taken.has(Date.parse(w.starts_at));
      // A call that repeats is one repeating slot a time — the one that
      // time's days are already part of, when the same call is made again
      // to run longer.
      const repeats = days.length > new Set(input.days).size;
      for (const slot of slots) {
        const had = [...new Set(want.filter((w) => w.slot === slot).map((w) => taken.get(Date.parse(w.starts_at))?.series_id).filter(Boolean))];
        slot.seriesId = repeats ? (had.length === 1 ? had[0] : newId()) : null;
      }

      const made = want.filter((w) => !isTaken(w)).map((w) => ({
        id: newId(), day: w.day, title: input.name || madeTitle(kind.code, location), title_custom: Boolean(input.name),
        kind: kind.code, role: kind.role, place_id: where.place_id, location, starts_at: w.starts_at, ends_at: w.ends_at,
        instructions: input.instructions || null, link: input.link || null, capacity: input.capacity ?? null, need: input.need ?? null,
        public: Boolean(input.public), drop_in: input.drop_in || null, series_id: w.slot.seriesId,
      }));
      if (made.length) {
        await insertShifts(tx, ws, ctx.user.id, made);
        await insertTurfs(tx, ws, made.flatMap((s) => turfIds.map((t) => ({ shift_id: s.id, turf_id: t }))));
      }
      for (const s of made) {
        emit('shift', s.id, 'create', createPayload(s));
        if (turfIds.length) emit('shift', s.id, 'update', { turf_ids: turfIds });
      }
      const series = [...new Set(made.map((s) => s.series_id).filter(Boolean))];
      return {
        shifts: made.map((s) => ({ id: s.id, title: s.title, day: s.day, starts_at: s.starts_at, ends_at: s.ends_at, series_id: s.series_id })),
        skipped: want.filter(isTaken).map((w) => ({ day: w.day, start: w.slot.start })),
        series_id: series.length === 1 ? series[0] : null,
      };
    },
    after: clearSite,
  },

  'shift.copyWeek': {
    roles: DESK,
    input: z.object({ from: dayInput(), to: dayInput(), with_people: z.boolean().default(false) }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      const tz = tzOf(ctx);
      const from = weekStart(input.from);
      const to = weekStart(input.to);
      if (from === to) throw httpError(400, 'pick another week to copy to');
      const inWeek = async (monday, limit) => (await tx.query(
        `select * from shifts where workspace_id = $1 and deleted_at is null and starts_at >= $2 and starts_at < $3
          order by starts_at, id ${limit ? `limit ${limit}` : ''}`,
        [ws, zonedISO(monday, 0, tz), zonedISO(addDays(monday, 7), 0, tz)],
      )).rows;
      const source = await inWeek(from, MAX_SHIFTS + 1);
      if (!source.length) throw httpError(409, 'that week has no shifts to copy');
      if (source.length > MAX_SHIFTS) throw httpError(400, `That week has more than ${MAX_SHIFTS} shifts — too many to copy at once`);
      const free = await inWeek(to);
      const delta = daysApart(from, to);
      const now = Date.now();

      // Each shift and its copy: one already there (the same kind, place and
      // start — and name, where it has no kind), else a new one. Each shift
      // already there stands in for one copy only.
      const pairs = [];
      const made = [];
      let past = 0;
      let already = 0;
      for (const s of source) {
        const times = movedTimes(s, { day: addDays(clockTimes(s, tz).day, delta) }, tz);
        if (Date.parse(times.ends_at || times.starts_at) < now) { past += 1; continue; }
        const at = Date.parse(times.starts_at);
        const i = free.findIndex((t) => (t.kind || null) === (s.kind || null) && new Date(t.starts_at).getTime() === at
          && sameWhere(t, s) && (s.kind || words(t.title) === words(s.title)));
        if (i >= 0) {
          pairs.push([s, free.splice(i, 1)[0]]);
          already += 1;
          continue;
        }
        const copy = {
          id: newId(), title: s.title, title_custom: s.title_custom, kind: s.kind, role: s.role, place_id: s.place_id, location: s.location,
          ...times, instructions: s.instructions, link: s.link, capacity: s.capacity, need: s.need, public: Boolean(s.public), drop_in: s.drop_in || null,
          series_id: null,
        };

        made.push(copy);
        pairs.push([s, copy]);
      }
      if (made.length) await insertShifts(tx, ws, ctx.user.id, made);

      // Their turfs — walk lists, so only for someone with Map & turfs.
      const copyOf = new Map(pairs.filter(([, t]) => made.includes(t)).map(([s, t]) => [s.id, t.id]));
      const carried = copyOf.size ? (await tx.query(
        `select st.shift_id, st.turf_id from shift_turfs st join turfs t on t.id = st.turf_id and t.deleted_at is null
          where st.workspace_id = $1 and st.shift_id = any($2::uuid[]) order by t.created_at, t.id`,
        [ws, [...copyOf.keys()]],
      )).rows : [];
      const canTurfs = areasFor(ctx).includes('map');
      const turfsOf = new Map();
      for (const r of carried) turfsOf.set(copyOf.get(r.shift_id), [...(turfsOf.get(copyOf.get(r.shift_id)) || []), r.turf_id]);
      if (canTurfs) await insertTurfs(tx, ws, [...turfsOf].flatMap(([shiftId, ids]) => ids.map((t) => ({ shift_id: shiftId, turf_id: t }))));
      for (const s of made) {
        emit('shift', s.id, 'create', createPayload(s));
        if (canTurfs && turfsOf.has(s.id)) emit('shift', s.id, 'update', { turf_ids: turfsOf.get(s.id) });
      }

      // The same people, as plain bookings — the events shift.assign writes.
      let full = 0;
      const bookings = [];
      if (input.with_people && pairs.length) {
        const holders = (await tx.query(
          `select a.shift_id, a.person_id from shift_assignments a join persons p on p.id = a.person_id and p.deleted_at is null
            where a.workspace_id = $1 and a.shift_id = any($2::uuid[]) and a.status = any($3::text[]) order by a.created_at, a.id`,
          [ws, pairs.map(([s]) => s.id), HOLD],
        )).rows;
        const onIt = new Map(pairs.map(([, t]) => [t.id, { people: new Set(), holding: 0 }]));
        for (const r of (await tx.query(
          'select shift_id, person_id, status from shift_assignments where workspace_id = $1 and shift_id = any($2::uuid[])',
          [ws, pairs.map(([, t]) => t.id)],
        )).rows) {
          onIt.get(r.shift_id).people.add(r.person_id);
          if (HOLD.includes(r.status)) onIt.get(r.shift_id).holding += 1;
        }
        for (const [s, t] of pairs) {
          const dst = onIt.get(t.id);
          for (const h of holders.filter((x) => x.shift_id === s.id)) {
            // On it already, in any way: left as they are ("can't make it" stays so).
            if (dst.people.has(h.person_id)) continue;
            if (t.capacity && dst.holding >= t.capacity) { full += 1; continue; }
            bookings.push({ id: newId(), shift_id: t.id, person_id: h.person_id });
            dst.people.add(h.person_id);
            dst.holding += 1;
          }
        }
        await inParts(bookings, 100, (part) => tx.query(
          `insert into shift_assignments (id, workspace_id, shift_id, person_id)
           select x.id, $1, x.shift_id, x.person_id from jsonb_to_recordset($2::jsonb) as x(id uuid, shift_id uuid, person_id uuid)`,
          [ws, JSON.stringify(part)],
        ));
        for (const b of bookings) emit('shift_assignment', b.id, 'create', b);
      }
      const noTurfs = canTurfs ? 0 : turfsOf.size;
      return {
        shifts: made.map((s) => ({ id: s.id, title: s.title, starts_at: s.starts_at, ends_at: s.ends_at })),
        already, past, booked: bookings.length, full, ...(noTurfs ? { no_turfs: noTurfs } : {}),
      };
    },
    after: clearSite,
  },

  'shift.series.update': {
    roles: DESK,
    input: z.object({ id: z.uuid(), patch: z.record(z.string(), z.unknown()) }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      const tz = tzOf(ctx);
      // The patch is shift.update's own, checked by its own contract.
      const { ACTIONS } = await import('../../actions/index.js');
      const update = ACTIONS['shift.update'];
      const parsed = update.input.omit({ id: true }).safeParse(input.patch);
      if (!parsed.success) {
        const i = parsed.error.issues[0];
        throw httpError(400, `${i.path.join('.') || 'patch'}: ${i.message}`);
      }
      const patch = parsed.data;
      if (!Object.keys(patch).length) throw httpError(400, 'nothing to change');
      if ('starts_at' in patch || 'ends_at' in patch) throw httpError(400, 'for a repeating slot, say when as a day and times');
      const anchor = (await tx.query('select * from shifts where id = $1 and workspace_id = $2 and deleted_at is null', [input.id, ws])).rows[0];
      if (!anchor) throw httpError(404, 'shift not found');
      if (!anchor.series_id) throw httpError(400, 'that shift doesn’t repeat — change it on its own');
      const following = (await tx.query(
        `select * from shifts where workspace_id = $1 and series_id = $2 and deleted_at is null and starts_at > $3 order by starts_at, id`,
        [ws, anchor.series_id, iso(anchor.starts_at)],
      )).rows;
      const together = following.filter((s) => !s.series_edited_at);
      // Another day moves each one by as many days as this one moves.
      const delta = patch.day ? daysApart(clockTimes(anchor, tz).day, patch.day) : 0;
      const changed = [];
      for (const s of [anchor, ...together]) {
        const own = patch.day ? { ...patch, day: addDays(clockTimes(s, tz).day, delta) } : patch;
        try {
          await update.handler(tx, ctx, { id: s.id, ...own }, emit, { series: true });
        } catch (e) {
          // One that can't change stops them all: say which day it is.
          if (e.status) throw httpError(e.status, `${fmtIn(s.starts_at, tz, { weekday: 'short', month: 'short', day: 'numeric' })}: ${e.message}`);
          throw e;
        }
        changed.push(s.id);
      }
      return { changed, left: following.length - together.length };
    },
  },

  'shift.series.cancel': {
    roles: DESK,
    input: z.object({ id: z.uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      const anchor = (await tx.query('select id, series_id, starts_at from shifts where id = $1 and workspace_id = $2 and deleted_at is null', [input.id, ws])).rows[0];
      if (!anchor) throw httpError(404, 'shift not found');
      if (!anchor.series_id) throw httpError(400, 'that shift doesn’t repeat — call it off on its own');
      const slot = (await tx.query(
        `select s.id, s.title, s.starts_at,
                (select count(*)::int from shift_assignments a where a.shift_id = s.id and a.status = any($4::text[])) as booked
           from shifts s
          where s.workspace_id = $1 and s.series_id = $2 and s.deleted_at is null and s.starts_at >= $3 order by s.starts_at, s.id`,
        [ws, anchor.series_id, iso(anchor.starts_at), HOLD],
      )).rows;
      const gone = slot.filter((s) => !s.booked).map((s) => s.id);
      if (gone.length) await tx.query('update shifts set deleted_at = now() where workspace_id = $1 and id = any($2::uuid[])', [ws, gone]);
      for (const id of gone) emit('shift', id, 'void', {});
      return {
        called_off: gone,
        kept: slot.filter((s) => s.booked).map((s) => ({ id: s.id, title: s.title, starts_at: iso(s.starts_at), booked: s.booked })),
      };
    },
    after: clearSite,
  },
};
