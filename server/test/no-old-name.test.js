// The product's older name is gone from everything a person sees, and from
// everything in the repository, apart from a short, fixed list of places
// that exist only so what is already saved keeps working (RENAME.md 4.3):
// the two tables of older names, the service worker's own small block of
// them, the website's database migrations already applied (frozen history),
// tests that prove the older names still work, and render.yaml's older keys,
// listed with no value so a Blueprint sync can neither delete nor overwrite
// what a client has saved under them.
//
// 1. No tracked path, and no line of a tracked text file, holds the word in
//    any letter case outside that list. The list is a constant here and may
//    not grow past 13 entries, so a new exception is a deliberate edit.
// 2. The two tables hold names, frozen tables and small pure functions only,
//    and import nothing, so they can't grow into a second code path.
// 3. A guide names only settings base.win (or the website) really reads.
// 4. What a server says: started with the new names only, its health
//    answer, Settings → Services, a test email, the export, a CSV download
//    and the public site's privacy page carry no trace of the word. Started
//    again with one older name set, only the "older setting names" row and
//    the one start-up line that says what to rename it to mention it.
//
// The word itself is never written here: it comes from shared/old-names.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OLD_WORD, OLD_SETTINGS, settingNames } from '../../shared/old-names.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const WORD = new RegExp(OLD_WORD, 'i');

// ── The allowlist (RENAME.md 4.3, with render.yaml kept for this release) ──
// Each entry: a path (or a test for one) and what may be in it.
const SW_BEGIN = '// old-names: begin';
const SW_END = '// old-names: end';
const SW_MAX = 15;
const RENDER_KEY = new RegExp(`^\\s*- key: (${Object.values(OLD_SETTINGS).join('|')})\\s*$`);
const ALLOW = [
  { path: 'shared/old-names.js', why: 'base.win’s table of older names' },
  { path: 'apps/web/src/lib/old-names.ts', why: 'the website’s own table of older names' },
  { path: 'web/public/sw.js', why: 'the service worker can’t import the table: its own block, between the markers', block: true },
  { path: `apps/web/drizzle/0006_${OLD_WORD}_desk.sql`, why: 'a website migration already applied' },
  { path: 'apps/web/drizzle/0007_memo_build.sql', why: 'a website migration already applied' },
  { path: 'apps/web/drizzle/meta/_journal.json', why: 'the website’s record of applied migrations' },
  { path: 'apps/web/drizzle/meta/0006_snapshot.json', why: 'a website migration already applied' },
  { path: 'apps/web/drizzle/meta/0007_snapshot.json', why: 'a website migration already applied' },
  { test: (p) => /\.test\.(js|mjs|ts)$/.test(p) && basename(p).includes('old-names'), why: 'a test that proves an older name still works' },
  { path: 'render.yaml', why: 'older keys listed with no value (sync: false), so a sync never drops or overwrites one', renderKeys: true },
];
const allowFor = (p) => ALLOW.find((a) => (a.test ? a.test(p) : a.path === p));

// Every tracked file: git's list, or (no git, as in a copy of the tree) a
// walk that leaves out what is never tracked.
const SKIP_DIRS = new Set(['.git', 'node_modules', '.claude', 'dist', '.next', 'data', 'coverage']);
const tracked = () => {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    const list = out.split('\0').filter(Boolean);
    if (list.length) return list.filter((p) => existsSync(join(ROOT, p)));
  } catch { /* no git here: walk the tree */ }
  const found = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) { if (!SKIP_DIRS.has(name)) walk(full); } else found.push(relative(ROOT, full));
    }
  };
  walk(ROOT);
  return found;
};
const textOf = (p) => {
  const buf = readFileSync(join(ROOT, p));
  if (buf.subarray(0, 8000).includes(0)) return null; // binary
  return buf.toString('utf8');
};

test('the allowlist holds exactly the tables, the migration history and the justified files, and no more than 13 entries', () => {
  assert.ok(ALLOW.length <= 13, `the allowlist has ${ALLOW.length} entries`);
  for (const a of ALLOW) if (a.path) assert.ok(existsSync(join(ROOT, a.path)), `${a.path} is on the allowlist but not in the repository`);
});

