// Doors worked out once, stored for SQL (UNITS lane U2): server/lib/doors.js
// fills door_civic, door_unit, door_kind and door_src beside address and
// unit (never rewriting them), and every count, match and read keys a door
// the one way shared/units.js does. Runs in memory and, under
// npm run test:pg, over the wire. Every name and address is made up.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshDb, Client } from './helpers.js';
import { loadContext } from '../lib/auth.js';
import { walkFor } from '../routes/api.js';
import { bootstrap } from '../db/schema.js';

// The module under test is read when asked, so the tests that need none of
// it still run (and say what they find) where it is missing.
const doorsMod = await import('../lib/doors.js').catch(() => null);
const need = () => { assert.ok(doorsMod, 'server/lib/doors.js exists'); return doorsMod; };

let db, mgr, ws;
const realFetch = globalThis.fetch;
const asked = [];
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
const square = (lat, lng, d = 0.001) => [[lat - d, lng - d], [lat - d, lng + d], [lat + d, lng + d], [lat + d, lng - d]];

const insert = async (row) => {
  const id = row.id || randomUUID();
  await db.query(
    `insert into persons (id, workspace_id, name, address, unit, city, lat, lng, rating) values ($1, $2, $3, $4, $5, 'Surrey', $6, $7, $8)`,
    [id, row.ws || ws, row.name, row.address ?? null, row.unit ?? null, row.lat ?? null, row.lng ?? null, row.rating ?? null],
  );
  return id;
};
const DOOR_COLS = ['door_civic', 'door_unit', 'door_kind', 'door_src'];
const without = (r) => Object.fromEntries(Object.entries(r).filter(([k]) => !DOOR_COLS.includes(k)));
const fill = async (opts = {}) => need().fillDoorParts(db, { workspaceId: ws, ...opts });
const stale = async () => (await db.query(
  `select count(*)::int as n from persons p where p.workspace_id = $1 and not (${need().FRESH('p')})`, [ws],
)).rows[0].n;

before(async () => {
  db = await freshDb();
  mgr = new Client();
  ws = (await mgr.signup({ workspaceName: 'Doors Example', jurisdiction: 'bc-municipal' })).json.workspace.id;
  globalThis.fetch = async (url, opts) => {
    const u = new URL(String(url));
    if (u.hostname !== 'geocoder.api.gov.bc.ca') return realFetch(url, opts);
    const q = u.searchParams.get('addressString');
    asked.push(q);
    if (/nomatch/i.test(q)) return new Response(JSON.stringify({ features: [] }));
    const n = Number(q.match(/^\d+/)?.[0] || 0);
    return new Response(JSON.stringify({ features: [{ geometry: { coordinates: [-122.5 + n / 1e7, 49.5 + n / 1e7] },
      properties: { score: 97, matchPrecision: 'CIVIC_NUMBER', fullAddress: q } }] }));
  };
});
after(() => {
  globalThis.fetch = realFetch;
  doorsMod?.stopDoorSweeper?.();
});

