// Buildings (HR-1, ext/buildings): a 120-unit tower read as one building —
// its unit rows in floor order with their states, the same from a person and
// from a dot; a pass never shrinks it (doors it doesn't want stay, off this
// round); a volunteer kept to their turfs sees it only inside one; a person
// gone or moved away says so; a crowd too big to list says that. The walk
// list's door shaping (routes/api.js shapeDoors) is what it was. And the busy
// map's dots know how many units a spot has (doorDots' u).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb, Client } from './helpers.js';
import { loadContext } from '../lib/auth.js';
import { walkFor, loadLocated, boxOf, shapeDoors } from '../routes/api.js';
import { openPass, listedWhere } from '../ext/passes/rule.js';
import { pointInPolygon, groupDoors, walkOrder } from '../lib/geo.js';
import { forViewer } from '../lib/viewer.js';
import { doorState, inPass } from '@starbase/shared/passes';

let db, ws, mgr, vol, volId, stranger, turf, anchor;
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
const T = { lat: 49.19, lng: -122.85 };
const square = (lat, lng, d = 0.002) => [[lat - d, lng - d], [lat - d, lng + d], [lat + d, lng + d], [lat + d, lng - d]];
const UNITS = [];
for (let f = 2; f <= 13; f += 1) for (let k = 1; k <= 10; k += 1) UNITS.push(String(f * 100 + k));
const byUnit = new Map();

const insert = async (row) => {
  const id = randomUUID();
  await db.query(
    `insert into persons (id, workspace_id, name, address, unit, city, lat, lng, rating) values ($1, $2, $3, $4, $5, 'Surrey', $6, $7, $8)`,
    [id, ws, row.name, row.address, row.unit ?? null, row.lat ?? T.lat, row.lng ?? T.lng, row.rating ?? null],
  );
  return id;
};
const join = async (email, name) => {
  const inv = await mgr.action('member.invite', { email, role: 'volunteer' });
  const c = new Client();
  const id = ok(await c.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name, password: 'walker-pass-1' })).user.id;
  return [c, id];
};

before(async () => {
  db = await freshDb();
  mgr = new Client();
  ws = (await mgr.signup({ workspaceName: 'Towers', jurisdiction: 'bc-municipal' })).json.workspace.id;
  // The tower: floors 2–13, 10 units a floor; every other unit written with
  // its unit inside the address. Floors 2–7 say yes (1); the rest not asked.
  for (const [k, u] of UNITS.entries()) {
    const yes = Number(u) < 800 ? '1' : null;
    const row = k % 2 === 0 ? { address: '13450 104 Ave', unit: u } : { address: `${u}-13450 104 Ave`, unit: null };
    const id = await insert({ name: `Unit${u} Example`, rating: yes, ...row });
    byUnit.set(u, id);
  }
  // 1203 written the other way too (it is in hyphen form above): one unit.
  await insert({ name: 'Second1203 Example', address: '13450 104 Avenue', unit: '1203' });
  // The house next door: three doors (a suite and a coach house), not a building.
  for (const unit of [null, 'A', 'B']) await insert({ name: `House${unit || ''} Example`, address: '13452 104 Ave', unit, lat: T.lat + 0.0001 });
  anchor = byUnit.get('201');
  [vol, volId] = await join('walker.tower@example.org', 'Walker Example');
  [stranger] = await join('stranger.tower@example.org', 'Stranger Example');
  turf = ok(await mgr.action('turf.create', { name: 'The tower', polygon: square(T.lat, T.lng) })).turf;
  ok(await mgr.action('turf.assign', { turf_id: turf.id, user_id: volId }));
});

const unitsOf = (j) => [...new Set(j.doors.map((d) => d.unit_label))];

