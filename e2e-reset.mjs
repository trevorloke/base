// Forgot password — browser check. A fresh in-memory server under a
// client's path (BASE_PATH=/a, BASE_PUBLIC_URL=…/a) with a stand-in for
// Resend (server/test/fake-mail.js) loaded into it; a volunteer on a laptop
// and on a 390×844 phone:
//   · Sign in → Forgot your password? → their email → "a link is on its
//     way"; the emailed link opens Choose a new password ("For …"), the
//     address drops #t= at once, Save password signs them in ("Password
//     changed…"), and the old password no longer works;
//   · with two-step sign-in on, the link asks for the code after the new
//     password, then signs in;
//   · with no sender, Forgot says to ask a manager, with no form;
//   · Settings → Members: a manager's Password link for a volunteer — with
//     no sender the link with Copy; with one, "Emailed", and no link shown;
//     with no BASE_PUBLIC_URL, no Password link at all.
// Phones: no sideways scroll, every control 48 px or more. Screenshots of
// each screen, desktop and phone.
//
//   npm run build  then  PORT=5620 SHOTS=/tmp/reset node e2e-reset.mjs
//   (the stand-in sender listens on PORT+1, the test's controls on PORT+4)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { base32Decode, hotp, totpStep } from './server/lib/twostep.js';
import { bothNames } from './shared/old-names.js';

