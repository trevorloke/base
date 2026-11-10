// The look, on real screens (web/src/app.css; the shades from
// shared/brand-look.js). Two fresh in-memory servers — base.win's own brand
// and Imagine Surrey's — each with the sample campaign. A manager at a desk
// (1360) and on a phone (390), and a volunteer on a phone, open every main
// screen in light and in dark, and each screen is read for what the look
// must never break:
//   - text reads: at least 4.5:1 against the ground actually behind it
//     (the rating colours, the map and the website's own theme sample are
//     data, not the app's look, and are not judged; nor is anything dimmed
//     because it is off);
//   - at most one primary button; no sideways scroll at 390;
//   - the shell: the campaign leads, the sidebar and the phone's bars are
//     light, a desk role on a phone has four tabs and More;
//   - the desk's density: with a mouse a button and a field are 40px; on a
//     phone they are 48 — and so is every choice in a pick-one control,
//     and the control itself (it lines up with the button beside it).
// Then the same screens under four hard brand colours — a yellow, a red, a
// pale pink, near-black — each with the light, the brand-coloured and the
// dark sidebar, written into the page the way the server writes a brand's
// shades (lookCss): any colour a campaign could pick is safe on the screens
// themselves, not only in the sums (server/test/brand-look.test.js).
//
//   PORT=4190 SHOTS=/tmp/look node e2e-look.mjs      (uses PORT and PORT+1)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { lookCss } from './shared/brand-look.js';

const PORT = Number(process.env.PORT) || 4190;
const SHOTS = process.env.SHOTS || '/tmp/starbase-look';
mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 600) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const servers = [];
const start = async (port, env) => {
  const s = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, STARBASE_OPEN_SIGNUP: '1', STARBASE_DATA: 'memory', PORT: String(port), STARBASE_JOBS: 'off', STARBASE_BRAND: '', STARBASE_ORG_NAME: '', STARBASE_ENV: '', ...env },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  servers.push(s);
  for (let i = 0; i < 80; i += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return `http://127.0.0.1:${port}`; } catch { /* not yet */ }
    await sleep(250);
  }
  throw new Error(`server on ${port} didn't start`);
};
const stopAll = () => { for (const s of servers) s.kill(); };
process.on('exit', stopAll);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const errors = [];
const tag = Date.now().toString(36);

// Map tiles are not reachable from a test machine: a plain ground stands in.
const TILE = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#eceae4"/><path d="M0 0H256M0 0V256" stroke="#fff" stroke-width="4"/></svg>';
const context = async (base, { phone = false, scheme = 'light', cookies = null } = {}) => {
  const ctx = await browser.newContext({
    viewport: phone ? { width: 390, height: 844 } : { width: 1360, height: 900 }, colorScheme: scheme, timezoneId: 'America/Vancouver', serviceWorkers: 'block',
    ...(phone ? { isMobile: true, hasTouch: true } : {}),
  });
  await ctx.route(/\/\d+\/\d+\/\d+(@2x)?\.(png|jpg|webp)(\?.*)?$/, (route) => (route.request().url().startsWith(base) ? route.continue() : route.fulfill({ status: 200, contentType: 'image/svg+xml', body: TILE })));
  if (cookies) await ctx.addCookies(cookies);
  return ctx;
};

