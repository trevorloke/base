// Voter guide E2E (VG) — one campaign on a file-backed database, the server
// started and restarted by this suite with the clock moved only by
// STARBASE_CLOCK_SHIFT_MS (STARBASE_E2E=1), a fake B.C. address service on
// 5513 and a plain "someone else's website" on 5514 that frames the embed.
// Made-up data only ("Example Community Hall", "Sample Secondary School");
// the dates are relative to the test's today (advance days in 3 and 4
// days, election day in 6).
//   1. a manager opens Website → Voter guide: the empty state; adds two
//      advance days and election day; sees the checklist;
//   2. pastes 6 places (one bad day, one the fake service can't find): New 5
//      · Not on the map 1 · Problem 1; fixes the row; saves; Shifts' places
//      list them as voting places;
//   3. vote anywhere; both checks; the official link; a ballot (Mayor 3
//      names, Councillor 10) with the slate's name ticked Ours; checked;
//   4. adds the guide page and publishes it; the public page says it isn't
//      out; "Tell me when it's out" signs someone up;
//   5. publishes with "Also use these days for GOTV mode"; GOTV's screen
//      (/voted) shows the days;
//   6. advance day 1 at 10:00: open at 1440 and 390, Use my location sorts,
//      Find sorts, Directions is GMP's dir link, the banner on another page;
//      with JavaScript off ?area= shows that area and the plain page all;
//   7. a volunteer's phone on /vote-info; the desk marks a place Closed
//      today; the phone's next read (back to the foreground) strikes it;
//      the public page shows its note and "Changed …"; the next voting day
//      it is open by its hours, no strike-through;
//   8. Today's "Where to vote"; a walk-list door's More → "Nearest to …"
//      with three rows; Show the voter's QR code is the guide's address with
//      ?near= at 2 decimals; no request carries the door's address, its full
//      pin or a person id (also after a reload);
//   9. a door 80 m from an open place: the warning, no Show the voter, no
//      names, Directions there, the walk list's chip; closed today or after
//      8 p.m.: neither;
//  10. offline: the kept copy opens with its QR; a phone that never loaded
//      it says so;
//  11. past the last close: over, no banner, no Today row — and a browser
//      in America/Los_Angeles flips at the same instant;
//  12. the embed framed by a saved origin, Use my location inside it; an
//      unsaved origin is refused;
//  13. staff with the Website area: no Publish, Unpublish, Clear or embed
//      addresses; a volunteer on /website/guide gets the field fallback;
//  14. every screen: ≤ 1 primary, no sideways scroll at 390, 48 px phone
//      targets, console clean (no hydration warnings).
// The QR is checked by reading the drawn modules back and comparing them
// with the code for the expected address (jsqr, which the spec names for
// decoding, is not a dependency of this repository).
//
//   flock -o SP/batch6/locks/browser.lock node e2e-voteguide.mjs                       (5510)
//   BASE_PATH=/imaginesurrey PORT=5511 flock -o SP/batch6/locks/browser.lock node e2e-voteguide.mjs
// SHOTS=<dir> for the screenshots (default /tmp/starbase-voteguide).
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { qrMatrix } from './shared/qr.js';

const PORT = Number(process.env.PORT || 5510);
const P = String(process.env.BASE_PATH || '').replace(/\/+$/, '');
const ORIGIN = `http://127.0.0.1:${PORT}`;
const DESK = `${ORIGIN}${P ? `${P}/desk` : '/admin'}`;
const FIELD = `${ORIGIN}${P ? `${P}/field` : ''}`;
const SITE = `${ORIGIN}${P}/site`;
const API = `${ORIGIN}${P}/api`;
const GEO_PORT = 5513;
const FRAME_PORT = 5514;
const SHOTS = process.env.SHOTS || '/tmp/starbase-voteguide';
mkdirSync(SHOTS, { recursive: true });
const DATA = mkdtempSync(join(tmpdir(), 'vg-e2e-'));
const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 260) : ''}`);
};
const skip = (name, why) => console.log(`SKIP  ${name}  — ${why}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Days, by B.C.'s clock (UTC-7 all year) ──
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const bcDay = (ms) => new Date(ms - 7 * HOUR).toISOString().slice(0, 10);
const plus = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const at = (day, hm) => Date.parse(`${day}T${hm}:00Z`) + 7 * HOUR;
const TODAY = bcDay(Date.now());
const A1 = plus(TODAY, 3); const A2 = plus(TODAY, 4); const G = plus(TODAY, 6);

