// Path to win E2E — one fresh in-memory campaign. A manager signs up and
// brings in a made-up list (three turfs' doors around Newton, Fleetwood and
// Guildford, some knocked weeks ago, some rated) and logs one knock today.
// Today → More → "Path to win" opens the screen: no election day, no win
// number yet (one primary button: "Set the win number"); everyone on file by
// rating, the 12-week trend (and its table), and the turfs ranked best first
// — on the map (one outline per turf, coloured by priority, rank badges, a
// legend) and in the table, each with its score's parts and reasons, the
// same as the server's. The manager sets the numbers: election day in 10
// weeks; the council worked out from eligible voters × turnout × share
// (the preview says 300 votes → 375 supporters with 80% of supporters
// voting), the school board typed in; a wrong percent is refused in place.
// The race cards then say found of needed, still to find, needed a week,
// found a week — the API's numbers; the chart draws each race's needed
// pace. "How the score works" opens in place. Tapping the top turf (in the
// list, and on the map) opens it on the main map (/map?turf=…). On a phone
// nothing scrolls sideways, there is at most one primary button and every
// tap target is ≥ 48px. A staffer reads it but can't change the numbers; a
// volunteer can't read it. Every claim on screen is checked against the API.
//
//   STARBASE_OPEN_SIGNUP=1 STARBASE_DATA=memory PORT=5610 node server/index.js &
//   BASE=http://127.0.0.1:5610 SHOTS=/tmp/path-to-win node e2e-path-to-win.mjs
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:3200';
const SHOTS = process.env.SHOTS || '/tmp/starbase-path-to-win';
mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 240) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Date.now().toString(36);
const num = (n) => Math.round(Number(n) || 0).toLocaleString('en-CA');

