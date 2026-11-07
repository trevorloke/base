// The field report's numbers: knocks at the door, by turf, by canvasser and
// by day, over a range of the campaign's days; and one person's all-time
// line for Today. Reads only.
//
//   rangeOf(query, tz)            { from, to } as YYYY-MM-DD (from may be
//                                 'all'), defaults the last 30 days; a bad
//                                 date is a 400
//   boundsOf(db, range, tz)       the range as timestamptz bounds: from the
//                                 start of `from` to the start of the day
//                                 after `to`, in the campaign's zone
//   doorContacts(db, ws, b, tz)   the range's door knocks, each with its door
//   turfNumbers(db, ws, knocks)   per live turf: doors (the walk list's
//                                 grouping), people, knocked, coverage,
//                                 talked, support found, not-homes …
//   canvasserNumbers(db, ws, knocks)  per person who knocked
//   days(knocks)                  per day: doors knocked, talks
//   totals(turfs, canvassers)     the page's top line
//   mineAll(db, ws, userId, tz)   one person's knocks, all time (the brief)
//
// A door is the address + unit (the walk list's), or the person when they
// have no address — the brief's key. People are placed in a turf where their
// pin is today. Support found is the rating given with the knock (the
// contact row), never the person's rating now, so re-rating someone later
// never rewrites last week. An outcome this report doesn't know (a feature's
// own) counts under "other".
import { bandOf } from '@starbase/shared/scale';
import { pointInPolygon, groupDoors } from '../../lib/geo.js';
import { httpError } from '../../actions/util.js';
import { DEFAULT_TZ } from '../../lib/org.js';
import { fromLocal, toLocal } from '../../lib/tzsql.js';

// left_lit: a lit drop (ext/litdrop) — its own column, never a talk.
export const KNOWN = ['contacted', 'no_answer', 'refused', 'moved', 'inaccessible', 'left_lit'];
export const DEFAULT_DAYS = 30;

