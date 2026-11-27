// Google fonts for the website (WA stage 1; SITE.md "Fonts"), in a browser.
//
// base.win runs in this process on PORT (5490), with a stand-in Google Fonts
// on PORT+1 (server/test/fake-google-fonts.js) and a stand-in Google
// Translation on PORT+2 (for /pa and /zh). Every request the browser makes is
// recorded: none may leave 127.0.0.1. A manager opens Website → Theme (the
// Fonts card drawn in its own face), picks the Fraunces / Inter pairing and
// saves (the public heading is Fraunces, loaded), gets Fake Display from
// "Google" for headings (its file served by the site, immutable, CSP still
// font-src 'self'), sees body text limited to fonts checked for reading (the
// server refuses a heading-only one), sees Google failing (500, a stall: the
// words within 10 s, the site unchanged) and a file too large. Each of the
// 12 pairings: a phone's first visit downloads at most 150 KB of fonts, the
// Authorized-by line stays visible in the body face, not in capitals, and
// body text is 17 px. /pa draws Gurmukhi with Fake Display headings, nothing
// 404s; /zh headings carry the Chinese faces. A font in use can't be
// removed; an unused one can, and Undo brings it back. Settings → Brand
// takes Fraunces, then Fake Display, both drawn on the desk. On a phone the
// sheet is full screen, rows 48 px or more, no sideways scroll. Screens are
// saved at 1440×900 and 390×844 under SHOTS.
//
//   (cd web && npm run build)
//   PORT=5490 SHOTS=/tmp/site-fonts node e2e-site-fonts.mjs
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

// The fixtures here are Imagine Surrey's, so the server runs as its production
// does (render.yaml sets this brand); a brand set by hand is left as set.
if (process.env.STARBASE_BRAND === undefined) process.env.STARBASE_BRAND = 'imagine-surrey';

const PORT = Number(process.env.PORT) || 5490;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOTS || '/tmp/site-fonts';
mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  — ${String(extra).slice(0, 300)}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Date.now().toString(36);

for (const k of ['DATABASE_URL', 'RESEND_API_KEY', 'MAIL_FROM', 'STARBASE_PUBLIC_URL', 'BASE_PATH', 'SITE_HOSTS', 'GOOGLE_TRANSLATE_KEY']) delete process.env[k];
Object.assign(process.env, {
  STARBASE_OPEN_SIGNUP: '1', STARBASE_DATA: 'memory', GEOCODE_ON_SAVE: 'off',
  GOOGLE_FONTS_CSS_BASE: `http://127.0.0.1:${PORT + 1}`, GOOGLE_FONTS_FILE_HOSTS: `127.0.0.1:${PORT + 1}`,
  GOOGLE_TRANSLATE_API_BASE: `http://127.0.0.1:${PORT + 2}`,
});
const { startFakeGoogleFonts } = await import('./server/test/fake-google-fonts.js');
const fake = await startFakeGoogleFonts({ port: PORT + 1 });
const { startFakeTranslate } = await import('./server/test/fake-translate.js');
const fakeT = await startFakeTranslate({ port: PORT + 2 });
const { serve } = await import('@hono/node-server');
const { app } = await import('./server/index.js');
const { getDb } = await import('./server/db/client.js');
const { startJobRunner, stopJobRunner } = await import('./server/lib/jobs.js');
const { islandsBuilt } = await import('./server/ext/site/render/index.js');
const { PAIRINGS, FONT_BY_VALUE, FONT_WORDS } = await import('./shared/site/fonts.js');
const { LEGAL_ENGLISH, LEGAL_KEYS, slotsOf } = await import('./shared/site/wording.js');
if (!islandsBuilt()) { console.log('FAIL  web/dist/site-islands.js is missing: run `cd web && npm run build` first'); process.exit(1); }
const server = serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' });
const db = await getDb();
startJobRunner(db, { everyMs: 1000 });
await sleep(300);

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const finish = async (code) => {
  stopJobRunner();
  await browser.close().catch(() => {});
  server.close();
  await fake.close();
  await fakeT.close();
  process.exit(code);
};
process.on('unhandledRejection', async (e) => { console.log(`FAIL  ${e?.stack || e}`); await finish(1); });

