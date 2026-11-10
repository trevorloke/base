// A page from before a deploy — browser suite. Two builds of the web app take
// turns on one running server (the second is the first under new file names,
// as every build has), and a manager's tabs live through the change:
//   1. a tab open across a deploy, the service worker installed: its next
//      answer from the server names the new build, the strip under the nav
//      says "A new version is ready · Reload", the next link is a full page
//      load, and the map shows the people on file — never "All 0", never a
//      blank screen. The worker keeps the build before's files, so a tab
//      that has not caught up yet still opens a screen it had not opened;
//   2. no service worker (a private window): a screen whose file is gone
//      (404, not the app's page under a .js name) — the tab reloads itself
//      once and the screen opens on the new build;
//   3. the server slow to hand over the page after a deploy: the worker shows
//      the page it kept, and that page gives way to the new one by itself;
//   4. a screen that cannot load at all says "This screen didn’t load ·
//      Reload" — once, with the rest of the app still there.
// Needs a web build (web/dist). It swaps that folder under the server while
// it runs and puts it back as it found it.
//
//   (cd web && npm run build) && node e2e-deploy.mjs      (its own server on :4946, a slow door on :4947)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT) || 4946;
const DOOR = Number(process.env.DOOR_PORT) || PORT + 1;
const SHOTS = process.env.SHOTS || join(tmpdir(), 'basewin-deploy-shots');
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 260) : ''}`);
};

// ── Two builds ──
const DIST = fileURLToPath(new URL('./web/dist', import.meta.url));
if (!existsSync(join(DIST, 'index.html'))) {
  console.error('no web build: (cd web && npm run build) first');
  process.exit(1);
}
const TMP = mkdtempSync(join(tmpdir(), 'basewin-deploy-'));
const BUILD_A = join(TMP, 'a');
const BUILD_B = join(TMP, 'b');
cpSync(DIST, BUILD_A, { recursive: true });
// The same build under new names: every script and stylesheet in assets/
// gets a new stamp, and every file that names one is told.
const restamp = (from, to) => {
  cpSync(from, to, { recursive: true });
  const renamed = new Map();
  for (const f of readdirSync(join(to, 'assets'))) {
    const m = /^(.+-[A-Za-z0-9_-]{6,})\.(js|css)$/.exec(f);
    if (m) renamed.set(f, `${m[1]}b.${m[2]}`);
  }
  for (const [was, now] of renamed) renameSync(join(to, 'assets', was), join(to, 'assets', now));
  const names = new RegExp([...renamed.keys()].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  const tell = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) tell(p);
      else if (/\.(js|css|html)$/.test(e.name)) writeFileSync(p, readFileSync(p, 'utf8').replace(names, (n) => renamed.get(n)));
    }
  };
  tell(to);
};
restamp(BUILD_A, BUILD_B);
const entryOf = (dir) => /\/assets\/(index-[A-Za-z0-9._-]+\.js)/.exec(readFileSync(join(dir, 'index.html'), 'utf8'))?.[1];
const A = entryOf(BUILD_A);
const B = entryOf(BUILD_B);
const chunkOf = (dir, screen) => readdirSync(join(dir, 'assets')).find((f) => new RegExp(`^${screen}-.*\\.js$`).test(f));
// A deploy: the other build takes the server's folder. (The server looks at
// its page again within two seconds.)
const deploy = async (dir) => {
  rmSync(DIST, { recursive: true, force: true });
  cpSync(dir, DIST, { recursive: true });
  await sleep(2400);
};

// ── The server, and a door in front of it that can be slow to hand over a page ──
const server = spawn(process.execPath, ['server/index.js'], {
  cwd: fileURLToPath(new URL('.', import.meta.url)),
  env: { ...process.env, STARBASE_OPEN_SIGNUP: '1', STARBASE_DATA: 'memory', PORT: String(PORT), STARBASE_JOBS: 'off', GEOCODE_ON_SAVE: 'off' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('server did not start')), 30000);
  server.stdout.on('data', (b) => { if (/starbase on :/.test(String(b))) { clearTimeout(t); resolve(); } });
  server.on('exit', (code) => reject(new Error(`server exited ${code}`)));
});
const slow = { path: null, ms: 0 };
const door = http.createServer((req, res) => {
  const pass = () => {
    const up = http.request({ host: '127.0.0.1', port: PORT, method: req.method, path: req.url, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  };
  if (slow.path && slow.path.test(req.url.split('?')[0])) setTimeout(pass, slow.ms); else pass();
});
await new Promise((resolve) => door.listen(DOOR, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${DOOR}`;

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const errors = [];
const tileSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e7e3d6"/></svg>';
const EMAIL = `deploy+${Date.now().toString(36)}@example.org`;
const PASSWORD = 'surrey-forward-2026';
let signedUp = false;
const context = async (opts = {}) => {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, timezoneId: 'America/Vancouver', ...opts });
  await ctx.route(/tile\.openstreetmap\.org|basemaps\.cartocdn\.com/, (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', headers: { 'access-control-allow-origin': '*' }, body: tileSvg }));
  const r = signedUp
    ? await ctx.request.post(`${BASE}/api/auth/login`, { data: { email: EMAIL, password: PASSWORD } })
    : await ctx.request.post(`${BASE}/api/auth/signup`, { data: { name: 'Riley Manager', email: EMAIL, password: PASSWORD, workspaceName: 'Deploy day', jurisdiction: 'bc-municipal' } });
  if (!r.ok()) throw new Error(`sign-in ${r.status()} ${await r.text()}`);
  signedUp = true;
  return ctx;
};
const tab = async (ctx, who) => {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`[${who}] ${e.message}`));
  return page;
};
// What a tab shows: which build it runs, whether there is anything on screen,
// the map's count, and the words that matter here.
const state = (page) => page.evaluate(() => {
  const words = (document.body.innerText || '').replace(/\s+/g, ' ');
  return {
    build: [...document.scripts].map((s) => s.src).find((s) => /\/assets\/index-/.test(s))?.split('/').pop() || null,
    root: document.getElementById('root')?.children.length || 0,
    path: location.pathname,
    h1: document.querySelector('main.page h1')?.innerText || null,
    pill: document.querySelector('.map-filter-btn')?.innerText.replace(/\s+/g, ' ').trim() || null,
    noDoors: /No doors yet/.test(words),
    newVersion: /A new version is ready/.test(words),
    didntLoad: /This screen didn.t load/.test(words),
    reload: [...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'Reload' && b.getBoundingClientRect().height > 0),
  };
});
const doorsOf = (st) => Number((/All\s+([\d,]+)/.exec(st.pill || '') || [])[1]?.replace(/,/g, '') ?? NaN);
const until = async (page, fn, ms = 15000) => {
  const end = Date.now() + ms;
  let st = await state(page).catch(() => null);
  while (!(st && fn(st)) && Date.now() < end) { await sleep(250); st = await state(page).catch(() => null); }
  return st || {};
};
const workerReady = async (page) => {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await sleep(4000); // the worker keeps the whole build
};
const kept = (page, names) => page.evaluate(async (list) => {
  const have = new Set();
  for (const n of await caches.keys()) for (const k of await (await caches.open(n)).keys()) have.add(k.url.split('/').pop());
  return list.map((f) => have.has(f));
}, names);

