// Website renderer E2E — the public site's pages as a visitor sees them.
//
// A tiny server started here calls renderSite (server/ext/site/render)
// directly for two sample sites: Imagine Surrey's home page in its own skin
// (its words, from apps/web) at /is/, and a generic campaign on the Base
// skin at /base/ (server/test/site-samples.js). It serves the site's css,
// fonts and island script (web/dist/site-islands.js — run `cd web && npm
// run build` first) and answers the forms like the site server would
// (SITE.md: JSON → 200/400, a plain post → 303 back with ?sent= / ?error=).
//
// Checked, on a 1360px desktop and a 390px phone, in both skins: nothing
// scrolls sideways, buttons and fields are at least 48px tall, text reads
// at WCAG AA contrast, every id is used once and every field is labelled,
// and the islands hydrate without a mismatch. Then: the rotating words (and
// none under reduced motion), the Menu (Escape; on a phone), the donate
// amounts (never above the limit; monthly), field errors tied to their
// fields, a newsletter and a petition sent as JSON with SITE.md's field
// names, the share sheet (WhatsApp first, ?source=share-<channel>, copy),
// the donate checkout, a one-tap volunteer sign-up, the same forms without
// JavaScript, the post, campaign, preview and not-found pages, everything
// under a client's path (/imaginesurrey, through server/lib/mount.js), and
// the Imagine Surrey home page against imaginesurrey.ca's design (navy hero,
// red Donate, Montserrat, the red heading shadow, yellow band, deep-navy
// footer). Screenshots of both skins, desktop and phone, go to SHOTS.
//
//   cd web && npm run build && cd ..
//   PORT=5150 SHOTS=/tmp/site-render node e2e-site-render.mjs
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { renderSite, readSiteAsset, islandsBuilt } from './server/ext/site/render/index.js';
import { rewriters } from './server/lib/mount.js';
import { imagineSurrey, baseSample, samplePost, sampleData } from './server/test/site-samples.js';
import { checkTheme, contrast, mix, PAIRS, SKINS } from './shared/site/theme.js';

const PORT = Number(process.env.PORT) || 5150;
const SHOTS = process.env.SHOTS || '/tmp/site-render';
const ORIGIN = `http://127.0.0.1:${PORT}`;
mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  — ${String(extra).slice(0, 300)}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!islandsBuilt()) {
  console.log('FAIL  web/dist/site-islands.js is missing: run `cd web && npm run build` first');
  process.exit(1);
}

// ── The sample sites, served ──
const SITES = { is: imagineSurrey, base: baseSample };
const IMAGES = { 'hero-park': 'hero-park.jpg', 'members-rally': 'members-rally.jpg', 'is-logo': 'logo.webp' };
const posted = [];

const readBody = (req) => new Promise((resolve) => {
  let b = '';
  req.on('data', (c) => { b += c; });
  req.on('end', () => resolve(b));
});

// What the site server answers (SITE.md "Public forms"), in miniature.
function answerForm(kind, body) {
  if (String(body.website || '')) return { ok: true };
  const email = String(body.email || '').trim();
  if (!email && !String(body.phone || '').trim()) return { error: 'Enter your email or a phone number', field: 'email' };
  if (/bounce/.test(email)) return { error: 'That address bounced. Try another one.', field: 'email' };
  if (kind === 'newsletter' && !(body.consent_email === true || body.consent_email === 'true')) return { error: 'Tick the box', field: 'consent_email' };
  if ((kind === 'petition' || kind === 'pledge') && !body.campaign) return { error: 'Which petition?', field: 'campaign' };
  if (kind === 'rsvp' && !body.shift_id) return { error: 'Which shift?', field: 'shift_id' };
  if (kind === 'contact' && !String(body.message || '').trim()) return { error: 'Write your message', field: 'message' };
  if ((kind === 'donate' || kind === 'join') && !(body.declaration === true || body.declaration === 'true')) return { error: 'Tick the box to confirm', field: 'declaration' };
  if (kind === 'donate' && !(Number(body.amount_cents) > 0)) return { error: 'Choose an amount', field: 'amount_cents' };
  if (kind === 'donate' || kind === 'join') return { ok: true, checkout_url: `${ORIGIN}/checkout-stub?kind=${kind}&amount=${Number(body.amount_cents) || 0}` };
  return { ok: true };
}