// Every request any page makes: none may leave this machine.
const away = [];
const watch = (ctx) => ctx.on('request', (r) => { const u = new URL(r.url()); if (!['127.0.0.1', 'localhost'].includes(u.hostname) && !/^(data|blob):/.test(r.url())) away.push(r.url()); });
const desk = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, timezoneId: 'America/Vancouver' });
watch(desk);
const page = await desk.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const api = (path, body, p = page) => p.evaluate(async ([pth, b]) => {
  const r = await fetch(`/api${pth}`, b ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) } : undefined);
  return { status: r.status, json: await r.json().catch(() => null) };
}, [path, body]);
const act = (name, input, p = page) => api(`/actions/${name}`, input, p);
const go = async (path, p = page) => {
  await p.goto(`${BASE}/admin${path}`, { waitUntil: 'domcontentloaded' });
  await p.locator('h1').first().waitFor({ timeout: 15000 });
  await sleep(700);
};
const overflow = (p = page) => p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const both = async (name, p = page) => {
  const vp = p.viewportSize();
  await p.screenshot({ path: `${SHOTS}/${name}-1440.png`, fullPage: false });
  await p.setViewportSize({ width: 390, height: 844 });
  await sleep(500);
  await p.screenshot({ path: `${SHOTS}/${name}-390.png`, fullPage: false });
  await p.setViewportSize(vp);
  await sleep(300);
};
const setTheme = async (fonts) => {
  const s = (await api('/site')).json.settings;
  return act('site.settings.save', { theme: { ...s.theme, fonts } });
};
const waitFor = async (fn, ms = 60000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await fn()) return true; await sleep(500); }
  return false;
};
const sheet = () => page.locator('dialog.wb-dialog[open]');
const openSheet = async () => {
  await go('/website/theme');
  await page.getByRole('button', { name: 'Change fonts' }).click();
  await sheet().waitFor();
  await sleep(400);
};
const visitor = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
watch(visitor);
const pub = await visitor.newPage();
const headingFont = async (path = '/site/') => {
  await pub.goto(`${BASE}${path}`, { waitUntil: 'load' });
  await pub.evaluate(() => document.fonts.ready);
  return pub.evaluate(() => { const h = document.querySelector('h1, .display'); return h ? getComputedStyle(h).fontFamily : ''; });
};

