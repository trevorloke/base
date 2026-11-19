// Setup: open only with a long setup code and no operator (or a changed
// code: break-glass); limited per address, across addresses and per code;
// finished once, under a lock, against the code that is current.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshApp, browser, setUp, SETUP_CODE, baseEnv, keyFromPage } from './helpers.mjs';
import { totp, base32Decode } from '../../../server/lib/twostep.js';

const fresh = async () => { baseEnv(); return freshApp(); };

test('open with no operator; closed with a short code, with the line', async () => {
  const { app } = await fresh();
  const b = browser(app);
  const open = await b.get('/setup');
  assert.equal(open.status, 200);
  const body = await open.text();
  assert.match(body, /Set up the control centre/);
  assert.match(body, /Render → base-platform → Environment → OPS_SETUP_CODE\./);
  assert.match(await (await b.get('/signin')).text(), /href="\/setup"/, 'sign-in offers Set up while it is open');
  process.env.OPS_SETUP_CODE = 'short-code-0123456789';
  const closed = await b.get('/setup');
  assert.match(await closed.text(), /The setup code in Render is too short\. Press Generate next to OPS_SETUP_CODE, then Save and deploy\./);
  assert.doesNotMatch(await (await b.get('/signin')).text(), /href="\/setup"/);
  assert.equal((await b.post('/setup', { code: 'short-code-0123456789' })).status, 503);
  baseEnv();
});

test('a wrong code is refused; 11 tries from one address are limited', async () => {
  const { app } = await fresh();
  const b = browser(app, { ip: '198.51.100.7' });
  const res = await b.post('/setup', { code: 'not-the-code' });
  assert.equal(res.status, 401);
  assert.match(await res.text(), /That isn’t the setup code\./);
  for (let i = 0; i < 9; i++) await b.post('/setup', { code: 'nope' });
  const eleventh = await b.post('/setup', { code: SETUP_CODE });
  assert.equal(eleventh.status, 429);
  assert.match(await eleventh.text(), /Too many tries — wait 15 minutes\./);
  assert.equal((await browser(app, { ip: '198.51.100.8' }).post('/setup', { code: SETUP_CODE })).status, 303, 'another address still can');
});

test('30 wrong tries in all for one code: no more guesses, even from new addresses — but the right code still goes through', async () => {
  const { app } = await fresh();
  for (let i = 0; i < 30; i++) await browser(app, { ip: `192.0.2.${i + 1}` }).post('/setup', { code: 'wrong' });
  const res = await browser(app, { ip: '192.0.2.200' }).post('/setup', { code: 'still wrong' });
  assert.equal(res.status, 429);
  assert.match(await res.text(), /Too many tries with this code\. Press Generate next to OPS_SETUP_CODE in Render for a new one\./);
  // A stranger spending the code's tries and the hourly limit can't keep the owner out.
  const ob = browser(app, { ip: '192.0.2.201' });
  const owner = await ob.post('/setup', { code: SETUP_CODE });
  assert.equal(owner.status, 303);
  assert.equal(owner.headers.get('location'), '/setup/you');
  const next = await ob.post('/setup/you', { name: 'Olive Example', email: 'owner@example.org', password: 'a long test password 1' });
  assert.equal(next.headers.get('location'), '/setup/app', 'and on through the next step');
  process.env.OPS_SETUP_CODE = `${SETUP_CODE}-new`;
  // The global limit (30 an hour) still holds this hour; the per-code count is new.
  const { db } = await fresh();
  assert.equal(Number((await db.query('select count(*)::int n from setup_tries')).rows[0].n), 0);
  baseEnv();
});

