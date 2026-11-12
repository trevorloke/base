// Two brands a campaign can start from: Imagine Surrey's own (production)
// and base.win's (staging, any other campaign) — server/lib/brand.js. Both
// are presets through one rule (shared/brand-look.js), on the same look: a
// light, neutral shell where the campaign's logo — or its initials — and one
// colour do the branding. This script starts two fresh in-memory servers:
// one STARBASE_BRAND=base named "Demo Campaign" (as staging is), one Imagine
// Surrey (as production is, nothing set but the name). On each: the page
// arrives marked before it paints, with that brand's icon and shades; the
// campaign leads (logo, or initials and name) and base.win is the small line
// under it; base.win's own says nothing of Imagine Surrey anywhere a person
// can see (sign-in, Today, the menu, training, Settings); Imagine Surrey's
// wears Surrey Navy and its wordmark. A manager renames the campaign in
// Settings → Campaign, and the sign-in page then says the new name.
// Then the brand a manager saves (Settings → Brand, through the screen): on
// base.win's own campaign a logo given as an SVG (kept as a PNG), a version
// for dark backgrounds, a square mark, a colour, the brand-coloured sidebar,
// what training is called and the name under the icon — a logo that can't
// be seen is warned about, never refused; the sample follows each change;
// after Save the screen, the signed-out sign-in page, the icons and the
// manifest all wear it; "Back to base.win's look" takes it off. On Imagine
// Surrey's, a save that changes only the sidebar keeps its wordmark (now the
// campaign's own upload) and leaves its live website's look alone.
// Screenshots of sign-in and Today, desktop and phone, light and dark, for
// each.
//
//   PORT=4180 SHOTS=/tmp/brand node e2e-brand.mjs     (uses PORT and PORT+1)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

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
  return { brand: document.documentElement.dataset.brand || null, accent: v('--accent'), second: v('--second'), mark: v('--mark'), words: v('--accent-words'), page: v('--page'), side: v('--side'), gold: v('--gold'), display: v('--font-display') };
});

