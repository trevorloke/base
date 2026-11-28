// Google fonts for the website (WA stage 1, SITE.md "Fonts"). A campaign
// picks any family from the snapshot of Google's list (shared/site/
// google-fonts.json); base.win fetches its files from Google once, at that
// moment, and keeps them (site_fonts, site_font_files). The site and the
// desk then load them from base.win's own address: no visitor's browser
// ever asks Google, and the CSP stays font-src 'self'.
//
//   site.font.add     { family } → { font }   fetched first (`before`, outside
//                     any transaction), then one write; six at most
//   site.font.remove  { slug }   refused (409) while a theme, another
//                     website or the brand uses it; Undo: site.font.restore
//   GET  /api/site/fonts                 { fonts: [{ …, used, missing, refetch }], max, built }
//   GET  /api/site/fonts/catalogue       ?q=&kind=&for=heading|body&sort=recommended|az&page=
//   GET  /api/site/fonts/sample          ?family=&text=&w=  a few letters, drawn in it
//   GET  /api/site/fonts/file/<sha>.woff2  an added font's file, for the desk
//   GET  {site root}site-assets/fonts/g/<sha>.woff2   the same, for visitors
//   GET  {site root}site-assets/fonts/licences        the fonts' licences
//
// GOOGLE_FONTS_CSS_BASE and GOOGLE_FONTS_FILE_HOSTS point the fetches at a
// stand-in (server/test/fake-google-fonts.js); production ignores both.
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { outsideFetch } from '../../lib/outside.js';
import { envName } from '../../lib/org.js';
import { newId, runAction } from '../../lib/events.js';
import { enqueueJob } from '../../lib/jobs.js';
import { httpError } from '../../actions/util.js';
import { FONTS, fontFor, slugFor } from '@base-win/shared/site/fonts';
import { ensureSiteTx, parseJ } from './store.js';
import { cacheClear } from './cache.js';

const CATALOGUE = JSON.parse(readFileSync(fileURLToPath(new URL('../../../shared/site/google-fonts.json', import.meta.url)), 'utf8'));
// Three made-up families the stand-in serves, listed only while it is in use
// (GOOGLE_FONTS_CSS_BASE set, never in production).
export const TEST_FAMILIES = [
  { f: 'Fake Sans', c: 'sans-serif', a: [100, 900], s: ['latin', 'latin-ext'], l: 'OFL', b: 1 },
  { f: 'Fake Display', c: 'display', w: [400], s: ['latin', 'latin-ext'], l: 'OFL' },
  { f: 'Fake Serif', c: 'serif', w: [400, 700], s: ['latin'], l: 'OFL' },
];
const testing = () => envName() !== 'production' && Boolean(String(process.env.GOOGLE_FONTS_CSS_BASE || '').trim());
const families = () => (testing() ? [...TEST_FAMILIES, ...CATALOGUE.families] : CATALOGUE.families);
const BY_FAMILY = new Map(CATALOGUE.families.map((r) => [r.f, r]));
export const catalogueRow = (family) => {
  const f = String(family || '').trim();
  return BY_FAMILY.get(f) || (testing() ? TEST_FAMILIES.find((r) => r.f === f) : null) || null;
};
export const MAX_FONTS = 6;

export const WORDS = {
  unknown: 'We couldn’t find that font in Google Fonts',
  full: 'Six added fonts is the most. Remove one you don’t use first (Choose fonts → Fonts on your site).',
  down: 'Google Fonts didn’t answer. Try again in a minute. Your site keeps its current fonts.',
  odd: 'Google Fonts sent something unexpected. Try again later.',
  fileBig: 'That font’s files are too large for a website (over 300 KB a file). Pick another font.',
  allBig: 'That font’s files are too large for a website (over 900 KB in all). Pick another font.',
  slow: 'Slow down a moment.',
};

