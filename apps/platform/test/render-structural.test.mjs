// The shape that keeps the Render key safe, pinned so a change to it is a
// changed test: one file names Render's host and reads the key; that file
// can make only the calls on a short list, none of which removes, stops or
// resizes anything; Render is asked only from inside a signed-in request,
// never by the poller or a page builder; every change goes through a code
// typed for it and the log; the lists of settings that may be read or
// written are exactly these; and nothing under apps/platform can run other
// code or carries a package of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseEnv } from './helpers.mjs';

baseEnv();
const { CALLS } = await import('../render-api.mjs');
const { READABLE, WRITABLE, WRITABLE_MADE, neededFor, writableFor } = await import('../render-guard.mjs');
const { DENY } = await import('../snippets.mjs');
const { cfg } = await import('../config.mjs');

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const sources = (dir = ROOT) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  if (e.isDirectory()) return e.name === 'test' || e.name === 'node_modules' ? [] : sources(join(dir, e.name));
  return /\.(mjs|js|sql)$/.test(e.name) ? [join(dir, e.name)] : [];
});
const files = sources().map((path) => ({ path: path.slice(ROOT.length), text: readFileSync(path, 'utf8') }));
const file = (path) => files.find((f) => f.path === path).text;
const api = file('render-api.mjs');

// S1
test('one file names Render’s host, builds the key’s header and reads the key; cfg() has no key', () => {
  for (const f of files.filter((x) => x.path !== 'render-api.mjs')) {
    assert.doesNotMatch(f.text, /api\.render\.com/, `${f.path} names Render’s API host`);
    assert.doesNotMatch(f.text, /Authorization/, `${f.path} builds an Authorization header`);
    assert.doesNotMatch(f.text, /renderKey\(/, `${f.path} reads the Render key`);
    assert.doesNotMatch(f.text, /Bearer /, `${f.path} builds a Bearer header`);
  }
  assert.equal([...api.matchAll(/Authorization/g)].length, 1, 'the header is built in one place');
  assert.equal([...api.matchAll(/api\.render\.com/g)].length, 1, 'the host is named once');
  const config = file('config.mjs');
  const inCfg = /export const cfg = \(\) => \(\{([\s\S]*?)\n\}\);/.exec(config)[1];
  assert.doesNotMatch(inCfg, /RENDER_API_KEY|renderKey|keyValue\(\)(?!\))/, 'cfg() returns no key');
  assert.match(inCfg, /render: Boolean\(keyValue\(\)\)/, 'only whether one is set');
  assert.equal([...config.matchAll(/env\.RENDER_API_KEY/g)].length, 1, 'the key is read from the settings in one place');
  process.env.RENDER_API_KEY = 'rnd_0123456789abcdefghijklmnop';
  assert.ok(!JSON.stringify(cfg()).includes('rnd_0123456789'));
  delete process.env.RENDER_API_KEY;
});

