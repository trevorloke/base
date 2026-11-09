// The name: base.win, one product — no app switcher, and nothing called
// Ground, Web or Air. Sign-in, the page's title, the field app and the
// desk say base.win with the campaign's own name under it; installed, it
// is base.win. (e2e-platform.mjs walks every desk screen for the old names.)
//
//   STARBASE_OPEN_SIGNUP=1 STARBASE_DATA=memory PORT=4140 node server/index.js &
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
const OLD = /\bGround\b|\bAir\b|Base Web|Starsign/;
const tag = Math.random().toString(36).slice(2, 8);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(`${BASE}/login`);
await page.waitForSelector('.auth-page .brand');
check('sign-in says base.win, in the tab too', (await page.innerText('.brand')).trim() === 'base.win' && (await page.title()) === 'base.win', await page.title());
await page.goto(`${BASE}/signup`);
await page.fill('#su-name', 'Marco Example');
if (await page.locator('#su-org').count()) await page.fill('#su-org', 'Imagine Surrey');
await page.fill('#su-email', `marco+${tag}@example.org`);
await page.fill('#su-password', 'surrey-forward-2026');
await page.click('button[type="submit"]');
await page.waitForURL(/\/admin\/?$/, { timeout: 15000 });
await page.waitForSelector('.brand-name', { timeout: 10000 });
check('the desk: base.win, the campaign under it', (await page.innerText('.brand-name')).trim() === 'base.win' && /Imagine Surrey/.test(await page.innerText('.brand-org')), await page.innerText('.nav .brand'));
check('the desk: no app switcher', await page.locator('.apps-btn, .apps-panel').count() === 0);
check('the desk’s header names nothing else', !OLD.test(await page.innerText('header.nav')), await page.innerText('header.nav'));
await page.screenshot({ path: `${SHOTS}/01-desk.png` });

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.brand-name', { timeout: 10000 });
check('the field app: base.win too', (await page.innerText('.brand-name')).trim() === 'base.win', await page.innerText('.brand-name'));
check('the field app: no switcher, no old names', await page.locator('.apps-btn').count() === 0 && !OLD.test(await page.innerText('header.nav')));
check('the field app has no command bar (it’s the desk’s)', await page.locator('.cmd-btn').count() === 0);

const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await phone.addCookies(await ctx.cookies());
const pp = await phone.newPage();
pp.on('pageerror', (e) => errors.push(`phone: ${e.message}`));
await pp.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
await pp.waitForSelector('.brand-name', { timeout: 10000 });
const bar = await pp.$eval('header.nav', (e) => e.getBoundingClientRect().height);
check('on a phone the top bar stays one row', bar < 80, bar);
const overflow = await pp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
check('on a phone: no sideways scroll', overflow <= 0, overflow);
await pp.screenshot({ path: `${SHOTS}/02-desk-phone.png` });
const manifest = await (await ctx.request.get(`${BASE}/manifest.webmanifest`)).json();
check('installed, it is called base.win', manifest.name === 'base.win' && manifest.short_name === 'base.win', JSON.stringify([manifest.name, manifest.short_name]));
const html = await (await ctx.request.get(`${BASE}/`)).text();
check('the page’s own title and home-screen name: base.win', /<title>base\.win<\/title>/.test(html) && /apple-mobile-web-app-title" content="base\.win"/.test(html));
check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
