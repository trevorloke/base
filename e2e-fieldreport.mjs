// Field, by turf E2E — one fresh in-memory campaign: a manager draws two
// turfs (Newton block, four doors; Fleetwood east, two), a volunteer and the
// manager knock (a talk with a yes, a not-home twice at one door, a refusal,
// a talk with a lean yes in Fleetwood); Reports links to "Field, by turf →";
// /admin/field-report shows both tables with the API's numbers (a door
// knocked twice counts once), the pills change the range in the address
// (and the back button goes back), Download CSV is a text/csv spreadsheet
// whose first line is the turf head, and with no signal a reload shows the
// kept copy with "No signal · from <time>". On a phone (390) the report is
// rows, nothing scrolls sideways and every tap target is ≥ 48px. The
// volunteer's Today → More says "All time: 3 doors · 2 talks · 2 supporters
// found", with no signal too; the report itself is not theirs. Every claim on
// a screen is checked against the API.
//
//   STARBASE_OPEN_SIGNUP=1 STARBASE_DATA=memory PORT=4460 node server/index.js &
//   BASE=http://127.0.0.1:4460 SHOTS=/tmp/fieldreport node e2e-fieldreport.mjs
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:3200';
const ADMIN = { toString() { return `${BASE}/admin`; } }; // the desk's pages live in the admin (web/src/mode.js)
const SHOTS = process.env.SHOTS || '/tmp/starbase-fieldreport';
mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 220) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Date.now().toString(36);

