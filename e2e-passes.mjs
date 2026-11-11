// Passes E2E — one fresh in-memory campaign: a manager seeds a turf of four
// doors through the API (one knocked already); Turfs says "Pass: none ›";
// /passes starts "Persuasion · test" (2 tries) from the one yellow button
// and every turf's doors come back; a volunteer on a 390×844 phone: Today
// names the pass beside the doors left; on the walk list a No answer keeps
// the door in the count with an amber "Try again · 1 of 2" chip and Next
// door moves on to a door not knocked yet; Show → Try again lists it alone;
// a second No answer finishes it (the count drops); a talk finishes a door
// at once; the desk's card counts doors knocked · talked · yes and ends the
// pass (asks in place), after which every knocked door is done the old way;
// a get-out-the-vote pass for supporters turns Today's button to "Get out
// the vote →" and lists only the supporters' doors. Every claim on a screen
// is checked against the API; each new screen is measured (yellow buttons,
// sideways scroll, 48px targets).
//
//   STARBASE_OPEN_SIGNUP=1 STARBASE_DATA=memory PORT=4410 node server/index.js &
//   BASE=http://127.0.0.1:4410 SHOTS=/tmp/passes node e2e-passes.mjs
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:3200';
const ADMIN = { toString() { return `${BASE}/admin`; } }; // the desk's pages live in the admin (web/src/mode.js)
const SHOTS = process.env.SHOTS || '/tmp/starbase-passes';
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
const month = new Date().toLocaleDateString('en-CA', { month: 'long', timeZone: 'America/Vancouver' });

// ── 1. A manager, a turf of four doors (555-01xx phones), one knocked already ──
const dctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, timezoneId: 'America/Vancouver' });
await tiles(dctx);
const page = await dctx.newPage();
const D = helpers(page, 'manager');
await D.go('/signup');
await page.fill('#su-name', 'Priya Manager');
if (await page.locator('#su-org').count()) await page.fill('#su-org', 'Imagine Surrey');
await page.fill('#su-email', `priya+${tag}@passes.example`);
await page.fill('#su-password', 'surrey-forward-2026');
await page.click('button[type="submit"]');
await page.waitForURL(/\/admin\/?$/, { timeout: 15000 });
const lat = 49.1327; const lng = -122.855;
const P = {};
const mk = async (key, name, phone, address, dLng) => { P[key] = (await D.api('/actions/person.create', { name, phone, address, city: 'Surrey', lat, lng: lng + dLng })).json.person; };
await mk('ana', 'Ana Example', '604-555-0141', '13213 72 Ave', 0);
await mk('ben', 'Ben Example', '604-555-0142', '13225 72 Ave', 0.0003);
await mk('cy', 'Cy Example', '604-555-0143', '13224 72 Ave', 0.0003);
await mk('dee', 'Dee Example', '604-555-0144', '13212 72 Ave', 0);
const turf = (await D.api('/actions/turf.create', {
  name: 'Newton block', polygon: [[lat + 0.001, lng - 0.001], [lat + 0.001, lng + 0.002], [lat - 0.001, lng + 0.002], [lat - 0.001, lng - 0.001]],
})).json.turf;
const knocked = await D.api('/actions/contact.log', { person_id: P.ana.id, channel: 'door', outcome: 'contacted', rating: '1' });
check('seeded 4 doors, a turf, and a knock on Ana from before any pass', Object.values(P).every((p) => p?.id) && turf?.id && knocked.status === 200);
const walkApi = async (H = D) => (await H.api(`/turfs/${turf.id}/walk`)).json;
const turfApi = async (H = D) => (await H.api('/turfs')).json;

// ── 2. Turfs → "Pass: none ›" → /passes: start one ──
await D.go('/turfs');
await page.waitForSelector('.pass-chip', { timeout: 8000 }).catch(() => {});
const chip0 = (await page.innerText('.pass-chip').catch(() => '')).replace(/\s+/g, ' ').trim();
const row0 = (await page.innerText('.turfs-row__left').catch(() => '')).replace(/\s+/g, ' ').trim();
check('Turfs: the chip says "Pass: none ›"; the turf says "3 doors left" (Ana’s door done the old way)', chip0 === 'Pass: none ›' && row0 === '3 doors left', `${chip0} · ${row0}`);
check('…and the API agrees: no pass, doorsDone 1, doorsAgain 0', (await turfApi()).pass === null && (await turfApi()).turfs[0].doorsDone === 1 && (await turfApi()).turfs[0].doorsAgain === 0);
await page.click('.pass-chip');
await page.waitForURL(`${ADMIN}/passes`, { timeout: 8000 });
await sleep(700);
let m = await measure(page);
let t = await D.text();
check('/passes, empty: the title, "No pass yet…", one yellow "Start a pass"', /Passes/.test(t) && /No pass yet\. A pass is a sweep over every turf: who to knock, and how many tries before a door is left\./.test(t)
  && m.yellow === 1 && /Start a pass/.test(await page.innerText('.btn-primary')), JSON.stringify(m));
