// The field cuts on People — a fresh in-memory campaign: four people, a turf
// around two of them, knocks on some. People → Filter → More filters:
// "Never knocked", "Last outcome: No answer", a turf and a postal code each
// narrow the list to what the server says; their chips say them in words and
// take them off; "Save as a list" carries them to the new list, which keeps
// them; at 390 the sheet doesn't scroll sideways and its chips are 48px; a
// count that gets a 502 says Unavailable, never the rows on screen; the
// snapshot form's taps are 48px.
//
//   STARBASE_OPEN_SIGNUP=1 STARBASE_DATA=memory PORT=4130 node server/index.js &
//   BASE=http://127.0.0.1:4130 SHOTS=/tmp/cuts node e2e-cuts.mjs
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:3200';
const ADMIN = `${BASE}/admin`;
const SHOTS = process.env.SHOTS || '/tmp/starbase-cuts';
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

const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, timezoneId: 'America/Vancouver' });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
const api = async (path, body) => {
  const r = body === undefined ? await ctx.request.get(`${BASE}/api${path}`) : await ctx.request.post(`${BASE}/api${path}`, { data: body });
  return { status: r.status(), json: await r.json().catch(() => null) };
};
await page.goto(`${BASE}/signup`);
await page.fill('#su-name', 'Riley Manager');
if (await page.locator('#su-org').count()) await page.fill('#su-org', 'Imagine Surrey');
await page.fill('#su-email', `riley+${tag}@cuts.example`);
await page.fill('#su-password', 'surrey-forward-2026');
await page.click('button[type="submit"]');
await page.waitForURL(/\/admin\/?$/, { timeout: 15000 });

const lat = 49.1327; const lng = -122.855;
const P = {};
const mk = async (key, data) => { P[key] = (await api('/actions/person.create', data)).json.person; };
await mk('ana', { name: 'Ana Example', phone: '604-555-0141', address: '13213 72 Ave', city: 'Surrey', postal: 'V3W 1A1', lat, lng });
await mk('ben', { name: 'Ben Example', phone: '604-555-0142', address: '13225 72 Ave', city: 'Surrey', postal: 'V3W 2B2', lat, lng: lng + 0.0003 });
await mk('cy', { name: 'Cy Example', phone: '604-555-0143', address: '1 Far Rd', city: 'Surrey', postal: 'V4N 3C3', lat: 49.3, lng: -122.5 });
await mk('dee', { name: 'Dee Example', phone: '604-555-0144' });
const turf = (await api('/actions/turf.create', {
  name: 'Newton block', polygon: [[lat + 0.001, lng - 0.001], [lat + 0.001, lng + 0.002], [lat - 0.001, lng + 0.002], [lat - 0.001, lng - 0.001]],
})).json.turf;
await api('/actions/contact.log', { person_id: P.ana.id, channel: 'door', outcome: 'no_answer' });
await api('/actions/contact.log', { person_id: P.ben.id, channel: 'door', outcome: 'contacted', rating: '2' });
check('seeded four people, a turf, two knocks', Object.values(P).every((p) => p?.id) && turf?.id);