// ── Fetching from Google ──
const production = () => envName() === 'production';
const cssBase = () => (!production() && String(process.env.GOOGLE_FONTS_CSS_BASE || '').trim().replace(/\/+$/, '')) || 'https://fonts.googleapis.com';
// Where a font file may come from: Google's file host, and in tests the stand-in.
const fileAllowed = (url) => {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol === 'https:' && u.host === 'fonts.gstatic.com') return true;
  if (production()) return false;
  const hosts = String(process.env.GOOGLE_FONTS_FILE_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean);
  return hosts.includes(u.host) && /^https?:$/.test(u.protocol);
};
// Google answers TTF to an agent it doesn't know; a current desktop Chrome gets woff2.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const fail = (status, words) => httpError(status, words);

// The axes asked for: the wght range of a variable family (and its
// italics); a static family's 400, 700, heaviest and 400 italic, as it has them.
export function axesFor(row) {
  if (row.a) {
    const r = `${row.a[0]}..${row.a[1]}`;
    return row.i ? `ital,wght@0,${r};1,${r}` : `wght@${r}`;
  }
  const w = row.w || [];
  const heaviest = Math.max(...w);
  let want = [...new Set([400, 700, heaviest].filter((x) => w.includes(x)))].sort((a, b) => a - b);
  if (!want.length) want = [w.find((x) => x >= 400)];
  return row.i && w.includes(400) ? `ital,wght@${want.map((x) => `0,${x}`).join(';')};1,400` : `wght@${want.join(';')}`;
}
const familyParam = (family) => encodeURIComponent(family).replace(/%20/g, '+');

// Google's stylesheet → its faces ({ subset, weight, style, unicode_range, url }).
export function parseFaces(css) {
  const out = [];
  for (const m of String(css).matchAll(/(?:\/\*\s*([a-z0-9-]+)\s*\*\/\s*)?@font-face\s*\{([^}]*)\}/g)) {
    const body = m[2];
    const get = (k) => new RegExp(`${k}\\s*:\\s*([^;]+);?`).exec(body)?.[1]?.trim() || '';
    out.push({
      subset: m[1] || '',
      weight: get('font-weight'),
      style: get('font-style') || 'normal',
      unicode_range: get('unicode-range'),
      url: /url\(\s*['"]?([^'")\s]+)['"]?\s*\)/.exec(body)?.[1] || '',
    });
  }
  return out;
}

const isWoff2 = (buf) => buf.length >= 4 && buf.subarray(0, 4).toString('latin1') === 'wOF2';
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

// Steps 2–4 of WA decision 5: the stylesheet, its latin and latin-ext
// faces, their files (two at a time). Never inside a write (outsideFetch).
export async function fetchFamily(row) {
  const url = `${cssBase()}/css2?family=${familyParam(row.f)}:${axesFor(row)}&display=swap`;
  let css;
  try {
    const res = await outsideFetch(url, { timeout: 8000, maxBytes: 200_000, headers: { 'User-Agent': UA, Accept: 'text/css,*/*;q=0.1' } });
    if (res.status >= 500) throw fail(502, WORDS.down);
    if (!res.ok) throw fail(502, WORDS.odd);
    css = res.body.toString('utf8');
  } catch (e) {
    if (e.status) throw e;
    throw fail(502, e.code === 'too-big' ? WORDS.odd : WORDS.down);
  }
  const all = parseFaces(css);
  // Every address must be Google's file host: anything else, nothing is fetched.
  if (!all.length || all.some((f) => !fileAllowed(f.url))) throw fail(502, WORDS.odd);
  const faces = all.filter((f) => f.subset === 'latin' || f.subset === 'latin-ext');
  if (!faces.length || faces.length > 8) throw fail(502, WORDS.odd);
  const version = /\/v(\d+)\//.exec(faces[0].url)?.[1] ? `v${/\/v(\d+)\//.exec(faces[0].url)[1]}` : '';
  const files = new Map(); // sha → Buffer
  let total = 0;
  const one = async (f) => {
    let res;
    try {
      res = await outsideFetch(f.url, { timeout: 8000, maxBytes: 300 * 1024 });
    } catch (e) {
      throw fail(502, e.code === 'too-big' ? WORDS.fileBig : WORDS.down);
    }
    if (res.status >= 500) throw fail(502, WORDS.down);
    if (!res.ok || !isWoff2(res.body)) throw fail(502, WORDS.odd);
    total += res.body.length;
    if (total > 900 * 1024) throw fail(502, WORDS.allBig);
    f.sha256 = sha(res.body);
    f.bytes = res.body.length;
    files.set(f.sha256, res.body);
  };
  for (let i = 0; i < faces.length; i += 2) await Promise.all(faces.slice(i, i + 2).map(one));
  return {
    version,
    faces: faces.map(({ subset, weight, style, unicode_range: u, sha256, bytes }) => ({ subset, weight, style, unicode_range: u, sha256, bytes })),
    files,
  };
}

