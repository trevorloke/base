// Shifts on a turf E2E — one fresh in-memory campaign: a manager makes
// "Saturday canvass" in Shifts → New shift and, under More details, picks the
// turf "Newton block"; the shift says "Walk list: Newton block" with "Change
// turfs", the week board shows a turf chip, and an assignee with no app
// sign-in is marked. A volunteer on a phone (390×844) sees the row
// "Saturday canvass · Newton block" and the shift's "Walk list: Newton block
// — Count me in puts it on your phone"; Count me in → Today's "Start
// canvassing" is Newton block and the shift row reads "… · Newton block".
// With no signal a second shift's Count me in waits on the phone, Today's
// row still names the turf, and once the signal is back the server puts them
// on that shift's turf. Can't make it → Newton block leaves Today; the turf
// the desk gave by hand and the other shift's turf stay. Every claim on a
// screen is checked against the API; each screen is measured (one yellow
// button, no sideways scroll, 48px targets on the phone).
//
//   STARBASE_OPEN_SIGNUP=1 STARBASE_DATA=memory PORT=4450 node server/index.js &
//   BASE=http://127.0.0.1:4450 SHOTS=/tmp/shiftturfs node e2e-shiftturfs.mjs
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:3200';
const ADMIN = { toString() { return `${BASE}/admin`; } }; // the desk's pages live in the admin (web/src/mode.js)
const SHOTS = process.env.SHOTS || '/tmp/starbase-shiftturfs';
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
// A control is 48px wherever a thumb reaches and 40 on a desk with a mouse
// (app.css --ctl): the page itself says which it is.
const tapFloor = (page) => page.evaluate(() => (matchMedia('(min-width: 900px) and (pointer: fine)').matches ? 40 : 48));
const simple = async (pg, name, sel = null, yellow = 1) => {
  const mm = await measure(pg, sel);
  const floor = await tapFloor(pg);
  check(`${name}: ${yellow} yellow, no sideways scroll${sel ? `, targets ≥ ${floor}px` : ''}`, mm.yellow === yellow && mm.overflow <= 0 && (mm.minTap == null || mm.minTap >= floor - 0.5), JSON.stringify(mm));
  return mm;
};
// Days on the campaign's clock (the browsers run in Vancouver): the next
// Saturday after today, and the Sunday after it.
const dayAhead = (n) => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' });
const satIn = (() => {
  for (let i = 1; i <= 7; i += 1) if (new Date(`${dayAhead(i)}T12:00:00Z`).getUTCDay() === 6) return i;
  return 7;
})();
const at10 = (day) => {
  // 10:00 in Vancouver for that day, as an ISO timestamp with its offset.
  const probe = new Date(`${day}T18:00:00Z`);
  const off = probe.toLocaleString('en-US', { timeZone: 'America/Vancouver', timeZoneName: 'shortOffset' }).match(/GMT([+-]\d+)/)?.[1] || '-8';
  const h = String(Math.abs(Number(off))).padStart(2, '0');
  return `${day}T10:00:00${Number(off) < 0 ? '-' : '+'}${h}:00`;
};

// ── 1. A manager, three turfs with doors in them (Example surnames, 555-01xx phones) ──
const dctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, timezoneId: 'America/Vancouver' });
await tiles(dctx);
const page = await dctx.newPage();
const D = helpers(page, 'manager');
await D.go('/signup');
await page.fill('#su-name', 'Priya Staff');
if (await page.locator('#su-org').count()) await page.fill('#su-org', 'Imagine Surrey');
await page.fill('#su-email', `priya+${tag}@shiftturfs.example`);
await page.fill('#su-password', 'surrey-forward-2026');
await page.click('button[type="submit"]');
await page.waitForURL(/\/admin\/?$/, { timeout: 15000 });

