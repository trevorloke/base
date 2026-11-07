// Ask the office E2E — one fresh in-memory campaign: a manager draws a turf
// round three doors and gives it to a volunteer; on a 390×844 phone the
// volunteer opens a door on the walk list, More → "Ask the office" → "Wants
// to volunteer" + what they said → Send: "Sent to the office", and the
// button reads "Asked the office · <time>"; with no signal the same at the
// next door says "Ask the office · Saved offline" and the strip's sheet
// lists "Ask the office · Wants to volunteer · <name> · <time>", sent once
// when the signal is back. The map's door card has it under More too (and
// says it was asked). The volunteer reads a person's requests as the kind
// and when only, and can't read the desk's list. At the desk, Today's Needs
// you says "1 request from the doors", then "2 …"; it opens Requests from
// the doors (/admin/requests), where Done ✓ asks what you did and marks it
// done, until "Nothing waiting from the doors."; the Done pill says who did
// it and offers Reopen. Every claim on a screen is checked against the API;
// each screen is measured (yellow buttons, sideways scroll, 48px targets).
//
//   BASE_OPEN_SIGNUP=1 BASE_DATA=memory PORT=4440 node server/index.js &
//   BASE=http://127.0.0.1:4440 SHOTS=/tmp/requests node e2e-requests.mjs
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:3200';
const ADMIN = { toString() { return `${BASE}/admin`; } }; // the desk's pages live in the admin (web/src/mode.js)
const SHOTS = process.env.SHOTS || '/tmp/base-ground-requests';
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
      return { status: r.status, json, raw };
    }, [path, body]),
    go: async (path) => { await page.goto(`${/vol/.test(who) ? BASE : ADMIN}${path}`, { waitUntil: 'domcontentloaded' }); await sleep(900); },
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
const CLOCK = '\\d{1,2}:\\d{2} (am|pm)';

// ── 1. A manager, three doors in a turf (555-01xx phones) ──
const dctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, timezoneId: 'America/Vancouver' });
await tiles(dctx);
const page = await dctx.newPage();
const D = helpers(page, 'manager');
await D.go('/signup');
await page.fill('#su-name', 'Riley Example');
if (await page.locator('#su-org').count()) await page.fill('#su-org', 'Imagine Surrey');
await page.fill('#su-email', `riley+${tag}@requests.example`);
await page.fill('#su-password', 'surrey-forward-2026');
await page.click('button[type="submit"]');
await page.waitForURL(/\/admin\/?$/, { timeout: 15000 });
const P = {};
const mk = async (key, data) => { P[key] = (await D.api('/actions/person.create', data)).json.person; };
await mk('dev', { name: 'Dev Example', phone: '604-555-0151', address: '7231 132 St', city: 'Surrey', lat: 49.13400, lng: -122.85000 });
await mk('ana', { name: 'Ana Example', phone: '604-555-0152', address: '7245 132 St', city: 'Surrey', lat: 49.13450, lng: -122.84950 });
await mk('tom', { name: 'Tom Example', phone: '604-555-0153', address: '7259 132 St', city: 'Surrey', lat: 49.13500, lng: -122.84900 });
const turf = (await D.api('/actions/turf.create', {
  name: 'Newton East', polygon: [[49.130, -122.860], [49.140, -122.860], [49.140, -122.840], [49.130, -122.840]],
})).json.turf;
check('seeded 3 doors and a turf', Object.values(P).every((p) => p?.id) && turf?.id);

// ── 2. A volunteer on a phone, on that turf ──
const invite = (await D.api('/actions/member.invite', { email: `jas+${tag}@requests.example`, role: 'volunteer' })).json;
const vctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/Vancouver' });
await tiles(vctx);
const vpage = await vctx.newPage();
const V = helpers(vpage, 'vol');
await V.go('/login');
const joined = await V.api('/auth/join', { token: invite.joinUrl.split('/').pop(), name: 'Jas Example', password: 'knock-knock-2026' });
check('volunteer joined', joined.status === 200 && joined.json.role === 'volunteer', joined.status);
const volId = (await V.api('/auth/me')).json.user.id;
check('turf given to the volunteer', (await D.api('/actions/turf.assign', { turf_id: turf.id, user_id: volId })).status === 200);

// Open a door on the walk list by its person's name, then its More.
const openDoor = async (name) => {
  const li = vpage.locator('li.walk-door', { hasText: name }).first();
  if (!(await li.evaluate((el) => el.classList.contains('is-open')).catch(() => false))) {
    await li.locator('.walk-door__head').click();
    await sleep(300);
  }
  const more = li.locator('.walk-panel .fk-more__btn').first();
  if ((await more.getAttribute('aria-expanded')) !== 'true') await more.click();
  await sleep(200);
  return li;
};

