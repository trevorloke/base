// Scripts — a fresh in-memory campaign. The desk opens Today → More →
// Scripts, writes the door script with "+ First name" and "+ Your name", sees
// the preview read for a made-up voter, and saves; then the phone script.
// A volunteer on a phone opens their walk list: the open door shows "Script",
// which opens to the words with the voter's and their own first names in;
// it stays open on the next door, reads the same with no signal after a
// reload, and the Calls card shows the phone script for the person called.
// Measured at 390: no sideways scroll, nothing under 44px, one yellow.
//
//   BASE_OPEN_SIGNUP=1 BASE_DATA=memory PORT=4131 node server/index.js &
//   BASE=http://127.0.0.1:4131 SHOTS=/tmp/scripts node e2e-scripts.mjs
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:3200';
const FIELD = `${BASE}/field`; // the field app (web/src/mode.js); the desk is ADMIN, at /ground
const ADMIN = `${BASE}/ground`;
const SHOTS = process.env.SHOTS || '/tmp/base-ground-scripts';
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
const tiles = (c) => c.route(/tile\.openstreetmap\.org/, (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"/>' }));

// ── The desk writes the scripts ──
const dctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, timezoneId: 'America/Vancouver' });
const page = await dctx.newPage();
page.on('pageerror', (e) => errors.push(`desk: ${e.message}`));
const api = async (path, body) => {
  const r = body === undefined ? await dctx.request.get(`${BASE}/api${path}`) : await dctx.request.post(`${BASE}/api${path}`, { data: body });
  return { status: r.status(), json: await r.json().catch(() => null) };
};
await page.goto(`${FIELD}/signup`);
await page.fill('#su-name', 'Marco Manager');
if (await page.locator('#su-org').count()) await page.fill('#su-org', 'Imagine Surrey');
await page.fill('#su-email', `marco+${tag}@scripts.example`);
await page.fill('#su-password', 'surrey-forward-2026');
await page.click('button[type="submit"]');
await page.waitForURL(/\/ground\/?$/, { timeout: 15000 });
const campaign = (await api('/auth/me')).json.workspace.name;

