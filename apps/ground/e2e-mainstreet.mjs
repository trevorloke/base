// Mainstreeting — a fresh in-memory campaign. A volunteer on a phone opens
// Today → Mainstreeting, says where they are (Newton bus loop), and saves
// two people: one with a rating and "wants to volunteer", then one with no
// signal (it waits on the phone, and goes once the signal is back). The desk
// sees them on file: first and last apart, a Mainstreeting contact with the
// place, the volunteer request. Measured at 390.
//
//   BASE_OPEN_SIGNUP=1 BASE_DATA=memory PORT=4136 node server/index.js &
//   BASE=http://127.0.0.1:4136 SHOTS=/tmp/mainstreet node e2e-mainstreet.mjs
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:3200';
const FIELD = `${BASE}/field`; // the field app (web/src/mode.js); the desk is ADMIN, at /ground
const SHOTS = process.env.SHOTS || '/tmp/base-ground-mainstreet';
mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 220) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Math.random().toString(36).slice(2, 8);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const errors = [];

const dctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const page = await dctx.newPage();
page.on('pageerror', (e) => errors.push(`desk: ${e.message}`));
const api = async (path, body) => {
  const r = body === undefined ? await dctx.request.get(`${BASE}/api${path}`) : await dctx.request.post(`${BASE}/api${path}`, { data: body });
  return { status: r.status(), json: await r.json().catch(() => null) };
};
await page.goto(`${FIELD}/signup`);
await page.fill('#su-name', 'Marco Manager');
if (await page.locator('#su-org').count()) await page.fill('#su-org', 'Imagine Surrey');
await page.fill('#su-email', `marco+${tag}@ms.example`);
await page.fill('#su-password', 'surrey-forward-2026');
await page.click('button[type="submit"]');
await page.waitForURL(/\/ground\/?$/, { timeout: 15000 });
const inv = (await api('/actions/member.invite', { email: `vic+${tag}@ms.example`, role: 'volunteer' })).json;

const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const vp = await pctx.newPage();
vp.on('pageerror', (e) => errors.push(`vol: ${e.message}`));
await vp.goto(`${FIELD}/join/${inv.joinUrl.split('/join/')[1]}`);
await vp.fill('#join-name', 'Vic Volunteer');
await vp.fill('#join-password', 'vic-pass-2026');
await vp.click('button[type="submit"]');
await vp.waitForURL((u) => !/\/join\//.test(String(u)), { timeout: 15000 }).catch(() => {});

// ── Today → Mainstreeting → where ──
await vp.goto(`${FIELD}/`, { waitUntil: 'domcontentloaded' });
await vp.waitForSelector('a.today-row[href="/mainstreet"]', { timeout: 10000 });
await vp.tap('a.today-row[href="/mainstreet"]');
await vp.waitForSelector('#ms-place', { timeout: 8000 });
await vp.fill('#ms-place', 'Newton bus loop');
await vp.tap('button:has-text("Start")');
await vp.waitForSelector('#ms-first', { timeout: 5000 });
check('Today → Mainstreeting: "At Newton bus loop", the form', /Newton bus loop/.test(await vp.innerText('.ms-where')));

// ── One person, online ──
await vp.fill('#ms-first', 'Ana');
await vp.fill('#ms-last', 'Example');
await vp.fill('#ms-phone', '604-555-0181');
await vp.fill('#ms-postal', 'V3W 1A1');
await vp.tap('.ms-rate button[aria-label^="2:"]').catch(() => vp.tap('.ms-rate .rb-btn >> nth=1'));
await vp.check('.ms-asks input >> nth=0');
await vp.fill('#ms-note', 'Rides the 96');
const m = await vp.evaluate(() => ({
  overflow: document.documentElement.scrollWidth - window.innerWidth,
  minTap: Math.min(...[...document.querySelectorAll('.ms-page input:not([type=checkbox]), .ms-page textarea, .ms-page button')].map((el) => el.getBoundingClientRect().height)),
}));
check('at 390: no sideways scroll, every field and button ≥ 44px', m.overflow <= 0 && m.minTap >= 44, JSON.stringify(m));
await vp.screenshot({ path: `${SHOTS}/01-mainstreet-form.png`, fullPage: true });
await vp.tap('button:has-text("Save · next person")');
await vp.waitForSelector('.ops-done', { timeout: 8000 }).catch(() => {});
check('saved: "✓ Ana Example — saved", the form clear for the next person, the place kept',
  /Ana Example — saved/.test(await vp.innerText('.ops-done').catch(() => '')) && (await vp.inputValue('#ms-first')) === '' && /Newton bus loop/.test(await vp.innerText('.ms-where')));
check('"Met here today · 1"', /Met here today · 1/i.test(await vp.innerText('.ms-met').catch(() => '')));

// ── One with no signal ──
await pctx.setOffline(true);
await vp.fill('#ms-first', 'Ben');
await vp.fill('#ms-last', 'Offline');
await vp.tap('button:has-text("Save · next person")');
await sleep(600);
check('no signal: it waits on the phone ("Not sent yet")', /Not sent yet/.test(await vp.innerText('.ms-met').catch(() => '')) && /Met here today · 2/i.test(await vp.innerText('.ms-met').catch(() => '')));
await vp.screenshot({ path: `${SHOTS}/02-mainstreet-offline.png`, fullPage: true });
await pctx.setOffline(false);
await vp.evaluate(() => window.dispatchEvent(new Event('online')));
let ben = null;
for (let i = 0; i < 30 && !ben; i += 1) { ben = (await api('/persons?q=Ben%20Offline')).json.persons[0]; if (!ben) await sleep(500); }
check('signal back: Ben reaches the campaign, once', ben && (await api('/persons?q=Ben%20Offline')).json.persons.length === 1);

// ── The desk ──
const ana = (await api('/persons?q=Ana%20Example')).json.persons[0];
const prof = (await api(`/persons/${ana.id}`)).json;
check('Ana on file: first and last apart, her phone, rated 2, tagged mainstreeting', ana.first_name === 'Ana' && ana.last_name === 'Example' && ana.phone === '604-555-0181' && ana.rating === '2' && ana.tags.includes('mainstreeting'), JSON.stringify(ana));
check('her history: a Mainstreeting contact', prof.contacts[0]?.channel === 'mainstreet', JSON.stringify(prof.contacts[0]));
const reqs = (await api('/requests')).json.requests.filter((r) => r.person.id === ana.id);
check('"Wants to volunteer" is a request for the desk, with the place', reqs.length === 1 && reqs[0].kind === 'volunteer' && /Newton bus loop/.test(reqs[0].note), JSON.stringify(reqs));
await page.goto(`${BASE}/ground/people/${ana.id}`, { waitUntil: 'domcontentloaded' });
await sleep(1200);
check('the profile’s history reads Mainstreeting', /Mainstreeting/.test(await page.innerText('main')));
check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