const lat = 49.1327; const lng = -122.855;
const box = (dLat) => [[lat + dLat + 0.001, lng - 0.001], [lat + dLat + 0.001, lng + 0.002], [lat + dLat - 0.001, lng + 0.002], [lat + dLat - 0.001, lng - 0.001]];
const T = {};
const mkTurf = async (key, name, dLat, color) => { T[key] = (await D.api('/actions/turf.create', { name, polygon: box(dLat), color })).json.turf; };
await mkTurf('newton', 'Newton block', 0, '#2b6cb0');
await mkTurf('east', '72 Ave east', 0.01, '#c05621');
await mkTurf('sept', 'September turf', 0.02, '#2f855a');
let n = 0;
for (const [key, dLat] of [['newton', 0], ['east', 0.01], ['sept', 0.02]]) {
  for (let i = 0; i < 3; i += 1) {
    n += 1;
    await D.api('/actions/person.create', {
      name: `Door${n} Example`, phone: `604-555-01${String(10 + n).padStart(2, '0')}`,
      address: `${13200 + i * 12} 72 Ave`, city: 'Surrey', lat: lat + dLat, lng: lng + i * 0.0003,
    });
  }
  check(`turf "${T[key].name}" has its doors`, (await D.api('/turfs')).json.turfs.find((t) => t.id === T[key].id)?.doors === 3);
}

// ── 2. Shifts → New shift: "Saturday canvass", the turf under More details ──
const day = dayAhead(satIn);
await D.go('/shifts?new=1');
await page.waitForSelector('form[aria-label="New shift"]', { timeout: 8000 });
await page.fill('#shift-title', 'Saturday canvass');
await page.fill('#shift-starts', `${day}T10:00`);
await page.fill('#shift-location', 'Newton Rec Centre');
await page.fill('#shift-capacity', '8');
await page.click('form[aria-label="New shift"] button:has-text("More details")');
await page.waitForSelector('#shift-turfs .st-opt', { timeout: 8000 }).catch(() => {});
const opts = await page.$$eval('#shift-turfs .st-opt', (els) => els.map((e) => e.innerText.trim()));
check('More details → Turfs lists the campaign’s turfs', opts.join('|') === 'Newton block|72 Ave east|September turf', opts.join('|'));
check('…with "Anyone who counts themselves in gets these walk lists"', /Anyone who counts themselves in gets these walk lists/.test(await D.text()));
await page.click('#shift-turfs .st-opt:has-text("Newton block")');
check('a picked turf is pressed', (await page.getAttribute('#shift-turfs .st-opt:has-text("Newton block")', 'aria-pressed')) === 'true');
await simple(page, 'new shift form (1360)', '#shift-turfs .st-opt');
await D.shot('01-new-shift-turfs');
await page.click('form[aria-label="New shift"] button[type="submit"]');
await page.waitForURL(/\/admin\/shifts\/[0-9a-f-]{36}$/, { timeout: 10000 });
const shiftId = page.url().split('/').pop();
const st = await D.api(`/shiftturfs/${shiftId}`);
check('server: the shift carries Newton block', st.status === 200 && st.json.turfs.map((t) => t.name).join('|') === 'Newton block', st.raw);
await page.waitForSelector('.st-walk__line', { timeout: 8000 }).catch(() => {});
let line = await page.innerText('.st-walk__line').catch(() => '');
check('desk shift: "Walk list: Newton block"', line.trim() === 'Walk list: Newton block', line);
check('desk shift: "Change turfs"', await page.locator('.st-walk button:has-text("Change turfs")').count() === 1);

// Someone with no app sign-in on it: the desk is told.
const pat = (await D.api('/actions/person.create', { name: 'Pat Example', phone: '604-555-0131' })).json.person;
check('desk assigns Pat (no sign-in)', (await D.api('/actions/shift.assign', { shift_id: shiftId, person_id: pat.id })).status === 200);
await D.go(`/shifts/${shiftId}`);
// Under the crew board, the roster folds away: open it.
await page.locator('.st-roster-toggle').click({ timeout: 8000 }).catch(() => {});
await page.waitForSelector('.st-signin', { timeout: 8000 }).catch(() => {});
const note = await page.innerText('.ops-item:has-text("Pat Example") .st-signin').catch(() => '');
check('Pat’s row: "No app sign-in — add them to the turf on the map"', note === 'No app sign-in — add them to the turf on the map', note);
await simple(page, 'desk shift (1360)');
await D.shot('02-desk-shift');

