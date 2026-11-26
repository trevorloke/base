// The control centre's shape: it uses only the server's small shared
// helpers (never its database, extensions, routes or index), reads only its
// own settings, keeps secret-like columns to the sign-in tables, keeps a
// campaign's values to an allow-list, never changes or removes a log line,
// and refuses the same names as the door.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESERVED } from '../campaigns.mjs';
import { RESERVED as DOOR_RESERVED } from '../../door/door.mjs';
import { pickValues, VALUE_KEYS } from '../snippets.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const sources = (dir = ROOT) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  if (e.isDirectory()) return e.name === 'test' || e.name === 'node_modules' ? [] : sources(join(dir, e.name));
  return /\.(mjs|js|sql)$/.test(e.name) ? [join(dir, e.name)] : [];
});
const files = sources().map((path) => ({ path: path.slice(ROOT.length), text: readFileSync(path, 'utf8') }));

test('only the server’s small shared helpers: never its database, extensions, routes or index', () => {
  const allowed = new Set(['server/lib/auth.js', 'server/lib/twostep.js', 'server/lib/guard.js', 'server/lib/events.js']);
  for (const f of files) {
    for (const m of f.text.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*)'([^']+)'/g)) {
      const spec = m[1];
      if (!spec.startsWith('.')) { assert.ok(/^(node:|hono|@hono\/|pg$|@electric-sql\/pglite$)/.test(spec), `${f.path}: ${spec}`); continue; }
      const fromRepo = relative(REPO, join(ROOT, f.path, '..', spec)).replace(/\\/g, '/');
      if (fromRepo.startsWith('apps/platform/')) continue;
      assert.ok(allowed.has(fromRepo), `${f.path} imports ${fromRepo}`);
      assert.doesNotMatch(fromRepo, /^server\/(db|ext|routes|index)/);
    }
  }
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies, undefined, 'no dependencies of its own');
});

test('settings are read in config.mjs only, and only its own', () => {
  const ALLOWED = ['DATABASE_URL', 'PORT', 'NODE_ENV', 'OPS_HOST', 'OPS_SETUP_CODE', 'OPS_SECRET', 'PLATFORM_SIGNING_KEY', 'OPS_CLIENT_ORIGIN', 'OPS_INSECURE_COOKIES', 'OPS_ALLOW_LOCAL'];
  for (const f of files.filter((x) => x.path !== 'config.mjs')) assert.doesNotMatch(f.text, /process\.env/, f.path);
  const config = files.find((x) => x.path === 'config.mjs').text;
  const read = [...new Set([...config.matchAll(/\benv\.([A-Z_]+)/g)].map((m) => m[1]))];
  assert.ok(read.length >= 8);
  for (const k of read) assert.ok(ALLOWED.includes(k), k);
  assert.equal([...config.replace(/^\s*\/\/.*$/gm, '').matchAll(/process\.env/g)].length, 1, 'one read of process.env, kept as env');
});

