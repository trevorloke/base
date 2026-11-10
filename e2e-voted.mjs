// Voted E2E — one fresh in-memory campaign: a manager seeds four doors in a
// turf and a volunteer joins on a phone; with Election day off no screen
// offers "Voted ✓"; the manager switches it on at Today → More → Election
// day (/admin/voted); the volunteer's open walk-list door shows a 48px
// "Voted ✓" — a tap says "Voted · Harjit" with Change, the panel "✓ Voted",
// the door's row "✓ Voted" (Change takes it back, the tap puts it back);
// Today reads "Election day · 1 of 2 supporters voted"; the map's door card
// and the Calls card carry the same button; with no signal a tap says
// "Voted · Saved offline", the row "Voted · Not sent" and the strip's sheet
// lists it — back online it sends once (one voted_marks row in the export);
// the Election day screen counts by band and by turf; a file with a Voted
// column marks people and never un-marks; mode off → the buttons go. Every
// claim on a screen is checked against the API; each screen is measured
// (yellow buttons, sideways scroll, 48px targets) at 1360 and at 390.
//
//   STARBASE_OPEN_SIGNUP=1 STARBASE_DATA=memory PORT=4420 node server/index.js &
//   BASE=http://127.0.0.1:4420 SHOTS=/tmp/voted node e2e-voted.mjs
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:3200';
const ADMIN = { toString() { return `${BASE}/admin`; } }; // the desk's pages live in the admin (web/src/mode.js)
const SHOTS = process.env.SHOTS || '/tmp/starbase-voted';
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
// Wait for the API to say something, a few times (the outbox sends on its own clock).
const until = async (fn, tries = 12, every = 700) => {
  for (let i = 0; i < tries; i += 1) {
    if (await fn()) return true;
    await sleep(every);
  }
  return fn();
};

// ── 1. A manager, four doors in one turf (public-building addresses, 555-01xx phones), a volunteer ──
const dctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, timezoneId: 'America/Vancouver' });
await tiles(dctx);
const page = await dctx.newPage();
const D = helpers(page, 'manager');
await D.go('/signup');
await page.fill('#su-name', 'Marco Manager');
if (await page.locator('#su-org').count()) await page.fill('#su-org', 'Imagine Surrey');
await page.fill('#su-email', `marco+${tag}@voted.example`);
await page.fill('#su-password', 'surrey-forward-2026');
await page.click('button[type="submit"]');
await page.waitForURL(/\/admin\/?$/, { timeout: 15000 });
const P = {};
const mk = async (key, data) => { P[key] = (await D.api('/actions/person.create', data)).json.person; };
const lat = 49.1327; const lng = -122.855;
await mk('harjit', { name: 'Harjit Example', phone: '604-555-0141', address: '13213 72 Ave', city: 'Surrey', lat, lng });
await mk('maya', { name: 'Maya Example', phone: '604-555-0142', address: '13225 72 Ave', city: 'Surrey', lat, lng: lng + 0.0003 });
await mk('tom', { name: 'Tom Example', phone: '604-555-0143', address: '13224 72 Ave', city: 'Surrey', lat: lat - 0.0002, lng: lng + 0.0003 });
await mk('dev', { name: 'Dev Example', phone: '604-555-0144', address: '13212 72 Ave', city: 'Surrey', lat: lat - 0.0002, lng });
// Off the map (no address): the voted file marks her later.
await mk('grace', { name: 'Grace Example', phone: '604-555-0145' });
check('seeded 5 people', Object.values(P).every((p) => p?.id));
await D.api('/actions/contact.log', { person_id: P.harjit.id, channel: 'door', outcome: 'contacted', rating: '1' });
await D.api('/actions/contact.log', { person_id: P.maya.id, channel: 'door', outcome: 'contacted', rating: '2' });
await D.api('/actions/contact.log', { person_id: P.tom.id, channel: 'door', outcome: 'contacted', rating: '3' });
const turf = (await D.api('/actions/turf.create', {
  name: 'Newton block', polygon: [[lat + 0.001, lng - 0.001], [lat + 0.001, lng + 0.002], [lat - 0.001, lng + 0.002], [lat - 0.001, lng - 0.001]],
})).json.turf;
check('turf drawn', !!turf?.id);
const invite = (await D.api('/actions/member.invite', { email: `ana+${tag}@voted.example`, role: 'volunteer' })).json;
const vctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/Vancouver' });
await tiles(vctx);
const vpage = await vctx.newPage();
const V = helpers(vpage, 'vol');
const tap = (sel) => vpage.tap(sel).catch(() => vpage.click(sel));
await V.go('/login');
const joined = await V.api('/auth/join', { token: invite.joinUrl.split('/').pop(), name: 'Ana Volunteer', password: 'knock-knock-2026' });
check('volunteer joined', joined.status === 200 && joined.json.role === 'volunteer', joined.status);
const volId = (await V.api('/auth/me')).json.user.id;
check('volunteer on the turf', (await D.api('/actions/turf.assign', { turf_id: turf.id, user_id: volId })).status === 200);
const marksOf = async (id) => (await D.api(`/voted/persons/${id}`)).json;
const doorOf = (name) => `.walk-door:has(.walk-door__names:has-text("${name}"))`;
const OPEN = '.walk-door.is-open .walk-panel'; // plain CSS, for measure()
const openDoor = async (name) => {
  await vpage.waitForSelector('.walk-door', { timeout: 10000 }).catch(() => {});
  await tap(`${doorOf(name)} .walk-door__head`);
  await vpage.waitForSelector(`${doorOf(name)} .walk-panel`, { timeout: 5000 }).catch(() => {});
  await sleep(400);
};

