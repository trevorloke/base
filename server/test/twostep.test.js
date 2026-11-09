// Two-step sign-in (lib/twostep.js, ext/twostep, routes/auth.js): the code
// maths against the RFCs' own test vectors, the QR code, the secret sealed
// at rest; turning it on, signing in with and without the code, recovery
// codes that work once, a manager's requirement for desk roles, a manager's
// reset — each on the event log, nothing secret in it or in the export.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { app } from '../index.js';
import { getDb } from '../db/client.js';
import { runAction, verifyChain } from '../lib/events.js';
import { qrMatrix, qrSvgPath } from '../lib/qr.js';
import {
  base32Decode, base32Encode, codeFails, groupSecret, hashRecoveryCode, hotp, keyStatus, looksLikeRecoveryCode,
  newRecoveryCodes, newRecoverySalt, newTotpSecret, openSecret, otpauthUri, resetFromServer, sealSecret, totp, totpStep, verifyTotp,
} from '../lib/twostep.js';

const env = { ...process.env };
let ipSeq = 0;
// A browser: every cookie the server sets (the sign-in and the code step's
// ticket are two), and an address of its own for sign-in's per-address limit.
class Browser {
  constructor() { this.jar = new Map(); this.ip = `198.51.100.${(ipSeq += 1) % 250}`; }
  get cookie() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '); }
  async req(method, path, body) {
    const res = await app.request(path, {
      method,
      headers: { 'content-type': 'application/json', 'x-forwarded-for': this.ip, ...(this.jar.size ? { cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(';');
      const i = pair.indexOf('=');
      const [k, v] = [pair.slice(0, i), pair.slice(i + 1)];
      if (!v || /max-age=0/i.test(sc)) this.jar.delete(k); else this.jar.set(k, v);
    }
    let json = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, json };
  }
  get(p) { return this.req('GET', p); }
  post(p, b) { return this.req('POST', p, b); }
  action(name, input = {}) { return this.post(`/api/actions/${name}`, input); }
  signIn(email, password = 'two-step-2026') { return this.post('/api/auth/login', { email, password }); }
}

const ascii = (s) => Buffer.from(s, 'ascii');
// The next code the account will take: the step after the last one used.
// A test is faster than a person: when that step is still more than one
// ahead of the clock, it's as if the next 30 seconds had passed — the step
// last used is put back one.
const nextCode = async (key, userId) => {
  const db = await getDb();
  const now = totpStep(Date.now());
  const last = (await db.query('select last_step from two_step where user_id = $1', [userId])).rows[0]?.last_step;
  if (last == null) return hotp(base32Decode(key), now);
  if (Number(last) + 1 <= now + 1) return hotp(base32Decode(key), Number(last) + 1);
  await db.query('update two_step set last_step = $2 where user_id = $1', [userId, now]);
  return hotp(base32Decode(key), now + 1);
};
const eventsOf = async (wsId, type) => (await (await getDb()).query(
  'select action, entity_id, op, payload, actor_id from events where workspace_id = $1 and entity_type = $2 order by seq', [wsId, type],
)).rows;

let mgr, mgrId, wsId, mgrKey;
const people = {};

before(async () => {
  await freshDb();
  delete process.env.STARBASE_TWO_STEP_KEY;
  delete process.env.RESEND_API_KEY;
  mgr = new Browser();
  const r = await mgr.post('/api/auth/signup', {
    name: 'Rae Example', email: 'rae.manager@example.org', password: 'two-step-2026', workspaceName: 'Imagine Surrey', jurisdiction: 'bc-municipal',
  });
  assert.equal(r.status, 201);
  mgrId = r.json.user.id;
  wsId = r.json.workspace.id;
  assert.deepEqual(r.json.two_step, { on: false, required: false, must_set_up: false });
  // A staffer, a treasurer and two volunteers, each joined by invite.
  for (const [who, role] of [['sam', 'staff'], ['tess', 'treasurer'], ['val', 'volunteer'], ['vic', 'volunteer']]) {
    const inv = await mgr.action('member.invite', { email: `${who}@example.org`, role });
    assert.equal(inv.status, 200, JSON.stringify(inv.json));
    const b = new Browser();
    const j = await b.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: `${who[0].toUpperCase()}${who.slice(1)} Example`, password: 'two-step-2026' });
    assert.equal(j.status, 200, JSON.stringify(j.json));
    people[who] = { b, id: j.json.user.id, email: `${who}@example.org` };
  }
});
after(() => {
  for (const k of ['STARBASE_TWO_STEP_KEY']) {
    if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k];
  }
});

