// base.win support's entry from the control centre (POST /api/auth/operator,
// lib/entry.js, ext/operator): a signed one-minute token, at this server's
// own origin only, once; the account it lands on and never takes over; a
// two-hour sign-in that ends when the campaign turns base.win sign-in off
// or the key goes; what it may not do; every event it writes tagged; and
// sign-up closed on a fresh server that holds the key.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';
import { verifyChain } from '../lib/events.js';
import { bootstrap } from '../db/schema.js';
import { signEntry } from './entry-sign.js';

const V = JSON.parse(readFileSync(new URL('./entry-vector.json', import.meta.url), 'utf8'));
const OWN = 'http://127.0.0.1:5620';
const OP = { id: '7b1f3c2e-0000-4000-8000-000000000001', email: 'owner@example.org' };
const KEYS = ['BASE_PLATFORM_PUBKEY', 'STARBASE_OWN_URL', 'RENDER_EXTERNAL_URL', 'STARBASE_ENV', 'STARBASE_OPEN_SIGNUP',
  'STARBASE_DEMO_EMAIL', 'STARBASE_ORG_NAME', 'STARBASE_PUBLIC_URL'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

let db;
let ipSeq = 0;
const nonce = () => randomBytes(16).toString('base64url');
const inst = async () => (await db.query('select instance from platform_identity')).rows[0].instance;
const mint = async (over = {}, opOver = {}) => {
  const now = Math.floor(Date.now() / 1000);
  return signEntry(V.signingKey, {
    v: 1, kid: V.kid, aud: OWN, env: process.env.STARBASE_ENV, inst: await inst(), iat: now, exp: now + 60,
    nonce: nonce(), op: { ...OP, stepUpAt: now - 60, ...opOver }, go: '/desk', invite: null, ...over,
  });
};
// The Enter page's request: from this origin, JSON, its own address.
const post = (token, { origin = OWN, env } = {}) => app.request('/api/auth/operator', {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin, 'x-forwarded-for': `198.51.100.${(ipSeq += 1) % 250}` },
  body: JSON.stringify({ token }),
}, env);
const entry = async (token, opts) => {
  const res = await post(token, opts);
  const json = await res.json().catch(() => null);
  const set = res.headers.get('set-cookie') || '';
  return { status: res.status, json, set, cookie: set.split(';')[0] };
};
const as = (cookie) => {
  const c = new Client();
  c.cookie = cookie;
  return c;
};
const sessions = async () => Number((await db.query('select count(*)::int as n from sessions where entry is not null')).rows[0].n);
const wsId = async () => (await db.query('select id from workspaces order by created_at limit 1')).rows[0].id;
const setSettings = async (patch) => db.query(
  `update workspaces set settings = settings || $2::jsonb where id = $1`, [await wsId(), JSON.stringify(patch)],
);

// A database with nothing in it, as on a new server. Over the Postgres wire
// (npm run test:pg) a file has one database: it is emptied and made again.
const fresh = async () => {
  db = await freshDb();
  if (db.kind === 'postgres') {
    await db.query('drop schema public cascade');
    await db.query('create schema public');
    await bootstrap(db);
  }
  return db;
};

// A campaign set up by its own manager (the usual case).
const withCampaign = async () => {
  await fresh();
  process.env.STARBASE_OPEN_SIGNUP = '1';
  const mgr = new Client();
  const r = await mgr.signup({ name: 'Morgan Example', email: 'morgan@example.org' });
  assert.equal(r.status, 201);
  delete process.env.STARBASE_OPEN_SIGNUP;
  return mgr;
};

before(() => {
  process.env.BASE_PLATFORM_PUBKEY = V.publicKey;
  process.env.STARBASE_OWN_URL = OWN;
  process.env.STARBASE_ENV = 'production';
  delete process.env.RENDER_EXTERNAL_URL;
  delete process.env.STARBASE_DEMO_EMAIL;
});
beforeEach(() => {
  process.env.BASE_PLATFORM_PUBKEY = V.publicKey;
  process.env.STARBASE_OWN_URL = OWN;
  process.env.STARBASE_ENV = 'production';
  delete process.env.STARBASE_DEMO_EMAIL;
});
after(() => {
  for (const k of KEYS) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
});

