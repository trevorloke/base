// Relationships E2E — one fresh in-memory campaign with the Imagine Surrey
// sample loaded. A manager at a desk (1360) finds People → More → Most
// connected (Priya Nair first, "knows 6 · N supporters" as the server counts
// them), opens a profile's Knows (Brought in by, a nudge naming a supporter
// who knows an undecided voter — no guessed pronouns), adds someone they know
// from the directory and removes them in place. Priya, a sample volunteer,
// signs in on a 390×844 phone: Today has one yellow button and a quiet "My
// people · 6"; My people lists her six with their rating chips; she opens one,
// talks in person, rates them (a contact with channel in_person, counted on
// Today), adds someone new (brought in by her) and — with no signal — someone
// else, sent once when the signal is back; her browser never receives anyone
// else's email or a money tag, and the desk reads stay closed to her. Calls
// links to My people. Both roles are measured at 390 and 1360 (visible words,
// one yellow button at most, no sideways scroll, 48px targets). The books
// still verify. Then the ties that matter: a desk profile's key line (Priya:
// her close tie first, "Same address" without the do-not-contact housemate)
// at 1440 and 390, Close in place, Make a list ("Priya Nair’s circle", as many
// as she knows), People → Knows a supporter (the server's count), the rule
// builder, a staff member denied Donations (no "Knows a donor"), the desk
// Calls card's "Knows …", Most connected's "brought in", and Priya at a
// walk-list door with no signal: More → "I know them" → Friend — the chip at
// once, sent once — while her browser never gets a desk tie read.
//
//   STARBASE_OPEN_SIGNUP=1 STARBASE_DATA=memory PORT=5100 node server/index.js &
//   BASE=http://127.0.0.1:5100 SHOTS=/tmp/relationships node e2e-relationships.mjs
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:3200';
const ADMIN = { toString() { return `${BASE}/admin`; } }; // the desk's pages live in the admin (web/src/mode.js)
const SHOTS = process.env.SHOTS || '/tmp/starbase-relationships';
mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 240) : ''}`);
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
// A control is 48px wherever a thumb reaches and 40 on a desk with a mouse
// (app.css --ctl): the page itself says which it is.
const tapFloor = (page) => page.evaluate(() => (matchMedia('(min-width: 900px) and (pointer: fine)').matches ? 40 : 48));
const simple = async (page, name, sel = FIELDS) => {
  const m = await measure(page, sel);
  const floor = await tapFloor(page);
  check(`${name}: ≤1 yellow, no sideways scroll, targets ≥${floor}px`, m.yellow <= 1 && m.overflow <= 0 && (m.minTap == null || m.minTap >= floor - 0.5),
    `words=${m.words} yellow=${m.yellow} overflow=${m.overflow} minTap=${m.minTap} ${m.minTap < floor - 0.5 ? m.minWho : ''}`);
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
const PRONOUN = /\b(he|she|his|her|hers|him)\b/i;
// The words as written (innerText follows CSS uppercase on buttons and chips).
const it = (p, sel) => p.$eval(sel, (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => '');
const tc = (p, sel) => p.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');

// ── 1. A manager at a desk; the Imagine Surrey sample ──
const dctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, timezoneId: 'America/Vancouver' });
await tiles(dctx);
const page = await dctx.newPage();
const D = helpers(page, 'desk');
await D.go('/signup');
await page.fill('#su-name', 'Riley Manager');
if (await page.locator('#su-org').count()) await page.fill('#su-org', 'Imagine Surrey');
await page.fill('#su-email', `riley+${tag}@relationships.example`);
await page.fill('#su-password', 'surrey-forward-2026');
await page.click('button[type="submit"]');
await page.waitForURL(/\/admin\/?$/, { timeout: 15000 });
await page.click('button:has-text("Load sample data")');
await until(async () => (await D.api('/brief')).json?.sampleLoaded);
check('sample loaded', (await D.api('/brief')).json.sampleLoaded === true);
const byName = async (name) => (await D.api(`/persons?q=${encodeURIComponent(name)}`)).json.persons.find((p) => p.name === name);

// ── 2. People → More → Most connected ──
await D.go('/people');
await page.click('.pp-menu button:has-text("More")');
const mc = await page.$('.pp-menu__panel a[href="/admin/people/connected"]');
check('People → More lists "Most connected"', !!mc && /Most connected/.test(await mc.textContent()));
await mc.click();
await page.waitForURL(`${ADMIN}/people/connected`);
await page.waitForSelector('.ops-row', { timeout: 8000 }).catch(() => {});
const apiConnected = (await D.api('/relationships/connected')).json.people;
const shown = await page.$$eval('.ops-row', (els) => els.map((e) => ({
  name: e.querySelector('.ops-row__name')?.innerText, fact: e.querySelector('.ops-row__sub')?.innerText,
})));
const plural = (n, one) => `${n} ${n === 1 ? one : `${one}s`}`;
check('Most connected: Priya Nair first, knows 6', apiConnected[0]?.name === 'Priya Nair' && apiConnected[0].knows === 6, JSON.stringify(apiConnected[0]));
check('each row says "knows N · M supporters" as the server counts them',
  shown.length === apiConnected.length && shown.every((s, i) => s.name === apiConnected[i].name && s.fact === `knows ${apiConnected[i].knows} · ${plural(apiConnected[i].supporters, 'supporter')}${apiConnected[i].brought_in ? ` · brought in ${apiConnected[i].brought_in}` : ''}`),
  `${shown.slice(0, 3).map((s) => `${s.name}: ${s.fact}`).join(' | ')}`);
let m = await simple(page, 'Most connected (desk 1360)');
check('Most connected: no yellow button (nothing to do but look)', m.yellow === 0);
await D.shot('01-most-connected-desk');

// ── 3. A profile's Knows: the nudge, Brought in by, add and remove in place ──
const jasmine = await byName('Jasmine Wong');
const priya = await byName('Priya Nair');
const jk = (await D.api(`/persons/${jasmine.id}/knows`)).json;
await D.go(`/people/${jasmine.id}`);
const nudge = await page.innerText('.rel-nudge').catch(() => '');
const undecided = jasmine.rating == null || jasmine.rating === '3';
check('undecided Jasmine: "Ask Priya Nair — they know each other"', undecided && nudge.trim() === 'Ask Priya Nair — they know each other' && jk.nudge?.id === priya.id, `${jasmine.rating} · ${nudge}`);
check('the nudge guesses no pronoun', !PRONOUN.test(nudge));
await page.click('.pf-sec__btn:has-text("Knows")');
await sleep(300);
const knowsRows = async () => page.$$eval('.rel-knows li', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
let rows = await knowsRows();
check('Knows lists who Jasmine knows: Priya Nair · Neighbour', rows.length === jk.knows.length && /Priya Nair Neighbour/.test(rows[0] || ''), rows.join(' | '));
const knowsCount = await page.innerText('.pf-sec__btn:has-text("Knows") .pf-sec__count').catch(() => '');
check('the section count is the server’s', knowsCount === String(jk.knows.length), knowsCount);
await page.click('button:has-text("+ Someone they know")');
await page.fill('.rel-add input[type="search"]', 'Maya');
await page.waitForSelector('.rel-pick:has-text("Maya Chen")', { timeout: 8000 }).catch(() => {});
m = await simple(page, 'Knows: search the list (desk 1360)');
await page.click('.rel-pick:has-text("Maya Chen")');
const q = await page.innerText('.rel-add__q').catch(() => '');
check('then: "Maya Chen — how do they know each other?" (no pronoun guessed)', q === 'Maya Chen — how do they know each other?' && !PRONOUN.test(q), q);
await page.click('.rel-kind:has-text("Friend")');
await until(async () => (await D.api(`/persons/${jasmine.id}/knows`)).json.knows.length === jk.knows.length + 1);
let after = (await D.api(`/persons/${jasmine.id}/knows`)).json.knows;
const maya = await byName('Maya Chen');
check('added: Jasmine knows Maya Chen (Friend), on the server', after.some((k) => k.person.id === maya.id && k.kind === 'friend'), after.map((k) => k.person.name).join());
await sleep(500);
rows = await knowsRows();
check('…and on the screen', rows.some((r) => /Maya Chen Friend/.test(r)), rows.join(' | '));
const mayaKnows = (await D.api(`/persons/${maya.id}/knows`)).json.knows;
check('…both ways: Maya’s profile knows Jasmine', mayaKnows.some((k) => k.person.id === jasmine.id));
await D.shot('02-profile-knows-desk');
await page.click(`.rel-knows li:has-text("Maya Chen") button:has-text("Remove")`);
check('Remove asks in place: "Remove? Yes · No"', /Remove\? ?Yes ?No/.test(await tc(page, '.rel-knows li:has-text("Maya Chen") .rel-confirm')), await tc(page, '.rel-knows li:has-text("Maya Chen")'));
await page.click('.rel-knows li:has-text("Maya Chen") button:has-text("Yes")');
await until(async () => (await D.api(`/persons/${jasmine.id}/knows`)).json.knows.length === jk.knows.length);
after = (await D.api(`/persons/${jasmine.id}/knows`)).json.knows;
check('removed: off the server', !after.some((k) => k.person.id === maya.id));
await sleep(500);
check('…and off the screen', !(await knowsRows()).some((r) => /Maya Chen/.test(r)));
m = await simple(page, 'profile with Knows open (desk 1360)');
check('the link’s note shows beside its kind: "Neighbour · Same block"', rows.some((r) => /Priya Nair Neighbour · Same block/.test(r)) || (await knowsRows()).some((r) => /Priya Nair Neighbour · Same block/.test(r)), (await knowsRows()).join(' | '));

// Knows with no signal (desk): its writes are off and say so; the search says it needs signal.
await page.click('button:has-text("+ Someone they know")');
await sleep(1500); // the profile's Knows is kept a moment after it loads
await dctx.setOffline(true);
await page.fill('.rel-add input[type="search"]', 'Harjit');
await sleep(800);
let addText = await tc(page, '.rel-add');
check('no signal: "+ Someone they know" search says "Adding someone they know needs signal"', /Adding someone they know needs signal/.test(addText) && !/No one matches|Harjit Gill/.test(addText), addText);
await page.click('.rel-add button:has-text("Cancel")');
check('…"+ Someone they know", Remove and Close are off, said once: "Adding, removing and Close need signal"',
  await page.locator('button:has-text("+ Someone they know")').isDisabled() && await page.locator('.rel-knows li button:has-text("Remove")').first().isDisabled()
  && /Adding, removing and Close need signal/.test(await tc(page, '.pf-row-acts')), await tc(page, '.pf-row-acts'));
await D.shot('02b-knows-no-signal-desk');
// Through a reload with no signal: the kept Knows and the nudge, never "Loading…".
await D.go(`/people/${jasmine.id}`);
await page.waitForSelector('.pf-page h1', { timeout: 8000 }).catch(() => {});
check('reload with no signal: the nudge is still there', (await page.innerText('.rel-nudge').catch(() => '')).trim() === 'Ask Priya Nair — they know each other');
await page.click('.pf-sec__btn:has-text("Knows")');
await sleep(400);
rows = await knowsRows();
check('…Knows from its kept copy (no "Loading…")', rows.some((r) => /Priya Nair Neighbour · Same block/.test(r)) && !/Loading…/.test(await D.text()), rows.join(' | ') || (await D.text()).slice(0, 200));
m = await simple(page, 'profile Knows, no signal (desk 1360)');
await dctx.setOffline(false);
await sleep(1500);
// Do not contact: no nudge to reach them through a friend.
await D.api('/actions/person.update', { id: jasmine.id, tags: [...(jasmine.tags || []), 'do-not-contact'] });
await D.go(`/people/${jasmine.id}`);
await page.waitForSelector('.pf-page h1', { timeout: 8000 }).catch(() => {});
check('tagged do-not-contact: no "Ask … — they know each other"', !(await page.$('.rel-nudge')) && /Do not contact/i.test(await D.text()), (await D.text()).slice(0, 160));
await D.api('/actions/person.update', { id: jasmine.id, tags: jasmine.tags || [] });

const sofia = await byName('Sofia Petrova');
await D.go(`/people/${sofia.id}`);
await page.click('.pf-sec__btn:has-text("Knows")');
await sleep(300);
check('Sofia: "Brought in by Priya Nair"', (await page.innerText('.rel-by').catch(() => '')).trim() === 'Brought in by Priya Nair');
const rated1 = (await D.api('/persons?rating=1&limit=200')).json.persons.find((p) => p.name === 'Kwame Mensah');
if (rated1) {
  await D.go(`/people/${rated1.id}`);
  check('a strong yes gets no nudge', !(await page.$('.rel-nudge')));
}
// Money tag on someone Priya knows: her browser must never get it.
const daniel = await byName('Daniel Kim');
await D.api('/actions/person.update', { id: daniel.id, tags: [...daniel.tags, 'lapsed'] });

// ── 4. Priya, a sample volunteer, on her phone ──
const invite = (await D.api('/actions/member.invite', { email: 'priya.nair@example.org', role: 'volunteer' })).json;
check('Priya invited as a volunteer', /\/join\/[0-9a-f]{48}$/.test(invite.joinUrl || ''), invite.email);
const vctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/Vancouver' });
await tiles(vctx);
const vpage = await vctx.newPage();
// Her browser never receives anyone else's ties: no answered desk read, ever.
const leaks = [];
vpage.on('response', (r) => { if (/\/api\/(relationships\/(key|connected)|persons\/[0-9a-f-]{36}\/knows)/.test(r.url()) && r.status() < 400) leaks.push(`${r.status()} ${r.url()}`); });
const V = helpers(vpage, 'vol');
await V.go('/login');
const joined = await V.api('/auth/join', { token: invite.joinUrl.split('/').pop(), name: 'Priya Nair', password: 'knock-knock-2026' });
check('Priya joined', joined.status === 200 && joined.json.role === 'volunteer', joined.status);
await V.go('/');
await vpage.waitForSelector('a[href="/my-people"]', { timeout: 8000 }).catch(() => {});
let mine = (await V.api('/relationships/mine')).json;
check('her own record is the sample’s Priya Nair: six people', mine.me?.id === priya.id && mine.people.length === 6, JSON.stringify(mine.me));
const row = await tc(vpage, 'a[href="/my-people"]');
check('Today: a quiet "My people · 6" row', /^My people · 6/.test(row), row);
const yellows = await vpage.$$eval('.btn-primary', (els) => els.filter((e) => e.getBoundingClientRect().width > 0).map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
check('Today keeps one yellow button: Start canvassing', yellows.length === 1 && /Start canvassing/.test(yellows[0]), yellows.join(' | '));
m = await simple(vpage, 'volunteer Today (390)');
await V.shot('03-today-phone');

await vpage.click('a[href="/my-people"]');
await vpage.waitForURL(`${BASE}/my-people`);
await vpage.waitForSelector('.ops-row', { timeout: 8000 }).catch(() => {});
const names = await vpage.$$eval('.ops-row .ops-row__name', (els) => els.map((e) => e.innerText));
check('My people: her six, as the server has them', names.join('|') === mine.people.map((x) => x.person.name).join('|'), names.join('|'));
const chips = await vpage.$$eval('.ops-row .rb-chip', (els) => els.length);
check('each with a rating chip', chips === 6, chips);
check('a link’s note shows on the row: "Neighbour · Same block"', /Neighbour · Same block/.test(await tc(vpage, '.ops-row:has-text("Jasmine Wong") .ops-row__sub')), await tc(vpage, '.ops-row:has-text("Jasmine Wong") .ops-row__sub'));
check('back link says "← Today"', (await tc(vpage, '.ops-back')) === '← Today');
m = await simple(vpage, 'My people (volunteer 390)');
check('My people: one yellow "Add someone"', m.yellow === 1 && (await tc(vpage, '.btn-primary')) === 'Add someone');
await V.shot('04-my-people-phone');
const raw = (await V.api('/relationships/mine')).raw;
check('her browser gets no one else’s email', !/@/.test(raw), (raw.match(/[^"]*@[^"]*/) || [''])[0]);
check('…and no money tag (Daniel’s "lapsed")', !/lapsed|donor/i.test(raw));

// Open Jasmine; talk in person; rate.
await vpage.click('.ops-row:has-text("Jasmine Wong")');
await vpage.waitForSelector('.rel-reach', { timeout: 5000 }).catch(() => {});
const ways = await vpage.$$eval('.rel-how button', (els) => els.map((e) => e.textContent.trim()));
check('how you talked: Phone · Text · In person', ways.join(' · ') === 'Phone · Text · In person', ways.join(' · '));
check('Phone shows the Calls card’s Call button', /Call Jasmine/.test(await tc(vpage, '.rel-reach')));
await vpage.click('.rel-how button:has-text("In person")');
check('In person: no Call button, no "No answer"', !/Call Jasmine|No answer/i.test(await tc(vpage, '.rel-reach')) && /Strong yes/.test(await tc(vpage, '.rel-reach')));
m = await simple(vpage, 'My people, a person open (volunteer 390)');
await V.shot('05-reach-in-person-phone');
const briefBefore = (await D.api('/brief')).json;
await vpage.click('.rel-reach .rb-btn[aria-label^="1:"]');
await vpage.waitForSelector('.rel-reach .pf-status', { timeout: 8000 }).catch(() => {});
const said = (await vpage.innerText('.rel-reach .pf-status').catch(() => '')).trim();
check('the line says what was logged: "✓ In person · Rated 1 · Strong yes"', said === '✓ In person · Rated 1 · Strong yes', said);
const jprof = (await D.api(`/persons/${jasmine.id}`)).json;
check('on the server: a contact by Priya, in person, rated 1', jprof.contacts[0]?.channel === 'in_person' && jprof.contacts[0].rating === '1' && jprof.person.rating === '1', JSON.stringify(jprof.contacts[0]));
const briefAfter = (await D.api('/brief')).json;
check('Today counts it: in person +1, the week +1, doors unchanged',
  briefAfter.inPerson.week === briefBefore.inPerson.week + 1 && briefAfter.field.week === briefBefore.field.week + 1 && briefAfter.field.doors === briefBefore.field.doors,
  `${JSON.stringify(briefBefore.inPerson)} ${JSON.stringify(briefBefore.field)} → ${JSON.stringify(briefAfter.inPerson)} ${JSON.stringify(briefAfter.field)}`);
await sleep(800);
const jchip = await vpage.innerText('.ops-row:has-text("Jasmine Wong") .rb-chip').catch(() => '');
check('her chip now reads 1', jchip.trim() === '1', jchip);
// The desk's profile says how: "In person".
await D.go(`/people/${jasmine.id}`);
check('the desk’s History says "In person"', /^In person/.test(await tc(page, '.timeline li .what')), await tc(page, '.timeline li .what'));
check('the nudge is gone now Jasmine is a strong yes', !(await page.$('.rel-nudge')));
await D.go('/');
await page.click('.today-morebox__toggle');
await sleep(300);
check('desk Today → More: "· 1 in person" this week', /· 1 in person/.test(await page.innerText('.today-morebox__body').catch(() => '')));

// Add someone new.
await vpage.click('button:has-text("Add someone")');
await vpage.waitForSelector('form[aria-label="Add someone you know"]', { timeout: 5000 });
m = await simple(vpage, 'Add someone (volunteer 390)');
check('the form keeps one yellow button', m.yellow === 1 && (await tc(vpage, '.btn-primary')) === 'Add');
await V.shot('06-add-someone-phone');
await vpage.fill('#rel-name', 'Rowan Example');
await vpage.click('.rel-kind:has-text("Neighbour")');
await vpage.click('form[aria-label="Add someone you know"] button[type="submit"]');
check('no phone or email: "Add a phone or an email"', /Add a phone or an email/.test(await vpage.innerText('form[aria-label="Add someone you know"]')));
await vpage.fill('#rel-email', 'typo@');
await vpage.click('form[aria-label="Add someone you know"] button[type="submit"]');
check('an email that isn’t one: "Check the email", nothing saved', /Check the email/.test(await vpage.innerText('form[aria-label="Add someone you know"]')) && (await vpage.$('form[aria-label="Add someone you know"]')));
await vpage.fill('#rel-email', '');
await vpage.fill('#rel-phone', '604-555-0177');
await vpage.click('.rel-moredetails');
await vpage.fill('#rel-note', 'Book club');
await vpage.click('form[aria-label="Add someone you know"] button[type="submit"]');
await vpage.waitForSelector('.ops-done', { timeout: 8000 }).catch(() => {});
check('"✓ Added Rowan Example"', (await vpage.innerText('.ops-done').catch(() => '')).trim() === '✓ Added Rowan Example');
await until(async () => /Book club/.test(await tc(vpage, '.ops-row:has-text("Rowan Example") .ops-row__sub')), 6000);
check('the note they typed shows on the row: "Neighbour · Book club · 604-555-0177"', /^Neighbour · Book club ·\s*604-555-0177$/.test(await tc(vpage, '.ops-row:has-text("Rowan Example") .ops-row__sub')), await tc(vpage, '.ops-row:has-text("Rowan Example") .ops-row__sub'));
const rowan = await byName('Rowan Example');
const rk = rowan && (await D.api(`/persons/${rowan.id}/knows`)).json;
check('on the server: Rowan, brought in by Priya Nair, a neighbour', rk?.brought_in_by?.id === priya.id && rk.knows[0]?.kind === 'neighbour' && rowan.phone === '604-555-0177', JSON.stringify(rk));
check('Rowan opens in place, ready to reach', /Call Rowan/.test(await tc(vpage, '.ops-item[data-open]')));

// With no signal: saved on the phone, sent once when the signal is back.
await vctx.setOffline(true);
await vpage.click('button:has-text("Add someone")');
await vpage.fill('#rel-name', 'Quinn Example');
await vpage.fill('#rel-phone', '604-555-0178');
await vpage.click('.rel-kind:has-text("Friend")');
await vpage.click('form[aria-label="Add someone you know"] button[type="submit"]');
await sleep(600);
check('offline: "Quinn Example · Saved offline"', /Quinn Example · Saved offline/.test(await vpage.innerText('.ops-done').catch(() => '')));
check('…a row marked Offline', /Quinn Example ?Friend ?Offline/.test(await tc(vpage, '.ops-item:has-text("Quinn Example")')), await tc(vpage, '.ops-item:has-text("Quinn Example")'));
check('…nothing on the server yet', !(await byName('Quinn Example')));
const strip = await tc(vpage, '.offline-strip');
check('the strip lists it as saved on this phone', /1 saved on this phone/i.test(strip), strip);
await V.shot('07-offline-add-phone');
await vpage.click('.offline-strip__chip');
await vpage.waitForSelector('.obx-sheet', { timeout: 3000 }).catch(() => {});
const sheet = await vpage.$$eval('.obx-sheet .obx-row', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
check('the sheet says it plainly: "Someone you know · Quinn Example · <time>"', sheet.length === 1 && /^Someone you know · Quinn Example · \d{1,2}:\d{2} (am|pm)$/.test(sheet[0]), sheet.join(' | '));
await vpage.click('.obx-scrim').catch(() => {});
await sleep(300);
// Remove needs signal: said in place, Yes is off.
if (!(await vpage.$('.ops-item[data-open]:has-text("Rowan Example")'))) await vpage.click('.ops-row:has-text("Rowan Example")');
await vpage.click('.ops-item[data-open] .rel-foot button:has-text("Remove")');
check('offline Remove: "Removing needs signal", Yes is off', /Removing needs signal/.test(await tc(vpage, '.ops-item[data-open]'))
  && await vpage.locator('.ops-item[data-open] .rel-foot button:has-text("Yes")').isDisabled(), await tc(vpage, '.ops-item[data-open] .rel-foot'));
await vpage.click('.ops-item[data-open] .rel-foot button:has-text("No")');
// A rating saved offline shows on the row, marked, until it's sent.
await vpage.click('.ops-row:has-text("Daniel Kim")');
await vpage.waitForSelector('.ops-item[data-open]:has-text("Daniel Kim") .rel-reach', { timeout: 5000 }).catch(() => {});
await vpage.click('.ops-item[data-open] .rel-how button:has-text("In person")');
await vpage.click('.ops-item[data-open] .rel-reach .rb-btn[aria-label^="2:"]');
await sleep(500);
const danielEnd = async () => ((await vpage.innerText('.ops-row:has-text("Daniel Kim") .ops-row__end').catch(() => '')) || '').replace(/\s+/g, ' ').trim();
check('offline rating: the row shows it, "2 · Offline"', /^2 Offline$/i.test(await danielEnd()), await danielEnd());
m = await simple(vpage, 'My people, a rating saved offline (volunteer 390)');
await V.shot('07b-offline-rating-phone');
await vctx.setOffline(false);
const quinn = await until(() => byName('Quinn Example'));
check('back online: Quinn reaches the server', !!quinn);
await sleep(1500);
const quinns = (await D.api('/persons?q=Quinn&limit=50')).json.persons.filter((p) => p.name === 'Quinn Example');
const qk = quinn && (await D.api(`/persons/${quinn.id}/knows`)).json;
check('…once: one Quinn, one link to Priya', quinns.length === 1 && qk?.knows.length === 1 && qk.knows[0].person.id === priya.id, `${quinns.length} · ${qk?.knows.length}`);
await until(async () => (await vpage.$$('.ops-row:has-text("Quinn Example")')).length === 1 && !(await vpage.$('.ops-item:has-text("Quinn Example") .chip-warn')));
check('…and My people shows Quinn as one of hers', (await vpage.$$('.ops-row:has-text("Quinn Example")')).length === 1);
check('…the line now says "✓ Added Quinn Example", not "Saved offline"', (await vpage.innerText('.ops-done').catch(() => '')).trim() === '✓ Added Quinn Example', await vpage.innerText('.ops-done').catch(() => ''));
await until(async () => /^2$/.test(await danielEnd()), 8000);
check('…Daniel’s rating sent: the row reads 2, no mark', /^2$/.test(await danielEnd()) && (await D.api(`/persons/${daniel.id}`)).json.person.rating === '2', await danielEnd());
mine = (await V.api('/relationships/mine')).json;
check('My people · 8 now', mine.people.length === 8);

// Refused when it's sent (the server checks an email the form can't): the row says
// "Not saved", the line above it goes, and the sheet says why in their words.
await vctx.setOffline(true);
await vpage.click('button:has-text("Add someone")');
await vpage.fill('#rel-name', 'Pat Typo');
await vpage.fill('#rel-email', 'pat,smith@example.org');
await vpage.click('.rel-kind:has-text("Other")');
await vpage.click('form[aria-label="Add someone you know"] button[type="submit"]');
await sleep(500);
check('offline: "Pat Typo · Saved offline"', /Pat Typo · Saved offline/.test(await vpage.innerText('.ops-done').catch(() => '')));
await vctx.setOffline(false);
await until(async () => /Not saved/i.test(await tc(vpage, '.ops-item:has-text("Pat Typo")')), 15000);
check('refused: the row says "Not saved", and "Saved offline" is gone', /Not saved/i.test(await tc(vpage, '.ops-item:has-text("Pat Typo")'))
  && !/Pat Typo/.test(await vpage.innerText('.ops-done').catch(() => '')), `${await tc(vpage, '.ops-item:has-text("Pat Typo")')} · ${await vpage.innerText('.ops-done').catch(() => '')}`);
await vpage.click('.offline-strip__chip');
await vpage.waitForSelector('.obx-sheet .is-refused', { timeout: 3000 }).catch(() => {});
const why = await tc(vpage, '.obx-sheet .is-refused');
check('the sheet: "Invalid email address", never the field path', /Invalid email address/.test(why) && !/person\.|Person\./.test(why), why);
await vpage.click('.obx-sheet .is-refused button:has-text("Dismiss")');
await vpage.click('.obx-scrim').catch(() => {});
await sleep(300);

// Remove in place.
if (!(await vpage.$('.ops-item[data-open]:has-text("Rowan Example")'))) await vpage.click('.ops-row:has-text("Rowan Example")');
await vpage.click('.ops-item[data-open] .rel-foot button:has-text("Remove")');
check('Remove? Yes · No', /Remove\? ?Yes ?No/.test(await tc(vpage, '.ops-item[data-open] .rel-foot')), await tc(vpage, '.ops-item[data-open] .rel-foot'));
await vpage.click('.ops-item[data-open] .rel-foot button:has-text("Yes")');
await until(async () => !(await vpage.$('.ops-row:has-text("Rowan Example")')));
check('Rowan is off her list (and the server’s)', !(await vpage.$('.ops-row:has-text("Rowan Example")')) && !(await V.api('/relationships/mine')).json.people.some((x) => x.person.name === 'Rowan Example'));
check('…still brought in by Priya on the books', (await D.api(`/persons/${rowan.id}/knows`)).json.brought_in_by?.id === priya.id);

// Jasmine's email under a nickname: someone new for her (she's told nothing
// more), who never takes Jasmine's email — and the desk is told they may be one.
const guess = await V.api('/actions/relationship.add', { person: { name: 'Jas Wong', email: 'jasmine.wong@example.org' }, kind: 'friend' });
check('a nickname with Jasmine’s email: someone new, no email handed back', guess.status === 200 && guess.json.created_person === true
  && guess.json.matched === false && guess.json.person.email === null && guess.json.person.id !== jasmine.id, JSON.stringify(guess.json).slice(0, 200));
const jas = guess.json.person?.id ? (await D.api(`/persons/${guess.json.person.id}`)).json.person : null;
check('…on the books with no email: Jasmine’s stays Jasmine’s', jas && jas.email === null, jas?.email);
if (jas) {
  await D.go(`/people/${jas.id}`);
  check('desk: "May be the same person as Jasmine Wong"', (await page.innerText('.rel-same').catch(() => '')).trim() === 'May be the same person as Jasmine Wong', await page.innerText('.rel-same').catch(() => ''));
  m = await simple(page, 'profile with "May be the same person" (desk 1360)');
  await D.shot('02c-maybe-same-desk');
  await D.go(`/people/${jasmine.id}`);
  check('…and on Jasmine’s: "May be the same person as Jas Wong"', (await page.innerText('.rel-same').catch(() => '')).trim() === 'May be the same person as Jas Wong', await page.innerText('.rel-same').catch(() => ''));
  await V.api('/actions/relationship.remove', { id: guess.json.relationship.id });
}

// The desk's reads stay closed; her profile view is the volunteer one.
for (const path of ['/relationships/connected', `/persons/${jasmine.id}/knows`]) {
  check(`volunteer refused ${path.replace(/[0-9a-f-]{36}/, ':id')}`, (await V.api(path)).status === 403);
}
await V.go('/people/connected');
check('typing /people/connected lands on Today', new URL(vpage.url()).pathname === '/', vpage.url());
await V.go('/my-people');
await vpage.click('.ops-row:has-text("Maya Chen")');
await vpage.click('.ops-item[data-open] a:has-text("Profile")');
await vpage.waitForURL(/\/people\/[0-9a-f-]{36}$/);
await sleep(800);
check('her view of a profile: no Knows, no email', !(await vpage.$('.pf-sec__btn:has-text("Knows")')) && !/@/.test(await V.text()));
check('…and its back link returns to My people', (await tc(vpage, '.pf-back')) === '← My people', await tc(vpage, '.pf-back'));

// Calls links to My people.
await V.go('/calls');
const callsLink = await until(async () => { const t = await tc(vpage, 'a[href="/my-people"]'); return t === 'My people · 7' ? t : null; }, 6000) || await tc(vpage, 'a[href="/my-people"]');
check('Calls: a quiet "My people · 7" link', callsLink === 'My people · 7', `${callsLink} · server ${(await V.api('/relationships/mine')).json.people.map((x) => x.person.name).join(',')}`);
m = await simple(vpage, 'Calls with the My people link (volunteer 390)');
await vpage.click('a[href="/my-people"]');
await vpage.waitForURL(`${BASE}/my-people`);
await vpage.waitForSelector('.ops-back', { timeout: 5000 }).catch(() => {});
check('…whose back link says "← Calls"', (await tc(vpage, '.ops-back')) === '← Calls', await tc(vpage, '.ops-back'));

// ── 5. Each role at the other width ──
await vpage.setViewportSize({ width: 1360, height: 900 });
await V.go('/my-people');
m = await simple(vpage, 'My people (volunteer 1360)');
await V.shot('08-my-people-wide');
await V.go('/');
m = await simple(vpage, 'volunteer Today (1360)');

await page.setViewportSize({ width: 390, height: 844 });
await D.go('/people/connected');
m = await simple(page, 'Most connected (desk 390)');
await D.shot('09-most-connected-phone');
await D.go(`/people/${priya.id}`);
await page.click('.pf-sec__btn:has-text("Knows")');
await sleep(300);
check('Priya’s profile Knows: her seven', (await knowsRows()).length === 7);
m = await simple(page, 'profile with Knows open (desk 390)');
await D.shot('10-profile-knows-phone');
// A long note with no spaces (a link, say) wraps in Knows; the page never scrolls sideways.
{
  const ada = (await D.api('/actions/person.create', { name: 'Ada Anchor', phone: '604-555-0171' })).json.person;
  const notes = ['https://www.facebook.com/groups/newtonlibrarybookclub.wednesdays', 'x'.repeat(90)];
  for (const [i, note] of notes.entries()) {
    const bea = (await D.api('/actions/person.create', { name: `Bea Book ${i + 1}`, phone: `604-555-017${i + 2}` })).json.person;
    await D.api('/actions/relationship.add', { from_id: ada.id, person_id: bea.id, kind: 'community', note });
  }
  await D.go(`/people/${ada.id}`);
  await page.click('.pf-sec__btn:has-text("Knows")');
  await sleep(300);
  const long = await knowsRows();
  check('Knows shows a long unbroken note, wrapped', long.length === 2 && long.some((t) => t.replace(/\s+/g, '').includes(notes[0])), long.join(' | '));
  m = await simple(page, 'profile Knows with a long unbroken note (desk 390)');
  await D.shot('10b-profile-knows-long-note-phone');
}
await D.go('/my-people');
check('the manager’s own My people starts empty: one line + one button', /Add the people you know — friends, family, neighbours\./.test(await D.text()) && (await measure(page)).yellow === 1);
m = await simple(page, 'My people (desk 390)');
await page.setViewportSize({ width: 1360, height: 900 });
await D.go('/my-people');
m = await simple(page, 'My people (desk 1360)');

// ── 6. The books ──
const v = (await D.api('/audit/verify')).json;
check('hash chain verifies after the whole journey', v.ok === true && v.checked > 50, JSON.stringify(v));
const evs = (await D.api('/events?limit=1000')).json.events.filter((e) => e.entity_type === 'relationship');
check('every link change is on the event log', evs.some((e) => e.op === 'create' && e.action === 'relationship.add')
  && evs.some((e) => e.op === 'void' && e.action === 'relationship.remove') && evs.some((e) => e.action === 'sample.load'), evs.length);

// ── 7. Clear the sample, load it again: Priya is still one person, with her six ──
const before7 = (await V.api('/relationships/mine')).json.people.map((x) => x.person.name).sort();
const cleared = await page.evaluate(async () => (await fetch('/api/data/sample', { method: 'DELETE' })).status);
const reloaded = (await D.api('/data/sample', {})).status;
check('sample cleared and loaded again', cleared === 200 && reloaded === 200, `${cleared} ${reloaded}`);
const priyas = (await D.api('/persons?q=Priya%20Nair&limit=50')).json.persons.filter((p) => p.name === 'Priya Nair');
check('one Priya Nair, the one she signs in as', priyas.length === 1 && priyas[0].id === priya.id, priyas.map((p) => p.id).join());
const after7 = (await V.api('/relationships/mine')).json.people.map((x) => x.person.name).sort();
check('…her people as before: the sample’s six and hers', after7.join('|') === before7.join('|') && after7.length === 7, after7.join(', '));
await V.go('/');
await vpage.waitForSelector('a[href="/my-people"]', { timeout: 8000 }).catch(() => {});
check('Today: "My people · 7"', /^My people · 7/.test(await tc(vpage, 'a[href="/my-people"]')), await tc(vpage, 'a[href="/my-people"]'));
const conn7 = (await D.api('/relationships/connected')).json.people.filter((p) => p.name === 'Priya Nair');
check('Most connected: one Priya Nair', conn7.length === 1 && conn7[0].knows === 7, JSON.stringify(conn7));
check('hash chain still verifies', (await D.api('/audit/verify')).json.ok === true);
// ── 8. The ties that matter, when we pull someone up ──
const rankTies = (ties) => ties.filter((t) => !t.person.dnc).sort((x, y) => (Number(Boolean(y.close)) - Number(Boolean(x.close)))
  || ((['1', '2'].includes(x.person.rating) ? 0 : 1) - (['1', '2'].includes(y.person.rating) ? 0 : 1))
  || (['family', 'friend', 'neighbour', 'work', 'community', 'other'].indexOf(x.kind) - ['family', 'friend', 'neighbour', 'work', 'community', 'other'].indexOf(y.kind))
  || (new Date(y.linked_at) - new Date(x.linked_at)) || x.person.name.toLowerCase().localeCompare(y.person.name.toLowerCase()));
// Two housemates at Priya's address: one asked not to be contacted.
let pp = (await D.api(`/persons/${priya.id}`)).json.person;
if (!pp.address) {
  await D.api('/actions/person.update', { id: priya.id, address: '7301 Example St' });
  pp = (await D.api(`/persons/${priya.id}`)).json.person;
}
const hana = (await D.api('/actions/person.create', { name: 'Hana Example', phone: '604-555-0181', address: pp.address, unit: pp.unit || undefined })).json.person;
const dee = (await D.api('/actions/person.create', { name: 'Dee Example', phone: '604-555-0182', address: pp.address, unit: pp.unit || undefined })).json.person;
await D.api('/actions/person.update', { id: dee.id, tags: ['do-not-contact'] });
const pk = (await D.api(`/persons/${priya.id}/knows`)).json.knows;
const ranked = rankTies(pk);
await page.setViewportSize({ width: 1440, height: 900 });
await D.go(`/people/${priya.id}`);
await page.waitForSelector('.pf-head .rk-line', { timeout: 8000 }).catch(() => {});
const line = await it(page, '.pf-head .rk-line');
const firstTie = await it(page, '.pf-head .rk-tie');
check('profile: the key line under the chips, "Knows …"', /^Knows /.test(line) && await page.$('.pf-meta + .rk-line'), line);
check('…her close tie first: "Sofia Petrova Friend · Close"', ranked[0]?.person.name === 'Sofia Petrova' && /^Sofia Petrova Friend · Close/.test(firstTie), `${firstTie} · ranked ${ranked.slice(0, 3).map((t) => t.person.name).join(', ')}`);
const shownNames = await page.$$eval('.pf-head .rk-tie a', (els) => els.map((e) => e.textContent));
check('…three, in the server’s order (shared/ties.js)', shownNames.join('|') === ranked.slice(0, 3).map((t) => t.person.name).join('|'), shownNames.join(', '));
check(`…then "· ${pk.length - 3} more"`, (await tc(page, '.pf-head .rk-more')) === `${pk.length - 3} more`, await tc(page, '.pf-head .rk-more'));
check('…"Same address: Hana Example", never the do-not-contact housemate', /Same address: Hana Example/.test(line) && !/Dee Example/.test(line), line);
m = await simple(page, 'profile with the key line (desk 1440)');
await D.shot('11-profile-key-line-desk');
await page.click('.pf-head .rk-more');
await sleep(500);
check('"N more" opens Knows', (await knowsRows()).length === pk.length, (await knowsRows()).length);
// Close, in place.
const notClose = pk.find((t) => !t.close && !t.person.dnc);
const closeBtn = `.rel-knows li:has-text("${notClose.person.name}") .rk-close`;
check('Knows: each row has a quiet "Close" (aria-pressed)', (await page.$$('.rel-knows .rk-close[aria-pressed]')).length === pk.length
  && (await page.getAttribute(closeBtn, 'aria-pressed')) === 'false');
await page.click(closeBtn);
const closedNow = await until(async () => (await D.api(`/persons/${priya.id}/knows`)).json.knows.find((t) => t.id === notClose.id)?.close === true, 6000);
await until(async () => (await page.getAttribute(closeBtn, 'aria-pressed')) === 'true', 4000);
check(`Close toggles in place: ${notClose.person.name} is close, on the server and on the button`, closedNow && (await page.getAttribute(closeBtn, 'aria-pressed')) === 'true');
await page.click(closeBtn);
const unclosed = await until(async () => (await D.api(`/persons/${priya.id}/knows`)).json.knows.find((t) => t.id === notClose.id)?.close === false, 6000);
check('…and un-marks with a second tap', unclosed && await until(async () => (await page.getAttribute(closeBtn, 'aria-pressed')) === 'false', 4000));
check('Make a list, with its helper line', (await it(page, '.rk-make')) === 'Make a list Anyone you give this list to sees who is on it.', await it(page, '.rk-make'));
await page.click('button:has-text("+ Someone they know")');
await page.fill('.rel-add input[type="search"]', 'Hana');
await page.waitForSelector('.rel-pick:has-text("Hana Example")', { timeout: 8000 }).catch(() => {});
await page.click('.rel-pick:has-text("Hana Example")');
check('the note has its helper line', (await tc(page, '.rel-add .rk-help')) === 'Only what helps the campaign — no health, family or money details.', await tc(page, '.rel-add'));
await D.shot('12-knows-close-list-note-desk');
m = await simple(page, 'Knows with Close, Make a list and the note (desk 1440)');
await page.click('.rel-add button:has-text("Back")');
await page.click('.rel-add button:has-text("Cancel")');
await page.setViewportSize({ width: 390, height: 844 });
await D.go(`/people/${priya.id}`);
await page.waitForSelector('.pf-head .rk-line', { timeout: 8000 }).catch(() => {});
const lineBox = await page.$eval('.pf-head .rk-line', (e) => ({ h: e.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(e).lineHeight) || 21 }));
check('at 390 the line keeps to two lines: her close tie, "N more", "Same address"', lineBox.h <= lineBox.lh * 2 + 8 && (await page.$$('.pf-head .rk-tie')).length === 1
  && (await it(page, '.pf-head .rk-more')) === `${pk.length - 1} more` && /Same address: Hana Example/.test(await it(page, '.pf-head .rk-line')), JSON.stringify(lineBox));
m = await simple(page, 'profile with the key line (desk 390)');
await D.shot('13-profile-key-line-phone');
await page.click('.pf-head .rk-more');
await sleep(400);
m = await simple(page, 'Knows with Close and Make a list (desk 390)');
await D.shot('14-knows-close-list-phone');
// Make a list: "Priya Nair’s circle", as many as she knows.
await page.click('.rk-make button:has-text("Make a list")');
await page.waitForURL(/\/lists\/[0-9a-f-]{36}$/, { timeout: 8000 }).catch(() => {});
await page.waitForSelector('.au-fig__n', { timeout: 8000 }).catch(() => {});
const listH = await tc(page, 'h1');
const listTotal = await tc(page, '.au-fig__n');
check('Make a list opens "Priya Nair’s circle", whose total is her links', listH === 'Priya Nair’s circle' && listTotal === String(pk.length), `${listH} · ${listTotal} vs ${pk.length}`);
await page.setViewportSize({ width: 1360, height: 900 });

// People → Filter → Knows a supporter: the server's count.
await D.go('/people');
await page.click('.pp-filterbtn');
await page.click('.pp-morefilters').catch(() => {});
await page.waitForSelector('legend:has-text("Knows")', { timeout: 5000 }).catch(() => {});
const knowsChips = await page.$$eval('fieldset:has(legend:text-is("Knows")) button', (els) => els.map((e) => e.textContent.trim()));
check('the filter sheet has Knows: supporter · donor · volunteer · anyone', knowsChips.join('|') === 'Knows a supporter|Knows a donor|Knows a volunteer|Knows anyone', knowsChips.join(', '));
await page.$eval('fieldset:has(legend:text-is("Knows"))', (e) => e.scrollIntoView({ block: 'center' }));
await D.shot('15-filter-knows-desk');
m = await simple(page, 'filter sheet with Knows (desk 1360)');
await page.click('fieldset:has(legend:text-is("Knows")) button:has-text("Knows a supporter")');
await page.click('.pp-sheet button:has-text("Done"), button:has-text("Done")').catch(() => {});
const want = (await D.api('/persons/count?knows=supporter')).json.total;
const shownCount = await until(async () => { const t = await tc(page, '.pp-count [aria-live]'); return t.startsWith(want.toLocaleString('en-CA')) ? t : null; }, 8000) || await tc(page, '.pp-count [aria-live]');
check(`People filtered "Knows a supporter": ${want}, as the server counts`, want > 0 && shownCount.startsWith(want.toLocaleString('en-CA')) && /Knows a supporter/.test(await tc(page, '.pp-chips')), `${shownCount} vs ${want}`);
// The rule builder.
await D.go('/lists/new');
await page.click('.au-rules__toggle').catch(() => {});
await page.waitForSelector('label:text-is("Knows")', { timeout: 5000 }).catch(() => {});
const ruleOpts = await page.$$eval('label:text-is("Knows") + select option', (els) => els.map((e) => e.textContent.trim()));
check('the rule builder has Knows with the same four', ruleOpts.join('|') === 'Anyone|Knows a supporter|Knows a donor|Knows a volunteer|Knows anyone', ruleOpts.join(', '));
await page.$eval('label:text-is("Knows")', (e) => e.scrollIntoView({ block: 'center' }));
await D.shot('16-rule-builder-knows-desk');
m = await simple(page, 'rule builder with Knows (desk 1360)', FIELDS.replace('input:not([type=checkbox])', 'input:not([type=checkbox]):not([type=radio])'));
// The Calls card: "Knows …" under the name.
await D.go('/calls?knows=any');
await page.waitForSelector('.cl-who .rk-line', { timeout: 10000 }).catch(() => {});
const callLine = await it(page, '.cl-who .rk-line');
check('desk Calls card: "Knows …" under the name', /^Knows \S/.test(callLine) && (await page.$$('.cl-who .rk-tie')).length <= 2, callLine);
m = await simple(page, 'Calls card with Knows (desk 1360)');
await D.shot('17-calls-card-knows-desk');
await page.setViewportSize({ width: 390, height: 844 });
await D.go('/calls?knows=any');
await page.waitForSelector('.cl-who .rk-line', { timeout: 10000 }).catch(() => {});
m = await simple(page, 'Calls card with Knows (desk 390)');
await D.shot('18-calls-card-knows-phone');
await D.go('/people/connected');
await D.shot('19-most-connected-phone');
await page.setViewportSize({ width: 1440, height: 900 });
await D.go('/people/connected');
{
  const conn = (await D.api('/relationships/connected')).json.people;
  const credit = conn.find((p) => p.brought_in > 0);
  check('Most connected: "brought in" as the server counts it', credit && new RegExp(`${credit.name} knows ${credit.knows} · .* · brought in ${credit.brought_in}`).test(await D.text()), JSON.stringify(conn.slice(0, 3)));
}
await D.shot('19b-most-connected-desk');

// A staff member denied Donations: no "Knows a donor", still "Knows a supporter".
{
  const inv = (await D.api('/actions/member.invite', { email: `sam+${tag}@relationships.example`, role: 'staff' })).json;
  const sctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, timezoneId: 'America/Vancouver' });
  const spage = await sctx.newPage();
  const S = helpers(spage, 'staff');
  await spage.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  const sj = await S.api('/auth/join', { token: inv.joinUrl.split('/').pop(), name: 'Sam Example', password: 'surrey-staff-2026' });
  const sid = (await S.api('/auth/me')).json.user.id;
  const denied = await D.api('/actions/permission.member.set', { user_id: sid, grant: [], deny: ['money'] });
  check('staff Sam joined, Donations denied', sj.status === 200 && denied.status === 200, `${sj.status} ${denied.status}`);
  await S.go('/people');
  await spage.click('.pp-filterbtn');
  await spage.click('.pp-morefilters').catch(() => {});
  await spage.waitForSelector('legend:has-text("Knows")', { timeout: 5000 }).catch(() => {});
  const sChips = await spage.$$eval('fieldset:has(legend:text-is("Knows")) button', (els) => els.map((e) => e.textContent.trim()));
  check('denied Donations: no "Knows a donor", still "Knows a supporter"', !sChips.includes('Knows a donor') && sChips.includes('Knows a supporter'), sChips.join(', '));
  await sctx.close();
}

// Priya at a walk-list door, no signal: More → "I know them" → Friend.
await vpage.setViewportSize({ width: 390, height: 844 });
const wren = (await D.api('/actions/person.create', { name: 'Wren Example', phone: '604-555-0183', address: '100 Example St', lat: 49.2001, lng: -122.6001 })).json.person;
const wturf = (await D.api('/actions/turf.create', { name: 'Example Lane', polygon: [[49.199, -122.602], [49.202, -122.602], [49.202, -122.598], [49.199, -122.598]] })).json.turf;
const priyaUser = (await V.api('/auth/me')).json.user.id;
check('a turf with Wren on it, walked by Priya', wren?.id && wturf?.id && (await D.api('/actions/turf.assign', { turf_id: wturf.id, user_id: priyaUser })).status === 200);
await V.go('/my-people'); // her circle, kept on the phone
await V.go(`/turfs/${wturf.id}`);
await vpage.waitForSelector('.walk-door', { timeout: 8000 }).catch(() => {});
if (!(await vpage.$('.walk-door.is-open'))) await vpage.click('.walk-door__head');
await vpage.waitForSelector('.walk-panel', { timeout: 5000 }).catch(() => {});
check('Wren’s door: no "You know them" yet', !(await vpage.$('.walk-panel .rk-chip')));
await vpage.click('.walk-panel .fk-more__btn');
await vpage.waitForSelector('.walk-panel .rk-know', { timeout: 5000 }).catch(() => {});
await vctx.setOffline(true);
await vpage.click('.walk-panel .rk-know');
const askQ = await tc(vpage, '.rk-ask .rel-add__q');
const kindBtns = await vpage.$$eval('.rk-ask .rel-kind', (els) => els.map((e) => [e.textContent.trim(), e.getBoundingClientRect().height]));
check('"How do you know them?" with the six kinds, 48px each', askQ === 'How do you know them?' && kindBtns.length === 6 && kindBtns.every(([, h]) => h >= 47.5), JSON.stringify(kindBtns));
await vpage.$eval('.rk-ask', (e) => e.scrollIntoView({ block: 'center' }));
await V.shot('20-how-do-you-know-them-phone');
m = await simple(vpage, '"How do you know them?" (volunteer 390)');
await vpage.click('.rk-ask .rel-kind:has-text("Friend")');
await sleep(500);
check('offline: the chip shows at once, "You know them · Friend"', (await tc(vpage, '.walk-panel .rk-chip')) === 'You know them · Friend', await tc(vpage, '.walk-panel'));
check('…and it says it was saved offline', /saved offline/i.test(await tc(vpage, '.rk-said')), await tc(vpage, '.rk-said'));
check('…nothing on the server yet', (await D.api(`/persons/${wren.id}/knows`)).json.knows.length === 0);
await vpage.$eval('.walk-panel', (e) => e.scrollIntoView({ block: 'start' }));
await V.shot('21-walk-door-know-chip-phone');
m = await simple(vpage, 'walk door with the chip (volunteer 390)');
await vctx.setOffline(false);
const sentOnce = await until(async () => (await D.api(`/persons/${wren.id}/knows`)).json.knows.length === 1, 30000);
const wk = (await D.api(`/persons/${wren.id}/knows`)).json.knows;
check('back online: sent once — Priya knows Wren (Friend)', sentOnce && wk.length === 1 && wk[0].person.id === priya.id && wk[0].kind === 'friend', JSON.stringify(wk));
await sleep(3000);
const wEvents = (await D.api('/events?limit=1000')).json.events.filter((e) => e.entity_type === 'relationship' && e.entity_id === wk[0]?.id && e.op === 'create');
check('…one create on the event log', wEvents.length === 1, wEvents.length);
await V.go('/my-people');
check('…and Wren is in My people', /Wren Example/.test(await V.text()));
await vpage.setViewportSize({ width: 1360, height: 900 });
await V.go(`/turfs/${wturf.id}`);
await vpage.waitForSelector('.walk-door', { timeout: 8000 }).catch(() => {});
if (!(await vpage.$('.walk-door.is-open'))) await vpage.click('.walk-door__head');
await sleep(500);
check('the walk door says "You know them · Friend" (volunteer 1360)', (await tc(vpage, '.walk-panel .rk-chip')) === 'You know them · Friend');
m = await simple(vpage, 'walk door with the chip (volunteer 1360)');
check('her browser never received a key, Most connected or Knows answer', leaks.length === 0, leaks.join(' | '));

check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
