// The website's way in (ext/intake): keys a manager makes (shown once,
// stored hashed, revocable, stopped when their maker leaves), and POST
// /in/v1/people from the website's server. What a visitor typed is not proof
// of who they are: only the same email fills a person's blanks; a name and
// phone match only gets tags; nobody is put back on the newsletter who left
// it; a message or a volunteer sign-up is a request for the desk; and the
// answer is only an id — never whether someone was on file.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';

const tag = Math.random().toString(36).slice(2, 8);
let mgr, mgr2, staff, db, key, ws, mgr2Id;
const ok = (r, msg) => { assert.equal(r.status, 200, `${msg || ''} ${r.status} ${JSON.stringify(r.json)}`); return r.json; };
const call = async (path, { body, k = key, headers = {}, method } = {}) => {
  const res = await app.request(path, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { ...(k ? { authorization: `Bearer ${k}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const person = async (id) => (await db.query('select name, email, phone, address, city, postal, tags, attrs from persons where id = $1', [id])).rows[0];
const subOf = async (email) => (await db.query('select status, source from subscriptions where workspace_id = $1 and email = $2', [ws, email])).rows[0];

before(async () => {
  db = await freshDb();
  mgr = new Client();
  const r = await mgr.signup({ workspaceName: `Intake ${tag}`, email: `in-mgr+${tag}@example.org`, jurisdiction: 'bc-municipal' });
  ws = r.json.workspace.id;
  const inv = await mgr.action('member.invite', { email: `in-staff+${tag}@example.org`, role: 'staff' });
  staff = new Client();
  await staff.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: 'Sam Example', password: 'intake-pass-1' });
  const inv2 = await mgr.action('member.invite', { email: `in-mgr2+${tag}@example.org`, role: 'manager' });
  mgr2 = new Client();
  mgr2Id = (await mgr2.post('/api/auth/join', { token: inv2.json.joinUrl.split('/join/')[1], name: 'Mo Example', password: 'intake-pass-2' })).json.user.id;
});

test('a manager makes a key: answered once, stored hashed, listed by its first characters', async () => {
  const made = ok(await mgr.action('intake.key.create', { name: 'Website' }));
  key = made.key;
  assert.match(key, /^sbk_[A-Za-z0-9]{40}$/);
  const row = (await db.query('select key_hash, prefix from intake_keys where id = $1', [made.id])).rows[0];
  assert.notEqual(row.key_hash, key, 'the key itself is never stored');
  assert.equal(row.prefix, key.slice(0, 10));
  const list = ok(await mgr.get('/api/intake/keys')).keys;
  assert.equal(list.length, 1);
  assert.ok(!JSON.stringify(list).includes(key), 'the list never carries the key');
  assert.equal((await staff.action('intake.key.create', { name: 'x' })).status, 403);
  assert.equal((await staff.get('/api/intake/keys')).status, 403);
  assert.deepEqual(ok(await call('/in/v1/ping')), { ok: true, campaign: `Intake ${tag}`, key: 'Website' });
  assert.ok(ok(await mgr.get('/api/intake/keys')).keys[0].last_used_at, 'last used is kept');
});

test('refusals: no key, a wrong key, not JSON, nothing to reach them by, a field it doesn’t know', async () => {
  assert.equal((await call('/in/v1/ping', { k: null })).status, 401);
  assert.equal((await call('/in/v1/ping', { k: 'sbk_' + 'x'.repeat(40) })).status, 401);
  assert.equal((await call('/in/v1/people', { body: 'name=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 415);
  const none = await call('/in/v1/people', { body: { name: 'No Contact' } });
  assert.deepEqual([none.status, none.json.error], [400, 'an email or a phone']);
  assert.equal((await call('/in/v1/people', { body: { name: 'Odd', email: 'odd@example.org', rating: '1' } })).status, 400, 'a rating never comes from the website');
  assert.equal((await call('/api/persons', { k: key })).status, 401, 'the key opens /in only, never the app’s API');
});

test('a new person from a petition: created, tagged as sent and with the source, on the newsletter — the answer is only an id', async () => {
  const r = ok(await call('/in/v1/people', { body: {
    first_name: 'Asha', last_name: 'Example', email: 'Asha@Example.org', phone: '604-555-0161',
    address: '13450 104 Ave', city: 'Surrey', postal: 'v3t 1v8', tags: ['Petition: Transit'], newsletter: true, source: 'petition-transit',
  } }));
  assert.deepEqual(Object.keys(r).sort(), ['ok', 'person_id']);
  const p = await person(r.person_id);
  assert.deepEqual([p.name, p.email, p.address, p.postal], ['Asha Example', 'asha@example.org', '13450 104 Ave', 'V3T 1V8']);
  assert.deepEqual([...p.tags].sort(), ['Petition: Transit', 'newsletter', 'petition-transit'].sort());
  assert.deepEqual(await subOf('asha@example.org'), { status: 'subscribed', source: 'petition-transit' });
});

test('on file by email: blanks filled, tags added, nothing overwritten; the answer looks the same as a new person’s', async () => {
  const on = await mgr.createPerson('Ben Example', { email: 'ben@example.org', city: 'Surrey', tags: ['VIP'] });
  const r = await call('/in/v1/people', { body: { name: 'B. Example', email: 'BEN@example.org', phone: '604-555-0162', city: 'Delta', tags: ['volunteer-form'] } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, person_id: on.id });
  const p = await person(on.id);
  assert.deepEqual([p.name, p.phone, p.city], ['Ben Example', '604-555-0162', 'Surrey'], 'the phone was blank; the name and city on file stand');
  assert.deepEqual([...p.tags].sort(), ['VIP', 'volunteer-form', 'website'].sort());
});

test('what a visitor typed never lands on someone else’s record', async () => {
  const vic = await mgr.createPerson('Vic Tim', { phone: '604-555-0170' });
  // Their name and phone, with the visitor's own email: a new person, not Vic.
  const r = ok(await call('/in/v1/people', { body: { name: 'Vic Tim', phone: '604-555-0170', email: 'stranger@example.org', address: '1 Elsewhere Rd' } }));
  assert.notEqual(r.person_id, vic.id);
  const v = await person(vic.id);
  assert.deepEqual([v.email, v.address], [null, null], 'nothing added to Vic');
  // No email: the name and phone match only gets the tags.
  const r2 = ok(await call('/in/v1/people', { body: { name: 'Vic Tim', phone: '(604) 555-0170', address: '2 Elsewhere Rd', tags: ['petition'] } }));
  assert.equal(r2.person_id, vic.id);
  const v2 = await person(vic.id);
  assert.equal(v2.address, null);
  assert.ok(v2.tags.includes('petition'));
  // A message is a request for the desk, never their note.
  ok(await call('/in/v1/people', { body: { name: 'Vic Tim', phone: '604-555-0170', note: 'Please call about the park' } }));
  assert.equal((await person(vic.id)).attrs?.note ?? null, null);
  const req = ok(await mgr.get('/api/requests')).requests.find((x) => x.person.id === vic.id);
  assert.deepEqual([req.kind, req.note], ['other', 'From the website: Please call about the park']);
});

test('nobody is put back on the newsletter who left it or is do-not-email; a volunteer sign-up is a request', async () => {
  ok(await mgr.action('subscription.add', { email: 'cara@example.org', name: 'Cara Example' }));
  const sid = (await db.query('select id from subscriptions where email = $1 and workspace_id = $2', ['cara@example.org', ws])).rows[0].id;
  ok(await mgr.action('subscription.remove', { id: sid }));
  const r = ok(await call('/in/v1/people', { body: { name: 'Cara Example', email: 'cara@example.org', newsletter: true, volunteer: true, note: 'Weekends are best', source: 'volunteer-form' } }));
  assert.equal((await subOf('cara@example.org')).status, 'unsubscribed', 'left the list: stays off it');
  const reqs = ok(await mgr.get('/api/requests')).requests.filter((x) => x.person.id === r.person_id);
  assert.deepEqual(reqs.map((x) => [x.kind, x.note]), [['volunteer', 'From the website (volunteer-form): Weekends are best']]);
  await mgr.createPerson('Dee Example', { email: 'dee@example.org', tags: ['do-not-email'] });
  ok(await call('/in/v1/people', { body: { email: 'dee@example.org', newsletter: true } }));
  assert.equal(await subOf('dee@example.org'), undefined, 'do-not-email: never subscribed from here');
});

test('Idempotency-Key: a retry answers the same, once; a different body with the same key is refused', async () => {
  const body = { name: 'Eli Example', email: 'eli@example.org' };
  const first = ok(await call('/in/v1/people', { body, headers: { 'idempotency-key': 'form-123' } }));
  const second = ok(await call('/in/v1/people', { body, headers: { 'idempotency-key': 'form-123' } }));
  assert.deepEqual([second.person_id, second.replayed], [first.person_id, true]);
  assert.equal((await db.query('select count(*)::int as n from persons where workspace_id = $1 and email = $2', [ws, 'eli@example.org'])).rows[0].n, 1);
  assert.equal((await call('/in/v1/people', { body: { ...body, phone: '1' }, headers: { 'idempotency-key': 'form-123' } })).status, 409);
});

test('a key stops when its maker leaves the campaign, and when revoked; the books verify', async () => {
  const theirs = ok(await mgr2.action('intake.key.create', { name: 'Form service' })).key;
  ok(await call('/in/v1/ping', { k: theirs }));
  ok(await mgr.action('member.remove', { user_id: mgr2Id }));
  assert.equal((await call('/in/v1/ping', { k: theirs })).status, 401, 'their maker left');
  const id = ok(await mgr.get('/api/intake/keys')).keys.find((k) => k.name === 'Website').id;
  ok(await mgr.action('intake.key.revoke', { id }));
  assert.equal((await call('/in/v1/ping')).status, 401);
  assert.equal(ok(await mgr.get('/api/audit/verify')).ok, true);
});