// ── 2. Election day off: nothing offers "Voted ✓" ──
await V.go(`/turfs/${turf.id}`);
await openDoor('Harjit Example');
check('Election day off: an open door has no "Voted ✓"', !!(await vpage.$(`${doorOf('Harjit Example')} .walk-panel .rb-btn`)) && !(await vpage.$('.vt-btn')));
check('GET /voted/status for every role: off', (await V.api('/voted/status')).json?.on === false);

// ── 3. The manager turns it on: Today → More → Election day ──
await D.go('/');
await page.click('.today-morebox__toggle');
await sleep(300);
const rowOff = await page.$('a.today-row[href="/admin/voted"]');
const rowOffText = rowOff ? (await rowOff.$eval('.today-row__main', (el) => el.innerText)).replace(/\s+/g, ' ').trim() : '(no row)';
check('Today → More lists "GOTV & voting days" (off: no count)', !!rowOff && rowOffText === 'GOTV & voting days', rowOffText);
await rowOff.click();
await page.waitForURL(`${ADMIN}/voted`, { timeout: 8000 });
await sleep(700);
check('/admin/voted: "Get out the vote", Off, the switch off, what GOTV mode does', (await page.innerText('h1')) === 'Get out the vote'
  && (await page.getAttribute('.vt-page .sv-switch', 'aria-checked')) === 'false'
  && /Off\./.test(await page.innerText('.vt-now'))
  && /everyone can mark people as voted/.test(await D.text()) && /GOTV scripts/.test(await D.text()));
let m = await measure(page, '.vt-page .sv-switch, .vt-page .vt-date, .vt-page .btn, .vt-page .ops-back');
// A desk with a mouse: 40px controls (app.css --ctl); the phone's 48 is checked at 390 below.
check('Election day at 1360: one yellow (Save), targets ≥ 40px on a desk', m.yellow === 1 && m.minTap >= 40 && /Save/.test(await page.innerText('.btn-primary')), JSON.stringify(m));
check('Save is off until something changes', await page.$eval('.vt-page .btn-primary', (b) => b.disabled));
await D.shot('01-election-day-off');
await page.click('.vt-page .sv-switch');
const today = await page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
check('On by hand: the switch reads so', (await page.getAttribute('.vt-page .sv-switch', 'aria-checked')) === 'true');
// Election day is today; an advance-voting day goes on the list.
await page.fill('#vt-date', today);
await page.fill('#vt-newday', '2030-10-09');
await page.click('.vt-addday button:has-text("Add day")');
check('the advance-voting day shows as a chip', /Oct 9/.test(await page.innerText('.vt-days').catch(() => '')));
await page.click('.vt-page .btn-primary');
await sleep(900);
const status = (await D.api('/voted/status')).json;
check('Save: "✓ Saved"; the server has it on, election day today, the advance day kept', /✓ Saved/.test(await D.text()) && status.on === true && status.election_day === today
  && status.voting_day === 'election' && status.advance_days.join() === '2030-10-09', JSON.stringify(status));