await page.goto(`${ADMIN}/scripts`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#sc-door', { timeout: 10000 });
await page.fill('#sc-door', 'Hi ');
await page.click('form[aria-label="At the door"] button:has-text("+ First name")');
await page.type('#sc-door', ', I’m ');
await page.click('form[aria-label="At the door"] button:has-text("+ Your name")');
await page.type('#sc-door', '. Do you have a minute?');
const typed = await page.inputValue('#sc-door');
check('the fill-in buttons put their words where the cursor is', typed === 'Hi {{first_name}}, I’m {{my_name}}. Do you have a minute?', typed);
const preview = (await page.innerText('form[aria-label="At the door"] .sl-words')).trim();
check('the preview reads for a made-up voter', preview === 'Hi Sam, I’m Marco. Do you have a minute?', preview);
await page.click('form[aria-label="At the door"] button[type="submit"]');
await sleep(800);
check('Save: "✓ Saved", and the server has it', /✓ Saved/.test(await page.innerText('form[aria-label="At the door"] .sc-acts')) && (await api('/scripts')).json.door.body === typed);
await page.fill('#sc-phone', 'Hi {{first_name}}, it’s {{my_name}} calling for {{campaign}}.');
await page.click('form[aria-label="On the phone"] button[type="submit"]');
await sleep(800);
check('the phone script saved', /calling for/.test((await api('/scripts')).json.phone?.body || ''));
await page.screenshot({ path: `${SHOTS}/01-scripts-desk.png`, fullPage: true });

// ── A volunteer on a phone ──
const lat = 49.1327; const lng = -122.855;
const P = {};
for (const [k, name, address, dLng] of [['ana', 'Ana Example', '13213 72 Ave', 0], ['ben', 'Ben Example', '13225 72 Ave', 0.0003]]) {
  P[k] = (await api('/actions/person.create', { name, phone: '604-555-01' + (k === 'ana' ? '41' : '42'), address, city: 'Surrey', lat, lng: lng + dLng })).json.person;
}
const turf = (await api('/actions/turf.create', { name: 'Newton block', polygon: [[lat + 0.001, lng - 0.001], [lat + 0.001, lng + 0.002], [lat - 0.001, lng + 0.002], [lat - 0.001, lng - 0.001]] })).json.turf;
const invite = (await api('/actions/member.invite', { email: `jas+${tag}@scripts.example`, role: 'volunteer' })).json;
const vctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/Vancouver' });
await tiles(vctx);
const vp = await vctx.newPage();
vp.on('pageerror', (e) => errors.push(`phone: ${e.message}`));
await vp.goto(`${FIELD}/login`);
const joined = await vp.evaluate(async (t) => (await fetch('/api/auth/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: t, name: 'Jas Volunteer', password: 'knock-knock-2026' }) })).json(), invite.joinUrl.split('/').pop());
await api('/actions/turf.assign', { turf_id: turf.id, user_id: joined.user.id });
await vp.goto(`${FIELD}/turfs/${turf.id}`, { waitUntil: 'domcontentloaded' });
await vp.waitForSelector('#walk-door-0 .walk-door__head', { timeout: 10000 });
await sleep(800);
const openDoorAt = async (i) => {
  if (!(await vp.$(`#walk-door-${i}.is-open`))) await vp.tap(`#walk-door-${i} .walk-door__head`);
  await vp.waitForSelector(`#walk-door-${i} .walk-panel`, { timeout: 5000 });
};
await openDoorAt(0);
const nameAt = async (i) => (await vp.innerText(`#walk-door-${i} .walk-door__names`)).trim();
check('the open door shows "Script", shut at first', (await vp.innerText(`#walk-door-0 .sl-btn`).catch(() => '')).trim() === 'Script' && !(await vp.$('#walk-door-0 .sl-words')));
await vp.tap('#walk-door-0 .sl-btn');
const words0 = (await vp.innerText('#walk-door-0 .sl-words').catch(() => '')).trim();
check(`opened: the voter's and the volunteer's first names in ("${(await nameAt(0)).split(' ')[0]}", "Jas")`, words0 === `Hi ${(await nameAt(0)).split(' ')[0]}, I’m Jas. Do you have a minute?`, words0);
let m = await vp.evaluate(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  return { overflow: document.documentElement.scrollWidth - window.innerWidth, yellow: [...document.querySelectorAll('.btn-primary')].filter(vis).length, script: document.querySelector('.sl-btn').getBoundingClientRect().height };
});
check('walk list at 390: no sideways scroll, one yellow, "Script" ≥ 44px', m.overflow <= 0 && m.yellow <= 1 && m.script >= 44, JSON.stringify(m));
await vp.screenshot({ path: `${SHOTS}/02-walk-script.png` });
await openDoorAt(1);
const words1 = (await vp.innerText('#walk-door-1 .sl-words').catch(() => '')).trim();
check('the next door: still open, with that voter’s name', words1.startsWith(`Hi ${(await nameAt(1)).split(' ')[0]},`), words1);

// No signal, reloaded: the kept copy.
await vctx.setOffline(true);
await vp.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
await vp.waitForSelector('#walk-door-0 .walk-door__head', { timeout: 15000 }).catch(() => {});
await sleep(800);
await openDoorAt(0);
const offline = (await vp.innerText('#walk-door-0 .sl-words').catch(() => '')).trim();
check('no signal, reloaded: the script still reads', offline.startsWith('Hi ') && offline.endsWith('Do you have a minute?'), offline);
await vctx.setOffline(false);

// The Calls card: the phone script.
await vp.goto(`${FIELD}/calls?person=${P.ben.id}`, { waitUntil: 'domcontentloaded' });
await vp.waitForSelector('section.cl-card', { timeout: 10000 }).catch(() => {});
await sleep(600);
if (!(await vp.$('section.cl-card .sl-words'))) await vp.tap('section.cl-card .sl-btn').catch(() => {});
const call = (await vp.innerText('section.cl-card .sl-words').catch(() => '')).trim();
check('Calls: the phone script for Ben', call === `Hi Ben, it’s Jas calling for ${campaign}.`, call);
await vp.screenshot({ path: `${SHOTS}/03-calls-script.png` });
check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
