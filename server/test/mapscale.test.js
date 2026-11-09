// A city-wide list on the map. Up to STARBASE_MAP_ALL located people the map
// loads them all (never cut off part way, as the old 5,000 limit did — by
// address, so a whole voter file showed only the "10…" streets). Past it the
// map asks by the part in view (?bbox), at most 8,000 people at a time, and
// from further out by a count per patch (/map/density), by rating. Turfs
// count only the people inside their own corners. A volunteer kept to their
// turfs gets those doors, however big the list.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb, Client } from './helpers.js';

let mgr, vol, volId, db, ws;
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
// 10 × 6 = 60 people on a grid around Newton, every third rated 1, every
// fifth rated 4.
const GRID = [];
for (let i = 0; i < 10; i += 1) for (let j = 0; j < 6; j += 1) GRID.push({ lat: 49.10 + i * 0.001, lng: -122.85 + j * 0.001, n: i * 6 + j });

before(async () => {
  db = await freshDb();
  mgr = new Client();
  ws = (await mgr.signup({ workspaceName: 'Map scale', jurisdiction: 'bc-municipal' })).json.workspace.id;
  const inv = await mgr.action('member.invite', { email: 'walker.scale@example.org', role: 'volunteer' });
  vol = new Client();
  volId = ok(await vol.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: 'Walker Example', password: 'walker-pass-1' })).user.id;
  for (const g of GRID) {
    await db.query(
      `insert into persons (id, workspace_id, name, address, lat, lng, rating) values ($1, $2, $3, $4, $5, $6, $7)`,
      [randomUUID(), ws, `Voter ${g.n} Example`, `${1000 + g.n} Example St`, g.lat, g.lng, g.n % 3 === 0 ? '1' : g.n % 5 === 0 ? '4' : null],
    );
  }
  // One with an address and no place on the map yet.
  await db.query(`insert into persons (id, workspace_id, name, address) values ($1, $2, 'Unplaced Example', '1 Nowhere St')`, [randomUUID(), ws]);
});

test('a list under the limit loads whole, every person (no cut-off by address)', async () => {
  process.env.STARBASE_MAP_ALL = '100';
  const j = ok(await mgr.get('/api/map/doors'));
  assert.equal(j.persons.length, 60);
  assert.equal(j.total, 60);
  assert.equal(j.unlocated, 1, 'the one with an address and no place is counted, not lost');
  assert.ok(!j.big);
});

test('a bigger list: the map is told to ask by view; the view gets everyone in it', async () => {
  process.env.STARBASE_MAP_ALL = '20';
  const whole = ok(await mgr.get('/api/map/doors'));
  assert.deepEqual([whole.big, whole.total, whole.persons.length, whole.unlocated], [true, 60, 0, 1]);
  const [bs, bw, bn, be] = whole.bounds;
  assert.ok(bs >= 49.0999 && bn <= 49.1091 && bw >= -122.8501 && be <= -122.8449 && bs < bn && bw < be, `where they live: ${whole.bounds}`);
  // The south-west corner: rows 0–4, columns 0–2 → 15 people.
  const view = ok(await mgr.get('/api/map/doors?bbox=49.0995,-122.8505,49.1045,-122.8475'));
  assert.equal(view.scope, 'view');
  assert.equal(view.persons.length, 15);
  assert.equal(view.truncated, false);
  assert.equal((await mgr.get('/api/map/doors?bbox=nonsense')).json.big, true, 'a bad box is ignored, not an error');
});

test('from further out: a count per patch, by rating, adding up to everyone in view', async () => {
  process.env.STARBASE_MAP_ALL = '20';
  const d = ok(await mgr.get('/api/map/density?bbox=49.09,-122.86,49.12,-122.84&cell=0.005,0.005'));
  const total = d.cells.reduce((n, c) => n + c[3], 0);
  assert.equal(total, 60);
  const by = (r) => d.cells.filter((c) => c[2] === r).reduce((n, c) => n + c[3], 0);
  assert.deepEqual([by('1'), by('4'), by('')], [20, 8, 32], 'rated 1, rated 4 (not also 1), not yet rated');
  const coarse = ok(await mgr.get('/api/map/density?bbox=49,-123,50,-122&cell=0.00001,0.00001'));
  assert.ok(coarse.cell[0] > 0.00001 && (1 / coarse.cell[0]) * (1 / coarse.cell[1]) <= 150000, `too fine for the area: coarsened to ${coarse.cell}`);
  assert.equal(coarse.cells.reduce((n, c) => n + c[3], 0), 60, '…and still everyone');
  assert.equal((await mgr.get('/api/map/density')).status, 400);
});

