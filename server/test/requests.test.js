// Ask the office: requests from the doors (server/ext/requests). A volunteer
// at a door asks the office about someone — once, however often the phone
// replays it; the desk reads the open ones (who asked, the person's phone
// and address) and marks them done, with a note, or reopens them. Volunteers
// can't read the desk's list or count, can't mark anything done, and a
// person's requests reach them as the kind and when only — never what was
// said, who asked, or what the office did. The export carries the table and
// the chain still verifies.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';

const tag = Math.random().toString(36).slice(2, 8);
let db; let mgr; let vol; let dev; let ana;

const events = async () => (await mgr.get('/api/events?since=0&limit=1000')).json.events
  .filter((e) => e.entity_type === 'door_request');

before(async () => {
  db = await freshDb();
  mgr = new Client();
  assert.equal((await mgr.signup({ name: 'Priya Example', workspaceName: 'Requests Field', email: `req.mgr+${tag}@example.org` })).status, 201);
  const inv = await mgr.action('member.invite', { email: `req.vol+${tag}@example.org`, role: 'volunteer' });
  vol = new Client();
  const j = await vol.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: 'Jas Example', password: 'knock-knock-2026' });
  assert.equal(j.status, 200, JSON.stringify(j.json));
  dev = await mgr.createPerson('Dev Example', { phone: '604-555-0131', address: '7231 132 St', unit: '4' });
  ana = await mgr.createPerson('Ana Example', { phone: '604-555-0132', address: '7235 132 St' });
});

const CID = '3f0b6a4e-8c1d-4f2a-9b7e-0d5c6a1e2f30';

test('a volunteer asks the office about someone: once, however often it is replayed', async () => {
  const r = await vol.action('request.ask', { person_id: dev.id, kind: 'volunteer', note: '  free Saturdays, call after 6 ', client_id: CID });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.request.kind, 'volunteer');
  assert.equal(r.json.request.note, 'free Saturdays, call after 6', 'trimmed');
  assert.equal(r.json.duplicate, undefined);

  const again = await vol.action('request.ask', { person_id: dev.id, kind: 'volunteer', note: 'free Saturdays, call after 6', client_id: CID });
  assert.equal(again.status, 200);
  assert.equal(again.json.duplicate, true);
  assert.equal(again.json.request.id, r.json.request.id);

  const all = (await mgr.get('/api/requests?open=all')).json.requests;
  assert.equal(all.length, 1, 'one row');
  const evs = await events();
  assert.equal(evs.length, 1, 'one event');
  assert.equal(evs[0].action, 'request.ask');
  assert.equal(evs[0].op, 'create');
  assert.equal(evs[0].payload.client_id, CID);

  // Refusals: a kind outside the four, a note over 500, someone not on the list.
  assert.equal((await vol.action('request.ask', { person_id: dev.id, kind: 'donate' })).status, 400);
  assert.equal((await vol.action('request.ask', { person_id: dev.id, kind: 'question', note: 'x'.repeat(501) })).status, 400);
  assert.equal((await vol.action('request.ask', { person_id: dev.id, kind: 'question', note: 'x'.repeat(500) })).status, 200, '500 is fine');
  const missing = await vol.action('request.ask', { person_id: '00000000-0000-4000-8000-000000000000', kind: 'other' });
  assert.equal(missing.status, 404);
  assert.match(missing.json.error, /^person not found/);
  // A second request about the same person, with no note, from the desk.
  assert.equal((await mgr.action('request.ask', { person_id: ana.id, kind: 'call_back' })).status, 200);
});

