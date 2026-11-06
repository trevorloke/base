// Addresses that find their place — a fresh in-memory server and a stand-in
// for the BC Address Geocoder (a tiny local server: the real one is never
// asked). A manager on a phone taps "+ Door": the form opens at once; typing
// "13450 104" offers the door, a pick fills it in and drops the pin where it
// is; a typed address nobody picked is found when it's saved; with no
// signal the pin is a tap on the map, and the door is sent once. At the
// desk: "Add person" opens (it used to crash) and a picked address pins
// them; the profile's Edit at the top opens the form on the name, saves only
// what changed, and a new address moves the pin (picked) or is found after
// the save (typed); a sign at an address takes that address's pin. Every
// claim is checked against the API; each new form is measured.
//
//   node e2e-addresses.mjs                          (starts its own server on :4120)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';

const PORT = Number(process.env.PORT) || 4120;
const SHOTS = process.env.SHOTS || '/tmp/starbase-addresses';
mkdirSync(SHOTS, { recursive: true });

// ── The stand-in address service ──
const feature = (n, street, type, lng, lat) => ({
  geometry: { coordinates: [lng, lat] },
  properties: { civicNumber: n, civicNumberSuffix: '', streetName: street, streetType: type, streetDirection: '',
    localityName: 'Surrey', fullAddress: `${n} ${street} ${type}, Surrey, BC`, matchPrecision: 'CIVIC_NUMBER', score: 96 },
});
const BOOK = {
  '13450 104 Ave': feature(13450, '104', 'Ave', -122.8466, 49.1906),
  '13460 104 Ave': feature(13460, '104', 'Ave', -122.8461, 49.1907),
  '10355 King George Blvd': feature(10355, 'King George', 'Blvd', -122.8433, 49.1872),
  '7452 132 St': feature(7452, '132', 'St', -122.8475, 49.1371),
};
const fake = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const q = (u.searchParams.get('addressString') || '').toLowerCase().replace(/,.*$/, '').trim();
  const hits = u.searchParams.get('autoComplete') === 'true'
    ? Object.entries(BOOK).filter(([k]) => k.toLowerCase().includes(q)).map(([, f]) => f)
    : Object.entries(BOOK).filter(([k]) => q.startsWith(k.toLowerCase())).map(([, f]) => f).slice(0, 1);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ features: hits }));
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const FAKE = `http://127.0.0.1:${fake.address().port}`;

let server = null;
let BASE = process.env.BASE;
const ADMIN = { toString() { return `${BASE}/admin`; } };
if (!BASE) {
  server = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, STARBASE_OPEN_SIGNUP: '1', STARBASE_DATA: 'memory', PORT: String(PORT), STARBASE_JOBS: 'off',
      GEOCODER: 'bc', BC_GEOCODER_URL: FAKE, GEOCODE_ON_SAVE: 'on' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 30000);
    server.stdout.on('data', (b) => { if (/starbase on :/.test(String(b))) { clearTimeout(t); resolve(); } });
    server.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
  BASE = `http://127.0.0.1:${PORT}`;
}
// However it ends, the server and the stand-in go with it.
process.on('exit', () => { server?.kill(); });
process.on('unhandledRejection', (e) => { console.log(`FAIL  stopped: ${e?.message || e}`); process.exit(1); });

const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 220) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Math.random().toString(36).slice(2, 8);
const until = async (fn, ms = 6000) => { for (const end = Date.now() + ms; Date.now() < end;) { const v = await fn(); if (v) return v; await sleep(150); } return fn(); };
const tileSvg = () => '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e7e3d6"/></svg>';
const routeTiles = (c) => c.route(/tile\.openstreetmap\.org/, (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: tileSvg() }));

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const errors = [];
const measure = (page, sel = null) => page.evaluate((targets) => {
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const yellow = [...document.querySelectorAll('.btn-primary')].filter(visible).length;
  const overflow = document.documentElement.scrollWidth - window.innerWidth;
  let minTap = null;
  if (targets) for (const el of document.querySelectorAll(targets)) { if (!visible(el)) continue; const h = el.getBoundingClientRect().height; minTap = minTap == null ? h : Math.min(minTap, h); }
  return { yellow, overflow, minTap };
}, sel);

