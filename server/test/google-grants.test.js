// Google connections (lib/google/tokens.js, purposes.js; ext/google): the
// plumbing Gmail, Drive and Calendar build on, with purposes of the test's
// own. Connecting, refusals that leave nothing at Google, grants that
// follow role changes, googleFetch's refusals and pauses, narrowToken,
// disconnecting and revoking (never a Google account another row holds),
// clean-up before a revoke, and the pinned event payload.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { EXTENSIONS } from '../ext.js';
import { ACTIONS } from '../actions/index.js';
import { areaOfAction } from '../lib/perms.js';
import { runAction } from '../lib/events.js';
import { registerJob, runDueJobs } from '../lib/jobs.js';
import { definePurpose } from '../lib/google/purposes.js';
import { openToken, sealToken } from '../lib/google/seal.js';
import { _resetPausesForTest, _setTokenTimeoutForTest, tokenPaused } from '../lib/google/flow.js';
import {
  _resetTokensForTest, dropPurpose, googleFetch, grantFor, markReconnect, narrowToken, revokeIfUnshared,
} from '../lib/google/tokens.js';
import { Browser, TOKEN_KEY, acct, join, restoreEnv, signup, startGoogle, tag } from './google-helpers.js';

const SCOPE = (s) => `https://www.googleapis.com/auth/test.${s}`;
const cleaned = [];
definePurpose('test.purpose', { label: 'Test purpose', scopes: [SCOPE('read')], roles: ['manager', 'treasurer', 'staff'], area: 'outreach' });
definePurpose('test.other', { label: 'Test other', scopes: [SCOPE('other')], roles: ['manager', 'treasurer', 'staff', 'volunteer'], area: null });
definePurpose('test.domain', { label: 'Test domain', scopes: [SCOPE('dom')], roles: ['manager', 'staff', 'volunteer'], area: null, domain: () => 'campaign.example.org' });
definePurpose('test.browser', { label: 'Test browser', scopes: [SCOPE('pick'), SCOPE('read')], roles: ['manager', 'staff', 'volunteer'], area: null, browserToken: true });
definePurpose('test.clean', {
  label: 'Test clean', scopes: [SCOPE('cal')], roles: ['manager', 'staff', 'volunteer'], area: null, ownCard: true,
  onRevoke: async (db, { userId, workspaceId, fetch }) => {
    cleaned.push({ userId, workspaceId, fetch: Boolean(fetch), revokesSoFar: fake.counts.revoke });
    if (fetch) {
      const r = await fetch(`${fake.base}/test-api/calendars/delete`, { method: 'POST' });
      assert.equal(r.status, 200);
    }
  },
});
registerJob('test.google.fetch', async (db, job) => {
  const g = await grantFor(db, job.payload, 'test.other');
  const r = await googleFetch(db, g, `${fake.base}/test-api/job`);
  if (r.trouble?.code !== 'reconnect') throw new Error(`expected reconnect, got ${JSON.stringify(r.trouble)}`);
});
registerJob('test.google.drop', async (db, job) => {
  const g = await grantFor(db, job.payload, 'test.other');
  await dropPurpose(db, { workspaceId: job.payload.workspaceId, actorId: null }, g, 'test.other');
});

const A = Array.from({ length: 24 }, (_, i) => acct(i + 1));
A[1] = acct(2, { email: `bo.${tag}@campaign.example.org`, hd: 'campaign.example.org' });
let fake, db, M, S, T;
const api = (path = 'x') => `${fake.base}/test-api/${path}`;
const connect = (b, purpose, pick, extra = {}) => b.google(fake, { do: 'connect', for: purpose, app: 'field', back: '/profile', ...extra }, pick);
const grantRow = async (userId) => (await db.query('select * from google_grants where user_id = $1', [userId])).rows[0] || null;
const jobs = () => runDueJobs(db, { workspaceId: M.ws });
const events = async (type, ws = M.ws) => (await db.query(
  'select action, entity_id, op, payload, actor_id from events where workspace_id = $1 and entity_type = $2 order by seq', [ws, type],
)).rows;

