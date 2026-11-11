// The name: base.win, one product — no app switcher, and nothing called
// Ground, Web or Air. The campaign leads (its logo, or its initials and its
// name) and base.win is the small line under it: on sign-in, in the field
// app and on the desk; the page's title is base.win and, installed, it is
// base.win. On a phone the bars stay one row and a desk role's nine places
// are four tabs and "More". (e2e-platform.mjs walks every desk screen for
// the old names.)
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
check('the desk: the campaign leads, base.win under it', (await page.innerText('.brand-name')).trim() === 'base.win' && /Imagine Surrey/.test(await page.innerText('.brand-org')), await page.innerText('.nav .brand'));
// The campaign is named once for everyone: in its logo's alt text, or in words beside its initials.
const lead = await page.evaluate(() => { const img = document.querySelector('.nav .brand img'); return { alt: img?.alt ?? null, initials: document.querySelector('.nav .brand-mono')?.innerText.trim() ?? null, link: document.querySelector('.nav .brand').getAttribute('aria-label') }; });
check('the desk: the campaign’s logo (its name as alt text) or its initials; the link says the campaign first', (lead.alt === 'Imagine Surrey' || lead.initials === 'IS') && lead.link === 'Imagine Surrey — base.win', JSON.stringify(lead));
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
// A manager has nine places: the tab bar shows the first four and "More".
const tabs = await pp.$$eval('.tabbar > a, .tabbar .tab-more__btn', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { t: e.innerText.trim(), w: Math.round(r.width), h: Math.round(r.height) }; }));
check('on a phone a desk role gets four tabs and More, each a thumb wide', tabs.length === 5 && tabs[4]?.t === 'More' && tabs.every((t) => t.w >= 64 && t.h >= 48), JSON.stringify(tabs));
await pp.tap('.tab-more__btn');
const rest = await pp.$$eval('.tab-more__panel a', (els) => els.filter((e) => e.getBoundingClientRect().height >= 48).map((e) => e.innerText.trim()));
check('More opens the rest of the places, each a full row', rest.length === 5 && rest[0] === 'Donations' && rest.includes('Website') && (await pp.getAttribute('.tab-more__btn', 'aria-expanded')) === 'true', rest.join(' | '));
await pp.getByRole('link', { name: 'Donations' }).tap();
await pp.waitForURL(/\/admin\/money$/, { timeout: 8000 });
await pp.waitForSelector('.tab-more__btn.active', { timeout: 5000 }).catch(() => {});
check('a place under More opens, the sheet closes, and More is the tab you are on', (await pp.getAttribute('.tab-more__btn', 'aria-expanded')) === 'false'
  && await pp.locator('.tab-more__panel').isHidden() && /\bactive\b/.test(await pp.getAttribute('.tab-more__btn', 'class')), await pp.getAttribute('.tab-more__btn', 'class'));
// A screen's own "More" (Donations has one) stays the one button called
// exactly that: the tab says its label inside a longer name.
await pp.getByRole('button', { name: 'More', exact: true }).first().waitFor({ timeout: 8000 }).catch(() => {});
const mores = await pp.getByRole('button', { name: 'More', exact: true }).count();
const tabNamed = await pp.locator('.tabbar').getByRole('button', { name: 'More places', exact: true }).count();
check('on a phone a screen’s own More is the only button called “More”; the tab is “More places”', mores === 1 && tabNamed === 1, JSON.stringify({ mores, tabNamed }));
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