test('of/:id: 120 units in floor order with their states; the house next door is not in it; at?lat&lng the same', async () => {
  const j = ok(await mgr.get(`/api/buildings/of/${anchor}`));
  assert.equal(j.building.units, 120);
  assert.equal(j.building.address, '13450 104 Ave');
  assert.equal(j.building.people, 121);
  assert.equal(j.building.floors, true);
  assert.deepEqual(unitsOf(j), UNITS, 'floor by floor, 201 to 1310');
  assert.equal(j.doors.length, 121, '1203 is two doors (two spellings), one unit');
  assert.ok(!j.doors.some((d) => d.address.startsWith('13452')), 'the house next door');
  assert.deepEqual([j.building.open, j.building.again, j.building.done], [120, 0, 0]);
  assert.equal(j.pass, null);
  const d201 = j.doors[0];
  assert.deepEqual([d201.unit, d201.unit_label, d201.floor, d201.in_round, d201.state], ['201', '201', 2, true, 'open']);
  assert.ok(Array.isArray(d201.signs) && d201.persons[0].name === 'Unit201 Example', 'the walk list’s door shape');
  const hy = j.doors.find((d) => d.unit_label === '202');
  assert.deepEqual([hy.address, hy.unit, hy.floor], ['202-13450 104 Ave', null, 2], 'a door stays address + unit as on file');
  ok(await mgr.action('contact.log', { person_id: byUnit.get('202'), channel: 'door', outcome: 'no_answer' }));
  const after = ok(await mgr.get(`/api/buildings/of/${anchor}`));
  assert.deepEqual([after.building.open, after.building.done], [119, 1], 'with no pass a knock finishes a door');
  const at = ok(await mgr.get(`/api/buildings/at?lat=${T.lat}&lng=${T.lng}`));
  assert.equal(at.building.key, after.building.key);
  assert.deepEqual(unitsOf(at), UNITS);
  assert.deepEqual(ok(await mgr.get(`/api/buildings/at?lat=${T.lat + 0.0001}&lng=${T.lng}`)), { building: null }, 'the house: not a building');
  assert.deepEqual(ok(await mgr.get('/api/buildings/at?lat=10&lng=10')), { building: null }, 'nobody there');
  assert.equal((await mgr.get('/api/buildings/at?lat=x&lng=1')).status, 400);
});

test('a pass that leaves out the anchor and half the tower still returns the whole building', async () => {
  ok(await mgr.action('pass.start', { name: 'Undecided', kind: 'persuasion', who: 'undecided' }));
  ok(await mgr.action('contact.log', { person_id: byUnit.get('801'), channel: 'door', outcome: 'no_answer' }));
  ok(await mgr.action('contact.log', { person_id: byUnit.get('802'), channel: 'door', outcome: 'contacted' }));
  const j = ok(await mgr.get(`/api/buildings/of/${anchor}`));
  assert.equal(j.building.units, 120);
  assert.deepEqual(unitsOf(j), UNITS);
  const out = j.doors.filter((d) => !d.in_round).map((d) => d.unit_label);
  assert.equal(out.length, 60);
  assert.ok(out.every((u) => Number(u) < 800), 'floors 2–7 said yes: not on this round');
  assert.deepEqual([j.building.open, j.building.again, j.building.done], [58, 1, 1], 'only the units on this round');
  assert.equal(j.pass.who, 'undecided');
  assert.equal(j.doors.find((d) => d.unit_label === '801').state, 'again');
});

test('a volunteer kept to their turfs: inside, the building; outside, not; the desk always', async () => {
  ok(await mgr.action('permission.doors.set', { scope: 'turfs' }));
  try {
    assert.equal(ok(await vol.get(`/api/buildings/of/${anchor}`)).building.units, 120);
    const no = await stranger.get(`/api/buildings/of/${anchor}`);
    assert.deepEqual([no.status, no.json.error], [404, 'Not on your turfs']);
    const noAt = await stranger.get(`/api/buildings/at?lat=${T.lat}&lng=${T.lng}`);
    assert.equal(noAt.status, 404);
    assert.equal(ok(await mgr.get(`/api/buildings/of/${anchor}`)).building.units, 120);
  } finally {
    ok(await mgr.action('permission.doors.set', { scope: 'all' }));
  }
  assert.equal(ok(await stranger.get(`/api/buildings/of/${anchor}`)).building.units, 120, 'every door: any building');
});

