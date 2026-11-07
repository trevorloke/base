// Stewardship (ext/stewardship): every gift thanked; lapsed donors and next
// steps; the desk only.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';

let mgr, vol, db;
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
const yr = new Date().getFullYear();
const P = {};

before(async () => {
  db = await freshDb();
  mgr = new Client();
  await mgr.signup({ workspaceName: 'Stewards', jurisdiction: 'bc-municipal' });
  const inv = await mgr.action('member.invite', { email: 'vol@example.org', role: 'volunteer' });
  vol = new Client();
  ok(await vol.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: 'Vic', password: 'steward-pass-1' }));
  P.ana = ok(await mgr.action('person.create', { kind: 'person', first_name: 'Ana', last_name: 'Example', address: '16068 83 Ave', unit: '204', city: 'Surrey', postal: 'v4n0n2', phone: '604-555-0101' })).person;
  P.ben = ok(await mgr.action('person.create', { kind: 'person', first_name: 'Ben', last_name: 'Example', email: 'ben@example.org' })).person; // no address
  P.cy = ok(await mgr.action('person.create', { kind: 'person', first_name: 'Cy', last_name: 'Lapsed', address: '9 Oak Ave', city: 'Surrey', postal: 'V3T 1V8' })).person;
  P.dee = ok(await mgr.action('person.create', { kind: 'person', first_name: 'Dee', last_name: 'Nomail', address: '1 Main St', city: 'Surrey', tags: ['do-not-mail'] })).person;
  P.g1 = ok(await mgr.action('gift.log', { person_id: P.ana.id, amount_cents: 25000, date: `${yr}-03-01`, method: 'cheque' })).gift;
  P.g2 = ok(await mgr.action('gift.log', { person_id: P.ben.id, amount_cents: 5000, date: `${yr}-04-01`, method: 'cash' })).gift;
  P.g3 = ok(await mgr.action('gift.log', { person_id: P.cy.id, amount_cents: 10000, date: `${yr - 1}-06-01`, method: 'cheque' })).gift;
});

test('to thank, lapsed, top donors; thank a gift by a call; a next step', async () => {
  let s = ok(await mgr.get('/api/stewardship'));
  assert.deepEqual(s.to_thank.map((g) => g.name).sort(), ['Ana Example', 'Ben Example', 'Cy Lapsed']);
  assert.deepEqual(s.lapsed.map((d) => [d.name, d.last_year_cents]), [['Cy Lapsed', 10000]]);
  assert.equal(s.top[0].name, 'Ana Example');
  ok(await mgr.action('gift.thank', { gift_id: P.g2.id, how: 'call', note: 'Left a voicemail too' }));
  ok(await mgr.action('donor.step', { person_id: P.cy.id, step: 'Coffee after the debate', due_on: `${yr}-01-01` }));
  s = ok(await mgr.get('/api/stewardship'));
  assert.ok(!s.to_thank.some((g) => g.gift_id === P.g2.id), 'thanked: off the list');
  assert.deepEqual(s.steps.map((x) => [x.name, x.step, x.due]), [['Cy Lapsed', 'Coffee after the debate', true]]);
  assert.equal((await vol.get('/api/stewardship')).status, 403);
  assert.equal((await vol.action('gift.thank', { gift_id: P.g1.id, how: 'call' })).status, 403);
  ok(await mgr.action('gift.unthank', { gift_id: P.g2.id }));
  assert.ok(ok(await mgr.get('/api/stewardship')).to_thank.some((g) => g.gift_id === P.g2.id), 'taken back: on the list again');
  ok(await mgr.action('gift.thank', { gift_id: P.g2.id, how: 'email' }));
});

test('the record still checks out', async () => {
  assert.equal(ok(await mgr.get('/api/audit/verify')).ok, true);
});