// ── The theme sweep: every colour pair the site draws text in ──
// Themes that pass the theme check (theme.js checkTheme — what Website →
// Theme and site.settings.save let an admin save), made at its edge: each
// text colour just reaches 4.5:1 on the backgrounds the check names for it
// (PAIRS), from a random colour; light pages and dark ones. A page with
// every kind of module, each that takes a background in every one, its
// forms showing an error, a thank-you and the campaign page are drawn in
// each, and every piece of text must read (the audit below). Seeded: the
// same themes every run. Two from the review: a yellow brand under black
// text (a Dark petition was 1.25:1), and a pale soft-panel colour (links
// and headings on it were 4.02:1) — each swept only if the check lets it
// be saved.
let seed = 20261109;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const randomColor = (lo = 0, hi = 255) => `#${[0, 1, 2].map(() => Math.round(lo + rand() * (hi - lo)).toString(16).padStart(2, '0')).join('')}`;
const needs = (fg) => PAIRS.filter((p) => p.fg === fg).map((p) => p.bg);
const barely = (colors, fg) => {
  const bgs = needs(fg).map((k) => colors[k]);
  for (let tries = 0; tries < 40; tries += 1) {
    const start = randomColor();
    for (const toward of rand() < 0.5 ? ['#000000', '#ffffff'] : ['#ffffff', '#000000']) {
      for (let t = 0; t <= 1.0001; t += 0.02) {
        const c = mix(start, toward, Math.min(1, t));
        if (bgs.every((bg) => contrast(c, bg) >= 4.5)) return c;
      }
    }
  }
  return null;
};
const THEMES = [
  { name: 'review: yellow brand, black text on it', theme: { skin: 'base', colors: { brand: '#ffcc00', brandInk: '#000000' } } },
  { name: 'review: pale soft panels', theme: { skin: 'base', colors: { accent: '#3b3fd8', accentInk: '#ffffff', surface: '#a9b0bb' } } },
  { name: 'Imagine Surrey', theme: { ...SKINS['imagine-surrey'], logo: { url: '', alt: '' } } },
  { name: 'Base', theme: { ...SKINS.base } },
];
for (let n = 0; THEMES.length < 16 && n < 400; n += 1) {
  const dark = rand() < 0.35;
  const paper = dark ? randomColor(0, 60) : randomColor(200, 255);
  const colors = {
    paper, surface: mix(paper, dark ? '#ffffff' : '#000000', 0.03 + rand() * 0.14),
    brand: randomColor(), accent: randomColor(), action: randomColor(), line: mix(paper, dark ? '#ffffff' : '#000000', 0.25),
  };
  for (const fg of ['ink', 'link', 'brandInk', 'accentInk', 'actionInk']) colors[fg] = barely(colors, fg);
  if (Object.values(colors).some((c) => !c)) continue;
  THEMES.push({ name: `random ${THEMES.length - 3} (${dark ? 'dark' : 'light'} page)`, theme: { skin: 'base', colors, pop: rand() < 0.5 } });
}
const TONE_NAMES = ['paper', 'surface', 'brand', 'accent', 'ink'];
const CLOSED = { ...baseSample.campaign, id: 'c-closed', slug: 'closed-one', title: 'A closed sample pledge', status: 'closed' };
const SWEEP_DATA = sampleData({ [baseSample.campaign.id]: baseSample.campaign, [CLOSED.id]: CLOSED });
const SWEEP_PAGE = {
  id: 'page-sweep', slug: 'home', title: 'Every module', description: '',
  modules: [
    ...baseSample.page.modules,
    ...TONE_NAMES.flatMap((tone) => [
      { id: `text-${tone}`, kind: 'text', props: { title: `Text on ${tone}`, body: 'Words with [a link](/plan), **bold** and `code`.\n\n> A quote in the text.\n\n## A heading in the text', cta: { label: 'A button', href: '/plan' }, tone } },
      { id: `band-${tone}`, kind: 'band', props: { title: 'When we organize,', highlight: 'we win', cta: { label: 'Join us', href: '/#m-join' }, tone } },
      { id: `quote-${tone}`, kind: 'quote', props: { quote: 'A sample quote on this background.', name: 'Sam Example', role: 'Volunteer', photo: { url: '', alt: '' }, tone } },
      { id: `letter-${tone}`, kind: 'newsletter', props: { title: 'The newsletter', intro: 'News and events.', askPhone: true, buttonLabel: 'Sign up', tone } },
      { id: `pledge-${tone}`, kind: 'petition', props: { campaign: baseSample.campaign.id, eyebrow: 'Pledge', tone } },
      { id: `closed-${tone}`, kind: 'petition', props: { campaign: CLOSED.id, eyebrow: '', tone } },
      { id: `gone-${tone}`, kind: 'petition', props: { campaign: 'c-gone', eyebrow: '', tone } },
      { id: `help-${tone}`, kind: 'volunteer', props: { title: 'Volunteer', intro: 'Tell us how you would like to help.', roles: ['Doorknocking', 'Phoning'], askAvailability: true, tone } },
    ]),
  ],
};

