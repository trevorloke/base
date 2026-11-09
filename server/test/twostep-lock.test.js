// Wrong two-step codes add up (lib/twostep.js LOCK_AFTER): the count is the
// account's, in the database — a new sign-in, the 15-minute pause running
// out or a restart doesn't wipe it; a right code does. Twenty wrong in a
// row and the codes from the app stop working for the account: the answer
// says so, the lock is on each campaign's log, the person and the
// campaign's managers are emailed, and the managers' Today and Settings →
// Members show it until a recovery code — or a manager's reset — unlocks it.
// Joining another campaign and turning it off count the same.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { app } from '../index.js';
import { getDb } from '../db/client.js';
import { base32Decode, codeFails, hotp, totp, totpStep, LOCK_AFTER } from '../lib/twostep.js';

const env = { ...process.env };
const realFetch = globalThis.fetch;
const mails = [];
let ipSeq = 0;
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
  signIn(email) { return this.post('/api/auth/login', { email, password: 'two-step-2026' }); }
}
const ok = (r) => { assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.json)); return r.json; };
// The next code the account will take (a test is quicker than 30 seconds).
const nextCode = async (key, userId) => {
  const db = await getDb();
  const now = totpStep(Date.now());
  const last = (await db.query('select last_step from two_step where user_id = $1', [userId])).rows[0]?.last_step;
  if (last == null) return hotp(base32Decode(key), now);
  if (Number(last) + 1 <= now + 1) return hotp(base32Decode(key), Number(last) + 1);
  await db.query('update two_step set last_step = $2 where user_id = $1', [userId, now]);
  return hotp(base32Decode(key), now + 1);
};
const stateOf = async (userId) => (await (await getDb()).query('select fails, locked_at from two_step where user_id = $1', [userId])).rows[0];
// Wrong codes from fresh sign-ins: n of them, as they'd come over an
// evening (the 15-minute pause in this process is let run out between).
const wrongCodes = async (email, userId, n) => {
  let r;
  const b = new Browser();
  for (let i = 0; i < n; i++) {
    if (i % 5 === 0) assert.deepEqual(ok(await b.signIn(email)), { two_step: 'code' });
    if (i % 10 === 0) codeFails.clear(`user:${userId}`);
    r = await b.post('/api/auth/login/code', { code: String(100000 + i) });
  }
  return r;
};

let rae;
const team = {};
before(async () => {
  await freshDb();
  delete process.env.STARBASE_TWO_STEP_KEY;
  process.env.RESEND_API_KEY = 're_test_lock';
  process.env.MAIL_FROM = 'Imagine Surrey <team@example.org>';
  globalThis.fetch = async (url, init = {}) => {
    if (!String(url).startsWith('https://api.resend.com/')) return realFetch(url, init);
    mails.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: `m${mails.length}` }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  rae = new Browser();
  const r = ok(await rae.post('/api/auth/signup', {
    name: 'Rae Example', email: 'rae.lock@example.org', password: 'two-step-2026', workspaceName: 'Imagine Surrey', jurisdiction: 'bc-municipal',
  }));
  team.rae = { b: rae, id: r.user.id, email: 'rae.lock@example.org' };
  for (const [who, role] of [['max', 'manager'], ['sam', 'staff'], ['val', 'volunteer']]) {
    const inv = ok(await rae.action('member.invite', { email: `${who}.lock@example.org`, role }));
    const b = new Browser();
    const j = ok(await b.post('/api/auth/join', { token: inv.joinUrl.split('/join/')[1], name: `${who[0].toUpperCase()}${who.slice(1)} Example`, password: 'two-step-2026' }));
    team[who] = { b, id: j.user.id, email: `${who}.lock@example.org` };
  }
  // Sam turns it on: the key and ten recovery codes.
  const s = ok(await team.sam.b.action('twostep.start'));
  const on = ok(await team.sam.b.action('twostep.confirm', { code: totp(base32Decode(s.setup.key), Date.now()) }));
  team.sam.key = s.setup.key;
  team.sam.codes = on.recovery_codes;
});
after(() => {
  globalThis.fetch = realFetch;
  for (const k of ['RESEND_API_KEY', 'MAIL_FROM']) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
});