before(async () => {
  db = await freshDb();
  fake = await startGoogle(A);
  M = await signup(`Grants Campaign ${tag}`, `mo.${tag}@example.org`);
  S = await join(M.b, `sam.${tag}@example.org`, 'staff', 'Sam Example');
  T = await join(M.b, `tia.${tag}@example.org`, 'staff', 'Tia Example');
});
beforeEach(() => { fake.clearKnobs(); _resetPausesForTest(); _resetTokensForTest(); process.env.GOOGLE_TOKEN_KEY = TOKEN_KEY; });
after(async () => { _setTokenTimeoutForTest(8000); await fake.close(); restoreEnv(); });

test('boot: a purpose must say its roles, area and scopes; one route pair; one google_grants', () => {
  assert.throws(() => definePurpose('test.noroles', { label: 'x', scopes: [SCOPE('x')], area: null }), /needs roles/);
  assert.throws(() => definePurpose('test.noarea', { label: 'x', scopes: [SCOPE('x')], roles: ['staff'] }), /needs an area/);
  assert.throws(() => definePurpose('test.badrole', { label: 'x', scopes: [SCOPE('x')], roles: ['owner'], area: null }), /unknown role/);
  assert.throws(() => definePurpose('test.noscope', { label: 'x', scopes: [], roles: ['staff'], area: null }), /needs scopes/);
  assert.throws(() => definePurpose('test.purpose', { label: 'x', scopes: [SCOPE('x')], roles: ['staff'], area: null }), /defined twice/);
  const routes = EXTENSIONS.flatMap((e) => [...(e.publicRoutes?.routes || []), ...(e.api?.routes || []).map((r) => ({ ...r, path: `/api${r.path}` }))]);
  const google = [...new Set(routes.map((r) => r.path).filter((p) => p.startsWith('/api/auth/google/')))].sort();
  assert.deepEqual(google, ['/api/auth/google/back', '/api/auth/google/start']);
  assert.ok(!routes.some((r) => /^\/api\/google\/(connect|back)/.test(r.path)));
  assert.equal(EXTENSIONS.filter((e) => /create table if not exists google_grants\b/.test(e.sql || '')).length, 1);
});

test('every google.* action: no area and only your own, or managers only', () => {
  const names = Object.keys(ACTIONS).filter((n) => n.startsWith('google.'));
  assert.deepEqual(names.sort(), ['google.disconnect', 'google.forget', 'google.settings', 'google.unlink', 'google.unlinkMember']);
  for (const n of names) {
    const a = ACTIONS[n];
    const managerOnly = a.roles.length === 1 && a.roles[0] === 'manager';
    assert.equal(areaOfAction(n), null, n);
    if (!managerOnly) assert.ok(!('user_id' in (a.input.shape || {})), `${n} acts only on the caller`);
  }
});

test('connect: the refresh token sealed (never plain), only the purpose’s own scopes asked for', async () => {
  const r = await connect(S.b, 'test.other', A[0].sub);
  assert.equal(r.location, '/profile?google=connected');
  const at = new URL(r.at).searchParams;
  assert.equal(at.get('scope'), `openid email ${SCOPE('other')}`);
  assert.equal(at.get('prompt'), 'consent');
  assert.equal(at.get('access_type'), 'offline');
  assert.equal(at.get('include_granted_scopes'), 'true');
  const row = await grantRow(S.id);
  assert.deepEqual(row.purposes, ['test.other']);
  assert.equal(row.state, 'ok');
  assert.ok(openToken(row.refresh_sealed));
  const dump = JSON.stringify(row);
  for (const t of fake.tokens()) assert.ok(!dump.includes(t));
  const ev = await events('google_grant');
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0].payload, { holder: 'user', user_id: S.id, purposes: ['test.other'], state: 'ok' });
  assert.equal(ev[0].actor_id, S.id);
  assert.equal(ev[0].action, 'google.connect');
});

test('no GOOGLE_TOKEN_KEY: connecting is refused before any call to Google', async () => {
  delete process.env.GOOGLE_TOKEN_KEY;
  fake.resetCounts();
  const s = await S.b.send('GET', '/api/auth/google/start?do=connect&for=test.other&back=/profile');
  assert.equal(s.headers.get('location'), '/profile?google=not-set-up');
  assert.deepEqual(Object.values(fake.counts).reduce((a, b) => a + b, 0), 0);
  // Sign-in still works without it.
  assert.equal((await S.b.get('/api/google')).json.setup.signin, true);
});