test('no tracked path or line holds the older name outside the allowlist', () => {
  const files = tracked();
  assert.ok(files.length > 500, `only ${files.length} files found`);
  const bad = [];
  for (const p of files) {
    const allow = allowFor(p);
    if (WORD.test(p) && !allow) bad.push(`${p} (its path)`);
    if (allow && !allow.block && !allow.renderKeys) continue;
    const text = textOf(p);
    if (text == null) continue;
    const lines = text.split('\n');
    let inBlock = false;
    lines.forEach((line, i) => {
      if (allow?.block && line.trim() === SW_BEGIN) inBlock = true;
      const ok = (allow?.block && inBlock) || (allow?.renderKeys && RENDER_KEY.test(line));
      if (WORD.test(line) && !ok) bad.push(`${p}:${i + 1}: ${line.trim().slice(0, 120)}`);
      if (allow?.block && line.trim() === SW_END) inBlock = false;
    });
  }
  assert.deepEqual(bad, [], `the older name, outside the allowlist:\n${bad.join('\n')}`);
});

test('the service worker’s block of older names is bounded by its two markers and short', () => {
  const lines = readFileSync(join(ROOT, 'web/public/sw.js'), 'utf8').split('\n').map((l) => l.trim());
  const begin = lines.indexOf(SW_BEGIN);
  const end = lines.indexOf(SW_END);
  assert.ok(begin >= 0 && end > begin, 'both markers, in order');
  assert.equal(lines.lastIndexOf(SW_BEGIN), begin, 'one begin marker');
  assert.equal(lines.lastIndexOf(SW_END), end, 'one end marker');
  assert.ok(end - begin + 1 <= SW_MAX, `the block is ${end - begin + 1} lines`);
  assert.ok(lines.slice(begin, end + 1).some((l) => WORD.test(l)), 'the block is what holds them');
});

test('render.yaml lists each older key with sync: false and no value', () => {
  const lines = readFileSync(join(ROOT, 'render.yaml'), 'utf8').split('\n');
  let seen = 0;
  lines.forEach((line, i) => {
    if (!RENDER_KEY.test(line)) return;
    seen += 1;
    assert.match(lines[i + 1] || '', /^\s*sync: false\s*$/, `render.yaml:${i + 2} follows an older key`);
    assert.doesNotMatch(lines[i + 2] || '', /^\s*value:/, `render.yaml:${i + 3}: an older key never carries a value`);
  });
  assert.ok(seen > 0, 'the older keys are still listed (RENAME.md, decision R1)');
});