test('over the cap, a view keeps the people nearest its middle and says so', async () => {
  process.env.STARBASE_MAP_ALL = '20';
  const prev = process.env.STARBASE_MAP_VIEW;
  // 60 people on the grid; the box covers all of them; a cap of 10 (test
  // setting) keeps the 10 nearest the middle.
  process.env.STARBASE_MAP_VIEW = '10';
  const v = ok(await mgr.get('/api/map/doors?bbox=49.0995,-122.8505,49.1095,-122.8445'));
  assert.equal(v.truncated, true);
  assert.equal(v.persons.length, 10);
  const mid = [(49.0995 + 49.1095) / 2, (-122.8505 + -122.8445) / 2];
  const d = (p) => Math.abs(p.lat - mid[0]) + Math.abs(p.lng - mid[1]);
  const kept = Math.max(...v.persons.map(d));
  if (prev === undefined) delete process.env.STARBASE_MAP_VIEW; else process.env.STARBASE_MAP_VIEW = prev;
  // The grid's 10 nearest the middle are within 0.002° (rows 4–5 by
  // columns 1–4); the far corners are 0.007° out.
  assert.ok(kept <= 0.0021, `the kept ones are the middle ones (furthest kept ${kept.toFixed(4)})`);
});

test('a sign asked for before its person had a pin shows at their door', async () => {
  process.env.STARBASE_MAP_ALL = '20';
  const pid = (await db.query("select id from persons where workspace_id = $1 and name = 'Voter 0 Example'", [ws])).rows[0].id;
  await db.query(`insert into signs (id, workspace_id, person_id, address, kind, status) values ($1, $2, $3, '1000 Example St', 'lawn', 'requested')`, [randomUUID(), ws, pid]);
  const v = ok(await mgr.get('/api/map/doors?bbox=49.0995,-122.8505,49.1005,-122.8495'));
  assert.ok(v.signs.some((s) => s.person_id === pid), 'found by its person’s pin');
});

test('turfs count only the people inside them', async () => {
  // Rows 0–1 (lat 49.100–49.101), every column: 12 people.
  const polygon = [[49.0995, -122.8505], [49.0995, -122.8445], [49.1015, -122.8445], [49.1015, -122.8505]];
  const turf = ok(await mgr.action('turf.create', { name: 'Two rows', polygon })).turf;
  const t = ok(await mgr.get('/api/turfs')).turfs.find((x) => x.id === turf.id);
  assert.equal(t.people, 12);
  assert.equal(t.doors, 12);
  const walk = ok(await mgr.get(`/api/turfs/${turf.id}/walk`));
  assert.equal(walk.doors.length, 12);
  ok(await mgr.action('turf.assign', { turf_id: turf.id, user_id: volId }));
});

test('a volunteer kept to their turfs gets those doors, however big the list; no city-wide counts', async () => {
  process.env.STARBASE_MAP_ALL = '20';
  ok(await mgr.action('permission.doors.set', { scope: 'turfs' }));
  const j = ok(await vol.get('/api/map/doors'));
  assert.equal(j.scope, 'turfs');
  assert.equal(j.persons.length, 12);
  assert.equal((await vol.get('/api/map/density?bbox=49.09,-122.86,49.12,-122.84&cell=0.005,0.005')).status, 403);
  ok(await mgr.action('permission.doors.set', { scope: 'all' }));
  const all = ok(await vol.get('/api/map/doors'));
  assert.equal(all.big, true, 'every door again: the rest asked by view, like the desk');
  assert.equal(all.persons.length, 12, 'their own turf comes whole (kept on the phone for no signal)');
  assert.equal(ok(await mgr.get('/api/map/doors')).persons.length, 0, 'the desk: all by view');
  delete process.env.STARBASE_MAP_ALL;
});
