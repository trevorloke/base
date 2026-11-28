// scripts/find-old-word.mjs: where the product's older name is still written
// in stored text, as counts per table and column, read only. The owner (or
// the lead, on staging) runs it in Render's Shell; here it runs over made-up
// rows (in memory, and over the wire under npm run test:pg). It never
// prints a value and never writes; a release never rewrites what it finds.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { freshDb } from './helpers.js';
import { _resetDbForTest } from '../db/client.js';
import { OLD_WORD } from '../../shared/old-names.js';
import { findOldWord, readOnly, main, connectPg } from '../../scripts/find-old-word.mjs';

const Word = OLD_WORD[0].toUpperCase() + OLD_WORD.slice(1);
const A = randomUUID();
let db;
const q = (sql, params) => db.query(sql, params);

before(async () => {
  db = await freshDb();
  await q('insert into workspaces (id, name) values ($1, $2)', [A, 'Riverbend Example']);
  const person = (name, address, tags = []) => q('insert into persons (id, workspace_id, name, address, tags) values ($1, $2, $3, $4, $5)',
    [randomUUID(), A, name, address, JSON.stringify(tags)]);
  // Three people's rows mention it: twice in a name-free address line, once in a tag (jsonb), in any case.
  await person('Pat Example', `12 ${Word} Way`);
  await person('Lee Example', `40 ${OLD_WORD.toUpperCase()} Rd`, ['volunteer']);
  await person('Kim Example', '9 Elm St', [`from-${OLD_WORD}`]);
  await person('Ana Example', '7 Oak St');
});
after(async () => {
  // In memory the database is one connection: the script's session setting is taken off again.
  if (!process.env.DATABASE_URL) await q('set default_transaction_read_only = off').catch(() => {});
});

test('counts per table and column, only where the word is', async () => {
  const found = await findOldWord(q);
  const mine = found.filter((f) => f.table === 'persons');
  assert.deepEqual(mine, [{ table: 'persons', column: 'address', rows: 2 }, { table: 'persons', column: 'tags', rows: 1 }]);
  assert.ok(found.every((f) => Number.isInteger(f.rows) && f.rows > 0));
});

test('inside its read-only session and transaction, the database refuses a write', async () => {
  const conn = db.pool ? await db.pool.connect() : null;
  const cq = conn ? (sql, params) => conn.query(sql, params) : q;
  try {
    await assert.rejects(
      readOnly(cq, (tx) => tx("update persons set name = 'Changed'")),
      (e) => e.code === '25006' || /read-only transaction/.test(e.message),
    );
    // The session too: a transaction of its own, after the script's, is still refused.
    await assert.rejects(cq("insert into workspaces (id, name) values ($1, 'Written')", [randomUUID()]), (e) => e.code === '25006' || /read-only transaction/.test(e.message));
  } finally {
    await cq('set default_transaction_read_only = off');
    conn?.release();
  }
  assert.equal((await q("select count(*)::int as n from persons where name = 'Changed'")).rows[0].n, 0);
});

test('run as the owner runs it: counts and a total, no value; only reads', async () => {
  const sent = [];
  const spy = (client) => {
    const query = client.query.bind(client);
    client.query = (sql, params) => { sent.push(String(sql).trim()); return query(sql, params); };
    return client;
  };
  const out = [];
  if (process.env.DATABASE_URL) {
    await db.close();
    _resetDbForTest();
    await main({ out: (line) => out.push(line), connect: async (url) => spy(await connectPg(url)) });
  } else {
    const client = { connect: async () => {}, end: async () => {}, query: (sql, params) => db.query(sql, params) };
    await main({ url: 'memory', out: (line) => out.push(line), connect: async () => spy(client) });
    await q('set default_transaction_read_only = off');
  }
  assert.ok(out.includes('persons.address: 2'), out.join('\n'));
  assert.ok(out.includes('persons.tags: 1'), out.join('\n'));
  assert.match(out.at(-1), /^Rows that mention the older name: \d+ \(in \d+ columns\)$/);
  assert.equal(sent[0], 'set default_transaction_read_only = on', 'the session is read only before anything is asked');
  assert.match(sent[1], /^begin transaction isolation level repeatable read read only$/i);
  assert.equal(sent.at(-1), 'rollback');
  for (const sql of sent.slice(2, -1)) assert.match(sql, /^(set local |select )/i, sql);
  for (const line of out) {
    assert.doesNotMatch(line, /Example|Way|Rd\b|Elm|Oak|volunteer/);
    assert.ok(!line.toLowerCase().includes(OLD_WORD), 'the word itself is not printed');
  }
});

test('without DATABASE_URL it says so and reads nothing', async () => {
  await assert.rejects(main({ url: '', out: () => assert.fail('printed'), connect: async () => { throw new Error('should not connect'); } }), /DATABASE_URL/);
});

test('the image carries the script, and it needs only shared/ and pg', () => {
  const root = new URL('../../', import.meta.url);
  const docker = readFileSync(new URL('Dockerfile', root), 'utf8');
  const runtime = docker.slice(docker.indexOf(' AS runtime'));
  assert.match(runtime, /^COPY scripts\/find-old-word\.mjs \.\/scripts\/find-old-word\.mjs$/m);
  assert.match(runtime, /^COPY shared \.\/shared$/m);
  const src = readFileSync(new URL('scripts/find-old-word.mjs', root), 'utf8');
  const used = [...src.matchAll(/(?:from\s+|import\()\s*'([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(used, ['../shared/old-names.js', 'node:url', 'pg']);
});