// A plain made-up base map: no tile servers are reached.
const tileSvg = (x, y) => {
  const lines = [];
  for (let i = 0; i <= 256; i += 32) {
    lines.push(`<line x1="${i}" y1="0" x2="${i}" y2="256" stroke="#fff" stroke-width="${((x * 256 + i) / 32) % 4 === 0 ? 5 : 2}"/>`);
    lines.push(`<line x1="0" y1="${i}" x2="256" y2="${i}" stroke="#fff" stroke-width="${((y * 256 + i) / 32) % 4 === 0 ? 5 : 2}"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#ecebe6"/>${lines.join('')}</svg>`;
};
const tiles = (ctx) => ctx.route(/(tile\.openstreetmap\.org|basemaps\.cartocdn\.com)\/.*?(\d+)\/(\d+)\/(\d+)(@2x)?\.png/, (route) => {
  const m = route.request().url().match(/\/(\d+)\/(\d+)\/(\d+)(@2x)?\.png/);
  route.fulfill({ status: 200, contentType: 'image/svg+xml', headers: { 'access-control-allow-origin': '*' }, body: tileSvg(+m[2], +m[3]) });
});

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const errors = [];
const watch = (page, who) => {
  page.on('pageerror', (e) => errors.push(`[${who}] ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && /key|unique|warning/i.test(m.text())) errors.push(`[${who}] ${m.text()}`); });
};
const apiOf = (page) => (path, body) => page.evaluate(async ([p, b]) => {
  const r = await fetch('/api' + p, b === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  return { status: r.status, json: await r.json().catch(() => null) };
}, [path, body]);
const textOf = async (page, sel = 'main.page') => ((await page.innerText(sel).catch(() => '')) || '').replace(/\s+/g, ' ');
// SIMPLE.md: primary buttons, sideways scroll, and tap targets under 48px
// among the screen's own controls.
const measure = (page) => page.evaluate(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'; };
  const root = document.querySelector('.ptw-page') || document.body;
  const yellow = [...document.querySelectorAll('.btn-primary')].filter(vis).length;
  const overflow = document.documentElement.scrollWidth - window.innerWidth;
  // A radio's or a checkbox's target is its whole label.
  const target = (el) => (/^(radio|checkbox)$/.test(el.type) && el.closest('label')) || el;
  const small = [...root.querySelectorAll('button, a.btn, input, select, textarea, .ptw-row__link, .leaflet-bar a, .ops-back')].filter(vis)
    .map((el) => { const r = target(el).getBoundingClientRect(); return { t: (el.innerText || el.getAttribute('aria-label') || el.title || el.tagName).trim().slice(0, 24), h: Math.round(r.height), w: Math.round(r.width) }; })
    .filter((x) => x.h < 48 || x.w < 44);
  return { yellow, overflow, small };
});
const addDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };

// ── 1. A manager signs up; a made-up list comes in ──
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, timezoneId: 'America/Vancouver' });
await tiles(ctx);
const page = await ctx.newPage();
watch(page, 'manager');
const api = apiOf(page);
await page.goto(`${BASE}/signup`, { waitUntil: 'domcontentloaded' });
await page.fill('#su-name', 'Rae Example');
if (await page.locator('#su-org').count()) await page.fill('#su-org', 'Example Campaign');
await page.fill('#su-email', `rae.${tag}@example.org`);
await page.fill('#su-password', 'path-to-win-2026');
await page.click('button[type="submit"]');
await page.waitForURL(/\/admin\/?$/, { timeout: 15000 });

const rect = (lat, lng, dLat, dLng) => [[lat - dLat, lng - dLng], [lat - dLat, lng + dLng], [lat + dLat, lng + dLng], [lat + dLat, lng - dLng]];
const TURFS = {
  newton: { name: 'Newton block', at: [49.1327, -122.855] },
  fleetwood: { name: 'Fleetwood block', at: [49.1585, -122.776] },
  guildford: { name: 'Guildford block', at: [49.1890, -122.800] },
};
for (const t of Object.values(TURFS)) {
  const r = await api('/actions/turf.create', { name: t.name, polygon: rect(t.at[0], t.at[1], 0.003, 0.004) });
  t.id = r.json?.turf?.id;
}
check('three turfs drawn', Object.values(TURFS).every((t) => t.id));
const FIRST = ['Ana', 'Ben', 'Cy', 'Di', 'Ed', 'Flo', 'Gus', 'Hal', 'Ida', 'Jo', 'Kai', 'Lee', 'Mo', 'Nia', 'Oz', 'Pat'];
const rows = [];
// One door each; `knocked` doors came with the list's last knock (weeks ago),
// `ratings` in order from door 1.
const block = (key, street, doors, knocked, ratings, daysAgo) => {
  const [lat, lng] = TURFS[key].at;
  for (let i = 0; i < doors; i += 1) {
    rows.push({
      name: `${FIRST[i % FIRST.length]} Example`, address: `${100 + i * 2} ${street}`, city: 'Surrey',
      lat: lat - 0.0025 + (i % 10) * 0.0005, lng: lng - 0.0035 + Math.floor(i / 10) * 0.0012,
      ...(ratings[i] ? { rating: ratings[i] } : {}),
      ...(i < knocked ? { history: { channel: 'door', outcome: 'contacted', date: daysAgo } } : {}),
    });
  }
};
const status = (await api('/pathtowin')).json;
const today = status.today;
const ago = (n) => addDays(today, -n);
// Newton: 30 doors, 22 knocked 10 days ago — 8 yeses behind them; three undecided and two opposed further on.
block('newton', 'Example St', 30, 22, ['1', '2', '1', '2', '1', '2', '1', '1', null, null, null, null, null, null, null, null, null, null, null, null, null, null, '3', '3', '3', '4', '4'], ago(10));
// Fleetwood: 40 doors, 5 knocked a month ago (2 yeses), six undecided.
block('fleetwood', 'Example Ave', 40, 5, ['1', '2', null, null, null, '3', '3', '3', '3', '3', '3'], ago(30));
// Guildford: 12 doors, never knocked.
block('guildford', 'Example Rd', 12, 0, [], ago(1));
const imp = await api('/data/import', { rows });
check('the list comes in: 82 people', imp.status === 200 && imp.json?.created === 82, JSON.stringify(imp.json).slice(0, 200));
// One knock today, in Guildford: a strong yes.
const guildfordDoor = (await api(`/persons?q=${encodeURIComponent('100 Example Rd')}&limit=5`)).json?.persons?.[0];
const k = await api('/actions/contact.log', { person_id: guildfordDoor?.id, channel: 'door', outcome: 'contacted', rating: '1' });
check('a knock today with a strong yes', k.status === 200, JSON.stringify(k.json).slice(0, 160));

// ── 2. Today → More → Path to win ──
await page.goto(`${BASE}/admin/`, { waitUntil: 'domcontentloaded' });
await page.getByRole('button', { name: 'More', exact: true }).click();
const row = page.getByRole('link', { name: 'Path to win', exact: true });
const moreRows = (await page.locator('.today-morebox__body .today-row__main').allInnerTexts()).map((s) => s.trim());
check('Today → More lists "Path to win" beside Reports', await row.isVisible().catch(() => false)
  && moreRows.join('|').includes('Path to win|Reports'), moreRows.join(' | '));
await row.click();
await page.waitForURL(/\/admin\/path-to-win$/);
await page.locator('.ptw-turfs').waitFor({ timeout: 20000 });
await sleep(800);
const d0 = (await api('/pathtowin?fresh=1')).json;
await page.reload({ waitUntil: 'domcontentloaded' });
await page.locator('.ptw-turfs').first().waitFor({ timeout: 20000 });
await sleep(800);
let t = await textOf(page);
check('no election day, no win number yet: one line each', /No election day yet/.test(t) && /No win number yet/.test(t), t.slice(0, 200));
const primary = page.locator('.btn-primary:visible');
check('one primary button: "Set the win number"', (await primary.count()) === 1 && (await primary.innerText()).trim() === 'Set the win number');
const stand = (await page.locator('.ptw-stand__i').allInnerTexts()).map((s) => s.replace(/\s+/g, ' '));
const s0 = d0.standing;
check('where we stand: the API’s counts', stand[0].startsWith(`${num(s0.supporters)} Supporters ${num(s0.strong)} strong yes · ${num(s0.lean)} lean yes`)
  && stand[1].startsWith(`${num(s0.persuadables)} Persuadables`) && stand[2].startsWith(`${num(s0.opposed)} Opposed`)
  && stand[3].startsWith(`${num(s0.unrated)} Not rated yet of ${num(s0.people)} people`), stand.join(' | '));
check('the counts add up: 11 supporters, 9 persuadables, 2 opposed of 82', s0.supporters === 11 && s0.persuadables === 9 && s0.opposed === 2 && s0.people === 82, JSON.stringify(s0));

// The turfs, best first, as the server ranks them.
const order = d0.turfs.map((x) => x.name);
const listed = (await page.locator('.ptw-turfs tbody th a').allInnerTexts()).map((s) => s.trim());
check('the table ranks the turfs as the server does', JSON.stringify(listed) === JSON.stringify(order), `${listed} vs ${order}`);
const scores = (await page.locator('.ptw-turfs .ptw-score__n').allInnerTexts()).map(Number);
check('scores as the server’s, best first', JSON.stringify(scores) === JSON.stringify(d0.turfs.map((x) => x.score)) && scores.every((v, i) => i === 0 || scores[i - 1] >= v), scores.join(','));
const top = d0.turfs[0];
check('each score is its parts added up', d0.turfs.every((x) => x.score === x.parts.find + x.parts.persuade + x.parts.rest), JSON.stringify(d0.turfs.map((x) => x.parts)));
const firstRow = await textOf(page, '.ptw-turfs tbody tr:first-child');
check('the top turf’s row shows its parts: +find, +persuade, +rest', firstRow.includes(`+${top.parts.find}`) && firstRow.includes(`+${top.parts.persuade}`) && firstRow.includes(`+${top.parts.rest}`), firstRow);
const newton = d0.turfs.find((x) => x.id === TURFS.newton.id);
check('Newton: 30 doors, 22 knocked, its own 36.4 per 100 (8 yeses behind 22 doors)', newton.doors === 30 && newton.knocked === 22 && newton.rate_from === 'turf' && Math.abs(newton.rate - 800 / 22) < 1e-9, JSON.stringify(newton).slice(0, 300));
const fleet = d0.turfs.find((x) => x.id === TURFS.fleetwood.id);
check('Fleetwood: 5 knocked — the turfs’ average stands in, said so', fleet.rate_from === 'campaign' && /your turfs’ average — under 20 knocked here/.test(fleet.reasons[0].text), fleet.reasons[0].text);
const guild = d0.turfs.find((x) => x.id === TURFS.guildford.id);
check('Guildford: knocked today', guild.days_since === 0 && guild.reasons.at(-1).text === 'Knocked today', JSON.stringify(guild.reasons));
// The map: one outline per turf, coloured by priority, ranks on the top ones, a legend.
check('the map draws one outline per turf, by priority', (await page.locator('.ptw-map path.ptw-turf').count()) === 3
  && (await page.locator(`.ptw-map path.ptw-turf--${top.priority}`).count()) >= 1);
check('rank badges on the map', (await page.locator('.ptw-map .ptw-rank').allInnerTexts()).map((s) => s.trim()).sort().join(',') === d0.turfs.filter((x) => x.priority !== 'done').map((x) => String(x.rank)).sort().join(','));
const legend = await textOf(page, '.ptw-legend');
check('a legend: Work next · Soon · Later · Nothing left', /Work next · 60 points or more/.test(legend) && /Soon · 30–59 points/.test(legend) && /Later · under 30 points/.test(legend) && /Nothing left/.test(legend), legend);
// The trend: 12 weeks; the table has them all.
check('the trend’s last 4 weeks, as the API says', (await textOf(page, '.ptw-trend__line')).includes(`+${num(d0.last4)} supporters`), await textOf(page, '.ptw-trend__line'));
await page.getByRole('button', { name: 'Table', exact: true }).click();
const trows = await page.locator('.ptw-trend tbody tr').count();
const lastWeek = await textOf(page, '.ptw-trend tbody tr:first-child');
check('Table: 12 weeks, this week first with the supporters on file now', trows === 12 && lastWeek.includes(num(s0.supporters)), `${trows} rows · ${lastWeek}`);
await page.getByRole('button', { name: 'Chart', exact: true }).click();
await page.getByRole('button', { name: 'How the score works' }).click();
const how = await textOf(page, '.ptw-how__body');
check('"How the score works" opens in place, in plain words', /Up to 60 for supporters still to find/.test(how) && /Up to 30 for persuadables left/.test(how) && /Up to 10 for time since the last knock/.test(how), how.slice(0, 200));
const m1 = await measure(page);
check('desktop: one primary, no sideways scroll, no small targets', m1.yellow === 1 && m1.overflow <= 0 && m1.small.length === 0, JSON.stringify(m1));
await page.screenshot({ path: `${SHOTS}/1-desktop-new.png`, fullPage: false });
await page.locator('section[aria-labelledby="ptw-turfs-h"]').screenshot({ path: `${SHOTS}/1-desktop-turfs.png` });

// ── 3. The manager sets the numbers ──
await page.getByRole('button', { name: 'Set the win number' }).click();
const form = page.locator('form[aria-label="The numbers"]');
await form.waitFor();
check('the form opens with election day first, focused', await page.evaluate(() => document.activeElement?.id === 'ptw-day'));
const day = addDays(today, 70);
await page.fill('#ptw-day', day);
const council = form.locator('fieldset', { hasText: 'City council' });
await council.getByLabel('Work it out').check();
await council.getByLabel('Eligible voters').fill('4,000');
await council.getByLabel('Turnout').fill('30');
await council.getByLabel('Share needed').fill('25');
check('the preview: 4,000 × 30% × 25% = 300 votes → 300 supporters', (await textOf(page, `fieldset:has-text("City council") .ptw-preview`)) === '300 votes needed → 300 supporters to find');
await council.getByLabel('Supporters who vote (optional)').fill('80');
check('…with 80% of supporters voting → 375 supporters', (await textOf(page, `fieldset:has-text("City council") .ptw-preview`)) === '300 votes needed → 375 supporters to find');
const board = form.locator('fieldset', { hasText: 'School board' });
await board.getByLabel('Votes needed to win').fill('200');
// A wrong percent is refused in place, before anything is sent.
await council.getByLabel('Turnout').fill('33.33');
await page.getByRole('button', { name: 'Save' }).click();
await sleep(300);
const err = await textOf(page, `fieldset:has-text("City council")`);
check('a percent with two decimals is refused in place', /Turnout: a percent from 0.1 to 100/.test(err)
  && (await council.getByLabel('Turnout').getAttribute('aria-invalid')) === 'true' && (await api('/pathtowin')).json.races.every((r) => !r.set), err.slice(0, 200));
await council.getByLabel('Turnout').fill('30');
await page.screenshot({ path: `${SHOTS}/2-form.png`, fullPage: false });
await form.screenshot({ path: `${SHOTS}/2-form-whole.png` });
await page.getByRole('button', { name: 'Save' }).click();
await form.waitFor({ state: 'detached', timeout: 10000 });
await page.locator('.ptw-race').first().waitFor();
await sleep(500);
const d1 = (await api('/pathtowin')).json;
const [rc, rb] = d1.races;
check('saved: the council 300 votes → 375 supporters, worked out; the school board 200, typed in',
  rc.set && rc.how === 'worked' && rc.votes === 300 && rc.supporters_needed === 375 && rb.set && rb.how === 'direct' && rb.supporters_needed === 200,
  JSON.stringify(d1.races).slice(0, 300));
check('election day in 10 weeks, set here', d1.election.day === day && d1.election.from === 'here' && d1.election.days_left === 70);
t = await textOf(page);
check('the line under the title: election day and 10 weeks to go', /Election day: .*2[0-9]{3} · 10 weeks to go/.test(t), t.slice(0, 160));
const cards = (await page.locator('.ptw-race').allInnerTexts()).map((s) => s.replace(/\s+/g, ' '));
check('council card: found of needed, still to find, needed a week, found a week', cards[0].includes(`${num(rc.found)} of 375 supporters`)
  && cards[0].includes(`Still to find ${num(rc.still)}`) && cards[0].includes(`Needed a week ${num(rc.per_week_needed)}`)
  && rc.per_week_needed === Math.ceil(((375 - rc.found) * 7) / 70), cards[0]);
check('…and how it was worked out', cards[0].includes('4,000 eligible × 30% turnout × 25% share = 300 votes · 80% of supporters vote → 375 supporters'), cards[0]);
check('school board card: of 200, typed in', cards[1].includes(`${num(rb.found)} of 200 supporters`) && cards[1].includes('200 votes to win, typed in'), cards[1]);
const behind = rc.on_pace === false ? Math.max(1, Math.ceil(rc.per_week_needed - rc.per_week_last4)) : 0;
check('behind says by how many a week (the API’s pace)', behind === 0 || cards[0].includes(`Behind: ${num(behind)} more supporters a week`), cards[0]);
const needLabels = (await page.locator('.ptw-need text').allTextContents()).map((s) => s.trim());
check('the chart draws each race’s needed pace', needLabels.includes(`City council: ${num(rc.per_week_needed)} a week`) && needLabels.includes(`School board: ${num(rb.per_week_needed)} a week`), needLabels.join(' | '));
check('no primary button left over once set', (await page.locator('.btn-primary:visible').count()) === 0);
await page.screenshot({ path: `${SHOTS}/3-desktop-set.png`, fullPage: true });
await page.screenshot({ path: `${SHOTS}/3-desktop-top.png`, fullPage: false });

// ── 4. Tap a turf: the main map opens on it ──
await page.locator('.ptw-turfs tbody tr:first-child th a').click();
await page.waitForURL(/\/admin\/map\?turf=/, { timeout: 10000 });
check('the list’s top turf opens on the main map', new URL(page.url()).searchParams.get('turf') === top.id, page.url());
await page.goBack();
await page.waitForURL(/\/admin\/path-to-win$/);
await page.locator('.ptw-map path.ptw-turf').first().waitFor({ timeout: 15000 });
await sleep(700);
// Its outline on the small map does the same (a corner, clear of the rank badge).
await page.locator('.ptw-map').scrollIntoViewIfNeeded();
await sleep(400);
const box = await page.locator(`.ptw-map path.ptw-turf--${top.priority}`).first().boundingBox();
await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.8);
await page.waitForURL(/\/admin\/map\?turf=/, { timeout: 10000 });
check('tapping its outline on the map opens it too', new URL(page.url()).searchParams.get('turf') === top.id, page.url());
await sleep(1200);
await page.screenshot({ path: `${SHOTS}/4-main-map.png`, fullPage: false });

// ── 5. On a phone ──
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(`${BASE}/admin/path-to-win`, { waitUntil: 'domcontentloaded' });
await page.locator('.ptw-rows').first().waitFor({ timeout: 20000 });
await sleep(1000);
const m2 = await measure(page);
check('phone: no sideways scroll, at most one primary, every tap target ≥ 48px', m2.overflow <= 0 && m2.yellow <= 1 && m2.small.length === 0, JSON.stringify(m2));
check('phone: the turfs are rows (no table)', (await page.locator('.ptw-rows .ptw-row').count()) === 3 && !(await page.locator('.ptw-turfs').isVisible()));
const phoneRow = await textOf(page, '.ptw-rows .ptw-row:first-child');
check('phone row: rank, name, score, priority and its reasons with points', phoneRow.startsWith(`1 ${top.name} ${top.score}`) && top.reasons.every((r) => phoneRow.includes(r.text)), phoneRow);
await page.screenshot({ path: `${SHOTS}/5-phone-top.png`, fullPage: false });
await page.screenshot({ path: `${SHOTS}/5-phone-full.png`, fullPage: true });
await page.locator('section[aria-labelledby="ptw-turfs-h"]').screenshot({ path: `${SHOTS}/5-phone-turfs.png` });
await page.getByRole('button', { name: 'Change the numbers' }).click();
await page.locator('form[aria-label="The numbers"]').waitFor();
await sleep(300);
const m3 = await measure(page);
check('phone, the numbers open: one primary (Save), no sideways scroll, targets ≥ 48px', m3.yellow === 1 && m3.overflow <= 0 && m3.small.length === 0, JSON.stringify(m3));
await page.getByRole('button', { name: 'Cancel' }).click();
// Count again: the counts are made now.
const before = (await api('/pathtowin')).json.computed_at;
await page.getByRole('button', { name: 'Count again' }).click();
await sleep(1200);
const after = (await api('/pathtowin')).json.computed_at;
check('"Count again" counts now', after && after !== before && /Counted at/.test(await textOf(page, '.ptw-counted')), `${before} → ${after}`);

// ── 6. A staffer reads it; a volunteer doesn't ──
const invite = async (role, email) => (await api('/actions/member.invite', { email, role })).json?.joinUrl;
const joinAs = async (url, name) => {
  const c = await browser.newContext({ viewport: { width: 1360, height: 900 }, timezoneId: 'America/Vancouver' });
  await tiles(c);
  const p = await c.newPage();
  watch(p, name);
  await p.goto(url, { waitUntil: 'domcontentloaded' });
  await p.fill('input[autocomplete="name"], #join-name', name).catch(() => {});
  await p.fill('input[type="password"]', 'path-to-win-2026');
  await p.click('button[type="submit"]');
  await sleep(2000);
  return { c, p };
};
const staff = await joinAs(await invite('staff', `sam.${tag}@example.org`), 'Sam Example');
await staff.p.goto(`${BASE}/admin/path-to-win`, { waitUntil: 'domcontentloaded' });
await staff.p.locator('.ptw-race').first().waitFor({ timeout: 20000 });
const st = await textOf(staff.p);
check('staff: the same numbers, "A manager changes these.", no way to change them', /A manager changes these\./.test(st)
  && (await staff.p.getByRole('button', { name: 'Change the numbers' }).count()) === 0 && st.includes(`of 375 supporters`), st.slice(0, 160));
const sapi = apiOf(staff.p);
check('staff: the server refuses their save', (await sapi('/actions/pathtowin.save', { races: { council: { how: 'direct', votes: 5 } } })).status === 403);
const vol = await joinAs(await invite('volunteer', `vic.${tag}@example.org`), 'Vic Example');
const vapi = apiOf(vol.p);
check('volunteer: the server refuses the read', (await vapi('/pathtowin')).status === 403);
await vol.p.goto(`${BASE}/admin/path-to-win`, { waitUntil: 'domcontentloaded' });
await sleep(1500);
check('volunteer: the admin is not theirs', /Not for your role/.test(await textOf(vol.p, 'body')));
await staff.c.close();
await vol.c.close();

// A turf's name is shown as words, never run as code (the map's tooltip is HTML).
await page.setViewportSize({ width: 1360, height: 900 });
const odd = await api('/actions/turf.create', { name: '<img src=x onerror="window.__ptwXss=1"> block', polygon: rect(49.10, -122.70, 0.002, 0.003) });
await page.goto(`${BASE}/admin/path-to-win`, { waitUntil: 'domcontentloaded' });
await page.locator('.ptw-map path.ptw-turf--done').waitFor({ timeout: 20000 });
await page.locator('.ptw-map').scrollIntoViewIfNeeded();
await sleep(500);
const oddBox = await page.locator('.ptw-map path.ptw-turf--done').boundingBox();
await page.mouse.move(oddBox.x + oddBox.width / 2, oddBox.y + oddBox.height / 2);
await sleep(400);
const tip = await page.locator('.leaflet-tooltip').innerText().catch(() => '');
check('a turf named like code shows as words on the map, nothing runs', odd.status === 200 && tip.includes('<img src=x') && !(await page.evaluate(() => window.__ptwXss)), tip);

const books = (await api('/audit/verify')).json;
check('the books verify', books?.ok === true, JSON.stringify(books));
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
