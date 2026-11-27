// A release replaces the app only; it never erases a client's data
// (GOING-LIVE.md section 0). Every statement the campaign server runs on its
// database when it starts is read here, as the server would run it, and none
// may drop, empty, rename or retype what clients already keep, unless it is
// on the reviewed list in release-safety.js. No database is used: the start-up
// is run against a stand-in that only writes down what it is asked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { bootstrap } from '../db/schema.js';
import { EXTENSIONS } from '../ext.js';
import { ddlFor, recordTypeKeys } from '@starbase/shared/registry';
import { ALLOWED_AT_START, destructive, problemsIn, staleAllowed, explainProblems } from './release-safety.js';

const root = new URL('../../', import.meta.url);
const sqlOf = (e) => (typeof e.sql === 'function' ? e.sql() : e.sql);

// What bootstrap runs, each with the file it comes from.
const startUpSql = async () => {
  const ran = [];
  const stand = {
    kind: 'recording',
    exec: async (sql) => { ran.push(sql); },
    query: async (sql) => { ran.push(sql); return { rows: [{}], affectedRows: 0 }; },
    transaction: async (fn) => fn(stand),
  };
  await bootstrap(stand);
  const from = new Map();
  for (const key of recordTypeKeys()) from.set(ddlFor(key), `shared/registry.js (${key})`);
  for (const e of EXTENSIONS) if (e.sql) from.set(sqlOf(e), `server/ext/${e.name}`);
  return ran.map((sql) => ({ source: from.get(sql) || 'server/db/schema.js', sql }));
};

const fail = (problems) => { if (problems.length) assert.fail(explainProblems(problems)); };

test('nothing the server runs at start-up drops, empties, renames or retypes clients’ data', async () => {
  const sources = await startUpSql();
  // The stand-in saw the whole start-up: the core, every record type and
  // every feature's own SQL.
  const seen = new Set(sources.map((s) => s.sql));
  for (const e of EXTENSIONS) if (e.sql) assert.ok(seen.has(sqlOf(e)), `server/ext/${e.name}'s SQL ran`);
  for (const key of recordTypeKeys()) assert.ok(seen.has(ddlFor(key)), key);
  assert.ok(sources.some((s) => s.source === 'server/db/schema.js' && /create table if not exists workspaces/.test(s.sql)));
  fail(problemsIn(sources));
  // An entry for the server that no longer matches anything is taken off.
  assert.deepEqual(staleAllowed(sources, ALLOWED_AT_START.filter((a) => !a.source.startsWith('apps/'))), []);
});

test('the server runs start-up SQL from one place, so this check reads all of it', () => {
  // Files that hand SQL scripts to the database (db.exec). A new one is
  // either start-up SQL to add to startUpSql() above, or not start-up at all.
  const KNOWN = {
    'server/db/schema.js': 'bootstrap: the start-up itself, read above',
    'server/db/client.js': 'passes SQL through to the database; runs none of its own',
    // Not a client's start-up: it runs only on staging (base-win-staging),
    // behind guards G1–G3, and makes the sample's own bookkeeping table.
    // Its drop of the old sample is staging's alone; samplecampaign.test.js
    // and env-closed.test.js prove it never runs on a client's server.
    'server/lib/samplecampaign.js': 'staging only: the sample’s own bookkeeping table',
  };
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(new URL(dir, root))) {
      const rel = `${dir}${name}`;
      if (name === 'node_modules' || name === 'test') continue;
      if (statSync(new URL(rel, root)).isDirectory()) walk(`${rel}/`);
      else if (/\.(m?js)$/.test(name)) files.push(rel);
    }
  };
  walk('server/');
  walk('shared/');
  const callers = files.filter((f) => /\b(db|tx|client|pool)\.exec\(/.test(readFileSync(new URL(f, root), 'utf8')));
  assert.deepEqual(callers.sort(), Object.keys(KNOWN).sort());
});

