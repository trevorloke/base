// Signing in once (ext/sso, lib/suite.js — SUITE.md "The hand-off"): base
// air and base web send the browser to /api/sso/authorize, get a one-time
// code back on their own address, and trade it from their server at
// /api/sso/token for who the person is. And GET /api/suite, the switcher's
// list of apps.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';
import { getDb } from '../db/client.js';
import { redirectOk } from '../lib/suite.js';
import { safeNext } from '@base-ground/shared/paths';

const tag = Math.random().toString(36).slice(2, 8);
const AIR = 'https://base.win/imaginesurrey/air';
const WEB = 'https://imaginesurrey.ca';
const AIR_SECRET = 'air-secret-0123456789abcdefghijklmnopqrstuvwxyz';
const WEB_SECRET = 'web-secret-0123456789abcdefghijklmnopqrstuvwxyz';
const AIR_CB = `${AIR}/auth/base/callback`;
const WEB_CB = `${WEB}/auth/base/callback`;
const KEYS = ['BASE_AIR_URL', 'BASE_AIR_SSO_SECRET', 'BASE_WEB_URL', 'BASE_WEB_SSO_SECRET', 'BASE_PATH', 'BASE_CLIENT', 'BASE_ORG_NAME', 'BASE_TRUSTED_PROXIES'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let mgr, staff, vol, volGranted, volId;

const setUp = () => Object.assign(process.env, {
  BASE_AIR_URL: AIR, BASE_AIR_SSO_SECRET: AIR_SECRET, BASE_WEB_URL: `${WEB}/`, BASE_WEB_SSO_SECRET: WEB_SECRET,
});
const join = async (inviter, email, role, name) => {
  const inv = await inviter.action('member.invite', { email, role });
  const c = new Client();
  const r = await c.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name, password: 'sso-pass-12345' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return [c, r.json.user.id];
};

before(async () => {
  for (const k of KEYS) delete process.env[k];
  setUp();
  await freshDb();
  mgr = new Client();
  await mgr.signup({ workspaceName: `SSO ${tag}`, email: `sso-mgr+${tag}@example.org`, name: 'Morgan Manager' });
  [staff] = await join(mgr, `sso-staff+${tag}@example.org`, 'staff', 'Sam Staff');
  [vol] = await join(mgr, `sso-vol+${tag}@example.org`, 'volunteer', 'Val Volunteer');
  let granted;
  [volGranted, granted] = await join(mgr, `sso-vol2+${tag}@example.org`, 'volunteer', 'Gale Granted');
  volId = granted;
  assert.equal((await mgr.action('permission.member.set', { user_id: granted, grant: ['outreach'] })).status, 200);
});
after(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

// Raw requests: the redirect itself, not where it leads.
const raw = (path, { cookie, method = 'GET', body, headers = {} } = {}) => app.request(path, {
  method,
  headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
  body: body ? JSON.stringify(body) : undefined,
});
const authorizeUrl = ({ app: a = 'air', redirect = AIR_CB, state = 'st-123' } = {}) =>
  `/api/sso/authorize?${new URLSearchParams({ app: a, redirect_uri: redirect, state })}`;
// Signed in → the code, from the redirect back to the app.
const codeFor = async (client, opts = {}) => {
  const res = await raw(authorizeUrl(opts), { cookie: client.cookie });
  assert.equal(res.status, 302, await res.clone().text());
  const to = new URL(res.headers.get('location'));
  return { to, code: to.searchParams.get('code'), state: to.searchParams.get('state') };
};
const token = (code, { redirect = AIR_CB, secret = AIR_SECRET, auth } = {}) => raw('/api/sso/token', {
  method: 'POST', body: { code, redirect_uri: redirect },
  headers: { authorization: auth ?? `Bearer ${secret}`, 'x-forwarded-for': `203.0.113.${Math.floor(Math.random() * 200)}` },
});
const grantRefused = async (res) => {
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'invalid_grant' }, 'no detail');
};

