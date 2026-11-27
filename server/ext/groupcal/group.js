// Who sees what on the group calendar — one rule for the page (GET
// /api/calendar) and the person's calendar link (ext/calendar /cal/<43>.ics):
//   every member   their own booked shifts and the website's public events
//                  (unless kept out of Shifts), the voting days, items for
//                  everyone and for a team they are on
//   a candidate    also items for all candidates and for their own seat
//   money roles    the filing dates (ext/calendar content.js's rule)
//   managers       every item, whoever it is for (and anyone given Admin,
//                  who may add items too)
//   every shift    the desk's Shifts board, on the page when asked — never
//                  in the link
// What an entry carries: its title, times, place, the item's notes, and who
// it is for. Never a shift's instructions, anyone's name on a shift, a
// phone or an email.
import { googleLink, shiftEvent } from '@starbase/shared/ics';
import { addDays, dayOf } from '@starbase/shared/dayparts';
import { shiftAppLink } from '../../lib/calendar.js';
import { DEFAULT_TZ } from '../../lib/org.js';
import { areasFor, decide } from '../../lib/perms.js';
import { loginEmail } from '../../lib/viewer.js';
import { filingDays, isDesk, seesMoney, votingDays } from '../calendar/content.js';

const HOLDING = ['assigned', 'confirmed', 'completed'];
const MAX_ITEMS = 1000;
const MAX_SHIFTS = 500;
const HOUR = 3600_000;
const dateOnly = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d ?? '').slice(0, 10));
const iso = (d) => (d == null ? null : new Date(d).toISOString());

// The person reading: from a signed-in request, or (the link) from the row
// the link's token found.
export const viewerOf = (ctx) => ({
  workspaceId: ctx.workspaceId,
  userId: ctx.user.id,
  role: ctx.role,
  perms: ctx.perms,
  candidateId: ctx.candidate?.id || null,
  email: loginEmail(ctx),
  tz: ctx.workspace?.settings?.tz || DEFAULT_TZ,
  name: ctx.workspace?.name || '',
  publicUrl: ctx.publicUrl || null,
});

export const seesAll = (v) => v.role === 'manager' || decide(v.perms, 'admin') === true;
export const seesShifts = (v) => decide(v.perms, 'shifts') !== false;
// The Shifts board: whoever has the Shifts area (a desk role, or given it).
export const seesEvery = (v) => areasFor({ role: v.role, perms: v.perms }).includes('shifts');

const teamsOf = async (db, v) => (await db.query(
  `select tm.team_id from team_members tm join teams t on t.id = tm.team_id and t.deleted_at is null
    where tm.workspace_id = $1 and tm.user_id = $2`,
  [v.workspaceId, v.userId],
)).rows.map((r) => r.team_id);

// The words for who an item is for, and the form's value for it. A team
// since deleted, or a seat since removed, says so: "Sign crew (removed)".
const gone = (name, fallback, isGone) => `${name || fallback}${isGone ? ' (removed)' : ''}`;
const whoOf = (r) => {
  if (r.who === 'team') return { label: gone(r.team_name, 'A team', r.team_gone), value: `team:${r.team_id}` };
  if (r.who === 'candidate') return { label: gone(r.candidate_name, 'A candidate', r.candidate_gone), value: `candidate:${r.candidate_id}` };
  return { label: { everyone: 'Everyone', candidates: 'Candidates', managers: 'Managers' }[r.who] || 'Everyone', value: r.who };
};

// An item as a calendar entry (shared/ics.js). Its stamp is when it last
// changed, so a calendar takes an edit.
export const itemEvent = (r) => {
  const base = { uid: `item-${r.id}@base.win`, title: r.title, where: r.place || '', details: r.details || null, stamp: r.updated_at ? new Date(r.updated_at) : undefined };
  if (r.all_day) return { ...base, allDay: true, start: dateOnly(r.first_day), end: addDays(dateOnly(r.last_day || r.first_day), 1) };
  const start = iso(r.starts_at);
  return { ...base, start, end: r.ends_at ? iso(r.ends_at) : new Date(new Date(start).getTime() + HOUR).toISOString() };
};

