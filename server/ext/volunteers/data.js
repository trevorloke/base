// Who the campaign's volunteers are, and how each is doing — read once and
// shared by the roster (GET /volunteers) and the crew board's "Add people"
// tray (GET /crew/:shiftId).
//
// A volunteer is anyone who:
//   holds a volunteer role (driver, doorknocking, candidate aide, …),
//   has ever been on a shift,
//   asked to volunteer (a door request, the membership form, Mainstreeting),
//   signed in to the app as a volunteer (matched by login email), or
//   carries the "volunteer" tag (an import, the membership form).
// Built from the small tables first (roles, shifts, requests, members), so a
// city-wide voter list is read only for the tag — never row by row.
//
// For each: their roles; shifts done (checked in as done, or on a shift
// that is over and not marked otherwise), no-shows, upcoming shifts and
// the next one; the last shift and the last door or call they logged;
// whether they asked to volunteer and it's still open; an app sign-in.
// stage: 'active' (a shift coming up, or busy in the last 30 days), 'new'
// (nothing done yet), 'lapsed' (did something once, nothing for 30 days).
import { noCallSql } from '../../lib/reach.js';
import { azKey } from '../../lib/az.js';

const ACTIVE = ['assigned', 'confirmed'];
const DAY = 864e5;
export const ACTIVE_DAYS = 30;
const MAX = 5000;

const iso = (v) => (v instanceof Date ? v.toISOString() : v || null);
const later = (a, b) => (!a ? b : !b ? a : (new Date(a) > new Date(b) ? a : b));

export const loadVolunteers = async (db, ws, { now = new Date() } = {}) => {
  const ids = (await db.query(
    `select person_id as id from volunteer_roles where workspace_id = $1
     union select person_id from shift_assignments where workspace_id = $1
     union select person_id from door_requests where workspace_id = $1 and kind = 'volunteer'
     union select p.id from memberships m
       join users u on u.id = m.user_id
       join persons p on p.workspace_id = $1 and p.deleted_at is null and p.email is not null and lower(p.email) = lower(u.email)
       where m.workspace_id = $1 and m.role = 'volunteer'
     union select id from persons
       where workspace_id = $1 and deleted_at is null and (tags @> '["volunteer"]'::jsonb or tags @> '["Volunteer"]'::jsonb)`,
    [ws],
  )).rows.map((r) => r.id);
  if (!ids.length) return [];
  const people = (await db.query(
    `select p.id, p.name, p.last_name, p.phone, p.email, p.created_at, ${noCallSql('p')} as no_call from persons p
     where p.workspace_id = $1 and p.deleted_at is null and p.id = any($2::uuid[])
     order by ${azKey('p')} limit ${MAX}`,
    [ws, ids],
  )).rows;
  if (!people.length) return [];
  const pid = people.map((p) => p.id);

  const roles = new Map();
  for (const r of (await db.query(
    'select person_id, role from volunteer_roles where workspace_id = $1 and person_id = any($2::uuid[]) order by created_at',
    [ws, pid],
  )).rows) {
    const list = roles.get(r.person_id) || [];
    if (!list.includes(r.role)) list.push(r.role);
    roles.set(r.person_id, list);
  }

  const stats = new Map((await db.query(
    `select a.person_id,
       count(*) filter (where a.status = 'completed'
         or (a.status = any($3::text[]) and coalesce(s.ends_at, s.starts_at) < $4))::int as done,
       count(*) filter (where a.status = 'no_show')::int as no_shows,
       count(*) filter (where a.status = any($3::text[]) and coalesce(s.ends_at, s.starts_at) >= $4)::int as upcoming,
       max(s.starts_at) filter (where (a.status = 'completed' or a.status = any($3::text[]))
         and coalesce(s.ends_at, s.starts_at) < $4) as last_shift_at
     from shift_assignments a join shifts s on s.id = a.shift_id and s.deleted_at is null
     where a.workspace_id = $1 and a.person_id = any($2::uuid[])
     group by a.person_id`,
    [ws, pid, ACTIVE, now.toISOString()],
  )).rows.map((r) => [r.person_id, r]));

  // Their upcoming shifts, soonest first (the roster flags a clash with these).
  const upcomingOf = new Map();
  for (const r of (await db.query(
    `select a.person_id, s.id, s.title, s.starts_at, s.ends_at
     from shift_assignments a join shifts s on s.id = a.shift_id and s.deleted_at is null
     where a.workspace_id = $1 and a.person_id = any($2::uuid[]) and a.status = any($3::text[])
       and coalesce(s.ends_at, s.starts_at) >= $4
     order by s.starts_at, s.id`,
    [ws, pid, ACTIVE, now.toISOString()],
  )).rows) {
    const list = upcomingOf.get(r.person_id) || [];
    list.push({ id: r.id, title: r.title, starts_at: iso(r.starts_at), ends_at: iso(r.ends_at) });
    upcomingOf.set(r.person_id, list);
  }

  const asked = new Map((await db.query(
    `select person_id, bool_or(done_at is null) as open, max(created_at) as asked_at
     from door_requests where workspace_id = $1 and kind = 'volunteer' and person_id = any($2::uuid[])
     group by person_id`,
    [ws, pid],
  )).rows.map((r) => [r.person_id, r]));

  // An app sign-in (login email = their email), and the last door or call
  // that sign-in logged.
  const users = (await db.query(
    `select p.id as person_id, u.id as user_id
     from persons p
     join users u on p.email is not null and lower(u.email) = lower(p.email)
     join memberships m on m.user_id = u.id and m.workspace_id = $1
     where p.workspace_id = $1 and p.id = any($2::uuid[])`,
    [ws, pid],
  )).rows;
  const userOf = new Map(users.map((r) => [r.person_id, r.user_id]));
  const lastContact = users.length ? new Map((await db.query(
    `select created_by, max(created_at) as at from contacts
     where workspace_id = $1 and created_by = any($2::uuid[]) group by created_by`,
    [ws, [...new Set(users.map((u) => u.user_id))]],
  )).rows.map((r) => [r.created_by, r.at])) : new Map();

  return people.map((p) => {
    const s = stats.get(p.id);
    const a = asked.get(p.id);
    const userId = userOf.get(p.id) || null;
    const lastShift = iso(s?.last_shift_at);
    const lastActive = later(lastShift, iso(userId ? lastContact.get(userId) : null));
    const upcoming = s?.upcoming || 0;
    const done = s?.done || 0;
    const recent = lastActive && now - new Date(lastActive) <= ACTIVE_DAYS * DAY;
    const stage = upcoming > 0 || recent ? 'active' : (done === 0 && !lastActive ? 'new' : 'lapsed');
    return {
      id: p.id,
      name: p.name,
      phone: p.phone || null,
      no_call: p.no_call,
      email: p.email || null,
      roles: roles.get(p.id) || [],
      signed_in: Boolean(userId),
      done,
      no_shows: s?.no_shows || 0,
      upcoming,
      next: upcomingOf.get(p.id)?.[0] || null,
      upcoming_shifts: upcomingOf.get(p.id) || [],
      last_shift_at: lastShift,
      last_active_at: lastActive,
      asked: Boolean(a?.open),
      asked_at: iso(a?.asked_at),
      since: iso(p.created_at),
      stage,
    };
  });
};

// Contact details are the desk's: a volunteer granted Shifts sees names,
// roles and how each is doing, never a phone or an email.
export const forRole = (ctx) => (v) => (ctx.role === 'volunteer' ? { ...v, phone: null, email: null, no_call: null } : v);
