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
// Stage 2 (MAP decisions 9–13):
//   6. the desk Map has no margins or frame: its canvas is 1208 × 900 at
//      1440 × 900, the menu keeps its words, the offline line changes no size;
//   7. the phone Map is unchanged (390 × 722);
//   8. the desk band (once HOME mounts it on Today): 1,144 wide, folds and
//      stays folded, never reads /map/doors or Google's tiles (SKIP before
//      HOME's desk Today is there; a FAIL once it is and the band is not,
//      or with REQUIRE_BAND=1);
//   9. field Today's map window: open the first time under the one button,
//      the turf's doors from /map/doors?mine=1 only, folds (no Leaflet asked
//      for), Open the map, the page scrolls through it, offline, the doors
//      unavailable, its chunk failing, and none with no walk list;
//   and 6, 8, 9 again under BASE_PATH.
// Stand-ins answer every tile host (the sandbox reaches none); every person
// is made up. The notice is a PNG made here; a good tile is a picture of its
// own address.
//
//   (cd web && npm run build) && node e2e-maplive.mjs     servers on :5410–:5414 (a stand-in Google on a free port)
//   ONLY=nokey,notice,good,nocors,google,basepath        just those steps
//   ONLY=stage2 (desk, band, window), basepath2          stage 2's steps
//   SHOTS=<dir>                                          where the screenshots go
//   REQUIRE_BAND=1                                       the desk band must be on Today (no SKIP)
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
    net.osm.push({ url: r.url(), type: r.resourceType() === 'fetch' && !r.serviceWorker() ? 'probe' : r.resourceType(), headers: r.headers() });
    if (net.osmMode === 'fail') return route.abort('internetdisconnected');
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
  // Stage 2: a volunteer with no walk list, and a candidate with none.
  invites.loner = await post('/actions/member.invite', { email: `loner+${tag}@example.org`, role: 'volunteer' });
  const seat = (await post('/actions/candidate.save', { name: 'Cleo Example', office: 'Council', race: 'council', email: `cand+${tag}@example.org` })).candidate.id;
  invites.candidate = await post('/actions/candidate.invite', { id: seat });
  const state = await mc.storageState(); // (mc stays open: the manager's hand for turfs)
  // A context signed in as someone, with its own tile net.
  const as = async (role, opts, mode) => {
    const n = freshNet(mode);
    const ctx = await newContext(opts, n);
    let userId = null;
    if (role === 'manager') await ctx.addCookies(state.cookies);
    else if (joined[role]) await ctx.addCookies(joined[role].cookies);
    else {
      const j = await ctx.request.post(`${base}${prefix}/api/auth/join`, { data: { token: invites[role].joinUrl.split('/').pop(), name: `${role} Example`, password: 'knock-knock-2026' } });
      if (!j.ok()) throw new Error(`join ${role} ${j.status()} ${await j.text()}`);
      userId = (await j.json()).user?.id;
      joined[role] = { ...(await ctx.storageState()), userId };
    }
    return { ctx, net: n, userId: userId || joined[role]?.userId || null };
  };
  const joined = {};
  return { as, base, prefix, post };
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

  // ── Stage 2 (MAP decisions 9–13): more room on the Map, a map on Today ──
  const rectOf = (pg, sel) => pg.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) }; }).catch(() => null);
  const near = (a, b) => Math.abs(a - b) <= 1;
  const field = (prefix) => (prefix ? '/field' : '');
  const deskSteps = async (camp, label) => {
    // 6. Desk Map: no margins, no frame, the menu with its words.
    const { ctx } = await camp.as('manager', DESK, 'good');
    const pg = await openMap(ctx, `${camp.base}${camp.prefix}/admin/map`, `${label} desk map`, null);
    await until(pg, (x) => x.loaded > 0);
    await sleep(800);
    const c = await rectOf(pg, '.map-canvas');
    const words = await pg.$eval('.nav', (n) => n.innerText).catch(() => '');
    const frame = await pg.$eval('.map-page', (el) => getComputedStyle(el).borderTopWidth).catch(() => null);
    await pg.screenshot({ path: `${SHOTS}/6-desk-map-${label.replace(/\W+/g, '-')}-1440.png` });
    check(`${label}: desk Map 1440 × 900 — the canvas is 1208 × 900, no frame, the menu keeps its words`,
      c && near(c.w, 1208) && near(c.h, 900) && near(c.x, 232) && frame === '0px' && /People/.test(words) && /Map/.test(words), JSON.stringify({ c, frame, words: words.slice(0, 80) }));
    await ctx.setOffline(true);
    await pg.evaluate(() => dispatchEvent(new Event('offline')));
    await sleep(1200);
    const off = await rectOf(pg, '.map-canvas');
    const line = await pg.$eval('.nav', (n) => /offline|no signal/i.test(n.innerText)).catch(() => false);
    check(`${label}: offline, the line is in the menu and the canvas keeps its size`, off && near(off.w, c.w) && near(off.h, c.h) && line, JSON.stringify({ off, line }));
    await pg.screenshot({ path: `${SHOTS}/6-desk-map-offline-${label.replace(/\W+/g, '-')}-1440.png` });
    await ctx.setOffline(false);
    await pg.evaluate(() => dispatchEvent(new Event('online')));
    await pg.goto(`${camp.base}${camp.prefix}/admin/people`, { waitUntil: 'domcontentloaded' });
    await pg.waitForSelector('main.page', { timeout: 10000 });
    const pad = await pg.$eval('main.page', (el) => getComputedStyle(el).paddingLeft);
    check(`${label}: back on People, the page has its margins`, pad === '32px', pad);
    await ctx.close();
    // 7. Phone Map: unchanged.
    const v = await camp.as('volunteer', PHONE, 'good');
    const vp = await openMap(v.ctx, `${camp.base}${camp.prefix}${field(camp.prefix)}/map`, `${label} phone map`, null);
    await until(vp, (x) => x.loaded > 0);
    const pc = await rectOf(vp, '.map-canvas');
    check(`${label}: phone Map 390 × 844 — the canvas is 390 × 722, no sideways scroll`, pc && near(pc.w, 390) && near(pc.h, 722) && !(await sideways(vp)), JSON.stringify(pc));
    await v.ctx.close();
  };

  // 9. Field Today's map window.
  const windowSteps = async (camp, label) => {
    const v = await camp.as('volunteer', PHONE, 'good');
    const turf = (await camp.post('/actions/turf.create', { name: 'Example block', polygon: [[49.103, -122.843], [49.103, -122.835], [49.113, -122.835], [49.113, -122.843]] })).turf;
    await camp.post('/actions/turf.assign', { turf_id: turf.id, user_id: v.userId });
    const today = `${camp.base}${camp.prefix}${field(camp.prefix)}/`;
    const asked = [];
    v.ctx.on('request', (r) => { if (!r.serviceWorker()) asked.push(r.url()); });
    const pg = await v.ctx.newPage();
    pg.on('pageerror', (e) => errors.push(`[${label} window] ${e.message}`));
    await pg.goto(today, { waitUntil: 'domcontentloaded' });
    await sleep(800);
    await pg.reload({ waitUntil: 'domcontentloaded' }); // the second, the service worker in control
    await pg.waitForSelector('.mapwindow--window', { timeout: 10000 });
    await pg.waitForFunction(() => document.querySelectorAll('.mapwindow__canvas .leaflet-overlay-pane path').length >= 2, null, { timeout: 10000 }).catch(() => {});
    await sleep(1500);
    const w = await pg.evaluate(() => ({
      open: document.querySelector('.mapwindow__toggle')?.getAttribute('aria-expanded'),
      meta: document.querySelector('.mapwindow__meta')?.innerText.trim(),
      paths: document.querySelectorAll('.mapwindow__canvas .leaflet-overlay-pane path').length,
      tiles: document.querySelectorAll('.mapwindow__canvas img.leaflet-tile-loaded').length,
      note: document.querySelector('.mapwindow__note')?.innerText || null,
      primaries: [...document.querySelectorAll('.btn-primary')].filter((b) => b.offsetParent).length,
      afterGo: document.querySelector('.today-go')?.nextElementSibling?.classList.contains('mapwindow'),
      small: [...document.querySelectorAll('.mapwindow button, .mapwindow a.btn')].map((b) => [b.innerText.trim(), Math.round(b.getBoundingClientRect().height)]).filter(([, h]) => h < 48),
    }));
    const doorAsks = asked.filter((u) => /\/api\/map\/doors/.test(u));
    await pg.screenshot({ path: `${SHOTS}/9-window-open-view-${label.replace(/\W+/g, '-')}-390.png` });
    await pg.screenshot({ path: `${SHOTS}/9-window-open-${label.replace(/\W+/g, '-')}-390.png`, fullPage: true });
    check(`${label}: field Today 390 — the map window is open the first time, under the one button, doors and outline drawn, streets in`,
      w.open === 'true' && w.afterGo && w.paths >= 3 && w.tiles > 0 && !w.note, JSON.stringify(w));
    check(`${label}: its row reads “Example block · N doors left”`, /^Example block · \d[\d,]* doors? left$/.test(w.meta || ''), w.meta);
    check(`${label}: the only doors read is /api/map/doors?mine=1`, doorAsks.length >= 1 && doorAsks.every((u) => /\/api\/map\/doors\?mine=1$/.test(u)), JSON.stringify(doorAsks));
    // Streets only once it knows where it looks: no city-wide tiles asked
    // for while the doors are on their way (OpenStreetMap's servers are
    // volunteers'; the turf frames at about zoom 15). The notice probe's two
    // asks (one far out on purpose) are not the map's tiles.
    const zooms = v.net.osm.filter((t) => t.type !== 'probe').map((t) => Number((new URL(t.url).pathname.match(/^\/(\d+)\//) || [])[1])).filter(Number.isFinite);
    check(`${label}: no street tiles asked for before the window frames on the turf (none below zoom 14)`, zooms.length > 0 && zooms.every((z) => z >= 14), JSON.stringify(zooms));
    check(`${label}: one primary button on the page; every target in the window at least 48 px; no sideways scroll`, w.primaries === 1 && w.small.length === 0 && !(await sideways(pg)), JSON.stringify(w.small));
    // A swipe that starts on the map scrolls the page.
    const box = await rectOf(pg, '.mapwindow__frame');
    const y0 = await pg.evaluate(() => scrollY);
    const cdp = await pg.context().newCDPSession(pg);
    const sx = box.x + box.w / 2; const sy = box.y + box.h / 2;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: sx, y: sy }] });
    for (let i = 1; i <= 10; i += 1) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: sx, y: sy - i * 15 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(500);
    const y1 = await pg.evaluate(() => scrollY);
    check(`${label}: a swipe that starts on the map scrolls the page`, y1 > y0 + 50, JSON.stringify({ y0, y1, box }));
    await pg.evaluate(() => scrollTo(0, 0));
    // Open the map → the Map, on the turf.
    await pg.click('.mapwindow__open');
    await pg.waitForURL(/\/map\?turf=/, { timeout: 8000 }).catch(() => {});
    check(`${label}: “Open the map” goes to the Map on the turf`, new URL(pg.url()).pathname.endsWith('/map') && new URL(pg.url()).searchParams.get('turf') === turf.id, pg.url());
    await pg.goto(today, { waitUntil: 'domcontentloaded' });
    await pg.waitForSelector('.mapwindow__toggle', { timeout: 10000 });
    // Fold it; reload: folded, and no Leaflet asked for.
    await pg.click('.mapwindow__toggle');
    await sleep(300);
    await pg.screenshot({ path: `${SHOTS}/9-window-folded-${label.replace(/\W+/g, '-')}-390.png`, fullPage: true });
    asked.length = 0;
    await pg.reload({ waitUntil: 'domcontentloaded' });
    await pg.waitForSelector('.mapwindow__toggle', { timeout: 10000 });
    await sleep(1500);
    const folded = await pg.$eval('.mapwindow__toggle', (b) => b.getAttribute('aria-expanded'));
    const chunks = asked.filter((u) => /\/assets\/(leaflet|MapWindowMap)-/.test(u));
    check(`${label}: folded and reloaded — still folded, and neither Leaflet nor the map window’s chunk was asked for`, folded === 'false' && chunks.length === 0, JSON.stringify({ folded, chunks }));
    await pg.click('.mapwindow__toggle'); // open again for what follows
    await pg.waitForSelector('.mapwindow__canvas.leaflet-container', { timeout: 10000 });
    await sleep(1500);
    // Offline with the tiles failing: the doors still draw, GMP's no-signal line.
    v.net.osmMode = 'fail';
    await pg.evaluate(async () => { for (const k of await caches.keys()) if (/tiles/.test(k)) await caches.delete(k); });
    await v.ctx.setOffline(true);
    await pg.reload({ waitUntil: 'domcontentloaded' });
    const off = await pg.waitForFunction(() => /No signal — the street map is back when you are\. Your doors are all here\./.test(document.querySelector('.mapwindow__note')?.innerText || ''), null, { timeout: 15000 }).then(() => true, () => false);
    const offPaths = await pg.$$eval('.mapwindow__canvas .leaflet-overlay-pane path', (p) => p.length).catch(() => 0);
    await pg.screenshot({ path: `${SHOTS}/9-window-offline-${label.replace(/\W+/g, '-')}-390.png`, fullPage: true });
    check(`${label}: offline, the street map failing — the doors still draw, and “No signal — the street map is back when you are…”`, off && offPaths >= 3, JSON.stringify({ off, offPaths }));
    await v.ctx.setOffline(false);
    v.net.osmMode = null;
    await pg.close();
    await v.ctx.close();
    // The doors can't be read and there's no kept copy (a browser that never
    // had them): Unavailable — Try again.
    const u = await camp.as('volunteer', PHONE, 'good');
    await u.ctx.route(/\/api\/map\/doors\?mine=1/, (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' }));
    const up = await u.ctx.newPage();
    up.on('pageerror', (e) => errors.push(`[${label} unavailable] ${e.message}`));
    await up.goto(today, { waitUntil: 'domcontentloaded' });
    const unav = await up.waitForFunction(() => /Unavailable/.test(document.querySelector('.mapwindow__over')?.innerText || ''), null, { timeout: 20000 }).then(() => true, () => false);
    const retry = await up.$('.mapwindow__over .mapwindow__retry');
    await up.screenshot({ path: `${SHOTS}/9-window-unavailable-${label.replace(/\W+/g, '-')}-390.png`, fullPage: true });
    // "Try again" on one line (the pill is centred by a transform and would shrink to fit).
    const lines = retry ? await retry.evaluate((b) => { const r = document.createRange(); r.selectNodeContents(b); return new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size; }) : 0;
    check(`${label}: doors unavailable with no kept copy — “Unavailable” and Try again in the window, on one line`, unav && Boolean(retry) && lines === 1, JSON.stringify({ unav, lines }));
    await u.ctx.unroute(/\/api\/map\/doors\?mine=1/);
    if (retry) await retry.click();
    const back = await up.waitForFunction(() => !document.querySelector('.mapwindow__over') && document.querySelectorAll('.mapwindow__canvas .leaflet-overlay-pane path').length >= 3, null, { timeout: 10000 }).then(() => true, () => false);
    check(`${label}: …Try again draws the doors`, back);
    await u.ctx.close();
    // The map window's chunk fails to load (no service worker: a first visit).
    const b = await camp.as('volunteer', { ...PHONE, serviceWorkers: 'block' }, 'good');
    await b.ctx.route(/\/assets\/MapWindowMap-[^/]*\.js/, (r) => r.abort('failed'));
    const bp = await b.ctx.newPage();
    bp.on('pageerror', () => {}); // the failed import is the point here
    await bp.goto(today, { waitUntil: 'domcontentloaded' });
    const said = await bp.waitForFunction(() => /Unavailable/.test(document.querySelector('.mapwindow__fail')?.innerText || ''), null, { timeout: 15000 }).then(() => true, () => false);
    const rest = await bp.evaluate(() => ({ go: Boolean(document.querySelector('.today-go .btn-primary')), rows: Boolean(document.querySelector('.today-rows')) }));
    await bp.screenshot({ path: `${SHOTS}/9-window-chunk-fails-${label.replace(/\W+/g, '-')}-390.png`, fullPage: true });
    check(`${label}: the window’s chunk fails — “Unavailable” and Try again in the box; Start canvassing and the rest of Today still there`, said && rest.go && rest.rows, JSON.stringify(rest));
    await b.ctx.unroute(/\/assets\/MapWindowMap-[^/]*\.js/);
    await Promise.all([bp.waitForNavigation({ timeout: 10000 }).catch(() => {}), bp.click('.mapwindow__fail .mapwindow__retry').catch(() => {})]);
    const drew = await bp.waitForFunction(() => document.querySelector('.mapwindow__canvas.leaflet-container'), null, { timeout: 10000 }).then(() => true, () => false);
    check(`${label}: …Try again with the chunk back draws the map`, drew);
    await b.ctx.close();
    // No walk list: no map window (a volunteer, and a candidate).
    for (const who of ['loner', 'candidate']) {
      const n = await camp.as(who, PHONE, 'good');
      const np = await n.ctx.newPage();
      await np.goto(today, { waitUntil: 'domcontentloaded' });
      await np.waitForSelector('.today-go', { timeout: 10000 }).catch(() => {});
      await sleep(1500);
      const has = await np.$('.mapwindow');
      check(`${label}: a ${who === 'loner' ? 'volunteer' : 'candidate'} with no walk list sees no map window`, !has);
      await n.ctx.close();
    }
  };

  // 8. The desk band, once HOME mounts it on the desk's Today.
  const bandSteps = async (camp, label) => {
    await camp.post('/actions/turf.create', { name: 'Band block', polygon: [[49.12, -122.85], [49.12, -122.84], [49.13, -122.84], [49.13, -122.85]] });
    for (const role of ['manager', 'staff']) {
      const { ctx } = await camp.as(role, DESK, 'good');
      const asked = [];
      ctx.on('request', (r) => { if (!r.serviceWorker()) asked.push(r.url()); });
      const pg = await ctx.newPage();
      pg.on('pageerror', (e) => errors.push(`[${label} band] ${e.message}`));
      await pg.goto(`${camp.base}${camp.prefix}/admin/`, { waitUntil: 'domcontentloaded' });
      await sleep(2500);
      // Before HOME: no band, and no HOME desk Today either (.today-desk) —
      // SKIP. Once HOME's Today is here (or REQUIRE_BAND=1), a missing band
      // fails: the band must be under the numbers, not quietly gone.
      if (!(await pg.$('.mapwindow--band'))) {
        const homeIn = process.env.REQUIRE_BAND === '1' || Boolean(await pg.$('.today-desk'));
        if (homeIn) check(`${label}, ${role}: the desk band is on HOME’s Today`, false, 'no .mapwindow--band on the desk’s Today');
        else console.log(`SKIP  ${label}: the desk band (${role}) — not on Today until HOME mounts it`);
        await ctx.close(); continue;
      }
      await pg.waitForFunction(() => document.querySelectorAll('.mapwindow--band .leaflet-overlay-pane path').length >= 1, null, { timeout: 10000 }).catch(() => {});
      const r = await rectOf(pg, '.mapwindow--band');
      const f = await rectOf(pg, '.mapwindow--band .mapwindow__frame');
      const meta = await pg.$eval('.mapwindow--band .mapwindow__meta', (e) => e.innerText.trim());
      const wide = await pg.$$eval('.today-desk > :not(.mapwindow--band)', (els) => els.map((e) => Math.round(e.getBoundingClientRect().width)).filter((x) => x > 1200));
      await pg.screenshot({ path: `${SHOTS}/8-band-open-${role}-${label.replace(/\W+/g, '-')}-1440.png` });
      check(`${label}, ${role}: the band is open, 1,144 wide, 320–560 tall, outlines drawn, “N walk lists”; nothing else wider than 1,200`,
        r && near(r.w, 1144) && f.h >= 320 && f.h <= 560 && /^\d[\d,]* walk lists?$/.test(meta) && wide.length === 0, JSON.stringify({ r, f, meta, wide }));
      check(`${label}, ${role}: Today asks nothing of /api/map/doors, nor Google’s /tiles/`, !asked.some((u) => /\/api\/map\/doors|\/tiles\/\d/.test(u)), JSON.stringify(asked.filter((u) => /map|tiles/.test(u))));
      await pg.click('.mapwindow--band .mapwindow__toggle');
      asked.length = 0;
      await pg.reload({ waitUntil: 'domcontentloaded' });
      await sleep(2000);
      const folded = await pg.$eval('.mapwindow--band .mapwindow__toggle', (b) => b.getAttribute('aria-expanded')).catch(() => null);
      await pg.screenshot({ path: `${SHOTS}/8-band-folded-${role}-${label.replace(/\W+/g, '-')}-1440.png` });
      // (A manager's Today still draws the Dashboard, with its own map, until HOME moves it.)
      const chunks = asked.filter((u) => /\/assets\/(leaflet|MapWindowMap)-/.test(u));
      check(`${label}, ${role}: folded and reloaded — still folded, no Leaflet asked for`, folded === 'false' && chunks.length === 0, JSON.stringify({ folded, chunks }));
      await pg.click('.mapwindow--band .mapwindow__toggle');
      await ctx.close();
    }
  };

  if (want('stage2') || want('desk') || want('window') || want('band')) {
    const camp = await campaign(await start(5410, {}).catch(() => 'http://127.0.0.1:5410'));
    if (want('stage2') || want('desk')) await deskSteps(camp, 'root');
    if (want('stage2') || want('band')) await bandSteps(camp, 'root');
    if (want('stage2') || want('window')) await windowSteps(camp, 'root');
  }
  if (want('basepath2')) {
    const camp = await campaign(await start(5412, { BASE_PATH: '/imaginesurrey' }).catch(() => 'http://127.0.0.1:5412'), '/imaginesurrey');
    await deskSteps(camp, 'under BASE_PATH');
    await bandSteps(camp, 'under BASE_PATH');
    await windowSteps(camp, 'under BASE_PATH');
  }

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