console.log(`      words on /passes (empty): ${m.words}`);
await D.shot('01-passes-empty');
await page.click('.ops-head button:has-text("Start a pass")');
await page.waitForSelector('form[aria-label="Start a pass"]', { timeout: 5000 });
const form = 'form[aria-label="Start a pass"]';
const suggested = await page.inputValue(`${form} input`);
check(`the name is suggested from the kind and the month: "Persuasion · ${month}"`, suggested === `Persuasion · ${month}`, suggested);
const kinds = await page.$$eval(`${form} .sv-kind`, (els) => els.map((e) => e.innerText.trim()));
check('What for · Who · Tries, in the rule’s words', kinds.join('|') === 'Persuasion|Get out the vote|Lit drop|Find out who’s who|All doors|Not rated yet|Undecided or not rated|Yes (1–2)|Everyone but opposed|1|2|3|4|5', kinds.join('|'));
const pressed = await page.$$eval(`${form} .sv-kind[aria-pressed="true"]`, (els) => els.map((e) => e.innerText.trim()));
check('defaults: Persuasion · All doors · 2 tries', pressed.join('|') === 'Persuasion|All doors|2', pressed.join('|'));
m = await measure(page, `${form} .sv-kind, ${form} .input, ${form} .btn`);
check('the form: one yellow "Start the pass", targets ≥ 48px, the line under it', m.yellow === 1 && m.minTap >= 48 && /Start the pass/.test(await page.innerText('.btn-primary'))
  && /Doors left on every turf will change when the pass starts\./.test(await D.text()), JSON.stringify(m));
await D.shot('02-start-form');
await page.fill(`${form} input`, 'Persuasion · test');
await page.click(`${form} button[type="submit"]`);
await page.waitForSelector('.pass-open', { timeout: 8000 });
await sleep(500);
const openCard = (await page.innerText('.pass-open')).replace(/\s+/g, ' ');
const passes1 = (await D.api('/passes')).json;
check('the open pass card: its name, "Persuasion · All doors · 2 tries", started today, 0 doors knocked · 0 talked · 0 yes',
  /Persuasion · test/.test(openCard) && /Persuasion · All doors · 2 tries/.test(openCard) && /started /.test(openCard) && /0 doors knocked · 0 talked · 0 yes/.test(openCard), openCard);
check('…and the server has it open, with those numbers', passes1.open?.name === 'Persuasion · test' && passes1.open.kind === 'persuasion' && passes1.open.tries === 2
  && JSON.stringify(passes1.open.stats) === JSON.stringify({ doors_knocked: 0, talked: 0, support_found: 0 }) && passes1.past.length === 0, JSON.stringify(passes1));
m = await measure(page, '.pass-page .btn');
check('/passes with a pass open: one yellow (Start a pass), "End this pass" is not yellow, targets ≥ 48px', m.yellow === 1 && m.minTap >= 48
  && !(await page.$('.pass-open .btn-primary')), JSON.stringify(m));
await D.shot('03-pass-open');
await D.go('/turfs');
await page.waitForSelector('.pass-chip', { timeout: 8000 }).catch(() => {});
const chip1 = (await page.innerText('.pass-chip')).replace(/\s+/g, ' ').trim();
const row1 = (await page.innerText('.turfs-row__left')).replace(/\s+/g, ' ').trim();
check('Turfs: "Pass: Persuasion · test ›", and the turf is back to "4 doors left"', chip1 === 'Pass: Persuasion · test ›' && row1 === '4 doors left', `${chip1} · ${row1}`);
const w0 = await walkApi();
check('the walk list API: every door open in this pass, Ana’s too; pass carried', w0.pass?.name === 'Persuasion · test' && w0.doors.length === 4 && w0.doors.every((d) => d.state === 'open' && d.done === false && d.tries === 0) && w0.stats.doorsDone === 0, JSON.stringify(w0.doors.map((d) => d.state)));

