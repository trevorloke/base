// The map shows streets, and says why when it doesn't — browser suite for
// the blank Map of November 2026: since late August CARTO answers a request
// with no key with one picture reading "API KEY REQUIRED", which loads like
// any tile, so the Map opened on Clean showed doors on blank grey and
// nothing said why. Stage 1 (MAP decisions 1–8):
//   1. no CARTO key (:5410): nothing is asked of CARTO; the map draws
//      OpenStreetMap's Standard (Show → Map: no Clean, Standard chosen); a
//      phone that saved Clean draws Standard; nothing is saved until a tap;
//   2. a key (:5411), CARTO sending its notice: the map finds it, switches to
//      Muted by itself and says "The street map wasn’t showing streets —
//      switched to Muted"; People and back keeps Muted with no second line;
//      a manager's Why? opens the Map check, whose top line is "Clean ·
//      CARTO — sends a notice, not streets" with the picture of what this
//      phone got; staff and volunteers see the line with no Why?; no probe
//      sends no-cache headers;
//   3. a key, CARTO answering streets: Clean draws, keyed, nothing said, the
//      check's picture is a street tile; at most two probe asks to CARTO;
//   4. a probe that can't run (no CORS header): no verdict, no false alarm;
//   5. Google down (:5413), and with STARBASE_TILE_CLEAN=off (:5414): the
//      free map is OpenStreetMap, said as GMP says it; no probe of /tiles/;
//   10. under BASE_PATH (:5412): step 1, and the check's picture loads.
// Stand-ins answer every tile host (the sandbox reaches none); every person
// is made up. The notice is a PNG made here; a good tile is a picture of its
// own address.
//
//   (cd web && npm run build) && node e2e-maplive.mjs     servers on :5410–:5414 (a stand-in Google on a free port)
//   ONLY=nokey,notice,good,nocors,google,basepath        just those steps
//   SHOTS=<dir>                                          where the screenshots go
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHOTS = process.env.SHOTS || join(tmpdir(), 'basewin-maplive-shots');
mkdirSync(SHOTS, { recursive: true });
const ONLY = new Set((process.env.ONLY || '').split(',').filter(Boolean));
const want = (part) => !ONLY.size || ONLY.has(part);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 400) : ''}`);
};
const errors = [];
const procs = [];

// ── A stand-in Google (GMP's Map Tiles): 'ok' or 'billing' (refuses all) ──
const PNG1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const g = { mode: 'billing' };
const BILLING = JSON.stringify({ error: { code: 403, message: 'This API method requires billing to be enabled.', status: 'PERMISSION_DENIED', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'BILLING_DISABLED' }] } });
const standInGoogle = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (g.mode === 'billing') { res.writeHead(403, { 'content-type': 'application/json' }); res.end(BILLING); return; }
  if (u.pathname === '/v1/createSession') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ session: 's1', expiry: String(Math.floor(Date.now() / 1000) + 86400) })); return; }
  if (u.pathname === '/tile/v1/viewport') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ copyright: 'Map data ©2026 Google' })); return; }
  res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG1);
});
await new Promise((resolve) => standInGoogle.listen(0, '127.0.0.1', resolve));
const GOOGLE_URL = `http://127.0.0.1:${standInGoogle.address().port}/v1`;

const start = (port, env) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, ['server/index.js'], {
    cwd: fileURLToPath(new URL('.', import.meta.url)),
    env: { ...process.env, STARBASE_OPEN_SIGNUP: '1', STARBASE_DATA: 'memory', PORT: String(port), GEOCODE_ON_SAVE: 'off', GEOCODER: 'off', STARBASE_TILE_CARTO_KEY: '', STARBASE_TILE_CLEAN: '', GOOGLE_MAPS_SERVER_KEY: '', GOOGLE_MAPS_TILES: '', ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  procs.push(p);
  const t = setTimeout(() => reject(new Error(`server :${port} did not start`)), 30000);
  p.stdout.on('data', (b) => { if (/starbase on :/.test(String(b))) { clearTimeout(t); resolve(`http://127.0.0.1:${port}`); } });
  p.on('exit', (code) => { clearTimeout(t); reject(new Error(`server :${port} exited ${code}`)); });
});

process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });

// The notice: one PNG, "API KEY REQUIRED" on a blank background (made-up words
// in CARTO's manner), the same for every tile — made here, in the browser.
let NOTICE;
{
  const p = await browser.newPage({ viewport: { width: 256, height: 256 }, deviceScaleFactor: 1 });
  await p.setContent('<body style="margin:0;width:256px;height:256px;background:#e9e9e9;display:flex;align-items:center;justify-content:center;font:bold 18px sans-serif;color:#9a9a9a">API KEY REQUIRED</body>');
  NOTICE = await p.screenshot({ type: 'png' });
  await p.close();
}
const streetSvg = (path) => `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#f4f1ea"/><path d="M0 96H256M80 0V256M0 200H256" stroke="#ffffff" stroke-width="10"/><text x="8" y="20" font-size="11" fill="#bbb">${path}</text></svg>`;
const CORS = { 'access-control-allow-origin': '*' };

// One context: CARTO answers as `carto` says ('notice' | 'good' | 'notice-nocors'),
// OpenStreetMap with good streets; every request to either is recorded.
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 };
const DESK = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 };
const newContext = async (opts, net) => {
  const ctx = await browser.newContext({ timezoneId: 'America/Vancouver', serviceWorkers: 'allow', ...opts });
  await ctx.route(/basemaps\.cartocdn\.com/, (route) => {
    const r = route.request();
    // type 'probe': asked by the page's own script (the notice probe), not a
    // tile it draws, nor the service worker fetching one.
    const probe = r.resourceType() === 'fetch' && !r.serviceWorker();
    net.carto.push({ url: r.url(), type: probe ? 'probe' : r.resourceType(), headers: r.headers() });
    // A stand-in can't leave out the CORS header the way a host does: the
    // browser doesn't check it on an answer made here. A script's ask is
    // refused instead, which is what the page sees either way (a TypeError).
    if (net.cartoMode === 'notice-nocors' && probe) return route.abort('failed');
    if (net.cartoMode === 'good') return route.fulfill({ status: 200, contentType: 'image/svg+xml', headers: CORS, body: streetSvg(new URL(r.url()).pathname) });
    return route.fulfill({ status: 200, contentType: 'image/png', headers: net.cartoMode === 'notice-nocors' ? {} : CORS, body: NOTICE });
  });
  await ctx.route(/tile\.openstreetmap\.org/, (route) => {
    const r = route.request();
    net.osm.push({ url: r.url(), type: r.resourceType(), headers: r.headers() });
    return route.fulfill({ status: 200, contentType: 'image/svg+xml', headers: CORS, body: streetSvg(new URL(r.url()).pathname) });
  });
  return ctx;
};
const freshNet = (cartoMode) => ({ cartoMode, carto: [], osm: [] });

// A campaign on one server: a manager, a staff member and a volunteer, and a
// few made-up people with pins.
const campaign = async (base, prefix = '') => {
  const tag = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const net = freshNet('good');
  const mc = await newContext(DESK, net);
  const s = await mc.request.post(`${base}${prefix}/api/auth/signup`, { data: { name: 'Riley Example', email: `mgr+${tag}@example.org`, password: 'surrey-forward-2026', workspaceName: 'Map live', jurisdiction: 'bc-municipal' } });
  if (!s.ok()) throw new Error(`signup ${s.status()} ${await s.text()}`);
  const post = async (path, data) => {
    const r = await mc.request.post(`${base}${prefix}/api${path}`, { data });
    if (!r.ok()) throw new Error(`${path} ${r.status()} ${await r.text()}`);
    return r.json();
  };
  for (let i = 0; i < 8; i += 1) await post('/actions/person.create', { name: `P${i} Example`, address: `${100 + i} Example St`, city: 'Surrey', lat: 49.105 + (i % 4) * 0.002, lng: -122.84 + Math.floor(i / 4) * 0.003 });
  const invites = {};
  for (const role of ['staff', 'volunteer']) invites[role] = await post('/actions/member.invite', { email: `${role}+${tag}@example.org`, role });
  const state = await mc.storageState();
  await mc.close();
  // A context signed in as someone, with its own tile net.
  const as = async (role, opts, mode) => {
    const n = freshNet(mode);
    const ctx = await newContext(opts, n);
    if (role === 'manager') await ctx.addCookies(state.cookies);
    else {
      const j = await ctx.request.post(`${base}${prefix}/api/auth/join`, { data: { token: invites[role].joinUrl.split('/').pop(), name: `${role} Example`, password: 'knock-knock-2026' } });
      if (!j.ok()) throw new Error(`join ${role} ${j.status()} ${await j.text()}`);
    }
    return { ctx, net: n };
  };
  return { as, base, prefix };
};

