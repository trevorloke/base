// Stewardship (ext/stewardship) and mailouts (ext/mailouts): every gift
// thanked; lapsed donors and next steps; letters, postcards and labels to a
// list or to the donors to thank — the list made ready (only people who can
// be mailed), printed, and in the mail, which thanks the gifts.
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

test('a thank-you letter: only donors with an address; printed with their gift; mailed → their gifts thanked by letter', async () => {
  const m = ok(await mgr.action('mailout.save', {
    name: 'Thank-you letters', kind: 'letter', audience: { thanks: true },
    body: 'Dear {{first_name}},\n\nThank you for your gift of {{amount}} on {{gift_date}}.\n\n— {{campaign}}',
    return_address: 'Stewards\n100 Campaign Way\nSurrey BC  V3T 0A1',
  })).mailout;
  const preview = ok(await mgr.get(`/api/mailouts/${m.id}`)).preview;
  assert.deepEqual([preview.recipients, preview.left_out], [2, 0], 'Ana and Cy (Ben was thanked)');
  const ready = ok(await mgr.action('mailout.ready', { id: m.id }));
  assert.deepEqual([ready.recipients, ready.left_out], [2, 0]);
  const d = ok(await mgr.get(`/api/mailouts/${m.id}`));
  const ana = d.recipients.find((r) => r.name === 'Ana Example');
  assert.deepEqual([ana.line1, ana.city, ana.province, ana.postal, ana.amount_cents], ['204-16068 83 Ave', 'Surrey', 'BC', 'V4N 0N2', 25000]);
  const print = async (what) => { const r = await app.request(`/api/mailouts/${m.id}/print?what=${what}`, { headers: { cookie: mgr.cookie } }); return { status: r.status, html: await r.text() }; };
  const letters = await print('letters');
  assert.equal(letters.status, 200);
  assert.match(letters.html, /Dear Ana,/);
  assert.match(letters.html, /\$250\.00/);
  assert.match(letters.html, /204-16068 83 AVE/);
  assert.match(letters.html, /SURREY BC&nbsp; V4N 0N2/, 'two spaces before the postal code');
  assert.match(letters.html, new RegExp(`on March 1, ${yr}\\.`), 'the gift date, written out');
  assert.doesNotMatch(letters.html, /Invalid Date/);
  assert.match(letters.html, /100 Campaign Way/);
  assert.equal((letters.html.match(/class="sheet"/g) || []).length, 2, 'one page each');
  for (const w of ['envelopes', 'postcards', 'labels-5160', 'labels-5163', 'return-5167']) assert.equal((await print(w)).status, 200, w);
  assert.equal((await print('labels-5160')).html.match(/class="lab"/g).length, 2);
  assert.equal((await print('return-5167')).html.match(/class="lab"/g).length, 80, 'a full sheet of return labels');
  assert.equal((await app.request(`/api/mailouts/${m.id}/print?what=letters`, { headers: { cookie: vol.cookie } })).status, 403);
  const mailed = ok(await mgr.action('mailout.mailed', { id: m.id }));
  assert.equal(mailed.thanked, 2);
  const t = (await db.query('select how from gift_thanks where gift_id = any($1::uuid[]) order by how', [[P.g1.id, P.g3.id]])).rows.map((r) => r.how);
  assert.deepEqual(t, ['letter', 'letter']);
  assert.equal(ok(await mgr.get('/api/stewardship')).to_thank.length, 0, 'everyone thanked');
  assert.equal((await mgr.action('mailout.delete', { id: m.id })).status, 409, 'in the mail: it stays on the record');
});

test('a postcard to a list: do-not-mail and no-address left out and counted; a change of list makes it ready again', async () => {
  const list = ok(await mgr.action('list.create', { name: 'Everyone', kind: 'people', person_ids: [P.ana.id, P.ben.id, P.cy.id, P.dee.id] })).list;
  const m = ok(await mgr.action('mailout.save', { name: 'Rally card', kind: 'postcard', audience: { list_id: list.id }, body: 'Hi {{first_name}} — rally Saturday!' })).mailout;
  const r = ok(await mgr.action('mailout.ready', { id: m.id }));
  assert.deepEqual([r.recipients, r.left_out], [2, 2], 'Ana and Cy; Ben (no address) and Dee (do-not-mail) left out');
  const other = ok(await mgr.action('list.create', { name: 'Just Ana', kind: 'people', person_ids: [P.ana.id] })).list;
  ok(await mgr.action('mailout.save', { id: m.id, name: 'Rally card', kind: 'postcard', audience: { list_id: other.id }, body: 'x' }));
  assert.equal(ok(await mgr.get(`/api/mailouts/${m.id}`)).mailout.status, 'draft', 'a new list: ready again first');
  assert.equal((await mgr.action('mailout.mailed', { id: m.id })).status, 409);
  ok(await mgr.action('mailout.delete', { id: m.id }));
  assert.ok(!ok(await mgr.get('/api/mailouts')).mailouts.some((x) => x.id === m.id));
  assert.equal(ok(await mgr.get('/api/mailouts')).mail_from, 'Stewards\n100 Campaign Way\nSurrey BC  V3T 0A1', 'the return address is remembered');
  assert.equal(ok(await mgr.get('/api/audit/verify')).ok, true);
});
