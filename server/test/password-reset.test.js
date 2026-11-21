// Forgot password (ext/passwords, routes/auth.js): a link by email built only
// from STARBASE_PUBLIC_URL with the token in the fragment; the same answer
// whatever the address; limits per address and per email; links that work
// once, for 30 minutes, and never end each other until one is used; a
// reset that ends every sign-in and still asks two-step's code; and a
// manager's password link — emailed and never shown when there is a
// sender, shown to pass on when there isn't.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { freshDb } from './helpers.js';
import { app } from '../index.js';
import { getDb } from '../db/client.js';
import { verifyChain } from '../lib/events.js';
import { base32Decode, totp } from '../lib/twostep.js';
import { _lastResetWork } from '../ext/passwords/reset.js';
import { startFakeMail } from './fake-mail.js';

const KEYS = ['MAIL_PROVIDER', 'MAIL_FROM', 'RESEND_API_KEY', 'RESEND_API_BASE', 'SENDGRID_API_KEY', 'STARBASE_PUBLIC_URL', 'BASE_PATH', 'STARBASE_DEMO_EMAIL', 'STARBASE_ENV'];
const env = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const PUBLIC = 'https://base.win/sample';
const PASSWORD = 'first-password-2026';

let ipSeq = 0;
// A browser: its cookies (sign-in and the code step's ticket) and an
// address of its own, so one test's tries don't count against another's.
class Browser {
  constructor() { this.jar = new Map(); this.ip = `203.0.113.${(ipSeq += 1) % 250}`; }
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
  signIn(email, password = PASSWORD) { return this.post('/api/auth/login', { email, password }); }
}

let mail, mgr, wsId, mgrId;
const people = {};
const sha = (s) => createHash('sha256').update(s).digest('hex');
const sender = (on) => {
  if (on) Object.assign(process.env, { RESEND_API_KEY: 're_test_key', RESEND_API_BASE: mail.url, MAIL_FROM: 'Sample Example <team@example.org>' });
  else delete process.env.RESEND_API_KEY;
};
// Ask for a link and wait for the work after the answer.
const forgot = async (email, b = new Browser()) => {
  const r = await b.post('/api/auth/forgot', { email });
  await _lastResetWork();
  return r;
};
const tokenOf = (m) => m.body.text.match(/#t=([0-9a-f]{64})/)?.[1];
const userEvents = async (id) => (await (await getDb()).query(
  "select action, payload, actor_id from events where entity_type = 'user' and entity_id = $1 order by seq", [id],
)).rows;

before(async () => {
  await freshDb();
  for (const k of KEYS) delete process.env[k];
  mail = await startFakeMail({ provider: 'resend' });
  process.env.STARBASE_PUBLIC_URL = PUBLIC;
  mgr = new Browser();
  const r = await mgr.post('/api/auth/signup', {
    name: 'Rae Example', email: 'rae@example.org', password: PASSWORD, workspaceName: 'Sample Campaign', jurisdiction: 'bc-municipal',
  });
  assert.equal(r.status, 201);
  wsId = r.json.workspace.id;
  mgrId = r.json.user.id;
  for (const [who, role] of [['sam', 'volunteer'], ['val', 'volunteer'], ['tess', 'staff'], ['moe', 'manager'], ['pat', 'volunteer'], ['ned', 'volunteer']]) {
    const inv = await mgr.action('member.invite', { email: `${who}@example.org`, role });
    const b = new Browser();
    const j = await b.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: `${who[0].toUpperCase()}${who.slice(1)} Example`, password: PASSWORD });
    assert.equal(j.status, 200, JSON.stringify(j.json));
    people[who] = { b, id: j.json.user.id, email: `${who}@example.org` };
  }
  sender(true);
});
after(async () => {
  for (const k of KEYS) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  await mail.close();
});