// ── 3. The walk list: More → Ask the office ──
await V.go(`/turfs/${turf.id}`);
await vpage.waitForSelector('.walk-door', { timeout: 10000 }).catch(() => {});
let door = await openDoor('Dev Example');
const askBtn = door.locator('.rq-open');
check('walk list: "Ask the office" under More (a plain button, never yellow)', (await askBtn.count()) === 1
  && (await askBtn.innerText()).trim() === 'Ask the office' && !(await askBtn.evaluate((el) => el.classList.contains('btn-primary'))));
await askBtn.click();
await sleep(200);
const kinds = await door.locator('.rq-kind').allInnerTexts();
check('four choices, in words', kinds.join('|') === 'Call them back|Wants to volunteer|Has a question|Something else', kinds.join('|'));
check('one line for what they said', (await door.locator('input.rq-note').getAttribute('placeholder')) === 'What they said'
  && (await door.locator('input.rq-note').getAttribute('maxlength')) === '500');
check('Send waits for a choice', await door.locator('.rq-send').isDisabled());
await door.locator('.rq-kind', { hasText: 'Wants to volunteer' }).click();
await door.locator('input.rq-note').fill('free Saturdays, call after 6');
let m = await measure(vpage, '.rq-kind, .rq-note, .rq-send, .rq-cancel');
check('the sheet at 390: 48px choices and buttons, no sideways scroll, no second yellow', m.minTap >= 48 && m.overflow <= 0 && m.yellow <= 1, JSON.stringify(m));
await V.shot('01-walk-ask-sheet');
await door.locator('.rq-send').click();
await vpage.waitForSelector('.walk-toast', { timeout: 4000 }).catch(() => {});
const toast1 = await vpage.innerText('.walk-toast').catch(() => '');
check('toast: "Sent to the office"', /Sent to the office/.test(toast1), toast1);
const line1 = (await door.locator('.rq-open').innerText().catch(() => '')).trim();
check('the button now reads "Asked the office · <time>"', new RegExp(`^Asked the office · ${CLOCK}$`).test(line1), line1);
await V.shot('02-walk-asked');

// On the server, as the desk and as the volunteer sees it.
let reqs = (await D.api('/requests')).json.requests;
const devReq = reqs.find((r) => r.person.id === P.dev.id);
check('the desk has it: Dev · volunteer · the note · asked by Jas Example, with phone and address', reqs.length === 1 && devReq
  && devReq.kind === 'volunteer' && devReq.note === 'free Saturdays, call after 6' && devReq.asked_by_name === 'Jas Example'
  && devReq.person.phone === '604-555-0151' && devReq.person.address === '7231 132 St', JSON.stringify(reqs));
const vr = await V.api(`/persons/${P.dev.id}/requests`);
check('the volunteer reads the kind and when only — never what was said or who asked', vr.status === 200 && vr.json.requests.length === 1
  && JSON.stringify(Object.keys(vr.json.requests[0]).sort()) === '["created_at","done","id","kind"]' && !/Saturdays|Jas/.test(vr.raw), vr.raw);
check('the volunteer can’t read the desk’s list or count', (await V.api('/requests')).status === 403 && (await V.api('/requests/count')).status === 403);
check('the volunteer can’t mark it done', (await V.api('/actions/request.done', { id: devReq?.id })).status === 403);

// ── 4. Desk Today: 1 request from the doors ──
await D.go('/');
await page.waitForSelector('#today-needs-h', { timeout: 8000 }).catch(() => {});
await sleep(600);
let needs = await page.innerText('section[aria-labelledby="today-needs-h"]').catch(() => '');
check('Today · Needs you: "1 request from the doors"', /\b1 request from the doors\b/.test(needs.replace(/\s+/g, ' ')), needs.replace(/\s+/g, ' '));

// ── 5. No signal: the next door ──
await vctx.setOffline(true);
await vpage.evaluate(() => window.dispatchEvent(new Event('offline')));
await sleep(300);
door = await openDoor('Ana Example');
await door.locator('.rq-open').click();
await door.locator('.rq-kind', { hasText: 'Wants to volunteer' }).click();
await door.locator('input.rq-note').fill('can do Sundays');
await door.locator('.rq-send').click();
await sleep(400);
const toast2 = await vpage.innerText('.walk-toast').catch(() => '');
check('offline toast: "Ask the office · Saved offline"', toast2.trim() === 'Ask the office · Saved offline', toast2);
const line2 = (await door.locator('.rq-open').innerText().catch(() => '')).trim();
check('offline, the button still says "Asked the office · <time>" (from the phone)', new RegExp(`^Asked the office · ${CLOCK}$`).test(line2), line2);
await vpage.tap('.offline-strip__chip').catch(() => vpage.click('.offline-strip__chip'));
await vpage.waitForSelector('.obx-sheet', { timeout: 3000 }).catch(() => {});
const rows = await vpage.$$eval('.obx-sheet .obx-row', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim())).catch(() => []);
check('the strip’s sheet: "Ask the office · Wants to volunteer · Ana Example · <time>"', rows.length === 1
  && new RegExp(`^Ask the office · Wants to volunteer · Ana Example · ${CLOCK}$`).test(rows[0]), rows.join(' | '));
