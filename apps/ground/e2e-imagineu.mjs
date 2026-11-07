// ImagineU — courses of modules, each module a mix of materials, the module
// the marker of progress. A fresh in-memory campaign: the desk (Admin →
// ImagineU → Edit) adds a course, then a module that opens with a note and
// holds a video link and a PDF; a volunteer on a phone opens the module,
// sees its materials in order, marks it done, and the course reads
// "1 of 1 module done". Measured at 390.
//
//   BASE_OPEN_SIGNUP=1 BASE_DATA=memory PORT=4134 node server/index.js &
//   BASE=http://127.0.0.1:4134 SHOTS=/tmp/imagineu node e2e-imagineu.mjs
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.BASE || 'http://localhost:3200';
const ADMIN = `${BASE}/admin`;
const SHOTS = process.env.SHOTS || '/tmp/base-ground-imagineu';
mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 220) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Math.random().toString(36).slice(2, 8);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const errors = [];
const pdfPath = join(tmpdir(), `walk-sheet-${tag}.pdf`);
writeFileSync(pdfPath, '%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');

const dctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, timezoneId: 'America/Vancouver' });
const page = await dctx.newPage();
page.on('pageerror', (e) => errors.push(`desk: ${e.message}`));
const api = async (path, body) => {
  const r = body === undefined ? await dctx.request.get(`${BASE}/api${path}`) : await dctx.request.post(`${BASE}/api${path}`, { data: body });
  return { status: r.status(), json: await r.json().catch(() => null) };
};
await page.goto(`${BASE}/signup`);
await page.fill('#su-name', 'Marco Manager');
if (await page.locator('#su-org').count()) await page.fill('#su-org', 'Imagine Surrey');
await page.fill('#su-email', `marco+${tag}@learn.example`);
await page.fill('#su-password', 'surrey-forward-2026');
await page.click('button[type="submit"]');
await page.waitForURL(/\/admin\/?$/, { timeout: 15000 });

// ── The desk: a course, then a module with materials ──
await page.goto(`${ADMIN}/imagineu`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.lu-head', { timeout: 10000 });
await page.click('.lu-tools button:has-text("Edit")');
await page.click('button:has-text("+ Add a course")');
await page.fill('.lu-form input[placeholder="Canvassing 101"]', 'Canvassing 101');
await page.click('.lu-form button:has-text("Add course")');
await page.waitForSelector('.lu-sec__h:has-text("Canvassing 101")', { timeout: 8000 });
await page.click('button:has-text("+ Add a module to Canvassing 101")');
await page.fill('.lu-form--lesson input[placeholder="At the door"]', 'At the door');
await page.fill('.lu-form--lesson textarea >> nth=0', 'What a knock sounds like.');
await page.click('.lu-parts-ed__add button:has-text("+ Video")');
await page.fill('.lu-part-ed >> nth=0 >> input[type="url"]', 'https://www.youtube.com/watch?v=abcdefghijk');
await page.fill('.lu-part-ed >> nth=0 >> input[maxlength="160"]', 'Watch first');
await page.click('.lu-parts-ed__add button:has-text("+ Document")');
await page.setInputFiles('.lu-part-ed >> nth=1 >> input[type="file"]', pdfPath);
await page.waitForSelector('.lu-part-ed >> nth=1 >> .lu-file__cur', { timeout: 10000 }).catch(() => {});
check('the PDF uploads into material 2', /walk-sheet/.test(await page.innerText('.lu-part-ed >> nth=1').catch(() => '')));
await page.screenshot({ path: `${SHOTS}/01-module-editor.png`, fullPage: true });
await page.click('.lu-form--lesson button:has-text("Add module")');
await page.waitForSelector('.lu-row:has-text("At the door")', { timeout: 8000 }).catch(() => {});
const row = (await page.innerText('.lu-row:has-text("At the door")').catch(() => '')).replace(/\s+/g, ' ');
check('the module’s row says what it holds: Note · Video · Document', /Note · Video · Document/.test(row), row);
const home = (await api('/learn')).json;
const mod = home.sections[0].lessons[0];
check('the server: one course, one module with two materials', home.sections.length === 1 && mod.parts.join() === 'video,document', JSON.stringify(mod.parts));

// ── A volunteer on a phone ──
const inv = (await api('/actions/member.invite', { email: `vic+${tag}@learn.example`, role: 'volunteer' })).json;
const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/Vancouver' });
const vp = await pctx.newPage();
vp.on('pageerror', (e) => errors.push(`vol: ${e.message}`));
await vp.goto(`${BASE}/join/${inv.joinUrl.split('/join/')[1]}`);
await vp.fill('input[autocomplete="name"], #jn-name', 'Vic Volunteer').catch(() => {});
await vp.fill('input[type="password"]', 'vic-pass-2026');
await vp.click('button[type="submit"]');
await vp.waitForURL((u) => !/\/join\//.test(String(u)), { timeout: 15000 }).catch(() => {});
await vp.goto(`${BASE}/imagineu`, { waitUntil: 'domcontentloaded' });
await vp.waitForSelector('.lu-row', { timeout: 10000 }).catch(() => {});
check('the course reads "0 of 1 module done"', /0 of 1 module done/.test(await vp.innerText('.lu-course').catch(() => '')));
await vp.tap('.lu-row:has-text("At the door")');
await vp.waitForSelector('.lu-lesson h1', { timeout: 8000 }).catch(() => {});
const parts = await vp.$$eval('.lu-part .lu-part__h', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
check('the module: its note, then Video "Watch first", then Document', parts.length === 2 && /Video Watch first/i.test(parts[0]) && /Document/i.test(parts[1]), parts.join(' | '));
check('the video is embedded; the PDF opens', !!(await vp.$('.lu-part iframe[src*="youtube-nocookie"]')) && !!(await vp.$('.lu-part a:has-text("Open the PDF")')));
const m = await vp.evaluate(() => ({ overflow: document.documentElement.scrollWidth - window.innerWidth }));
check('at 390: no sideways scroll', m.overflow <= 0, JSON.stringify(m));
await vp.screenshot({ path: `${SHOTS}/02-module-phone.png`, fullPage: true });
await vp.tap('button:has-text("Mark this module done")');
await sleep(700);
check('done: "✓ Module done — undo"', /Module done/.test(await vp.innerText('.lu-done').catch(() => '')));
await vp.goto(`${BASE}/imagineu`, { waitUntil: 'domcontentloaded' });
await vp.waitForSelector('.lu-course', { timeout: 8000 }).catch(() => {});
check('the course now reads "1 of 1 module done"', /1 of 1 module done/.test(await vp.innerText('.lu-course').catch(() => '')));
await vp.screenshot({ path: `${SHOTS}/03-course-done.png` });

// ── The desk's Progress ──
await page.goto(`${ADMIN}/imagineu/progress`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.lu-prow', { timeout: 8000 }).catch(() => {});
check('Progress: Vic 1 / 1', /Vic Volunteer[\s\S]*1 \/ 1/.test(await page.innerText('.lu-plist').catch(() => '')));
check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
