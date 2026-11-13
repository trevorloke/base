// The field cuts (ext/cuts): People, a saved list and a send's audience by
// when a door was last knocked, the latest outcome, a turf, a postal code
// and the tags someone doesn't have. A value it doesn't understand matches
// nobody.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';

const tag = Math.random().toString(36).slice(2, 8);
let mgr, db, turf;
const P = {};
const lat = 49.1327; const lng = -122.855;
const ok = (r, msg) => { assert.equal(r.status, 200, `${msg || ''} ${JSON.stringify(r.json)}`); return r.json; };
const names = async (qs) => ok(await mgr.get(`/api/persons?${qs}`)).persons.map((p) => p.name).sort();

before(async () => {
  db = await freshDb();
  mgr = new Client();
  await mgr.signup({ workspaceName: `Cuts ${tag}`, email: `cut-mgr+${tag}@example.org`, jurisdiction: 'bc-municipal' });
  P.ana = await mgr.createPerson('Ana Example', { address: '13213 72 Ave', lat, lng, postal: 'V3W 1A1', tags: ['newsletter'] });
  P.ben = await mgr.createPerson('Ben Example', { address: '13225 72 Ave', lat, lng: lng + 0.0003, postal: 'v3w 2b2' });
  P.cy = await mgr.createPerson('Cy Example', { address: '1 Far Rd', lat: 49.3, lng: -122.5, postal: 'V4N 3C3', tags: ['VIP'] });
  P.dee = await mgr.createPerson('Dee Example', { phone: '604-555-0164' });
  turf = ok(await mgr.action('turf.create', {
    name: 'Newton block', polygon: [[lat + 0.001, lng - 0.001], [lat + 0.001, lng + 0.002], [lat - 0.001, lng + 0.002], [lat - 0.001, lng - 0.001]],
  })).turf;
  // Ana knocked today (no answer); Ben knocked 20 days ago (talked); Cy called, never knocked.
  ok(await mgr.action('contact.log', { person_id: P.ana.id, channel: 'door', outcome: 'no_answer' }));
  const ben = ok(await mgr.action('contact.log', { person_id: P.ben.id, channel: 'door', outcome: 'contacted', rating: '2' })).contact;
  await db.query(`update contacts set created_at = now() - interval '20 days' where id = $1`, [ben.id]);
  ok(await mgr.action('contact.log', { person_id: P.cy.id, channel: 'phone', outcome: 'refused' }));
});

test('knocked: never, and not in the last N days', async () => {
  assert.deepEqual(await names('knocked=never'), ['Cy Example', 'Dee Example'], 'a call is not a knock');
  assert.deepEqual(await names('knocked=14'), ['Ben Example', 'Cy Example', 'Dee Example']);
  assert.deepEqual(await names('knocked=30'), ['Cy Example', 'Dee Example']);
  assert.deepEqual(await names('knocked=5'), [], 'a count it doesn’t offer matches nobody');
});

test('outcome: the latest contact, any channel', async () => {
  assert.deepEqual(await names('outcome=no_answer'), ['Ana Example']);
  assert.deepEqual(await names('outcome=refused'), ['Cy Example']);
  assert.deepEqual(await names('outcome=contacted'), ['Ben Example']);
  assert.deepEqual(await names('outcome=nonsense'), []);
});

test('turf, postal code and the tags they don’t have', async () => {
  assert.deepEqual(await names(`turf=${turf.id}`), ['Ana Example', 'Ben Example']);
  assert.deepEqual(await names('turf=0b6c3d8e-1f2a-4c5b-8d9e-0a1b2c3d4e5f'), []);
  assert.deepEqual(await names('postal=v3w'), ['Ana Example', 'Ben Example'], 'case and spaces don’t matter');
  assert.deepEqual(await names('postal=V3W 2B'), ['Ben Example']);
  assert.deepEqual(await names('postal=%25'), []);
  assert.deepEqual(await names('notag=newsletter,VIP'), ['Ben Example', 'Dee Example']);
  assert.deepEqual(await names(`turf=${turf.id}&knocked=14`), ['Ben Example'], 'cuts combine');
});

test('a saved list keeps the cuts, and its audience follows them', async () => {
  const list = ok(await mgr.action('list.create', { name: 'Newton, not knocked in 14 days', kind: 'filter', filter: { turf: turf.id, knocked: '14' } })).list;
  assert.deepEqual(list.filter, { turf: turf.id, knocked: '14' });
  const people = ok(await mgr.get(`/api/lists/${list.id}`)).people.map((p) => p.name);
  assert.deepEqual(people, ['Ben Example']);
});

test('voted=no|yes: who still has to vote (GOTV), and who has', async () => {
  const p1 = await mgr.createPerson('Gotv Pending', { phone: '604-555-0191' });
  const p2 = await mgr.createPerson('Gotv Done', { phone: '604-555-0192' });
  ok(await mgr.action('vote.mark', { person_id: p2.id, source: 'desk' }));
  const no = ok(await mgr.get('/api/persons?q=Gotv&voted=no')).persons.map((x) => x.name);
  const yes = ok(await mgr.get('/api/persons?q=Gotv&voted=yes')).persons.map((x) => x.name);
  assert.deepEqual([no, yes], [['Gotv Pending'], ['Gotv Done']]);
  assert.equal(ok(await mgr.get('/api/persons?q=Gotv&voted=maybe')).persons.length, 0, 'a value it doesn’t know matches nobody');
  void p1;
});

test('moved=open|unknown: Needs an address and Address unknown (ext/moves); a saved list keeps it', async () => {
  const mo = await mgr.createPerson('Mo Mover', { address: '13240 72 Ave', city: 'Surrey', lat, lng });
  ok(await mgr.action('contact.log', { person_id: mo.id, channel: 'door', outcome: 'moved' }));
  assert.deepEqual(await names('moved=open'), ['Mo Mover'], 'tapped Moved, no address yet');
  const m = ok(await mgr.action('person.move', { person_id: mo.id, unknown: true })).move;
  assert.deepEqual(await names('moved=open'), [], 'a move since the tap');
  assert.deepEqual(await names('moved=unknown'), ['Mo Mover']);
  const list = ok(await mgr.action('list.create', { name: 'Address unknown', kind: 'filter', filter: { moved: 'unknown' } })).list;
  assert.deepEqual(list.filter, { moved: 'unknown' });
  assert.deepEqual(ok(await mgr.get(`/api/lists/${list.id}`)).people.map((p) => p.name), ['Mo Mover']);
  ok(await mgr.action('person.unmove', { move_id: m.id }));
  assert.deepEqual(await names('moved=open'), ['Mo Mover'], 'undone: back in the queue');
  assert.deepEqual(await names('moved=unknown'), []);
  ok(await mgr.action('contact.log', { person_id: mo.id, channel: 'door', outcome: 'no_answer' }));
  assert.deepEqual(await names('moved=open'), [], 'a later knock that isn’t Moved takes them out');
  assert.deepEqual(await names('moved=nonsense'), []);
});