// ── 1. The sweeper ──
test('the sweeper fills the parts and never changes address, unit or updated_at; an edit makes a row stale until the next sweep', async () => {
  const at = { lat: 49.05, lng: -122.9 };
  const ids = {
    bsmt: await insert({ name: 'Sweep Bsmt Example', address: '10388 134 St Bsmt', ...at }),
    hy: await insert({ name: 'Sweep Hyphen Example', address: '1203-13450 104 Ave', ...at }),
    main: await insert({ name: 'Sweep Main Example', address: '10388 134 St', unit: 'Main', ...at }),
    none: await insert({ name: 'Sweep Nowhere Example' }),
  };
  const before = (await db.query('select * from persons where workspace_id = $1 order by id', [ws])).rows;
  const d = need();
  assert.ok(await stale() >= 4, 'new rows are stale');
  const r = await fill();
  assert.ok(r.filled >= 4, JSON.stringify(r));
  assert.equal(await stale(), 0);
  const after1 = (await db.query('select * from persons where workspace_id = $1 order by id', [ws])).rows;
  assert.deepEqual(after1.map(without), before.map(without), 'nothing but the four door columns changes, updated_at included');
  const row = (id) => after1.find((x) => x.id === id);
  assert.deepEqual(DOOR_COLS.map((k) => row(ids.bsmt)[k]), ['10388 134 st', 'BSMT', 'suite', `${d.UNIT_V}|10388 134 St Bsmt|`]);
  assert.deepEqual(DOOR_COLS.map((k) => row(ids.hy)[k]), ['13450 104 ave', '1203', 'unit', `${d.UNIT_V}|1203-13450 104 Ave|`]);
  assert.deepEqual(DOOR_COLS.map((k) => row(ids.main)[k]), ['10388 134 st', '', 'main', `${d.UNIT_V}|10388 134 St|Main`]);
  assert.deepEqual(DOOR_COLS.map((k) => row(ids.none)[k]), ['', '', 'main', `${d.UNIT_V}||`]);
  assert.deepEqual(await fill(), { filled: 0 }, 'a second sweep has nothing to do');
  // An edit by any writer: stale, and the door key falls back to today's until the sweep.
  await db.query(`update persons set address = '10390 134 St' where id = $1`, [ids.main]);
  assert.equal(await stale(), 1);
  const key = async (id) => (await db.query(`select ${d.doorSql('p')} as k from persons p where id = $1`, [id])).rows[0].k;
  assert.equal(await key(ids.main), '10390 134 st|main', 'stale: today’s key');
  assert.deepEqual(await fill({ ids: [ids.main] }), { filled: 1 });
  assert.equal(await key(ids.main), '10390 134 st|');
  assert.equal(await key(ids.none), ids.none, 'no address: the person');
  await db.query('delete from persons where id = any($1::uuid[])', [Object.values(ids)]);
});

test('a write that commits is worked out at once (one listener after commit), not a minute later', async () => {
  const d = need();
  d.watchDoorWrites(db);
  const p = ok(await mgr.action('person.create', { name: 'Listener Example', address: 'Coach house, 10500 134 St' })).person;
  const fresh = async () => (await db.query(`select ${d.FRESH('p')} as f, door_unit from persons p where id = $1`, [p.id])).rows[0];
  for (let i = 0; i < 100 && !(await fresh()).f; i += 1) await new Promise((r) => { setTimeout(r, 20); });
  assert.deepEqual(await fresh(), { f: true, door_unit: 'COACH' });
  ok(await mgr.action('person.update', { id: p.id, unit: 'Upper' }));
  for (let i = 0; i < 100 && (await fresh()).door_unit !== 'UPPER'; i += 1) await new Promise((r) => { setTimeout(r, 20); });
  assert.deepEqual(await fresh(), { f: true, door_unit: 'UPPER' });
  await db.query('delete from persons where id = $1', [p.id]);
});

test('the stale-row index carries the parser version in its name; another version’s is dropped at start', async () => {
  const d = need();
  const names = async () => (await db.query(
    `select indexname from pg_indexes where tablename = 'persons' and indexname like 'persons_door_stale%' order by 1`,
  )).rows.map((r) => r.indexname);
  assert.deepEqual(await names(), [`persons_door_stale_v${d.UNIT_V}_idx`]);
  await db.query('create index persons_door_stale_v0_idx on persons (workspace_id) where door_src is null');
  await bootstrap(db);
  assert.deepEqual(await names(), [`persons_door_stale_v${d.UNIT_V}_idx`]);
});

