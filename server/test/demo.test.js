// The public demo (lib/demo.js): staging may be framed by the sites named
// and opened with no password as one demo account; production never.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';

const KEYS = ['STARBASE_ENV', 'STARBASE_FRAME_HOSTS', 'STARBASE_DEMO_EMAIL'];
let kept;
beforeEach(async () => { kept = Object.fromEntries(KEYS.map((k) => [k, process.env[k]])); await freshDb(); });
afterEach(() => { for (const k of KEYS) { if (kept[k] === undefined) delete process.env[k]; else process.env[k] = kept[k]; } });

const health = () => app.request('/api/health');

test('nobody may frame the app unless staging names a site', async () => {
  process.env.STARBASE_ENV = 'staging';
  delete process.env.STARBASE_FRAME_HOSTS;
  let r = await health();
  assert.equal(r.headers.get('x-frame-options'), 'DENY');

  process.env.STARBASE_FRAME_HOSTS = 'https://base.win, https://www.base.win/, http://evil.example, nonsense';
  r = await health();
  assert.equal(r.headers.get('x-frame-options'), null);
  assert.equal(r.headers.get('content-security-policy'), "frame-ancestors 'self' https://base.win https://www.base.win");
});

test('production ignores both settings', async () => {
  process.env.STARBASE_ENV = 'production';
  process.env.STARBASE_FRAME_HOSTS = 'https://base.win';
  process.env.STARBASE_DEMO_EMAIL = 'demo@example.org';
  const r = await health();
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('content-security-policy'), null);
  assert.equal((await app.request('/api/auth/demo')).status, 404);
});

test('the demo signs a visitor in as the demo account', async () => {
  process.env.STARBASE_ENV = 'staging';
  delete process.env.STARBASE_DEMO_EMAIL;
  assert.equal((await app.request('/api/auth/demo')).status, 404, 'off until an account is named');

  const mgr = new Client();
  await mgr.signup({ email: 'demo@example.org' });
  process.env.STARBASE_DEMO_EMAIL = 'nobody@example.org';
  assert.equal((await app.request('/api/auth/demo')).status, 503, 'an account not in the campaign');

  process.env.STARBASE_DEMO_EMAIL = 'Demo@Example.org';
  const r = await app.request('/api/auth/demo');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/');
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const who = await (await app.request('/api/auth/me', { headers: { cookie } })).json();
  assert.equal(who.user.email, 'demo@example.org');
  assert.equal(who.role, 'manager');
});