// The week board: a small turf chip on the shift.
await D.go(`/shifts?week=${day}`);
await page.waitForSelector('.sb-shift', { timeout: 10000 }).catch(() => {});
const chip = await page.innerText(`.sb-shift[data-shift="${shiftId}"] .st-chip`).catch(() => '');
check('week board: the shift’s turf chip "Newton block"', chip.trim() === 'Newton block', chip);
await D.shot('03-week-board');

// A second shift (Sunday), made through the API; the desk adds its turf with "Add turfs".
const sunday = (await D.api('/actions/shift.create', { title: 'Sunday canvass', location: 'Newton Rec Centre', starts_at: at10(dayAhead(satIn + 1)) })).json.shift;
await D.go(`/shifts/${sunday.id}`);
await page.click('.st-walk button:has-text("Add turfs")');
await page.waitForSelector('#shift-turfs-edit .st-opt', { timeout: 8000 });
await page.click('#shift-turfs-edit .st-opt:has-text("72 Ave east")');
await simple(page, 'Change turfs open (1360)');
await page.click('.st-walk button:has-text("Save")');
await page.waitForSelector('.st-walk .ops-done', { timeout: 8000 }).catch(() => {});
check('Save → "✓ Saved"', /✓ Saved/.test(await page.innerText('.st-walk').catch(() => '')));
line = await page.innerText('.st-walk__line').catch(() => '');
check('…and "Walk list: 72 Ave east", from the server', line.trim() === 'Walk list: 72 Ave east'
  && (await D.api(`/shiftturfs/${sunday.id}`)).json.turfs.map((t) => t.name).join('|') === '72 Ave east', line);

// ── 3. Walker, a volunteer, on a phone ──
const walkerEmail = `walker+${tag}@shiftturfs.example`;
const invite = (await D.api('/actions/member.invite', { email: walkerEmail, role: 'volunteer' })).json;
const vctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/Vancouver' });
await tiles(vctx);
const vp = await vctx.newPage();
const V = helpers(vp, 'vol');
await V.go('/login');
const joined = await V.api('/auth/join', { token: invite.joinUrl.split('/').pop(), name: 'Walker Example', password: 'knock-knock-2026' });
check('volunteer joined', joined.status === 200 && joined.json.role === 'volunteer', joined.status);
const walkerId = joined.json.user.id;
// September: the desk put Walker on a turf by hand.
check('desk gives Walker "September turf" by hand', (await D.api('/actions/turf.assign', { turf_id: T.sept.id, user_id: walkerId })).status === 200);
check('server: before Count me in, Walker can’t open Newton block', (await V.api(`/turfs/${T.newton.id}/walk`)).status === 403);
const vAll = await V.api('/shiftturfs');
check('volunteer reads the shifts’ turfs: names and colours only', vAll.status === 200
  && JSON.stringify(vAll.json.shifts[shiftId]) === JSON.stringify([{ id: T.newton.id, name: 'Newton block', color: '#2b6cb0' }]), vAll.raw);

await V.go('/shifts');
await vp.waitForSelector('.ops-row__name', { timeout: 8000 }).catch(() => {});
const rows = await vp.$$eval('.ops-row__name', (els) => els.map((e) => e.innerText.trim()));
check('Shifts on the phone: "Saturday canvass · Newton block"', rows.includes('Saturday canvass · Newton block') && rows.includes('Sunday canvass · 72 Ave east'), rows.join(' | '));
await simple(vp, 'Shifts list (390)', null, 0);
await V.shot('04-vol-shifts');