let failed = null;
try {
  // ══ 1. A tab open across a deploy, the service worker installed ══
  const ctx1 = await context();
  for (const [i, lat, lng] of [[1, 49.133, -122.851], [2, 49.1331, -122.8495], [3, 49.131, -122.852], [4, 49.132, -122.848], [5, 49.1295, -122.848], [6, 49.134, -122.853]]) {
    const r = await ctx1.request.post(`${BASE}/api/actions/person.create`, { data: { name: `Voter ${i} Example`, address: `${12300 + i * 10} 72 Ave`, city: 'Surrey', lat, lng } });
    if (!r.ok()) throw new Error(`seed ${r.status()} ${await r.text()}`);
  }
  const first = await tab(ctx1, 'first');
  await first.goto(`${BASE}/admin/`, { waitUntil: 'networkidle' });
  await workerReady(first);
  const waiting = await tab(ctx1, 'waiting'); // a second tab, left on Today
  await waiting.goto(`${BASE}/admin/`, { waitUntil: 'networkidle' });
  let st = await state(first);
  check('before the deploy: the tab runs the build on the server', st.build === A && st.root > 0 && !st.newVersion, JSON.stringify(st));
  const health = async () => (await (await ctx1.request.get(`${BASE}/api/health`)).json()).build;
  check('the server names its build', await health() === A, await health());

  await deploy(BUILD_B);
  check('after the deploy it names the new one', await health() === B, await health());
  await first.click('nav.links a[href$="/map"]');
  st = await until(first, (s) => s.pill && /All\s+\d/.test(s.pill) && (s.newVersion || s.build === B));
  await first.screenshot({ path: `${SHOTS}/1-open-tab-after-deploy.png` });
  check('the open tab, Map: the people on file, never "All 0" or a blank screen', doorsOf(st) === 6 && !st.noDoors && st.root > 0, JSON.stringify(st));
  check('…and it says a new version is ready (or already runs it)', st.build === B || (st.newVersion && st.reload), JSON.stringify(st));
  if (st.build !== B) {
    // The next link is a full page load: the new build arrives with it.
    await first.click('nav.links a[href$="/people"]');
    st = await until(first, (s) => s.build === B && s.h1 === 'People');
    check('the next link is a full load: People, on the new build', st.build === B && st.h1 === 'People' && !st.newVersion, JSON.stringify(st));
  }
  // A new tab takes the new page; the worker takes in the new build and keeps the one before.
  const fresh = await tab(ctx1, 'fresh');
  await fresh.goto(`${BASE}/admin/map`, { waitUntil: 'domcontentloaded' });
  st = await until(fresh, (s) => s.build === B && /All\s+\d/.test(s.pill || ''));
  check('a new tab after the deploy runs the new build', st.build === B && doorsOf(st) === 6 && !st.newVersion, JSON.stringify(st));
  await sleep(6000);
  const files = [chunkOf(BUILD_A, 'People'), chunkOf(BUILD_B, 'People'), chunkOf(BUILD_A, 'Map'), chunkOf(BUILD_B, 'Map')];
  const have = await kept(fresh, files);
  check('the worker has the new build, and keeps the files of the one before', have.every(Boolean), files.map((f, i) => `${f}:${have[i]}`).join(' '));
  // The tab left on Today across the deploy opens a screen it had not opened.
  await waiting.click('nav.links a[href$="/people"]');
  st = await until(waiting, (s) => s.h1 === 'People');
  await waiting.screenshot({ path: `${SHOTS}/1-tab-left-open-next-screen.png` });
  check('a tab left open opens a screen it had not opened — not a blank page', st.h1 === 'People' && st.root > 0, JSON.stringify(st));
  st = await until(waiting, (s) => s.build === B || s.newVersion, 6000);
  check('…and knows a new version is ready (or runs it)', st.build === B || (st.newVersion && st.reload), JSON.stringify(st));
  if (st.build !== B) {
    await waiting.click('button:has-text("Reload")', { timeout: 4000 }).catch(() => {});
    st = await until(waiting, (s) => s.build === B && s.h1 === 'People');
    check('Reload brings the new build, on the same screen', st.build === B && st.h1 === 'People' && !st.newVersion, JSON.stringify(st));
  }
  await ctx1.close();

  // ══ 2. No service worker: the screen's file is gone ══
  const ctx2 = await context({ serviceWorkers: 'block' });
  const priv = await tab(ctx2, 'no-worker');
  await priv.goto(`${BASE}/admin/`, { waitUntil: 'networkidle' });
  st = await state(priv);
  const gone = await ctx2.request.get(`${BASE}/assets/${chunkOf(BUILD_A, 'People')}`);
  check('a file of the build before is a 404, not the app’s page', gone.status() === 404 && !/html/.test(gone.headers()['content-type'] || ''), `${gone.status()} ${gone.headers()['content-type']}`);
  await deploy(BUILD_A); // the server moves on; this tab still runs B
  let loads = 0;
  priv.on('framenavigated', (f) => { if (f === priv.mainFrame()) loads += 1; });
  await priv.click('nav.links a[href$="/people"]');
  st = await until(priv, (s) => s.h1 === 'People' && s.build === A);
  await priv.screenshot({ path: `${SHOTS}/2-no-worker-file-gone.png` });
  check('its file gone, the tab reloads itself and the screen opens on the new build', st.h1 === 'People' && st.build === A && st.root > 0, JSON.stringify(st));
  await sleep(1500);
  check('…once, not round and round', loads >= 1 && loads <= 2 && (await state(priv)).h1 === 'People', `page loads after the click: ${loads}`);
  await ctx2.close();

  // ══ 3. The server slow to hand over the page after a deploy ══
  const ctx3 = await context();
  const before = await tab(ctx3, 'kept');
  await before.goto(`${BASE}/admin/map`, { waitUntil: 'networkidle' });
  await workerReady(before);
  st = await state(before);
  check('the worker has the page of the build on the server', st.build === A && doorsOf(st) === 6, JSON.stringify(st));
  await before.close();
  await deploy(BUILD_B);
  slow.path = /^\/admin\/map$/;
  slow.ms = 6000;
  const again = await tab(ctx3, 'kept-again');
  const t0 = Date.now();
  await again.goto(`${BASE}/admin/map`, { waitUntil: 'domcontentloaded' });
  const opened = Date.now() - t0;
  check('six seconds for the page: the worker shows the one it kept after four', opened > 3000 && opened < 5800, `${opened} ms`);
  st = await until(again, (s) => s.build === B && /All\s+\d/.test(s.pill || ''), 25000);
  await again.screenshot({ path: `${SHOTS}/3-slow-page-after-deploy.png` });
  check('the kept page gives way to the new build by itself, and the map shows the people on file', st.build === B && doorsOf(st) === 6 && !st.noDoors, JSON.stringify(st));
  slow.path = null;
  await again.reload({ waitUntil: 'domcontentloaded' });
  st = await until(again, (s) => /All\s+\d/.test(s.pill || ''));
  check('a reload stays on the new build', st.build === B && doorsOf(st) === 6 && !st.newVersion, JSON.stringify(st));
  await ctx3.close();

  // ══ 4. A screen that cannot load at all ══
  const ctx4 = await context({ serviceWorkers: 'block' });
  const broken = await tab(ctx4, 'broken');
  await broken.route(/\/assets\/People-[^/]+\.js$/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: 'throw new Error("this screen is broken")' }));
  await broken.goto(`${BASE}/admin/`, { waitUntil: 'networkidle' });
  loads = 0;
  broken.on('framenavigated', (f) => { if (f === broken.mainFrame()) loads += 1; });
  await broken.click('nav.links a[href$="/people"]');
  st = await until(broken, (s) => s.didntLoad, 12000);
  await broken.screenshot({ path: `${SHOTS}/4-screen-didnt-load.png` });
  check('a screen that cannot load says so, with Reload — not a blank page', st.didntLoad && st.reload && st.root > 0, JSON.stringify(st));
  check('…after trying again once by itself', loads <= 2, `page loads after the click: ${loads}`);
  await broken.click('nav.links a[href$="/map"]');
  st = await until(broken, (s) => /All\s+\d/.test(s.pill || ''));
  check('the rest of the app is still there: Map opens', doorsOf(st) === 6 && !st.didntLoad, JSON.stringify(st));
  await ctx4.close();

  const expected = /this screen is broken|dynamically imported module|Importing a module script failed/i;
  const stray = errors.filter((e) => !expected.test(e));
  check('no other page errors', stray.length === 0, stray.join(' | '));
} catch (e) {
  failed = e;
} finally {
  await browser.close().catch(() => {});
  door.close();
  server.kill();
  // The folder as it was found.
  rmSync(DIST, { recursive: true, force: true });
  cpSync(BUILD_A, DIST, { recursive: true });
  rmSync(TMP, { recursive: true, force: true });
}
if (failed) { console.error('FAILED', failed); process.exit(1); }
const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
