// Buildings and suites: four numbers, from this service's own database, read
// only. An optional check (GOING-LIVE.md section 5): after the voters list
// is in, in Render's Shell for the service,
//
//   node scripts/hr-counts.mjs
//
// It prints four lines and nothing else: no name, address or campaign.
//   1. Located doors: people with a pin, one door per door key (the server's
//      one key, server/lib/doors.js: "Main" and blank are one door, a unit
//      written in the address or in its column is one door), as the map
//      groups them (server/lib/geo.js groupDoors).
//   2. Buildings: 3 or more numbered or lettered units at one address, what
//      the map draws as a building (shared/buildings.js groupPlaces, the
//      map's own code).
//   3. Houses with a suite: any other address with 2 or more doors (a main
//      door and a basement suite, a coach house…).
//   4. Rows still being worked out: people whose door the server has not
//      worked out since their address or unit last changed. It goes to 0 a
//      few minutes after a start; until then 1–3 can read a little high.
// Every campaign in the database is counted; doors are each campaign's own.
//
// Everything runs in one read-only transaction (the database itself refuses
// any write in it), ended with a rollback. It connects on its own with
// DATABASE_URL and never starts the server's database set-up.
import { pathToFileURL } from 'node:url';
import { groupPlaces } from '../shared/buildings.js';
import { doorSql, FRESH } from '../server/lib/doors.js';

// A door's key, as the server counts doors.
const DOOR_KEY = doorSql('persons');
const LIVE = 'deleted_at is null';
const LOCATED = `${LIVE} and lat is not null and lng is not null`;

// q(sql, params) → { rows }, on one connection.
export const hrCounts = async (q) => {
  const doors = (await q(
    `select count(*)::int as n from (select 1 from persons where ${LOCATED} group by workspace_id, ${DOOR_KEY}) d`,
  )).rows[0].n;

  // One row per door (its first person's address, unit and pin, as
  // groupDoors keeps them), each campaign's doors grouped on their own.
  const rows = (await q(
    `select workspace_id::text as ws,
            (array_agg(address order by created_at, id))[1] as address,
            (array_agg(unit order by created_at, id))[1] as unit,
            (array_agg(lat order by created_at, id))[1] as lat,
            (array_agg(lng order by created_at, id))[1] as lng
       from persons where ${LOCATED}
      group by workspace_id, ${DOOR_KEY}
      order by workspace_id`,
  )).rows;
  let buildings = 0;
  let houses = 0;
  for (let i = 0; i < rows.length;) {
    let j = i;
    while (j < rows.length && rows[j].ws === rows[i].ws) j += 1;
    const places = groupPlaces(rows.slice(i, j).map(({ ws, ...door }) => ({ ...door, persons: [] })));
    buildings += places.buildings.length;
    houses += places.houses.length;
    i = j;
  }

  const stale = (await q(
    `select count(*)::int as n from persons where ${LIVE} and not (${FRESH('persons')})`,
  )).rows[0].n;

  return { doors, buildings, houses, stale };
};

// fn(q) inside one read-only transaction, always rolled back.
export const readOnly = async (q, fn) => {
  await q('begin transaction isolation level repeatable read read only');
  try {
    await q("set local statement_timeout = '10min'");
    return await fn(q);
  } finally {
    await q('rollback');
  }
};

// A connection of its own, with the server's TLS rule (server/db/client.js).
export const connectPg = async (url) => {
  const { default: pg } = await import('pg');
  const ssl = /sslmode=(require|verify)/.test(url) || process.env.PGSSL === '1'
    ? { rejectUnauthorized: process.env.PGSSL_STRICT === '1' }
    : undefined;
  const client = new pg.Client({ connectionString: url, ssl, connectionTimeoutMillis: 30_000 });
  await client.connect();
  return client;
};

export const main = async ({ url = process.env.DATABASE_URL, out = console.log, connect = connectPg } = {}) => {
  if (!String(url || '').trim()) throw new Error('DATABASE_URL is not set: run this in Render’s Shell for the service.');
  const client = await connect(url);
  try {
    const n = await readOnly((sql, params) => client.query(sql, params), hrCounts);
    out(`Located doors: ${n.doors}`);
    out(`Buildings: ${n.buildings}`);
    out(`Houses with a suite: ${n.houses}`);
    out(`Rows still being worked out: ${n.stale}`);
  } finally {
    await client.end();
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`hr-counts: ${e.message}`);
    process.exit(1);
  });
}
