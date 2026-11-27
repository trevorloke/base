// Pick lists E2E (FLD) — one fresh in-memory campaign, as a manager, staff
// and a volunteer, at 1440x900 and 390x844: Faith as buttons with Christian
// opening its churches (one pick; opening and closing a group never changes
// the value; the row's Clear), the Private chip and hint; Dwelling type as
// one scroll-down list; Campus as three buttons; no signal turns them off;
// the faith-tag line; the desk's kept copy never holds a Faith and shows
// "Needs signal"; People filters "Christian (any)"; Profile fields' Private
// switch, Show as, the notice and Turn into a list end to end (Needs you,
// the confirm with counts, done, "Dwelling type as written" on a profile),
// Stop then Turn into a list again; the import's "what the list's words
// mean" (guesses, Keep as written, the line about the words beyond 40, no
// refused rows, and no room for an "as written" field); the private tick
// under the People download (and the staff line by Download everything); a
// list picked by Faith stays in the office; the membership form's Campus;
// a volunteer sees Dwelling type and no Faith or Campus. Every claim on a
// screen is checked against the API.
//
// It starts its own in-memory server on PORT (default 5450) and stops it,
// with the suite's handle on how fast a field is turned into a list on
// PORT+1 (slowed down so Stop can be pressed while one runs). Build the web
// app first (cd web && npm run build).
//
//   SHOTS=/tmp/picklists [PORT=5450] node e2e-picklists.mjs
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PORT = Number(process.env.PORT) || 5450;
const CONTROL = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = `${BASE}/admin`;
const SHOTS = process.env.SHOTS || '/tmp/starbase-picklists';
mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 260) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Date.now().toString(36);
const CAMPUSES = ['Kwantlen Polytechnic University – Surrey', 'Kwantlen Polytechnic University – Cloverdale', 'SFU Surrey'];

// ── The server, and the handle on its conversion's pace ──
const serverDir = fileURLToPath(new URL('./server/', import.meta.url));
const STUB = `${SHOTS}/picklists-stub.mjs`;
writeFileSync(STUB, `
import { createServer } from 'node:http';
// The fixtures here are Imagine Surrey's, so the server runs as its production
// does (render.yaml sets this brand); a brand set by hand is left as set.
if (process.env.STARBASE_BRAND === undefined) process.env.STARBASE_BRAND = 'imagine-surrey';

const { _setPaceForTest } = await import(${JSON.stringify(pathToFileURL(`${serverDir}ext/fields/convert.js`).href)});
createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  if (req.url === '/pace') _setPaceForTest(JSON.parse(body || '{}'));
  res.end('ok');
}).listen(${CONTROL}, '127.0.0.1');
`);
const env = { ...process.env };
for (const k of Object.keys(env)) if (/^(GOOGLE_|RESEND_|SENDGRID_|MAIL_|STARBASE_)/.test(k)) delete env[k];
Object.assign(env, { STARBASE_OPEN_SIGNUP: '1', STARBASE_DATA: 'memory', PORT: String(PORT), STARBASE_JOBS_EVERY_MS: '1000' });
const server = spawn(process.execPath, ['--import', pathToFileURL(STUB).href, 'server/index.js'], {
  cwd: fileURLToPath(new URL('.', import.meta.url)), env, stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
process.on('exit', () => { try { server.kill('SIGKILL'); } catch { /* gone */ } });
let up = false;
for (let i = 0; i < 150 && !up; i += 1) {
  if (server.exitCode !== null) break;
  up = await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false);
  if (!up) await sleep(200);
}
if (!up) { console.log(serverLog.slice(-1500)); server.kill('SIGKILL'); process.exit(1); }
const pace = (o) => fetch(`http://127.0.0.1:${CONTROL}/pace`, { method: 'POST', body: JSON.stringify(o) });

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const errors = [];
const helpers = (page, who, desk = true) => {
  page.on('pageerror', (e) => errors.push(`[${who}] ${e.message}`));
  return {
    shot: (n) => page.screenshot({ path: `${SHOTS}/${n}.png` }),
    full: (n) => page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true }),
    text: async () => ((await page.innerText('body').catch(() => '')) || '').replace(/\s+/g, ' '),
    api: (path, body) => page.evaluate(async ([p, b]) => {
      const r = await fetch('/api' + p, b === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
      const raw = await r.text();
      let json = null;
      try { json = JSON.parse(raw); } catch { /* not json */ }
      return { status: r.status, json, raw };
    }, [path, body]),
    go: async (path) => { await page.goto(`${desk ? ADMIN : BASE}${path}`, { waitUntil: 'domcontentloaded' }); await sleep(1100); },
  };
};
const measure = (page, sel = null) => page.evaluate((targets) => {
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const yellow = [...document.querySelectorAll('.btn-primary')].filter(visible).length;
  const overflow = document.documentElement.scrollWidth - window.innerWidth;
  let minTap = null;
  if (targets) for (const el of document.querySelectorAll(targets)) { if (!visible(el)) continue; const h = el.getBoundingClientRect().height; minTap = minTap == null ? h : Math.min(minTap, h); }
  return { yellow, overflow, minTap };
}, sel);
const simple = async (page, name, sel = null, min = 47.5) => {
  const m = await measure(page, sel);
  check(`${name}: ≤ 1 yellow, no sideways scroll${sel ? `, targets ≥ ${Math.round(min)}px` : ''}`, m.yellow <= 1 && m.overflow <= 0 && (m.minTap == null || m.minTap >= min), JSON.stringify(m));
};
const openSec = async (page, title) => {
  await page.waitForSelector(`.pf-sec__btn:has-text("${title}")`, { timeout: 10000 }).catch(() => {});
  const b = await page.$(`.pf-sec__btn:has-text("${title}")`);
  if (b && (await b.getAttribute('aria-expanded')) !== 'true') { await b.click(); await sleep(400); }
};
const Q = 'form[aria-label="More details"]';
const FAITH = `${Q} [role="group"]:has(.fd-grp)`;
const saveOff = (page) => page.$eval(`${Q} .fd-save`, (b) => b.disabled).catch(() => null);
const save = async (page) => { await page.click(`${Q} .fd-save`); await page.waitForSelector(`${Q} .fd-said:has-text("Saved")`, { timeout: 8000 }).catch(() => {}); await sleep(400); };

