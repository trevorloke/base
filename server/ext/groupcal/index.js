// The group calendar: one calendar for the campaign, where each person sees
// what is on it for them (group.js has the rule) — on the Calendar page of
// the field app and the desk, and in their own calendar link (ext/calendar).
//
//   calendar.item.add     managers (or anyone given Admin): an item and who
//       { title, all_day, day, last_day?, start?, end?, place?, details?, who }
//       day / last_day 'YYYY-MM-DD'; start / end 'HH:MM' on the campaign's
//       clock; who: everyone · candidates · candidate:<seat> · managers ·
//       team:<team>. The log has the title and who, never the notes.
//   calendar.item.edit    { id, …the same }
//   calendar.item.remove  { id }   gone for everyone, and from their calendars
//                         the next time those check
//
//   GET /api/calendar?month=YYYY-MM[&every=1]   every member
//       → { month, today, tz, entries, canAdd, canEvery, who? }
//       month: the campaign's own (its days and clock); none asked: this one.
//       every=1: every shift, for whoever has the Shifts board (else ignored).
//       who: the form's choices, for those who may add.
import { Hono } from 'hono';
import { z } from 'zod';
import { addDays, instantOf, isClock, isDay, zonedISO } from '@starbase/shared/dayparts';
import { httpError } from '../../actions/util.js';
import { newId } from '../../lib/events.js';
import { mayRun } from '../../lib/perms.js';
import { todayOf } from '../audience/index.js';
import { calendarFor, seesEvery, viewerOf } from './group.js';

export { sql } from './sql.js';

