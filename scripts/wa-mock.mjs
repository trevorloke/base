// The website's before/after mock (WA decision 28): what stage 3a would do to
// the public site, shown on the real pages before any of it is built.
//
// It starts base.win on PORT (5494) with the Imagine Surrey seed, then again
// with the Base seed, signs up a manager, gives the site a made-up financial
// agent (so the Authorized-by line shows), adds the walk's sample page (a hero without a picture, a text
// block, two points, a newsletter and a band) and three sample news posts,
// then screenshots the home page, the sample page and /news at 1440×900 and
// 390×844 (whole pages), in three looks:
//   1. imagine-surrey  — Imagine Surrey as saved today. "After" shows only the
//                        structural fixes (decisions 32–35).
//   2. is-modern       — Imagine Surrey with the modern heading sizes, the
//                        shadow on the hero and bands only, and the picture
//                        beside the headline (decisions 30–31) plus the fixes.
//   3. civic-blue      — on the Base seed: the proposed Civic blue look (its
//                        colours and the DM Serif Display / DM Sans pairing), before with
//                        today's code, after with the modern scale and fixes.
// "Before" is the page as base.win draws it today. "After" is the same page
// with this file's MOCK_CSS and a few DOM moves applied in the browser: a
// drawing of stage 3a, not its code. Where a hero has no picture, "after"
// shows a plain box labelled "Your picture" (never a photo presented as the
// campaign's). 3 looks × 3 pages × 2 sizes × before/after = 36 PNGs, plus
// index.md naming each.
//
//   cd web && npm run build && cd ..
//   PORT=5494 OUT=<dir> node scripts/wa-mock.mjs
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { newModule } from '../shared/site/catalogue.js';
import { SKINS } from '../shared/site/theme.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 5494;
const OUT = process.env.OUT || '/tmp/wa-mock';
const BASE = `http://127.0.0.1:${PORT}`;
mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── The three looks ──
const IS = SKINS['imagine-surrey'];
const isTheme = { ...IS, logo: { url: '/site-assets/imagine-surrey/logo.webp', alt: 'Imagine Surrey' } };
// Civic blue: a proposal for owner item 3 (decision 37), none of Imagine
// Surrey's colours. Every pair passes 4.5:1 (checkTheme reports no problems).
const civicBlue = {
  colors: { brand: '#1f4fa3', brandInk: '#ffffff', accent: '#8fd0f0', accentInk: '#0b1f3a', ink: '#13233a', paper: '#ffffff', surface: '#f1f5fb', line: '#d6e0ee', link: '#1f4fa3', action: '#1f4fa3', actionInk: '#ffffff' },
  fonts: { heading: 'dm-serif-display', body: 'dm-sans' },
  radius: 'soft',
  pop: false,
};
const LOOKS = [
  { key: 'imagine-surrey', name: 'Imagine Surrey as saved today', theme: isTheme, after: { modern: false, beside: false } },
  { key: 'is-modern', name: 'Imagine Surrey, modern sizes and the picture beside the headline', theme: isTheme, after: { modern: true, beside: true } },
  { key: 'civic-blue', name: 'Civic blue (DM Serif Display / DM Sans)', theme: civicBlue, after: { modern: true, beside: true } },
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

// ── Stage 3a, drawn ──
// Decision numbers are WA.md's. The selectors are today's markup; 3a moves
// this into site.css and the components.
const MOCK_CSS = `
/* 32: sections breathe the same everywhere; two plain sections share a gap. */
.section { padding-top: clamp(48px, 7vw, 96px); padding-bottom: clamp(48px, 7vw, 96px); }
.section.tone-paper + .section.tone-paper { padding-top: clamp(24px, 3vw, 40px); }
/* 32: the hero keeps room for a second line only for rotating words. */
.hero-title { min-height: 0; }
.hero-title[data-words] { min-height: 2.2em; }
/* 32: points fill the row: 3 across at most, 2 on a tablet, 1 on a phone. */
.pillars.mock-cols { display: grid; gap: 20px; grid-template-columns: minmax(0, 1fr); }
@media (min-width: 600px) { .pillars.mock-cols { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (min-width: 900px) { .pillars.mock-cols { grid-template-columns: repeat(var(--cols-n), minmax(0, 1fr)); } }
.mock-cols .pillar { flex-direction: column; align-items: flex-start; flex-wrap: nowrap; gap: 12px; margin: 0; padding: 24px;
  border: 1px solid var(--line); border-radius: var(--radius); background: var(--paper); }
.mock-cols .pillar > * { flex: none; }
.mock-cols .pillar p { margin: 0; }
.mock-cols .pillar p:empty { display: none; }
/* 34: news as cards, the whole card one link named by the title. */
.card-grid.mock-news { grid-template-columns: repeat(auto-fill, minmax(min(280px, 100%), 1fr)); }
.mock-news .card { position: relative; gap: 8px; padding: 24px; transition: border-color 0.2s ease; }
.mock-news .card:hover { border-color: var(--link); }
.mock-news .card.has-picture { background: var(--paper); }
.mock-news .news-card-image { margin: -24px -24px 8px; width: calc(100% + 48px); max-width: none; aspect-ratio: 16 / 9; object-fit: cover; }
.mock-news .eyebrow { font-size: 14px; font-weight: 500; text-transform: none; letter-spacing: 0; }
.mock-news .h3 { margin: 0; font-size: 21px; line-height: 1.3; }
.mock-news .h3 a { color: inherit; text-decoration: none; }
.mock-news .h3 a::after { content: ''; position: absolute; inset: 0; border-radius: var(--radius); }
.mock-news .h3 a:focus-visible { outline: none; }
.mock-news .card:focus-within { outline: 3px solid var(--link); outline-offset: 2px; }
.mock-news .card p:not(.eyebrow) { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
/* 35: the legal lines, each on its own line, readable, in the body face. */
.footer-legal-block { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding-top: 24px;
  border-top: 1px solid color-mix(in srgb, var(--brand-ink) 18%, transparent); }
.footer-legal-block, .footer-legal-block p, .form-small {
  font-family: var(--font-body); font-size: 15px; line-height: 1.6; text-transform: none; letter-spacing: 0; }
.footer-legal-block p { margin: 0; color: var(--brand-soft); }
.footer-legal-block .footer-legal a { min-height: 48px; display: inline-flex; align-items: center; }
/* 36: one focus ring. */
.site-shell a:focus-visible, .site-shell button:focus-visible { outline: 3px solid var(--link); outline-offset: 2px; }

/* 30: the modern scale. The hero is the biggest thing on the page; the
   shadow stays on the hero and the bands only. */
html[data-mock-scale="modern"] .hero-title { font-size: clamp(40px, 6vw, 72px); }
html[data-mock-scale="modern"] .section:not(.hero):not(.band):not(.page-head) .display { font-size: clamp(28px, 3.6vw, 44px); --pop-c: transparent; }
html[data-mock-scale="modern"] .band .display { font-size: clamp(32px, 4.8vw, 56px); }
html[data-mock-scale="modern"] .page-head .display { font-size: clamp(34px, 5vw, 60px); --pop-c: transparent; }
html[data-mock-scale="modern"] .mock-cols .pillar h3 { font-size: 21px; }

/* 31: the picture beside the words (4:5 at 900 px and wider; above the
   words at 16:9 on smaller screens). */
.hero.mock-beside .hero-inner { display: grid; grid-template-columns: minmax(0, 1fr); gap: 32px; align-items: center; }
.hero.mock-beside .hero-image, .hero.mock-beside .mock-ph { order: -1; aspect-ratio: 16 / 9; width: 100%; height: auto; object-fit: cover; }
@media (min-width: 900px) {
  .hero.mock-beside .hero-inner { grid-template-columns: minmax(0, 7fr) minmax(0, 5fr); gap: 56px; }
  .hero.mock-beside .hero-image, .hero.mock-beside .mock-ph { order: 0; aspect-ratio: 4 / 5; max-height: 600px; }
}
.mock-ph { display: flex; align-items: center; justify-content: center; border-radius: var(--radius);
  border: 2px dashed color-mix(in srgb, var(--brand-ink) 45%, transparent);
  background: color-mix(in srgb, var(--brand-ink) 10%, transparent); color: var(--brand-ink);
  font: 600 18px/1.3 var(--font-body); }
`;

// The DOM moves the CSS can't make (3a makes them in the components).
function applyAfter({ modern, beside }) {
  document.documentElement.dataset.mockScale = modern ? 'modern' : 'classic';
  // 32: the rotating words keep their room; a still headline doesn't.
  for (const t of document.querySelectorAll('.hero-title')) {
    if (t.querySelector('.hero-word')) t.setAttribute('data-words', '');
  }
  // 31: beside. A hero with no picture shows the labelled placeholder.
  if (beside) {
    for (const hero of document.querySelectorAll('.hero')) {
      hero.classList.add('mock-beside');
      if (!hero.querySelector('.hero-image')) {
        const ph = document.createElement('div');
        ph.className = 'mock-ph';
        ph.setAttribute('role', 'img');
        ph.setAttribute('aria-label', 'Your picture');
        ph.textContent = 'Your picture';
        hero.querySelector('.hero-inner').append(ph);
      }
    }
  }
  // 32: columns know how many points they have.
  for (const p of document.querySelectorAll('.pillars')) {
    p.classList.add('mock-cols');
    p.style.setProperty('--cols-n', String(Math.max(1, Math.min(p.children.length, 3))));
  }
  // 33: one page heading. A first section whose heading is the page's title
  // takes the title band's place and becomes the h1.
  const head = document.querySelector('.page-head');
  const next = head?.nextElementSibling;
  const nh = next?.querySelector('.display');
  const norm = (s) => String(s || '').trim().toLowerCase();
  if (head && nh && norm(nh.textContent) === norm(head.querySelector('h1')?.textContent)) {
    const h1 = document.createElement('h1');
    for (const a of nh.attributes) h1.setAttribute(a.name, a.value);
    h1.innerHTML = nh.innerHTML;
    nh.replaceWith(h1);
    head.remove();
  }
  // 34: news cards: the title is the link; the picture fills the top.
  for (const g of document.querySelectorAll('.news .card-grid')) {
    g.classList.add('mock-news');
    for (const card of g.querySelectorAll('.card')) {
      const link = card.querySelector('.card-link');
      const h = card.querySelector('.h3');
      if (link && h) {
        const a = document.createElement('a');
        a.href = link.getAttribute('href');
        a.textContent = h.textContent;
        h.textContent = '';
        h.append(a);
        link.remove();
      }
      const img = card.querySelector('.news-card-image');
      if (img) { card.classList.add('has-picture'); card.prepend(img); }
    }
  }
  // 35: the legal lines, one each.
  for (const b of document.querySelectorAll('.footer-bottom')) {
    b.classList.replace('footer-bottom', 'footer-legal-block');
    const copy = b.querySelector('p:not([class])');
    if (copy) {
      copy.classList.add('footer-copy');
      const auth = copy.querySelector('.footer-authorization');
      if (auth) {
        const p = document.createElement('p');
        p.className = 'footer-auth';
        p.textContent = auth.textContent;
        auth.remove();
        copy.after(p);
      }
    }
    for (const p of b.querySelectorAll('p.footer-authorization')) p.className = 'footer-auth';
    for (const p of b.querySelectorAll('p.footer-parent')) p.classList.add('footer-by');
  }
}

// On main the Latin faces for Montserrat and Inter (one face, weights
// 100–900) are shadowed by the Gurmukhi faces declared under the same names
// with narrower weight ranges (site.css, TR), so the browser draws Latin text
// in a fallback face. This branch declares them under the same ranges; on a
// checkout without that fix this adds the Latin files the same way, so the
// pictures show the site in its own fonts. On this branch it adds nothing.
function fixLatinFaces() {
  const out = [];
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const r of rules) {
      if (!(r instanceof CSSFontFaceRule)) continue;
      const fam = r.style.getPropertyValue('font-family').replace(/["']/g, '').trim();
      const src = r.style.getPropertyValue('src');
      if (!/^(Montserrat|Inter)$/.test(fam) || /gurmukhi/.test(src) || r.style.getPropertyValue('font-weight').trim() !== '100 900') continue;
      const abs = src.replace(/url\("?([^")]+)"?\)/g, (m, u) => `url("${new URL(u, sheet.href).href}")`);
      const range = r.style.getPropertyValue('unicode-range');
      for (const w of ['100 599', '600 900']) out.push(`@font-face{font-family:"${fam}";font-style:normal;font-weight:${w};font-display:swap;src:${abs};${range ? `unicode-range:${range};` : ''}}`);
    }
  }
  const s = document.createElement('style');
  s.textContent = out.join('\n');
  document.head.append(s);
  return out.length;
}

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
      mod('band', 'mock-band'),
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
    await act('site.settings.save', { theme: look.theme });
    for (const size of SIZES) {
      const ctx = await browser.newContext({ viewport: size.viewport, deviceScaleFactor: 1, timezoneId: 'America/Vancouver', reducedMotion: 'reduce' });
      const pub = await ctx.newPage();
      for (const pg of PAGES) {
        await pub.goto(`${BASE}${pg.path}`, { waitUntil: 'load' });
        await pub.evaluate(fixLatinFaces);
        await settle(pub);
        const face = await pub.evaluate(async () => {
          const fam = getComputedStyle(document.querySelector('.display') || document.body).fontFamily.split(',')[0].trim();
          return { fam, loaded: (await document.fonts.load(`700 40px ${fam}`, 'Abc')).length > 0 };
        });
        if (!face.loaded) { failed = true; log(`FAIL  ${look.key} ${pg.key}: the heading face ${face.fam} didn't load`); }
        const auth = await pub.evaluate(() => /Authorized by Sam Example/.test(document.querySelector('.site-footer')?.textContent || ''));
        if (!auth) { failed = true; log(`FAIL  ${look.key} ${pg.key}: no Authorized-by line in the footer`); }
        await sleep(400);
        const name = (when) => `${look.key}-${pg.key}-${size.key}-${when}.png`;
        await pub.screenshot({ path: join(OUT, name('before')), fullPage: true });
        await pub.addStyleTag({ content: MOCK_CSS });
        await pub.evaluate(applyAfter, look.after);
        await settle(pub);
        await sleep(300);
        const over = await pub.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        if (over > 0) { failed = true; log(`FAIL  ${name('after')} scrolls sideways by ${over}px`); }
        await pub.screenshot({ path: join(OUT, name('after')), fullPage: true });
        index.push({ look, pg, size, before: name('before'), after: name('after') });
        log(`saved ${name('before')} and ${name('after')}`);
      }
      await ctx.close();
    }
  }
  await desk.close();
  await stopServer();
}

