// The website's real before/after (WA decision 28, rebuilt as WEB): the
// same pages as scripts/wa-mock.mjs, but drawn by the code itself, not by a
// mock over it. Run once on a checkout of main ("before") and once on this
// branch ("after"): each run starts that checkout's server on PORT with the
// Imagine Surrey seed, then the Base seed, signs up a manager, gives the
// site a made-up financial agent, adds the sample page and three sample
// posts, and saves the home page, the sample page and /news at 1440×900 and
// 390×844 (whole pages) in three looks:
//   1. imagine-surrey — Imagine Surrey as saved (its theme untouched).
//   2. is-modern      — Imagine Surrey's theme with the modern heading
//                       sizes picked (scale: 'modern'; main ignores it).
//   3. civic-blue     — on the Base seed: the Civic blue look (its colours,
//                       DM Serif Display / DM Sans, the modern sizes).
// The sample page's hero has no picture (never a photo presented as the
// campaign's), so its words stand alone on both.
//
//   (in each checkout) npm run build
//   ROOT=<checkout> WHEN=before|after PORT=5494 OUT=<dir> node scripts/wa-before-after.mjs
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = process.env.ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
const WHEN = process.env.WHEN === 'before' ? 'before' : 'after';
// The checkout's own catalogue and set-up, so each side seeds as it would.
const { newModule } = await import(join(ROOT, 'shared/site/catalogue.js'));
const { presetFor } = await import(join(ROOT, 'server/lib/preset.js'));
const PORT = Number(process.env.PORT) || 5494;
const OUT = process.env.OUT || '/tmp/wa-before-after';
const BASE = `http://127.0.0.1:${PORT}`;
mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── The three looks ──
const IS = presetFor('imagine-surrey').site.skin;
const isTheme = { ...IS, logo: { url: '/site-assets/imagine-surrey/logo.webp', alt: 'Imagine Surrey' } };
// Civic blue as shared/site/looks.js has it (written out, so main — which
// doesn't have the look — draws the same colours and fonts).
const civicBlue = {
  colors: { brand: '#1f4fa3', brandInk: '#ffffff', accent: '#8fd0f0', accentInk: '#0b1f3a', ink: '#13233a', paper: '#ffffff', surface: '#f1f5fb', line: '#d6e0ee', link: '#1f4fa3', action: '#1f4fa3', actionInk: '#ffffff' },
  fonts: { heading: 'dm-serif-display', body: 'dm-sans' },
  radius: 'soft',
  pop: false,
};
const LOOKS = [
  { key: 'imagine-surrey', name: 'Imagine Surrey as saved', theme: isTheme },
  { key: 'is-modern', name: 'Imagine Surrey with the modern look picked', theme: { ...isTheme, scale: 'modern' } },
  { key: 'civic-blue', name: 'Civic blue (DM Serif Display / DM Sans) on the Base seed', theme: { ...civicBlue, skin: 'civic-blue', scale: 'modern' } },
];
// Imagine Surrey's two looks on its own seed; Civic blue on the Base seed, so
// no Imagine Surrey logo or words appear in a look that isn't theirs.
const SEEDS = [
  { brand: 'imagine-surrey', org: 'Imagine Surrey', looks: LOOKS.slice(0, 2) },
  { brand: 'base', org: 'Example Campaign', looks: LOOKS.slice(2) },
];
const PAGES = [
  { key: 'home', path: '/site/', name: 'Home page' },
  { key: 'sample', path: '/site/sample-page', name: 'Sample page' },
  { key: 'news', path: '/site/news', name: 'News' },
];
const SIZES = [
  { key: '1440', viewport: { width: 1440, height: 900 } },
  { key: '390', viewport: { width: 390, height: 844 } },
];

// Every picture loaded before a shot: the footer logo is lazy, and a whole-
// page screenshot doesn't scroll to it.
async function settle(pub) {
  await pub.evaluate(async () => {
    for (const i of document.images) i.loading = 'eager';
    await Promise.all([...document.images].map((i) => (i.complete ? 0 : new Promise((r) => { i.onload = r; i.onerror = r; }))));
    await document.fonts.ready;
  });
}

// ── The server, once per seed ──
let server;
let serverLog = '';
const stop = () => { try { server?.kill('SIGTERM'); } catch { /* gone */ } };
process.on('exit', stop);
// Stopped from outside (Ctrl-C, a timeout): the server goes too.
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stop(); process.exit(130); });

async function startServer(brand) {
  serverLog = '';
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), STARBASE_OPEN_SIGNUP: '1', STARBASE_DATA: 'memory', STARBASE_BRAND: brand },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  for (let i = 0; ; i += 1) {
    try { if ((await fetch(`${BASE}/signup`)).ok) return; } catch { /* not up yet */ }
    if (i > 120) throw new Error(`the server didn't start on ${PORT}\n${serverLog.slice(-2000)}`);
    await sleep(500);
  }
}
async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const gone = new Promise((r) => server.once('exit', r));
  stop();
  await Promise.race([gone, sleep(5000)]);
}

let browser;
let failed = false;
const index = [];