// What is on the screen now: sideways scroll, primary buttons, and every
// piece of text whose colour is under 4.5:1 against the ground behind it.
const read = (page) => page.evaluate(() => {
  const shown = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const overflow = document.documentElement.scrollWidth - window.innerWidth;
  const primaries = [...document.querySelectorAll('.btn-primary')].filter(shown).length;
  const lum = (c) => { const [r, g, b] = c.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const parse = (s) => { const m = /rgba?\(([^)]+)\)/.exec(s); if (!m) return null; const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number); return { rgb: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 }; };
  const over = (top, a, under) => top.map((v, i) => v * a + under[i] * (1 - a));
  // The ground behind an element: its own and its ancestors' fills, the
  // see-through ones laid over the first solid one. A picture or a gradient
  // behind the text is not judged.
  const ground = (el) => {
    const stack = [];
    for (let n = el; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.backgroundImage && s.backgroundImage !== 'none') return null;
      const c = parse(s.backgroundColor);
      if (c && c.a > 0) { stack.push(c); if (c.a >= 1) break; }
    }
    let base = [255, 255, 255];
    for (const c of stack.reverse()) base = c.a >= 1 ? c.rgb : over(c.rgb, c.a, base);
    return base;
  };
  // Data, not the look: rating colours, the map, charts, the website's own theme.
  const DATA = '.leaflet-container, svg, .rb-chip, .rb-btn, .pp-dot, .dash-swatch, .lu-mark, .wb-sample, .wb-frame, .wb-swatch, .wb-pair, iframe';
  const low = new Map();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const text = t.nodeValue.trim();
    if (text.length < 2) continue;
    const el = t.parentElement;
    if (!el || !shown(el) || el.closest(DATA)) continue;
    let off = false;
    for (let n = el; n; n = n.parentElement) if (Number(getComputedStyle(n).opacity) < 1 || n.disabled || n.getAttribute?.('aria-disabled') === 'true') { off = true; break; }
    if (off) continue;
    const s = getComputedStyle(el);
    const fg = parse(s.color); const bg = ground(el);
    if (!fg || !bg) continue;
    const ink = fg.a >= 1 ? fg.rgb : over(fg.rgb, fg.a, bg);
    const a = lum(ink); const b = lum(bg);
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    if (ratio < 4.49) {
      const key = `${String(el.className).split(' ').filter(Boolean).slice(0, 2).join('.') || el.tagName.toLowerCase()} ${s.color} on rgb(${bg.map(Math.round).join(',')})`;
      if (!low.has(key)) low.set(key, `${ratio.toFixed(2)} “${text.slice(0, 20)}”`);
    }
  }
  return { overflow, primaries, low: [...low.entries()].map(([k, v]) => `${k} = ${v}`) };
});

// Opens each screen and reads it; `css` is a brand's shades written into
// the page (as the server writes them), for the colours no preset has.
const walk = async (page, base, paths, { css = null, phone = false } = {}) => {
  const bad = { low: [], overflow: [], primaries: [] };
  for (const path of paths) {
    await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' });
    if (css) await page.addStyleTag({ content: css });
    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
    await sleep(350);
    const m = await read(page);
    if (m.low.length) bad.low.push(`${path}: ${m.low.slice(0, 3).join('; ')}`);
    if (phone && m.overflow > 0) bad.overflow.push(`${path}: ${m.overflow}px`);
    if (m.primaries > 1) bad.primaries.push(`${path}: ${m.primaries}`);
  }
  return bad;
};

// A campaign with the sample data, a shift, and a volunteer who has a turf.
const setUp = async (base, campaign) => {
  const ctx = await context(base);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`[${campaign}] ${e.message}`));
  await page.goto(`${base}/signup`, { waitUntil: 'domcontentloaded' });
  await page.fill('#su-name', 'Riley Example');
  if (await page.locator('#su-org').count()) await page.fill('#su-org', campaign);
  await page.fill('#su-email', `riley.${tag}@example.org`);
  await page.fill('#su-password', 'look-check-2026');
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/admin\/?$/, { timeout: 20000 });
  const api = async (path, body) => {
    const r = body === undefined ? await ctx.request.get(`${base}/api${path}`) : await ctx.request.post(`${base}/api${path}`, { data: body });
    return { status: r.status(), json: await r.json().catch(() => null) };
  };
  await api('/data/sample', {});
  const people = (await api('/persons?limit=50')).json?.persons || [];
  const turfs = (await api('/turfs')).json?.turfs || [];
  const shifts = (await api('/shifts')).json?.shifts || [];
  const invite = (await api('/actions/member.invite', { email: `jas.${tag}@example.org`, role: 'volunteer' })).json;
  const vctx = await context(base, { phone: true });
  const vp = await vctx.newPage();
  await vp.goto(invite.joinUrl.replace(/^https?:\/\/[^/]+/, base), { waitUntil: 'domcontentloaded' });
  await vp.fill('#join-name', 'Jas Example');
  await vp.fill('#join-password', 'knock-knock-2026');
  await vp.click('button[type="submit"]');
  await vp.waitForURL((u) => !/\/join\//.test(String(u)), { timeout: 15000 });
  const me = await (await vctx.request.get(`${base}/api/auth/me`)).json();
  for (const t of turfs) await api('/actions/turf.assign', { turf_id: t.id, user_id: me.user.id });
  const state = { desk: await ctx.cookies(), vol: await vctx.cookies(), person: people[0]?.id, turf: turfs[0]?.id, shift: shifts[0]?.id };
  await ctx.close(); await vctx.close();
  return state;
};