// ── The campaign's added fonts ──
const fontOut = (r) => ({
  slug: r.slug, family: r.family, category: r.category, bodySafe: Boolean(r.body_safe),
  licence: r.licence, version: r.version || '', faces: parseJ(r.faces, []),
});
// The added fonts (not removed), as fonts.js takes them.
export const readAddedFonts = async (q, workspaceId) => (await q.query(
  'select slug, family, category, body_safe, licence, version, faces from site_fonts where workspace_id = $1 and deleted_at is null order by created_at',
  [workspaceId],
)).rows.map(fontOut);

// What checkTheme needs to check a theme's fonts: the added fonts, and
// whether the site is in Punjabi (its first visit is counted too). `on`: the
// languages a save is turning on, when it names them.
export const fontsForCheck = async (q, ws, on) => {
  const langs = Array.isArray(on) ? on
    : parseJ((await q.query('select languages from site_settings where workspace_id = $1', [ws])).rows[0]?.languages, {})?.on;
  return { added: await readAddedFonts(q, ws), punjabi: Array.isArray(langs) && langs.includes('pa') };
};
// A theme's first problem, in words.
export const themeProblem = (p) => (p.font ? p.words
  : `${p.pair.label}: ${p.ratio.toFixed(1)}:1 is too hard to read — it needs 4.5:1. Pick a darker or lighter colour.`);

const countAdded = async (q, ws) => Number((await q.query('select count(*)::int as n from site_fonts where workspace_id = $1 and deleted_at is null', [ws])).rows[0].n);

// Each file in 24 KB pieces: one statement per piece keeps every message
// small (PGlite's wire server, which test:pg runs on, fails on a message of
// about 100 KB; a hosted Postgres takes either).
const PIECE = 24 * 1024;
const writeFiles = async (tx, ws, files) => {
  for (const [hash, buf] of files) {
    const made = (await tx.query(
      `insert into site_font_files (workspace_id, sha256, bytes, data) values ($1, $2, $3, $4)
       on conflict (workspace_id, sha256) do nothing returning sha256`,
      [ws, hash, buf.length, buf.subarray(0, PIECE)],
    )).rows[0];
    if (!made) continue;
    for (let at = PIECE; at < buf.length; at += PIECE) {
      await tx.query('update site_font_files set data = data || $3 where workspace_id = $1 and sha256 = $2', [ws, hash, buf.subarray(at, at + PIECE)]);
    }
  }
};

// Where an added font is in use (its value 'g:<slug>'): the words that say so.
async function usesOf(q, ws, family, value) {
  const out = [];
  const say = (t, what, where) => {
    if (t?.fonts?.heading === value) out.push(`${family} is used for headings ${where}`);
    else if (t?.fonts?.body === value) out.push(`${family} is used for body text ${where}`);
  };
  const s = (await q.query('select theme from site_settings where workspace_id = $1', [ws])).rows[0];
  say(parseJ(s?.theme, {}), 'theme', 'on the main site');
  for (const m of (await q.query('select name, theme from microsites where workspace_id = $1 and deleted_at is null order by created_at', [ws])).rows) {
    say(parseJ(m.theme, {}), 'theme', `on ${m.name} (another website)`);
  }
  const w = (await q.query('select settings from workspaces where id = $1', [ws])).rows[0];
  if (parseJ(w?.settings, {})?.brand?.heading === value) out.push(`${family} is used by the campaign’s brand`);
  return out;
}

