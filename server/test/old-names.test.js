// The table of older names (shared/old-names.js): a setting saved in Render
// under its older name keeps working, the newer name wins when both are set,
// a blank setting never hides a real one, and nothing a person sees or a log
// prints carries a value. This file may write the older names out: it proves
// they still work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as names from '@base-win/shared/old-names';
import * as direct from '../../shared/old-names.js';

const {
  OLD_WORD, OLD_SETTINGS, JOINED, SECRET, setting, settingNames, bothNames, newNameOf, adoptOldNames,
  OLD_STORAGE, OLD_DATA_DIRS, OLD_HEALTH_SERVICE, OLD_EXPORT_FORMAT,
} = names;

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FILE = join(ROOT, 'shared/old-names.js');

// Every STARBASE_* setting base.win read at 82c8990, written out by hand from
// `git grep` on that commit (the website's own three, STARBASE_URL,
// STARBASE_KEY and STARBASE_INBOUND_KEY, live in apps/web's table instead).
const AT_82C8990 = Object.freeze([
  'STARBASE_AB_SEND_PER_RUN', 'STARBASE_BRAND', 'STARBASE_CANDIDATES', 'STARBASE_CITY', 'STARBASE_CLOCK_SHIFT_MS',
  'STARBASE_DATA', 'STARBASE_DEMO_EMAIL', 'STARBASE_E2E', 'STARBASE_EMAIL_TIMEOUT_MS', 'STARBASE_EMBEDDED_DB',
  'STARBASE_ENV', 'STARBASE_FRAME_HOSTS', 'STARBASE_GEO_BOUNDS', 'STARBASE_GOTV_LOCK_MS', 'STARBASE_GOTV_PING_MS',
  'STARBASE_JOBS', 'STARBASE_JOBS_EVERY_MS', 'STARBASE_JURISDICTION', 'STARBASE_LIST_COUNTS_MS', 'STARBASE_MAP_ALL',
  'STARBASE_MAP_DOTS', 'STARBASE_MAP_VIEW', 'STARBASE_OPEN_SIGNUP', 'STARBASE_ORG_NAME', 'STARBASE_OWN_URL',
  'STARBASE_PROVINCE', 'STARBASE_PTW_CACHE_MS', 'STARBASE_PUBLIC_URL', 'STARBASE_RECEIPT_DELAY_S', 'STARBASE_SAMPLE',
  'STARBASE_SAMPLE_RESET', 'STARBASE_SECURE_COOKIES', 'STARBASE_SEND_INLINE_MS', 'STARBASE_SEND_PER_RUN',
  'STARBASE_SITE_DOMAIN', 'STARBASE_SITE_FORMER_URL', 'STARBASE_SLATES', 'STARBASE_TILE_ATTRIBUTION',
  'STARBASE_TILE_CARTO_KEY', 'STARBASE_TILE_CLEAN', 'STARBASE_TILE_KEY', 'STARBASE_TILE_MAX_ZOOM',
  'STARBASE_TILE_PROVIDER', 'STARBASE_TILE_URL', 'STARBASE_TRUSTED_PROXIES', 'STARBASE_TWO_STEP_KEY', 'STARBASE_TZ',
  'STARBASE_WEBSITE_KEY', 'STARBASE_WEBSITE_URL',
]);
// The website's own settings (apps/web reads them, not base.win) and names in
// the website's code that only look like settings.
const NOT_BASE_WIN_SETTINGS = new Set([
  'STARBASE_URL', 'STARBASE_KEY', 'STARBASE_INBOUND_KEY',
  'STARBASE_FIELDS', 'STARBASE_LIMITS', 'STARBASE_TEST_KEY', 'STARBASE_TIMEOUT_MS', 'STARBASE_ENDPOINTS',
]);
const ENTRIES = Object.entries(OLD_SETTINGS);

test('the shared package exposes the table, and it is the same module as the file', () => {
  assert.equal(names.setting, direct.setting);
  assert.equal(names.OLD_SETTINGS, direct.OLD_SETTINGS);
  const pkg = JSON.parse(readFileSync(join(ROOT, 'shared/package.json'), 'utf8'));
  assert.equal(pkg.exports['./old-names'], './old-names.js');
});

