// Volunteers E2E — the crew board on a shift and the volunteer roster, on one
// fresh in-memory campaign (made-up people, example.org emails, 555-01xx).
//
// A manager has three turfs with doors in them, a "Saturday canvass" that
// carries two of them (Newton block, 72 Ave east), a volunteer with an app
// sign-in (Walker), someone who asked to volunteer at a door (Asker), a
// driver, someone busy on an overlapping phone bank, and someone who did one
// shift two months ago.
//
// The shift's crew board: the tray lists the volunteers not on it (Busy says
// "Busy then: Phone bank", Asker "Asked to volunteer"); columns "Not placed
// yet", one per turf (with its doors), "No walk list". Dragging with a mouse:
// Asker from the tray onto Newton block books them there and their request
// is done; Walker onto "Not placed yet" gives both walk lists (Walker's own
// /api/turfs says so); Walker's card onto 72 Ave east leaves only that one.
// Without dragging: tap Driver, then "Add Driver here" on "No walk list";
// Enter picks a card up and Escape puts it down. The ⋯ menu makes Walker
// team lead. "Split the rest evenly" places everyone not placed. A card
// dragged back to the tray leaves the shift, and Undo brings it back where
// it was — a Confirmed card comes back confirmed, on its turf, with its job
// and walk list. Every move is read out (aria-live) and matches the API.
//
// A shift tonight with room for one: the ⋯ menu's Here checks someone in,
// the shift still says Full and nobody can be booked past it; taken off,
// Undo brings them back as Here. Staff kept out of Map & turfs: taking
// someone off a turf offers no Undo (putting them back there isn't theirs
// to do); someone not placed comes back with Undo, still Here.
//
// Shifts → Volunteers: counts by stage; "Asked to volunteer" lists a new
// asker; "Put on a shift" books them on Saturday canvass and their request
// is done; Lapsed lists the summer volunteer. On a 390×844 phone the board
// stacks, nothing scrolls sideways, and the tap path works. Screens are
// measured (≤1 yellow, 48px targets on the phone).
//
//   STARBASE_OPEN_SIGNUP=1 STARBASE_DATA=memory PORT=4511 node server/index.js &
//   BASE=http://127.0.0.1:4511 SHOTS=/tmp/volunteers node e2e-volunteers.mjs
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:3200';
const SHOTS = process.env.SHOTS || '/tmp/starbase-volunteers';
mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 240) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Date.now().toString(36);
const inDays = (n) => new Date(Date.now() + n * 864e5).toISOString();
const lat = 49.1327; const lng = -122.855;
const square = (d) => [[lat + d + 0.001, lng - 0.001], [lat + d + 0.001, lng + 0.002], [lat + d - 0.001, lng + 0.002], [lat + d - 0.001, lng - 0.001]];

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const errors = [];
const wire = (page, who) => {
  page.on('pageerror', (e) => errors.push(`[${who}] ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && /key|unique|warning/i.test(m.text())) errors.push(`[${who}] ${m.text()}`); });
  return {
    api: (path, body) => page.evaluate(async ([p, b]) => {
      const r = await fetch('/api' + p, b === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
      return { status: r.status, json: await r.json().catch(() => null) };
    }, [path, body]),
    shot: (n, full = false) => page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: full }),
  };
};
const measure = (page, sel) => page.evaluate((targets) => {
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const yellow = [...document.querySelectorAll('.btn-primary')].filter(visible).length;
  const overflow = document.documentElement.scrollWidth - window.innerWidth;
  let minTap = null; let minWho = '';
  for (const el of document.querySelectorAll(targets)) {
    if (!visible(el)) continue;
    const h = el.getBoundingClientRect().height;
    if (minTap == null || h < minTap) { minTap = h; minWho = el.outerHTML.slice(0, 90); }
  }
  return { yellow, overflow, minTap, minWho };
}, sel);
const live = (page) => page.locator('.cb-live').innerText().catch(() => '');
const until = async (fn, ms = 10000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(200);
  }
};

// ── 1. A manager, turfs with doors, the people ──
const desk = await browser.newContext({ viewport: { width: 1400, height: 950 }, timezoneId: 'America/Vancouver' });
const page = await desk.newPage();
const D = wire(page, 'desk');
await page.goto(`${BASE}/signup`, { waitUntil: 'domcontentloaded' });
await page.fill('#su-name', 'Rae Organizer');
if (await page.locator('#su-org').count()) await page.fill('#su-org', 'Imagine Surrey');
await page.fill('#su-email', `organizer.${tag}@example.org`);
await page.fill('#su-password', 'surrey-forward-2026');
await page.click('button[type="submit"]');
await page.waitForURL(/\/admin\/?$/, { timeout: 15000 });

const turf = async (name, d) => (await D.api('/actions/turf.create', { name, polygon: square(d) })).json.turf;
const newton = await turf('Newton block', 0.01);
const east = await turf('72 Ave east', 0.02);
await turf('Fleetwood loop', 0.03);
for (let i = 0; i < 3; i += 1) await D.api('/actions/person.create', { name: `Door${i} Example`, address: `${13200 + i} 72 Ave`, lat: lat + 0.01, lng: lng + i * 0.0004 });
await D.api('/actions/person.create', { name: 'Door9 Example', address: '13300 72 Ave', lat: lat + 0.02, lng });
const person = async (name, extra = {}) => (await D.api('/actions/person.create', { name, ...extra })).json.person;
const inv = (await D.api('/actions/member.invite', { email: `walker.${tag}@example.org`, role: 'volunteer' })).json;
const walkerCtx = await browser.newContext({ timezoneId: 'America/Vancouver' });
const wj = await walkerCtx.request.post(`${BASE}/api/auth/join`, { data: { token: inv.joinUrl.split('/join/')[1], name: 'Walker Example', password: 'walker-pass-123' } });
check('the walker joined', wj.status() === 200, wj.status());
const walkerTurfs = async () => (await (await walkerCtx.request.get(`${BASE}/api/turfs`)).json()).turfs.map((t) => t.name).sort();
const P = {
  walker: await person('Walker Example', { email: `walker.${tag}@example.org`, phone: '604-555-0181' }),
  asker: await person('Asker Example', { phone: '604-555-0182' }),
  driver: await person('Driver Example', { phone: '604-555-0183' }),
  busy: await person('Busy Example', { phone: '604-555-0184' }),
  lapsed: await person('Lapsed Example', { phone: '604-555-0185' }),
  extra1: await person('Extra Example', { phone: '604-555-0186' }),
  extra2: await person('Other Example', { phone: '604-555-0187' }),
};
await D.api('/actions/request.ask', { person_id: P.asker.id, kind: 'volunteer', note: 'Saturdays work' });
await D.api('/actions/volunteer.assign', { person_id: P.driver.id, role: 'driver' });
await D.api('/actions/volunteer.assign', { person_id: P.extra1.id, role: 'doorknocking' });
await D.api('/actions/volunteer.assign', { person_id: P.extra2.id, role: 'doorknocking' });
const shift = (await D.api('/actions/shift.create', { title: 'Saturday canvass', location: 'Newton Rec Centre', starts_at: inDays(3), ends_at: inDays(3.125), capacity: 10 })).json.shift;
await D.api('/actions/shift.turfs.set', { shift_id: shift.id, turf_ids: [newton.id, east.id] });
const phone = (await D.api('/actions/shift.create', { title: 'Phone bank', starts_at: inDays(3.02), ends_at: inDays(3.2) })).json.shift;
await D.api('/actions/shift.assign', { shift_id: phone.id, person_id: P.busy.id });
const past = (await D.api('/actions/shift.create', { title: 'Summer BBQ', starts_at: inDays(-60), ends_at: inDays(-59.9) })).json.shift;
await D.api('/actions/shift.assign', { shift_id: past.id, person_id: P.lapsed.id });
const crewOf = async () => (await D.api(`/crew/${shift.id}`)).json;
const placed = async (personId) => (await crewOf()).crew.find((c) => c.person_id === personId);

// ── 2. The shift's crew board ──
await page.goto(`${BASE}/admin/shifts/${shift.id}`, { waitUntil: 'domcontentloaded' });
await page.locator('.cb-col').first().waitFor({ timeout: 10000 });
await sleep(600);
const cols = await page.locator('.cb-col__title').allInnerTexts();
check('columns: Not placed yet, each turf, No walk list', JSON.stringify(cols) === JSON.stringify(['Not placed yet', 'Newton block', '72 Ave east', 'No walk list']), cols.join(' | '));
const sub = await page.locator('.cb-col[data-drop-key="turf:' + newton.id + '"] .cb-col__sub').innerText().catch(() => '');
check('a turf column says its doors', /3 doors/.test(sub), sub);
const trayText = (await page.locator('.cb-tray').innerText()).replace(/\s+/g, ' ');
check('the tray: volunteers not on the shift', ['Asker Example', 'Driver Example', 'Busy Example', 'Lapsed Example', 'Walker Example'].every((n) => trayText.includes(n)), trayText.slice(0, 300));
check('Busy says "Busy then: Phone bank"', /Busy Example Busy then: Phone bank/.test(trayText), trayText.slice(0, 300));
check('Asker says "Asked to volunteer"', /Asker Example Asked to volunteer/.test(trayText));
const m0 = await measure(page, '.cb button, .cb input, .cb select');
check('the shift page with its board: ≤1 yellow, no sideways scroll', m0.yellow <= 1 && m0.overflow <= 0, JSON.stringify(m0));
await D.shot('1-board-desktop', true);

// ── 3. Drag with a mouse ──
const trayBtn = (name) => page.locator('.cb-person', { hasText: name });
const colOf = (key) => page.locator(`.cb-col[data-drop-key="${key}"]`);
await trayBtn('Asker Example').dragTo(colOf(`turf:${newton.id}`));
await until(async () => (await placed(P.asker.id))?.to === newton.id);
check('dragged Asker onto Newton block: booked there', (await placed(P.asker.id))?.to === newton.id);
const said = await until(async () => { const t = await live(page); return /Asker Example is on the shift — Newton block/.test(t) ? t : null; });
check('read out: "Asker Example is on the shift — Newton block" and the request is done', /Wants to volunteer” is done/.test(said || ''), said);
const req = (await D.api(`/persons/${P.asker.id}/requests`)).json.requests[0];
check('their "Wants to volunteer" request is done on the server', !!req?.done_at && /^On Saturday canvass/.test(req.done_note || ''), JSON.stringify(req).slice(0, 160));
check('Asker’s card is on the Newton block column', await colOf(`turf:${newton.id}`).locator('.cb-card', { hasText: 'Asker Example' }).count() === 1);

await sleep(400);
await trayBtn('Walker Example').dragTo(colOf('every'));
await until(async () => (await placed(P.walker.id))?.to === 'every');
check('Walker onto "Not placed yet": every walk list on their phone', JSON.stringify(await walkerTurfs()) === JSON.stringify(['72 Ave east', 'Newton block']), (await walkerTurfs()).join(', '));
await sleep(400);
await page.locator('.cb-card', { hasText: 'Walker Example' }).locator('.cb-card__main').dragTo(colOf(`turf:${east.id}`));
await until(async () => (await placed(P.walker.id))?.to === east.id);
check('Walker’s card onto 72 Ave east: only that walk list now', JSON.stringify(await walkerTurfs()) === JSON.stringify(['72 Ave east']), (await walkerTurfs()).join(', '));

// ── 4. Without dragging: tap, then "Add here"; Enter and Escape ──
await sleep(400);
await trayBtn('Driver Example').click();
check('a tap picks Driver up', (await trayBtn('Driver Example').getAttribute('aria-pressed')) === 'true');
check('the hand bar says what to do', /Driver Example — tap “Add here” on a column/.test(await page.locator('.cb-hand').innerText().catch(() => '')));
await colOf('none').getByRole('button', { name: 'Add Driver here' }).click();
await until(async () => (await placed(P.driver.id))?.to === 'none');
check('tap path: Driver on "No walk list"', (await placed(P.driver.id))?.to === 'none');
await sleep(400);
const card = page.locator('.cb-card', { hasText: 'Asker Example' }).locator('.cb-card__main');
await card.focus();
await page.keyboard.press('Enter');
check('Enter picks a card up', (await card.getAttribute('aria-pressed')) === 'true');
check('…and each other column offers "Move Asker here"', await page.getByRole('button', { name: 'Move Asker here' }).count() === 3);
await page.keyboard.press('Escape');
check('Escape puts it down', (await card.getAttribute('aria-pressed')) === 'false');

// ── 5. Team lead; split the rest evenly ──
await page.locator('.cb-card', { hasText: 'Walker Example' }).getByRole('button', { name: 'More for Walker Example' }).click();
await page.locator('.cb-menu').getByRole('button', { name: 'Team lead' }).click();
await until(async () => (await placed(P.walker.id))?.job === 'lead');
check('the ⋯ menu: Walker is team lead', (await placed(P.walker.id))?.job === 'lead'
  && await page.locator('.cb-card', { hasText: 'Walker Example' }).locator('.cb-job--lead').count() === 1);
await D.api('/actions/shift.add', { shift_id: shift.id, person_id: P.extra1.id });
await D.api('/actions/shift.add', { shift_id: shift.id, person_id: P.extra2.id });
await page.reload({ waitUntil: 'domcontentloaded' });
await page.locator('.cb-col').first().waitFor();
await sleep(500);
check('"Split the rest evenly" offered for 2 not placed', /2 not placed yet/.test(await page.locator('.cb-count').innerText()));
await page.getByRole('button', { name: 'Split the rest evenly' }).click();
await until(async () => (await crewOf()).crew.every((c) => c.to !== 'every'));
const after = (await crewOf()).crew;
const on = (id) => after.filter((c) => c.to === id).length;
check('split: nobody left not placed, the turfs evenly (2 and 2)', after.every((c) => c.to !== 'every') && on(newton.id) === 2 && on(east.id) === 2, after.map((c) => `${c.name}:${c.to}`).join(', '));
await D.shot('2-board-split', true);

// ── 6. Back to the tray: off the shift; Undo ──
await sleep(500);
await page.locator('.cb-card', { hasText: 'Driver Example' }).locator('.cb-card__main').dragTo(page.locator('.cb-tray'));
await until(async () => !(await placed(P.driver.id)));
check('Driver dragged back to the tray: off the shift', !(await placed(P.driver.id)));
await page.locator('.cb-toast').getByRole('button', { name: 'Undo' }).click();
await until(async () => (await placed(P.driver.id))?.to === 'none');
check('Undo: back on, on "No walk list"', (await placed(P.driver.id))?.to === 'none');

// Undo brings a card back as it was: Confirmed, on its turf, team lead.
await D.api('/actions/shift.setStatus', { id: (await placed(P.walker.id)).assignment_id, status: 'confirmed' });
await page.reload({ waitUntil: 'domcontentloaded' });
await page.locator('.cb-col').first().waitFor();
await sleep(500);
const cardOf = (pg, name) => pg.locator('.cb-card', { hasText: name });
const chipOn = async (pg, name, words) => cardOf(pg, name).locator('.chip', { hasText: words }).count();
check('Walker’s card says Confirmed', await chipOn(page, 'Walker Example', 'Confirmed') === 1);
const takeOff = async (pg, name) => {
  await cardOf(pg, name).getByRole('button', { name: `More for ${name}` }).click();
  await pg.locator('.cb-menu').getByRole('button', { name: 'Take off the shift' }).click();
  await pg.locator('.cb-toast', { hasText: `${name} is off the shift` }).waitFor({ timeout: 8000 }).catch(() => {});
};
await takeOff(page, 'Walker Example');
await until(async () => !(await placed(P.walker.id)));
check('⋯ → Take off the shift: Walker is off it, walk list and all', !(await placed(P.walker.id)) && (await walkerTurfs()).length === 0, (await walkerTurfs()).join(', '));
await page.locator('.cb-toast').getByRole('button', { name: 'Undo' }).click();
await until(async () => (await placed(P.walker.id))?.status === 'confirmed');
const wBack = await placed(P.walker.id);
check('Undo: Walker back confirmed — on 72 Ave east, team lead', wBack?.status === 'confirmed' && wBack.to === east.id && wBack.job === 'lead', JSON.stringify(wBack));
await until(async () => (await chipOn(page, 'Walker Example', 'Confirmed')) === 1, 5000);
check('…the card says Confirmed again, and the walk list is back', await chipOn(page, 'Walker Example', 'Confirmed') === 1
  && JSON.stringify(await walkerTurfs()) === JSON.stringify(['72 Ave east']), (await walkerTurfs()).join(', '));

// ── 6b. On the day: Here keeps the spot; Undo brings them back as Here ──
const night = await person('Night Example', { phone: '604-555-0189' });
const tonight = (await D.api('/actions/shift.create', { title: 'Lit drop tonight', starts_at: inDays(2 / 24), ends_at: inDays(4 / 24), capacity: 1 })).json.shift;
await D.api('/actions/shift.add', { shift_id: tonight.id, person_id: night.id });
const nightOn = async () => (await D.api(`/crew/${tonight.id}`)).json.crew.find((c) => c.person_id === night.id);
await page.goto(`${BASE}/admin/shifts/${tonight.id}`, { waitUntil: 'domcontentloaded' });
await page.locator('.cb-col').first().waitFor({ timeout: 10000 });
await sleep(500);
const spots = () => page.locator('.ops-spots').innerText().catch(() => '');
check('tonight, room for one: Full', /Full/.test(await spots()), await spots());
await cardOf(page, 'Night Example').getByRole('button', { name: 'More for Night Example' }).click();
await page.locator('.cb-menu').getByRole('button', { name: 'Here', exact: true }).click();
await until(async () => (await nightOn())?.status === 'completed');
check('the ⋯ menu on the day: Here', (await nightOn())?.status === 'completed'
  && await until(async () => (await chipOn(page, 'Night Example', 'Here')) === 1, 5000));
// The shift's own roster says Done once the page has the check-in.
await page.locator('.st-roster-toggle').click();
await until(async () => /Done/.test(await page.locator('#shift-roster').innerText().catch(() => '')), 5000);
check('Here keeps the spot: still Full', /Full/.test(await spots()), await spots());
const past1 = await D.api('/actions/shift.add', { shift_id: tonight.id, person_id: P.extra2.id });
check('…and nobody is booked past it', past1.status === 409, JSON.stringify(past1.json));
await takeOff(page, 'Night Example');
await until(async () => !(await nightOn()));
await page.locator('.cb-toast').getByRole('button', { name: 'Undo' }).click();
await until(async () => (await nightOn())?.status === 'completed');
check('Undo: Night back on the shift as Here', (await nightOn())?.status === 'completed'
  && await until(async () => (await chipOn(page, 'Night Example', 'Here')) === 1, 5000), JSON.stringify(await nightOn()));

// ── 6c. Staff kept out of Map & turfs: Undo only where they may put someone ──
const sInv = (await D.api('/actions/member.invite', { email: `staff.${tag}@example.org`, role: 'staff' })).json;
const staffCtx = await browser.newContext({ viewport: { width: 1400, height: 950 }, timezoneId: 'America/Vancouver' });
const sj = await staffCtx.request.post(`${BASE}/api/auth/join`, { data: { token: sInv.joinUrl.split('/join/')[1], name: 'Staff Example', password: 'staff-pass-123' } });
const staffUser = (await sj.json().catch(() => ({})))?.user?.id;
check('a staff member joined, kept out of Map & turfs', sj.status() === 200
  && (await D.api('/actions/permission.member.set', { user_id: staffUser, grant: [], deny: ['map'] })).status === 200, sj.status());
const sp = await staffCtx.newPage();
wire(sp, 'staff');
await sp.goto(`${BASE}/admin/shifts/${shift.id}`, { waitUntil: 'domcontentloaded' });
await sp.locator('.cb-col').first().waitFor({ timeout: 10000 });
await sleep(500);
check('their board says moving walk lists needs Map & turfs', /Moving walk lists needs Map & turfs/.test(await sp.locator('.cb-help').innerText()));
const extraWas = (await placed(P.extra1.id))?.to;
await takeOff(sp, 'Extra Example');
await until(async () => !(await placed(P.extra1.id)));
const offToast = await sp.locator('.cb-toast').innerText().catch(() => '');
check('Extra taken off a turf: said, with no Undo it couldn’t keep', [newton.id, east.id].includes(extraWas) && !(await placed(P.extra1.id))
  && /Extra Example is off the shift/.test(offToast) && await sp.locator('.cb-toast').getByRole('button', { name: 'Undo' }).count() === 0, `${extraWas} · ${offToast}`);
await sp.goto(`${BASE}/admin/shifts/${tonight.id}`, { waitUntil: 'domcontentloaded' });
await sp.locator('.cb-col').first().waitFor({ timeout: 10000 });
await sleep(500);
await takeOff(sp, 'Night Example');
await until(async () => !(await nightOn()));
await sp.locator('.cb-toast').getByRole('button', { name: 'Undo' }).click();
await until(async () => (await nightOn())?.status === 'completed');
check('Night (not placed) taken off and back with Undo — still Here', (await nightOn())?.status === 'completed', JSON.stringify(await nightOn()));
await staffCtx.close();

// ── 7. Shifts → Volunteers ──
const newbie = await person('Newbie Example', { phone: '604-555-0188' });
await D.api('/actions/request.ask', { person_id: newbie.id, kind: 'volunteer' });
await page.goto(`${BASE}/admin/shifts`, { waitUntil: 'domcontentloaded' });
await page.getByRole('button', { name: 'Volunteers' }).click();
await page.waitForURL(/\/shifts\/volunteers$/);
await page.locator('.vl-rows').waitFor({ timeout: 10000 });
const sum = await page.locator('.vl-sum').innerText();
const roster = (await D.api('/volunteers')).json;
check('the roster’s line matches the server', sum.startsWith(`${roster.counts.all} volunteers · ${roster.counts.active} active`) && /1 asked to volunteer/.test(sum), sum);
await page.locator('.vl-shows').getByRole('button', { name: /^Asked to volunteer/ }).click();
const askedRows = await page.locator('.vl-item .ops-row__name').allInnerTexts();
check('Asked to volunteer: Newbie', JSON.stringify(askedRows) === '["Newbie Example"]', askedRows.join(', '));
await page.locator('.vl-item', { hasText: 'Newbie Example' }).locator('.ops-row').click();
check('an open row: Call · Text', await page.getByRole('link', { name: 'Call' }).count() === 1 && await page.getByRole('link', { name: 'Text' }).count() === 1);
const m1 = await measure(page, '.vl-page button, .vl-page a.btn, .vl-page input, .vl-page select');
check('roster: ≤1 yellow, no sideways scroll', m1.yellow <= 1 && m1.overflow <= 0, JSON.stringify(m1));
await page.getByRole('button', { name: 'Put on a shift' }).click();
const busyRow = await page.locator('.vl-shift', { hasText: 'Saturday canvass' }).innerText();
check('the shifts ahead, each with its spots', /Saturday canvass/.test(busyRow) && /spots left/.test(busyRow), busyRow);
await D.shot('3-roster-put-on', true);
await page.locator('.vl-shift', { hasText: 'Saturday canvass' }).click();
await page.locator('.ops-done', { hasText: 'On Saturday canvass' }).waitFor({ timeout: 8000 }).catch(() => {});
check('"✓ On Saturday canvass — their “Wants to volunteer” is done"', /On Saturday canvass — their “Wants to volunteer” is done/.test(await page.locator('.vl-item', { hasText: 'Newbie Example' }).innerText()));
check('the server has Newbie on the crew', !!(await placed(newbie.id)));
await page.locator('.vl-shows').getByRole('button', { name: /^Lapsed/ }).click();
check('Lapsed: the summer volunteer', (await page.locator('.vl-item .ops-row__name').allInnerTexts()).includes('Lapsed Example'));

// ── 8. A phone ──
const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/Vancouver' });
await mobile.addCookies((await desk.cookies()).map((c) => ({ ...c })));
const ph = await mobile.newPage();
wire(ph, 'phone');
await ph.goto(`${BASE}/admin/shifts/${shift.id}`, { waitUntil: 'domcontentloaded' });
await ph.locator('.cb-col').first().waitFor({ timeout: 10000 });
await sleep(600);
const m2 = await measure(ph, '.cb button, .cb input:not([type=checkbox]), .cb select, .cb-free');
check('phone: no sideways scroll, targets ≥44px', m2.overflow <= 0 && m2.minTap >= 43.5, JSON.stringify(m2));
await ph.locator('.cb-person', { hasText: 'Busy Example' }).tap();
await ph.locator('.cb-col[data-drop-key="every"]').getByRole('button', { name: 'Add Busy here' }).tap();
await until(async () => (await placed(P.busy.id))?.to === 'every');
check('phone tap path: Busy on the shift, not placed yet', (await placed(P.busy.id))?.to === 'every');
await ph.screenshot({ path: `${SHOTS}/4-board-phone.png`, fullPage: true });

check('no page errors', errors.length === 0, errors.join(' | '));
check('the books verify', (await D.api('/audit/verify')).json?.ok === true);
await browser.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