// ── 2. Counts: one door key everywhere ──
const C = { lat: 49.2, lng: -122.6 };
const counts = {};
test('counts: a house is 2 doors; one door written two ways is 1; knocking the suite knocks only the suite', async () => {
  ok(await mgr.action('pass.start', { name: 'First round', kind: 'persuasion', who: 'all' }));
  const id = {
    ana: await insert({ name: 'Ana Example', address: '10388 134 St', ...C }),
    ben: await insert({ name: 'Ben Example', address: '10388 134 St Bsmt', ...C }),
    cara: await insert({ name: 'Cara Example', address: '10400 134 St', lat: C.lat + 0.0002, lng: C.lng }),
    dev: await insert({ name: 'Dev Example', address: '10400 134 St', unit: 'Main', lat: C.lat + 0.0002, lng: C.lng }),
    eli: await insert({ name: 'Eli Example', address: '1203-13450 104 Ave', lat: C.lat + 0.0004, lng: C.lng }),
    fay: await insert({ name: 'Fay Example', address: '13450 104 Ave', unit: '1203', lat: C.lat + 0.0004, lng: C.lng }),
  };
  counts.id = id;
  const turf = ok(await mgr.action('turf.create', { name: 'Count block', polygon: square(C.lat + 0.0002, C.lng) })).turf;
  counts.turf = turf;
  for (const k of ['ben', 'cara', 'dev']) ok(await mgr.action('contact.log', { person_id: id[k], channel: 'door', outcome: 'left_lit' }));
  for (const k of ['eli', 'fay']) ok(await mgr.action('contact.log', { person_id: id[k], channel: 'door', outcome: 'no_answer' }));
  const read = async () => {
    const brief = ok(await mgr.get('/api/brief'));
    const passes = ok(await mgr.get('/api/passes'));
    const report = ok(await mgr.get('/api/field-report?from=all'));
    const { turfRows } = await import('../ext/pathtowin/numbers.js');
    const ptw = (await turfRows(db, ws, 'America/Vancouver')).find((t) => t.id === turf.id);
    return {
      today: brief.field.doors, lit: brief.field.lit, mine_all: brief.field.mine_all?.doors,
      pass: passes.open.stats.doors_knocked,
      report: report.totals.doors_knocked, report_turf: report.turfs.find((t) => t.id === turf.id)?.doors,
      ptw_doors: ptw.doors, ptw_knocked: ptw.knocked,
    };
  };
  // Before the sweep (6. the stale fallback): every SQL count is today's.
  if (doorsMod) await db.query('update persons set door_src = null where workspace_id = $1', [ws]);
  const old = await read();
  assert.deepEqual([old.today, old.lit, old.mine_all, old.pass, old.ptw_doors, old.ptw_knocked], [5, 3, 5, 5, 6, 5],
    'stale rows: the counts are exactly today’s (Main ≠ blank, 1203 written two ways is two)');
  await fill();
  const now = await read();
  assert.deepEqual(now, {
    today: 3, lit: 2, mine_all: 3, pass: 3, report: 3, report_turf: 4, ptw_doors: 4, ptw_knocked: 3,
  }, 'Bsmt and the main door are two doors, Ana’s still not knocked; Main≡blank and 1203 two ways are one door each');
});