const mapPath = (role, prefix = '') => (role === 'volunteer' ? (prefix ? '/field/map' : '/map') : '/admin/map');
const state = (pg) => pg.evaluate(() => {
  const el = document.querySelector('.map-canvas');
  const imgs = [...(el?.querySelectorAll('.leaflet-tile-pane img.leaflet-tile') || [])];
  return {
    tiles: el?.dataset.tiles ?? null,
    look: (document.querySelector('.map-page')?.className.match(/map-view--(\w+)/) || [])[1] || null,
    note: document.querySelector('.map-tilenote')?.innerText.replace(/\s+/g, ' ').trim() || null,
    why: Boolean(document.querySelector('.map-tilenote__why')),
    hosts: [...new Set(imgs.map((i) => { try { return new URL(i.src).host + (new URL(i.src).search.includes('key=') ? '+key' : ''); } catch { return i.src.split('?')[0]; } }))],
    loaded: imgs.filter((i) => i.classList.contains('leaflet-tile-loaded') && i.naturalWidth > 0).length,
    pick: localStorage.getItem('starbase:map:view'),
  };
}).catch(() => ({}));
const until = async (pg, fn, ms = 12000) => {
  const end = Date.now() + ms;
  let said = null;
  for (;;) {
    const s = await state(pg);
    said = s.note || said;
    if (fn(s) || Date.now() > end) return { ...s, said };
    await sleep(150);
  }
};
// Open the map twice (the second with the service worker in control).
const openMap = async (ctx, url, role, pick, net = null) => {
  const pg = await ctx.newPage();
  pg.on('pageerror', (e) => errors.push(`[${role}] ${e.message}`));
  await pg.goto(url, { waitUntil: 'domcontentloaded' });
  await pg.evaluate((v) => { try { if (v === undefined) return; if (v) localStorage.setItem('starbase:map:view', v); else localStorage.removeItem('starbase:map:view'); } catch {} }, pick);
  await sleep(600);
  if (net) { await sleep(2500); net.carto.length = 0; net.osm.length = 0; } // count one page life: the second
  await pg.reload({ waitUntil: 'domcontentloaded' });
  return pg;
};
const showLooks = async (pg) => {
  await pg.click('.map-filter-btn');
  await pg.waitForSelector('.map-fsheet');
  const looks = await pg.$$eval('.map-vchip', (els) => els.map((b) => ({ label: b.innerText.trim(), on: b.getAttribute('aria-checked') === 'true' })));
  await pg.keyboard.press('Escape');
  await sleep(300);
  return looks;
};
const openCheck = async (pg) => {
  await pg.click('.map-filter-btn');
  await pg.waitForSelector('.map-fsheet');
  await pg.click('.map-fsheet__check');
  await pg.waitForSelector('.map-check .map-check__row', { timeout: 10000 });
  await sleep(1500);
};
const rowsOf = (pg) => pg.$$eval('.map-check .map-check__row', (els) => els.map((r) => ({ key: r.dataset.key, text: r.innerText.replace(/\s+/g, ' ').trim(), warn: r.classList.contains('is-warn') })));
const pictureOf = (pg) => pg.$eval('.map-check__picture img', (i) => ({ src: i.src, w: i.naturalWidth, h: i.naturalHeight, done: i.complete })).catch(() => null);
const sideways = (pg) => pg.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);

