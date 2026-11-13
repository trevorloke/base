// Sign in with Google (ext/google, lib/google/): the one route pair, the
// checks before anyone goes to Google and on the way back, signing in only
// by a link its owner made (never by email), two-step sign-in unchanged,
// the campaign's rules, the limits — and nothing about a Google account on
// the event log or in the export.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { app } from '../index.js';
import { getDb } from '../db/client.js';
import { mountAt } from '../lib/mount.js';
import { base32Decode, hotp, totpStep } from '../lib/twostep.js';
import { Browser, PUBLIC, CLIENT_ID, acct, join, restoreEnv, signup, startGoogle, tag, twoStepOn } from './google-helpers.js';

const A = Array.from({ length: 12 }, (_, i) => acct(i + 1));
A[2] = acct(3, { email: `bo.${tag}@campaign.example.org`, hd: 'campaign.example.org' });
A[3] = acct(4, { email: `cy.${tag}@campaign.example.org`, hd: null }); // the domain in the email, no hd
let fake, db, M, V, S;
const seen = { codes: [], states: [], nonces: [] };
const remember = (r) => { for (const k of ['code', 'state', 'nonce']) if (r[k]) seen[`${k}s`].push(r[k]); return r; };
const go = async (b, q, pick, o) => remember(await b.google(fake, q, pick, o));

before(async () => {
  db = await freshDb();
  fake = await startGoogle(A);
  M = await signup(`Google Campaign ${tag}`, `mo.${tag}@example.org`);
  V = await join(M.b, `val.${tag}@example.org`, 'volunteer', 'Val Example');
  S = await join(M.b, `sam.${tag}@example.org`, 'staff', 'Sam Example');
});
after(async () => { await fake.close(); restoreEnv(); });

test('setup: google only with the client and a usable public address; never the client id', async () => {
  const anon = new Browser();
  assert.equal((await anon.get('/api/auth/setup')).json.google, true);
  const id = process.env.GOOGLE_OAUTH_CLIENT_ID;
  delete process.env.GOOGLE_OAUTH_CLIENT_ID;
  assert.equal((await anon.get('/api/auth/setup')).json.google, false);
  process.env.GOOGLE_OAUTH_CLIENT_ID = id;
  process.env.NODE_ENV = 'production';
  try {
    // http://localhost is fine on a laptop, never in production; and the
    // test addresses are ignored there.
    assert.equal((await anon.get('/api/auth/setup')).json.google, false);
    process.env.STARBASE_PUBLIC_URL = 'https://base.example.org';
    assert.equal((await anon.get('/api/auth/setup')).json.google, true);
    const { accountsBase, oauthBase } = await import('../lib/google/config.js');
    assert.equal(accountsBase(), 'https://accounts.google.com');
    assert.equal(oauthBase(), 'https://oauth2.googleapis.com');
  } finally {
    delete process.env.NODE_ENV;
    process.env.STARBASE_PUBLIC_URL = PUBLIC;
  }
  for (const r of [await anon.get('/api/auth/setup'), await M.b.get('/api/auth/me'), await M.b.get('/api/google')]) {
    assert.ok(!JSON.stringify(r.json).includes(CLIENT_ID), 'the client id is in no answer');
  }
});

test('start: only the flows, apps and purposes it knows; a bad back falls back to the app’s profile', async () => {
  const b = new Browser();
  assert.equal((await b.send('GET', '/api/auth/google/start?do=join')).status, 400, 'there is no Google join');
  assert.equal((await b.send('GET', '/api/auth/google/start?do=signin&app=phone')).status, 400);
  assert.equal((await b.send('GET', '/api/auth/google/start?do=connect&for=nothing.here')).status, 400);
  // Not signed in: refused back to where it came from — the desk's profile
  // when the back address isn't one of the app's.
  for (const back of ['https://evil.example.org/x', '//evil.example.org', '/admin//profile', '/Admin/Profile']) {
    const r = await b.send('GET', `/api/auth/google/start?do=link&app=desk&back=${encodeURIComponent(back)}`);
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/admin/profile?google=expired', back);
  }
  const ok = await b.send('GET', '/api/auth/google/start?do=link&app=field&back=/people/x_1');
  assert.equal(ok.headers.get('location'), '/people/x_1?google=expired');
});