// ── 2. The tables are data ──
// Strings, template literals and comments blanked out, so what is left is code.
const codeOf = (src) => src.replace(
  /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g,
  (m) => (m.startsWith('/') ? ' ' : '""'),
);
// The top-level statements of a file whose statements end in semicolons.
const statements = (code) => {
  const out = [];
  let depth = 0; let start = 0;
  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i];
    if ('{(['.includes(ch)) depth += 1;
    else if ('})]'.includes(ch)) depth -= 1;
    else if (ch === ';' && depth === 0) { out.push(code.slice(start, i).trim()); start = i + 1; }
  }
  out.push(code.slice(start).trim());
  return out.filter(Boolean);
};
// What a table may hold: a name bound to a string, a frozen object or list,
// a TypeScript `as const` literal, an arrow function, or another of its names.
const DECL = /^(export\s+)?const\s+[A-Za-z_$][\w$]*\s*=\s*([\s\S]*)$/;
const VALUE_OK = [
  /^""$/,
  /^Object\.freeze\([\s\S]*\)$/,
  /^[{[][\s\S]*[}\]]\s+as\s+const$/,
  /^\([^)]*\)\s*=>[\s\S]*$/,
  /^[A-Za-z_$][\w$]*\s*=>[\s\S]*$/,
  /^[A-Za-z_$][\w$]*$/,
];
// Nothing that reaches outside: no loading, no network, no storage, no
// timers, no clock, no code from text.
const FORBIDDEN = /\b(?:import|require|fetch|XMLHttpRequest|WebSocket|Worker|localStorage|sessionStorage|indexedDB|caches|document|window|navigator|console|setTimeout|setInterval|Date|Math\.random|eval|Function|async|await|class|this|while)\b|\bexport\s*[{*]/;

for (const file of ['shared/old-names.js', 'apps/web/src/lib/old-names.ts']) {
  test(`${file} holds only names, frozen tables and small pure functions, and imports nothing`, () => {
    const code = codeOf(readFileSync(join(ROOT, file), 'utf8'));
    const found = code.match(FORBIDDEN);
    assert.equal(found, null, `${file}: “${found?.[0]}” is not data`);
    for (const st of statements(code)) {
      const m = st.match(DECL);
      assert.ok(m, `${file}: a statement that is not a named value: ${st.slice(0, 80)}`);
      const value = m[2].trim();
      assert.ok(VALUE_OK.some((re) => re.test(value)), `${file}: not a name, a frozen table or a function: ${st.slice(0, 80)}`);
    }
    // The only global a table may look at is the process's settings, read.
    const globals = [...code.matchAll(/globalThis\.[\w?.]+/g)].map((g) => g[0]);
    assert.ok(globals.every((g) => g === 'globalThis.process?.env'), `${file}: ${globals.join(', ')}`);
  });
}

// ── 3. The guides name real settings ──
// The settings that were never renamed (they never had the older name).
const NEVER_RENAMED = ['BASE_PATH', 'BASE_DOOR_KEY', 'BASE_CLIENTS', 'BASE_APEX', 'BASE_TRUSTED_PROXIES', 'BASE_PLATFORM_PUBKEY'];
const websiteSettings = () => {
  const ts = readFileSync(join(ROOT, 'apps/web/src/lib/old-names.ts'), 'utf8');
  const body = ts.match(/export const OLD_ENV = \{([^}]*)\}/)?.[1] || '';
  return [...body.matchAll(/(\w+)\s*:/g)].map((m) => m[1]);
};

test('a guide names only a BASE_ setting base.win or the website really reads', () => {
  const site = websiteSettings();
  assert.deepEqual(site.sort(), ['BASE_WIN_INBOUND_KEY', 'BASE_WIN_KEY', 'BASE_WIN_URL'], 'the website’s three settings');
  const known = new Set([...Object.keys(OLD_SETTINGS), ...site, ...NEVER_RENAMED]);
  const bad = [];
  for (const p of tracked().filter((f) => f.endsWith('.md'))) {
    const lines = (textOf(p) || '').split('\n');
    lines.forEach((line, i) => {
      for (const [name] of line.matchAll(/\bBASE_[A-Z0-9_]*[A-Z0-9]\b/g)) if (!known.has(name)) bad.push(`${p}:${i + 1}: ${name}`);
    });
  }
  assert.deepEqual(bad, [], `a setting no code reads:\n${bad.join('\n')}`);
});

// ── 4. What a server says ──
// server/test/no-old-name-visit.js starts the server in its own process, so
// it starts as a service does, with the built-in database in memory and only
// the settings given here, and prints what it was answered.
const PUBLIC = 'https://riverbend.example.org';
const NEW_ONLY = {
  BASE_BRAND: 'imagine-surrey', // a fresh Imagine Surrey preset: its site, its privacy page
  BASE_ORG_NAME: 'Riverbend Forward',
  BASE_PUBLIC_URL: PUBLIC,
  BASE_DATA: 'memory',
  BASE_JOBS: 'off',
  BASE_OPEN_SIGNUP: '1',
  BASE_SECURE_COOKIES: '0',
  RENDER_EXTERNAL_URL: 'https://riverbend-a1b2.onrender.com',
  MAIL_FROM: 'Riverbend Forward <hello@riverbend.example.org>',
  GEOCODE_ON_SAVE: 'off',
};
const CLEARED = ['NODE_TEST_CONTEXT', 'DATABASE_URL', 'RENDER', 'BASE_PATH', 'NODE_ENV', 'RESEND_API_KEY', 'SENDGRID_API_KEY', 'MAIL_PROVIDER',
  ...Object.keys(OLD_SETTINGS).flatMap(settingNames)];