// ── The maths ──
test('HOTP: RFC 4226 appendix D, counters 0 to 9', () => {
  const key = ascii('12345678901234567890');
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  assert.deepEqual(expected.map((_, i) => hotp(key, i)), expected);
});

test('TOTP: RFC 6238 appendix B, SHA-1, SHA-256 and SHA-512, 8 digits', () => {
  const seeds = {
    sha1: ascii('12345678901234567890'),
    sha256: ascii('12345678901234567890123456789012'),
    sha512: ascii('1234567890123456789012345678901234567890123456789012345678901234'),
  };
  const vectors = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
  ];
  for (const [seconds, sha1, sha256, sha512] of vectors) {
    const at = seconds * 1000;
    assert.equal(totp(seeds.sha1, at, { digits: 8 }), sha1, `sha1 at ${seconds}`);
    assert.equal(totp(seeds.sha256, at, { digits: 8, algorithm: 'sha256' }), sha256, `sha256 at ${seconds}`);
    assert.equal(totp(seeds.sha512, at, { digits: 8, algorithm: 'sha512' }), sha512, `sha512 at ${seconds}`);
  }
  // What the apps show: 6 digits (the last six of the RFC's), 30-second steps.
  assert.equal(totp(seeds.sha1, 59_000), '287082');
  assert.equal(totpStep(59_000), 1);
  assert.equal(totpStep(60_000), 2);
});

test('a code: now and one step either side; never two away, junk, or a step already used', () => {
  const key = ascii('12345678901234567890');
  const now = 1_700_000_015_000;
  const step = totpStep(now);
  const at = (s) => hotp(key, s);
  assert.equal(verifyTotp(key, at(step), { nowMs: now }), step);
  assert.equal(verifyTotp(key, at(step - 1), { nowMs: now }), step - 1);
  assert.equal(verifyTotp(key, at(step + 1), { nowMs: now }), step + 1);
  assert.equal(verifyTotp(key, at(step - 2), { nowMs: now }), null);
  assert.equal(verifyTotp(key, at(step + 2), { nowMs: now }), null);
  for (const junk of ['', '12345', 'abcdef', '1234567']) assert.equal(verifyTotp(key, junk, { nowMs: now }), null, junk);
  assert.equal(verifyTotp(key, `${at(step).slice(0, 3)} ${at(step).slice(3)}`, { nowMs: now }), step, 'spaced as apps show it');
  assert.equal(verifyTotp(key, at(step), { nowMs: now, afterStep: step }), null, 'the same code twice');
  assert.equal(verifyTotp(key, at(step - 1), { nowMs: now, afterStep: step }), null, 'an earlier one');
  assert.equal(verifyTotp(key, at(step + 1), { nowMs: now, afterStep: step }), step + 1, 'the next one is still good');
});

