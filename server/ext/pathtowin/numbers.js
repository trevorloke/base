// Path to win — the counting, in SQL (a city-wide voter file is 300,000
// people: nothing here reads them into the server one by one).
//
//   statsReady(db)              one ANALYZE for a table never analyzed
//   todayOf(db, tz)             the campaign's today, by the database's clock
//   standing(db, ws)            everyone on file by rating band, now
//   trendRows(db, ws, today, tz) when each rating began and ended, by band
//                               and by how many weeks ago (rules.trendFrom)
//   turfRows(db, ws, tz)        per live turf: doors, doors knocked, people,
//                               supporters, persuadables, opposed, the
//                               supporters at doors knocked, the last knock
//                               (and its day)
//
// A rating's history is its contacts: each contact that gave a rating
// starts it, the person's next rated contact ends it. A rating that came in
// with a list (an import: no contact behind it) counts from when it reached
// the file. People since deleted are left out of every count, so this
// week's count is the people on file now (the standing).
//
// Turfs: each turf's corners bound the read (persons_ws_geo_idx, as
// routes/api.js reads a turf's people), and Postgres's own polygon test
// keeps the people inside (point <@ polygon: on the edge counts as inside).
// A door is the address + unit, or the person with no address (the walk
// list's door); it is knocked once anyone there has a door contact, any
// outcome (the walk list's rule with no pass open).
import { toLocal } from '../../lib/tzsql.js';
import { WEEKS } from './rules.js';

const DOOR = `case when nullif(trim(p.address), '') is null then p.id::text
                   else lower(trim(p.address)) || '|' || lower(trim(coalesce(p.unit, ''))) end`;
const BAND = `case when r.rating in ('1', '2') then 'support' when r.rating = '3' then 'undecided'
                   when r.rating ~ '^4[A-Z]{0,2}$' then 'opposed' end`;

// PGlite runs no autovacuum: a table never analyzed looks empty to the
// planner, which then reads a whole list where an index would do (see
// statsReady in routes/data.js). One ANALYZE once there are rows fixes that
// for good; hosted Postgres analyzes on its own.
export const statsReady = async (db) => {
  try {
    const r = (await db.query(
      `select (select reltuples from pg_class where oid = 'persons_ws_geo_idx'::regclass) as persons,
              (select reltuples from pg_class where oid = 'contacts_ws_person_idx'::regclass) as contacts`,
    )).rows[0];
    if (r && Number(r.persons) <= 0) await db.query('analyze persons');
    if (r && Number(r.contacts) <= 0) await db.query('analyze contacts');
  } catch { /* only a speed-up */ }
};

export const standing = async (db, ws) => {
  const r = (await db.query(
    `select count(*)::int as people,
            count(*) filter (where rating = '1')::int as strong,
            count(*) filter (where rating = '2')::int as lean,
            count(*) filter (where rating = '3')::int as persuadables,
            count(*) filter (where rating ~ '^4[A-Z]{0,2}$')::int as opposed,
            count(*) filter (where rating is null)::int as unrated
       from persons where workspace_id = $1 and deleted_at is null`,
    [ws],
  )).rows[0];
  return { ...r, supporters: r.strong + r.lean };
};

// [{ band, w, n }] for rules.trendFrom. today: the campaign's YYYY-MM-DD.
export const trendRows = async (db, ws, today, tz) => (await db.query(
  `with ev as (
     select c.person_id, c.created_at as at, c.rating, 1 as k
       from contacts c
       join persons p on p.id = c.person_id and p.workspace_id = c.workspace_id and p.deleted_at is null
      where c.workspace_id = $1 and c.rating is not null
     union all
     select p.id, coalesce(p.rated_at, p.created_at), p.rating, 0
       from persons p
      where p.workspace_id = $1 and p.deleted_at is null and p.rating is not null
        and not exists (select 1 from contacts c where c.workspace_id = p.workspace_id and c.person_id = p.id and c.rating is not null)
   ),
   spans as (
     select rating, at, lead(at) over (partition by person_id order by at, k) as next_at from ev
   ),
   r as (
     select rating, at as t, 1 as n from spans
     union all
     select rating, next_at, -1 from spans where next_at is not null
   )
   select ${BAND} as band,
          least($3::int, greatest(0, ($2::date - (${toLocal('r.t', '$4::text')})::date) / 7))::int as w,
          sum(r.n)::int as n
     from r
    group by 1, 2`,
  [ws, today, WEEKS, tz],
)).rows.filter((x) => x.band);