// ── 3. A volunteer on a phone: Today ──
const invite = (await D.api('/actions/member.invite', { email: `jas+${tag}@passes.example`, role: 'volunteer' })).json;
const vctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/Vancouver' });
await tiles(vctx);
const vpage = await vctx.newPage();
const V = helpers(vpage, 'vol');
await V.go('/login');
const joined = await V.api('/auth/join', { token: invite.joinUrl.split('/').pop(), name: 'Jas Volunteer', password: 'knock-knock-2026' });
check('volunteer joined', joined.status === 200 && joined.json.role === 'volunteer', joined.status);
const volId = (await V.api('/auth/me')).json.user.id;
check('the turf is theirs', (await D.api('/actions/turf.assign', { turf_id: turf.id, user_id: volId })).status === 200);
const vPasses = (await V.api('/passes')).json;
check('a volunteer reads the open pass only (no past passes)', vPasses.open?.id === passes1.open.id && Array.isArray(vPasses.past) && vPasses.past.length === 0, JSON.stringify(vPasses));
check('…and may not start or end one', (await V.api('/actions/pass.end', { id: passes1.open.id })).status === 403 && (await V.api('/actions/pass.start', { name: 'x', kind: 'persuasion' })).status === 403);
await V.go('/');
await vpage.waitForSelector('.today-start', { timeout: 8000 });
await sleep(900);
let meta = ((await vpage.innerText('.today-go__meta').catch(() => '')) || '').replace(/\s+/g, ' ').trim();
let startBtn = ((await vpage.innerText('.today-start').catch(() => '')) || '').replace(/\s+/g, ' ').trim();
check('Today: "Start canvassing →", then "Newton block · Persuasion · test · 4 doors left" (nothing to try again yet)',
  startBtn === 'Start canvassing →' && /Newton block/.test(meta) && /Persuasion · test/.test(meta) && /4 doors left/.test(meta) && !/to try again/.test(meta), `${startBtn} · ${meta}`);
const brief = (await V.api('/brief')).json;
check('the brief carries the pass (kept on the phone with it)', brief.pass?.id === passes1.open.id && brief.pass.kind === 'persuasion', JSON.stringify(brief.pass));
m = await measure(vpage);
check('Today at 390: no sideways scroll, one yellow', m.overflow <= 0 && m.yellow === 1, JSON.stringify(m));
await V.shot('04-today-phone');

// ── 4. The walk list: No answer → Try again · 1 of 2; Show; the second No answer; a talk ──
await vpage.click('.today-start');
await vpage.waitForURL(`${BASE}/turfs/${turf.id}`, { timeout: 8000 });
await vpage.waitForSelector('.walk-door', { timeout: 8000 });
await sleep(700);
const progress = () => vpage.innerText('.walk-progress__text').then((s) => s.replace(/\s+/g, ' ').trim()).catch(() => '');
const pills = () => vpage.$$eval('.pass-show__pill', (els) => els.map((e) => `${e.innerText.trim()}${e.getAttribute('aria-pressed') === 'true' ? '*' : ''}`));
// The door's "Try again · 1 of 2" chip (a rating chip may sit beside it), or ''.
const againChip = (i) => vpage.innerText(`#walk-door-${i} .walk-door__chips .pass-again`).then((s) => s.replace(/\s+/g, ' ').trim()).catch(() => '');
const openDoor = () => vpage.$eval('.walk-door.is-open', (el) => el.id).catch(() => null);
const nextBtn = () => vpage.innerText('.walk-head .walk-next__btn').then((s) => s.replace(/\s+/g, ' ').trim()).catch(() => '');
check('walk list: "4 doors left", Show · All* · Not knocked (4) · Try again (0), Next door is Ana’s (odd side up)',
  (await progress()) === '4 doors left' && (await pills()).join('|') === 'All*|Not knocked (4)|Try again (0)' && /^Next door 13213 72 Ave$/.test(await nextBtn()),
  `${await progress()} · ${(await pills()).join('|')} · ${await nextBtn()}`);
m = await measure(vpage, '.pass-show__pill, .walk-door__head, .walk-next__btn');
check('walk list at 390: one yellow (Next door), no sideways scroll, pills and rows ≥ 48px', m.yellow === 1 && m.overflow <= 0 && m.minTap >= 48, JSON.stringify(m));
console.log(`      words on the walk list: ${m.words}`);
await V.shot('05-walk-list');
await vpage.click('#walk-door-0 .walk-door__head');
await vpage.waitForSelector('#walk-panel-0', { timeout: 5000 });
await vpage.click('#walk-panel-0 .fk-out:has-text("No answer")');
await vpage.waitForSelector('.walk-toast', { timeout: 5000 }).catch(() => {});
const toast1 = ((await vpage.innerText('.walk-toast').catch(() => '')) || '').replace(/\s+/g, ' ').trim();
await sleep(1200);
let w1 = await walkApi(V);
check('No answer at Ana’s: the toast says "No answer", the row says "Try again · 1 of 2", the count holds: "4 doors left · 1 to try again"',
  /^No answer/.test(toast1) && (await againChip(0)) === 'Try again · 1 of 2' && (await progress()) === '4 doors left · 1 to try again', `${toast1} · ${await againChip(0)} · ${await progress()}`);