check('vote.settings is a manager’s: the volunteer is refused', (await V.api('/actions/vote.settings', { on: false })).status === 403);
await D.shot('02-election-day-on');

// ── 4. The volunteer's walk list: "Voted ✓" on the open door ──
await V.go(`/turfs/${turf.id}`);
await openDoor('Harjit Example');
const panel = `${doorOf('Harjit Example')} .walk-panel`;
check('the open door shows "Voted ✓" above the rating row', (await vpage.innerText(`${panel} .vt-btn`).catch(() => '')).replace(/\s+/g, ' ').trim() === 'Voted ✓'
  && await vpage.$eval(`${panel}`, (el) => el.querySelector('.vt-btn').compareDocumentPosition(el.querySelector('.rb-btn')) & Node.DOCUMENT_POSITION_FOLLOWING));
m = await measure(vpage, `${OPEN} .vt-btn, ${OPEN} .rb-btn, ${OPEN} .fk-out`);
check('walk list at 390: "Voted ✓" ≥ 48px, no sideways scroll, ≤ 1 yellow', m.minTap >= 48 && m.overflow <= 0 && m.yellow <= 1, JSON.stringify(m));
check('no "Voted ✓" on a closed door', (await vpage.$$('.vt-btn')).length === 1);
await V.shot('03-walk-voted-button');
await tap(`${panel} .vt-btn`);
await sleep(700);
let toast = ((await vpage.innerText('.walk-toast').catch(() => '')) || '').replace(/\s+/g, ' ').trim();
check('tap: the toast reads "Voted · Harjit" with Change', /^Voted · Harjit/.test(toast) && /Change$/.test(toast), toast);
let marks = await marksOf(P.harjit.id);
check('the server has the fact and one mark from the door', !!marks.voted_at && marks.marks.length === 1 && marks.marks[0].source === 'door' && marks.marks[0].voted === true, JSON.stringify(marks));
check('the panel reads "✓ Voted · <time>" with a quiet Change', /^✓ Voted · \d{1,2}:\d{2}/.test((await vpage.innerText(`${panel} .vt-done`)).replace(/\s+/g, ' ').trim())
  && !!(await vpage.$(`${panel} .vt-change`)) && !(await vpage.$(`${panel} .vt-btn`)), await vpage.innerText(`${panel} .vt-done`).catch(() => ''));
check('the door’s row shows the "✓ Voted" chip', await until(async () => ((await vpage.innerText(`${doorOf('Harjit Example')} .walk-door__chips .vt-chip`).catch(() => '')) || '').trim() === '✓ Voted'));
m = await measure(vpage, `${OPEN} .vt-change, ${OPEN} .rb-btn, .walk-toast__btn`);
check('marked: Change ≥ 48px, still ≤ 1 yellow', m.minTap >= 48 && m.yellow <= 1, JSON.stringify(m));
await V.shot('04-walk-voted');
// Change on the toast: a take-back (a new mark); the button comes back.
await tap('.walk-toast__btn:has-text("Change")');
await sleep(800);
marks = await marksOf(P.harjit.id);
check('Change: voted_at clears, both marks kept (append-only), the button is back', marks.voted_at === null && marks.marks.length === 2
  && !!(await vpage.$(`${panel} .vt-btn`)) && !(await vpage.$(`${doorOf('Harjit Example')} .vt-chip`)), JSON.stringify(marks.marks));