const YMD = /^\d{4}-\d{2}-\d{2}$/;
export const zoneOf = (tz) => {
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz || DEFAULT_TZ }); return tz || DEFAULT_TZ; } catch { return DEFAULT_TZ; }
};
// YYYY-MM-DD of a moment in the campaign's zone.
export const localDay = (d, tz) => {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
};
export const addDays = (ymd, n) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
// A real calendar day (not 2026-02-30).
const isDay = (s) => {
  if (!YMD.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

export const rangeOf = (query = {}, tz) => {
  const zone = zoneOf(tz);
  const rawTo = String(query.to ?? '').trim();
  const rawFrom = String(query.from ?? '').trim();
  const to = rawTo || localDay(new Date(), zone);
  if (!isDay(to)) throw httpError(400, 'from and to are dates');
  const from = rawFrom === 'all' ? 'all' : rawFrom || addDays(to, -(DEFAULT_DAYS - 1));
  if (from !== 'all' && !isDay(from)) throw httpError(400, 'from and to are dates');
  if (from !== 'all' && from > to) throw httpError(400, 'from is after to');
  return { from, to };
};

// The campaign's days as moments: [start, end).
export const boundsOf = async (db, range, tz) => {
  const r = (await db.query(
    `select ${fromLocal('($1::date)::timestamp', '$3::text')} as start,
            ${fromLocal('($2::date + 1)::timestamp', '$3::text')} as stop`,
    [range.from === 'all' ? null : range.from, range.to, zoneOf(tz)],
  )).rows[0];
  return { start: r.start ? new Date(r.start).toISOString() : null, end: new Date(r.stop).toISOString() };
};

export const doorKeyOf = (r) => {
  const a = String(r.address ?? '').trim().toLowerCase();
  return a ? `${a}|${String(r.unit ?? '').trim().toLowerCase()}` : `person:${r.person_id}`;
};
const iso = (v) => (v == null ? null : new Date(v).toISOString());
const later = (a, b) => (!a || new Date(b) > new Date(a) ? b : a);
const supportive = (rating) => rating != null && bandOf(rating) === 'support';
const parseJ = (v, d) => { try { return typeof v === 'string' ? JSON.parse(v) : (v ?? d); } catch { return d; } };

// The range's door knocks (phone calls and texts are never knocks), each
// with its door, its day in the campaign's zone and its pin (null: none).
export const doorContacts = async (db, ws, bounds, tz) => (await db.query(
  `select c.person_id, c.outcome, c.rating, c.created_by, c.created_at, c.source,
          to_char(${toLocal('c.created_at', '$4::text')}, 'YYYY-MM-DD') as day,
          p.lat, p.lng, p.address, p.unit
     from contacts c join persons p on p.id = c.person_id
    where c.workspace_id = $1 and c.channel = 'door'
      and ($2::timestamptz is null or c.created_at >= $2::timestamptz)
      and c.created_at < $3::timestamptz
    order by c.created_at`,
  [ws, bounds.start, bounds.end, zoneOf(tz)],
)).rows.map((r) => ({ ...r, door: doorKeyOf(r), created_at: iso(r.created_at) }));

// What a set of knocks adds up to (a turf's, a canvasser's).
const tally = (knocks) => {
  const out = {
    knocked: 0, talked: 0, support_found: 0, other: 0, canvassers: 0, last_at: null,
    ...Object.fromEntries(KNOWN.filter((o) => o !== 'contacted').map((o) => [o, 0])),
  };
  const doors = new Set(); const backers = new Set(); const who = new Set(); const days = new Set();
  for (const k of knocks) {
    doors.add(k.door);
    days.add(k.day);
    if (k.created_by) who.add(k.created_by);
    if (k.outcome === 'contacted') out.talked += 1;
    else if (KNOWN.includes(k.outcome)) out[k.outcome] += 1;
    else out.other += 1;
    if (supportive(k.rating)) backers.add(k.person_id);
    out.last_at = later(out.last_at, k.created_at);
  }
  out.knocked = doors.size;
  out.support_found = backers.size;
  out.canvassers = who.size;
  out.days_out = days.size;
  return out;
};

export const turfNumbers = async (db, ws, knocks) => {
  const turfs = (await db.query(
    'select id, name, color, polygon from turfs where workspace_id = $1 and deleted_at is null order by created_at', [ws],
  )).rows;
  const located = (await db.query(
    `select id, lat, lng, address, unit from persons
      where workspace_id = $1 and deleted_at is null and lat is not null and lng is not null`, [ws],
  )).rows;
  const pinned = knocks.filter((k) => k.lat != null && k.lng != null);
  return turfs.map((t) => {
    const ring = parseJ(t.polygon, []);
    const inside = located.filter((p) => pointInPolygon(p.lat, p.lng, ring));
    const doors = groupDoors(inside).length;
    const n = tally(pinned.filter((k) => pointInPolygon(k.lat, k.lng, ring)));
    return {
      id: t.id, name: t.name, color: t.color,
      doors, people: inside.length,
      knocked: n.knocked,
      // A knock on someone since deleted at a door the turf no longer has
      // can't make a turf more than done.
      coverage_pct: doors ? Math.min(100, Math.round((100 * n.knocked) / doors)) : 0,
      talked: n.talked, support_found: n.support_found,
      no_answer: n.no_answer, refused: n.refused, moved: n.moved, inaccessible: n.inaccessible, left_lit: n.left_lit, other: n.other,
      canvassers: n.canvassers, last_knock_at: n.last_at,
    };
  });
};

export const canvasserNumbers = async (db, ws, knocks) => {
  const by = new Map();
  for (const k of knocks) {
    // Knocks from an imported list (ext/importhistory) are their own row.
    const id = k.created_by || (k.source === 'import' ? 'import' : null);
    if (!by.has(id)) by.set(id, []);
    by.get(id).push(k);
  }
  const ids = [...by.keys()].filter((k) => k && k !== 'import');
  const users = ids.length ? (await db.query('select id, name from users where id = any($1::uuid[])', [ids])).rows : [];
  const nameOf = new Map(users.map((u) => [u.id, u.name]));
  // Their first team, by name (teams are ext/admin's; plain SQL, no import).
  const teams = ids.length ? (await db.query(
    `select m.user_id, t.name from team_members m join teams t on t.id = m.team_id
      where m.workspace_id = $1 and t.deleted_at is null and m.user_id = any($2::uuid[])
      order by lower(t.name)`, [ws, ids],
  )).rows : [];
  const teamOf = new Map();
  for (const r of teams) if (!teamOf.has(r.user_id)) teamOf.set(r.user_id, r.name);
  return [...by.entries()].map(([id, list]) => {
    const n = tally(list);
    return {
      id, name: id === 'import' ? 'From an imported list' : (id && nameOf.get(id)) || 'Someone no longer here', team: (id && id !== 'import' && teamOf.get(id)) || null,
      doors: n.knocked, talked: n.talked, support_found: n.support_found,
      days_out: n.days_out, last_out: n.last_at,
    };
  }).sort((a, b) => (b.doors - a.doors) || (b.talked - a.talked) || String(a.name).localeCompare(String(b.name)));
};

export const days = (knocks) => {
  const by = new Map();
  for (const k of knocks) {
    if (!by.has(k.day)) by.set(k.day, { day: k.day, doors: new Set(), talked: 0 });
    const d = by.get(k.day);
    d.doors.add(k.door);
    if (k.outcome === 'contacted') d.talked += 1;
  }
  return [...by.values()].sort((a, b) => a.day.localeCompare(b.day)).map((d) => ({ day: d.day, doors: d.doors.size, talked: d.talked }));
};

// The turfs' doors and knocks (so coverage reads the same as the table),
// and every knock in the range for the rest (so the canvassers add up).
export const totals = (turfs, knocks) => {
  const n = tally(knocks);
  return {
    doors: turfs.reduce((a, t) => a + t.doors, 0),
    knocked: turfs.reduce((a, t) => a + t.knocked, 0),
    doors_knocked: n.knocked,
    talked: n.talked,
    support_found: n.support_found,
    canvassers: n.canvassers,
  };
};

export const fieldReport = async (db, ws, query, tz) => {
  const zone = zoneOf(tz);
  const range = rangeOf(query, zone);
  const bounds = await boundsOf(db, range, zone);
  const knocks = await doorContacts(db, ws, bounds, zone);
  const turfs = await turfNumbers(db, ws, knocks);
  return {
    range: { ...range, tz: zone },
    turfs,
    canvassers: await canvasserNumbers(db, ws, knocks),
    days: days(knocks),
    totals: totals(turfs, knocks),
  };
};

// One person's knocks, all time: distinct doors, talks at the door, the
// people they found in support (a support-band rating they gave, at the
// door or on the phone), and the days they were out knocking.
export const mineAll = async (db, ws, userId, tz) => {
  const r = (await db.query(
    `select count(distinct case when nullif(trim(p.address), '') is null then p.id::text
                                else lower(trim(p.address)) || '|' || lower(trim(coalesce(p.unit, ''))) end)::int as doors,
            count(*) filter (where c.outcome = 'contacted')::int as talked,
            count(distinct to_char(${toLocal('c.created_at', '$3::text')}, 'YYYY-MM-DD'))::int as days_out
       from contacts c join persons p on p.id = c.person_id
      where c.workspace_id = $1 and c.created_by = $2 and c.channel = 'door'`,
    [ws, userId, zoneOf(tz)],
  )).rows[0];
  const rated = (await db.query(
    `select person_id, rating from contacts
      where workspace_id = $1 and created_by = $2 and rating is not null group by 1, 2`,
    [ws, userId],
  )).rows;
  const backers = new Set(rated.filter((x) => supportive(x.rating)).map((x) => x.person_id));
  return { doors: r.doors, talked: r.talked, support_found: backers.size, days_out: r.days_out };
};
