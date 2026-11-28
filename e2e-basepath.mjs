// base.win under a client's path: BASE_PATH=/imaginesurrey.
// The field app at /imaginesurrey/field, the desk at /imaginesurrey/desk;
// lazy screens load; the service worker's scope, the caches and every key
// kept on the phone are the client's own; the sign-in cookie is kept to the
// client's path; an old /admin link and the bare path go where they should.
// Last, an update under the client's path with work still on the phone: the
// app as it was before its new name (its keys, lock, caches and worker under
// the older names in shared/old-names.js, all with the client's name) saves
// three knocks and a note with no signal; the new app replaces it, and the
// server gets each one exactly once; the tiles kept before still draw with
// the network blocked.
//
//   BASE_BRAND=imagine-surrey BASE_OPEN_SIGNUP=1 BASE_DATA=memory BASE_PATH=/imaginesurrey PORT=4141 node server/index.js &
//   BASE=http://127.0.0.1:4141 SHOTS=/tmp/bp node e2e-basepath.mjs
//   (a server started from this checkout: the update case serves the older
//   app from its web/dist for a while, and puts this build back even when the
//   run fails. The older app is built once from git, UPGRADE_REV, default
//   82c8990, into node_modules/.cache/base-win-upgrade/; UPGRADE_FROM=<dir>
//   uses a build made elsewhere.)
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { OLD_STORAGE } from './shared/old-names.js';

// ── The older app, for the update case ──
const HERE = fileURLToPath(new URL('.', import.meta.url));
const CACHE = `${HERE}node_modules/.cache/base-win-upgrade`;
const olderBuild = () => {
  if (process.env.UPGRADE_FROM) return process.env.UPGRADE_FROM;
  const rev = process.env.UPGRADE_REV || '82c8990';
  const dir = `${CACHE}/${rev}`;
  if (!existsSync(`${dir}/web/dist/index.html`)) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const tar = execFileSync('git', ['archive', rev, 'web/src', 'web/public', 'web/index.html', 'web/vite.config.js', 'shared'], { cwd: HERE, maxBuffer: 1 << 28 });
    execFileSync('tar', ['-x', '-C', dir], { input: tar });
    execFileSync(process.execPath, [`${HERE}node_modules/vite/bin/vite.js`, 'build', '--logLevel', 'warn'], { cwd: `${dir}/web`, stdio: ['ignore', 'ignore', 'inherit'] });
  }
  return `${dir}/web/dist`;
};
// The server reads web/dist from disk on every request: another build is
// served by putting it there, and this one goes back afterwards.
const DIST = `${HERE}web/dist`;
const THIS_BUILD = `${CACHE}/this-build`;
let swapped = false;
const serveBuild = (dir) => {
  if (!swapped) { rmSync(THIS_BUILD, { recursive: true, force: true }); cpSync(DIST, THIS_BUILD, { recursive: true }); swapped = true; }
  rmSync(DIST, { recursive: true, force: true });
  cpSync(dir, DIST, { recursive: true });
};
const serveThisBuild = () => {
  if (!swapped) return;
  rmSync(DIST, { recursive: true, force: true });
  cpSync(THIS_BUILD, DIST, { recursive: true });
  swapped = false;
};
process.on('exit', serveThisBuild);
// The older app's names, from the table (never typed out here).
const OLD = { ns: OLD_STORAGE.prefix, cache: `${OLD_STORAGE.rootLock.split('-')[0]}-` };