test('Forgot password: one email, its link built from STARBASE_PUBLIC_URL with the token in the fragment', async () => {
  const before0 = mail.sent.length;
  assert.equal((await new Browser().get('/api/auth/setup')).json.resetByEmail, true);
  const r = await forgot('sam@example.org');
  assert.deepEqual([r.status, r.json], [200, { ok: true }]);
  assert.equal(mail.sent.length, before0 + 1);
  const m = mail.sent.at(-1);
  assert.equal(m.to, 'sam@example.org');
  assert.equal(m.subject, 'Reset your password for Sample Campaign on base.win');
  assert.match(m.body.text, /^Someone asked to reset the password for this address on Sample Campaign’s base\.win\./);
  assert.match(m.body.text, new RegExp(`works once, for 30 minutes\\): ${PUBLIC.replace(/[./]/g, '\\$&')}/reset#t=[0-9a-f]{64}\\n`));
  assert.match(m.key, /^reset:[0-9a-f]{32}$/);
  // Only the hash is kept.
  const token = tokenOf(m);
  const rows = (await (await getDb()).query('select token_hash from password_resets where user_id = $1', [people.sam.id])).rows;
  assert.ok(rows.some((x) => x.token_hash === sha(token)));
  assert.ok(!rows.some((x) => x.token_hash === token));
  assert.equal(m.key, `reset:${sha(token).slice(0, 32)}`);

  // Under a client's path: the volunteers' app's Reset screen.
  process.env.BASE_PATH = '/sample';
  try {
    await forgot('val@example.org');
    assert.match(mail.sent.at(-1).body.text, new RegExp(`${PUBLIC.replace(/[./]/g, '\\$&')}/field/reset#t=[0-9a-f]{64}\\n`));
  } finally { delete process.env.BASE_PATH; }
});

test('Forgot password: the same answer and no email for an unknown address, base.win support, the demo’s account, no campaign, or no sender', async () => {
  const db = await getDb();
  await db.query("insert into users (id, email, name, password_hash, support) values (gen_random_uuid(), 'help@example.org', 'base.win support', 'none', true)");
  await db.query("insert into users (id, email, name, password_hash) values (gen_random_uuid(), 'nobody-here@example.org', 'Nora Example', 'x')");
  const n = mail.sent.length;
  for (const e of ['stranger@example.org', 'help@example.org', 'nobody-here@example.org']) {
    const r = await forgot(e);
    assert.deepEqual([r.status, r.json], [200, { ok: true }], e);
  }
  // The demo's account (a staging server: STARBASE_DEMO_EMAIL), and the
  // demo turns it off altogether.
  process.env.STARBASE_DEMO_EMAIL = 'pat@example.org';
  try {
    assert.equal((await new Browser().get('/api/auth/setup')).json.resetByEmail, false);
    assert.deepEqual((await forgot('pat@example.org')).json, { ok: true });
    assert.deepEqual((await forgot('ned@example.org')).json, { ok: true });
  } finally { delete process.env.STARBASE_DEMO_EMAIL; }
  sender(false);
  try {
    assert.equal((await new Browser().get('/api/auth/setup')).json.resetByEmail, false);
    assert.deepEqual((await forgot('ned@example.org')).json, { ok: true });
  } finally { sender(true); }
  assert.equal(mail.sent.length, n, 'nothing sent');
});

test('Forgot password: STARBASE_PUBLIC_URL unset → no email, never a link from the Host header', async () => {
  delete process.env.STARBASE_PUBLIC_URL;
  const n = mail.sent.length;
  try {
    const b = new Browser();
    assert.equal((await b.get('/api/auth/setup')).json.resetByEmail, false);
    const r = await b.req('POST', '/api/auth/forgot', { email: 'ned@example.org' });
    await _lastResetWork();
    assert.equal(r.status, 200);
    assert.equal(mail.sent.length, n);
  } finally { process.env.STARBASE_PUBLIC_URL = PUBLIC; }
});

test('Forgot password: Moe@Example.org and moe@example.org share one limit of 3 an hour', async () => {
  const n = mail.sent.length;
  for (const e of ['Moe@Example.org', ' moe@example.org ', 'MOE@example.org', 'moe@example.org']) {
    assert.deepEqual((await forgot(e)).json, { ok: true });
  }
  assert.equal(mail.sent.length - n, 3, 'the 4th ask in an hour sends nothing');
});

test('Forgot password: ten asks an hour from one address', async () => {
  const b = new Browser();
  const n = mail.sent.length;
  for (let i = 0; i < 10; i++) await forgot(`unknown${i}@example.org`, b);
  await forgot('pat@example.org', b);
  assert.equal(mail.sent.length, n, 'the 11th ask from one address sends nothing');
  await forgot('pat@example.org');
  assert.equal(mail.sent.length, n + 1, 'from another address it goes');
});