// ── The fake B.C. address service: lat 49.10 + n/10000 for house number n ──
const lookups = [];
const geo = createServer((req, res) => {
  const q = new URL(req.url, 'http://x').searchParams.get('addressString') || '';
  lookups.push(q);
  res.setHeader('content-type', 'application/json');
  if (/nowhere/i.test(q)) return res.end(JSON.stringify({ features: [] }));
  const n = Number(/(\d+)/.exec(q)?.[1] || 1);
  return res.end(JSON.stringify({ features: [{ geometry: { coordinates: [-122.8, 49.1 + n / 10000] }, properties: { score: 99, matchPrecision: 'CIVIC_NUMBER', fullAddress: q } }] }));
});
await new Promise((r) => geo.listen(GEO_PORT, '127.0.0.1', r));
// ── Someone else's website, framing the guide ──
const framer = createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><meta charset="utf-8"><title>Example society</title><h1>Example society</h1>
<iframe src="${SITE}/embed/voter-guide" title="Voter guide" allow="geolocation" loading="lazy" style="width:100%;min-height:1200px;border:0"></iframe>
<script src="${SITE}/site-assets/embed.js" async></script>`);
});
await new Promise((r) => framer.listen(FRAME_PORT, '0.0.0.0', r));

// ── The server, restarted with a moved clock ──
let server = null;
const startServer = async (shift = 0) => {
  server = spawn(process.execPath, ['server/index.js'], {
    env: {
      ...process.env, PORT: String(PORT), STARBASE_OPEN_SIGNUP: '1', STARBASE_DATA: DATA, STARBASE_E2E: '1', STARBASE_CLOCK_SHIFT_MS: String(Math.round(shift)),
      GEOCODER: 'bc', BC_GEOCODER_URL: `http://127.0.0.1:${GEO_PORT}`, STARBASE_GEO_BOUNDS: '49.002,-122.92|49.222,-122.67', SITE_CACHE_SECONDS: '60',
      ...(P ? { BASE_PATH: P } : {}),
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  for (let i = 0; i < 120; i += 1) {
    try { if ((await fetch(`${API}/health`)).ok) return; } catch { /* not yet */ }
    await sleep(250);
  }
  throw new Error('server did not start');
};
const stopServer = async () => {
  if (!server) return;
  const s = server; server = null;
  s.kill('SIGTERM');
  await new Promise((r) => { s.once('exit', r); setTimeout(r, 5000); });
};
const moveTo = async (ms) => { await stopServer(); await startServer(ms - Date.now()); };

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const errors = [];
const watch = (page, who) => {
  page.on('pageerror', (e) => errors.push(`[${who}] ${e.message}`));
  page.on('console', (m) => {
    const t = m.text();
    if (/hydrat/i.test(t) || (m.type() === 'error' && !/Failed to load resource|ERR_INTERNET_DISCONNECTED|net::ERR|frame-ancestors|Refused to frame/i.test(t))) errors.push(`[${who}] ${t}`);
  });
  return page;
};
const api = (page, path, body) => page.evaluate(async ([u, b]) => {
  const r = await fetch(u, b === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  const raw = await r.text();
  let json = null; try { json = JSON.parse(raw); } catch { /* not json */ }
  return { status: r.status, json };
}, [`${API}${path}`, body]);
const act = (page, name, input) => api(page, `/actions/${name}`, input);
const text = async (page, sel = 'body') => ((await page.innerText(sel).catch(() => '')) || '').replace(/\s+/g, ' ');
const measure = (page, targets = null) => page.evaluate((sel) => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const yellow = [...document.querySelectorAll('.btn-primary')].filter(vis).length;
  const overflow = document.documentElement.scrollWidth - window.innerWidth;
  let minTap = null;
  if (sel) for (const el of document.querySelectorAll(sel)) { if (!vis(el)) continue; const h = el.getBoundingClientRect().height; minTap = minTap == null ? h : Math.min(minTap, h); }
  return { yellow, overflow, minTap };
}, targets);
const simple = async (page, name, { phone = false, targets = null } = {}) => {
  const m = await measure(page, targets);
  check(`${name}: ≤ 1 primary, no sideways scroll${phone && targets ? ', ≥ 48 px targets' : ''}`, m.yellow <= 1 && m.overflow <= 0 && (!phone || !targets || m.minTap === null || m.minTap >= 47.5), JSON.stringify(m));
};
const shot = (page, n, full = false) => page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: full });
const go = async (page, url) => { await page.goto(url, { waitUntil: 'domcontentloaded' }); await sleep(900); };