// Under a client's path on a shared domain (BASE_PATH, server/lib/mount.js):
// /imaginesurrey/base/… is the Base sample with the client's path taken off
// on the way in and put back in front of href, src, action and redirects on
// the way out — as the real server does.
const BASE = '/imaginesurrey';
const rw = rewriters(BASE);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  const based = url.pathname.startsWith(`${BASE}/`);
  if (based) url.pathname = url.pathname.slice(BASE.length);
  const send = (status, type, body, headers = {}) => {
    let out = body;
    let h = headers;
    if (based && h.location) h = { ...h, location: rw.location(h.location) };
    if (based && /text\/html/.test(type)) out = rw.html(String(body));
    if (based && /text\/css/.test(type)) out = rw.css(String(body));
    res.writeHead(status, { 'content-type': type, ...h });
    res.end(out);
  };
  if (url.pathname === '/__posted') return send(200, 'application/json', JSON.stringify(posted));
  if (url.pathname === '/checkout-stub') return send(200, 'text/html; charset=utf-8', `<!doctype html><title>Checkout</title><h1>Checkout (stub) ${url.searchParams.get('kind')} ${url.searchParams.get('amount')}</h1>`);
  const media = /^\/media\/([a-z-]+)$/.exec(url.pathname);
  if (media && IMAGES[media[1]]) {
    const file = new URL(`./apps/web/public/images/${IMAGES[media[1]]}`, import.meta.url);
    return send(200, media[1] === 'is-logo' ? 'image/webp' : 'image/jpeg', readFileSync(file), { 'cache-control': 'max-age=3600' });
  }
  // The sweep: /sweep/<n>/ (every module) and /sweep/<n>/act (the campaign page) in THEMES[n].
  const sw = /^\/sweep\/(\d+)(\/.*)?$/.exec(url.pathname);
  if (sw && THEMES[Number(sw[1])]) {
    const root = `/sweep/${sw[1]}/`;
    const rest = sw[2] || '/';
    if (rest.startsWith('/site-assets/')) {
      const a = readSiteAsset(rest.slice('/site-assets/'.length) + url.search);
      return a ? send(200, a.type, a.body, { 'cache-control': a.cache }) : send(404, 'text/plain', 'no such file');
    }
    const site = { ...baseSample.site, theme: THEMES[Number(sw[1])].theme };
    const sent = url.searchParams.get('sent') || undefined;
    const error = url.searchParams.get('error') || undefined;
    const ctx = { root, path: rest, origin: ORIGIN, islands: true, sent, error, preview: url.searchParams.has('preview') };
    const r = rest === '/act'
      ? renderSite({ kind: 'campaign', site, campaign: baseSample.campaign, data: SWEEP_DATA, ctx })
      : renderSite({ kind: 'page', site, page: SWEEP_PAGE, data: SWEEP_DATA, ctx: { ...ctx, path: '/' } });
    return send(r.status, 'text/html; charset=utf-8', r.html);
  }
  const m = /^\/(is|base)(\/.*)?$/.exec(url.pathname);
  if (!m) return send(404, 'text/plain', 'not found');
  const key = m[1];
  const sample = SITES[key];
  const root = `/${key}/`;
  const rest = (m[2] || '/');
  if (rest.startsWith('/site-assets/')) {
    const a = readSiteAsset(rest.slice('/site-assets/'.length) + url.search);
    return a ? send(200, a.type, a.body, { 'cache-control': a.cache }) : send(404, 'text/plain', 'no such file');
  }
  const form = /^\/api\/forms\/([a-z]+)$/.exec(rest);
  if (form && req.method === 'POST') {
    const raw = await readBody(req);
    const json = /json/.test(req.headers['content-type'] || '');
    let body;
    if (json) body = JSON.parse(raw || '{}');
    else {
      const p = new URLSearchParams(raw);
      body = {};
      for (const k of new Set(p.keys())) { const all = p.getAll(k); body[k] = all.length > 1 ? all : all[0]; }
    }
    posted.push({ site: key, kind: form[1], json, body, path: req.url });
    const a = answerForm(form[1], body);
    if (json) return send(a.ok ? 200 : 400, 'application/json', JSON.stringify(a));
    // A plain form post: back to the page, or on to the checkout.
    if (a.checkout_url) return send(303, 'text/plain', '', { location: a.checkout_url });
    const back = new URL(req.headers.referer || `${ORIGIN}${root}`);
    const q = a.ok ? `sent=${form[1]}` : `error=${a.field}`;
    return send(303, 'text/plain', '', { location: `${back.pathname}?${q}#m-${body.module_id || ''}` });
  }
  // Under the client's path the server here doesn't say its address: the
  // browser works out share links from the page's own.
  const ctx = { root, path: rest, origin: based ? undefined : ORIGIN, islands: true, sent: url.searchParams.get('sent') || undefined, error: url.searchParams.get('error') || undefined };
  let r;
  if (rest === '/' || rest === '/__preview') r = renderSite({ kind: 'page', site: sample.site, page: sample.page, data: sample.data, ctx: { ...ctx, preview: rest === '/__preview', path: '/' } });
  else if (rest === `/act/${sample.campaign.slug}`) r = renderSite({ kind: 'campaign', site: sample.site, campaign: sample.campaign, data: sample.data, ctx });
  else if (rest === `/news/${samplePost.slug}`) r = renderSite({ kind: 'post', site: sample.site, post: samplePost, data: sample.data, ctx });
  else r = renderSite({ kind: 'notFound', site: sample.site, data: sample.data, ctx });
  return send(r.status, 'text/html; charset=utf-8', r.html);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

// ── The browser ──
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const errors = [];
async function newPage({ width = 1360, height = 900, js = true, reducedMotion = 'no-preference', mobile = false } = {}) {
  const ctx = await browser.newContext({
    viewport: { width, height }, javaScriptEnabled: js, reducedMotion, timezoneId: 'America/Vancouver',
    isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1,
  });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
  // Nothing leaves the machine (a video's player, say).
  await ctx.route('**/*', (route) => (route.request().url().startsWith(ORIGIN) ? route.continue() : route.abort()));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${page.url()}: ${e.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/Failed to load resource|ERR_FAILED|net::/.test(msg.text())) errors.push(`${page.url()}: ${msg.text()}`);
  });
  return page;
}
const hydrated = (page) => page.waitForFunction(() => window.__siteIslands && document.documentElement.classList.contains('js'), null, { timeout: 15000 });
// Effects have run (an island marks its form novalidate once it is live).
const live = (page, sel = 'form.site-form') => page.waitForFunction((s) => [...document.querySelectorAll(s)].every((f) => f.noValidate), sel, { timeout: 15000 });
const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });

// The layout checks, run in the page.
const audit = (page) => page.evaluate(() => {
  const out = { overflow: document.documentElement.scrollWidth - window.innerWidth, small: [], contrast: [], dupes: [], unlabelled: [] };
  // Every id once; every field with a label.
  const seen = new Set();
  for (const el of document.querySelectorAll('[id]')) { if (seen.has(el.id)) out.dupes.push(el.id); seen.add(el.id); }
  for (const el of document.querySelectorAll('input:not([type=hidden]), select, textarea')) {
    if (el.closest('.hp')) continue;
    if (!(el.labels && el.labels.length) && !el.getAttribute('aria-label')) out.unlabelled.push(el.name || el.id);
  }
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    for (let e = el; e; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
      if (e.classList?.contains('visually-hidden') || e.classList?.contains('hp')) return false;
    }
    return true;
  };
  // Tap targets: buttons, fields and links that stand alone.
  const TARGETS = 'a.btn, button, summary, input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea, .nav-link, .text-link, .share-sheet__link, .amount, .toggle-option, label.check, .social, .footer-links a, .footer-contact, .footer-legal a, .event-where a, .logo-link';
  for (const el of document.querySelectorAll(TARGETS)) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.height < 47.5) out.small.push(`${el.tagName.toLowerCase()}.${[...el.classList].join('.')} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30)}" ${Math.round(r.width)}×${Math.round(r.height)}`);
  }
  // Contrast: each piece of text against what is behind it.
  const parse = (c) => {
    let m = /^rgba?\(([^)]+)\)$/.exec(c);
    if (m) { const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] ?? 1]; }
    m = /^color\(srgb ([^)]+)\)$/.exec(c);
    if (m) { const p = m[1].split(/[\s/]+/).filter(Boolean).map(Number); return [p[0] * 255, p[1] * 255, p[2] * 255, p[3] ?? 1]; }
    return null;
  };
  const blend = (top, bottom) => [0, 1, 2].map((i) => top[i] * top[3] + bottom[i] * (1 - top[3])).concat(1);
  const lum = (c) => {
    const f = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  const background = (el) => {
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.backgroundImage && s.backgroundImage !== 'none') return null; // text over a picture: not measured
      const c = parse(s.backgroundColor);
      if (c && c[3] > 0) { layers.push(c); if (c[3] >= 1) break; }
    }
    let bg = [255, 255, 255, 1];
    for (const l of layers.reverse()) bg = blend(l, bg);
    return bg;
  };
  for (const el of document.querySelectorAll('body *')) {
    if (['SCRIPT', 'STYLE', 'OPTION', 'svg', 'path', 'IMG', 'IFRAME', 'PROGRESS'].includes(el.tagName)) continue;
    const text = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
    if (!text || !visible(el)) continue;
    const s = getComputedStyle(el);
    const fg = parse(s.color);
    const bg = background(el);
    if (!fg || !bg) continue;
    const size = parseFloat(s.fontSize);
    const bold = Number(s.fontWeight) >= 700;
    const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
    const r = ratio(fg[3] < 1 ? blend(fg, bg) : fg, bg);
    if (r < need) out.contrast.push(`"${text.slice(0, 40)}" ${r.toFixed(2)} < ${need} (${s.color} on ${bg.map(Math.round).join(',')})`);
  }
  return out;
});

// ── Both skins, desktop and phone ──
for (const key of ['is', 'base']) {
  for (const [label, vp] of [['desktop', { width: 1360, height: 900 }], ['phone', { width: 390, height: 844, mobile: true }]]) {
    const page = await newPage(vp);
    const res = await page.goto(`${ORIGIN}/${key}/`, { waitUntil: 'networkidle' });
    check(`${key} ${label}: home answers 200`, res.status() === 200, res.status());
    await hydrated(page);
    await live(page);
    const n = await page.evaluate(() => window.__siteIslands.hydrated);
    const expected = await page.locator('[data-island]').count();
    check(`${key} ${label}: every island hydrated (${n})`, n === expected && n > 3, `${n} of ${expected}`);
    // Let lazy pictures load before the screenshot.
    await page.evaluate(async () => { for (const img of document.images) img.loading = 'eager'; await Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((r) => { i.onload = r; i.onerror = r; })))); });
    await sleep(300);
    const a = await audit(page);
    check(`${key} ${label}: nothing scrolls sideways`, a.overflow <= 0, a.overflow);
    check(`${key} ${label}: tap targets at least 48px`, a.small.length === 0, a.small.slice(0, 6).join(' | '));
    check(`${key} ${label}: text contrast at least AA`, a.contrast.length === 0, a.contrast.slice(0, 6).join(' | '));
    check(`${key} ${label}: every id once, every field labelled`, a.dupes.length === 0 && a.unlabelled.length === 0, `${a.dupes.slice(0, 5)} ${a.unlabelled.slice(0, 5)}`);
    await shot(page, `${key}-home-${label}`);
    if (label === 'phone') {
      // The Menu open on a phone: the title-bar links move into it.
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.locator('.menu > summary').click();
      const a2 = await audit(page);
      check(`${key} phone: the open Menu fits and every link is a 48px target`, a2.overflow <= 0 && a2.small.length === 0, `${a2.overflow} ${a2.small.slice(0, 3)}`);
      await page.screenshot({ path: `${SHOTS}/${key}-menu-open-phone.png` });
    }
    await page.context().close();
  }
}

