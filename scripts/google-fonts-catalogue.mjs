// The Google font list and the ready-made pairings' files (WA decisions 2–4).
//
//   node scripts/google-fonts-catalogue.mjs [--repo <google/fonts checkout>] [--files]
//
// 1. The list: shared/site/google-fonts.json, one row per family, from the
//    public github.com/google/fonts repository (each family's METADATA.pb; a
//    shallow sparse clone, no key). Pass --repo to use a checkout you have.
//      f family · c category · w static weights | a [min, max] of the wght
//      axis · i has an italic (the axis's, or a static 400) · s subsets
//      (latin, latin-ext) · l licence · d its folder in the repository ·
//      b body-safe · r recommended
//    Left out: families without a latin subset, icon and emoji families, and
//    families whose only weights are under 400. A family on
//    scripts/google-fonts-body-safe.txt gets b: 1 only when it has a 400 and
//    a weight of 600 or more; a listed family missing from the list fails.
// 2. --files: the pairings' faces (shared/site/fonts.js BUILT_FILES), copied
//    into shared/site/fonts/ with each licence in fonts/LICENCES/. They come
//    from the Fontsource packages on the npm registry, which carry Google
//    Fonts' own latin and latin-ext woff2 files as Google serves them (base.win
//    never asks Google itself here). Then each pairing's first-visit `kb` is
//    worked out from the files and written into shared/site/fonts.js; a pair
//    over 100 KB fails the script (swap it, or use its static files).
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const SKIP = /^(Material Icons|Material Symbols|Noto Color Emoji|Noto Emoji)/;
const KINDS = { SANS_SERIF: 'sans-serif', SERIF: 'serif', DISPLAY: 'display', HANDWRITING: 'handwriting', MONOSPACE: 'monospace' };

// A METADATA.pb (protocol buffer text format), just the parts we read.
export function parseMetadata(text) {
  const one = (re) => re.exec(text)?.[1];
  const fonts = [...text.matchAll(/fonts \{([\s\S]*?)\n\}/g)].map((m) => ({
    style: /style: "(\w+)"/.exec(m[1])?.[1], weight: Number(/weight: (\d+)/.exec(m[1])?.[1]),
  }));
  const axes = [...text.matchAll(/axes \{([\s\S]*?)\n\}/g)].map((m) => ({
    tag: /tag: "(\w+)"/.exec(m[1])?.[1], min: Number(/min_value: ([\d.]+)/.exec(m[1])?.[1]), max: Number(/max_value: ([\d.]+)/.exec(m[1])?.[1]),
  }));
  return {
    name: one(/^name: "([^"]+)"/m), license: one(/^license: "([^"]+)"/m), category: one(/^category: "([^"]+)"/m),
    subsets: [...text.matchAll(/^subsets: "([^"]+)"/gm)].map((m) => m[1]).filter((s) => s !== 'menu'),
    fonts, wght: axes.find((a) => a.tag === 'wght') || null,
  };
}