let failed = null;
try {
  // ── 1. No CARTO key: OpenStreetMap's Standard, nothing asked of CARTO ──
  const noKeySteps = async (camp, label) => {
    for (const [role, opts, size] of [['manager', DESK, 1440], ['volunteer', PHONE, 390]]) {
      const { ctx, net } = await camp.as(role, opts, 'notice');
      const pg = await openMap(ctx, `${camp.base}${camp.prefix}${mapPath(role, camp.prefix)}`, `${label} ${role}`, null);
      const s = await until(pg, (x) => x.tiles === 'ok' && x.loaded > 0);
      await sleep(1500);
      const s2 = await state(pg);
      check(`${label}, ${role} ${size}: nothing asked of CARTO; streets from OpenStreetMap; Standard drawn; data-tiles ok; nothing saved`,
        net.carto.length === 0 && net.osm.length > 0 && s2.tiles === 'ok' && s2.look === 'standard' && s2.hosts.every((h) => h === 'tile.openstreetmap.org') && s2.pick === null && !s2.note,
        JSON.stringify({ carto: net.carto.length, osm: net.osm.length, ...s2, first: s.tiles }));
      await pg.screenshot({ path: `${SHOTS}/1-${label.replace(/\W+/g, '-')}-${role}-${size}.png` });
      if (role === 'manager') {
        const looks = await showLooks(pg);
        check(`${label}: Show → Map has no Clean, and Standard is chosen for someone who picked nothing`,
          !looks.some((l) => l.label === 'Clean') && looks.find((l) => l.on)?.label === 'Standard', JSON.stringify(looks));
        if (label === 'under BASE_PATH') {
          await openCheck(pg);
          const pic = await pictureOf(pg);
          check('under BASE_PATH: the Map check’s picture loads (a 256 px street tile from OpenStreetMap)', pic && pic.w === 256 && /tile\.openstreetmap\.org/.test(pic.src), JSON.stringify(pic));
        }
      } else check(`${label}, phone: no sideways scroll`, !(await sideways(pg)));
      await pg.close();
      // A phone that saved Clean before: Standard.
      if (role === 'volunteer') {
        const sp = await openMap(ctx, `${camp.base}${camp.prefix}${mapPath(role, camp.prefix)}`, `${label} saved clean`, 'clean');
        const ss = await until(sp, (x) => x.tiles === 'ok' && x.loaded > 0);
        check(`${label}: a phone that saved Clean draws Standard (its saved pick kept)`, ss.look === 'standard' && ss.pick === 'clean' && net.carto.length === 0, JSON.stringify({ ...ss, carto: net.carto.length }));
        await sp.close();
      }
      await ctx.close();
    }
  };
  if (want('nokey')) await noKeySteps(await campaign(await start(5410, {})), 'no key');

  // ── 2–4. With the campaign's key (:5411) ──
  if (want('notice') || want('good') || want('nocors')) {
    const camp = await campaign(await start(5411, { STARBASE_TILE_CARTO_KEY: 'test-key' }));
    if (want('notice')) {
      // 2. CARTO sends its notice.
      for (const [role, opts, size] of [['manager', DESK, 1440], ['staff', DESK, 1440], ['volunteer', PHONE, 390], ['manager', PHONE, 390]]) {
        const { ctx, net } = await camp.as(role, opts, 'notice');
        const pg = await ctx.newPage();
        pg.on('pageerror', (e) => errors.push(`[notice ${role}] ${e.message}`));
        const t0 = Date.now();
        await pg.goto(`${camp.base}${mapPath(role)}`, { waitUntil: 'domcontentloaded' });
        const s = await until(pg, (x) => x.look === 'muted' && /wasn’t showing streets — switched to Muted/.test(x.note || ''), 10000);
        const took = Date.now() - t0;
        await pg.screenshot({ path: `${SHOTS}/2-notice-${role}-${size}.png` });
        check(`notice, ${role} ${size}: found within 10 s, switched to Muted by itself, said “The street map wasn’t showing streets — switched to Muted”`,
          s.look === 'muted' && /^The street map wasn’t showing streets — switched to Muted/.test(s.note || '') && took < 10000 && s.pick === null,
          JSON.stringify({ took, ...s }));
        check(`notice, ${role}: ${role === 'manager' ? 'with' : 'no'} “Why?”`, s.why === (role === 'manager'), JSON.stringify(s));
        const probes = net.carto.filter((r) => r.type === 'probe');
        check(`notice, ${role}: the probe asked CARTO at most twice, keyed, with no no-cache headers`,
          probes.length >= 1 && probes.length <= 2 && probes.every((r) => /key=test-key/.test(r.url) && !/no-cache/i.test(r.headers['cache-control'] || '') && !r.headers.pragma),
          JSON.stringify(probes.map((r) => [r.url.replace(/^.*\/light_all/, ''), r.headers['cache-control'] || '', r.headers.pragma || ''])));
        if (role === 'manager' && size === 1440) {
          // People and back: still Muted, no second line.
          await pg.evaluate((p) => { history.pushState({}, '', p); dispatchEvent(new PopStateEvent('popstate')); }, '/admin/people');
          await sleep(1200);
          await pg.evaluate((p) => { history.pushState({}, '', p); dispatchEvent(new PopStateEvent('popstate')); }, '/admin/map');
          const back = await until(pg, (x) => x.loaded > 0 && x.tiles === 'ok', 8000);
          await sleep(2500);
          const b2 = await state(pg);
          check('notice, nothing saved: People and back keeps Muted, with no second switch line', b2.look === 'muted' && !b2.note && b2.pick === null, JSON.stringify({ back, b2 }));
          await pg.close();
          // Why?: the Map check's top line, the CARTO note, the notice picture.
          const wp = await ctx.newPage();
          wp.on('pageerror', (e) => errors.push(`[notice why] ${e.message}`));
          await wp.goto(`${camp.base}/admin/map`, { waitUntil: 'domcontentloaded' });
          await until(wp, (x) => x.why, 10000);
          await wp.click('.map-tilenote__why');
          await wp.waitForSelector('.map-check .map-check__row', { timeout: 10000 });
          await wp.waitForFunction(() => document.querySelector('.map-check__picture img')?.complete, null, { timeout: 8000 }).catch(() => {});
          await sleep(1500);
          const rows = await rowsOf(wp);
          const pic = await pictureOf(wp);
          await wp.screenshot({ path: `${SHOTS}/2-check-notice-manager-1440.png` });
          check('Why?: the Map check’s top line is “Clean · CARTO — sends a notice, not streets”, with the CARTO note',
            rows[0]?.key === 'tiles' && rows[0].warn && /Clean · CARTO — sends a notice, not streets/.test(rows[0].text) && /CARTO’s free map needs a key now: set STARBASE_TILE_CARTO_KEY in Render, or STARBASE_TILE_CLEAN=off/.test(rows[0].text),
            JSON.stringify(rows.slice(0, 3)));
          check('…and under it the picture this phone got: the notice (256 px, from CARTO, keyed)',
            pic && pic.w === 256 && pic.h === 256 && /basemaps\.cartocdn\.com\/.*key=test-key/.test(pic.src) && /What this phone gets for the middle of the map:/.test(rows[0].text),
            JSON.stringify(pic));
          check('…the street map service line is flagged too', rows.find((r) => r.key === 'tilesvc')?.warn === true, JSON.stringify(rows.find((r) => r.key === 'tilesvc')));
          await wp.close();
        } else {
          if (size === 390) {
            check(`notice, ${role} 390: no sideways scroll`, !(await sideways(pg)));
            if (role === 'manager') {
              await until(pg, (x) => x.why, 4000);
              const w = await pg.$('.map-tilenote__why');
              if (w) {
                await w.tap();
                await pg.waitForSelector('.map-check .map-check__row', { timeout: 10000 }).catch(() => {});
                await pg.waitForFunction(() => document.querySelector('.map-check__picture img')?.complete, null, { timeout: 8000 }).catch(() => {});
                await sleep(1000);
                await pg.screenshot({ path: `${SHOTS}/2-check-notice-manager-390.png` });
                const rows = await rowsOf(pg);
                check('390 px: the check’s top line is the notice', /sends a notice, not streets/.test(rows[0]?.text || ''), rows[0]?.text);
              }
            }
          }
          await pg.close();
        }
        await ctx.close();
      }
      // A campaign's map with no other look: the line, and Try again.
    }
    if (want('good')) {
      // 3. CARTO answering streets.
      const { ctx, net } = await camp.as('manager', DESK, 'good');
      const pg = await openMap(ctx, `${camp.base}/admin/map`, 'good', null, net);
      const s = await until(pg, (x) => x.tiles === 'ok' && x.loaded > 0 && x.look === 'clean');
      await sleep(3000);
      const s2 = await state(pg);
      check('a key, CARTO answering streets: Clean draws, every tile keyed, nothing said, nothing saved',
        s2.look === 'clean' && s2.tiles === 'ok' && !s2.note && s2.hosts.length > 0 && s2.hosts.every((h) => /basemaps\.cartocdn\.com\+key/.test(h)) && s2.pick === null,
        JSON.stringify({ s, s2 }));
      const probes = net.carto.filter((r) => r.type === 'probe');
      check('…in its life the page asked CARTO at most twice beside its tiles (the probe, once)', probes.length >= 1 && probes.length <= 2, String(probes.length));
      await openCheck(pg);
      const pic = await pictureOf(pg);
      const rows = await rowsOf(pg);
      await pg.screenshot({ path: `${SHOTS}/3-check-streets-manager-1440.png` });
      check('…the Map check’s picture is a street tile from CARTO, and nothing is flagged about the street map',
        pic && pic.w === 256 && /basemaps\.cartocdn\.com\/.*key=test-key/.test(pic.src) && !rows.find((r) => r.key === 'tiles')?.warn, JSON.stringify({ pic, tiles: rows.find((r) => r.key === 'tiles') }));
      await ctx.close();
    }
    if (want('nocors')) {
      // 4. The notice, but without the CORS header: the probe can't read it.
      const { ctx } = await camp.as('manager', DESK, 'notice-nocors');
      const pg = await openMap(ctx, `${camp.base}/admin/map`, 'nocors', null);
      await until(pg, (x) => x.tiles === 'ok' && x.loaded > 0);
      await sleep(5000);
      const s = await state(pg);
      check('a probe that can’t run (no CORS header): no verdict — Clean stays, nothing said', s.look === 'clean' && s.tiles === 'ok' && !s.note, JSON.stringify(s));
      await ctx.close();
    }
  }

  // ── 5. Google as the map, refusing: the free map is OpenStreetMap ──
  if (want('google')) {
    for (const [port, label, env] of [[5413, 'no key', {}], [5414, 'STARBASE_TILE_CLEAN=off', { STARBASE_TILE_CLEAN: 'off', STARBASE_TILE_CARTO_KEY: 'test-key' }]]) {
      const base = await start(port, { GOOGLE_MAPS_TILES: '1', GOOGLE_MAPS_SERVER_KEY: 'e2e-not-a-key', GOOGLE_MAPS_TILES_URL: GOOGLE_URL, ...env });
      const camp = await campaign(base);
      const { ctx, net } = await camp.as('manager', DESK, 'notice');
      const ownFetches = [];
      ctx.on('request', (r) => { if (/\/tiles\/\d+\/\d+\/\d+/.test(r.url()) && r.resourceType() === 'fetch') ownFetches.push(r.url()); });
      const pg = await ctx.newPage();
      pg.on('pageerror', (e) => errors.push(`[google ${label}] ${e.message}`));
      await pg.goto(`${base}/admin/map`, { waitUntil: 'domcontentloaded' });
      const s = await until(pg, (x) => /Google Maps isn’t loading — showing the free map/.test(x.note || '') && x.loaded > 0, 15000);
      await sleep(1500);
      const s2 = await state(pg);
      await pg.screenshot({ path: `${SHOTS}/5-google-down-${port}-1440.png` });
      check(`Google refusing (${label}): the free map from OpenStreetMap, said as before; nothing asked of CARTO`,
        /Google Maps isn’t loading — showing the free map/.test(s.said || '') && s2.hosts.includes('tile.openstreetmap.org') && net.carto.length === 0,
        JSON.stringify({ said: s.said, hosts: s2.hosts, carto: net.carto.length }));
      check(`…(${label}) no probe of the server’s own /tiles/ (only “does it answer” asks, before a switch)`, ownFetches.length <= 1, JSON.stringify(ownFetches));
      await ctx.close();
    }
  }

  // ── 10. Under BASE_PATH (:5412) ──
  if (want('basepath')) await noKeySteps(await campaign(await start(5412, { BASE_PATH: '/imaginesurrey' }), '/imaginesurrey'), 'under BASE_PATH');

  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  failed = e;
  console.error(e);
} finally {
  await browser.close().catch(() => {});
  for (const p of procs) p.kill();
  standInGoogle.close();
}
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed${failed ? ' (stopped early)' : ''} — screenshots in ${SHOTS}`);
process.exit(failed || passed !== results.length ? 1 : 0);