// A Website action whose slow part (Google) runs first, outside the
// campaign's write, and is handed to the write (api.js `before`).
const fontAction = (input, handler, before) => ({
  roles: ['manager'],
  area: 'site',
  input,
  before,
  handler: async (tx, ctx, data, emit, ready) => {
    await ensureSiteTx(tx, ctx.workspace || { id: ctx.workspaceId }, emit);
    return handler(tx, ctx, data, emit, ready);
  },
  after: async (db, ctx, result) => {
    cacheClear(ctx.workspaceId);
    return { result };
  },
});

const liveRow = async (q, ws, slug) => (await q.query('select * from site_fonts where workspace_id = $1 and slug = $2 and deleted_at is null', [ws, slug])).rows[0];

export const fontActions = {
  'site.font.add': fontAction(z.object({ family: z.string().trim().min(1).max(100) }), async (tx, ctx, input, emit, ready) => {
    const ws = ctx.workspaceId;
    const row = ready.row;
    const slug = slugFor(row.f);
    // Already there (another tab got it first): that one.
    const have = await liveRow(tx, ws, slug);
    if (have) return { font: fontOut(have), added: false };
    // Removed by someone else since it was looked at: fetched again next time.
    if (!ready.faces.length) throw fail(409, 'That font changed a moment ago. Try again.');
    // Counted again under the campaign's lock: two tabs never make seven.
    if (await countAdded(tx, ws) >= MAX_FONTS) throw fail(400, WORDS.full);
    await writeFiles(tx, ws, ready.files);
    const id = newId();
    const saved = (await tx.query(
      `insert into site_fonts (id, workspace_id, slug, family, category, body_safe, licence, version, faces, added_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *`,
      [id, ws, slug, row.f, row.c, Boolean(row.b), row.l, ready.version, JSON.stringify(ready.faces), ctx.user?.id || null],
    )).rows[0];
    emit('site_font', id, 'create', { slug, family: row.f, category: row.c, licence: row.l, version: ready.version, faces: ready.faces });
    return { font: fontOut(saved), added: true };
  }, async (db, ctx, input) => {
    const row = catalogueRow(input.family);
    if (!row) throw fail(404, WORDS.unknown);
    const have = await liveRow(db, ctx.workspaceId, slugFor(row.f));
    if (have) return { row, files: new Map(), faces: [], version: '' };
    if (await countAdded(db, ctx.workspaceId) >= MAX_FONTS) throw fail(400, WORDS.full);
    return { row, ...await fetchFamily(row) };
  }),

  'site.font.remove': fontAction(z.object({ slug: z.string().regex(/^[a-z0-9-]{1,80}$/) }), async (tx, ctx, input, emit) => {
    const ws = ctx.workspaceId;
    const r = await liveRow(tx, ws, input.slug);
    if (!r) throw fail(404, 'That font isn’t on your site');
    const uses = await usesOf(tx, ws, r.family, `g:${r.slug}`);
    if (uses.length) throw fail(409, `${uses[0]}. Pick another font there first.`);
    await tx.query('update site_fonts set deleted_at = now(), updated_at = now() where id = $1', [r.id]);
    emit('site_font', r.id, 'void', { slug: r.slug, family: r.family });
    return { removed: r.slug };
  }),

  // Undo of a removal: the font as it was (its files never left).
  'site.font.restore': fontAction(z.object({ slug: z.string().regex(/^[a-z0-9-]{1,80}$/) }), async (tx, ctx, input, emit) => {
    const ws = ctx.workspaceId;
    if (await liveRow(tx, ws, input.slug)) throw fail(409, 'That font is on your site already');
    if (await countAdded(tx, ws) >= MAX_FONTS) throw fail(400, WORDS.full);
    const r = (await tx.query(
      'select * from site_fonts where workspace_id = $1 and slug = $2 and deleted_at is not null order by deleted_at desc limit 1', [ws, input.slug],
    )).rows[0];
    if (!r) throw fail(404, 'That font isn’t on your site');
    const back = (await tx.query('update site_fonts set deleted_at = null, updated_at = now() where id = $1 returning *', [r.id])).rows[0];
    emit('site_font', r.id, 'restore', { slug: r.slug, family: r.family });
    return { font: fontOut(back) };
  }),
};