const visit = (settings) => new Promise((ok, no) => {
  const env = { ...process.env };
  for (const k of CLEARED) delete env[k];
  Object.assign(env, settings);
  const child = spawn(process.execPath, ['server/test/no-old-name-visit.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
  child.on('exit', (code) => {
    clearTimeout(timer);
    const line = out.split('\n').find((l) => l.startsWith('VISIT '));
    if (code !== 0 || !line) return no(new Error(`the visit stopped (${code}):\n${err.slice(-3000)}\n${out.slice(-3000)}`));
    ok(JSON.parse(line.slice('VISIT '.length)));
  });
});

const runs = {};
const newOnly = () => { runs.new ??= visit(NEW_ONLY); return runs.new; };
const oneOld = () => {
  const { BASE_ORG_NAME, ...rest } = NEW_ONLY;
  runs.old ??= visit({ ...rest, [OLD_SETTINGS.BASE_ORG_NAME]: BASE_ORG_NAME });
  return runs.old;
};
const mentions = (pages) => Object.entries(pages).filter(([, text]) => WORD.test(text)).map(([name, text]) => `${name}: …${text.slice(Math.max(0, text.search(WORD) - 80), text.search(WORD) + 80)}…`);

test('started with the new names only: nothing it says carries the older name', async () => {
  const r = await newOnly();
  assert.deepEqual(Object.keys(r.pages).sort(), ['csv', 'email', 'export', 'health', 'privacy', 'services', 'startup'].sort());
  // Each page is really the thing named, not an error.
  assert.equal(r.health.service, 'base.win');
  assert.equal(r.health.address, PUBLIC, 'the public address, never the machine’s .onrender.com one');
  assert.equal(r.status.privacy, 200);
  assert.match(r.pages.privacy, /Privacy policy/);
  assert.equal(r.status.csv, 200);
  assert.match(r.pages.csv, /filename="base-win-people/);
  assert.equal(r.status.export, 200);
  assert.match(r.pages.export, /"format":"base-win-export"/);
  assert.match(r.pages.export, /filename="base-win-export\.json"/);
  assert.equal(r.emails, 1, 'one test email');
  assert.match(r.pages.email, /\[Test\] Riverbend news/);
  assert.ok(r.services.length > 3, 'Settings → Services lists the services');
  assert.ok(!r.services.some((s) => s.key === 'older-names'), 'no older names on this server: no row for them');
  assert.deepEqual(mentions(r.pages), []);
});

test('started again with one older name set: only the “older setting names” row and its start-up line mention it', async () => {
  const r = await oneOld();
  const old = OLD_SETTINGS.BASE_ORG_NAME;
  const row = r.services.find((s) => s.key === 'older-names');
  assert.ok(row, 'Settings → Services lists the older name');
  assert.deepEqual(row.older, [{ old, now: 'BASE_ORG_NAME' }]);
  assert.match(row.detail, /BASE_ORG_NAME/, 'with the new name to use');
  assert.equal(r.health.organization, NEW_ONLY.BASE_ORG_NAME, 'and the setting still works');
  const { startup, services, ...rest } = r.pages;
  assert.deepEqual(mentions(rest), [], 'no other page');
  const others = JSON.stringify(r.services.filter((s) => s.key !== 'older-names'));
  assert.doesNotMatch(others, WORD, 'no other service row');
  const said = startup.split('\n').filter((l) => WORD.test(l));
  assert.deepEqual(said, [`base.win: the setting ${old} still works; rename it to BASE_ORG_NAME in Render.`], 'one start-up line, naming the new name');
  assert.ok(!startup.includes(NEW_ONLY.BASE_ORG_NAME), 'the log carries no value');
});
