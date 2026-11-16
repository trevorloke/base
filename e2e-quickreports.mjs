// Quick reports E2E (server/ext/reports/quick.js; Reports.jsx,
// QuickReport.jsx, WalkSheet.jsx). A fresh in-memory campaign of made-up
// people, at 1440x900 and 390x844, as a manager, a staff member denied
// Donations, a staff member with Map only, and a volunteer:
//   Reports opens on Quick reports; the counts go from Loading… to numbers;
//   "Field, by turf →" is still one non-primary link; More opens the old
//   tables; the turfs' own counts are untouched.
//   Donors: chips change the address and the number; Largest first; Print is
//   the one primary; Download CSV (BOM, Last name,First name,Total); "Do not
//   call" in a Phone cell; Make it a list on This year and Lapsed only; the
//   phone stack: the name and two facts.
//   Interested in being a candidate: rows, and Make it a list → /lists/new.
//   Walking list: the chooser (names, the "aren't on the map yet" line); the
//   sheet's head, the Canvasser line, the heads in the scale's words, the
//   "If Opposed" line, the script filled, street headings with capitals,
//   Last: <word>, Do not contact — skip; no phone, no email, no two-letter
//   code; Still to knock vs Every door; Script Off; print media; PDFs.
//   A turf's walk list on the desk: Print; the field app's: none.
//   Staff denied Donations, staff with Map only, a volunteer; no signal.
//
//   PORT=5460 SHOTS=/tmp/qr node e2e-quickreports.mjs              (starts its own server)
//   BASE_PATH=/imaginesurrey PORT=5461 SHOTS=/tmp/qr-bp node e2e-quickreports.mjs
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.PORT) || 5460;
const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/$/, '');
const SHOTS = process.env.SHOTS || '/tmp/starbase-quickreports';
mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 300) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Date.now().toString(36);

const server = spawn(process.execPath, ['server/index.js'], {
  env: { ...process.env, STARBASE_OPEN_SIGNUP: '1', STARBASE_DATA: 'memory', PORT: String(PORT), STARBASE_JOBS: 'off',
    GEOCODER: 'off', GEOCODE_ON_SAVE: 'off', BASE_PATH },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('server did not start')), 30000);
  server.stdout.on('data', (b) => { if (/starbase on :/.test(String(b))) { clearTimeout(t); resolve(); } });
  server.on('exit', (code) => reject(new Error(`server exited ${code}`)));
});
process.on('exit', () => { server.kill(); });
process.on('unhandledRejection', (e) => { console.log(`FAIL  stopped: ${e?.stack || e}`); process.exit(1); });
const BASE = BASE_PATH ? `http://127.0.0.1:${PORT}${BASE_PATH}/field` : `http://127.0.0.1:${PORT}`;
const ADMIN = BASE_PATH ? `http://127.0.0.1:${PORT}${BASE_PATH}/desk` : `${BASE}/admin`;

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const errors = [];
const helpers = (page, who) => {
  page.on('pageerror', (e) => errors.push(`[${who}] ${e.message}`));
  return {
    shot: (n) => page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true }),
    text: async (sel = 'body') => ((await page.innerText(sel).catch(() => '')) || '').replace(/\s+/g, ' '),
    api: (path, body) => page.evaluate(async ([p, b]) => {
      const r = await fetch(`${p}`, b === undefined ? {} : {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b),
      });
      const raw = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await r.arrayBuffer());
      let json = null;
      try { json = JSON.parse(raw); } catch { /* not json */ }
      const bom = raw.charCodeAt(0) === 0xfeff;
      return { status: r.status, json, raw, disp: r.headers.get('content-disposition') || '', bom };
    }, [`${BASE_PATH}/api${path}`, body]),
    go: async (path, field = false) => { await page.goto(`${field ? BASE : ADMIN}${path}`, { waitUntil: 'domcontentloaded' }); await sleep(900); },
  };
};
const measure = (page, sel = null) => page.evaluate((targets) => {
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const yellow = [...document.querySelectorAll('.btn-primary')].filter(visible).length;
  const overflow = document.documentElement.scrollWidth - window.innerWidth;
  let minTap = null;
  let small = '';
  if (targets) {
    for (const el of document.querySelectorAll(targets)) {
      if (!visible(el)) continue;
      const h = el.getBoundingClientRect().height;
      if (minTap == null || h < minTap) { minTap = h; small = el.outerHTML.slice(0, 80); }
    }
  }
  return { yellow, overflow, minTap, small };
}, sel);
const simple = async (pg, name, sel = null) => {
  const mm = await measure(pg, sel);
  check(`${name}: ≤ 1 yellow, no sideways scroll${sel ? ', targets ≥ 48px' : ''}`, mm.yellow <= 1 && mm.overflow <= 0 && (mm.minTap == null || mm.minTap >= 47.5), JSON.stringify(mm));
  return mm;
};
const PHONE = { width: 390, height: 844 };
const WIDE = { width: 1440, height: 900 };
const TARGETS = '.rp-quick__i, .qr-chip, .ops-head__actions .btn, .ops-back, .ws-turfs a';
// Each named screen at both sizes: the wide one, then the phone.
const both = async (pg, S, name) => {
  await pg.setViewportSize(WIDE); await sleep(300);
  await simple(pg, `${name} at 1440`);
  await S.shot(`${name}-1440`);
  await pg.setViewportSize(PHONE); await sleep(300);
  await simple(pg, `${name} at 390`, TARGETS);
  await S.shot(`${name}-390`);
  await pg.setViewportSize(WIDE); await sleep(200);
};
// More under a report: open it, whatever it was.
const openMore = async (pg) => {
  const b = pg.locator('button.disclose', { hasText: 'More' });
  if ((await b.getAttribute('aria-expanded')) !== 'true') await b.click();
};
const settled = async (pg, sel) => {
  for (let i = 0; i < 40; i += 1) {
    const t = await pg.innerText(sel).catch(() => '');
    if (t && !/Loading…/.test(t)) return t.replace(/\s+/g, ' ');
    await sleep(150);
  }
  return (await pg.innerText(sel).catch(() => '')).replace(/\s+/g, ' ');
};