await tap(`${panel} .vt-btn`);
await sleep(800);
marks = await marksOf(P.harjit.id);
check('tapped again: voted, three marks on file', !!marks.voted_at && marks.marks.length === 3, marks.marks.length);
check('a volunteer’s own marks carry no names', JSON.stringify((await V.api(`/voted/persons/${P.harjit.id}`)).json.marks).includes('by_name') === false);

// ── 5. Today (desk): "Election day · 1 of 2 supporters voted" ──
await D.go('/');
await page.click('.today-morebox__toggle');
await sleep(300);
const rowOn = ((await page.innerText('a.today-row[href="/admin/voted"] .today-row__main').catch(() => '')) || '').replace(/\s+/g, ' ').trim();
const brief = (await D.api('/brief')).json.voted;
check('Today → More: "GOTV · 1 of 2 supporters voted" — the brief agrees', rowOn === 'GOTV · 1 of 2 supporters voted' && brief.supporters_voted === 1 && brief.supporters === 2 && brief.on === true, `${rowOn} · ${JSON.stringify(brief)}`);
const card = ((await page.innerText('.today-gotv').catch(() => '')) || '').replace(/\s+/g, ' ');
check('Today’s GOTV card: "Election day · 1 of 2 supporters have voted · 1 to go", Call who hasn’t voted', /Election day/i.test(card) && /1 of 2 supporters have voted · 1 to go/.test(card)
  && (await page.getAttribute('.today-gotv a:has-text("Call who hasn")', 'href')) === '/admin/calls?rating=1,2&voted=no', card);
await V.go('/');
check('the volunteer’s Today has the GOTV card too', /supporters have voted/.test(((await vpage.innerText('.today-gotv').catch(() => '')) || '')));
await D.shot('05-today-row');

// The map's filters: with Election day on, "Yes, not voted" (the pull list)
// and "Voted", counted as the server's people say (one person per door here).
const sheet = async () => {
  await V.go('/map');
  await vpage.waitForSelector('.map-filter-btn', { timeout: 8000 }).catch(() => {});
  await tap('.map-filter-btn');
  await vpage.waitForSelector('.map-fopt', { timeout: 5000 }).catch(() => {});
  return vpage.$$eval('.map-fopt', (els) => els.map((e) => [e.querySelector('.map-fopt__label').innerText.trim(), e.querySelector('.map-fopt__n').innerText.trim()]));
};
const opts = await sheet();
const ppl = (await V.api('/map/doors')).json.persons;
const wantVoted = ppl.filter((x) => x.voted_at).length;
const wantGotv = ppl.filter((x) => ['1', '2'].includes(x.rating) && !x.voted_at).length;
const opt = (label) => opts.find(([l]) => l === label)?.[1];
check(`map filters: "Yes, not voted" (${wantGotv}) and "Voted" (${wantVoted})`, opt('Yes, not voted') === String(wantGotv) && opt('Voted') === String(wantVoted) && wantVoted > 0 && wantGotv > 0, JSON.stringify(opts));
await tap('.map-fopt:has-text("Yes, not voted")');
await sleep(400);
check('…picked: the pill says "Show: Yes, not voted"', /Show:\s*Yes, not voted/.test(await vpage.innerText('.map-filter-btn').catch(() => '')));
await vpage.keyboard.press('Escape').catch(() => {});

// ── 6. The map's door card has the same button ──
await V.go(`/map?person=${P.maya.id}`);
await vpage.waitForSelector('aside.door-card', { timeout: 8000 }).catch(() => {});
await sleep(400);
check('door card: "Voted ✓" between the rating row and the outcomes', (await vpage.innerText('aside.door-card .vt-btn').catch(() => '')).replace(/\s+/g, ' ').trim() === 'Voted ✓'
  && await vpage.$eval('aside.door-card .door-rate', (el) => (el.querySelector('.rb-btn').compareDocumentPosition(el.querySelector('.vt-btn')) & Node.DOCUMENT_POSITION_FOLLOWING)
    && (el.querySelector('.vt-btn').compareDocumentPosition(el.querySelector('.fk-out')) & Node.DOCUMENT_POSITION_FOLLOWING)));