let exitCode = 1;
try {
  await startServer(0);
  // ── A manager (signed up through the API), the slate's name, a volunteer and staff ──
  const mctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, timezoneId: 'America/Vancouver' });
  const mpage = watch(await mctx.newPage(), 'manager');
  await go(mpage, `${DESK}/login`);
  const su = await api(mpage, '/auth/signup', { name: 'Ana Example', email: 'ana@example.org', password: 'voterguide-2027', workspaceName: 'Example Campaign', jurisdiction: 'bc-municipal' });
  check('a manager signed up', su.status === 200 || su.status === 201, su.status);
  await act(mpage, 'site.settings.save', { org: { name: 'Example Campaign', agentName: 'Pat Example', agentContact: 'agent@example.org' } });
  check('the slate has Ann Example', (await act(mpage, 'candidate.save', { name: 'Ann Example', office: 'Mayor', race: '' })).status === 200);
  // Two doors: one 78 m from where Example Community Hall will be (49.1100), one between places.
  const near = { lat: 49.1107, lng: -122.8 }; const far = { lat: 49.1253, lng: -122.8012 };
  const harjit = (await act(mpage, 'person.create', { name: 'Harjit Example', phone: '604-555-0141', address: '11 Example Close', city: 'Surrey', ...near })).json.person;
  const maya = (await act(mpage, 'person.create', { name: 'Maya Example', phone: '604-555-0142', address: '12530 Example Street', city: 'Surrey', ...far })).json.person;
  const turf = (await act(mpage, 'turf.create', { name: 'Example block', polygon: [[49.105, -122.81], [49.105, -122.79], [49.13, -122.79], [49.13, -122.81]] })).json.turf;
  check('two doors in a turf', Boolean(harjit?.id && maya?.id && turf?.id));
  const fields = (await api(mpage, '/fields')).json?.fields || [];
  const language = fields.find((f) => f.name === 'Language');
  if (language) await act(mpage, 'field.values.set', { person_id: maya.id, values: [{ field_id: language.id, value: ['Punjabi'] }] });
  const join = async (role, name, email, opts) => {
    const inv = (await act(mpage, 'member.invite', { email, role })).json;
    const ctx = await browser.newContext({ deviceScaleFactor: 1, timezoneId: 'America/Vancouver', ...opts });
    const page = watch(await ctx.newPage(), role);
    await go(page, `${role === 'volunteer' ? FIELD : DESK}/login`);
    const r = await api(page, '/auth/join', { token: inv.joinUrl.split('/').pop(), name, password: 'knock-knock-2026' });
    return { ctx, page, ok: r.status === 200, id: (await api(page, '/auth/me')).json?.user?.id };
  };
  const vol = await join('volunteer', 'Vic Volunteer', 'vic@example.org', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  check('a volunteer joined', vol.ok);
  await act(mpage, 'turf.assign', { turf_id: turf.id, user_id: vol.id });
  await act(mpage, 'permission.role.set', { role: 'staff', grant: ['site'], deny: [] });
  const staff = await join('staff', 'Sam Staff', 'sam@example.org', { viewport: { width: 1440, height: 900 } });
  check('staff with the Website area joined', staff.ok);

  // ── 1. Website → Voter guide: empty, days, the checklist ──
  await go(mpage, `${DESK}/website/guide`);
  await mpage.waitForSelector('.wg-page h1', { timeout: 10000 }).catch(() => {});
  check('1. the empty state', /Nothing yet\. Add it when the elections office publishes it\./.test(await text(mpage)) && /Not out yet/.test(await text(mpage, '.wg-head')));
  await shot(mpage, '01-desk-empty-1440');
  await mpage.click('button:has-text("Add voting days")');
  await mpage.click('#wg-days button:has-text("Add a day")');
  await mpage.click('#wg-days button:has-text("Add a day")');
  for (const [i, d, k] of [[0, A1, 'advance'], [1, A2, 'advance'], [2, G, 'general']]) {
    await mpage.fill(`#wg-d-${i}`, d);
    await mpage.selectOption(`#wg-k-${i}`, k);
    await mpage.fill(`#wg-o-${i}`, '08:00');
    await mpage.fill(`#wg-c-${i}`, '20:00');
  }
  await mpage.click('#wg-days button:has-text("Save")');
  await sleep(1200);
  const g1 = (await api(mpage, '/site/guide')).json;
  check('1. three days saved (two advance, election day)', g1.guide.days.length === 3 && g1.guide.days.filter((d) => d.kind === 'advance').length === 2, JSON.stringify(g1.guide.days.map((d) => d.day)));
  const firstMissing = await text(mpage, '.wg-checks');
  check('1. the checklist names what is missing', /Add at least one voting place/.test(firstMissing) && /Say whether voters can vote at any voting place/.test(firstMissing), firstMissing.slice(0, 200));
  await shot(mpage, '02-desk-checklist-1440', true);
  await simple(mpage, 'desk with days');

  // ── 2. Import 6 places ──
  await mpage.click('#wg-places button:has-text("Import places")');
  const paste = (bad) => ['Name,Address,Days,Area',
    'Example Community Hall,100 Example Ave,All,Newton',
    'Sample Secondary School,200 Sample St,All,Fleetwood',
    'Example Library,300 Example Rd,Advance,Newton',
    'Example Recreation Centre,400 Example Way,Election day,Fleetwood',
    `Example Arena,500 Example Blvd,${bad ? 'Someday' : 'All'},Newton`,
    'Example Church Hall,999 Nowhere Lane,All,Newton'].join('\n');
  await mpage.fill('#wg-imp', paste(true));
  await mpage.click('button:has-text("Preview")');
  await mpage.waitForSelector('.wg-counts', { timeout: 15000 }).catch(() => {});
  const counts = await text(mpage, '.wg-counts');
  check('2. preview: New 5 · Not on the map 1 · Problem 1', /New 5/.test(counts) && /Not on the map 1/.test(counts) && /Problem 1/.test(counts), counts);
  check('2. the bad day says how to write days', /Use dates like YYYY-MM-DD or Oct 19, or Advance, Election day or All/.test(await text(mpage, '.wg-preview')));
  await shot(mpage, '03-import-preview-1440', true);
  await mpage.fill('#wg-imp', paste(false));
  await mpage.click('button:has-text("Preview")');
  await mpage.waitForSelector('.wg-counts', { timeout: 15000 }).catch(() => {});
  check('2. fixed: Problem 0', /Problem 0/.test(await text(mpage, '.wg-counts')), await text(mpage, '.wg-counts'));
  await mpage.click('button:has-text("Save these places")');
  await sleep(1500);
  const g2 = (await api(mpage, '/site/guide')).json;
  check('2. six places in the guide, five on the map', g2.guide.places.length === 6 && g2.guide.places.filter((p) => p.lat != null).length === 5, g2.guide.places.length);
  const shiftsPlaces = (await api(mpage, '/places')).json?.places || [];
  check('2. Shifts’ places list them as voting places', shiftsPlaces.filter((p) => p.voting).length === 6, shiftsPlaces.length);
  const hall = g2.guide.places.find((p) => p.name === 'Example Community Hall');

  // ── 3. Anywhere, checks, the official link, the ballot ──
  await mpage.click('label:has-text("Yes, at any voting place")');
  await sleep(800);
  await mpage.click('#wg-days .wg-foot input[type=checkbox]');
  await sleep(600);
  await mpage.click('#wg-places .wg-foot input[type=checkbox]');
  await sleep(600);
  await mpage.fill('#wg-ourl', 'https://elections.example.org/vote');
  await mpage.fill('#wg-olab', 'Example City elections');
  await mpage.click('#wg-official button:has-text("Save")');
  await sleep(800);
  await mpage.click('#wg-ballot button:has-text("Add an office")');
  await mpage.click('#wg-ballot button:has-text("Add an office")');
  await mpage.fill('#wg-off-0', 'Mayor'); await mpage.fill('#wg-vf-0', '1');
  await mpage.fill('#wg-names-0', 'EXAMPLE, Ann\nBo Sample\nCy Sample');
  await mpage.fill('#wg-off-1', 'Councillor'); await mpage.fill('#wg-vf-1', '8');
  await mpage.fill('#wg-names-1', Array.from({ length: 10 }, (_, i) => `Councillor Example ${i + 1}`).join('\n'));
  await mpage.click('#wg-ballot button:has-text("Save")');
  await sleep(1200);
  const annBox = mpage.locator('#wg-ballot label:has-text("EXAMPLE, Ann · Ours") input');
  check('3. the slate’s name is ticked Ours', await annBox.isChecked().catch(() => false));
  await mpage.click('#wg-ballot .wg-foot input[type=checkbox]');
  await sleep(800);
  const g3 = (await api(mpage, '/site/guide')).json;
  check('3. anywhere, three checks, the link, two contests', g3.guide.vote_anywhere === true && ['days', 'places', 'ballot'].every((s) => g3.guide.checked[s]) && g3.guide.official_url && g3.guide.contests.length === 2,
    JSON.stringify({ any: g3.guide.vote_anywhere, checked: Object.keys(g3.guide.checked) }));
  check('3. the checklist is complete', g3.checklist.every((c) => c.done), JSON.stringify(g3.checklist.filter((c) => !c.done)));
  await shot(mpage, '04-desk-filled-1440', true);

  // ── 4. The guide page; not out; "Tell me when it's out" ──
  await mpage.click('.wg-more > summary');
  await mpage.click('button:has-text("Add the guide page")');
  await sleep(1000);
  const pages = (await api(mpage, '/site')).json?.pages || [];
  const gp = pages.find((p) => p.slug === 'voter-guide');
  check('4. the guide page is made as a draft', gp && gp.status !== 'published');
  await act(mpage, 'site.page.publish', { id: gp.id });
  const pub = watch(await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 })).newPage(), 'public');
  await go(pub, `${SITE}/voter-guide`);
  const notOut = await text(pub);
  check('4. public: “Voting information isn’t out yet.” and no place', /Voting information isn’t out yet\./.test(notOut) && !/Example Community Hall/.test(notOut));
  await shot(pub, '05-public-notout-390', true);
  await pub.fill('.vg--not-out input[type=email]', 'lena@example.org');
  for (const box of await pub.$$('.vg--not-out input[type=checkbox]')) await box.check().catch(() => {});
  await pub.click('.vg--not-out button[type=submit]');
  await sleep(1500);
  check('4. someone asked to be told', (await api(mpage, '/site/guide')).json.asked === 1);

  // ── 13. Staff: no Publish, no Unpublish/Clear/embed addresses; a volunteer gets the field ──
  await go(staff.page, `${DESK}/website/guide`);
  await staff.page.waitForSelector('.wg-page h1', { timeout: 10000 }).catch(() => {});
  await staff.page.click('.wg-more > summary').catch(() => {});
  const st = await text(staff.page);
  check('13. staff: no Publish, Unpublish, Clear or embed addresses', !(await staff.page.$('button:has-text("Publish")')) && !/Unpublish|Clear for the next election|Websites that may show it/.test(st) && /A manager publishes it\./.test(st));
  check('13. staff: publish refused by the server', (await act(staff.page, 'site.guide.publish', {})).json?.error === 'Only a manager can do this');
  await go(vol.page, `${FIELD}/website/guide`);
  check('13. a volunteer on /website/guide gets the field fallback', !(await vol.page.$('.wg-page')), vol.page.url());

  // ── 5. Publish with GOTV's days ──
  await go(mpage, `${DESK}/website/guide`);
  await mpage.waitForSelector('.wg-head .btn-primary', { timeout: 10000 }).catch(() => {});
  await mpage.click('.wg-head .btn-primary');
  check('5. the confirm ticks “Also use these days for GOTV mode”', await mpage.locator('label:has-text("Also use these days for GOTV mode") input').isChecked());
  await shot(mpage, '06-publish-confirm-1440');
  await mpage.click('.wg-confirm button:has-text("Yes")');
  await sleep(1500);
  check('5. live', /Live/.test(await text(mpage, '.wg-head')) && /View guide/.test(await text(mpage, '.wg-head')));
  await shot(mpage, '07-desk-live-1440');
  await go(mpage, `${DESK}/voted`);
  await mpage.waitForSelector('#vt-date', { timeout: 10000 }).catch(() => {});
  const vdays = await text(mpage, '.vt-days');
  check('5. GOTV’s screen shows the guide’s days', (await mpage.inputValue('#vt-date')) === G && (await mpage.$$('.vt-day')).length === 2, `${await mpage.inputValue('#vt-date')} ${vdays}`);
  check('5. GOTV: no “other days” line once they match', !/The voter guide has other days/.test(await text(mpage)));
  await go(pub, `${SITE}/`);
  check('before: the banner on the home page', /Voting starts/.test(await text(pub, '.vote-banner')), await text(pub, '.vote-banner'));

  // ── 6. Advance day 1 at 10:00 ──
  await moveTo(at(A1, '10:00'));
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, geolocation: { latitude: 49.1495, longitude: -122.8 }, permissions: ['geolocation'] });
    const p = watch(await ctx.newPage(), `public-${w}`);
    await p.goto(`${SITE}/voter-guide`, { waitUntil: 'networkidle' });
    check(`6. ${w}: “Voting is open now · until 8 p.m.”`, /Voting is open now · until 8 p\.m\./.test(await text(p, '.vg-status')), await text(p, '.vg-status'));
    await p.click('.vg-locate');
    await sleep(700);
    const firstName = await p.locator('.vg-places .vg-place-name').first().innerText().catch(() => '');
    check(`6. ${w}: Use my location sorts — Example Arena first`, /Nearest to you/.test(await text(p)) && firstName === 'Example Arena', firstName);
    await shot(p, `08-public-open-${w}`, true);
    await simple(p, `public open ${w}`, { phone: w === 390, targets: '.vg-locate, .vg-chips a, .vg-chips button' });
    if (w === 390) {
      await p.fill('.vg-address input', '210 Example Ave');
      await p.click('.vg-find-btn');
      await sleep(900);
      const f1 = await p.locator('.vg-places .vg-place-name').first().innerText().catch(() => '');
      check('6. Find sorts by the typed address — Sample Secondary School first', f1 === 'Sample Secondary School', f1);
      const href = await p.locator('.vg-directions').first().getAttribute('href');
      check('6. Directions is GMP’s dir link', /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=/.test(href || ''), href);
      await go(p, `${SITE}/`);
      check('6. another page shows the banner “Vote today until 8 p.m.”', /Vote today until 8 p\.m\./.test(await text(p, '.vote-banner')), await text(p, '.vote-banner'));
      await shot(p, '09-home-banner-390');
    }
    await ctx.close();
  }
  const nojs = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const nj = await nojs.newPage();
  await nj.goto(`${SITE}/voter-guide?area=Fleetwood`);
  // A voting day: "Open today" is on by default, so Fleetwood's place open today.
  const njNames = await nj.locator('.vg-places .vg-place-name').allInnerTexts();
  check('6. no JavaScript: ?area=Fleetwood shows Fleetwood’s place open today', njNames.join(',') === 'Sample Secondary School', njNames.join(', '));
  await nj.goto(`${SITE}/voter-guide`);
  const njAll = await nj.locator('.vg-places .vg-place-name').allInnerTexts();
  check('6. no JavaScript: the plain page then shows every place open today', njAll.length === 5 && !njAll.includes('Example Recreation Centre'), njAll.join(', '));
  await nojs.close();

  // ── 8. Today's row; a door's More; Show the voter; no door in any URL ──
  const reqs = [];
  vol.page.on('request', (r) => reqs.push(r.url()));
  await go(vol.page, `${FIELD}/`);
  await vol.page.waitForSelector('.today-rows', { timeout: 10000 }).catch(() => {});
  check('8. Today’s first row is “Where to vote”', (await vol.page.locator('ul.today-next > li').first().innerText().catch(() => '')).includes('Where to vote'));
  await shot(vol.page, '10-today-row-390');
  const doorOf = (name) => `.walk-door:has(.walk-door__names:has-text("${name}"))`;
  const openDoor = async (name) => {
    await go(vol.page, `${FIELD}/turfs/${turf.id}`);
    await vol.page.waitForSelector('.walk-door', { timeout: 10000 }).catch(() => {});
    if (!(await vol.page.$(`${doorOf(name)}.is-open`))) await vol.page.click(`${doorOf(name)} .walk-door__head`);
    await sleep(500);
    await vol.page.click(`${doorOf(name)} .walk-panel button:has-text("More")`).catch(() => {});
    await sleep(400);
    await vol.page.click(`${doorOf(name)} .walk-panel button:has-text("Where to vote")`);
    await vol.page.waitForURL(/\/vote-info$/, { timeout: 8000 }).catch(() => {});
    await vol.page.waitForSelector('.vi-page h1', { timeout: 8000 }).catch(() => {});
    await sleep(500);
  };
  await openDoor('Maya Example');
  const reqStart = reqs.length;
  const vi = await text(vol.page, '.vi-page');
  check('8. “Nearest to 12530 Example Street” with three rows', /Nearest to 12530 Example Street/.test(vi) && (await vol.page.locator('#vi-near-h + .vi-places > li').count()) === 3, vi.slice(0, 160));
  check('8. the address bar is /vote-info, nothing more', new URL(vol.page.url()).search === '' && new URL(vol.page.url()).hash === '', vol.page.url());
  await shot(vol.page, '11-vote-info-door-390', true);
  await simple(vol.page, 'Where to vote from a door', { phone: true, targets: '.vi-page .btn, .vi-sec__h' });
  await vol.page.click('button:has-text("Show the voter")');
  await vol.page.waitForSelector('.vi-qr', { timeout: 5000 }).catch(() => {});
  const links = (await api(vol.page, '/guide')).json?.links || {};
  const expected = `${links.en}?near=${far.lat.toFixed(2)},${far.lng.toFixed(2)}`;
  const drawn = await vol.page.evaluate(() => {
    const svg = document.querySelector('.vi-qr'); if (!svg) return null;
    const size = Number(svg.getAttribute('viewBox').split(' ')[2]);
    const d = svg.querySelector('path').getAttribute('d');
    const cells = [];
    for (const m of d.matchAll(/M(\d+) (\d+)h(\d+)/g)) for (let i = 0; i < Number(m[3]); i += 1) cells.push(`${Number(m[1]) + i},${m[2]}`);
    return { size, cells };
  });
  const want = qrMatrix(expected);
  const wantCells = [];
  want.forEach((row, y) => row.forEach((on, x) => { if (on) wantCells.push(`${x + 4},${y + 4}`); }));
  check('8. the QR code is the guide’s address with ?near= at 2 decimals', drawn && drawn.size === want.length + 8 && JSON.stringify([...drawn.cells].sort()) === JSON.stringify(wantCells.sort()), expected);
  check('8. the link under the code says the same', (await text(vol.page, '.vi-sheet__link')) === expected, await text(vol.page, '.vi-sheet__link'));
  if (links.pa) check('8. Punjabi preselected for a Punjabi speaker', (await vol.page.getAttribute('.vi-lang[lang="pa"]', 'aria-checked')) === 'true');
  else skip('8. Punjabi preselected', 'the website offers no Punjabi pages in this campaign (TR offers a language only after its pages are approved)');
  await shot(vol.page, '12-show-the-voter-390');
  await vol.page.click('.vi-sheet button:has-text("Done")');
  await vol.page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(1500);
  check('8. a reload opens “Where to vote” without the door', /Voting places/.test(await text(vol.page, '.vi-page')) && !/Nearest to/.test(await text(vol.page, '.vi-page')));
  const plain = (u) => { try { return decodeURIComponent(u); } catch { return u; } };
  const leaked = reqs.slice(reqStart).filter((u) => /12530|Example Street|Example\+Street|49\.1253|122\.8012/i.test(plain(u)) || u.includes(maya.id));
  check('8. from “Where to vote” to the code and a reload, no request carried the door’s address, its full pin or a person id', leaked.length === 0, leaked.join(' '));

  // ── 9. Near a voting place ──
  await openDoor('Harjit Example');
  const warn = await text(vol.page, '.vi-page');
  check('9. 80 m from an open place: the warning and the place', /You’re near a voting place — no campaigning within 100 m\./.test(warn) && /Example Community Hall/.test(await text(vol.page, '.vi-warn')));
  check('9. no Show the voter, no names; Directions there', !(await vol.page.$('button:has-text("Show the voter")')) && !/Our names on the ballot/.test(warn) && (await vol.page.locator('.vi-go').count()) > 0);
  await shot(vol.page, '13-near-place-390', true);
  await go(vol.page, `${FIELD}/turfs/${turf.id}`);
  await vol.page.waitForSelector('.walk-door', { timeout: 10000 }).catch(() => {});
  check('9. the walk list shows “Near a voting place” on that door only', (await vol.page.locator(`${doorOf('Harjit Example')} .vi-nearchip`).count()) === 1 && (await vol.page.locator(`${doorOf('Maya Example')} .vi-nearchip`).count()) === 0);
  await shot(vol.page, '14-walk-list-chip-390');

  // ── 7. Closed today, from the desk; the phone's next read; the public page ──
  await go(vol.page, `${FIELD}/vote-info`);
  await vol.page.waitForSelector('.vi-places', { timeout: 8000 }).catch(() => {});
  await go(mpage, `${DESK}/website/guide`);
  await mpage.waitForSelector('#wg-places .wg-table', { timeout: 10000 }).catch(() => {});
  await mpage.click('#wg-places .wg-table button:has-text("Example Community Hall")');
  await mpage.click('#wg-places [role=switch]:has-text("Closed today")');
  await mpage.fill('input[aria-label="Why it’s closed"]', 'Power outage — use Sample Secondary School');
  await mpage.click('#wg-places .wg-place button:has-text("Save")');
  await sleep(1200);
  await vol.page.evaluate(() => { window.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); });
  let struck = false;
  for (let i = 0; i < 12 && !struck; i += 1) { await sleep(500); struck = (await vol.page.locator('.vi-place[data-closed] .vi-place__name:has-text("Example Community Hall")').count()) === 1; }
  check('7. back in the foreground, the phone strikes the closed place', struck);
  await shot(vol.page, '15-closed-phone-390', true);
  await go(pub, `${SITE}/voter-guide`);
  const pubClosed = await text(pub);
  const closedRow = await text(pub, '.vg-place--closed');
  check('7. the public page: struck, its note, “Changed …”', (await pub.locator('.vg-place--closed').count()) === 1 && /Closed: Power outage/.test(closedRow) && /Changed \d/.test(closedRow), `${await pub.locator('.vg-place--closed').count()} | ${closedRow} | ${pubClosed.slice(pubClosed.indexOf('Example Community Hall') - 20, pubClosed.indexOf('Example Community Hall') + 200)}`);
  await shot(pub, '15b-closed-public-390', true);
  await openDoor('Harjit Example');
  check('9. the same door when the place is closed today: no warning', !(await vol.page.$('.vi-warn')));

  // ── 10. Offline ──
  await go(vol.page, `${FIELD}/vote-info`);
  await vol.page.waitForSelector('.vi-places', { timeout: 8000 }).catch(() => {});
  await vol.ctx.setOffline(true);
  await vol.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(2500);
  check('10. offline: “Where to vote” opens from the copy', /Voting places/.test(await text(vol.page, '.vi-page')) && /from \d/i.test(await text(vol.page, '.offline-strip__kept')), (await text(vol.page)).slice(0, 160));
  await vol.page.click('button:has-text("Show the voter")').catch(() => {});
  check('10. offline: the QR code still draws', (await vol.page.locator('.vi-qr').count()) === 1);
  await shot(vol.page, '16-offline-390');
  await vol.page.click('.vi-sheet button:has-text("Done")').catch(() => {});
  await vol.ctx.setOffline(false);
  // A phone that never loaded it.
  const v2 = await join('volunteer', 'Wen Volunteer', 'wen@example.org', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await v2.ctx.route('**/api/guide**', (r) => r.abort());
  await go(v2.page, `${FIELD}/`);
  // The service worker in charge of this tab before the signal goes.
  await v2.page.evaluate(() => navigator.serviceWorker?.ready).catch(() => {});
  await v2.page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(1500);
  await v2.ctx.setOffline(true);
  await v2.page.goto(`${FIELD}/vote-info`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(2500);
  check('10. a phone that never loaded it says so', /No signal — open this once with signal to keep it on your phone\./.test(await text(v2.page)), (await text(v2.page)).slice(0, 160));
  await v2.ctx.close();

  // ── 12. The embed ──
  const em = await act(mpage, 'site.guide.embed', { origins: [`http://localhost:${FRAME_PORT}`] });
  check('12. the framing site saved as an embed address', em.status === 200, JSON.stringify(em.json));
  const fctx = await browser.newContext({ viewport: { width: 1024, height: 900 }, deviceScaleFactor: 1, geolocation: { latitude: 49.1405, longitude: -122.8 } });
  await fctx.grantPermissions(['geolocation'], { origin: `http://localhost:${FRAME_PORT}` });
  await fctx.grantPermissions(['geolocation'], { origin: ORIGIN });
  const fp = watch(await fctx.newPage(), 'framer');
  await fp.goto(`http://localhost:${FRAME_PORT}/`, { waitUntil: 'networkidle' });
  const frame = fp.frames().find((f) => f.url().includes('/embed/voter-guide'));
  const ftext = frame ? ((await frame.innerText('body').catch(() => '')) || '').replace(/\s+/g, ' ') : '';
  check('12. framed: the guide and its authorization line', /Voting is open now/.test(ftext) && /Authorized by/.test(ftext), ftext.slice(0, 120));
  if (frame) {
    await frame.click('.vg-locate').catch(() => {});
    await sleep(800);
    check('12. Use my location works inside the frame', /Nearest to you/.test(((await frame.innerText('body').catch(() => '')) || '')));
  }
  await shot(fp, '17-embed-framed-1024');
  const bad = await fctx.newPage();
  await bad.goto(`http://127.0.0.1:${FRAME_PORT}/`, { waitUntil: 'load' });
  await sleep(1000);
  const badFrame = bad.frames().find((f) => f !== bad.mainFrame());
  const badText = badFrame ? ((await badFrame.innerText('body').catch(() => '')) || '') : '';
  check('12. an unsaved origin is refused (frame blocked)', !/Voting is open now/.test(badText));
  await fctx.close();

  // ── 7 (next day). Open again by its hours ──
  await moveTo(at(A2, '10:00'));
  await go(pub, `${SITE}/voter-guide`);
  check('7. next voting day: the place is open, no strike-through', (await pub.locator('.vg-place--closed').count()) === 0 && /Example Community Hall/.test(await text(pub)));
  const desk2 = (await api(mpage, '/site/guide')).json;
  check('7. next voting day: the desk’s switch reads off', desk2.guide.places.find((p) => p.id === hall.id)?.closed === false);
  await openDoor('Harjit Example');
  check('9. the next day, open again: the warning is back', Boolean(await vol.page.$('.vi-warn')));

  // ── 9 (after 8 p.m.) ──
  await moveTo(at(A2, '20:30'));
  await openDoor('Harjit Example');
  check('9. after 8 p.m.: no warning', !(await vol.page.$('.vi-warn')) && /Voting opens|Next day to vote/.test(await text(vol.page, '.vi-status')), await text(vol.page, '.vi-status'));
  await go(vol.page, `${FIELD}/turfs/${turf.id}`);
  check('9. after 8 p.m.: no chip on the walk list', (await vol.page.locator('.vi-nearchip').count()) === 0);

  // ── 11. Past the last close, in two time zones ──
  await moveTo(at(G, '19:59') + 20_000);
  const zones = [];
  for (const tz of ['America/Vancouver', 'America/Los_Angeles']) {
    const c = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, timezoneId: tz });
    const p = watch(await c.newPage(), `public-${tz}`);
    await p.goto(`${SITE}/voter-guide`, { waitUntil: 'networkidle' });
    zones.push({ tz, c, p, before: await text(p, '.vg-status') });
  }
  for (const z of zones) check(`11. ${z.tz}: open at 7:59 p.m.`, /Voting is open now/.test(z.before), z.before);
  const flipped = {};
  for (let i = 0; i < 90 && zones.some((z) => !flipped[z.tz]); i += 1) {
    await sleep(500);
    for (const z of zones) if (!flipped[z.tz] && /Voting is over\. Thank you for voting\./.test(await text(z.p, '.vg'))) flipped[z.tz] = Date.now();
  }
  check('11. both flip to “Voting is over. Thank you for voting.”', zones.every((z) => flipped[z.tz]), JSON.stringify(flipped));
  const gap = Math.abs((flipped['America/Vancouver'] || 0) - (flipped['America/Los_Angeles'] || 0));
  check('11. at the same instant (an hour-wrong zone changes nothing)', gap < 3000, `${gap} ms apart`);
  await shot(zones[1].p, '18-over-la-390');
  for (const z of zones) await z.c.close();
  await go(pub, `${SITE}/`);
  check('11. over: no banner', !(await pub.$('.vote-banner')));
  await go(vol.page, `${FIELD}/`);
  await vol.page.waitForSelector('.today-rows', { timeout: 10000 }).catch(() => {});
  check('11. over: Today has no “Where to vote”', !/Where to vote/.test(await text(vol.page, '.today-next')));

  // ── 14. Console ──
  check('14. console clean (no errors, no hydration warnings)', errors.length === 0, errors.slice(0, 5).join(' | '));
  exitCode = results.every(Boolean) ? 0 : 1;
} catch (e) {
  console.log(`FAIL  the suite stopped: ${e.stack || e.message}`);
} finally {
  await browser.close().catch(() => {});
  await stopServer();
  geo.close(); framer.close();
  rmSync(DATA, { recursive: true, force: true });
  const n = results.filter(Boolean).length;
  console.log(`\n${n}/${results.length} passed${exitCode ? '' : ' — all good'}`);
  process.exit(exitCode);
}