// ── 1. The desk: made-up people, gifts, a turf with a pass, a script ──
const dctx = await browser.newContext({ viewport: WIDE, timezoneId: 'America/Vancouver', acceptDownloads: true });
const page = await dctx.newPage();
const D = helpers(page, 'manager');
await D.go('/signup');
await page.fill('#su-name', 'Riley Manager');
if (await page.locator('#su-org').count()) await page.fill('#su-org', 'Quick Example Campaign');
await page.fill('#su-email', `riley+${tag}@quick.example`);
await page.fill('#su-password', 'surrey-forward-2026');
await page.click('button[type="submit"]');
await page.waitForURL(/\/(admin|desk)\/?$/, { timeout: 15000 });
const me = (await D.api('/auth/me')).json;
const campaign = me.workspace?.name || '';
const act = async (name, input) => {
  const r = await D.api(`/actions/${name}`, input);
  if (r.status !== 200) console.log(`  (${name} → ${r.status} ${r.raw.slice(0, 200)})`);
  return r.json;
};
const P = {};
const mk = async (key, first, last, address, lat, lng, extra = {}) => {
  P[key] = (await act('person.create', { first_name: first, last_name: last, address, city: 'Surrey', ...(lat != null ? { lat, lng } : {}), ...extra })).person;
};
await mk('ana', 'Ana', 'Example', '12390 72 Ave', 49.1331, -122.8495, { phone: '604-555-0151', email: `ana.${tag}@example.org`, tags: ['do-not-call'] });
await mk('ben', 'Ben', 'Sample', '12390 72 Ave', 49.1331, -122.8495, { phone: '604-555-0152' });
await mk('cy', 'Cy', 'Van Sample', '12345 72 Ave', 49.1330, -122.8510, { phone: '604-555-0153', tags: ['do-not-contact'] });
await mk('dee', 'Dee', 'Example', '7120 124 St', 49.1310, -122.8520);
await mk('eve', 'Eve', 'Example', '7150 124 St', 49.1300, -122.8530, { phone: '604-555-0155' });
await mk('fay', 'Fay', 'Nowhere', '15000 88 Ave', null, null);
const turf = (await act('turf.create', {
  name: 'Newton East', polygon: [[49.125, -122.860], [49.140, -122.860], [49.140, -122.838], [49.125, -122.838]],
})).turf;
await act('turf.create', { name: 'Fleetwood West', polygon: [[49.16, -122.80], [49.17, -122.80], [49.17, -122.79], [49.16, -122.79]] });
const yr = new Date().getFullYear();
const iso = (d) => d.toISOString().slice(0, 10);
await act('gift.log', { person_id: P.ana.id, amount_cents: 5000, date: iso(new Date()), method: 'cash' });
await act('gift.log', { person_id: P.eve.id, amount_cents: 125000, date: iso(new Date()), method: 'cheque' });
await act('gift.log', { person_id: P.ben.id, amount_cents: 2000, date: `${yr - 1}-06-15`, method: 'cash' });
// Ratings: Ana Lean yes; Ben voting for Locke (4B).
await act('contact.log', { person_id: P.ana.id, channel: 'door', outcome: 'contacted', rating: '2' });
await act('contact.log', { person_id: P.ben.id, channel: 'door', outcome: 'contacted', rating: '4B' });
const fields = (await D.api('/fields')).json;
const cand = (fields?.fields || fields || []).find?.((f) => /interested in being a candidate/i.test(f.name));
await act('field.values.set', { person_id: P.dee.id, values: [{ field_id: cand?.id, value: true }] });
await act('script.save', { context: 'door', body: 'Hi {{first_name}}, I’m {{my_name}} with {{campaign}}.' });
const pass = (await act('pass.start', { name: 'Persuasion · November', kind: 'persuasion', who: 'all', tries: 2 }))?.pass;
// Eve's door knocked in the pass: done.
await act('contact.log', { person_id: P.eve.id, channel: 'door', outcome: 'contacted' });
check('seeded people, two turfs, gifts, a candidate, a script and a pass', Object.values(P).every((p) => p?.id) && turf?.id && cand?.id && pass?.id, JSON.stringify({ cand: cand?.id, pass: pass?.id }));

