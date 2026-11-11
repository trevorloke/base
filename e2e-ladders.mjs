// Ladders E2E — one fresh in-memory campaign: a desk user finds Ladders
// under Outreach, builds "Thank new signers" (starts on a tag; steps
// as cards: Tag · Email · Follow-up, one moved up, a Wait), turns it on; a
// desk tags someone; the job runner tags them,
// adds the follow-up and — email not connected — the run says "Waiting —
// email isn't connected" on screen exactly as the server has it. Today's
// "Needs you" has "1 follow-up"; the follow-up is done and undone; the
// profile shows the engagement chip and the Ladders section; off holds the
// run in place and on resumes it. A volunteer on a 390×844 phone rates a
// door 1 (which puts that person on a ladder) and can reach none of it —
// screens, API, or the JSON their browser receives; Dora never said yes to
// email, so the ladder's email skips her ("didn't ask for email"). The
// unsubscribe link asks before it acts; once Ana is off the list the desk
// can't add her back; Dora (never on it) is flagged do-not-email with no list
// row. The builder's email card says who it reaches ("· N people said yes"),
// "+ First name" fills in as "[first name]" (the server keeps {{first_name}}),
// no code shows on the builder, and a {first_name} is flagged. Back links
// say where they go ("← Today" from Today, "← Ladders", "← Ana Souza" from her
// profile). The books still verify. New screens are measured (visible words,
// yellow buttons, sideways scroll, 48px targets).
// "Send to a web address" (under Other steps): the step asks for an https
// address and a label; http is refused on the page and an address inside a
// private network by the server, both said in the step; More details sends
// a test and shows the campaign's signing secret only when asked, with
// "Make a new secret" beside it; the keyboard's place follows each tap;
// measured at both sizes. A step kind the page doesn't know says so and is
// saved as it is.
//
//   STARBASE_OPEN_SIGNUP=1 STARBASE_DATA=memory PORT=4103 STARBASE_JOBS_EVERY_MS=1000 node server/index.js &
//   BASE=http://127.0.0.1:4103 SHOTS=/tmp/ladders node e2e-ladders.mjs
//
// To also watch the step deliver — a test about a made-up person, one
// signed message each, an email only for who said yes, "Zapier: Sent · 200"
// on the run's log, do-not-contact never sent, a redirect handed it once,
// someone taken off mid-send, a failing address tried again — run a
// stand-in receiver and point both at it:
//
//   PORT=4104 node server/test/fake-receiver.js &
//   … LADDER_WEBHOOK_API_BASE=http://127.0.0.1:4104 node server/index.js &
//   HOOKS=http://127.0.0.1:4104 BASE=http://127.0.0.1:4103 node e2e-ladders.mjs
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { verifySignature } from './server/lib/signature.js';

const BASE = process.env.BASE || 'http://localhost:3200';
// The stand-in receiver the server sends to (fake-receiver.js), if one is running.
const HOOKS = (process.env.HOOKS || '').replace(/\/$/, '');
const ADMIN = { toString() { return `${BASE}/admin`; } }; // the desk's pages live in the admin (web/src/mode.js)
const SHOTS = process.env.SHOTS || '/tmp/starbase-ladders';
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
  page.on('console', (m) => { if (m.type() === 'error' && /key|unique|warning/i.test(m.text())) errors.push(`[${who}] ${m.text()}`); });
  return {
    shot: (n) => page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: false }),
    full: (n) => page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true }),
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
  let minWho = '';
  if (targets) {
    for (const el of document.querySelectorAll(targets)) {
      if (!visible(el)) continue;
      const h = el.getBoundingClientRect().height;
      if (minTap == null || h < minTap) { minTap = h; minWho = el.outerHTML.slice(0, 80); }
    }
  }
  return { words, yellow, overflow, minTap, minWho };
}, sel);
const FIELDS = 'main.page input:not([type=checkbox]), main.page select, main.page textarea, main.page button, main.page a.btn';
const simple = async (page, name, sel = FIELDS) => {
  const m = await measure(page, sel);
  check(`${name}: ≤1 yellow, no sideways scroll, targets ≥48px`, m.yellow <= 1 && m.overflow <= 0 && (m.minTap == null || m.minTap >= 47.5),
    `words=${m.words} yellow=${m.yellow} overflow=${m.overflow} minTap=${m.minTap} ${m.minTap < 47.5 ? m.minWho : ''}`);
  return m;
};
const until = async (fn, ms = 20000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(500);
  }
};

// ── 1. Desk: sign up, a few people ──
const desk = await browser.newContext({ viewport: { width: 1360, height: 900 }, timezoneId: 'America/Vancouver' });
await tiles(desk);
const page = await desk.newPage();
const D = helpers(page, 'desk');
await D.go('/signup');
await page.fill('#su-name', 'Ladder Organizer');
if (await page.locator('#su-org').count()) await page.fill('#su-org', 'Imagine Surrey');
await page.fill('#su-email', `organizer.${tag}@example.org`);
await page.fill('#su-password', 'surrey-forward-2026');
await page.click('button[type="submit"]');
await page.waitForURL(/\/admin\/?$/, { timeout: 15000 });
const me = (await D.api('/auth/me')).json;
const slug = me.workspace.slug;
check('desk signed up', !!slug, slug);
const dora = (await D.api('/actions/person.create', { name: 'Dora Door', phone: '604-555-0161', address: '12345 72 Ave', city: 'Surrey', lat: 49.133, lng: -122.851, email: `dora.${tag}@example.org` })).json.person;

// ── 2. Outreach → Ladders ──
await D.go('/outreach/newsletter');
const link = page.locator('a.lad-link');
check('Outreach has a Ladders row', await link.isVisible().catch(() => false), await D.text().then((t) => t.slice(-120)));
await link.click();
await page.waitForURL(`${ADMIN}/ladders`, { timeout: 8000 }).catch(() => {});
await sleep(600);
let t = await D.text();
check('Ladders opens empty: one line + one button', /No ladders yet\./.test(t) && (await page.locator('.btn-primary:visible').count()) === 1, t.slice(0, 160));
check('Ladders says what it is under the title', /^Ladders Automatic emails, texts & follow-ups/.test(t), t.slice(0, 60));
await D.shot('1-ladders-empty');