test('each refusal after the exchange stores nothing and revokes what Google handed over, once', async () => {
  const u = await join(M.b, `ref.${tag}@example.org`, 'staff');
  const cases = [
    ['missing-scope', () => fake.next('token', 'partial_scope'), 'test.other', A[2].sub],
    ['domain', () => {}, 'test.domain', A[3].sub],
    ['unavailable', () => fake.next('token', 'no_refresh'), 'test.other', A[4].sub],
  ];
  for (const [code, arm, purpose, sub] of cases) {
    arm();
    fake.resetCounts();
    const r = await connect(u.b, purpose, sub);
    assert.equal(r.google, code);
    assert.equal(await grantRow(u.id), null, code);
    await jobs();
    assert.equal(fake.counts.revoke, 1, code);
    assert.equal([...fake.revoked.values()].reduce((a, b) => a + b, 0), 1, code);
  }
  // not-allowed: their role changed while they were at Google.
  const s = await u.b.send('GET', '/api/auth/google/start?do=connect&for=test.purpose&back=/profile');
  assert.equal((await M.b.action('member.setRole', { user_id: u.id, role: 'volunteer' })).status, 200);
  const back = new URL(fake.authorize(s.headers.get('location'), A[5].sub));
  fake.resetCounts();
  assert.equal((await u.b.send('GET', `${back.pathname}${back.search}`)).headers.get('location'), '/profile?google=not-allowed');
  await jobs();
  assert.equal(fake.counts.revoke, 1);
  // other-account: connected as one Google account, then another.
  assert.equal((await connect(u.b, 'test.other', A[6].sub)).google, 'connected');
  fake.resetCounts();
  assert.equal((await connect(u.b, 'test.other', A[7].sub)).google, 'other-account');
  assert.equal((await grantRow(u.id)).sub, A[6].sub);
  await jobs();
  assert.equal(fake.counts.revoke, 1);
  assert.equal((await googleFetch(db, await grantFor(db, { userId: u.id, workspaceId: M.ws }, 'test.other'), api())).ok, true, 'the first account still works');
});

test('a purpose’s roles and area: a manager’s deny on its area stops it before Google', async () => {
  assert.equal((await M.b.action('permission.member.set', { user_id: T.id, grant: [], deny: ['outreach'] })).status, 200);
  fake.resetCounts();
  assert.equal((await connect(T.b, 'test.purpose', A[8].sub)).google, 'not-allowed');
  assert.equal(fake.counts.token, 0);
  assert.equal((await M.b.action('permission.member.set', { user_id: T.id, grant: [], deny: [] })).status, 200);
  assert.equal((await connect(T.b, 'test.purpose', A[8].sub)).google, 'connected');
  const purposes = (await T.b.get('/api/google')).json.purposes.map((p) => p.key);
  assert.ok(purposes.includes('test.purpose') && !purposes.includes('nothing'));
});

test('a sign-in domain for the campaign leaves a no-domain purpose on gmail ok; a domain purpose wants its hd', async () => {
  assert.equal((await M.b.google(fake, { do: 'link', app: 'desk', back: '/admin/profile' }, A[1].sub)).google, 'linked');
  assert.equal((await M.b.action('google.settings', { domain: 'campaign.example.org' })).status, 200);
  const g = await grantFor(db, { userId: S.id, workspaceId: M.ws }, 'test.other');
  assert.equal(g.state, 'ok');
  assert.equal((await connect(M.b, 'test.domain', A[1].sub, { app: 'desk', back: '/admin/profile' })).google, 'connected');
  assert.equal((await grantFor(db, { userId: M.id, workspaceId: M.ws }, 'test.domain')).state, 'ok');
  assert.equal((await M.b.action('google.settings', { domain: null })).status, 200);
});

