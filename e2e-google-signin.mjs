// Sign in with Google and the Google card, end to end, against a stand-in
// Google (server/test/fake-google.js) — never the real one: the suite fails
// if the browser asks anything of an address other than 127.0.0.1.
//
// It starts its own servers and stops them: base.win on 5300, the fake
// Google on 5301, a second base.win under BASE_PATH=/imaginesurrey on 5302,
// a test hook on 5303 (server/test/google-e2e-server.js: one googleFetch,
// as a feature would make), and a base.win without Google on 5304 (the
// Services row "Not set up"). Build the web app first (cd web && npm run build).
//
//   SHOTS=/tmp/google node e2e-google-signin.mjs
//
// A manager, a staffer and volunteers, at 1440x900 and 390x844: the button
// under the one primary "Sign in" (and the installed app's line instead);
// an unlinked Google account refused; linking on Your profile, then Google
// sign-in landing on the desk for the manager and the field app for a
// volunteer (the Strict session cookie works after the cross-site return);
// two-step's code step from Google; Cancel; the domain rule; Join with the
// tick box; Link and Unlink; the Services panel (Copy, the switch, the
// domain refused then set); Team's chip and Unlink Google; a connection
// (Connect, Connected as, Reconnect after Google revokes, Disconnect);
// offline; under BASE_PATH; one primary per screen, no sideways scroll at
// 390, 48 px targets on the phone.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { startFakeGoogle } from './server/test/fake-google.js';
import { base32Decode, hotp, totpStep } from './server/lib/twostep.js';