function checkout() {
  const given = arg('--repo');
  if (given) return given;
  const dir = mkdtempSync(join(tmpdir(), 'google-fonts-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'inherit' });
  git('clone', '--depth', '1', '--filter=blob:none', '--sparse', 'https://github.com/google/fonts.git', 'repo');
  execFileSync('git', ['sparse-checkout', 'set', '--no-cone', '/ofl/*/METADATA.pb', '/apache/*/METADATA.pb', '/ufl/*/METADATA.pb'], { cwd: join(dir, 'repo'), stdio: 'inherit' });
  return join(dir, 'repo');
}

const LICENCES = { OFL: 'OFL', APACHE2: 'Apache-2.0', UFL: 'UFL' };
const bodySafeList = () => readFileSync(join(ROOT, 'scripts/google-fonts-body-safe.txt'), 'utf8')
  .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

async function buildList() {
  const repo = checkout();
  const { FONTS } = await import('../shared/site/fonts.js');
  const pairFaces = new Set(FONTS.filter((f) => f.family).map((f) => f.family));
  const safe = bodySafeList();
  const byName = new Map();
  for (const dir of ['ofl', 'apache', 'ufl']) {
    if (!existsSync(join(repo, dir))) continue;
    for (const fam of readdirSync(join(repo, dir))) {
      const file = join(repo, dir, fam, 'METADATA.pb');
      if (!existsSync(file)) continue;
      const m = parseMetadata(readFileSync(file, 'utf8'));
      if (!m.name || SKIP.test(m.name) || !m.subsets.includes('latin') || !KINDS[m.category]) continue;
      const row = { f: m.name, c: KINDS[m.category] };
      if (m.wght) {
        if (m.wght.max < 400) continue;
        row.a = [Math.round(m.wght.min), Math.round(m.wght.max)];
      } else {
        const w = [...new Set(m.fonts.filter((x) => x.style === 'normal').map((x) => x.weight))].sort((a, b) => a - b);
        if (!w.some((x) => x >= 400)) continue;
        row.w = w;
      }
      // i: an italic base.win can ask for (the axis's, or a static 400).
      if (m.fonts.some((x) => x.style === 'italic' && (m.wght || x.weight === 400))) row.i = 1;
      row.s = m.subsets.filter((s) => s === 'latin' || s === 'latin-ext');
      row.l = LICENCES[m.license] || m.license;
      row.d = `${dir}/${fam}`;
      byName.set(m.name, row);
    }
  }
  for (const name of safe) {
    const row = byName.get(name);
    if (!row) throw new Error(`${name} is on the body-safe list but not in Google Fonts`);
    const has = (w) => (row.a ? row.a[0] <= w && row.a[1] >= w : row.w.includes(w));
    const heavy = row.a ? row.a[1] >= 600 : row.w.some((w) => w >= 600);
    if (has(400) && heavy) row.b = 1;
  }
  for (const [name, row] of byName) if (pairFaces.has(name) || row.b) row.r = 1;
  const families = [...byName.values()].sort((a, b) => a.f.localeCompare(b.f, 'en'));
  const built = new Date().toISOString().slice(0, 10);
  writeFileSync(join(ROOT, 'shared/site/google-fonts.json'), JSON.stringify({ built, families }) + '\n');
  console.log(`google-fonts.json: ${families.length} families, ${families.filter((f) => f.b).length} body-safe, built ${built}`);
}

// The pairings' files: the npm package and its file for each BUILT_FILES entry.
async function copyFiles() {
  const { BUILT_FILES } = await import('../shared/site/fonts.js');
  const work = mkdtempSync(join(tmpdir(), 'fontsource-'));
  const unpacked = new Map();
  const pkg = (name) => {
    if (unpacked.has(name)) return unpacked.get(name);
    const tgz = execFileSync('npm', ['pack', name, '--silent'], { cwd: work }).toString().trim().split('\n').pop();
    const dir = join(work, tgz.replace(/\.tgz$/, ''));
    mkdirSync(dir, { recursive: true });
    execFileSync('tar', ['xzf', join(work, tgz), '-C', dir]);
    unpacked.set(name, join(dir, 'package'));
    return join(dir, 'package');
  };
  mkdirSync(join(ROOT, 'shared/site/fonts/LICENCES'), { recursive: true });
  for (const f of BUILT_FILES) {
    const dir = pkg(f.from);
    copyFileSync(join(dir, 'files', f.source), join(ROOT, 'shared/site', f.file));
    const licence = join(ROOT, 'shared/site/fonts/LICENCES', `${f.family}.txt`);
    if (!existsSync(licence)) copyFileSync(join(dir, 'LICENSE'), licence);
  }
  console.log(`${BUILT_FILES.length} files copied`);
}

// Each pairing's first-visit KB from the files on disk, written into fonts.js.
async function writeKb() {
  const { PAIRINGS, pairFiles } = await import(`../shared/site/fonts.js?${Date.now()}`);
  const src = join(ROOT, 'shared/site/fonts.js');
  let js = readFileSync(src, 'utf8');
  for (const p of PAIRINGS) {
    const bytes = pairFiles(p).reduce((n, file) => n + statSync(join(ROOT, 'shared/site', file)).size, 0);
    const kb = Math.ceil(bytes / 1024);
    if (kb > 100) throw new Error(`${p.key} adds ${kb} KB on a first visit; a pairing may add at most 100`);
    js = js.replace(new RegExp(`(key: '${p.key}',[^\\n]*kb: )\\d+`), `$1${kb}`);
    console.log(`${p.key}: ${kb} KB`);
  }
  writeFileSync(src, js);
}

if (!process.argv.includes('--kb-only')) await buildList();
if (process.argv.includes('--files')) { await copyFiles(); await writeKb(); }
if (process.argv.includes('--kb-only')) await writeKb();