check('…the server: state again, 1 try, doorsAgain 1, doors left unchanged', w1.doors[0].state === 'again' && w1.doors[0].tries === 1 && w1.doors[0].done === false
  && w1.stats.doorsAgain === 1 && w1.stats.doors - w1.stats.doorsDone === 4 && w1.doors[0].persons[0].pass_last_outcome === 'no_answer', JSON.stringify(w1.stats));
check('…Next door moved on to a door not knocked yet (Ben’s), and the pills count it: Not knocked (3) · Try again (1)',
  (await openDoor()) === 'walk-door-1' && (await pills()).join('|') === 'All*|Not knocked (3)|Try again (1)', `${await openDoor()} · ${(await pills()).join('|')}`);
check('the knock carries the pass (contacts.pass_id)', (await D.api('/passes')).json.open.stats.doors_knocked === 1);
await V.shot('06-try-again-chip');
await vpage.click('.pass-show__pill:has-text("Try again")');
await sleep(300);
const shown = await vpage.$$eval('.walk-door', (els) => els.map((e) => e.querySelector('.walk-door__addr').innerText.trim()));
check('Show → Try again lists that door alone', shown.join('|') === '13213 72 Ave' && (await pills()).join('|') === 'All|Not knocked (3)|Try again (1)*', shown.join('|'));
m = await measure(vpage);
check('…no sideways scroll, ≤ 1 yellow', m.overflow <= 0 && m.yellow <= 1, JSON.stringify(m));
await V.shot('07-show-try-again');
await vpage.click('.pass-show__pill:has-text("All")');
await sleep(300);
check('Show → All brings every door back', (await vpage.$$('.walk-door')).length === 4);
// The second No answer gives the door up.
await vpage.click('#walk-door-0 .walk-door__head');
await vpage.waitForSelector('#walk-panel-0', { timeout: 5000 });
await vpage.click('#walk-panel-0 .fk-out:has-text("No answer")');
await sleep(1500);
w1 = await walkApi(V);
check('a second No answer: the door is done — ticked, no chip, "3 doors left" and nothing to try again',
  !!(await vpage.$('#walk-door-0.is-done .walk-check[data-done]')) && (await againChip(0)) === '' && (await progress()) === '3 doors left'
  && w1.doors[0].state === 'done' && w1.doors[0].tries === 2 && w1.stats.doorsAgain === 0, `${await againChip(0)} · ${await progress()} · ${w1.doors[0].state}`);
check('…Next door opened Ben’s (not knocked) again', (await openDoor()) === 'walk-door-1', await openDoor());
// A talk finishes a door at once: rate Ben 2.
await vpage.click('#walk-panel-1 button[aria-label="2: Lean support"]');
await sleep(1500);
w1 = await walkApi(V);
check('a talk (rated 2) finishes Ben’s door on the first try: "2 doors left"', (await progress()) === '2 doors left' && !!(await vpage.$('#walk-door-1.is-done'))
  && w1.doors[1].state === 'done' && w1.doors[1].tries === 1 && w1.stats.doorsDone === 2, `${await progress()} · ${w1.doors[1].state}`);
await vpage.click('.walk-head .fk-more__btn');
await sleep(300);
const info = ((await vpage.innerText('#walk-info').catch(() => '')) || '').replace(/\s+/g, ' ');
check('the header’s More names the pass', /Pass Persuasion · test/i.test(info), info);
m = await measure(vpage);
check('walk list after the knocks at 390: no sideways scroll, ≤ 1 yellow', m.overflow <= 0 && m.yellow <= 1, JSON.stringify(m));
await V.shot('08-walk-after-knocks');

