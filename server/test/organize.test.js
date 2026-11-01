// Turfs + walk lists, and offline-safe contact logging.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { getDb } from '../db/client.js';

let mgr, ws;

before(async () => {
  await freshDb();
  mgr = new Client();
  const r = await mgr.signup({ workspaceName: 'Imagine Surrey', jurisdiction: 'bc-municipal' });
  ws = r.json.workspace.id;
});

// ── Turfs ──
test('turf: draw, stats, walk list in odd-up / even-back order, assignment scopes volunteers', async () => {
  const lat = 49.1327; const lng = -122.855;
  const mk = (name, address, dLng) => mgr.createPerson(name, { address, lat, lng: lng + dLng });
  const a = await mk('A One', '13213 72 Ave', 0.0000);
  await mk('B Two', '13225 72 Ave', 0.0003);
  await mk('C Three', '13224 72 Ave', 0.0003);
  await mk('D Four', '13212 72 Ave', 0.0000);
  await mgr.createPerson('Far Away', { address: '1 Other Rd', lat: 49.3, lng: -122.5 });
  const t = await mgr.action('turf.create', {
    name: 'Newton block', polygon: [[lat + 0.001, lng - 0.001], [lat + 0.001, lng + 0.002], [lat - 0.001, lng + 0.002], [lat - 0.001, lng - 0.001]],
  });
  assert.equal(t.status, 200);
  await mgr.action('contact.log', { person_id: a.id, channel: 'door', outcome: 'contacted', rating: '1' });
  const list = (await mgr.get('/api/turfs')).json.turfs;
  const turf = list.find((x) => x.id === t.json.turf.id);
  assert.equal(turf.doors, 4, 'far-away person excluded');
  assert.equal(turf.doorsDone, 1);
  const walk = await mgr.get(`/api/turfs/${turf.id}/walk`);
  assert.deepEqual(walk.json.doors.map((d) => d.address), ['13213 72 Ave', '13225 72 Ave', '13224 72 Ave', '13212 72 Ave'],
    'odd side up, even side back');
  assert.equal(walk.json.doors[0].done, true);
  const bad = await mgr.action('turf.create', { name: 'x', polygon: [[1, 2], [3, 4]] });
  assert.equal(bad.status, 400, 'a turf needs at least 3 points');

  // Volunteer: sees only assigned turfs; walk list of an unassigned turf is refused.
  const inv = await mgr.action('member.invite', { email: 'walker@example.org', role: 'volunteer' });
  const vol = new Client();
  await vol.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: 'Walker', password: 'walker-pass-1' });
  assert.equal((await vol.get('/api/turfs')).json.turfs.length, 0);
  assert.equal((await vol.get(`/api/turfs/${turf.id}/walk`)).status, 403);
  const members = (await mgr.get('/api/members')).json.members;
  const walker = members.find((m) => m.name === 'Walker');
  assert.equal((await mgr.action('turf.assign', { turf_id: turf.id, user_id: walker.id })).status, 200);
  assert.equal((await vol.get('/api/turfs')).json.turfs.length, 1);
  assert.equal((await vol.get(`/api/turfs/${turf.id}/walk`)).status, 200);
  const brief = (await vol.get('/api/brief')).json;
  assert.equal(brief.myTurfs[0].name, 'Newton block');
  assert.equal((await vol.action('turf.create', { name: 'v', polygon: [[0, 0], [0, 1], [1, 1]] })).status, 403);
  assert.equal((await vol.get('/api/members')).status, 403);
});

// ── Offline-safe knocks ──
test('a knock replayed with the same client_id is recorded once', async () => {
  const p = await mgr.createPerson('Offline Knock');
  const client_id = '0b6c3d8e-1f2a-4c5b-8d9e-0a1b2c3d4e5f';
  const first = await mgr.action('contact.log', { person_id: p.id, channel: 'door', outcome: 'contacted', rating: '2', client_id });
  const replay = await mgr.action('contact.log', { person_id: p.id, channel: 'door', outcome: 'contacted', rating: '2', client_id });
  assert.equal(first.status, 200);
  assert.equal(replay.status, 200);
  assert.equal(replay.json.duplicate, true);
  const prof = (await mgr.get(`/api/persons/${p.id}`)).json;
  assert.equal(prof.contacts.length, 1);
  const db = await getDb();
  const n = (await db.query(`select count(*)::int as n from events where workspace_id = $1 and entity_type = 'contact' and payload->>'client_id' = $2`, [ws, client_id])).rows[0].n;
  assert.equal(n, 1, 'one event for one knock');
});
