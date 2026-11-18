// base.win support's way in from the control centre — browser check. Two
// fresh in-memory servers, as on Render, each at its own origin and holding
// the control centre's test key (server/test/entry-vector.json):
//   A  PORT     at its root, production;
//   B  PORT+2   a client's path (BASE_PATH=/x), production — its own
//               address works at the root; its /x path is what the base.win
//               door hands on, and entry is refused there.
// Tokens are signed here as the control centre signs them
// (server/test/entry-sign.js). The walk:
//   1. A fresh server with the key: sign-up says it is set up from the
//      control centre; a first manager is made with sign-up opened for
//      that one request (as STARBASE_OPEN_SIGNUP=1 would).
//   2. /admin/enter#t=… → Today with the banner; the address drops #t.
//   3. Settings → Members: the chip, and the switch disabled with its line.
//   4. Sign out from the banner → Sign in.
//   5. The manager turns the switch off: support's open visit is signed out
//      on its next request; a new token's Enter page says "turned off".
//   6. On again; an invite token lands on Members with the invite shown.
//   7. Today: "base.win support signed in"; History: "(via base.win)".
//   8. B at its root works; the same kind of token under /x is refused.
//   9. A token for A is refused by B (another address).
//  10. The operator's email a volunteer here: the volunteer line.
// Screens at 1440×900 and 390×844: no sideways scroll at 390 px, and the
// banner's, Enter's and the switch's controls 48 px or more.
//
//   npm run build  then  PORT=5630 SHOTS=/tmp/entry node e2e-entry.mjs
//   (A on PORT, its test controls on PORT+1, B on PORT+2)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { signEntry } from './server/test/entry-sign.js';

const V = JSON.parse(readFileSync(new URL('./server/test/entry-vector.json', import.meta.url), 'utf8'));
const PORT = Number(process.env.PORT) || 5630;
const CONTROL = PORT + 1;
const A = `http://127.0.0.1:${PORT}`;
const B = `http://127.0.0.1:${PORT + 2}`;
const SHOTS = process.env.SHOTS || '/tmp/starbase-entry';
mkdirSync(SHOTS, { recursive: true });
const PASSWORD = 'first-password-2026';
const OP = { id: '7b1f3c2e-0000-4000-8000-000000000001', email: 'owner@example.org' };
const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 260) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A's test controls (its settings, changed while it runs), loaded into it.
const STUB = `${SHOTS}/entry-stub.mjs`;
writeFileSync(STUB, `
import { createServer } from 'node:http';
createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const j = body ? JSON.parse(body) : {};
  for (const [k, v] of Object.entries(j.env || {})) { if (v === null) delete process.env[k]; else process.env[k] = v; }
  res.end('ok');
}).listen(${CONTROL}, '127.0.0.1');
`);
const base = { ...process.env, STARBASE_DATA: 'memory', STARBASE_JOBS: 'off', STARBASE_ENV: 'production', BASE_PLATFORM_PUBKEY: V.publicKey };
for (const k of ['STARBASE_OPEN_SIGNUP', 'STARBASE_DEMO_EMAIL', 'RENDER_EXTERNAL_URL', 'STARBASE_PUBLIC_URL', 'BASE_PATH', 'MAIL_PROVIDER', 'RESEND_API_KEY', 'SENDGRID_API_KEY']) delete base[k];
const logs = { A: '', B: '' };
const start = (name, args, env) => {
  const s = spawn(process.execPath, [...args, 'server/index.js'], { cwd: fileURLToPath(new URL('.', import.meta.url)), env, stdio: ['ignore', 'pipe', 'pipe'] });
  s.stdout.on('data', (d) => { logs[name] += d; });
  s.stderr.on('data', (d) => { logs[name] += d; });
  process.on('exit', () => { try { s.kill('SIGTERM'); } catch { /* gone */ } });
  return s;
};
const servers = [
  start('A', ['--import', pathToFileURL(STUB).href], { ...base, PORT: String(PORT), STARBASE_OWN_URL: A }),
  start('B', [], { ...base, PORT: String(PORT + 2), STARBASE_OWN_URL: B, BASE_PATH: '/x' }),
];
const health = async (o) => fetch(`${o}/api/health`).then((r) => r.json()).catch(() => null);
for (const o of [A, B]) {
  for (let i = 0; i < 80; i += 1) { if ((await health(o))?.ok) break; await sleep(250); }
}
const control = (env) => fetch(`http://127.0.0.1:${CONTROL}/`, { method: 'POST', body: JSON.stringify({ env }) }).then((r) => r.text());