test('Checking a link: the email for a live one; 404 past 30 minutes and once used; no route takes the token in its path', async () => {
  const b = new Browser();
  const n = mail.sent.length;
  await forgot('val@example.org');
  assert.equal(mail.sent.length, n + 1);
  const token = tokenOf(mail.sent.at(-1));
  assert.deepEqual(await b.post('/api/auth/reset/check', { token }), { status: 200, json: { email: 'val@example.org' } });
  for (const bad of ['', 'x', token.toUpperCase(), `${token}0`, { t: token }]) {
    const r = await b.post('/api/auth/reset/check', { token: bad });
    assert.deepEqual([r.status, r.json.error], [404, 'That link has run out or was already used.']);
  }
  // Past 30 minutes.
  await (await getDb()).query("update password_resets set expires_at = now() - interval '1 second' where token_hash = $1", [sha(token)]);
  assert.equal((await b.post('/api/auth/reset/check', { token })).status, 404);
  assert.equal((await b.post('/api/auth/reset', { token, password: 'a-new-password-1' })).status, 404);
  // The routes: never ":token" on a reset path, never a GET with it.
  const src = readFileSync(new URL('../routes/auth.js', import.meta.url), 'utf8');
  for (const line of src.split('\n').filter((l) => /app\.\w+\(['"`]\/(reset|forgot)/.test(l))) {
    assert.ok(!/:token/.test(line) && /app\.post\(/.test(line), line);
  }
  assert.notEqual((await b.get(`/api/auth/reset/${token}`)).status, 200);
});

test('Using a link: the new password works and the old fails; every sign-in of that account ends, not another’s; on the log with no token', async () => {
  const db = await getDb();
  const sam = people.sam;
  // Signed in on two devices; Val too.
  const phone = new Browser();
  assert.equal((await phone.signIn('sam@example.org')).status, 200);
  assert.equal((await sam.b.get('/api/auth/me')).status, 200);
  const val = new Browser();
  assert.equal((await val.signIn('val@example.org')).status, 200);
  // Two live links (asked twice): both work until one is used (S14).
  await db.query('delete from password_resets where user_id = $1', [sam.id]);
  const n = mail.sent.length;
  await forgot('sam@example.org');
  await forgot('sam@example.org');
  assert.equal(mail.sent.length, n + 2);
  const [first, second] = mail.sent.slice(-2).map(tokenOf);
  const b = new Browser();
  assert.equal((await b.post('/api/auth/reset/check', { token: first })).status, 200);
  assert.equal((await b.post('/api/auth/reset/check', { token: second })).status, 200);
  // Too short: refused, and the link still works.
  const short = await b.post('/api/auth/reset', { token: second, password: 'short' });
  assert.deepEqual([short.status, short.json.error], [400, 'Choose a password of 8 or more characters.']);
  const r = await b.post('/api/auth/reset', { token: second, password: 'a-brand-new-one-2026' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.user.email, 'sam@example.org');
  assert.equal((await b.get('/api/auth/me')).status, 200, 'signed in here');
  // Both links are done.
  assert.equal((await b.post('/api/auth/reset/check', { token: first })).status, 404);
  assert.equal((await b.post('/api/auth/reset/check', { token: second })).status, 404);
  assert.equal((await b.post('/api/auth/reset', { token: first, password: 'another-one-2026' })).status, 404);
  // Signed out everywhere else; Val isn't.
  assert.equal((await phone.get('/api/auth/me')).status, 401);
  assert.equal((await sam.b.get('/api/auth/me')).status, 401);
  assert.equal((await val.get('/api/auth/me')).status, 200);
  // The old password fails, the new one works.
  assert.equal((await new Browser().signIn('sam@example.org')).status, 401);
  assert.equal((await new Browser().signIn('sam@example.org', 'a-brand-new-one-2026')).status, 200);
  // On the log: that it happened and how — no token, no hash.
  const ev = (await userEvents(sam.id)).filter((e) => e.action === 'auth.password.reset');
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0].payload, { password_reset: true, via: 'email link', made_by: null });
  assert.equal(ev[0].actor_id, sam.id);
  const all = JSON.stringify((await db.query('select payload from events')).rows);
  for (const t of [first, second, sha(first), sha(second)]) assert.ok(!all.includes(t), 'no token on the log');
  assert.equal((await verifyChain(db, wsId)).ok, true);
  people.sam.password = 'a-brand-new-one-2026';
});

test('Using a link with two-step sign-in on: the code step, then signed in', async () => {
  const b = new Browser();
  assert.equal((await b.signIn('tess@example.org')).status, 200);
  const start = await b.action('twostep.start');
  const key = start.json.setup.key;
  assert.equal((await b.action('twostep.confirm', { code: totp(base32Decode(key), Date.now()) })).status, 200);
  await (await getDb()).query('delete from password_resets where user_id = $1', [people.tess.id]);
  const n = mail.sent.length;
  await forgot('tess@example.org');
  assert.equal(mail.sent.length, n + 1);
  const c = new Browser();
  const r = await c.post('/api/auth/reset', { token: tokenOf(mail.sent.at(-1)), password: 'tess-new-pass-2026' });
  assert.deepEqual(r.json, { two_step: 'code' });
  assert.equal((await c.get('/api/auth/me')).status, 401, 'no session before the code');
  assert.equal((await b.get('/api/auth/me')).status, 401, 'the other sign-in ended');
  // The next step's code (the one just used for confirm can't be used again).
  const code = totp(base32Decode(key), Date.now() + 30_000);
  const signed = await c.post('/api/auth/login/code', { code });
  assert.equal(signed.status, 200, JSON.stringify(signed.json));
  assert.equal(signed.json.user.email, 'tess@example.org');
});

test('A reset is on the log of every campaign the account is in', async () => {
  const db = await getDb();
  const other = new Browser();
  const s = await other.post('/api/auth/signup', { name: 'Oli Example', email: 'oli@example.org', password: PASSWORD, workspaceName: 'Other Campaign', jurisdiction: 'bc-municipal' });
  const inv = await other.action('member.invite', { email: 'val@example.org', role: 'volunteer' });
  const j = await new Browser().post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], password: PASSWORD });
  assert.equal(j.status, 200, JSON.stringify(j.json));
  await db.query('delete from password_resets where user_id = $1', [people.val.id]);
  await forgot('val@example.org');
  // The email names the campaign they joined first.
  assert.equal(mail.sent.at(-1).subject, 'Reset your password for Sample Campaign on base.win');
  const r = await new Browser().post('/api/auth/reset', { token: tokenOf(mail.sent.at(-1)), password: 'val-new-pass-2026' });
  assert.equal(r.status, 200);
  const ev = (await db.query(
    "select workspace_id from events where action = 'auth.password.reset' and entity_id = $1 order by seq", [people.val.id],
  )).rows.map((x) => x.workspace_id);
  assert.deepEqual(ev.sort(), [wsId, s.json.workspace.id].sort());
  assert.equal((await verifyChain(db, s.json.workspace.id)).ok, true);
});

