// scripts/hr-counts.mjs: buildings and suites, four numbers from a client's
// own database, read only. The owner may run it in Render's Shell (an
// optional check, GOING-LIVE.md section 5); here it runs over made-up rows
// (in memory, and over the wire under npm run test:pg).
//   1. located doors (one door key, server/lib/doors.js, as the map groups people)
//   2. buildings (shared/buildings.js groupPlaces, the map's own code)
//   3. houses with a suite (the same)
//   4. rows still being worked out (address or unit changed since the sweep; 0 when done)
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb } from './helpers.js';
import { _resetDbForTest } from '../db/client.js';
import { groupDoors } from '../lib/geo.js';
import { groupPlaces } from '../../shared/buildings.js';
import { hrCounts, readOnly, main, connectPg } from '../../scripts/hr-counts.mjs';

const doorsMod = await import('../lib/doors.js').catch(() => null);

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
  [A, '13450 104 Ave', '1', FAR], // two numbered doors, no main door: a house with Suite 1 and Suite 2
  [A, '13450 104 Ave', '2', FAR],
  // A walk-up of 3: a building (3 or more numbered units).
  [A, '200 King St', '1', WALKUP],
  [A, '200 King St', '2', WALKUP],
  [A, '200 King St', '3', WALKUP],
  // A house with two people at its main door, and a basement suite written after the street.
  [A, '7 Elm St', null, HOUSE],
  [A, '7 Elm St', null, HOUSE],
  [A, '7 Elm St Bsmt', null, HOUSE],
  // No pin: not a door; one has its unit inside the address.
  [A, '9 Oak St', null, null],
  [A, '5-10000 Oak St', null, null],
  [A, '1-12345 Pine St', null, HOUSE, true], // deleted
  // No address, a pin: each person is a door of their own.
  [A, null, null, HOUSE],
  [A, '', null, HOUSE],
  // Another campaign: four units, all inside the address,
  // and a door with the same address as one of A's (its own door, not A's).
  [B, '1-5000 Main St', null, WALKUP],
  [B, '2-5000 Main St', null, WALKUP],
  [B, '3-5000 Main St', null, WALKUP],
  [B, '4-5000 Main St', null, WALKUP],
  [B, '13450 104 Ave', '1203', TOWER],
];
// 1203 written two ways is one door; the tower, the walk-up and B's four are buildings.
const WANT = { doors: 19, buildings: 3, houses: 2, stale: 0 };
const LINES = [
  'Located doors: 19',
  'Buildings: 3',
  'Houses with a suite: 2',
  'Rows still being worked out: 0',
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

test('before the server has worked the rows out, line 4 says how many are left', async () => {
  const got = await hrCounts((sql, params) => db.query(sql, params));
  const live = ROWS.filter((r) => !r[4]).length;
  assert.equal(got.stale, live);
  assert.ok(doorsMod, 'server/lib/doors.js');
  await doorsMod.fillDoorParts(db);
});

test('the four counts over made-up rows', async () => {
  const got = await hrCounts((sql, params) => db.query(sql, params));
  assert.deepEqual(got, WANT);
});

test('the counts agree with the map’s own code over the same rows', async () => {
  const rows = (await db.query('select * from persons where deleted_at is null')).rows;
  let doors = 0;
  let buildings = 0;
  let houses = 0;
  for (const ws of [A, B]) {
    const mine = groupDoors(rows.filter((p) => p.workspace_id === ws));
    doors += mine.length;
    const places = groupPlaces(mine);
    buildings += places.buildings.length;
    houses += places.houses.length;
  }
  assert.deepEqual({ doors, buildings, houses, stale: 0 }, WANT);
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
test('run as the owner runs it: four lines, only reads, nothing changed', async () => {
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
test('the image carries the script, and the script needs only shared/, the door module and pg', async () => {
  const { readFileSync } = await import('node:fs');
  const root = new URL('../../', import.meta.url);
  const docker = readFileSync(new URL('Dockerfile', root), 'utf8');
  const runtime = docker.slice(docker.indexOf(' AS runtime'));
  assert.match(runtime, /^COPY scripts\/hr-counts\.mjs \.\/scripts\/hr-counts\.mjs$/m);
  assert.match(runtime, /^COPY shared \.\/shared$/m);
  const src = readFileSync(new URL('scripts/hr-counts.mjs', root), 'utf8');
  const used = [...src.matchAll(/(?:from\s+|import\()\s*'([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(used, ['../server/lib/doors.js', '../shared/buildings.js', 'node:url', 'pg']);
  assert.match(runtime, /^COPY server \.\/server$/m);
  // What those need in turn: the door module only the parser (it reads the
  // event spine only when the server asks it to watch writes, never here),
  // buildings.js only the parser, the parser nothing.
  const importsOf = (path) => [...readFileSync(new URL(path, root), 'utf8').matchAll(/^import [^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
  assert.deepEqual(importsOf('server/lib/doors.js'), ['../../shared/units.js']);
  assert.deepEqual(importsOf('shared/buildings.js'), ['./units.js']);
  assert.deepEqual(importsOf('shared/units.js'), []);
});
