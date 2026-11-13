// The front page's map window (GET /map/doors?mine=1): the doors of the
// turfs the caller walks, and their own record — for a volunteer (kept to
// their turfs or not), a candidate and a manager alike. It is read on every
// visit to Today, so it reads the people by the turfs' boxes and the email
// index only: never a count, the list's bounds or anything over the whole
// list (at 300,000 people those run for seconds).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';

let db, mgr, vol, volId, cand, candId, mgrId;
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
const box = (lat, lng, d = 0.005) => [[lat - d, lng - d], [lat - d, lng + d], [lat + d, lng + d], [lat + d, lng - d]];
const names = (j) => j.persons.map((p) => p.name).sort();
const join = async (email, name, role = 'volunteer') => {
  const inv = await mgr.action('member.invite', { email, role });
  const cl = new Client();
  const id = ok(await cl.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name, password: 'walker-pass-1' })).user.id;
  return [cl, id];
};

before(async () => {
  db = await freshDb();
  mgr = new Client();
  mgrId = (await mgr.signup({ workspaceName: 'Mine', jurisdiction: 'bc-municipal' })).json.user.id;
  [vol, volId] = await join('walker.mine@example.org', 'Walker Example');
  // A candidate: a volunteer account holding a seat.
  const seat = ok(await mgr.action('candidate.save', { name: 'Cleo Example', office: 'Council', race: 'council', email: 'cleo.mine@example.org' })).candidate.id;
  const inv = ok(await mgr.action('candidate.invite', { id: seat }));
  cand = new Client();
  candId = ok(await cand.post('/api/auth/join', { token: inv.joinUrl.split('/join/')[1], name: 'Cleo Example', password: 'candidate-2026' })).user.id;
  await mgr.createPerson('North Example', { address: '1 North St', lat: 49.1, lng: -122.8 });
  await mgr.createPerson('South Example', { address: '2 South St', lat: 49.0, lng: -122.7 });
  await mgr.createPerson('Far Example', { address: '9 Far Rd', lat: 49.2, lng: -122.6 });
  await mgr.createPerson('Walker Example', { email: 'walker.mine@example.org', address: '5 Home Ave', lat: 49.3, lng: -122.5 });
  ok(await mgr.action('sign.place', { kind: 'lawn', address: '1 North St', lat: 49.1, lng: -122.8 }));
  const north = ok(await mgr.action('turf.create', { name: 'North block', polygon: box(49.1, -122.8) })).turf;
  const south = ok(await mgr.action('turf.create', { name: 'South block', polygon: box(49.0, -122.7) })).turf;
  ok(await mgr.action('turf.assign', { turf_id: north.id, user_id: volId }));
  ok(await mgr.action('turf.assign', { turf_id: south.id, user_id: candId }));
  ok(await mgr.action('turf.assign', { turf_id: north.id, user_id: mgrId }));
});

// Every query each answer asks of the database.
const watched = async (fn) => {
  const asked = [];
  const real = db.query;
  db.query = (sql, ...rest) => { asked.push(String(sql)); return real.call(db, sql, ...rest); };
  try { return { answer: await fn(), asked }; } finally { db.query = real; }
};
const lean = (asked) => {
  const people = asked.filter((q) => /\bfrom persons\b/i.test(q));
  for (const q of people) {
    assert.doesNotMatch(q, /count\s*\(/i, `a count over the people: ${q}`);
    assert.doesNotMatch(q, /percentile_disc/i, `the list's bounds: ${q}`);
    assert.match(q, /lat between|lower\(email\) =/i, `a read of the people by neither a box nor an email: ${q}`);
  }
  return people.length;
};

const mine = async (cl) => {
  const { answer, asked } = await watched(async () => ok(await cl.get('/api/map/doors?mine=1')));
  assert.ok(lean(asked) <= 1);
  assert.equal(answer.scope, 'mine');
  assert.equal(answer.unlocated, 0);
  assert.equal(answer.signs, undefined, 'no signs on the front page');
  assert.equal(answer.total, undefined);
  return answer;
};

test('a volunteer: their turf’s doors and their own record, whatever the volunteers’ map setting', async () => {
  for (const scope of ['all', 'turfs']) {
    ok(await mgr.action('permission.doors.set', { scope }));
    const j = await mine(vol);
    assert.deepEqual(names(j), ['North Example', 'Walker Example'], scope);
    assert.equal(j.turfs, 1);
    assert.deepEqual(j.outlines.map((t) => [t.name, t.polygon.length]), [['North block', 4]], 'their turf’s outline, to draw');
  }
  ok(await mgr.action('permission.doors.set', { scope: 'all' }));
  // The bare read is unchanged (every door, as before).
  assert.deepEqual(names(ok(await vol.get('/api/map/doors'))), ['Far Example', 'North Example', 'South Example', 'Walker Example']);
});

test('a candidate gets their own turf; a manager with a turf gets theirs, not the whole list', async () => {
  const c = await mine(cand);
  assert.deepEqual([names(c), c.turfs], [['South Example'], 1]);
  const m = await mine(mgr);
  assert.deepEqual([names(m), m.turfs], [['North Example'], 1]);
  // Volunteers never see a hidden field through it (forViewer).
  assert.ok((await mine(vol)).persons.every((p) => !('gifts' in p)));
});

test('no turf: their own record or nothing, and no read of the people but by email', async () => {
  const [lone] = await join('lone.mine@example.org', 'Lone Example');
  const j = await mine(lone);
  assert.deepEqual([j.persons, j.turfs, j.outlines], [[], 0, []]);
});