// ── 3. The busy map's dots ──
test('doorDots: a house is u 1, h 2; a low-rise written “Suite 101” after the street is one building; a tower its units', async () => {
  process.env.BASE_MAP_ALL = '20';
  try {
    const H = { lat: 49.3, lng: -122.6 };
    await insert({ name: 'Dot Main Example', address: '10388 135 St', ...H });
    await insert({ name: 'Dot Bsmt Example', address: '10388 135 St Bsmt', ...H });
    const L = { lat: 49.3005, lng: -122.6 };
    for (let i = 1; i <= 40; i += 1) await insert({ name: `Low${i} Example`, address: `13520 105 Ave Suite ${100 + i}`, ...L });
    const T = { lat: 49.301, lng: -122.6 };
    await insert({ name: 'Tower Office Example', address: '13600 105 Ave', ...T });
    for (let i = 1; i <= 210; i += 1) {
      const u = String(200 + i);
      await insert({ name: `Tower${u} Example`, ...(i % 2 ? { address: '13600 105 Ave', unit: u } : { address: `${u}-13600 105 Ave` }), ...T });
    }
    const dots = async () => ok(await mgr.get('/api/map/doors?bbox=49.299,-122.601,49.302,-122.599&dots=1')).dots;
    const at = (list, p) => list.find((x) => Math.abs(x[0] - p.lat) < 1e-6 && Math.abs(x[1] - p.lng) < 1e-6);
    // 6. The stale fallback: before any sweep the tower and the house read as today.
    if (doorsMod) await db.query('update persons set door_src = null where workspace_id = $1', [ws]);
    const before = await dots();
    assert.deepEqual(at(before, T).slice(0, 5), [T.lat, T.lng, 0, 211, 211], 'stale: today’s count (the blank row is a door)');
    assert.deepEqual(at(before, H).slice(0, 4), [H.lat, H.lng, 0, 2]);
    await fill();
    const list = await dots();
    assert.deepEqual(at(list, H), [H.lat, H.lng, 0, 2, 1, 2], 'one house with two doors');
    assert.deepEqual(at(list, L), [L.lat, L.lng, 0, 40, 40, 0], 'forty units written after the street: one building');
    assert.deepEqual(at(list, T), [T.lat, T.lng, 0, 211, 211, 0], 'a tower and its office row: 211 units');
    // A townhouse complex typed "TH 1"…"TH 24" (a space in the unit) is a building, not a house with 23 suites.
    const C = { lat: 49.3015, lng: -122.6 };
    for (let i = 1; i <= 24; i += 1) await insert({ name: `Town${i} Example`, address: '10150 King George Blvd', unit: `TH ${i}`, ...C });
    await fill();
    assert.deepEqual(at(await dots(), C), [C.lat, C.lng, 0, 24, 24, 0], 'TH 1…TH 24: one building of 24 units');
  } finally {
    delete process.env.BASE_MAP_ALL;
  }
});

// ── 4. Import ──
test('import: a row whose unit says Basement finds the person saved with Bsmt; not made twice, not counted as moved', async () => {
  const first = ok(await mgr.post('/api/data/import', { rows: [{ name: 'Gil Example', address: '10600 134 St', unit: 'Bsmt' }] }));
  assert.equal(first.created, 1);
  const again = ok(await mgr.post('/api/data/import', { rows: [{ name: 'Gil Example', address: '10600 134 St', unit: 'Basement', phone: '604-555-0142' }] }));
  assert.deepEqual([again.created, again.merged, again.moved_kept], [0, 1, 0]);
  const hy = ok(await mgr.post('/api/data/import', { rows: [{ name: 'Hana Example', address: '1505-13450 104 Ave' }] }));
  assert.equal(hy.created, 1);
  await fill(); // (the server does it right after the import commits)
  const hy2 = ok(await mgr.post('/api/data/import', { rows: [{ name: 'Hana Example', address: '13450 104 Avenue', unit: '1505', phone: '604-555-0143' }] }));
  assert.deepEqual([hy2.created, hy2.merged], [0, 1], 'the unit inside the address or in its column: one door');
  const n = (await db.query(`select count(*)::int as n from persons where workspace_id = $1 and name in ('Gil Example', 'Hana Example')`, [ws])).rows[0].n;
  assert.equal(n, 2);
});

// ── 5. Geocoding: the civic address only ──
test('geocoding: 300 units in hyphen form are one lookup; a suite written after the street is looked up as its house', async () => {
  const { geocodeRound } = await import('../ext/geocoding/index.js');
  const other = (await new Client().signup({ workspaceName: 'Geo Example', jurisdiction: 'bc-municipal' })).json.workspace.id;
  for (let i = 1; i <= 300; i += 1) await insert({ ws: other, name: `Geo${i} Example`, address: `${1000 + i}-13700 104 Ave` });
  await insert({ ws: other, name: 'Geo Bsmt Example', address: '10700 134 St Bsmt' });
  if (doorsMod) await doorsMod.fillDoorParts(db, { workspaceId: other });
  asked.length = 0;
  for (let i = 0; i < 10; i += 1) if ((await geocodeRound(db, other, null)).done) break;
  const placed = (await db.query('select count(*)::int as n from persons where workspace_id = $1 and lat is not null', [other])).rows[0].n;
  assert.equal(placed, 301);
  assert.equal(asked.filter((q) => /13700 104 Ave/i.test(q)).length, 1, `one lookup for the tower: ${asked.length} asked`);
  assert.ok(asked.some((q) => /^10700 134 St/.test(q)) && !asked.some((q) => /bsmt/i.test(q)), asked.join(' · '));
  // The house's own row, added later: its pin is copied from the suite, no lookup.
  await insert({ ws: other, name: 'Geo Main Example', address: '10700 134 St' });
  if (doorsMod) await doorsMod.fillDoorParts(db, { workspaceId: other });
  asked.length = 0;
  await geocodeRound(db, other, null);
  assert.equal(asked.length, 0);
  const pins = (await db.query(`select distinct lat, lng from persons where workspace_id = $1 and address like '10700 %'`, [other])).rows;
  assert.equal(pins.length, 1);
});