await V.go(`/shifts/${shiftId}`);
await vp.waitForSelector('.st-walk__line', { timeout: 8000 }).catch(() => {});
line = await vp.innerText('.st-walk__line').catch(() => '');
check('phone shift: "Walk list: Newton block — Count me in puts it on your phone"', line.trim() === 'Walk list: Newton block — Count me in puts it on your phone', line);
check('…no "Change turfs" for a volunteer', await vp.locator('button:has-text("Change turfs")').count() === 0);
await simple(vp, 'phone shift (390)', '.ops-tap');
await V.shot('05-vol-shift');
await vp.tap('button:has-text("Count me in")').catch(() => vp.click('button:has-text("Count me in")'));
await vp.waitForSelector('.ops-onit', { timeout: 8000 }).catch(() => {});
line = await vp.innerText('.st-walk__line').catch(() => '');
check('Count me in → "You’re on this shift", "Walk list: Newton block — it’s on your phone"', /You’re on this shift/.test(await V.text()) && line.trim() === 'Walk list: Newton block — it’s on your phone', line);
check('server: Walker is on Newton block, its walk list opens', (await V.api('/turfs')).json.turfs.some((t) => t.id === T.newton.id)
  && (await V.api(`/turfs/${T.newton.id}/walk`)).status === 200);

await V.go('/');
await vp.waitForSelector('.today-go', { timeout: 8000 }).catch(() => {});
const go = (await vp.innerText('.today-go').catch(() => '')).replace(/\s+/g, ' ');
check('Today: "Start canvassing → Newton block · 3 doors left"', /Start canvassing/.test(go) && /Newton block/.test(go) && /3 doors left/.test(go), go);
const next = (await vp.innerText('.today-next .today-need:has-text("Your next shift")').catch(() => '')).replace(/\s+/g, ' ');
check('Today: the shift row "Saturday canvass … · Newton block"', /Saturday canvass/.test(next) && /· Newton block/.test(next), next);
await simple(vp, 'Today (390)', '.today-start');
await V.shot('06-vol-today');

// ── 4. No signal: the Sunday shift's Count me in waits on the phone ──
await V.go(`/shifts/${sunday.id}`); // opened once with signal: kept on the phone
await vp.waitForSelector('.st-walk__line', { timeout: 8000 }).catch(() => {});
await vctx.setOffline(true);
await V.go(`/shifts/${sunday.id}`);
await vp.waitForSelector('.st-walk__line', { timeout: 8000 }).catch(() => {});
line = await vp.innerText('.st-walk__line').catch(() => '');
check('offline shift: "Offline copy", still "Walk list: 72 Ave east"', /Offline copy/i.test(await V.text()) && /^Walk list: 72 Ave east/.test(line.trim()), line);
await vp.tap('button:has-text("Count me in")').catch(() => vp.click('button:has-text("Count me in")'));
await sleep(500);
check('offline Count me in: "Not sent yet"', /Count me in\s*Not sent yet/i.test(await V.text()));
await simple(vp, 'offline shift (390)', '.ops-tap', 0);
await V.go('/');
await vp.waitForSelector('.today-next', { timeout: 8000 }).catch(() => {});
const nextOff = (await vp.innerText('.today-next .today-need:has-text("Your next shift")').catch(() => '')).replace(/\s+/g, ' ');
check('offline Today, from the phone: the shift row still "… · Newton block"', /Saturday canvass/.test(nextOff) && /· Newton block/.test(nextOff), nextOff);
await V.shot('07-vol-today-offline');
await vctx.setOffline(false);
await vp.evaluate(() => window.dispatchEvent(new Event('online')));
let mine = [];
for (let i = 0; i < 24; i += 1) {
  mine = ((await V.api('/brief')).json?.myTurfs ?? []).map((t) => t.name);
  if (mine.includes('72 Ave east')) break;
  await sleep(500);
}
check('signal back: it sends, and the server puts Walker on 72 Ave east', mine.join('|') === 'Newton block|72 Ave east|September turf', mine.join('|'));