test('not ready: no key, or no own origin → 503', async () => {
  await withCampaign();
  const token = await mint();
  delete process.env.BASE_PLATFORM_PUBKEY;
  let r = await entry(token);
  assert.equal(r.status, 503);
  assert.equal(r.json.code, 'not-ready');
  process.env.BASE_PLATFORM_PUBKEY = 'not a key';
  assert.equal((await entry(token)).status, 503);
  process.env.BASE_PLATFORM_PUBKEY = V.publicKey;
  delete process.env.STARBASE_OWN_URL;
  r = await entry(token);
  assert.equal(r.status, 503);
  assert.equal(await sessions(), 0);
});

test('a good entry: a two-hour sign-in as base.win support, a manager, on the log; then never again', async () => {
  await withCampaign();
  const token = await mint();
  const r = await entry(token);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.match(r.set, /^mv2_session=[0-9a-f]{64}; Max-Age=7200; Path=\/; HttpOnly; SameSite=Strict/);
  assert.equal(r.json.go, '/desk');
  assert.equal(r.json.invite, null);
  assert.equal(r.json.role, 'manager');
  const me = await as(r.cookie).get('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.role, 'manager');
  assert.equal(me.json.user.name, 'base.win support');
  const ahead = Date.parse(me.json.operator.until) - Date.now();
  assert.ok(ahead > 7100_000 && ahead <= 7200_000, `until ${me.json.operator.until}`);
  const u = (await db.query('select id, support, password_hash from users where email = $1', [OP.email])).rows[0];
  assert.equal(u.support, true);
  assert.equal(u.password_hash, 'none');
  const link = (await db.query('select user_id from operator_links where operator_id = $1', [OP.id])).rows[0];
  assert.equal(link.user_id, u.id);
  const ev = (await db.query("select entity_type, payload from events where action = 'operator.enter' order by seq")).rows;
  const nonceOf = JSON.parse(Buffer.from(token.split('.')[2], 'base64url')).nonce;
  assert.ok(ev.length >= 2);
  for (const e of ev) assert.equal(e.payload.entry, nonceOf);
  const sess = ev.find((e) => e.entity_type === 'session').payload;
  assert.equal(sess.via, 'base.win support');
  assert.equal(sess.operator, OP.id);
  assert.ok(!JSON.stringify(ev).includes(OP.email), 'the operator’s email is not in the events');
  assert.equal((await verifyChain(db, await wsId())).ok, true);
  const row = (await db.query('select user_id, kid from operator_entries where nonce = $1', [nonceOf])).rows[0];
  assert.deepEqual(row, { user_id: u.id, kid: V.kid });

  // Replay: the same token again — refused, and no second session.
  const again = await entry(token);
  assert.equal(again.status, 401);
  assert.equal(again.json.code, 'entry');
  assert.equal(again.set, '');
  assert.equal(await sessions(), 1);

  // Signing out ends it.
  await as(r.cookie).post('/api/auth/logout', {});
  assert.equal((await as(r.cookie).get('/api/auth/me')).status, 401);
});

test('request checks: the Origin, a client path, another instance or environment → 401', async () => {
  await withCampaign();
  assert.equal((await entry(await mint(), { origin: 'https://evil.example.org' })).status, 401);
  assert.equal((await entry(await mint(), { origin: '' })).status, 401);
  assert.equal((await entry(await mint(), { env: { base: '/x' } })).status, 401);
  assert.equal((await entry(await mint({ inst: 'AAAAAAAAAAAAAAAAAAAAAA' }))).status, 401);
  assert.equal((await entry(await mint({ env: 'staging' }))).status, 401);
  assert.equal((await entry(await mint({ aud: 'http://127.0.0.1:5621' }))).status, 401);
  // Signed by a key this server doesn't hold.
  const now = Math.floor(Date.now() / 1000);
  const other = signEntry(V.otherSigningKey, {
    v: 1, kid: V.otherKid, aud: OWN, env: 'production', inst: await inst(), iat: now, exp: now + 60,
    nonce: nonce(), op: { ...OP, stepUpAt: now }, go: '/desk', invite: null,
  });
  assert.equal((await entry(other)).status, 401);
  // An old token.
  assert.equal((await entry(await mint({ iat: now - 200, exp: now - 140 }, { stepUpAt: now - 300 }))).status, 401);
  assert.equal(await sessions(), 0);
});

test('two servers alike (same own address, each its own database): a token for one is refused by the other', async () => {
  await withCampaign();
  const tokenForA = await mint();
  await withCampaign();
  const r = await entry(tokenForA);
  assert.equal(r.status, 401);
  assert.equal((await entry(await mint())).status, 200);
});

test('the instance is made once and kept', async () => {
  await fresh();
  const a = await inst();
  assert.match(a, /^[A-Za-z0-9_-]{22}$/);
  await db.exec((await import('../ext/operator/sql.js')).sql);
  assert.equal(await inst(), a);
  await fresh();
  assert.notEqual(await inst(), a);
});

test('a fresh server with the key: sign-up closed; the first entry makes the campaign', async () => {
  await fresh();
  delete process.env.STARBASE_OPEN_SIGNUP;
  process.env.STARBASE_ORG_NAME = 'Example Civic Team';
  try {
    const setup = await new Client().get('/api/auth/setup');
    assert.equal(setup.json.open, false);
    const up = await new Client().signup({ email: 'stranger@example.org' });
    assert.equal(up.status, 403);
    assert.equal(up.json.error, 'This campaign is set up from the base.win control centre.');
    // Without the key, the usual first run.
    delete process.env.BASE_PLATFORM_PUBKEY;
    assert.equal((await new Client().get('/api/auth/setup')).json.open, true);
    process.env.BASE_PLATFORM_PUBKEY = V.publicKey;

    const r = await entry(await mint());
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const ws = (await db.query('select id, name from workspaces')).rows;
    assert.equal(ws.length, 1);
    assert.equal(ws[0].name, 'Example Civic Team');
    const m = (await db.query('select m.role, u.support from memberships m join users u on u.id = m.user_id')).rows;
    assert.deepEqual(m, [{ role: 'manager', support: true }]);
    assert.equal((await verifyChain(db, ws[0].id)).ok, true);
    const all = (await db.query('select payload from events where workspace_id = $1', [ws[0].id])).rows;
    assert.ok(all.length >= 3);
    for (const e of all) assert.ok(e.payload.entry, 'every event of the visit is tagged');
    assert.ok(!JSON.stringify(all).includes(OP.email), 'the operator’s email is not on the log');
    // Set up now: the usual closed words.
    assert.equal((await new Client().signup({ email: 'later@example.org' })).status, 403);
    // STARBASE_OPEN_SIGNUP=1 still opens it.
    process.env.STARBASE_OPEN_SIGNUP = '1';
    assert.equal((await new Client().signup({ email: 'forced@example.org' })).status, 201);
  } finally {
    delete process.env.STARBASE_OPEN_SIGNUP;
    delete process.env.STARBASE_ORG_NAME;
  }
});

test('existing accounts: a member keeps role and name; a non-member is never taken; a new operator id relinks; removed support comes back', async () => {
  const mgr = await withCampaign();
  // A volunteer with the operator's email.
  const inv = await mgr.action('member.invite', { email: OP.email, role: 'volunteer' });
  assert.equal(inv.status, 200);
  const token = inv.json.joinUrl.split('/join/')[1];
  const joined = await new Client().post('/api/auth/join', { token, name: 'Owner Example', password: 'owner-password-1' });
  assert.equal(joined.status, 200);
  const r = await entry(await mint());
  assert.equal(r.status, 200);
  assert.equal(r.json.role, 'volunteer');
  assert.equal(r.json.user.name, 'Owner Example');
  const uid = r.json.user.id;
  assert.equal((await db.query('select user_id from operator_links where operator_id = $1', [OP.id])).rows[0].user_id, uid);
  // The control centre made again (a new operator id), the same email: the same member, relinked.
  const newOp = randomUUID();
  const r2 = await entry(await mint({}, { id: newOp }));
  assert.equal(r2.status, 200);
  assert.equal(r2.json.user.id, uid);
  assert.equal((await db.query('select user_id from operator_links where operator_id = $1', [newOp])).rows[0].user_id, uid);
  // The account the operator comes in as gets no password link from a manager.
  process.env.STARBASE_PUBLIC_URL = 'https://base.win/example';
  try {
    const link = await mgr.action('member.passwordLink', { user_id: uid });
    assert.equal(link.status, 409);
    assert.match(link.json.error, /base\.win support comes in as/);
  } finally { delete process.env.STARBASE_PUBLIC_URL; }

  // An account with that email that isn't on the team: 409, nothing linked, on the log.
  await withCampaign();
  await db.query("insert into users (id, email, name, password_hash) values ($1, $2, 'Someone Example', 'x')", [randomUUID(), OP.email]);
  const r3 = await entry(await mint());
  assert.equal(r3.status, 409);
  assert.equal(r3.json.code, 'email-taken');
  assert.equal((await db.query('select count(*)::int as n from operator_links')).rows[0].n, 0);
  const refused = (await db.query("select payload from events where action = 'operator.enter'")).rows;
  assert.deepEqual(refused.map((e) => e.payload), [{ operator_refused: 'email-taken' }]);
  assert.equal(await sessions(), 0);

  // Support removed by a manager: the next entry puts the membership back.
  const mgr2 = await withCampaign();
  const first = await entry(await mint());
  const supportId = first.json.user.id;
  const rm = await mgr2.action('member.remove', { user_id: supportId });
  assert.ok(rm.status === 200, JSON.stringify(rm.json));
  assert.equal((await db.query('select 1 from memberships where user_id = $1', [supportId])).rows.length, 0);
  const back = await entry(await mint());
  assert.equal(back.status, 200);
  assert.equal(back.json.user.id, supportId);
  assert.equal(back.json.role, 'manager');
  const ev = (await db.query("select payload from events where action = 'operator.enter' and entity_type = 'membership'")).rows;
  assert.equal(ev.length, 2);
  assert.equal(ev[1].payload.via, 'base.win support');
});

test('the switch: off refuses entry and ends a visit in progress; on the demo it never stops entry', async () => {
  await withCampaign();
  const open = await entry(await mint());
  assert.equal(open.status, 200);
  await setSettings({ operatorEntry: false });
  // The visit in progress is signed out on its next request.
  assert.equal((await as(open.cookie).get('/api/auth/me')).status, 401);
  assert.equal((await as(open.cookie).get('/api/brief')).status, 401);
  const off = await entry(await mint());
  assert.equal(off.status, 403);
  assert.equal(off.json.code, 'off');
  await setSettings({ operatorEntry: true });
  assert.equal((await entry(await mint())).status, 200);

  // The demo (staging): entry works whatever the switch says.
  process.env.STARBASE_ENV = 'staging';
  process.env.STARBASE_DEMO_EMAIL = 'demo@example.org';
  await setSettings({ operatorEntry: false });
  const demo = await entry(await mint());
  assert.equal(demo.status, 200);
  assert.equal((await as(demo.cookie).get('/api/auth/me')).status, 200);
});

test('the key removed or changed: a visit in progress ends', async () => {
  await withCampaign();
  const r = await entry(await mint());
  assert.equal((await as(r.cookie).get('/api/auth/me')).status, 200);
  // A key change in progress: both held, still in.
  process.env.BASE_PLATFORM_PUBKEY = `${V.otherPublicKey},${V.publicKey}`;
  assert.equal((await as(r.cookie).get('/api/auth/me')).status, 200);
  process.env.BASE_PLATFORM_PUBKEY = V.otherPublicKey;
  assert.equal((await as(r.cookie).get('/api/auth/me')).status, 401);
  process.env.BASE_PLATFORM_PUBKEY = '';
  assert.equal((await as(r.cookie).get('/api/auth/me')).status, 401);
});

test('what a visit may not do: its own sign-in methods, the switch, password links, Google; twostep.reset stays', async () => {
  const mgr = await withCampaign();
  const vol = await mgr.action('member.invite', { email: 'vol@example.org', role: 'volunteer' });
  await new Client().post('/api/auth/join', { token: vol.json.joinUrl.split('/join/')[1], name: 'Val Example', password: 'val-password-1' });
  const volId = (await db.query("select id from users where email = 'vol@example.org'")).rows[0].id;
  const r = await entry(await mint());
  const support = as(r.cookie);
  for (const name of ['twostep.start', 'twostep.confirm', 'twostep.off', 'twostep.codes', 'twostep.require', 'workspace.operatorEntry', 'member.passwordLink']) {
    const res = await support.action(name, name === 'member.passwordLink' ? { user_id: volId } : {});
    assert.equal(res.status, 403, name);
    assert.equal(res.json.error, 'Not while signed in as base.win support.', name);
  }
  const reset = await support.action('twostep.reset', { user_id: volId });
  assert.notEqual(reset.status, 403, JSON.stringify(reset.json));
  // The campaign's own manager isn't stopped by the list.
  assert.notEqual((await mgr.action('twostep.start', {})).status, 403);
  // Google link and connect, as support: refused (Google set up, at the public address).
  const g = { id: process.env.GOOGLE_OAUTH_CLIENT_ID, secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET, key: process.env.GOOGLE_TOKEN_KEY };
  Object.assign(process.env, { GOOGLE_OAUTH_CLIENT_ID: 'test-client.apps.example', GOOGLE_OAUTH_CLIENT_SECRET: 'test-secret', GOOGLE_TOKEN_KEY: 'k'.repeat(40), STARBASE_PUBLIC_URL: 'http://localhost' });
  try {
    for (const q of ['do=link&app=desk', 'do=connect&app=desk&for=drive']) {
      const res = await app.request(`http://localhost/api/auth/google/start?${q}`, { headers: { cookie: r.cookie } });
      assert.equal(res.status, 302, q);
      assert.match(res.headers.get('location'), /google=not-allowed/, q);
      // The campaign's manager gets as far as Google.
      const m = await app.request(`http://localhost/api/auth/google/start?${q}`, { headers: { cookie: mgr.cookie } });
      assert.doesNotMatch(m.headers.get('location') || '', /google=not-allowed/, q);
    }
  } finally {
    for (const [k, v] of [['GOOGLE_OAUTH_CLIENT_ID', g.id], ['GOOGLE_OAUTH_CLIENT_SECRET', g.secret], ['GOOGLE_TOKEN_KEY', g.key]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    delete process.env.STARBASE_PUBLIC_URL;
  }
});

test('tagging: every event a visit writes carries its nonce; others don’t', async () => {
  const mgr = await withCampaign();
  const token = await mint();
  const r = await entry(token);
  const n = JSON.parse(Buffer.from(token.split('.')[2], 'base64url')).nonce;
  const made = await as(r.cookie).createPerson('Pat Example');
  assert.ok(made?.id);
  await mgr.createPerson('Lee Example');
  const ev = (await db.query("select action, payload from events where action = 'person.create' order by seq")).rows;
  assert.equal(ev[0].payload.entry, n);
  assert.equal(ev[ev.length - 1].payload.entry, undefined);
  assert.equal((await verifyChain(db, await wsId())).ok, true);
});

test('two-step required at the desk: a visit is not stuck setting it up', async () => {
  await withCampaign();
  await setSettings({ twoStepRequired: true });
  const r = await entry(await mint());
  const me = await as(r.cookie).get('/api/auth/me');
  assert.equal(me.json.two_step.must_set_up, false);
  assert.equal((await as(r.cookie).get('/api/brief')).status, 200);
});

test('invite: the visit invites the first manager itself, with the campaign’s own address', async () => {
  await withCampaign();
  process.env.STARBASE_PUBLIC_URL = 'https://base.win/example';
  try {
    const r = await entry(await mint({ go: '/desk/settings/members', invite: { email: 'sam@example.org' } }));
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.invite, { email: 'sam@example.org' });
    assert.equal(r.json.go, '/desk/settings/members');
    // The server didn't invite; the Enter page does, as support.
    assert.equal((await db.query('select count(*)::int as n from invites')).rows[0].n, 0);
    const inv = await as(r.cookie).action('member.invite', { email: r.json.invite.email, role: 'manager' });
    assert.equal(inv.status, 200);
    assert.ok(inv.json.joinUrl.startsWith('https://base.win/example/join/'), inv.json.joinUrl);
    assert.equal((await db.query("select role from invites where email = 'sam@example.org'")).rows[0].role, 'manager');
  } finally {
    delete process.env.STARBASE_PUBLIC_URL;
  }
});

test('support accounts: no password sign-in (the same wait), and no invite to their address', async () => {
  const mgr = await withCampaign();
  await entry(await mint());
  const t0 = Date.now();
  const bad = await new Client().post('/api/auth/login', { email: OP.email, password: 'none' });
  const tSupport = Date.now() - t0;
  assert.equal(bad.status, 401);
  const t1 = Date.now();
  await new Client().post('/api/auth/login', { email: 'morgan@example.org', password: 'wrong-password' });
  const tWrong = Date.now() - t1;
  // dummyVerify ran: a scrypt's worth of time, like a wrong password.
  assert.ok(tSupport > tWrong / 3, `support ${tSupport} ms, wrong password ${tWrong} ms`);
  // An invite to support's address (removed from the team first) can't be
  // used to join as it.
  const supportId = (await db.query('select id from users where email = $1', [OP.email])).rows[0].id;
  assert.equal((await mgr.action('member.remove', { user_id: supportId })).status, 200);
  const inv = await mgr.action('member.invite', { email: OP.email, role: 'volunteer' });
  assert.equal(inv.status, 200, JSON.stringify(inv.json));
  const join = await new Client().post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], password: 'whatever-password' });
  assert.equal(join.status, 409);
  assert.equal(join.json.error, 'This address is base.win support’s here; invite another address.');
});