test('geocoding: a house number written "#12345" on a numbered street is looked up as that house, not as the street', async () => {
  const { geocodeRound } = await import('../ext/geocoding/index.js');
  const other = (await new Client().signup({ workspaceName: 'Grid Example', jurisdiction: 'bc-municipal' })).json.workspace.id;
  // A row already on the map whose address is the bare street: its pin must not be copied to the houses.
  await insert({ ws: other, name: 'Grid Street Example', address: '104 Ave', lat: 49.7, lng: -122.7 });
  const a = await insert({ ws: other, name: 'Grid One Example', address: '#12345 104 Ave' });
  const b = await insert({ ws: other, name: 'Grid Two Example', address: '#12351 104 Ave' });
  const c = await insert({ ws: other, name: 'Grid Three Example', address: 'No. 10388 134 St' });
  if (doorsMod) await doorsMod.fillDoorParts(db, { workspaceId: other });
  asked.length = 0;
  for (let i = 0; i < 5; i += 1) if ((await geocodeRound(db, other, null)).done) break;
  assert.ok(asked.some((q) => /12345 104 Ave/.test(q)), asked.join(' · '));
  assert.ok(asked.some((q) => /12351 104 Ave/.test(q)), asked.join(' · '));
  assert.ok(asked.some((q) => /10388 134 St/.test(q)), asked.join(' · '));
  assert.ok(!asked.some((q) => /^\s*(104 Ave|134 St)\b/i.test(q)), `never the bare street: ${asked.join(' · ')}`);
  const pins = (await db.query('select id, lat from persons where id = any($1::uuid[])', [[a, b, c]])).rows;
  assert.equal(pins.filter((r) => Number(r.lat) === 49.7).length, 0, 'the street row\'s pin is not copied to the houses');
  const civ = (await db.query('select address, door_civic, door_unit from persons where id = any($1::uuid[]) order by address', [[a, b, c]])).rows;
  assert.deepEqual(civ.map((r) => [r.door_civic, r.door_unit]), [['12345 104 ave', ''], ['12351 104 ave', ''], ['no 10388 134 st', '']]);
});

test('geocoding: suites set aside before are tried again once, as their house, when Place on map is pressed', async () => {
  const other = (await new Client().signup({ workspaceName: 'Retry Example', jurisdiction: 'bc-municipal' })).json.workspace.id;
  const geo = JSON.stringify({ geocode: { status: 'nomatch', at: '2026-01-01T00:00:00Z' } });
  const aside = await insert({ ws: other, name: 'Aside Bsmt Example', address: 'Bsmt 10800 134 St' });
  const plain = await insert({ ws: other, name: 'Aside Plain Example', address: '99999 Nowhere Rd' });
  await db.query(`update persons set attrs = attrs || $2::jsonb where id = any($1::uuid[])`, [[aside, plain], geo]);
  if (doorsMod) await doorsMod.fillDoorParts(db, { workspaceId: other });
  const { requeueSuites } = await import('../ext/geocoding/index.js');
  assert.equal(typeof requeueSuites, 'function', 'ext/geocoding requeueSuites');
  assert.equal(await requeueSuites(db, other), 1);
  const st = async (id) => (await db.query(`select attrs->'geocode' as g, address, unit from persons where id = $1`, [id])).rows[0];
  const a = await st(aside);
  assert.equal(a.g.status, '');
  assert.equal(a.g.suite_retry, true);
  assert.deepEqual([a.address, a.unit], ['Bsmt 10800 134 St', null], 'address and unit untouched');
  assert.equal((await st(plain)).g.status, 'nomatch', 'an address with no suite in it stays set aside');
  await db.query(`update persons set attrs = attrs || $2::jsonb where id = $1`, [aside, JSON.stringify({ geocode: { status: 'nomatch', suite_retry: true } })]);
  assert.equal(await requeueSuites(db, other), 0, 'once only');
});

