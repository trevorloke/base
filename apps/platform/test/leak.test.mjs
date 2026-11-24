// The control centre's secrets never leave it: with OPS_SETUP_CODE,
// OPS_SECRET and PLATFORM_SIGNING_KEY set to sentinels, a full run (setup,
// sign-in, a new campaign, its address, the sample, Open, Invite, a stale
// code, the key, the log, sign out and a recovery code) shows none of them
// (nor the Ed25519 seed in hex or base64) in any body, header, stdout or
// stderr line, or table row; and no row holds the authenticator key or a
// recovery code as typed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseEnv, setUp, codeNow, browser } from './helpers.mjs';

baseEnv();
const SENTINELS = {
  OPS_SETUP_CODE: 'SENTINEL-SETUP-CODE-7f3a9c1e5b2d4f60',
  OPS_SECRET: 'SENTINEL-OPS-SECRET-1c9e4a7b3f5d2e80',
  PLATFORM_SIGNING_KEY: 'SENTINEL-SIGNING-KEY-5d2b8e4f1a7c3b90',
};
Object.assign(process.env, SENTINELS);
const { seedOf, publicKeyOf, currentKid } = await import('../keys.mjs');
const { openDb } = await import('../db.mjs');
const { makeApp } = await import('../server.mjs');

const seed = seedOf(SENTINELS.PLATFORM_SIGNING_KEY);
const FORBIDDEN = [...Object.values(SENTINELS), seed.toString('hex'), seed.toString('base64'), seed.toString('base64url')];

// Every byte that goes out: bodies and headers, and the process's own output.
const out = [];
const tap = (stream) => {
  const write = stream.write.bind(stream);
  stream.write = (chunk, ...rest) => { out.push(String(chunk)); return write(chunk, ...rest); };
};
tap(process.stdout);
tap(process.stderr);

const A = 'https://base-win-leak.onrender.com';
const S = 'https://starbase-staging.onrender.com';
const INST = 'EBESExQVFhcYGRobHB0eHw';
const fetcher = async (url) => {
  const origin = url.startsWith(S) ? S : A;
  return { status: 200, ms: 3, body: JSON.stringify({
    ok: true, database: 'ok', env: url.startsWith(S) ? 'staging' : 'production', commit: 'd9130ae', tzdataCurrent: true, ownOrigin: origin,
    instance: url.startsWith(S) ? 'SSSSSSSSSSSSSSSSSSSSSS' : INST, address: 'https://leak.base.win', entry: 'ready', platformKids: [currentKid()], setupOpen: false, campaignMade: true, store: 'postgres',
  }) };
};

const db = await openDb(process.env.DATABASE_URL || '', { max: Number(process.env.PG_POOL_MAX) || 5 });
if (process.env.DATABASE_URL) {
  await db.query('delete from ops_sessions; delete from operator_setup; delete from setup_tries; delete from operators');
  await db.query("delete from checklist; delete from checks; delete from environments where campaign <> 'sample'; delete from campaigns where name <> 'sample'; update environments set server_url = null, instance = null");
}
const app = makeApp({ db, fetcher });
const seen = [];
const recorded = { request: async (...args) => {
  const res = await app.request(...args);
  const body = await res.clone().text();
  seen.push(body, JSON.stringify([...res.headers]));
  return res;
} };

test('a full run leaks no secret anywhere', async () => {
  console.log('leak test: starting a full run');
  const op = await setUp(recorded, db);
  const b = op.b;
  const totpSecret = op.secret;
  const steps = [
    () => b.get('/'),
    () => b.post('/new', { name: 'leak', display: 'Leak Example', city: 'Exampleton', province: 'BC', rules: 'bc-municipal', tz: 'America/Vancouver', races: 'council', sw: '50.6, -120.5', ne: '50.8, -120.2' }),
    () => b.get('/c/leak/setup'),
    () => b.post('/c/leak/setup', { server_url: A }),
    () => b.get('/c/leak/setup'),
    () => b.post('/sample', { server_url: S }),
    () => b.post('/c/leak/check-now', {}),
    () => b.get('/c/leak'),
    () => b.post('/c/leak/open', { env: 'production' }),
    () => b.post('/c/leak/invite', { env: 'production', email: 'sam@example.org' }),
    () => b.post('/c/sample/open', { env: 'staging' }),
    () => b.get('/key'),
    () => b.get('/log'),
    () => b.get('/healthz'),
    async () => { await db.query("update ops_sessions set code_at = now() - interval '11 minutes'"); return b.post('/c/leak/open', { env: 'production' }); },
    async () => b.post('/c/leak/open', { env: 'production', code: await codeNow(db, totpSecret) }),
    () => b.post('/signout', {}),
  ];
  for (const step of steps) {
    const res = await step();
    assert.ok(res.status < 500, `${res.status}`);
  }
  assert.ok(out.length > 0);
  // Sign in again with a recovery code.
  const again = browser(recorded);
  const res = await again.post('/signin', { email: op.email, password: op.password, code: op.codes[0] });
  assert.equal(res.status, 303);
  const opened = seen.join('\n');
  assert.match(opened, /bw-entry\.v1\./, 'the run opened desks');
  assert.match(opened, /id="env-block"/, 'the run made a campaign and showed its block');
  assert.ok(opened.includes(publicKeyOf(SENTINELS.PLATFORM_SIGNING_KEY).publicKey), 'the public key is shown');

  let rows = '';
  for (const t of ['operators', 'operator_setup', 'setup_tries', 'ops_sessions', 'campaigns', 'environments', 'checks', 'checklist', 'ops_log', 'ops_chain']) {
    rows += JSON.stringify((await db.query(`select * from ${t}`)).rows);
  }
  const everywhere = { bodiesAndHeaders: opened, output: out.join(''), rows };
  for (const [where, text] of Object.entries(everywhere)) {
    for (const secret of FORBIDDEN) assert.ok(!text.includes(secret), `${where} holds ${secret.slice(0, 12)}…`);
  }
  assert.ok(!rows.includes(totpSecret), 'the authenticator key is only sealed');
  for (const code of op.codes) assert.ok(!rows.includes(code), 'recovery codes are only hashed');
  assert.ok(!rows.includes('sam@example.org'), 'the invited email is only hashed');
});