// ── 1. A manager, the campaign's fields, a few made-up people ──
const mctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, timezoneId: 'America/Vancouver' });
const page = await mctx.newPage();
const M = helpers(page, 'manager');
await M.go('/signup');
await page.fill('#su-name', 'Riley Manager');
if (await page.locator('#su-org').count()) await page.fill('#su-org', 'Pick Lists Example');
await page.fill('#su-email', `riley+${tag}@lists.example`);
await page.fill('#su-password', 'pick-lists-2026');
await page.click('button[type="submit"]');
await page.waitForURL(/\/admin\/?$/, { timeout: 15000 });
const fieldsNow = async () => Object.fromEntries((await M.api('/fields')).json.fields.filter((f) => !f.retired).map((f) => [f.name, f]));
let F = await fieldsNow();
check('a new campaign: Faith (Pick one, 29, Private), Dwelling type (a scroll-down list), Campus (the three)',
  F.Faith?.kind === 'choice' && F.Faith.choices.length === 29 && F.Faith.sensitive && F['Dwelling type']?.display === 'list'
  && JSON.stringify(F.Campus?.choices) === JSON.stringify(CAMPUSES), JSON.stringify([F.Faith?.choices?.length, F['Dwelling type']?.display, F.Campus?.choices]));
const P = {};
const mk = async (key, data) => { P[key] = (await M.api('/actions/person.create', data)).json.person; };
await mk('ann', { name: 'Ann Example', phone: '604-555-0151', tags: ['faith'] });
await mk('ben', { name: 'Ben Example', phone: '604-555-0152' });
await mk('cal', { name: 'Cal Example', phone: '604-555-0153' });
await M.api('/actions/field.values.set', { person_id: P.cal.id, values: [{ field_id: F.Faith.id, value: 'Sikh' }] });
const valuesOf = async (id) => Object.fromEntries((await M.api(`/persons/${id}/fields`)).json.fields.map((f) => [f.name, f.value]));

// ── 2. More details: Faith, Dwelling type, Campus (1440) ──
await M.go(`/people/${P.ben.id}`);
await openSec(page, 'More details');
await page.waitForSelector(FAITH, { timeout: 8000 }).catch(() => {});
check('Faith: 10 buttons (Christian is one)', (await page.$$(`${FAITH} > .sv-q__opts > button`)).length === 10, (await page.$$(`${FAITH} > .sv-q__opts > button`)).length);
check('Faith: the “Private” chip and “Only what they tell you. Never guess.”',
  /Private/.test(await page.innerText(`${FAITH} .fd-q__label`)) && /Only what they tell you\. Never guess\./.test(await page.innerText(FAITH)));
await page.click(`${FAITH} .fd-grp`);
await sleep(200);
const sub = await page.$$eval(`${FAITH} .fd-sub .sv-q__opts button`, (els) => els.map((e) => e.textContent.trim()));
check('Christian opens 20, “Just Christian (no church named)” first, with “Just Christian? Pick the first one.”',
  sub.length === 20 && sub[0] === 'Just Christian (no church named)' && /Christian — pick one\. Just Christian\? Pick the first one\./.test(await page.innerText(`${FAITH} .fd-sub`)), sub.slice(0, 3).join('|'));
