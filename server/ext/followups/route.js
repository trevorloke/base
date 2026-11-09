// Who follows up: one named organizer for each new volunteer, message and
// RSVP. In order:
//   1. brought_in  the teammate who brought them in — the website's
//                  referral (the site action's referrer) or "Brought in by"
//                  in My people (relationships.brought_in)
//   2. knows       a teammate who knows them (My people: a live link) —
//                  the one with the fewest open follow-ups, then the
//                  oldest link
//   3. turf        someone walking a turf their pin falls in: a captain
//                  first (their own record holds a captain role), then
//                  whoever the desk put on the turf by hand, then anyone a
//                  shift put there — the fewest open follow-ups, then by name
//   4. office      the managers: the one with the fewest open follow-ups,
//                  then the longest on the team
// A teammate is someone who signs in to this campaign; their own record is
// the one with their login email (as My people finds it). → { userId,
// name, routed } or null (a campaign with no manager can't happen: the one
// who set it up is one).
import { pointInPolygon } from '../../lib/geo.js';

const CAPTAIN_ROLES = ['zone_house_captain', 'highrise_captain'];
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

// Teammates by their own records: person id → { user_id, name, role }.
const teamByPerson = async (tx, ws, personIds) => {
  if (!personIds.length) return new Map();
  const rows = (await tx.query(
    `select distinct on (p.id) p.id as person_id, u.id as user_id, u.name, m.role
     from persons p
     join users u on lower(u.email) = lower(p.email)
     join memberships m on m.user_id = u.id and m.workspace_id = $1
     where p.workspace_id = $1 and p.id = any($2::uuid[]) and p.deleted_at is null and p.email is not null
     order by p.id, m.created_at`,
    [ws, personIds],
  )).rows;
  return new Map(rows.map((r) => [r.person_id, r]));
};

// Open follow-ups each teammate has now (fewest first is the fair pick).
const loadOf = async (tx, ws, userIds) => {
  if (!userIds.length) return new Map();
  return new Map((await tx.query(
    `select assigned_to, count(*)::int as n from ladder_followups
     where workspace_id = $1 and status = 'open' and assigned_to = any($2::uuid[]) group by assigned_to`,
    [ws, userIds],
  )).rows.map((r) => [r.assigned_to, r.n]));
};

// The person themself, if they are on the team: never their own organizer.
export const teammateOf = async (tx, ws, personId) => (await teamByPerson(tx, ws, [personId])).get(personId) || null;

const pick = (r, routed) => (r ? { userId: r.user_id, name: r.name, routed } : null);

const broughtInBy = async (tx, ws, personId, referrerId) => {
  const by = [];
  if (referrerId) by.push(referrerId);
  for (const r of (await tx.query(
    `select from_person from relationships
     where workspace_id = $1 and brought_in = $2 and from_person is not null order by created_at`,
    [ws, personId],
  )).rows) by.push(r.from_person);
  const team = await teamByPerson(tx, ws, [...new Set(by)].filter((id) => id !== personId));
  for (const id of by) if (team.has(id)) return pick(team.get(id), 'brought_in');
  return null;
};

const knownBy = async (tx, ws, personId) => {
  const links = (await tx.query(
    `select case when person_a = $2 then person_b else person_a end as other, created_at
     from relationships where workspace_id = $1 and removed_at is null and (person_a = $2 or person_b = $2)
     order by created_at`,
    [ws, personId],
  )).rows;
  const team = await teamByPerson(tx, ws, links.map((l) => l.other));
  const them = links.map((l) => team.get(l.other)).filter(Boolean);
  if (!them.length) return null;
  const load = await loadOf(tx, ws, them.map((t) => t.user_id));
  // Stable: links are oldest first, and sort keeps that order among equals.
  them.sort((a, b) => (load.get(a.user_id) || 0) - (load.get(b.user_id) || 0));
  return pick(them[0], 'knows');
};

const turfOrganizer = async (tx, ws, personId) => {
  const p = (await tx.query('select lat, lng from persons where id = $1 and workspace_id = $2', [personId, ws])).rows[0];
  if (p?.lat == null || p?.lng == null) return null;
  const lat = Number(p.lat);
  const lng = Number(p.lng);
  const turfs = (await tx.query(
    'select id, polygon from turfs where workspace_id = $1 and deleted_at is null', [ws],
  )).rows.filter((t) => {
    const ring = (parse(t.polygon) || []).map(([a, b]) => [Number(a), Number(b)]);
    return ring.length >= 3 && pointInPolygon(lat, lng, ring);
  });
  if (!turfs.length) return null;
  // by_hand: on one of these turfs by the desk's hand, not only for a shift
  // (ext/shiftturfs keeps a walker row for what a shift gave).
  const members = (await tx.query(
    `select u.id as user_id, u.name, m.role,
       exists (select 1 from persons me join volunteer_roles v on v.person_id = me.id and v.workspace_id = me.workspace_id
               where me.workspace_id = $1 and me.deleted_at is null and lower(me.email) = lower(u.email)
                 and v.role = any($3::text[])) as captain,
       bool_or(not exists (select 1 from shift_turf_walkers w
                           where w.workspace_id = $1 and w.turf_id = tm.turf_id and w.user_id = u.id)) as by_hand
     from turf_members tm
     join users u on u.id = tm.user_id
     join memberships m on m.user_id = u.id and m.workspace_id = $1
     where tm.workspace_id = $1 and tm.turf_id = any($2::uuid[])
     group by u.id, u.name, u.email, m.role`,
    [ws, turfs.map((t) => t.id), CAPTAIN_ROLES],
  )).rows;
  if (!members.length) return null;
  const load = await loadOf(tx, ws, members.map((m) => m.user_id));
  members.sort((a, b) => (b.captain - a.captain) || (b.by_hand - a.by_hand)
    || ((load.get(a.user_id) || 0) - (load.get(b.user_id) || 0))
    || String(a.name).localeCompare(String(b.name)));
  return pick(members[0], 'turf');
};

const office = async (tx, ws) => {
  const managers = (await tx.query(
    `select u.id as user_id, u.name, m.role from memberships m join users u on u.id = m.user_id
     where m.workspace_id = $1 and m.role = 'manager' order by m.created_at, u.id`,
    [ws],
  )).rows;
  if (!managers.length) return null;
  const load = await loadOf(tx, ws, managers.map((m) => m.user_id));
  managers.sort((a, b) => (load.get(a.user_id) || 0) - (load.get(b.user_id) || 0));
  return pick(managers[0], 'office');
};

export const routeFollowup = async (tx, ws, personId, { referrerId = null } = {}) => (
  await broughtInBy(tx, ws, personId, referrerId)
  || await knownBy(tx, ws, personId)
  || await turfOrganizer(tx, ws, personId)
  || office(tx, ws)
);

// Only the turf (a pin that arrived after the follow-up was made: the
// address lookup runs just after the save); only the office (a ladder's
// own follow-up whose organizer left).
export { turfOrganizer, office as officeOf };
