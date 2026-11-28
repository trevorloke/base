// The built-in database's folder (server/db/client.js): the default is now
// ./data/base-win (/data/base-win in the container), and a folder made under
// the older default is still the one opened while it is there and the new
// one is not. No folder is ever renamed, copied or deleted.
//
// The real opening runs in a child process started in a temporary folder, so
// the relative default lands there and nothing is written to this checkout.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDirFor } from '../db/client.js';
import { OLD_DATA_DIRS, OLD_SETTINGS, settingNames } from '../../shared/old-names.js';

const CLIENT = new URL('../db/client.js', import.meta.url).href;
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NEW_DIR = './data/base-win';
const OLD_DIR = OLD_DATA_DIRS[NEW_DIR];
const temps = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'base-win-data-')); temps.push(d); return d; };
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

// Every folder under a folder, as relative paths, sorted (files left out).
const folders = (root, at = '') => readdirSync(join(root, at), { withFileTypes: true }).filter((e) => e.isDirectory())
  .flatMap((e) => { const p = at ? `${at}/${e.name}` : e.name; return [p, ...folders(root, p)]; }).sort();
const topFolders = (root) => folders(root).filter((p) => p.split('/').length <= 2);

// Open the built-in database from `cwd` with these settings, then close it. → { code, out, err }
const open = (cwd, settings = {}) => new Promise((ok) => {
  const env = { ...process.env };
  for (const k of ['NODE_TEST_CONTEXT', 'DATABASE_URL', 'RENDER', 'IMAGE_DATA_DIR', ...settingNames('BASE_DATA')]) delete env[k];
  Object.assign(env, settings);
  const code = `const m = await import(${JSON.stringify(CLIENT)}); const db = await m.getDb(); await db.query('select 1'); await db.close();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.on('exit', (c) => ok({ code: c, out, err }));
});
const isDatabase = (dir) => existsSync(join(dir, 'PG_VERSION'));

test('the older folder is there and the new one is not: the older one is opened, and no folder is made or moved', async () => {
  const cwd = temp();
  mkdirSync(join(cwd, OLD_DIR), { recursive: true });
  // A first run there (as before the rename) leaves a database in it.
  let r = await open(cwd, { [OLD_SETTINGS.BASE_DATA]: OLD_DIR });
  assert.equal(r.code, 0, r.err);
  assert.ok(isDatabase(join(cwd, OLD_DIR)));
  writeFileSync(join(cwd, OLD_DIR, 'marker.txt'), 'kept');
  const before = topFolders(cwd);

  r = await open(cwd);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(topFolders(cwd), before, 'the same folders before and after');
  assert.ok(!existsSync(join(cwd, NEW_DIR)), 'no new folder');
  assert.equal(readFileSync(join(cwd, OLD_DIR, 'marker.txt'), 'utf8'), 'kept');
  const said = (r.out + r.err).split('\n').filter((l) => /older folder/.test(l));
  assert.deepEqual(said, [`base.win: using the built-in database's older folder ${OLD_DIR}; it is never moved automatically.`]);
});

test('neither folder: the new one is made', async () => {
  const cwd = temp();
  const r = await open(cwd);
  assert.equal(r.code, 0, r.err);
  assert.ok(isDatabase(join(cwd, NEW_DIR)), 'the database is in the new folder');
  assert.ok(!existsSync(join(cwd, OLD_DIR)), 'and no older one is made');
  assert.doesNotMatch(r.out + r.err, /older folder/);
});

test('both folders: the new one is used, the older one is left alone', async () => {
  const cwd = temp();
  mkdirSync(join(cwd, OLD_DIR), { recursive: true });
  writeFileSync(join(cwd, OLD_DIR, 'marker.txt'), 'kept');
  mkdirSync(join(cwd, NEW_DIR), { recursive: true });
  const r = await open(cwd);
  assert.equal(r.code, 0, r.err);
  assert.ok(isDatabase(join(cwd, NEW_DIR)));
  assert.ok(!isDatabase(join(cwd, OLD_DIR)));
  assert.deepEqual(readdirSync(join(cwd, OLD_DIR)), ['marker.txt']);
  assert.doesNotMatch(r.out + r.err, /older folder/);
});

