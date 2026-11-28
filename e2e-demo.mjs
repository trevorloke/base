// The public demo, in a browser — what a visitor on base.win sees. One
// server set up exactly as render.yaml's staging block sets staging, with
// its database kept in a folder so it can be stopped and started again, as
// a deploy does. The walk:
//   1. The server makes the sample by itself; a visitor who opens the app
//      lands in it, signed in as the demo account, with no password asked.
//   2. /login?stay=1 keeps the sign-in form (someone with their own
//      account); a browser that keeps no cookie sees the form and "The demo
//      could not sign you in." after one try, not a loop.
//   3. A sample being made (another start at it): the demo's door shows
//      "The demo is being refreshed" and tries again every 10 seconds; at
//      390 px, nothing wider than the screen.
//   4. A release with a newer sample: the server drops the old one at its
//      start and makes the new one. The browser left open on the demo ends
//      on the new sample, signed in, without being asked for a password;
//      what the visitor typed is gone. The server keeps its instance.
//
//   npm run build  then  PORT=5690 SHOTS=/tmp/demo node e2e-demo.mjs
import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stagingBlock } from './server/test/sample-prints.js';
import { bothNames } from './shared/old-names.js';

const PORT = Number(process.env.PORT) || 5690;
const A = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOTS || '/tmp/base-win-demo';
const DATA = `${SHOTS}/data`;
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
const ROOT = fileURLToPath(new URL('.', import.meta.url));
const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 260) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Staging's own settings (NODE_ENV aside: its Secure cookies need https).
const BLOCK = stagingBlock();
delete BLOCK.NODE_ENV;
const env = { ...process.env, ...BLOCK, BASE_DATA: DATA, PORT: String(PORT), BASE_JOBS: 'off', GEOCODER: 'off', GEOCODE_ON_SAVE: 'off' };
for (const k of ['BASE_OPEN_SIGNUP', 'BASE_SAMPLE_RESET', 'BASE_PLATFORM_PUBKEY', 'BASE_PUBLIC_URL', 'BASE_PATH', 'DATABASE_URL'].flatMap(bothNames)) delete env[k];

