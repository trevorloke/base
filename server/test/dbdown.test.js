// A database that isn't answering (restarting, or a plan change on the
// host): /api/health says so with a 503, and the server asks again next
// time instead of remembering it as down — once it's back, sign-in works
// without a restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:9/nothing'; // port 9: nothing listens
const { getDb, dbReachable, _resetDbForTest } = await import('../db/client.js');
const { app } = await import('../index.js');

test('unreachable: health says "not reachable" with a 503', async () => {
  _resetDbForTest();
  const r = await app.request('/api/health');
  assert.equal(r.status, 503);
  const body = await r.json();
  assert.deepEqual([body.ok, body.database], [false, 'not reachable']);
});

test('a failed connection is not remembered: the next call tries again', async () => {
  _resetDbForTest();
  const first = getDb();
  await assert.rejects(first);
  await new Promise((r) => setImmediate(r));
  const second = getDb();
  assert.notEqual(second, first, 'a fresh attempt, not the cached failure');
  await assert.rejects(second);
  assert.equal(await dbReachable(), false);
});