test('a person gone, or moved away, gives 404 gone', async () => {
  const gone = await insert({ name: 'Gone Example', address: '13450 104 Ave', unit: '1310' });
  assert.equal(ok(await mgr.get(`/api/buildings/of/${gone}`)).building.units, 120);
  await db.query('update persons set deleted_at = now() where id = $1', [gone]);
  const r = await mgr.get(`/api/buildings/of/${gone}`);
  assert.deepEqual([r.status, r.json.gone, r.json.error], [404, true, 'This building isn’t here any more']);
  const mover = await insert({ name: 'Mover Example', address: '13450 104 Ave', unit: '1309' });
  const was = `${T.lat},${T.lng}`;
  assert.equal(ok(await mgr.get(`/api/buildings/of/${mover}?was=${was}`)).building.units, 120);
  // Moved to Address unknown: no address at all.
  await db.query('update persons set address = null where id = $1', [mover]);
  assert.equal((await mgr.get(`/api/buildings/of/${mover}`)).json.gone, true);
  // Moved across town: the sheet that showed the tower says it isn't here.
  await db.query(`update persons set address = '5 Oak St', unit = null, lat = 49.25, lng = -122.75 where id = $1`, [mover]);
  const moved = await mgr.get(`/api/buildings/of/${mover}?was=${was}`);
  assert.deepEqual([moved.status, moved.json.gone], [404, true]);
  assert.deepEqual(ok(await mgr.get(`/api/buildings/of/${mover}`)), { building: null }, 'asked afresh: a house');
  assert.equal((await mgr.get('/api/buildings/of/not-an-id')).status, 404);
  assert.equal((await mgr.get(`/api/buildings/of/${randomUUID()}`)).json.gone, true);
});

test('more than 3,000 people around one point: too big to list, no doors', async () => {
  const at = { lat: 49.40, lng: -122.60 };
  await db.query(
    `insert into persons (id, workspace_id, name, address, unit, lat, lng)
     select gen_random_uuid(), $1, 'Crowd' || g || ' Example', '100 Crowd St', g::text, $2, $3 from generate_series(1, 3001) g`,
    [ws, at.lat, at.lng],
  );
  const one = (await db.query(`select id from persons where workspace_id = $1 and address = '100 Crowd St' limit 1`, [ws])).rows[0].id;
  const j = ok(await mgr.get(`/api/buildings/of/${one}`));
  assert.deepEqual(j.building, { address: '100 Crowd St', units: null });
  assert.equal(j.truncated, true);
  assert.deepEqual(j.doors, []);
  await db.query(`delete from persons where workspace_id = $1 and address = '100 Crowd St'`, [ws]);
});

// The walk list's door shaping as it was before shapeDoors was lifted out of
// walkFor (the frozen copy), against walkFor now: byte for byte.
const walkBefore = async (ctx, t) => {
  const polygon = typeof t.polygon === 'string' ? JSON.parse(t.polygon) : t.polygon;
  const pass = await openPass(db, ctx.workspaceId);
  const box = boxOf(polygon);
  const located = box ? await loadLocated(db, ctx, pass, box, await listedWhere(db, ctx, pass)) : [];
  const doors = walkOrder(groupDoors(located.filter((p) => pointInPolygon(p.lat, p.lng, polygon))).filter((d) => inPass(d, pass)));
  const view = forViewer(ctx);
  const signs = (await db.query(
    `select id, person_id, address, kind, status from signs where workspace_id = $1 and status <> 'removed'`,
    [ctx.workspaceId],
  )).rows;
  const signsAt = (d) => {
    const ids = new Set(d.persons.map((p) => p.id));
    const addr = !d.unit && d.address ? String(d.address).trim().toLowerCase() : null;
    return signs
      .filter((s) => (s.person_id ? ids.has(s.person_id) : addr && String(s.address || '').trim().toLowerCase() === addr))
      .map(({ id, kind, status }) => ({ id, kind, status }));
  };
  return {
    turf: { id: t.id, name: t.name, color: t.color, notes: t.notes, polygon },
    doors: doors.map((d) => {
      const state = doorState(d, pass);
      return { ...d, persons: d.persons.map(view), signs: signsAt(d), state, tries: Math.max(0, ...d.persons.map((p) => p.pass_tries || 0)), done: state === 'done' };
    }),
    pass: pass ? { id: pass.id, name: pass.name, kind: pass.kind, who: pass.who, list_id: pass.list_id || null, tries: pass.tries, started_at: pass.started_at } : null,
  };
};

