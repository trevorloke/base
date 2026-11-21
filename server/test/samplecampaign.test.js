// Staging's sample campaign (lib/samplecampaign.js): made once on an empty database,
// started over only by a new reset word, and never on production.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';
import { seedSample, samplePeople, AREAS } from '../lib/samplecampaign.js';

const KEYS = ['STARBASE_ENV', 'STARBASE_SAMPLE', 'STARBASE_SAMPLE_RESET', 'STARBASE_DEMO_EMAIL', 'STARBASE_OPEN_SIGNUP'];
let kept; let db;
beforeEach(async () => {
  kept = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  delete process.env.STARBASE_OPEN_SIGNUP; // the real first run
  db = await freshDb();
});
afterEach(() => { for (const k of KEYS) { if (kept[k] === undefined) delete process.env[k]; else process.env[k] = kept[k]; } });
const count = async (table) => Number((await db.query(`select count(*) as n from ${table}`)).rows[0].n);
const quiet = () => {};

test('everyone in the sample is made up, and in Vancouver', () => {
  const people = samplePeople(200);
  assert.deepEqual(samplePeople(200), people, 'the same sample every time');
  for (const p of people) {
    const [s, w, n, e] = AREAS.find((a) => a.name === p.area).box;
    assert.ok(p.lat >= s && p.lat <= n && p.lng >= w && p.lng <= e, 'inside its neighbourhood');
    assert.equal(p.city, 'Vancouver');
    if (p.email) assert.match(p.email, /@example\.org$/);
    if (p.phone) assert.match(p.phone, /^604-555-01\d\d$/);
  }
});

test('made once on staging; a new reset word starts it over; production never', async () => {
  process.env.STARBASE_DEMO_EMAIL = 'demo@example.org';
  process.env.STARBASE_SAMPLE = 'vancouver';

  process.env.STARBASE_ENV = 'production';
  process.env.STARBASE_SAMPLE_RESET = 'first';
  assert.equal(await seedSample(app, quiet, 24), null);
  assert.equal(await count('workspaces'), 0, 'production makes nothing');

  process.env.STARBASE_ENV = 'staging';
  delete process.env.STARBASE_SAMPLE_RESET;
  const made = await seedSample(app, quiet, 24);
  assert.equal(made.failed, 0);
  assert.equal(made.people, 24);
  assert.equal(made.turfs, 4);
  assert.equal(made.shifts, 5);
  assert.ok(made.knocks > 0);
  assert.equal(await count('persons'), 24);
  assert.equal(await seedSample(app, quiet, 24), null, 'a campaign is there: nothing more is made');

  // Something a visitor left behind goes with a new reset word.
  const r = await app.request('/api/auth/demo');
  assert.equal(r.status, 302);
  const visitor = new Client();
  visitor.cookie = r.headers.get('set-cookie').split(';')[0];
  assert.ok((await visitor.createPerson('Left Behind')).id);
  assert.equal(await count('persons'), 25);

  process.env.STARBASE_SAMPLE_RESET = 'first';
  assert.equal((await seedSample(app, quiet, 24)).people, 24);
  assert.equal(await count('persons'), 24);
  assert.equal(await count('workspaces'), 1);
  assert.equal(await seedSample(app, quiet, 24), null, 'the same word again drops nothing');
  assert.equal(await count('persons'), 24);
});