// ── Fetched again: a font whose files aren't here (an export brought back) ──
const missingOf = async (q, ws, fonts) => {
  const want = fonts.flatMap((f) => f.faces.map((x) => x.sha256)).filter(Boolean);
  if (!want.length) return new Set();
  const have = new Set((await q.query('select sha256 from site_font_files where workspace_id = $1 and sha256 = any($2::text[])', [ws, want])).rows.map((r) => r.sha256));
  return new Set(fonts.filter((f) => f.faces.some((x) => !have.has(x.sha256))).map((f) => f.slug));
};

export const refetchJob = async (db, job) => {
  const ws = job.workspace_id;
  const r = await liveRow(db, ws, job.payload?.slug);
  if (!r) return;
  if (!(await missingOf(db, ws, [fontOut(r)])).size) return;
  const row = catalogueRow(r.family);
  if (!row) throw new Error(`${r.family} is no longer in the font list`);
  const got = await fetchFamily(row);
  await runAction(db, { workspaceId: ws, actorId: null, action: 'site.font.refetch' }, async (tx, emit) => {
    await writeFiles(tx, ws, got.files);
    await tx.query('update site_fonts set faces = $2, version = $3, updated_at = now() where id = $1', [r.id, JSON.stringify(got.faces), got.version || r.version]);
    emit('site_font', r.id, 'update', { slug: r.slug, family: r.family, version: got.version, faces: got.faces, by: 'import' });
  });
  cacheClear(ws);
};

// Each font whose files are missing gets one job (its key: the row as it is
// now, so a later Try again is a new one).
const queueRefetch = async (db, ws, slugs, again = false) => {
  for (const slug of slugs) {
    const r = await liveRow(db, ws, slug);
    if (!r) continue;
    const stamp = again ? Date.now() : new Date(r.updated_at).getTime();
    await enqueueJob(db, { workspaceId: ws, kind: 'site.font.refetch', payload: { slug }, key: `font-refetch:${slug}:${stamp}` });
  }
};

// ── Reads (mounted by api.js under /api/site, the Website area) ──
const kbOf = (row, stored) => {
  if (stored) return { kb: Math.ceil(stored / 1024), about: false };
  return { kb: row.a ? 45 : 22, about: true };
};
const latinRegular = (faces) => {
  const f = faces.find((x) => x.subset === 'latin' && x.style !== 'italic'
    && Number(String(x.weight).split(' ')[0]) <= 400 && Number(String(x.weight).split(' ').pop()) >= 400);
  return f?.bytes || 0;
};

const SAMPLES = new Map(); // "family|w|text" → { body, at }
const SAMPLE_BYTES = { n: 0 };
const SAMPLE_TTL = 24 * 3600_000;
const measured = new Map(); // family → bytes of a sample (a hint for "about")
const RATE = new Map(); // user → [times]
let outsideNow = 0;
const waiting = [];
const slot = async () => {
  if (outsideNow >= 4) await new Promise((r) => waiting.push(r));
  outsideNow += 1;
};
const release = () => { outsideNow -= 1; waiting.shift()?.(); };

const FILE_LRU = new Map(); // "ws|sha" → Buffer (40 at most)
async function fontFile(db, ws, hash) {
  const k = `${ws}|${hash}`;
  if (FILE_LRU.has(k)) { const b = FILE_LRU.get(k); FILE_LRU.delete(k); FILE_LRU.set(k, b); return b; }
  const r = (await db.query('select data from site_font_files where workspace_id = $1 and sha256 = $2', [ws, hash])).rows[0];
  if (!r) return null;
  const buf = Buffer.from(r.data);
  FILE_LRU.set(k, buf);
  if (FILE_LRU.size > 40) FILE_LRU.delete(FILE_LRU.keys().next().value);
  return buf;
}
const FILE_NAME = /^([a-f0-9]{64})\.woff2$/;