const PORT = Number(process.env.PORT) || 5620;
const FAKE = PORT + 1;
const CONTROL = PORT + 4;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const P = '/a';
const FIELD = `${ORIGIN}${P}/field`;
const DESK = `${ORIGIN}${P}/desk`;
const SHOTS = process.env.SHOTS || '/tmp/base-win-reset';
mkdirSync(SHOTS, { recursive: true });
const PASSWORD = 'first-password-2026';
const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 260) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── The stand-in sender and the test's controls, loaded into the server ──
const serverDir = fileURLToPath(new URL('./server/', import.meta.url));
const href = (p) => JSON.stringify(pathToFileURL(`${serverDir}${p}`).href);
const STUB = `${SHOTS}/reset-stub.mjs`;
writeFileSync(STUB, `
import { createServer } from 'node:http';
// The fixtures here are Imagine Surrey's, so the server runs as its production
// does (render.yaml sets this brand); a brand set by hand is left as set.
if (${JSON.stringify(bothNames('BASE_BRAND'))}.every((k) => process.env[k] === undefined)) process.env.BASE_BRAND = 'imagine-surrey';

const { startFakeMail } = await import(${href('test/fake-mail.js')});
const fake = await startFakeMail({ provider: 'resend', port: ${FAKE} });
createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const j = body ? JSON.parse(body) : {};
  if (req.url === '/set') {
    for (const [k, v] of Object.entries(j.env || {})) { if (v === null) delete process.env[k]; else process.env[k] = v; }
    return res.end('ok');
  }
  if (req.url === '/sent') return res.end(JSON.stringify(fake.sent.map((x) => ({ to: x.to, subject: x.subject, text: x.body?.text || '' }))));
  res.end('ok');
}).listen(${CONTROL}, '127.0.0.1');
`);
const env = { ...process.env, BASE_OPEN_SIGNUP: '1', BASE_DATA: 'memory', PORT: String(PORT), BASE_JOBS: 'off', BASE_PATH: P, BASE_PUBLIC_URL: `${ORIGIN}${P}` };
for (const k of ['MAIL_PROVIDER', 'RESEND_API_KEY', 'RESEND_API_BASE', 'RESEND_WEBHOOK_SECRET', 'SENDGRID_API_KEY', 'MAIL_FROM', 'BASE_DEMO_EMAIL'].flatMap(bothNames)) delete env[k];
const server = spawn(process.execPath, ['--import', pathToFileURL(STUB).href, 'server/index.js'], {
  cwd: fileURLToPath(new URL('.', import.meta.url)), env, stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
process.on('exit', () => { try { server.kill('SIGTERM'); } catch { /* gone */ } });
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
for (let i = 0; i < 80; i += 1) {
  if (await fetch(`${ORIGIN}/api/health`).then((r) => r.ok).catch(() => false)) break;
  await sleep(250);
}
const control = (path, body) => fetch(`http://127.0.0.1:${CONTROL}${path}`, { method: 'POST', body: JSON.stringify(body || {}) }).then((r) => r.text());
const sender = (on) => control('/set', { env: on
  ? { RESEND_API_KEY: 're_e2e_reset', RESEND_API_BASE: `http://127.0.0.1:${FAKE}`, MAIL_FROM: 'Sample Campaign <team@example.org>' }
  : { RESEND_API_KEY: null } });
const outbox = async () => JSON.parse(await control('/sent'));
// The newest email to an address, waited for (it goes after the answer).
const linkFor = async (to, count) => {
  for (let i = 0; i < 40; i += 1) {
    const mine = (await outbox()).filter((m) => m.to === to);
    if (mine.length >= count) return mine.at(-1).text.match(/(http\S+#t=[0-9a-f]{64})/)?.[1] || null;
    await sleep(150);
  }
  return null;
};

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const errors = [];
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const newPage = async (viewport, label) => {
  const ctx = await browser.newContext({
    viewport, deviceScaleFactor: 1, timezoneId: 'America/Vancouver', permissions: ['clipboard-read', 'clipboard-write'],
    ...(viewport === PHONE ? { isMobile: true, hasTouch: true } : {}),
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`[${label}] ${e.message}`));
  return { ctx, page };
};
const api = (page, path, body) => page.evaluate(async ([u, b]) => {
  const r = await fetch(u, { method: b ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
}, [`${ORIGIN}${P}/api${path}`, body]);
const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
// Phones: nothing wider than the screen; every button, field and link 48 px tall or more.
const phoneOk = async (page, name) => {
  const r = await page.evaluate(() => {
    const wide = document.documentElement.scrollWidth > window.innerWidth + 1;
    const small = [...document.querySelectorAll('button, input, select, a')]
      .filter((el) => el.offsetParent && !el.closest('.auth-foot'))
      .map((el) => [el.textContent.trim() || el.id || el.getAttribute('aria-label'), Math.round(el.getBoundingClientRect().height)])
      .filter(([, h]) => h < 48);
    return { wide, small };
  });
  check(`${name}: no sideways scroll at 390 px, controls ≥ 48 px`, !r.wide && !r.small.length, JSON.stringify(r));
};

try {
  // ── A campaign: the manager, and a volunteer joined by invite ──
  const { ctx: mgrCtx, page: mgr } = await newPage(DESKTOP, 'manager');
  await mgr.goto(`${FIELD}/login`);
  const su = await api(mgr, '/auth/signup', { name: 'Rae Example', email: 'rae@example.org', password: PASSWORD, workspaceName: 'Sample Campaign', jurisdiction: 'bc-municipal' });
  check('the manager signs up', su.status === 201, JSON.stringify(su.json));
  const inv = await api(mgr, '/actions/member.invite', { email: 'sam@example.org', role: 'volunteer' });
  const joined = await api(mgr, '/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: 'Sam Example', password: PASSWORD });
  check('a volunteer joins', joined.status === 200, JSON.stringify(joined.json));
  // join signed this browser in as Sam: back to the manager.
  await api(mgr, '/auth/login', { email: 'rae@example.org', password: PASSWORD });
  await sender(true);

  // ── 1. Sign in → Forgot your password? → "a link is on its way" ──
  for (const [viewport, label] of [[DESKTOP, 'desktop'], [PHONE, 'phone']]) {
    const { ctx, page } = await newPage(viewport, `sam-${label}`);
    await page.goto(`${FIELD}/login`);
    await page.getByRole('link', { name: 'Forgot your password?' }).waitFor();
    await shot(page, `login-${label}`);
    await page.getByRole('link', { name: 'Forgot your password?' }).click();
    await page.getByRole('heading', { name: 'Forgot your password?' }).waitFor();
    check(`${label}: Forgot opens under the client's path`, page.url() === `${FIELD}/forgot`, page.url());
    await page.fill('#forgot-email', label === 'desktop' ? 'Sam@Example.org' : 'nobody@example.org');
    await shot(page, `forgot-${label}`);
    if (label === 'phone') await phoneOk(page, 'Forgot');
    await page.getByRole('button', { name: 'Email me a link' }).click();
    await page.getByText('If that address has an account here, a link is on its way. It works for 30 minutes.').waitFor();
    check(`${label}: the same words whatever the address`, true);
    check(`${label}: one quiet way back`, await page.getByRole('link', { name: 'Back to sign in' }).isVisible());
    await shot(page, `forgot-sent-${label}`);
    if (label === 'phone') await phoneOk(page, 'Forgot, sent');
    await ctx.close();
  }

  // ── 2. The emailed link → Choose a new password → signed in ──
  const link1 = await linkFor('sam@example.org', 1);
  check('one email to Sam, its link to the field app’s Reset under the client’s path', link1?.startsWith(`${FIELD}/reset#t=`), link1);
  check('nothing emailed to an address with no account', !(await outbox()).some((m) => m.to === 'nobody@example.org'));
  {
    const { ctx, page } = await newPage(PHONE, 'sam-reset');
    await page.goto(link1);
    await page.getByRole('heading', { name: 'Choose a new password' }).waitFor();
    await page.getByText('sam@example.org').waitFor();
    check('the address drops the token at once', !page.url().includes('#t') && page.url() === `${FIELD}/reset`, page.url());
    check('helper line under the field', await page.getByText('8 or more characters.').isVisible());
    await shot(page, 'reset-phone');
    await phoneOk(page, 'Choose a new password');
    await page.fill('#reset-password', 'second-password-2026');
    await page.getByRole('button', { name: 'Save password' }).click();
    await page.getByText('Password changed. You’re signed out everywhere else.').waitFor();
    await shot(page, 'reset-done-phone');
    await page.waitForURL((u) => !u.pathname.endsWith('/reset'), { timeout: 8000 });
    const me = await api(page, '/auth/me');
    check('signed in as Sam, in the field app', me.status === 200 && me.json.user.email === 'sam@example.org' && page.url().startsWith(FIELD), `${me.status} ${page.url()}`);
    check('no #t in the address after', !page.url().includes('#t'));
    // The same link again: run out.
    await page.goto(link1);
    await page.getByText('That link has run out or was already used.').waitFor();
    check('a used link says so, with a way to ask again', await page.getByRole('link', { name: 'Ask for a new one' }).isVisible());
    await shot(page, 'reset-used-phone');
    await ctx.close();
  }

  // ── 3. The old password fails ──
  {
    const { ctx, page } = await newPage(DESKTOP, 'old');
    await page.goto(`${FIELD}/login`);
    const old = await api(page, '/auth/login', { email: 'sam@example.org', password: PASSWORD });
    const fresh = await api(page, '/auth/login', { email: 'sam@example.org', password: 'second-password-2026' });
    check('the old password fails, the new one works', old.status === 401 && fresh.status === 200, `${old.status} ${fresh.status}`);
    // ── 4. With two-step on: the code step ──
    const start = await api(page, '/actions/twostep.start', {});
    const key = start.json.setup.key;
    const step0 = totpStep(Date.now());
    const on = await api(page, '/actions/twostep.confirm', { code: hotp(base32Decode(key), step0) });
    check('Sam turns two-step sign-in on', on.status === 200, JSON.stringify(on.json));
    const asked = await api(page, '/auth/forgot', { email: 'sam@example.org' });
    check('Sam asks again', asked.status === 200);
    await ctx.close();
    const link2 = await linkFor('sam@example.org', 2);
    const { ctx: c2, page: p2 } = await newPage(DESKTOP, 'sam-code');
    await p2.goto(link2);
    await p2.fill('#reset-password', 'third-password-2026');
    await p2.getByRole('button', { name: 'Save password' }).click();
    await p2.getByRole('heading', { name: 'Enter your code' }).waitFor();
    check('two-step on: the code after the new password', await p2.locator('#reset-code').isVisible());
    await shot(p2, 'reset-code-desktop');
    await p2.fill('#reset-code', hotp(base32Decode(key), Math.max(step0 + 1, totpStep(Date.now()))));
    await p2.getByRole('button', { name: 'Sign in' }).click();
    await p2.getByText('Password changed. You’re signed out everywhere else.').waitFor();
    const me = await api(p2, '/auth/me');
    check('…then signed in', me.status === 200 && me.json.user.email === 'sam@example.org', String(me.status));
    await c2.close();
  }

  // ── 5. No sender: ask a manager, and no form ──
  await sender(false);
  for (const [viewport, label] of [[DESKTOP, 'desktop'], [PHONE, 'phone']]) {
    const { ctx, page } = await newPage(viewport, `nosender-${label}`);
    await page.goto(`${FIELD}/forgot`);
    await page.getByText('This campaign can’t send email yet. Ask a manager for a password link.').waitFor();
    check(`${label}: no sender — ask a manager, no form`, (await page.locator('#forgot-email').count()) === 0);
    await shot(page, `forgot-nosender-${label}`);
    if (label === 'phone') await phoneOk(page, 'Forgot, no sender');
    await ctx.close();
  }

  // ── 6. A manager's password link ──
  await mgr.goto(`${DESK}/settings`);
  const row = mgr.locator('.ot-item', { hasText: 'Sam Example' });
  await row.getByRole('button', { name: 'Password link' }).waitFor();
  check('no Password link on the manager’s own row', (await mgr.locator('.ot-item', { hasText: 'Rae Example' }).getByRole('button', { name: 'Password link' }).count()) === 0);
  await row.getByRole('button', { name: 'Password link' }).click();
  await row.getByText('Make a password link for Sam Example?').waitFor();
  await shot(mgr, 'members-confirm-desktop');
  await row.getByRole('button', { name: 'Yes' }).click();
  await row.getByText('Password link for Sam Example · works for 24 hours').waitFor();
  const shown = await row.getByTestId('password-link').textContent();
  check('no sender: the link to pass on', /\/a\/field\/reset#t=[0-9a-f]{64}$/.test(shown), shown);
  await row.getByRole('button', { name: 'Copy link' }).click();
  const copied = await mgr.evaluate(() => navigator.clipboard.readText()).catch(() => '');
  check('Copy puts it on the clipboard', copied === shown, copied);
  await shot(mgr, 'members-link-desktop');
  await sender(true);
  const before = (await outbox()).length;
  await row.getByRole('button', { name: 'Password link' }).click();
  await row.getByRole('button', { name: 'Yes' }).click();
  await row.getByText('Emailed a password link to Sam Example · it works for 24 hours').waitFor();
  check('with a sender: emailed, and no link on screen', (await row.getByTestId('password-link').count()) === 0);
  const after = await outbox();
  check('…one email to Sam', after.length === before + 1 && after.at(-1).to === 'sam@example.org', JSON.stringify(after.at(-1)?.subject));
  await shot(mgr, 'members-emailed-desktop');
  {
    const { ctx, page } = await newPage(PHONE, 'manager-phone');
    await page.goto(`${FIELD}/login`);
    await api(page, '/auth/login', { email: 'rae@example.org', password: PASSWORD });
    await page.goto(`${DESK}/settings`);
    const r = page.locator('.ot-item', { hasText: 'Sam Example' });
    await r.getByRole('button', { name: 'Password link' }).click();
    await r.getByText('Make a password link for Sam Example?').waitFor();
    await shot(page, 'members-confirm-phone');
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    check('Members on a phone: no sideways scroll', !wide);
    await r.getByRole('button', { name: 'No' }).click();
    await ctx.close();
  }
  // No campaign address: no Password link (every tap would be refused).
  await control('/set', { env: { BASE_PUBLIC_URL: null } });
  try {
    await mgr.goto(`${DESK}/settings`);
    const r = mgr.locator('.ot-item', { hasText: 'Sam Example' });
    await r.getByRole('button', { name: 'Remove' }).waitFor();
    await mgr.waitForLoadState('networkidle');
    check('no address: no Password link', (await r.getByRole('button', { name: 'Password link' }).count()) === 0);
    check('no address: says why', await mgr.getByText('Password links need this campaign’s web address').isVisible().catch(() => false));
  } finally { await control('/set', { env: { BASE_PUBLIC_URL: `${ORIGIN}${P}` } }); }
  await mgrCtx.close();
} catch (e) {
  check('the walk finished', false, e.stack || e.message);
} finally {
  await browser.close();
  server.kill('SIGTERM');
}

check('no page errors', !errors.length, errors.join(' | '));
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed) console.log(serverLog.slice(-3000));
process.exit(failed ? 1 : 0);