test('wrong codes add up across sign-ins, and past the 15-minute pause; a right code clears them', async () => {
  const { sam } = team;
  const last = await wrongCodes(sam.email, sam.id, 9);
  assert.deepEqual([last.status, last.json.two_step], [401, 'code']);
  codeFails.clear(`user:${sam.id}`); // the pause runs out (or the server restarts)
  assert.equal((await stateOf(sam.id)).fails, 9, 'kept by the account, not by this process');
  const b = new Browser();
  await b.signIn(sam.email);
  ok(await b.post('/api/auth/login/code', { code: await nextCode(sam.key, sam.id) }));
  assert.deepEqual(await stateOf(sam.id), { fails: 0, locked_at: null });
});

test('twenty wrong in a row lock the app’s codes: said, on the log, the person and the managers told; a recovery code unlocks', async () => {
  const { sam } = team;
  mails.length = 0;
  const before20 = await wrongCodes(sam.email, sam.id, LOCK_AFTER - 1);
  assert.equal(before20.json.locked, undefined, 'nineteen: not yet');
  const locked = await wrongCodes(sam.email, sam.id, 1);
  assert.equal(locked.status, 401);
  assert.equal(locked.json.locked, true);
  assert.equal(locked.json.two_step, 'code', 'a recovery code can still be typed');
  assert.match(locked.json.error, /locked/);
  assert.match(locked.json.error, /recovery code/);
  // Even the right code from the app is refused now.
  codeFails.clear(`user:${sam.id}`);
  const b = new Browser();
  await b.signIn(sam.email);
  const right = await b.post('/api/auth/login/code', { code: await nextCode(sam.key, sam.id) });
  assert.deepEqual([right.status, right.json.locked], [401, true]);
  assert.ok(!b.jar.has('mv2_session'));
  // On the campaign's log, by nobody (it may not have been Sam).
  const db = await getDb();
  const ev = (await db.query(
    "select action, op, payload, actor_id from events where entity_type = 'two_step' and entity_id = $1 and action = 'twostep.locked'", [sam.id],
  )).rows;
  assert.deepEqual(ev.map((e) => [e.op, e.payload.locked, e.payload.wrong_codes, e.actor_id]), [['update', true, LOCK_AFTER, null]]);
  // Told: Sam, and each manager — once.
  const to = mails.filter((m) => /two-step/i.test(m.subject)).map((m) => m.to[0]).sort();
  assert.deepEqual(to, ['max.lock@example.org', 'rae.lock@example.org', 'sam.lock@example.org']);
  const toSam = mails.find((m) => m.to[0] === 'sam.lock@example.org');
  assert.match(toSam.text, /recovery code/);
  assert.match(toSam.text, /password/);
  const toRae = mails.find((m) => m.to[0] === 'rae.lock@example.org');
  assert.match(toRae.text, /Sam Example/);
  assert.match(toRae.text, /Settings → Members/);
  assert.ok(!mails.some((m) => m.text.includes(sam.key) || /\b1000\d\d\b/.test(m.text)), 'nothing secret, no codes');
  // A manager's Today and Settings → Members say so; a volunteer's Today doesn't.
  const brief = ok(await rae.get('/api/brief'));
  assert.ok((brief.serverWarnings || []).some((w) => /Sam Example/.test(w) && /locked/.test(w)), JSON.stringify(brief.serverWarnings));
  assert.ok(!(ok(await team.val.b.get('/api/brief')).serverWarnings || []).some((w) => /Sam/.test(w)));
  assert.equal(ok(await rae.get('/api/two-step/team')).members.find((m) => m.id === sam.id).locked, true);
  // More wrong codes: still locked, nobody told twice.
  await wrongCodes(sam.email, sam.id, 2);
  assert.equal(mails.filter((m) => /two-step/i.test(m.subject)).length, 3);
  // A recovery code signs in and unlocks; the app's codes work again.
  codeFails.clear(`user:${sam.id}`);
  const c = new Browser();
  await c.signIn(sam.email);
  const rec = ok(await c.post('/api/auth/login/code', { code: sam.codes[0] }));
  assert.equal(rec.recovery_left, 9);
  assert.deepEqual(await stateOf(sam.id), { fails: 0, locked_at: null });
  assert.ok(!(ok(await rae.get('/api/brief')).serverWarnings || []).some((w) => /Sam Example/.test(w)), 'gone from Today');
  const d = new Browser();
  await d.signIn(sam.email);
  ok(await d.post('/api/auth/login/code', { code: await nextCode(sam.key, sam.id) }));
  sam.b = d;
});