m = await measure(vpage, '.obx-sheet .btn');
check('the sheet: no sideways scroll, no yellow', m.overflow <= 0 && !(await vpage.$('.obx-sheet .btn-primary')), JSON.stringify(m));
await V.shot('03-offline-sheet');
await vpage.click('.obx-sheet .obx-x').catch(() => {});
check('nothing reached the server yet', !(await D.api('/requests')).json.requests.some((r) => r.person.id === P.ana.id));

// Signal back: sent once.
await vctx.setOffline(false);
await vpage.evaluate(() => window.dispatchEvent(new Event('online')));
let anaReqs = [];
for (let i = 0; i < 20; i++) {
  anaReqs = (await D.api('/requests')).json.requests.filter((r) => r.person.id === P.ana.id);
  if (anaReqs.length && !(await vpage.$('.offline-strip__chip'))) break;
  await sleep(500);
}
await sleep(1500); // a second flush, if one were coming, would land by now
anaReqs = (await D.api('/requests')).json.requests.filter((r) => r.person.id === P.ana.id);
const anaEvents = (await D.api('/events?since=0&limit=1000')).json.events.filter((e) => e.action === 'request.ask' && e.payload?.person_id === P.ana.id);
check('back online: sent once — one request, one event', anaReqs.length === 1 && anaEvents.length === 1 && anaReqs[0].note === 'can do Sundays'
  && !(await vpage.$('.offline-strip__chip')), `${anaReqs.length} rows, ${anaEvents.length} events`);

// ── 6. The map's door card: the same, under More ──
await V.go(`/map?person=${P.dev.id}`);
await vpage.waitForSelector('aside.door-card', { timeout: 10000 }).catch(() => {});
await vpage.click('aside.door-card .fk-more__btn').catch(() => {});
await sleep(800);
const cardLine = (await vpage.innerText('aside.door-card .rq-open').catch(() => '')).trim();
check('map door card: More says "Asked the office · <time>" for Dev (from the server)', new RegExp(`^Asked the office · ${CLOCK}$`).test(cardLine), cardLine);
await V.go(`/map?person=${P.tom.id}`);
await vpage.waitForSelector('aside.door-card', { timeout: 10000 }).catch(() => {});
await vpage.click('aside.door-card .fk-more__btn').catch(() => {});
await sleep(600);
check('map door card: "Ask the office" under More for Tom', (await vpage.innerText('aside.door-card .rq-open').catch(() => '')).trim() === 'Ask the office');
await vpage.click('aside.door-card .rq-open');
await sleep(200);
m = await measure(vpage, 'aside.door-card .rq-kind, aside.door-card .rq-send, aside.door-card .rq-cancel, aside.door-card .rq-note');
check('map door card sheet at 390: 48px targets, no sideways scroll, no second yellow', m.minTap >= 48 && m.overflow <= 0 && m.yellow <= 1, JSON.stringify(m));
await V.shot('04-map-card-sheet');
await vpage.click('aside.door-card .rq-cancel');
await sleep(200);
check('Cancel closes it; nothing sent', (await vpage.innerText('aside.door-card .rq-open').catch(() => '')).trim() === 'Ask the office'
  && !(await D.api('/requests')).json.requests.some((r) => r.person.id === P.tom.id));

// ── 7. The desk: Today → Requests from the doors → Done ✓ ──
await D.go('/');
await page.waitForSelector('#today-needs-h', { timeout: 8000 }).catch(() => {});
await sleep(600);
needs = (await page.innerText('section[aria-labelledby="today-needs-h"]').catch(() => '')).replace(/\s+/g, ' ');
check('Today · Needs you: "2 requests from the doors"', /\b2 requests from the doors\b/.test(needs), needs);
await page.click('section[aria-labelledby="today-needs-h"] a[href="/admin/requests"]');
await page.waitForURL(`${ADMIN}/requests`, { timeout: 8000 }).catch(() => {});
await page.waitForSelector('.rq-row', { timeout: 8000 }).catch(() => {});
check('it opens /admin/requests', page.url() === `${ADMIN}/requests`, page.url());
const backLink = await page.innerText('.rq-page .ops-back').catch(() => '');
check('title "Requests from the doors", back to Today', (await page.innerText('.rq-page h1').catch(() => '')) === 'Requests from the doors'
  && /^← Today$/i.test(backLink.trim()), backLink);