// ── 5. The desk: the numbers, End this pass ──
await D.go('/passes');
await page.waitForSelector('.pass-open', { timeout: 8000 });
const stats2 = (await page.innerText('.pass-open__stats')).replace(/\s+/g, ' ').trim();
const passes2 = (await D.api('/passes')).json;
check('the card counts the team’s work: "2 doors knocked · 1 talked · 1 yes" — the server’s numbers', stats2 === '2 doors knocked · 1 talked · 1 yes'
  && JSON.stringify(passes2.open.stats) === JSON.stringify({ doors_knocked: 2, talked: 1, support_found: 1 }), `${stats2} · ${JSON.stringify(passes2.open.stats)}`);
await page.click('.pass-open button:has-text("End this pass")');
await sleep(200);
t = await D.text();
check('End this pass asks in place: "End this pass? Until the next one, a door counts as done once anyone there has been knocked." Yes · No', /End this pass\? Until the next one, a door counts as done once anyone there has been knocked\./.test(t)
  && !!(await page.$('.pass-open .ops-confirm button:has-text("Yes")')) && !!(await page.$('.pass-open .ops-confirm button:has-text("No")')));
await page.click('.pass-open .ops-confirm button:has-text("No")');
check('No keeps it open', !!(await page.$('.pass-open button:has-text("End this pass")')) && !(await page.$('.pass-open .ops-confirm')));
await page.click('.pass-open button:has-text("End this pass")');
await page.click('.pass-open .ops-confirm button:has-text("Yes")');
await sleep(900);
t = await D.text();
const passes3 = (await D.api('/passes')).json;
const pastRow = ((await page.innerText('section[aria-label="Past passes"] .ops-row').catch(() => '')) || '').replace(/\s+/g, ' ').trim();
check('ended: "✓ Ended …", no open card, the pass under Past passes with its line, dates and "2 doors knocked · 1 talked"',
  /✓ Ended “Persuasion · test”/.test(t) && !(await page.$('.pass-open')) && /Persuasion · test/.test(pastRow) && /Persuasion · All doors · 2 tries/.test(pastRow) && /2 doors knocked · 1 talked/.test(pastRow),
  `${pastRow} · ${t.slice(0, 120)}`);
check('…the server: open null, the pass past with ended_at and its stats', passes3.open === null && passes3.past.length === 1 && passes3.past[0].name === 'Persuasion · test' && !!passes3.past[0].ended_at
  && passes3.past[0].stats.doors_knocked === 2, JSON.stringify(passes3.past));
m = await measure(page);
check('/passes after the end: one yellow (Start a pass), no sideways scroll', m.yellow === 1 && m.overflow <= 0, JSON.stringify(m));
await D.full('09-pass-ended');
await D.go('/turfs');
await page.waitForSelector('.pass-chip', { timeout: 8000 }).catch(() => {});
const chip3 = (await page.innerText('.pass-chip')).replace(/\s+/g, ' ').trim();
const row3 = (await page.innerText('.turfs-row__left')).replace(/\s+/g, ' ').trim();
const w3 = await walkApi();
check('no pass: "Pass: none ›"; the old rule is back — Ana’s and Ben’s doors done, "2 doors left"', chip3 === 'Pass: none ›' && row3 === '2 doors left'
  && w3.pass === null && w3.doors.map((d) => d.state).join('|') === 'done|done|open|open', `${chip3} · ${row3} · ${w3.doors.map((d) => d.state).join('|')}`);
await V.go('/');
await vpage.waitForSelector('.today-start', { timeout: 8000 });
await sleep(900);
meta = ((await vpage.innerText('.today-go__meta').catch(() => '')) || '').replace(/\s+/g, ' ').trim();
check('Today, no pass: "Newton block · 2 doors left", no pass name', /Newton block/.test(meta) && /2 doors left/.test(meta) && !/Persuasion/.test(meta), meta);

// ── 6. Get out the vote: supporters only, Today’s button changes ──
await D.go('/passes');
await page.click('.ops-head button:has-text("Start a pass")');
await page.waitForSelector(form, { timeout: 5000 });
await page.click(`${form} .sv-kind:has-text("Get out the vote")`);
const suggested2 = await page.inputValue(`${form} input`);
check(`picking a kind re-suggests the name: "Get out the vote · ${month}"`, suggested2 === `Get out the vote · ${month}`, suggested2);
await page.click(`${form} .sv-kind:has-text("Yes (1–2)")`);
await page.click(`${form} .sv-kind:text-is("3")`);
await page.fill(`${form} input`, 'GOTV · test');
await page.click(`${form} button[type="submit"]`);
await page.waitForSelector('.pass-open', { timeout: 8000 });
const gotvCard = (await page.innerText('.pass-open')).replace(/\s+/g, ' ');
const passes4 = (await D.api('/passes')).json;
check('a GOTV pass for supporters, 3 tries: the card and the server', /GOTV · test/.test(gotvCard) && /Get out the vote · Yes \(1–2\) · 3 tries/.test(gotvCard)
  && passes4.open?.kind === 'gotv' && passes4.open.who === 'support' && passes4.open.tries === 3 && passes4.past.length === 1, gotvCard);