test('joining another campaign and turning it off count the same; locked, only a recovery code turns it off', async () => {
  const { sam } = team;
  const db = await getDb();
  // Another campaign on this server invites Sam.
  const ida = new Browser();
  ok(await ida.post('/api/auth/signup', { name: 'Ida Example', email: 'ida.lock@example.org', password: 'two-step-2026', workspaceName: 'Another Campaign' }));
  const inv = ok(await ida.action('member.invite', { email: sam.email, role: 'volunteer' }));
  const token = inv.joinUrl.split('/join/')[1];
  codeFails.clear(`user:${sam.id}`);
  const wrongJoin = await new Browser().post('/api/auth/join', { token, password: 'two-step-2026', code: '123456' });
  assert.deepEqual([wrongJoin.status, wrongJoin.json.two_step], [401, 'code']);
  assert.equal((await stateOf(sam.id)).fails, 1, 'a wrong code at joining counts');
  const wrongOff = await sam.b.action('twostep.off', { code: '123456' });
  assert.equal(wrongOff.status, 400);
  assert.equal((await stateOf(sam.id)).fails, 2, 'a wrong code to turn it off counts');
  // Up to the lock, from wherever.
  await db.query('update two_step set fails = $2 where user_id = $1', [sam.id, LOCK_AFTER - 1]);
  mails.length = 0;
  const lockedOff = await sam.b.action('twostep.off', { code: '123456' });
  assert.equal(lockedOff.status, 400);
  assert.match(lockedOff.json.error, /locked/);
  assert.ok((await stateOf(sam.id)).locked_at, 'locked by a wrong code to turn it off');
  assert.equal(mails.filter((m) => /two-step/i.test(m.subject)).length, 3, 'told: Sam and both managers');
  // On the log of the campaign Sam is in (the other one never let Sam in).
  const evs = (await db.query("select workspace_id from events where action = 'twostep.locked' and entity_id = $1", [sam.id])).rows;
  assert.equal(evs.length, 2, 'the first lock and this one');
  codeFails.clear(`user:${sam.id}`);
  const appOff = await sam.b.action('twostep.off', { code: await nextCode(sam.key, sam.id) });
  assert.equal(appOff.status, 400, 'the app’s codes are locked');
  const joinLocked = await new Browser().post('/api/auth/join', { token, password: 'two-step-2026', code: await nextCode(sam.key, sam.id) });
  assert.deepEqual([joinLocked.status, joinLocked.json.locked], [401, true]);
  const codes = await sam.b.action('twostep.codes', { code: await nextCode(sam.key, sam.id) });
  assert.equal(codes.status, 400);
  assert.match(codes.json.error, /locked/);
  // A recovery code turns it off (and so ends the lock with it).
  const off = ok(await sam.b.action('twostep.off', { code: sam.codes[1] }));
  assert.equal(off.on, false);
  assert.equal(await stateOf(sam.id), undefined);
  codeFails.clear(`user:${sam.id}`);
});