test('walkFor’s output for a recorded turf is byte-identical before and after shapeDoors', async () => {
  ok(await mgr.action('sign.place', { kind: 'lawn', person_id: byUnit.get('305') }));
  ok(await mgr.action('sign.place', { kind: 'lawn', address: '13452 104 Ave', lat: T.lat + 0.0001, lng: T.lng }));
  const t = (await db.query('select * from turfs where id = $1', [turf.id])).rows[0];
  for (const c of [mgr, vol]) {
    const ctx = await loadContext(db, c.cookie.split('=')[1]);
    const now = await walkFor(db, ctx, t);
    const { stats, ...rest } = now;
    assert.ok(stats && now.doors.length > 60);
    assert.equal(JSON.stringify(rest), JSON.stringify(await walkBefore(ctx, t)), ctx.role);
    assert.equal(JSON.stringify(await shapeDoors(db, ctx, [], null)), '[]');
  }
  // The walk list takes the tower floor by floor.
  const walk = ok(await vol.get(`/api/turfs/${turf.id}/walk`));
  const tower = walk.doors.filter((d) => /13450 104 Ave/.test(d.address)).map((d) => d.unit || d.address.split('-')[0]);
  assert.deepEqual([...new Set(tower)], UNITS.filter((u) => Number(u) >= 800), 'the units on this round, 801 to 1310');
});

test('doorDots: u, the most units at one address at a spot; band still the strongest', async () => {
  process.env.BASE_MAP_ALL = '20';
  try {
    const A = { lat: 49.30, lng: -122.70 };
    for (let i = 1; i <= 50; i += 1) {
      const u = String(100 + i);
      await insert({ name: `Fifty${u} Example`, ...(i % 2 ? { address: '13460 Fifty St', unit: u } : { address: `${u}-13460 Fifty St` }), ...A });
    }
    const B = { lat: 49.31, lng: -122.70 };
    for (let i = 1; i <= 5; i += 1) await insert({ name: `Rough${i} Example`, address: `${i} Rough Rd`, ...B, rating: i === 1 ? '4' : i === 2 ? '1' : null });
    const j = ok(await mgr.get('/api/map/doors?bbox=49.29,-122.71,49.32,-122.69&dots=1'));
    const at = (p) => j.dots.find((x) => Math.abs(x[0] - p.lat) < 1e-6 && Math.abs(x[1] - p.lng) < 1e-6);
    assert.deepEqual(at(A), [A.lat, A.lng, 0, 50, 50], 'a tower half in hyphen form: the full count');
    assert.deepEqual(at(B), [B.lat, B.lng, 3, 5, 1], 'five houses on one rough geocode: not a building; opposed beats yes');
    const tower = ok(await mgr.get(`/api/map/doors?bbox=${T.lat - 0.0002},${T.lng - 0.0002},${T.lat + 0.0002},${T.lng + 0.0002}&dots=1`));
    assert.ok(tower.dots.some((x) => x[4] >= 120), 'the tower’s spot');
  } finally {
    delete process.env.BASE_MAP_ALL;
  }
});