// The campaign's today, YYYY-MM-DD, by the same clock as the counts
// (lib/tzsql.js: B.C. on UTC-7 all year from March 2026, whatever this
// runtime's own copy of the time-zone rules says).
export const todayOf = async (db, tz) => (await db.query(
  `select to_char(${toLocal('now()', '$1::text')}, 'YYYY-MM-DD') as today`, [tz],
)).rows[0].today;

// One row per live turf with at least three corners. Its shape is its plan,
// whatever the database knows about the tables (an embedded one never
// gathers statistics): each turf's counts are a subquery of their own (an
// aggregate, so never merged into one big join), reading that turf's
// people by its corners through persons_ws_geo_idx, each person's last
// knock by contacts_ws_person_idx, and grouping only that turf's doors.
// last_day: the last knock's day in the campaign's zone.
export const turfRows = async (db, ws, tz) => (await db.query(
  `with t as materialized (
     select t.id, t.name, t.color, t.polygon, t.created_at, b.s, b.w, b.n, b.e,
            ('(' || b.pts || ')')::polygon as poly
       from turfs t
       cross join lateral (
         select min((e->>0)::float8) as s, min((e->>1)::float8) as w,
                max((e->>0)::float8) as n, max((e->>1)::float8) as e,
                string_agg('(' || (e->>1) || ',' || (e->>0) || ')', ',' order by i) as pts,
                count(*) as corners
           from jsonb_array_elements(case when jsonb_typeof(t.polygon) = 'array' then t.polygon else '[]'::jsonb end) with ordinality as x(e, i)
          where jsonb_typeof(e) = 'array' and jsonb_typeof(e->0) = 'number' and jsonb_typeof(e->1) = 'number'
       ) b
      where t.workspace_id = $1 and t.deleted_at is null and b.corners >= 3
   )
   select t.id, t.name, t.color, t.polygon,
          coalesce(per.doors, 0) as doors, coalesce(per.knocked, 0) as knocked, coalesce(per.people, 0) as people,
          coalesce(per.supporters, 0) as supporters, coalesce(per.persuadables, 0) as persuadables,
          coalesce(per.opposed, 0) as opposed, coalesce(per.sup_at_knocked, 0) as sup_at_knocked, per.last_at,
          to_char(${toLocal('per.last_at', '$2::text')}, 'YYYY-MM-DD') as last_day
     from t
     cross join lateral (
       select count(*)::int as doors, count(*) filter (where d.last_at is not null)::int as knocked,
              sum(d.people)::int as people, sum(d.supporters)::int as supporters,
              sum(d.persuadables)::int as persuadables, sum(d.opposed)::int as opposed,
              coalesce(sum(d.supporters) filter (where d.last_at is not null), 0)::int as sup_at_knocked,
              max(d.last_at) as last_at
         from (
           select i.door, max(i.last_at) as last_at, count(*)::int as people,
                  count(*) filter (where i.rating in ('1', '2'))::int as supporters,
                  count(*) filter (where i.rating = '3')::int as persuadables,
                  count(*) filter (where i.rating ~ '^4[A-Z]{0,2}$')::int as opposed
             from (
               select ${DOOR} as door, p.rating,
                      (select max(c.created_at) from contacts c
                        where c.workspace_id = p.workspace_id and c.person_id = p.id and c.channel = 'door') as last_at
                 from persons p
                where p.workspace_id = $1 and p.deleted_at is null and p.lat is not null
                  and p.lat >= t.s and p.lat <= t.n and p.lng >= t.w and p.lng <= t.e
                  and point(p.lng, p.lat) <@ t.poly
             ) i
            group by i.door
         ) d
     ) per
    order by t.created_at, t.id`,
  [ws, tz],
)).rows.map((r) => ({ ...r, polygon: typeof r.polygon === 'string' ? JSON.parse(r.polygon) : r.polygon }));