test('an older setting name still works when the newer one is not set', () => {
  assert.equal(setting('BASE_TZ', { STARBASE_TZ: 'America/Edmonton' }), 'America/Edmonton');
  for (const [now, old] of ENTRIES) {
    if (JOINED.includes(now)) continue;
    assert.equal(setting(now, { [old]: 'from-the-older-name' }), 'from-the-older-name', now);
  }
});

test('when both names are set, the newer one wins', () => {
  assert.equal(setting('BASE_TZ', { BASE_TZ: 'America/Vancouver', STARBASE_TZ: 'America/Edmonton' }), 'America/Vancouver');
  for (const [now, old] of ENTRIES) {
    if (JOINED.includes(now)) continue;
    assert.equal(setting(now, { [now]: 'newer', [old]: 'older' }), 'newer', now);
  }
});

test('a blank setting counts as not set, so it never hides a real value', () => {
  assert.equal(setting('BASE_TZ', { BASE_TZ: '  ', STARBASE_TZ: 'X' }), 'X');
  assert.equal(setting('BASE_TZ', { BASE_TZ: '', STARBASE_TZ: 'X' }), 'X');
  assert.equal(setting('BASE_TZ', { BASE_TZ: '\t\n', STARBASE_TZ: 'X' }), 'X');
  assert.equal(setting('BASE_TZ', { BASE_TZ: 'Y', STARBASE_TZ: '  ' }), 'Y');
  // The value itself is handed back as it was set, spaces and all.
  assert.equal(setting('BASE_ORG_NAME', { STARBASE_ORG_NAME: ' Riverbend Forward ' }), ' Riverbend Forward ');
});

test('when neither name has a value, the reader sees what it saw before (blank or missing)', () => {
  // Readers written as `?? fallback` or `!= null` treat a blank setting as
  // set; that behaviour stays, only the older/newer choice ignores blanks.
  assert.equal(setting('BASE_TZ', {}), undefined);
  assert.equal(setting('BASE_TZ', { BASE_TZ: '' }), '');
  assert.equal(setting('BASE_TZ', { STARBASE_TZ: '' }), '');
  assert.equal(setting('BASE_TZ', { BASE_TZ: ' ', STARBASE_TZ: '' }), ' ');
});

test('a name outside the table is read as it is', () => {
  assert.equal(setting('BASE_PATH', { BASE_PATH: '/one' }), '/one');
  assert.equal(setting('BASE_PATH', {}), undefined);
  assert.equal(setting('PORT', { PORT: '5750' }), '5750');
});

test('asking by the older name reads the same setting', () => {
  assert.equal(setting('STARBASE_TZ', { BASE_TZ: 'America/Vancouver', STARBASE_TZ: 'America/Edmonton' }), 'America/Vancouver');
  assert.equal(setting('STARBASE_TZ', { STARBASE_TZ: 'America/Edmonton' }), 'America/Edmonton');
});

test('the two-step key joins both names, newer first, with no value repeated', () => {
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  const c = 'c'.repeat(40);
  assert.deepEqual(JOINED, ['BASE_TWO_STEP_KEY']);
  assert.equal(setting('BASE_TWO_STEP_KEY', { BASE_TWO_STEP_KEY: a, STARBASE_TWO_STEP_KEY: b }), `${a},${b}`);
  assert.equal(setting('BASE_TWO_STEP_KEY', { BASE_TWO_STEP_KEY: a, STARBASE_TWO_STEP_KEY: a }), a);
  assert.equal(setting('BASE_TWO_STEP_KEY', { STARBASE_TWO_STEP_KEY: b }), b);
  assert.equal(setting('BASE_TWO_STEP_KEY', { BASE_TWO_STEP_KEY: a }), a);
  // Each name may already hold a list (server/lib/twostep.js splits on commas and spaces).
  assert.equal(setting('BASE_TWO_STEP_KEY', { BASE_TWO_STEP_KEY: `${a} ${b}`, STARBASE_TWO_STEP_KEY: `${b},${c}` }), `${a},${b},${c}`);
  assert.equal(setting('BASE_TWO_STEP_KEY', { BASE_TWO_STEP_KEY: '  ', STARBASE_TWO_STEP_KEY: b }), b);
  assert.equal(setting('BASE_TWO_STEP_KEY', {}), undefined);
});