// ── 2. Reports opens on Quick reports ──
await D.go('/reports');
const loadingSeen = /Loading…/.test(await D.text('.rp-quick'));
const menu = await settled(page, '.rp-quick');
check('Reports: the Quick reports heading first', (await page.locator('.rp-page h2').first().innerText()) === 'Quick reports');
check('the seven, each with its line and its number', ['Walking list', 'Donors', 'Interested in being a candidate', 'Volunteers', 'Members', 'Signs to put up', 'Moved — needs an address'].every((t) => menu.includes(t))
  && /2 turfs/.test(menu) && !/Unavailable/.test(menu), menu);
check('the counts said Loading… first (or were already there)', loadingSeen || /2 turfs/.test(menu));
const field = page.locator('a', { hasText: 'Field, by turf →' });
check('"Field, by turf →" is still one link, not primary', (await field.count()) === 1 && !/btn-primary/.test(await field.getAttribute('class')));
check('the numbers are not read until More is opened', (await page.locator('.rp-totals').count()) === 0);
await page.click('button:has-text("More: numbers and exports")');
await page.waitForSelector('.rp-totals', { timeout: 8000 });
const totals = await D.text('.rp-totals');
check('More opens the totals and the old tables', /people/.test(totals) && /raised this year/.test(totals) && (await page.locator('.rp-sec h2', { hasText: 'Tags' }).count()) === 1, totals);
await both(page, D, 'reports-more');
await page.reload({ waitUntil: 'domcontentloaded' }); await sleep(800);
await settled(page, '.rp-quick');
await both(page, D, 'reports');
// The shared turfs cache is untouched: Turfs still shows door counts.
await page.click('.rp-quick__i:has-text("Walking list")');
await page.waitForSelector('.ws-turfs', { timeout: 8000 });
await page.click('.ops-back');
await page.waitForSelector('.rp-quick', { timeout: 8000 });
await page.evaluate(() => { window.history.pushState({}, '', window.location.pathname.replace(/\/reports$/, '/turfs')); window.dispatchEvent(new PopStateEvent('popstate')); });
await sleep(900);
const turfsText = await settled(page, 'main');
check('after Reports, Turfs still shows each turf’s door counts', /door/.test(turfsText), turfsText.slice(0, 200));