// ── Imagine Surrey: the look of imaginesurrey.ca ──
{
  const page = await newPage();
  await page.goto(`${ORIGIN}/is/`, { waitUntil: 'networkidle' });
  await hydrated(page);
  const look = await page.evaluate(() => {
    const cs = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el) : null; };
    return {
      hero: cs('[data-module="hero"]')?.backgroundColor,
      heroTitle: cs('.hero-title')?.color,
      word: cs('.hero-word')?.color,
      donate: cs('.nav-cta')?.backgroundColor,
      font: cs('.display')?.fontFamily,
      weight: cs('[data-module="columns"] .display')?.fontWeight,
      shadow: cs('[data-module="columns"] .display')?.textShadow,
      band: cs('[data-module="band"]')?.backgroundColor,
      footer: cs('.site-footer')?.backgroundColor,
      primary: cs('[data-module="hero"] .btn--primary')?.backgroundColor,
      fontsReady: document.fonts.check('900 40px Montserrat'),
    };
  });
  check('IS: navy hero (#003979) with white headline and a yellow word', look.hero === 'rgb(0, 57, 121)' && look.heroTitle === 'rgb(255, 255, 255)' && look.word === 'rgb(255, 241, 0)', JSON.stringify(look));
  check('IS: red Donate button in the header (#d81b1e)', look.donate === 'rgb(216, 27, 30)', look.donate);
  check('IS: yellow primary button on the hero', look.primary === 'rgb(255, 241, 0)', look.primary);
  check('IS: Montserrat 900 headings with the layered red shadow', /Montserrat/.test(look.font) && look.weight === '900' && /rgb\(216, 27, 30\)/.test(look.shadow) && look.fontsReady, `${look.font} ${look.weight} ${String(look.shadow).slice(0, 60)}`);
  check('IS: yellow organize band, deep-navy footer', look.band === 'rgb(255, 241, 0)' && /rgb\(0, 4[01], 8[6-9]\)/.test(look.footer), `${look.band} ${look.footer}`);

  // Rotating words: they move, and stop when paused.
  const word = () => page.locator('.hero-word').innerText();
  const w1 = await word();
  await page.waitForFunction((w) => document.querySelector('.hero-word')?.textContent !== w, w1, { timeout: 6000 }).catch(() => {});
  const w2 = await word();
  check('hero: the word after the headline changes', w1 !== w2, `${w1} → ${w2}`);
  await page.getByRole('button', { name: 'Pause the rotating words' }).click();
  const paused = await word();
  await sleep(3200);
  check('hero: the pause button stops it (aria-pressed)', (await word()) === paused && (await page.getByRole('button', { name: 'Pause the rotating words' }).getAttribute('aria-pressed')) === 'true');

  // The Menu: opens, Escape closes it and puts focus back on the button.
  const summary = page.locator('.menu > summary');
  await summary.click();
  check('menu: opens and lists the pages', await page.locator('.menu-panel').isVisible() && (await page.locator('.menu-panel a').count()) === 6);
  await page.screenshot({ path: `${SHOTS}/is-menu-open-desktop.png`, clip: { x: 0, y: 0, width: 1360, height: 560 } });
  await page.keyboard.press('Escape');
  await sleep(150);
  check('menu: Escape closes it, focus back on Menu', !(await page.locator('.menu-panel').isVisible()) && (await page.evaluate(() => document.activeElement?.matches('.menu > summary'))));

  // The petition: field errors tied to the fields, then signed, then shared.
  const pet = page.locator('[data-module="petition"] form');
  await pet.getByRole('button', { name: 'Add my name' }).click();
  const errFirst = pet.locator('#skytrain-form-first_name');
  const described = await errFirst.getAttribute('aria-describedby');
  check('petition: an empty form says what is missing, next to each field', (await errFirst.getAttribute('aria-invalid')) === 'true' && described && (await page.locator(`#${described}`).innerText()).includes('Enter your first name'), described);
  check('petition: focus goes to the first field to fix', await page.evaluate(() => document.activeElement?.id === 'skytrain-form-first_name'));
  check('petition: the form-level alert counts the fields', /Please check the \d+ highlighted fields/.test(await pet.locator('.form-alert').innerText()));
  await pet.getByLabel('First name', { exact: true }).fill('Ada');
  await pet.getByLabel('Last name', { exact: true }).fill('Example');
  await pet.getByLabel('Email', { exact: true }).fill('ada.bounce@example.org');
  await pet.getByLabel('Postal code', { exact: true }).fill('V3T 1A1');
  await pet.getByRole('button', { name: 'Add my name' }).click();
  await page.locator('#skytrain-form-email-error').waitFor({ timeout: 8000 });
  check('petition: the server’s answer shows on its field', /bounced/.test(await page.locator('#skytrain-form-email-error').innerText()));
  await pet.getByLabel('Email', { exact: true }).fill('ada@example.org');
  await pet.locator('label.check', { hasText: 'can email me' }).locator('input').check();
  await pet.getByRole('button', { name: 'Add my name' }).click();
  const thanks = page.locator('[data-module="petition"] .success-card');
  await thanks.waitFor({ timeout: 8000 });
  check('petition: thank-you in place of the form, focused', /Your name is on the petition/.test(await thanks.innerText()) && (await page.evaluate(() => document.activeElement?.classList.contains('success-card'))));
  await thanks.screenshot({ path: `${SHOTS}/is-petition-thanks.png` });
  const sent = (await (await fetch(`${ORIGIN}/__posted`)).json()).filter((p) => p.kind === 'petition' && p.json);
  const last = sent[sent.length - 1]?.body || {};
  const keys = Object.keys(last).sort().join(',');
  check('petition: JSON with SITE.md’s field names', keys === 'campaign,client_key,comment,consent_email,consent_sms,email,first_name,last_name,module_id,page_id,phone,postal_code,website', keys);
  check('petition: consent as booleans, campaign and ids carried, one key per form', last.consent_email === true && last.consent_sms === false && last.campaign === 'c-skytrain' && last.module_id === 'skytrain' && last.page_id === 'page-home' && /^[\w-]{8,64}$/.test(last.client_key) && sent[0].body.client_key === last.client_key, JSON.stringify(last).slice(0, 200));
  const shareLinks = await thanks.locator('.share-sheet__link').evaluateAll((els) => els.map((e) => ({ label: e.querySelector('span:not(.visually-hidden)')?.textContent.trim(), href: e.getAttribute('href') || '' })));
  check('share: WhatsApp first, then text, Facebook, X, email, copy', shareLinks.map((s) => s.label).join(',') === 'WhatsApp,Text,Facebook,X,Email,Copy link', shareLinks.map((s) => s.label).join(','));
  check('share: each link tagged ?source=share-<channel>, the petition’s own page', ['whatsapp', 'sms', 'facebook', 'x', 'email'].every((c, i) => decodeURIComponent(shareLinks[i].href).includes(`/is/act/skytrain-south-surrey?source=share-${c}`)) && shareLinks[0].href.startsWith('https://wa.me/') && shareLinks[1].href.startsWith('sms:'), shareLinks[0].href);
  await thanks.getByRole('button', { name: 'Copy link' }).click();
  await sleep(200);
  const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
  check('share: Copy link copies the link (tagged share-copy) and says so', clip === `${ORIGIN}/is/act/skytrain-south-surrey?source=share-copy` && /Link copied/.test(await thanks.locator('.share-sheet__status').innerText()), clip);

  // Donate: amounts within the limit, monthly within a twelfth of it, then checkout.
  const don = page.locator('[data-module="donate"] form');
  const amounts = async () => don.locator('.amount span').allInnerTexts();
  check('donate: the suggested amounts, none above the limit', (await amounts()).join(' ') === '$25 $50 $100 $250', (await amounts()).join(' '));
  check('donate: $50 picked to start, the button says so', (await don.locator('.amount input:checked').getAttribute('value')) === '5000' && /Donate \$50$/.test((await don.locator('button[type=submit]').innerText()).trim()));
  await don.locator('.toggle-option', { hasText: 'Monthly' }).click();
  check('donate: monthly drops $250 (over a twelfth of the limit) and shows the monthly note', (await amounts()).join(' ') === '$25 $50 $100' && /Imagine Victory Fund/.test(await don.innerText()));
  check('donate: monthly button reads “a month”', /Donate \$50 a month$/.test((await don.locator('button[type=submit]').innerText()).trim()));
  await don.screenshot({ path: `${SHOTS}/is-donate-monthly.png` });
  await don.getByLabel('Other amount', { exact: true }).fill('500');
  await don.getByRole('button', { name: /Donate/ }).click();
  check('donate: an amount over the monthly limit is refused with the limit', /The most you can give is \$119 a month/.test(await don.locator('#donate-form-amount-error').innerText().catch(() => '')));
  await don.locator('.toggle-option', { hasText: 'Once' }).click();
  await don.getByLabel('Other amount', { exact: true }).fill('');
  await don.locator('.amount', { hasText: '$100' }).click();
  await don.getByLabel('First name', { exact: true }).fill('Ada');
  await don.getByLabel('Last name', { exact: true }).fill('Example');
  await don.getByLabel('Email', { exact: true }).fill('ada@example.org');
  await don.getByLabel('Street address', { exact: true }).fill('10250 140 St');
  await don.getByLabel('City', { exact: true }).fill('Surrey');
  await don.getByLabel('Postal code', { exact: true }).fill('V3T 4B2');
  await don.locator('label.check', { hasText: 'Canadian citizen' }).locator('input').check();
  await Promise.all([page.waitForURL(/checkout-stub/, { timeout: 10000 }), don.getByRole('button', { name: /Donate \$100/ }).click()]);
  check('donate: goes to the checkout with the amount', /kind=donate&amount=10000/.test(page.url()), page.url());
  const gift = (await (await fetch(`${ORIGIN}/__posted`)).json()).filter((p) => p.kind === 'donate').pop()?.body || {};
  check('donate: amount_cents, cadence and the declaration sent', gift.amount_cents === 10000 && gift.cadence === 'once' && gift.declaration === true && gift.address === '10250 140 St', JSON.stringify(gift).slice(0, 200));
  await page.context().close();
}

