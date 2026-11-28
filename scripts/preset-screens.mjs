// What Imagine Surrey's manager reads on eight screens, saved as text, so two
// versions of the code can be compared (the server's answers are compared by
// scripts/preset-dump.sh; this is what the browser makes of them).
//
//   npm run build
//   node scripts/preset-screens.mjs OUT_DIR [PORT]
//   diff -r before after
//
// It starts this checkout's server on PORT (default 4791) with an in-memory
// database and Imagine Surrey's production settings (render.yaml, base-win),
// signs up the first manager and saves, for each screen, the words on it,
// the grey example words in its boxes, and its lists' choices:
//   today, map (and which map tiles it asked for: where the map opens),
//   person (with the Scrutineer and the Community committee role boxes
//   opened), rating-scale, membership-form, website-theme, field-to-list
//   (Dwelling type and Campus), training.
// Dates, times of day and ids are replaced by fixed words.
// PRESET_SCREENS_BRAND= (empty) leaves BASE_BRAND unset.
//
// The same screens for any other campaign (what a neutral one reads):
//   PRESET_SCREENS_ENV='{"BASE_BRAND":"base","BASE_ORG_NAME":"Kamloops Forward","BASE_CITY":"Kamloops","BASE_GEO_BOUNDS":"50.6,-120.5|50.8,-120.2","BASE_CANDIDATES":"none"}' \
//   PRESET_SCREENS_ONLY=today,map,rating-scale node scripts/preset-screens.mjs OUT_DIR
// PRESET_SCREENS_ENV: settings laid over (a value of null takes one away).
// PRESET_SCREENS_ONLY: only these screens.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bothNames } from '../shared/old-names.js';

const OUT = process.argv[2];
if (!OUT) { console.error('usage: node scripts/preset-screens.mjs OUT_DIR [PORT]'); process.exit(2); }
const PORT = Number(process.argv[3]) || 4791;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = `${BASE}/admin`;
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Imagine Surrey's production settings; no candidates, map area or province.
const env = { ...process.env, PORT: String(PORT), BASE_DATA: 'memory', BASE_ENV: 'production',
  BASE_ORG_NAME: 'Imagine Surrey', BASE_CITY: 'Surrey', BASE_JURISDICTION: 'bc-municipal', BASE_TZ: 'America/Vancouver',
  BASE_SLATES: 'council:City council,school_board:School board', GEOCODE_ON_SAVE: 'off' };
const brand = process.env.PRESET_SCREENS_BRAND ?? 'imagine-surrey';
if (brand) env.BASE_BRAND = brand; else for (const k of bothNames('BASE_BRAND')) delete env[k];
for (const k of ['BASE_CANDIDATES', 'BASE_GEO_BOUNDS', 'BASE_PROVINCE', 'BASE_PUBLIC_URL', 'BASE_OPEN_SIGNUP', 'NODE_ENV', 'RENDER', 'DATABASE_URL', 'BASE_PATH'].flatMap(bothNames)) delete env[k];
for (const [k, v] of Object.entries(JSON.parse(process.env.PRESET_SCREENS_ENV || '{}'))) { if (v === null) delete env[k]; else env[k] = String(v); }
delete env.PRESET_SCREENS_ENV;
const ONLY = (process.env.PRESET_SCREENS_ONLY || '').split(',').map((x) => x.trim()).filter(Boolean);
const want = (name) => !ONLY.length || ONLY.includes(name);
const server = spawn(process.execPath, [fileURLToPath(new URL('../server/index.js', import.meta.url))], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });
const stop = () => { try { server.kill('SIGTERM'); } catch { /* gone */ } };
process.on('exit', stop);
for (let i = 0; i < 120; i += 1) {
  if (await fetch(`${BASE}/api/health`).then((r) => r.ok, () => false)) break;
  if (server.exitCode != null) { console.error(`the server stopped:\n${log}`); process.exit(1); }
  await sleep(500);
}

const tidy = (s) => String(s || '')
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'ID')
  .replace(/\b(Mon|Tues?|Wed(nes)?|Thu(rs)?|Fri|Sat(ur)?|Sun)(day)?,? /g, 'DAY ')
  .replace(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.? \d{1,2}(, \d{4})?/g, 'DATE')
  .replace(/\b\d{4}-\d\d-\d\d\b/g, 'DATE')
  .replace(/\b\d{1,2}:\d\d ?([ap]\.?m\.?)?/gi, 'TIME')
  .replace(/Good (morning|afternoon|evening)/g, 'Good DAYPART')
  .replace(/\b20\d\d\b/g, 'YEAR')
  .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

const tileSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e7e3d6"/></svg>';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, timezoneId: 'America/Vancouver', serviceWorkers: 'block' });
const tilesAsked = new Set();
await ctx.route(/(?:tile\.openstreetmap\.org|basemaps\.cartocdn\.com\/[a-z_]+)\/(\d+)\/(\d+)\/(\d+)(@2x)?\.png/, (route) => {
  const m = route.request().url().match(/\/(\d+)\/(\d+)\/(\d+)(?:@2x)?\.png/);
  tilesAsked.add(`${m[1]}/${m[2]}/${m[3]}`);
  route.fulfill({ status: 200, contentType: 'image/svg+xml', headers: { 'access-control-allow-origin': '*' }, body: tileSvg });
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const api = async (path, body) => {
  const r = body === undefined ? await ctx.request.get(`${BASE}/api${path}`) : await ctx.request.post(`${BASE}/api${path}`, { data: body });
  return { status: r.status(), json: await r.json().catch(() => null) };
};

// What a screen says: its words, the example words in its boxes, its lists.
const capture = async (name, extra = '') => {
  const got = await page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    return {
      title: document.title,
      brand: document.documentElement.dataset.brand || '',
      text: document.body.innerText,
      examples: [...document.querySelectorAll('[placeholder]')].filter(vis).map((el) => el.getAttribute('placeholder')),
      choices: [...document.querySelectorAll('select')].filter(vis).map((el) => `${el.id || el.getAttribute('aria-label') || 'list'}: ${[...el.options].map((o) => o.textContent.trim()).join(' | ')}`),
      boxes: [...document.querySelectorAll('input[type=text], input:not([type]), input[type=number]')].filter(vis).map((el) => el.value).filter(Boolean),
      pictures: [...document.querySelectorAll('img')].filter(vis).map((el) => new URL(el.src, location.href).pathname),
    };
  });
  const out = [`# ${name}`, `title: ${got.title}`, `brand mark: ${got.brand}`, '## words', tidy(got.text),
    '## example words', ...got.examples.map(tidy), '## lists', ...got.choices.map(tidy), '## filled boxes', ...got.boxes.map(tidy),
    '## pictures', ...got.pictures.map(tidy), extra].join('\n');
  writeFileSync(`${OUT}/${name}.txt`, `${out}\n`);
  console.log(`saved ${name}`);
};
const go = async (path, wait = 1500) => { await page.goto(`${ADMIN}${path}`, { waitUntil: 'domcontentloaded' }); await sleep(wait); };

try {
  // The first manager, as the sign-up screen does it.
  await page.goto(`${BASE}/signup`, { waitUntil: 'domcontentloaded' });
  await page.fill('#su-name', 'Pat Manager');
  if (await page.locator('#su-org').count()) await page.fill('#su-org', env.BASE_ORG_NAME || 'Imagine Surrey');
  await page.fill('#su-email', 'pat@example.test');
  await page.fill('#su-password', 'correct-horse-battery-9');
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/admin\/?$/, { timeout: 20000 });
  await sleep(1500);

  // One person: on Imagine Surrey's map, in Surrey. For any other campaign,
  // with no pin, so the map shows where it opens by itself.
  const person = (await api('/actions/person.create', process.env.PRESET_SCREENS_ENV
    ? { name: 'Morgan Screencheck', phone: '555-555-0142', address: '100 Example St' }
    : { name: 'Morgan Screencheck', phone: '604-555-0142', address: '100 Example St', city: 'Surrey', lat: 49.133, lng: -122.851 })).json.person;

  if (want('today')) {
    await go('/');
    await capture('today');
  }

  if (want('map')) {
    tilesAsked.clear();
    await go('/map', 4000);
    await capture('map', ['## map tiles asked for (where the map opens)', ...[...tilesAsked].sort()].join('\n'));
  }

  // A person's page, with the two role boxes that have an example opened.
  if (want('person')) {
  await go(`/people/${person.id}`);
  const roles = page.locator('.pf-sec__btn:has-text("Volunteer roles")');
  await roles.waitFor({ timeout: 10000 });
  if ((await roles.getAttribute('aria-expanded')) !== 'true') { await roles.click(); await sleep(400); }
  let roleWords = '';
  for (const code of ['scrutineer', 'community_committee']) {
    await page.selectOption('#role-pick', code).catch(() => {});
    await sleep(300);
    const box = page.locator('#role-detail');
    roleWords += `\n## role ${code}\nlabel: ${await page.locator('label[for="role-detail"]').innerText().catch(() => '(none)')}\nexample: ${(await box.count()) ? await box.getAttribute('placeholder') : '(none)'}`;
  }
  await capture('person', roleWords);
  }

  if (want('rating-scale')) {
    await go('/rating-scale');
    await capture('rating-scale');
  }

  if (want('membership-form')) {
    await go('/people/membership-form', 2500);
    await capture('membership-form');
  }

  if (want('website-theme')) {
    await go('/website/theme', 3000);
    await capture('website-theme');
  }

  // Profile fields → Turn into a list, for the two fields with a standard
  // list: typed fields with words on file, as a campaign from before has them.
  if (want('field-to-list')) {
  const fields = (await api('/fields')).json.fields;
  const made = {};
  for (const name of ['Dwelling type', 'Campus']) {
    const f = fields.find((x) => x.name === name && !x.retired);
    if (f) { await api('/actions/field.update', { id: f.id, name: `${name} (new list)` }); await api('/actions/field.retire', { id: f.id }); }
    made[name] = (await api('/actions/field.create', { name, kind: 'text' })).json?.field;
  }
  const words = ['House', 'townhome', 'Apt', 'Basement suite'];
  const campus = ['kpu surrey', 'SFU Surrey', 'Kwantlen', 'UBC'];
  await api('/data/import', { rows: words.map((w, i) => ({ name: `Dw${i} Example`, fields: { [made['Dwelling type'].id]: w, [made.Campus.id]: campus[i] } })) });
  for (const [name, file] of [['Dwelling type', 'field-to-list-dwelling'], ['Campus', 'field-to-list-campus']]) {
    await go(`/people/fields?list=${made[name].id}`, 2500);
    await capture(file);
  }
  }

  // Training, by the link in the menu (its address is the campaign's own).
  if (want('training')) {
  await go('/');
  const link = page.locator('a[href*="/imagineu"], a[href*="/training"]').first();
  const href = (await link.count()) ? await link.getAttribute('href') : '/admin/training';
  await page.goto(new URL(href, ADMIN).href, { waitUntil: 'domcontentloaded' });
  await sleep(2000);
  await capture('training', `## menu link\n${await link.innerText().catch(() => '')}`);
  }

  writeFileSync(`${OUT}/_errors.txt`, `${errors.join('\n')}\n`);
  console.log(errors.length ? `page errors: ${errors.length}` : 'no page errors');
} finally {
  await browser.close();
  stop();
}
process.exit(0);