test('geocoding: a suite tried again and still not found is not asked again on the next press', async () => {
  const other = (await new Client().signup({ workspaceName: 'Retry Twice Example', jurisdiction: 'bc-municipal' })).json.workspace.id;
  const id = await insert({ ws: other, name: 'Retry Bsmt Example', address: 'Bsmt 10801 Nomatch St' });
  await db.query(`update persons set attrs = attrs || $2::jsonb where id = $1`, [id, JSON.stringify({ geocode: { status: 'nomatch', at: '2026-01-01T00:00:00Z' } })]);
  if (doorsMod) await doorsMod.fillDoorParts(db, { workspaceId: other });
  const { requeueSuites, geocodeRound } = await import('../ext/geocoding/index.js');
  assert.equal(await requeueSuites(db, other), 1, 'first press: tried again');
  asked.length = 0;
  for (let i = 0; i < 5; i += 1) if ((await geocodeRound(db, other, null)).done) break;
  assert.ok(asked.some((q) => /^10801 Nomatch St/i.test(q)), `looked up as its house: ${asked.join(' · ')}`);
  const g = (await db.query(`select attrs->'geocode' as g from persons where id = $1`, [id])).rows[0].g;
  assert.equal(g.status, 'nomatch');
  assert.equal(g.suite_retry, true, 'the round keeps the mark');
  assert.equal(await requeueSuites(db, other), 0, 'second press: not asked again');
});

// ── 2b. The walk list decides house or building before the round thins it ──
test('walk list: a round that leaves two units and a blank row of a tower still reads Building; a house keeps its place', async () => {
  const W = { lat: 49.4, lng: -122.6 };
  await insert({ name: 'Walk Office Example', address: '13800 104 Ave', ...W });
  for (let i = 1; i <= 12; i += 1) {
    await insert({ name: `Walk${i} Example`, address: '13800 104 Ave', unit: String(1200 + i), rating: i <= 10 ? '1' : null, ...W });
  }
  const Hs = { lat: 49.4003, lng: -122.6 };
  await insert({ name: 'Walk House Example', address: '10900 134 St', rating: '1', ...Hs });
  await insert({ name: 'Walk Suite Example', address: '10900 134 St', unit: 'Bsmt', ...Hs });
  ok(await mgr.action('pass.start', { name: 'Undecided round', kind: 'persuasion', who: 'undecided' }));
  const t = ok(await mgr.action('turf.create', { name: 'Walk block', polygon: square(W.lat + 0.0001, W.lng) })).turf;
  const row = (await db.query('select * from turfs where id = $1', [t.id])).rows[0];
  const ctx = await loadContext(db, mgr.cookie.split('=')[1]);
  const w = await walkFor(db, ctx, row);
  const tower = w.doors.filter((d) => /13800/.test(d.address));
  assert.deepEqual(tower.map((d) => d.unit || ''), ['1211', '1212', ''], 'on this round: two units and the blank row (Other units, last)');
  for (const d of tower) assert.deepEqual([d.place, d.units, d.civic], ['building', 13, '13800 104 ave']);
  assert.deepEqual(tower.map((d) => d.unit_words), ['Unit 1211', 'Unit 1212', 'No unit number']);
  const suite = w.doors.filter((d) => /10900/.test(d.address));
  assert.equal(suite.length, 1, 'the main door said yes: not on this round');
  assert.deepEqual([suite[0].place, suite[0].unit_words], ['house', 'Basement suite']);
  assert.deepEqual(suite[0].house_doors.map((x) => [x.unit, x.words, x.in_round]), [['', 'Main', false], ['BSMT', 'Basement suite', true]]);
  ok(await mgr.action('pass.end', { id: w.pass.id }));
});

