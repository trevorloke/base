// GET /volunteers         the roster: every volunteer (data.js) with their
//                         roles and how they're doing, and counts by stage
// GET /crew/:shiftId      the crew board for one shift: the shift, its turfs,
//                         everyone booked on it (where the board put them,
//                         their job, an app sign-in, first shift), those
//                         who can't make it, and the "Add people" tray —
//                         volunteers not on it, each free or busy then
//                         (another shift that overlaps), roles, asked to
//                         volunteer, shifts done
// Both are the desk's (deskOnlyReads — or a volunteer granted Shifts, who
// sees no phone or email). Area: shifts (lib/perms.js).
import { Hono } from 'hono';
import { ACTIVE_DAYS, forRole, loadVolunteers } from './data.js';
import { noCallSql } from '../../lib/reach.js';
import { azKey } from '../../lib/az.js';

export const api = new Hono();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVE = ['assigned', 'confirmed'];
const iso = (v) => (v instanceof Date ? v.toISOString() : v || null);

api.get('/volunteers', async (c) => {
  const ctx = c.get('ctx');
  const rows = (await loadVolunteers(c.get('db'), ctx.workspaceId)).map(forRole(ctx));
  const counts = { all: rows.length, active: 0, new: 0, lapsed: 0, asked: 0 };
  for (const r of rows) {
    counts[r.stage] += 1;
    if (r.asked) counts.asked += 1;
  }
  return c.json({ volunteers: rows, counts, active_days: ACTIVE_DAYS });
});

api.get('/crew/:shiftId', async (c) => {
  const id = c.req.param('shiftId');
  if (!UUID_RE.test(id)) return c.json({ error: 'not found' }, 404);
  const ctx = c.get('ctx');
  const db = c.get('db');
  const ws = ctx.workspaceId;
  const shift = (await db.query(
    `select id, title, role, location, starts_at, ends_at, capacity from shifts
     where id = $1 and workspace_id = $2 and deleted_at is null`,
    [id, ws],
  )).rows[0];
  if (!shift) return c.json({ error: 'not found' }, 404);
  const turfs = (await db.query(
    `select t.id, t.name, t.color from shift_turfs st join turfs t on t.id = st.turf_id and t.deleted_at is null
     where st.workspace_id = $1 and st.shift_id = $2 order by t.created_at, t.id`,
    [ws, id],
  )).rows;
  const turfIds = new Set(turfs.map((t) => t.id));
  const booked = (await db.query(
    `select a.id as assignment_id, a.status, a.person_id, a.arrive_at, a.leave_at, p.name, p.last_name, p.phone, p.email, ${noCallSql('p')} as no_call,
            c.placed, c.turf_id, c.job,
            exists (select 1 from users u join memberships m on m.user_id = u.id and m.workspace_id = $1
                    where p.email is not null and lower(u.email) = lower(p.email)) as signed_in
     from shift_assignments a
     join persons p on p.id = a.person_id
     left join shift_crew c on c.assignment_id = a.id
     where a.workspace_id = $1 and a.shift_id = $2
     order by ${azKey('p')}, a.id`,
    [ws, id],
  )).rows;
  // A first shift: nothing done before on any other shift.
  const people = booked.map((b) => b.person_id);
  const seasoned = new Set(people.length ? (await db.query(
    `select distinct a.person_id from shift_assignments a join shifts s on s.id = a.shift_id and s.deleted_at is null
     where a.workspace_id = $1 and a.person_id = any($2::uuid[]) and a.shift_id <> $3
       and (a.status = 'completed' or (a.status = any($4::text[]) and coalesce(s.ends_at, s.starts_at) < now()))`,
    [ws, people, id, ACTIVE],
  )).rows.map((r) => r.person_id) : []);
  const view = ctx.role === 'volunteer';
  const crewOut = (b) => ({
    assignment_id: b.assignment_id,
    person_id: b.person_id,
    name: b.name,
    last_name: b.last_name ?? null,
    phone: view ? null : b.phone || null,
    no_call: view ? null : b.no_call,
    email: view ? null : b.email || null,
    status: b.status,
    // Where the board put them: 'every' (not placed), 'none', or a turf id —
    // a turf the shift no longer carries reads as not placed.
    to: b.placed === 'none' ? 'none' : b.placed === 'turf' && turfIds.has(b.turf_id) ? b.turf_id : 'every',
    job: b.job || null,
    // Their own hours inside the shift (ext/schedule/hours.js), null for
    // the whole shift: who comes late, who leaves early.
    arrive_at: iso(b.arrive_at),
    leave_at: iso(b.leave_at),
    signed_in: Boolean(b.signed_in),

    first_shift: !seasoned.has(b.person_id),
  });
  // On the board: booked, or checked in as done. Off it: couldn't make it,
  // didn't show.
  const ON_BOARD = [...ACTIVE, 'completed'];
  const crew = booked.filter((b) => ON_BOARD.includes(b.status)).map(crewOut);
  const out = booked.filter((b) => !ON_BOARD.includes(b.status)).map(crewOut);

  // The tray: volunteers not on this shift in any way, each free or busy
  // then. A shift with no end counts as an hour.
  const onIt = new Set(people);
  const starts = new Date(shift.starts_at);
  const ends = shift.ends_at ? new Date(shift.ends_at) : new Date(starts.getTime() + 3600e3);
  const busy = new Map((await db.query(
    `select distinct on (a.person_id) a.person_id, s.id, s.title, s.starts_at
     from shift_assignments a join shifts s on s.id = a.shift_id and s.deleted_at is null
     where a.workspace_id = $1 and a.shift_id <> $2 and a.status = any($3::text[])
       and s.starts_at < $5 and coalesce(s.ends_at, s.starts_at + interval '1 hour') > $4
     order by a.person_id, s.starts_at`,
    [ws, id, ACTIVE, starts.toISOString(), ends.toISOString()],
  )).rows.map((r) => [r.person_id, { id: r.id, title: r.title, starts_at: iso(r.starts_at) }]));
  const tray = (await loadVolunteers(db, ws))
    .filter((v) => !onIt.has(v.id))
    .map((v) => ({ ...forRole(ctx)(v), busy: busy.get(v.id) || null }));

  return c.json({
    shift: { ...shift, starts_at: iso(shift.starts_at), ends_at: iso(shift.ends_at) },
    turfs,
    crew,
    out,
    tray,
  });
});