// ── 3. Donors ──
await D.go('/reports/quick/donors');
let t = await settled(page, '.qr-page');
check('Donors: the number and the dollars', /2 donors · \$1,300\.00/.test(t), t.slice(0, 200));
const lastNames = await page.$$eval('.qr-table tbody tr', (rows) => rows.map((r) => r.children[1]?.innerText));
check('A–Z by last name', lastNames.join(',') === 'Example,Example', lastNames.join(','));
const anaRow = await D.text('.qr-table tbody tr:nth-child(1)');
check('"Do not call" in Ana’s Phone cell; no number', /Do not call/.test(anaRow) && !/555-0151/.test(anaRow), anaRow);
check('Print is the one primary', (await measure(page)).yellow === 1 && (await page.locator('.btn-primary', { hasText: 'Print' }).count()) === 1);
await page.click('.qr-chip:has-text("Last year")');
await sleep(800);
t = await settled(page, '.qr-page');
check('a chip changes the address and the number', /period=last_year/.test(page.url()) && /1 donor\b/.test(t), `${page.url()} ${t.slice(0, 120)}`);
check('Make it a list: not for Last year', (await page.locator('button.disclose', { hasText: 'More' }).count()) === 0);
await page.click('.qr-chip:has-text("Lapsed")'); await sleep(800);
await openMore(page);
check('Make it a list on Lapsed', (await page.locator('a', { hasText: 'Make it a list' }).getAttribute('href'))?.endsWith('/lists/new?gave=lapsed'));
await page.click('.qr-chip:has-text("This year")'); await sleep(500);
await page.click('.qr-chip:has-text("Largest first")'); await sleep(800);
const largest = await page.$$eval('.qr-table tbody tr', (rows) => rows.map((r) => r.children[2]?.innerText));
check('Largest first', /order=largest/.test(page.url()) && largest[0] === 'Eve', largest.join(','));
await both(page, D, 'donors-largest');
await page.click('.qr-chip:has-text("A–Z by last name")'); await sleep(800);
await openMore(page);
const mk1 = page.locator('a', { hasText: 'Make it a list' });
check('Make it a list on This year', (await mk1.getAttribute('href'))?.endsWith('/lists/new?gave=year'));
const csv = await D.api('/quick-reports/donors.csv?period=year');
check('Download CSV: the file, with a BOM and Last name,First name,Total', /filename="donors-this-year-\d{4}-\d{2}-\d{2}\.csv"/.test(csv.disp) && csv.bom && csv.raw.startsWith('﻿Last name,First name,Total'), `${csv.disp} ${JSON.stringify(csv.raw.slice(0, 40))}`);
const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }).catch(() => null), page.click('a:has-text("Download CSV")')]);
check('the Download CSV link downloads it', dl && /^donors-this-year-.*\.csv$/.test(dl.suggestedFilename()), dl?.suggestedFilename());
await both(page, D, 'donors');
await page.setViewportSize(PHONE); await sleep(300);
const stack = await page.$$eval('.qr-table tbody tr:first-child td', (tds) => tds.filter((td) => td.getBoundingClientRect().height > 0).map((td) => `${td.dataset.label || ''}:${td.innerText}`));
check('the phone stack: the name first and two facts', stack.length === 3 && /Ana Example/.test(stack[0]) && stack.includes('Phone:Do not call') && stack.includes('Total:$50.00'), JSON.stringify(stack));
await page.setViewportSize(WIDE);
await page.emulateMedia({ media: 'print' });
await page.pdf({ path: `${SHOTS}/donors.pdf`, format: 'Letter' });
await page.emulateMedia({ media: 'screen' });

// ── 4. Interested in being a candidate; the others ──
await D.go('/reports/quick/running');
t = await settled(page, '.qr-page');
check('Interested in being a candidate: Dee', /1 person/.test(t) && /Dee/.test(t), t.slice(0, 200));
await openMore(page);
await page.click('a:has-text("Make it a list")');
await sleep(800);
check('Make it a list opens /lists/new with the filter', new RegExp(`/lists/new\\?field=${cand?.id}(%3A|:)yes`).test(page.url()), page.url());
await D.go('/reports/quick/running');
await settled(page, '.qr-page');
await both(page, D, 'running');
// Renamed, the field is not found: the sentence in place, Print off.
await act('field.update', { id: cand?.id, name: 'Might run' });
await D.go('/reports/quick/running');
t = await settled(page, '.qr-page');
check('after a rename: Unavailable, in place, and Print off', /Unavailable — the profile field “Interested in being a candidate” was renamed/.test(t)
  && await page.locator('.btn-primary:has-text("Print")').isDisabled(), t.slice(0, 200));
await both(page, D, 'running-renamed');
await act('field.update', { id: cand?.id, name: 'Interested in being a candidate' });
for (const name of ['volunteers', 'members', 'signs', 'moved']) {
  await D.go(`/reports/quick/${name}`);
  const s = await settled(page, '.qr-page');
  check(`${name}: opens with its number or No one yet.`, /\d/.test(s) && !/Unavailable/.test(s), s.slice(0, 160));
  await both(page, D, name);
}

