// What goes into a calendar: a person's own shifts, the voting days and the
// filing dates — read once here for the calendar link and the one-item
// files alike.
import { dayEvent } from '@starbase/shared/ics';
import { decide } from '../../lib/perms.js';
import { DESK_ROLES } from '../../lib/twostep.js';

// The roles that handle money (receipts' MONEY_ROLES, filing dates' rule),
// and only while not kept out of Donations. Default-closed: a role added
// later gets no filing dates until someone decides.
export const MONEY_ROLES = ['manager', 'treasurer', 'staff'];
export const seesMoney = (role, perms) => MONEY_ROLES.includes(role) && decide(perms, 'money') !== false;
export const isDesk = (role) => DESK_ROLES.includes(role);

// Bookings that hold a spot.
const HOLDING = ['assigned', 'confirmed', 'completed'];
const MAX_SHIFTS = 1000;
const dateOnly = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d ?? '').slice(0, 10));

// The shifts booked for the person whose email is this login's, from 30
// days ago on, soonest first. Driven from persons by (workspace_id,
// lower(email)), then the person's bookings by (workspace_id, person_id),
// then each shift and place by key — never a scan of shifts. A booking's own
// hours and drop_in are SH's columns, read through to_jsonb so this works
// before and after them (null before).
export const MY_SHIFTS_SQL = `
  select s.id, s.title, s.kind, s.starts_at, s.ends_at, s.location, s.instructions, s.link,
         to_jsonb(s)->>'drop_in' as drop_in, pl.lat as place_lat, pl.lng as place_lng,
         to_jsonb(a)->>'arrive_at' as arrive_at, to_jsonb(a)->>'leave_at' as leave_at
    from persons p
    join shift_assignments a on a.workspace_id = p.workspace_id and a.person_id = p.id
    join shifts s on s.id = a.shift_id
    left join places pl on pl.id = s.place_id
   where p.workspace_id = $1 and lower(p.email) = $2 and p.deleted_at is null
     and a.status = any($3::text[])
     and s.workspace_id = $1 and s.deleted_at is null
     and coalesce(s.ends_at, s.starts_at) >= now() - interval '30 days'
   order by s.starts_at, s.id
   limit ${MAX_SHIFTS}`;

export const myShifts = async (db, workspaceId, email) => {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return [];
  const rows = (await db.query(MY_SHIFTS_SQL, [workspaceId, e, HOLDING])).rows;
  // Two records with the same email on one shift: one entry.
  const seen = new Set();
  return rows.filter((r) => (seen.has(r.id) ? false : seen.add(r.id)));
};

// The voting days, all-day, soonest first: advance voting, then election
// day. No places or hours are stored, so the entry says only whose it is.
export const votingDays = async (db, workspaceId, campaignName) => {
  const s = (await db.query('select election_day, advance_days from voted_settings where workspace_id = $1', [workspaceId])).rows[0];
  if (!s) return [];
  const raw = typeof s.advance_days === 'string' ? JSON.parse(s.advance_days) : (s.advance_days || []);
  const election = s.election_day ? dateOnly(s.election_day) : null;
  const advance = [...new Set((Array.isArray(raw) ? raw : []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d !== election))].sort();
  return [
    ...advance.map((day) => ({ day, title: 'Advance voting' })),
    ...(election ? [{ day: election, title: 'Election day' }] : []),
  ].sort((a, b) => a.day.localeCompare(b.day))
    .map(({ day, title }) => dayEvent({ uid: `vote-${day}@base.win`, title, day, details: campaignName }))
    .filter(Boolean);
};

// The financial agent's filing dates, all-day, titled as typed.
export const filingDays = async (db, workspaceId, slot = null) => (await db.query(
  'select slot, name, due_on from filing_dates where workspace_id = $1 and ($2::int is null or slot = $2) order by slot',
  [workspaceId, slot],
)).rows.map((r) => {
  const day = dateOnly(r.due_on);
  return dayEvent({ uid: `filing-${r.slot}-${day}@base.win`, title: r.name, day });
}).filter(Boolean);
