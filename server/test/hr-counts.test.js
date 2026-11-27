// scripts/hr-counts.mjs: HR-1's three numbers from a client's own database,
// read only. The owner runs it once in Render's Shell; here it runs over
// made-up rows (in memory, and over the wire under npm run test:pg).
//   1. located doors (address + unit, as the map groups people into doors)
//   2. addresses with BUILDING_MIN or more distinct units (shared/buildings.js)
//   3. people whose unit is written inside the address (splitUnit needed)
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb } from './helpers.js';
import { _resetDbForTest } from '../db/client.js';
import { groupDoors } from '../lib/geo.js';
import { groupBuildings, splitUnit, BUILDING_MIN } from '@starbase/shared/buildings';
import { hrCounts, readOnly, main, connectPg } from '../../scripts/hr-counts.mjs';

let db;
const A = randomUUID();
const B = randomUUID();
const TOWER = [49.19, -122.85];
const FAR = [49.2, -122.85]; // the same civic, about 1 km away: another place
const WALKUP = [49.2, -122.8];
const HOUSE = [49.21, -122.81];

// [campaign, address, unit, pin, deleted]
const ROWS = [
  // A tower of 5 units: 1203 twice (in the unit, and inside the address),
  // 1204 with two people, 305 and 1501 written inside the address, PH2.
  [A, '13450 104 Ave', '1203', TOWER],
  [A, '1203-13450 104 Ave', null, TOWER],
  [A, '13450 104 Ave', '1204', TOWER],
  [A, '13450 104 Ave', '1204', TOWER],
  [A, '#305 13450 104 Avenue', null, TOWER],
  [A, '13450 104 Ave Unit 1501', null, TOWER],
  [A, '13450 104 ave', 'PH2', TOWER],
  [A, '13450 104 Ave', '1999', TOWER, true], // deleted: not a sixth unit
  [A, '13450 104 Ave', '1', FAR],
  [A, '13450 104 Ave', '2', FAR],
  // A walk-up of 3: not a building.
  [A, '200 King St', '1', WALKUP],
  [A, '200 King St', '2', WALKUP],
  [A, '200 King St', '3', WALKUP],
  // A house with two people: one door.
  [A, '7 Elm St', null, HOUSE],
  [A, '7 Elm St', null, HOUSE],
  // No pin: not a door; one has its unit inside the address.
  [A, '9 Oak St', null, null],
  [A, '5-10000 Oak St', null, null],
  [A, '1-12345 Pine St', null, HOUSE, true], // deleted
  // No address, a pin: each person is a door of their own.
  [A, null, null, HOUSE],
  [A, '', null, HOUSE],
  // Another campaign: exactly BUILDING_MIN units, all inside the address,
  // and a door with the same address as one of A's (its own door, not A's).
  [B, '1-5000 Main St', null, WALKUP],
  [B, '2-5000 Main St', null, WALKUP],
  [B, '3-5000 Main St', null, WALKUP],
  [B, '4-5000 Main St', null, WALKUP],
  [B, '13450 104 Ave', '1203', TOWER],
];
const WANT = { doors: 19, buildings: 2, inside: 8 };
const LINES = [
  'Located doors: 19',
  `Addresses with ${BUILDING_MIN} or more units: 2`,
  'People with the unit inside the address: 8',
];

const seed = async (q) => {
  await q('insert into workspaces (id, name) values ($1, $2), ($3, $4)', [A, 'Example Campaign A', B, 'Example Campaign B']);
  let n = 0;
  for (const [ws, address, unit, pin, deleted] of ROWS) {
    n += 1;
    await q(
      'insert into persons (id, workspace_id, name, address, unit, lat, lng, deleted_at) values ($1, $2, $3, $4, $5, $6, $7, $8)',
      [randomUUID(), ws, `Person ${n} Example`, address, unit, pin?.[0] ?? null, pin?.[1] ?? null, deleted ? new Date() : null],
    );
  }
};

// Everything a write could change, to compare before and after.
const picture = async (q) => ({
  tables: (await q("select count(*)::int as n from information_schema.tables where table_schema = 'public'")).rows[0].n,
  persons: (await q("select md5(string_agg(p::text, ',' order by p.id)) as h from persons p")).rows[0].h,
  workspaces: (await q("select md5(string_agg(w::text, ',' order by w.id)) as h from workspaces w")).rows[0].h,
});

before(async () => {
  db = await freshDb();
  await seed((sql, params) => db.query(sql, params));
});

test('the three counts over made-up rows', async () => {
  const got = await hrCounts((sql, params) => db.query(sql, params));
  assert.deepEqual(got, WANT);
});