try {
  // ── A manager with a website ──
  await page.goto(`${BASE}/signup`, { waitUntil: 'domcontentloaded' });
  await page.fill('#su-name', 'Rae Example');
  if (await page.locator('#su-org').count()) await page.fill('#su-org', 'Harbour City Together');
  await page.fill('#su-email', `fonts.${tag}@example.org`);
  await page.fill('#su-password', 'harbour-forward-2026');
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/admin\/?$/, { timeout: 15000 });
  await go('/website');
  const s0 = (await api('/site')).json.settings;
  await act('site.settings.save', { org: { ...s0.org, name: 'Harbour City Together', shortName: '', agentName: 'Ada Example', agentContact: '604-555-0100' } });

  // ── 1. The Fonts card draws the name in the heading face ──
  await go('/website/theme');
  const cardFace = await page.locator('.wb-fonts__h').evaluate((el) => getComputedStyle(el).fontFamily);
  const first = cardFace.split(',')[0].replace(/['"]/g, '').trim();
  check('1. the Fonts card draws the site’s name in its heading face', await page.evaluate((f) => document.fonts.check(`24px "${f}"`), first), cardFace);
  await both('theme-fonts-card');

  // ── 2. Pairings: Fraunces / Inter, its KB, the sample, saved, live ──
  await page.getByRole('button', { name: 'Change fonts' }).click();
  await sheet().waitFor();
  await sleep(600);
  await both('sheet-pairings');
  const card = sheet().locator('.fs-pair', { hasText: 'Fraunces / Inter' });
  check('2. the pairing shows what it adds', (await card.innerText()).includes(`Adds ${PAIRINGS.find((p) => p.key === 'fraunces-inter').kb} KB on a first visit`), await card.innerText());
  await card.click();
  await sleep(300);
  const sampleFace = await sheet().locator('.fs-sample__h').evaluate((el) => getComputedStyle(el).fontFamily);
  check('2. the pinned sample switches to Fraunces', /^'?"?Fraunces/.test(sampleFace), sampleFace);
  await sheet().getByRole('button', { name: 'Use these fonts' }).click();
  await sheet().waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  await page.getByRole('button', { name: 'Use this look' }).click();
  await page.locator('text=Saved — the site has its new look').first().waitFor({ timeout: 10000 });
  const pubFace = await headingFont();
  check('2. the public heading is in Fraunces, and loaded', /^"?Fraunces/.test(pubFace) && await pub.evaluate(() => document.fonts.check('40px Fraunces')), pubFace);

  // ── 3. Any Google font → For headings → Fake Display, fetched once ──
  await openSheet();
  await sheet().getByRole('tab', { name: 'Any Google font' }).click();
  await sheet().locator('.fs-search').fill('Fake Display');
  const row = sheet().locator('.fs-row', { hasText: 'Fake Display' });
  await row.waitFor({ timeout: 10000 });
  const drawn = await waitFor(async () => /wa-fake-display/.test(await row.locator('.fs-row__name').evaluate((el) => el.style.fontFamily)), 10000);
  check('3. the row’s name is drawn from base.win’s sample', drawn && fake.requests.some((q) => q.path.includes('text=')));
  await both('sheet-any-font');
  await row.click();
  const get = sheet().getByRole('button', { name: 'Get Fake Display and use it' });
  check('3. the button says it will get the font', await get.count() === 1);
  await get.click();
  const getting = await sheet().locator('.fs-said').innerText().catch(() => '');
  await sheet().waitFor({ state: 'detached', timeout: 15000 }).catch(() => {});
  check('3. “Getting Fake Display from Google…” then the sheet closes', /Getting Fake Display from Google…|^$/.test(getting) && await sheet().count() === 0, getting);
  await page.getByRole('button', { name: 'Use this look' }).click();
  await page.locator('text=Saved — the site has its new look').first().waitFor({ timeout: 10000 });
  const fileResp = pub.waitForResponse((r) => /\/site-assets\/fonts\/g\/[a-f0-9]{64}\.woff2$/.test(r.url()), { timeout: 15000 });
  const homeResp = await pub.goto(`${BASE}/site/`, { waitUntil: 'load' });
  const fr = await fileResp.catch(() => null);
  check('3. the public page loads the font from the site (200, immutable)', fr && fr.status() === 200 && /immutable/.test(fr.headers()['cache-control'] || ''), fr?.url());
  check('3. the CSP still says font-src \'self\'', /font-src 'self';/.test(homeResp.headers()['content-security-policy'] || ''));

  // ── 4. Body text: only Sans serif and Serif, only fonts checked for reading ──
  await openSheet();
  await sheet().getByRole('tab', { name: 'Any Google font' }).click();
  await sheet().locator('.fs-seg__opt', { hasText: 'For body text' }).click();
  await sleep(800);
  const chips = await sheet().locator('.fs-chips .fs-chip').allInnerTexts();
  const shown = await sheet().locator('.fs-row .fs-row__name').allInnerTexts();
  const safe = (await api('/site/fonts/catalogue?for=body&page=0')).json.rows.map((r) => r.family);
  check('4. body text: Sans serif and Serif only', JSON.stringify(chips) === '["Sans serif","Serif"]', JSON.stringify(chips));
  check('4. body text: only fonts checked for reading', shown.length > 0 && shown.every((n) => safe.includes(n.replace(/ · Preview unavailable$/, ''))), shown.slice(0, 5).join());
  check('4. the line says why', /Body text uses fonts checked for long reading\./.test(await sheet().innerText()));
  const forced = await setTheme({ heading: 'inter', body: 'oswald' });
  check('4. a heading-only font for body is refused with the words', forced.status === 400 && forced.json.error === FONT_WORDS.body, JSON.stringify(forced.json));
  await sheet().getByRole('button', { name: 'Close' }).click();

  // ── 5. Google failing: 500, then a stall ──
  const before5 = await headingFont();
  for (const mode of [500, 'stall']) {
    fake.mode = mode;
    await openSheet();
    await sheet().getByRole('tab', { name: 'Any Google font' }).click();
    await sheet().locator('.fs-search').fill('Fake Sans');
    await sheet().locator('.fs-row', { hasText: 'Fake Sans' }).click();
    const t = Date.now();
    await sheet().getByRole('button', { name: 'Get Fake Sans and use it' }).click();
    const said = await waitFor(async () => /Google Fonts didn’t answer\. Try again in a minute\. Your site keeps its current fonts\./.test(await sheet().locator('.fs-said').innerText()), 12000);
    check(`5. Google ${mode}: the words within 10 s`, said && Date.now() - t < 10_500, `${Date.now() - t} ms`);
    if (mode === 500) await both('sheet-google-down');
    fake.mode = 'ok';
    await sheet().getByRole('button', { name: 'Close' }).click();
  }
  check('5. the public page is unchanged', await headingFont() === before5);

  // ── 6. A file too large ──
  fake.mode = 'big';
  await openSheet();
  await sheet().getByRole('tab', { name: 'Any Google font' }).click();
  await sheet().locator('.fs-search').fill('Fake Serif');
  await sheet().locator('.fs-row', { hasText: 'Fake Serif' }).click();
  await sheet().getByRole('button', { name: 'Get Fake Serif and use it' }).click();
  check('6. a 400 KB file: the size words', await waitFor(async () => /over 300 KB a file/.test(await sheet().locator('.fs-said').innerText()), 12000));
  fake.mode = 'ok';
  await sheet().getByRole('button', { name: 'Close' }).click();

  // ── 7 and 8. Each pairing: a phone's first visit, the legal line, body text ──
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  watch(phone);
  for (const p of PAIRINGS) {
    const r = await setTheme({ heading: p.heading, body: p.body });
    if (r.status !== 200) { check(`7. ${p.key} saved`, false, JSON.stringify(r.json)); continue; }
    const tab = await phone.newPage();
    await tab.goto(`${BASE}/site/`, { waitUntil: 'load' });
    await tab.evaluate(() => document.fonts.ready);
    await sleep(300);
    const kb = await tab.evaluate(() => performance.getEntriesByType('resource').filter((e) => /\.woff2(\?|$)/.test(e.name)).reduce((n, e) => n + (e.transferSize || e.encodedBodySize || 0), 0) / 1024);
    check(`7. ${p.key}: a phone’s first visit takes ${Math.round(kb)} KB of fonts (≤ 150)`, kb <= 150);
    const legal = await tab.evaluate(() => {
      const el = document.querySelector('.footer-authorization');
      const body = document.querySelector('main p');
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { visible: el.offsetParent !== null && cs.visibility !== 'hidden', family: cs.fontFamily, root: getComputedStyle(document.documentElement).getPropertyValue('--font-body').trim(), size: parseFloat(cs.fontSize), upper: cs.textTransform, bodySize: body ? parseFloat(getComputedStyle(body).fontSize) : 17 };
    });
    const bodyFace = FONT_BY_VALUE[p.body].family;
    check(`8. ${p.key}: Authorized by visible, in the body face, not in capitals; body text 17 px`,
      legal && legal.visible && legal.family.includes(bodyFace) && legal.upper === 'none' && legal.size >= 13 && legal.bodySize >= 17, JSON.stringify(legal));
    await tab.close();
  }
  await phone.close();
  ok200(await setTheme({ heading: 'g:fake-display', body: 'inter' }), 'Fake Display for headings again');

  // ── 9. /pa and /zh: Gurmukhi and the Chinese faces under any heading font ──
  process.env.GOOGLE_TRANSLATE_KEY = `test-translate-key-${tag}`;
  const s9 = (await api('/site')).json.settings;
  ok200(await act('site.settings.save', { languages: { ...s9.languages, on: ['pa', 'zh-Hans'] } }), 'languages on');
  const words = (lang) => Object.fromEntries(LEGAL_KEYS.map((k) => [k, `${lang === 'pa' ? 'ਮਨਜ਼ੂਰ' : '批准的文字'} ${k} ${slotsOf(LEGAL_ENGLISH[k]).map((x) => `{${x}}`).join(' ')}`.trim()]));
  for (const lang of ['pa', 'zh-Hans']) ok200(await act('site.legal.approve', { lang, words: words(lang) }), `approve ${lang}`);
  await act('site.translate.now', {});
  const on = await waitFor(async () => (await api('/site/languages')).json.languages.filter((l) => ['pa', 'zh-Hans'].includes(l.code)).every((l) => l.offered), 90000);
  check('9. ਪੰਜਾਬੀ and 简体 are on', on);
  const notFound = [];
  pub.on('response', (r) => { if (r.status() === 404) notFound.push(r.url()); });
  await pub.goto(`${BASE}/site/pa/`, { waitUntil: 'load' });
  await pub.evaluate(() => document.fonts.ready);
  await sleep(500);
  const paOk = await pub.evaluate(() => ({
    gurmukhi: document.fonts.check('16px "Noto Sans Gurmukhi"', 'ਪੰਜਾਬੀ'),
    fake: document.fonts.check('40px "Fake Display"'),
    clipped: [...document.querySelectorAll('h1, h2, .display')].filter((h) => h.scrollHeight > h.clientHeight + 2 && getComputedStyle(h).overflow === 'hidden').length,
  }));
  check('9. /pa: Gurmukhi drawn, the Fake Display face loaded, no heading clipped, nothing 404s', paOk.gurmukhi && paOk.fake && paOk.clipped === 0 && !notFound.length, JSON.stringify({ ...paOk, notFound }));
  await pub.screenshot({ path: `${SHOTS}/public-pa-1440.png` });
  await pub.goto(`${BASE}/site/zh/`, { waitUntil: 'load' });
  const zhFace = await pub.evaluate(() => getComputedStyle(document.querySelector('h1, h2, .display')).fontFamily);
  check('9. /zh: a heading carries the Chinese faces', /PingFang SC|Microsoft YaHei/.test(zhFace), zhFace);
  ok200(await act('site.settings.save', { languages: { ...(await api('/site')).json.settings.languages, on: [] } }), 'languages off');

  // ── 10. Remove: refused while in use; an unused one goes, Undo brings it back ──
  await openSheet();
  await sheet().locator('.fs-mine > summary').click();
  await sheet().locator('.fs-mine__row', { hasText: 'Fake Display' }).getByRole('button', { name: /Remove/ }).click();
  check('10. a font in use: refused, in place', await waitFor(async () => /Fake Display is used for headings on the main site/.test(await sheet().locator('.fs-said').innerText()), 5000));
  ok200(await act('site.font.add', { family: 'Fake Sans' }), 'Fake Sans added');
  await go('/website/theme');
  await page.getByRole('button', { name: 'Change fonts' }).click();
  await sheet().waitFor();
  await sheet().locator('.fs-mine > summary').click();
  const unused = sheet().locator('.fs-mine__row', { hasText: 'Fake Sans' });
  check('10. an unused font is tagged Not used', (await unused.innerText()).includes('Not used'));
  await both('sheet-fonts-on-site');
  await unused.getByRole('button', { name: /Remove/ }).click();
  await waitFor(async () => (await sheet().locator('.fs-mine__row', { hasText: 'Fake Sans' }).count()) === 0, 5000);
  await sheet().locator('.fs-said').getByRole('button', { name: 'Undo' }).click();
  check('10. Undo brings it back', await waitFor(async () => (await sheet().locator('.fs-mine__row', { hasText: 'Fake Sans' }).count()) === 1, 5000));
  await sheet().getByRole('button', { name: 'Close' }).click();

  // ── 11. Settings → Brand: Fraunces, then Fake Display, drawn on the desk ──
  for (const [family, tabName] of [['Fraunces', 'Fraunces'], ['Fake Display', 'Fake Display']]) {
    await go('/settings/brand');
    await page.getByRole('button', { name: 'Change font' }).click();
    await sheet().waitFor();
    await sheet().locator('.fs-search').fill(tabName);
    await sheet().locator('.fs-row', { hasText: tabName }).first().click();
    await sheet().getByRole('button', { name: /Use these fonts|and use it/ }).click();
    await sheet().waitFor({ state: 'detached', timeout: 15000 }).catch(() => {});
    await page.getByRole('button', { name: /^Save/ }).first().click();
    await page.waitForLoadState('load');
    await sleep(1500);
    await go('/settings/brand');
    await page.evaluate(() => document.fonts.ready);
    const okFace = await page.evaluate((f) => document.fonts.check(`22px "${f}"`), family);
    check(`11. Brand heading ${family}: drawn on the desk`, okFace && (await page.locator('.bs-heading').innerText()).includes(family));
  }
  await both('brand-heading');

  // ── 12. On a phone: the sheet full screen, rows 48 px, no sideways scroll ──
  await page.setViewportSize({ width: 390, height: 844 });
  await openSheet();
  await sheet().getByRole('tab', { name: 'Any Google font' }).click();
  await sleep(800);
  const box = await sheet().boundingBox();
  const small = await sheet().evaluate((d) => [...d.querySelectorAll('.fs-row, .fs-pair, button, .fs-seg__opt, input')].filter((e) => e.offsetParent && !e.closest('.ws-sr'))
    .map((e) => [e.textContent.trim().slice(0, 24) || e.getAttribute('aria-label'), Math.round(e.getBoundingClientRect().height)]).filter(([, h]) => h < 40));
  const rowsTall = await sheet().evaluate((d) => [...d.querySelectorAll('.fs-row')].every((r) => r.getBoundingClientRect().height >= 48));
  check('12. the sheet is full screen on a phone', box && box.width >= 389 && box.height >= 840, JSON.stringify(box));
  check('12. rows at least 48 px; no sideways scroll', rowsTall && await sheet().evaluate((d) => d.scrollWidth <= d.clientWidth + 1) && await overflow() <= 0, JSON.stringify(small));
  await page.screenshot({ path: `${SHOTS}/sheet-any-phone-390.png` });

  check('no request left this machine', away.length === 0, away.slice(0, 5).join(' '));
  check('no script errors on the desk', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  check(`ran to the end: ${e.message}`, false, e.stack);
}

function ok200(r, what) { if (r.status !== 200) check(what, false, JSON.stringify(r.json)); }

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
await finish(failed ? 1 : 0);
