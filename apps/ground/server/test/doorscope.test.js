// Volunteers' map (Admin → Permissions): every door, as before, or only the
// doors inside the turfs each volunteer walks — the rest never reach their
// phone. Their own record always comes; a volunteer given Map & turfs sees
// every door; the desk is never narrowed.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';

let mgr, vol, volId;
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
const box = (lat, lng, d = 0.005) => [[lat - d, lng - d], [lat - d, lng + d], [lat + d, lng + d], [lat + d, lng - d]];
const names = (j) => j.persons.map((p) => p.name).sort();

before(async () => {
  await freshDb();
  mgr = new Client();
  await mgr.signup({ workspaceName: 'Door scope', jurisdiction: 'bc-municipal' });
  const inv = await mgr.action('member.invite', { email: 'walker@example.org', role: 'volunteer' });
  vol = new Client();
  volId = ok(await vol.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: 'Walker Example', password: 'walker-pass-1' })).user.id;
  await mgr.createPerson('Inside Example', { address: '1 Inside St', lat: 49.1, lng: -122.8 });
  await mgr.createPerson('Outside Example', { address: '9 Far Rd', lat: 49.2, lng: -122.6 });
  await mgr.createPerson('Walker Example', { email: 'walker@example.org', address: '5 Home Ave', lat: 49.3, lng: -122.5 });
  ok(await mgr.action('sign.place', { kind: 'lawn', address: '1 Inside St', lat: 49.1, lng: -122.8 }));
  ok(await mgr.action('sign.place', { kind: 'lawn', address: '9 Far Rd', lat: 49.2, lng: -122.6 }));
});

test('every door by default; managers alone choose', async () => {
  assert.equal(ok(await mgr.get('/api/admin/permissions')).doors, 'all');
  assert.deepEqual(names(ok(await vol.get('/api/map/doors'))), ['Inside Example', 'Outside Example', 'Walker Example']);
  assert.equal((await vol.action('permission.doors.set', { scope: 'turfs' })).status, 403);
});

test('only their turfs: no turf, nothing but their own door; a turf, its doors and signs', async () => {
  ok(await mgr.action('permission.doors.set', { scope: 'turfs' }));
  assert.equal(ok(await mgr.get('/api/admin/permissions')).doors, 'turfs');
  let j = ok(await vol.get('/api/map/doors'));
  assert.deepEqual([j.scope, j.turfs, j.unlocated], ['turfs', 0, 0]);
  assert.deepEqual(names(j), ['Walker Example'], 'their own record, nobody else');
  assert.equal(j.signs.length, 0);

  const turf = ok(await mgr.action('turf.create', { name: 'Inside block', polygon: box(49.1, -122.8) })).turf;
  ok(await mgr.action('turf.assign', { turf_id: turf.id, user_id: volId }));
  j = ok(await vol.get('/api/map/doors'));
  assert.equal(j.turfs, 1);
  assert.deepEqual(names(j), ['Inside Example', 'Walker Example']);
  assert.deepEqual(j.signs.map((s) => s.address), ['1 Inside St']);

  // The desk is never narrowed.
  assert.deepEqual(names(ok(await mgr.get('/api/map/doors'))), ['Inside Example', 'Outside Example', 'Walker Example']);
});

test('a volunteer given Map & turfs sees every door; back to every door for all', async () => {
  ok(await mgr.action('permission.member.set', { user_id: volId, grant: ['map'], deny: [] }));
  assert.equal(ok(await vol.get('/api/map/doors')).scope, undefined);
  ok(await mgr.action('permission.member.set', { user_id: volId, grant: [], deny: [] }));
  assert.equal(ok(await vol.get('/api/map/doors')).scope, 'turfs');
  ok(await mgr.action('permission.doors.set', { scope: 'all' }));
  assert.deepEqual(names(ok(await vol.get('/api/map/doors'))), ['Inside Example', 'Outside Example', 'Walker Example']);
});