// A campaign's pictures for the brand screen, as a designer would send
// them: SVGs with no size of their own (the browser draws them to PNGs).
const svg = (ink) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 80"><rect x="4" y="16" width="48" height="48" rx="10" fill="${ink}"/><rect x="66" y="24" width="240" height="14" rx="4" fill="${ink}"/><rect x="66" y="46" width="150" height="12" rx="4" fill="${ink}"/></svg>`;
const LOGO = `${SHOTS}/riverside-logo.svg`;
const LOGO_LIGHT = `${SHOTS}/riverside-logo-light.svg`;
const MARK = `${SHOTS}/riverside-mark.svg`;
const LOGO_FOREIGN = `${SHOTS}/riverside-logo-foreign.svg`;
writeFileSync(LOGO_FOREIGN, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 80"><foreignObject width="320" height="80"><div xmlns="http://www.w3.org/1999/xhtml">Riverside</div></foreignObject></svg>');
writeFileSync(LOGO, svg('#0f766e'));
writeFileSync(LOGO_LIGHT, svg('#ffffff'));
writeFileSync(MARK, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="#0f766e"/><circle cx="50" cy="50" r="24" fill="#ffffff"/></svg>');
// A picture is in once its button says Replace.
const upload = async (page, field, file) => {
  await page.setInputFiles(`#${field}`, file);
  await page.locator(`[aria-labelledby="${field}-label"]`).getByRole('button', { name: /^Replace/ }).waitFor({ timeout: 20000 });
  await sleep(500);
};
const notes = (page) => page.evaluate(() => [...document.querySelectorAll('.bs-note')].map((n) => `${n.className.includes('--warn') ? 'WARN ' : ''}${n.innerText.trim()}`).join(' | '));
const signinOf = async (base) => {
  const out = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const op = await out.newPage();
  op.on('pageerror', (e) => errors.push(`[signed out] ${e.message}`));
  await op.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await op.waitForSelector('.auth-page .btn-primary', { timeout: 8000 });
  const seen = await op.evaluate(() => {
    const i = document.querySelector('.auth-head img.brand-mark');
    return {
      logo: i ? { src: i.getAttribute('src'), alt: i.alt, drawn: i.complete && i.naturalWidth > 0, w: i.naturalWidth, h: i.naturalHeight } : null,
      initials: document.querySelector('.auth-head .brand-mono')?.innerText.trim() || null,
      button: getComputedStyle(document.querySelector('.auth-page .btn-primary')).backgroundColor,
      icon: document.querySelector('link[rel="icon"]')?.getAttribute('href'),
      title: document.title,
    };
  });
  return { out, op, seen };
};

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
  check('base: the page leaves marked data-brand="base", with the Base icon and a light bar colour (app.css holds its shades: no block)',
    /<html lang="en" data-brand="base">/.test(html) && /href="\/base-mark.svg"/.test(html) && /name="theme-color" content="#ffffff"/.test(html) && !/<style id="brand">/.test(html) && !/star\.png/.test(html));
  const manifest = await (await fetch(`${BASE}/manifest.webmanifest`)).json();
  check('base: installed, it is base.win on the page colour, with base.win’s icons', manifest.name === 'base.win' && manifest.theme_color === '#ffffff' && manifest.background_color === '#fafafb' && manifest.icons.every((i) => i.src.includes('base-')), JSON.stringify(manifest).slice(0, 200));
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
  check('base: indigo as the accent on a light sidebar, Inter headlines — not Surrey Navy or Marigold', t.brand === 'base' && t.accent === '#4f46e5' && t.mark === '#4f46e5' && t.side === '#f3f4f6' && t.gold !== '#ffc72c' && /^["']?inter/.test(t.display), JSON.stringify(t));
  const signin = await visibleText(page);
  check('base: sign-in names the demo campaign, nothing of Imagine Surrey', /Demo Campaign/.test(signin) && !/Imagine|Surrey/i.test(signin), signin.slice(0, 200));
  const authBg = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundImage);
  check('base: the sign-in backdrop is a soft wash of the tint on the page colour', /radial-gradient/.test(authBg) && !/linear-gradient/.test(authBg), authBg.slice(0, 120));
  // No logo: the campaign's initials on the brand colour lead; base.win is the line at the foot.
  const lead = await page.evaluate(() => {
    const m = document.querySelector('.auth-head .brand-mono');
    return { initials: m?.innerText.trim() || null, fill: m ? getComputedStyle(m).backgroundColor : null, imgs: document.querySelectorAll('.auth-page img').length, foot: document.querySelector('.auth-foot .brand')?.innerText.trim() || null };
  });
  check('base: sign-in leads with the campaign’s initials on the brand colour; base.win is the line at the foot', lead.initials === 'DC' && lead.fill === 'rgb(79, 70, 229)' && lead.imgs === 0 && lead.foot === 'base.win', JSON.stringify(lead));
  await page.screenshot({ path: `${SHOTS}/base-signin-desktop.png` });

  await signUp(page, BASE, 'Demo Campaign');
  await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
  await sleep(600);
  const today = await visibleText(page);
  check('base: Today and the menu say nothing of Imagine Surrey; training is "Training"', !/Imagine|Surrey/i.test(today) && /Training/.test(today), today.slice(0, 300));
  const side = await page.evaluate(() => ({ initials: document.querySelector('.nav .brand-mono')?.innerText.trim() || null, imgs: document.querySelectorAll('.nav .brand img').length, org: document.querySelector('.nav .brand-org')?.innerText.trim() || null, sub: document.querySelector('.nav .brand-name')?.innerText.trim() || null, ground: getComputedStyle(document.querySelector('.nav')).backgroundColor }));
  check('base: the sidebar is light and leads with the campaign — its initials and name, base.win under it', side.initials === 'DC' && side.imgs === 0 && side.org === 'Demo Campaign' && side.sub === 'base.win' && side.ground === 'rgb(243, 244, 246)', JSON.stringify(side));
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
  const bars = await pp.evaluate(() => ({ top: getComputedStyle(document.querySelector('header.nav')).backgroundColor, tabs: getComputedStyle(document.querySelector('.tabbar')).backgroundColor, on: getComputedStyle(document.querySelector('.tabbar a.active')).color }));
  check('base, phone: the top bar and the tab bar are light; the tab you are on is the brand colour', bars.top === 'rgb(255, 255, 255)' && bars.tabs === 'rgb(255, 255, 255)' && bars.on === 'rgb(79, 70, 229)', JSON.stringify(bars));
  await pp.screenshot({ path: `${SHOTS}/base-today-phone.png` });
  // Dark.
  const dark = await browser.newContext({ viewport: { width: 1360, height: 900 }, colorScheme: 'dark' });
  await dark.addCookies(await ctx.cookies());
  const dp = await dark.newPage();
  await dp.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
  await sleep(600);
  const dt = await tokens(dp);
  check('base, dark: neutral dark grounds, the brand lightened where it is words', dt.page === '#0f1012' && dt.accent === '#4f46e5' && dt.words === '#8983ee', JSON.stringify(dt));
  await dp.screenshot({ path: `${SHOTS}/base-today-desktop-dark.png` });
  await shoot(BASE, 'base', 'dark');
  await shoot(BASE, 'base', 'light');

  // ── Settings → Brand: the campaign's own look, through the screen ──
  const api = async (path, body) => {
    const r = body === undefined ? await ctx.request.get(`${BASE}/api${path}`) : await ctx.request.post(`${BASE}/api${path}`, { data: body });
    return { status: r.status(), json: await r.json().catch(() => null) };
  };
  await page.goto(`${BASE}/admin/settings/brand`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.bs', { timeout: 8000 });
  const opens = await page.evaluate(() => ({
    tabs: [...document.querySelectorAll('.ws-tabs a')].map((a) => a.innerText.trim()).slice(-2).join(' · '),
    primaries: [...document.querySelectorAll('.btn-primary')].filter((b) => b.offsetParent).map((b) => b.innerText.trim()),
    colour: document.querySelector('#bs-color').value, wells: [...document.querySelectorAll('.bs-pic__well')].map((w) => w.innerText.trim()).join(','),
    frames: document.querySelectorAll('.bs-sample .bs-s').length, back: /Back to/.test(document.querySelector('.bs-acts').innerText),
  }));
  check('Settings → Brand sits beside Campaign: the look it started in, no pictures yet, a sample of desk and phone in light and dark, and Save the one primary',
    opens.tabs === 'Campaign · Brand' && opens.primaries.join() === 'Save' && opens.colour === '#4f46e5' && opens.wells === 'None,None,None' && opens.frames === 4 && !opens.back, JSON.stringify(opens));

  // Leaving by a link inside the app keeps what was changed: it is there on coming back, said once.
  await page.fill('#bs-color', '#123456');
  await page.getByRole('group', { name: 'Corners' }).getByRole('button', { name: 'Square' }).click();
  await page.locator('.ws-tabs a', { hasText: 'Campaign' }).click();
  await page.waitForSelector('.bs', { state: 'detached', timeout: 8000 });
  await page.locator('.ws-tabs a', { hasText: 'Brand' }).click();
  await page.waitForSelector('.bs', { timeout: 8000 });
  const again = await page.evaluate(() => ({ colour: document.querySelector('#bs-color').value, corners: document.querySelector('[aria-labelledby="bs-corners"] [aria-pressed="true"]')?.innerText.trim(),
    said: document.querySelector('.bs-said')?.innerText.replace(/\s+/g, ' ').trim() || '' }));
  check('leaving Settings → Brand by a link and coming back: what was changed is still there, said in a line with “Discard them”',
    again.colour === '#123456' && again.corners === 'Square' && /^Your changes from before are still here\. They aren’t saved yet\. Discard them$/.test(again.said), JSON.stringify(again));
  await page.getByRole('button', { name: 'Discard them' }).click();
  await page.locator('.ws-tabs a', { hasText: 'Campaign' }).click();
  await page.waitForSelector('.bs', { state: 'detached', timeout: 8000 });
  await page.goBack();
  await page.waitForSelector('.bs', { timeout: 8000 });
  const clean = await page.evaluate(() => ({ colour: document.querySelector('#bs-color').value, corners: document.querySelector('[aria-labelledby="bs-corners"] [aria-pressed="true"]')?.innerText.trim(), said: document.querySelector('.bs-said')?.innerText || '' }));
  check('“Discard them”: the brand as it is saved again, and nothing kept', clean.colour === '#4f46e5' && clean.corners === 'Soft' && clean.said === '', JSON.stringify(clean));

  // A shared computer: what one manager left unsaved is theirs. Sign out forgets it, and the next manager to sign in on this tab is not offered it.
  const invite = (await api('/actions/member.invite', { email: `morgan.${tag}@example.org`, role: 'manager' })).json;
  await page.fill('#bs-color', '#7c2d12');
  await page.locator('.ws-tabs a', { hasText: 'Campaign' }).click();
  await page.waitForSelector('.bs', { state: 'detached', timeout: 8000 });
  const draftKeys = () => page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.includes('brand-draft')).length);
  const keptBefore = await draftKeys();
  const signOut = async () => {
    await page.click('.acct-btn');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.waitForURL(/\/login$/, { timeout: 10000 });
  };
  await signOut();
  const keptAfter = await draftKeys();
  await page.goto(String(invite?.joinUrl).replace(/^https?:\/\/[^/]+/, BASE), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#join-name', { timeout: 8000 });
  await page.fill('#join-name', 'Morgan Manager');
  await page.fill('#join-password', 'brand-check-2026');
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !/\/join\//.test(String(u)), { timeout: 15000 });
  const brandAsOpened = async () => {
    await page.goto(`${BASE}/admin/settings/brand`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.bs', { timeout: 8000 });
    return page.evaluate(() => ({ colour: document.querySelector('#bs-color').value, said: document.querySelector('.bs-said')?.innerText.replace(/\s+/g, ' ').trim() || '' }));
  };
  const next = await brandAsOpened();
  check('one manager’s unsaved brand is not offered to the next manager to sign in on the same tab: sign out forgets it',
    keptBefore === 1 && keptAfter === 0 && next.colour === '#4f46e5' && next.said === '', JSON.stringify({ keptBefore, keptAfter, next }));
  // Signing out straight from the screen, changes still on it, leaves nothing behind either.
  await page.fill('#bs-color', '#7c2d12');
  const keptOnScreen = await draftKeys();
  await signOut();
  const keptGone = await draftKeys();
  // The first manager again, for the rest: nothing of theirs was kept.
  await page.fill('#login-email', `riley.${tag}.democampaign@example.org`);
  await page.fill('#login-password', 'brand-check-2026');
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/admin\/?$/, { timeout: 15000 });
  const mine = await brandAsOpened();
  check('signing out from Settings → Brand itself forgets what was on it; signed in again, the first manager finds the brand as it is saved',
    keptOnScreen === 1 && keptGone === 0 && mine.colour === '#4f46e5' && mine.said === '', JSON.stringify({ keptOnScreen, keptGone, mine }));
  // The phone's sign-in was a copy of the one that just ended: it gets the new one.
  await phone.clearCookies();
  await phone.addCookies(await ctx.cookies());

  // An SVG the browser can draw but not hand back (a web page's text inside it): refused in words a manager can act on.
  await page.setInputFiles('#bs-logo', LOGO_FOREIGN);
  await page.locator('[aria-labelledby="bs-logo-label"] .error').waitFor({ timeout: 20000 });
  const foreign = await page.evaluate(() => ({ err: document.querySelector('[aria-labelledby="bs-logo-label"] .error').innerText.trim(), well: document.querySelector('.bs-pic__well').innerText.trim() }));
  check('an SVG that can’t be made a picture is refused in plain words, not the browser’s', foreign.err === 'This SVG can’t be turned into a picture here. Save it as a PNG and upload that.' && foreign.well === 'None', JSON.stringify(foreign));

  // A white logo given as the standard one: said, not refused.
  await upload(page, 'bs-logo', LOGO_LIGHT);
  const hidden = await notes(page);
  check('a logo that can’t be seen on a light background is warned about, and can still be saved', /WARN [^|]*too light to see on a light background/.test(hidden) && await page.locator('.bs-acts .btn-primary').isEnabled(), hidden);
  await upload(page, 'bs-logo', LOGO);
  const seenNow = await notes(page);
  check('the right logo: the warning goes; a version for dark backgrounds is offered', !/WARN/.test(seenNow) && /sits on a white chip\. Add a version for dark backgrounds/.test(seenNow), seenNow);
  await upload(page, 'bs-logo-dark', LOGO_LIGHT);
  await upload(page, 'bs-mark', MARK);
  const withDark = await notes(page);
  check('with a version for dark backgrounds, nothing more is asked', !/WARN|white chip/.test(withDark), withDark);

  // One colour in: the sample wears it as it is typed; a pale one gets dark text, by rule.
  await page.fill('#bs-color', '#fff100');
  await sleep(300);
  const pale = { notes: await notes(page), sample: await page.evaluate(() => { const b = document.querySelector('.bs-s[data-scheme="light"] .bs-s__btn'); const c = getComputedStyle(b); return `${c.backgroundColor} ${c.color}`; }) };
  check('a yellow brand colour: the sample’s button is yellow with dark text, and the screen says so', pale.sample === 'rgb(255, 241, 0) rgb(20, 22, 26)' && /buttons have dark text/.test(pale.notes) && /As words, your colour becomes #/.test(pale.notes), JSON.stringify(pale));
  await page.fill('#bs-color', '#0f766e');
  await page.getByRole('group', { name: 'Sidebar' }).getByRole('button', { name: 'Brand colour' }).click();
  await page.getByRole('group', { name: 'Corners' }).getByRole('button', { name: 'Round' }).click();
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.fill('#bs-learn', 'Academy');
  await page.fill('#bs-short', 'Riverside');
  await sleep(300);
  const sample = await page.evaluate(() => {
    const f = document.querySelector('.bs-s--desk[data-scheme="light"]');
    const side = f.querySelector('.bs-s__side'); const img = side.querySelector('img');
    return { side: getComputedStyle(side).backgroundColor, logo: img?.getAttribute('src') || null, drawn: Boolean(img?.complete && img.naturalWidth > 0), radius: getComputedStyle(f.querySelector('.bs-s__btn')).borderRadius };
  });
  check('the sample follows: a teal sidebar with the logo for dark backgrounds on it, round corners', sample.side === 'rgb(15, 118, 110)' && /^\/brand\/[0-9a-f-]{36}\.png$/.test(sample.logo || '') && sample.drawn && sample.radius === '12px', JSON.stringify(sample));
  await page.screenshot({ path: `${SHOTS}/base-settings-brand.png`, fullPage: true });

  await page.locator('.bs-acts .btn-primary').click();
  await page.waitForSelector('.bs-said', { timeout: 20000 });
  await sleep(600);
  const worn = { said: await page.innerText('.bs-said'), t: await tokens(page), nav: await page.evaluate(() => { const i = document.querySelector('.nav img.brand-mark'); return { src: i?.getAttribute('src') || null, drawn: Boolean(i?.complete && i.naturalWidth > 0), alt: i?.alt, text: document.querySelector('header.nav').innerText }; }) };
  check('saved: this screen wears it at once — teal the accent and the sidebar, the light logo on it, training called Academy',
    /Saved/.test(worn.said) && worn.t.accent === '#0f766e' && worn.t.side === '#0f766e' && /^\/brand\/[0-9a-f-]{36}\.png$/.test(worn.nav.src || '') && worn.nav.drawn && worn.nav.alt === 'Riverside Demo' && /Academy/.test(worn.nav.text), JSON.stringify(worn).slice(0, 400));
  const kept = (await api('/auth/me')).json.workspace.settings.brand;
  check('kept: the SVG logo is a PNG 1,024 px wide, the mark is square, four app icons were made from it — ids, never an address',
    kept.logo?.type === 'png' && kept.logo.w === 1024 && kept.logo.h === 256 && kept.logoDark?.type === 'png' && kept.mark?.w === kept.mark?.h && kept.mark.w === 512
    && ['i192', 'i512', 'maskable', 'touch'].every((k) => /^[0-9a-f-]{36}$/.test(kept.icons?.[k] || '')) && kept.shortName === 'Riverside' && kept.learn === 'Academy', JSON.stringify(kept).slice(0, 300));
  await page.screenshot({ path: `${SHOTS}/base-settings-brand-saved.png`, fullPage: true });

  // Signed out: the sign-in page wears it, before it paints.
  const branded = await signinOf(BASE);
  const rawPage = await (await fetch(`${BASE}/login`)).text();
  const man = await (await fetch(`${BASE}/manifest.webmanifest`)).json();
  const icon = await fetch(`${BASE}${man.icons[0].src}`);
  check('signed out: sign-in shows the campaign’s logo (alt: its name) and a teal button; the shades are in the page before the stylesheets',
    /^\/brand\/[0-9a-f-]{36}\.png$/.test(branded.seen.logo?.src || '') && branded.seen.logo.drawn && branded.seen.logo.alt === 'Riverside Demo' && branded.seen.button === 'rgb(15, 118, 110)'
    && /<style id="brand">:root\{[^<]*--accent:#0f766e;/.test(rawPage) && rawPage.indexOf('<style id="brand">') < rawPage.indexOf('<link rel="stylesheet"'), JSON.stringify(branded.seen));
  check('the tab and the installed app: the mark as the icon, Riverside under it', /^\/brand\/[0-9a-f-]{36}\.png$/.test(branded.seen.icon || '') && /^Riverside/.test(branded.seen.title)
    && man.short_name === 'Riverside' && /^\/brand\//.test(man.icons[0].src) && man.icons.length === 3 && icon.status === 200 && /image\/png/.test(icon.headers.get('content-type') || ''), JSON.stringify({ icon: branded.seen.icon, title: branded.seen.title, man: man.short_name, src: man.icons[0].src, status: icon.status }));
  await branded.op.screenshot({ path: `${SHOTS}/base-signin-branded.png` });
  await branded.out.close();

  // On a phone: nothing off the side, a thumb-sized Save.
  await pp.goto(`${BASE}/admin/settings/brand`, { waitUntil: 'networkidle' });
  await pp.waitForSelector('.bs', { timeout: 8000 });
  await sleep(500);
  const small = await pp.evaluate(() => ({ overflow: document.documentElement.scrollWidth - window.innerWidth, save: Math.round(document.querySelector('.bs-acts .btn-primary').getBoundingClientRect().height),
    primaries: [...document.querySelectorAll('.btn-primary')].filter((b) => b.offsetParent).length, top: getComputedStyle(document.querySelector('header.nav')).backgroundColor }));
  check('Settings → Brand on a phone: no sideways scroll, one primary 48px tall, the top bar in the brand colour', small.overflow <= 0 && small.save >= 48 && small.primaries === 1 && small.top === 'rgb(15, 118, 110)', JSON.stringify(small));
  await pp.screenshot({ path: `${SHOTS}/base-settings-brand-phone.png`, fullPage: true });

  // And back.
  await page.getByRole('button', { name: 'Back to base.win’s look' }).click();
  await page.getByRole('button', { name: 'Yes, go back' }).click();
  await page.waitForSelector('.bs-said', { timeout: 20000 });
  await sleep(600);
  const back = { said: await page.innerText('.bs-said'), t: await tokens(page), brand: (await api('/auth/me')).json.workspace.settings.brand ?? null };
  const plain = await signinOf(BASE);
  check('“Back to base.win’s look”: indigo and the campaign’s initials again, here and on sign-in', /Back to base\.win’s look/.test(back.said) && back.t.accent === '#4f46e5' && back.brand === null
    && plain.seen.logo === null && plain.seen.initials === 'RD' && plain.seen.button === 'rgb(79, 70, 229)', JSON.stringify({ back, plain: plain.seen }).slice(0, 300));
  await plain.out.close();
  await ctx.close(); await phone.close(); await dark.close();
}

// ── Imagine Surrey's own (production: only the name set) ──
const IS = await start(PORT + 1, { STARBASE_ENV: 'production', STARBASE_ORG_NAME: 'Imagine Surrey' });
{
  const html = await (await fetch(`${IS}/`)).text();
  check('imagine-surrey: marked, with the star as its icon, its shades in the page before the stylesheets (Surrey Navy the accent) and a light bar',
    /data-brand="imagine-surrey"/.test(html) && /href="\/star.png"/.test(html) && /<style id="brand">:root\{[^<]*--accent:#003979;/.test(html)
    && html.indexOf('<style id="brand">') < html.indexOf('<link rel="stylesheet"') && /name="theme-color" content="#ffffff"/.test(html));
  const manifest = await (await fetch(`${IS}/manifest.webmanifest`)).json();
  check('imagine-surrey: the manifest has its icons, on the page colour', manifest.theme_color === '#ffffff' && manifest.background_color === '#fafafb' && manifest.icons[0].src === '/icon-192.png', JSON.stringify(manifest).slice(0, 200));
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`[is] ${e.message}`));
  await page.goto(`${IS}/login`, { waitUntil: 'networkidle' });
  const t = await tokens(page);
  check('imagine-surrey: Surrey Navy the accent, Marigold the second colour, Inter headlines', t.brand === 'imagine-surrey' && t.accent === '#003979' && t.mark === '#003979' && t.second === '#ffc72c' && t.gold === '#ffc72c' && /^["']?inter/.test(t.display), JSON.stringify(t));
  const signinLogo = await page.evaluate(() => { const i = document.querySelector('.auth-head img.brand-mark'); return i ? { src: i.getAttribute('src'), alt: i.alt, drawn: i.complete && i.naturalWidth > 0 } : null; });
  check('imagine-surrey: sign-in leads with its wordmark, named for people who cannot see it', /\/site-assets\/imagine-surrey\/logo\.webp$/.test(signinLogo?.src || '') && signinLogo.alt === 'Imagine Surrey' && signinLogo.drawn, JSON.stringify(signinLogo));
  await page.screenshot({ path: `${SHOTS}/is-signin-desktop.png` });
  await signUp(page, IS, 'Imagine Surrey');
  await page.goto(`${IS}/admin`, { waitUntil: 'networkidle' });
  await sleep(600);
  const logo = await page.evaluate(() => { const i = document.querySelector('.nav img.brand-mark'); return i ? { src: i.getAttribute('src'), alt: i.alt, drawn: i.complete && i.naturalWidth > 0, sub: document.querySelector('.nav .brand-name')?.innerText.trim() } : null; });
  check('imagine-surrey: training is ImagineU; its wordmark leads the sidebar (alt: the campaign’s name), base.win under it',
    /ImagineU/.test(await visibleText(page)) && /\/site-assets\/imagine-surrey\/logo\.webp$/.test(logo?.src || '') && logo.alt === 'Imagine Surrey' && logo.drawn && logo.sub === 'base.win', JSON.stringify(logo));
  await page.screenshot({ path: `${SHOTS}/is-today-desktop.png` });
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await phone.addCookies(await ctx.cookies());
  const pp = await phone.newPage();
  await pp.goto(`${IS}/`, { waitUntil: 'networkidle' });
  await sleep(600);
  await pp.screenshot({ path: `${SHOTS}/is-today-phone.png` });
  // Dark: neutral grounds, navy lightened where it is words, and the wordmark's light version.
  const dark = await browser.newContext({ viewport: { width: 1360, height: 900 }, colorScheme: 'dark' });
  await dark.addCookies(await ctx.cookies());
  const dp = await dark.newPage();
  dp.on('pageerror', (e) => errors.push(`[is dark] ${e.message}`));
  await dp.goto(`${IS}/admin`, { waitUntil: 'networkidle' });
  await sleep(600);
  const dt = await tokens(dp);
  const darkLogo = await dp.evaluate(() => { const i = document.querySelector('.nav img.brand-mark'); return i ? { src: i.currentSrc, drawn: i.complete && i.naturalWidth > 0 } : null; });
  check('imagine-surrey, dark: neutral dark grounds (not a blue mode), navy lightened where it is words, the light wordmark',
    dt.page === '#0f1012' && dt.accent === '#003979' && dt.words !== '#003979' && /logo-light\.png$/.test(darkLogo?.src || '') && darkLogo.drawn, JSON.stringify({ ...dt, darkLogo }));
  await dp.screenshot({ path: `${SHOTS}/is-today-desktop-dark.png` });
  await shoot(IS, 'is', 'light');
  await shoot(IS, 'is', 'dark');

  // ── Imagine Surrey saves a brand: only the sidebar changes ──
  const api = async (path, body) => {
    const r = body === undefined ? await ctx.request.get(`${IS}/api${path}`) : await ctx.request.post(`${IS}/api${path}`, { data: body });
    return { status: r.status(), json: await r.json().catch(() => null) };
  };
  const siteBefore = (await api('/site')).json.settings.theme;
  await page.goto(`${IS}/admin/settings/brand`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.bs', { timeout: 8000 });
  await sleep(800);
  const starts = await page.evaluate(() => ({ colour: document.querySelector('#bs-color').value, second: document.querySelector('#bs-second').value,
    wells: [...document.querySelectorAll('.bs-pic__well img')].map((i) => i.getAttribute('src')), drawn: [...document.querySelectorAll('.bs-pic__well img')].every((i) => i.complete && i.naturalWidth > 0),
    warn: document.querySelectorAll('.bs-note--warn').length, site: /Use the website’s colours and logo/.test(document.querySelector('.bs-acts').innerText) }));
  check('imagine-surrey: Settings → Brand opens on its own look — navy, marigold, both wordmarks, nothing to warn about — and offers the website’s colours and logo',
    starts.colour === '#003979' && starts.second === '#ffc72c' && starts.wells.length === 2 && /logo\.webp$/.test(starts.wells[0]) && /logo-light\.png$/.test(starts.wells[1]) && starts.drawn && starts.warn === 0 && starts.site, JSON.stringify(starts));
  await page.getByRole('group', { name: 'Sidebar' }).getByRole('button', { name: 'Brand colour' }).click();
  await page.screenshot({ path: `${SHOTS}/is-settings-brand.png`, fullPage: true });
  await page.locator('.bs-acts .btn-primary').click();
  await page.waitForSelector('.bs-said', { timeout: 30000 });
  await sleep(600);
  const navy = { t: await tokens(page), nav: await page.evaluate(() => { const i = document.querySelector('.nav img.brand-mark'); return { src: i?.getAttribute('src') || null, drawn: Boolean(i?.complete && i.naturalWidth > 0), alt: i?.alt, text: document.querySelector('header.nav').innerText }; }) };
  const isKept = (await api('/auth/me')).json.workspace.settings.brand;
  check('imagine-surrey, saved with a navy sidebar: its wordmark stays (now the campaign’s own upload, the light one on the navy), ImagineU stays, the star stays its icon',
    navy.t.side === '#003979' && /^\/brand\/[0-9a-f-]{36}\.png$/.test(navy.nav.src || '') && navy.nav.src.includes(isKept.logoDark?.id) && navy.nav.drawn && navy.nav.alt === 'Imagine Surrey' && /ImagineU/.test(navy.nav.text)
    && isKept.logo?.id && isKept.learn === 'ImagineU' && /href="\/star\.png"/.test(await (await fetch(`${IS}/`)).text()), JSON.stringify({ navy, isKept }).slice(0, 400));
  const siteAfter = (await api('/site')).json.settings.theme;
  check('imagine-surrey: its website keeps its own look — it does not follow the brand', siteAfter.follow !== true && JSON.stringify(siteAfter.colors) === JSON.stringify(siteBefore.colors) && siteAfter.logo?.url === siteBefore.logo?.url, JSON.stringify(siteAfter).slice(0, 200));
  await page.screenshot({ path: `${SHOTS}/is-today-navy-sidebar.png` });
  await ctx.close(); await phone.close(); await dark.close();
}

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
stopAll();
const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
