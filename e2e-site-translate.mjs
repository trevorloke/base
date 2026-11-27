// The website in Punjabi and Chinese (TR; SITE.md "Languages"), in a browser:
// the desk's Languages screens and the public pages they make.
//
// base.win runs in this process on PORT (5470), with a stand-in Google
// Translation on PORT+1 (server/test/fake-translate.js: made-up words in the
// right scripts) and a stand-in Stripe on PORT+2. Nothing reaches a real
// service. A manager signs up; Website → Languages says to add the key. The
// key is then set (as if the server restarted with it) and Settings →
// Services' Check translation says "Names kept … Header accepted: yes". The
// manager turns on ਪੰਜਾਬੀ (seeing its estimate) and 中文, sees the
// checklist, fills Authorized by, approves the words the law needs in each
// language, presses Translate now, and sees ਪੰਜਾਬੀ, 简体 and 繁體 On. The
// public pages: the switch after the skip link (four 48 px segments on a
// phone, no sideways scroll, readable contrast), /pa/about by the switch
// with every menu link under /pa and a clean console, the footer's two
// Authorized-by lines, a newsletter on /zh whose yes shows in History in
// 简体 with the English, a donation on /pa/donate (the stand-in Stripe page,
// Back lands on /pa/donate, the checkout keeps the Punjabi declaration). A
// volunteer given only "Website translations" suggests a correction: the
// public page does not change until the manager presses Looks right, then
// shows it at once and after a republish; Looks right is not offered on
// their own words. The remembered language (a page then a menu link, the
// browser closed: / lands on /pa/; English tapped: stays English). A live
// microsite at dougdidnt.test shows the switch and /pa/. 繁體 turned off:
// /zh-hant/about lands on /about and the switch reads 中文. Fonts are
// checked as loaded (Gurmukhi from the site's own face; a CJK face found
// for Chinese) and a long Punjabi heading is not clipped on the Barlow
// and the Inter headings. Every desk screen and page is saved at 1440×900
// and 390×844 under SHOTS.
//
//   (cd web && npm run build)
//   PORT=5470 SHOTS=/tmp/site-translate node e2e-site-translate.mjs
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

// The fixtures here are Imagine Surrey's, so the server runs as its production
// does (render.yaml sets this brand); a brand set by hand is left as set.
if (process.env.STARBASE_BRAND === undefined) process.env.STARBASE_BRAND = 'imagine-surrey';

const PORT = Number(process.env.PORT) || 5470;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOTS || '/tmp/site-translate';
const DOUG = 'dougdidnt.test';
mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  — ${String(extra).slice(0, 300)}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Date.now().toString(36);

// ── Preflight: without CJK and Gurmukhi fonts the screenshots show boxes ──
const fonts = (lang) => { try { return execSync(`fc-list :lang=${lang}`, { encoding: 'utf8' }).trim(); } catch { return ''; } };
if (!fonts('zh')) {
  console.log('FAIL  Install fonts-noto-cjk (apt-get install -y fonts-noto-cjk) on this machine');
  process.exit(1);
}
if (!fonts('pa')) console.log('NOTE  no system Gurmukhi font: the site’s own Noto Sans Gurmukhi is what draws it');

// ── base.win, the stand-in Google and the stand-in Stripe, in this process ──
for (const k of ['DATABASE_URL', 'RESEND_API_KEY', 'MAIL_FROM', 'STARBASE_PUBLIC_URL', 'BASE_PATH', 'SITE_HOSTS', 'GOOGLE_TRANSLATE_KEY']) delete process.env[k];
const STRIPE_KEY = `sk_test_tr_${tag}`;
Object.assign(process.env, {
  STARBASE_OPEN_SIGNUP: '1', STARBASE_DATA: 'memory', GEOCODE_ON_SAVE: 'off',
  GOOGLE_TRANSLATE_API_BASE: `http://127.0.0.1:${PORT + 1}`,
  STRIPE_SECRET_KEY: STRIPE_KEY, STRIPE_WEBHOOK_SECRET: `whsec_tr_${tag}`,
});
const { startFakeTranslate } = await import('./server/test/fake-translate.js');
const fakeT = await startFakeTranslate({ port: PORT + 1 });
const { startFakeStripe } = await import('./server/test/fake-stripe.js');
const fakeS = await startFakeStripe({ port: PORT + 2, secret: process.env.STRIPE_WEBHOOK_SECRET, webhookUrl: `${BASE}/stripe/webhook`, apiKey: STRIPE_KEY });
process.env.STRIPE_API_BASE = fakeS.url;
const { serve } = await import('@hono/node-server');
const { app } = await import('./server/index.js');
const { getDb } = await import('./server/db/client.js');
const { startJobRunner, stopJobRunner } = await import('./server/lib/jobs.js');
const { islandsBuilt } = await import('./server/ext/site/render/index.js');
if (!islandsBuilt()) { console.log('FAIL  web/dist/site-islands.js is missing: run `cd web && npm run build` first'); process.exit(1); }
const server = serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' });
const db = await getDb();
startJobRunner(db, { everyMs: 1000 });
await sleep(300);

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', `--host-resolver-rules=MAP ${DOUG} 127.0.0.1`] });
const finish = async (code) => {
  stopJobRunner();
  await browser.close().catch(() => {});
  server.close();
  await fakeT.close();
  await fakeS.close?.();
  process.exit(code);
};
process.on('unhandledRejection', async (e) => { console.log(`FAIL  ${e?.stack || e}`); await finish(1); });