async function shootSeed(seed) {
  await startServer(seed.brand);
  const desk = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, timezoneId: 'America/Vancouver' });
  const page = await desk.newPage();
  await page.goto(`${BASE}/signup`, { waitUntil: 'domcontentloaded' });
  await page.fill('#su-name', 'Sam Example');
  if (await page.locator('#su-org').count()) await page.fill('#su-org', seed.org);
  await page.fill('#su-email', `mock.${Date.now()}@example.org`);
  await page.fill('#su-password', 'surrey-forward-2026');
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/admin\/?$/, { timeout: 30000 });
  const act = async (name, input) => {
    const r = await page.evaluate(async ([n, b]) => {
      const res = await fetch(`/api/actions/${n}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    }, [name, input]);
    if (r.status >= 300) throw new Error(`${name}: ${r.status} ${JSON.stringify(r.body).slice(0, 400)}`);
    return r.body;
  };
  // A made-up financial agent, so the footer shows the Authorized-by line
  // on its own line (owner item 5: the seed has none).
  const site = await page.evaluate(async () => (await fetch('/api/site', { credentials: 'same-origin' })).json());
  const org = site.settings?.org || {};
  await act('site.settings.save', { org: { ...org, agentName: 'Sam Example', agentContact: '555-0100' } });
  // The walk's sample page (research d09/d13), as the builder makes it.
  const mod = (kind, id, props = {}) => { const m = newModule(kind, id); return { ...m, props: { ...m.props, ...props } }; };
  const sample = await act('site.page.create', {
    title: 'Sample page',
    slug: 'sample-page',
    modules: [
      mod('hero', 'mock-hero', { titlePrefix: 'A sample headline', text: 'Sample words on what this page is about and what to do next.' }),
      mod('text', 'mock-text', { title: 'A sample heading', body: 'Some sample words for this section. **Bold words** here.' }),
      mod('columns', 'mock-cols', { items: [{ icon: 'civic', title: 'First sample point', body: '' }, { icon: 'civic', title: 'Second sample point', body: '' }] }),
      mod('newsletter', 'mock-news'),
      // Sample words of its own: Publish refuses the band's starting samples.
      mod('band', 'mock-band', { title: 'Sample words for a band,', highlight: 'with a button' }),
    ],
  });
  const sampleId = sample.id || sample.page?.id;
  await act('site.page.publish', { id: sampleId });
  // Three sample posts (no pictures: the cards show the soft panel).
  for (const [title, excerpt] of [
    ['A sample post', 'A short sample line about what happened and why it matters to people here.'],
    ['Another sample post', 'One or two sentences that sum the post up, shown in lists and when it’s shared.'],
    ['A third sample post', 'Sample words for a third post, long enough to show how a summary is cut at two lines on a card in the list.'],
  ]) {
    const p = await act('site.post.save', { title, excerpt, body: `${excerpt}\n\n## A sample sub-heading\n\nMore sample words.` });
    await act('site.post.publish', { id: p.id || p.post?.id });
  }

  for (const look of seed.looks) {
    // Its own look, not the campaign's brand (a new website follows the brand).
    await act('site.settings.save', { theme: { ...look.theme, follow: false } });
    for (const size of SIZES) {
      const ctx = await browser.newContext({ viewport: size.viewport, deviceScaleFactor: 1, timezoneId: 'America/Vancouver', reducedMotion: 'reduce' });
      const pub = await ctx.newPage();
      for (const pg of PAGES) {
        await pub.goto(`${BASE}${pg.path}`, { waitUntil: 'load' });
        await settle(pub);
        const face = await pub.evaluate(async () => {
          const fam = getComputedStyle(document.querySelector('.display') || document.body).fontFamily.split(',')[0].trim();
          return { fam, loaded: (await document.fonts.load(`700 40px ${fam}`, 'Abc')).length > 0 };
        });
        if (!face.loaded) { failed = true; log(`FAIL  ${look.key} ${pg.key}: the heading face ${face.fam} didn't load`); }
        const auth = await pub.evaluate(() => /Authorized by Sam Example/.test(document.querySelector('.site-footer')?.textContent || ''));
        if (!auth) { failed = true; log(`FAIL  ${look.key} ${pg.key}: no Authorized-by line in the footer`); }
        await sleep(400);
        const name = `${look.key}-${pg.key}-${size.key}-${WHEN}.png`;
        const over = await pub.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        if (over > 0) { failed = true; log(`FAIL  ${name} scrolls sideways by ${over}px`); }
        await pub.screenshot({ path: join(OUT, name), fullPage: true });
        index.push({ look, pg, size, file: name });
        log(`saved ${name}`);
      }
      await ctx.close();
    }
  }
  await desk.close();
  await stopServer();
}

try {
  browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage'] } : {});
  for (const seed of SEEDS) await shootSeed(seed);
  const lines = [
    `# ${WHEN === 'before' ? 'Before (main)' : 'After (this branch)'}`,
    '',
    ...index.map((r) => `| ${r.look.name} | ${r.pg.name} | ${r.size.key === '1440' ? '1440×900' : '390×844'} | ${r.file} |`),
    '',
  ];
  writeFileSync(join(OUT, `index-${WHEN}.md`), lines.join('\n'));
  log(`${index.length} screenshots and index-${WHEN}.md in ${OUT}`);
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await browser?.close().catch(() => {});
  stop();
}
process.exit(failed ? 1 : 0);