// The span read: moments (from, to) and the campaign's days (fromDay,
// toDay — both included). to / toDay null: no end.
const ITEM_SQL = `
  select i.*, t.name as team_name, c.name as candidate_name,
         t.deleted_at is not null as team_gone, c.removed_at is not null as candidate_gone
    from calendar_items i
    left join teams t on t.id = i.team_id and t.workspace_id = i.workspace_id
    left join candidates c on c.id = i.candidate_id and c.workspace_id = i.workspace_id
   where i.workspace_id = $1 and i.removed_at is null
     and (case when i.all_day
               then i.last_day >= $2::date and ($3::date is null or i.first_day <= $3::date)
               else coalesce(i.ends_at, i.starts_at) >= $4::timestamptz and ($5::timestamptz is null or i.starts_at < $5::timestamptz) end)
     and ($6::boolean
          or i.who = 'everyone'
          or (i.who = 'candidates' and $7::uuid is not null)
          or (i.who = 'candidate' and i.candidate_id = $7::uuid)
          or (i.who = 'team' and i.team_id = any($8::uuid[])))
   order by coalesce(i.starts_at, i.first_day::timestamptz), i.created_at
   limit ${MAX_ITEMS}`;

// The same rule as one test, for rows read some other way (the data
// export): does this person see this item on their calendar?
export const seesItem = async (db, v) => {
  if (seesAll(v)) return () => true;
  const teams = new Set(await teamsOf(db, v));
  return (r) => r.who === 'everyone'
    || (r.who === 'candidates' && v.candidateId != null)
    || (r.who === 'candidate' && r.candidate_id === v.candidateId)
    || (r.who === 'team' && teams.has(r.team_id));
};

export const itemsFor = async (db, v, span) => {
  const all = seesAll(v);
  const teams = all ? [] : await teamsOf(db, v);
  return (await db.query(ITEM_SQL, [v.workspaceId, span.fromDay, span.toDay, span.from, span.to, all, v.candidateId, teams])).rows;
};

// The person's own booked shifts in the span: driven from their person
// record by email, as the link's (ext/calendar content.js MY_SHIFTS_SQL).
const MINE_SQL = `
  select s.id, s.title, s.kind, s.starts_at, s.ends_at, s.location,
         to_jsonb(s)->>'drop_in' as drop_in, pl.lat as place_lat, pl.lng as place_lng,
         to_jsonb(a)->>'arrive_at' as arrive_at, to_jsonb(a)->>'leave_at' as leave_at
    from persons p
    cross join lateral (
      select a.* from shift_assignments a
       where a.workspace_id = $1 and a.person_id = p.id and a.status = any($3::text[])
      offset 0
    ) a
    join shifts s on s.id = a.shift_id
    left join places pl on pl.id = s.place_id
   where p.workspace_id = $1 and lower(p.email) = $2 and p.deleted_at is null
     and s.workspace_id = $1 and s.deleted_at is null
     and coalesce(s.ends_at, s.starts_at) >= $4::timestamptz and s.starts_at < $5::timestamptz
   order by s.starts_at, s.id
   limit ${MAX_SHIFTS}`;
const mineIn = async (db, v, span) => {
  const e = String(v.email || '').trim().toLowerCase();
  if (!e) return [];
  const seen = new Set();
  return (await db.query(MINE_SQL, [v.workspaceId, e, HOLDING, span.from, span.to])).rows
    .filter((r) => (seen.has(r.id) ? false : seen.add(r.id)));
};
// Shifts in the span: the website's public events, or (every) all of them.
const shiftsIn = async (db, v, span, { publicOnly }) => (await db.query(
  `select s.id, s.title, s.kind, s.starts_at, s.ends_at, s.location, to_jsonb(s)->>'drop_in' as drop_in,
          pl.lat as place_lat, pl.lng as place_lng
     from shifts s left join places pl on pl.id = s.place_id
    where s.workspace_id = $1 and s.deleted_at is null and ($4::boolean is false or s.public)
      and coalesce(s.ends_at, s.starts_at) >= $2::timestamptz and ($3::timestamptz is null or s.starts_at < $3::timestamptz)
    order by s.starts_at, s.id limit ${MAX_SHIFTS}`,
  [v.workspaceId, span.from, span.to, publicOnly],
)).rows;