const errors = [];
const desk = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, timezoneId: 'America/Vancouver' });
const page = await desk.newPage();
page.on('pageerror', (e) => errors.push(e.message));
const text = async (p = page) => ((await p.innerText('main').catch(() => '')) || '').replace(/\s+/g, ' ');
const overflow = (p = page) => p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
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
const primaries = (p = page) => p.evaluate(() => [...document.querySelectorAll('main .btn-primary')].filter((b) => b.offsetParent).map((b) => b.textContent.trim()));
// Both sizes: as it is, then on a phone (no sideways scroll; buttons, links
// and fields 48 px tall).
const phoneIssues = [];
const both = async (name, p = page) => {
  const vp = p.viewportSize();
  await p.screenshot({ path: `${SHOTS}/${name}-1440.png`, fullPage: true });
  await p.setViewportSize({ width: 390, height: 844 });
  await sleep(400);
  const o = await overflow(p);
  const small = await p.evaluate(() => [...document.querySelectorAll('main .btn, main button, main input:not([type=checkbox]):not([type=radio]), main textarea, .lg-row__link, .lg-check a')]
    .filter((el) => el.offsetParent && !el.closest('.ws-sr, .sv2-sr, [aria-hidden=true]'))
    .map((el) => [el.textContent.trim().slice(0, 30) || el.getAttribute('aria-label') || el.id, Math.round(el.getBoundingClientRect().height)])
    .filter(([, h]) => h < 48));
  if (o > 0 || small.length) phoneIssues.push([name, o, small]);
  await p.screenshot({ path: `${SHOTS}/${name}-390.png`, fullPage: true });
  await p.setViewportSize(vp);
  await sleep(200);
};
const waitFor = async (fn, ms = 60000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await fn()) return true; await sleep(700); }
  return false;
};

