// The website's way in (ext/intake): keys a manager makes (shown once,
// stored hashed, revocable), and POST /in/v1/people from the website's
// server — matched like an import, blanks filled, tags added, never an
// overwrite; newsletter sign-ups (rejoining someone who left); volunteer
// sign-ups as a request for the desk; Idempotency-Key replays; refusals.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';

const tag = Math.random().toString(36).slice(2, 8);
let mgr, staff, db, key, ws;
const ok = (r, msg) => { assert.ok([200, 201].includes(r.status), `${msg || ''} ${r.status} ${JSON.stringify(r.json)}`); return r.json; };
const call = async (path, { body, k = key, headers = {}, method } = {}) => {
  const res = await app.request(path, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { ...(k ? { authorization: `Bearer ${k}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const person = async (id) => (await db.query('select name, email, phone, address, city, postal, tags, attrs from persons where id = $1', [id])).rows[0];

before(async () => {
  db = await freshDb();
  mgr = new Client();
  const r = await mgr.signup({ workspaceName: `Intake ${tag}`, email: `in-mgr+${tag}@example.org`, jurisdiction: 'bc-municipal' });
  ws = r.json.workspace.id;
  const inv = await mgr.action('member.invite', { email: `in-staff+${tag}@example.org`, role: 'staff' });
  staff = new Client();
  await staff.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: 'Sam Example', password: 'intake-pass-1' });
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
  const ping = ok(await call('/in/v1/ping'));
  assert.deepEqual(ping, { ok: true, campaign: `Intake ${tag}`, key: 'Website' });
  assert.ok(ok(await mgr.get('/api/intake/keys')).keys[0].last_used_at, 'last used is kept');
});

test('refusals: no key, a wrong key, not JSON, nothing to reach them by, a field it doesn’t know', async () => {
  assert.equal((await call('/in/v1/ping', { k: null })).status, 401);
  assert.equal((await call('/in/v1/ping', { k: 'sbk_' + 'x'.repeat(40) })).status, 401);
  assert.equal((await call('/in/v1/people', { body: 'name=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 415);
  const none = await call('/in/v1/people', { body: { name: 'No Contact' } });
  assert.deepEqual([none.status, none.json.error], [400, 'an email or a phone']);
  const odd = await call('/in/v1/people', { body: { name: 'Odd', email: 'odd@example.org', rating: '1' } });
  assert.equal(odd.status, 400, 'a rating never comes from the website');
  assert.equal((await call('/api/persons', { k: key })).status, 401, 'the key opens /in only, never the app’s API');
});

test('a new person from a petition: created, tagged with the source, on the newsletter', async () => {
  const r = await call('/in/v1/people', { body: {
    first_name: 'Asha', last_name: 'Example', email: 'Asha@Example.org', phone: '604-555-0161',
    address: '13450 104 Ave', city: 'Surrey', postal: 'v3t 1v8', tags: ['Petition: Transit'], newsletter: true, source: 'petition-transit',
  } });
  assert.equal(r.status, 201);
  assert.deepEqual([r.json.created, r.json.newsletter, r.json.volunteer], [true, 'subscribed', null]);
  const p = await person(r.json.person_id);
  assert.deepEqual([p.name, p.email, p.address, p.postal], ['Asha Example', 'asha@example.org', '13450 104 Ave', 'V3T 1V8']);
  assert.deepEqual([...p.tags].sort(), ['Petition: Transit', 'newsletter', 'petition-transit'].sort(), 'tags as sent; the source as a word');
  const sub = (await db.query('select status, source from subscriptions where workspace_id = $1 and email = $2', [ws, 'asha@example.org'])).rows[0];
  assert.deepEqual(sub, { status: 'subscribed', source: 'petition-transit' });
});

test('someone on file: matched, blanks filled, tags added — nothing overwritten', async () => {
  const on = await mgr.createPerson('Ben Example', { phone: '604-555-0162', city: 'Surrey', tags: ['VIP'] });
  const r = ok(await call('/in/v1/people', { body: { name: 'ben example', phone: '(604) 555-0162', email: 'ben@example.org', city: 'Delta', tags: ['volunteer-form'] } }));
  assert.equal(r.person_id, on.id, 'matched by name and phone');
  assert.deepEqual(r.merged.sort(), ['email', 'tags']);
  const p = await person(on.id);
  assert.deepEqual([p.name, p.email, p.city], ['Ben Example', 'ben@example.org', 'Surrey'], 'the city on file stands');
  assert.deepEqual([...p.tags].sort(), ['VIP', 'volunteer-form', 'website'].sort());
  const again = ok(await call('/in/v1/people', { body: { name: 'Ben E', email: 'BEN@example.org' } }));
  assert.equal(again.person_id, on.id, 'matched by email whatever the name');
});

test('a volunteer sign-up is a request under Needs you; a newsletter sign-up rejoins someone who left', async () => {
  ok(await mgr.action('subscription.add', { email: 'cara@example.org', name: 'Cara Example' }));
  const sid = (await db.query('select id from subscriptions where email = $1 and workspace_id = $2', ['cara@example.org', ws])).rows[0].id;
  ok(await mgr.action('subscription.remove', { id: sid }));
  const r = ok(await call('/in/v1/people', { body: { name: 'Cara Example', email: 'cara@example.org', newsletter: true, volunteer: true, note: 'Weekends are best', source: 'volunteer-form' } }));
  assert.deepEqual([r.newsletter, r.volunteer], ['rejoined', 'requested']);
  assert.equal((await db.query('select status from subscriptions where id = $1', [sid])).rows[0].status, 'subscribed');
  const reqs = ok(await mgr.get('/api/requests')).requests.filter((x) => x.person.id === r.person_id);
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].kind, 'volunteer');
  assert.equal(reqs[0].note, 'Signed up on the website (volunteer-form): Weekends are best');
  assert.equal(ok(await call('/in/v1/people', { body: { email: 'cara@example.org', newsletter: true } })).newsletter, 'already');
  // A message with nowhere else to go becomes their note, once.
  const d = ok(await call('/in/v1/people', { body: { name: 'Dee Example', email: 'dee@example.org', note: 'Please call about the park' } }));
  assert.equal((await person(d.person_id)).attrs.note, 'Please call about the park');
});

test('Idempotency-Key: a retry answers the same, once; a different body with the same key is refused', async () => {
  const body = { name: 'Eli Example', email: 'eli@example.org' };
  const first = await call('/in/v1/people', { body, headers: { 'idempotency-key': 'form-123' } });
  assert.equal(first.status, 201);
  const second = ok(await call('/in/v1/people', { body, headers: { 'idempotency-key': 'form-123' } }));
  assert.deepEqual([second.person_id, second.replayed], [first.json.person_id, true]);
  assert.equal((await db.query('select count(*)::int as n from persons where workspace_id = $1 and email = $2', [ws, 'eli@example.org'])).rows[0].n, 1);
  assert.equal((await call('/in/v1/people', { body: { ...body, phone: '1' }, headers: { 'idempotency-key': 'form-123' } })).status, 409);
});

test('a revoked key stops at once; the books verify', async () => {
  const id = ok(await mgr.get('/api/intake/keys')).keys[0].id;
  ok(await mgr.action('intake.key.revoke', { id }));
  assert.equal((await call('/in/v1/ping')).status, 401);
  assert.equal(ok(await mgr.get('/api/audit/verify')).ok, true);
});