const ORIGIN = process.env.BASE || 'http://localhost:3200';
const P = '/imaginesurrey';
const SHOTS = process.env.SHOTS || '/tmp/base-win-basepath';
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
check('its caches carry the client’s name', sw.caches.length > 0 && sw.caches.every((n) => n.startsWith('base-win-imaginesurrey-')), JSON.stringify(sw.caches));
// The app's face, kept for no signal: the fonts and the campaign's logo, at
// the client's own addresses, and its shades in the page with no address in them.
await page.waitForFunction(async () => { const n = (await caches.keys()).find((k) => /-assets-/.test(k)); return n ? (await (await caches.open(n)).keys()).some((r) => /\/fonts\//.test(r.url)) : false; }, null, { timeout: 10000 }).catch(() => {});
const face = await page.evaluate(async () => {
  const cache = await caches.open((await caches.keys()).find((k) => /-assets-/.test(k)));
  const logo = document.querySelector('.nav img.brand-mark');
  return { kept: (await cache.keys()).map((r) => new URL(r.url).pathname).filter((x) => !/\/assets\//.test(x)).sort(), logo: logo?.getAttribute('src') || null, block: document.getElementById('brand')?.textContent || '' };
});
check('the worker keeps the fonts and the logo at the client’s addresses', face.kept.includes(`${P}/fonts/fonts.css`) && face.kept.includes(`${P}/fonts/inter-latin.woff2`)
  && (!face.logo || (face.logo.startsWith(`${P}/`) && face.kept.includes(face.logo))) && face.kept.every((x) => x.startsWith(`${P}/`)), JSON.stringify(face.kept));
check('the brand’s shades in the page carry no address', !/url\(|\/\//.test(face.block), face.block.slice(0, 80));
const keys = await page.evaluate(() => Object.keys(localStorage));
check('every key kept on the phone is the client’s', keys.length > 0 && keys.every((k) => k.startsWith('base-win:imaginesurrey:')), JSON.stringify(keys));
const manifest = await (await ctx.request.get(`${ORIGIN}${P}/manifest.webmanifest`)).json();
check('installed, it opens the field app, within the client’s path', manifest.start_url === `${P}/field/map` && manifest.scope === `${P}/` && manifest.id === `${P}/`, JSON.stringify(manifest));
await page.screenshot({ path: `${SHOTS}/01-field.png` });

check('nothing the app asked for was missing (no 404s)', failed.length === 0, failed.join(', '));

// ── An update under the client's path, with work on the phone ──
const api = async (path, body) => {
  const r = body === undefined ? await ctx.request.get(`${ORIGIN}${P}/api${path}`) : await ctx.request.post(`${ORIGIN}${P}/api${path}`, { data: body });
  return r.json().catch(() => null);
};
const doors = [];
for (const [name, lat, lng] of [['Lena Ortiz', 49.1331, -122.8495], ['Omar Haddad', 49.1310, -122.8520], ['Wren Castillo', 49.1295, -122.8480], ['Ike Moreau', 49.1300, -122.8510]]) {
  doors.push((await api('/actions/person.create', { name, address: `${doors.length + 1} Example St`, lat, lng })).person);
}
serveBuild(olderBuild());
const uctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
await uctx.addCookies(await ctx.cookies());
// OpenStreetMap's tiles (this server's map), with a switch: off while the
// new app comes in, so the only tiles it can draw offline afterwards are the
// ones kept before.
let tilesDown = false;
const tileSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><!--e2e-tile--><rect width="256" height="256" fill="#e3e6d6"/></svg>';
await uctx.route(/tile\.openstreetmap\.org\//, (route) => (tilesDown ? route.abort('internetdisconnected')
  : route.fulfill({ status: 200, contentType: 'image/svg+xml', headers: { 'access-control-allow-origin': '*' }, body: tileSvg })));
const up = await uctx.newPage();
up.on('pageerror', (e) => errors.push('[update] ' + e.message));
const go = async (path) => { await up.goto(`${ORIGIN}${P}${path}`, { waitUntil: 'domcontentloaded' }); await sleep(1200); };
const waitDoors = () => up.waitForFunction(() => Number(document.querySelector('.map-canvas')?.dataset.doors || 0) >= 1, null, { timeout: 10000 }).catch(() => {});
await go('/desk/map');
await waitDoors();
await up.evaluate(() => navigator.serviceWorker.ready).catch(() => {});
await go('/desk/map');
await waitDoors();
await sleep(2500);
const before = await up.evaluate(async ([old, client]) => {
  const names = await caches.keys();
  const tiles = names.find((n) => n === `${old.cache}${client}-tiles-v2`);
  return { names, tiles: tiles ? (await (await caches.open(tiles)).keys()).length : 0, keys: Object.keys(localStorage) };
}, [OLD, P.slice(1)]);
check('the older app keeps the client’s caches and keys under its older names', before.tiles > 0 && before.names.every((n) => n.startsWith(`${OLD.cache}${P.slice(1)}-`))
  && before.keys.length > 0 && before.keys.every((k) => k.startsWith(`${OLD.ns}${P.slice(1)}:`)), JSON.stringify({ ...before, keys: before.keys.length }));
await uctx.setOffline(true);
for (const p of doors.slice(0, 3)) {
  await go(`/desk/map?person=${p.id}`);
  await up.waitForSelector('aside.door-card', { timeout: 8000 }).catch(() => {});
  await up.click('aside.door-card button[aria-label="1: Strong support"]').catch(() => {});
  await sleep(500);
}
const uNote = `Call after the game ${tag}`;
await go(`/desk/map?person=${doors[3].id}`);
await up.waitForSelector('aside.door-card', { timeout: 8000 }).catch(() => {});
await up.click('aside.door-card .fk-more__btn').catch(() => {});
await up.fill('#door-note', uNote).catch(() => {});
await up.click('aside.door-card button:has-text("Save note")').catch(() => {});
await sleep(600);
const waiting = await up.evaluate((k) => JSON.parse(localStorage.getItem(k) || '[]'), `${OLD.ns}${P.slice(1)}:outbox:v2`);
check('no signal, older app: three knocks and a note wait under the client’s older outbox name', waiting.length === 4 && waiting.every((i) => i.state === 'pending'), JSON.stringify(waiting.map((i) => i.name)));
serveThisBuild();
tilesDown = true;
await uctx.setOffline(false);
await go('/desk/map');
await up.evaluate(() => window.dispatchEvent(new Event('online')));
let after = null;
for (let i = 0; i < 40; i += 1) {
  after = await up.evaluate(async ([old, client]) => ({
    names: await caches.keys(),
    old: Object.keys(localStorage).filter((k) => k.startsWith(old.ns)),
    outbox: JSON.parse(localStorage.getItem(`base-win:${client}:outbox:v2`) || '[]').length,
  }), [OLD, P.slice(1)]).catch(() => null);
  if (after && !after.names.some((n) => n.startsWith(OLD.cache)) && after.old.length === 0 && after.outbox === 0) break;
  if (i === 10) await go('/desk/map'); // the new worker takes over by the next page
  await sleep(500);
}
const contacts = await Promise.all(doors.map(async (p) => (await api(`/persons/${p.id}`)).contacts));
check('after the update: the server has each knock exactly once', contacts.slice(0, 3).every((c) => c.length === 1 && c[0].rating === '1'), JSON.stringify(contacts.map((c) => c.length)));
check('…and the note exactly once', contacts[3].length === 1 && contacts[3][0].note === uNote, JSON.stringify(contacts[3]));
check('…nothing left under the older names, the outbox empty, every cache the client’s under the new name', after && after.old.length === 0 && after.outbox === 0
  && after.names.length > 0 && after.names.every((n) => n.startsWith(`base-win-${P.slice(1)}-`)), JSON.stringify(after));
await uctx.setOffline(true);
await go('/desk/map');
await waitDoors();
await sleep(1500);
const drawn = await up.$$eval('.leaflet-tile-loaded', (els) => els.filter((i) => i.complete && i.naturalWidth > 0).length).catch(() => 0);
check('network blocked: the map still draws the tiles kept before the update', drawn > 0, drawn);
await up.screenshot({ path: `${SHOTS}/02-update-offline-map.png` });
await uctx.close();

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
