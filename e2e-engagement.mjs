// Speed to lead and automations E2E — one fresh in-memory campaign.
//
// A desk signs up and invites an organizer, Rae (a volunteer, on a 390×844
// phone). Rae adds Nora to My people. Nora then fills in the website's
// volunteer form (the website's server calls the intake API, as a site's
// form does): a follow-up goes to Rae — she brought Nora in — with what Nora
// said and a 24-hour clock, on Rae's own Today. Rae opens it: Nora's words,
// one tap to call (the phone's own dialler: calls aren't connected) and how
// it went; "Talked" logs the call and the follow-up closes — off her Today,
// done on the desk's Follow-ups with the time to first contact. A second
// website volunteer nobody knows goes to the office (the manager's Today);
// the desk hands it to Rae on Follow-ups ("Who has them"). Then a ladder
// built on screen: "Booked a shift", the goal "Came to a shift", a Wait and
// a Text step (one that doesn't name the campaign is flagged first); Nora
// is booked (she's on it, waiting) and checked in — she comes off at once,
// "Reached the goal". New screens are measured (one yellow, no sideways
// scroll, 48px targets); screenshots at 1360×900 and 390×844. The books
// verify.
//
//   STARBASE_OPEN_SIGNUP=1 STARBASE_DATA=memory PORT=4180 STARBASE_JOBS_EVERY_MS=1000 node server/index.js &
//   BASE=http://127.0.0.1:4180 SHOTS=/tmp/engagement node e2e-engagement.mjs
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:3200';
const ADMIN = `${BASE}/admin`;
const SHOTS = process.env.SHOTS || '/tmp/starbase-engagement';
mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 240) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Date.now().toString(36);
const until = async (fn, ms = 20000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(400);
  }
};

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const errors = [];
const helpers = (page, who) => {
  page.on('pageerror', (e) => errors.push(`[${who}] ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && /key|unique|warning/i.test(m.text())) errors.push(`[${who}] ${m.text()}`); });
  return {
    shot: (n, full = false) => page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: full }),
    text: async () => ((await page.innerText('main.page').catch(() => page.innerText('body').catch(() => ''))) || '').replace(/\s+/g, ' '),
    api: (path, body) => page.evaluate(async ([p, b]) => {
      const r = await fetch('/api' + p, b === undefined ? {} : {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b),
      });
      const raw = await r.text();
      let json = null;
      try { json = JSON.parse(raw); } catch { /* not json */ }
      return { status: r.status, json, raw };
    }, [path, body]),
  };
};
// One yellow, no sideways scroll, every target in `sel` at least 48px.
const FIELDS = 'main.page input:not([type=checkbox]), main.page select, main.page textarea, main.page button, main.page a.btn';
const simple = async (page, name, sel = FIELDS) => {
  const m = await page.evaluate((targets) => {
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
    const yellow = [...document.querySelectorAll('.btn-primary')].filter(visible).length;
    const overflow = document.documentElement.scrollWidth - window.innerWidth;
    let minTap = null;
    let minWho = '';
    for (const el of document.querySelectorAll(targets)) {
      if (!visible(el)) continue;
      const h = el.getBoundingClientRect().height;
      if (minTap == null || h < minTap) { minTap = h; minWho = el.outerHTML.slice(0, 90); }
    }
    return { yellow, overflow, minTap, minWho };
  }, sel);
  check(`${name}: ≤1 yellow, no sideways scroll, targets ≥48px`, m.yellow <= 1 && m.overflow <= 0 && (m.minTap == null || m.minTap >= 47.5),
    `yellow=${m.yellow} overflow=${m.overflow} minTap=${m.minTap} ${m.minTap < 47.5 ? m.minWho : ''}`);
};

// ── 1. The desk signs up; Rae joins on her phone ──
const desk = await browser.newContext({ viewport: { width: 1360, height: 900 }, timezoneId: 'America/Vancouver' });
const page = await desk.newPage();
const D = helpers(page, 'desk');
await page.goto(`${BASE}/signup`, { waitUntil: 'domcontentloaded' });
await page.fill('#su-name', 'Mona Example');
if (await page.locator('#su-org').count()) await page.fill('#su-org', 'Imagine Surrey');
await page.fill('#su-email', `mona.${tag}@example.org`);
await page.fill('#su-password', 'surrey-forward-2026');
await page.click('button[type="submit"]');
await page.waitForURL(/\/admin\/?$/, { timeout: 15000 });
const me = (await D.api('/auth/me')).json;
check('desk signed up', !!me?.workspace?.id);
const campaign = me.workspace.name;

const inv = (await D.api('/actions/member.invite', { email: `rae.${tag}@example.org`, role: 'volunteer' })).json;
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/Vancouver' });
const rae = await phone.newPage();
const R = helpers(rae, 'rae');
await rae.goto(inv.joinUrl.replace(/^https?:\/\/[^/]+/, BASE), { waitUntil: 'domcontentloaded' });
await rae.waitForSelector('#join-name', { timeout: 8000 }).catch(() => {});
await rae.fill('#join-name', 'Rae Example');
await rae.fill('#join-password', 'knock-knock-2026');
await rae.click('button[type="submit"]');
await rae.waitForURL(`${BASE}/`, { timeout: 15000 }).catch(() => {});
check('Rae joined (the field app)', new URL(rae.url()).pathname === '/');
await sleep(800);
check('Rae’s Today: no "Follow up" while there is nobody to reach', !(await rae.locator('section.fu').count()));

// Rae knows Nora (My people: she brings her in).
const noraEmail = `nora.${tag}@example.org`;
const added = await R.api('/actions/relationship.add', { person: { name: 'Nora Example', phone: '604-555-0170', email: noraEmail }, kind: 'neighbour' });
check('Rae adds Nora to My people', added.status === 200, added.raw.slice(0, 160));
const noraId = added.json?.person?.id || added.json?.relationship?.person_b || null;

// ── 2. The website's volunteer form (its server calls the intake API) ──
const key = (await D.api('/actions/intake.key.create', { name: 'Website' })).json.key;
const form = async (body) => {
  const r = await fetch(`${BASE}/in/v1/people`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'idempotency-key': `${tag}-${body.email}` },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const sent = await form({ first_name: 'Nora', last_name: 'Example', email: noraEmail, phone: '604-555-0170', volunteer: true, note: 'Weekday evenings, near Guildford library', source: 'volunteer-form' });
check('the volunteer form is in', sent.status === 200 && sent.json?.person_id, JSON.stringify(sent.json));

// ── 3. Rae's Today: Nora, what she said, the clock ──
await rae.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await rae.locator('section.fu .fu-row').first().waitFor({ timeout: 10000 }).catch(() => {});
let rt = await R.text();
check('Rae’s Today: "Follow up · 1" at the top', /Follow up · 1/i.test(rt) && rt.search(/Follow up/i) < rt.indexOf('Start canvassing'), rt.slice(0, 200));
const row = rae.locator('section.fu .fu-row', { hasText: 'Nora Example' });
const rowText = ((await row.innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
check('the row: her name, what she did, the 24-hour clock', /Nora Example/.test(rowText) && /Offered to volunteer on the website/.test(rowText) && /(2[34]|1\d) h left/.test(rowText), rowText);
check('the clock is said in full to a screen reader', /hours left to reach them/.test(await row.locator('.fu-sr').innerText().catch(() => '')));
await R.shot('phone-1-today-followup');
await simple(rae, 'Rae’s Today with a follow-up', 'main.page section.fu button, main.page .today-start');
await row.tap();
await rae.locator('.fu-body').waitFor({ timeout: 8000 });
await sleep(300);
const body = ((await rae.locator('.fu-body').innerText()) || '').replace(/\s+/g, ' ');
check('opened: what she said on the form', /Weekday evenings, near Guildford library/.test(body), body.slice(0, 200));
check('one tap to call: Call Nora (the phone’s own, calls not connected)', (await rae.locator('.fu-body a.cl-call[href^="tel:"]').count()) === 1, body.slice(0, 200));
check('a Text way too', (await rae.locator('.fu-body .cl-toggle button', { hasText: 'Text' }).count()) === 1);
check('how it went: ratings, Talked, Left a message, No answer', /Talked/.test(body) && /Left a message/.test(body) && /No answer/.test(body) && (await rae.locator('.fu-body .rb-btn').count()) >= 4);
check('opened row says it is open (aria-expanded)', (await row.getAttribute('aria-expanded')) === 'true');
await R.shot('phone-2-followup-open', true);
await simple(rae, 'an opened follow-up', 'main.page .fu-body button, main.page .fu-body a.btn, main.page .fu-row');
check('the volunteer never gets Nora’s email', !(await R.api('/followups/mine')).raw.includes(noraEmail));

// ── 4. "Talked" logs the call; the follow-up closes ──
await rae.locator('.fu-body .cl-out', { hasText: 'Talked' }).tap();
await rae.locator('.fu-said').waitFor({ timeout: 10000 }).catch(() => {});
rt = await R.text();
check('said: "✓ Nora Example · Call · Talked — followed up"', /✓ Nora Example · Call · Talked — followed up/.test(rt), rt.slice(0, 200));
const left = await until(async () => ((await R.api('/followups/mine')).json?.followups?.length === 0 ? 'ok' : null), 8000);
check('off Rae’s list on the server', !!left);
await sleep(500);
check('no row for Nora any more', (await rae.locator('section.fu .fu-row', { hasText: 'Nora Example' }).count()) === 0);
await R.shot('phone-3-followed-up');
const deskList = (await D.api('/ladders/followups')).json;
const doneNora = deskList.done.find((f) => f.person.name === 'Nora Example');
check('the desk: done, reached by Rae', doneNora && doneNora.contacted_at && doneNora.done_by_name === 'Rae Example', JSON.stringify(doneNora || {}).slice(0, 200));
check('time to first contact: 1 of 1 within a day', deskList.stats.reached === 1 && deskList.stats.in_a_day === 1 && deskList.stats.median_hours != null, JSON.stringify(deskList.stats));
const contacts = (await D.api(`/persons/${sent.json.person_id}`)).json;
check('the call is on Nora’s record', JSON.stringify(contacts).includes('"channel":"phone"'), JSON.stringify(contacts).slice(0, 120));

// ── 5. Someone nobody knows: the office; the desk hands it to Rae ──
const omar = await form({ first_name: 'Omar', last_name: 'Example', email: `omar.${tag}@example.org`, phone: '604-555-0171', volunteer: true, source: 'volunteer-form' });
check('a second volunteer form', omar.status === 200);
await page.goto(`${ADMIN}/`, { waitUntil: 'domcontentloaded' });
await page.locator('section.fu .fu-row').first().waitFor({ timeout: 10000 }).catch(() => {});
let dt = await D.text();
check('the manager’s Today: "Follow up · 1" — Omar, from the office', /Follow up · 1/i.test(dt) && /Omar Example/.test(dt), dt.slice(0, 240));
check('Needs you: "1 follow-up"', /1 follow-up/.test(dt));
await D.shot('desk-1-today');
const tphone = await desk.newPage();
await tphone.setViewportSize({ width: 390, height: 844 });
await tphone.goto(`${ADMIN}/`, { waitUntil: 'domcontentloaded' });
await tphone.locator('section.fu .fu-row').first().waitFor({ timeout: 10000 }).catch(() => {});
await sleep(400);
await tphone.screenshot({ path: `${SHOTS}/phone-9-desk-today.png`, fullPage: false });
await simple(tphone, 'the desk’s Today on a phone', 'main.page section.fu button, main.page .today-rows a');
await tphone.close();
await page.goto(`${ADMIN}/follow-ups`, { waitUntil: 'domcontentloaded' });
await page.locator('.lad-by').waitFor({ timeout: 8000 }).catch(() => {});
await sleep(400);
dt = await D.text();
check('Follow-ups: 1 to do, the pace over 30 days', /1 to do/.test(dt) && /Last 30 days/i.test(dt) && /1 of 1 within a day/.test(dt), dt.slice(0, 300));
check('Who has them: Mona Example · 1', (await page.locator('.lad-by__pick', { hasText: 'Mona Example' }).count()) === 1, dt.slice(0, 300));
check('the row says who has it and why', /Mona Example has it \(the office\)/.test(dt));
await D.shot('desk-2-followups');
await page.getByRole('button', { name: 'Hand to…' }).click();
await page.locator('form.lad-hand select').selectOption({ label: 'Rae Example' });
await page.getByRole('button', { name: 'Hand over' }).click();
await page.locator('.toast').waitFor({ timeout: 8000 }).catch(() => {});
dt = await D.text();
check('handed over: "Omar Example · Rae Example has it"', /Omar Example · Rae Example has it/.test(dt), dt.slice(-200));
await page.getByRole('button', { name: /^Rae Example/ }).click();
await sleep(500);
check('Who has them → Rae: only hers', (await page.locator('.lad-fu').count()) === 1 && new URL(page.url()).searchParams.get('who'), page.url());
await rae.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await rae.locator('section.fu .fu-row', { hasText: 'Omar Example' }).waitFor({ timeout: 10000 }).catch(() => {});
check('Omar is on Rae’s Today now', (await rae.locator('section.fu .fu-row', { hasText: 'Omar Example' }).count()) === 1);
// A day later (the answer's due time moved back a day: the clock counts
// from the server's time, whatever the phone's says): overdue, in red.
await rae.route('**/api/followups/mine', async (route) => {
  const res = await route.fetch();
  const body = await res.json();
  for (const f of body.followups) f.due_at = new Date(new Date(body.now).getTime() - 3 * 3600_000 - 60_000).toISOString();
  await route.fulfill({ response: res, json: body });
});
await rae.reload({ waitUntil: 'domcontentloaded' });
await rae.locator('section.fu .fu-row', { hasText: 'Omar Example' }).waitFor({ timeout: 10000 }).catch(() => {});
const late = rae.locator('section.fu .fu-row', { hasText: 'Omar Example' });
const lateText = ((await late.innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
const lateColor = await late.locator('.fu-clock').evaluate((el) => getComputedStyle(el).color).catch(() => '');
check('overdue: "Overdue · 3 h", in red, and the heading says so', /Overdue · 3 h/.test(lateText) && /Overdue by 3 hours/.test(lateText)
  && /^rgb\((1[5-9]\d|2\d\d), \d{1,2}, \d{1,2}\)$/.test(lateColor) && /1 overdue/i.test(await R.text()), `${lateText} ${lateColor}`);
check('…and not by colour alone: a red edge on the row', (await rae.locator('.fu-item[data-late]').count()) === 1);
await R.shot('phone-8-overdue');
await rae.unroute('**/api/followups/mine');
await rae.goto(`${BASE}/follow-ups`, { waitUntil: 'domcontentloaded' });
await sleep(500);
check('Rae can’t open the desk’s Follow-ups', new URL(rae.url()).pathname === '/', rae.url());
check('…nor read it', (await R.api('/ladders/followups')).status === 403);
const fphone = await desk.newPage();
await fphone.setViewportSize({ width: 390, height: 844 });
await fphone.goto(`${ADMIN}/follow-ups`, { waitUntil: 'domcontentloaded' });
await fphone.locator('.lad-by').waitFor({ timeout: 8000 }).catch(() => {});
await sleep(300);
await fphone.screenshot({ path: `${SHOTS}/phone-4-followups.png`, fullPage: true });
await simple(fphone, 'Follow-ups on a phone');
await fphone.close();

// ── 6. A ladder with a goal, built on screen ──
await page.goto(`${ADMIN}/ladders`, { waitUntil: 'domcontentloaded' });
await page.getByRole('button', { name: 'New ladder' }).click();
await page.fill('#lad-new-name', 'Get new volunteers to a shift');
await page.selectOption('#lad-new-kind', 'shift_booked');
await page.getByRole('button', { name: 'Create ladder' }).click();
await page.waitForURL(/\/ladders\/[0-9a-f-]{36}$/, { timeout: 8000 }).catch(() => {});
await sleep(600);
const ladderId = page.url().split('/').pop();
dt = await D.text();
check('starts when: Booked a shift', /Starts when Booked a shift/i.test(dt), dt.slice(0, 200));
await page.getByRole('button', { name: 'Add a goal' }).click();
await page.locator('#lad-goal-goal').selectOption('shift_attended');
await page.locator('form[aria-label="Goal"]').getByRole('button', { name: 'Save' }).click();
await sleep(600);
dt = await D.text();
check('goal: "Until they come to a shift"', /Goal Until they come to a shift/i.test(dt), dt.slice(0, 260));
await page.getByRole('button', { name: '+ Wait' }).click();
await page.locator('.lad-new-step input[type=number]').fill('2');
await page.getByRole('button', { name: 'Add step' }).click();
await sleep(600);
await page.getByRole('button', { name: '+ Text' }).click();
const textBox = page.locator('.lad-new-step textarea');
await textBox.fill('Hi [first name], see you at your first shift! —');
await page.getByRole('button', { name: 'Add step' }).click();
await sleep(300);
dt = await D.text();
check('a text that doesn’t say who it’s from is flagged', new RegExp(`Say it’s ${campaign.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(dt), dt.slice(-300));
await textBox.click();
await textBox.press('End');
await page.getByRole('button', { name: '+ Campaign' }).click();
await page.getByRole('button', { name: 'Add step' }).click();
await sleep(700);
let L = (await D.api(`/ladders/${ladderId}`)).json;
check('steps stored: Wait 2 days, a Text naming the campaign', L.ladder.steps.length === 2 && L.ladder.steps[1].kind === 'text' && L.ladder.steps[1].body === 'Hi {{first_name}}, see you at your first shift! — {{campaign}}', JSON.stringify(L.ladder.steps));
dt = await D.text();
check('the text card says the texting rules', /Text · Hi \[first name\], see you at your first shift! — \[campaign\]/.test(dt) && /never to anyone who replied STOP/.test(dt), dt.slice(0, 400));
await D.shot('desk-3-ladder-goal', true);
await simple(page, 'the ladder builder');
await page.getByRole('button', { name: 'Turn on' }).click();
await sleep(700);
L = (await D.api(`/ladders/${ladderId}`)).json;
check('turned on', L.ladder.active === true && L.ladder.goal?.kind === 'shift_attended');

// Nora is booked: she's on it, waiting.
const shift = (await D.api('/actions/shift.create', { title: 'Guildford canvass', starts_at: new Date(Date.now() + 2 * 3600000).toISOString() })).json.shift;
const booking = (await D.api('/actions/shift.assign', { shift_id: shift.id, person_id: sent.json.person_id })).json.assignment;
const waiting = await until(async () => (await D.api(`/ladders/${ladderId}`)).json.people.find((p) => p.person.name === 'Nora Example' && p.wait === 'time'));
check('booked: Nora is on the ladder, waiting', !!waiting);
await page.reload({ waitUntil: 'domcontentloaded' });
await sleep(800);
dt = await D.text();
check('the builder: "Nora Example Waiting until …"', /Nora Example Waiting until/.test(dt), dt.slice(dt.indexOf('People'), dt.indexOf('People') + 120));
// …and checked in: off at once.
await D.api('/actions/shift.setStatus', { id: booking.id, status: 'completed' });
const reached = await until(async () => (await D.api(`/ladders/${ladderId}`)).json.people.find((p) => p.person.name === 'Nora Example' && p.status === 'done'));
check('came to the shift: off the ladder', reached?.last?.result === 'goal', JSON.stringify(reached?.last || {}));
await page.reload({ waitUntil: 'domcontentloaded' });
await sleep(800);
dt = await D.text();
check('counts: "0 in progress · 1 finished (1 reached the goal)"', /0 in progress · 1 finished \(1 reached the goal\)/.test(dt), dt.slice(0, 260));
await page.getByRole('button', { name: /^Finished · / }).click();
await sleep(300);
dt = await D.text();
check('her line: "Reached the goal"', /Nora Example Reached the goal/.test(dt), dt.slice(dt.indexOf('People'), dt.indexOf('People') + 160));
await D.shot('desk-4-ladder-reached', true);
const lphone = await desk.newPage();
await lphone.setViewportSize({ width: 390, height: 844 });
await lphone.goto(`${ADMIN}/ladders/${ladderId}`, { waitUntil: 'domcontentloaded' });
await sleep(900);
await lphone.screenshot({ path: `${SHOTS}/phone-5-ladder.png`, fullPage: true });
await simple(lphone, 'the ladder builder on a phone');
await lphone.getByRole('button', { name: 'Change' }).first().click();
await sleep(300);
await lphone.screenshot({ path: `${SHOTS}/phone-6-trigger-picker.png`, fullPage: false });
const groups = await lphone.locator('#lad-trig-kind optgroup').evaluateAll((els) => els.map((e) => e.label));
check('the trigger picker in groups', JSON.stringify(groups) === JSON.stringify(['On the website', 'People', 'Shifts', 'Money and members']), JSON.stringify(groups));
await lphone.locator('#lad-trig-kind').selectOption('web');
await sleep(200);
const webChoices = await lphone.locator('#lad-trig-ref option').allInnerTexts();
check('"Did something on the website": what they did, in words', webChoices.includes('Signed a petition') && webChoices.includes('Offered to volunteer') && webChoices.includes('RSVP’d to an event'), webChoices.join(' | '));
await lphone.locator('form[aria-label="Starts when"]').getByRole('button', { name: 'Save' }).click();
await sleep(200);
check('…and it asks which before saving', /Pick what they did on the website/.test(await lphone.innerText('main.page')));
await lphone.screenshot({ path: `${SHOTS}/phone-7-website-trigger.png`, fullPage: false });
await lphone.close();

// ── 7. The books ──
const v = (await D.api('/audit/verify')).json;
check('hash chain verifies (follow-ups and ladder steps included)', v.ok === true, JSON.stringify(v));
const ev = (await D.api('/events?since=0&limit=2000')).json.events;
check('the follow-up and its close are on the chain', ev.some((e) => e.entity_type === 'ladder_followup' && e.op === 'create') && ev.some((e) => e.entity_type === 'ladder_followup' && e.payload?.closed_by === 'contact'));
check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
const fails = results.filter((x) => !x).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
