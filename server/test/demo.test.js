// The public demo (lib/demo.js): staging may be framed by the sites named
// and opened with no password as one demo account; production never.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';
import { bootstrap } from '../db/schema.js';

const KEYS = ['BASE_ENV', 'BASE_FRAME_HOSTS', 'BASE_DEMO_EMAIL', 'BASE_SAMPLE', 'BASE_OPEN_SIGNUP'];
let kept; let db;
beforeEach(async () => {
  kept = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  delete process.env.BASE_SAMPLE;
  db = await freshDb();
});
afterEach(() => { for (const k of KEYS) { if (kept[k] === undefined) delete process.env[k]; else process.env[k] = kept[k]; } });

const health = () => app.request('/api/health');

test('nobody may frame the app unless staging names a site', async () => {
  process.env.BASE_ENV = 'staging';
  delete process.env.BASE_FRAME_HOSTS;
  let r = await health();
  assert.equal(r.headers.get('x-frame-options'), 'DENY');

  process.env.BASE_FRAME_HOSTS = 'https://base.win, https://www.base.win/, http://evil.example, nonsense';
  r = await health();
  assert.equal(r.headers.get('x-frame-options'), null);
  assert.equal(r.headers.get('content-security-policy'), "frame-ancestors 'self' https://base.win https://www.base.win");
});

test('production ignores both settings', async () => {
  process.env.BASE_ENV = 'production';
  process.env.BASE_FRAME_HOSTS = 'https://base.win';
  process.env.BASE_DEMO_EMAIL = 'demo@example.org';
  const r = await health();
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('content-security-policy'), null);
  assert.equal((await app.request('/api/auth/demo')).status, 404);
});

test('the demo signs a visitor in as the demo account', async () => {
  process.env.BASE_ENV = 'staging';
  delete process.env.BASE_DEMO_EMAIL;
  assert.equal((await app.request('/api/auth/demo')).status, 404, 'off until an account is named');

  const mgr = new Client();
  await mgr.signup({ email: 'demo@example.org' });
  process.env.BASE_DEMO_EMAIL = 'nobody@example.org';
  assert.equal((await app.request('/api/auth/demo')).status, 503, 'an account not in the campaign');

  process.env.BASE_DEMO_EMAIL = 'Demo@Example.org';
  const r = await app.request('/api/auth/demo');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/');
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const who = await (await app.request('/api/auth/me', { headers: { cookie } })).json();
  assert.equal(who.user.email, 'demo@example.org');
  assert.equal(who.role, 'manager');
});

// Staging's sample server (lib/samplecampaign.js): nothing on the database
// (test:pg shares one database between a file's cases).
const empty = async () => {
  await db.query('drop schema public cascade');
  await db.query('create schema public');
  await db.query('drop schema if exists sample_meta cascade');
  await bootstrap(db);
};
const sampleServer = () => {
  process.env.BASE_ENV = 'staging';
  process.env.BASE_SAMPLE = 'vancouver';
  process.env.BASE_DEMO_EMAIL = 'demo@example.org';
  delete process.env.BASE_OPEN_SIGNUP; // the real first run
};
const html = { accept: 'text/html,application/xhtml+xml' };

test('a sample server takes no sign-up but the sample’s own, even with an empty database', async () => {
  await empty();
  sampleServer();
  const r = await new Client().signup({ email: 'stranger@example.org' });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'The demo is not open for sign-up.');
  assert.equal(Number((await db.query('select count(*) as n from workspaces')).rows[0].n), 0);
  const setup = await (await app.request('/api/auth/setup')).json();
  assert.equal(setup.open, false, 'the sign-in page offers no first-run set-up');
});

test('/api/auth/setup says demo: true only where there is a demo', async () => {
  process.env.BASE_ENV = 'staging';
  delete process.env.BASE_DEMO_EMAIL;
  assert.equal('demo' in (await (await app.request('/api/auth/setup')).json()), false);
  process.env.BASE_DEMO_EMAIL = 'demo@example.org';
  assert.equal((await (await app.request('/api/auth/setup')).json()).demo, true);
  process.env.BASE_ENV = 'production';
  assert.equal('demo' in (await (await app.request('/api/auth/setup')).json()), false, 'never on production');
});

test('while the sample is being made again, the demo says so and tries again every 10 seconds', async () => {
  await empty();
  sampleServer();
  await db.query('create schema if not exists sample_meta');
  await db.query(`create table if not exists sample_meta.made (id int primary key check (id = 1), version int not null,
    state text not null check (state in ('making','made','failed')), email text not null, attempts int not null default 0, at timestamptz not null default now())`);
  await db.query("insert into sample_meta.made (id, version, state, email, attempts) values (1, 2, 'making', 'demo@example.org', 1)");
  let r = await app.request('/api/auth/demo', { headers: html });
  assert.equal(r.status, 503);
  assert.match(r.headers.get('content-type'), /^text\/html/);
  const body = await r.text();
  assert.match(body, /<meta http-equiv="refresh" content="10">/);
  assert.match(body, /The demo is being refreshed\. It will be back in about a minute\./);
  r = await app.request('/api/auth/demo');
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { error: 'The demo is being refreshed. It will be back in about a minute.' });

  // Gone for good (no account, nothing being made): said once, no refresh.
  await db.query("update sample_meta.made set state = 'failed'");
  r = await app.request('/api/auth/demo', { headers: html });
  assert.equal(r.status, 503);
  const gone = await r.text();
  assert.doesNotMatch(gone, /http-equiv="refresh"/);
  assert.match(gone, /The demo is not available right now\./);
  await db.query('drop schema sample_meta cascade');
});
