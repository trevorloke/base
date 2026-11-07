// Base: the name, and the app switcher (Ground here; Web and Air linked).
// A fresh in-memory campaign; BASE_AIR_URL set, BASE_WEB_URL not, and the
// campaign's website set in Settings — so Web falls back to it + /admin.
//
//   STARBASE_OPEN_SIGNUP=1 STARBASE_DATA=memory BASE_AIR_URL=https://air.example.org PORT=4140 node server/index.js &
//   BASE=http://127.0.0.1:4140 SHOTS=/tmp/base node e2e-base.mjs
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:3200';
const SHOTS = process.env.SHOTS || '/tmp/starbase-base';
mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 220) : ''}`);
};
const tag = Math.random().toString(36).slice(2, 8);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(`${BASE}/login`);
check('sign-in says Base', (await page.innerText('.brand')).trim() === 'Base' && (await page.title()) === 'Base', await page.title());
await page.goto(`${BASE}/signup`);
await page.fill('#su-name', 'Marco Manager');
if (await page.locator('#su-org').count()) await page.fill('#su-org', 'Imagine Surrey');
await page.fill('#su-email', `marco+${tag}@base.example`);
await page.fill('#su-password', 'surrey-forward-2026');
await page.click('button[type="submit"]');
await page.waitForURL(/\/admin\/?$/, { timeout: 15000 });
await ctx.request.post(`${BASE}/api/actions/workspace.update`, { data: { website: 'https://imaginesurrey.example.org/' } }).catch(() => {});

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.brand-name', { timeout: 10000 });
check('the field app: Base Ground', /Base\s+Ground/.test(await page.innerText('.brand-name')), await page.innerText('.brand-name'));
await page.click('.apps-btn');
const items = await page.$$eval('.apps-item', (els) => els.map((e) => ({ text: e.innerText.replace(/\s+/g, ' ').trim(), href: e.getAttribute('href'), here: e.getAttribute('aria-current') })));
check('the switcher: Ground (here), Web, Air', items.length === 3 && /Base Ground · here/.test(items[0].text) && items[0].here === 'page'
  && /Base Web/.test(items[1].text) && /Base Air/.test(items[2].text), JSON.stringify(items));
check('Air links to BASE_AIR_URL', items[2].href === 'https://air.example.org', items[2].href);
const web = items[1];
check('Web: the campaign’s website + /admin (BASE_WEB_URL unset), or not linked yet', web.href === 'https://imaginesurrey.example.org/admin' || (/Not linked yet/.test(web.text) && !web.href), JSON.stringify(web));
await page.screenshot({ path: `${SHOTS}/01-switcher-desktop.png` });
await page.keyboard.press('Escape');
check('Escape closes it, focus back on the button', await page.isHidden('.apps-panel') && await page.evaluate(() => document.activeElement?.classList.contains('apps-btn')));

await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.brand-name', { timeout: 10000 });
check('the desk: Base Ground Admin', /Base\s+Ground\s+Admin/.test(await page.innerText('.brand-name')), await page.innerText('.brand-name'));

const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await phone.addCookies(await ctx.cookies());
const pp = await phone.newPage();
pp.on('pageerror', (e) => errors.push(`phone: ${e.message}`));
await pp.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await pp.waitForSelector('.apps-btn', { timeout: 10000 });
await pp.tap('.apps-btn');
const box = await pp.$eval('.apps-panel', (e) => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, w: window.innerWidth }; });
check('on a phone the switcher fits the screen', box.left >= 0 && box.right <= box.w, JSON.stringify(box));
await pp.screenshot({ path: `${SHOTS}/02-switcher-phone.png` });
const manifest = await (await ctx.request.get(`${BASE}/manifest.webmanifest`)).json();
check('installed, it is called Base', manifest.name === 'Base' && manifest.short_name === 'Base');
check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