// S2
test('the calls Render can be asked are exactly these, and nothing destructive can be written in the file', () => {
  assert.deepEqual(CALLS, {
    self: ['GET', '/services/{id}'],
    workspaces: ['GET', '/owners?limit=20'],
    services: ['GET', '/services?ownerId={owner}&limit=100{cursor}'],
    service: ['GET', '/services/{id}'],
    lastDeploy: ['GET', '/services/{id}/deploys?limit=1'],
    domains: ['GET', '/services/{id}/custom-domains?limit=20'],
    isSet: ['GET', '/services/{id}/env-vars/{key}'],
    databases: ['GET', '/postgres?ownerId={owner}&limit=100{cursor}'],
    database: ['GET', '/postgres/{id}'],
    blueprints: ['GET', '/blueprints?limit=20'],
    deploy: ['POST', '/services/{id}/deploys'],
    restart: ['POST', '/services/{id}/restart'],
    setOne: ['PUT', '/services/{id}/env-vars/{key}'],
    addDomain: ['POST', '/services/{id}/custom-domains'],
    checkDomain: ['POST', '/services/{id}/custom-domains/{host}/verify'],
    closeDatabase: ['PATCH', '/postgres/{id}'],
    // Stage 2: a new campaign's database and service (spec rows 17 and 18).
    makeDatabase: ['POST', '/postgres'],
    connectionInfo: ['GET', '/postgres/{id}/connection-info'],
    makeService: ['POST', '/services'],
  });
  assert.ok(Object.isFrozen(CALLS));
  for (const never of ['DELETE', '/suspend', '/resume', '/scale', '/rollback', '/jobs', '/logs', '/export', '/recovery', '/credentials', '/secret-files',
    '/env-groups', '/disks', '/members', '/webhooks', 'rejectUnauthorized', 'action:']) {
    assert.ok(!api.includes(never), `render-api.mjs holds ${never}`);
  }
  // A new database's connection details: named once (the table), asked for
  // once (inside makeService), and never returned.
  assert.equal([...api.matchAll(/connection-info/g)].length, 1, 'connection-info is named once, in the table');
  assert.equal([...api.matchAll(/call\('connectionInfo'/g)].length, 1, 'and asked for in one place');
  const makeService = api.slice(api.indexOf('const makeService = '), api.indexOf('\n  };\n', api.indexOf('const makeService = ')));
  assert.match(makeService, /call\('connectionInfo'/, 'that place is makeService');
  assert.doesNotMatch(makeService, /return[^;]*internalConnectionString/, 'the address is never handed back');
  assert.equal([...api.matchAll(/internalConnectionString/g)].length, 1, 'read in one place');
  // A create only after the gate's target, and only through these two functions.
  assert.equal([...api.matchAll(/call\('makeDatabase'/g)].length, 1);
  assert.equal([...api.matchAll(/call\('makeService'/g)].length, 1);
  assert.doesNotMatch(api, /'PUT',\s*'[^']*\/env-vars'/, 'no write of the whole settings list');
  assert.doesNotMatch(api, /'(PATCH|PUT)',\s*'\/services(\/\{id\})?'/, 'no change to a service itself');
  assert.doesNotMatch(api, /method:\s*'(?!GET)/, 'no method outside the table');
  // The only quoted HTTP methods in the file are the table's.
  const methods = [...api.matchAll(/'(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)'/g)].map((m) => m[1]);
  assert.equal(methods.filter((m) => m !== 'GET').length, Object.values(CALLS).filter(([m]) => m !== 'GET').length + 0, 'every write is a row of the table');
  // No request function is exported: only the client's maker, its table and its words.
  const exported = [...api.matchAll(/^export (?:const|function|class) (\w+)/gm)].map((m) => m[1]);
  assert.deepEqual(exported.sort(), ['CALLS', 'SHAPES', 'makeRender', 'sharedRender']);
});

// S3
test('Render is asked only from inside a request: not by the poller, the database, the log, the checklist or a page', () => {
  const importers = files.filter((f) => /from\s+'[^']*render-api\.mjs'/.test(f.text)).map((f) => f.path).sort();
  assert.deepEqual(importers, ['server.mjs'], 'only server.mjs imports the client');
  for (const path of ['poller.mjs', 'safe-fetch.mjs', 'db.mjs', 'log.mjs', 'checklist.mjs', ...files.map((f) => f.path).filter((p) => p.startsWith('pages/'))]) {
    assert.doesNotMatch(file(path), /(?:from|import)\s*\(?\s*'[^']*render-api/, `${path} imports the Render client`);
  }
  const server = file('server.mjs');
  const start = server.indexOf('export const makeApp');
  const end = server.indexOf('\n};\n', start);
  assert.ok(start > 0 && end > start);
  const outside = server.slice(0, start).replace(/^import .*$/gm, '') + server.slice(end);
  assert.doesNotMatch(outside, /sharedRender|makeRender/, 'server.mjs uses the client only inside makeApp');
  assert.match(server.slice(start, end), /sharedRender\(\)/);
  // The health checks still go out with no credentials of any kind.
  assert.doesNotMatch(file('safe-fetch.mjs'), /render|authorization|bearer/i);
  assert.doesNotMatch(file('poller.mjs'), /render-|ctx\.render/);
});

// S4
test('every Render change goes through a code typed for it and the log; the 10-minute window opens nothing there', () => {
  const routes = file('render-routes.mjs');
  assert.doesNotMatch(routes, /codeWindow/, 'the 10-minute window is not used for Render');
  assert.doesNotMatch(routes, /codeFresh/);
  // The file, cut at each route: a part runs from its app.get( or app.post( to the next.
  const parts = routes.split(/\n(?=\s*app\.(?:get|post)\()/);
  const posts = parts.filter((part) => /^\s*app\.post\(/.test(part));
  assert.ok(posts.length >= 2, `POST routes found: ${posts.length}`);
  let changes = 0;
  for (const body of posts) {
    const path = /app\.post\('([^']+)'/.exec(body)[1];
    if (path === '/render/check') {
      assert.doesNotMatch(body, /\.(deploy|restart|setOne|addDomain|checkDomain|closeDatabase|target)\(/, 'Check Render’s answers only reads');
      continue;
    }
    changes += 1;
    assert.match(body, /freshAppCode\(/, `${path} asks for a code typed for it`);
    assert.match(body, /appendLog/, `${path} writes the log`);
  }
  assert.equal(changes, 1, 'one route makes every change');
  // The start line is committed before Render is asked.
  const change = posts.find((p) => p.includes("'/c/:name/render/:what'"));
  assert.ok(change.indexOf("action: 'render.start'") > 0 && change.indexOf("action: 'render.start'") < change.indexOf('await run('), 'render.start is written before the call');
  assert.ok(change.indexOf('await run(') < change.indexOf("action: 'render.result'"), 'render.result after it');
});

// S5
test('the settings that may be read or written are exactly these: no secret, nothing of staging’s', () => {
  assert.deepEqual(READABLE, ['NODE_ENV', 'STARBASE_ENV', 'STARBASE_PUBLIC_URL', 'STARBASE_BRAND', 'STARBASE_ORG_NAME', 'STARBASE_JURISDICTION', 'STARBASE_TZ',
    'STARBASE_CITY', 'STARBASE_SLATES', 'STARBASE_PROVINCE', 'STARBASE_GEO_BOUNDS', 'STARBASE_CANDIDATES', 'BASE_PLATFORM_PUBKEY']);
  assert.deepEqual(WRITABLE, ['BASE_PLATFORM_PUBKEY']);
  const snippets = file('snippets.mjs');
  const LATER = /const LATER = \[([\s\S]*?)\];/.exec(snippets)[1].match(/[A-Z][A-Z0-9_]+/g);
  assert.ok(LATER.length >= 10);
  const never = ['DATABASE_URL', 'STARBASE_TWO_STEP_KEY', 'GOOGLE_TOKEN_KEY', 'RENDER_API_KEY', 'OPS_SECRET', 'OPS_SETUP_CODE', 'PLATFORM_SIGNING_KEY', ...DENY, ...LATER];
  for (const name of never) {
    assert.ok(!READABLE.includes(name), `${name} can be read`);
    assert.ok(!WRITABLE.includes(name), `${name} can be written`);
  }
  for (const name of ['NODE_ENV', 'STARBASE_ENV', 'STARBASE_OWN_URL', 'APP_HOSTS', 'GOOGLE_MAPS_TILES', 'STARBASE_PUBLIC_URL']) assert.ok(!WRITABLE.includes(name), `${name} can be written`);
  for (const name of READABLE) assert.doesNotMatch(name, /SECRET|TOKEN|PASSWORD|DATABASE/, name);
  const running = { kind: 'client', values: {} };
  const made = { kind: 'client', values: { city: 'X', province: 'BC', rules: 'bc-municipal', tz: 'America/Vancouver', races: ['council'], bounds: '1,2|3,4' } };
  assert.deepEqual(neededFor({ kind: 'sample', values: {} }), ['STARBASE_ENV', 'BASE_PLATFORM_PUBKEY']);
  assert.deepEqual(neededFor(running), ['NODE_ENV', 'STARBASE_ENV', 'STARBASE_PUBLIC_URL', 'STARBASE_BRAND', 'STARBASE_ORG_NAME', 'STARBASE_JURISDICTION', 'STARBASE_TZ',
    'STARBASE_CITY', 'STARBASE_SLATES', 'BASE_PLATFORM_PUBKEY'], 'a campaign added as already running: the three it never had are its own configuration');
  assert.deepEqual(neededFor(made), READABLE);
  for (const c of [running, made, { kind: 'sample', values: {} }]) assert.deepEqual(writableFor(c), ['BASE_PLATFORM_PUBKEY']);
  // Stage 2, with the gate open: a campaign made with New campaign may have
  // its missing settings added, each to its own value. Never the others.
  assert.deepEqual(WRITABLE_MADE, ['BASE_PLATFORM_PUBKEY', 'STARBASE_PUBLIC_URL', 'STARBASE_BRAND', 'STARBASE_ORG_NAME', 'STARBASE_CITY', 'STARBASE_JURISDICTION',
    'STARBASE_PROVINCE', 'STARBASE_TZ', 'STARBASE_SLATES', 'STARBASE_GEO_BOUNDS', 'STARBASE_CANDIDATES']);
  for (const name of [...never, 'NODE_ENV', 'STARBASE_ENV', 'STARBASE_OWN_URL', 'APP_HOSTS', 'GOOGLE_MAPS_TILES']) assert.ok(!WRITABLE_MADE.includes(name), `${name} can be written`);
  assert.deepEqual(writableFor(made, { stage2: true }), WRITABLE_MADE);
  for (const c of [running, { kind: 'sample', values: {} }, { ...made, kind: 'sample' }]) assert.deepEqual(writableFor(c, { stage2: true }), ['BASE_PLATFORM_PUBKEY']);
});

// S6
test('nothing under apps/platform can run other code, and it has no package of its own', () => {
  for (const f of files) {
    for (const never of ['child_process', 'eval(', 'new Function', 'node:vm', 'node:worker_threads']) {
      assert.ok(!f.text.includes(never), `${f.path} holds ${never}`);
    }
    assert.doesNotMatch(f.text, /\bimport\s*\(\s*[^'"]/, `${f.path} imports a path it works out`);
  }
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  for (const kind of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) assert.equal(pkg[kind], undefined, kind);
  assert.equal(readdirSync(ROOT).includes('node_modules'), false);
});

// S4 for making: each create is asked for only after its "Asked Render
// to…" line is committed, and a create is only ever called from the steps.
test('every create is asked for after its log line, from one place, with the gate’s target', () => {
  const make = file('render-make.mjs');
  for (const fn of ['makeDatabase', 'makeService']) {
    const calls = [...make.matchAll(new RegExp(`client\\.${fn}\\(`, 'g'))];
    assert.equal(calls.length, 1, `${fn} is called once`);
    const before = make.slice(0, calls[0].index);
    assert.ok(before.lastIndexOf('await begin(') > before.lastIndexOf('const step'), `${fn}: the start line is written first`);
  }
  assert.match(make, /const begin = [^\n]*\n[\s\S]*?action: 'render\.start'/, 'begin() writes render.start');
  for (const f of files.filter((x) => !['render-api.mjs', 'render-make.mjs'].includes(x.path))) {
    assert.doesNotMatch(f.text, /\.make(Database|Service|Target)\(/, `${f.path} makes something in Render`);
  }
  assert.match(file('render-routes.mjs'), /makeGate\(/, 'the routes ask the gate');
});

// S7: nothing under apps/platform (but its tests) names a client.
test('no file of the control centre names a client', () => {
  for (const f of files) assert.doesNotMatch(f.text, /Surrey|Imagine/, f.path);
});

test('the tables keep ids, names of settings and states: never a value or a body', () => {
  const sql = file('db.sql');
  const jobs = /create table if not exists render_jobs \(([\s\S]*?)\n\);/.exec(sql)[1];
  const cols = jobs.split('\n').map((l) => /^\s*([a-z_]+)\s/.exec(l)?.[1]).filter(Boolean);
  assert.deepEqual(cols, ['id', 'campaign', 'env', 'what', 'target', 'detail', 'state', 'asked_in', 'asked_at', 'began_at', 'problem']);
  assert.match(sql, /alter table environments add column if not exists render_service text;/);
  assert.match(sql, /alter table environments add column if not exists render_db text;/);
  assert.match(sql, /create unique index if not exists render_jobs_one_running on render_jobs \(campaign\) where state = 'running';/);
  assert.doesNotMatch(sql, /create table if not exists render_(?!jobs)/, 'no table of Render’s answers');
});

// A Blueprint sync writes render.yaml's branch over one changed only in
// Render, so "Before the key" asks for the branch in render.yaml itself,
// in the page's own steps, the README and GOING-LIVE alike.
test('before the key: the control centre’s branch is production in render.yaml, not only in Render', () => {
  const read = (p) => readFileSync(new URL(p, new URL('../', import.meta.url)), 'utf8');
  const step = (text) => text.slice(text.indexOf('Before the key'), text.indexOf('Before the key') + 1500).replace(/<[^>]+>|[`*]/g, '').replace(/\s+/g, ' ');
  for (const [name, text] of [['pages/render.mjs', file('pages/render.mjs')], ['README.md', read('README.md')], ['GOING-LIVE.md', read('../../GOING-LIVE.md')]]) {
    const s = step(text);
    assert.match(s, /render\.yaml.{0,4}s base-platform block says branch: production/, name);
    assert.match(s, /A Blueprint sync writes render\.yaml.{0,4}s branch over a change made only in Render/, name);
  }
});