const listed = await page.$$eval('.rq-row', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
const devRow = listed.find((t) => t.startsWith('Dev Example')) || '';
check('Dev’s row: name · kind · “what they said” · asked by Jas · <day> <time>', listed.length === 2
  && new RegExp(`^Dev Example · Wants to volunteer “free Saturdays, call after 6” 7231 132 St asked by Jas · [A-Z][a-z]{2} ${CLOCK}`).test(devRow), listed.join(' | '));
check('newest first: Ana, then Dev', /^Ana Example/.test(listed[0] || '') && /^Dev Example/.test(listed[1] || ''));
check('Call, Profile and Done ✓ on each', (await page.$$('.rq-row a[href^="tel:"]')).length === 2
  && (await page.$$('.rq-row a:has-text("Profile")')).length === 2 && (await page.$$('.rq-row button:has-text("Done ✓")')).length === 2);
m = await measure(page, '.rq-pill, .rq-row__acts .btn');
check('Requests at 1360: no yellow, no sideways scroll, 48px', m.yellow === 0 && m.overflow <= 0 && m.minTap >= 48, JSON.stringify(m));
await D.shot('05-requests');
await page.setViewportSize({ width: 390, height: 844 });
await sleep(300);
m = await measure(page, '.rq-pill, .rq-row__acts .btn');
check('Requests at 390: no sideways scroll, 48px targets', m.overflow <= 0 && m.minTap >= 48, JSON.stringify(m));
await D.shot('06-requests-390');
await page.setViewportSize({ width: 1360, height: 900 });

const devLi = page.locator('.rq-row', { hasText: 'Dev Example' });
await devLi.locator('button:has-text("Done ✓")').click();
await sleep(200);
check('Done ✓ asks what you did (optional)', (await devLi.locator('input.rq-note').getAttribute('placeholder')) === 'What you did');
m = await measure(page);
check('confirming: one yellow "Done" on the screen', m.yellow === 1 && /^Done$/.test((await devLi.locator('.btn-primary').innerText()).trim()), JSON.stringify(m));
await devLi.locator('input.rq-note').fill('booked on the Saturday canvass');
await devLi.locator('button.btn-primary:has-text("Done")').click();
await page.waitForSelector('.ops-toast', { timeout: 4000 }).catch(() => {});
check('toast "✓ Done"', /✓ Done/.test(await page.innerText('.ops-toast').catch(() => '')));
await sleep(400);
reqs = (await D.api('/requests?open=all')).json.requests;
const devDone = reqs.find((r) => r.person.id === P.dev.id);
check('the server: done, by Riley, with the note', devDone?.done_at && devDone.done_by_name === 'Riley Example' && devDone.done_note === 'booked on the Saturday canvass', JSON.stringify(devDone));
check('one row left on the list', (await page.$$('.rq-row')).length === 1);
const anaLi = page.locator('.rq-row', { hasText: 'Ana Example' });
await anaLi.locator('button:has-text("Done ✓")').click();
await anaLi.locator('button.btn-primary:has-text("Done")').click();
await sleep(800);
check('"Nothing waiting from the doors."', /Nothing waiting from the doors\./.test(await D.text()) && (await page.$$('.rq-row')).length === 0);
check('the server agrees: none open', (await D.api('/requests/count')).json.open === 0);
await D.shot('07-requests-empty');

await page.click('.rq-pill:has-text("Done")');
await page.waitForSelector('.rq-row', { timeout: 6000 }).catch(() => {});
await sleep(300);
const doneRows = await page.$$eval('.rq-row', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
const devDoneRow = doneRows.find((t) => t.startsWith('Dev Example')) || '';
check('Done: "done by Riley · <day> <time> · “booked on the Saturday canvass”" and a quiet Reopen', doneRows.length === 2
  && new RegExp(`done by Riley · [A-Z][a-z]{2} ${CLOCK} · “booked on the Saturday canvass”`).test(devDoneRow)
  && (await page.$$('.rq-row button.btn-quiet:has-text("Reopen")')).length === 2, doneRows.join(' | '));
check('the Done pill is in the address bar', /[?&]show=done\b/.test(page.url()), page.url());
await D.shot('08-requests-done');

await D.go('/');
await sleep(600);
needs = (await page.innerText('section[aria-labelledby="today-needs-h"]').catch(() => '')).replace(/\s+/g, ' ');
check('Today: no requests line once they’re done', !/from the doors/.test(needs), needs);

// ── 8. The books ──
const ex = await D.api('/export');
check('the export carries door_requests', Array.isArray(ex.json?.door_requests) && ex.json.door_requests.length === 2);
const v = (await D.api('/audit/verify')).json;
check('hash chain verifies after the whole journey', v.ok === true, JSON.stringify(v));
check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