// ── 6b. One person's door on a big list carries the other doors of the house ──
test('map ?person=: the door, and the other doors at its house (the door switch on a big list)', async () => {
  const P = { lat: 49.5, lng: -122.6 };
  const main = await insert({ name: 'Ivy Example', address: '11000 134 St', ...P });
  const bsmt = await insert({ name: 'Jon Example', address: '11000 134 St Bsmt', ...P });
  await insert({ name: 'Kim Example', address: '11000 134 St', unit: 'Coach house', ...P });
  await fill();
  const j = ok(await mgr.get(`/api/map/doors?person=${bsmt}`));
  assert.deepEqual(j.persons.map((p) => p.name), ['Jon Example']);
  assert.equal(j.place, 'house');
  assert.deepEqual(j.house.map((d) => [d.unit, d.unit_words, d.persons.map((p) => p.name)]), [
    ['', 'Main', ['Ivy Example']], ['COACH', 'Coach house', ['Kim Example']],
  ]);
  const prof = ok(await mgr.get(`/api/persons/${main}`));
  assert.deepEqual(prof.at_house.map((d) => [d.unit_words, d.people]), [['Basement suite', 1], ['Coach house', 1]]);
});

// ── 6c. A house's door states come from the server, for the open round ──
test('house states: each door at a house with its state on the open round, whoever asks and whatever their phone keeps', async () => {
  const Q = { lat: 49.55, lng: -122.6 };
  const main = await insert({ name: 'Nia Example', address: '11200 134 St', ...Q });
  const bsmt = await insert({ name: 'Oto Example', address: '11200 134 St Bsmt', ...Q });
  const coach = await insert({ name: 'Pia Example', address: '11200 134 St', unit: 'Coach house', ...Q });
  await insert({ name: 'Far Example', address: '11200 134 St', lat: Q.lat + 0.01, lng: Q.lng });
  await fill();
  const first = ok(await mgr.action('pass.start', { name: 'House round', kind: 'persuasion', who: 'all', tries: 2 })).pass;
  ok(await mgr.action('contact.log', { person_id: main, channel: 'door', outcome: 'no_answer' }));
  ok(await mgr.action('contact.log', { person_id: coach, channel: 'door', outcome: 'refused' }));
  const read = async (id) => ok(await mgr.get(`/api/buildings/house/${id}`));
  const j = await read(bsmt);
  assert.equal(j.pass?.id, first.id, 'the open round');
  assert.deepEqual(j.doors.map((d) => [d.key, d.unit, d.state, d.in_round]), [
    ['11200 134 st|', '', 'again', true], ['11200 134 st|BSMT', 'BSMT', 'open', true], ['11200 134 st|COACH', 'COACH', 'done', true],
  ], 'Main to try again, the basement suite not knocked, the coach house done (the same civic 1 km away is not this house)');
  assert.deepEqual((await read(main)).doors.map((d) => d.state), ['again', 'open', 'done'], 'the same from any door of the house');
  // A new round: every door is open again on it.
  ok(await mgr.action('pass.end', { id: first.id }));
  const second = ok(await mgr.action('pass.start', { name: 'Second round', kind: 'persuasion', who: 'all', tries: 2 })).pass;
  const k = await read(bsmt);
  assert.equal(k.pass?.id, second.id);
  assert.deepEqual(k.doors.map((d) => d.state), ['open', 'open', 'open']);
  ok(await mgr.action('pass.end', { id: second.id }));
  assert.equal((await mgr.get('/api/buildings/house/not-an-id')).status, 404);
});