// A token as the control centre signs it, for one server.
const mint = async (origin, { op = OP, go = '/desk', invite = null } = {}) => {
  const h = await health(origin);
  const now = Math.floor(Date.now() / 1000);
  return signEntry(V.signingKey, {
    v: 1, kid: V.kid, aud: origin, env: h.env, inst: h.instance, iat: now, exp: now + 60,
    nonce: randomBytes(16).toString('base64url'), op: { ...op, stepUpAt: now - 30 }, go, invite,
  });
};

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const errors = [];
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const newPage = async (viewport, label) => {
  const ctx = await browser.newContext({
    viewport, deviceScaleFactor: 1, timezoneId: 'America/Vancouver',
    ...(viewport === PHONE ? { isMobile: true, hasTouch: true } : {}),
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`[${label}] ${e.message}`));
  return { ctx, page };
};
const api = (page, origin, path, body) => page.evaluate(async ([u, b]) => {
  const r = await fetch(u, { method: b ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
}, [`${origin}/api${path}`, body]);
const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
// Phones: nothing wider than the screen; this feature's controls 48 px tall or more.
const phoneOk = async (page, name) => {
  const r = await page.evaluate(() => {
    const wide = document.documentElement.scrollWidth > window.innerWidth + 1;
    const small = [...document.querySelectorAll('.op-banner button, .op-quiet, .op-sec .ot-check')]
      .filter((el) => el.offsetParent)
      .map((el) => [el.textContent.trim(), Math.round(el.getBoundingClientRect().height)])
      .filter(([, h]) => h < 48);
    return { wide, small };
  });
  check(`${name}: no sideways scroll at 390 px, controls ≥ 48 px`, !r.wide && !r.small.length, JSON.stringify(r));
};
const BANNER = /You’re in as base\.win support · until \d{1,2}:\d{2} [ap]m/;
// A fresh load each time: from /admin/enter, a new #t alone would only move the fragment.
const enter = async (page, origin, token, path = '/admin/enter') => {
  await page.goto('about:blank');
  await page.goto(`${origin}${path}#t=${token}`);
};

try {
  // ── 1. A fresh server with the key: sign-up is closed ──
  const { ctx: mgrCtx, page: mgr } = await newPage(DESKTOP, 'manager');
  await mgr.goto(`${A}/admin/signup`);
  await mgr.getByText('This campaign is set up from the base.win control centre.').waitFor();
  check('a fresh server with the key: sign-up says it is set up from the control centre', true);
  await shot(mgr, 'signup-closed-desktop');
  await control({ STARBASE_OPEN_SIGNUP: '1' });
  const su = await api(mgr, A, '/auth/signup', { name: 'Morgan Example', email: 'morgan@example.org', password: PASSWORD, workspaceName: 'Sample Campaign', jurisdiction: 'bc-municipal' });
  await control({ STARBASE_OPEN_SIGNUP: null });
  check('the first manager signs up while it is opened', su.status === 201, JSON.stringify(su.json));
  check('closed again after', (await health(A)).setupOpen === false);
  // A volunteer whose email is another operator's (step 10), and someone to knock on (step 7).
  const OP2 = { id: '7b1f3c2e-0000-4000-8000-000000000002', email: 'vol-owner@example.org' };
  const inv = await api(mgr, A, '/actions/member.invite', { email: OP2.email, role: 'volunteer' });
  const joined = await api(mgr, A, '/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: 'Val Example', password: PASSWORD });
  check('a volunteer joins', joined.status === 200, JSON.stringify(joined.json));
  await api(mgr, A, '/auth/login', { email: 'morgan@example.org', password: PASSWORD });
  const pat = await api(mgr, A, '/actions/person.create', { name: 'Pat Example' });

  // ── 2. Enter → Today with the banner ──
  const { ctx: supCtx, page: sup } = await newPage(DESKTOP, 'support');
  await enter(sup, A, await mint(A));
  await sup.getByText(BANNER).waitFor();
  check('Enter lands on the desk’s Today', new URL(sup.url()).pathname === '/admin/', sup.url());
  check('the address has no #t after', !sup.url().includes('#t'), sup.url());
  const me = await api(sup, A, '/auth/me');
  check('signed in as base.win support, a manager, for two hours', me.json?.user?.name === 'base.win support' && me.json?.role === 'manager' && Boolean(me.json?.operator?.until), JSON.stringify(me.json?.operator));
  check('the banner is a status line with Sign out', (await sup.locator('.op-banner[role="status"]').count()) === 1 && await sup.locator('.op-banner').getByRole('button', { name: 'Sign out' }).isVisible());

  // ── 3. Settings → Members: the chip, the switch disabled ──
  await sup.goto(`${A}/admin/settings`);
  await sup.locator('.op-chip').first().waitFor();
  check('Members: the base.win support chip', await sup.locator('.ot-item', { hasText: 'base.win support' }).locator('.op-chip').isVisible());
  check('Members: the row says removing doesn’t stop it', await sup.getByText('Removing doesn’t stop base.win: turn off ‘base.win may sign in here’ below.').isVisible());
  const sw = sup.getByLabel('base.win may sign in here');
  await sw.waitFor();
  check('as support, the switch is disabled with its line', await sw.isDisabled() && await sup.getByText('Only the campaign’s own managers change this.').isVisible());
  check('support gets no Password link', (await sup.getByRole('button', { name: 'Password link' }).count()) === 0);
  await shot(sup, 'members-as-support-desktop');

  // ── 4. Sign out from the banner ──
  await sup.locator('.op-banner').getByRole('button', { name: 'Sign out' }).click();
  await sup.waitForURL((u) => u.pathname === '/admin/login', { timeout: 8000 });
  check('Sign out from the banner → Sign in', true);

  // ── 5. The manager turns the switch off: the open visit ends ──
  await enter(sup, A, await mint(A));
  await sup.getByText(BANNER).waitFor();
  await mgr.goto(`${A}/admin/settings`);
  const mgrSw = mgr.getByLabel('base.win may sign in here');
  await mgrSw.waitFor();
  check('as the manager, the switch is on and can be changed', await mgrSw.isChecked() && !(await mgrSw.isDisabled()));
  check('its helper lines', await mgr.getByText('Each visit shows in History and on Today. Turning it off ends a visit in progress.').isVisible()
    && await mgr.getByText('People base.win invited stay on the team.').isVisible());
  await mgrSw.uncheck();
  await mgr.locator('.op-sec').getByText('Saved').waitFor();
  check('off: "Saved"', !(await mgrSw.isChecked()));
  await shot(mgr, 'members-switch-off-desktop');
  await sup.reload();
  await sup.waitForURL((u) => u.pathname === '/admin/login', { timeout: 8000 });
  check('support’s open visit is signed out on its next request', true);
  await enter(sup, A, await mint(A));
  await sup.getByText('This campaign has turned off base.win sign-in. A manager can turn it on in Settings → Members.').waitFor();
  check('a new token: "turned off", with another way to sign in', await sup.getByRole('link', { name: 'Sign in another way' }).isVisible());
  check('the Enter page drops #t too', !sup.url().includes('#t'), sup.url());
  await shot(sup, 'enter-off-desktop');

  // ── 6. On again; an invite lands on Members ──
  await mgrSw.check();
  await mgr.locator('.op-sec').getByText('Saved').waitFor();
  await enter(sup, A, await mint(A, { go: '/desk/settings/members', invite: { email: 'sam@example.org' } }));
  await sup.waitForURL((u) => u.pathname === '/admin/settings/members', { timeout: 10000 });
  await sup.getByTestId('join-url').waitFor();
  check('an invite token lands on Members with the invite', await sup.getByText('Send sam@example.org this link').isVisible()
    && (await sup.getByTestId('join-url').textContent()).includes('/join/'));
  check('the invite is listed, as a manager', (await api(mgr, A, '/team')).json.invites.some((i) => i.email === 'sam@example.org' && i.role === 'manager'));
  await shot(sup, 'members-invite-desktop');

  // ── 7. Today and History ──
  const knock = await api(sup, A, '/actions/contact.log', { person_id: pat.json.person.id, channel: 'door', outcome: 'contacted', rating: '1' });
  check('support knocks on a door', knock.status === 200, JSON.stringify(knock.json));
  await mgr.goto(`${A}/admin/`);
  await mgr.getByText(/base\.win support signed in · \w{3} \d{1,2}:\d{2} [ap]m/).first().waitFor();
  check('Today (a manager): "base.win support signed in"', true);
  await shot(mgr, 'today-visits-desktop');
  await mgr.goto(`${A}/admin/people/${pat.json.person.id}`);
  const hist = mgr.locator('#pf-history .pf-sec__btn');
  await mgr.locator('#pf-history .pf-sec__count').waitFor();
  if ((await hist.getAttribute('aria-expanded')) !== 'true') await hist.click();
  await mgr.getByText(/\(via base\.win\)/).first().waitFor();
  check('History: "(via base.win)"', true);
  await shot(mgr, 'history-via-desktop');

  // ── 8. B: its root works; its client path doesn't ──
  const { ctx: bCtx, page: bp } = await newPage(DESKTOP, 'B');
  await enter(bp, B, await mint(B));
  await bp.getByText(BANNER).waitFor();
  check('B at its own root: in, and its first entry made the campaign', new URL(bp.url()).pathname === '/admin/', bp.url());
  await bCtx.close();
  const { ctx: b2Ctx, page: b2 } = await newPage(DESKTOP, 'B-path');
  await enter(b2, B, await mint(B), '/x/admin/enter');
  await b2.getByText('That link has run out. Open the desk again from the control centre.').waitFor();
  check('under B’s client path (the door’s): refused', (await api(b2, B, '/auth/me')).status === 401);
  await shot(b2, 'enter-refused-desktop');
  // ── 9. A's token at B ──
  await enter(b2, B, await mint(A));
  await b2.getByText('That link has run out. Open the desk again from the control centre.').waitFor();
  check('a token for A is refused by B', (await api(b2, B, '/auth/me')).status === 401);
  await b2Ctx.close();

  // ── 10. The operator a volunteer here ──
  const { ctx: vCtx, page: vp } = await newPage(DESKTOP, 'volunteer');
  await enter(vp, A, await mint(A, { op: OP2 }));
  await vp.getByText('You’re in as a volunteer here. A manager can change your role in Settings → Members.').waitFor();
  check('a volunteer here: the volunteer line, the role unchanged', (await api(vp, A, '/auth/me')).json?.role === 'volunteer');
  await shot(vp, 'enter-volunteer-desktop');
  await vCtx.close();

  // ── Phones ──
  {
    const { ctx, page } = await newPage(PHONE, 'support-phone');
    await enter(page, A, await mint(A));
    await page.getByText(BANNER).waitFor();
    await page.waitForLoadState('networkidle');
    await shot(page, 'today-banner-phone');
    await phoneOk(page, 'Today with the banner');
    await page.goto(`${A}/admin/settings`);
    await page.getByLabel('base.win may sign in here').waitFor();
    await page.locator('.op-sec').scrollIntoViewIfNeeded();
    await shot(page, 'members-as-support-phone');
    await phoneOk(page, 'Members as support');
    await enter(page, A, 'bw-entry.v1.junk.junk');
    await page.getByText('That link has run out. Open the desk again from the control centre.').waitFor();
    await shot(page, 'enter-error-phone');
    await phoneOk(page, 'Enter, an error');
    await page.goto(`${A}/admin/enter`);
    await page.getByText('Nothing to open here.').waitFor();
    check('no token: "Nothing to open here."', true);
    await ctx.close();
  }
  {
    const { ctx, page } = await newPage(PHONE, 'manager-phone');
    await page.goto(`${A}/admin/login`);
    await api(page, A, '/auth/login', { email: 'morgan@example.org', password: PASSWORD });
    await page.goto(`${A}/admin/`);
    await page.getByText(/base\.win support signed in/).first().waitFor();
    await shot(page, 'today-visits-phone');
    await phoneOk(page, 'Today’s line');
    await page.goto(`${A}/admin/settings`);
    await page.getByLabel('base.win may sign in here').waitFor();
    await page.locator('.op-sec').scrollIntoViewIfNeeded();
    await shot(page, 'members-manager-phone');
    await phoneOk(page, 'Members, the switch');
    await ctx.close();
  }
  {
    const { ctx, page } = await newPage(PHONE, 'volunteer-phone');
    await enter(page, A, await mint(A, { op: OP2 }));
    await page.getByText('You’re in as a volunteer here.', { exact: false }).waitFor();
    await shot(page, 'enter-volunteer-phone');
    await phoneOk(page, 'Enter, a volunteer');
    await ctx.close();
  }
  await supCtx.close();
  await mgrCtx.close();
} catch (e) {
  check('the walk finished', false, e.stack || e.message);
} finally {
  await browser.close();
  for (const s of servers) s.kill('SIGTERM');
}

check('no page errors', !errors.length, errors.join(' | '));
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed) console.log(`A:\n${logs.A.slice(-2000)}\nB:\n${logs.B.slice(-2000)}`);
process.exit(failed ? 1 : 0);