test('demoted: the purpose goes from the grant, none left → the row goes and is revoked once; the old grant calls nothing', async () => {
  const d = await join(M.b, `dem.${tag}@example.org`, 'staff');
  assert.equal((await connect(d.b, 'test.purpose', A[9].sub)).google, 'connected');
  const g = await grantFor(db, { userId: d.id, workspaceId: M.ws }, 'test.purpose');
  assert.equal(g.state, 'ok');
  fake.resetCounts();
  assert.equal((await M.b.action('member.setRole', { user_id: d.id, role: 'volunteer' })).status, 200);
  assert.equal(await grantRow(d.id), null);
  assert.equal(await grantFor(db, { userId: d.id, workspaceId: M.ws }, 'test.purpose'), null);
  const r = await googleFetch(db, g, api());
  assert.ok(r.trouble && !r.reached);
  assert.equal(fake.counts.api + fake.counts.refresh, 0);
  await jobs();
  assert.equal(fake.counts.revoke, 1);
  const last = (await events('google_grant')).at(-1);
  assert.equal(last.op, 'void');
  assert.equal(last.action, 'member.setRole');
  assert.deepEqual(last.payload, { holder: 'user', user_id: d.id, purposes: [], state: 'ok' });
  // Denied the purpose's area: the same.
  const e = await join(M.b, `den.${tag}@example.org`, 'staff');
  assert.equal((await connect(e.b, 'test.purpose', A[10].sub)).google, 'connected');
  fake.resetCounts();
  assert.equal((await M.b.action('permission.member.set', { user_id: e.id, grant: [], deny: ['outreach'] })).status, 200);
  assert.equal(await grantRow(e.id), null);
  await jobs();
  assert.equal(fake.counts.revoke, 1);
  // A role's defaults (Admin → Permissions): every staffer who connected it.
  assert.equal((await M.b.action('permission.role.set', { role: 'staff', grant: [], deny: ['outreach'] })).status, 200);
  assert.equal(await grantFor(db, { userId: T.id, workspaceId: M.ws }, 'test.purpose'), null);
  assert.equal((await M.b.action('permission.role.set', { role: 'staff', grant: [], deny: [] })).status, 200);
});

test('still allowed in another campaign: the purpose stays, but grantFor here says not-allowed and calls nothing', async () => {
  const other = await signup(`Grants Other ${tag}`, `ot.${tag}@example.org`);
  const w = await join(M.b, `two.${tag}@example.org`, 'staff');
  const inv = await other.b.action('member.invite', { email: w.email, role: 'staff' });
  assert.equal((await new Browser().post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], password: 'google-2026-pass' })).status, 200);
  assert.equal((await connect(w.b, 'test.purpose', A[11].sub)).google, 'connected');
  assert.equal((await M.b.action('member.setRole', { user_id: w.id, role: 'volunteer' })).status, 200);
  assert.deepEqual((await grantRow(w.id)).purposes, ['test.purpose']);
  const here = await grantFor(db, { userId: w.id, workspaceId: M.ws }, 'test.purpose');
  assert.equal(here.state, 'not-allowed');
  fake.resetCounts();
  const r = await googleFetch(db, here, api());
  assert.equal(r.trouble.code, 'not-allowed');
  assert.equal(fake.counts.api + fake.counts.refresh, 0);
  const there = await grantFor(db, { userId: w.id, workspaceId: other.ws }, 'test.purpose');
  assert.equal(there.state, 'ok');
  assert.equal((await googleFetch(db, there, api())).ok, true);
});

test('googleFetch: one refresh on a 401; auth-only never retries a 500', async () => {
  const g = await grantFor(db, { userId: S.id, workspaceId: M.ws }, 'test.other');
  assert.equal((await googleFetch(db, g, api())).ok, true);
  fake.resetCounts();
  fake.next('api', '401');
  const r = await googleFetch(db, g, api());
  assert.equal(r.ok, true);
  assert.equal(fake.counts.refresh, 1);
  assert.equal(fake.counts.api, 2);
  fake.resetCounts();
  fake.next('api', '500');
  const f = await googleFetch(db, g, api(), {}, { retry: 'auth-only' });
  assert.equal(f.trouble.code, 'unavailable');
  assert.equal(f.reached, true);
  assert.equal(fake.counts.api, 1);
  const n = await grantRow(S.id);
  assert.ok(n.last_ok_at);
});