test('member.passwordLink: managers only; refused for yourself, a manager, support, another campaign’s member, the demo, and with no address', async () => {
  const db = await getDb();
  sender(false);
  try {
    // Not a manager.
    const staff = new Browser();
    await staff.signIn('tess@example.org', 'tess-new-pass-2026');
    // (tess has two-step on: a staffer's refusal is checked with a volunteer instead)
    const vol = new Browser();
    assert.equal((await vol.signIn('pat@example.org')).status, 200);
    assert.equal((await vol.action('member.passwordLink', { user_id: people.sam.id })).status, 403);
    assert.equal((await vol.get('/api/password-links')).status, 403);
    const refuse = async (userId, words) => {
      const r = await mgr.action('member.passwordLink', { user_id: userId });
      assert.equal(r.status, 409, JSON.stringify(r.json));
      assert.match(r.json.error, words);
    };
    await refuse(mgrId, /For your own, use Forgot your password\?/);
    await refuse(people.moe.id, /^A manager resets their own: Forgot your password\?$/);
    await refuse(people.val.id, /in another campaign on this server too/);
    const help = (await db.query("select id from users where email = 'help@example.org'")).rows[0].id;
    await db.query("insert into memberships (user_id, workspace_id, role) values ($1, $2, 'volunteer')", [help, wsId]);
    await refuse(help, /base\.win support has no password here/);
    process.env.STARBASE_DEMO_EMAIL = 'rae@example.org';
    try { await refuse(people.pat.id, /The demo can’t make password links/); } finally { delete process.env.STARBASE_DEMO_EMAIL; }
    delete process.env.STARBASE_PUBLIC_URL;
    try { await refuse(people.pat.id, /^Set the campaign’s address first \(STARBASE_PUBLIC_URL\)\.$/); } finally { process.env.STARBASE_PUBLIC_URL = PUBLIC; }
    const shown = await mgr.get('/api/password-links');
    assert.deepEqual({ ...shown.json, elsewhere: shown.json.elsewhere.length }, { on: true, address: true, email: false, elsewhere: 1 });
    assert.deepEqual(shown.json.elsewhere, [people.val.id]);
  } finally { sender(true); }
});