test('the desk reads the open ones and marks them done; volunteers can do neither', async () => {
  assert.equal((await vol.get('/api/requests')).status, 403);
  assert.equal((await vol.get('/api/requests?open=all')).status, 403);
  assert.equal((await vol.get('/api/requests/count')).status, 403);

  assert.deepEqual((await mgr.get('/api/requests/count')).json, { open: 3 });
  const open = (await mgr.get('/api/requests')).json.requests;
  assert.equal(open.length, 3);
  assert.equal(open[0].person.name, 'Ana Example', 'newest first');
  const ask = open.find((r) => r.kind === 'volunteer');
  assert.equal(ask.asked_by_name, 'Jas Example');
  assert.equal(ask.note, 'free Saturdays, call after 6');
  assert.equal(ask.person.phone, '604-555-0131');
  assert.equal(ask.person.address, '7231 132 St');
  assert.equal(ask.person.unit, '4');
  assert.equal(ask.done_at, null);
  assert.equal(open[0].asked_by_name, 'Priya Example');

  // A volunteer can't mark it done.
  assert.equal((await vol.action('request.done', { id: ask.id })).status, 403);
  assert.equal((await vol.action('request.reopen', { id: ask.id })).status, 403);

  const done = await mgr.action('request.done', { id: ask.id, note: ' booked on the Saturday canvass ' });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.ok(done.json.request.done_at);
  assert.equal(done.json.request.done_note, 'booked on the Saturday canvass');
  assert.ok(!(await mgr.get('/api/requests?open=1')).json.requests.some((r) => r.id === ask.id), 'gone from the open list');
  assert.deepEqual((await mgr.get('/api/requests/count')).json, { open: 2 });
  const listed = (await mgr.get('/api/requests?open=all')).json.requests.find((r) => r.id === ask.id);
  assert.ok(listed.done_at);
  assert.equal(listed.done_by_name, 'Priya Example');
  assert.equal(listed.done_note, 'booked on the Saturday canvass');

  const twice = await mgr.action('request.done', { id: ask.id });
  assert.equal(twice.status, 409);
  assert.equal(twice.json.error, 'already done');
  assert.equal((await mgr.action('request.done', { id: '00000000-0000-4000-8000-000000000000' })).status, 404);

  const back = await mgr.action('request.reopen', { id: ask.id });
  assert.equal(back.status, 200);
  assert.equal(back.json.request.done_at, null);
  assert.equal(back.json.request.done_note, null);
  const reopened = (await mgr.get('/api/requests')).json.requests.find((r) => r.id === ask.id);
  assert.ok(reopened, 'open again');
  assert.equal(reopened.done_by_name, null);
  const evs = (await events()).filter((e) => e.entity_id === ask.id);
  assert.deepEqual(evs.map((e) => `${e.action}:${e.op}`), ['request.ask:create', 'request.done:update', 'request.reopen:update']);
  assert.equal(evs[2].payload.reopened, true);
  // Reopening one that is open changes nothing and logs nothing.
  assert.equal((await mgr.action('request.reopen', { id: ask.id })).status, 200);
  assert.equal((await events()).filter((e) => e.entity_id === ask.id).length, 3);

  // Done again, for the next test.
  assert.equal((await mgr.action('request.done', { id: ask.id, note: 'called back' })).status, 200);
  // The phone replays its ask after the office dealt with it: the volunteer
  // hears it's done, never what the office did.
  const replay = await vol.action('request.ask', { person_id: dev.id, kind: 'volunteer', client_id: CID });
  assert.equal(replay.json.duplicate, true);
  assert.deepEqual(Object.keys(replay.json.request).sort(), ['created_at', 'done', 'id', 'kind', 'note', 'person_id']);
  assert.equal(replay.json.request.done, true);
  assert.equal(replay.json.request.note, 'free Saturdays, call after 6', 'their own words');
  assert.ok(!JSON.stringify(replay.json).includes('called back'));
  // Someone else's request, replayed by a volunteer (its key found somehow): no note at all.
  const deskCid = 'b7c1d2e3-f4a5-4b6c-8d7e-9f0a1b2c3d4e';
  assert.equal((await mgr.action('request.ask', { person_id: ana.id, kind: 'question', note: 'office only words', client_id: deskCid })).status, 200);
  const theirs = await vol.action('request.ask', { person_id: ana.id, kind: 'question', client_id: deskCid });
  assert.equal(theirs.json.duplicate, true);
  assert.ok(!JSON.stringify(theirs.json).includes('office only words'));
  assert.ok(!('asked_by' in theirs.json.request));
});

test('a person’s requests: the kind and when for a volunteer, everything for the desk', async () => {
  const v = await vol.get(`/api/persons/${dev.id}/requests`);
  assert.equal(v.status, 200);
  assert.equal(v.json.requests.length, 2);
  for (const r of v.json.requests) assert.deepEqual(Object.keys(r).sort(), ['created_at', 'done', 'id', 'kind']);
  assert.deepEqual(v.json.requests.map((r) => r.done).sort(), [false, true]);
  const raw = JSON.stringify(v.json);
  for (const word of ['free Saturdays', 'called back', 'Jas Example', 'Priya Example', 'xxxxx']) assert.ok(!raw.includes(word), `no "${word}" for a volunteer`);

  const d = (await mgr.get(`/api/persons/${dev.id}/requests`)).json.requests;
  assert.equal(d.length, 2);
  const done = d.find((r) => r.done_at);
  assert.equal(done.note, 'free Saturdays, call after 6');
  assert.equal(done.asked_by_name, 'Jas Example');
  assert.equal(done.done_by_name, 'Priya Example');
  assert.equal(done.done_note, 'called back');

  assert.equal((await vol.get('/api/persons/not-an-id/requests')).status, 404);
  assert.equal((await vol.get('/api/persons/00000000-0000-4000-8000-000000000000/requests')).status, 404);
});

test('someone taken off the list drops out of the desk’s list and count', async () => {
  const gone = await mgr.createPerson('Gone Example', { phone: '604-555-0133' });
  assert.equal((await vol.action('request.ask', { person_id: gone.id, kind: 'question' })).status, 200);
  const before = (await mgr.get('/api/requests/count')).json.open;
  // Taken off the list (the way the sample clears a person who keeps a gift).
  await db.query('update persons set deleted_at = now() where id = $1', [gone.id]);
  assert.equal((await mgr.get('/api/requests/count')).json.open, before - 1);
  assert.ok(!(await mgr.get('/api/requests?open=all')).json.requests.some((r) => r.person.id === gone.id));
  assert.equal((await vol.action('request.ask', { person_id: gone.id, kind: 'question' })).status, 404);
});

test('the export carries door_requests; the chain verifies', async () => {
  assert.equal((await vol.get('/api/export')).status, 403);
  const ex = (await mgr.get('/api/export')).json;
  assert.ok(Array.isArray(ex.door_requests));
  assert.ok(ex.door_requests.some((r) => r.client_id === CID && r.person_id === dev.id));
  assert.equal((await mgr.get('/api/audit/verify')).json.ok, true);
});