test('base32 (RFC 4648), the key and the otpauth address', () => {
  for (const [plain, encoded] of [['', ''], ['f', 'MY'], ['fo', 'MZXQ'], ['foo', 'MZXW6'], ['foob', 'MZXW6YQ'], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI']]) {
    assert.equal(base32Encode(ascii(plain)), encoded);
    assert.equal(base32Decode(encoded).toString('ascii'), plain);
  }
  assert.equal(base32Decode('mzxw 6ytb-oi======').toString('ascii'), 'foobar');
  assert.throws(() => base32Decode('MZ1'));
  const s = newTotpSecret();
  assert.match(s, /^[A-Z2-7]{32}$/);
  assert.equal(base32Decode(s).length, 20);
  assert.equal(groupSecret('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'), 'ABCD EFGH IJKL MNOP QRST UVWX YZ23 4567');
  assert.equal(otpauthUri({ secret: 'JBSWY3DPEHPK3PXP', account: 'rae@example.org', issuer: 'Imagine Surrey (base.win)' }),
    'otpauth://totp/Imagine%20Surrey%20(base.win):rae%40example.org?secret=JBSWY3DPEHPK3PXP&issuer=Imagine%20Surrey%20%28base.win%29&algorithm=SHA1&digits=6&period=30');
});

test('the QR code: smallest version that fits, finder and timing patterns, an SVG path', () => {
  assert.equal(qrMatrix('hello').length, 21, 'version 1');
  const uri = otpauthUri({ secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', account: 'rae.manager@example.org', issuer: 'Imagine Surrey (base.win)' });
  const m = qrMatrix(uri);
  const version = (m.length - 17) / 4;
  assert.ok(Number.isInteger(version) && version >= 6 && version <= 10, `version ${version}`);
  for (const [x0, y0] of [[0, 0], [m.length - 7, 0], [0, m.length - 7]]) {
    for (let i = 0; i < 7; i++) assert.ok(m[y0][x0 + i] && m[y0 + 6][x0 + i] && m[y0 + i][x0] && m[y0 + i][x0 + 6]);
    assert.equal(m[y0 + 1][x0 + 1], false);
    assert.equal(m[y0 + 3][x0 + 3], true);
  }
  for (let i = 8; i < m.length - 8; i++) { assert.equal(m[6][i], i % 2 === 0); assert.equal(m[i][6], i % 2 === 0); }
  assert.equal(m[m.length - 8][8], true, 'the dark module');
  assert.deepEqual(qrMatrix(uri), m, 'the same every time');
  assert.throws(() => qrMatrix('x'.repeat(500)), /Too long/);
  const { d, size } = qrSvgPath('hello');
  assert.equal(size, 29);
  assert.ok(d.startsWith('M4 4h7v1h-7z'), 'the first finder’s top row, in from the quiet zone');
});

test('recovery codes: ten, unambiguous, hashed slowly with a salt, typed back any way', async () => {
  const codes = newRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const c of codes) {
    assert.match(c, /^[a-z2-9]{5}-[a-z2-9]{5}$/);
    assert.doesNotMatch(c, /[01ilo]/);
    assert.equal(looksLikeRecoveryCode(c), true);
  }
  assert.equal(looksLikeRecoveryCode('123456'), false);
  const salt = newRecoverySalt();
  const h = await hashRecoveryCode('k7m2q-x9tbn', salt);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(await hashRecoveryCode(' K7M2Q X9TBN ', salt), h);
  assert.notEqual(await hashRecoveryCode('k7m2q-x9tbn', newRecoverySalt()), h, 'another person’s salt, another hash');
});

test('the secret at rest: sealed with the environment’s key, else one base.win keeps in the database', async () => {
  const db = await getDb();
  delete process.env.STARBASE_TWO_STEP_KEY;
  assert.deepEqual(keyStatus(), { source: 'database', problem: 'unset' });
  const inDb = await sealSecret(db, 'JBSWY3DPEHPK3PXP');
  assert.match(inDb, /^v1\.db\.[\w-]+\.[\w-]+\.[\w-]+$/);
  assert.ok(!inDb.includes('JBSWY3DPEHPK3PXP'));
  assert.deepEqual(await openSecret(db, inDb), { plain: 'JBSWY3DPEHPK3PXP', current: true });
  assert.notEqual(await sealSecret(db, 'JBSWY3DPEHPK3PXP'), inDb, 'a fresh IV each time');
  // A key too short to be one is left out, and said.
  process.env.STARBASE_TWO_STEP_KEY = 'too-short';
  assert.deepEqual(keyStatus(), { source: 'database', problem: 'short' });
  // Set: it seals; what the database's key sealed still opens (not current).
  process.env.STARBASE_TWO_STEP_KEY = 'a-long-random-two-step-key-0123456789abcdef';
  assert.deepEqual(keyStatus(), { source: 'env' });
  const inEnv = await sealSecret(db, 'JBSWY3DPEHPK3PXP');
  assert.match(inEnv, /^v1\.e[0-9a-f]{10}\./);
  assert.deepEqual(await openSecret(db, inEnv), { plain: 'JBSWY3DPEHPK3PXP', current: true });
  assert.deepEqual(await openSecret(db, inDb), { plain: 'JBSWY3DPEHPK3PXP', current: false });
  // Moving to a new key: new first, old after — both open, the new seals.
  process.env.STARBASE_TWO_STEP_KEY = 'the-next-long-random-two-step-key-0123456789, a-long-random-two-step-key-0123456789abcdef';
  assert.deepEqual(await openSecret(db, inEnv), { plain: 'JBSWY3DPEHPK3PXP', current: false });
  // Another key, a tampered value, junk: unreadable.
  process.env.STARBASE_TWO_STEP_KEY = 'someone-elses-long-random-two-step-key-0123456789';
  assert.equal(await openSecret(db, inEnv), null);
  const [v, kid, iv, tag, body] = inDb.split('.');
  const flipped = Buffer.from(body, 'base64url'); flipped[0] ^= 1;
  assert.equal(await openSecret(db, [v, kid, iv, tag, flipped.toString('base64url')].join('.')), null);
  const shortTag = Buffer.from(tag, 'base64url').subarray(0, 4).toString('base64url');
  assert.equal(await openSecret(db, [v, kid, iv, shortTag, body].join('.')), null, 'a cut-short tag is refused');
  assert.equal(await openSecret(db, 'JBSWY3DPEHPK3PXP'), null);
  delete process.env.STARBASE_TWO_STEP_KEY;
});

// ── Turning it on ──
test('turning it on: a key and its QR code (the same after a reload), the first code, ten recovery codes', async () => {
  const off = await mgr.get('/api/two-step');
  assert.equal(off.status, 200);
  assert.deepEqual([off.json.on, off.json.setup, off.json.required], [false, null, false]);
  const start = await mgr.action('twostep.start');
  assert.equal(start.status, 200, JSON.stringify(start.json));
  const { setup } = start.json;
  assert.match(setup.key, /^[A-Z2-7]{32}$/);
  assert.equal(setup.grouped.replace(/ /g, ''), setup.key);
  assert.match(setup.uri, /^otpauth:\/\/totp\/Imagine%20Surrey%20\(base\.win\):rae\.manager%40example\.org\?secret=[A-Z2-7]{32}&issuer=/);
  assert.ok(setup.qr?.d && setup.qr.size >= 21 + 8, 'a QR code to scan');
  const again = await mgr.get('/api/two-step');
  assert.equal(again.json.setup.key, setup.key, 'a reload shows the key already scanned');
  // The key in the database is sealed, not the key itself.
  const stored = (await (await getDb()).query('select secret, on_since from two_step where user_id = $1', [mgrId])).rows[0];
  assert.ok(stored.secret.startsWith('v1.') && !stored.secret.includes(setup.key));
  assert.equal(stored.on_since, null, 'not on until the first code');

  const wrong = await mgr.action('twostep.confirm', { code: hotp(base32Decode(setup.key), totpStep(Date.now()) + 5) });
  assert.equal(wrong.status, 400);
  assert.match(wrong.json.error, /doesn’t match/);

  // Signed in on another device with the password alone: that one signs in again.
  const other = new Browser();
  assert.equal((await other.signIn('rae.manager@example.org')).status, 200);
  assert.equal((await other.get('/api/auth/me')).status, 200);

  const on = await mgr.action('twostep.confirm', { code: totp(base32Decode(setup.key), Date.now()) });
  assert.equal(on.status, 200, JSON.stringify(on.json));
  assert.equal(on.json.recovery_codes.length, 10);
  assert.equal(on.json.signed_out_elsewhere, 1);
  mgrKey = setup.key;
  mgr.codes = on.json.recovery_codes;
  assert.equal((await other.get('/api/auth/me')).status, 401, 'the other device is signed out');
  assert.equal((await mgr.get('/api/auth/me')).json.two_step.on, true, 'this one stays signed in');
  const status = await mgr.get('/api/two-step');
  assert.deepEqual([status.json.on, status.json.recovery_left, status.json.setup], [true, 10, null]);
  assert.equal((await mgr.action('twostep.start')).status, 409, 'already on');

  const ev = await eventsOf(wsId, 'two_step');
  assert.deepEqual(ev.map((e) => [e.action, e.op, e.entity_id, e.actor_id]), [['twostep.confirm', 'create', mgrId, mgrId]]);
  const log = JSON.stringify(await (await getDb()).query('select payload from events where workspace_id = $1', [wsId]));
  assert.ok(!log.includes(setup.key) && !on.json.recovery_codes.some((c) => log.includes(c)), 'no key, no code on the log');
});

// ── Signing in ──
test('sign-in asks for the code: no session from the password alone; the right code opens it', async () => {
  const b = new Browser();
  const first = await b.signIn('rae.manager@example.org');
  assert.equal(first.status, 200);
  assert.deepEqual(first.json, { two_step: 'code' }, 'nothing about the campaign yet');
  assert.ok(b.jar.has('mv2_two_step') && !b.jar.has('mv2_session'), 'a ticket for the code, no session');
  assert.equal((await b.get('/api/auth/me')).status, 401);
  assert.equal((await b.get('/api/persons')).status, 401);
  const bad = await b.post('/api/auth/login/code', { code: '000000' });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.two_step, 'code');
  assert.equal(bad.json.tries_left, 4);
  const ok = await b.post('/api/auth/login/code', { code: await nextCode(mgrKey, mgrId) });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.user.id, mgrId);
  assert.equal(ok.json.two_step.on, true);
  assert.ok(b.jar.has('mv2_session') && !b.jar.has('mv2_two_step'));
  assert.equal((await b.get('/api/persons')).status, 200);
});

