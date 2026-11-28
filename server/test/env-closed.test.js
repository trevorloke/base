// BASE_ENV unset or misspelled: staging's powers stay off.
//
// The name is read exactly (lib/org.js envName): "production" or "staging",
// spaces around it dropped, capitals not forgiven. Anything else is
// production wherever the server is hosted — NODE_ENV=production (the
// Dockerfile sets it) or on Render (RENDER is set on every service there) —
// and "local" only on a developer's machine. So a client's server whose
// BASE_ENV was mistyped never opens without a password
// (/api/auth/demo), is never framed by another site, never makes the sample
// campaign and never drops its database for a reset word.
import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';
import { envName } from '../lib/org.js';
import { seedSample } from '../lib/samplecampaign.js';
import { _resetDbForTest } from '../db/client.js';
import { serviceBlock } from './sample-prints.js';
import { bootstrap } from '../db/schema.js';

const KEYS = ['BASE_ENV', 'NODE_ENV', 'RENDER', 'BASE_FRAME_HOSTS', 'BASE_DEMO_EMAIL', 'BASE_SAMPLE', 'BASE_SAMPLE_RESET'];
let kept; let db;
// One campaign with one person in it, made once (over Postgres the whole
// file shares a database): what a reset word would drop.
before(async () => {
  db = await freshDb();
  // From nothing, so a second run over the same database (test:pg --twice)
  // finds the same one campaign.
  await db.query('drop schema public cascade');
  await db.query('create schema public');
  await bootstrap(db);
  const mgr = new Client();
  assert.equal((await mgr.signup({ email: 'demo@example.org' })).status, 201);
  await mgr.createPerson('Real Person');
  // An old record of a sample (lib/samplecampaign.js), as if this database
  // had once been staging's: an older version than the code's, which on
  // staging would mean "make it again".
  await db.query('drop schema if exists sample_meta cascade');
  await db.query('create schema sample_meta');
  await db.query(`create table sample_meta.made (id int primary key check (id = 1), version int not null,
    state text not null check (state in ('making','made','failed')), email text not null, attempts int not null default 0, at timestamptz not null default now())`);
  await db.query("insert into sample_meta.made (id, version, state, email) values (1, 1, 'made', 'demo@example.org')");
});
beforeEach(() => {
  kept = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => { for (const k of KEYS) { if (kept[k] === undefined) delete process.env[k]; else process.env[k] = kept[k]; } });
const count = async (table) => Number((await db.query(`select count(*) as n from ${table}`)).rows[0].n);
const setEnv = (typed) => { if (typed === undefined) delete process.env.BASE_ENV; else process.env.BASE_ENV = typed; };

// What could be typed on a host by mistake (undefined: not set at all).
const WRONG = [undefined, '', 'Staging', 'STAGING', 'stagin', 'staging-2', 'Production', 'prod', 'live', 'demo', 'local'];
// Where a server is hosted: the Dockerfile's NODE_ENV, or Render's own mark.
const HOSTED = [
  ['NODE_ENV=production (the Dockerfile)', () => { process.env.NODE_ENV = 'production'; }],
  ['on Render, whatever NODE_ENV says', () => { process.env.RENDER = 'true'; process.env.NODE_ENV = 'development'; }],
  ['on Render with NODE_ENV not set', () => { process.env.RENDER = 'true'; }],
];

for (const [where, host] of HOSTED) {
  test(`an unset or misspelled BASE_ENV is production: ${where}`, async () => {
    host();
    // Everything staging would act on, set as staging sets it.
    process.env.BASE_DEMO_EMAIL = 'demo@example.org';
    process.env.BASE_FRAME_HOSTS = 'https://base.win';
    process.env.BASE_SAMPLE = 'vancouver';
    process.env.BASE_SAMPLE_RESET = 'a-word-this-database-has-not-seen';
    for (const typed of WRONG) {
      setEnv(typed);
      const said = `BASE_ENV=${JSON.stringify(typed)}`;
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
    process.env.BASE_ENV = typed;
    assert.equal(envName(), name, JSON.stringify(typed));
  }
});

test('a developer’s machine (not hosted) is "local"; the sample and its reset still need staging by name', async () => {
  process.env.BASE_DEMO_EMAIL = 'demo@example.org';
  process.env.BASE_SAMPLE = 'vancouver';
  process.env.BASE_SAMPLE_RESET = 'a-word-this-database-has-not-seen';
  for (const typed of [undefined, 'Staging', 'dev']) {
    setEnv(typed);
    assert.equal(envName(), 'local', JSON.stringify(typed));
    assert.equal(await seedSample(app, () => {}, 8), null);
    assert.equal(await count('workspaces'), 1);
    assert.equal(await count('persons'), 1);
  }
});

test('staging with no BASE_SAMPLE: no sample, nothing dropped, whatever the old record says', async () => {
  process.env.BASE_ENV = 'staging';
  process.env.BASE_DEMO_EMAIL = 'demo@example.org';
  for (const typed of [undefined, '', 'surrey', 'vancouver-2']) {
    if (typed === undefined) delete process.env.BASE_SAMPLE; else process.env.BASE_SAMPLE = typed;
    assert.equal(await seedSample(app, () => {}, 8), null, JSON.stringify(typed));
    assert.equal(await count('workspaces'), 1);
    assert.equal(await count('persons'), 1);
  }
});

// Imagine Surrey's server, set exactly as render.yaml's base-win block sets
// it (and on Render, as it is). The two places it runs this work's code.
// → a function that puts the settings back.
const imagineSurrey = () => {
  const block = serviceBlock('base-win');
  const was = Object.fromEntries(Object.keys(block).map((k) => [k, process.env[k]]));
  Object.assign(process.env, block);
  process.env.RENDER = 'true';
  // What staging's block holds, wrongly set here too: still nothing.
  process.env.BASE_SAMPLE = 'vancouver';
  process.env.BASE_DEMO_EMAIL = 'demo@example.org';
  process.env.BASE_SAMPLE_RESET = 'a-word-this-database-has-not-seen';
  return () => { for (const [k, v] of Object.entries(was)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
};

test('Imagine Surrey: /api/auth/setup has exactly the keys it had', async () => {
  const restore = imagineSurrey();
  try {
    const setup = await (await app.request('/api/auth/setup')).json();
    assert.deepEqual(Object.keys(setup).sort(), ['fromControlCentre', 'google', 'googleDomain', 'open', 'org', 'organization', 'resetByEmail']);
  } finally { restore(); }
});

// Last in the file: it swaps the database out. On Render with no
// DATABASE_URL, asking for the database fails at once (db/client.js
// storeRefusal), so a sample code that so much as asked would reject here:
// resolving null proves it never asked (zero calls), before anything else.
test('Imagine Surrey: the sample code returns before it asks for the database', async () => {
  const url = process.env.DATABASE_URL;
  const restore = imagineSurrey();
  delete process.env.DATABASE_URL;
  delete process.env.BASE_EMBEDDED_DB;
  _resetDbForTest();
  try {
    await assert.rejects(import('../db/client.js').then((m) => m.getDb()), /not starting/, 'any ask for the database fails here');
    _resetDbForTest();
    assert.equal(await seedSample(app, () => {}, 8), null);
  } finally {
    restore();
    if (url !== undefined) process.env.DATABASE_URL = url;
    _resetDbForTest();
  }
  assert.equal(await count('workspaces'), 1, 'nothing made, nothing dropped');
  assert.equal(await count('persons'), 1);
});