await V.go('/');
await vpage.waitForSelector('.today-start', { timeout: 8000 });
await sleep(900);
startBtn = ((await vpage.innerText('.today-start').catch(() => '')) || '').replace(/\s+/g, ' ').trim();
meta = ((await vpage.innerText('.today-go__meta').catch(() => '')) || '').replace(/\s+/g, ' ').trim();
check('Today: the yellow button reads "Get out the vote →"; "Newton block · GOTV · test · 2 doors left" (the two supporters’ doors)',
  startBtn === 'Get out the vote →' && /GOTV · test/.test(meta) && /2 doors left/.test(meta), `${startBtn} · ${meta}`);
await V.shot('10-today-gotv');
await vpage.click('.today-start');
await vpage.waitForURL(`${BASE}/turfs/${turf.id}`, { timeout: 8000 });
await vpage.waitForSelector('.walk-door', { timeout: 8000 });
await sleep(700);
const gotvRows = await vpage.$$eval('.walk-door', (els) => els.map((e) => e.querySelector('.walk-door__addr').innerText.trim()));
const w4 = await walkApi(V);
check('the walk list lists only Ana’s and Ben’s doors, both to knock again in this pass', gotvRows.join('|') === '13213 72 Ave|13225 72 Ave' && (await progress()) === '2 doors left'
  && w4.doors.length === 2 && w4.doors.every((d) => d.state === 'open') && (await pills()).join('|') === 'All*|Not knocked (2)|Try again (0)', `${gotvRows.join('|')} · ${await progress()}`);
m = await measure(vpage, '.pass-show__pill, .walk-door__head, .walk-next__btn');
check('GOTV walk list at 390: one yellow, no sideways scroll, targets ≥ 48px', m.yellow === 1 && m.overflow <= 0 && m.minTap >= 48, JSON.stringify(m));
await V.shot('11-walk-gotv');

// ── 6b. Election day + GOTV: a Voted tap with no signal counts the door done at once ──
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' });
check('Election day on (a manager’s switch)', (await D.api('/actions/vote.settings', { on: true, election_day: today })).status === 200);
await V.go(`/turfs/${turf.id}`);
await vpage.waitForSelector('#walk-door-0 .walk-door__head', { timeout: 8000 });
await sleep(700);
if ((await openDoor()) !== 'walk-door-0') await vpage.tap('#walk-door-0 .walk-door__head').catch(() => vpage.click('#walk-door-0 .walk-door__head'));
await vpage.waitForSelector('#walk-door-0.is-open .vt-btn', { timeout: 8000 }).catch(() => {});
await vctx.setOffline(true);
await vpage.evaluate(() => window.dispatchEvent(new Event('offline')));
await sleep(300);
await vpage.tap('#walk-door-0.is-open .vt-btn').catch(() => vpage.click('#walk-door-0.is-open .vt-btn'));
await sleep(700);
check('offline, Ana votes: her door reads done at once and "1 door left" — the tap is still on the phone',
  !!(await vpage.$('#walk-door-0.is-done')) && (await progress()) === '1 door left' && (await walkApi(V).catch(() => null)) == null,
  `${await progress()}`);
await vctx.setOffline(false);
await vpage.evaluate(() => window.dispatchEvent(new Event('online')));
let w5 = null;
for (let i = 0; i < 30; i += 1) { w5 = await walkApi(V).catch(() => null); if (w5 && w5.doors.length === 1) break; await sleep(300); }
check('back online, sent: the server lists only Ben’s door', w5?.doors.length === 1 && w5.doors[0].address === '13225 72 Ave', JSON.stringify(w5?.doors?.map((d) => d.address)));
await V.go(`/turfs/${turf.id}`);
await vpage.waitForSelector('.walk-door', { timeout: 8000 });
await sleep(700);
const gotvRows2 = await vpage.$$eval('.walk-door', (els) => els.map((e) => e.querySelector('.walk-door__addr').innerText.trim()));
check('the reloaded walk list: Ben’s door, "1 door left"', gotvRows2.join('|') === '13225 72 Ave' && (await progress()) === '1 door left', `${gotvRows2.join('|')} · ${await progress()}`);
await D.api('/actions/vote.settings', { on: false, election_day: today });