// ── 3. New ladder: name + Starts when (a tag) ──
await page.getByRole('button', { name: 'New ladder' }).click();
await page.fill('#lad-new-name', 'Thank new signers');
await page.selectOption('#lad-new-kind', 'tag');
await page.fill('#lad-new-ref', 'signer');
check('new-ladder form: one yellow (the header button gives way)', (await page.locator('.btn-primary:visible').count()) === 1);
await D.shot('2-new-ladder');
await page.getByRole('button', { name: 'Create ladder' }).click();
await page.waitForURL(/\/ladders\/[0-9a-f-]{36}$/, { timeout: 8000 }).catch(() => {});
await sleep(700);
const ladderId = page.url().split('/').pop();
let L = (await D.api(`/ladders/${ladderId}`)).json;
check('ladder created off, starting on the tag', L?.ladder?.active === false && L.ladder.trigger.kind === 'tag' && L.ladder.trigger.ref === 'signer', JSON.stringify(L?.ladder?.trigger));
t = await D.text();
check('builder says what starts it', /Starts when/i.test(t) && /Got a tag · signer/.test(t), t.slice(0, 200));
check('Turn on waits for a step', await page.getByRole('button', { name: 'Turn on' }).isDisabled() && /Add a step, then turn it on\./.test(t));

// ── 4. Steps as cards ──
const addStep = async (label, fill) => {
  await page.getByRole('button', { name: `+ ${label}` }).click();
  await fill();
  await page.getByRole('button', { name: 'Add step' }).click();
  await sleep(700);
};
await addStep('Tag', () => page.getByLabel('Add tag').fill('thanked'));
// Email: a {first_name} is flagged before saving; + First name / + Campaign fill in.
await page.getByRole('button', { name: '+ Email' }).click();
await page.getByLabel('Subject').fill('Thanks, {first_name}');
await page.getByLabel('Message').fill('Thank you for signing for 72 Ave. — ');
await page.getByRole('button', { name: 'Add step' }).click();
await sleep(400);
t = await D.text();
check('a {first_name} is flagged, not saved', /\{first_name\} won’t fill in — use \+ First name/.test(t)
  && !(await D.api(`/ladders/${ladderId}`)).json.ladder.steps.some((x) => x.kind === 'email'), t.slice(t.indexOf('Subject'), t.indexOf('Subject') + 200));
