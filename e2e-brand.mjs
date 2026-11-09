// Two looks: Imagine Surrey's own (production) and base.win's generic one
// (staging, any other campaign) — server/lib/brand.js. This script starts
// two fresh in-memory servers: one STARBASE_BRAND=base named "Demo Campaign"
// (as staging is), one Imagine Surrey (as production is, nothing set but
// the name). On each: the page arrives marked before it paints, with that
// brand's icon, colours and mark; the generic one says nothing of Imagine Surrey
// anywhere a person can see (sign-in, Today, the menu, training, Settings);
// Imagine Surrey's is as it always was. A manager renames the campaign in
// Settings → Campaign, and the sign-in page then says the new name.
// Screenshots of sign-in and Today, desktop and phone, light and dark, for
// each.
//
//   PORT=4180 SHOTS=/tmp/brand node e2e-brand.mjs     (uses PORT and PORT+1)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const PORT = Number(process.env.PORT) || 4180;
const SHOTS = process.env.SHOTS || '/tmp/starbase-brand';
mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 240) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const servers = [];
const start = async (port, env) => {
  const s = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, STARBASE_OPEN_SIGNUP: '1', STARBASE_DATA: 'memory', PORT: String(port), STARBASE_JOBS: 'off', STARBASE_BRAND: '', STARBASE_ORG_NAME: '', STARBASE_ENV: '', ...env },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  servers.push(s);
  for (let i = 0; i < 60; i += 1) {
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
const visibleText = (page) => page.evaluate(() => document.body.innerText);
const tokens = (page) => page.evaluate(() => {
  const cs = getComputedStyle(document.documentElement);
  const v = (k) => cs.getPropertyValue(k).trim().toLowerCase();
  return { brand: document.documentElement.dataset.brand || null, navy: v('--navy'), gold: v('--gold'), mark: v('--mark'), display: v('--font-display') };
});

const signUp = async (page, base, campaign) => {
  await page.goto(`${base}/signup`, { waitUntil: 'domcontentloaded' });
  await page.fill('#su-name', 'Riley Manager');
  if (await page.locator('#su-org').count()) await page.fill('#su-org', campaign);
  await page.fill('#su-email', `riley.${tag}.${campaign.replace(/\W+/g, '').toLowerCase()}@example.org`);
  await page.fill('#su-password', 'brand-check-2026');
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/admin\/?$/, { timeout: 15000 });
  await sleep(800);
};

