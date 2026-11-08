// Base Ground brand E2E — a fresh in-memory server, a manager on a laptop
// and a volunteer on a 390×844 phone, with the sample campaign loaded:
//   · the first paint is already in the brand: index.html carries the
//     brand's <style> (Ground until anything is saved), the app's tokens
//     and font come from it, and the top bar shows the campaign's name;
//   · Settings → Brand: a preset fills the fields, the preview takes the
//     draft at once (and nothing else does), a low-contrast pair is flagged
//     with its ratio and saving it asks first; Save puts the new look on the
//     open app at once (the top bar's colour, the <style>), and every page
//     the server sends after carries it (index.html, the unsubscribe page);
//   · the field: rating buttons at least 72px tall, no sideways scroll.
// Screenshots of the field Today, the map, the desk dashboard, the Brand
// page and the sign-in page, in Ground and in Night, go to SHOTS.
//
//   node e2e-brand.mjs                    (starts its own server on :4131)
//   SHOTS=/tmp/x node e2e-brand.mjs
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const PORT = Number(process.env.PORT) || 4131;
const SHOTS = process.env.SHOTS || '/tmp/ground-brand-shots';
mkdirSync(SHOTS, { recursive: true });

let server = null;
let BASE = process.env.BASE;
if (!BASE) {
  server = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, BASE_OPEN_SIGNUP: '1', BASE_DATA: 'memory', PORT: String(PORT), BASE_JOBS: 'off' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  process.on('exit', () => server.kill());
  process.on('unhandledRejection', (e) => { console.error(e); process.exit(1); });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 30000);
    server.stdout.on('data', (b) => { if (/Base Ground on :/.test(String(b))) { clearTimeout(t); resolve(); } });
    server.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
  BASE = `http://127.0.0.1:${PORT}`;
}
const ADMIN = `${BASE}/admin`;

const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 220) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Math.random().toString(36).slice(2, 8);
const tileSvg = () => '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e7e3d6"/><path d="M0 128h256M128 0v256" stroke="#d4cfbf" stroke-width="6"/></svg>';
const routeTiles = (c) => c.route(/tile\.openstreetmap\.org/, (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: tileSvg() }));

const browser = await chromium.launch({
  executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const errors = [];
const api = (ctx) => async (path, body) => {
  const r = body === undefined ? await ctx.request.get(`${BASE}/api${path}`) : await ctx.request.post(`${BASE}/api${path}`, { data: body });
  return { status: r.status(), json: await r.json().catch(() => null) };
};
const rootVar = (page, name) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

// ── A manager, the sample campaign, a volunteer ──
const dctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, timezoneId: 'America/Vancouver' });
await routeTiles(dctx);
const dp = await dctx.newPage();
dp.on('pageerror', (e) => errors.push(e.message));
const D = api(dctx);