try {
  // ── 1. A manager; no key: "Add the translation key …"; the key set; Check translation ──
  await page.goto(`${BASE}/signup`, { waitUntil: 'domcontentloaded' });
  await page.fill('#su-name', 'Rae Example');
  if (await page.locator('#su-org').count()) await page.fill('#su-org', 'Harbour City Together');
  await page.fill('#su-email', `desk.${tag}@example.org`);
  await page.fill('#su-password', 'harbour-forward-2026');
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/admin\/?$/, { timeout: 15000 });
  await go('/website');
  // The site's pages for the rest of the suite: an About page with a long heading and a form, and a donate page.
  const site = (await api('/site')).json;
  await act('site.settings.save', { org: { ...site.settings.org, name: 'Harbour City Together', shortName: '', agentName: '', agentContact: '' } });
  const made = async (slug, title, modules) => {
    // The seed may have the page already: then its sections are replaced.
    let pg = (await act('site.page.create', { title, slug, modules, show_in_nav: true })).json?.page;
    if (!pg) {
      pg = (await api('/site')).json.pages.find((x) => x.slug === slug);
      const saved = await act('site.page.save', { id: pg.id, title, modules, show_in_nav: true });
      if (saved.status !== 200) throw new Error(`${slug}: ${JSON.stringify(saved.json)}`);
    }
    const pubd = await act('site.page.publish', { id: pg.id });
    if (pubd.status !== 200) throw new Error(`${slug}: ${JSON.stringify(pubd.json)}`);
    return pg;
  };
  const about = await made('about', 'About us', [
    { id: 'band01', kind: 'band', hidden: false, props: { title: 'When we organize,', highlight: 'we win', cta: { label: 'Join us', href: '/join' }, tone: 'accent' } },
    { id: 'text01', kind: 'text', hidden: false, props: { title: 'A long heading about our neighbourhood plan for safer streets and parks', body: 'We knock on doors every weekend.\n\n- Safer crossings\n- Better buses', tone: 'paper' } },
    { id: 'news01', kind: 'newsletter', hidden: false, props: { title: 'Get the newsletter', intro: 'News and events.', askPhone: false, buttonLabel: 'Sign up', tone: 'surface' } },
  ]);
  await made('donate', 'Donate', [{ id: 'don001', kind: 'donate', hidden: false, props: { title: 'Give', intro: 'Every dollar counts.', amounts: ['25', '50'], allowMonthly: false } }]);

  await go('/website/languages');
  check('1. no key: Languages says to add the translation key', /Add the translation key to turn on languages/.test(await text()), await text());
  check('Languages: no primary button', (await primaries()).length === 0, JSON.stringify(await primaries()));
  await both('languages-no-key');
  process.env.GOOGLE_TRANSLATE_KEY = `test-translate-key-${tag}`; // as if the server restarted with it
  await go('/settings/services');
  const row = page.locator('.sv2-row', { hasText: 'Translation (Google)' });
  await row.getByRole('button', { name: 'Check translation' }).click();
  await row.locator('.sv2-said').waitFor({ timeout: 20000 });
  const probeSaid = await row.locator('.sv2-said').innerText();
  check('1. Check translation: names kept · header accepted', /Names kept: (yes|no) · Header accepted: yes · Placeholders kept: yes/.test(probeSaid), probeSaid);

  // ── 2. Turn on ਪੰਜਾਬੀ (the estimate), then 中文; the checklist; Authorized by; approve; Translate now ──
  await go('/website/languages/pa');
  await page.locator('.lg-turnon p', { hasText: 'characters' }).waitFor({ timeout: 15000 });
  const est = await page.locator('.lg-turnon').innerText();
  check('2. Turn on shows the estimate', /First translation needs about [\d,]+ characters \([\d,]+ with everything\)\. This month: [\d,]+ of 450,000 left\./.test(est), est);
  check('Turn on: one primary button', JSON.stringify(await primaries()) === '["Turn on"]', JSON.stringify(await primaries()));
  await both('turn-on-estimate');
  await page.getByRole('button', { name: 'Turn on' }).click();
  await page.locator('.lg-checklist').waitFor({ timeout: 15000 });
  await go('/website/languages/zh-Hans');
  await page.getByRole('button', { name: 'Turn on' }).click();
  await page.locator('.lg-checklist').waitFor({ timeout: 15000 });
  await go('/website/languages/pa');
  const checklist = await page.locator('.lg-checklist').innerText();
  check('2. the checklist: key ticked, Authorized by to fill, approval to do', /Translation key/.test(checklist) && /Authorized by \(the agent’s name\)/.test(checklist)
    && (await page.locator('.lg-check[data-done]', { hasText: 'Translation key' }).count()) === 1
    && (await page.locator('.lg-check:not([data-done])', { hasText: 'agent’s name' }).count()) === 1, checklist);
  check('2. the checklist keeps its spaces ("in ਪੰਜਾਬੀ")', /Authorized by, in ਪੰਜਾਬੀ, approved/.test(checklist), checklist);
  await both('language-getting-ready');
  // Preview before visitors see it: the home page's draft in Punjabi.
  const [pv] = await Promise.all([page.context().waitForEvent('page'), page.getByRole('button', { name: /^Preview/ }).click()]);
  await pv.waitForURL(/__preview\/.*lang=pa/, { timeout: 15000 });
  check('2. Preview while getting ready opens the home page in ਪੰਜਾਬੀ', await pv.locator('html').getAttribute('lang') === 'pa', pv.url());
  await pv.close();
  await page.locator('.lg-check a', { hasText: 'agent’s name' }).click();
  await page.waitForURL(/\/website\/settings/);
  await page.locator('#wb-s-agent').waitFor();
  await page.fill('#wb-s-agent', 'Ada Example');
  await page.fill('#wb-s-agentc', '604-555-0100');
  await page.locator('#org').getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('text=Saved').first().waitFor({ timeout: 10000 });
  // The machine's drafts arrive with the first sweep.
  await waitFor(async () => (await api('/site/languages/pa/legal')).json?.draft_from === 'machine');
  // 繁體 before 简体 is approved: with no draft yet it says why the boxes are
  // empty and Approve waits; with one (the sweep converted 简体's) it is labelled.
  await go('/website/languages/zh-Hant/legal');
  const hantFrom = (await api('/site/languages/zh-Hant/legal')).json?.draft_from ?? null;
  const hantWait = await page.locator('.lg-wait').innerText().catch(() => '');
  const hantOff = await page.getByRole('button', { name: 'Approve these words' }).isDisabled().catch(() => false);
  check('2. 繁體 before 简体 is approved: no draft → “Approve 简体 first”, Approve off; a draft → no waiting note',
    hantFrom === null ? /Approve 简体 first/.test(hantWait) && hantOff : !hantWait, `${hantFrom} | ${hantWait} | ${hantOff}`);
  await both('legal-hant-waiting');
  for (const code of ['pa', 'zh-Hans', 'zh-Hant']) {
    await go(`/website/languages/${code}/legal`);
    if (code === 'pa') {
      const draftLabel = await page.locator('.lg-key').first().innerText();
      check('2. legal words: the machine draft, labelled', /Machine draft — check every word/.test(draftLabel), draftLabel);
      check('legal words: one primary button', JSON.stringify(await primaries()) === '["Approve these words"]', JSON.stringify(await primaries()));
      await both('legal-words');
    }
    if (code === 'zh-Hant') check('2. 繁體’s draft is 简体’s approved words, converted', /Converted from 简体 — check every word/.test(await text()));
    await page.getByRole('button', { name: 'Approve these words' }).click();
    await page.getByRole('button', { name: 'Yes' }).click();
    await page.locator('.toast', { hasText: 'Approved' }).waitFor({ timeout: 10000 }).catch(() => {});
    const err = await page.locator('.lg-legal .wb-field__err').count() ? await page.locator('.lg-legal .wb-field__err').innerText() : '';
    check(`2. approved the words the law needs in ${code}`, !err && (await api('/site/languages')).json.languages.find((l) => l.code === code).legal.state === 'approved', err);
  }
  await go('/website/languages/pa');
  if (await page.getByRole('button', { name: 'Translate now' }).count()) await page.getByRole('button', { name: 'Translate now' }).click();
  const allOn = await waitFor(async () => (await api('/site/languages')).json.languages.every((l) => l.offered), 90000);
  await go('/website/languages');
  const chips = await page.locator('.lg-row .chip').allInnerTexts();
  check('2. ਪੰਜਾਬੀ, 简体 and 繁體 are On', allOn && chips.join() === 'On,On,On', chips.join());
  await both('languages-on');

  // ── 3. The home page with the switch, both sizes; contrast ──
  const pub = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const v = await pub.newPage();
  const consoleErr = [];
  v.on('console', (m) => { if (m.type() === 'error') consoleErr.push(m.text()); });
  v.on('pageerror', (e) => consoleErr.push(e.message));
  for (const [name, path] of [['home-en', '/site/'], ['home-pa', '/site/pa/'], ['home-zh', '/site/zh/'], ['home-zh-hant', '/site/zh-hant/']]) {
    for (const [w, h] of [[1440, 900], [390, 844]]) {
      await v.setViewportSize({ width: w, height: h });
      await v.goto(BASE + path, { waitUntil: 'networkidle' });
      await v.evaluate(() => document.fonts.ready);
      await v.screenshot({ path: `${SHOTS}/${name}-${w}.png` });
      const o = await overflow(v);
      if (o > 0) check(`${name} at ${w}: no sideways scroll`, false, o);
      if (name === 'home-en' && w === 390) {
        const segs = await v.evaluate(() => [...document.querySelectorAll('.lang-switch a')].map((a) => Math.round(a.getBoundingClientRect().height)));
        const first = await v.evaluate(() => document.body.firstElementChild?.className);
        check('3. the switch: four 48 px segments on a phone, after the skip link', segs.length === 4 && segs.every((x) => x >= 48) && /skip-link/.test(first), JSON.stringify({ segs, first }));
      }
    }
  }
  const contrast = await v.evaluate(() => {
    const rgb = (s) => (s.match(/[\d.]+/g) || []).slice(0, 4).map(Number);
    const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const c = rgb(getComputedStyle(e).backgroundColor); if (c.length >= 3 && (c[3] === undefined || c[3] > 0.5)) return c; } return [255, 255, 255]; };
    return [...document.querySelectorAll('.lang-switch a')].map((a) => { const l1 = lum(rgb(getComputedStyle(a).color)); const l2 = lum(bgOf(a)); return Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 10) / 10; });
  });
  check('3. the switch reads at 4.5:1 or better', contrast.length === 4 && contrast.every((c) => c >= 4.5), JSON.stringify(contrast));

  // The privacy policy shown in English: its line is the bar's own; "Read it
  // in English" is one 48 px target on a phone; a band's call to action has an edge.
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    await v.setViewportSize({ width: w, height: h });
    await v.goto(`${BASE}/site/pa/privacy`, { waitUntil: 'networkidle' });
    const pol = await v.evaluate(() => { const p = document.querySelector('.lang-note--policy'); return p ? Boolean(p.closest('.lang-bar')) : null; });
    if (pol !== null) check(`3. privacy at ${w}: “our policy is in English” sits inside the language bar`, pol === true);
    await v.screenshot({ path: `${SHOTS}/privacy-pa-${w}.png` });
    await v.goto(`${BASE}/site/pa/about`, { waitUntil: 'networkidle' });
    if (w === 390) {
      const readH = await v.evaluate(() => Math.round(document.querySelector('.lang-note a')?.getBoundingClientRect().height || 0));
      check('3. “Read it in English” is 48 px on a phone', readH >= 48, readH);
    }
    const edge = await v.evaluate(() => { const b = document.querySelector('.tone-accent .btn--primary'); return b ? getComputedStyle(b).borderTopColor : null; });
    check(`3. about at ${w}: the band’s button has an edge`, edge && !/rgba\(0, 0, 0, 0\)|transparent/.test(edge), edge);
    await v.screenshot({ path: `${SHOTS}/about-pa-${w}.png` });
  }

  // ── 4. ਪੰਜਾਬੀ on /about by the switch; the menu under /pa; a clean console; the footer ──
  consoleErr.length = 0;
  await v.setViewportSize({ width: 1440, height: 900 });
  await v.goto(`${BASE}/site/about`, { waitUntil: 'networkidle' });
  await Promise.all([v.waitForURL(/\/site\/pa\/about$/), v.locator('.lang-switch a', { hasText: 'ਪੰਜਾਬੀ' }).click()]);
  await v.waitForLoadState('networkidle');
  const links = await v.evaluate(() => [...document.querySelectorAll('header a[href^="/site"], nav a[href^="/site"]')].filter((a) => !a.closest('.lang-switch')).map((a) => a.getAttribute('href')));
  check('4. tapped ਪੰਜਾਬੀ: /pa/about, every menu link under /pa', links.length > 0 && links.every((h) => h.startsWith('/site/pa')), JSON.stringify(links));
  check('4. the console is clean (no hydration mismatch)', consoleErr.length === 0, consoleErr.join(' | '));
  const footer = await v.locator('footer').innerText();
  check('4. the footer has both Authorized-by lines (English, then the approved Punjabi)', /Authorized by Ada Example, 604-555-0100/.test(footer) && (footer.match(/Ada Example/g) || []).length >= 2, footer.replace(/\s+/g, ' ').slice(-300));
  await v.evaluate(() => document.querySelector('footer').scrollIntoView());
  await v.screenshot({ path: `${SHOTS}/pa-footer-1440.png` });

  // Fonts: the site's Gurmukhi face loaded on /pa; CJK found on /zh.
  const cdp = await pub.newCDPSession(v);
  await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
  const familiesOf = async (selector) => {
    const { root } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    if (!nodeId) return [];
    return (await cdp.send('CSS.getPlatformFontsForNode', { nodeId })).fonts.map((f) => f.familyName);
  };
  const gFace = await v.evaluate(async () => { await document.fonts.ready; return [...document.fonts].filter((f) => /0?A00/i.test(f.unicodeRange) && f.status === 'loaded').map((f) => f.family.replace(/['"]/g, '')); });
  const paFam = await familiesOf('main h2');
  check('fonts: a loaded face with U+0A00 on /pa, and the heading drawn in Gurmukhi', gFace.length > 0 && paFam.some((f) => /Gurmukhi/i.test(f)), JSON.stringify({ gFace, paFam }));
  await v.goto(`${BASE}/site/zh/about`, { waitUntil: 'networkidle' });
  await v.evaluate(() => document.fonts.ready);
  const zhFam = await familiesOf('main h2');
  check('fonts: the Chinese heading drawn in a CJK face', zhFam.length > 0 && !zhFam.some((f) => /Last Resort/i.test(f)) && zhFam.some((f) => /CJK|Hei|Han|Noto Sans SC|WenQuanYi|Droid Sans Fallback|Unifont/i.test(f)), JSON.stringify(zhFam));

  // Nothing clipped: the long Punjabi heading on the Inter and the Barlow headings.
  const clipCheck = async (label) => {
    await v.goto(`${BASE}/site/pa/about`, { waitUntil: 'networkidle' });
    await v.evaluate(() => document.fonts.ready);
    const h = v.locator('main h2', { hasText: /\S/ }).nth(1);
    await h.scrollIntoViewIfNeeded();
    const lh = await h.evaluate((el) => { const s = getComputedStyle(el); return parseFloat(s.lineHeight) / parseFloat(s.fontSize); });
    const box = await h.boundingBox();
    const clip = { x: box.x, y: Math.max(0, box.y - 6), width: box.width, height: box.height + 12 };
    await v.evaluate(() => document.getAnimations().forEach((x) => x.pause()));
    await sleep(300);
    const a = await v.screenshot({ clip, animations: 'disabled', caret: 'hide' });
    const a2 = await v.screenshot({ clip, animations: 'disabled', caret: 'hide' });
    // Every ancestor whose overflow could cut the heading (not visible) and whose box doesn't hold it ±6 px.
    const cutters = await h.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const out = [];
      for (let e = el.parentElement; e && e.tagName !== 'BODY'; e = e.parentElement) {
        const s = getComputedStyle(e);
        const b = e.getBoundingClientRect();
        if ((s.overflowY !== 'visible' || s.overflowX !== 'visible') && (b.top > r.top - 6 || b.bottom < r.bottom + 6 || b.left > r.left || b.right < r.right)) out.push(`${e.tagName}.${e.className} ${s.overflowX}/${s.overflowY}`);
      }
      return out;
    });
    await h.evaluate((el) => { for (let e = el; e && e.tagName !== 'BODY'; e = e.parentElement) e.style.overflow = 'visible'; });
    await sleep(300);
    const b = await v.screenshot({ clip, animations: 'disabled', caret: 'hide' });
    await v.screenshot({ path: `${SHOTS}/pa-long-heading-${label}-1440.png`, clip: { x: 0, y: clip.y - 40, width: 1440, height: clip.height + 80 } });
    check(`not clipped (${label}): line-height ≥ 1.35 × size, no ancestor cuts it, the same with every overflow forced visible`,
      lh >= 1.349 && !cutters.length && (a.equals(b) || !a.equals(a2)), `line-height ${lh.toFixed(3)} · same: ${a.equals(b)} · steady: ${a.equals(a2)} · ${cutters.join(' | ')}`);
  };
  await clipCheck('inter');
  const theme = (await api('/site')).json.settings.theme;
  await act('site.settings.save', { theme: { ...theme, follow: false, fonts: { ...theme.fonts, heading: 'barlow-condensed' } } });
  await clipCheck('barlow');
  await act('site.settings.save', { theme });

  // ── 5. A newsletter on /zh; History shows the yes in 简体 with the English ──
  await v.goto(`${BASE}/site/zh/about`, { waitUntil: 'networkidle' });
  const nl = v.locator('#m-news01 form');
  const email = `mei.${tag}@example.org`;
  await nl.locator('input[name=email]').fill(email);
  if (await nl.locator('input[name=first_name]').count()) await nl.locator('input[name=first_name]').fill('Mei');
  if (await nl.locator('input[type=checkbox][name=consent_email]').count()) await nl.locator('input[type=checkbox][name=consent_email]').check();
  await v.screenshot({ path: `${SHOTS}/zh-form-1440.png` });
  await nl.locator('button[type=submit]').click();
  await waitFor(async () => (await db.query('select 1 from persons where lower(email) = $1', [email])).rows.length > 0, 15000);
  const pid = (await db.query('select id from persons where lower(email) = $1', [email])).rows[0]?.id;
  await go(`/people/${pid}`);
  const hist = page.locator('text=(in 简体)').first();
  await hist.waitFor({ timeout: 15000 }).catch(() => {});
  const histText = await text();
  check('5. the desk shows the yes in 简体 with the English beside it', /\(in 简体\) · English: /.test(histText), histText.slice(0, 400));
  await both('history-zh');

  // ── 6. A donation on /pa/donate: the stand-in Stripe, Back to /pa/donate, the Punjabi declaration kept ──
  await v.goto(`${BASE}/site/pa/donate`, { waitUntil: 'networkidle' });
  await v.evaluate(() => document.fonts.ready);
  await v.screenshot({ path: `${SHOTS}/pa-donate-1440.png`, fullPage: true });
  // Sent as a plain form: the island follows only an https (or this site's)
  // payment page, and the stand-in Stripe is plain http.
  const noJs = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, javaScriptEnabled: false });
  const vNo = await noJs.newPage();
  await vNo.goto(`${BASE}/site/pa/donate`, { waitUntil: 'load' });
  const dform = vNo.locator('#m-don001 form');
  await dform.locator('input[name=amount_cents], input[type=radio]').first().check({ force: true }).catch(() => {});
  for (const [n2, val] of [['first_name', 'Kiran'], ['last_name', 'Example'], ['email', `kiran.${tag}@example.org`], ['address', '1 Example St'], ['city', 'Surrey'], ['postal_code', 'V3T 1A1']]) {
    if (await dform.locator(`input[name=${n2}]`).count()) await dform.locator(`input[name=${n2}]`).fill(val);
  }
  if (await dform.locator('input[name=citizen]').count()) await dform.locator('input[name=citizen]').first().check({ force: true }).catch(() => {});
  await dform.locator('input[type=checkbox][name=declaration]').check({ force: true });
  await Promise.all([vNo.waitForURL((u) => new URL(String(u)).port === String(PORT + 2), { timeout: 20000 }).catch(() => {}), dform.locator('button[type=submit]').click()]);
  // The plain post's 303 may not be followed to another port here: then the
  // checkout's own page is opened at its address, as the redirect would.
  if (new URL(vNo.url()).port !== String(PORT + 2)) {
    await waitFor(async () => (await db.query("select 1 from stripe_checkouts c join persons p on p.id = c.person_id where lower(p.email) = $1 and c.session_id is not null", [`kiran.${tag}@example.org`])).rows.length > 0, 15000);
    const sid = (await db.query("select c.session_id from stripe_checkouts c join persons p on p.id = c.person_id where lower(p.email) = $1", [`kiran.${tag}@example.org`])).rows[0]?.session_id;
    console.log(`NOTE  the plain post stayed at ${vNo.url()}; opening the checkout ${sid} directly`);
    if (sid) await vNo.goto(`${fakeS.url}/pay/${sid}`, { waitUntil: 'load' });
  }
  const onStripe = new URL(vNo.url()).port === String(PORT + 2);
  await vNo.screenshot({ path: `${SHOTS}/pa-stripe-1440.png` });
  if (onStripe) await Promise.all([vNo.waitForURL(/\/site\/pa\/donate/, { timeout: 15000 }), vNo.getByRole('link', { name: 'Back' }).click()]);
  const co = (await db.query("select c.declaration from stripe_checkouts c join persons p on p.id = c.person_id where lower(p.email) = $1", [`kiran.${tag}@example.org`])).rows[0];
  const decl = co && (typeof co.declaration === 'string' ? JSON.parse(co.declaration) : co.declaration);
  check('6. donate on /pa: the stand-in Stripe opened, Back lands on /pa/donate, the checkout keeps the Punjabi declaration',
    onStripe && /\/site\/pa\/donate/.test(vNo.url()) && decl?.lang === 'pa' && /ਮਨਜ਼ੂਰ|[਀-੿]/.test(decl?.text || ''), JSON.stringify({ url: vNo.url(), decl }));
  await noJs.close();

  // ── 7. A volunteer with only Website translations suggests; the manager approves ──
  const inv = (await act('member.invite', { email: `vic.${tag}@example.org`, role: 'volunteer' })).json;
  const volCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const vp = await volCtx.newPage();
  await vp.goto(String(inv.joinUrl).replace(/^https?:\/\/[^/]+/, BASE), { waitUntil: 'domcontentloaded' });
  await vp.fill('#join-name', 'Vic Example');
  await vp.fill('#join-password', 'words-check-2026');
  await vp.click('button[type="submit"]');
  await vp.waitForURL((u) => !/\/join\//.test(String(u)), { timeout: 15000 });
  const volId = (await db.query('select id from users where email = $1', [`vic.${tag}@example.org`])).rows[0].id;
  await act('permission.member.set', { user_id: volId, grant: ['site_words'], deny: [] });
  await go('/website/languages/pa', vp);
  const tabs = await vp.locator('.wb-tabs a').allInnerTexts();
  check('7. a volunteer with Website translations sees only Languages', tabs.join() === 'Languages', tabs.join());
  await vp.fill('#lg-q', 'knock on doors');
  const sent = vp.locator('.lg-sent', { hasText: 'We knock on doors every weekend.' });
  await sent.waitFor({ timeout: 10000 });
  await sent.getByRole('button', { name: 'Change' }).click();
  const fixed = 'ਅਸੀਂ ਹਰ ਹਫ਼ਤੇ ਦਰਵਾਜ਼ੇ ਖੜਕਾਉਂਦੇ ਹਾਂ।';
  await sent.locator('textarea').fill(fixed);
  check('7. the volunteer’s button says Suggest', await sent.getByRole('button', { name: 'Suggest' }).count() === 1);
  await sent.getByRole('button', { name: 'Suggest' }).click();
  await vp.locator('.toast', { hasText: 'Suggested' }).waitFor({ timeout: 10000 });
  const pubText = async () => (await (await fetch(`${BASE}/site/pa/about`)).text());
  check('7. the public page does not change for a suggestion', !(await pubText()).includes(fixed));
  await vp.getByRole('button', { name: 'Suggested' }).click();
  const mine = vp.locator('.lg-sent', { hasText: fixed }).first();
  await mine.waitFor({ timeout: 10000 });
  check('7. Looks right is not offered on one’s own suggestion', await mine.getByRole('button', { name: 'Looks right' }).count() === 0);
  await both('sentences-suggested-volunteer', vp);
  await go('/website/languages/pa');
  await page.getByRole('button', { name: 'Suggested' }).click();
  const theirs = page.locator('.lg-sent', { hasText: fixed }).first();
  await theirs.waitFor({ timeout: 10000 });
  await both('sentences-suggested');
  await theirs.getByRole('button', { name: 'Looks right' }).click();
  await page.locator('.toast', { hasText: 'Approved' }).waitFor({ timeout: 10000 });
  check('7. after Looks right the public page shows it at the next request', (await pubText()).includes(fixed));
  await act('site.page.publish', { id: about.id });
  await sleep(2500);
  check('7. and still after the manager republishes the page', (await pubText()).includes(fixed));
  await page.locator('#lg-edits-h').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/recent-edits-1440.png`, fullPage: false });
  // A sentence that won't translate, listed under Couldn't translate.
  // Names go as <span translate="no"> once Check translation found Google keeps them.
  fakeT.set({ drop: { contains: 'meets on Tuesdays', what: 'name' } });
  await act('site.post.save', { title: 'Harbour City Together meets on Tuesdays', excerpt: 'Harbour City Together meets on Tuesdays at the library.' }).then(async (r) => { if (r.json?.post?.id) await act('site.post.publish', { id: r.json.post.id }); });
  await waitFor(async () => (await api('/site/languages/pa/sentences?filter=failed')).json?.sentences?.length > 0, 60000);
  fakeT.set({ drop: null });
  await go('/website/languages/pa');
  await page.getByRole('button', { name: /Couldn’t translate/ }).click();
  await page.locator('.lg-sent__why').first().waitFor({ timeout: 10000 }).catch(() => {});
  const why = await page.locator('.lg-sent__why').allInnerTexts();
  check('a sentence that won’t translate is listed with its reason', why.length > 0 && why.every((w) => w.trim().length > 0), JSON.stringify(why));
  await both('sentences-failed');

  // ── 8. Remembered: a page then a menu link; the browser closed; / lands on /pa/; English tapped stays ──
  const r1 = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const rp = await r1.newPage();
  await rp.goto(`${BASE}/site/pa/about`, { waitUntil: 'networkidle' });
  const menuLink = rp.locator('header a[href^="/site/pa/"]:not(.lang-switch a)').first();
  if (await menuLink.count()) await Promise.all([rp.waitForLoadState('load'), menuLink.click()]);
  const kept = await r1.storageState();
  await r1.close();
  const r2 = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, storageState: kept });
  const rp2 = await r2.newPage();
  await rp2.goto(`${BASE}/site/`, { waitUntil: 'networkidle' });
  check('8. reopened, / lands on /pa/', /\/site\/pa\/$/.test(rp2.url()), rp2.url());
  const before = JSON.stringify((await r2.cookies()).filter((c) => c.name === 'site_lang'));
  await rp2.locator('.lang-switch a', { hasText: 'English' }).hover();
  await sleep(1500);
  const hovered = JSON.stringify((await r2.cookies()).filter((c) => c.name === 'site_lang'));
  await Promise.all([rp2.waitForURL(/lang=en/, { timeout: 10000 }), rp2.locator('.lang-switch a', { hasText: 'English' }).click()]);
  await rp2.goto(`${BASE}/site/`, { waitUntil: 'networkidle' });
  check('8. hovering English changes nothing; tapped, the next visit stays English', before === hovered && /\/site\/$/.test(rp2.url()), JSON.stringify({ url: rp2.url(), same: before === hovered }));
  await r2.close();

  // ── 9. A live microsite at dougdidnt.test: the switch and /pa/ ──
  const m = (await act('site.microsite.create', { name: 'Doug Didn’t Example', domain: DOUG })).json.microsite;
  const mHome = (await db.query('select id from site_pages where site_id = $1', [m.id])).rows[0];
  await act('site.page.publish', { id: mHome.id });
  const live = await act('site.microsite.live', { id: m.id, live: true });
  await act('site.translate.now', {});
  await waitFor(async () => (await api(`/site/microsites/${m.id}`)).json?.waiting?.pa === 0, 60000);
  const mp = await pub.newPage();
  await mp.goto(`http://${DOUG}:${PORT}/`, { waitUntil: 'networkidle' });
  const mSwitch = await mp.locator('.lang-switch a').count();
  await mp.goto(`http://${DOUG}:${PORT}/pa/`, { waitUntil: 'networkidle' });
  const mLang = await mp.evaluate(() => document.documentElement.lang);
  for (const [w, h] of [[1440, 900], [390, 844]]) { await mp.setViewportSize({ width: w, height: h }); await mp.screenshot({ path: `${SHOTS}/microsite-pa-${w}.png` }); }
  check('9. the microsite shows the switch and /pa/ works there', live.status === 200 && mSwitch === 4 && mLang === 'pa', JSON.stringify({ live: live.status, mSwitch, mLang }));
  await go(`/website/sites/${m.id}`);
  check('the website’s overview says what is waiting per language', /ਪੰਜਾਬੀ: (all translated|\d+ waiting)/.test(await text()));

  // ── 10. 繁體 turned off ──
  await go('/website/languages/zh-Hant');
  await page.getByRole('button', { name: /More for/ }).click();
  await page.getByRole('button', { name: 'Turn off' }).click();
  await page.getByRole('button', { name: 'Yes' }).click();
  await page.locator('.toast', { hasText: 'is off' }).waitFor({ timeout: 10000 });
  const off = await fetch(`${BASE}/site/zh-hant/about`, { redirect: 'manual' });
  const en2 = await (await fetch(`${BASE}/site/about`)).text();
  const segs = [...en2.matchAll(/<nav class="lang-switch"[\s\S]*?<\/nav>/g)][0]?.[0] || '';
  check('10. 繁體 off: /zh-hant/about lands on /about; the switch has three segments with 中文',
    off.status === 302 && off.headers.get('location') === '/site/about' && (segs.match(/<a /g) || []).length === 3 && segs.includes('中文'), JSON.stringify({ status: off.status, loc: off.headers.get('location') }));

  check('every desk screen: no sideways scroll, 48 px targets on a phone', phoneIssues.length === 0, JSON.stringify(phoneIssues));
  check('no page errors on the desk', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('the suite ran to the end', false, e.stack || e.message);
}
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
await finish(failed ? 1 : 0);