export function mountFontReads(api, opened) {
  api.get('/site/fonts', async (c) => {
    const ws = await opened(c);
    const db = c.get('db');
    const fonts = await readAddedFonts(db, ws);
    const missing = await missingOf(db, ws, fonts);
    if (missing.size) await queueRefetch(db, ws, [...missing]);
    const jobs = missing.size ? (await db.query(
      `select payload->>'slug' as slug, status from jobs where workspace_id = $1 and kind = 'site.font.refetch' order by created_at desc`, [ws],
    )).rows : [];
    const out = [];
    for (const f of fonts) {
      const used = await usesOf(db, ws, f.family, `g:${f.slug}`);
      const job = jobs.find((j) => j.slug === f.slug);
      out.push({
        ...f, used, notUsed: used.length === 0, missing: missing.has(f.slug),
        refetch: missing.has(f.slug) ? (job?.status === 'failed' ? 'failed' : 'waiting') : null,
        kb: Math.ceil(latinRegular(f.faces) / 1024),
      });
    }
    return c.json({ fonts: out, max: MAX_FONTS, built: CATALOGUE.built });
  });

  // "Try again" after a font couldn't be fetched again.
  api.post('/site/fonts/refetch', async (c) => {
    const ws = await opened(c);
    const slug = String((await c.req.json().catch(() => ({})))?.slug || '');
    if (!/^[a-z0-9-]{1,80}$/.test(slug)) return c.json({ error: 'Which font?' }, 400);
    await queueRefetch(c.get('db'), ws, [slug], true);
    return c.json({ queued: true });
  });

  api.get('/site/fonts/catalogue', async (c) => {
    const ws = await opened(c);
    const q = String(c.req.query('q') || '').trim().toLowerCase().slice(0, 60);
    const kind = String(c.req.query('kind') || '');
    const forBody = c.req.query('for') === 'body';
    const az = c.req.query('sort') === 'az';
    const page = Math.max(0, Math.min(100, Number(c.req.query('page')) || 0));
    const added = await readAddedFonts(c.get('db'), ws);
    const addedBy = new Map(added.map((f) => [f.family, f]));
    let rows = families().filter((r) => (!forBody || r.b) && (!kind || r.c === kind) && (!q || r.f.toLowerCase().includes(q)));
    if (!az) rows = [...rows.filter((r) => r.r), ...rows.filter((r) => !r.r)];
    const total = rows.length;
    const builtIn = new Map(FONTS.filter((f) => f.family).map((f) => [f.family, f]));
    const list = rows.slice(page * 40, page * 40 + 40).map((r) => {
      const a = addedBy.get(r.f);
      const b = builtIn.get(r.f);
      const size = a ? kbOf(r, latinRegular(a.faces)) : measured.has(r.f) ? { kb: Math.ceil(measured.get(r.f) / 1024), about: true } : kbOf(r, 0);
      return {
        family: r.f, kind: r.c, latinExt: (r.s || []).includes('latin-ext'), ...size,
        added: Boolean(a), builtIn: b ? b.value : null, bodySafe: Boolean(r.b), recommended: Boolean(r.r),
      };
    });
    return c.json({ rows: list, total, page, built: CATALOGUE.built });
  });

  api.get('/site/fonts/sample', async (c) => {
    const ctx = c.get('ctx');
    const row = catalogueRow(c.req.query('family'));
    if (!row) return c.json({ error: WORDS.unknown }, 404);
    const text = String(c.req.query('text') || row.f);
    if ([...text].length > 120) return c.json({ error: 'At most 120 letters' }, 400);
    let w = Number(c.req.query('w')) || 400;
    w = row.a ? Math.max(row.a[0], Math.min(row.a[1], w)) : (row.w.includes(w) ? w : row.w.find((x) => x >= 400) || row.w[0]);
    const key = `${row.f}|${w}|${text}`;
    const hit = SAMPLES.get(key);
    const send = (body) => c.body(body, 200, { 'Content-Type': 'font/woff2', 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
    if (hit && Date.now() - hit.at < SAMPLE_TTL) return send(hit.body);
    // 120 a minute for each person.
    const who = ctx.user?.id || 'anon';
    const times = (RATE.get(who) || []).filter((t) => Date.now() - t < 60_000);
    if (times.length >= 120) return c.json({ error: WORDS.slow }, 429);
    times.push(Date.now());
    RATE.set(who, times);
    if (RATE.size > 5000) RATE.clear();
    await slot();
    try {
      const css = await outsideFetch(`${cssBase()}/css2?family=${familyParam(row.f)}:wght@${w}&text=${encodeURIComponent(text)}`, { timeout: 8000, maxBytes: 200_000, headers: { 'User-Agent': UA } });
      if (!css.ok) return c.json({ error: WORDS.down }, 502);
      const face = parseFaces(css.body.toString('utf8'))[0];
      if (!face || !fileAllowed(face.url)) return c.json({ error: WORDS.odd }, 502);
      const file = await outsideFetch(face.url, { timeout: 8000, maxBytes: 200_000 });
      if (!file.ok || !isWoff2(file.body)) return c.json({ error: WORDS.odd }, 502);
      SAMPLES.set(key, { body: file.body, at: Date.now() });
      SAMPLE_BYTES.n += file.body.length;
      while (SAMPLES.size > 400 || SAMPLE_BYTES.n > 20 * 1024 * 1024) {
        const [k, v] = SAMPLES.entries().next().value;
        SAMPLES.delete(k);
        SAMPLE_BYTES.n -= v.body.length;
      }
      return send(file.body);
    } catch {
      return c.json({ error: WORDS.down }, 502);
    } finally {
      release();
    }
  });

  api.get('/site/fonts/file/:file', async (c) => {
    const ws = await opened(c);
    const m = FILE_NAME.exec(c.req.param('file'));
    if (!m) return c.json({ error: 'not found' }, 404);
    const buf = await fontFile(c.get('db'), ws, m[1]);
    if (!buf) return c.json({ error: 'not found' }, 404);
    return c.body(buf, 200, { 'Content-Type': 'font/woff2', 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
  });
}

// ── The public site's routes (public.js, before its files) ──
export const publicFontFile = async (c) => {
  const site = c.get('site');
  const m = FILE_NAME.exec(c.req.param('file') || '');
  const buf = m ? await fontFile(site.db, site.ws.id, m[1]) : null;
  if (!buf) return c.text('not found', 404);
  return c.body(buf, 200, { 'Content-Type': 'font/woff2', 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
};

// The licences of the fonts a site uses (linked from nowhere; SITE.md).
const LICENCE_DIR = fileURLToPath(new URL('../../../shared/site/fonts/LICENCES/', import.meta.url));
const LICENCE_NAMES = { OFL: 'SIL Open Font License 1.1', 'Apache-2.0': 'Apache License 2.0', UFL: 'Ubuntu Font Licence 1.0' };
export const licencesText = (theme, added) => {
  const seen = new Set();
  const lines = ['Fonts on this website', '', 'Every font here is served by this website itself. Each is free to use under its licence:', ''];
  const texts = [];
  for (const value of [theme?.fonts?.heading, theme?.fonts?.body]) {
    const font = fontFor(value, added);
    if (!font?.family || seen.has(font.family)) continue;
    seen.add(font.family);
    const row = catalogueRow(font.family);
    const licence = row?.l || 'OFL';
    lines.push(`${font.family} — ${LICENCE_NAMES[licence] || licence}${row?.d ? ` — https://github.com/google/fonts/tree/main/${row.d}` : ''}`);
    const file = `${LICENCE_DIR}${font.family}.txt`;
    if (existsSync(file)) texts.push(`── ${font.family} ──\n\n${readFileSync(file, 'utf8').trim()}`);
  }
  if (!seen.size) lines.push('This website uses the reader’s own fonts.');
  return `${lines.join('\n')}\n${texts.length ? `\n${texts.join('\n\n')}\n` : ''}`;
};

