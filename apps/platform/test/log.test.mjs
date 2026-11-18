// The operator log: chained like a campaign's History; a changed or missing
// line shows on /log; appends at once stay gapless; every action has words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { freshApp, setUp, baseEnv } from './helpers.mjs';
import { appendLog, log, verifyLog } from '../log.mjs';
import { ACTIONS, wordsFor } from '../words.mjs';

baseEnv();
const { app, db } = await freshApp();
const op = await setUp(app, db);

test('the chain verifies across 500 lines', async () => {
  await db.transaction(async (tx) => {
    for (let i = 0; i < 499; i++) await appendLog(tx, { action: 'checklist.tick', campaign: 'sample', payload: { item: 'tz', n: i } });
  });
  const v = await verifyLog(db);
  assert.deepEqual(v, { ok: true, lines: 500 });
  const res = await op.b.get('/log');
  const body = await res.text();
  assert.match(body, /Log intact · 500 lines/);
  assert.equal([...body.matchAll(/class="oc-logline"/g)].length, 100, '100 a page');
  assert.match(body, /href="\/log\?before=401"/);
  assert.match(body, /Ticked “tz” · Sample \(staging\)/);
  const older = await (await op.b.get('/log?before=101')).text();
  assert.match(older, /Set up the control centre/, 'the first line is on a later page');
});

test('an edited payload, an edited action and a deleted line each show as “Changed at line N”', async () => {
  const keep = (await db.query('select * from ops_log where seq = 87')).rows[0];
  await db.query(`update ops_log set payload = '{"item":"door","n":85}' where seq = 87`);
  assert.deepEqual(await verifyLog(db), { ok: false, line: 87, lines: 500 });
  assert.match(await (await op.b.get('/log')).text(), /Changed at line 87/);
  await db.query('update ops_log set payload = $1 where seq = 87', [JSON.stringify(keep.payload)]);
  assert.equal((await verifyLog(db)).ok, true);
  await db.query("update ops_log set action = 'checklist.untick' where seq = 120");
  assert.equal((await verifyLog(db)).line, 120);
  await db.query("update ops_log set action = 'checklist.tick' where seq = 120");
  await db.query('delete from ops_log where seq = 200');
  assert.equal((await verifyLog(db)).line, 200);
});

test('the last line taken away shows too', async () => {
  const { db: d2 } = await freshApp();
  for (let i = 0; i < 3; i++) await log(d2, { action: 'stepup', payload: {} });
  await d2.query('delete from ops_log where seq = 3');
  assert.deepEqual(await verifyLog(d2), { ok: false, line: 3, lines: 3 });
});

test('20 appends at once stay gapless and in order', async () => {
  const { db: d2 } = await freshApp();
  await Promise.all(Array.from({ length: 20 }, (_, i) => log(d2, { action: 'stepup', payload: { i } })));
  const seqs = (await d2.query('select seq from ops_log order by seq')).rows.map((r) => Number(r.seq));
  assert.deepEqual(seqs, Array.from({ length: 20 }, (_, i) => i + 1));
  assert.equal((await verifyLog(d2)).ok, true);
});

test('every action the console writes has words, and no code updates or deletes the log', () => {
  const dir = new URL('../', import.meta.url);
  const files = ['', 'pages/'].flatMap((sub) => readdirSync(new URL(sub, dir)).filter((f) => f.endsWith('.mjs')).map((f) => readFileSync(new URL(sub + f, dir), 'utf8')));
  const src = files.join('\n');
  const written = new Set([...src.matchAll(/action: '([a-z.-]+)'/g)].map((m) => m[1]));
  for (const a of written) assert.ok(ACTIONS.includes(a), `${a} has words`);
  for (const a of ACTIONS) assert.notEqual(wordsFor(a, { env: 'production', left: 3, item: 'tz' }), a);
  assert.equal(wordsFor('desk.open', { env: 'production', purpose: 'desk' }), 'Opened the production desk');
  assert.doesNotMatch(src, /update\s+ops_log/i);
  assert.doesNotMatch(src, /delete\s+from\s+ops_log/i);
});