// ── 5. Can't make it: what the shift gave goes; the hand turf and Sunday's stay ──
await V.go(`/shifts/${shiftId}`);
await vp.waitForSelector('.ops-onit', { timeout: 8000 }).catch(() => {});
await vp.tap('button:has-text("Can’t make it")').catch(() => vp.click('button:has-text("Can’t make it")'));
await vp.tap('.ops-confirm button:has-text("Yes")').catch(() => vp.click('.ops-confirm button:has-text("Yes")'));
await vp.waitForSelector('button:has-text("Count me in")', { timeout: 8000 }).catch(() => {});
check('Can’t make it → Count me in is back', await vp.locator('button:has-text("Count me in")').count() === 1);
mine = ((await V.api('/brief')).json?.myTurfs ?? []).map((t) => t.name);
check('server: Newton block is off; 72 Ave east (Sunday) and September turf (by hand) stay', mine.join('|') === '72 Ave east|September turf', mine.join('|'));
check('server: the Newton walk list is closed to Walker again', (await V.api(`/turfs/${T.newton.id}/walk`)).status === 403);
await V.go('/');
await vp.waitForSelector('.today-go', { timeout: 8000 }).catch(() => {});
const go2 = (await vp.innerText('.today-go').catch(() => '')).replace(/\s+/g, ' ');
const all2 = await V.text();
check('Today: Newton block has left; "Start canvassing → 72 Ave east"', !/Newton block/.test(all2) && /Start canvassing/.test(go2) && /72 Ave east/.test(go2), go2);
const next2 = (await vp.innerText('.today-next .today-need:has-text("Your next shift")').catch(() => '')).replace(/\s+/g, ' ');
check('Today: the next shift is Sunday’s, "… · 72 Ave east"', /Sunday canvass/.test(next2) && /· 72 Ave east/.test(next2), next2);
await simple(vp, 'Today after Can’t make it (390)', '.today-start');
await V.shot('08-vol-today-after');

// ── 5b. The desk moves Sunday's shift, then calls it off ──
await D.go(`/shifts/${sunday.id}`);
await page.waitForSelector('.ops-shift-tools', { timeout: 8000 }).catch(() => {});
await page.click('.ops-shift-tools button:has-text("Edit")');
await page.waitForSelector('form[aria-label="Edit shift"]', { timeout: 8000 });
check('Edit opens filled in', (await page.inputValue('#edit-shift-title')) === 'Sunday canvass'
  && (await page.inputValue('#edit-shift-location')) === 'Newton Rec Centre'
  && /T10:00$/.test(await page.inputValue('#edit-shift-starts')), await page.inputValue('#edit-shift-starts'));
await page.fill('#edit-shift-starts', (await page.inputValue('#edit-shift-starts')).replace('T10:00', 'T11:30'));
await page.fill('#edit-shift-location', 'Newton Library');
await page.click('form[aria-label="Edit shift"] button[type="submit"]');
await page.waitForSelector('.ops-moved', { timeout: 8000 }).catch(() => {});
const moved = await page.innerText('.ops-moved').catch(() => '');
check('moved: "1 person booked has the old time or place" + Let them know', /It moved/.test(moved) && /Let them know/.test(moved), moved);
const after = (await D.api(`/shifts/${sunday.id}`)).json.shift;
check('server: the new place and 11:30', after.location === 'Newton Library'
  && new Date(after.starts_at).toLocaleTimeString('en-CA', { timeZone: 'America/Vancouver', hour: 'numeric', minute: '2-digit', hour12: false }) === '11:30',
  `${after.location} ${after.starts_at}`);
