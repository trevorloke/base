// One organization per deployment, from the environment: a deployment that
// names no campaign asks the first sign-up for it; the time zone, the city,
// the slates and the environment's name are what the app is told; staging
// says so at /api/health. The parsers for slates and candidates.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';
import { parseSlates } from '@starbase/shared/canvass';
import { parseCandidates } from '@starbase/shared/scale';

before(async () => {
  await freshDb();
  delete process.env.STARBASE_OPEN_SIGNUP;
  delete process.env.STARBASE_ORG_NAME;
  process.env.STARBASE_ENV = 'staging';
  process.env.STARBASE_TZ = 'America/Toronto';
  process.env.STARBASE_CITY = 'Ottawa';
  process.env.STARBASE_JURISDICTION = 'federal';
});
after(() => {
  process.env.STARBASE_OPEN_SIGNUP = '1';
  for (const k of ['STARBASE_ENV', 'STARBASE_TZ', 'STARBASE_CITY', 'STARBASE_JURISDICTION']) delete process.env[k];
});

test('a deployment that names no campaign: the first sign-up must, and gets the deployment’s rules', async () => {
  const setup = await new Client().get('/api/auth/setup');
  assert.equal(setup.json.open, true);
  assert.equal(setup.json.organization, null);
  assert.deepEqual([setup.json.org.jurisdiction, setup.json.org.tz, setup.json.org.city, setup.json.org.env], ['federal', 'America/Toronto', 'Ottawa', 'staging']);

  const c = new Client();
  const unnamed = await c.post('/api/auth/signup', { name: 'Pat Organizer', email: 'pat@example.org', password: 'river-city-2026' });
  assert.equal(unnamed.status, 400);
  assert.match(unnamed.json.error, /name the campaign/);
  const r = await c.post('/api/auth/signup', { name: 'Pat Organizer', email: 'pat@example.org', password: 'river-city-2026', workspaceName: 'River City Together' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.workspace.name, 'River City Together');
  assert.equal(r.json.workspace.jurisdiction, 'federal');
  assert.equal(r.json.workspace.settings.tz, 'America/Toronto');
  assert.equal(r.json.org.env, 'staging');
  const closed = await new Client().get('/api/auth/setup');
  assert.equal(closed.json.open, false);
  const again = await new Client().post('/api/auth/signup', { name: 'Late', email: 'late@example.org', password: 'late-pass-2026', workspaceName: 'X' });
  assert.equal(again.status, 403);
  assert.match(again.json.error, /already set up for this campaign/);
});

test('/api/health says which environment this is', async () => {
  const res = await app.request('/api/health');
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.env, 'staging');
  assert.equal(j.organization, null);
});

test('a bad time zone or jurisdiction falls back rather than breaking setup', async () => {
  process.env.STARBASE_TZ = 'Mars/Olympus';
  process.env.STARBASE_JURISDICTION = 'moon';
  const setup = await new Client().get('/api/auth/setup');
  assert.deepEqual([setup.json.org.tz, setup.json.org.jurisdiction], ['America/Vancouver', 'bc-municipal']);
});

test('slates and candidates are read from one line each', () => {
  assert.deepEqual(parseSlates('council:City council,school_board:School board'), [{ code: 'council', label: 'City council' }, { code: 'school_board', label: 'School board' }]);
  assert.deepEqual(parseSlates('mayor'), [{ code: 'mayor', label: 'Mayor' }], 'a code alone gets a label');
  assert.deepEqual(parseSlates('a:One, a:Two, Bad Code:x'), [{ code: 'a', label: 'One' }], 'repeats and odd codes are dropped');
  assert.equal(parseSlates(''), null);
  assert.deepEqual(parseCandidates('4D:McCallum:Opposed — Doug McCallum supporter;4B:Locke'), [
    { code: '4D', name: 'McCallum', label: 'Opposed — Doug McCallum supporter' },
    { code: '4B', name: 'Locke', label: 'Opposed — Locke' },
  ]);
  assert.equal(parseCandidates('1:Nope;4:NoLetters'), null, 'a candidate code is 4 plus letters');
});