test('invalid_grant: reconnect, never tried again; one event in the caller’s campaign as the grant’s person — and from a job', async () => {
  const u = await join(M.b, `ig.${tag}@example.org`, 'volunteer');
  assert.equal((await connect(u.b, 'test.other', A[12].sub)).google, 'connected');
  const g = await grantFor(db, { userId: u.id, workspaceId: M.ws }, 'test.other');
  const before = (await events('google_grant')).length;
  fake.resetCounts();
  fake.next('refresh', 'invalid_grant');
  const r = await googleFetch(db, g, api());
  assert.equal(r.trouble.code, 'reconnect');
  assert.equal(r.trouble.said, 'Google stopped letting base.win use this account');
  assert.equal(fake.counts.refresh, 1);
  _resetTokensForTest();
  const again = await googleFetch(db, await grantFor(db, { userId: u.id, workspaceId: M.ws }, 'test.other'), api());
  assert.equal(again.trouble.code, 'reconnect');
  assert.equal(fake.counts.refresh + fake.counts.api, 1, 'no further calls');
  const ev = (await events('google_grant')).slice(before);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].action, 'google.grant.state');
  assert.equal(ev[0].actor_id, u.id);
  assert.deepEqual(ev[0].payload, { holder: 'user', user_id: u.id, purposes: ['test.other'], state: 'reconnect' });
  assert.deepEqual((await u.b.get('/api/google')).json.me.grant.state, 'reconnect');
  // Reconnecting clears it; then from a job, the same.
  assert.equal((await connect(u.b, 'test.other', A[12].sub)).google, 'connected');
  assert.equal((await grantRow(u.id)).state, 'ok');
  _resetTokensForTest();
  fake.next('refresh', 'invalid_grant');
  await runAction(db, { workspaceId: M.ws, actorId: null, action: 'test.queue' }, async (tx) => {
    const { enqueueJob } = await import('../lib/jobs.js');
    await enqueueJob(tx, { workspaceId: M.ws, kind: 'test.google.fetch', payload: { userId: u.id, workspaceId: M.ws } });
  });
  const ran = await jobs();
  assert.equal(ran.failed, 0);
  assert.equal((await grantRow(u.id)).state, 'reconnect');
  assert.equal((await events('google_grant')).at(-1).actor_id, u.id);
});

test('the token endpoint: a wrong client pauses every start 60 s; no answer pauses 30 s', async () => {
  const g = await grantFor(db, { userId: S.id, workspaceId: M.ws }, 'test.other');
  fake.next('refresh', 'invalid_client');
  const r = await googleFetch(db, g, api());
  assert.equal(r.trouble.code, 'client');
  const p = tokenPaused();
  assert.equal(p.code, 'client');
  assert.ok(Math.abs(p.until - Date.now() - 60_000) < 2000);
  fake.resetCounts();
  const s = await new Browser().send('GET', '/api/auth/google/start?do=signin');
  assert.equal(s.headers.get('location'), '/login?google=not-set-up');
  assert.equal((await googleFetch(db, g, api())).trouble.code, 'client');
  assert.equal(fake.counts.refresh, 0);
  const row = (await M.b.get('/api/connections')).json.services.find((x) => x.key === 'google');
  assert.match(row.detail, /Google refused at .*: wrong client ID or secret/);
  _resetPausesForTest();
  _setTokenTimeoutForTest(300);
  try {
    fake.next('refresh', 'slow');
    const slow = await googleFetch(db, g, api());
    assert.equal(slow.trouble.code, 'unavailable');
    assert.ok(Math.abs(tokenPaused().until - Date.now() - 30_000) < 2000);
  } finally {
    _setTokenTimeoutForTest(8000);
  }
});

test('an API host down pauses that host only: sign-in still works, another host is still called', async () => {
  const g = await grantFor(db, { userId: S.id, workspaceId: M.ws }, 'test.other');
  assert.equal((await googleFetch(db, g, api())).ok, true);
  fake.resetCounts();
  fake.next('api', '503'); fake.next('api', '503');
  const r = await googleFetch(db, g, api());
  assert.equal(r.trouble.code, 'unavailable');
  assert.equal(fake.counts.api, 2, 'one more try, then the pause');
  assert.equal((await googleFetch(db, g, api())).trouble.code, 'unavailable');
  assert.equal(fake.counts.api, 2, 'paused: not called');
  const other = api().replace('127.0.0.1', 'localhost');
  assert.equal((await googleFetch(db, g, other)).ok, true);
  assert.equal(fake.counts.api, 3);
  assert.equal(tokenPaused(), null);
  const b = new Browser();
  assert.equal((await b.google(fake, { do: 'signin' }, A[1].sub)).location, '/');
  // A timeout is the same.
  _resetTokensForTest();
  fake.next('api', 'slow');
  const t = await googleFetch(db, g, other, {}, { timeoutMs: 300, retry: 'auth-only' });
  assert.equal(t.trouble.code, 'unavailable');
});