test('the flow cookie is Lax, httpOnly and only the state; back says no-store and no-referrer; a flow works once', async () => {
  const b = new Browser();
  const start = await b.send('GET', '/api/auth/google/start?do=signin&app=desk');
  const at = new URL(start.headers.get('location'));
  assert.equal(at.origin, fake.base);
  assert.equal(at.searchParams.get('prompt'), 'select_account');
  assert.equal(at.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(at.searchParams.get('scope'), 'openid email profile');
  assert.equal(at.searchParams.get('redirect_uri'), `${PUBLIC}/api/auth/google/back`);
  const flowCookie = b.raw.find((c) => c.startsWith('mv2_google='));
  assert.match(flowCookie, /SameSite=Lax/i);
  assert.match(flowCookie, /HttpOnly/i);
  assert.equal(flowCookie.split(';')[0], `mv2_google=${at.searchParams.get('state')}`);
  assert.ok(start.headers.get('location').startsWith('http'), 'only Google is a whole address');
  // Back, for an account nobody linked.
  const backUrl = new URL(fake.authorize(start.headers.get('location'), A[0].sub));
  const saved = new Map(b.jar);
  const back = await b.send('GET', `${backUrl.pathname}${backUrl.search}`);
  assert.equal(back.headers.get('cache-control'), 'no-store');
  assert.equal(back.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(back.headers.get('location'), '/admin/login?google=no-account');
  // The same return again, cookie and all: used up.
  b.jar = saved;
  const again = await b.send('GET', `${backUrl.pathname}${backUrl.search}`);
  assert.equal(again.headers.get('location'), '/login?google=expired');
  // A state that isn't the cookie's, or no cookie at all.
  const c = new Browser();
  const s2 = await c.send('GET', '/api/auth/google/start?do=signin');
  const u2 = new URL(fake.authorize(s2.headers.get('location'), A[0].sub));
  u2.searchParams.set('state', 'not-the-state');
  assert.equal((await c.send('GET', `${u2.pathname}${u2.search}`)).headers.get('location'), '/login?google=expired');
  const d = new Browser();
  const s3 = await d.send('GET', '/api/auth/google/start?do=signin');
  const u3 = new URL(fake.authorize(s3.headers.get('location'), A[0].sub));
  d.jar.clear();
  assert.equal((await d.send('GET', `${u3.pathname}${u3.search}`)).headers.get('location'), '/login?google=expired');
});

test('the ID token: wrong aud, nonce, iss, or expired — each refused', async () => {
  const b = new Browser();
  for (const knob of ['wrong_aud', 'wrong_nonce', 'wrong_iss', 'expired']) {
    fake.next('token', knob);
    const r = await go(b, { do: 'signin' }, A[0].sub);
    assert.equal(r.google, 'unavailable', knob);
  }
});

test('Google’s own refusals: Cancel, a Workspace admin’s block', async () => {
  const b = new Browser();
  assert.equal((await go(b, { do: 'signin' }, { cancel: true })).google, 'cancelled');
  fake.next('auth', 'admin_policy_enforced');
  assert.equal((await go(b, { do: 'signin' }, A[0].sub)).google, 'blocked');
});

test('never by email: a Google account with the same address as an account, not linked → no-account; nothing written', async () => {
  const same = acct(20, { email: M.email });
  const work = acct(21, { email: S.email, hd: 'example.org' });
  fake.account(same); fake.account(work);
  const b = new Browser();
  assert.equal((await go(b, { do: 'signin', app: 'desk' }, same.sub)).google, 'no-account');
  assert.equal((await go(b, { do: 'signin' }, work.sub)).google, 'no-account');
  assert.equal(b.jar.has('mv2_session'), false);
  const n = (await db.query('select count(*)::int as n from google_logins where sub = any($1)', [[same.sub, work.sub]])).rows[0].n;
  assert.equal(n, 0);
});

test('link on Your profile, then sign in with Google: the desk for a manager, the field app for a volunteer', async () => {
  const r = await go(M.b, { do: 'link', app: 'desk', back: '/admin/profile' }, A[0].sub);
  assert.equal(r.location, '/admin/profile?google=linked');
  assert.equal(new URL(r.at).searchParams.get('login_hint'), M.email);
  const me = await M.b.get('/api/auth/me');
  assert.deepEqual(me.json.google, { on: true, linked: true, email: A[0].email });
  // A different email from the account's is fine.
  assert.equal((await go(V.b, { do: 'link', back: '/profile' }, A[1].sub)).google, 'linked');

  const desk = new Browser();
  const d = await go(desk, { do: 'signin', app: 'desk' }, A[0].sub);
  assert.equal(d.location, '/admin');
  const session = desk.raw.find((c) => c.startsWith('mv2_session='));
  assert.match(session, /SameSite=Strict/i);
  assert.equal((await desk.get('/api/auth/me')).json.user.id, M.id);
  const used = (await db.query('select last_used_at from google_logins where user_id = $1', [M.id])).rows[0];
  assert.ok(used.last_used_at);
  const field = new Browser();
  assert.equal((await go(field, { do: 'signin' }, A[1].sub)).location, '/');
  assert.equal((await field.get('/api/auth/me')).json.role, 'volunteer');
});

test('a refused or cancelled sign-in writes nothing', async () => {
  const before = (await db.query('select last_used_at from google_logins where user_id = $1', [V.id])).rows[0].last_used_at;
  const b = new Browser();
  await go(b, { do: 'signin' }, { cancel: true });
  fake.next('token', 'wrong_nonce');
  await go(b, { do: 'signin' }, A[1].sub);
  const after = (await db.query('select last_used_at from google_logins where user_id = $1', [V.id])).rows[0].last_used_at;
  assert.equal(String(after), String(before));
});

test('taken: one Google account links to one person, and a person to one Google account', async () => {
  assert.equal((await go(S.b, { do: 'link' }, A[0].sub)).google, 'taken');
  assert.equal((await go(M.b, { do: 'link', app: 'desk', back: '/admin/profile' }, A[4].sub)).google, 'taken');
});

test('a user in two campaigns lands in the first, as a password sign-in does; removed → removed', async () => {
  const other = await signup(`Other Campaign ${tag}`, `oz.${tag}@example.org`);
  const inv = await other.b.action('member.invite', { email: V.email, role: 'staff' });
  const joined = await new Browser().post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], password: 'google-2026-pass' });
  assert.equal(joined.status, 200);
  const b = new Browser();
  await go(b, { do: 'signin' }, A[1].sub);
  assert.equal((await b.get('/api/auth/me')).json.workspace.id, M.ws);

  const gone = await join(M.b, `gone.${tag}@example.org`, 'volunteer');
  assert.equal((await go(gone.b, { do: 'link' }, A[5].sub)).google, 'linked');
  assert.equal((await M.b.action('member.remove', { user_id: gone.id })).status, 200);
  assert.equal((await go(new Browser(), { do: 'signin' }, A[5].sub)).google, 'removed');
});