const DESK = (s) => ['/', '/people', `/people/${s.person}`, '/map', '/shifts', `/shifts/${s.shift}`, '/shifts/volunteers', '/money', '/money?new=1', '/money/stewardship', '/outreach', '/outreach/texting',
  '/lists', '/signs', '/turfs', '/website', '/website/pages', '/website/theme', '/settings', '/settings/teams', '/settings/permissions', '/settings/services', '/settings/campaign',
  '/rating-scale', '/path-to-win', '/profile', '/data', '/people/import', '/people/fields', '/imagineu', '/requests', '/reports'].map((p) => `/admin${p === '/' ? '' : p}`);
// On a phone, the desk's screens a manager opens most.
const DESK_PHONE = (s) => ['/', '/people', `/people/${s.person}`, '/shifts', `/shifts/${s.shift}`, '/money', '/money?new=1', '/outreach', '/lists', '/signs', '/website', '/website/theme',
  '/settings', '/settings/permissions', '/settings/services', '/path-to-win', '/profile'].map((p) => `/admin${p === '/' ? '' : p}`);
const FIELD = (s) => ['/', '/map', '/shifts', `/shifts/${s.shift}`, '/calls', '/turfs', `/turfs/${s.turf}`, '/imagineu', '/profile', '/mainstreet', '/my-people'];
// The screens that carry the most of the brand: enough to judge a colour by.
const CORE = (s) => ['/admin', '/admin/people', `/admin/people/${s.person}`, '/admin/shifts', '/admin/money', '/admin/signs', '/admin/website', '/admin/settings'];
// Every pick-one control on these screens (app.css §13): how tall it is, how
// many rows its choices take, and its shortest choice.
const pickOnes = async (page, base, paths) => {
  const out = [];
  for (const path of paths) {
    await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
    out.push(...await page.evaluate(() => [...document.querySelectorAll('.ops-seg, .ot-seg, .dash-seg, .dash-periods, .channel-toggle, .cl-toggle, .door-channel, .rq-pills, .fk-tabs, .ot-tabs, .ws-tabs')].map((g) => {
      const r = g.getBoundingClientRect();
      const choices = [...g.children].filter((c) => c.matches('button, a')).map((c) => c.getBoundingClientRect());
      if (!r.height || !choices.length) return null;
      const tenth = (n) => Math.round(n * 10) / 10;
      return { is: g.className.split(' ')[0], h: tenth(r.height), rows: new Set(choices.map((c) => Math.round(c.top))).size, least: tenth(Math.min(...choices.map((c) => c.height))) };
    }).filter(Boolean)));
  }
  return out;
};
const wholeControl = (groups, px) => groups.length >= 3 && groups.every((g) => g.least >= px && (g.rows > 1 || g.h === px));
const none = (b) => b.low.length === 0;
const say = (list) => list.slice(0, 4).join(' | ');