test('quota: a 429 with Retry-After, or 403 userRateLimitExceeded, pauses that grant only', async () => {
  const g = await grantFor(db, { userId: S.id, workspaceId: M.ws }, 'test.other');
  const other = await join(M.b, `qt.${tag}@example.org`, 'volunteer');
  assert.equal((await connect(other.b, 'test.other', A[20].sub)).google, 'connected');
  const h = await grantFor(db, { userId: other.id, workspaceId: M.ws }, 'test.other');
  fake.next('api', '429', { retryAfter: 120 });
  const r = await googleFetch(db, g, api());
  assert.equal(r.trouble.code, 'paused');
  assert.ok(Math.abs(new Date(r.trouble.until) - Date.now() - 120_000) < 3000);
  fake.resetCounts();
  assert.equal((await googleFetch(db, g, api())).trouble.code, 'paused');
  assert.equal(fake.counts.api, 0);
  assert.equal((await googleFetch(db, h, api())).ok, true, 'another grant is not paused');
  fake.next('api', 'quota');
  const q = await googleFetch(db, h, api(), {}, { quotaPauseMs: 5000 });
  assert.equal(q.trouble.code, 'paused');
  assert.ok(Math.abs(new Date(q.trouble.until) - Date.now() - 5000) < 2000);
  fake.next('api', '403');
  await db.query('update google_grants set paused_until = null where user_id = any($1)', [[S.id, other.id]]);
  assert.equal((await googleFetch(db, g, api())).trouble.code, 'denied');
});

test('narrowToken: only a browserToken purpose, only its scopes; kept nowhere', async () => {
  const u = await join(M.b, `nt.${tag}@example.org`, 'volunteer');
  assert.equal((await connect(u.b, 'test.browser', A[13].sub)).google, 'connected');
  const g = await grantFor(db, { userId: u.id, workspaceId: M.ws }, 'test.browser');
  const o = await grantFor(db, { userId: S.id, workspaceId: M.ws }, 'test.other');
  assert.equal((await narrowToken(db, o, [SCOPE('other')])).trouble.code, 'not-allowed');
  assert.equal((await narrowToken(db, g, [SCOPE('other')])).trouble.code, 'not-allowed');
  const t = await narrowToken(db, g, [SCOPE('pick')]);
  assert.ok(t.token && t.expiresAt);
  const call = await fetch(`${fake.base}/test-api/picker`, { headers: { Authorization: `Bearer ${t.token}` } });
  assert.deepEqual((await call.json()).scopes, [SCOPE('pick')]);
  assert.equal((await narrowToken(db, g, [SCOPE('pick')])).token, t.token, 'kept in memory until it nears expiry');
});

test('disconnect: purposes left → no revoke, still at Google; the last → the row goes, one revoke', async () => {
  const u = await join(M.b, `dc.${tag}@example.org`, 'staff');
  assert.equal((await connect(u.b, 'test.other', A[14].sub)).google, 'connected');
  assert.equal((await connect(u.b, 'test.purpose', A[14].sub)).google, 'connected');
  assert.deepEqual((await grantRow(u.id)).purposes, ['test.other', 'test.purpose']);
  fake.resetCounts();
  const one = await u.b.action('google.disconnect', { purpose: 'test.other' });
  assert.equal(one.json.still_at_google, true);
  await jobs();
  assert.equal(fake.counts.revoke, 0);
  assert.equal((await u.b.action('google.disconnect', { purpose: 'test.other' })).status, 404);
  const two = await u.b.action('google.disconnect', { purpose: 'test.purpose' });
  assert.equal(two.json.still_at_google, false);
  assert.equal(await grantRow(u.id), null);
  await jobs();
  assert.equal(fake.counts.revoke, 1);
});

