// STARBASE_ENV unset or misspelled: staging's powers stay off.
//
// The name is read exactly (lib/org.js envName): "production" or "staging",
// spaces around it dropped, capitals not forgiven. Anything else is
// production wherever the server is hosted — NODE_ENV=production (the
// Dockerfile sets it) or on Render (RENDER is set on every service there) —
// and "local" only on a developer's machine. So a client's server whose
// STARBASE_ENV was mistyped never opens without a password
// (/api/auth/demo), is never framed by another site, never makes the sample
// campaign and never drops its database for a reset word.
import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';
import { envName } from '../lib/org.js';
import { seedSample } from '../lib/samplecampaign.js';

const KEYS = ['STARBASE_ENV', 'NODE_ENV', 'RENDER', 'STARBASE_FRAME_HOSTS', 'STARBASE_DEMO_EMAIL', 'STARBASE_SAMPLE', 'STARBASE_SAMPLE_RESET'];
let kept; let db;
// One campaign with one person in it, made once (over Postgres the whole
// file shares a database): what a reset word would drop.
before(async () => {
  db = await freshDb();
  const mgr = new Client();
  assert.equal((await mgr.signup({ email: 'demo@example.org' })).status, 201);
  await mgr.createPerson('Real Person');
});
beforeEach(() => {
  kept = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => { for (const k of KEYS) { if (kept[k] === undefined) delete process.env[k]; else process.env[k] = kept[k]; } });
const count = async (table) => Number((await db.query(`select count(*) as n from ${table}`)).rows[0].n);
const setEnv = (typed) => { if (typed === undefined) delete process.env.STARBASE_ENV; else process.env.STARBASE_ENV = typed; };

// What could be typed on a host by mistake (undefined: not set at all).
const WRONG = [undefined, '', 'Staging', 'STAGING', 'stagin', 'staging-2', 'Production', 'prod', 'live', 'demo', 'local'];
// Where a server is hosted: the Dockerfile's NODE_ENV, or Render's own mark.
const HOSTED = [
  ['NODE_ENV=production (the Dockerfile)', () => { process.env.NODE_ENV = 'production'; }],
  ['on Render, whatever NODE_ENV says', () => { process.env.RENDER = 'true'; process.env.NODE_ENV = 'development'; }],
  ['on Render with NODE_ENV not set', () => { process.env.RENDER = 'true'; }],
];

for (const [where, host] of HOSTED) {
  test(`an unset or misspelled STARBASE_ENV is production: ${where}`, async () => {
    host();
    // Everything staging would act on, set as staging sets it.
    process.env.STARBASE_DEMO_EMAIL = 'demo@example.org';
    process.env.STARBASE_FRAME_HOSTS = 'https://base.win';
    process.env.STARBASE_SAMPLE = 'vancouver';
    process.env.STARBASE_SAMPLE_RESET = 'a-word-this-database-has-not-seen';
    for (const typed of WRONG) {
      setEnv(typed);
      const said = `STARBASE_ENV=${JSON.stringify(typed)}`;
      assert.equal(envName(), 'production', said);
      const h = await app.request('/api/health');
      assert.equal((await h.json()).env, 'production', said);
      assert.equal(h.headers.get('x-frame-options'), 'DENY', `${said}: nobody may frame it`);
      assert.equal(h.headers.get('content-security-policy'), null, said);
      assert.equal((await app.request('/api/auth/demo')).status, 404, `${said}: no sign-in without a password`);
      assert.equal(await seedSample(app, () => {}, 8), null, `${said}: no sample campaign`);
      assert.equal(await count('workspaces'), 1, `${said}: the reset word drops nothing`);
      assert.equal(await count('persons'), 1, said);
    }
  });
}

test('the name is read exactly: spaces around it are dropped, nothing else is forgiven', () => {
  process.env.NODE_ENV = 'production';
  for (const [typed, name] of [['staging', 'staging'], [' staging ', 'staging'], ['production', 'production'], ['production\n', 'production']]) {
    process.env.STARBASE_ENV = typed;
    assert.equal(envName(), name, JSON.stringify(typed));
  }
});

test('a developer’s machine (not hosted) is "local"; the sample and its reset still need staging by name', async () => {
  process.env.STARBASE_DEMO_EMAIL = 'demo@example.org';
  process.env.STARBASE_SAMPLE = 'vancouver';
  process.env.STARBASE_SAMPLE_RESET = 'a-word-this-database-has-not-seen';
  for (const typed of [undefined, 'Staging', 'dev']) {
    setEnv(typed);
    assert.equal(envName(), 'local', JSON.stringify(typed));
    assert.equal(await seedSample(app, () => {}, 8), null);
    assert.equal(await count('workspaces'), 1);
    assert.equal(await count('persons'), 1);
  }
});