test('with no env given, the server\'s own settings are read', () => {
  const was = { BASE_TZ: process.env.BASE_TZ, STARBASE_TZ: process.env.STARBASE_TZ };
  try {
    delete process.env.BASE_TZ;
    process.env.STARBASE_TZ = 'America/Regina';
    assert.equal(setting('BASE_TZ'), 'America/Regina');
    process.env.BASE_TZ = 'America/Halifax';
    assert.equal(setting('BASE_TZ'), 'America/Halifax');
  } finally {
    for (const [k, v] of Object.entries(was)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test('adoptOldNames copies an older value only where the newer one is blank, and never removes the older one', () => {
  const env = {
    STARBASE_TZ: 'America/Edmonton',                        // only old: copied
    BASE_BRAND: 'riverbend', STARBASE_BRAND: 'riverbend',    // both, same: left alone
    BASE_CITY: 'Riverbend', STARBASE_CITY: 'Lakeshore',      // both, differ: newer kept
    BASE_ORG_NAME: '   ', STARBASE_ORG_NAME: 'Riverbend Together', // new blank: copied
    BASE_SLATES: 'council',                                   // only new: nothing to do
    STARBASE_MAP_ALL: '',                                     // old blank: not "still old"
    PORT: '5750',
  };
  const out = adoptOldNames(env);
  assert.equal(env.BASE_TZ, 'America/Edmonton');
  assert.equal(env.BASE_BRAND, 'riverbend');
  assert.equal(env.BASE_CITY, 'Riverbend');
  assert.equal(env.BASE_ORG_NAME, 'Riverbend Together');
  assert.equal(env.BASE_SLATES, 'council');
  assert.equal(env.BASE_MAP_ALL, undefined);
  // The older names are still there: nothing is ever deleted.
  assert.equal(env.STARBASE_TZ, 'America/Edmonton');
  assert.equal(env.STARBASE_CITY, 'Lakeshore');
  assert.equal(env.STARBASE_MAP_ALL, '');
  assert.equal(env.PORT, '5750');
  assert.deepEqual([...out.stillOld].sort(), ['BASE_BRAND', 'BASE_CITY', 'BASE_ORG_NAME', 'BASE_TZ']);
  assert.deepEqual(out.differ, ['BASE_CITY']);
});

test('adoptOldNames joins the two-step key and does not call a second key a conflict', () => {
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  const env = { BASE_TWO_STEP_KEY: a, STARBASE_TWO_STEP_KEY: b };
  const out = adoptOldNames(env);
  assert.equal(env.BASE_TWO_STEP_KEY, `${a},${b}`);
  assert.equal(env.STARBASE_TWO_STEP_KEY, b);
  assert.deepEqual(out.stillOld, ['BASE_TWO_STEP_KEY']);
  assert.deepEqual(out.differ, []);
  // Running it again changes nothing.
  const again = adoptOldNames(env);
  assert.equal(env.BASE_TWO_STEP_KEY, `${a},${b}`);
  assert.deepEqual(again, out);
  const onlyOld = { STARBASE_TWO_STEP_KEY: b };
  adoptOldNames(onlyOld);
  assert.equal(onlyOld.BASE_TWO_STEP_KEY, b);
});

test('adoptOldNames returns names only, never a value', () => {
  const env = {};
  const values = [];
  for (const [now, old] of ENTRIES) {
    const v = `value-of-${old.toLowerCase()}-7f3a`;
    values.push(v, `other-${v}`);
    env[old] = v;
    if (now.length % 2) env[now] = `other-${v}`; // half differ
  }
  const out = adoptOldNames(env);
  const said = JSON.stringify(out);
  for (const v of values) assert.ok(!said.includes(v), `a value reached the result: ${v}`);
  assert.deepEqual(Object.keys(out).sort(), ['differ', 'stillOld']);
  for (const n of [...out.stillOld, ...out.differ]) assert.ok(n in OLD_SETTINGS, n);
  assert.equal(out.stillOld.length, ENTRIES.length);
  assert.ok(out.differ.length > 0);
});

test('adoptOldNames with nothing old set changes nothing', () => {
  const env = { BASE_TZ: 'America/Toronto', PORT: '5751' };
  assert.deepEqual(adoptOldNames(env), { stillOld: [], differ: [] });
  assert.deepEqual(env, { BASE_TZ: 'America/Toronto', PORT: '5751' });
});

test('settingNames, bothNames and newNameOf round-trip for every entry', () => {
  for (const [now, old] of ENTRIES) {
    assert.deepEqual(settingNames(now), [now, old]);
    assert.deepEqual(settingNames(old), [now, old]);
    assert.deepEqual(bothNames(now), [now, old]);
    assert.equal(newNameOf(now), now);
    assert.equal(newNameOf(old), now);
    assert.equal(OLD_SETTINGS[newNameOf(old)], old);
  }
  assert.deepEqual(settingNames('BASE_PATH'), ['BASE_PATH']);
  assert.deepEqual(settingNames('PORT'), ['PORT']);
  assert.equal(newNameOf('BASE_PATH'), 'BASE_PATH');
  assert.equal(newNameOf('RENDER_API_KEY'), 'RENDER_API_KEY');
});

test('every newer name starts BASE_ and is the older name with only its first word changed', () => {
  const news = Object.keys(OLD_SETTINGS);
  const olds = Object.values(OLD_SETTINGS);
  assert.equal(new Set(news).size, news.length);
  assert.equal(new Set(olds).size, olds.length);
  for (const [now, old] of ENTRIES) {
    assert.match(now, /^BASE_[A-Z0-9_]+$/);
    assert.equal(old, `STARBASE_${now.slice('BASE_'.length)}`);
  }
  // No clash with settings that already carry the newer word.
  for (const taken of ['BASE_PATH', 'BASE_DOOR_KEY', 'BASE_CLIENTS', 'BASE_APEX', 'BASE_PLATFORM_PUBKEY']) {
    assert.ok(!(taken in OLD_SETTINGS), taken);
  }
});

test('the table covers all 49 settings base.win read at 82c8990', () => {
  assert.equal(AT_82C8990.length, 49);
  assert.deepEqual(Object.values(OLD_SETTINGS).sort(), [...AT_82C8990].sort());
});

// Files the repository tracks (or, with no git, every file under it).
const trackedFiles = () => {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 }).split('\0').filter(Boolean);
  } catch {
    const out = [];
    const walk = (dir) => {
      for (const n of readdirSync(dir)) {
        if (n === 'node_modules' || n === '.git' || n === '.claude') continue;
        const p = join(dir, n);
        if (statSync(p).isDirectory()) walk(p); else out.push(relative(ROOT, p));
      }
    };
    walk(ROOT);
    return out;
  }
};

test('no older setting name is in use anywhere that the table does not know', () => {
  // Catches a setting added after this table was written: until it is in the
  // table, a server that has it saved under the older name would lose it.
  const missing = [];
  for (const f of trackedFiles()) {
    if (f.startsWith('apps/web/') || f.includes('old-names')) continue;
    let text;
    try { text = readFileSync(join(ROOT, f), 'utf8'); } catch { continue; }
    if (text.includes('\0')) continue;
    for (const [n] of text.matchAll(/STARBASE_[A-Z0-9_]*[A-Z0-9](?![A-Za-z0-9_])/g)) {
      if (NOT_BASE_WIN_SETTINGS.has(n) || newNameOf(n) !== n) continue;
      missing.push(`${f}: ${n}`);
    }
  }
  assert.deepEqual([...new Set(missing)], []);
});

test('the secret settings are in the table, and the joined one is secret', () => {
  for (const n of SECRET) assert.ok(n in OLD_SETTINGS, n);
  for (const n of JOINED) assert.ok(SECRET.includes(n), n);
  assert.deepEqual([...SECRET].sort(), ['BASE_TILE_CARTO_KEY', 'BASE_TILE_KEY', 'BASE_TWO_STEP_KEY', 'BASE_WEBSITE_KEY']);
});

test('the phone, folder, health and export names are the ones saved today', () => {
  assert.equal(OLD_WORD, 'starbase');
  assert.equal(OLD_STORAGE.prefix, 'starbase:');
  assert.equal(OLD_STORAGE.rootLock, 'starbase-outbox');
  assert.equal(OLD_STORAGE.tilesMessage, 'starbase:tiles');
  // Kept in localStorage (web/src/pages/People.jsx), so a person's Phone/Text
  // choice can be carried over.
  assert.equal(OLD_STORAGE.callsChannel, 'starbase.calls.channel:');
  assert.deepEqual({ ...OLD_DATA_DIRS }, { './data/base-win': './data/starbase', '/data/base-win': '/data/starbase' });
  assert.equal(OLD_HEALTH_SERVICE, 'starbase');
  assert.equal(OLD_EXPORT_FORMAT, 'starbase-export');
});

test('the tables cannot be changed by the code that reads them', () => {
  for (const t of [OLD_SETTINGS, JOINED, SECRET, OLD_STORAGE, OLD_DATA_DIRS]) assert.ok(Object.isFrozen(t));
  assert.throws(() => { 'use strict'; OLD_SETTINGS.BASE_TZ = 'X'; }, TypeError);
  assert.equal(OLD_SETTINGS.BASE_TZ, 'STARBASE_TZ');
  const out = adoptOldNames({ STARBASE_TZ: 'America/Edmonton' });
  assert.ok(Array.isArray(out.stillOld) && Array.isArray(out.differ));
});

test('the table imports nothing, so it can never grow into a second code path', () => {
  const src = readFileSync(FILE, 'utf8');
  assert.doesNotMatch(src, /^\s*import\b/m);
  assert.doesNotMatch(src, /\bimport\s*\(/);
  assert.doesNotMatch(src, /\brequire\s*\(/);
});

test('setting() works on a phone, where there is no process', () => {
  const script = `
    Object.defineProperty(globalThis, 'process', { value: undefined, configurable: true, writable: true });
    const m = await import(${JSON.stringify(pathToFileURL(FILE).href)});
    const out = {
      noProcess: typeof globalThis.process,
      plain: m.setting('BASE_TZ') ?? null,
      given: m.setting('BASE_TZ', { STARBASE_TZ: 'America/Edmonton' }),
      joined: m.setting('BASE_TWO_STEP_KEY') ?? null,
      adopted: m.adoptOldNames(),
      names: m.settingNames('BASE_TZ'),
    };
    console.log(JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { STARBASE_TZ: 'America/Regina' } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim()), {
    noProcess: 'undefined', plain: null, given: 'America/Edmonton', joined: null,
    adopted: { stillOld: [], differ: [] }, names: ['BASE_TZ', 'STARBASE_TZ'],
  });
});

test('a page that imports only the phone names does not ship the settings table', async () => {
  const { rollup } = await import('rollup');
  const entry = 'virtual:entry';
  const bundle = await rollup({
    input: entry,
    plugins: [{
      name: 'entry',
      resolveId: (id) => (id === entry ? id : id === 'old-names' ? FILE : null),
      load: (id) => (id === entry ? "import { OLD_STORAGE } from 'old-names'; console.log(OLD_STORAGE.prefix);" : null),
    }],
    onwarn: () => {},
  });
  const { output } = await bundle.generate({ format: 'es' });
  await bundle.close();
  const code = output.map((o) => o.code || '').join('\n');
  assert.match(code, /starbase:/);
  assert.doesNotMatch(code, /STARBASE_/);
  assert.doesNotMatch(code, /BASE_TZ/);
});