const tileSvg = (z, x, y) => {
  const lines = [];
  for (let i = 0; i <= 256; i += 32) {
    const major = ((x * 256 + i) / 32) % 4 === 0;
    lines.push(`<line x1="${i}" y1="0" x2="${i}" y2="256" stroke="#fff" stroke-width="${major ? 5 : 2}"/>`);
  }
  for (let j = 0; j <= 256; j += 32) {
    const major = ((y * 256 + j) / 32) % 4 === 0;
    lines.push(`<line x1="0" y1="${j}" x2="256" y2="${j}" stroke="#fff" stroke-width="${major ? 5 : 2}"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e7e3d6"/>${lines.join('')}</svg>`;
};
const tiles = (ctx) => ctx.route(/tile\.openstreetmap\.org\/(\d+)\/(\d+)\/(\d+)\.png/, (route) => {
  const [, z, x, y] = route.request().url().match(/\/(\d+)\/(\d+)\/(\d+)\.png/);
  route.fulfill({ status: 200, contentType: 'image/svg+xml', body: tileSvg(+z, +x, +y) });
});

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const errors = [];
const helpers = (page, who) => {
  page.on('pageerror', (e) => errors.push(`[${who}] ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && /key|unique/i.test(m.text())) errors.push(`[${who}] ${m.text()}`); });
  return {
    shot: (n) => page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: false }),
    full: (n) => page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true }),
    text: async () => ((await page.innerText('body').catch(() => '')) || '').replace(/\s+/g, ' '),
    api: (path, body) => page.evaluate(async ([p, b]) => {
      const r = await fetch('/api' + p, b === undefined ? {} : {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b),
      });
      const raw = await r.text();
      let json = null;
      try { json = JSON.parse(raw); } catch { /* not json */ }
      return { status: r.status, json, raw, type: r.headers.get('content-type') || '' };
    }, [path, body]),
    go: async (path) => { await page.goto(`${/vol/.test(who) ? BASE : ADMIN}${path}`, { waitUntil: 'domcontentloaded' }); await sleep(900); },
    kept: () => page.$eval('.offline-strip__kept', (el) => el.innerText.replace(/\s+/g, ' ').trim()).catch(() => ''),
  };
};
// Simplicity: words on the screen (not the nav/tab bar), yellow buttons,
// sideways scroll, and the smallest tap target among `sel`.
const measure = (page, sel = null) => page.evaluate((targets) => {
  const main = document.querySelector('main.page') || document.body;
  const words = (main.innerText || '').split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const yellow = [...document.querySelectorAll('.btn-primary')].filter(visible).length;
  const overflow = document.documentElement.scrollWidth - window.innerWidth;
  let minTap = null;
  if (targets) {
    for (const el of document.querySelectorAll(targets)) {
      if (!visible(el)) continue;
      const h = el.getBoundingClientRect().height;
      minTap = minTap == null ? h : Math.min(minTap, h);
    }
  }
  return { words, yellow, overflow, minTap };
}, sel);
const swReady = (pg) => pg.evaluate(() => navigator.serviceWorker.ready.then(() => Boolean(navigator.serviceWorker.controller))).catch(() => false);
const KEPT = /No signal · from (\d{1,2}:\d{2} (am|pm)|[A-Z][a-z]{2} \d{1,2})/i;
const TAPS = '.fr-range, .ops-head .btn, .ops-back';
// The browser's day (the suite runs in Vancouver, the campaign's zone too).
// Days in the campaign's zone (the server and the page count in it), not
// this machine's: late in the evening in Vancouver it's already tomorrow in UTC.
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' });
const daysBack = (n) => { const [y, mo, d] = today.split('-').map(Number); return new Date(Date.UTC(y, mo - 1, d - n)).toISOString().slice(0, 10); };

// ── 1. A manager, two turfs, a volunteer, some knocks ──
const dctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, timezoneId: 'America/Vancouver' });
await tiles(dctx);
const page = await dctx.newPage();
const D = helpers(page, 'manager');
await D.go('/signup');
await page.fill('#su-name', 'Riley Manager');
if (await page.locator('#su-org').count()) await page.fill('#su-org', 'Imagine Surrey');
await page.fill('#su-email', `riley+${tag}@fieldreport.example`);
await page.fill('#su-password', 'surrey-forward-2026');
await page.click('button[type="submit"]');
await page.waitForURL(/\/admin\/?$/, { timeout: 15000 });

const N = { lat: 49.1327, lng: -122.855 };
const F = { lat: 49.1585, lng: -122.776 };
const box = (c, dLat = 0.001, dLng = 0.002) => [[c.lat + dLat, c.lng - 0.001], [c.lat + dLat, c.lng + dLng], [c.lat - dLat, c.lng + dLng], [c.lat - dLat, c.lng - 0.001]];
const P = {};
const mk = async (key, name, address, at, dLng) => {
  P[key] = (await D.api('/actions/person.create', { name, address, city: 'Surrey', lat: at.lat, lng: at.lng + dLng })).json.person;
};
await mk('a', 'Ada Example', '13213 72 Ave', N, 0.0000);
await mk('b', 'Ben Example', '13225 72 Ave', N, 0.0003);
await mk('c', 'Cy Example', '13224 72 Ave', N, 0.0003);
await mk('d', 'Di Example', '13212 72 Ave', N, 0.0000);
await mk('e', 'Eve Example', '16010 84 Ave', F, 0.0000);
await mk('f', 'Fay Example', '16020 84 Ave', F, 0.0004);
check('seeded 6 people with pins', Object.values(P).every((p) => p?.id));
const t1 = (await D.api('/actions/turf.create', { name: 'Newton block', polygon: box(N) })).json.turf;
const t2 = (await D.api('/actions/turf.create', { name: 'Fleetwood east', polygon: box(F) })).json.turf;
check('two turfs drawn', t1?.id && t2?.id);

const invite = (await D.api('/actions/member.invite', { email: `jas+${tag}@fieldreport.example`, role: 'volunteer' })).json;
const vctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/Vancouver' });
await tiles(vctx);
const vpage = await vctx.newPage();
const V = helpers(vpage, 'vol');
await V.go('/login');
const joined = await V.api('/auth/join', { token: invite.joinUrl.split('/').pop(), name: 'Jas Volunteer', password: 'knock-knock-2026' });
check('volunteer joined', joined.status === 200 && joined.json.role === 'volunteer', joined.status);
const knock = (H, p, outcome, rating) => H.api('/actions/contact.log', { person_id: p.id, channel: 'door', outcome, ...(rating ? { rating } : {}) });
const knocks = [
  await knock(V, P.a, 'contacted', '1'),
  await knock(V, P.b, 'no_answer'),
  await knock(V, P.b, 'no_answer'),
  await knock(V, P.e, 'contacted', '2'),
  await knock(D, P.c, 'refused'),
  // A call is never a knock.
  await D.api('/actions/contact.log', { person_id: P.d.id, channel: 'phone', outcome: 'contacted', rating: '1' }),
];
check('knocks logged (a talk, a not-home twice, a refusal, a Fleetwood talk; one call)', knocks.every((r) => r.status === 200), knocks.map((r) => r.status).join(','));

// ── 2. The API's numbers ──
const api = (await D.api('/field-report')).json;
const tN = api.turfs.find((t) => t.id === t1.id);
const tF = api.turfs.find((t) => t.id === t2.id);
check('API: Newton block 4 doors · 3 knocked (75%) · 1 talked · 1 yes · 2 no answer · 1 refused · 2 canvassers',
  tN && tN.doors === 4 && tN.knocked === 3 && tN.coverage_pct === 75 && tN.talked === 1 && tN.support_found === 1
  && tN.no_answer === 2 && tN.refused === 1 && tN.canvassers === 2 && !!tN.last_knock_at, JSON.stringify(tN));
check('API: Fleetwood east 2 doors · 1 knocked (50%) · 1 talked · 1 yes', tF && tF.doors === 2 && tF.knocked === 1 && tF.coverage_pct === 50
  && tF.talked === 1 && tF.support_found === 1, JSON.stringify(tF));
const jasRow = api.canvassers.find((p) => p.name === 'Jas Volunteer');
check('API: Jas Volunteer 3 doors · 2 talks · 2 yes · 1 day out', jasRow && jasRow.doors === 3 && jasRow.talked === 2 && jasRow.support_found === 2 && jasRow.days_out === 1, JSON.stringify(jasRow));
check('API: the last 30 days by default', api.range.from === daysBack(29) && api.range.to === today, JSON.stringify(api.range));
check('API: volunteers are refused the report and its CSV', (await V.api('/field-report')).status === 403 && (await V.api('/field-report.csv')).status === 403);

// ── 3. Reports → Field, by turf ──
await D.go('/reports');
const link = page.locator('a.btn:has-text("Field, by turf →")');
check('Reports links to "Field, by turf →" (not a yellow button)', (await link.count()) === 1 && !(await link.getAttribute('class')).includes('btn-primary'));
await link.click();
await page.waitForURL(`${ADMIN}/field-report`, { timeout: 8000 }).catch(() => {});
await page.waitForSelector('.fr-table', { timeout: 8000 }).catch(() => {});
check('…opens /admin/field-report titled "Field, by turf"', page.url() === `${ADMIN}/field-report` && (await page.innerText('h1').catch(() => '')) === 'Field, by turf', page.url());
const tableRows = async (sec) => page.$$eval(`#${sec} ~ .fr-wide tbody tr`, (trs) => trs.map((tr) => [...tr.children].map((td) => td.innerText.replace(/\s+/g, ' ').trim())));
const turfRows = await tableRows('fr-turfs');
const newton = turfRows.find((r) => r[0] === 'Newton block') || [];
const fleet = turfRows.find((r) => r[0] === 'Fleetwood east') || [];
check('by turf (1360, a table): Newton block · 4 · 3 (75%) · 1 · 1 · 2 · 1 · 0 · 0 · 0 lit · 0 · 2 · a last knock',
  newton.slice(0, 12).join('|') === 'Newton block|4|3 (75%)|1|1|2|1|0|0|0|0|2' && /\d:\d\d [ap]\.m\./.test(newton[12] || ''), newton.join('|'));
check('…Fleetwood east · 2 · 1 (50%) · 1 talked · 1 yes', fleet[1] === '2' && fleet[2] === '1 (50%)' && fleet[3] === '1' && fleet[4] === '1', fleet.join('|'));
const bar = await page.$eval('.fr-wide tbody tr:first-child .fr-bar > span', (el) => el.style.width).catch(() => '');
check('…with a thin coverage bar at the coverage', bar === `${api.turfs[0].coverage_pct}%`, bar);
const people = await tableRows('fr-people');
const jas = people.find((r) => r[0] === 'Jas Volunteer') || [];
const riley = people.find((r) => r[0] === 'Riley Manager') || [];
check('by canvasser: Jas Volunteer · — · 3 · 2 · 2 · 1 · a last out', jas.slice(1, 6).join('|') === '—|3|2|2|1' && /\d:\d\d [ap]\.m\./.test(jas[6] || ''), jas.join('|'));
check('…Riley Manager · 1 door · 0 talks (the call is not a knock)', riley[2] === '1' && riley[3] === '0' && riley[4] === '0', riley.join('|'));
const days = await page.$$eval('.fr-days tbody tr', (trs) => trs.map((tr) => tr.innerText.replace(/\s+/g, ' ').trim()));
check('by day: one day, 4 doors, 2 talks', days.length === 1 && / 4 2$/.test(days[0]), days.join(' / '));
let t = await D.text();
check('the line about pins and ratings is there', /People are counted where their pin is today; support found is the rating given at the door\./.test(t));
const inner = await page.$$eval('.fr-wide', (els) => els.map((e) => e.scrollWidth - e.clientWidth));
check('desk 1360: every table fits its column (no scrolling inside one)', inner.length === 2 && inner.every((x) => x <= 0), inner.join(','));
let m = await measure(page, TAPS);
// A desk with a mouse: 40px controls (app.css --ctl); the phone's 48 is checked at 390 below.
check('desk 1360: no yellow button, no sideways scroll, taps ≥ 40px', m.yellow === 0 && m.overflow <= 0 && m.minTap >= 39.5, JSON.stringify(m));
check('"30 days" is the pill that is on', (await page.getAttribute('.fr-range[aria-checked="true"]', 'class').catch(() => '')) != null
  && (await page.innerText('.fr-range[aria-checked="true"]').catch(() => '')) === '30 days');
await D.full('01-field-report-desk');

// ── 4. The pills change the range in the address ──
await page.click('.fr-range:has-text("Last 7 days")');
await page.waitForURL(/from=/, { timeout: 5000 }).catch(() => {});
await sleep(700);
let u = new URL(page.url());
check('"Last 7 days": ?from=<6 days ago>&to=<today>', u.searchParams.get('from') === daysBack(6) && u.searchParams.get('to') === today, page.url());
check('…and the pill is on', (await page.innerText('.fr-range[aria-checked="true"]').catch(() => '')) === 'Last 7 days');
await page.click('.fr-range:has-text("This week")');
await sleep(700);
u = new URL(page.url());
const monday = daysBack((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7);
check('"This week": from Monday', u.searchParams.get('from') === monday && u.searchParams.get('to') === today, page.url());
await page.click('.fr-range:has-text("All")');
await sleep(900);
u = new URL(page.url());
check('"All": ?from=all', u.searchParams.get('from') === 'all' && u.searchParams.get('to') === today, page.url());
check('…the numbers are the API’s for that range', /Newton block/.test(await D.text()) && (await tableRows('fr-turfs')).find((r) => r[0] === 'Newton block')?.[2] === '3 (75%)');
await page.goBack();
await sleep(700);
check('the back button goes back a range (This week)', new URL(page.url()).searchParams.get('from') === monday
  && (await page.innerText('.fr-range[aria-checked="true"]').catch(() => '')) === 'This week', page.url());
await page.goForward();
await sleep(700);

// ── 5. Download CSV ──
const href = await page.getAttribute('.ops-head a.btn:has-text("Download CSV")', 'href').catch(() => null);
check('Download CSV is a plain button with the range in its link', href === `/api/field-report.csv?from=all&to=${today}`
  && !(await page.getAttribute('.ops-head a.btn:has-text("Download CSV")', 'class')).includes('btn-primary'), href);
const csv = await page.evaluate(async (h) => {
  const r = await fetch(h);
  return { status: r.status, type: r.headers.get('content-type') || '', disp: r.headers.get('content-disposition') || '', text: await r.text() };
}, href);
const lines = csv.text.replace(/^\uFEFF/, '').split('\r\n');
check('…200 text/csv, a download named for the range', csv.status === 200 && /^text\/csv/.test(csv.type) && csv.disp.includes(`field-report-all-${today}.csv`), `${csv.status} ${csv.type} ${csv.disp}`);
check('…first line is the turf head; the canvassers follow after a blank row',
  lines[0] === 'Turf,Doors,Knocked,Coverage %,Talked,Yes,No answer,Refused,Moved,No access,Left lit,Other,Canvassers,Last knock'
  && lines[1].startsWith('Newton block,4,3,75,1,1,2,1,0,0,0,0,2,') && lines[3] === '' && lines[4] === 'Canvasser,Team,Doors,Talked,Yes,Days out,Last out'
  && lines.some((l) => l.startsWith('Jas Volunteer,,3,2,2,1,')), lines.slice(0, 6).join(' / '));

// ── 6. No signal: a reload shows the kept copy ──
const dReady = await swReady(page);
await dctx.setOffline(true);
await page.evaluate(() => window.dispatchEvent(new Event('offline')));
await D.go(`/field-report?from=all&to=${today}`);
await page.waitForSelector('.fr-table', { timeout: 8000 }).catch(() => {});
t = await D.text();
const kept = await D.kept();
check('reload with no signal: the kept copy (Newton block 3 (75%)) and "No signal · from <time>"', dReady && KEPT.test(kept)
  && (await tableRows('fr-turfs')).find((r) => r[0] === 'Newton block')?.[2] === '3 (75%)' && !/No signal — this loads/.test(t), `${dReady} · ${kept} · ${t.slice(0, 160)}`);
await D.shot('02-field-report-no-signal');
await D.go(`/field-report?from=${daysBack(2)}&to=${today}`);
await sleep(600);
t = await D.text();
check('…a range never loaded, with no signal: the No signal line', /No signal — this loads when you’re back online\./.test(t), t.slice(0, 200));
await dctx.setOffline(false);
await page.evaluate(() => window.dispatchEvent(new Event('online')));

// ── 7. On a phone (390): rows, no sideways scroll ──
const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/Vancouver', storageState: await dctx.storageState() });
await tiles(pctx);
const ppage = await pctx.newPage();
const PP = helpers(ppage, 'manager-phone');
await PP.go('/field-report');
await ppage.waitForSelector('.fr-row', { timeout: 8000 }).catch(() => {});
const rowsText = await ppage.$$eval('#fr-turfs ~ .fr-narrow .fr-row', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim())).catch(() => []);
check('phone: a row per turf — "Newton block 4 doors · 3 knocked (75%)", talked, yes, no answer, refused',
  rowsText.some((r) => /^Newton block 4 doors · 3 knocked \(75%\) 1 talked · 1 yes · 2 no answer · 1 refused 2 canvassers · last knock /.test(r)), rowsText.join(' / '));
check('…the wide tables are hidden', (await ppage.$$eval('.fr-wide', (els) => els.every((e) => getComputedStyle(e).display === 'none'))));
const prow = await ppage.$$eval('#fr-people ~ .fr-narrow .fr-row', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim())).catch(() => []);
check('…a row per canvasser: "Jas Volunteer 3 doors · 2 talks · 2 yes · 1 day out"', prow.some((r) => r.startsWith('Jas Volunteer 3 doors · 2 talks · 2 yes · 1 day out last out ')), prow.join(' / '));
m = await measure(ppage, TAPS);
check('phone 390: no sideways scroll, no yellow, taps ≥ 48px', m.overflow <= 0 && m.yellow === 0 && m.minTap >= 47.5, JSON.stringify(m));
await PP.full('03-field-report-phone');

// ── 8. The volunteer: Today → More → All time ──
await V.go('/');
await vpage.waitForSelector('.today-morebox__toggle', { timeout: 8000 }).catch(() => {});
await vpage.tap('.today-morebox__toggle');
await sleep(400);
const mine = (await V.api('/brief')).json.field?.mine_all;
check('brief: the volunteer’s all time is 3 doors, 2 talks, 2 supporters found, 1 day out', JSON.stringify(mine) === JSON.stringify({ doors: 3, talked: 2, support_found: 2, days_out: 1 }), JSON.stringify(mine));
let line = await vpage.innerText('.today-morebox__body').catch(() => '');
check('Today → More: "All time: 3 doors · 2 talks · 2 supporters found"', /All time: 3 doors · 2 talks · 2 supporters found/.test(line.replace(/\s+/g, ' ')), line.slice(0, 200));
m = await measure(vpage);
check('volunteer Today at 390: no sideways scroll, ≤ 1 yellow', m.overflow <= 0 && m.yellow <= 1, JSON.stringify(m));
await V.shot('04-volunteer-all-time');
await V.go('/field-report');
check('the volunteer typing /field-report lands on Today', new URL(vpage.url()).pathname === '/', vpage.url());
const vReady = await swReady(vpage);
await vctx.setOffline(true);
await V.go('/');
await vpage.waitForSelector('.today-morebox__toggle', { timeout: 8000 }).catch(() => {});
await vpage.tap('.today-morebox__toggle').catch(() => {});
await sleep(400);
line = await vpage.innerText('.today-morebox__body').catch(() => '');
check('…and with no signal, the same line from the kept Today', vReady && /All time: 3 doors · 2 talks · 2 supporters found/.test(line.replace(/\s+/g, ' ')), `${vReady} · ${line.slice(0, 160)}`);
await vctx.setOffline(false);

// ── 9. The books still verify ──
const v = (await D.api('/audit/verify')).json;
check('hash chain verifies (the report only reads)', v.ok === true, JSON.stringify(v));
check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
