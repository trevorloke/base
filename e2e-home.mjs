// A simple front page (HOME) — browser suite. Fresh in-memory
// campaigns of made-up people, at 1440x900 and 390x844, as a manager, staff,
// staff denied Data, staff denied Map, a treasurer denied Outreach and a
// volunteer:
//   the desk's Today has no dashboard; MAP's band runs across the page under
//   the three numbers (≥ 1,000 wide, ≤ 560 tall, the walk lists' outlines,
//   "N walk lists"), Today reads nothing of /api/map/doors or /density; it
//   folds, stays folded on a reload and asks no Leaflet while folded;
//   "Activity ›" opens /activity; staff denied Map see no band;
//   Activity (empty and with data): its title and period pills, the tiles,
//   the chart, the map as a band (≥ 1,000 wide, ≤ 560 tall) with the people
//   under it, By team, Latest; a 500 says "Unavailable" with Try again, no
//   signal says the No signal line; the search finds and opens it;
//   Supporters: "of N needed" with the brief's numbers, the breakdown in
//   place (support=1) with the win number's lines, the band legend and
//   "Path to win ›"; with no win number the manager sees "Set it on Path to
//   win ›" and staff don't;
//   Needs you: "Connect email" for the manager while email isn't set up (and
//   no "All caught up."); with email set (:5422) "All caught up."; never for
//   staff or a treasurer;
//   Go to: at most six, in QUICK order, Reports first; Data-denied staff have
//   no Reports or Path to win; each opens its screen; "All places and people"
//   opens the search with focus in the box and finds a person and Activity;
//   exactly one "Ctrl K" on Today;
//   More: the week's lines and Clear sample data, no links to places;
//   plain and short (≤ 150 words, ≤ 5 h2, ≤ 1 primary at 1360x900); the band
//   and Needs you above the fold at 1440x900; no sideways scroll and 48 px
//   targets at 390;
//   Import & export: Verify the records, and Needs signal offline;
//   the volunteer's field Today: one primary button, MAP's window under it;
//   a manager opening /activity or /path-to-win in the field app lands on
//   the desk's screen; and the same under BASE_PATH (:5421): page--wide on
//   the desk's /, Go to's, the band's and Activity's popup links under the
//   base.
// Stand-in tiles answer every tile host (the sandbox reaches none).
//
//   (cd web && npm run build) && SHOTS=/tmp/home node e2e-home.mjs   servers on :5420, :5421, :5422
//   ONLY=root,email,basepath                                           just those parts
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const SHOTS = process.env.SHOTS || '/tmp/starbase-home';
mkdirSync(SHOTS, { recursive: true });
const ONLY = new Set((process.env.ONLY || '').split(',').filter(Boolean));
const want = (part) => !ONLY.size || ONLY.has(part);
const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 400) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Date.now().toString(36);
const num = (n) => Math.round(Number(n) || 0).toLocaleString('en-CA');
const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

const procs = [];
const start = (port, env = {}) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, STARBASE_OPEN_SIGNUP: '1', STARBASE_DATA: 'memory', PORT: String(port), STARBASE_JOBS: 'off', GEOCODER: 'off', GEOCODE_ON_SAVE: 'off', ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  procs.push(p);
  const t = setTimeout(() => reject(new Error(`server :${port} did not start`)), 30000);
  p.stdout.on('data', (b) => { if (/starbase on :/.test(String(b))) { clearTimeout(t); resolve(); } });
  p.on('exit', (code) => reject(new Error(`server :${port} exited ${code}`)));
});
process.on('exit', () => { for (const p of procs) p.kill(); });