// ── 1. A manager, signed in on a phone and at the desk ──
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/Vancouver' });
await routeTiles(ctx);
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(`phone: ${e.message}`));
const api = async (path, body) => {
  const r = body === undefined ? await ctx.request.get(`${BASE}/api${path}`) : await ctx.request.post(`${BASE}/api${path}`, { data: body });
  return { status: r.status(), json: await r.json().catch(() => null) };
};
await page.goto(`${BASE}/signup`);
await page.fill('#su-name', 'Marco Manager');
if (await page.locator('#su-org').count()) await page.fill('#su-org', 'Imagine Surrey');
await page.fill('#su-email', `marco+${tag}@addresses.example`);
await page.fill('#su-password', 'surrey-forward-2026');
await page.click('button[type="submit"]');
await page.waitForURL(/\/admin\/?$/, { timeout: 15000 });
const findPerson = async (name) => (await api(`/persons?q=${encodeURIComponent(name)}`)).json.persons.find((p) => p.name === name);
const full = async (id) => (await api(`/persons/${id}`)).json.person;

// ── 2. The map: "+ Door", type, pick, the pin drops ──
await page.goto(`${ADMIN}/map`, { waitUntil: 'domcontentloaded' }); // the desk adds doors from the admin's map
await page.waitForSelector('.map-fab--add', { timeout: 15000 });
await sleep(800);
await page.tap('.map-fab--add');
await page.waitForSelector('form[aria-label="New door"]', { timeout: 5000 }).catch(() => {});
const banner = async () => ((await page.innerText('.map-mode').catch(() => '')) || '').replace(/\s+/g, ' ').trim();
check('+ Door opens the form at once, address first: "Type the address, or tap the new door"',
  !!(await page.$('form[aria-label="New door"] #nd-address')) && /Type the address, or tap the new door/.test(await banner()), await banner());