test('the counts agree with the map’s own code over the same rows', async () => {
  const rows = (await db.query('select * from persons where deleted_at is null')).rows;
  let doors = 0;
  let buildings = 0;
  for (const ws of [A, B]) {
    const mine = groupDoors(rows.filter((p) => p.workspace_id === ws));
    doors += mine.length;
    buildings += groupBuildings(mine).buildings.length;
  }
  const inside = rows.filter((p) => splitUnit(p.address)).length;
  assert.deepEqual({ doors, buildings, inside }, WANT);
});

test('inside its read-only transaction, the database refuses a write', async () => {
  const before = await picture((sql, params) => db.query(sql, params));
  // One connection for the whole transaction.
  const conn = db.pool ? await db.pool.connect() : null;
  const q = conn ? (sql, params) => conn.query(sql, params) : (sql, params) => db.query(sql, params);
  try {
    await assert.rejects(
      readOnly(q, (tx) => tx("insert into workspaces (id, name) values ($1, 'Written')", [randomUUID()])),
      (e) => e.code === '25006' || /read-only transaction/.test(e.message),
    );
    await assert.rejects(
      readOnly(q, (tx) => tx("update persons set name = 'Changed'")),
      (e) => e.code === '25006' || /read-only transaction/.test(e.message),
    );
  } finally {
    conn?.release();
  }
  assert.deepEqual(await picture((sql, params) => db.query(sql, params)), before);
});

// Last: under npm run test:pg it closes this file's own connection and runs
// the script as the owner will, with DATABASE_URL.
test('run as the owner runs it: three lines, only reads, nothing changed', async () => {
  const before = await picture((sql, params) => db.query(sql, params));
  const sent = [];
  const spy = (client) => {
    const query = client.query.bind(client);
    client.query = (sql, params) => { sent.push(String(sql).trim()); return query(sql, params); };
    return client;
  };
  const out = [];
  if (process.env.DATABASE_URL) {
    await db.close();
    _resetDbForTest();
    await main({ out: (line) => out.push(line), connect: async (url) => spy(await connectPg(url)) });
    const check = spy(await connectPg(process.env.DATABASE_URL));
    try {
      assert.deepEqual(await picture((sql, params) => check.query(sql, params)), before);
    } finally {
      await check.end();
    }
    sent.splice(sent.length - 3); // the picture's own three reads
  } else {
    // In memory: the database is one connection, as a pg client is.
    const client = { connect: async () => {}, end: async () => {}, query: (sql, params) => db.query(sql, params) };
    await main({ url: 'memory', out: (line) => out.push(line), connect: async () => spy(client) });
    assert.deepEqual(await picture((sql, params) => db.query(sql, params)), before);
  }
  assert.deepEqual(out, LINES);
  assert.match(sent[0], /^begin transaction isolation level repeatable read read only$/i);
  assert.equal(sent.at(-1), 'rollback');
  for (const sql of sent.slice(1, -1)) assert.match(sql, /^(set local |select )/i, sql);
  // Nothing about any person: no name, address or unit in what it prints.
  for (const line of out) assert.doesNotMatch(line, /Example|Ave|St\b|King|Elm|Oak|Main|1203/);
});

test('without DATABASE_URL it says so and reads nothing', async () => {
  const out = [];
  await assert.rejects(main({ url: '', out: (line) => out.push(line), connect: async () => { throw new Error('should not connect'); } }), /DATABASE_URL/);
  assert.deepEqual(out, []);
});

// Render runs the image, which has no scripts/ folder of its own: the
// runtime stage copies this one file, and it needs nothing the image lacks.
test('the image carries the script, and the script needs only shared/ and pg', async () => {
  const { readFileSync } = await import('node:fs');
  const root = new URL('../../', import.meta.url);
  const docker = readFileSync(new URL('Dockerfile', root), 'utf8');
  const runtime = docker.slice(docker.indexOf(' AS runtime'));
  assert.match(runtime, /^COPY scripts\/hr-counts\.mjs \.\/scripts\/hr-counts\.mjs$/m);
  assert.match(runtime, /^COPY shared \.\/shared$/m);
  const src = readFileSync(new URL('scripts/hr-counts.mjs', root), 'utf8');
  const used = [...src.matchAll(/(?:from\s+|import\()\s*'([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(used, ['../shared/buildings.js', 'node:url', 'pg']);
  const shared = readFileSync(new URL('shared/buildings.js', root), 'utf8');
  assert.doesNotMatch(shared, /^import /m);
});