// Reduced motion: the words stand still and there is nothing to pause.
{
  const page = await newPage({ reducedMotion: 'reduce' });
  await page.goto(`${ORIGIN}/is/`, { waitUntil: 'networkidle' });
  await hydrated(page);
  await sleep(300);
  const w1 = await page.locator('.hero-word').innerText();
  await sleep(3000);
  check('reduced motion: the word stays, no pause button', (await page.locator('.hero-word').innerText()) === w1 && (await page.locator('.rotate-toggle').count()) === 0);
  await page.context().close();
}

// ── Base: newsletter, one-tap volunteer sign-ups, payments not set up ──
{
  const page = await newPage();
  await page.goto(`${ORIGIN}/base/`, { waitUntil: 'networkidle' });
  await hydrated(page);
  await live(page);
  const nl = page.locator('[data-module="newsletter"] form');
  await nl.getByRole('button', { name: 'Sign up' }).click();
  check('newsletter: no email → said next to the field', /Enter your email address/.test(await nl.locator('#newsletter-form-email-error').innerText()) && (await nl.getByLabel('Email', { exact: true }).getAttribute('aria-invalid')) === 'true');
  await nl.getByLabel('Email', { exact: true }).fill('sam@example.org');
  await nl.locator('label.check', { hasText: 'can text me' }).locator('input').check();
  await nl.getByRole('button', { name: 'Sign up' }).click();
  check('newsletter: texts ticked without a number → asks for one', /Add a mobile number/.test(await nl.locator('#newsletter-form-phone-error').innerText()));
  await nl.getByLabel('Mobile number').fill('604-555-0142');
  await nl.getByRole('button', { name: 'Sign up' }).click();
  await page.locator('[data-module="newsletter"] .success-card').waitFor({ timeout: 8000 });
  const nlBody = (await (await fetch(`${ORIGIN}/__posted`)).json()).filter((p) => p.kind === 'newsletter' && p.json).pop()?.body || {};
  check('newsletter: sent with consent_email true and consent_sms true', nlBody.consent_email === true && nlBody.consent_sms === true && nlBody.email === 'sam@example.org' && nlBody.phone === '604-555-0142', JSON.stringify(nlBody).slice(0, 200));

  // Volunteer openings: the first sign-up asks who, the next is one tap.
  const list = page.locator('[data-module="shifts"]');
  const card1 = list.locator('.opening-card', { hasText: 'volunteer orientation' });
  await card1.getByText('Sign up', { exact: false }).first().click();
  const f = card1.locator('form');
  check('openings: Sign up opens a short form', await f.isVisible());
  await f.getByLabel('First name', { exact: true }).fill('Sam');
  await f.getByLabel('Email', { exact: true }).fill('sam@example.org');
  await f.getByRole('button', { name: 'I’ll be there' }).click();
  await card1.locator('.rsvp-done').waitFor({ timeout: 8000 });
  const card2 = list.locator('.opening-card', { hasText: 'phone bank' });
  check('openings: the next one offers one tap', /Sign me up/.test(await card2.locator('summary').innerText()));
  await card2.locator('summary').click();
  await card2.locator('.rsvp-done').waitFor({ timeout: 8000 });
  const rsvps = (await (await fetch(`${ORIGIN}/__posted`)).json()).filter((p) => p.kind === 'rsvp').map((p) => p.body);
  check('openings: two RSVPs, each with its shift_id, the second with the same person', rsvps.length === 2 && rsvps[0].shift_id === 'shift-1' && rsvps[1].shift_id === 'shift-2' && rsvps[1].email === 'sam@example.org' && rsvps[1].first_name === 'Sam', JSON.stringify(rsvps).slice(0, 300));
  check('openings: a full shift says so, with no sign-up', /This one is full/.test(await list.locator('.opening-card', { hasText: 'doorknocking' }).innerText()));
  await list.screenshot({ path: `${SHOTS}/base-openings-signed-up.png` });
  await page.context().close();
}