// ── 7. /passes on a phone, and the books ──
const pm = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/Vancouver' });
await pm.addCookies((await dctx.cookies()).map((c) => ({ ...c })));
const mpage = await pm.newPage();
const MP = helpers(mpage, 'manager-phone');
await MP.go('/passes');
await mpage.waitForSelector('.pass-open', { timeout: 8000 });
m = await measure(mpage, '.pass-page .btn');
check('/passes at 390: one yellow, no sideways scroll, targets ≥ 48px', m.yellow === 1 && m.overflow <= 0 && m.minTap >= 48, JSON.stringify(m));
console.log(`      words on /passes at 390: ${m.words}`);
await mpage.click('.ops-head button:has-text("Start a pass")');
await mpage.waitForSelector(form, { timeout: 5000 });
m = await measure(mpage, `${form} .sv-kind, ${form} .input, ${form} .btn`);
check('the form at 390: one yellow, no sideways scroll, targets ≥ 48px', m.yellow === 1 && m.overflow <= 0 && m.minTap >= 48, JSON.stringify(m));
await MP.full('12-passes-phone');
check('a volunteer typing /passes lands on Today', await (async () => { await V.go('/passes'); return new URL(vpage.url()).pathname === '/'; })(), vpage.url());
const exp = (await D.api('/export')).json;
check('the export carries the passes, and the knocks their pass', exp.canvass_passes?.length === 2 && exp.contacts.filter((c) => c.pass_id).length === 3, `${exp.canvass_passes?.length} · ${exp.contacts.filter((c) => c.pass_id).length}`);
const v = (await D.api('/audit/verify')).json;
check('hash chain verifies after the whole journey', v.ok === true && v.checked > 10, JSON.stringify(v));

// ── 8. After the books: the open door stays under Show; offline tries add up ──
const eve = (await D.api('/actions/person.create', { name: 'Eve Example', phone: '604-555-0145', address: '13212 72 Ave', city: 'Surrey', lat, lng })).json.person;
const again = (await D.api('/actions/pass.start', { name: 'Persuasion · again', kind: 'persuasion', who: 'all', tries: 2 })).json.pass;
check('a second persuasion pass, and Eve at Dee’s door (two people there)', !!eve?.id && !!again?.id);
await V.go(`/turfs/${turf.id}`);
await vpage.waitForSelector('.walk-door', { timeout: 8000 });
await sleep(700);
const order = (await walkApi(V)).doors.map((d) => d.address);
const deeI = order.indexOf('13212 72 Ave');
const cyI = order.indexOf('13224 72 Ave');
await vpage.click('.pass-show__pill:has-text("Not knocked")');
await sleep(300);
await vpage.click(`#walk-door-${deeI} .walk-door__head`);
await vpage.waitForSelector(`#walk-panel-${deeI}`, { timeout: 5000 });
await vpage.click(`#walk-panel-${deeI} button[aria-label="2: Lean support"]`);
await sleep(1500);
check('Show → Not knocked, a talk with one of two at a door: the door is done, and stays open on the list for the housemate',
  !!(await vpage.$(`#walk-door-${deeI}.is-open #walk-panel-${deeI}`)) && (await walkApi(V)).doors[deeI].state === 'done',
  `${await openDoor()} · ${order.join('|')}`);
await vpage.click('.pass-show__pill:has-text("All")');
await sleep(300);
await vctx.setOffline(true);
await vpage.evaluate(() => window.dispatchEvent(new Event('offline')));
await sleep(300);
for (let n = 0; n < 2; n += 1) {
  if ((await openDoor()) !== `walk-door-${cyI}`) await vpage.click(`#walk-door-${cyI} .walk-door__head`);
  await vpage.waitForSelector(`#walk-panel-${cyI}`, { timeout: 5000 });
  await vpage.click(`#walk-panel-${cyI} .fk-out:has-text("No answer")`);
  await sleep(700);
}
check('offline, two No answers at Cy’s (2 tries): the door is given up on the phone, no "Try again" chip',
  !!(await vpage.$(`#walk-door-${cyI}.is-done`)) && (await againChip(cyI)) === '', `${await againChip(cyI)} · ${await progress()}`);
await vctx.setOffline(false);
await vpage.evaluate(() => window.dispatchEvent(new Event('online')));
let wc = null;
for (let i = 0; i < 30; i += 1) { wc = await walkApi(V).catch(() => null); if (wc?.doors?.[cyI]?.tries === 2) break; await sleep(300); }
await sleep(800);
check('back online: the server agrees (2 tries, done), and the phone still reads done, not "Try again · 3 of 2"',
  wc?.doors[cyI].state === 'done' && wc.doors[cyI].tries === 2 && !!(await vpage.$(`#walk-door-${cyI}.is-done`)) && (await againChip(cyI)) === '',
  `${wc?.doors[cyI].state} · ${wc?.doors[cyI].tries} · ${await againChip(cyI)}`);