let server = null;
let log = '';
const start = () => new Promise((resolve, reject) => {
  log = '';
  server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  const t = setTimeout(() => reject(new Error(`the server did not start: ${log.slice(-400)}`)), 60_000);
  const look = setInterval(() => { if (/base\.win on :/.test(log)) { clearInterval(look); clearTimeout(t); resolve(); } }, 100);
});
const stop = () => new Promise((resolve) => {
  if (!server || server.exitCode !== null) { resolve(); return; }
  server.once('exit', () => resolve());
  server.kill('SIGTERM');
});
process.on('exit', () => { try { server?.kill('SIGKILL'); } catch { /* gone */ } });
const until = async (what, test, ms = 120_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await test()) return true; await sleep(250); }
  throw new Error(`waited ${ms / 1000} s for ${what}; the server said: ${log.slice(-600)}`);
};
// The stopped server's database, changed by hand (what a newer release, or
// a make under way, leaves there).
const sql = (statement) => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { PGlite } = await import('@electric-sql/pglite');
    const db = new PGlite(${JSON.stringify(DATA)});
    await db.query(${JSON.stringify(statement)});
    await db.close();`], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
};
const health = () => fetch(`${A}/api/health`).then((r) => r.json()).catch(() => null);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const errors = [];
const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const open = async (viewport = WIDE, label = 'visitor') => {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, timezoneId: 'America/Vancouver', ...(viewport === PHONE ? { isMobile: true, hasTouch: true } : {}) });
  // No tile server is reached.
  await ctx.route(/\/(\d+)\/(\d+)\/(\d+)(@2x)?\.png(\?.*)?$/, (route) => (/\/api\//.test(route.request().url()) ? route.continue() : route.fulfill({ status: 204 })));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`[${label}] ${e.message}`));
  return { ctx, page };
};
const me = (page) => page.evaluate(async () => {
  const r = await fetch('/api/auth/me');
  return { status: r.status, json: await r.json().catch(() => null) };
});
const people = (page) => page.evaluate(async () => (await (await fetch('/api/persons?limit=2000')).json()).persons);
const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
const signedInOff = (page) => !/\/login/.test(new URL(page.url()).pathname);

try {
  // ── 1. The sample makes itself; a visitor lands in it ──
  await start();
  await until('the sample', () => /sample: made/.test(log));
  const firstInstance = (await health())?.instance;
  check('the server made the sample by itself', /"people":320/.test(log), log.match(/sample: made .*/)?.[0]);

  const { page: visitor } = await open(WIDE, 'visitor');
  await visitor.goto(`${A}/`);
  await until('the visitor in the app', async () => (await me(visitor)).status === 200 && signedInOff(visitor), 30_000);
  const who = await me(visitor);
  check('a visitor who opens the app is signed in as the demo account', who.json?.user?.email === BLOCK.BASE_DEMO_EMAIL, who.json?.user?.email);
  await visitor.waitForLoadState('networkidle');
  check('no password is asked', await visitor.locator('input[type=password]').count() === 0);
  const first = await people(visitor);
  check('the people are the sample’s: 320 at 99xx addresses', first.length === 320 && first.every((p) => /^99\d\d /.test(p.address)), first.length);
  await shot(visitor, '1-in-the-demo');

  // ── 2. ?stay=1 keeps the form; no cookie, no loop ──
  const { ctx: stayCtx, page: stay } = await open(WIDE, 'stay');
  await stay.goto(`${A}/login?stay=1`);
  await stay.getByRole('heading', { name: 'Sign in' }).waitFor();
  await sleep(1500);
  check('/login?stay=1 keeps the sign-in form', /\/login/.test(stay.url()) && await stay.locator('#login-email').isVisible());
  await stayCtx.close();

  const { ctx: noCookie, page: nc } = await open(WIDE, 'no cookie');
  let doors = 0;
  // The door's answer without its cookie (fetched outside the browser, whose
  // own fetch would keep the cookie).
  await noCookie.route('**/api/auth/demo', async (route) => {
    doors += 1;
    const res = await fetch(route.request().url(), { redirect: 'manual' });
    const headers = Object.fromEntries([...res.headers].filter(([k]) => k !== 'set-cookie'));
    await route.fulfill({ status: res.status, headers, body: Buffer.from(await res.arrayBuffer()) });
  });
  await nc.goto(`${A}/login`);
  await nc.getByText('The demo could not sign you in.').waitFor({ timeout: 20_000 });
  await sleep(2000);
  check('a browser that keeps no cookie: the form and one line, after one try', doors === 1 && await nc.locator('#login-email').isVisible(), `${doors} tries`);
  await shot(nc, '2-no-cookie');
  await noCookie.close();

  // The visitor types something of their own.
  const typed = await visitor.evaluate(async () => (await fetch('/api/actions/person.create', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Left Behind' }),
  })).status);
  check('the visitor adds a person', typed === 200, typed);

  // ── 3. A make under way: the refresh page ──
  await stop();
  sql("update sample_meta.made set state = 'making', version = 1, at = now()");
  await start();
  const { ctx: phoneCtx, page: phone } = await open(PHONE, 'phone');
  const r = await phone.goto(`${A}/api/auth/demo`);
  check('the door answers 503 while the sample is made', r.status() === 503, r.status());
  check('it says the demo is being refreshed', await phone.getByText('The demo is being refreshed. It will be back in about a minute.').isVisible());
  check('and tries again every 10 seconds', await phone.locator('meta[http-equiv="refresh"][content="10"]').count() === 1);
  const wide = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check('no sideways scroll at 390 px', !wide);
  await shot(phone, '3-refreshing-390');
  await phoneCtx.close();

  // ── 4. A newer sample: made again; the open browser ends on it ──
  await stop();
  sql("update sample_meta.made set state = 'made', version = 1, at = now()");
  await start();
  await until('the new sample', () => /sample: made/.test(log));
  check('the old sample was dropped and the new one made', /the old sample was dropped/.test(log) && /"people":320/.test(log));
  check('the server keeps its instance (the control centre still knows it)', (await health())?.instance === firstInstance);
  // The visitor's next click.
  await visitor.reload();
  await until('the visitor back in', async () => (await me(visitor)).status === 200 && signedInOff(visitor), 60_000);
  await visitor.waitForLoadState('networkidle');
  check('the open browser ends on the new sample, signed in, with no password asked', await visitor.locator('input[type=password]').count() === 0);
  const after = await people(visitor);
  check('what the visitor typed is gone', after.length === 320 && !after.some((p) => p.name === 'Left Behind'), after.length);
  await shot(visitor, '4-new-sample');

  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  check(`the walk ran to the end: ${e.message}`, false);
} finally {
  await browser.close();
  await stop();
}
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