await page.fill('#nd-address', '13450 104');
await page.waitForSelector('.af-list .af-opt', { timeout: 5000 }).catch(() => {});
const opts = await page.$$eval('.af-list .af-opt', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
check('typing "13450 104" offers the door, with its city', opts.length === 1 && /^13450 104 Ave Surrey$/.test(opts[0]), opts.join(' | '));
let m = await measure(page, '.af-opt, .door-act');
check('the form at 390: one yellow, no sideways scroll, choices and buttons ≥ 48px', m.yellow === 1 && m.overflow <= 0 && m.minTap >= 48, JSON.stringify(m));
await page.screenshot({ path: `${SHOTS}/01-door-suggest.png` });
await page.tap('.af-list .af-opt');
await sleep(500);
const note = async (id) => ((await page.innerText(`#${id}-af-note`).catch(() => '')) || '').trim();
check('a pick: the address filled in, "✓ Pinned on the map", the new pin on the map, "Tap the map to move the pin"',
  (await page.inputValue('#nd-address')) === '13450 104 Ave' && /Pinned on the map/.test(await note('nd-address'))
  && !!(await page.$('.map-new-pin')) && /move the pin/.test(await banner()), `${await page.inputValue('#nd-address')} · ${await note('nd-address')} · ${await banner()}`);
const pinInView = await page.evaluate(() => {
  const pin = document.querySelector('.map-new-pin')?.getBoundingClientRect();
  const sheet = document.querySelector('.map-sheet')?.getBoundingClientRect();
  return Boolean(pin && sheet && pin.bottom <= sheet.top && pin.top >= 0);
});
check('…and the pin shows above the form, not under it', pinInView);
await page.screenshot({ path: `${SHOTS}/02-door-picked.png` });
await page.fill('#nd-first', 'Harjit'); await page.fill('#nd-last', 'Example');
await page.tap('form[aria-label="New door"] button[type="submit"]');
await sleep(1200);
let p = await findPerson('Harjit Example');
check('Add door: the person at the picked address and its pin (city Surrey)', p && p.address === '13450 104 Ave' && Number(p.lat) === 49.1906 && Number(p.lng) === -122.8466 && p.city === 'Surrey', JSON.stringify(p));

// A typed address nobody picked: found when it's saved. (The new door's card
// is open on a phone; it closes first, as anyone would.)
const addAnother = async () => {
  if (await page.$('.mapsheet-close')) { await page.tap('.mapsheet-close').catch(() => {}); await sleep(400); }
  await page.tap('.map-fab--add');
};
await addAnother();
await page.waitForSelector('#nd-address', { timeout: 5000 });
await page.fill('#nd-address', '13460 104 Ave');
await page.fill('#nd-first', 'Maya'); await page.fill('#nd-last', 'Example');
await sleep(600);
await page.tap('form[aria-label="New door"] button[type="submit"]');
await sleep(1500);
p = await findPerson('Maya Example');
check('typed and not picked: found on save, pinned where the address is', p && Number(p.lat) === 49.1907 && Number(p.lng) === -122.8461, JSON.stringify(p));
// An address the service doesn't know: said, nothing saved.
await addAnother();
await page.waitForSelector('#nd-address', { timeout: 5000 });
await page.fill('#nd-address', '1 Nowhere Rd');
await page.fill('#nd-first', 'Nobody'); await page.fill('#nd-last', 'Example');
await sleep(600);
await page.tap('form[aria-label="New door"] button[type="submit"]');
await sleep(1000);
const err = ((await page.innerText('form[aria-label="New door"] .error').catch(() => '')) || '').trim();
check('an address nobody knows: "Couldn’t find that address — pick one from the list, or tap the map…", not saved',
  /Couldn’t find that address/.test(err) && !(await findPerson('Nobody Example')), err);
// …so tap the map: the pin drops there, and the door is saved with it.
// The free part of the map: between the mode banner and the form's sheet.
const freeSpot = () => page.evaluate(() => {
  const map = document.querySelector('.leaflet-container').getBoundingClientRect();
  const sheet = document.querySelector('.map-sheet')?.getBoundingClientRect();
  const top = (document.querySelector('.map-top')?.getBoundingClientRect().bottom || map.top) + 10;
  const bottom = sheet ? sheet.top - 10 : map.bottom;
  return { x: map.left + map.width / 2, y: (top + bottom) / 2, room: bottom - top };
});
const box = await freeSpot();
check('the form leaves room to tap the map on a phone (≥ 120px)', box.room >= 120, JSON.stringify(box));
await page.mouse.click(box.x, box.y);
await sleep(500);
check('a tap drops the pin: "✓ Pinned on the map"', /Pinned on the map/.test(await note('nd-address')) && !!(await page.$('.map-new-pin')), await note('nd-address'));
await page.tap('form[aria-label="New door"] button[type="submit"]');
await sleep(1200);
p = await findPerson('Nobody Example');
check('…and the door is saved where it was tapped', p && p.lat != null && p.address === '1 Nowhere Rd', JSON.stringify(p));

// No signal: no suggestions; the pin is a tap; sent once when the signal is back.
await addAnother();
await page.waitForSelector('#nd-address', { timeout: 5000 });
await ctx.setOffline(true);
await page.evaluate(() => window.dispatchEvent(new Event('offline')));
await sleep(300);
await page.fill('#nd-address', '7452 132');
await sleep(800);
check('no signal: nothing offered, "No signal — tap the map where the door is"', !(await page.$('.af-list')) && /No signal — tap the map where the door is/.test(await note('nd-address')), await note('nd-address'));
await page.fill('#nd-address', '7452 132 St');
await page.fill('#nd-first', 'Offline'); await page.fill('#nd-last', 'Example');
await page.tap('form[aria-label="New door"] button[type="submit"]');
await sleep(500);
const err2 = ((await page.innerText('form[aria-label="New door"] .error').catch(() => '')) || '').trim();
check('…saving with no pin says to tap the map', /No signal — tap the map/.test(err2), err2);
const box2 = await freeSpot();
await page.mouse.click(box2.x + 30, box2.y);
await sleep(400);
await page.tap('form[aria-label="New door"] button[type="submit"]');
await sleep(800);
await ctx.setOffline(false);
await page.evaluate(() => window.dispatchEvent(new Event('online')));
p = await until(() => findPerson('Offline Example'));
check('…a tap, then Add door: kept on the phone and sent once with the pin', p && p.lat != null
  && (await api(`/persons?q=${encodeURIComponent('Offline Example')}`)).json.persons.length === 1, JSON.stringify(p));

// ── 3. The desk: Add person opens, and a picked address pins them ──
const dctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, timezoneId: 'America/Vancouver', storageState: await ctx.storageState() });
await routeTiles(dctx);
const desk = await dctx.newPage();
desk.on('pageerror', (e) => errors.push(`desk: ${e.message}`));
await desk.goto(`${ADMIN}/people?new=1`, { waitUntil: 'domcontentloaded' });
await desk.waitForSelector('#np-first', { timeout: 10000 }).catch(() => {});
check('People → Add person opens (no crash)', !!(await desk.$('#np-first')) && !errors.some((e) => /desk/.test(e)), errors.join(' | '));
await desk.fill('#np-first', 'Kim'); await desk.fill('#np-last', 'Example');
await desk.fill('#np-address', 'King George');
await desk.waitForSelector('.af-list .af-opt', { timeout: 5000 }).catch(() => {});
await desk.click('.af-list .af-opt');
await sleep(300);
check('a pick: "10355 King George Blvd", "✓ Pinned on the map"', (await desk.inputValue('#np-address')) === '10355 King George Blvd'
  && /Pinned on the map/.test(await desk.innerText('#np-address-af-note')), await desk.inputValue('#np-address'));
await desk.click('form.pp-add button[type="submit"]');
await desk.waitForURL(/\/people\/[0-9a-f-]{36}$/, { timeout: 8000 }).catch(() => {});
const kimId = desk.url().split('/').pop();
let kim = await full(kimId);
check('saved with its pin: the profile opens, on the map', kim?.address === '10355 King George Blvd' && Number(kim.lat) === 49.1872 && kim.city === 'Surrey', JSON.stringify(kim));