test('a code works once: the same code at the next sign-in is refused', async () => {
  const b = new Browser();
  await b.signIn('rae.manager@example.org');
  const last = (await (await getDb()).query('select last_step from two_step where user_id = $1', [mgrId])).rows[0].last_step;
  const replay = await b.post('/api/auth/login/code', { code: hotp(base32Decode(mgrKey), Number(last)) });
  assert.equal(replay.status, 401);
  assert.equal(replay.json.tries_left, 4);
});

test('signing in on a phone and a laptop at once: each finishes with its own code', async () => {
  const laptop = new Browser();
  const phone = new Browser();
  assert.deepEqual((await laptop.signIn('rae.manager@example.org')).json, { two_step: 'code' });
  assert.deepEqual((await phone.signIn('rae.manager@example.org')).json, { two_step: 'code' });
  assert.equal((await phone.post('/api/auth/login/code', { code: await nextCode(mgrKey, mgrId) })).status, 200);
  assert.equal((await laptop.post('/api/auth/login/code', { code: await nextCode(mgrKey, mgrId) })).status, 200, 'the laptop’s wait wasn’t ended by the phone’s');
});

test('five wrong codes and the password is asked again; a stale ticket too', async () => {
  const b = new Browser();
  await b.signIn('rae.manager@example.org');
  let r;
  for (let i = 0; i < 5; i++) r = await b.post('/api/auth/login/code', { code: '11111' + i });
  assert.equal(r.status, 401);
  assert.equal(r.json.two_step, 'again');
  assert.equal((await b.post('/api/auth/login/code', { code: await nextCode(mgrKey, mgrId) })).json.two_step, 'again', 'the ticket is gone');
  const none = await new Browser().post('/api/auth/login/code', { code: '123456' });
  assert.deepEqual([none.status, none.json.two_step], [401, 'again']);
  // Ten minutes go by between the password and the code.
  const late = new Browser();
  await late.signIn('rae.manager@example.org');
  await (await getDb()).query("update two_step_pending set expires_at = now() - interval '1 second' where user_id = $1", [mgrId]);
  const stale = await late.post('/api/auth/login/code', { code: await nextCode(mgrKey, mgrId) });
  assert.deepEqual([stale.status, stale.json.two_step], [401, 'again'], 'the password again');
  codeFails.clear(`user:${mgrId}`);
});