// ── 5. The walking list ──
await D.go('/reports/walk');
const chooser = await settled(page, '.qr-page');
check('the chooser lists turf names A–Z', (await page.$$eval('.ws-turfs a', (a) => a.map((x) => x.innerText))).join('|') === 'Fleetwood West|Newton East');
check('the "aren’t on the map yet" line, once', /1 person with an address isn’t on the map yet, so they’re on no walking list\./.test(chooser), chooser);
await both(page, D, 'walk-chooser');
await page.click('.ws-turfs a:has-text("Newton East")');
await page.waitForSelector('.ws-sheet', { timeout: 8000 });
let sheet = await D.text('.ws-sheet');
check('the head and its line', sheet.includes('Newton East — walking list') && /Persuasion · November · \d+ doors? · \d+ people · printed/.test(sheet), sheet.slice(0, 200));
check('the Canvasser line', /Canvasser _+ +Date _+ +Back to the office by _+/.test(sheet));
const heads = await page.$$eval('.ws-table thead th', (th) => th.map((x) => x.innerText.trim()));
check('the heads in the scale’s words, then the plain outcomes', heads.slice(1).join('|') === 'Strong yes|Lean yes|Undecided|Opposed|Not home|Refused|Moved|Left a flyer|Can’t get in|Sign|Volunteer|Note', heads.join('|'));
check('If Opposed, the letters', /If Opposed, write the letter of who they’re voting for: D McCallum · B Locke · F Annis · N van Vliet · C Randhawa/.test(sheet));
check('the script filled with the campaign’s name', sheet.includes(`Hi [their first name], I’m [your name] with ${campaign}.`), sheet.slice(0, 400));
check('street headings with capitals kept', (await page.$$eval('.ws-street th', (th) => th.map((x) => x.innerText))).includes('72 Ave'));
check('Last: Lean yes; Last: voting for Locke', /Last: Lean yes/.test(sheet) && /Last: voting for Locke/.test(sheet));
check('Do not contact — skip', /Do not contact — skip/.test(sheet));
check('no phone, no email, no "not on the map", no two-letter code', !/555-01|@example\.org|not on the map/i.test(sheet) && !/\b(NH|NA)\b/.test(sheet) && !/\b[1-4][A-Z]\b/.test(sheet));
check('Still to knock: Eve’s door (done) left off', !/7150/.test(sheet));
await page.click('.qr-chip:has-text("Every door")'); await sleep(900);
sheet = await D.text('.ws-sheet');
check('Every door: Eve’s door, marked Done', /7150 124 St\s*Done/.test(sheet), sheet.slice(0, 300));
await page.click('.qr-chip:has-text("Script: Off")'); await sleep(300);
check('Script Off removes the box', (await page.locator('.ws-script').count()) === 0);
await page.click('.qr-chip:has-text("Script: On")'); await sleep(300);
await both(page, D, 'walk-sheet');
await page.emulateMedia({ media: 'print' });
const printed = await page.evaluate(() => {
  const vis = (s) => [...document.querySelectorAll(s)].some((el) => getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0);
  return { nav: vis('.nav, .tabbar'), chips: vis('.qr-chip'), buttons: vis('.ops-head__actions .btn'), sheet: vis('.ws-sheet'), ticks: vis('.ws-tick'), text: document.body.innerText };
});
check('print: no nav, tab bar, chips or buttons; the sheet and its ticks', !printed.nav && !printed.chips && !printed.buttons && printed.sheet && printed.ticks, JSON.stringify({ ...printed, text: undefined }));
check('print: "Private — bring this sheet back to the office."', printed.text.includes('Private — bring this sheet back to the office.'));
await page.pdf({ path: `${SHOTS}/walking-list.pdf`, format: 'Letter' });
await page.emulateMedia({ media: 'screen' });

// ── 6. The way in from a turf ──
await D.go(`/turfs/${turf.id}`);
await page.waitForSelector('.walk-nav', { timeout: 8000 });
check('the desk’s walk list: Print', (await page.locator('.walk-nav a', { hasText: 'Print' }).count()) === 1);
await page.click('.walk-nav a:has-text("Print")');
await page.waitForSelector('.ws-sheet', { timeout: 8000 });
check('Print opens the sheet', /\/reports\/walk\?turf=/.test(page.url()));
await D.go(`/turfs/${turf.id}`, true);
await page.waitForSelector('.walk-nav', { timeout: 8000 });
check('the field app’s walk list: no Print', (await page.locator('.walk-nav a', { hasText: 'Print' }).count()) === 0);