m = await measure(vpage, 'aside.door-card .vt-btn, aside.door-card .rb-btn, aside.door-card .fk-out');
check('door card at 390: targets ≥ 48px, no sideways scroll, ≤ 1 yellow', m.minTap >= 48 && m.overflow <= 0 && m.yellow <= 1, JSON.stringify(m));
await tap('aside.door-card .vt-btn');
await sleep(800);
toast = ((await vpage.innerText('.map-toast').catch(() => '')) || '').replace(/\s+/g, ' ').trim();
marks = await marksOf(P.maya.id);
check('door card tap: "Voted · Maya" with Change, the server has it', /^Voted · Maya/.test(toast) && /Change/.test(toast) && !!marks.voted_at, `${toast} · ${JSON.stringify(marks)}`);
check('door card reads "✓ Voted"', /^✓ Voted/.test((await vpage.innerText('aside.door-card .vt-done').catch(() => '')).trim()));
await V.shot('06-door-card-voted');


// ── 7. The Calls card too ──
await V.go(`/calls?person=${P.tom.id}`);
await vpage.waitForSelector('section.cl-card', { timeout: 8000 }).catch(() => {});
await sleep(500);
check('Calls card (Tom): "Voted ✓" under the rating', /Tom Example/.test(await vpage.innerText('section.cl-card .cl-name').catch(() => ''))
  && (await vpage.innerText('section.cl-card .vt-btn').catch(() => '')).replace(/\s+/g, ' ').trim() === 'Voted ✓', await vpage.innerText('section.cl-card .cl-name').catch(() => ''));
m = await measure(vpage, 'section.cl-card .vt-btn, section.cl-card .rb-btn, section.cl-card .cl-out');
check('Calls at 390: targets ≥ 48px, no sideways scroll, ≤ 1 yellow', m.minTap >= 48 && m.overflow <= 0 && m.yellow <= 1, JSON.stringify(m));
await tap('section.cl-card .vt-btn');
await sleep(800);
toast = ((await vpage.innerText('.cl-toast').catch(() => '')) || '').replace(/\s+/g, ' ').trim();
marks = await marksOf(P.tom.id);
check('Calls tap: "Voted · Tom" with Change; a mark from the phone', /^Voted · Tom/.test(toast) && /Change$/.test(toast) && !!marks.voted_at && marks.marks[0].source === 'phone', `${toast} · ${JSON.stringify(marks)}`);
check('the card reads "✓ Voted"', /^✓ Voted/.test((await vpage.innerText('section.cl-card .vt-done').catch(() => '')).trim()));
await V.shot('07-calls-voted');

// ── 8. No signal: a tap is saved on the phone and sent once ──
await V.go(`/turfs/${turf.id}`);
await openDoor('Dev Example');
await vctx.setOffline(true);
await vpage.evaluate(() => window.dispatchEvent(new Event('offline')));
await sleep(300);
const devPanel = `${doorOf('Dev Example')} .walk-panel`;
await tap(`${devPanel} .vt-btn`);
await sleep(700);
toast = ((await vpage.innerText('.walk-toast').catch(() => '')) || '').replace(/\s+/g, ' ').trim();
check('offline tap: "Voted · Saved offline"', /^Voted · Saved offline/.test(toast), toast);
check('the row chip reads "Voted · Not sent"', (await vpage.innerText(`${doorOf('Dev Example')} .walk-door__chips .vt-chip`).catch(() => '')).trim() === 'Voted · Not sent'
  && await vpage.$eval(`${doorOf('Dev Example')} .vt-chip`, (el) => el.classList.contains('fk-wait')));