test('two-step on: Google leads to the code step; the code signs in; five wrong codes → sign in again', async () => {
  const t = await join(M.b, `tess.${tag}@example.org`, 'staff');
  const key = await twoStepOn(t.b);
  assert.equal((await go(t.b, { do: 'link' }, A[6].sub)).google, 'linked');
  const b = new Browser();
  const r = await go(b, { do: 'signin' }, A[6].sub);
  assert.equal(r.location, '/login?step=code');
  assert.ok(b.jar.has('mv2_two_step'));
  assert.equal(b.jar.has('mv2_session'), false);
  assert.equal((await b.get('/api/auth/me')).status, 401);
  assert.equal((await db.query('select last_used_at from google_logins where user_id = $1', [t.id])).rows[0].last_used_at, null);
  const step = totpStep(Date.now());
  const last = (await db.query('select last_step from two_step where user_id = $1', [t.id])).rows[0].last_step;
  const code = hotp(base32Decode(key), Math.max(step, Number(last) + 1));
  const ok = await b.post('/api/auth/login/code', { code });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.user.id, t.id);
  assert.ok((await db.query('select last_used_at from google_logins where user_id = $1', [t.id])).rows[0].last_used_at);

  const c = new Browser();
  await go(c, { do: 'signin' }, A[6].sub);
  let w;
  for (let i = 0; i < 5; i++) w = await c.post('/api/auth/login/code', { code: '000000' });
  assert.equal(w.json.two_step, 'again');
});

