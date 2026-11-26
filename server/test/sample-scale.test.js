// The sample carries its own opponents. Its rating scale is saved with the
// cast's three when it is made, so the demo names them whatever staging's
// STARBASE_CANDIDATES holds in Render: a setting a Blueprint sync never
// reached (the opponents an older render.yaml gave) does not come back.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { stagingBlock } from './sample-prints.js';
import { OPPONENTS } from '../lib/samplecast.js';

const BLOCK = stagingBlock();
delete BLOCK.NODE_ENV;
// Made-up stand-ins for an old value still in Render.
BLOCK.STARBASE_CANDIDATES = '4A:Stalewood:Opposed — Stalewood supporter;4B:Oldbury:Opposed — Oldbury supporter;4C:Formerly:Opposed — Formerly supporter';
const saved = Object.fromEntries(Object.keys(BLOCK).map((k) => [k, process.env[k]]));
Object.assign(process.env, BLOCK);
const { freshDb } = await import('./helpers.js');
const { app } = await import('../index.js');
const { bootstrap } = await import('../db/schema.js');
const { seedSample } = await import('../lib/samplecampaign.js');
after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

let cookie;
before(async () => {
  const db = await freshDb();
  await db.query('drop schema public cascade');
  await db.query('create schema public');
  await db.query('drop schema if exists sample_meta cascade');
  await bootstrap(db);
  await seedSample(app, () => {}, 12);
  const r = await app.request('/api/auth/demo');
  assert.equal(r.status, 302);
  cookie = r.headers.get('set-cookie').split(';')[0];
});

test('the sample’s rating scale names the cast’s three, not an old setting’s', async () => {
  const res = await app.request('/api/scale', { headers: { cookie } });
  const text = await res.text();
  const { scale } = JSON.parse(text);
  assert.deepEqual(scale.candidates.filter((c) => !c.off).map((c) => [c.code, c.name]), OPPONENTS.map((o) => [o.code, o.name]));
  for (const old of ['Stalewood', 'Oldbury', 'Formerly']) assert.ok(!text.includes(old), old);
});