test('two people on one Google account: one disconnecting never revokes the other’s', async () => {
  const a = await join(M.b, `sh1.${tag}@example.org`, 'volunteer');
  const b = await join(M.b, `sh2.${tag}@example.org`, 'volunteer');
  assert.equal((await connect(a.b, 'test.other', A[15].sub)).google, 'connected');
  assert.equal((await connect(b.b, 'test.other', A[15].sub)).google, 'connected');
  fake.resetCounts();
  const r = await a.b.action('google.disconnect', { purpose: 'test.other' });
  assert.equal(r.json.still_at_google, true);
  await jobs();
  assert.equal(fake.counts.revoke, 0);
  _resetTokensForTest();
  assert.equal((await googleFetch(db, await grantFor(db, { userId: b.id, workspaceId: M.ws }, 'test.other'), api())).ok, true);
  assert.equal(fake.counts.refresh, 1);
});

test('a revoke that keeps failing is tried five times, then parked as failed', async () => {
  const sealed = sealToken('1//not-a-real-token');
  await revokeIfUnshared(db, { workspaceId: M.ws, sub: `nobody-${tag}`, sealed });
  for (let i = 0; i < 5; i++) fake.next('revoke', '500');
  fake.resetCounts();
  for (let i = 0; i < 5; i++) {
    _resetPausesForTest();
    await db.query("update jobs set run_at = now() where workspace_id = $1 and kind = 'google.revoke' and status = 'pending'", [M.ws]);
    await jobs();
  }
  assert.equal(fake.counts.revoke, 5);
  const job = (await db.query("select status, attempts, payload from jobs where workspace_id = $1 and kind = 'google.revoke' order by run_at desc limit 1", [M.ws])).rows[0];
  assert.equal(job.status, 'failed');
  assert.equal(Number(job.attempts), 5);
  assert.ok(!JSON.stringify(job.payload).includes('not-a-real-token'), 'sealed in the job, never plain');
});

test('dropPurpose from a job; clean-up (onRevoke) runs before the revoke, and with no jobs, at once without a token', async () => {
  const u = await join(M.b, `dp.${tag}@example.org`, 'volunteer');
  assert.equal((await connect(u.b, 'test.other', A[16].sub)).google, 'connected');
  assert.equal((await connect(u.b, 'test.clean', A[16].sub)).google, 'connected');
  await runAction(db, { workspaceId: M.ws, actorId: null, action: 'test.queue' }, async (tx) => {
    const { enqueueJob } = await import('../lib/jobs.js');
    await enqueueJob(tx, { workspaceId: M.ws, kind: 'test.google.drop', payload: { userId: u.id, workspaceId: M.ws } });
  });
  fake.resetCounts();
  await jobs();
  assert.deepEqual((await grantRow(u.id)).purposes, ['test.clean']);
  assert.equal((await events('google_grant')).at(-1).action, 'google.disconnect');
  assert.equal(fake.counts.revoke, 0);
  cleaned.length = 0;
  assert.equal((await u.b.action('google.disconnect', { purpose: 'test.clean' })).json.still_at_google, false);
  await jobs();
  assert.deepEqual(cleaned.map((c) => [c.userId, c.fetch, c.revokesSoFar]), [[u.id, true, 0]]);
  assert.equal(fake.counts.revoke, 1, 'then the revoke');
  // A shared account: the clean-up still runs, no revoke follows.
  const v = await join(M.b, `dq.${tag}@example.org`, 'volunteer');
  assert.equal((await connect(v.b, 'test.clean', A[15].sub)).google, 'connected');
  cleaned.length = 0; fake.resetCounts();
  await v.b.action('google.disconnect', { purpose: 'test.clean' });
  await jobs();
  assert.equal(cleaned.length, 1);
  assert.equal(fake.counts.revoke, 0);
  // No background work on this server: the clean-up runs in the write, without a token.
  const w = await join(M.b, `dr.${tag}@example.org`, 'volunteer');
  assert.equal((await connect(w.b, 'test.clean', A[17].sub)).google, 'connected');
  process.env.STARBASE_JOBS = 'off';
  try {
    cleaned.length = 0;
    await w.b.action('google.disconnect', { purpose: 'test.clean' });
    assert.deepEqual(cleaned.map((c) => [c.userId, c.fetch]), [[w.id, false]]);
  } finally {
    delete process.env.STARBASE_JOBS;
  }
});