test('secret-like columns only in the sign-in tables, by their allowed names; a campaign’s values are an allow-list', () => {
  const sql = files.find((x) => x.path === 'db.sql').text;
  const SIGN_IN = ['operators', 'operator_setup', 'setup_tries', 'ops_sessions'];
  const ALLOWED = ['totp_last_step', 'password_hash', 'totp_sealed', 'recovery', 'recovery_salt', 'setup_code_hash', 'code_hash', 'token_hash'];
  // The log's chain: hashes of what the log says, not of any secret.
  const CHAIN = { ops_chain: ['last_hash'], ops_log: ['payload_hash', 'hash'] };
  const LOOKS_SECRET = /pass|hash|secret|seal|token|recovery|salt|(^|_)code($|_)|(^|_)key($|_)|totp|email|phone|name/;
  let seen = 0;
  for (const m of sql.matchAll(/create table if not exists (\w+) \(([\s\S]*?)\);\n/g)) {
    const [, table, body] = m;
    for (const line of body.split('\n')) {
      for (const col of line.replace(/--.*$/, '').split(',')) {
        const cm = /^\s*([a-z_]+)\s+([a-z]+)/.exec(col);
        if (!cm || ['primary', 'unique', 'check'].includes(cm[1])) continue;
        seen += 1;
        const [, name, type] = cm;
        if (!LOOKS_SECRET.test(name) || ['boolean', 'timestamptz', 'int', 'bigint'].includes(type)) continue;
        if (SIGN_IN.includes(table) && (ALLOWED.includes(name) || ['email', 'name'].includes(name) && table !== 'setup_tries')) continue;
        if (CHAIN[table]?.includes(name)) continue;
        if (table === 'campaigns' && ['name', 'display'].includes(name)) continue; // the campaign's short name and its name shown
        if (name === 'campaign') continue;
        assert.fail(`${table}.${name} looks like a secret or a person's detail`);
      }
    }
  }
  assert.ok(seen > 50, `columns read: ${seen}`);
  assert.deepEqual(VALUE_KEYS, ['city', 'province', 'rules', 'tz', 'races']);
  assert.deepEqual(pickValues({ city: 'X', tz: 'America/Toronto', token: 's', email: 'e@example.org', races: ['council'] }), { city: 'X', tz: 'America/Toronto', races: ['council'] });
  assert.match(files.find((x) => x.path === 'campaigns.mjs').text, /JSON\.stringify\(pickValues\(values\)\)/);
});

test('no line of the log is ever changed or removed', () => {
  for (const f of files) {
    assert.doesNotMatch(f.text, /update\s+ops_log/i, f.path);
    assert.doesNotMatch(f.text, /delete\s+from\s+ops_log/i, f.path);
    assert.doesNotMatch(f.text, /truncate[^;]*ops_log/i, f.path);
  }
});

test('the same kept names as the door', () => {
  assert.deepEqual(RESERVED, DOOR_RESERVED);
});

// How it ships: ops.base.win deploys from main whatever changed, so its
// tests run in CI on every change (and over Postgres, as on Render), its
// Node is pinned, and the notes around it say what is true now.
test('it ships tested and pinned: CI runs its tests on every change and over Postgres; Render pins Node 22', () => {
  const REPO = join(ROOT, '..', '..');
  const read = (p) => readFileSync(join(REPO, p), 'utf8');
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /run: npm run test:platform\s*$/m, 'ci.yml runs the control centre’s tests on every change');
  const wf = read('.github/workflows/base-platform.yml');
  assert.match(wf, /run: npm run test:platform:pg\s*$/m, 'base-platform.yml runs them over Postgres');
  for (const path of ['shared/**', 'web/src/app.css', 'package.json', 'package-lock.json', 'server/lib/**', 'server/test/entry-vector.json']) {
    for (const on of ['push', 'pull_request']) {
      const block = new RegExp(`${on}:[\\s\\S]*?paths: \\[([^\\]]*)\\]`).exec(wf)?.[1] || '';
      assert.ok(block.includes(`'${path}'`), `base-platform.yml ${on} paths include ${path}`);
    }
  }
  const render = read('render.yaml');
  const platform = /name: base-platform\n[\s\S]*?\n {2}- |name: base-platform\n[\s\S]*?\ndatabases:/.exec(render)?.[0] || '';
  assert.match(platform, /- key: NODE_VERSION[^\n]*\n\s+value: "22"/, 'base-platform pins Node 22 for Render’s native runtime');
  const header = render.split('\n').filter((l) => l.startsWith('#')).slice(0, 15).join('\n');
  assert.doesNotMatch(header, /-staging\)|copy of this file's pair/, 'render.yaml’s header no longer says to copy the pair');
  assert.match(header, /New campaign/);
  assert.doesNotMatch(read('apps/platform/README.md'), /Until the campaign server.s own entry is merged/);
});