// A plain made-up street map: no tile server is reached.
const tileSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#ecebe6"/><path d="M0 64H256M0 192H256M64 0V256M192 0V256" stroke="#fff" stroke-width="6"/></svg>`;
const tiles = (ctx) => ctx.route(/\/(\d+)\/(\d+)\/(\d+)(@2x)?\.png(\?.*)?$/, (route) => {
  if (/\/api\//.test(route.request().url())) return route.continue();
  return route.fulfill({ status: 200, contentType: 'image/svg+xml', headers: { 'access-control-allow-origin': '*' }, body: tileSvg });
});

// Tiles the service worker fetches go through the stand-in too.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const errors = [];

// One campaign on one server: its manager's page and helpers.
const campaign = async (port, basePath = '') => {
  const FIELD = basePath ? `http://127.0.0.1:${port}${basePath}/field` : `http://127.0.0.1:${port}`;
  const ADMIN = basePath ? `http://127.0.0.1:${port}${basePath}/desk` : `${FIELD}/admin`;
  const open = async (who, viewport = WIDE) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, timezoneId: 'America/Vancouver' });
    await tiles(ctx);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`[${who}${basePath ? ' bp' : ''}] ${e.message}`));
    const H = {
      ctx, page,
      api: async (path, body) => page.evaluate(async ([p, b]) => {
        const r = await fetch(p, b === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
        return { status: r.status, json: await r.json().catch(() => null) };
      }, [`${basePath}/api${path}`, body]),
      go: async (path, field = false) => { await page.goto(`${field ? FIELD : ADMIN}${path}`, { waitUntil: 'domcontentloaded' }); await sleep(700); },
      shot: (n, full = false) => page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: full }),
      text: async (sel = 'main.page') => ((await page.innerText(sel).catch(() => '')) || '').replace(/\s+/g, ' '),
    };
    return H;
  };
  const M = await open('manager');
  await M.go('/signup', true);
  await M.page.fill('#su-name', 'Rae Example');
  if (await M.page.locator('#su-org').count()) await M.page.fill('#su-org', 'Example Home Campaign');
  await M.page.fill('#su-email', `rae+${tag}${port}@example.org`);
  await M.page.fill('#su-password', 'front-page-2026');
  await M.page.click('button[type="submit"]');
  await M.page.waitForURL(/\/(admin|desk)\/?$/, { timeout: 15000 });
  const act = async (name, input) => {
    const r = await M.api(`/actions/${name}`, input);
    if (r.status !== 200) console.log(`  (${name} → ${r.status} ${JSON.stringify(r.json).slice(0, 200)})`);
    return r.json;
  };
  // Someone else on the team, with these areas taken away.
  const join = async (role, first, deny = [], viewport = WIDE) => {
    const inv = await act('member.invite', { email: `${first.toLowerCase()}+${tag}${port}@example.org`, role });
    const H = await open(first, viewport);
    await H.go('/login', true);
    const j = await H.api('/auth/join', { token: inv.joinUrl.split('/').pop(), name: `${first} Example`, password: 'front-page-2026' });
    const id = j.json?.user?.id;
    if (deny.length) await act('permission.member.set', { user_id: id, grant: [], deny });
    return { ...H, id };
  };
  return { M, act, join, open, FIELD, ADMIN, basePath };
};

// What Today asked of the server, while `fn` ran.
const asking = async (H, fn) => {
  const asked = [];
  const on = (r) => asked.push(r.url());
  H.page.on('request', on);
  try { await fn(); } finally { H.page.off('request', on); }
  return asked;
};
const rectOf = (page, sel) => page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) }; }).catch(() => null);
const deskToday = async (H) => { await H.go('/'); await H.page.waitForSelector('.today-nums', { timeout: 15000 }); await sleep(600); };
const goTo = (H) => H.page.$$eval('.today-goto a.today-goto__i', (els) => els.map((e) => ({ label: e.innerText.replace('›', '').trim(), href: e.getAttribute('href') })));
const measure = (page, targets) => page.evaluate((targets) => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'; };
  const yellow = [...document.querySelectorAll('main .btn-primary')].filter(vis).length;
  const overflow = document.documentElement.scrollWidth - window.innerWidth;
  const small = [...document.querySelectorAll(targets)].filter(vis)
    .map((el) => ({ t: (el.innerText || el.tagName).trim().slice(0, 30), h: Math.round(el.getBoundingClientRect().height) }))
    .filter((x) => x.h < 47.5);
  return { yellow, overflow, small };
}, targets);
const QUICK_ORDER = ['Reports', 'Print a walking list', 'Lists', 'Phone banks', 'Path to win', 'Get out the vote', 'Your letters'];
const inOrder = (labels) => labels.every((l, i) => i === 0 || QUICK_ORDER.indexOf(labels[i - 1]) < QUICK_ORDER.indexOf(l));