check('the panel: "✓ Voted" with "Saved offline"', /✓ Voted/.test(await vpage.innerText(devPanel)) && /Saved offline/.test(await vpage.innerText(`${devPanel} .vt-done`)));
const chip = ((await vpage.innerText('.offline-strip__chip').catch(() => '')) || '').replace(/\s+/g, ' ').trim();
check('the strip: "1 saved on this phone"', /^1 saved on this phone$/i.test(chip), chip);
await tap('.offline-strip__chip');
await vpage.waitForSelector('.obx-sheet', { timeout: 3000 }).catch(() => {});
const rows = await vpage.$$eval('.obx-sheet .obx-row', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
check('the strip’s sheet: "Voted · Dev Example · <time>"', rows.length === 1 && /^Voted · Dev Example · \d{1,2}:\d{2} (am|pm)$/.test(rows[0]), rows.join(' | '));
m = await measure(vpage, '.obx-sheet .btn');
check('offline walk list at 390: no sideways scroll, ≤ 1 yellow', m.overflow <= 0 && m.yellow <= 1, JSON.stringify(m));
await V.shot('08-walk-offline');
await vpage.keyboard.press('Escape').catch(() => {});
check('nothing reached the server yet', (await marksOf(P.dev.id)).voted_at === null);
await vctx.setOffline(false);
await vpage.evaluate(() => window.dispatchEvent(new Event('online')));
check('back online: sent once — one mark, one voted_marks row in the export', await until(async () => (await marksOf(P.dev.id)).voted_at)
  && (await marksOf(P.dev.id)).marks.length === 1
  && (await D.api('/export')).json.voted_marks.filter((x) => x.person_id === P.dev.id).length === 1, JSON.stringify(await marksOf(P.dev.id)));
check('the row chip settles to "✓ Voted"', await until(async () => ((await vpage.innerText(`${doorOf('Dev Example')} .walk-door__chips .vt-chip`).catch(() => '')) || '').trim() === '✓ Voted'));
check('the strip’s chip is gone', !(await vpage.$('.offline-strip__chip')));
// A replay of the same tap is a duplicate: still one mark.
const sent = (await D.api('/export')).json.voted_marks.find((x) => x.person_id === P.dev.id);
const replay = await V.api('/actions/vote.mark', { person_id: P.dev.id, voted: true, source: 'door', client_id: sent.client_id });
check('the same client_id replayed answers duplicate, no second row', replay.json?.duplicate === true && (await marksOf(P.dev.id)).marks.length === 1, replay.raw);

// ── 9. The Election day screen: by band and by turf ──
await D.go('/voted');
let t = await D.text();
const sum = (await D.api('/voted/summary')).json;
check('"2 of 2 supporters voted" — by band: Support 2 · Undecided 1 · Unrated 1', /2 of 2 supporters voted/.test(t) && /Support · 2/.test(t) && /Undecided · 1/.test(t) && /Opposed · 0/.test(t) && /Unrated · 1/.test(t)
  && sum.supporters_voted === 2 && sum.by_band.support === 2 && sum.by_band.undecided === 1 && sum.by_band.unrated === 1, t.slice(0, 300));
const turfRow = await page.$eval('.vt-table tbody tr', (tr) => [...tr.querySelectorAll('td')].map((td) => td.innerText.replace(/\s+/g, ' ').trim()));
check('by turf: Newton block · 2 supporters · 2 voted · 4 people, with a Walk list link', turfRow[0].startsWith('Newton block') && turfRow.slice(1).join('|') === '2|2|4'
  && (await page.getAttribute('.vt-table a.vt-walk', 'href')) === `/admin/turfs/${turf.id}`, turfRow.join(' | '));
check(`"${sum.total} people voted in all · ${sum.today} today" (people, not marks: Harjit's take-back and second mark are one voter)`, sum.total === 4 && sum.today === 4
  && new RegExp(`${sum.total} people voted in all · ${sum.today} today`).test(t), t.slice(0, 300));
check('the summary is the desk’s: a volunteer is refused', (await V.api('/voted/summary')).status === 403);
await D.full('09-election-day-summary');
const pm = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/Vancouver' });
await pm.addCookies((await dctx.cookies()).map((c) => ({ ...c })));
const mpage = await pm.newPage();
const MP = helpers(mpage, 'manager-phone');
await MP.go('/voted');
m = await measure(mpage, '.vt-page .sv-switch, .vt-page .vt-date, .vt-page .btn, .vt-page .vt-walk, .vt-page .ops-back');
check('Election day at 390: ≤ 1 yellow, no sideways scroll, targets ≥ 48px', m.yellow <= 1 && m.overflow <= 0 && m.minTap >= 48, JSON.stringify(m));
await MP.full('10-election-day-phone');
await pm.close();

// ── 10. A voted file: People → Import with a Voted column ──
await D.go('/people/import');
await page.click('button:has-text("Paste text")');
await page.fill('#imp-paste', `Name,Phone,Voted\nFile Example,604-555-0146,1\nNope Example,604-555-0147,0\nGrace Example,604-555-0145,1\nHarjit Example,604-555-0141,0`);
await page.click('button:has-text("Use this text")');
await sleep(500);
const sel = await page.$$eval('.imp-map__select', (els) => els.map((e) => e.options[e.selectedIndex].text));
check('the Voted column maps to "Voted (1/0 or a date)"', sel.join('|') === 'Full name|Phone|Voted (1/0 or a date)', sel.join('|'));
await page.click('button:has-text("Check 4 rows")');
await sleep(1200);
await page.click('button:has-text("See matches")').catch(() => {});
await sleep(300);
t = await D.text();
check('the check: 2 new, 1 update (Grace — "adds voted"), 1 same (Harjit, already voted)', /adds voted/.test(t) && /Grace Example — adds voted/.test(t) && !/Harjit Example — adds/.test(t), t.slice(-500));
await page.getByRole('button', { name: /^Import \d+ (person|people)$/ }).click();
await sleep(1500);
const file = (await D.api('/persons?q=File%20Example')).json.persons[0];
const nope = (await D.api('/persons?q=Nope%20Example')).json.persons[0];
const grace = await marksOf(P.grace.id);
check('the file marks File and Grace (source: file), leaves a 0 alone, never un-marks (Harjit stays voted)', !!file?.voted_at && nope?.voted_at === null && !!(await marksOf(P.harjit.id)).voted_at
  && (await marksOf(file.id)).marks[0].source === 'file' && !!grace.voted_at && grace.marks.length === 1 && grace.marks[0].source === 'file', JSON.stringify({ file: file?.voted_at, nope: nope?.voted_at, grace }));
check('the import’s own events are on the books (voted_mark)', (await D.api('/events?since=0&limit=5000')).json.events.filter((e) => e.action === 'import.persons' && e.entity_type === 'voted_mark').length === 2);
await D.shot('11-import-voted');

// ── 11. Off: the buttons go, the marks stay ──
// Today is election day, so off by hand also needs "turn on by itself" off.
await D.go('/voted');
await page.click('.vt-page .sv-switch');
await page.uncheck('.vt-auto input');
await page.click('.vt-page .btn-primary');
await sleep(900);
check('switched off on the server', (await D.api('/voted/status')).json.on === false);
await V.go(`/turfs/${turf.id}`);
await openDoor('Maya Example');
check('off: an open door has the rating row and no "Voted ✓", no Change — the "✓ Voted" chip stays', !!(await vpage.$(`${doorOf('Maya Example')} .walk-panel .rb-btn`))
  && !(await vpage.$('.vt-btn')) && !(await vpage.$('.vt-change')) && (await vpage.innerText(`${doorOf('Maya Example')} .vt-chip`).catch(() => '')).trim() === '✓ Voted');
await V.go(`/calls?person=${P.dev.id}`);
await vpage.waitForSelector('section.cl-card', { timeout: 8000 }).catch(() => {});
check('off: the Calls card has no "Voted ✓"', !(await vpage.$('section.cl-card .vt-btn')) && !(await vpage.$('section.cl-card .vt-done')));
const optsOff = await sheet();
check('off: the map has no voted filters', !optsOff.some(([l]) => l === 'Voted' || l === 'Yes, not voted'), JSON.stringify(optsOff));
await vpage.keyboard.press('Escape').catch(() => {});
await V.shot('12-walk-off');

// ── 12. The books still verify ──
const v = (await D.api('/audit/verify')).json;
check('hash chain verifies after the whole journey', v.ok === true && v.checked > 20, JSON.stringify(v));
check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