// ── Without JavaScript the same forms post and come back ──
// (Playwright's "is it still moving?" check runs in the page's script, so
// with JavaScript off its clicks are forced.)
{
  const page = await newPage({ js: false });
  await page.goto(`${ORIGIN}/base/`, { waitUntil: 'domcontentloaded' });
  const nl = page.locator('[data-module="newsletter"] form');
  check('no JS: the island script isn’t needed — form is a real POST', (await nl.getAttribute('method')) === 'post' && (await nl.getAttribute('action')) === '/base/api/forms/newsletter');
  check('no JS: “Other amount” and “Copy link” stay hidden', !(await page.locator('[data-module="donate"] .other-amount').isVisible()));
  await nl.getByLabel('Email', { exact: true }).fill('bounce@example.org');
  await Promise.all([page.waitForURL(/error=email/), nl.getByRole('button', { name: 'Sign up' }).click({ force: true })]);
  check('no JS: a refused email comes back with the error on its field', /Enter your email address/.test(await page.locator('[data-module="newsletter"] .field-error').innerText().catch(() => '')) && /#m-newsletter$/.test(page.url()), page.url());
  await page.locator('[data-module="newsletter"] form').getByLabel('Email', { exact: true }).fill('lena@example.org');
  await Promise.all([page.waitForURL(/sent=newsletter/), page.locator('[data-module="newsletter"] form').getByRole('button', { name: 'Sign up' }).click({ force: true })]);
  check('no JS: sent → the thank-you in place of the form', /You’re on the list/.test(await page.locator('[data-module="newsletter"]').innerText()));
  const plain = (await (await fetch(`${ORIGIN}/__posted`)).json()).filter((p) => p.kind === 'newsletter' && !p.json).pop()?.body || {};
  check('no JS: form-encoded with the same names (consent_email=true)', plain.consent_email === 'true' && plain.email === 'lena@example.org' && plain.module_id === 'newsletter' && plain.page_id === 'page-base-home' && plain.website === '', JSON.stringify(plain));
  // Menu and the RSVP form open as <details>.
  await page.locator('.menu > summary').click({ force: true });
  check('no JS: the Menu still opens', await page.locator('.menu-panel').isVisible());
  await page.context().close();
}

// ── The other templates ──
for (const key of ['is', 'base']) {
  const sample = SITES[key];
  for (const [label, vp] of [['desktop', { width: 1360, height: 900 }], ['phone', { width: 390, height: 844, mobile: true }]]) {
    const page = await newPage(vp);
    let res = await page.goto(`${ORIGIN}/${key}/act/${sample.campaign.slug}`, { waitUntil: 'networkidle' });
    await hydrated(page);
    const a = await audit(page);
    check(`${key} ${label}: campaign page — 200, form, goal bar, share row, layout`, res.status() === 200 && (await page.locator('#m-campaign form.site-form').count()) === 1 && (await page.locator('progress.goal-bar').count()) === 1 && (await page.locator('#m-campaign .share-sheet').count()) === 1 && a.overflow <= 0 && a.small.length === 0 && a.contrast.length === 0, `${a.overflow} ${a.small.slice(0, 3)} ${a.contrast.slice(0, 3)}`);
    await shot(page, `${key}-campaign-${label}`);
    res = await page.goto(`${ORIGIN}/${key}/news/${samplePost.slug}`, { waitUntil: 'networkidle' });
    const b = await audit(page);
    check(`${key} ${label}: news post — 200, article, share, layout`, res.status() === 200 && (await page.locator('article.post .prose h2').count()) === 1 && (await page.locator('article.post .share-sheet').count()) === 1 && b.overflow <= 0 && b.small.length === 0 && b.contrast.length === 0, `${b.overflow} ${b.small.slice(0, 3)} ${b.contrast.slice(0, 3)}`);
    if (label === 'phone') await shot(page, `${key}-post-${label}`);
    await page.context().close();
  }
  const page = await newPage();
  const res = await page.goto(`${ORIGIN}/${key}/no-such-page`, { waitUntil: 'networkidle' });
  check(`${key}: not found — 404, noindex, links home`, res.status() === 404 && (await page.locator('meta[name=robots][content=noindex]').count()) === 1 && (await page.locator('.not-found a', { hasText: 'Home page' }).getAttribute('href')) === `/${key}/`);
  await page.goto(`${ORIGIN}/${key}/__preview`, { waitUntil: 'networkidle' });
  check(`${key}: preview — banner and noindex`, (await page.locator('.preview-banner').isVisible()) && (await page.locator('meta[name=robots][content=noindex]').count()) === 1);
  await page.context().close();
}

// ── Under a client's path (base.win/imaginesurrey/…): every link, post and
// share keeps the client's path ──
{
  const page = await newPage();
  await page.goto(`${ORIGIN}${BASE}/base/`, { waitUntil: 'networkidle' });
  await hydrated(page);
  await live(page);
  const paths = await page.evaluate(() => ({
    donate: document.querySelector('.nav-cta')?.getAttribute('href'),
    action: document.querySelector('[data-module="newsletter"] form')?.getAttribute('action'),
    css: [...document.styleSheets].map((s) => s.href || '').find((h) => h.includes('site.css')),
    script: document.querySelector('script[type=module]')?.getAttribute('src'),
  }));
  check('client path: links, form actions, the stylesheet and the script carry it', paths.donate === `${BASE}/base/donate` && paths.action === `${BASE}/base/api/forms/newsletter` && paths.css?.includes(`${BASE}/base/site-assets/site.css`) && paths.script?.startsWith(`${BASE}/base/site-assets/site-islands.js`), JSON.stringify(paths));
  const list = page.locator('[data-module="shifts"]');
  const card1 = list.locator('.opening-card', { hasText: 'volunteer orientation' });
  await card1.locator('summary').click();
  await card1.getByLabel('First name', { exact: true }).fill('Lena');
  await card1.getByLabel('Email', { exact: true }).fill('lena@example.org');
  await card1.getByRole('button', { name: 'I’ll be there' }).click();
  await card1.locator('.rsvp-done').waitFor({ timeout: 8000 });
  const card2 = list.locator('.opening-card', { hasText: 'phone bank' });
  await card2.locator('summary').click();
  await card2.locator('.rsvp-done').waitFor({ timeout: 8000 });
  const rsvpPaths = (await (await fetch(`${ORIGIN}/__posted`)).json()).filter((p) => p.kind === 'rsvp').slice(-2).map((p) => p.path);
  check('client path: the sign-up and the one-tap sign-up post under it', rsvpPaths.length === 2 && rsvpPaths.every((p) => p === `${BASE}/base/api/forms/rsvp`), rsvpPaths.join(' '));
  const pledge = page.locator('[data-module="petition"] form');
  await pledge.getByLabel('First name', { exact: true }).fill('Lena');
  await pledge.getByLabel('Last name', { exact: true }).fill('Example');
  await pledge.getByLabel('Email', { exact: true }).fill('lena@example.org');
  await pledge.getByLabel('Postal code', { exact: true }).fill('V3T 1A1');
  await pledge.getByRole('button', { name: 'Sign the pledge' }).click();
  const thanks = page.locator('[data-module="petition"] .success-card');
  await thanks.waitFor({ timeout: 8000 });
  const wa = await thanks.locator('.share-sheet__link--whatsapp').getAttribute('href');
  check('client path: share links point at the pledge’s page under it', decodeURIComponent(wa).includes(`${ORIGIN}${BASE}/base/act/keep-the-pool-open?source=share-whatsapp`), decodeURIComponent(wa));
  await page.context().close();
}

// ── SEO and keyboard ──
{
  const page = await newPage();
  await page.goto(`${ORIGIN}/is/`, { waitUntil: 'networkidle' });
  const meta = await page.evaluate(() => ({
    title: document.title,
    desc: document.querySelector('meta[name=description]')?.content,
    og: document.querySelector('meta[property="og:image"]')?.content,
    canon: document.querySelector('link[rel=canonical]')?.href,
    h1: document.querySelectorAll('h1').length,
  }));
  check('SEO: title, description, canonical, Open Graph picture, one h1', meta.title === 'Imagine Surrey' && /basics right/.test(meta.desc) && meta.canon === `${ORIGIN}/is/` && meta.og === `${ORIGIN}/media/members-rally` && meta.h1 === 1, JSON.stringify(meta));
  await page.keyboard.press('Tab');
  check('keyboard: the first Tab is “Skip to content”', await page.evaluate(() => document.activeElement?.classList.contains('skip-link') && getComputedStyle(document.activeElement).top !== '-80px'));
  await page.keyboard.press('Enter');
  check('keyboard: skipping lands on the main content', await page.evaluate(() => location.hash === '#main'));
  await page.context().close();
}

// ── The theme sweep (THEMES, above): whatever an admin can save reads ──
{
  const page = await newPage();
  const swept = [];
  const refused = [];
  const failures = [];
  for (const [i, t] of THEMES.entries()) {
    if (checkTheme(t.theme).problems.length) { refused.push(t.name); continue; }
    for (const path of ['/?error=email&preview', '/?sent=rsvp', '/act']) {
      await page.goto(`${ORIGIN}/sweep/${i}${path}`, { waitUntil: 'domcontentloaded' });
      await hydrated(page).catch(() => {});
      const a = await audit(page);
      if (a.contrast.length) failures.push(`${t.name} ${path}: ${a.contrast.slice(0, 5).join(' | ')}${a.contrast.length > 5 ? ` (+${a.contrast.length - 5} more)` : ''}`);
    }
    swept.push(t.name);
  }
  console.log(`      swept ${swept.length} themes; the check refused: ${refused.join(', ') || 'none'}`);
  for (const f of failures) console.log(`      ${f}`);
  check(`theme sweep: in ${swept.length} themes the check lets through, every piece of text on every module, tone, form state and the campaign page reads at AA`, swept.length >= 12 && failures.length === 0, failures.slice(0, 3).join(' || '));
  await page.context().close();
}

check('no page errors, no hydration mismatches', errors.length === 0, errors.slice(0, 5).join(' | '));
await browser.close();
server.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