test('where the folder comes from: a set folder, either name, wins over every default; blank counts as unset', () => {
  const none = () => false;
  assert.deepEqual(dataDirFor({}, none), { dir: NEW_DIR, older: false });
  assert.deepEqual(dataDirFor({ NODE_TEST_CONTEXT: '1' }, none), { dir: 'memory', older: false });
  assert.deepEqual(dataDirFor({ BASE_DATA: '/srv/riverbend' }, none), { dir: '/srv/riverbend', older: false });
  assert.deepEqual(dataDirFor({ [OLD_SETTINGS.BASE_DATA]: '/srv/riverbend' }, none), { dir: '/srv/riverbend', older: false });
  assert.deepEqual(dataDirFor({ BASE_DATA: ' ', [OLD_SETTINGS.BASE_DATA]: '/srv/riverbend' }, none), { dir: '/srv/riverbend', older: false });
  assert.deepEqual(dataDirFor({ BASE_DATA: '/srv/new', [OLD_SETTINGS.BASE_DATA]: '/srv/old' }, none), { dir: '/srv/new', older: false });
  // The older default only for the defaults, and only while the new one isn't there.
  const only = (...there) => (p) => there.includes(p);
  assert.deepEqual(dataDirFor({}, only(OLD_DIR)), { dir: OLD_DIR, older: true });
  assert.deepEqual(dataDirFor({}, only(OLD_DIR, NEW_DIR)), { dir: NEW_DIR, older: false });
  assert.deepEqual(dataDirFor({ BASE_DATA: '/srv/riverbend' }, only(OLD_DIR)), { dir: '/srv/riverbend', older: false });
});

// The container (Dockerfile): its own default folder is not a setting, so a
// folder set on the service under either name always wins over it.
const imageEnv = () => {
  const text = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
  const runtime = text.slice(text.lastIndexOf('\nFROM '));
  const env = {};
  for (const m of runtime.matchAll(/^ENV\s+((?:[^\n]*\\\n)*[^\n]*)/gm)) {
    for (const pair of m[1].replace(/\\\n/g, ' ').trim().split(/\s+/)) {
      const at = pair.indexOf('=');
      if (at > 0) env[pair.slice(0, at)] = pair.slice(at + 1);
    }
  }
  return env;
};

test('the container: the image sets no data setting under either name; its default folder is the new one, and the older one is used while only it is there', () => {
  const image = imageEnv();
  for (const k of settingNames('BASE_DATA')) assert.equal(image[k], undefined, `the image sets ${k}`);
  assert.equal(image.IMAGE_DATA_DIR, '/data/base-win');
  assert.ok(Object.hasOwn(OLD_DATA_DIRS, image.IMAGE_DATA_DIR), 'a default with an older folder beside it');
  const none = () => false;
  assert.deepEqual(dataDirFor(image, none), { dir: '/data/base-win', older: false });
  assert.deepEqual(dataDirFor(image, (p) => p === OLD_DATA_DIRS['/data/base-win']), { dir: OLD_DATA_DIRS['/data/base-win'], older: true });
  // A folder set on the service on purpose (documented in the guides), under the older name.
  assert.deepEqual(dataDirFor({ ...image, [OLD_SETTINGS.BASE_DATA]: '/x' }, none), { dir: '/x', older: false });
  assert.deepEqual(dataDirFor({ ...image, BASE_DATA: '/x' }, none), { dir: '/x', older: false });
});

test('the container opens a folder set under the older name, with the image’s own settings around it', async () => {
  const cwd = temp();
  const x = join(temp(), 'x');
  // The image's settings, with its default folder moved under this test's folder so nothing outside it is touched.
  const image = { ...imageEnv(), IMAGE_DATA_DIR: join(cwd, 'image-default') };
  delete image.PORT;
  const r = await open(cwd, { ...image, [OLD_SETTINGS.BASE_DATA]: x });
  assert.equal(r.code, 0, r.err);
  assert.ok(isDatabase(x), 'opened /x');
  assert.ok(!existsSync(join(cwd, 'image-default')), 'not the image’s default');
});