try {
  browser = await chromium.launch();
  for (const seed of SEEDS) await shootSeed(seed);
  const lines = [
    '# Website mock: before and after (WA decision 28)',
    '',
    'Whole-page screenshots at 1440×900 (computer) and 390×844 (phone). “Before” is the site as base.win draws it today. “After” is the same page with stage 3a drawn over it in the browser (scripts/wa-mock.mjs): a mock, not the finished code.',
    '',
    '- imagine-surrey: Imagine Surrey as saved today. After shows only the structural fixes: no blank band under a one-line headline, points filling the row, one heading on News, news as cards, larger legal lines in the footer and under forms.',
    '- is-modern: Imagine Surrey with the modern heading sizes, the shadow on the hero and bands only, and the picture beside the headline, plus the fixes. Before is the same as the first look’s.',
    '- civic-blue: the proposed Civic blue look (DM Serif Display / DM Sans), shown on the Base seed (a made-up campaign) so no Imagine Surrey logo or words appear in a look that isn’t theirs. Before is today’s code with its colours and fonts; after adds the modern sizes, the picture beside the headline and the fixes.',
    '',
    'The Base look (the starting look for other campaigns) follows whatever is decided for the Imagine Surrey look: the structural fixes always, the modern sizes and picture beside the headline only if approved.',
    '',
    'Every site here has a made-up financial agent (“Authorized by Sam Example, 555-0100”), so the footer shows that line on its own line. Imagine Surrey’s real site has none set yet (owner item 5).',
    '',
    'Both shots of every pair draw Latin text in the look’s own fonts. On main today the Gurmukhi faces in site.css hide the Latin Montserrat and Inter files, so the live site draws its Latin text in a fallback face; this branch fixes that (each Latin file is declared under the Gurmukhi faces’ weight ranges), and that fix ships on its own, whatever is decided about the looks.',
    '',
    'The sample page has no hero picture, so the after shots show a plain box labelled “Your picture”. The news posts are made-up samples without pictures.',
    '',
    '| Look | Page | Size | Before | After |',
    '|---|---|---|---|---|',
    ...index.map((r) => `| ${r.look.name} | ${r.pg.name} | ${r.size.key === '1440' ? '1440×900' : '390×844'} | ${r.before} | ${r.after} |`),
    '',
  ];
  writeFileSync(join(OUT, 'index.md'), lines.join('\n'));
  log(`${index.length * 2} screenshots and index.md in ${OUT}`);
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await browser?.close().catch(() => {});
  stop();
}
process.exit(failed ? 1 : 0);