test('the right code through to the recovery codes: one operator, 10 recovery hashes, the key sealed; then closed', async () => {
  const { app, db } = await fresh();
  const b = browser(app);
  const first = await b.post('/setup', { code: SETUP_CODE });
  const cookie = first.headers.getSetCookie().find((l) => l.startsWith('ops-setup='));
  assert.match(cookie, /Max-Age=600\b/, 'the setup cookie lasts 10 minutes');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.equal(first.headers.get('location'), '/setup/you');
  assert.match(await (await b.get('/setup/you')).text(), /such as you\+support@…/);
  await b.post('/setup/you', { name: 'Olive Example', email: 'Owner@Example.org', password: 'a long test password 1' });
  const appPage = await (await b.get('/setup/app')).text();
  assert.match(appPage, /href="otpauth:\/\/totp\/[^"]+"/, 'the link for an app on this phone');
  assert.match(appPage, /Add to an authenticator app on this phone/);
  assert.match(appPage, /Google Authenticator, Microsoft Authenticator or 1Password all work\./);
  const secret = keyFromPage(appPage);
  assert.equal((await b.post('/setup/app', { code: '000000' })).status, 401);
  const done = await b.post('/setup/app', { code: totp(base32Decode(secret), Date.now()) });
  assert.equal(done.headers.get('location'), '/setup/codes');
  const codes = await (await b.get('/setup/codes')).text();
  assert.equal([...codes.matchAll(/<li>[a-z0-9]{5}-[a-z0-9]{5}<\/li>/g)].length, 10);
  assert.match(codes, /I’ve saved them/);
  assert.equal((await b.get('/setup/codes')).status, 303, 'shown once');
  const ops = (await db.query('select * from operators')).rows;
  assert.equal(ops.length, 1);
  assert.equal(ops[0].email, 'owner@example.org');
  assert.equal(ops[0].recovery.length, 10);
  assert.ok(ops[0].recovery.every((h) => /^[0-9a-f]{64}$/.test(h)));
  assert.match(ops[0].password_hash, /^scrypt:/);
  // The authenticator key is in no column, in any form.
  const all = JSON.stringify((await db.query('select * from operators')).rows) + JSON.stringify((await db.query('select * from operator_setup')).rows);
  assert.ok(!all.includes(secret));
  assert.ok(!all.toLowerCase().includes(secret.toLowerCase()));
  assert.equal((await db.query('select count(*)::int n from operator_setup')).rows[0].n, 0);
  // Closed now.
  assert.equal((await browser(app).get('/setup')).headers.get('location'), '/signin');
  assert.equal((await browser(app).post('/setup', { code: SETUP_CODE })).status, 303);
  assert.equal((await browser(app).post('/setup', { code: SETUP_CODE })).headers.get('location'), '/signin');
  const log = (await db.query('select action, payload from ops_log order by seq')).rows;
  assert.deepEqual(log[0], { action: 'setup', payload: { reopened: false } });
});

const startTo = async (app) => {
  const b = browser(app);
  await b.post('/setup', { code: process.env.OPS_SETUP_CODE });
  await b.post('/setup/you', { name: 'Olive Example', email: 'owner@example.org', password: 'a long test password 1' });
  const secret = keyFromPage(await (await b.get('/setup/app')).text());
  return { b, secret };
};

test('two tickets: the second finishing after the first is refused; one operator, no replacement', async () => {
  const { app, db } = await fresh();
  const one = await startTo(app);
  const two = await startTo(app);
  assert.equal((await one.b.post('/setup/app', { code: totp(base32Decode(one.secret), Date.now()) })).status, 303);
  const before = (await db.query('select * from operators')).rows[0];
  const late = await two.b.post('/setup/app', { code: totp(base32Decode(two.secret), Date.now()) });
  assert.equal(late.headers.get('location'), '/signin', 'setup is closed: refused');
  assert.equal(late.headers.getSetCookie().some((l) => l.startsWith('ops=')), false, 'no session');
  const after = (await db.query('select * from operators')).rows;
  assert.equal(after.length, 1);
  assert.equal(after[0].totp_sealed, before.totp_sealed);
  assert.equal(after[0].password_hash, before.password_hash);
});

test('a ticket made under the old code, finished after the code changed, is refused', async () => {
  const { app, db } = await fresh();
  const one = await startTo(app);
  process.env.OPS_SETUP_CODE = `${SETUP_CODE}-changed`;
  const res = await one.b.post('/setup/app', { code: totp(base32Decode(one.secret), Date.now()) });
  assert.equal(res.status, 409);
  assert.equal((await db.query('select count(*)::int n from operators')).rows[0].n, 0);
  baseEnv();
});

test('changing OPS_SETUP_CODE reopens setup: the same id, every session ended, logged reopened', async () => {
  const { app, db } = await fresh();
  const first = await setUp(app, db);
  const id = (await db.query('select id from operators')).rows[0].id;
  assert.equal((await first.b.get('/')).status, 200);
  process.env.OPS_SETUP_CODE = `${SETUP_CODE}-generated-again`;
  const b = browser(app);
  assert.equal((await b.get('/setup')).status, 200, 'open again');
  await b.post('/setup', { code: process.env.OPS_SETUP_CODE });
  assert.match(await (await b.get('/setup/you')).text(), /value="owner@example\.org"/, 'break-glass prefills');
  await b.post('/setup/you', { name: 'Olive Example', email: 'owner@example.org', password: 'another long password 2' });
  const secret = keyFromPage(await (await b.get('/setup/app')).text());
  assert.notEqual(secret, first.secret);
  assert.equal((await b.post('/setup/app', { code: totp(base32Decode(secret), Date.now()) })).status, 303);
  const ops = (await db.query('select id from operators')).rows;
  assert.deepEqual(ops.map((o) => o.id), [id]);
  assert.equal((await first.b.get('/')).headers.get('location'), '/signin', 'the old session ended');
  const last = (await db.query('select action, payload from ops_log order by seq desc limit 1')).rows[0];
  assert.deepEqual(last, { action: 'setup', payload: { reopened: true } });
  baseEnv();
});