// At 1360 People is a table: the names are its first column's links.
const rows = () => page.$$eval('.pp-table__name > a', (els) => els.map((e) => e.innerText.trim()).sort());
const chips = () => page.$$eval('.pp-fchip', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
const openMore = async () => {
  if (!(await page.$('.pp-sheet'))) await page.click('.pp-filterbtn');
  await page.waitForSelector('.pp-sheet', { timeout: 5000 });
  if (!(await page.$('.pp-sheet__more'))) await page.click('.pp-morefilters');
  await page.waitForSelector('.pp-sheet__more', { timeout: 5000 });
};
const pick = async (group, label) => {
  await openMore();
  await page.click(`.pp-sheet__more fieldset:has(legend:text-is("${group}")) button:text-is("${label}")`);
  await sleep(900);
};

await page.goto(`${ADMIN}/people`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.pp-table__name > a', { timeout: 10000 });
await pick('Last knocked', 'Never knocked');
check('"Never knocked": Cy and Dee', (await rows()).join('|') === 'Cy Example|Dee Example', (await rows()).join('|'));
check('…its chip says so', (await chips()).includes('Never knocked'), (await chips()).join(' | '));
await pick('Last knocked', 'Never knocked'); // off again
await pick('Last outcome', 'No answer');
check('"Last outcome: No answer": Ana', (await rows()).join('|') === 'Ana Example' && (await chips()).includes('Last: No answer'), `${(await rows()).join('|')} · ${(await chips()).join(' | ')}`);
await page.click('.pp-fchip:has-text("Last: No answer")');
await sleep(900);
check('the chip takes it off', (await rows()).length === 4 && !(await chips()).some((c) => /No answer/.test(c)), (await rows()).join('|'));
await pick('Turf', 'Newton block');
check('Turf "Newton block": Ana and Ben', (await rows()).join('|') === 'Ana Example|Ben Example' && (await chips()).includes('Turf: Newton block'), (await rows()).join('|'));
await openMore();
await page.fill('#pp-postal', 'v3w 2');
await sleep(1000);
check('Postal "V3W 2" with the turf: Ben', (await rows()).join('|') === 'Ben Example' && (await chips()).includes('Postal V3W 2…'), `${(await rows()).join('|')} · ${(await chips()).join(' | ')}`);
const viaApi = (await api(`/persons?turf=${turf.id}&postal=V3W2`)).json.persons.map((p) => p.name);
check('the server agrees', viaApi.join('|') === 'Ben Example', viaApi.join('|'));
await page.screenshot({ path: `${SHOTS}/01-people-cuts.png`, fullPage: true });

// Save as a list: the cuts come along, and the list keeps them.
await page.click('.pp-sheet button:has-text("Done")').catch(() => {});
await page.click('.pp-savelist');
await page.waitForSelector('#ls-name', { timeout: 8000 });
check('the new list’s form has the turf and the postal code', (await page.inputValue('#ls-turf')) === turf.id && (await page.inputValue('#ls-postal')).toUpperCase().replace(/\s/g, '') === 'V3W2',
  `${await page.inputValue('#ls-turf')} · ${await page.inputValue('#ls-postal')}`);
await page.fill('#ls-name', 'Newton, V3W 2');
await page.click('button[type="submit"]:has-text("Save list")');
await page.waitForURL(/\/lists\/[0-9a-f-]{36}$/, { timeout: 8000 }).catch(() => {});
const listId = page.url().split('/').pop();
const list = (await api(`/lists/${listId}`)).json;
check('the saved list keeps the cuts and finds Ben', list?.list?.filter?.turf === turf.id && list.people.map((p) => p.name).join('|') === 'Ben Example', JSON.stringify(list?.list?.filter));

// On a phone: the sheet fits.
const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/Vancouver', storageState: await ctx.storageState() });
const pp = await pctx.newPage();
pp.on('pageerror', (e) => errors.push(`phone: ${e.message}`));
await pp.goto(`${ADMIN}/people?knocked=7`, { waitUntil: 'domcontentloaded' });
await pp.waitForSelector('.pp-filterbtn', { timeout: 10000 });
await pp.tap('.pp-filterbtn');
await pp.waitForSelector('.pp-sheet__more', { timeout: 5000 }).catch(() => {});
const m = await pp.evaluate(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const taps = [...document.querySelectorAll('.pp-sheet__more .pp-pick')].filter(vis).map((el) => el.getBoundingClientRect().height);
  return { overflow: document.documentElement.scrollWidth - window.innerWidth, minTap: taps.length ? Math.min(...taps) : null, open: Boolean(document.querySelector('.pp-sheet__more')) };
});
check('at 390: a cut in the link opens More filters; no sideways scroll; chips ≥ 48px', m.open && m.overflow <= 0 && m.minTap >= 48, JSON.stringify(m));
await pp.screenshot({ path: `${SHOTS}/02-phone-sheet.png`, fullPage: true });

// The count behind a proxy that gave up (502) while the names came: Unavailable, never the rows on screen.
const badGateway = (route) => route.fulfill({ status: 502, contentType: 'text/html', body: '<html>Bad gateway</html>' });
await pp.route(/\/api\/persons\/count/, badGateway);
await pp.goto(`${ADMIN}/people`, { waitUntil: 'domcontentloaded' });
await pp.waitForFunction(() => /Unavailable/.test(document.querySelector('.pp-count')?.innerText || ''), null, { timeout: 15000 }).catch(() => {});
const countLine = (await pp.innerText('.pp-count').catch(() => '')).replace(/\s+/g, ' ');
check('People’s count gets a 502 while the names come: "Unavailable — Try again", no number off the screen',
  /Unavailable — Try again/.test(countLine) && !/\d\+? (people|person)/.test(countLine) && (await pp.$$('.pp-list li, .pp-table tbody tr')).length >= 4, countLine);
await pp.unroute(/\/api\/persons\/count/, badGateway);
await pp.tap('.pp-count .au-retry');
await pp.waitForFunction(() => /\b4 people/.test(document.querySelector('.pp-count')?.innerText || ''), null, { timeout: 10000 }).catch(() => {});
check('…Try again: "4 people"', /\b4 people/.test(await pp.innerText('.pp-count').catch(() => '')), await pp.innerText('.pp-count').catch(() => ''));
// "Save these people as they are now" (a filter is on) on a phone: its name box, Save and Cancel are 48px taps.
await pp.goto(`${ADMIN}/people?knocked=never`, { waitUntil: 'domcontentloaded' });
await pp.waitForSelector('.pp-count .au-snap__link', { timeout: 10000 }).catch(() => {});
const links = await pp.evaluate(() => [...document.querySelectorAll('.pp-count .pp-savelist, .pp-count .au-snap__link')].map((el) => Math.round(el.getBoundingClientRect().height)));
check('at 390: "Save as a list" and "Save these people as they are now" are ≥ 48px', links.length === 2 && Math.min(...links) >= 48, JSON.stringify(links));
await pp.tap('.pp-count .au-snap__link').catch(() => {});
await pp.waitForSelector('.au-snap', { timeout: 5000 }).catch(() => {});
const snap = await pp.evaluate(() => [...document.querySelectorAll('.au-snap input, .au-snap button')].map((el) => Math.round(el.getBoundingClientRect().height)));
check('at 390: the snapshot form’s name box, Save and Cancel are ≥ 48px', snap.length === 3 && Math.min(...snap) >= 48, JSON.stringify(snap));
await pp.screenshot({ path: `${SHOTS}/03-phone-snapshot.png` });
check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