// ── 10. One door, one wording: a list row carries its house (review 10) ──
test('People rows and search carry place "house" for a door at a house, so a duplex reads Suite B everywhere', async () => {
  const D2 = { lat: 49.65, lng: -122.6 };
  const a = await insert({ name: 'Rae Example', address: 'A-11400 134 St', ...D2 });
  const b = await insert({ name: 'Sam Example', address: 'B-11400 134 St', ...D2 });
  const m = await insert({ name: 'Tom Example', address: '11500 134 St', lat: D2.lat + 0.001, lng: D2.lng });
  const s = await insert({ name: 'Uli Example', address: '11500 134 St', unit: 'Bsmt', lat: D2.lat + 0.001, lng: D2.lng });
  const lone = await insert({ name: 'Val Example', address: '11600 134 St', lat: D2.lat + 0.002, lng: D2.lng });
  const unit = await insert({ name: 'Wyn Example', address: '#1803 14000 104 Ave', lat: D2.lat + 0.003, lng: D2.lng });
  // The same civic 1 km away, on its own: a lone door, not part of the duplex.
  const far = await insert({ name: 'Xan Example', address: 'A-11400 134 St', lat: D2.lat + 0.01, lng: D2.lng });
  await fill();
  const rows = ok(await mgr.get('/api/persons?limit=500')).persons;
  const placeOfRow = (id) => rows.find((r) => r.id === id)?.place ?? null;
  assert.deepEqual([a, b, m, s].map(placeOfRow), ['house', 'house', 'house', 'house'], 'the duplex and the house with a basement suite');
  assert.deepEqual([lone, unit, far].map(placeOfRow), [null, null, null], 'a lone door and a lone unit carry no place');
  const found = ok(await mgr.get(`/api/persons?q=${encodeURIComponent('11400 134')}`)).persons;
  assert.ok(found.some((r) => r.id === b && r.place === 'house'), 'search rows too');
  const { doorLine } = await import('../../shared/units.js');
  const row = found.find((r) => r.id === b);
  const prof = ok(await mgr.get(`/api/persons/${b}`));
  assert.equal(doorLine(row), 'Suite B · 11400 134 St', 'the search row');
  assert.equal(doorLine(prof.person, prof.at_house.length ? 'house' : 'door'), 'Suite B · 11400 134 St', 'the profile');
});

// ── 16. Search finds suites and units written in the address ──
test('search: “10388 134” finds the suite written “Bsmt 10388 134 St”; “13450 104” the unit “#1203 13450 104 Ave”', async () => {
  await insert({ name: 'Lou Example', address: 'Bsmt 11100 134 St', lat: 49.6, lng: -122.6 });
  await insert({ name: 'Max Example', address: '#1803 13900 104 Ave', lat: 49.6, lng: -122.61 });
  await fill();
  const names = async (q) => ok(await mgr.get(`/api/search/people?q=${encodeURIComponent(q)}&limit=50`)).persons.map((p) => p.name);
  assert.ok((await names('11100 134')).includes('Lou Example'));
  assert.ok((await names('13900 104')).includes('Max Example'));
});

// ── 25. The export leaves the worked-out columns out ──
test('the full export carries no door_ columns (they are worked out again from address and unit)', async () => {
  const j = ok(await mgr.get('/api/export'));
  assert.ok(j.persons.length > 0);
  for (const k of DOOR_COLS) assert.ok(!j.persons.some((p) => k in p), k);
});

// ── 5b. No raw door key left outside the one module ──
test('no copy of the old door key in server/ or scripts/ (only server/lib/doors.js and shared/units.js)', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const hits = [];
  const walk = (dir) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (f === 'node_modules' || f === 'test') continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(m?js|jsx)$/.test(f)) {
        const text = readFileSync(p, 'utf8');
        if (/lower\(b?trim\(p\.address\)\) \|\| '\|'/.test(text) || /norm\(d\.address\)\}\|/.test(text)
          || /address \|\| ''\)\.trim\(\)\.toLowerCase\(\)\}\|/.test(text)) hits.push(relative(root, p));
      }
    }
  };
  for (const d of ['server', 'scripts']) walk(join(root, d));
  assert.deepEqual(hits.filter((h) => !['server/lib/doors.js', 'shared/units.js'].includes(h)), []);
});