await D.api('/actions/pass.end', { id: again.id });

// ── 9. Walk this list: a list's Walk opens the pass form with it picked ──
// Ben's and Dee's doors have someone on the list; Eve (at Dee's door) and the others don't.
for (const p of [P.ben, P.dee]) await D.api('/actions/person.update', { id: p.id, tags: ['walk-list'] });
const walkList = (await D.api('/actions/list.create', { name: 'Walk these doors', kind: 'filter', filter: { tag: 'walk-list' } })).json.list;
check('a list of the people to walk: Ben and Dee', !!walkList?.id && (await D.api(`/lists/${walkList.id}`)).json.total === 2);
await D.go('/lists');
const walkRow = page.locator('.ops-item', { has: page.locator('.au-row__name', { hasText: 'Walk these doors' }) });
await walkRow.locator('.au-go a:has-text("Walk")').waitFor({ timeout: 8000 });
await walkRow.locator('.au-go a:has-text("Walk")').click();
await page.waitForSelector(form, { timeout: 8000 });
const picked = await page.inputValue(`${form} select`).catch(() => '');
t = await D.text();
check('Lists → Walk: the pass form opens with the list picked, and says only its doors are walked',
  new URL(page.url()).pathname === '/admin/passes' && picked === walkList.id && /Only doors with someone on the list are walked\./.test(t), `${page.url()} · ${picked}`);
m = await measure(page, `${form} .sv-kind, ${form} .input, ${form} .btn`);
check('…the form with the list: one yellow, targets ≥ 48px', m.yellow === 1 && m.minTap >= 48, JSON.stringify(m));
await D.shot('13-walk-this-list-form');
await page.fill(`${form} input`, 'Walk · test');
await page.click(`${form} button[type="submit"]`);
await page.waitForSelector('.pass-open', { timeout: 8000 });
await sleep(500);
const walkCard = (await page.innerText('.pass-open')).replace(/\s+/g, ' ');
const walkPass = (await D.api('/passes')).json.open;
check('the open pass walks the list: "Persuasion · List: Walk these doors · 2 tries"; the server has it',
  /Persuasion · List: Walk these doors · 2 tries/.test(walkCard) && walkPass?.list_id === walkList.id && walkPass.list_name === 'Walk these doors', walkCard);
await D.shot('14-walk-this-list-open');
const walked = async () => (await walkApi(V)).doors.map((d) => d.address);
check('the volunteer’s walk list: only Ben’s and Dee’s doors', (await walked()).join('|') === '13225 72 Ave|13212 72 Ave', (await walked()).join('|'));
const vOpen = (await V.api('/passes')).json.open;
check('…the volunteer reads the pass and its list’s id, never its name', vOpen?.list_id === walkList.id && vOpen.list_name === undefined, JSON.stringify(vOpen));
await V.go(`/turfs/${turf.id}`);
await vpage.waitForSelector('.walk-door', { timeout: 8000 });
await sleep(700);
check('the walk list on the phone: two doors, "2 doors left"', (await vpage.$$('.walk-door')).length === 2 && (await progress()) === '2 doors left', `${(await vpage.$$('.walk-door')).length} · ${await progress()}`);
m = await measure(vpage);
check('…at 390: one yellow, no sideways scroll', m.yellow <= 1 && m.overflow <= 0, JSON.stringify(m));
await V.shot('15-walk-this-list-phone');
await D.api('/actions/person.update', { id: P.ben.id, tags: [] });
check('Ben leaves the list: his door leaves the walk at the next load', (await walked()).join('|') === '13212 72 Ave', (await walked()).join('|'));
// The open pass walks it: deleting the list is refused, in place, in words.
await D.go(`/lists/${walkList.id}`);
await page.click('.ls-tools button:has-text("Delete")');
await page.click('.ls-tools .ops-confirm button:has-text("Yes")');
await sleep(800);
check('the list can’t be deleted while the pass walks it — said on its page', /The pass “Walk · test” walks this list — end the pass first/.test(await D.text())
  && (await D.api(`/lists/${walkList.id}`)).status === 200, (await D.text()).slice(0, 200));
await D.api('/actions/pass.end', { id: walkPass.id });
check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