test('two-step required and not set up: the session is made, the API asks for set-up, and linking waits', async () => {
  const w = await signup(`Strict Campaign ${tag}`, `sy.${tag}@example.org`);
  assert.equal((await go(w.b, { do: 'link', app: 'desk', back: '/admin/profile' }, A[7].sub)).google, 'linked');
  await db.query(`update workspaces set settings = settings || '{"twoStepRequired": true}'::jsonb where id = $1`, [w.ws]);
  const b = new Browser();
  assert.equal((await go(b, { do: 'signin', app: 'desk' }, A[7].sub)).location, '/admin');
  const api = await b.get('/api/persons');
  assert.equal(api.status, 401);
  assert.equal(api.json.two_step, 'set_up');
  assert.equal((await go(b, { do: 'link', app: 'desk', back: '/admin/profile' }, A[7].sub)).google, 'two-step-first');
});

test('join: never without a password; every account has one', async () => {
  const inv = await M.b.action('member.invite', { email: `nopass.${tag}@example.org`, role: 'volunteer' });
  const token = inv.json.joinUrl.split('/join/')[1];
  assert.equal((await new Browser().post('/api/auth/join', { token, name: 'No Pass' })).status, 400);
  assert.equal((await new Browser().post('/api/auth/join', { token, name: 'No Pass', password: '' })).status, 400);
});

test('unlink ends your other sessions; a manager’s unlink signs them out, managers only, not across campaigns', async () => {
  const u = await join(M.b, `ula.${tag}@example.org`, 'volunteer');
  assert.equal((await go(u.b, { do: 'link' }, A[8].sub)).google, 'linked');
  const elsewhere = new Browser();
  await go(elsewhere, { do: 'signin' }, A[8].sub);
  assert.equal((await elsewhere.get('/api/auth/me')).status, 200);
  const un = await u.b.action('google.unlink');
  assert.equal(un.status, 200, JSON.stringify(un.json));
  assert.equal((await elsewhere.get('/api/auth/me')).status, 401);
  assert.equal((await u.b.get('/api/auth/me')).status, 200, 'this one stays signed in');
  assert.equal((await go(new Browser(), { do: 'signin' }, A[8].sub)).google, 'no-account');

  const k = await join(M.b, `kai.${tag}@example.org`, 'volunteer');
  assert.equal((await go(k.b, { do: 'link' }, A[9].sub)).google, 'linked');
  // Team's chip: who signs in with Google, and who is in another campaign here too.
  const members = (await M.b.get('/api/google/members')).json;
  assert.deepEqual(members.find((x) => x.user_id === k.id), { user_id: k.id, elsewhere: false });
  assert.deepEqual(members.find((x) => x.user_id === V.id), { user_id: V.id, elsewhere: true });
  assert.ok(members.every((x) => Object.keys(x).join() === 'user_id,elsewhere'), 'no Google email');
  assert.equal((await S.b.get('/api/google/members')).status, 403);
  assert.equal((await S.b.action('google.unlinkMember', { user_id: k.id })).status, 403);
  assert.equal((await M.b.action('google.unlinkMember', { user_id: k.id })).status, 200);
  assert.equal((await k.b.get('/api/auth/me')).status, 401);
  assert.equal((await db.query('select 1 from google_logins where user_id = $1', [k.id])).rows.length, 0);
  // Val belongs to another campaign too (above): theirs to unlink.
  const both = await M.b.action('google.unlinkMember', { user_id: V.id });
  assert.equal(both.status, 409);
  assert.match(both.json.error, /another campaign on this server too/);
});