const SHOTS = process.env.SHOTS || '/tmp/starbase-google';
mkdirSync(SHOTS, { recursive: true });
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:5300`;
const G = `http://${HOST}:5301`;
const BP = `http://${HOST}:5302`;
const P = '/imaginesurrey';
const POKE = `http://${HOST}:5303`;
const NOG = `http://${HOST}:5304`;
const CLIENT_ID = 'e2e-client.apps.example';
const SECRET = 'e2e-client-secret';
const PASSWORD = 'surrey-forward-2026';
const tag = Date.now().toString(36);
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  — ${String(extra).slice(0, 300)}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── The stand-in Google and three base.win servers ──
const ACCTS = {
  ann: { sub: '200000000000000000001', email: 'ann.example@gmail.com', name: 'Ann Example' },
  bo: { sub: '200000000000000000002', email: 'bo@campaign.example.org', hd: 'campaign.example.org', name: 'Bo Example' },
  cy: { sub: '200000000000000000003', email: 'cy.example@gmail.com', name: 'Cy Example' },
  dee: { sub: '200000000000000000004', email: 'dee.example@gmail.com', name: 'Dee Example' },
  eve: { sub: '200000000000000000005', email: 'eve.example@gmail.com', name: 'Eve Example' },
  zed: { sub: '200000000000000000009', email: 'zed.example@gmail.com', name: 'Zed Example' },
};
const fake = await startFakeGoogle({
  port: 5301, clientId: CLIENT_ID, secret: SECRET, accounts: Object.values(ACCTS),
  redirectUris: [`${BASE}/api/auth/google/back`, `${BP}${P}/api/auth/google/back`],
});
const procs = [];
const startServer = async (port, env, label) => {
  const child = spawn(process.execPath, ['server/test/google-e2e-server.js'], {
    env: { ...process.env, STARBASE_OPEN_SIGNUP: '1', STARBASE_DATA: 'memory', PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  procs.push(child);
  for (let i = 0; i < 100; i += 1) {
    if (child.exitCode !== null) break; // a port in use, say: never trust another server's answer
    try { if ((await fetch(`http://${HOST}:${port}/api/health`)).status < 500) return child; } catch { /* starting */ }
    await sleep(200);
  }
  throw new Error(`${label} didn't start: ${log.slice(-800)}`);
};
const GOOGLE_ENV = {
  GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET: SECRET,
  GOOGLE_ACCOUNTS_BASE: G, GOOGLE_OAUTH_BASE: G,
};
const stopAll = async () => {
  for (const p of procs) p.kill('SIGTERM');
  await sleep(300);
  for (const p of procs) if (p.exitCode === null) p.kill('SIGKILL');
  await fake.close();
};

let browser;
const errors = [];
const offHost = [];
try {
  await startServer(5300, { ...GOOGLE_ENV, STARBASE_PUBLIC_URL: BASE, GOOGLE_TOKEN_KEY: `e2e-google-token-key-${tag}-0123456789abcdef`, POKE_PORT: '5303', STARBASE_JOBS_EVERY_MS: '1000' }, 'base.win');
  await startServer(5302, { ...GOOGLE_ENV, STARBASE_PUBLIC_URL: `${BP}${P}`, BASE_PATH: P }, 'base.win under BASE_PATH');
  await startServer(5304, { STARBASE_PUBLIC_URL: NOG }, 'base.win without Google');

  browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const contexts = [];
  const newPage = async (viewport = DESKTOP, label = 'page', { standalone = false } = {}) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, timezoneId: 'America/Vancouver', ...(viewport === PHONE ? { isMobile: true, hasTouch: true } : {}) });
    contexts.push(ctx);
    // Nothing leaves this machine: anything not on 127.0.0.1 is stopped and counted.
    await ctx.route('**/*', (route) => {
      const u = new URL(route.request().url());
      if (u.hostname !== HOST && u.protocol !== 'data:' && u.protocol !== 'blob:') { offHost.push(u.href); return route.abort(); }
      return route.continue();
    });
    if (standalone) {
      await ctx.addInitScript(() => {
        const real = window.matchMedia.bind(window);
        window.matchMedia = (q) => (/display-mode:\s*standalone/.test(q) ? { matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} } : real(q));
      });
    }
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`[${label}] ${e.message}`));
    return { ctx, page };
  };
  const shot = (p, name, full = true) => p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: full });
  const text = async (p, sel = 'body') => ((await p.innerText(sel).catch(() => '')) || '').replace(/\s+/g, ' ');
  const noSideways = (p) => p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const primaries = (p) => p.locator('.btn-primary:visible').count();
  const api = (p, path, body) => p.evaluate(async ([u, b]) => {
    const r = await fetch(u, b === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    return { status: r.status, json: await r.json().catch(() => null) };
  }, [path, body]);
  // The fake's page: pick an account (or Cancel), and wait to be back.
  const pickGoogle = async (p, who) => {
    await p.waitForURL((u) => u.port === '5301', { timeout: 10000 });
    if (who === 'cancel') await p.click('#cancel');
    else await p.click(`a.acct[data-sub="${ACCTS[who].sub}"]`);
    await p.waitForURL((u) => u.port !== '5301', { timeout: 10000 });
    await p.waitForLoadState('domcontentloaded');
  };
  const passwordIn = async (p, origin, path, email) => {
    await p.goto(`${origin}${path}`, { waitUntil: 'domcontentloaded' });
    await p.fill('#login-email', email);
    await p.fill('#login-password', PASSWORD);
    await p.getByRole('button', { name: 'Sign in', exact: true }).click();
  };
  const tapTargets = (p, sel) => p.evaluate((s) => [...document.querySelectorAll(s)].filter((e) => e.offsetParent)
    .map((e) => ({ t: e.textContent.trim().slice(0, 30), h: Math.round(e.getBoundingClientRect().height) })).filter((x) => x.h < 48), sel);

  // ── A manager signs up; a staffer and a volunteer join ──
  const { ctx: mctx, page: m } = await newPage(DESKTOP, 'manager');
  await m.goto(`${BASE}/signup`, { waitUntil: 'domcontentloaded' });
  await m.fill('#su-name', 'Rae Example');
  if (await m.locator('#su-org').count()) await m.fill('#su-org', 'Example Campaign');
  const mgr = `rae.${tag}@example.org`;
  await m.fill('#su-email', mgr);
  await m.fill('#su-password', PASSWORD);
  await m.click('button[type="submit"]');
  await m.waitForURL(/\/admin\/?$/, { timeout: 15000 });
  const joinByApi = async (email, role, name) => {
    const inv = (await api(m, '/api/actions/member.invite', { email, role })).json;
    const r = await fetch(`${BASE}/api/auth/join`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ token: inv.joinUrl.split('/join/')[1], name, password: PASSWORD }) });
    return r.status;
  };
  const staff = `sam.${tag}@example.org`;
  const vol = `val.${tag}@example.org`;
  check('a staffer and a volunteer join', (await joinByApi(staff, 'staff', 'Sam Example')) === 200 && (await joinByApi(vol, 'volunteer', 'Val Example')) === 200);

  // ── Sign in: the button under the one primary ──
  for (const [vp, name] of [[DESKTOP, 'desktop'], [PHONE, 'phone']]) {
    const { page } = await newPage(vp, `login ${name}`);
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await page.locator('.gg-btn').waitFor({ timeout: 8000 });
    const t = await text(page);
    check(`Sign in (${name}): “Sign in with Google” under one primary “Sign in”`, /Sign in with Google/.test(t) && (await primaries(page)) === 1
      && (await page.locator('.gg-btn').boundingBox()).y > (await page.locator('.btn-primary').boundingBox()).y);
    if (vp === PHONE) {
      check('Sign in (phone): no sideways scroll; the Google button is 48 px tall', (await noSideways(page)) <= 0 && (await tapTargets(page, '.gg-btn, .btn-primary')).length === 0);
    }
    await shot(page, `01-login-${name}`);
  }
  {
    const { page } = await newPage(PHONE, 'installed', { standalone: true });
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await page.getByText('Open base.win in your browser to use Google.').waitFor({ timeout: 8000 });
    check('installed app: the line, and no Google button', (await page.locator('.gg-btn').count()) === 0);
    await shot(page, '02-login-installed-phone');
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await page.fill('#login-email', vol);
    await page.fill('#login-password', PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL(`${BASE}/`, { timeout: 10000 });
    check('installed app: password sign-in unchanged', true);
  }
  {
    const { page } = await newPage(DESKTOP, 'wrong password');
    await passwordIn(page, BASE, '/login', mgr.replace('rae', 'nobody'));
    await page.locator('.error').waitFor({ timeout: 8000 });
    check('a wrong password: no promise of a reset', /don’t match\. Check both, or sign in with Google\./.test(await text(page, '.error')), await text(page, '.error'));
  }

  // ── Not linked → no-account; link on Your profile; then Google lands on the desk ──
  {
    const { page } = await newPage(DESKTOP, 'unlinked');
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await page.click('.gg-btn');
    await pickGoogle(page, 'ann');
    await page.locator('.error').waitFor({ timeout: 8000 });
    check('an unlinked Google account: no-account words', /That Google account isn’t linked to base\.win\. Sign in with your password, then link Google on Your profile\./.test(await text(page, '.error')));
    check('…and the address loses ?google=', !/google=/.test(page.url()), page.url());
    await shot(page, '03-login-no-account-desktop');
  }
  await m.goto(`${BASE}/admin/profile`, { waitUntil: 'domcontentloaded' });
  await m.getByText('Link Google account').waitFor({ timeout: 8000 });
  check('Your profile, not linked: the Google card says what linking does', /Sign in with your Google account as well as your password\./.test(await text(m, '.gg-card')) && (await primaries(m)) <= 1);
  await shot(m, '04-profile-not-linked-desktop');
  await m.click('text=Link Google account');
  await pickGoogle(m, 'ann');
  await m.getByText('Linked — next time, Sign in with Google').waitFor({ timeout: 8000 });
  check('linked from the desk: back on /admin/profile, linked', new URL(m.url()).pathname === '/admin/profile' && /Linked to ann\.example@gmail\.com/.test(await text(m, '.gg-card')), m.url());
  await shot(m, '05-profile-linked-desktop');
  {
    const { page } = await newPage(DESKTOP, 'manager google');
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await page.click('.gg-btn');
    await pickGoogle(page, 'ann');
    await page.waitForURL(/\/admin\/?$/, { timeout: 10000 });
    await page.locator('.nav .links, .brand-name').first().waitFor({ timeout: 10000 });
    const me = await api(page, '/api/auth/me');
    check('Google sign-in from the field’s Sign in: the manager lands on the desk, signed in at first load', me.status === 200 && me.json.user.email === mgr, page.url());
  }

  // ── A volunteer, on a phone: link, then Google lands in the field app ──
  const { page: v } = await newPage(PHONE, 'volunteer');
  await passwordIn(v, BASE, '/login', vol);
  await v.waitForURL(`${BASE}/`, { timeout: 10000 });
  await v.goto(`${BASE}/profile`, { waitUntil: 'domcontentloaded' });
  await v.getByText('Link Google account').waitFor({ timeout: 8000 });
  check('Your profile (phone): no sideways scroll; Google’s buttons 48 px', (await noSideways(v)) <= 0 && (await tapTargets(v, '.gg-card .btn')).length === 0, JSON.stringify(await tapTargets(v, '.gg-card .btn')));
  await shot(v, '06-profile-not-linked-phone');
  await v.click('text=Link Google account');
  await pickGoogle(v, 'cy');
  await v.getByText('Linked — next time, Sign in with Google').waitFor({ timeout: 8000 });
  check('linked from the field app: back on /profile', new URL(v.url()).pathname === '/profile', v.url());
  await shot(v, '07-profile-linked-phone');
  {
    const { page } = await newPage(PHONE, 'volunteer google');
    await page.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
    await page.click('.gg-btn');
    await pickGoogle(page, 'cy');
    await page.waitForURL(`${BASE}/`, { timeout: 10000 });
    const me = await api(page, '/api/auth/me');
    check('Google sign-in from the desk’s Sign in: the volunteer lands in the field app', me.status === 200 && me.json.user.email === vol && new URL(page.url()).pathname === '/', page.url());
  }

  // ── Cancel; offline ──
  {
    const { ctx, page } = await newPage(PHONE, 'cancel');
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await page.click('.gg-btn');
    await pickGoogle(page, 'cancel');
    await page.locator('.error').waitFor({ timeout: 8000 });
    check('Cancel at Google: “Google sign-in was cancelled.”', (await text(page, '.error')) === 'Google sign-in was cancelled.');
    await shot(page, '08-login-cancelled-phone');
    await ctx.setOffline(true);
    await page.getByText('No signal — Google sign-in needs the internet.').waitFor({ timeout: 5000 });
    check('offline: the Google button is disabled, with the no-signal line', (await page.getAttribute('.gg-btn', 'aria-disabled')) === 'true' && !(await page.getAttribute('.gg-btn', 'href')));
    await shot(page, '09-login-offline-phone');
    await ctx.setOffline(false);
  }

  // ── Two-step: Google leads to the code ──
  const { page: s } = await newPage(DESKTOP, 'staffer');
  await passwordIn(s, BASE, '/admin/login', staff);
  await s.waitForURL(/\/admin\/?$/, { timeout: 10000 });
  const st = await api(s, '/api/actions/twostep.start', {});
  const key = st.json.setup.key;
  let lastStep = totpStep(Date.now());
  check('the staffer turns two-step on', (await api(s, '/api/actions/twostep.confirm', { code: hotp(base32Decode(key), lastStep) })).status === 200);
  await s.goto(`${BASE}/admin/profile`, { waitUntil: 'domcontentloaded' });
  await s.click('text=Link Google account');
  await pickGoogle(s, 'eve');
  await s.getByText('Linked — next time, Sign in with Google').waitFor({ timeout: 8000 });
  {
    const { page } = await newPage(DESKTOP, 'staffer google');
    await page.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
    await page.click('.gg-btn');
    await pickGoogle(page, 'eve');
    await page.getByRole('heading', { name: 'Enter your code' }).waitFor({ timeout: 8000 });
    check('two-step on: Google leads to “Enter your code”', /\/admin\/login\?step=code$/.test(page.url()), page.url());
    await shot(page, '10-code-step-from-google-desktop');
    while (totpStep(Date.now()) <= lastStep) await sleep(1000);
    lastStep = totpStep(Date.now());
    await page.fill('#login-code', hotp(base32Decode(key), lastStep));
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL(/\/admin\/?$/, { timeout: 10000 });
    check('…and the code signs in', (await api(page, '/api/auth/me')).json?.user?.email === staff);
  }

  // ── Settings → Services → Google ──
  await mctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  await m.goto(`${BASE}/admin/settings/services`, { waitUntil: 'domcontentloaded' });
  const row = m.locator('.sv2-row', { has: m.locator('.sv2-name', { hasText: 'Google (sign-in and connections)' }) });
  await row.locator('.gg-panel').waitFor({ timeout: 8000 });
  check('Services → Google: ready, the redirect address shown', /Set up/.test(await text(m, '.sv2-row:has(.gg-panel) .sv2-state'))
    && (await row.locator('.gg-url').innerText()) === `${BASE}/api/auth/google/back`);
  check('…its lines one a line: who signs in, connections ready', /3 people sign in with Google · 0 connected accounts/.test(await text(m, '.gg-lines')) && /Connections: ready/.test(await text(m, '.gg-lines')), await text(m, '.gg-lines'));
  await row.getByRole('button', { name: /Copy/ }).click();
  check('Copy: the redirect address on the clipboard', (await m.evaluate(() => navigator.clipboard.readText())) === `${BASE}/api/auth/google/back`);
  await row.scrollIntoViewIfNeeded();
  await shot(m, '11-services-google-ready-desktop');
  // The switch: off hides the button on Sign in; passwords still work.
  await row.getByRole('switch', { name: 'Team can sign in with Google' }).click();
  await m.waitForFunction(() => document.querySelector('.gg-switch')?.getAttribute('aria-checked') === 'false');
  {
    const { page } = await newPage(DESKTOP, 'google off');
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await page.locator('#login-email').waitFor();
    await sleep(500);
    check('Google sign-in off: no button on Sign in', (await page.locator('.gg-btn').count()) === 0);
    await passwordIn(page, BASE, '/login', vol);
    await page.waitForURL(`${BASE}/`, { timeout: 10000 });
    check('…and a linked volunteer still signs in with the password', true);
  }
  await row.getByRole('switch', { name: 'Team can sign in with Google' }).click();
  await m.waitForFunction(() => document.querySelector('.gg-switch')?.getAttribute('aria-checked') === 'true');
  // The domain: refused while the manager's own link isn't there…
  await row.getByRole('button', { name: /Change/ }).click();
  await m.fill('#gg-domain', 'campaign.example.org');
  await shot(m, '12-services-domain-editor-desktop');
  await row.getByRole('button', { name: 'Save' }).click();
  await row.locator('.error').waitFor({ timeout: 8000 });
  check('a domain refused until the manager’s own link is at it — said in place', /Link your own Google account at campaign\.example\.org first/.test(await text(m, '.gg-panel .error')), await text(m, '.gg-panel .error'));
  await row.getByRole('button', { name: 'Cancel' }).click();
  // …so they unlink Ann (confirm in place) and link Bo, at the domain.
  await m.goto(`${BASE}/admin/profile`, { waitUntil: 'domcontentloaded' });
  await m.locator('.gg-card').getByRole('button', { name: 'Unlink' }).click();
  check('Unlink asks in place', /Unlink Google\? You’ll sign in with your password\./.test(await text(m, '.gg-confirm')));
  await shot(m, '13-profile-unlink-confirm-desktop');
  await m.locator('.gg-confirm').getByRole('button', { name: 'Unlink' }).click();
  await m.getByText('Link Google account').waitFor({ timeout: 8000 });
  check('unlinked: the card offers Link again', true);
  await m.click('text=Link Google account');
  await pickGoogle(m, 'bo');
  await m.getByText('Linked to bo@campaign.example.org').waitFor({ timeout: 8000 });
  await m.goto(`${BASE}/admin/settings/services`, { waitUntil: 'domcontentloaded' });
  await row.locator('.gg-panel').waitFor({ timeout: 8000 });
  await row.getByRole('button', { name: /Change/ }).click();
  await m.fill('#gg-domain', 'campaign.example.org');
  await row.getByRole('button', { name: 'Save' }).click();
  await m.waitForFunction(() => /campaign\.example\.org/.test(document.querySelector('.gg-panel')?.innerText || '') && !document.querySelector('#gg-domain'));
  check('…then set, once their own link is there', /Only Google accounts at campaign\.example\.org/.test(await text(m, '.gg-panel')));
  {
    const { page } = await newPage(DESKTOP, 'domain');
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await page.click('.gg-btn');
    await pickGoogle(page, 'cy');
    await page.locator('.error').waitFor({ timeout: 8000 });
    check('the domain rule: a gmail account refused, in words', /Only Google accounts at campaign\.example\.org can sign in here\. Use your password instead\./.test(await text(page, '.error')), `${page.url()} ${await text(page, '.error')}`);
    await shot(page, '14-login-domain-desktop');
  }
  await v.goto(`${BASE}/profile`, { waitUntil: 'domcontentloaded' });
  await v.locator('.gg-card .chip').waitFor({ timeout: 8000 });
  check('the volunteer’s card: “Not at campaign.example.org — sign in with your password”', /Not at campaign\.example\.org — sign in with your password/.test(await text(v, '.gg-card')));
  await shot(v, '15-profile-not-at-domain-phone');
  await row.getByRole('button', { name: /Change/ }).click();
  await row.getByRole('button', { name: 'Any Google account' }).click();
  await m.waitForFunction(() => /Any Google account/.test(document.querySelector('.gg-panel')?.innerText || '') && !document.querySelector('#gg-domain'));
  check('“Any Google account” clears the rule', true);

  // ── Join with the tick box ──
  const dee = `dee.${tag}@example.org`;
  {
    const inv = (await api(m, '/api/actions/member.invite', { email: dee, role: 'volunteer' })).json;
    const { page } = await newPage(PHONE, 'join');
    await page.goto(inv.joinUrl.replace(/^https?:\/\/[^/]+/, BASE), { waitUntil: 'domcontentloaded' });
    await page.getByText('Also sign in with Google next time').waitFor({ timeout: 8000 });
    check('Join: the tick box, off by default, one primary', !(await page.isChecked('.gg-tick input')) && (await primaries(page)) === 1 && (await noSideways(page)) <= 0);
    await page.fill('#join-name', 'Dee Example');
    await page.fill('#join-password', PASSWORD);
    await page.check('.gg-tick input');
    await shot(page, '16-join-tick-box-phone');
    await page.getByRole('button', { name: 'Join' }).click();
    await pickGoogle(page, 'dee');
    await page.getByText('Linked — next time, Sign in with Google').waitFor({ timeout: 8000 });
    check('joined, linked, on Your profile', new URL(page.url()).pathname === '/profile', page.url());
  }
  {
    const { page } = await newPage(PHONE, 'dee google');
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await page.click('.gg-btn');
    await pickGoogle(page, 'dee');
    await page.waitForURL(`${BASE}/`, { timeout: 10000 });
    check('the new volunteer signs in with Google', (await api(page, '/api/auth/me')).json?.user?.email === dee);
    const { page: p2 } = await newPage(PHONE, 'dee password');
    await passwordIn(p2, BASE, '/login', dee);
    await p2.waitForURL(`${BASE}/`, { timeout: 10000 });
    check('…and with the password they chose', true);
  }

  // ── Team: the chip and Unlink Google ──
  await m.goto(`${BASE}/admin/settings`, { waitUntil: 'domcontentloaded' });
  await m.locator('.tm-google').first().waitFor({ timeout: 8000 });
  const deeRow = m.locator('.ot-item', { hasText: 'Dee Example' });
  check('Team: “Google” beside the people who sign in with it', (await m.locator('.tm-google').count()) >= 4 && (await deeRow.locator('.tm-google').count()) === 1);
  await deeRow.getByRole('button', { name: 'Unlink Google' }).click();
  check('Unlink Google asks in place', /Unlink Google for Dee Example\? They’re signed out and sign in with their password\./.test(await text(m, '.ot-item:has-text("Dee Example")')));
  await shot(m, '17-team-chip-confirm-desktop');
  await deeRow.getByRole('button', { name: 'Unlink', exact: true }).click();
  await deeRow.getByText('Google unlinked — Dee Example is signed out.').waitFor({ timeout: 8000 });
  check('…unlinked, and the chip goes', (await deeRow.locator('.tm-google').count()) === 0);
  {
    const { page } = await newPage(PHONE, 'team phone');
    await page.context().addCookies(await mctx.cookies());
    await page.goto(`${BASE}/admin/settings`, { waitUntil: 'domcontentloaded' });
    await page.locator('.tm-google').first().waitFor({ timeout: 8000 });
    const past = await page.evaluate(() => [...document.querySelectorAll('.ot-item button, .ot-item select')]
      .filter((e) => e.getBoundingClientRect().right > window.innerWidth + 0.5).map((e) => e.textContent.trim()));
    check('Team on a phone: no sideways scroll, no button past the edge', (await noSideways(page)) <= 0 && past.length === 0, past.join(', '));
    await shot(page, '18-team-chip-phone');
  }

  // ── A connection: Connect, Connected as, Reconnect after Google revokes, Disconnect ──
  await m.goto(`${BASE}/api/auth/google/start?do=connect&for=test.purpose&app=desk&back=/admin/profile`);
  await pickGoogle(m, 'bo');
  await m.getByText('Connected as').waitFor({ timeout: 8000 });
  check('connected: “Connected as” and the purpose’s row with Disconnect', /Connected as bo@campaign\.example\.org/.test(await text(m, '.gg-card'))
    && (await m.locator('.gg-item', { hasText: 'Test connection' }).getByRole('button', { name: /Disconnect/ }).count()) === 1);
  await shot(m, '19-profile-connected-desktop');
  await fetch(`${G}/__revokeAll`, { method: 'POST', body: JSON.stringify({ sub: ACCTS.bo.sub }) });
  const poke = await (await fetch(`${POKE}/fetch?email=${encodeURIComponent(mgr)}`)).json();
  check('Google revoked it: the next call learns so', poke.trouble === 'reconnect', JSON.stringify(poke));
  await m.reload({ waitUntil: 'domcontentloaded' });
  await m.getByText('Needs reconnecting').waitFor({ timeout: 8000 });
  check('the card: “Needs reconnecting” with what Google said, and Reconnect', /Google stopped letting base\.win use this account/.test(await text(m, '.gg-card')));
  await shot(m, '20-profile-needs-reconnecting-desktop');
  await m.locator('.gg-card').getByText('Reconnect', { exact: true }).click();
  await pickGoogle(m, 'bo');
  await m.getByText('Connected', { exact: true }).waitFor({ timeout: 8000 });
  check('reconnected', (await m.locator('.gg-card .chip-warn', { hasText: 'Needs reconnecting' }).count()) === 0);
  const revokesBefore = fake.counts.revoke;
  await m.locator('.gg-item', { hasText: 'Test connection' }).getByRole('button', { name: /Disconnect/ }).click();
  check('Disconnect asks in place', /Stop using Google for Test connection\?/.test(await text(m, '.gg-confirm')));
  await m.locator('.gg-confirm').getByRole('button', { name: 'Disconnect' }).click();
  await m.getByText('Disconnected. Google no longer lets base.win in.').waitFor({ timeout: 8000 });
  for (let i = 0; i < 30 && fake.counts.revoke === revokesBefore; i += 1) await sleep(500);
  check('…disconnected, and Google is told', fake.counts.revoke > revokesBefore && (await m.locator('.gg-item').count()) === 0);

  // ── The wrong address; the installed app ──
  {
    const LOCAL = 'http://localhost:5300';
    const { page } = await newPage(DESKTOP, 'wrong address');
    await page.route('**/*', (r) => r.continue()); // localhost is this machine too
    await passwordIn(page, LOCAL, '/login', dee); // unlinked by the manager above
    await page.waitForURL(`${LOCAL}/`, { timeout: 10000 });
    await page.goto(`${LOCAL}/profile`, { waitUntil: 'domcontentloaded' });
    await page.locator('.gg-card').waitFor({ timeout: 8000 });
    await page.getByText(`Open base.win at ${BASE} to use Google here.`).waitFor({ timeout: 8000 }).catch(() => {});
    check('opened at another address: one line instead of Link', /Open base\.win at http:\/\/127\.0\.0\.1:5300 to use Google here\./.test(await text(page, '.gg-card'))
      && (await page.getByText('Link Google account').count()) === 0, await text(page, '.gg-card'));
    await shot(page, '21-profile-wrong-address-desktop');
  }
  {
    const { page } = await newPage(PHONE, 'installed profile', { standalone: true });
    await passwordIn(page, BASE, '/login', dee); // not linked: Link would show
    await page.waitForURL(`${BASE}/`, { timeout: 10000 });
    await page.goto(`${BASE}/profile`, { waitUntil: 'domcontentloaded' });
    await page.getByText('Open base.win in your browser to use Google.').waitFor({ timeout: 8000 });
    check('Your profile in the installed app: the line, no Link', (await page.getByText('Link Google account').count()) === 0);
    await shot(page, '22-profile-installed-phone');
  }

  // ── Services: missing, default ──
  {
    const { page } = await newPage(DESKTOP, 'no google');
    await page.goto(`${NOG}/signup`, { waitUntil: 'domcontentloaded' });
    await page.fill('#su-name', 'Nia Example');
    if (await page.locator('#su-org').count()) await page.fill('#su-org', 'Example Campaign');
    await page.fill('#su-email', `nia.${tag}@example.org`);
    await page.fill('#su-password', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/admin\/?$/, { timeout: 15000 });
    await page.goto(`${NOG}/admin/settings/services`, { waitUntil: 'domcontentloaded' });
    const r = page.locator('.sv2-row', { has: page.locator('.sv2-name', { hasText: 'Google (sign-in and connections)' }) });
    await r.waitFor({ timeout: 8000 });
    check('without Google: the row says Not set up and names the two settings', /Not set up/.test(await r.innerText()) && /GOOGLE_OAUTH_CLIENT_ID/.test(await r.innerText()));
    await r.scrollIntoViewIfNeeded();
    await shot(page, '23-services-google-missing-desktop', false);
    await page.goto(`${NOG}/admin/profile`, { waitUntil: 'domcontentloaded' });
    await page.locator('.me-page h1').waitFor();
    await sleep(800);
    check('…and no Google card on Your profile', (await page.locator('.gg-card').count()) === 0);
    await page.goto(`${NOG}/login`, { waitUntil: 'domcontentloaded' });
    await sleep(500);
    check('…and no Google button on Sign in', (await page.locator('.gg-btn').count()) === 0);
  }

  // ── Under BASE_PATH (no token key: connections not set up) ──
  {
    const { ctx, page } = await newPage(DESKTOP, 'basepath');
    await page.goto(`${BP}${P}/field/signup`, { waitUntil: 'domcontentloaded' });
    await page.fill('#su-name', 'Marco Example');
    if (await page.locator('#su-org').count()) await page.fill('#su-org', 'Example Campaign');
    const marco = `marco.${tag}@example.org`;
    await page.fill('#su-email', marco);
    await page.fill('#su-password', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL(new RegExp(`${P}/desk/?$`), { timeout: 15000 });
    await page.goto(`${BP}${P}/desk/settings/services`, { waitUntil: 'domcontentloaded' });
    const r = page.locator('.sv2-row', { has: page.locator('.sv2-name', { hasText: 'Google (sign-in and connections)' }) });
    await r.locator('.gg-panel').waitFor({ timeout: 8000 });
    check('Services under BASE_PATH without a token key: “Using the free default”, connections need the key', /Using the free default/.test(await r.innerText()) && /Connections need GOOGLE_TOKEN_KEY/.test(await r.innerText()));
    await r.scrollIntoViewIfNeeded();
    await shot(page, '24-services-google-default-desktop', false);
    await page.goto(`${BP}${P}/desk/profile`, { waitUntil: 'domcontentloaded' });
    await page.click('text=Link Google account');
    await pickGoogle(page, 'zed');
    await page.getByText('Linked — next time, Sign in with Google').waitFor({ timeout: 8000 });
    check('under BASE_PATH: linking returns to /imaginesurrey/desk/profile', new URL(page.url()).pathname === `${P}/desk/profile`, page.url());
    const { ctx: c2, page: p2 } = await newPage(DESKTOP, 'basepath google');
    await p2.goto(`${BP}${P}/desk/login`, { waitUntil: 'domcontentloaded' });
    await p2.click('.gg-btn');
    await p2.waitForURL((u) => u.port === '5301', { timeout: 10000 });
    const flow = (await c2.cookies(`${BP}${P}/`)).find((c) => c.name === 'mv2_google');
    await p2.click(`a.acct[data-sub="${ACCTS.zed.sub}"]`);
    await p2.waitForURL(new RegExp(`${P}/desk/?$`), { timeout: 10000 });
    const session = (await c2.cookies(`${BP}${P}/`)).find((c) => c.name === 'mv2_session');
    check('under BASE_PATH: the return lands at /imaginesurrey/desk/', new URL(p2.url()).pathname.replace(/\/$/, '') === `${P}/desk`, p2.url());
    check('…the cookies’ paths are /imaginesurrey', flow?.path === P && session?.path === P && session.sameSite === 'Strict', JSON.stringify([flow?.path, session?.path, session?.sameSite]));
    await ctx.close();
  }

  // Every other address is stopped in the browser before anything is sent
  // (the field app's map tiles, say): none of it may be Google's.
  const google = offHost.filter((u) => /google|gstatic|googleapis/i.test(new URL(u).hostname));
  check(`nothing reached Google; ${offHost.length} other off-machine requests stopped before they left`, google.length === 0, google.slice(0, 5).join(' '));
  check('no page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
  for (const c of contexts) await c.close().catch(() => {});
} catch (e) {
  check('the suite ran to the end', false, e.stack || e.message);
} finally {
  await browser?.close().catch(() => {});
  await stopAll();
}

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
