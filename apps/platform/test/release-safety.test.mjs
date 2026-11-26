// The control centre's start-up SQL (db.sql, run at every start) keeps
// what it holds: nothing in it may drop, empty, rename or retype what is
// there, unless it is on the reviewed list in server/test/release-safety.js
// (GOING-LIVE.md section 0). Read as text; no database is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALLOWED_AT_START, problemsIn, staleAllowed, explainProblems } from '../../../server/test/release-safety.js';

const here = new URL('../', import.meta.url);
const SOURCE = 'apps/platform/db.sql';
const schemaFrom = (path) => [{ source: SOURCE, sql: readFileSync(path, 'utf8') }];

test('db.sql drops, empties, renames and retypes nothing but the reviewed statements', () => {
  const sources = schemaFrom(new URL('db.sql', here));
  const problems = problemsIn(sources);
  if (problems.length) assert.fail(explainProblems(problems));
  // Every entry for db.sql is still in it (a statement taken out is taken off the list).
  assert.deepEqual(staleAllowed(sources, ALLOWED_AT_START.filter((a) => a.source === SOURCE)), []);
});

test('the control centre runs db.sql at start-up and no other SQL script', () => {
  const db = readFileSync(new URL('db.mjs', here), 'utf8');
  assert.match(db, /const SCHEMA = readFileSync\(new URL\('\.\/db\.sql', import\.meta\.url\), 'utf8'\);/);
  assert.match(db, /await db\.exec\(SCHEMA\);/);
  // db.exec appears in db.mjs only: the start-up, and the wrappers that pass SQL through.
  const callers = [];
  const walk = (dir) => {
    for (const name of readdirSync(new URL(dir, here))) {
      if (name === 'test' || name === 'node_modules') continue;
      const rel = `${dir}${name}`;
      if (statSync(new URL(rel, here)).isDirectory()) walk(`${rel}/`);
      else if (/\.m?js$/.test(name) && /\b(db|tx|client|pool)\.exec\(/.test(readFileSync(new URL(rel, here), 'utf8'))) callers.push(rel);
    }
  };
  walk('');
  assert.deepEqual(callers, ['db.mjs']);
  assert.equal([...db.matchAll(/\bdb\.exec\(/g)].length, 2, 'the start-up and the PGlite wrapper');
});

test('a DROP COLUMN planted in a copy of db.sql is caught, whatever its case and line breaks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-safety-'));
  try {
    const copy = join(dir, 'db.sql');
    writeFileSync(copy, `${readFileSync(new URL('db.sql', here), 'utf8')}
-- no longer needed
Alter Table checks
  DROP
    column IF EXISTS problem;
`);
    const problems = problemsIn(schemaFrom(copy));
    assert.deepEqual(problems.map((p) => [p.kind, p.statement]), [['DROP COLUMN', 'alter table checks drop column if exists problem']]);
    const said = explainProblems(problems);
    assert.match(said, /apps\/platform\/db\.sql runs this at start-up \(DROP COLUMN\)/);
    assert.match(said, /What to do instead: add a new column or table/);
    // The reviewed list is by exact statement: the reviewed DELETE does not
    // let another one through.
    writeFileSync(copy, `${readFileSync(new URL('db.sql', here), 'utf8')}\ndelete from checks where via = 'server';\n`);
    assert.deepEqual(problemsIn(schemaFrom(copy)).map((p) => p.statement), ["delete from checks where via = 'server'"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