const shoot = async (base, who, scheme) => {
  for (const [label, vp] of [['desktop', { width: 1360, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    const ctx = await browser.newContext({ viewport: vp, colorScheme: scheme, ...(label === 'phone' ? { isMobile: true, hasTouch: true } : {}) });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(`[${who} ${label}] ${e.message}`));
    await p.goto(`${base}/login`, { waitUntil: 'networkidle' });
    await p.screenshot({ path: `${SHOTS}/${who}-signin-${label}-${scheme}.png` });
    await ctx.close();
  }
};

// ── base.win's own look (staging) ──
// Sign-up closes once the campaign is set up, as on staging itself.
const BASE = await start(PORT, { STARBASE_BRAND: 'base', STARBASE_ENV: 'staging', STARBASE_ORG_NAME: 'Demo Campaign', STARBASE_OPEN_SIGNUP: '' });
{
  const html = await (await fetch(`${BASE}/`)).text();
  check('base: the page leaves marked data-brand="base", with the Base icon and slate bar colour',
    /<html lang="en" data-brand="base">/.test(html) && /href="\/base-mark.svg"/.test(html) && /content="#1e293b"/.test(html) && !/star\.png/.test(html));
  const manifest = await (await fetch(`${BASE}/manifest.webmanifest`)).json();
  check('base: installed, it is base.win in slate, with the generic look’s icons', manifest.name === 'base.win' && manifest.theme_color === '#1e293b' && manifest.icons.every((i) => i.src.includes('base-')), JSON.stringify(manifest).slice(0, 200));
  for (const icon of ['/base-mark.svg', '/base-icon-192.png', '/base-icon-512.png', '/base-icon-maskable-512.png', '/base-touch-icon.png']) {
    check(`base: ${icon} is there`, (await fetch(`${BASE}${icon}`)).status === 200);
  }
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`[base] ${e.message}`));
  // Before any script runs, the mark is already on <html> (no flash of the other look).
  await page.goto(`${BASE}/login`, { waitUntil: 'commit' });
  const early = await page.evaluate(() => document.documentElement.getAttribute('data-brand'));
  check('base: marked before the app’s script runs', early === 'base', early);
  await page.waitForLoadState('networkidle');
  const t = await tokens(page);
  check('base: slate and indigo, Inter headlines — not Surrey Navy or Marigold', t.brand === 'base' && t.navy === '#1e293b' && t.mark === '#4f46e5' && /^["']?inter/.test(t.display), JSON.stringify(t));
  const signin = await visibleText(page);
  check('base: sign-in names the demo campaign, nothing of Imagine Surrey', /Demo Campaign/.test(signin) && !/Imagine|Surrey/i.test(signin), signin.slice(0, 200));
  const authBg = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundImage);
  check('base: the sign-in backdrop is Base’s wash, not the rise', /linear-gradient\(160deg/.test(authBg), authBg.slice(0, 120));
  const markBg = await page.evaluate(() => getComputedStyle(document.querySelector('.auth-page .brand'), '::before').backgroundImage);
  check('base: the sign-in mark is Base’s', /base-mark\.svg/.test(markBg), markBg);
  await page.screenshot({ path: `${SHOTS}/base-signin-desktop.png` });

  await signUp(page, BASE, 'Demo Campaign');
  await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
  await sleep(600);
  const today = await visibleText(page);
  check('base: Today and the menu say nothing of Imagine Surrey; training is "Training"', !/Imagine|Surrey/i.test(today) && /Training/.test(today), today.slice(0, 300));
  const markSrc = await page.getAttribute('.brand-mark', 'src');
  check('base: the sidebar’s mark is Base’s', /base-mark\.svg$/.test(markSrc || ''), markSrc);
  await page.screenshot({ path: `${SHOTS}/base-today-desktop.png` });

  await page.goto(`${BASE}/admin/imagineu`, { waitUntil: 'networkidle' });
  await sleep(500);
  check('base: the training page is "Training"', (await page.innerText('h1')).trim() === 'Training');
  await page.goto(`${BASE}/admin/settings/permissions`, { waitUntil: 'networkidle' });
  await sleep(500);
  const perms = await visibleText(page);
  check('base: Settings → Permissions lists Training, not ImagineU', /Training/.test(perms) && !/ImagineU/.test(perms));

  // Settings → Campaign: rename in one step.
  await page.goto(`${BASE}/admin/settings/campaign`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#ws-name', { timeout: 8000 });
  check('Settings → Campaign shows the campaign’s name', (await page.inputValue('#ws-name')) === 'Demo Campaign');
  await page.fill('#ws-name', 'Riverside Demo');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.waitForSelector('text=✓ Saved', { timeout: 8000 });
  await sleep(500);
  check('renamed: the sidebar shows the new name at once', /Riverside Demo/.test(await page.innerText('.brand-org')), await page.innerText('.brand-org'));
  await page.screenshot({ path: `${SHOTS}/base-settings-campaign.png` });
  // Signed out, the sign-in page says it too — not "Demo Campaign", the
  // name the deployment gave before setup.
  const out = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const op = await out.newPage();
  op.on('pageerror', (e) => errors.push(`[base signed out] ${e.message}`));
  await op.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await op.waitForSelector('.auth-page .brand-org', { timeout: 8000 });
  const signinNow = await visibleText(op);
  check('renamed: the sign-in page shows the new name', (await op.innerText('.auth-page .brand-org')) === 'Riverside Demo' && !/Demo Campaign/.test(signinNow), signinNow.slice(0, 200));
  await op.screenshot({ path: `${SHOTS}/base-signin-renamed.png` });
  await out.close();

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await phone.addCookies(await ctx.cookies());
  const pp = await phone.newPage();
  pp.on('pageerror', (e) => errors.push(`[base phone] ${e.message}`));
  await pp.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await sleep(600);
  const field = await visibleText(pp);
  check('base, phone: the field app says nothing of Imagine Surrey; its tab reads Training', !/Imagine|Surrey/i.test(field) && /Training/.test(await pp.innerText('.tabbar')), field.slice(0, 200));
  const overflow = await pp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('base, phone: no sideways scroll', overflow <= 0, overflow);
  await pp.screenshot({ path: `${SHOTS}/base-today-phone.png` });
  // Dark.
  const dark = await browser.newContext({ viewport: { width: 1360, height: 900 }, colorScheme: 'dark' });
  await dark.addCookies(await ctx.cookies());
  const dp = await dark.newPage();
  await dp.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
  await sleep(600);
  const dt = await tokens(dp);
  check('base, dark: deep slate with light indigo', dt.mark === '#818cf8', JSON.stringify(dt));
  await dp.screenshot({ path: `${SHOTS}/base-today-desktop-dark.png` });
  await shoot(BASE, 'base', 'dark');
  await shoot(BASE, 'base', 'light');
  await ctx.close(); await phone.close(); await dark.close();
}

// ── Imagine Surrey's own (production: only the name set) ──
const IS = await start(PORT + 1, { STARBASE_ENV: 'production', STARBASE_ORG_NAME: 'Imagine Surrey' });
{
  const html = await (await fetch(`${IS}/`)).text();
  check('imagine-surrey: marked, with the star and Surrey Navy, as before', /data-brand="imagine-surrey"/.test(html) && /href="\/star.png"/.test(html) && /content="#003979"/.test(html));
  const manifest = await (await fetch(`${IS}/manifest.webmanifest`)).json();
  check('imagine-surrey: the manifest as it was', manifest.theme_color === '#003979' && manifest.icons[0].src === '/icon-192.png');
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`[is] ${e.message}`));
  await page.goto(`${IS}/login`, { waitUntil: 'networkidle' });
  const t = await tokens(page);
  check('imagine-surrey: Surrey Navy, Marigold, Barlow Condensed — unchanged', t.brand === 'imagine-surrey' && t.navy === '#003979' && t.gold === '#ffc72c' && /barlow/i.test(t.display), JSON.stringify(t));
  await page.screenshot({ path: `${SHOTS}/is-signin-desktop.png` });
  await signUp(page, IS, 'Imagine Surrey');
  await page.goto(`${IS}/admin`, { waitUntil: 'networkidle' });
  await sleep(600);
  check('imagine-surrey: training is ImagineU; the star in the sidebar', /ImagineU/.test(await visibleText(page)) && /star\.png$/.test(await page.getAttribute('.brand-mark', 'src') || ''));
  await page.screenshot({ path: `${SHOTS}/is-today-desktop.png` });
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await phone.addCookies(await ctx.cookies());
  const pp = await phone.newPage();
  await pp.goto(`${IS}/`, { waitUntil: 'networkidle' });
  await sleep(600);
  await pp.screenshot({ path: `${SHOTS}/is-today-phone.png` });
  await shoot(IS, 'is', 'light');
  await ctx.close(); await phone.close();
}

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
stopAll();
const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