test('the campaign’s rules: off (password still works), only our domain, and a manager’s own link first', async () => {
  const w = await signup(`Rules Campaign ${tag}`, `ru.${tag}@example.org`);
  const p = await join(w.b, `pat.${tag}@example.org`, 'volunteer');
  assert.equal((await go(p.b, { do: 'link' }, A[10].sub)).google, 'linked');
  // Only our domain: refused until the manager's own link is at it.
  const refused = await w.b.action('google.settings', { domain: 'Campaign.Example.org' });
  assert.equal(refused.status, 409);
  assert.equal(refused.json.error, 'Link your own Google account at campaign.example.org first (Your profile)');
  assert.equal((await go(w.b, { do: 'link', app: 'desk', back: '/admin/profile' }, A[2].sub)).google, 'linked');
  assert.equal((await w.b.action('google.settings', { domain: 'campaign.example.org' })).status, 200);
  assert.equal((await go(new Browser(), { do: 'signin' }, A[10].sub)).google, 'domain');
  assert.equal((await go(new Browser(), { do: 'signin', app: 'desk' }, A[2].sub)).location, '/admin');
  // The domain in an email without Google's hd doesn't count — to link either.
  const q = await join(w.b, `quin.${tag}@example.org`, 'volunteer');
  assert.equal((await go(q.b, { do: 'link' }, A[3].sub)).google, 'domain');
  assert.equal((await new Browser().signIn(p.email)).status, 200, 'password sign-in unaffected');
  assert.equal((await w.b.action('google.settings', { domain: 'nonsense' })).status, 400);
  // Off: the button goes, links stay, passwords work.
  assert.equal((await w.b.action('google.settings', { signin: false, domain: null })).status, 200);
  assert.equal((await go(new Browser(), { do: 'signin' }, A[10].sub)).google, 'off');
  assert.equal((await go(q.b, { do: 'link' }, A[11].sub)).google, 'off');
  assert.equal((await new Browser().signIn(p.email)).status, 200);
  assert.equal((await db.query('select 1 from google_logins where user_id = $1', [p.id])).rows.length, 1);
  // Ten refusals for one account, then a wait — never for the password.
  const b = new Browser();
  // (the domain and off refusals above count too)
  for (let i = 0; i < 8; i++) assert.equal((await go(b, { do: 'signin' }, A[10].sub)).google, 'off');
  assert.equal((await go(b, { do: 'signin' }, A[10].sub)).google, 'too-many');
  assert.equal((await new Browser().signIn(p.email)).status, 200);
  const ev = (await db.query("select action, payload from events where workspace_id = $1 and action like 'google.%' order by seq", [w.ws])).rows;
  assert.deepEqual(ev.map((e) => e.action), ['google.link', 'google.link', 'google.settings', 'google.settings']);
});

test('limits: 25 round trips are fine, the 61st start is not; 21 failed returns wait without calling Google', async () => {
  const b = new Browser();
  for (let i = 0; i < 25; i++) assert.equal((await go(b, { do: 'signin' }, A[0].sub)).location, '/');
  for (let i = 0; i < 35; i++) assert.equal((await b.send('GET', '/api/auth/google/start?do=signin')).status, 302);
  assert.equal((await b.send('GET', '/api/auth/google/start?do=signin')).headers.get('location'), '/login?google=too-many');
  const c = new Browser();
  const tokens = fake.counts.token;
  for (let i = 0; i < 20; i++) {
    const r = await c.send('GET', `/api/auth/google/back?state=wrong-${i}&code=x`);
    assert.equal(r.headers.get('location'), '/login?google=expired');
  }
  assert.equal((await c.send('GET', '/api/auth/google/back?state=wrong&code=x')).headers.get('location'), '/login?google=too-many');
  assert.equal(fake.counts.token, tokens);
});