test('a visit ends after two hours', async () => {
  await withCampaign();
  const r = await entry(await mint());
  await db.query("update sessions set expires_at = now() - interval '1 second' where entry is not null");
  assert.equal((await as(r.cookie).get('/api/auth/me')).status, 401);
});

test('structural: the test signer only in tests; no route logs the entry or reset bodies', () => {
  const root = new URL('../..', import.meta.url).pathname;
  const files = [];
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      if (['node_modules', 'dist', '.git', '.claude'].includes(f)) continue;
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(m?js|jsx)$/.test(f)) files.push(p);
    }
  };
  walk(join(root, 'server'));
  walk(join(root, 'web', 'src'));
  for (const f of readdirSync(root)) if (/\.mjs$/.test(f)) files.push(join(root, f));
  const users = files.filter((f) => /entry-sign/.test(readFileSync(f, 'utf8')) && !f.endsWith('entry-sign.js'));
  for (const f of users) {
    const rel = f.slice(root.length);
    assert.ok(rel.startsWith('server/test/') || rel === 'e2e-entry.mjs', `entry-sign.js imported by ${rel}`);
  }
  const auth = readFileSync(join(root, 'server/routes/auth.js'), 'utf8');
  for (const route of ['/operator', '/reset/check', '/reset']) {
    const at = auth.indexOf(`app.post('${route}'`);
    assert.ok(at > 0, route);
    const body = auth.slice(at, auth.indexOf('\n});', at));
    assert.doesNotMatch(body, /console\.(log|error|warn|info)/, route);
  }
});

