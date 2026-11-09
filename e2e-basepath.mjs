// base.win under a client's path: BASE_PATH=/imaginesurrey.
// The field app at /imaginesurrey/field, the desk at /imaginesurrey/desk;
// lazy screens load; the service worker's scope, the caches and every key
// kept on the phone are the client's own; the sign-in cookie is kept to the
// client's path; an old /admin link and the bare path go where they should.
//
//   STARBASE_OPEN_SIGNUP=1 STARBASE_DATA=memory BASE_PATH=/imaginesurrey PORT=4141 node server/index.js &
//   BASE=http://127.0.0.1:4141 SHOTS=/tmp/bp node e2e-basepath.mjs
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const ORIGIN = process.env.BASE || 'http://localhost:3200';
const P = '/imaginesurrey';
const SHOTS = process.env.SHOTS || '/tmp/starbase-basepath';
mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 240) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Math.random().toString(36).slice(2, 8);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const errors = [];
const failed = [];
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('response', (r) => { if (r.status() === 404 && new URL(r.url()).origin === ORIGIN) failed.push(new URL(r.url()).pathname); });

await page.goto(`${ORIGIN}${P}`);
check('the client’s path opens the field app', new URL(page.url()).pathname.startsWith(`${P}/field`), page.url());
await page.goto(`${ORIGIN}${P}/field/signup`);
await page.waitForSelector('#su-name', { timeout: 15000 });
await page.fill('#su-name', 'Marco Manager');
if (await page.locator('#su-org').count()) await page.fill('#su-org', 'Imagine Surrey');
await page.fill('#su-email', `marco+${tag}@base.example`);
await page.fill('#su-password', 'surrey-forward-2026');
await page.click('button[type="submit"]');
await page.waitForURL(new RegExp(`${P}/desk/?$`), { timeout: 15000 }).catch(() => {});
check('signed up: the desk, at /imaginesurrey/desk', new URL(page.url()).pathname.replace(/\/$/, '') === `${P}/desk`, page.url());
const cookies = await ctx.cookies();
const sid = cookies.find((c) => c.httpOnly);
check('the sign-in cookie is kept to /imaginesurrey', sid && sid.path === P, JSON.stringify(cookies.map((c) => [c.name, c.path])));

const peopleLink = await page.getAttribute('nav.links a[href$="/people"]', 'href').catch(() => null);
check('the desk’s links are under /imaginesurrey/desk', peopleLink === `${P}/desk/people`, peopleLink);

await page.goto(`${ORIGIN}${P}/field/map`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.leaflet-container', { timeout: 15000 }).catch(() => {});
check('the field app’s Map (a lazy screen) loads', !!(await page.$('.leaflet-container')), page.url());
await page.goto(`${ORIGIN}${P}/admin/people`);
await page.waitForSelector('h1', { timeout: 10000 }).catch(() => {});
check('an old /admin link goes to /desk, and People shows', new URL(page.url()).pathname.startsWith(`${P}/desk/people`) && /People/i.test(await page.innerText('h1').catch(() => '')), page.url());

// The service worker: this client's scope, this client's caches.
await page.goto(`${ORIGIN}${P}/field/`, { waitUntil: 'load' });
await sleep(2500);
const sw = await page.evaluate(async () => {
  const regs = await navigator.serviceWorker.getRegistrations();
  return { scopes: regs.map((r) => new URL(r.scope).pathname), caches: await caches.keys() };
});
check('the service worker’s scope is /imaginesurrey/', sw.scopes.length === 1 && sw.scopes[0] === `${P}/`, JSON.stringify(sw));
check('its caches carry the client’s name', sw.caches.length > 0 && sw.caches.every((n) => n.startsWith('starbase-imaginesurrey-')), JSON.stringify(sw.caches));
const keys = await page.evaluate(() => Object.keys(localStorage));
check('every key kept on the phone is the client’s', keys.length > 0 && keys.every((k) => k.startsWith('starbase:imaginesurrey:')), JSON.stringify(keys));
const manifest = await (await ctx.request.get(`${ORIGIN}${P}/manifest.webmanifest`)).json();
check('installed, it opens the field app, within the client’s path', manifest.start_url === `${P}/field/map` && manifest.scope === `${P}/` && manifest.id === `${P}/`, JSON.stringify(manifest));
await page.screenshot({ path: `${SHOTS}/01-field.png` });

check('nothing the app asked for was missing (no 404s)', failed.length === 0, failed.join(', '));
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