try {
  // ════════════════════════════════════════════════════════════════════
  // 1. The manager's desk Today, on a campaign with the sample loaded
  // ════════════════════════════════════════════════════════════════════
  if (want('root')) {
    await start(5420);
    const C = await campaign(5420);
    const { M, act } = C;
    const page = M.page;

    // Before the sample: an empty campaign's Today (the before/after pair's "after" for a new campaign).
    await deskToday(M);
    await M.shot('0-manager-empty-1440');
    await M.go('/activity');
    await page.waitForSelector('[data-testid="dashboard"] .dash-figs', { timeout: 15000 }).catch(() => {});
    await sleep(800);
    await M.shot('3-activity-empty-1440', true);
    const sample = await M.api('/data/sample', {});
    check('the sample loads', sample.status === 200, JSON.stringify(sample.json).slice(0, 200));
    // A second walk list, and the manager walks the sample's.
    const turfs = (await M.api('/turfs')).json?.turfs ?? [];
    await act('turf.create', { name: 'Fleetwood block', polygon: [[49.15, -122.80], [49.15, -122.79], [49.16, -122.79], [49.16, -122.80]] });
    const meId = (await M.api('/auth/me')).json.user.id;
    if (turfs[0]) await act('turf.assign', { turf_id: turfs[0].id, user_id: meId });

    // ── The band ──
    const asked = await asking(M, async () => {
      await deskToday(M);
      await page.waitForFunction(() => document.querySelectorAll('.mapwindow--band .leaflet-overlay-pane path').length >= 1, null, { timeout: 10000 }).catch(() => {});
      await sleep(800);
    });
    check('no dashboard on the desk’s Today', (await page.$('[data-testid="dashboard"]')) === null);
    const band = await rectOf(page, '.mapwindow--band');
    const frame = await rectOf(page, '.mapwindow--band .mapwindow__frame');
    const under = await page.$eval('.today-nums', (e) => e.nextElementSibling?.classList.contains('mapwindow--band')).catch(() => false);
    const meta = await page.$eval('.mapwindow--band .mapwindow__meta', (e) => e.innerText.trim()).catch(() => '');
    const outlines = await page.$$eval('.mapwindow--band .leaflet-overlay-pane path', (els) => els.length).catch(() => 0);
    const streets = await page.$$eval('.mapwindow--band .leaflet-tile-pane img', (els) => els.filter((i) => i.complete && i.naturalWidth > 0).length).catch(() => 0);
    check('the band: ≥ 1,000 wide, ≤ 560 tall, directly under the numbers', band && band.w >= 1000 && frame && frame.h <= 560 && frame.h >= 300 && under, JSON.stringify({ band, frame, under }));
    check('the band: streets and the walk lists’ outlines, “2 walk lists”', streets > 0 && outlines >= 2 && meta === '2 walk lists', JSON.stringify({ streets, outlines, meta }));
    check('Today asks nothing of /api/map/doors or /api/map/density', !asked.some((u) => /\/api\/map\/(doors|density)/.test(u)), asked.filter((u) => /map/.test(u)).join(' '));
    const wide = await page.$$eval('.today-desk > :not(.mapwindow--band)', (els) => els.map((e) => Math.round(e.getBoundingClientRect().width)).filter((x) => x > 1200));
    check('every other block keeps the 1,200 px column', wide.length === 0, JSON.stringify(wide));
    const needsTop = await rectOf(page, '#today-needs-h');
    check('at 1440x900 the band’s bottom and Needs you are above the fold', band && band.bottom <= 900 && needsTop && needsTop.y + needsTop.h <= 900, JSON.stringify({ band, needsTop }));
    await M.shot('1-manager-band-open-1440');

    // Fold, reload: still folded, no Leaflet asked for.
    await page.click('.mapwindow--band .mapwindow__toggle');
    const foldedNow = await page.$eval('.mapwindow--band .mapwindow__toggle', (b) => b.getAttribute('aria-expanded'));
    const mapGone = (await page.$('.mapwindow--band .mapwindow__frame')) === null;
    const reloadAsked = await asking(M, async () => { await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForSelector('.today-nums'); await sleep(1500); });
    const folded = await page.$eval('.mapwindow--band .mapwindow__toggle', (b) => b.getAttribute('aria-expanded')).catch(() => null);
    const chunks = reloadAsked.filter((u) => /\/assets\/(leaflet|MapWindowMap)-/.test(u));
    check('the fold: aria-expanded false and no map; a reload keeps it folded and asks no Leaflet', foldedNow === 'false' && mapGone && folded === 'false' && chunks.length === 0, JSON.stringify({ foldedNow, mapGone, folded, chunks }));
    await M.shot('2-manager-band-folded-1440');
    await page.setViewportSize(PHONE); await sleep(400);
    await M.shot('2-manager-band-folded-390', true);
    await page.setViewportSize(WIDE); await sleep(300);
    await page.click('.mapwindow--band .mapwindow__toggle');
    await sleep(800);

    // Activity ›
    await page.click('.today-under-band a');
    await page.waitForSelector('[data-testid="dashboard"]', { timeout: 10000 }).catch(() => {});
    check('“Activity ›” opens /activity, the old dashboard', /\/activity$/.test(new URL(page.url()).pathname) && Boolean(await page.$('[data-testid="dashboard"]')), page.url());

    // ── Activity: the rest of the dashboard, its own screen ──
    await page.waitForSelector('.dash-map .leaflet-tile-pane img', { timeout: 10000 }).catch(() => {});
    await sleep(1000);
    const h1 = await page.$eval('main h1', (e) => e.innerText.trim()).catch(() => '');
    const pills = await page.$$eval('.ops-head [role="radiogroup"] [role="radio"]', (els) => els.map((e) => e.innerText.trim()));
    const figs = await page.$$eval('.dash-figs [role="listitem"]', (els) => els.length).catch(() => 0);
    const actText = await M.text();
    check('Activity: “Activity”, the period pills, the overview tiles, the chart, By team and Latest',
      h1 === 'Activity' && pills.join('|') === 'Today|7 days|30 days|All time' && figs >= 6 && Boolean(await page.$('.dash svg'))
      && /By team/.test(actText) && /Latest/.test(actText) && !/Dashboard/.test(await page.$$eval('main h2', (els) => els.map((e) => e.innerText).join(' '))),
      JSON.stringify({ h1, pills, figs }));
    const amap = await rectOf(page, '.dash-map');
    const plist = await rectOf(page, '.dash-people');
    check('Activity: the map is a band (≥ 1,000 wide, ≤ 560 tall), the people list under it',
      amap && amap.w >= 1000 && amap.h <= 560 && amap.h >= 300 && plist && plist.y >= amap.bottom, JSON.stringify({ amap, plist }));
    const zoom = await page.evaluate(() => document.querySelector('.dash-map')?.classList.contains('leaflet-container'));
    check('Activity: the map is drawn, with its one-line note', zoom && /Dots: the period’s contacts · Initials: who canvassed/.test(actText), '');
    await M.shot('3-activity-1440', true);
    // Their zoom survives the band's height changing (a phone's address bar).
    const zoomNow = () => page.evaluate(() => {
      const lv = [...document.querySelectorAll('.dash-map .leaflet-tile-container')].sort((a, b) => Number(b.style.zIndex) - Number(a.style.zIndex))[0];
      const m = (lv?.querySelector('img')?.getAttribute('src') || '').match(/\/(\d+)\/\d+\/\d+(@2x)?\.png/);
      return m ? Number(m[1]) : null;
    });
    const z0 = await zoomNow();
    await page.click('.dash-map .leaflet-control-zoom-in'); await sleep(500);
    await page.click('.dash-map .leaflet-control-zoom-in'); await sleep(900);
    const z1 = await zoomNow();
    await page.setViewportSize({ width: 1440, height: 860 }); await sleep(900);
    const z2 = await zoomNow();
    check('Activity: zoomed in twice, a shorter window keeps the zoom', z0 != null && z1 === z0 + 2 && z2 === z1, JSON.stringify({ z0, z1, z2 }));
    await page.setViewportSize(WIDE); await sleep(400);
    await page.setViewportSize(PHONE); await sleep(600);
    const am = await measure(page, '.dash-period, .dash-prow');
    check('Activity at 390: no sideways scroll', am.overflow <= 0, JSON.stringify(am));
    await M.shot('3-activity-390', true);
    await page.setViewportSize(WIDE);
    // A failed read: "Unavailable" and Try again, never the raw message.
    await page.route(/\/api\/dashboard/, (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom: relation dashboard_x' }) }));
    await M.go('/activity');
    await page.waitForSelector('.dash-unavail', { timeout: 15000 }).catch(() => {});
    const failed = await M.text();
    check('Activity, a 500: “Unavailable” and Try again, no raw text', /Unavailable/.test(failed) && Boolean(await page.$('.dash-unavail button:has-text("Try again")')) && !/boom|relation/.test(failed), failed.slice(0, 200));
    await M.shot('3-activity-unavailable-1440');
    await page.unroute(/\/api\/dashboard/);
    await page.click('.dash-unavail button');
    await page.waitForSelector('.dash-figs', { timeout: 15000 }).catch(() => {});
    check('Activity: Try again loads it', Boolean(await page.$('.dash-figs')));
    // No signal and nothing loaded: the shared line.
    await page.route(/\/api\/dashboard/, (r) => r.abort('internetdisconnected'));
    await M.go('/activity');
    await page.waitForSelector('.dash .no-signal', { timeout: 15000 }).catch(() => {});
    check('Activity with no signal and nothing loaded: the No signal line', /No signal — this loads when you’re back online/.test(await M.text()), (await M.text()).slice(0, 200));
    await page.unroute(/\/api\/dashboard/);
    // From the search.
    await deskToday(M);
    await page.click('.today-goto__search');
    await page.waitForSelector('.cmd [role="combobox"]', { timeout: 5000 }).catch(() => {});
    await page.locator('.cmd [role="combobox"]').fill('activity');
    await sleep(400);
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-testid="dashboard"]', { timeout: 10000 }).catch(() => {});
    check('the search: “activity” ↵ opens Activity', /\/activity$/.test(new URL(page.url()).pathname), page.url());

    // ── Supporters, no win number yet ──
    await deskToday(M);
    let b = (await M.api('/brief')).json;
    let tile = (await page.innerText('button.today-num[aria-controls]')).replace(/\s+/g, ' ');
    const sup = (Number(b.ratings?.['1']) || 0) + (Number(b.ratings?.['2']) || 0);
    check('no win number: the tile is “Supporters” with the plain count', /Supporters/.test(tile) && tile.includes(num(sup)) && !/needed/.test(tile) && b.goal?.set === false, tile);
    await page.click('button.today-num[aria-controls]');
    await sleep(400);
    let detail = await M.text('.today-support');
    check('no win number: the manager is offered “Set it on Path to win ›”', /No win number yet/.test(detail) && /Set it on Path to win/.test(detail), detail.slice(0, 200));
    await M.shot('3-manager-no-win-number-1440');

    // ── With a win number ──
    const day = new Date(Date.now() + 38 * 86_400_000).toISOString().slice(0, 10);
    await act('pathtowin.save', { election_day: day, races: { council: { how: 'direct', votes: 120 } } });
    await deskToday(M);
    b = (await M.api('/brief')).json;
    const g = b.goal;
    tile = (await page.innerText('button.today-num[aria-controls]')).replace(/\s+/g, ' ');
    const aria = await page.getAttribute('button.today-num[aria-controls]', 'aria-label');
    check('the tile: “Supporters”, the number, “of N needed” (the brief’s)', g?.set && /Supporters/.test(tile) && tile.includes(num(g.supporters)) && tile.includes(`of ${num(g.needed)} needed`) && aria === `Supporters ${num(g.supporters)} of ${num(g.needed)} needed`, `${tile} | ${aria}`);
    await page.click('button.today-num[aria-controls]');
    await sleep(400);
    detail = await M.text('.today-support');
    check('the breakdown opens in place (support=1) with the win number’s lines, the legend and Path to win ›',
      /support=1/.test(page.url()) && detail.includes(`${g.label}: ${num(g.supporters)} of ${num(g.needed)} supporters · ${num(g.still)} to go`)
      && detail.includes(`${num(g.days_left)} days left · about ${num(g.per_week_needed)} a week to get there`)
      && /Opposed/.test(detail) && /Undecided/.test(detail) && /Path to win ›/.test(detail), detail.slice(0, 300));
    await M.shot('4-manager-breakdown-1440');
    await page.setViewportSize(PHONE); await sleep(400);
    await M.shot('4-manager-breakdown-390', true);
    await page.setViewportSize(WIDE); await sleep(300);
    await page.click('.today-support a:has-text("Path to win")');
    await page.waitForURL(/\/path-to-win/, { timeout: 8000 }).catch(() => {});
    check('“Path to win ›” opens /path-to-win', /\/path-to-win$/.test(new URL(page.url()).pathname), page.url());

    // ── Needs you ──
    await deskToday(M);
    await sleep(800);
    const needs = await M.text('section[aria-labelledby="today-needs-h"]');
    check('Needs you: the manager sees “Connect email” while email isn’t set up, not “All caught up.”', /Connect email/.test(needs) && !/All caught up/.test(needs), needs.slice(0, 300));
    const connectHref = await page.getAttribute('section[aria-labelledby="today-needs-h"] a:has-text("Connect email")', 'href');
    check('“Connect email” goes to Settings → Services', /\/settings\/services$/.test(connectHref || ''), connectHref);

    // ── Go to ──
    const places = await goTo(M);
    const labels = places.map((p) => p.label);
    check('Go to: at most six, Reports first, in QUICK order', labels.length <= 6 && labels.length >= 4 && labels[0] === 'Reports' && inOrder(labels), labels.join(' | '));
    await M.shot('5-manager-today-1440', true);
    for (const p of places) {
      await deskToday(M);
      await page.click(`.today-goto a.today-goto__i[href="${p.href}"]`);
      await sleep(900);
      const path = new URL(page.url()).pathname;
      check(`Go to → ${p.label} opens ${p.href.replace(/^.*(admin|desk)/, '')}`, path === p.href && !/Couldn’t load|went wrong/.test(await M.text()), path);
    }
    await deskToday(M);
    const kbd = await page.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => e.children.length === 0 && /^(Ctrl K|⌘K)$/.test(e.textContent.trim()) && e.getClientRects().length).length);
    check('exactly one “Ctrl K” on Today (the header’s)', kbd === 1, String(kbd));
    await page.click('.today-goto__search');
    await page.waitForSelector('.cmd [role="combobox"]', { timeout: 5000 }).catch(() => {});
    const focused = await page.evaluate(() => document.activeElement?.getAttribute('role'));
    check('“All places and people” opens the search, focus in the box', focused === 'combobox', String(focused));
    const someone = (await M.api('/persons?limit=1')).json?.persons?.[0]?.name || 'Example';
    await page.locator('.cmd [role="combobox"]').fill(someone);
    await page.waitForFunction((n) => [...document.querySelectorAll('.cmd [role="option"]')].some((o) => o.textContent.includes(n)), someone, { timeout: 6000 }).catch(() => {});
    const found = await page.$$eval('.cmd [role="option"]', (els) => els.map((e) => e.textContent.trim()));
    check(`the search finds a made-up person (${someone})`, found.some((t) => t.includes(someone)), found.slice(0, 5).join(' | '));
    await page.locator('.cmd [role="combobox"]').fill('activity');
    await sleep(400);
    const act1 = await page.$$eval('.cmd [role="option"]', (els) => els.map((e) => e.textContent.trim()));
    check('typing “activity” finds Activity', /^Activity/.test(act1[0] || ''), act1.slice(0, 3).join(' | '));
    await M.shot('6-manager-search-1440');
    await page.keyboard.press('Escape');

    // ── More ──
    await page.click('.today-morebox > .today-morebox__toggle');
    await sleep(400);
    const more = await M.text('.today-morebox__body');
    const moreLinks = await page.$$eval('.today-morebox__body a', (els) => els.map((e) => e.getAttribute('href')));
    check('More: the week’s lines, Your walk list, Clear sample data; no links to places',
      /This week:/.test(more) && /In all:/.test(more) && /Your walk list/.test(more) && /Clear sample data/.test(more)
      && moreLinks.every((h) => /\/turfs\//.test(h)) && !/Verify the records|Export all data|Phone banks/.test(more), `${more.slice(0, 200)} | ${moreLinks.join(' ')}`);
    await M.shot('7-manager-more-open-1440', true);

    // ── Plain and short, at 1360x900 ──
    await page.setViewportSize({ width: 1360, height: 900 });
    await deskToday(M);
    const plain = await page.evaluate(() => {
      const main = document.querySelector('main.page');
      const words = main.innerText.split(/\s+/).filter((w) => /\w/.test(w)).length;
      const h2 = main.querySelectorAll('h2').length;
      const yellow = [...main.querySelectorAll('.btn-primary')].filter((e) => e.getClientRects().length).length;
      return { words, h2, yellow };
    });
    check('plain and short: ≤ 150 words, ≤ 5 headings, ≤ 1 primary (1360x900, sample loaded)', plain.words <= 150 && plain.h2 <= 5 && plain.yellow <= 1, JSON.stringify(plain));
    console.log(`  (the manager’s desk Today, sample loaded: ${plain.words} words, ${plain.h2} h2)`);

    // ── The phone ──
    await page.setViewportSize(PHONE);
    await deskToday(M);
    await sleep(600);
    const mm = await measure(page, '.today-goto__i, .today-goto__search, .mapwindow__toggle, .today-num');
    check('at 390: no sideways scroll, ≤ 1 primary, Go to, the search and the fold ≥ 48 px', mm.overflow <= 0 && mm.yellow <= 1 && mm.small.length === 0, JSON.stringify(mm));
    await M.shot('8-manager-today-390', true);
    await page.setViewportSize(WIDE);

    // ── Import & export: Check the records ──
    await M.go('/data');
    await page.click('button:has-text("Verify the records")');
    await page.waitForSelector('.dt-page .ok-text', { timeout: 10000 }).catch(() => {});
    const verified = await M.text('.dt-page');
    check('Import & export: Verify the records → “✓ N entries check out”', /✓ [\d,]+ entries check out/.test(verified), verified.slice(-200));
    await M.shot('9-data-check-records-1440', true);
    await M.ctx.setOffline(true);
    await sleep(500);
    const offBtn = page.locator('button:has-text("Verify the records")');
    check('offline: Verify the records is off, with “Needs signal”', await offBtn.isDisabled() && /Needs signal/.test(await M.text('#dt-check + *').catch(() => '') || await M.text('.dt-page')), '');
    await M.ctx.setOffline(false);

    // ── Field app: desk addresses go to the desk ──
    for (const p of ['/activity', '/path-to-win']) {
      await M.go(p, true);
      await sleep(800);
      check(`a manager opening ${p} in the field app lands on the desk’s`, new URL(page.url()).pathname === `/admin${p}`, page.url());
    }

    // ════════════════════════════════════════════════════════════════
    // 2. Staff, staff denied Data, staff denied Map, a treasurer denied
    //    Outreach, a volunteer
    // ════════════════════════════════════════════════════════════════
    const staff = await C.join('staff', 'Sam');
    await deskToday(staff);
    await sleep(800);
    const sb = (await staff.api('/brief')).json;
    const sTile = (await staff.page.innerText('button.today-num[aria-controls]')).replace(/\s+/g, ' ');
    const sNeeds = await staff.text('section[aria-labelledby="today-needs-h"]');
    const sPlaces = (await goTo(staff)).map((p) => p.label);
    check('staff: “of N needed”, the band, no Connect email, no Activity, Go to ≤ 6 in order',
      sTile.includes(`of ${num(sb.goal?.needed)} needed`) && Boolean(await staff.page.$('.mapwindow--band')) && !/Connect email/.test(sNeeds)
      && !(await staff.page.$('.today-under-band')) && sPlaces.length <= 6 && inOrder(sPlaces), `${sTile} | ${sPlaces.join(' | ')}`);
    await staff.shot('10-staff-1440', true);
    await staff.go('/activity');
    await sleep(600);
    check('staff typing /activity land on Today', new URL(staff.page.url()).pathname === '/admin/' || new URL(staff.page.url()).pathname === '/admin', staff.page.url());

    // Their own letter, and the campaign's reply: Needs you says so, and
    // "Your letters" takes Go to's last tile.
    const mine = await staff.api('/actions/myletter.submit', { client_id: '00000000-0000-4000-8000-0000000004e1', kind: 'letter', body: 'A made-up letter about parks, for this test.' });
    await act('letter.note', { id: mine.json?.letter?.id, body: 'Thanks — one small change?' });
    await deskToday(staff);
    await sleep(800);
    const lNeeds = await staff.text('section[aria-labelledby="today-needs-h"]');
    const lHref = await staff.page.getAttribute('section[aria-labelledby="today-needs-h"] a:has-text("to your letters")', 'href').catch(() => null);
    const lPlaces = (await goTo(staff)).map((p) => p.label);
    check('a writer with a reply: “1 reply to your letters” in Needs you → /letters; Go to ends with “Your letters”',
      /1 reply to your letters/.test(lNeeds) && /\/letters$/.test(lHref || '') && lPlaces.length <= 6 && lPlaces[lPlaces.length - 1] === 'Your letters' && inOrder(lPlaces),
      `${lNeeds.slice(0, 200)} | ${lHref} | ${lPlaces.join(' | ')}`);
    await staff.shot('10b-staff-letters-1440', true);

    const dana = await C.join('staff', 'Dana', ['data']);
    await deskToday(dana);
    await sleep(600);
    const dPlaces = (await goTo(dana)).map((p) => p.label);
    const dTile = (await dana.page.innerText('button.today-num[aria-controls]')).replace(/\s+/g, ' ');
    check('staff denied Data: no Reports or Path to win in Go to; the plain count', !dPlaces.includes('Reports') && !dPlaces.includes('Path to win') && dPlaces.length > 0 && dPlaces.length <= 6 && !/needed/.test(dTile), `${dPlaces.join(' | ')} | ${dTile}`);
    await dana.page.click('button.today-num[aria-controls]');
    await sleep(300);
    check('staff denied Data: no win number lines, no “Set it”', !/Set it on Path to win|Path to win ›|No win number/.test(await dana.text('.today-support')));
    await dana.shot('11-staff-denied-data-1440', true);
    await dana.page.setViewportSize(PHONE); await sleep(400);
    await dana.shot('11-staff-denied-data-390', true);

    const mo = await C.join('staff', 'Mo', ['map']);
    await deskToday(mo);
    check('staff denied Map: no band', (await mo.page.$('.mapwindow--band')) === null);

    const tess = await C.join('treasurer', 'Tess', ['outreach']);
    await deskToday(tess);
    await sleep(800);
    const tNeeds = await tess.text('section[aria-labelledby="today-needs-h"]');
    check('a treasurer denied Outreach: no “Connect email”; Total raised', !/Connect email/.test(tNeeds) && /Total raised/.test(await tess.text()), tNeeds.slice(0, 200));

    // The volunteer's field Today: one primary button, MAP's window under it.
    const vic = await C.join('volunteer', 'Vic', [], PHONE);
    if (turfs[0]) await act('turf.assign', { turf_id: turfs[0].id, user_id: vic.id });
    await vic.go('/', true);
    await vic.page.waitForSelector('.today-go', { timeout: 10000 }).catch(() => {});
    await sleep(1200);
    const vm = await measure(vic.page, '.today-go .btn');
    const underGo = await vic.page.$eval('section.today-go', (e) => e.nextElementSibling?.classList.contains('mapwindow--window')).catch(() => false);
    const col = await rectOf(vic.page, 'main.page');
    check('the volunteer’s field Today: one primary button, MAP’s window directly under it, no sideways scroll', vm.yellow === 1 && underGo && vm.overflow <= 0, JSON.stringify({ vm, underGo, col }));
    await vic.shot('12-volunteer-field-open-390', true);
    await vic.page.click('.mapwindow--window .mapwindow__toggle').catch(() => {});
    await sleep(400);
    await vic.shot('12-volunteer-field-closed-390', true);
    for (const h of [staff, dana, mo, tess, vic]) await h.ctx.close();
    await M.ctx.close();
  }

  // ════════════════════════════════════════════════════════════════════
  // 3. Email set up (:5422): the manager's Needs you is all caught up
  // ════════════════════════════════════════════════════════════════════
  if (want('email')) {
    await start(5422, { RESEND_API_KEY: 're_made_up_for_tests', RESEND_API_BASE: 'http://127.0.0.1:9/' });
    const C = await campaign(5422);
    await deskToday(C.M);
    await sleep(1200);
    const b = (await C.M.api('/brief')).json;
    const needs = await C.M.text('section[aria-labelledby="today-needs-h"]');
    check('email set, texting not: the manager’s Needs you is “All caught up.”', b.providers?.email === true && b.providers?.text === false && /All caught up\./.test(needs) && !/Connect email/.test(needs), `${JSON.stringify(b.providers)} | ${needs}`);
    await C.M.ctx.close();
  }

  // ════════════════════════════════════════════════════════════════════
  // 4. Under BASE_PATH (:5421)
  // ════════════════════════════════════════════════════════════════════
  if (want('basepath')) {
    await start(5421, { BASE_PATH: '/imaginesurrey' });
    const C = await campaign(5421, '/imaginesurrey');
    const { M } = C;
    await M.api('/data/sample', {});
    await deskToday(M);
    await M.page.waitForSelector('.mapwindow--band .mapwindow__open', { timeout: 10000 }).catch(() => {});
    const pageClass = await M.page.getAttribute('main.page', 'class');
    const band = await rectOf(M.page, '.mapwindow--band');
    check('under BASE_PATH: page--wide on /imaginesurrey/desk, the band ≥ 1,000 wide', /page--wide/.test(pageClass || '') && band?.w >= 1000, `${pageClass} ${JSON.stringify(band)}`);
    const places = await goTo(M);
    check('under BASE_PATH: Go to’s links are under /imaginesurrey/desk', places.length > 0 && places.every((p) => p.href.startsWith('/imaginesurrey/desk/')), places.map((p) => p.href).join(' '));
    const bandLinks = (await M.page.$$eval('.mapwindow--band a', (els) => els.map((e) => e.getAttribute('href')))).filter((h) => !/^https?:/.test(h));
    check('under BASE_PATH: the band’s links are under /imaginesurrey/desk', bandLinks.length > 0 && bandLinks.every((h) => h.startsWith('/imaginesurrey/desk/')), bandLinks.join(' '));
    await M.page.click('.today-under-band a');
    await M.page.waitForSelector('[data-testid="dashboard"]', { timeout: 10000 }).catch(() => {});
    check('under BASE_PATH: Activity › opens /imaginesurrey/desk/activity', new URL(M.page.url()).pathname === '/imaginesurrey/desk/activity', M.page.url());
    // Activity's popups link through adminHref: a walk list's and a contact's.
    const popLinks = [];
    await M.page.waitForSelector('.dash-map path.leaflet-interactive', { timeout: 10000 }).catch(() => {});
    for (const i of [0, -1]) {
      await M.page.evaluate((i) => {
        const all = [...document.querySelectorAll('.dash-map path.leaflet-interactive')];
        all.at(i)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }, i);
      await M.page.waitForSelector('.dash-map .leaflet-popup-content a', { timeout: 5000 }).catch(() => {});
      popLinks.push(...await M.page.$$eval('.dash-map .leaflet-popup-content a', (els) => els.map((e) => e.getAttribute('href'))));
    }
    check('under BASE_PATH: Activity’s map popups link under /imaginesurrey/desk', popLinks.length > 0 && popLinks.every((h) => h.startsWith('/imaginesurrey/desk/')), popLinks.join(' '));
    await M.page.click(`.today-goto a`).catch(() => {});
    await M.go('/');
    await M.page.waitForSelector('.today-goto a', { timeout: 10000 });
    const first = places[0];
    await M.page.click(`.today-goto a[href="${first.href}"]`);
    await sleep(800);
    check(`under BASE_PATH: Go to → ${first.label} opens`, new URL(M.page.url()).pathname === first.href, M.page.url());
    await M.go('/', true);
    await sleep(600);
    const fieldClass = await M.page.getAttribute('main.page', 'class').catch(() => '');
    check('under BASE_PATH: the field app’s / keeps the column (no page--wide)', !/page--wide/.test(fieldClass || ''), fieldClass);
    await M.ctx.close();
  }
  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  check(`stopped: ${e?.stack || e}`, false);
} finally {
  await browser.close().catch(() => {});
  for (const p of procs) p.kill();
}
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed — screenshots in ${SHOTS}`);
process.exit(passed === results.length ? 0 : 1);