test('leaving the team: a one-campaign member’s grant goes and is revoked; a paid membership’s void touches nothing', async () => {
  const u = await join(M.b, `lv.${tag}@example.org`, 'volunteer');
  assert.equal((await connect(u.b, 'test.other', A[18].sub)).google, 'connected');
  await runAction(db, { workspaceId: M.ws, actorId: M.id, action: 'membership.cancel' }, async (tx, emit) => {
    emit('membership', u.id, 'void', {});
  });
  assert.ok(await grantRow(u.id));
  await jobs(); // what earlier tests left queued
  fake.resetCounts();
  assert.equal((await M.b.action('member.remove', { user_id: u.id })).status, 200);
  assert.equal(await grantRow(u.id), null);
  await jobs();
  assert.equal(fake.counts.revoke, 1);
});

test('google.forget: every member’s connection here, revoked — a shared account excepted; managers only', async () => {
  const a = await join(M.b, `fg1.${tag}@example.org`, 'volunteer');
  assert.equal((await connect(a.b, 'test.other', A[15].sub)).google, 'connected'); // shared with sh2
  assert.equal((await S.b.action('google.forget')).status, 403);
  fake.resetCounts();
  const r = await M.b.action('google.forget');
  assert.equal(r.status, 200);
  assert.ok(r.json.disconnected >= 3);
  const left = (await db.query(
    'select g.user_id from google_grants g join memberships m on m.user_id = g.user_id and m.workspace_id = $1', [M.ws],
  )).rows.map((x) => x.user_id);
  assert.deepEqual(left.length, 1, 'the member also in another campaign keeps theirs');
  await jobs();
  const revokedSubs = fake.counts.revoke;
  assert.ok(revokedSubs >= 2);
  const voids = (await events('google_grant')).filter((e) => e.action === 'google.forget');
  assert.equal(voids.length, r.json.disconnected);
  for (const e of voids) assert.equal(e.op, 'void');
});

test('key rotation reseals on refresh; a lost key means reconnect', async () => {
  const u = await join(M.b, `kr.${tag}@example.org`, 'volunteer');
  assert.equal((await connect(u.b, 'test.other', A[19].sub)).google, 'connected');
  const K2 = 'second-google-token-key-for-tests-0123456789';
  process.env.GOOGLE_TOKEN_KEY = `${K2},${TOKEN_KEY}`;
  assert.equal(openToken((await grantRow(u.id)).refresh_sealed).current, false);
  const g = await grantFor(db, { userId: u.id, workspaceId: M.ws }, 'test.other');
  assert.equal((await googleFetch(db, g, api())).ok, true);
  assert.equal(openToken((await grantRow(u.id)).refresh_sealed).current, true);
  process.env.GOOGLE_TOKEN_KEY = 'a-third-key-nobody-sealed-with-0123456789';
  _resetTokensForTest();
  const r = await googleFetch(db, g, api());
  assert.equal(r.trouble.code, 'reconnect');
  assert.equal((await grantRow(u.id)).said, 'Connect again — this server’s Google key changed');
  await markReconnect(db, g, 'Connect again — this server’s Google key changed');
});

test('payloads pinned; access tokens in no table, job or event', async () => {
  for (const e of await events('google_grant')) {
    assert.deepEqual(Object.keys(e.payload).sort(), ['holder', 'purposes', 'state', 'user_id']);
    assert.equal(e.payload.holder, 'user');
  }
  const tables = ['google_grants', 'google_flows', 'google_logins', 'jobs', 'events'];
  const dump = (await Promise.all(tables.map((t) => db.query(`select * from ${t}`)))).map((r) => JSON.stringify(r.rows)).join('\n');
  for (const t of fake.tokens()) assert.ok(!dump.includes(t), `stored: ${t.slice(0, 10)}…`);
  const list = (await M.b.get('/api/google')).json;
  const text = JSON.stringify(list);
  assert.ok(!/sub|scope/i.test(Object.keys(list.me.grant || {}).join()));
  for (const a of A) assert.ok(!text.includes(a.sub));
});