await page.getByLabel('Subject').fill('Thanks, ');
await page.getByRole('button', { name: '+ First name' }).click();
await page.getByLabel('Message').click();
await page.getByLabel('Message').press('End');
await page.getByRole('button', { name: '+ Campaign' }).click();
const filled = [await page.getByLabel('Subject').inputValue(), await page.getByLabel('Message').inputValue()];
check('+ First name / + Campaign fill in at the cursor, as words', filled[0] === 'Thanks, [first name]' && filled[1] === 'Thank you for signing for 72 Ave. — [campaign]', JSON.stringify(filled));
check('no code in the help line', !/\{\{/.test(await page.locator('.lad-new-step .lad-hint').innerText()));
await page.getByRole('button', { name: 'Add step' }).click();
await sleep(700);
await page.getByRole('button', { name: '+ Follow-up' }).click();
const fuHint = await page.getByLabel('Follow-up for staff').getAttribute('placeholder');
check('follow-up placeholder in words, no code', fuHint === 'Call [first name] to say thanks', fuHint);
await page.getByLabel('Follow-up for staff').fill('Call [first name] to say thanks');
await page.getByRole('button', { name: 'Add step' }).click();
await sleep(700);
// Open the follow-up card and move it above the email.
await page.locator('.lad-step .ops-row', { hasText: 'Follow-up · Call' }).click();
await page.getByRole('button', { name: 'Move up' }).click();
await sleep(700);
await addStep('Wait', async () => {
  await page.getByLabel('Wait').fill('1');
  await page.getByRole('button', { name: 'Days' }).click();
});
L = (await D.api(`/ladders/${ladderId}`)).json;
const kinds = L.ladder.steps.map((s) => s.kind).join(',');
check('steps saved in order (follow-up moved up)', kinds === 'tag,followup,email,wait', kinds);
const cards = (await page.locator('.lad-step .lad-step__line').allInnerTexts()).join(' | ');
const em = L.ladder.steps.find((x) => x.kind === 'email');
const fu = L.ladder.steps.find((x) => x.kind === 'followup');
check('the server keeps the codes underneath', em.subject === 'Thanks, {{first_name}}' && em.body === 'Thank you for signing for 72 Ave. — {{campaign}}'
  && fu.text === 'Call {{first_name}} to say thanks', JSON.stringify([em, fu]));
check('cards read as the server has them, in words', cards === 'Tag · thanked | Follow-up · Call [first name] to say thanks | Email · Thanks, [first name] | Wait 1 day', cards);
check('no code on the builder', !/\{\{|\}\}/.test(await D.text()), (await D.text()).match(/.{0,40}\{\{.{0,40}/)?.[0]);
const who = (await page.locator('.lad-step .lad-step__who').allInnerTexts()).map((x) => x.trim());
const saidYes = `${L.emailYes} ${L.emailYes === 1 ? 'person' : 'people'} said yes`;
check('the email card says who it reaches, the number with its noun (= server)', who.length === 1 && who[0] === `Goes only to people who said yes to email · ${saidYes}`, `${who.join(' | ')} vs ${L.emailYes}`);
const backOrig = async () => ({ text: ((await page.locator('.ops-back').first().textContent().catch(() => '')) || '').trim(), href: await page.locator('.ops-back').first().getAttribute('href').catch(() => null) });
// The desk lives in the admin: read its links without the base.
const backRaw = backOrig;
const backStripped = async () => { const b = await backRaw(); return b && b.href ? { ...b, href: b.href.replace(/^\/admin(?=\/|$)/, '') || '/' } : b; };
const back = backStripped;
let bk = await back();
check('builder back: "← Ladders", like every screen', bk.text === '← Ladders' && bk.href === '/ladders', JSON.stringify(bk));
check('the steps row says "Other steps", the page has one More',
  await page.getByRole('button', { name: 'Other steps' }).isVisible() && (await page.getByRole('button', { name: 'More', exact: true }).count()) === 1);
// Field targets inside an open email editor.
await page.getByRole('button', { name: '+ Email' }).click();
await sleep(300);
await simple(page, 'builder with an email step open (desktop)');
await page.locator('.lad-new-step').getByRole('button', { name: 'Cancel' }).click();
t = await D.text();
check('email not connected is said once', /Email isn’t connected — email steps wait\./.test(t));
await D.full('3-builder-steps');

await page.getByRole('button', { name: 'Turn on' }).click();
await sleep(800);
L = (await D.api(`/ladders/${ladderId}`)).json;
t = await D.text();
const statusChip = (await page.locator('.lad-status .chip').innerText().catch(() => '')).trim();
check('Turn on → On (server and screen)', L.ladder.active === true && /^on$/i.test(statusChip) && !(await page.getByRole('button', { name: 'Turn on' }).count()), `${statusChip} · ${t.slice(0, 120)}`);
check('On is said once (the chip), no extra line', (await page.locator('.ops-done').count()) === 0);

// ── 5. Ana joins the newsletter and gets the tag ──
const visitor = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const vp = await visitor.newPage();
vp.on('pageerror', (e) => errors.push(`[visitor] ${e.message}`));
const anaP = (await D.api('/actions/person.create', { name: 'Ana Souza', email: `ana.${tag}@example.org` })).json.person;
await D.api('/actions/subscription.add', { email: `ana.${tag}@example.org`, name: 'Ana Souza' }); // she says yes to email
const tagged = await D.api('/actions/person.update', { id: anaP.id, tags: ['signer'] });
check('Ana tagged signer', tagged.status === 200, JSON.stringify(tagged.json).slice(0, 120));

// The job runner takes her through Tag and Follow-up; Email waits.
const run = await until(async () => {
  const j = (await D.api(`/ladders/${ladderId}`)).json;
  const r = j?.people?.find((p) => p.person.name === 'Ana Souza');
  return r && r.wait === 'email' ? r : null;
});
check('run reached the email step and waits (email not connected)', run && run.step === 2 && run.status === 'active', JSON.stringify(run || {}).slice(0, 200));
await D.go(`/ladders/${ladderId}`);
t = await D.text();
check('screen: "Waiting — email isn’t connected" for Ana', /Ana Souza Waiting — email isn’t connected/.test(t), t.slice(t.indexOf('People'), t.indexOf('People') + 120));
check('screen: 1 in progress · 0 finished', /1 in progress · 0 finished/.test(t));
await page.locator('.lad-sec .ops-row', { hasText: 'Ana Souza' }).click();
await sleep(300);
const log = (await page.locator('.lad-log li').allInnerTexts()).map((s) => s.replace(/\s+/g, ' '));
check('her row opens on what each step did', log.length === 3 && /^Tag · thanked/.test(log[0]) && /^Follow-up added/.test(log[1]) && /^Email waiting — not connected/.test(log[2]), log.join(' | '));
await D.full('4-builder-people');
const ana = (await D.api(`/persons?q=${encodeURIComponent('Ana Souza')}`)).json.persons[0];
const prof = (await D.api(`/persons/${ana.id}`)).json;
check('the Tag step really tagged her', prof.person.tags.includes('thanked'), prof.person.tags.join(','));

// ── 6. Today → 1 follow-up → done, undone ──
await D.go('/');
t = await D.text();
check('Today Needs you: 1 follow-up', /Needs you.*?\b1 follow-up\b/i.test(t), t.slice(0, 300));
await D.shot('5-today-needs-you');
await page.locator('a.today-row', { hasText: 'follow-up' }).click();
await page.waitForURL(`${ADMIN}/follow-ups`, { timeout: 8000 }).catch(() => {});
await sleep(700);
let FU = (await D.api('/ladders/followups')).json;
t = await D.text();
check('follow-up reads as the server has it', FU.open.length === 1 && FU.open[0].text === 'Call Ana to say thanks' && t.includes('Call Ana to say thanks') && /1 to do/.test(t), t.slice(0, 200));
bk = await back();
check('follow-ups from Today: back says "← Today"', bk.text === '← Today' && bk.href === '/', JSON.stringify(bk));
await simple(page, 'follow-ups (desktop)');
await D.shot('6-follow-ups');
await page.getByRole('button', { name: 'Done' }).click();
await sleep(800);
FU = (await D.api('/ladders/followups')).json;
t = await D.text();
check('Done → done on the server, toast says so', FU.open.length === 0 && FU.done[0]?.status === 'done' && /Done · Ana Souza/.test(await page.innerText('body')) && /0 to do/.test(t));
await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
await sleep(800);
FU = (await D.api('/ladders/followups')).json;
check('Undo → open again', FU.open.length === 1 && /1 to do/.test(await D.text()));

// ── 7. Profile: engagement chip + Ladders section ──
await D.go(`/people/${ana.id}`);
const lev = (await D.api(`/persons/${ana.id}/ladders`)).json;
const chip = await page.locator('.lad-level').innerText().catch(() => '');
check('profile: engagement chip = server level', chip.trim().toLowerCase() === lev.level.label.toLowerCase() && lev.level.code === 'signer', `${chip} vs ${lev.level.label}`);
await page.getByRole('button', { name: /^Ladders/ }).click();
await sleep(300);
t = await D.text();
check('profile: Ladders section says where she is', /Thank new signers Waiting — email isn’t connected/.test(t) && /Call Ana to say thanks/.test(t), t.slice(t.indexOf('Ladders'), t.indexOf('Ladders') + 160));
await D.shot('7-profile');
await page.locator('.lad-pf-runs a', { hasText: 'Thank new signers' }).click();
await page.waitForURL(`${ADMIN}/ladders/${ladderId}`, { timeout: 8000 }).catch(() => {});
await sleep(700);
bk = await back();
check('ladder from her profile: back says "← Ana Souza"', bk.text === '← Ana Souza' && bk.href === `/people/${ana.id}`, JSON.stringify(bk));

// ── 8. The list + engagement ──
await D.go('/ladders');
t = await D.text();
const rowText = (await page.locator('.ops-rows .ops-item', { hasText: 'Thank new signers' }).innerText()).replace(/\s+/g, ' ').trim();
check('list row: trigger, counts, On', /^Thank new signers Got a tag · signer 1 in progress · 0 finished On$/i.test(rowText), rowText);
check('list: follow-ups row and email note', /1 follow-up to do/.test(t) && /Email isn’t connected — email steps wait\./.test(t));
await page.locator('a.lad-fu-link').click();
await page.waitForURL(`${ADMIN}/follow-ups`, { timeout: 8000 }).catch(() => {});
await sleep(500);
bk = await back();
check('follow-ups from Ladders: back says "← Ladders"', bk.text === '← Ladders' && bk.href === '/ladders', JSON.stringify(bk));
await D.go('/ladders');
await page.getByRole('button', { name: 'How involved people are' }).click();
await sleep(300);
const LS = (await D.api('/ladders')).json;
const bars = (await page.locator('.lad-levels__row').allInnerTexts()).map((s) => s.replace(/\s+/g, ' ').trim());
const want = LS.levels.map((l) => `${l.label} ${l.n}`);
check('engagement bars = server counts', JSON.stringify(bars) === JSON.stringify(want), `${bars.join(' | ')} vs ${want.join(' | ')}`);
await D.full('8-ladders-list');

// ── 9. Off holds her place; On resumes ──
await D.go(`/ladders/${ladderId}`);
await page.getByRole('button', { name: 'Turn off' }).click();
await sleep(800);
let r = (await D.api(`/ladders/${ladderId}`)).json.people[0];
t = await D.text();
check('Off → paused at the same step (server and screen)', r.status === 'paused' && r.step === 2 && /Ana Souza Paused · step 3 of 4/.test(t) && /Off · 1 paused in place/.test(t), t.slice(0, 200));
await page.getByRole('button', { name: 'Turn on' }).click();
await sleep(800);
r = (await D.api(`/ladders/${ladderId}`)).json.people[0];
check('On → active again, same step', r.status === 'active' && r.step === 2 && /On · 1 picked up where they were/.test(await D.text()));
await until(async () => (await D.api(`/ladders/${ladderId}`)).json.people[0].wait === 'email', 8000);

// ── 10. Phone, desk: the new screens measured at 390px ──
await page.setViewportSize({ width: 390, height: 844 });
for (const [path, name] of [['/ladders', 'ladders list (phone)'], [`/ladders/${ladderId}`, 'builder (phone)'], ['/follow-ups', 'follow-ups (phone)']]) {
  await D.go(path);
  const m = await simple(page, name);
  console.log(`      words on ${path}: ${m.words}`);
}
await D.go(`/ladders/${ladderId}`);
await page.getByRole('button', { name: '+ Wait' }).click();
await sleep(300);
await simple(page, 'builder, wait editor open (phone)');
await D.shot('9-builder-phone');
await page.locator('.lad-new-step').getByRole('button', { name: 'Cancel' }).click();
await page.setViewportSize({ width: 1360, height: 900 });

// ── 11. Volunteer on a phone: rates a door 1, sees nothing of ladders ──
const yes = (await D.api('/actions/ladder.create', {
  name: 'Rated yes', trigger: { kind: 'rating' },
  steps: [{ kind: 'tag', tag: 'said-yes' }, { kind: 'email', subject: 'Glad you are with us', body: 'Hi {{first_name}}' }],
})).json.ladder;
await D.api('/actions/ladder.setActive', { id: yes.id, active: true });
const inv = (await D.api('/actions/member.invite', { email: `jas.${tag}@example.org`, role: 'volunteer' })).json;
const vctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/Vancouver' });
await tiles(vctx);
const vol = await vctx.newPage();
const V = helpers(vol, 'volunteer');
await vol.goto(inv.joinUrl.replace(/^https?:\/\/[^/]+/, BASE), { waitUntil: 'domcontentloaded' });
await vol.waitForSelector('#join-name', { timeout: 8000 }).catch(() => {});
await vol.fill('#join-name', 'Jas Volunteer');
await vol.fill('#join-password', 'knock-knock-2026');
await vol.click('button[type="submit"]');
await vol.waitForURL(`${BASE}/`, { timeout: 15000 }).catch(() => {});
check('volunteer joined', new URL(vol.url()).pathname === '/');
await V.go(`/map?person=${dora.id}`);
await vol.waitForSelector('aside.door-card', { timeout: 8000 }).catch(() => {});
await vol.tap('aside.door-card button[aria-label="1: Strong support"]').catch(() => vol.click('aside.door-card button[aria-label="1: Strong support"]'));
await sleep(900);
const vt = ((await vol.innerText('body')) || '').replace(/\s+/g, ' ');
check('volunteer rated the door; the toast says only that', /Rated 1/.test(vt) && !/ladder|follow-up/i.test(vt), vt.slice(0, 160));
const doraRun = await until(async () => (await D.api(`/ladders/${yes.id}`)).json.people.find((p) => p.person.id === dora.id && p.status === 'done'));
check('…which put Dora on "Rated yes" (desk sees it)', !!doraRun);
check('a 1 at the door is not a yes to email: her email is skipped', doraRun && JSON.stringify(doraRun.skipped) === JSON.stringify([{ step: 1, kind: 'email', reason: 'no_consent' }]), JSON.stringify(doraRun?.skipped));
await D.go(`/ladders/${yes.id}`);
await page.getByRole('button', { name: /^Finished · / }).click().catch(() => {});
await sleep(300);
t = await D.text();
check('desk: "Finished · email skipped (didn’t ask for email)"', /Dora Door Finished · email skipped \(didn’t ask for email\)/.test(t), t.slice(t.indexOf('People'), t.indexOf('People') + 140));
await page.locator('.lad-sec .ops-row', { hasText: 'Dora Door' }).click();
await sleep(300);
const dlog = (await page.locator('.lad-log li').allInnerTexts()).map((x) => x.replace(/\s+/g, ' '));
check('her log: "Email skipped — didn’t ask for email"', dlog.some((x) => /^Email skipped — didn’t ask for email/.test(x)), dlog.join(' | '));
for (const path of ['/ladders', `/ladders/${ladderId}`, '/follow-ups']) {
  await V.go(path);
  check(`volunteer typing ${path} lands on Today`, new URL(vol.url()).pathname === '/', vol.url());
}
const vapi = [];
for (const path of ['/ladders', `/ladders/${ladderId}`, '/ladders/followups', '/ladders/followups/count', `/persons/${ana.id}/ladders`]) {
  const res = await V.api(path);
  vapi.push(`${path}=${res.status}`);
  check(`volunteer API ${path} → 403, nothing in it`, res.status === 403 && !/Thank|Ana|follow/i.test(res.raw), res.raw.slice(0, 100));
}
const created = await V.api('/actions/ladder.create', { name: 'x', trigger: { kind: 'rating' } });
check('volunteer cannot make a ladder', created.status === 403);
const vprof = await V.api(`/persons/${dora.id}`);
check('volunteer’s profile JSON carries nothing of ladders', vprof.status === 200 && !/ladder|said-yes|engagement/i.test(vprof.raw.replace(/"tags":\[[^\]]*\]/, '')), vprof.raw.slice(0, 120));
await V.go(`/people/${dora.id}`);
const vpt = ((await vol.innerText('main.page').catch(() => '')) || '').replace(/\s+/g, ' ');
check('volunteer profile: no engagement chip, no Ladders section', !(await vol.locator('.lad-level').count()) && !/\bLadders\b/.test(vpt), vpt.slice(0, 160));
const overflow = await vol.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
check('volunteer: no sideways scroll at 390px', overflow <= 0, overflow);
await V.shot('10-volunteer-profile');
await V.go('/');
await V.shot('11-volunteer-today');
check('volunteer Today: no follow-ups row', !/follow-up/i.test(await V.text()));
await vctx.close();

// ── 12. The unsubscribe link in her email works, and is honoured ──
await vp.goto(`${BASE}/lu/${run.id}`, { waitUntil: 'domcontentloaded' });
let ut = await vp.innerText('body');
const stillOn = (await D.api('/subscriptions')).json.subscriptions.find((s) => s.email === `ana.${tag}@example.org`);
check('opening the link only asks: one Unsubscribe button, still subscribed', /Unsubscribe from Imagine Surrey\?/.test(ut)
  && (await vp.locator('button', { hasText: /^Unsubscribe$/i }).count()) === 1 && stillOn?.status === 'subscribed', ut.slice(0, 120));
await vp.screenshot({ path: `${SHOTS}/12a-unsubscribe-ask.png` });
await vp.locator('button', { hasText: /^Unsubscribe$/i }).click();
await vp.waitForSelector('text=/Unsubscribed\./', { timeout: 8000 }).catch(() => {});
ut = await vp.innerText('body');
check('one tap: Unsubscribed, names the campaign', /Unsubscribed\./.test(ut) && /Imagine Surrey/.test(ut), ut.slice(0, 120));
await vp.screenshot({ path: `${SHOTS}/12-unsubscribed.png` });
const subs = (await D.api('/subscriptions')).json.subscriptions.filter((s) => s.email === `ana.${tag}@example.org`);
check('on the newsletter list as unsubscribed', subs.length === 1 && subs[0].status === 'unsubscribed', JSON.stringify(subs));
// Dora was never on the list: no list row, flagged do-not-email.
const doraRunId = (await D.api(`/ladders/${yes.id}`)).json.people.find((p) => p.person.id === dora.id).id;
const pre = (await D.api('/subscriptions')).json;
await vp.goto(`${BASE}/lu/${doraRunId}`, { waitUntil: 'domcontentloaded' });
await vp.locator('button', { hasText: /^Unsubscribe$/i }).click();
await vp.waitForSelector('text=/Unsubscribed\./', { timeout: 8000 }).catch(() => {});
const post = (await D.api('/subscriptions')).json;
const doraNow = (await D.api(`/persons/${dora.id}`)).json.person;
check('never on the list: no list row, flagged do-not-email', post.subscriptions.length === pre.subscriptions.length
  && !post.subscriptions.some((s) => s.email === `dora.${tag}@example.org`) && doraNow.tags.includes('do-not-email'), doraNow.tags.join(','));
await visitor.close();

// The desk sees the list as it is and can't put Ana back.
await D.go('/outreach/newsletter');
await page.click('button.ot-more:has-text("More")');
await sleep(300);
const SL = (await D.api('/subscriptions')).json;
const subsHead = (await page.locator('section[aria-label="Subscribers"] h2').innerText()).replace(/\s+/g, ' ').trim();
check('More: "Subscribers N · 1 unsubscribed" (= server)', subsHead.toLowerCase() === `subscribers ${SL.subscribed} · ${SL.unsubscribed} unsubscribed` && SL.unsubscribed === 1, subsHead);
check('no Re-subscribe anywhere', (await page.getByRole('button', { name: 'Re-subscribe' }).count()) === 0);
await page.fill('#sub-email', `ana.${tag}@example.org`);
await page.locator('form.ot-inline-add').getByRole('button', { name: 'Add' }).click();
await sleep(700);
t = await D.text();
const anaAfter = (await D.api('/subscriptions')).json.subscriptions.find((s) => s.email === `ana.${tag}@example.org`);
check('Add: "Unsubscribed on <date> — only they can rejoin", still off', /Unsubscribed on [A-Z][a-z]{2} \d{1,2} — only they can rejoin/.test(t) && anaAfter.status === 'unsubscribed', anaAfter.status);
await D.shot('12b-subscribers');

// ── 12c. A donor's profile: the level chip never repeats the donor tier ──
const gil = (await D.api('/actions/person.create', { name: 'Gil Giver', email: `gil.${tag}@example.org` })).json.person;
await D.api('/actions/gift.log', { person_id: gil.id, amount_cents: 5000, date: new Date().toISOString().slice(0, 10) });
await D.go(`/people/${gil.id}`);
const metaChips = (await page.locator('.pf-meta .chip').allInnerTexts()).map((x) => x.trim().toLowerCase());
check('donor profile: one Donor chip, not two', metaChips.filter((x) => x === 'donor').length === 1 && !(await page.locator('.pf-meta .lad-level').count()), metaChips.join(' | '));

// ── 12d. Send to a web address: the step, its refusals, a test, the signing secret ──
const PRIVATE = 'That address points inside a private network — it can’t be used';
const told = (await D.api('/actions/ladder.create', { name: 'Tell the team', trigger: { kind: 'tag', ref: 'new-signer' }, steps: [{ kind: 'tag', tag: 'told' }] })).json.ladder;
const hookSteps = async () => (await D.api(`/ladders/${told.id}`)).json.ladder.steps.filter((x) => x.kind === 'webhook');
const stepAlert = async () => ((await page.locator('.lad-new-step .lad-step-form > .error').innerText().catch(() => '')) || '').trim();
// Where the keyboard is: the focused element's words.
const focused = () => page.evaluate(() => (document.activeElement?.innerText || '').replace(/\s+/g, ' ').trim());
await D.go(`/ladders/${told.id}`);
check('"Send to a web address" waits under Other steps', (await page.getByRole('button', { name: '+ Send to a web address' }).count()) === 0);
await page.getByRole('button', { name: 'Other steps' }).click();
await sleep(200);
check('Other steps: the keyboard is on the first of them', (await focused()) === '+ Send to a web address', await focused());
await page.setViewportSize({ width: 390, height: 844 });
await sleep(200);
const oneLine = await page.evaluate(() => {
  const b = [...document.querySelectorAll('.lad-add--other button')].find((x) => x.innerText.trim() === '+ Send to a web address');
  const r = document.createRange();
  r.selectNodeContents(b);
  return { lines: new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size, height: Math.round(b.getBoundingClientRect().height) };
});
check('on a phone "+ Send to a web address" reads on one line', oneLine.lines === 1 && oneLine.height >= 48, JSON.stringify(oneLine));
await page.setViewportSize({ width: 1360, height: 900 });
await page.getByRole('button', { name: '+ Send to a web address' }).click();
await sleep(300);
check('the new step takes the keyboard’s place (its name; Tab goes on to its first field)', /^New step · Send to a web address$/i.test(await focused()), await focused());
check('the step asks for a web address and a label', (await page.getByLabel('Web address').count()) === 1 && (await page.getByLabel('Label').count()) === 1);
check('the label says what it is for', (await page.locator('.lad-new-step label', { hasText: 'Label' }).innerText()).trim() === 'Label — what to call the other tool');
await simple(page, 'builder, web address step open (desktop)');
await page.getByLabel('Web address').fill('http://hooks.example.org/catch/e2e');
await page.getByLabel('Label').fill('Zapier');
await page.getByRole('button', { name: 'Add step' }).click();
await sleep(300);
check('http is refused on the page', (await stepAlert()) === 'The address must start with https://', await stepAlert());
await page.getByLabel('Web address').fill('https://192.168.1.20/hook');
await page.getByRole('button', { name: 'Add step' }).click();
await until(async () => (await stepAlert()) === PRIVATE, 5000);
check('an address inside a private network is refused by the server, said in the step', (await stepAlert()) === PRIVATE && (await hookSteps()).length === 0, await stepAlert());
await page.getByLabel('Web address').fill('https://hooks.example.org/catch/e2e?from=base');
check('the refusal goes once the address is changed', (await page.locator('.lad-new-step .lad-step-form > .error').count()) === 0);
await page.getByRole('button', { name: 'More details' }).click();
await sleep(200);
check('the signing secret is not on the page until asked for', !/sbw_[0-9a-f]{8}/.test(await page.content()));
// Send a test: one message about a made-up person to the address as typed, before the step is saved.
const testSaid = async () => ((await page.locator('.lad-hook-more .lad-hook-said').first().innerText().catch(() => '')) || '').trim();
const hooksGot = async () => (HOOKS ? (await (await fetch(`${HOOKS}/__received`)).json()).filter((x) => x.path === '/catch/e2e?from=base' && x.body?.campaign === me.workspace.name) : []);
await page.getByRole('button', { name: 'Send a test' }).click();
await until(testSaid, 12000);
check('Send a test keeps the keyboard’s place while it sends and after', (await focused()) === 'Send a test', await focused());
if (!HOOKS) {
  // No stand-in receiver: the name is looked up, and hooks.example.org is no one's.
  check('Send a test answers in place (no stand-in: the address is looked up first)', /^(We couldn’t find hooks\.example\.org — check the address|Sent · \d+|Failed · .+|Answered with a redirect .+)$/.test(await testSaid()), await testSaid());
} else {
  check('Send a test: "Sent · 200", in place', (await testSaid()) === 'Sent · 200', await testSaid());
  const tests = await hooksGot();
  check('the address got one message about a made-up person, marked a test', tests.length === 1 && tests[0].body.test === true && tests[0].body.person.first_name === 'Sam'
    && tests[0].body.person.email === 'sam@example.org' && tests[0].body.step === 'Zapier' && /^Test · Tell the team: Sam Example — /.test(tests[0].body.text), JSON.stringify(tests[0]?.body).slice(0, 200));
  await fetch(`${HOOKS}/__answer`, { method: 'POST', body: JSON.stringify({ status: 500, times: 1 }) });
  await page.getByRole('button', { name: 'Send a test' }).click();
  await until(async () => (await testSaid()) === 'Failed · 500', 8000);
  check('an address that is down: "Failed · 500"', (await testSaid()) === 'Failed · 500', await testSaid());
  check('a test puts no one on the ladder and saves no step', (await D.api(`/ladders/${told.id}`)).json.people.length === 0 && (await hookSteps()).length === 0);
}
await page.getByRole('button', { name: 'Show secret' }).click();
await page.waitForSelector('.lad-hook-secret__code', { timeout: 8000 }).catch(() => {});
await sleep(150);
const shown = ((await page.locator('.lad-hook-secret__code').innerText().catch(() => '')) || '').trim();
check('Show secret: the campaign’s own (= server), the keyboard on Copy', /^sbw_[0-9a-f]{64}$/.test(shown) && shown === (await D.api('/actions/ladder.signingSecret', {})).json.secret
  && (await focused()) === 'Copy', `${shown.slice(0, 12)} · ${await focused()}`);
await simple(page, 'builder, signing secret shown (desktop)');
await D.shot('13-web-address-step');
await page.setViewportSize({ width: 390, height: 844 });
await sleep(300);
await simple(page, 'builder, signing secret shown (phone)');
await page.locator('.lad-new-step').scrollIntoViewIfNeeded();
await D.shot('13b-web-address-step-phone');
await page.setViewportSize({ width: 1360, height: 900 });
// Make a new secret: asked once more in place, then the old one is gone.
await page.getByRole('button', { name: 'Make a new secret' }).click();
await sleep(200);
check('Make a new secret asks first, in place', /Make a new secret\? The old one stops working\./.test(await page.locator('.lad-hook-secret').innerText()) && (await focused()) === 'No', await focused());
await page.locator('.lad-hook-secret').getByRole('button', { name: 'Yes' }).click();
await until(async () => ((await page.locator('.lad-hook-secret__code').innerText().catch(() => '')) || '').trim() !== shown, 8000);
const secret = ((await page.locator('.lad-hook-secret__code').innerText().catch(() => '')) || '').trim();
check('Yes: a new secret, the campaign’s own from now on (= server)', /^sbw_[0-9a-f]{64}$/.test(secret) && secret !== shown
  && secret === (await D.api('/actions/ladder.signingSecret', {})).json.secret && /New secret — the old one no longer works\./.test(await page.locator('.lad-hook-secret').innerText()), secret.slice(0, 12));
await D.shot('13e-new-secret');
await page.getByRole('button', { name: 'Hide' }).click();
await sleep(150);
check('Hide takes it off the page, the keyboard back on Show secret', !/sbw_[0-9a-f]{8}/.test(await page.content()) && (await focused()) === 'Show secret', await focused());
await page.getByRole('button', { name: 'Add step' }).click();
// Saved, or said why not: the server may look the name up for a few seconds first.
const NOT_FOUND = 'We couldn’t find hooks.example.org — check the address';
await until(async () => (await hookSteps()).length === 1 || (await stepAlert()) !== '', 8000);
if (!HOOKS) {
  // No stand-in receiver: the server looks the name up, and hooks.example.org is no one's.
  const said = await stepAlert();
  const kept = await hookSteps();
  check('with no stand-in the name is looked up: saved, or "We couldn’t find …" in the step',
    (kept.length === 1 && !said) || (kept.length === 0 && said === NOT_FOUND), `${kept.length} saved · ${said}`);
} else {
  const kept = await hookSteps();
  check('saved: the address and its label', kept.length === 1 && kept[0].url === 'https://hooks.example.org/catch/e2e?from=base' && kept[0].label === 'Zapier', JSON.stringify(kept));
  await sleep(400);
  const card = page.locator('.lad-step', { hasText: 'Send to a web address' });
  const who = ((await card.locator('.lad-step__who').innerText().catch(() => '')) || '').trim();
  check('the card: "Send to a web address · Zapier", where it goes by the site’s name only, in one short line',
    (await card.locator('.lad-step__line').innerText()).trim() === 'Send to a web address · Zapier'
    && who === 'To hooks.example.org · no ratings, notes or money', who);
  // In the saved card too, a refusal is said in the step, clear of the button under it.
  await card.locator('.ops-row').click();
  await card.getByLabel('Web address').fill('https://10.1.2.3/x');
  await card.getByRole('button', { name: 'Save step' }).click();
  await until(async () => (await card.locator('.lad-step-form > .error').count()) === 1, 5000);
  const gap = await card.evaluate((el) => {
    const e = el.querySelector('.lad-step-form > .error');
    const b = [...el.querySelectorAll('.ops-actions button')].find((x) => x.innerText.trim() === 'Save step');
    return e && b ? Math.round(b.getBoundingClientRect().top - e.getBoundingClientRect().bottom) : null;
  });
  check('an open card: the refusal is in the card, clear of Save step', ((await card.locator('.lad-step-form > .error').innerText().catch(() => '')) || '').trim() === PRIVATE && gap >= 8, `${gap}px`);
  await card.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Turn on' }).click();
  await sleep(800);
  // Hana said yes to email; Ivo never did.
  await D.api('/actions/subscription.add', { email: `hana.${tag}@example.org`, name: 'Hana Example' });
  const hana = (await D.api('/actions/person.create', { name: 'Hana Example', email: `hana.${tag}@example.org`, phone: '604-555-0171', postal: 'V3T 1V8', tags: ['new-signer'] })).json.person;
  const ivo = (await D.api('/actions/person.create', { name: 'Ivo Example', email: `ivo.${tag}@example.org`, tags: ['new-signer'] })).json.person;
  const received = async () => (await hooksGot()).filter((x) => !x.body.test);
  const got = await until(async () => { const all = await received(); return all.length >= 2 ? all : null; });
  const of = (p) => (got || []).find((x) => x.body.person.id === p.id);
  check('the address got one message for each', got?.length === 2 && !!of(hana) && !!of(ivo), `${got?.length}`);
  check('signed with the new secret the screen showed, over the bytes received — not with the one before', !!of(hana) && verifySignature(of(hana).raw, of(hana).headers['base-signature'], [secret]).ok
    && !verifySignature(`${of(hana).raw} `, of(hana).headers['base-signature'], [secret]).ok && !verifySignature(of(hana).raw, of(hana).headers['base-signature'], [shown]).ok);
  check('what it says: what started the ladder, the ladder, the label, the person', of(hana)?.body.event === 'tag' && of(hana).body.ladder === 'Tell the team'
    && of(hana).body.step === 'Zapier' && of(hana).body.person.first_name === 'Hana' && of(hana).body.person.postal === 'V3T 1V8', JSON.stringify(of(hana)?.body).slice(0, 200));
  check('Hana said yes to email: her email and mobile; Ivo never did: no email', of(hana)?.body.person.email === `hana.${tag}@example.org` && of(hana).body.person.phone === '+16045550171'
    && of(ivo)?.body.person.email === null && !of(ivo).raw.includes(`ivo.${tag}`), JSON.stringify([of(hana)?.body.person.email, of(ivo)?.body.person.email]));
  const doneRuns = async () => (await D.api(`/ladders/${told.id}`)).json.people.filter((p) => p.status === 'done');
  await until(async () => (await doneRuns()).length === 2);
  await D.go(`/ladders/${told.id}`);
  await page.getByRole('button', { name: /^Finished · / }).click().catch(() => {});
  await sleep(300);
  await page.locator('.lad-sec .ops-row', { hasText: 'Hana Example' }).click();
  await sleep(300);
  const hlog = (await page.locator('.lad-log li').allInnerTexts()).map((x) => x.replace(/\s+/g, ' '));
  check('her log: "Zapier: Sent · 200"', hlog.some((x) => /^Zapier: Sent · 200/.test(x)), hlog.join(' | '));
  await D.shot('13c-web-address-sent');
  // Someone marked do-not-contact is never sent; an address that answers with a redirect is handed it once.
  await D.api('/actions/person.create', { name: 'Kai Example', tags: ['new-signer', 'do-not-contact'] });
  await until(async () => (await doneRuns()).length === 3);
  await fetch(`${HOOKS}/__answer`, { method: 'POST', body: JSON.stringify({ status: 302, times: 1 }) });
  await D.api('/actions/person.create', { name: 'Lia Example', tags: ['new-signer'] });
  await until(async () => (await doneRuns()).length === 4);
  // Taken off while the address is being called: the row says so, and the late answer promises no other try.
  await fetch(`${HOOKS}/__hold`, { method: 'POST', body: JSON.stringify({ times: 1 }) });
  const moe = (await D.api('/actions/person.create', { name: 'Moe Example', tags: ['new-signer'] })).json.person;
  await until(async () => (await received()).some((x) => x.body.person.id === moe.id));
  const moeRun = (await D.api(`/ladders/${told.id}`)).json.people.find((p) => p.person.id === moe.id);
  await D.api('/actions/ladder.stopRun', { id: moeRun.id });
  await fetch(`${HOOKS}/__release`, { method: 'POST', body: JSON.stringify({ status: 500 }) });
  await until(async () => (await D.api(`/ladders/${told.id}`)).json.people.find((p) => p.person.id === moe.id)?.log.some((e) => e.kind === 'webhook' && e.result === 'failed'));
  await D.go(`/ladders/${told.id}`);
  await page.getByRole('button', { name: /^Finished · / }).click().catch(() => {});
  await sleep(300);
  const rowOf = async (who) => ((await page.locator('#lad-done .ops-row', { hasText: who }).innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
  check('do-not-contact: the row says they were not sent, and why', (await rowOf('Kai Example')) === 'Kai Example Finished · not sent to Zapier (do not contact)', await rowOf('Kai Example'));
  check('a redirect: the row says so', (await rowOf('Lia Example')) === 'Lia Example Finished · Zapier answered with a redirect', await rowOf('Lia Example'));
  check('taken off mid-send: the row says "Taken off"', (await rowOf('Moe Example')) === 'Moe Example Taken off · not sent to Zapier', await rowOf('Moe Example'));
  await page.locator('#lad-done .ops-row', { hasText: 'Lia Example' }).click();
  await sleep(300);
  let llog = (await page.locator('.lad-log li').allInnerTexts()).map((x) => x.replace(/\s+/g, ' '));
  check('a redirect is not followed and not tried again: one line on her log, one copy at the address',
    llog.filter((x) => /^Zapier: /.test(x)).length === 1 && /^Zapier: Answered with a redirect \(302\) — not followed/.test(llog.find((x) => /^Zapier: /.test(x)) || '')
    && (await received()).filter((x) => x.body.person.first_name === 'Lia').length === 1, llog.join(' | '));
  await page.locator('#lad-done .ops-row', { hasText: 'Lia Example' }).click();
  await page.locator('#lad-done .ops-row', { hasText: 'Moe Example' }).click();
  await sleep(300);
  llog = (await page.locator('.lad-log li').allInnerTexts()).map((x) => x.replace(/\s+/g, ' '));
  check('his log: "Taken off", then what the address answered — no "trying again"', llog.some((x) => /^Taken off/.test(x)) && llog.some((x) => /^Zapier: Failed · 500/.test(x)) && !llog.some((x) => /trying again/.test(x)), llog.join(' | '));
  await D.shot('13f-web-address-rows');
  // An address that is slow to answer holds nothing behind it: while it is
  // being called, another ladder's step runs (the job runner isn't made to wait).
  const quick = (await D.api('/actions/ladder.create', { name: 'Quick tag', trigger: { kind: 'tag', ref: 'quick-one' }, steps: [{ kind: 'tag', tag: 'quick-done' }] })).json.ladder;
  await D.api('/actions/ladder.setActive', { id: quick.id, active: true });
  await fetch(`${HOOKS}/__hold`, { method: 'POST', body: JSON.stringify({ times: 1 }) });
  const ned = (await D.api('/actions/person.create', { name: 'Ned Example', tags: ['new-signer'] })).json.person;
  await until(async () => (await received()).some((x) => x.body.person.id === ned.id)); // the address has it, and says nothing yet
  const olaAt = Date.now();
  const ola = (await D.api('/actions/person.create', { name: 'Ola Example', tags: ['quick-one'] })).json.person;
  const olaDone = await until(async () => (await D.api(`/persons/${ola.id}`)).json.person.tags.includes('quick-done'), 3500);
  const nedNow = (await D.api(`/ladders/${told.id}`)).json.people.find((p) => p.person.id === ned.id);
  check('while a slow address is being called, another ladder’s step runs — the runner doesn’t wait for the answer', !!olaDone && nedNow?.wait === 'sending',
    `${olaDone ? `ran after ${Date.now() - olaAt} ms` : 'not within 3.5 s'} · Ned: ${nedNow?.wait}`);
  await fetch(`${HOOKS}/__release`, { method: 'POST', body: JSON.stringify({ status: 200 }) });
  await until(async () => (await D.api(`/ladders/${told.id}`)).json.people.find((p) => p.person.id === ned.id)?.status === 'done');
  await D.api('/actions/ladder.setActive', { id: quick.id, active: false });
  // An address that is down: the first failure is said at once (the next tries are a minute, then five, away).
  await fetch(`${HOOKS}/__answer`, { method: 'POST', body: JSON.stringify({ status: 500, times: 1 }) });
  const jun = (await D.api('/actions/person.create', { name: 'Jun Example', tags: ['new-signer'] })).json.person;
  const waiting = await until(async () => (await D.api(`/ladders/${told.id}`)).json.people.find((p) => p.person.id === jun.id && p.wait === 'retry'));
  await D.go(`/ladders/${told.id}`);
  t = await D.text();
  check('a failing address: "The web address didn’t take it — trying again" (server and screen)', !!waiting && /Jun Example The web address didn’t take it — trying again/.test(t), t.slice(t.indexOf('People'), t.indexOf('People') + 160));
  await page.locator('.lad-sec .ops-row', { hasText: 'Jun Example' }).click();
  await sleep(300);
  const jlog = (await page.locator('.lad-log li').allInnerTexts()).map((x) => x.replace(/\s+/g, ' '));
  check('his log: "Zapier: Didn’t go (500) — trying again"', jlog.some((x) => /^Zapier: Didn’t go \(500\) — trying again/.test(x)), jlog.join(' | '));
  await D.shot('13d-web-address-retry');
  await D.api('/actions/ladder.setActive', { id: told.id, active: false });
}

// A tab left open from before this step shows it as a Stop. What its "Save
// step" and "Remove step" on that card would send (a Stop in the step's
// place, or the steps without it, and no word on which kinds it knows) is
// refused, in words that page shows as they are.
const RELOAD = 'Reload this page — it’s out of date and shows this step wrongly';
const asSaved = (await D.api(`/ladders/${told.id}`)).json.ladder.steps;
const hookAt = asSaved.findIndex((x) => x.kind === 'webhook');
if (hookAt >= 0) {
  const stopOver = await D.api('/actions/ladder.update', { id: told.id, steps: asSaved.map((x, i) => (i === hookAt ? { kind: 'stop' } : x)) });
  const takenOut = await D.api('/actions/ladder.update', { id: told.id, steps: asSaved.filter((_, i) => i !== hookAt) });
  const still = (await D.api(`/ladders/${told.id}`)).json.ladder.steps;
  check('a page from before this step can’t save a Stop over it or take it away: it is told to reload',
    stopOver.status === 409 && stopOver.json.error === RELOAD && takenOut.status === 409 && takenOut.json.error === RELOAD
    && JSON.stringify(still) === JSON.stringify(asSaved), `${stopOver.status} ${takenOut.status} ${stopOver.json?.error || ''}`);
}

// A step kind this page doesn't know (a tab left open from before a release
// that added one): the card says so, and saving it hands the step back as
// it is — never as a Stop.
const later = { kind: 'call', number: '604-555-0100', after: 2 };
await page.route(`**/api/ladders/${told.id}`, async (route) => {
  const res = await route.fetch();
  const body = await res.json();
  body.ladder.steps = [...body.ladder.steps, later];
  await route.fulfill({ response: res, json: body });
});
await D.go(`/ladders/${told.id}`);
const odd = page.locator('.lad-step', { hasText: 'A step this page doesn’t know — reload' });
check('a step kind the page doesn’t know says so (not "Stop")', (await odd.count()) === 1 && (await page.locator('.lad-step', { hasText: /^\d+\s*Stop$/ }).count()) === 0);
await odd.locator('.ops-row').click();
await sleep(300);
const [saving] = await Promise.all([
  page.waitForRequest((r) => r.url().endsWith('/api/actions/ladder.update') && r.method() === 'POST', { timeout: 8000 }).catch(() => null),
  odd.getByRole('button', { name: 'Save step' }).click(),
]);
const savedSteps = saving?.postDataJSON()?.steps || [];
check('saving its card hands it back exactly as it is', JSON.stringify(savedSteps.at(-1)) === JSON.stringify(later) && !savedSteps.some((x) => x.kind === 'stop'), JSON.stringify(savedSteps.at(-1)));
const knows = saving?.postDataJSON()?.knows || [];
check('each save names the step kinds the page has words for (not the one it doesn’t know)', knows.includes('webhook') && knows.includes('stop') && !knows.includes('call'), JSON.stringify(knows));
await page.unroute(`**/api/ladders/${told.id}`);

// ── 13. The books still verify ──
const v = (await D.api('/audit/verify')).json;
check('hash chain verifies (ladder steps included)', v.ok === true && v.checked > 10, JSON.stringify(v));
const ev = (await D.api('/events?since=0&limit=1000')).json.events;
check('ladder steps are on the chain as the system', ev.some((e) => e.action === 'ladder.step' && e.actor_id === null && e.entity_type === 'ladder_followup'));
check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
const fails = results.filter((x) => !x).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