const shiftEntry = (s, v, kind) => {
  const event = shiftEvent(s, {
    tz: v.tz, private: false,
    booking: kind === 'shift' ? { arrive_at: s.arrive_at ?? null, leave_at: s.leave_at ?? null } : null,
    appUrl: v.publicUrl ? shiftAppLink(v.publicUrl, { desk: isDesk(v.role), id: s.id }) : null,
  });
  return {
    key: `${kind}-${s.id}`, kind, shift_id: s.id, title: event.title, allDay: false,
    start: event.start, end: s.ends_at || s.leave_at ? event.end : null, day: dayOf(event.start, v.tz), where: event.where || '',
    mine: kind === 'shift', event, google: googleLink(event),
  };
};
const dayEntry = (e, kind) => ({
  key: `${kind}-${e.start}-${e.title}`, kind, title: e.title, allDay: true, start: e.start, end: e.end,
  day: e.start, last_day: addDays(e.end, -1), where: '', event: e, google: googleLink(e),
});
const itemEntry = (r, v) => {
  const event = itemEvent(r);
  const who = whoOf(r);
  return {
    key: `item-${r.id}`, kind: 'item', id: r.id, title: r.title, allDay: Boolean(r.all_day),
    start: event.start, end: r.all_day ? event.end : iso(r.ends_at),
    day: r.all_day ? event.start : dayOf(event.start, v.tz), ...(r.all_day ? { last_day: dateOnly(r.last_day || r.first_day) } : {}),
    where: r.place || '', details: r.details || '', who: who.label,
    ...(seesAll(v) ? { value: who.value } : {}),
    event, google: googleLink(event),
  };
};

// The page's month: every entry this person may see, soonest first (a day's
// all-day entries before its timed ones).
export const calendarFor = async (db, v, span, { every = false } = {}) => {
  const out = [];
  const shifts = seesShifts(v);
  const mine = shifts ? await mineIn(db, v, span) : [];
  const mineIds = new Set(mine.map((s) => s.id));
  out.push(...mine.map((s) => shiftEntry(s, v, 'shift')));
  if (shifts) {
    const publicOnly = !(every && seesEvery(v));
    for (const s of await shiftsIn(db, v, span, { publicOnly })) {
      if (!mineIds.has(s.id)) out.push(shiftEntry(s, v, publicOnly ? 'event' : 'every'));
    }
  }
  const inSpan = (e) => e.start <= span.toDay && addDays(e.end, -1) >= span.fromDay;
  out.push(...(await votingDays(db, v.workspaceId, v.name)).filter(inSpan).map((e) => dayEntry(e, 'vote')));
  if (seesMoney(v.role, v.perms)) out.push(...(await filingDays(db, v.workspaceId)).filter(inSpan).map((e) => dayEntry(e, 'filing')));
  out.push(...(await itemsFor(db, v, span)).map((r) => itemEntry(r, v)));
  const at = (e) => (e.allDay ? `${e.day}T00:00:00.000Z` : e.start);
  return out
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.day.localeCompare(b.e.day) || (b.e.allDay - a.e.allDay) || at(a.e).localeCompare(at(b.e)) || a.i - b.i)
    .map(({ e }) => e);
};

// What the link adds to its shifts, voting days and filing dates: the
// public events and this person's items, from 30 days back. uids: what the
// link already holds (a public event they are booked on is there already).
export const linkExtras = async (db, v, uids = new Set()) => {
  const from = new Date(Date.now() - 30 * 24 * HOUR).toISOString();
  const span = { from, to: null, fromDay: from.slice(0, 10), toDay: null };
  const out = [];
  if (seesShifts(v)) {
    for (const s of await shiftsIn(db, v, span, { publicOnly: true })) {
      const e = shiftEvent(s, { tz: v.tz, private: false, appUrl: v.publicUrl ? shiftAppLink(v.publicUrl, { desk: isDesk(v.role), id: s.id }) : null });
      if (!uids.has(e.uid)) out.push(e);
    }
  }
  out.push(...(await itemsFor(db, v, span)).map(itemEvent));
  return out;
};