await M.shot('01-faith-open-1440');
check('opening a group changes nothing (Save off)', (await saveOff(page)) === true);
await page.click(`${FAITH} .fd-sub button:text-is("Catholic")`);
check('Catholic picked: the group shows on too', (await page.getAttribute(`${FAITH} .fd-grp`, 'class')).includes('is-on'));
await save(page);
check('server: Faith is “Christian – Catholic”', (await valuesOf(P.ben.id)).Faith === 'Christian – Catholic');
check('a saved value in a group opens its row', !!(await page.$(`${FAITH} .fd-sub`)));
await page.click(`${FAITH} .fd-sub button:text-is("Catholic")`);
check('tapping Catholic again clears it (Save on)', (await saveOff(page)) === false && (await page.getAttribute(`${FAITH} .fd-sub button:text-is("Catholic")`, 'aria-pressed')) === 'false');
await page.click(`${FAITH} .fd-sub button:text-is("Catholic")`);
await page.click(`${FAITH} .fd-grp`); // close
await page.click(`${FAITH} .fd-grp`); // open again
check('with a saved Catholic, closing and reopening Christian leaves Save off and Catholic on',
  (await saveOff(page)) === true && (await page.getAttribute(`${FAITH} .fd-sub button:text-is("Catholic")`, 'aria-pressed')) === 'true');
await page.click(`${FAITH} .fd-sub .fd-clear`);
await save(page);
check('the row’s Clear clears (server)', (await valuesOf(P.ben.id)).Faith == null);
// Dwelling type: one select.
const sel = `${Q} select`;
check('Dwelling type is one select, “Pick one…” first', (await page.$$(sel)).length === 1 && (await page.$eval(sel, (s) => s.options[0].text)) === 'Pick one…');
await page.selectOption(sel, 'House');
await save(page);
check('picking House saves it', (await valuesOf(P.ben.id))['Dwelling type'] === 'House');
await page.selectOption(sel, '');
await save(page);
check('“Pick one…” clears it', (await valuesOf(P.ben.id))['Dwelling type'] == null);
const campusBtns = await page.$$eval(`${Q} [role="group"]:has(.fd-q__label:text-is("Campus")) .sv-opt`, (els) => els.map((e) => e.textContent.trim()));
check('Campus: three buttons', JSON.stringify(campusBtns) === JSON.stringify(CAMPUSES), campusBtns.join('|'));
await M.full('02-more-details-1440');
await simple(page, 'profile at 1440', `${Q} .sv-opt, ${Q} select`, 39.5);
await mctx.setOffline(true);
await sleep(600);
check('no signal: the select and the buttons are off', await page.$eval(sel, (s) => s.disabled) && await page.$eval(`${FAITH} .fd-grp`, (b) => b.disabled));
await mctx.setOffline(false);
await sleep(600);

// The faith-tag line.
await M.go(`/people/${P.ann.id}`);
await openSec(page, 'More details');
check('the faith-tag line, for a person tagged “faith” with no Faith', /Tagged “faith”\. If they told you their faith, pick it under Faith\./.test(await page.innerText(Q)));
await M.shot('03-faith-tag-line-1440');
await page.click(`${FAITH} > .sv-q__opts button:text-is("Sikh")`);
await save(page);
check('…and not once Faith is picked', !/Tagged “faith”/.test(await page.innerText(Q)) && (await valuesOf(P.ann.id)).Faith === 'Sikh');
await M.api('/actions/field.values.set', { person_id: P.ben.id, values: [{ field_id: F.Faith.id, value: 'Christian – Catholic' }] });

// ── 3. The phone (390): More details ──
const phctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, timezoneId: 'America/Vancouver' });
const ppage = await phctx.newPage();
const PH = helpers(ppage, 'manager-phone');
await PH.go('/login');
await ppage.fill('#li-email, input[type="email"]', `riley+${tag}@lists.example`).catch(() => {});
await ppage.fill('input[type="password"]', 'pick-lists-2026').catch(() => {});
await ppage.click('button[type="submit"]').catch(() => {});
await sleep(1500);
await PH.go(`/people/${P.ben.id}`);
await openSec(ppage, 'More details');
await ppage.waitForSelector(FAITH, { timeout: 8000 }).catch(() => {});
const across = await ppage.$$eval(`${FAITH} > .sv-q__opts > button`, (els) => new Set(els.map((e) => Math.round(e.getBoundingClientRect().top))).size);
check('phone: Faith is 10 buttons in 5 rows of two', across === 5, across);
check('phone: the select is 48 px tall', (await ppage.$eval(`${Q} select`, (s) => s.getBoundingClientRect().height)) >= 47.5);
await PH.full('04-more-details-390');
await simple(ppage, 'profile at 390', `${Q} .sv-opt, ${Q} select, ${Q} .fd-clear`);