test('member.passwordLink without a sender: the link to pass on, for 24 hours; with one: emailed after the write, never shown', async () => {
  const db = await getDb();
  // Pat's own ask (above) is cleared, so the count below is the manager's.
  await db.query('delete from password_resets where user_id = $1', [people.pat.id]);
  sender(false);
  let link;
  try {
    const n = mail.sent.length;
    const r = await mgr.action('member.passwordLink', { user_id: people.pat.id });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    link = r.json.link;
    assert.match(link, new RegExp(`^${PUBLIC.replace(/[./]/g, '\\$&')}/reset#t=[0-9a-f]{64}$`));
    assert.equal(r.json.hours, 24);
    assert.equal(mail.sent.length, n);
    const row = (await db.query('select made_by, extract(epoch from expires_at - created_at)::int as secs from password_resets where token_hash = $1', [sha(link.split('#t=')[1])])).rows[0];
    assert.deepEqual(row, { made_by: mgrId, secs: 24 * 3600 });
  } finally { sender(true); }
  const n = mail.sent.length;
  const r = await mgr.action('member.passwordLink', { user_id: people.pat.id });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.emailed, true);
  assert.ok(!('link' in r.json), 'no link in the answer');
  assert.ok(!JSON.stringify(r.json).includes('#t='));
  assert.equal(mail.sent.length, n + 1);
  const m = mail.sent.at(-1);
  assert.equal(m.to, 'pat@example.org');
  assert.equal(m.subject, 'Choose a password for Sample Campaign on base.win');
  assert.match(m.body.text, /^Rae Example made you a link to choose a new password on Sample Campaign’s base\.win\.\n\nChoose one here \(works once, for 24 hours\): /);
  // The log: that a link was made, by whom — never the link.
  const ev = (await userEvents(people.pat.id)).filter((e) => e.action === 'member.passwordLink');
  assert.equal(ev.length, 2);
  assert.deepEqual(ev[0].payload, { password_link: true });
  assert.equal(ev[0].actor_id, mgrId);
  // A third, then the cap of 3 live links.
  assert.equal((await mgr.action('member.passwordLink', { user_id: people.pat.id })).status, 200);
  const capped = await mgr.action('member.passwordLink', { user_id: people.pat.id });
  assert.equal(capped.status, 409);
  assert.match(capped.json.error, /already has 3 links that still work/);
  // The manager's link sets a password; the log says it was a manager's.
  const used = await new Browser().post('/api/auth/reset', { token: link.split('#t=')[1], password: 'pat-chosen-2026' });
  assert.equal(used.status, 200);
  const reset = (await userEvents(people.pat.id)).filter((e) => e.action === 'auth.password.reset');
  assert.deepEqual(reset.at(-1).payload, { password_reset: true, via: 'manager link', made_by: mgrId });
  assert.equal((await verifyChain(db, wsId)).ok, true);
});

test('A JSON null body: /forgot gives the same answer, /reset/check says the link has run out (never a 500)', async () => {
  const b = new Browser();
  const raw = (path) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': b.ip }, body: 'null' });
  const f = await raw('/api/auth/forgot');
  assert.deepEqual([f.status, await f.json()], [200, { ok: true }]);
  const ch = await raw('/api/auth/reset/check');
  assert.deepEqual([ch.status, (await ch.json()).error], [404, 'That link has run out or was already used.']);
});

test('member.passwordLink whose email fails: 502, the link ended (not one of the 3 live), and the log says it wasn’t sent', async () => {
  const db = await getDb();
  await db.query('delete from password_resets where user_id = $1', [people.ned.id]);
  mail.fail(500);
  try {
    for (let i = 0; i < 4; i += 1) {
      const r = await mgr.action('member.passwordLink', { user_id: people.ned.id });
      assert.deepEqual([r.status, r.json.error], [502, 'The email to Ned Example didn’t go. Try again in a minute.']);
    }
  } finally { mail.fail(false); }
  const live = (await db.query('select count(*)::int as n from password_resets where user_id = $1 and used_at is null and expires_at > now()', [people.ned.id])).rows[0].n;
  assert.equal(live, 0, 'an unsent link still works');
  const ev = (await userEvents(people.ned.id)).filter((e) => e.action.startsWith('member.passwordLink'));
  assert.deepEqual(ev.slice(-2).map((e) => e.payload), [{ password_link: true }, { password_link: 'not sent' }]);
  // Mail back: the next one goes.
  const ok = await mgr.action('member.passwordLink', { user_id: people.ned.id });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal((await db.query('select count(*)::int as n from password_resets where user_id = $1 and used_at is null and expires_at > now()', [people.ned.id])).rows[0].n, 1);
  assert.equal((await verifyChain(db, wsId)).ok, true);
});

test('Password links are never in the export', async () => {
  const r = await mgr.get('/api/export');
  assert.ok(!JSON.stringify(r.json || {}).includes('password_resets'));
});