// ── 4. The profile: Edit at the top; only what changed; a new address moves the pin ──
await sleep(800);
await desk.click('.pf-edit');
await desk.waitForSelector('form[aria-label="Edit details"]', { timeout: 5000 }).catch(() => {});
const focused = await desk.evaluate(() => document.activeElement?.id);
check('Edit (top of the profile) opens the details form on the name', focused === 'ed-first', focused);
// Someone else changes the email meanwhile: a phone-only save must not undo it.
await api('/actions/person.update', { id: kimId, email: 'kim@example.org' });
await desk.fill('#ed-phone', '604-555-0177');
await desk.click('form[aria-label="Edit details"] button[type="submit"]');
await sleep(1200);
kim = await full(kimId);
check('Save sends only the phone: the other desk’s email stands, the pin stays',
  kim.phone === '604-555-0177' && kim.email === 'kim@example.org' && Number(kim.lat) === 49.1872, JSON.stringify(kim));
check('…and says "✓ Saved"', /✓ Saved/.test(await desk.innerText('.pf-saved').catch(() => '')));
await desk.click('.pf-edit');
await desk.waitForSelector('#ed-address', { timeout: 5000 });
await desk.fill('#ed-address', '13460 104');
await desk.waitForSelector('.af-list .af-opt', { timeout: 5000 }).catch(() => {});
await desk.click('.af-list .af-opt:has-text("13460 104 Ave")');
await sleep(300);
check('a new address picked: "✓ Pinned on the map"', /Pinned on the map/.test(await desk.innerText('#ed-address-af-note')));
await desk.click('form[aria-label="Edit details"] button[type="submit"]');
await sleep(1200);
kim = await full(kimId);
check('Save: the address and the pin move together', kim.address === '13460 104 Ave' && Number(kim.lat) === 49.1907, JSON.stringify(kim));
await desk.click('.pf-edit');
await desk.waitForSelector('#ed-address', { timeout: 5000 });
await desk.fill('#ed-address', '7452 132 St');
await desk.click('#ed-unit');
await sleep(500);
check('typed, not picked, on someone already pinned: "The pin moves to the new address when you save"',
  /The pin moves to the new address when you save/.test(await desk.innerText('#ed-address-af-note')), await desk.innerText('#ed-address-af-note'));
const looked = [];
const onReq = (r) => { if (r.url().includes('/api/address/suggest')) looked.push(decodeURIComponent(r.url().split('q=')[1] || '')); };
desk.on('request', onReq);
await desk.click('form[aria-label="Edit details"] button[type="submit"]');
// Offline Example's door (added above, pinned by a tap) is on the map at that
// address already: a door on file comes before the address service's.
const door = await findPerson('Offline Example');
await until(async () => Number((await full(kimId)).lat) === Number(door.lat), 4000);
desk.off('request', onReq);
kim = await full(kimId);
check('…found on save: the pin is the door already on the map at that address (Offline Example’s)',
  kim.address === '7452 132 St' && Number(kim.lat) === Number(door.lat) && Number(kim.lng) === Number(door.lng) && looked.includes('7452 132 St'),
  `${kim.lat},${kim.lng} · ${door.lat},${door.lng} · asked: ${looked.join(' | ')}`);
m = await measure(desk);
check('profile at 1360: no sideways scroll, ≤ 1 yellow', m.overflow <= 0 && m.yellow <= 1, JSON.stringify(m));
await desk.screenshot({ path: `${SHOTS}/03-profile.png`, fullPage: true });

// ── 5. A sign at an address takes that address's pin ──
await desk.goto(`${ADMIN}/signs?new=1`, { waitUntil: 'domcontentloaded' });
await desk.waitForSelector('form[aria-label="Add a sign"]', { timeout: 10000 }).catch(() => {});
await desk.click('form[aria-label="Add a sign"] button:has-text("Address")');
await desk.fill('#sign-address', '13450 104');
await desk.waitForSelector('.af-list .af-opt', { timeout: 5000 }).catch(() => {});
await desk.click('.af-list .af-opt');
await sleep(300);
await desk.click('form[aria-label="Add a sign"] button[type="submit"]');
await sleep(1200);
const signs = (await api('/signs')).json?.signs || [];
const sg = signs.find((s) => s.address === '13450 104 Ave');
check('the sign is at the picked address, with its pin', sg && Number(sg.lat) === 49.1906, JSON.stringify(signs.map((s) => [s.address, s.lat])));

// ── 6. The books ──
const v = (await api('/audit/verify')).json;
check('hash chain verifies', v?.ok === true, JSON.stringify(v));
check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
fake.close();
if (server) server.kill();
const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