await dp.goto(`${ADMIN}/signup`, { waitUntil: 'domcontentloaded' });
const firstHtml = await (await dctx.request.get(`${BASE}/admin/signup`)).text();
check('index.html carries the brand’s <style> in <head> (Ground: forest green)', /<style id="base-brand"[^>]*>html:root\{[^<]*--mark:#17462b/.test(firstHtml) && firstHtml.indexOf('id="base-brand"') < firstHtml.indexOf('</head>'));
await dp.waitForSelector('#su-name');
await dp.fill('#su-name', 'Riley Desk');
if (await dp.locator('#su-org').count()) await dp.fill('#su-org', 'Imagine Surrey');
await dp.fill('#su-email', `desk+${tag}@example.org`);
await dp.fill('#su-password', 'surrey-forward-2026');
await dp.click('button[type="submit"]');
await dp.waitForURL(/\/admin\/?$/, { timeout: 15000 });
check('the sample campaign loads', (await D('/data/sample', {})).status === 200);

const inv = (await D('/actions/member.invite', { email: `vol+${tag}@example.org`, role: 'volunteer' })).json;
const vctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/Vancouver' });
await routeTiles(vctx);
const vp = await vctx.newPage();
vp.on('pageerror', (e) => errors.push('[vol] ' + e.message));
const V = api(vctx);
await vp.goto(inv.joinUrl.replace(/^https?:\/\/[^/]+/, BASE), { waitUntil: 'domcontentloaded' });
await vp.waitForSelector('#join-name', { timeout: 8000 });
await vp.fill('#join-name', 'Jas Volunteer');
await vp.fill('#join-password', 'knock-knock-2026');
await vp.click('button[type="submit"]');
await vp.waitForURL((u) => !/\/join\//.test(String(u)), { timeout: 15000 }).catch(() => {});
const volId = (await V('/auth/me')).json.user.id;
const turfs = (await D('/turfs')).json.turfs || [];
if (turfs[0]) await D('/actions/turf.assign', { turf_id: turfs[0].id, user_id: volId });
check('a volunteer on a turf of the sample', turfs.length > 0);

// ── Screens in a look ──
const shoot = async (look) => {
  await vp.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await vp.waitForSelector('.nav .brand', { timeout: 10000 });
  await sleep(1500);
  await vp.screenshot({ path: `${SHOTS}/${look}-1-field-today.png`, fullPage: false });
  const ov = await vp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(`${look}: field Today has no sideways scroll at 390px`, ov <= 0, ov);

  await vp.goto(`${BASE}/map`, { waitUntil: 'domcontentloaded' });
  await vp.waitForSelector('.map-canvas', { timeout: 10000 });
  await sleep(2500);
  await vp.screenshot({ path: `${SHOTS}/${look}-2-field-map.png` });
  // Open a door: the rating buttons.
  const pin = vp.locator('.map-pin').first();
  if (await pin.count()) {
    await pin.click({ force: true }).catch(() => {});
    await sleep(1200);
    const hs = await vp.$$eval('.rb-btn', (els) => els.filter((e) => e.offsetParent).map((e) => Math.round(e.getBoundingClientRect().height)));
    if (hs.length) check(`${look}: door-rating buttons at least 72px tall`, hs.every((h) => h >= 72), JSON.stringify(hs));
    await vp.screenshot({ path: `${SHOTS}/${look}-3-field-map-door.png` });
  }

  await dp.goto(`${ADMIN}/`, { waitUntil: 'domcontentloaded' });
  await dp.waitForSelector('.nav .brand', { timeout: 10000 });
  await sleep(2500);
  await dp.screenshot({ path: `${SHOTS}/${look}-4-desk-dashboard.png` });

  await dp.goto(`${ADMIN}/settings/brand`, { waitUntil: 'domcontentloaded' });
  await dp.waitForSelector('.bs-preview', { timeout: 10000 });
  await sleep(1000);
  await dp.screenshot({ path: `${SHOTS}/${look}-5-desk-brand.png` });
  await dp.evaluate(() => document.querySelector('.bs-colors')?.scrollIntoView({ block: 'start' }));
  await sleep(300);
  await dp.screenshot({ path: `${SHOTS}/${look}-5b-desk-brand-colours.png` });

  // The other screens, to see nothing broke in the look (not checked here).
  for (const [i, path] of [['8a', '/people'], ['8b', '/shifts'], ['8c', '/outreach'], ['8d', '/money'], ['8e', '/settings']]) {
    await dp.goto(`${ADMIN}${path}`, { waitUntil: 'domcontentloaded' });
    await sleep(1800);
    await dp.screenshot({ path: `${SHOTS}/${look}-${i}-desk${path.replace(/\//g, '-')}.png` });
  }
  if (turfs[0]) {
    await vp.goto(`${BASE}/turfs/${turfs[0].id}`, { waitUntil: 'domcontentloaded' });
    await sleep(1800);
    await vp.screenshot({ path: `${SHOTS}/${look}-9a-field-walk-list.png` });
  }
  await vp.goto(`${BASE}/shifts`, { waitUntil: 'domcontentloaded' });
  await sleep(1500);
  await vp.screenshot({ path: `${SHOTS}/${look}-9b-field-shifts.png` });

  const lctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const lp = await lctx.newPage();
  await lp.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await lp.waitForSelector('#login-email');
  await sleep(800);
  await lp.screenshot({ path: `${SHOTS}/${look}-6-sign-in.png` });
  const signIn = await lp.$eval('.auth-page .brand', (el) => el.innerText.replace(/\s+/g, ' ').trim());
  await lctx.close();
  return { signIn };
};

// ── Ground (the default) ──
await vp.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await vp.waitForSelector('.nav .brand', { timeout: 10000 });
check('Ground on the phone: --mark is forest green, the font is Atkinson Hyperlegible',
  (await rootVar(vp, '--mark')) === '#17462b' && /Atkinson/.test(await vp.evaluate(() => getComputedStyle(document.body).fontFamily)));
check('the top bar shows the campaign’s name and Base Ground’s own mark',
  /Imagine Surrey/.test(await vp.$eval('.nav .brand', (el) => el.innerText)) && !!(await vp.$('.nav .brand svg.brand-mark--own')));
const g = await shoot('ground');
check('sign-in page: the campaign’s name and the mark', /Imagine Surrey/.test(g.signIn), g.signIn);

// ── The Brand page: preset, preview, contrast, confirm, save, live ──
await dp.goto(`${ADMIN}/settings/brand`, { waitUntil: 'domcontentloaded' });
await dp.waitForSelector('.bs-preview');
const navBefore = await dp.$eval('.nav', (el) => getComputedStyle(el).backgroundColor);
await dp.click('.bs-preset:has-text("Night")');
await sleep(300);
const pvMark = await dp.$eval('.bs-preview', (el) => getComputedStyle(el).getPropertyValue('--mark').trim());
check('picking Night fills the fields and the preview takes it — the app does not, yet',
  pvMark === '#6bd49a' && (await dp.inputValue('#bs-hex-primary')) === '#6bd49a' && (await dp.$eval('.nav', (el) => getComputedStyle(el).backgroundColor)) === navBefore);
await dp.fill('#bs-hex-onPrimary', '#5fbf8a');
await sleep(300);
const lowRows = await dp.$$eval('.bs-pair.is-low', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ')));
check('a low pair is flagged with its ratio and its line', lowRows.some((r) => /Text on primary/.test(r) && /\d\.\d\d:1/.test(r) && /needs 4\.5:1/.test(r)), JSON.stringify(lowRows));
await dp.click('.bs-save');
await sleep(400);
const ask = await dp.$eval('.bs-ask', (el) => el.innerText.replace(/\s+/g, ' ')).catch(() => '');
check('Save with a low pair asks first — nothing saved yet', /under the contrast line/.test(ask) && (await D('/brand')).json.source === 'default', ask);
await dp.click('.bs-ask button:has-text("Keep editing")');
await dp.fill('#bs-hex-onPrimary', '#06140c');
await dp.fill('#bs-name', 'Imagine Surrey Field');
await sleep(300);
check('fixed: every pair reads again', (await dp.$$('.bs-pair.is-low')).length === 0);
await dp.click('.bs-save');
await dp.waitForSelector('.bs-saved', { timeout: 8000 });
const saved = (await D('/brand')).json;
check('saved: Night, with the name', saved.source === 'saved' && saved.brand.preset === 'night' && saved.name === 'Imagine Surrey Field');
await sleep(300);
const navAfter = await dp.$eval('.nav', (el) => getComputedStyle(el).backgroundColor);
check('the open app took the new look at once: the bar colour and the name', navAfter !== navBefore && /Imagine Surrey Field/.test(await dp.$eval('.nav .brand', (el) => el.innerText)), `${navBefore} → ${navAfter}`);
const ev = (await D('/events?since=0&limit=5000')).json.events.filter((e) => e.action === 'brand.save');
check('on the event log: brand.save, a workspace update', ev.length === 1 && ev[0].entity_type === 'workspace');
const html2 = await (await dctx.request.get(`${BASE}/map`)).text();
check('every page the server sends now carries Night', /--mark:#6bd49a/.test(html2) && /color-scheme:dark/.test(html2) && /data-name="Imagine Surrey Field"/.test(html2));

// The public unsubscribe page in the brand.
await D('/actions/subscription.add', { email: `reader+${tag}@example.org`, name: 'Reader' });
const sub = (await D('/subscriptions')).json.subscriptions.find((s) => s.email === `reader+${tag}@example.org`);
const pub = await (await dctx.request.get(`${BASE}/u/${sub.id}`)).text();
check('the unsubscribe page wears the brand', /--mark:#6bd49a/.test(pub) && /Imagine Surrey Field/.test(pub));
const pubPage = await dctx.newPage();
await pubPage.setViewportSize({ width: 390, height: 700 });
await pubPage.goto(`${BASE}/u/${sub.id}`);
await pubPage.screenshot({ path: `${SHOTS}/night-7-public-unsubscribe.png` });
await pubPage.close();

// ── Night ──
const n = await shoot('night');
check('sign-in page: the saved name', /Imagine Surrey Field/.test(n.signIn), n.signIn);
check('Night on the phone: dark page, light text', (await rootVar(vp, '--paper')) === '#0e1511' && (await rootVar(vp, '--ink')) === '#e9f1eb');

// ── Harvest, the brand page only (the warm one, round corners, serif headlines) ──
await dp.goto(`${ADMIN}/settings/brand`, { waitUntil: 'domcontentloaded' });
await dp.waitForSelector('.bs-preview');
await dp.click('.bs-preset:has-text("Harvest")');
await sleep(300);
await dp.click('.bs-save');
await dp.waitForSelector('.bs-saved', { timeout: 8000 });
await sleep(500);
await dp.evaluate(() => window.scrollTo(0, 0));
await sleep(300);
await dp.screenshot({ path: `${SHOTS}/harvest-5-desk-brand.png` });
await dp.goto(`${ADMIN}/`, { waitUntil: 'domcontentloaded' });
await sleep(2500);
await dp.screenshot({ path: `${SHOTS}/harvest-4-desk-dashboard.png` });
await vp.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await sleep(1500);
await vp.screenshot({ path: `${SHOTS}/harvest-1-field-today.png` });

// Back to Ground for whoever looks next.
await D('/actions/brand.clear', {});

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
if (server) server.kill();
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed · shots in ${SHOTS}`);
process.exit(failed ? 1 : 0);