// ── 7. No signal ──
await D.go('/reports');
await settled(page, '.rp-quick');
await dctx.setOffline(true);
await page.click('.rp-quick__i:has-text("Members")');
await sleep(800);
const off = await D.text('.qr-page');
check('no signal: Needs signal, Print off', /Needs signal/.test(off) && await page.locator('.btn-primary:has-text("Print")').isDisabled(), off.slice(0, 160));
await D.shot('no-signal-1440');
await dctx.setOffline(false);

// ── 8. Staff denied Donations; staff with Map only; a volunteer ──
const join = async (role, first, perms) => {
  const inv = await act('member.invite', { email: `${first.toLowerCase()}+${tag}@quick.example`, role });
  const ctx = await browser.newContext({ viewport: WIDE, timezoneId: 'America/Vancouver' });
  const pg = await ctx.newPage();
  const H = helpers(pg, first);
  await H.go('/login');
  const j = await H.api('/auth/join', { token: inv.joinUrl.split('/').pop(), name: `${first} Example`, password: 'knock-knock-2026' });
  if (perms) await act('permission.member.set', { user_id: j.json?.user?.id || (await H.api('/auth/me')).json.user.id, grant: [], deny: [], ...perms });
  return { pg, H, ctx };
};
const nia = await join('staff', 'Nia', { deny: ['money'] });
await nia.H.go('/reports');
const niaMenu = await settled(nia.pg, '.rp-quick');
check('denied Donations: no Donors, no Members', !/Donors/.test(niaMenu) && !/Members/.test(niaMenu) && /Walking list/.test(niaMenu), niaMenu);
await nia.pg.click('button:has-text("More: numbers and exports")');
await nia.pg.waitForSelector('.rp-totals', { timeout: 8000 });
check('denied Donations: the totals have no Donations line', !/raised/.test(await nia.H.text('.rp-totals')));
await nia.H.go('/reports/quick/donors');
const niaDon = await settled(nia.pg, '.qr-page');
check('denied Donations: the Donors report says not for you, in place', /not for you — ask a manager under Admin → Permissions/.test(niaDon), niaDon.slice(0, 200));
await nia.H.shot('denied-donors-1440');

const max = await join('staff', 'Max', { deny: ['people', 'shifts', 'money', 'signs', 'outreach', 'data', 'learn', 'media'] });
await max.H.go('/');
await max.pg.waitForSelector('.cmd-btn', { timeout: 10000 });
await max.pg.keyboard.press('Control+k');
await max.pg.waitForSelector('.cmd [role="combobox"]');
await max.pg.locator('.cmd [role="combobox"]').fill('report');
await sleep(300);
const maxOpts = await max.pg.$$eval('.cmd [role="option"]', (els) => els.map((e) => e.textContent));
await max.pg.locator('.cmd [role="combobox"]').fill('walking');
await sleep(300);
const maxWalk = await max.pg.$$eval('.cmd [role="option"]', (els) => els.map((e) => e.textContent));
check('Map only: the bar offers Print a walking list, not Reports nor Donors', maxWalk.some((x) => /Print a walking list/.test(x)) && !maxOpts.some((x) => /^Reports|Donors report/.test(x)), JSON.stringify([maxOpts, maxWalk]));
await max.pg.keyboard.press('Enter');
await sleep(900);
check('Map only: the bar opens the walking list', /\/reports\/walk$/.test(max.pg.url()) && /Walking list/.test(await max.H.text('h1')), max.pg.url());
check('Map only: back goes to Turfs, not Reports', (await max.pg.locator('.ops-back').innerText()).includes('Turfs'));
await max.pg.click('.ws-turfs a:has-text("Newton East")');
await max.pg.waitForSelector('.ws-sheet', { timeout: 8000 });
check('Map only: the sheet opens', /Newton East — walking list/.test(await max.H.text('.ws-sheet')));
await max.H.go('/reports');
check('Map only: Reports itself goes home', !/\/reports$/.test(max.pg.url()), max.pg.url());

const vol = await join('volunteer', 'Vic');
await vol.H.go('/reports/walk', true);
await sleep(1200);
check('a volunteer: a typed /reports/walk in their app goes home', !/\/reports/.test(vol.pg.url()) && !/Walking list/.test(await vol.H.text()), vol.pg.url());
await vol.H.go('/reports/walk');
check('a volunteer: the desk’s address says Not for your role, no sheet', /Not for your role/.test(await vol.H.text()) && (await vol.pg.locator('.ws-turfs, .ws-sheet').count()) === 0);
const vr = await vol.H.api('/quick-reports-menu');
check('a volunteer: the server says desk only', vr.status === 403);

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
server.kill();
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