const MANAGER = ['manager'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const tzOf = (ctx) => ctx.workspace?.settings?.tz || 'America/Vancouver';

const fields = {
  title: z.string().trim().min(1, 'Add a title').max(120),
  all_day: z.boolean(),
  day: z.string(),
  last_day: z.string().nullish(),
  start: z.string().nullish(),
  end: z.string().nullish(),
  place: z.string().trim().max(200).nullish(),
  details: z.string().trim().max(2000).nullish(),
  who: z.string().max(60),
};

// "team:<id>" → { who: 'team', team_id }, checked against this campaign.
const whoFrom = async (tx, ws, raw) => {
  const [kind, id] = String(raw || '').split(':');
  const no = () => httpError(400, 'Pick who sees it from the list');
  if (['everyone', 'candidates', 'managers'].includes(kind) && id === undefined) return { who: kind, team_id: null, candidate_id: null };
  if (!UUID.test(id || '')) throw no();
  if (kind === 'team') {
    const t = (await tx.query('select 1 from teams where id = $1 and workspace_id = $2 and deleted_at is null', [id, ws])).rows[0];
    if (!t) throw no();
    return { who: 'team', team_id: id, candidate_id: null };
  }
  if (kind === 'candidate') {
    const c = (await tx.query('select 1 from candidates where id = $1 and workspace_id = $2 and removed_at is null', [id, ws])).rows[0];
    if (!c) throw no();
    return { who: 'candidate', team_id: null, candidate_id: id };
  }
  throw no();
};

// The form's words → the row's times, on the campaign's clock.
const timesFrom = (input, tz) => {
  if (!isDay(input.day)) throw httpError(400, 'Pick a day');
  if (input.all_day) {
    const last = input.last_day || input.day;
    if (!isDay(last)) throw httpError(400, 'Pick the last day');
    if (last < input.day) throw httpError(400, 'The last day is before the first');
    return { all_day: true, starts_at: null, ends_at: null, first_day: input.day, last_day: last };
  }
  if (!isClock(input.start)) throw httpError(400, 'Add a start time, or make it all day');
  if (input.end && !isClock(input.end)) throw httpError(400, 'Pick an end time');
  if (input.end && input.end <= input.start) throw httpError(400, 'It ends before it starts');
  return {
    all_day: false,
    starts_at: instantOf(input.day, input.start, tz),
    ends_at: input.end ? instantOf(input.day, input.end, tz) : null,
    first_day: null,
    last_day: null,
  };
};

const COLS = 'id, title, all_day, starts_at, ends_at, first_day, last_day, place, details, who, team_id, candidate_id';
const itemOut = (r) => ({
  ...r,
  first_day: r.first_day instanceof Date ? r.first_day.toISOString().slice(0, 10) : r.first_day,
  last_day: r.last_day instanceof Date ? r.last_day.toISOString().slice(0, 10) : r.last_day,
});
const loadItem = async (tx, ws, id) => {
  const r = (await tx.query(`select ${COLS} from calendar_items where id = $1 and workspace_id = $2 and removed_at is null for update`, [id, ws])).rows[0];
  if (!r) throw httpError(404, 'not found');
  return r;
};
const saveRow = async (tx, ctx, input) => {
  const times = timesFrom(input, tzOf(ctx));
  const who = await whoFrom(tx, ctx.workspaceId, input.who);
  return { ...times, ...who, title: input.title, place: input.place || null, details: input.details || null };
};

export const actions = {
  'calendar.item.add': {
    roles: MANAGER,
    input: z.object(fields),
    handler: async (tx, ctx, input, emit) => {
      const row = await saveRow(tx, ctx, input);
      const id = newId();
      const made = (await tx.query(
        `insert into calendar_items (id, workspace_id, title, all_day, starts_at, ends_at, first_day, last_day, place, details, who, team_id, candidate_id, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) returning ${COLS}`,
        [id, ctx.workspaceId, row.title, row.all_day, row.starts_at, row.ends_at, row.first_day, row.last_day, row.place, row.details, row.who, row.team_id, row.candidate_id, ctx.user.id],
      )).rows[0];
      emit('calendar_item', id, 'create', { title: row.title, who: input.who });
      return { item: itemOut(made) };
    },
  },
  'calendar.item.edit': {
    roles: MANAGER,
    input: z.object({ id: z.uuid(), ...fields }),
    handler: async (tx, ctx, input, emit) => {
      const cur = await loadItem(tx, ctx.workspaceId, input.id);
      const row = await saveRow(tx, ctx, input);
      const saved = (await tx.query(
        `update calendar_items set title = $3, all_day = $4, starts_at = $5, ends_at = $6, first_day = $7, last_day = $8,
                place = $9, details = $10, who = $11, team_id = $12, candidate_id = $13, updated_at = now()
          where id = $1 and workspace_id = $2 returning ${COLS}`,
        [cur.id, ctx.workspaceId, row.title, row.all_day, row.starts_at, row.ends_at, row.first_day, row.last_day, row.place, row.details, row.who, row.team_id, row.candidate_id],
      )).rows[0];
      emit('calendar_item', cur.id, 'update', { title: row.title, who: input.who });
      return { item: itemOut(saved) };
    },
  },
  'calendar.item.remove': {
    roles: MANAGER,
    input: z.object({ id: z.uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const cur = await loadItem(tx, ctx.workspaceId, input.id);
      await tx.query('update calendar_items set removed_at = now(), updated_at = now() where id = $1 and workspace_id = $2', [cur.id, ctx.workspaceId]);
      emit('calendar_item', cur.id, 'void', {});
      return { removed: true, id: cur.id };
    },
  },
};

// The form's choices: everyone, all candidates, each seat, managers, each team.
const whoChoices = async (db, ws) => {
  const seats = (await db.query('select id, name from candidates where workspace_id = $1 and removed_at is null order by position, name', [ws])).rows;
  const teams = (await db.query('select id, name from teams where workspace_id = $1 and deleted_at is null order by lower(name)', [ws])).rows;
  return [
    { value: 'everyone', label: 'Everyone' },
    { value: 'candidates', label: 'All candidates' },
    ...seats.map((s) => ({ value: `candidate:${s.id}`, label: s.name })),
    { value: 'managers', label: 'Managers' },
    ...teams.map((t) => ({ value: `team:${t.id}`, label: t.name })),
  ];
};

export const api = new Hono();

api.get('/calendar', async (c) => {
  const ctx = c.get('ctx');
  const db = c.get('db');
  const tz = tzOf(ctx);
  const today = todayOf(ctx);
  const asked = c.req.query('month') || '';
  if (asked && !MONTH.test(asked)) return c.json({ error: 'month: YYYY-MM' }, 400);
  const month = asked || today.slice(0, 7);
  const fromDay = `${month}-01`;
  // The next month's first day: 31 days on from any first is in the next month.
  const next = `${addDays(fromDay, 31).slice(0, 7)}-01`;
  const span = { from: zonedISO(fromDay, 0, tz), to: zonedISO(next, 0, tz), fromDay, toDay: addDays(next, -1) };
  const v = viewerOf(ctx);
  const canEvery = seesEvery(v);
  const entries = await calendarFor(db, v, span, { every: canEvery && c.req.query('every') === '1' });
  const canAdd = mayRun(ctx, 'calendar.item.add', actions['calendar.item.add']);
  return c.json({ month, today, tz, entries, canAdd, canEvery, ...(canAdd ? { who: await whoChoices(db, ctx.workspaceId) } : {}) });
});

export const exportTables = ['calendar_items'];