// ── 4. Staff and a volunteer ──
const join = async (role, name, ctxOpts) => {
  const inv = (await M.api('/actions/member.invite', { email: `${role}+${tag}@lists.example`, role })).json;
  const c = await browser.newContext({ deviceScaleFactor: 1, timezoneId: 'America/Vancouver', ...ctxOpts });
  const pg = await c.newPage();
  const H = helpers(pg, role, role !== 'volunteer');
  await H.go('/login');
  const j = await H.api('/auth/join', { token: inv.joinUrl.split('/').pop(), name, password: 'pick-lists-2026' });
  check(`${role} joined`, j.status === 200, j.status);
  return { c, pg, H };
};
const S = await join('staff', 'Sam Staff', { viewport: { width: 1440, height: 900 } });
const V = await join('volunteer', 'Val Volunteer', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const vf = (await V.H.api(`/persons/${P.ben.id}/fields`));
const vnames = (vf.json?.fields || []).map((f) => f.name);
await M.api('/actions/field.values.set', { person_id: P.ben.id, values: [{ field_id: F['Dwelling type'].id, value: 'House' }, { field_id: F.Campus.id, value: 'SFU Surrey' }] });
const vf2 = (await V.H.api(`/persons/${P.ben.id}/fields`)).json?.fields || [];
check('a volunteer’s profile: Dwelling type read-only, no Faith or Campus', vf2.some((f) => f.name === 'Dwelling type' && f.value === 'House') && !vf2.some((f) => /Faith|Campus/.test(f.name)) && (await V.H.api(`/persons/${P.ben.id}/fields`)).json.edit === false, JSON.stringify([vnames, vf2.map((f) => f.name)]));

// ── 5. The desk offline: a kept profile holds no Faith and says "Needs signal" ──
await S.H.go(`/people/${P.ben.id}`);
await openSec(S.pg, 'More details');
await S.pg.waitForSelector(FAITH, { timeout: 8000 }).catch(() => {});
await S.pg.evaluate(() => navigator.serviceWorker?.ready).catch(() => {});
await sleep(1500);
const stored = await S.pg.evaluate(() => {
  const all = [];
  for (const s of [localStorage, sessionStorage]) for (let i = 0; i < s.length; i += 1) { const k = s.key(i); if (k && k.startsWith('starbase:copy:')) all.push(s.getItem(k)); }
  return all.join('\n');
}).catch(() => '');
// Faith's choices are in the copy (the list's words); Ben's value is not.
check('the kept copy holds the profile and no Faith value', /Dwelling type/.test(stored) && /kept_out/.test(stored)
  && !/value\\?":\\?"Christian – Catholic/.test(stored), stored.length);
await S.c.setOffline(true);
await S.H.go(`/people/${P.ben.id}`);
await openSec(S.pg, 'More details');
const offTxt = await S.pg.innerText(Q).catch(() => '');
check('offline, Faith shows “Needs signal”', /Faith\s*Private\s*Needs signal/.test(offTxt), offTxt.slice(0, 200));
await S.H.shot('05-offline-needs-signal');
await S.c.setOffline(false);
await sleep(500);

// ── 6. People: “Christian (any)” ──
await M.go(`/people?field=${encodeURIComponent(`${F.Faith.id}:Christian – *`)}`);
await page.waitForSelector('.pp-fchip', { timeout: 8000 }).catch(() => {});
const chipWords = await page.innerText('.pp-fchip').catch(() => '');
const listed = await M.text();
check('the filter chip reads “Faith: Christian (any)”', /Faith: Christian \(any\)/.test(chipWords), chipWords);
check('Christian (any) lists Ben (Catholic), not Cal or Ann (Sikh)', /Ben Example/.test(listed) && !/Cal Example/.test(listed) && !/Ann Example/.test(listed));
await M.go('/people');
await page.click('button:has-text("Filter")').catch(() => {});
await sleep(300);
await page.click('button:has-text("More filters")').catch(() => {});
await sleep(300);
const faithChips = await page.$$eval('fieldset.pp-group:has(legend:text-is("Faith")) > .pp-group__opts > *', (els) => els.map((e) => e.textContent.trim())).catch(() => []);
check('the Faith group’s chips: Sikh · Christian (any) · … · Prefer not to say', faithChips.length === 10 && faithChips[1] === 'Christian (any)' && faithChips[9] === 'Prefer not to say', faithChips.join('|'));
await M.full('06-people-filter-1440');

// ── 7. Profile fields: Private, Show as, the notice, Turn into a list ──
// Dwelling type and Campus as a campaign from before has them: typed, with words on file.
const retireStd = async (name) => {
  const f = (await fieldsNow())[name];
  await M.api('/actions/field.update', { id: f.id, name: `${name} (new list)` });
  await M.api('/actions/field.retire', { id: f.id });
};
await retireStd('Dwelling type');
await retireStd('Campus');
const dw = (await M.api('/actions/field.create', { name: 'Dwelling type', kind: 'text' })).json.field;
const cp = (await M.api('/actions/field.create', { name: 'Campus', kind: 'text' })).json.field;
const WORDS = ['House', 'house', 'Townhouse', 'townhome', 'Apartment', 'Condo', 'Basement suite', 'Duplex', 'Highrise', 'Low-rise', 'Mobile home', 'Care home', 'Residence', 'Unknown', 'Apt', 'Flat', 'Row house', 'Detached', 'Semi', 'Walk-up'];
for (let part = 0; part < 2; part += 1) {
  const rows = Array.from({ length: 1000 }, (_, k) => { const i = part * 1000 + k; return { name: `Dw${i} Example`, fields: { [dw.id]: WORDS[i % WORDS.length], ...(i < 300 ? { [cp.id]: ['kpu surrey', 'SFU Surrey', 'Kwantlen', 'UBC'][i % 4] } : {}) } }; });
  const r = await M.api('/data/import', { rows });
  check(`seeded 1,000 typed Dwelling type words (part ${part + 1})`, r.status === 200 && (r.json.invalid || []).length === 0, r.raw.slice(0, 200));
}
const apt = (await M.api(`/persons?q=${encodeURIComponent('Dw4 Example')}`)).json.persons.find((p) => p.name === 'Dw4 Example');
const hse = (await M.api(`/persons?q=${encodeURIComponent('Dw0 Example')}`)).json.persons.find((p) => p.name === 'Dw0 Example');
await M.go(`/people/${apt.id}`);
await openSec(page, 'More details');
await page.waitForSelector(`${Q} .fd-listable`, { timeout: 8000 }).catch(() => {});
check('a manager’s profile: “This can be a pick list — Turn it into a list”', /This can be a pick list — Turn it into a list/.test(await page.innerText(Q)));
await M.shot('07-can-be-a-list-1440');
await S.H.go(`/people/${apt.id}`);
await openSec(S.pg, 'More details');
await sleep(500);
check('staff’s profile: no such line', !/This can be a pick list/.test(await S.pg.innerText(Q).catch(() => '')));

await M.go('/people/fields');
await page.waitForSelector('.fd-notice', { timeout: 8000 }).catch(() => {});
check('the notice: “Dwelling type and Campus can be pick lists now.”', /Dwelling type and Campus can be pick lists now\./.test(await page.innerText('.fd-notice').catch(() => '')));
// A text field whose words are all different: no Turn into a list, its muted line.
const doors = (await M.api('/actions/field.create', { name: 'Doorstep words', kind: 'text' })).json.field;
await M.api('/data/import', { rows: Array.from({ length: 600 }, (_, i) => ({ name: `Dw${i} Example`, fields: { [doors.id]: `Word ${i} ${tag}` } })) });
await M.go('/people/fields');
await page.click('.ops-row:has-text("Doorstep words")');
await sleep(300);
const doorEd = await page.innerText('.fd-item[data-open]');
check('a Text field of all-different words: “it doesn’t suit a list”, no Turn into a list', /Its words are mostly different — it doesn’t suit a list\./.test(doorEd) && !(await page.$('.fd-item[data-open] .fd-tolist')));
// Private switch and Show as, on Citizenship (Pick one).
await page.click('.ops-row:has-text("Citizenship")');
await sleep(300);
const ed = '.fd-item[data-open]';
check('Pick one: “Show as” Buttons · Scroll-down list', (await page.$$eval(`${ed} .sv-kinds button`, (els) => els.map((e) => e.textContent))).join('|').includes('Buttons|Scroll-down list'));
await page.click(`${ed} button[role="switch"]:has-text("Volunteers can see this")`);
await page.click(`${ed} button[role="switch"]:has-text("Private")`);
check('Private on: “Volunteers can see this” goes off and grey', (await page.getAttribute(`${ed} button[role="switch"]:has-text("Volunteers can see this")`, 'aria-checked')) === 'false'
  && await page.$eval(`${ed} button[role="switch"]:has-text("Volunteers can see this")`, (b) => b.disabled)
  && /Never shown to volunteers, put in downloads, walked, called or used to pick who gets a message\./.test(await page.innerText(ed)));
await M.full('08-field-editor-private-1440');
await page.click(`${ed} button:has-text("Cancel")`);

// Turn Dwelling type into a list.
await M.go(`/people/fields?list=${dw.id}`);
await page.waitForSelector('.fl-words', { timeout: 15000 }).catch(() => {});
const flTxt = await M.text();
check('Turn “Dwelling type” into a list: the standard list, 2,000 people · 19 different words',
  /Turn “Dwelling type” into a list/.test(flTxt) && /The standard list — change it if you like/.test(flTxt) && /2,000 people · 19 different words/.test(flTxt), flTxt.slice(0, 300));
const needs = await page.$$eval('section[aria-labelledby="fl-needs"] .fl-word__w', (els) => els.map((e) => e.textContent));
check('Needs you: Apartment, Condo, Apt, Flat (no height said)', ['Apartment', 'Condo', 'Apt', 'Flat'].every((w) => needs.includes(w)) && needs.length === 4, needs.join('|'));
const pre = await page.$eval('select[aria-label="“Townhouse” becomes"]', (s) => s.value).catch(() => '');
check('a guess is pre-filled: Townhouse → Townhouse or row house', pre === 'Townhouse or row house', pre);
await M.full('09-to-list-before-1440');
await page.click('.fl-go .btn-primary');
const conf = await page.innerText('.fl-go').catch(() => '');
check('the confirm: “Change 2,000 people? 1,600 get a choice · 400 keep their words in “Dwelling type as written”.”',
  /Change 2,000 people\? 1,600 get a choice · 400 keep their words in “Dwelling type as written”\./.test(conf), conf);
await M.shot('10-to-list-confirm-1440');
await page.click('.fl-go button:has-text("Yes")');
await page.waitForSelector('.fl-run, .ops-done', { timeout: 15000 }).catch(() => {});
if (await page.$('.fl-run')) await M.shot('11-to-list-running-1440');
await page.waitForSelector('.ops-done:has-text("is now a list")', { timeout: 90000 }).catch(() => {});
check('done: “✓ Dwelling type is now a list”', /✓ Dwelling type is now a list/.test(await M.text()));
await M.shot('12-to-list-done-1440');
F = await fieldsNow();
check('server: Dwelling type is Pick one; “Dwelling type as written” keeps the rest', F['Dwelling type']?.kind === 'choice' && F['Dwelling type as written']?.as_written_of === dw.id);
await M.go(`/people/${apt.id}`);
await openSec(page, 'More details');
const wr = await page.innerText(`${Q} .fd-written`).catch(() => '');
check('a person with “Dwelling type as written”: read-only words, the hint and Clear', /Apartment/.test(wr) && /From before the list — pick the type above, then clear this/.test(wr) && /Clear/.test(wr) && !(await page.$(`${Q} .fd-written input`)), wr);
await M.shot('13-as-written-1440');
await page.click(`${Q} .fd-written .fd-clear`);
await save(page);
check('its Clear empties it', (await valuesOf(apt.id))['Dwelling type as written'] == null);
await M.go(`/people/${hse.id}`);
await openSec(page, 'More details');
check('a person without: no such field', !(await page.$(`${Q} .fd-written`)) && (await valuesOf(hse.id))['Dwelling type'] === 'House');

// Campus: Turn into a list, Stop while it runs, then Turn into a list again.
// Slowed (20 values a chunk, 1.5 s apart) so Stop can be pressed.
await pace({ size: 20, waitMs: 1500 });
await M.go(`/people/fields?list=${cp.id}`);
await page.waitForSelector('.fl-go .btn-primary', { timeout: 15000 }).catch(() => {});
await page.click('.fl-go .btn-primary');
await page.click('.fl-go button:has-text("Yes")');
await page.waitForSelector('.fl-run', { timeout: 15000 }).catch(() => {});
await page.waitForSelector('.fl-run p:has-text("Turning into a list… 20 of 300"), .fl-run p:has-text("Turning into a list… 40 of 300")', { timeout: 15000 }).catch(() => {});
const runTxt = await page.innerText('.fl-run').catch(() => '');
check('Campus running: the bar and “Turning into a list… N of 300”', /Turning into a list… [\d,]+ of 300/.test(runTxt) && !!(await page.$('.fl-run [role="progressbar"]')), runTxt);
await M.shot('11b-campus-running-1440');
// Meanwhile, an import with a Campus column waits for it.
{
  const p2 = await mctx.newPage();
  await p2.goto(`${ADMIN}/people/import`, { waitUntil: 'domcontentloaded' });
  await sleep(1100);
  await p2.click('button:has-text("Paste text")');
  await p2.fill('#imp-paste', ['Full name\tCampus', 'Wait Example\tSFU Surrey'].join('\n'));
  await p2.click('button:has-text("Use this text")');
  await p2.waitForSelector('.imp-wait:has-text("is being turned into a list")', { timeout: 10000 }).catch(() => {});
  const need = await p2.innerText('.imp-wait[role="status"]').catch(() => '');
  check('the import, while Campus converts: “Campus is being turned into a list — import when it’s done”, Check off',
    /Campus is being turned into a list — import when it’s done/.test(need) && await p2.$eval('button:has-text("Check 1 row")', (b) => b.disabled).catch(() => false), need);
  await p2.screenshot({ path: `${SHOTS}/11c-import-waits-1440.png` });
  await p2.close();
}
await page.click('.fl-run button:has-text("Stop")');
check('Stop asks first: “Stop? What’s done stays done.”', /Stop\? What’s done stays done\./.test(await page.innerText('.fl-run')));
await M.shot('11d-campus-stop-confirm-1440');
await page.click('.fl-run .ops-confirm button:has-text("Yes")');
await page.waitForSelector('.fl-go .btn-primary', { timeout: 20000 }).catch(() => {});
const afterStop = (await fieldsNow()).Campus;
check('Stopped: “Stopped — what was done stays done.”, Campus still Text, Turn into a list offered again',
  /Stopped — what was done stays done\./.test(await M.text()) && afterStop.kind === 'text' && !afterStop.converting && !!(await page.$('.fl-go .btn-primary')), JSON.stringify([afterStop.kind, afterStop.converting]));
await M.shot('11e-campus-stopped-1440');
// A reload of the words (here: the signal comes back) keeps what's been typed.
await page.click('.sv-choice__add');
const last = page.locator('.sv-choices .sv-choice input').last();
await last.fill('Another campus example');
let reads = 0;
const countReads = (r) => { if (/\/api\/fields\/[^/]+\/words/.test(r.url())) reads += 1; };
page.on('response', countReads);
await mctx.setOffline(true);
await sleep(600);
await mctx.setOffline(false);
await sleep(2500);
page.off('response', countReads);
check('a reload of the words keeps a typed choice', reads >= 1 && (await page.locator('.sv-choices .sv-choice input').last().inputValue()) === 'Another campus example', `${reads} reads`);
await page.locator('.sv-choices .sv-choice__x').last().click();
await pace({});
await page.click('.fl-go .btn-primary');
await page.click('.fl-go button:has-text("Yes")');
await page.waitForSelector('.ops-done:has-text("is now a list")', { timeout: 90000 }).catch(() => {});
F = await fieldsNow();
check('Campus finishes: a list, the rest in “Campus as written”', F.Campus?.kind === 'choice' && F['Campus as written']?.as_written_of === cp.id, JSON.stringify(F.Campus));

// ── 8. Import: what the list's words mean ──
const GUESSABLE = ['house', 'townhouse', 'duplex', 'tower', 'walkup', 'trailer', 'dorm', 'basement', 'semi', 'unknown'];
const words60 = [...GUESSABLE, ...Array.from({ length: 50 }, (_, i) => `Odd place ${String(i).padStart(2, '0')}`)];
const lines = [['First Name', 'Surname', 'Dwelling Type'].join('\t'), ...words60.map((w, i) => [`Imp${i}`, 'Example', w].join('\t'))];
await M.go('/people/import');
await page.click('button:has-text("Paste text")');
await page.fill('#imp-paste', lines.join('\n'));
await page.click('button:has-text("Use this text")');
await page.waitForSelector('section.imp-rmap:has(h3:text-is("Dwelling type"))', { timeout: 10000 }).catch(() => {});
const SEC = 'section.imp-rmap:has(h3:text-is("Dwelling type"))';
const rowsShown = await page.$$eval(`${SEC} .imp-rmap__row`, (rows) => Object.fromEntries(rows.map((r) => [r.querySelector('.imp-rmap__word').innerText.trim(), r.querySelector('select').selectedOptions[0].text])));
check('the mapping section: 40 rows, “What the list’s Dwelling Type words mean.”', Object.keys(rowsShown).length === 40 && /What the list’s Dwelling Type words mean\./.test(await page.innerText(SEC)));
check('pre-filled guesses (house → House, duplex → Semi-detached…), the rest Keep as written',
  rowsShown.house === 'House' && rowsShown.duplex === 'Semi-detached or side-by-side duplex' && rowsShown['Odd place 00'] === 'Keep as written', JSON.stringify(rowsShown).slice(0, 240));
check('the line about the 20 beyond 40', /20 other words in 20 rows are kept as written in “Dwelling type as written”/.test(await page.innerText(SEC)), await page.innerText(SEC));
await M.full('14-import-mapping-1440');
await page.click('button:has-text("Check 60 rows")');
await page.waitForSelector('button:has-text("Import 60 people")', { timeout: 20000 }).catch(() => {});
await page.click('button:has-text("Import 60 people")');
await page.waitForSelector('text=/Imported|added/i', { timeout: 30000 }).catch(() => {});
await sleep(1500);
let every = true; let bad = '';
for (let i = 0; i < 60; i += 1) {
  const p = (await M.api(`/persons?q=${encodeURIComponent(`Imp${i} Example`)}`)).json.persons.find((x) => x.name === `Imp${i} Example`);
  const v = p ? await valuesOf(p.id) : {};
  const ok = (v['Dwelling type'] && F['Dwelling type'].choices.includes(v['Dwelling type'])) || v['Dwelling type as written'] === words60[i];
  if (!ok) { every = false; bad = `${words60[i]} → ${JSON.stringify([v['Dwelling type'], v['Dwelling type as written']])}`; break; }
}
check('the import lands with no refused rows, every word a choice or in “Dwelling type as written”', every, bad);

// No room: 40 fields and no "as written" field yet.
const shirt = (await M.api('/actions/field.create', { name: 'Shirt size', kind: 'choice', choices: ['Small', 'Large'] })).json.field;
const live = Object.keys(await fieldsNow()).length;
const fillers = [];
for (let i = live; i < 40; i += 1) fillers.push((await M.api('/actions/field.create', { name: `Filler ${i}`, kind: 'yesno' })).json.field);
await M.go('/people/import');
await page.click('button:has-text("Paste text")');
await page.fill('#imp-paste', ['Full name\tShirt size', 'Shirt Example\tMedium'].join('\n'));
await page.click('button:has-text("Use this text")');
const SH = 'section.imp-rmap:has(h3:text-is("Shirt size"))';
await page.waitForSelector(SH, { timeout: 10000 }).catch(() => {});
check('no room: “There’s no room for a “Shirt size as written” field (40 fields)…” and Check is off',
  /There’s no room for a “Shirt size as written” field \(40 fields\)\. Take a field off, or pick “Leave blank” for the words below\./.test(await page.innerText(SH))
  && await page.$eval('button:has-text("Check 1 row")', (b) => b.disabled), await page.innerText(SH).catch(() => ''));
await M.shot('15-import-no-room-1440');
await page.selectOption(`${SH} select`, { label: 'Leave blank' });
check('…until the word is set to Leave blank', !(await page.$eval('button:has-text("Check 1 row")', (b) => b.disabled)));
for (const f of fillers) await M.api('/actions/field.retire', { id: f.id });
await M.api('/actions/field.retire', { id: shirt.id });

// ── 9. Downloads ──
await M.go('/data');
const tick = page.locator('label.rp-private');
check('manager: “Include private fields (Faith) in the download” under People', (await tick.count()) === 1 && /Include private fields \(Faith\) in the download/.test(await tick.innerText()));
const csvHead = (href) => page.evaluate(async (h) => (await (await fetch(h)).text()).split('\n')[0], href);
const peopleHref = () => page.$eval('li.drv-export--private > a', (a) => a.getAttribute('href'));
check('unticked: the CSV has no Faith', !/Faith/.test(await csvHead(await peopleHref())), await peopleHref());
await tick.locator('input').check();
check('ticked: the CSV has Faith', /\?private=1$/.test(await peopleHref()) && /Faith/.test(await csvHead(await peopleHref())));
const sheets = page.locator('li.drv-export--private button:has-text("Google Sheets")');
if (await sheets.count()) {
  check('ticked: People’s Google Sheets is off, “Google Sheets never gets private fields”', await sheets.isDisabled() && /Google Sheets never gets private fields/.test(await page.innerText('li.drv-export--private')));
} else console.log('NOTE  Google Sheets isn’t set up on this server: its control isn’t drawn, nothing to switch off');
await M.full('16-data-manager-1440');
await S.H.go('/data');
await sleep(500);
check('staff: no private tick; “Private fields (Faith) are left out of your copy.”', (await S.pg.locator('label.rp-private').count()) === 0 && /Private fields \(Faith\) are left out of your copy\./.test(await S.H.text()));
check('staff: ?private=1 is refused', (await S.pg.evaluate(async () => (await fetch('/api/export/people.csv?private=1')).status)) === 403);
await S.H.full('17-data-staff-1440');

// ── 10. A list picked by Faith ──
const lst = (await M.api('/actions/list.create', { name: 'Sikh friends', kind: 'filter', filter: { field: `${F.Faith.id}:Sikh` } })).json.list;
await M.go(`/lists/${lst.id}`);
await page.waitForSelector('.ls-office', { timeout: 8000 }).catch(() => {});
check('the list’s page: “Stays in the office: it picks people by Faith, so it can’t be walked, called, sent to CallHub, emailed, texted or copied.”',
  /Stays in the office: it picks people by Faith, so it can’t be walked, called, sent to CallHub, emailed, texted or copied\./.test(await page.innerText('.ls-office').catch(() => '')));
check('…its Email, Text, Call and Walk are off', (await page.$$eval('.au-go--page button', (bs) => bs.filter((b) => b.disabled).length)) === 4);
await M.full('18-list-office-1440');
await M.go(`/banks/new?list=${lst.id}`);
await page.waitForSelector('form.bk-form button[type="submit"]', { timeout: 8000 }).catch(() => {});
await sleep(800);
await page.click('form.bk-form button[type="submit"]').catch(() => {});
await page.waitForSelector('form.bk-form .error', { timeout: 8000 }).catch(() => {});
check('New phone bank on it: the 409 in place', /picks people by Faith, which is private/.test(await page.innerText('form.bk-form').catch(() => '')));
await M.shot('19-bank-refused-1440');
await M.go(`/passes?new=1&list=${lst.id}`);
await page.waitForSelector('form.pass-form', { timeout: 8000 }).catch(() => {});
await page.fill('form.pass-form input.input[required]', 'Faith walk');
await page.click('form.pass-form button[type="submit"]').catch(() => {});
await page.waitForSelector('text=/picks people by Faith, which is private/', { timeout: 8000 }).catch(() => {});
check('Start a pass on it: the 409 in place', /picks people by Faith, which is private/.test(await M.text()) && (await M.api('/passes')).json?.open == null);
await M.shot('19b-pass-refused-1440');

// ── 11. The membership form's Campus ──
await M.go('/people/membership-form');
await page.waitForSelector('.mf-campus', { timeout: 8000 }).catch(() => {});
const radios = (await page.locator('.mf-campus label.mf-check').allInnerTexts()).map((t) => t.trim());
check('Campus radios: the three and Another campus', radios.join('|') === [...CAMPUSES, 'Another campus'].join('|'), radios.join('|'));
await page.getByLabel('First name').first().fill('Uma');
await page.getByLabel('Last name').first().fill(`Example ${tag}`);
await page.locator('.mf-campus label.mf-check', { hasText: 'Another campus' }).locator('input').check();
await page.fill('input[aria-label="Another campus"]', 'UBC');
await page.getByRole('button', { name: 'Save the form' }).click();
await page.waitForSelector('.mf-done', { timeout: 15000 }).catch(() => {});
check('“Another campus: UBC” saves the form, with its warning', /Campus “UBC” isn’t one of the choices/.test(await M.text()), (await M.text()).slice(0, 300));
await M.full('20-membership-saved-1440');
await PH.go('/people/membership-form');
await ppage.waitForSelector('.mf-campus', { timeout: 8000 }).catch(() => {});
await ppage.locator('.mf-campus').scrollIntoViewIfNeeded().catch(() => {});
await PH.shot('21-membership-campus-390');
await simple(ppage, 'membership form at 390', '.mf-campus label.mf-check');

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
server.kill('SIGTERM');
await sleep(300);
if (server.exitCode === null) server.kill('SIGKILL');
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