test('a planted DROP COLUMN is caught, in any case and across lines, with what to do instead', async () => {
  // A copy of the start-up with one more statement; nothing on disk changes.
  const sources = await startUpSql();
  const planted = [...sources, { source: 'server/ext/fields', sql: `${sources.find((s) => s.source === 'server/ext/fields').sql}
    -- tidy up
    ALTER TABLE
        persons
      Drop
        COLUMN  rating;
  ` }];
  const problems = problemsIn(planted);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, 'DROP COLUMN');
  assert.equal(problems[0].statement, 'alter table persons drop column rating');
  const said = explainProblems(problems);
  assert.match(said, /server\/ext\/fields runs this at start-up \(DROP COLUMN\)/);
  assert.match(said, /add a new column or table and leave the old one where\s+it is/);
  assert.match(said, /get the owner's OK first, then add the exact\s+statement above to ALLOWED_AT_START/);
  assert.throws(() => fail(problems), /alter table persons drop column rating/);
});

test('what counts as destructive, and what does not', () => {
  const kinds = (sql) => destructive(sql).map((f) => f.kind);
  const BAD = [
    ['drop table people', 'DROP TABLE'],
    ['DROP TABLE IF EXISTS "Persons" CASCADE', 'DROP TABLE'],
    ['drop\n  schema public cascade', 'DROP SCHEMA'],
    ['TRUNCATE persons', 'TRUNCATE'],
    ['truncate table a, b', 'TRUNCATE'],
    ['DELETE FROM persons', 'DELETE without WHERE'],
    ["delete from persons where kind = 'org'", 'DELETE'],
    ['alter table persons drop column rating', 'DROP COLUMN'],
    ['alter table persons drop rating', 'DROP COLUMN'],
    ['ALTER TABLE ONLY public.persons DROP COLUMN IF EXISTS rating', 'DROP COLUMN'],
    ['alter table persons add column x int, drop column rating', 'DROP COLUMN'],
    ['alter table persons alter column rating type int using rating::int', 'ALTER COLUMN ... TYPE'],
    ['alter table persons alter rating set data type int', 'ALTER COLUMN ... TYPE'],
    ['alter table persons rename column rating to score', 'RENAME COLUMN'],
    ['alter table persons rename rating to score', 'RENAME COLUMN'],
    ['alter table if exists persons rename to people', 'RENAME TABLE'],
    ["do $$ begin execute 'alter table persons drop column rating'; end $$", 'DROP COLUMN'],
  ];
  for (const [sql, kind] of BAD) assert.deepEqual(kinds(sql), [kind], sql);
  const FINE = [
    'create table if not exists persons (id uuid primary key, deleted_at timestamptz)',
    'alter table persons add column if not exists rating text',
    'alter table blasts drop constraint if exists blasts_kind_check',
    'alter table blast_recipients alter column email drop not null',
    'alter table persons alter column tags set default \'[]\'',
    'alter table persons rename constraint a to b',
    'drop index if exists persons_ws_phone_digits_idx',
    'drop trigger if exists persons_names on persons',
    'create or replace function f() returns int language sql as $f$ select 1 $f$',
    'create table t (a uuid references persons(id) on delete cascade)',
    "update blast_recipients set open_logged_at = first_open_at where first_open_at is not null",
    "-- drop table persons\n/* truncate persons */ select 1",
  ];
  for (const sql of FINE) assert.deepEqual(kinds(sql), [], sql);
});

test('the reviewed list: each entry has a reason and names a file that runs at start-up', () => {
  for (const a of ALLOWED_AT_START) {
    assert.ok(a.why && a.why.length > 20, a.statement);
    assert.ok(/^(apps\/platform\/db\.sql|server\/|shared\/)/.test(a.source), a.source);
    assert.equal(a.statement, a.statement.toLowerCase().replace(/\s+/g, ' ').trim(), 'written as normalize() gives it');
  }
});