test('a recovery code signs in once; then it’s spent (and the log says one was used)', async () => {
  const code = mgr.codes[0];
  const b = new Browser();
  await b.signIn('rae.manager@example.org');
  const ok = await b.post('/api/auth/login/code', { code: code.toUpperCase().replace('-', ' ') });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.recovery_left, 9);
  const c = new Browser();
  await c.signIn('rae.manager@example.org');
  const again = await c.post('/api/auth/login/code', { code });
  assert.equal(again.status, 401, 'used once already');
  assert.equal((await mgr.get('/api/two-step')).json.recovery_left, 9);
  const ev = await eventsOf(wsId, 'two_step');
  const used = ev.find((e) => e.action === 'twostep.signin');
  assert.deepEqual(used && [used.op, used.payload, used.actor_id], ['update', { recovery_code_used: true, recovery_left: 9 }, mgrId]);
  codeFails.clear(`user:${mgrId}`);
});

test('new recovery codes: an app code (not a recovery code); the old ones stop working', async () => {
  assert.equal((await mgr.action('twostep.codes', { code: mgr.codes[1] })).status, 400, 'a recovery code doesn’t make more');
  const r = await mgr.action('twostep.codes', { code: await nextCode(mgrKey, mgrId) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.recovery_codes.length, 10);
  const b = new Browser();
  await b.signIn('rae.manager@example.org');
  assert.equal((await b.post('/api/auth/login/code', { code: mgr.codes[2] })).status, 401, 'an old code');
  assert.equal((await b.post('/api/auth/login/code', { code: r.json.recovery_codes[0] })).status, 200, 'a new one');
  mgr.codes = r.json.recovery_codes.slice(1);
  codeFails.clear(`user:${mgrId}`);
});

test('volunteers sign in as before — the password alone — unless they turn it on', async () => {
  const b = new Browser();
  const r = await b.signIn('val@example.org');
  assert.equal(r.status, 200);
  assert.equal(r.json.role, 'volunteer');
  assert.deepEqual(r.json.two_step, { on: false, required: false, must_set_up: false });
  assert.ok(b.jar.has('mv2_session'));
  // Vic turns it on for themselves: their sign-in asks for the code too.
  const vic = people.vic;
  const s = await vic.b.action('twostep.start');
  assert.equal(s.status, 200);
  assert.equal((await vic.b.action('twostep.confirm', { code: totp(base32Decode(s.json.setup.key), Date.now()) })).status, 200);
  vic.key = s.json.setup.key;
  const v = new Browser();
  assert.deepEqual((await v.signIn('vic@example.org')).json, { two_step: 'code' });
  assert.equal((await v.post('/api/auth/login/code', { code: await nextCode(vic.key, vic.id) })).status, 200);
});

// ── The campaign's requirement ──
test('requiring it for desk roles: managers only, and only once their own is on', async () => {
  assert.equal((await people.sam.b.action('twostep.require', { on: true })).status, 403, 'staff can’t');
  const fresh = new Browser();
  const other = await fresh.post('/api/auth/signup', { name: 'Ola Example', email: 'ola.other@example.org', password: 'two-step-2026', workspaceName: 'Another Campaign' });
  assert.equal(other.status, 201);
  const refused = await fresh.action('twostep.require', { on: true });
  assert.equal(refused.status, 409);
  assert.match(refused.json.error, /for yourself first/);
  const r = await mgr.action('twostep.require', { on: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const team = await mgr.get('/api/two-step/team');
  assert.equal(team.json.required, true);
  assert.deepEqual(team.json.members.map((m) => m.id).sort(), [mgrId, people.vic.id].sort());
  assert.equal((await people.sam.b.get('/api/two-step/team')).status, 401, 'staff: set it up first (and it’s managers’ anyway)');
  const ev = (await eventsOf(wsId, 'workspace')).filter((e) => e.action === 'twostep.require');
  assert.deepEqual(ev.map((e) => [e.op, e.payload, e.actor_id]), [['update', { two_step_required: true }, mgrId]]);
});

test('required: a desk member already signed in does nothing else until it’s set up; volunteers carry on', async () => {
  const sam = people.sam;
  const me = await sam.b.get('/api/auth/me');
  assert.equal(me.status, 200, 'who they are still answers');
  assert.deepEqual(me.json.two_step, { on: false, required: true, must_set_up: true });
  for (const path of ['/api/persons', '/api/brief', '/api/team', '/api/export']) {
    const r = await sam.b.get(path);
    assert.equal(r.status, 401, path);
    assert.equal(r.json.two_step, 'set_up', path);
  }
  const write = await sam.b.action('person.create', { name: 'Nobody Example' });
  assert.deepEqual([write.status, write.json.two_step], [401, 'set_up']);
  // A volunteer isn't asked.
  const val = await people.val.b.get('/api/persons');
  assert.equal(val.status, 200);
  assert.equal((await people.val.b.get('/api/auth/me')).json.two_step.must_set_up, false);
  // The set-up itself answers.
  const status = await sam.b.get('/api/two-step');
  assert.deepEqual([status.status, status.json.must_set_up, status.json.required], [200, true, true]);
  const s = await sam.b.action('twostep.start');
  assert.equal(s.status, 200);
  const done = await sam.b.action('twostep.confirm', { code: totp(base32Decode(s.json.setup.key), Date.now()) });
  assert.equal(done.status, 200);
  sam.key = s.json.setup.key;
  assert.equal((await sam.b.get('/api/persons')).status, 200, 'set up: the desk opens');
  assert.equal((await sam.b.get('/api/auth/me')).json.two_step.must_set_up, false);
});

test('required: at their next sign-in a desk member sets it up before anything else', async () => {
  const tess = people.tess;
  const b = new Browser();
  const r = await b.signIn('tess@example.org');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.two_step, { on: false, required: true, must_set_up: true });
  assert.equal((await b.get('/api/stewardship')).status, 401);
  const s = await b.action('twostep.start');
  assert.equal(s.status, 200);
  assert.equal((await b.action('twostep.confirm', { code: totp(base32Decode(s.json.setup.key), Date.now()) })).status, 200);
  tess.key = s.json.setup.key;
  assert.equal((await b.get('/api/stewardship')).status, 200, 'set up: the money desk opens');
  assert.equal((await tess.b.get('/api/auth/me')).status, 401, 'the sign-in from before (no code) is over');
  tess.b = b;
});

test('turning it off: an app code or a recovery code; when it’s required, set-up comes straight back', async () => {
  const sam = people.sam;
  assert.equal((await sam.b.action('twostep.off', { code: '000000' })).status, 400);
  const off = await sam.b.action('twostep.off', { code: await nextCode(sam.key, sam.id) });
  assert.equal(off.status, 200, JSON.stringify(off.json));
  assert.deepEqual([off.json.on, off.json.must_set_up], [false, true]);
  assert.equal((await sam.b.get('/api/persons')).json.two_step, 'set_up');
  const s = await sam.b.action('twostep.start');
  assert.equal((await sam.b.action('twostep.confirm', { code: totp(base32Decode(s.json.setup.key), Date.now()) })).status, 200);
  sam.key = s.json.setup.key;
  // Vic (a volunteer, not required) turns theirs off with a recovery code… after making some.
  const vic = people.vic;
  const codes = (await vic.b.action('twostep.codes', { code: await nextCode(vic.key, vic.id) })).json.recovery_codes;
  const voff = await vic.b.action('twostep.off', { code: codes[3] });
  assert.equal(voff.status, 200);
  assert.deepEqual([voff.json.on, voff.json.must_set_up], [false, false]);
  const v = new Browser();
  const r = await v.signIn('vic@example.org');
  assert.equal(r.json.role, 'volunteer', 'the password alone again');
  const ev = (await eventsOf(wsId, 'two_step')).filter((e) => e.action === 'twostep.off');
  assert.deepEqual(ev.map((e) => [e.entity_id, e.op, e.payload.with]), [[sam.id, 'void', 'app'], [vic.id, 'void', 'recovery code']]);
});

test('ten wrong codes in 15 minutes and the person waits', async () => {
  const tess = people.tess;
  const b = new Browser();
  for (let i = 0; i < 2; i++) {
    await b.signIn('tess@example.org');
    for (let j = 0; j < 5; j++) await b.post('/api/auth/login/code', { code: `00000${j}` });
  }
  await b.signIn('tess@example.org');
  const r = await b.post('/api/auth/login/code', { code: await nextCode(tess.key, tess.id) });
  assert.equal(r.status, 429, 'even the right code waits');
  assert.equal((await tess.b.action('twostep.codes', { code: '123456' })).status, 429, 'and so does everything that takes a code');
  codeFails.clear(`user:${tess.id}`);
});

// ── A manager's reset ──
test('a manager resets someone’s two-step sign-in: signed out everywhere, on the log; set-up again at sign-in', async () => {
  const sam = people.sam;
  assert.equal((await people.tess.b.action('twostep.reset', { user_id: sam.id })).status, 403, 'a treasurer can’t');
  assert.equal((await mgr.action('twostep.reset', { user_id: mgrId })).status, 400, 'not your own');
  assert.equal((await mgr.action('twostep.reset', { user_id: people.val.id })).status, 404, 'they don’t use it');
  const r = await mgr.action('twostep.reset', { user_id: sam.id });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal((await sam.b.get('/api/auth/me')).status, 401, 'signed out');
  const b = new Browser();
  const again = await b.signIn('sam@example.org');
  assert.equal(again.status, 200, 'the password alone signs in…');
  assert.equal(again.json.two_step.must_set_up, true, '…to the set-up, since it’s required');
  const ev = (await eventsOf(wsId, 'two_step')).filter((e) => e.action === 'twostep.reset');
  assert.deepEqual(ev.map((e) => [e.entity_id, e.op, e.payload, e.actor_id]), [[sam.id, 'void', { reset: true }, mgrId]]);
  assert.deepEqual(await verifyChain(await getDb(), wsId), { ok: true, checked: (await (await getDb()).query('select event_seq from workspaces where id = $1', [wsId])).rows[0].event_seq });
});

test('joining another campaign with an account that has it on: the code too', async () => {
  const fresh = new Browser();
  const other = await fresh.post('/api/auth/signup', { name: 'Ida Example', email: 'ida.other@example.org', password: 'two-step-2026', workspaceName: 'Third Campaign' });
  assert.equal(other.status, 201);
  const inv = await fresh.action('member.invite', { email: 'tess@example.org', role: 'volunteer' });
  const token = inv.json.joinUrl.split('/join/')[1];
  const b = new Browser();
  const noCode = await b.post('/api/auth/join', { token, password: 'two-step-2026' });
  assert.deepEqual([noCode.status, noCode.json.two_step], [401, 'code']);
  const wrong = await b.post('/api/auth/join', { token, password: 'two-step-2026', code: '000000' });
  assert.equal(wrong.status, 401);
  const ok = await b.post('/api/auth/join', { token, password: 'two-step-2026', code: await nextCode(people.tess.key, people.tess.id) });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.workspace.name, 'Third Campaign');
  codeFails.clear(`user:${people.tess.id}`);
});

test('nothing secret leaves: not in the export, not in any answer about others', async () => {
  const exp = await mgr.get('/api/export');
  assert.equal(exp.status, 200);
  const text = JSON.stringify(exp.json);
  assert.ok(!('two_step' in exp.json) && !('two_step_pending' in exp.json) && !('app_secrets' in exp.json));
  assert.ok(!text.includes(mgrKey));
  const team = await mgr.get('/api/two-step/team');
  assert.ok(!JSON.stringify(team.json).includes('v1.'), 'statuses only');
});

test('from the server’s shell: the only manager lost their phone and codes — cleared, signed out, on the log', async () => {
  const db = await getDb();
  assert.equal(await resetFromServer(db, 'nobody@example.org', runAction), null);
  const tess = people.tess;
  assert.equal((await tess.b.get('/api/auth/me')).status, 200);
  const spaces = await resetFromServer(db, ' TESS@example.org ', runAction);
  assert.equal(spaces.length, 2, 'Imagine Surrey and the campaign she joined later');
  assert.equal((await db.query('select 1 from two_step where user_id = $1', [tess.id])).rows.length, 0);
  assert.equal((await tess.b.get('/api/auth/me')).status, 401, 'signed out everywhere');
  const ev = (await eventsOf(wsId, 'two_step')).filter((e) => e.entity_id === tess.id && e.action === 'twostep.reset');
  assert.deepEqual(ev.map((e) => [e.op, e.payload, e.actor_id]), [['void', { reset: true, from: 'the server' }, null]]);
  const r = await new Browser().signIn('tess@example.org');
  assert.equal(r.json.two_step.must_set_up, true, 'her password signs her in — to the set-up, since it’s required');
});

test('Settings → Services says where the key comes from', async () => {
  delete process.env.STARBASE_TWO_STEP_KEY;
  const r = await mgr.get('/api/connections');
  const row = r.json.services.find((s) => s.key === 'twostep');
  assert.ok(row, JSON.stringify(r.json.services.map((s) => s.key)));
  assert.equal(row.state, 'missing');
  assert.deepEqual(row.missing, ['STARBASE_TWO_STEP_KEY']);
  assert.match(row.detail, /database/);
  process.env.STARBASE_TWO_STEP_KEY = 'a-long-random-two-step-key-0123456789abcdef';
  const set = (await mgr.get('/api/connections')).json.services.find((s) => s.key === 'twostep');
  assert.equal(set.state, 'ready');
  // A secret the database's key sealed moves to the new key at its next code.
  const before = (await (await getDb()).query('select secret from two_step where user_id = $1', [mgrId])).rows[0].secret;
  assert.ok(before.startsWith('v1.db.'));
  const b = new Browser();
  await b.signIn('rae.manager@example.org');
  assert.equal((await b.post('/api/auth/login/code', { code: await nextCode(mgrKey, mgrId) })).status, 200);
  const after = (await (await getDb()).query('select secret from two_step where user_id = $1', [mgrId])).rows[0].secret;
  assert.match(after, /^v1\.e[0-9a-f]{10}\./);
  delete process.env.STARBASE_TWO_STEP_KEY;
});