test('the right address: signing in elsewhere goes to the public one; linking there is refused', async () => {
  const b = new Browser({ origin: 'http://127.0.0.1' });
  const r = await b.send('GET', '/api/auth/google/start?do=signin&app=desk');
  assert.equal(r.headers.get('location'), `${PUBLIC}/api/auth/google/start?do=signin&app=desk`);
  M.b.origin = 'http://127.0.0.1';
  const l = await M.b.send('GET', '/api/auth/google/start?do=link&app=desk&back=/admin/profile');
  M.b.origin = PUBLIC;
  assert.equal(l.headers.get('location'), '/admin/profile?google=wrong-address');
});

test('under BASE_PATH: paths and cookies under the client’s path, the return at /imaginesurrey/desk/', async () => {
  const fetch = mountAt(app, '/imaginesurrey');
  process.env.STARBASE_PUBLIC_URL = `${PUBLIC}/imaginesurrey`;
  try {
    const b = new Browser({ fetch: (url, init) => fetch(new Request(url, init)), origin: PUBLIC });
    const s = await b.send('GET', '/imaginesurrey/api/auth/google/start?do=signin&app=desk');
    const at = s.headers.get('location');
    assert.equal(new URL(at).searchParams.get('redirect_uri'), `${PUBLIC}/imaginesurrey/api/auth/google/back`);
    const back = new URL(fake.authorize(at, A[0].sub));
    const done = await b.send('GET', `${back.pathname}${back.search}`);
    assert.equal(done.headers.get('location'), '/imaginesurrey/desk/');
    for (const c of b.raw.filter((x) => /^mv2_(google|session)=/.test(x))) assert.match(c, /Path=\/imaginesurrey(;|$)/, c);
    const anon = new Browser({ fetch: (url, init) => fetch(new Request(url, init)), origin: PUBLIC });
    const refused = await anon.send('GET', '/imaginesurrey/api/auth/google/start?do=link&app=desk');
    assert.equal(refused.headers.get('location'), '/imaginesurrey/desk/profile?google=expired');
  } finally {
    process.env.STARBASE_PUBLIC_URL = PUBLIC;
  }
});

test('the event log: link, unlink and settings on it; nothing about a Google account; sign-in adds nothing', async () => {
  const before = (await db.query('select count(*)::int as n from events where workspace_id = $1', [M.ws])).rows[0].n;
  await go(new Browser(), { do: 'signin' }, A[1].sub);
  assert.equal((await db.query('select count(*)::int as n from events where workspace_id = $1', [M.ws])).rows[0].n, before);
  const logins = (await db.query(
    "select e.payload from events e join workspaces w on w.id = e.workspace_id where e.entity_type = 'google_login' and w.name like $1",
    [`%${tag}%`],
  )).rows.map((r) => r.payload);
  assert.ok(logins.length >= 5);
  for (const p of logins) assert.ok(JSON.stringify(p) === '{}' || JSON.stringify(p) === '{"by":"manager"}', JSON.stringify(p));
  const all = (await db.query(
    'select e.payload from events e join workspaces w on w.id = e.workspace_id where w.name like $1', [`%${tag}%`],
  )).rows.map((r) => JSON.stringify(r.payload)).join('\n');
  const secrets = [...A.map((a) => a.sub), ...A.slice(0, 3).map((a) => a.email), ...seen.codes, ...seen.states, ...seen.nonces, ...fake.tokens()];
  for (const s of secrets) assert.ok(!all.includes(s), `on the log: ${s.slice(0, 12)}…`);
});

test('the export has no Google table; every account’s password is a real hash', async () => {
  const exp = await M.b.get('/api/export');
  assert.equal(exp.status, 200);
  for (const t of ['google_flows', 'google_logins', 'google_grants']) assert.ok(!(t in exp.json), t);
  const hashes = (await db.query('select password_hash from users')).rows;
  for (const h of hashes) assert.match(h.password_hash, /^scrypt:/);
});