test('happy path: a manager opens base air signed in, once', async () => {
  process.env.BASE_ORG_NAME = 'Imagine Surrey';
  process.env.BASE_PATH = '/imaginesurrey';
  const res = await raw(`/imaginesurrey${authorizeUrl()}`, { cookie: mgr.cookie });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const to = new URL(res.headers.get('location'));
  assert.equal(`${to.origin}${to.pathname}`, AIR_CB, 'back to the app’s own callback');
  assert.equal(to.searchParams.get('state'), 'st-123');
  const code = to.searchParams.get('code');
  assert.match(code, /^[A-Za-z0-9_-]{43}$/, '32 random bytes, base64url');

  // Only its SHA-256 is kept.
  const db = await getDb();
  const kept = (await db.query('select code_hash, app, redirect_uri, expires_at - created_at as ttl from sso_codes')).rows;
  assert.ok(!JSON.stringify(kept).includes(code), 'never the code itself');
  assert.ok(kept.some((r) => r.code_hash === createHash('sha256').update(code).digest('hex') && r.app === 'air' && r.redirect_uri === AIR_CB));

  const r = await raw('/imaginesurrey/api/sso/token', { method: 'POST', body: { code, redirect_uri: AIR_CB }, headers: { authorization: `Bearer ${AIR_SECRET}` } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const who = await r.json();
  assert.deepEqual(Object.keys(who).sort(), ['areas', 'client', 'email', 'name', 'organization', 'role', 'sub']);
  assert.equal(typeof who.sub, 'string');
  assert.equal(who.sub, (await db.query('select id from users where email = $1', [who.email])).rows[0].id, 'sub: the user’s id here');
  assert.equal(who.email, `sso-mgr+${tag}@example.org`);
  assert.equal(who.name, 'Morgan Manager');
  assert.equal(who.role, 'manager');
  assert.ok(who.areas.includes('admin'));
  assert.equal(who.organization, 'Imagine Surrey');
  assert.equal(who.client, 'imaginesurrey', 'the last part of BASE_PATH');
  delete process.env.BASE_PATH;
  assert.equal((await raw(authorizeUrl(), { cookie: mgr.cookie })).status, 302, 'no prefix: at the root, as before');
  process.env.BASE_CLIENT = 'surrey-2026';
  const again = await codeFor(staff);
  const s = await (await token(again.code)).json();
  assert.equal(s.client, 'surrey-2026', 'BASE_CLIENT wins');
  assert.equal(s.role, 'staff');
  assert.notEqual(s.sub, who.sub, 'each person their own sub');
  const later = await (await token((await codeFor(mgr)).code)).json();
  assert.equal(later.sub, who.sub, 'the same person, the same sub, every time');
  delete process.env.BASE_CLIENT;
  delete process.env.BASE_ORG_NAME;
});

test('a code works once', async () => {
  const { code } = await codeFor(mgr);
  assert.equal((await token(code)).status, 200);
  await grantRefused(await token(code));
});

test('a code expires after 60 seconds', async () => {
  const { code } = await codeFor(mgr);
  const db = await getDb();
  await db.query("update sso_codes set expires_at = now() - interval '1 second' where code_hash = $1", [createHash('sha256').update(code).digest('hex')]);
  await grantRefused(await token(code));
  const fresh = await codeFor(mgr);
  const row = (await db.query('select extract(epoch from expires_at - created_at)::int as s from sso_codes where code_hash = $1',
    [createHash('sha256').update(fresh.code).digest('hex')])).rows[0];
  assert.equal(row.s, 60);
});

test('a code is bound to its app and its redirect_uri; the secret must be that app’s', async () => {
  // Made for air, presented with web's secret.
  const forAir = await codeFor(mgr);
  await grantRefused(await token(forAir.code, { secret: WEB_SECRET }));
  await grantRefused(await token(forAir.code, { secret: WEB_SECRET, redirect: WEB_CB }));
  // Another address under air's than the one it was made for.
  await grantRefused(await token(forAir.code, { redirect: `${AIR}/auth/base/other` }));
  // Wrong, missing and malformed secrets.
  await grantRefused(await token(forAir.code, { secret: `${AIR_SECRET}x` }));
  await grantRefused(await token(forAir.code, { secret: AIR_SECRET.slice(0, -1) }));
  await grantRefused(await token(forAir.code, { auth: '' }));
  await grantRefused(await token(forAir.code, { auth: AIR_SECRET }));
  // None of those spent it.
  assert.equal((await token(forAir.code)).status, 200);

  const forWeb = await codeFor(mgr, { app: 'web', redirect: WEB_CB });
  await grantRefused(await token(forWeb.code, { redirect: WEB_CB }));
  const ok = await token(forWeb.code, { redirect: WEB_CB, secret: WEB_SECRET });
  assert.equal(ok.status, 200);
  await grantRefused(await token('not-a-code'));
  await grantRefused(await raw('/api/sso/token', { method: 'POST', body: {}, headers: { authorization: `Bearer ${AIR_SECRET}` } }));
});

test('an app that isn’t set up is neither offered nor trusted', async () => {
  delete process.env.BASE_WEB_SSO_SECRET;
  const res = await raw(authorizeUrl({ app: 'web', redirect: WEB_CB }), { cookie: mgr.cookie });
  assert.equal(res.status, 400);
  assert.equal(res.headers.get('location'), null);
  assert.match(await res.text(), /base web isn’t set up/);
  // An empty secret matches nothing, even an empty Bearer.
  await grantRefused(await token('x', { auth: 'Bearer ' }));
  assert.equal((await raw(authorizeUrl({ app: 'nope' }), { cookie: mgr.cookie })).status, 400);
  setUp();
});

test('volunteers are refused; a volunteer given an area is let through', async () => {
  const res = await raw(authorizeUrl(), { cookie: vol.cookie });
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('location'), null);
  assert.match(await res.text(), /base air is for staff/);
  const { code } = await codeFor(volGranted);
  const who = await (await token(code)).json();
  assert.equal(who.role, 'volunteer');
  assert.deepEqual(who.areas, ['outreach']);
  // Made a plain volunteer between the two steps: the code is no good.
  const next = await codeFor(volGranted);
  assert.equal((await mgr.action('permission.member.set', { user_id: volId, grant: [], deny: [] })).status, 200);
  await grantRefused(await token(next.code));
});

test('not signed in: to the desk’s sign-in, and back to this same address after', async () => {
  process.env.BASE_PATH = '/imaginesurrey';
  const url = authorizeUrl({ state: 'abc' });
  const res = await raw(`/imaginesurrey${url}`);
  assert.equal(res.status, 302);
  const to = new URL(res.headers.get('location'), 'https://base.win');
  assert.equal(to.pathname, '/imaginesurrey/ground/login');
  const next = to.searchParams.get('next');
  assert.equal(next, `/imaginesurrey${url}`);
  assert.equal(safeNext(next, '/imaginesurrey'), next, 'the sign-in page will follow it');
  delete process.env.BASE_PATH;
});

test('redirect_uri must be the app’s own address — no way to send the code elsewhere', async () => {
  const bad = [
    'https://evil.example/auth/base/callback',
    `${AIR}`, // the app itself, not under it
    `${AIR}evil/callback`, // /airevil
    'https://base.win/imaginesurrey/airx/cb',
    'https://base.win/otherclient/air/auth/base/callback',
    `${AIR}/../../otherclient/air/cb`,
    `${AIR}/%2e%2e/%2e%2e/otherclient/air/cb`,
    `${AIR}/auth/..%2f..%2fx`,
    `${AIR}/cb#frag`,
    `${AIR}/cb\\@evil.example`,
    `https://user@base.win/imaginesurrey/air/cb`,
    'http://base.win/imaginesurrey/air/cb',
    'https://base.win.evil.example/imaginesurrey/air/cb',
    `//evil.example/imaginesurrey/air/cb`,
    'javascript:alert(1)//base.win/imaginesurrey/air/',
    '',
  ];
  for (const uri of bad) {
    assert.equal(redirectOk('air', uri), false, uri);
    const res = await raw(authorizeUrl({ redirect: uri }), { cookie: mgr.cookie });
    assert.equal(res.status, 400, uri);
    assert.equal(res.headers.get('location'), null, uri);
  }
  assert.equal(redirectOk('air', `${AIR}/auth/base/callback?x=1`), true);
  assert.equal(redirectOk('web', `${WEB}/auth/base/callback`), true);
  assert.equal(redirectOk('web', 'https://imaginesurrey.ca.evil.example/cb'), false);
  // A missing state is refused too.
  assert.equal((await raw(`/api/sso/authorize?app=air&redirect_uri=${encodeURIComponent(AIR_CB)}`, { cookie: mgr.cookie })).status, 400);
});

test('the sign-in page’s next: this app’s own paths only (no open redirect)', () => {
  const base = '/imaginesurrey';
  assert.equal(safeNext('/imaginesurrey/api/sso/authorize?app=air&redirect_uri=https%3A%2F%2Fx', base), '/imaginesurrey/api/sso/authorize?app=air&redirect_uri=https%3A%2F%2Fx');
  assert.equal(safeNext('/imaginesurrey/ground/people', base), '/imaginesurrey/ground/people');
  for (const next of [
    'https://evil.example/', '//evil.example/x', '/\\evil.example', '\\\\evil.example', 'javascript:alert(1)',
    '/otherclient/ground/', '/imaginesurreyx/ground', '/imaginesurrey/../otherclient/ground', '/imaginesurrey/%2e%2e/otherclient',
    '/imaginesurrey/\nx', 'evil.example', '', null, undefined, ' /imaginesurrey/ground',
  ]) assert.equal(safeNext(next, base), null, String(next));
  // No prefix (a laptop): any path on this site, still never another site.
  assert.equal(safeNext('/ground/', ''), '/ground/');
  assert.equal(safeNext('//evil.example', ''), null);
});

test('GET /api/suite: the apps this person may open', async () => {
  assert.equal((await new Client().get('/api/suite')).status, 401);
  process.env.BASE_PATH = '/imaginesurrey';
  const res = await raw('/imaginesurrey/api/suite', { cookie: mgr.cookie });
  const m = await res.json();
  delete process.env.BASE_PATH;
  assert.equal(m.client, 'imaginesurrey');
  assert.deepEqual(m.apps.map((a) => a.key), ['field', 'ground', 'air', 'web']);
  assert.equal(m.apps.find((a) => a.key === 'ground').href, '/ground/', 'the browser adds its prefix');
  assert.equal(m.apps.find((a) => a.key === 'air').href, `${AIR}/auth/base`);
  assert.equal(m.apps.find((a) => a.key === 'web').href, `${WEB}/auth/base`);
  assert.deepEqual((await vol.get('/api/suite')).json.apps.map((a) => a.key), ['field']);
  assert.deepEqual((await staff.get('/api/suite')).json.apps.map((a) => a.key), ['field', 'ground', 'air', 'web']);
  assert.equal((await mgr.action('permission.member.set', { user_id: volId, grant: ['people'] })).status, 200);
  assert.deepEqual((await volGranted.get('/api/suite')).json.apps.map((a) => a.key), ['field', 'ground', 'air', 'web'], 'an area makes them staff: the same people the hand-off lets through');
  delete process.env.BASE_AIR_SSO_SECRET;
  assert.deepEqual((await mgr.get('/api/suite')).json.apps.map((a) => a.key), ['field', 'ground', 'web'], 'not set up: not listed');
  setUp();
});

test('Settings → Services says whether air and web are connected — never the secret', async () => {
  const l = (await mgr.get('/api/connections')).json;
  const by = Object.fromEntries(l.services.map((s) => [s.key, s]));
  assert.equal(by.air.state, 'ready');
  assert.equal(by.web.state, 'ready');
  assert.ok(!JSON.stringify(l).includes(AIR_SECRET) && !JSON.stringify(l).includes(WEB_SECRET));
  process.env.BASE_AIR_SSO_SECRET = 'short';
  delete process.env.BASE_WEB_URL;
  const l2 = (await mgr.get('/api/connections')).json;
  const by2 = Object.fromEntries(l2.services.map((s) => [s.key, s]));
  assert.equal(by2.air.state, 'missing');
  assert.match(by2.air.detail, /short/);
  assert.deepEqual(by2.web.missing, ['BASE_WEB_URL']);
  setUp();
});