check('page reads the new place', /Newton Library/.test(await D.text()));
await page.click('.ops-moved button:has-text("Let them know")');
await page.waitForSelector('.ops-notify .ops-confirm', { timeout: 8000 }).catch(() => {});
check('Let them know opens "Email + text 1 person?"', /Email \+ text 1 person\?/.test(await page.innerText('.ops-notify').catch(() => '')));
await page.click('.ops-notify .ops-confirm button:has-text("Cancel")');
await D.shot('09-desk-shift-moved');
// Room for fewer than are booked is refused.
const tooSmall = await D.api('/actions/shift.update', { id: sunday.id, capacity: 1 });
check('capacity at what is booked is fine', tooSmall.status === 200, tooSmall.raw);
await page.click('.ops-shift-tools button:has-text("Call off")');
const offText = await page.innerText('.ops-shift-tools .ops-confirm').catch(() => '');
check('Call off asks, and says the 1 booked won’t be told', /Call off this shift\?/.test(offText) && /1 person booked won’t be told/.test(offText), offText);
await page.click('.ops-shift-tools button:has-text("Call it off")');
await page.waitForURL(/\/shifts$/, { timeout: 8000 }).catch(() => {});
await page.waitForSelector('main.page h1, main h1', { timeout: 8000 }).catch(() => {});
await sleep(400);
check('called off → back on Shifts, and it isn’t listed', /\/shifts$/.test(page.url()) && !/Sunday canvass/.test(await D.text()), page.url());
check('server: the shift is gone (404)', (await D.api(`/shifts/${sunday.id}`)).status === 404);
mine = ((await V.api('/brief')).json?.myTurfs ?? []).map((t) => t.name);
check('Walker: 72 Ave east (from Sunday) came off; September turf (by hand) stays', mine.join('|') === 'September turf', mine.join('|'));
await V.go(`/shifts/${sunday.id}`);
check('Walker opening it: "That shift is gone."', /That shift is gone/.test(await V.text()));

// ── 5c. Volunteers' map: only their turfs ──
await D.go('/settings/permissions');
await page.waitForSelector('fieldset.adm-doors', { timeout: 8000 });
check('Settings → Permissions: Volunteers’ map is "Every door"', await page.isChecked('input[name="adm-doors"][value="all"]'));
await page.click('fieldset.adm-doors label:has-text("Only their turfs")');
await page.waitForFunction(() => document.querySelector('input[name="adm-doors"][value="turfs"]')?.checked && !document.querySelector('input[name="adm-doors"]')?.disabled, null, { timeout: 8000 }).catch(() => {});
await D.shot('10-desk-volunteers-map');
const everyDoor = (await D.api('/map/doors')).json.persons.length;
const scoped = (await V.api('/map/doors')).json;
const rings = ((await V.api('/turfs')).json.turfs || []).map((t) => t.polygon);
const inRing = (lat, lng, ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i]; const [yj, xj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const strays = scoped.persons.filter((p) => !rings.some((r) => inRing(p.lat, p.lng, r)) && p.name !== 'Walker Example');
check('Walker’s phone: only doors inside their turfs', scoped.scope === 'turfs' && strays.length === 0 && scoped.persons.length < everyDoor,
  `${scoped.persons.length} of ${everyDoor}, strays: ${strays.map((p) => p.name).join(', ')}`);
await V.go('/map');
await vp.waitForSelector('.leaflet-container', { timeout: 8000 }).catch(() => {});
await V.shot('10-vol-map-turfs-only');
await page.click('fieldset.adm-doors label:has-text("Every door")');
await page.waitForFunction(() => document.querySelector('input[name="adm-doors"][value="all"]')?.checked, null, { timeout: 8000 }).catch(() => {});
check('back to Every door: Walker’s phone has every door again', (await V.api('/map/doors')).json.persons.length === everyDoor);

// ── 6. The books still verify ──
const v = (await D.api('/audit/verify')).json;
check('hash chain verifies after the whole journey', v.ok === true && v.checked > 20, JSON.stringify(v));
const exp = (await D.api('/export')).json;
check('the export carries shift_turfs and shift_turf_walkers', exp.shift_turfs?.length === 2 && Array.isArray(exp.shift_turf_walkers) && exp.shift_turf_walkers.length === 0,
  `${exp.shift_turfs?.length} · ${exp.shift_turf_walkers?.length}`);
check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