for (const [key, env, campaign] of [['base', { STARBASE_BRAND: 'base' }, 'Riverside Forward'], ['imagine-surrey', { STARBASE_BRAND: 'imagine-surrey' }, 'Imagine Surrey']]) {
  const base = await start(key === 'base' ? PORT : PORT + 1, env);
  const s = await setUp(base, campaign);
  check(`${key}: a campaign with sample people, a turf and a shift to look at`, Boolean(s.person && s.turf && s.shift), JSON.stringify({ person: !!s.person, turf: !!s.turf, shift: !!s.shift }));

  for (const scheme of ['light', 'dark']) {
    // A manager at a desk.
    const d = await context(base, { scheme, cookies: s.desk });
    const dp = await d.newPage();
    dp.on('pageerror', (e) => errors.push(`[${key} ${scheme} desk] ${e.message}`));
    let bad = await walk(dp, base, DESK(s));
    check(`${key}, ${scheme}, at a desk: text reads on all ${DESK(s).length} screens`, none(bad), say(bad.low));
    check(`${key}, ${scheme}, at a desk: never more than one primary button`, bad.primaries.length === 0, say(bad.primaries));
    if (scheme === 'light') {
      await dp.goto(`${base}/admin/people`, { waitUntil: 'networkidle' });
      const shell = await dp.evaluate(() => {
        const css = (sel, prop) => { const el = document.querySelector(sel); return el ? getComputedStyle(el)[prop] : null; };
        const h = (sel) => Math.round(document.querySelector(sel)?.getBoundingClientRect().height || 0);
        return { side: css('header.nav', 'backgroundColor'), edge: css('header.nav', 'borderRightWidth'), shadow: css('.table', 'boxShadow'), h1: css('main.page h1', 'fontFamily'), caps: css('.table th', 'textTransform'),
          btn: h('.page-head .btn-primary'), field: h('.pp-search .input'), row: h('.table tbody tr'), sub: document.querySelector('.nav .brand-name')?.innerText.trim(), lead: Boolean(document.querySelector('.nav .brand img, .nav .brand-mono')) };
      });
      check(`${key}: a light sidebar on a hairline, flat cards, Inter headlines, sentence-case labels; the campaign leads, base.win under it`,
        shell.side === 'rgb(243, 244, 246)' && shell.edge === '1px' && shell.shadow === 'none' && /^["']?Inter/.test(shell.h1) && shell.caps === 'none' && shell.sub === 'base.win' && shell.lead, JSON.stringify(shell));
      check(`${key}: with a mouse a button and a field are 40px and a table row 44`, shell.btn === 40 && shell.field === 40 && shell.row >= 44 && shell.row <= 46, JSON.stringify({ btn: shell.btn, field: shell.field, row: shell.row }));
      await dp.screenshot({ path: `${SHOTS}/${key}-people-desk.png` });
      const picks = await pickOnes(dp, base, ['/admin', '/admin/outreach', '/admin/settings']);
      check(`${key}: with a mouse every choice in a pick-one control is 40px, and so is the control`, wholeControl(picks, 40), JSON.stringify(picks));
    }
    await d.close();

    // The same manager on a phone.
    const m = await context(base, { phone: true, scheme, cookies: s.desk });
    const mp = await m.newPage();
    mp.on('pageerror', (e) => errors.push(`[${key} ${scheme} phone] ${e.message}`));
    bad = await walk(mp, base, DESK_PHONE(s), { phone: true });
    check(`${key}, ${scheme}, the desk on a phone: text reads, no sideways scroll, one primary at most`, none(bad) && bad.overflow.length === 0 && bad.primaries.length === 0, say([...bad.low, ...bad.overflow, ...bad.primaries]));
    if (scheme === 'light') {
      await mp.goto(`${base}/admin/people`, { waitUntil: 'networkidle' });
      const bars = await mp.evaluate(() => {
        const css = (sel, prop) => { const el = document.querySelector(sel); return el ? getComputedStyle(el)[prop] : null; };
        const h = (sel) => Math.round(document.querySelector(sel)?.getBoundingClientRect().height || 0);
        return { top: css('header.nav', 'backgroundColor'), tabs: css('.tabbar', 'backgroundColor'), n: document.querySelectorAll('.tabbar > a, .tabbar .tab-more__btn').length, more: Boolean(document.querySelector('.tabbar .tab-more__btn')),
          btn: h('.page-head .btn-primary'), field: h('.pp-search .input') };
      });
      check(`${key}, on a phone: light bars, four tabs and More, and 48px controls`, bars.top === 'rgb(255, 255, 255)' && bars.tabs === 'rgb(255, 255, 255)' && bars.n === 5 && bars.more && bars.btn >= 48 && bars.field >= 48, JSON.stringify(bars));
      await mp.screenshot({ path: `${SHOTS}/${key}-people-phone.png` });
      const picks = await pickOnes(mp, base, ['/admin', '/admin/outreach', '/admin/settings']);
      check(`${key}, on a phone: every choice in a pick-one control is 48px — a row of them is 48, and tabs that wrap keep 48 a row`, wholeControl(picks, 48), JSON.stringify(picks));
    }
    await m.close();

    // A volunteer on a phone.
    const v = await context(base, { phone: true, scheme, cookies: s.vol });
    const vp = await v.newPage();
    vp.on('pageerror', (e) => errors.push(`[${key} ${scheme} volunteer] ${e.message}`));
    bad = await walk(vp, base, FIELD(s), { phone: true });
    check(`${key}, ${scheme}, a volunteer’s phone: text reads, no sideways scroll, one primary at most`, none(bad) && bad.overflow.length === 0 && bad.primaries.length === 0, say([...bad.low, ...bad.overflow, ...bad.primaries]));
    await vp.goto(`${base}/`, { waitUntil: 'networkidle' });
    await vp.screenshot({ path: `${SHOTS}/${key}-today-phone-${scheme}.png` });
    await v.close();

    // Signed out.
    const o = await context(base, { scheme });
    const op = await o.newPage();
    bad = await walk(op, base, ['/login', '/signup']);
    check(`${key}, ${scheme}, signed out: sign-in reads`, none(bad), say(bad.low));
    await op.screenshot({ path: `${SHOTS}/${key}-signin-${scheme}.png` });
    await o.close();
  }

  // Any colour a campaign could pick, on the screens themselves (on
  // base.win's own campaign: no logo, so the initials wear the colour too).
  if (key === 'base') {
    for (const [name, color] of [['yellow', '#fff100'], ['red', '#d81b1e'], ['pale pink', '#f9a8d4'], ['near-black', '#111111']]) {
      for (const sidebar of ['light', 'brand', 'dark']) {
        const css = lookCss({ color, sidebar });
        const found = [];
        for (const scheme of ['light', 'dark']) {
          const d = await context(base, { scheme, cookies: s.desk });
          const dp = await d.newPage();
          const bad = await walk(dp, base, CORE(s), { css });
          found.push(...bad.low.map((x) => `${scheme} desk ${x}`));
          if (scheme === 'light' && sidebar !== 'light') await dp.screenshot({ path: `${SHOTS}/brand-${name.replace(/\W+/g, '-')}-${sidebar}-desk.png` });
          await d.close();
          const m = await context(base, { phone: true, scheme, cookies: s.vol });
          const mp = await m.newPage();
          const badPhone = await walk(mp, base, ['/', '/calls', `/turfs/${s.turf}`], { css, phone: true });
          found.push(...badPhone.low.map((x) => `${scheme} phone ${x}`), ...badPhone.overflow.map((x) => `${scheme} phone ${x}`));
          await m.close();
        }
        check(`a ${name} brand (${color}), ${sidebar} sidebar: text reads on real screens, light and dark`, found.length === 0, say(found));
      }
    }
  }
}

check('no page errors', errors.length === 0, errors.slice(0, 4).join(' | '));
await browser.close();
stopAll();
const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
