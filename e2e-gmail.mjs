// Email from your own Gmail (ext/gmail), end to end, against the stand-in
// Google (server/test/fake-google.js) — never the real one: every outside
// address is stopped, and the suite fails if the browser asks Google.
//
// It starts its own servers and stops them: base.win on PORT (default 5240)
// with Google and Gmail pointed at the fake on PORT+1, base.win without
// Google on PORT+2, and base.win under BASE_PATH=/imaginesurrey on PORT+3.
// Build the web app first (cd web && npm run build).
//
//   SHOTS=/tmp/gmail [PORT=5240] node e2e-gmail.mjs
//
// A manager, a staffer and a volunteer, at 1440x900 and 390x844:
// Settings → Services → Gmail (not set up; how Google is set up, the switch,
// the domain line); Your profile's Gmail line (Connect Gmail through the
// fake, "Connected", the not-reviewed line, sent today, Send me a test,
// paused, ?google=blocked, Disconnect); a person's page (the Email sheet,
// Sent, History, Reached by; unsure and Send again; Connect again mid-send
// with the draft back; not connected; the do-not-email, bounced and
// Do-Not-Contact chips; Google off: the mail app, Email's outcomes, the
// outbox with no signal); staff denied Outreach and the volunteer see no
// Gmail; one primary per screen, no sideways scroll at 390, 48 px targets.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { startFakeGoogle } from './server/test/fake-google.js';

const SHOTS = process.env.SHOTS || '/tmp/starbase-gmail';
mkdirSync(SHOTS, { recursive: true });
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 5240;
const G_PORT = PORT + 1;
const NOG_PORT = PORT + 2;
const BP_PORT = PORT + 3;
const BASE = `http://${HOST}:${PORT}`;
const G = `http://${HOST}:${G_PORT}`;
const NOG = `http://${HOST}:${NOG_PORT}`;
const BP = `http://${HOST}:${BP_PORT}`;
const P = '/imaginesurrey';
const CLIENT_ID = 'e2e-gmail-client.apps.example';
const SECRET = 'e2e-gmail-client-secret';
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

const ACCTS = {
  rae: { sub: '300000000000000000001', email: 'rae.example@gmail.com', name: 'Rae Example' },
  sam: { sub: '300000000000000000002', email: 'sam.example@gmail.com', name: 'Sam Example' },
  bea: { sub: '300000000000000000003', email: 'bea.example@gmail.com', name: 'Bea Example' },
};
// slowMs above base.win's 10 s Gmail timeout: a hang is "Not sure it went".
const fake = await startFakeGoogle({
  port: G_PORT, clientId: CLIENT_ID, secret: SECRET, accounts: Object.values(ACCTS), slowMs: 14000,
  redirectUris: [`${BASE}/api/auth/google/back`, `${BP}${P}/api/auth/google/back`],
});
const procs = [];
const startServer = async (port, env, label) => {
  const child = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, STARBASE_OPEN_SIGNUP: '1', STARBASE_DATA: 'memory', PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  procs.push(child);
  for (let i = 0; i < 100; i += 1) {
    if (child.exitCode !== null) break;
    try { if ((await fetch(`http://${HOST}:${port}/api/health`)).status < 500) return child; } catch { /* starting */ }
    await sleep(200);
  }
  throw new Error(`${label} didn't start: ${log.slice(-800)}`);
};
const GOOGLE_ENV = {
  GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET: SECRET,
  GOOGLE_ACCOUNTS_BASE: G, GOOGLE_OAUTH_BASE: G, GMAIL_API_BASE: G,
  GOOGLE_TOKEN_KEY: `e2e-gmail-token-key-${tag}-0123456789abcdef`,
};

let browser;
const errors = [];
const offHost = [];
try {
  await startServer(PORT, { ...GOOGLE_ENV, STARBASE_PUBLIC_URL: BASE }, 'base.win');
  await startServer(NOG_PORT, { STARBASE_PUBLIC_URL: NOG }, 'base.win without Google');
  await startServer(BP_PORT, { ...GOOGLE_ENV, STARBASE_PUBLIC_URL: `${BP}${P}`, BASE_PATH: P }, 'base.win under BASE_PATH');

  browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const newPage = async (viewport, label) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, timezoneId: 'America/Vancouver', ...(viewport === PHONE ? { isMobile: true, hasTouch: true } : {}) });
    await ctx.route('**/*', (route) => {
      const u = new URL(route.request().url());
      if (u.hostname !== HOST && u.protocol !== 'data:' && u.protocol !== 'blob:') { if (/google/i.test(u.hostname)) offHost.push(u.href); return route.abort(); }
      return route.continue();
    });
    // The phone's own mail app: never opened here, the tap's own work still done.
    await ctx.addInitScript(() => {
      document.addEventListener('click', (e) => { if (e.target.closest?.('a[href^="mailto:"]')) e.preventDefault(); }, true);
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`[${label}] ${e.message}`));
    return { ctx, page };
  };
  const shot = (p, name) => p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
  const text = async (p, sel = 'body') => ((await p.locator(sel).first().innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
  const noSideways = (p) => p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const primaries = (p) => p.locator('.btn-primary:visible').count();
  const api = (p, path, body) => p.evaluate(async ([u, b]) => {
    const r = await fetch(u, b === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    return { status: r.status, json: await r.json().catch(() => null) };
  }, [path, body]);
  const small = (p, sel) => p.evaluate((s) => [...document.querySelectorAll(s)].filter((e) => e.offsetParent)
    .map((e) => ({ t: e.textContent.trim().slice(0, 30), h: Math.round(e.getBoundingClientRect().height) })).filter((x) => x.h < 48), sel);
  const pickGoogle = async (p, who) => {
    await p.waitForURL((u) => u.port === String(G_PORT), { timeout: 10000 });
    await p.click(`a.acct[data-sub="${ACCTS[who].sub}"]`);
    await p.waitForURL((u) => u.port !== String(G_PORT), { timeout: 10000 });
    await p.waitForLoadState('domcontentloaded');
  };
  const signUp = async (p, origin, prefix, email) => {
    await p.goto(`${origin}${prefix}/signup`, { waitUntil: 'domcontentloaded' });
    await p.fill('#su-name', 'Rae Example');
    if (await p.locator('#su-org').count()) await p.fill('#su-org', 'Example Campaign');
    await p.fill('#su-email', email);
    await p.fill('#su-password', PASSWORD);
    await p.click('button[type="submit"]');
    await p.waitForURL(/\/(admin|desk)\/?$/, { timeout: 15000 });
  };
  const signIn = async (p, path, email) => {
    await p.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
    await p.fill('#login-email', email);
    await p.fill('#login-password', PASSWORD);
    await p.getByRole('button', { name: 'Sign in', exact: true }).click();
    await p.waitForURL((u) => !u.pathname.endsWith('/login'), { timeout: 10000 });
  };
  const addPerson = async (p, name, email, tags = []) => (await api(p, '/api/actions/person.create', { kind: 'person', name, email, tags })).json?.person?.id;
  const reachPressed = (p) => p.locator('.pf-channel button[aria-pressed="true"]').first().innerText().catch(() => '');
  const outcomes = (p) => p.locator('.pf-rate .fk-outcomes button').allInnerTexts();

  // ── Without Google: the Gmail row, and Email by the phone's own mail app ──
  {
    const { ctx, page } = await newPage(DESKTOP, 'no-google');
    await signUp(page, NOG, '', `rae.nog.${tag}@example.org`);
    await page.goto(`${NOG}/admin/settings/services`, { waitUntil: 'domcontentloaded' });
    await page.getByText('Gmail (send as yourself)').waitFor({ timeout: 10000 });
    // The row reads Google's side too: wait for it (a busy machine is slow).
    await page.waitForFunction(() => ![...document.querySelectorAll('.sv2-row')].some((r) => /Gmail \(send as yourself\)/.test(r.innerText) && /Loading…/.test(r.innerText)), null, { timeout: 15000 }).catch(() => {});
    const row = await text(page, '.sv2-row:has(.sv2-name:text-is("Gmail (send as yourself)"))');
    check('Services → Gmail without Google: "Set up Google first — the Google row above." and nothing else', row.includes('Set up Google first — the Google row above.')
      && !row.includes('Let the desk send') && !/Check/.test(row), row);
    const jo = await api(page, '/api/actions/person.create', { kind: 'person', name: 'Jo Example', email: 'jo@example.org' });
    await page.goto(`${NOG}/admin/people/${jo.json.person.id}`, { waitUntil: 'domcontentloaded' });
    const tile = page.locator('.pf-acts a.pf-act:has-text("Email")');
    await tile.waitFor({ timeout: 10000 });
    check('Google off: the Email tile is the mail app (mailto:), with no Gmail line', (await tile.getAttribute('href')) === 'mailto:jo@example.org' && !(await page.locator('.gm-tileline').count()));
    await tile.click();
    check('…and its tap presets "Reached by: Email"', (await reachPressed(page)) === 'Email', await reachPressed(page));
    const outs = await outcomes(page);
    check('…the outcome row shows No answer and Refused only', outs.join('|') === 'No answer|Refused', outs.join('|'));
    await shot(page, '01-person-google-off-1440');
    await ctx.setOffline(true);
    await page.locator('.pf-rate .fk-outcomes button:has-text("No answer")').click();
    await page.waitForTimeout(500);
    const st = await text(page, '.pf-status');
    check('no signal: "Reached by: Email · No answer" waits in the outbox', /Email · No answer/.test(st) && !/✓ Email/.test(st), st);
    await ctx.setOffline(false);
    await page.waitForFunction(() => /✓ Sent · Email · No answer/.test(document.querySelector('.pf-status')?.textContent || ''), null, { timeout: 15000 }).catch(() => {});
    check('…and sends when back online', /✓ Sent · Email · No answer/.test(await text(page, '.pf-status')), await text(page, '.pf-status'));
    // The phone: the same, at 390.
    const { ctx: pctx, page: pp } = await newPage(PHONE, 'no-google-phone');
    await pctx.addCookies(await ctx.cookies(NOG));
    await pp.goto(`${NOG}/admin/people/${jo.json.person.id}`, { waitUntil: 'domcontentloaded' });
    await pp.locator('.pf-acts a.pf-act:has-text("Email")').click();
    const chipSmall = await small(pp, '.pf-channel button');
    check('phone: the rating card’s Reached by chips (Email too) are 48 px, no sideways scroll', chipSmall.length === 0 && (await noSideways(pp)) <= 0, JSON.stringify(chipSmall));
    await shot(pp, '02-person-google-off-390');
    await pctx.close();
    await ctx.close();
  }

  // ── The manager: Services → Gmail ──
  const { ctx: mctx, page: m } = await newPage(DESKTOP, 'manager');
  const mgr = `rae.${tag}@example.org`;
  await signUp(m, BASE, '', mgr);
  const join = async (email, role, name) => {
    const inv = (await api(m, '/api/actions/member.invite', { email, role })).json;
    const r = await fetch(`${BASE}/api/auth/join`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ token: inv.joinUrl.split('/join/')[1], name, password: PASSWORD }) });
    return r.status;
  };
  const staff = `sam.${tag}@example.org`;
  const staff2 = `bea.${tag}@example.org`;
  const vol = `val.${tag}@example.org`;
  check('a staffer, a second staffer and a volunteer join', (await join(staff, 'staff', 'Sam Example')) === 200
    && (await join(staff2, 'staff', 'Bea Example')) === 200 && (await join(vol, 'volunteer', 'Val Example')) === 200);
  const jane = await addPerson(m, 'Jane Example', 'jane@example.org');
  const dee = await addPerson(m, 'Dee Example', 'dee@example.org', ['do-not-email']);
  const con = await addPerson(m, 'Con Example', 'con@example.org', ['Do-Not-Contact']);
  const bo = await addPerson(m, 'Bo Example', 'bo@example.org');
  check('four people on file', [jane, dee, con, bo].every(Boolean));

  await m.goto(`${BASE}/admin/settings/services`, { waitUntil: 'domcontentloaded' });
  const gm = m.locator('.sv2-row:has(.sv2-name:text-is("Gmail (send as yourself)"))');
  await gm.locator('.gm-panel').waitFor({ timeout: 10000 });
  await gm.getByRole('switch', { name: /Let the desk send/ }).click();
  await gm.locator('.error').waitFor({ timeout: 5000 }).catch(() => {});
  check('turning Gmail on before saying how Google is set up: the sentence in place', (await text(m, '.gm-panel .error')) === 'Say how Google is set up for base.win', await text(m, '.gm-panel .error'));
  await gm.getByRole('button', { name: 'Not reviewed by Google yet' }).click();
  await m.waitForFunction(() => [...document.querySelectorAll('.gm-review')].some((b) => b.getAttribute('aria-pressed') === 'true'));
  await gm.getByRole('switch', { name: /Let the desk send/ }).click();
  await m.waitForFunction(() => document.querySelector('.gm-panel [role="switch"]')?.getAttribute('aria-checked') === 'true', null, { timeout: 5000 }).catch(() => {});
  const panel = await text(m, '.gm-panel');
  check('Services → Gmail: "Not reviewed by Google yet" picked, the switch on', (await gm.locator('.gm-review[aria-pressed="true"]').innerText()) === 'Not reviewed by Google yet'
    && (await gm.getByRole('switch').getAttribute('aria-checked')) === 'true', panel);
  check('…each choice with its one line, and GSI’s domain rule read-only', panel.includes('no more than 100 people can ever connect') && panel.includes('Anyone on the desk can connect.')
    && panel.includes('Any Google account can connect. Personal Gmail has lower sending limits and can’t be managed by the campaign.') && !(await gm.locator('.gm-panel input').count()), panel);
  check('…no Check button on the Gmail row', !(await gm.locator('.sv2-check').count()));
  await shot(m, '03-services-gmail-1440');
  {
    const { ctx, page } = await newPage(PHONE, 'manager-phone');
    await ctx.addCookies(await mctx.cookies(BASE));
    await page.goto(`${BASE}/admin/settings/services`, { waitUntil: 'domcontentloaded' });
    await page.locator('.gm-panel').waitFor({ timeout: 10000 });
    check('Services at 390: no sideways scroll', (await noSideways(page)) <= 0);
    await page.locator('.gm-panel').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/04-services-gmail-390.png` });
    await ctx.close();
  }

  // ── Staff: Your profile, before connecting; a person's page, not connected ──
  const { ctx: sctx, page: s } = await newPage(DESKTOP, 'staff');
  await signIn(s, '/admin/login', staff);
  await s.goto(`${BASE}/admin/people/${jane}`, { waitUntil: 'domcontentloaded' });
  await s.locator('.gm-tileline').waitFor({ timeout: 10000 }).catch(() => {});
  check('not connected: the tile is the mail app, and "Gmail needs connecting — Your profile"', (await s.locator('.pf-acts a.pf-act:has-text("Email")').getAttribute('href')) === 'mailto:jane@example.org'
    && (await text(s, '.gm-tileline')) === 'Gmail needs connecting — Your profile' && (await s.locator('.gm-tileline a').getAttribute('href')).endsWith('/profile'));
  await shot(s, '05-person-not-connected-1440');
  await s.goto(`${BASE}/admin/profile`, { waitUntil: 'domcontentloaded' });
  await s.locator('.gm-connect').waitFor({ timeout: 10000 });
  const pre = await text(s, '.gm-connect');
  check('Your profile: what Gmail is for, the not-reviewed line, Connect Gmail (quiet)', pre.includes('Send email from your own Gmail, from a person’s page.')
    && pre.includes('Google will warn that it hasn’t reviewed base.win. That’s expected here — continue past it.')
    && (await s.locator('.gm-connect a:has-text("Connect Gmail")').getAttribute('class')).includes('btn-quiet'), pre);
  check('…one primary on Your profile at most (Two-step’s)', (await primaries(s)) <= 1);
  await shot(s, '06-profile-not-connected-1440');
  await s.locator('.gm-connect a:has-text("Connect Gmail")').click();
  await pickGoogle(s, 'sam');
  await s.locator('.gm-count').waitFor({ timeout: 10000 }).catch(() => {});
  check('Connect Gmail → the fake approves → back on Your profile, "Connected"', new URL(s.url()).pathname === '/admin/profile' && (await text(s, '.gg-note')) === 'Connected', `${s.url()} ${await text(s, '.gg-note')}`);
  check('…"Send from your Gmail" under Connected as, with "0 sent today of 100"', (await text(s, '.gg-card')).includes(`Connected as ${ACCTS.sam.email}`)
    && (await text(s, '.gg-item:has-text("Send from your Gmail") .gm-count__n')) === '0 sent today of 100', await text(s, '.gg-card'));
  await s.getByRole('button', { name: 'Send me a test' }).click();
  await s.waitForFunction(() => /Test sent|Gmail/.test(document.querySelector('.gm-test-said')?.textContent || ''), null, { timeout: 10000 }).catch(() => {});
  check('Send me a test → "Test sent — check your inbox", to their own address', (await text(s, '.gm-test-said')) === 'Test sent — check your inbox'
    && fake.gmailSent.at(-1)?.headers.to === `<${ACCTS.sam.email}>`, await text(s, '.gm-test-said'));
  await s.waitForFunction(() => /^1 sent today/.test(document.querySelector('.gm-count__n')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
  check('…and it counts: "1 sent today"', /^1 sent today of 100/.test(await text(s, '.gm-count__n')), await text(s, '.gm-count__n'));
  check('…still one primary at most', (await primaries(s)) <= 1);
  await shot(s, '07-profile-connected-1440');

  // ── The sheet: Sent ──
  await s.goto(`${BASE}/admin/people/${jane}`, { waitUntil: 'domcontentloaded' });
  const emailBtn = s.locator('.pf-acts button.pf-act:has-text("Email")');
  await emailBtn.waitFor({ timeout: 10000 });
  check('Gmail ready: the Email tile opens the sheet in place, no line under the tiles', !(await s.locator('.gm-tileline').count()));
  await emailBtn.click();
  await s.locator('.gm-sheet').waitFor();
  const sheet = await text(s, '.gm-sheet');
  check('"Email Jane Example": From your Gmail, To their address', sheet.includes('Email Jane Example') && sheet.includes(`From: ${ACCTS.sam.email} · your Gmail`) && sheet.includes('To: jane@example.org'), sheet);
  check('…one primary: Send', (await primaries(s)) === 1);
  await shot(s, '08-sheet-empty-1440');
  await s.fill('.gm-sheet input', 'Thanks for Saturday — café on 72 Ave');
  await s.fill('.gm-sheet textarea', 'Hi Jane,\n\nThanks for coming out.\n\nSam');
  const before = fake.gmailSent.length;
  await s.locator('.gm-send').click();
  await s.locator('.toast:has-text("Sent from your Gmail")').waitFor({ timeout: 10000 }).catch(() => {});
  check('Send → the sheet closes, "Sent from your Gmail"', !(await s.locator('.gm-sheet').count()) && (await text(s, '.toast')) === 'Sent from your Gmail', await text(s, '.toast'));
  check('…one message, to Jane, from Sam’s Gmail', fake.gmailSent.length === before + 1 && fake.gmailSent.at(-1).headers.to === '<jane@example.org>' && fake.gmailSent.at(-1).headers.from.includes(ACCTS.sam.email));
  check('…"Reached by: Email" preset', (await reachPressed(s)) === 'Email');
  await s.waitForFunction(() => /Sent from Gmail/.test(document.querySelector('#pf-history')?.textContent || ''), null, { timeout: 10000 }).catch(() => {});
  const hist = await text(s, '#pf-history');
  check('History: "Sent from Gmail" by Sam, with the subject', hist.includes('Sent from Gmail') && hist.includes('Sam Example') && hist.includes('Thanks for Saturday'), hist.slice(0, 300));
  await s.locator('#pf-history').screenshot({ path: `${SHOTS}/09-history-gmail-1440.png` });

  // ── Unsure, then Send again ──
  await emailBtn.click();
  await s.fill('.gm-sheet input', 'Second try');
  await s.fill('.gm-sheet textarea', 'Hello again.');
  fake.next('gmail', 'hang');
  await s.locator('.gm-send').click();
  await s.waitForFunction(() => /Sending…/.test(document.querySelector('.gm-send')?.textContent || ''), null, { timeout: 3000 }).catch(() => {});
  check('while sending: "Sending…", the button disabled', (await s.locator('.gm-send').isDisabled()) && (await s.locator('.gm-send').innerText()) === 'Sending…');
  await shot(s, '10-sheet-sending-1440');
  await s.locator('.gm-said:has-text("Not sure it went")').waitFor({ timeout: 20000 }).catch(() => {});
  check('Gmail doesn’t answer: "Not sure it went — check your Gmail’s Sent folder before sending again."', (await text(s, '.gm-said p')) === 'Not sure it went — check your Gmail’s Sent folder before sending again.', await text(s, '.gm-sheet'));
  await shot(s, '11-sheet-unsure-1440');
  const unsureAt = Date.now();
  await s.getByRole('button', { name: 'Send again' }).click();
  check('Send again asks first: "Send again? It may arrive twice."', (await text(s, '.gm-confirm')).startsWith('Send again? It may arrive twice.'));
  // Right after no answer, GSI waits 30 s before asking Gmail again: said, nothing sent.
  const sentBefore = fake.gmailSent.length;
  await s.locator('.gm-confirm button:has-text("Send")').click();
  await s.locator('.gm-sheet .error').waitFor({ timeout: 10000 }).catch(() => {});
  check('…at once: "Google isn’t answering — nothing was sent. Try again in a minute."', (await text(s, '.gm-sheet .error')) === 'Google isn’t answering — nothing was sent. Try again in a minute.'
    && fake.gmailSent.length === sentBefore, await text(s, '.gm-sheet'));
  await sleep(Math.max(0, unsureAt + 31000 - Date.now()));
  await s.locator('.gm-send').click();
  await s.locator('.toast:has-text("Sent from your Gmail")').waitFor({ timeout: 10000 }).catch(() => {});
  check('…a minute on, Send: it goes, the sheet closes', !(await s.locator('.gm-sheet').count()) && fake.gmailSent.length === sentBefore + 1, await text(s, '.gm-sheet'));

  // ── The phone: the sheet at 390 ──
  {
    const { ctx, page } = await newPage(PHONE, 'staff-phone');
    await ctx.addCookies(await sctx.cookies(BASE));
    await page.goto(`${BASE}/admin/people/${jane}`, { waitUntil: 'domcontentloaded' });
    await page.locator('.pf-acts button.pf-act:has-text("Email")').click();
    await page.locator('.gm-sheet').waitFor();
    const send = await page.locator('.gm-send').boundingBox();
    check('phone: Send is full width and 48 px tall; no sideways scroll', send.height >= 48 && send.width >= PHONE.width - 80 && (await noSideways(page)) <= 0, JSON.stringify(send));
    const tiny = await small(page, '.gm-sheet button, .gm-sheet a.btn, .gm-sheet summary');
    check('phone: every target in the sheet is 48 px', tiny.length === 0, JSON.stringify(tiny));
    await page.locator('.gm-sheet').screenshot({ path: `${SHOTS}/12-sheet-390.png` });
    await page.goto(`${BASE}/admin/profile`, { waitUntil: 'domcontentloaded' });
    await page.locator('.gm-count').waitFor({ timeout: 10000 });
    const tinyLine = await small(page, '.gm-count .btn, .gg-item .btn');
    check('phone: the Gmail line’s buttons are 48 px; no sideways scroll', tinyLine.length === 0 && (await noSideways(page)) <= 0, JSON.stringify(tinyLine));
    await page.screenshot({ path: `${SHOTS}/13-profile-connected-390.png`, fullPage: true });
    await ctx.close();
  }

  // ── Connect again mid-send: the draft comes back ──
  await emailBtn.click();
  await s.fill('.gm-sheet input', 'About the lawn sign');
  await s.fill('.gm-sheet textarea', 'Hi Jane — still keen on a sign?');
  fake.revokeAll(ACCTS.sam.sub);
  await s.locator('.gm-send').click();
  await s.locator('.gm-said a:has-text("Connect again")').waitFor({ timeout: 10000 }).catch(() => {});
  check('Google let go of Sam’s Gmail: the words, and a quiet "Connect again"', /Gmail needs connecting again/.test(await text(s, '.gm-said')) && (await s.locator('.gm-said a:has-text("Connect again")').count()) === 1, await text(s, '.gm-sheet'));
  await shot(s, '14-sheet-reconnect-1440');
  // Cancel on Google's page: the message is still on screen, with the way back.
  await s.locator('.gm-said a:has-text("Connect again")').click();
  await s.waitForURL((u) => u.port === String(G_PORT), { timeout: 10000 });
  await s.click('#cancel');
  await s.waitForURL((u) => u.port !== String(G_PORT), { timeout: 10000 });
  await s.locator('.gm-sheet').waitFor({ timeout: 10000 }).catch(() => {});
  check('…Cancel at Google: back on Jane’s page, the sheet open with the draft, the words and "Connect again"', new URL(s.url()).pathname === `/admin/people/${jane}`
    && (await s.locator('.gm-sheet input').inputValue().catch(() => '')) === 'About the lawn sign'
    && (await s.locator('.gm-sheet textarea').inputValue().catch(() => '')) === 'Hi Jane — still keen on a sign?'
    && /Gmail needs connecting again/.test(await text(s, '.gm-said'))
    && (await s.locator('.gm-said a:has-text("Connect again")').count()) === 1
    && (await text(s, '.toast')) === 'Connecting Gmail was cancelled.', `${s.url()} ${await text(s, '.toast')} ${await text(s, '.gm-sheet')}`);
  check('…and nothing kept in this tab to pop up later', (await s.evaluate((id) => sessionStorage.getItem(`gmail-draft:${id}`), jane)) === null);
  await shot(s, '14b-sheet-cancelled-at-google-1440');
  await s.locator('.gm-said a:has-text("Connect again")').click();
  await pickGoogle(s, 'sam');
  await s.locator('.gm-sheet').waitFor({ timeout: 10000 }).catch(() => {});
  check('…back on Jane’s page, "Connected", the sheet open with the draft', new URL(s.url()).pathname === `/admin/people/${jane}`
    && (await s.locator('.gm-sheet input').inputValue().catch(() => '')) === 'About the lawn sign'
    && (await s.locator('.gm-sheet textarea').inputValue().catch(() => '')) === 'Hi Jane — still keen on a sign?'
    && (await text(s, '.toast')) === 'Connected', `${s.url()} ${await text(s, '.toast')}`);
  await s.getByRole('button', { name: 'Cancel', exact: true }).click();
  check('…Cancel: the draft is gone from this tab', (await s.evaluate((id) => sessionStorage.getItem(`gmail-draft:${id}`), jane)) === null && !(await s.locator('.gm-sheet').count()));

  // ── Who can't be emailed: the chips, no tile ──
  await s.goto(`${BASE}/admin/people/${dee}`, { waitUntil: 'domcontentloaded' });
  await s.locator('.pf-meta').waitFor();
  check('do-not-email: the "Do not email" chip and no Email tile', (await s.locator('.pf-meta .chip:text-is("Do not email")').count()) === 1 && !(await s.locator('.pf-act:has-text("Email")').count()));
  check('…the Email field shows the address, not a link', (await s.locator('.pf-sections a[href^="mailto:"]').count()) === 0);
  await s.locator('.pf-channel button:has-text("Email")').click();
  check('…Reached by Email still logs, with the warning in view', (await text(s, '.gm-warn')) === 'Do not email');
  await shot(s, '15-person-do-not-email-1440');
  await s.goto(`${BASE}/admin/people/${con}`, { waitUntil: 'domcontentloaded' });
  await s.locator('.pf-meta').waitFor();
  check('tagged "Do-Not-Contact" (capitals): the "Do not contact" chip and no Email tile', (await s.locator('.pf-meta .chip:text-is("Do not contact")').count()) === 1 && !(await s.locator('.pf-act:has-text("Email")').count()));
  // A bounced address (the person read's email_why, as the server says it after a bounce webhook).
  await s.route(`**/api/persons/${bo}`, async (route) => {
    const r = await route.fetch();
    const j = await r.json();
    j.person.email_why = 'suppressed';
    await route.fulfill({ response: r, json: j });
  });
  await s.goto(`${BASE}/admin/people/${bo}`, { waitUntil: 'domcontentloaded' });
  await s.locator('.pf-meta').waitFor();
  const bounced = s.locator('.pf-meta .chip:text-is("Email bounced")');
  check('a bounced address: the "Email bounced" chip, titled how to fix it, and no Email tile', (await bounced.count()) === 1
    && (await bounced.getAttribute('title')) === 'The address bounced or reported spam — fix it under Edit' && !(await s.locator('.pf-act:has-text("Email")').count()));
  await s.unroute(`**/api/persons/${bo}`);

  // ── Paused: Gmail asks to wait ──
  await s.goto(`${BASE}/admin/people/${jane}`, { waitUntil: 'domcontentloaded' });
  await emailBtn.click();
  await s.fill('.gm-sheet input', 'One more');
  await s.fill('.gm-sheet textarea', 'Hi.');
  fake.next('gmail', '429', { retryAfter: 120 });
  await s.locator('.gm-send').click();
  await s.locator('.gm-sheet .error').waitFor({ timeout: 10000 }).catch(() => {});
  check('Gmail asks to wait: its words, in place', /^Gmail asked us to wait\. Try after \d{1,2}:\d{2} [ap]m\.$/.test(await text(s, '.gm-sheet .error')), await text(s, '.gm-sheet .error'));
  await s.getByRole('button', { name: 'Cancel', exact: true }).click();
  await s.reload({ waitUntil: 'domcontentloaded' });
  await s.locator('.gm-tileline').waitFor({ timeout: 10000 }).catch(() => {});
  check('…the tile is the mail app, "Gmail asked us to wait until 3:40 pm"', /^Gmail asked us to wait until \d{1,2}:\d{2} [ap]m$/.test(await text(s, '.gm-tileline'))
    && (await s.locator('.pf-acts a.pf-act:has-text("Email")').count()) === 1, await text(s, '.gm-tileline'));
  await s.goto(`${BASE}/admin/profile`, { waitUntil: 'domcontentloaded' });
  await s.locator('.gg-item:has-text("Send from your Gmail") .gm-pline').waitFor({ timeout: 10000 }).catch(() => {});
  check('Your profile, paused: "Gmail asked us to wait until …"', /^Gmail asked us to wait until \d{1,2}:\d{2} [ap]m\.$/.test(await text(s, '.gg-item .gm-pline')), await text(s, '.gg-card'));
  await shot(s, '16-profile-paused-1440');

  // ── ?google=blocked, then Disconnect ──
  await s.goto(`${BASE}/admin/profile?google=blocked`, { waitUntil: 'domcontentloaded' });
  await s.locator('.gg-note').waitFor({ timeout: 10000 }).catch(() => {});
  check('?google=blocked: the Workspace admin words', (await text(s, '.gg-note')).startsWith('Your Google Workspace admin hasn’t allowed base.win'), await text(s, '.gg-note'));
  await s.locator('.gg-item:has-text("Send from your Gmail") button:has-text("Disconnect")').click();
  check('Disconnect asks: "Stop using Google for Send from your Gmail?"', (await text(s, '.gg-confirm')).startsWith('Stop using Google for Send from your Gmail?'));
  await s.locator('.gg-confirm button:has-text("Disconnect")').click();
  await s.locator('.gm-connect').waitFor({ timeout: 10000 }).catch(() => {});
  check('…disconnected: Connect Gmail again', (await s.locator('.gm-connect a:has-text("Connect Gmail")').count()) === 1);

  // ── Staff denied Outreach: no Gmail anywhere, never "Unavailable" ──
  const members = (await api(m, '/api/team')).json;
  const bea = (members?.members || members?.team || []).find?.((x) => x.email === staff2);
  const denied = bea ? (await api(m, '/api/actions/permission.member.set', { user_id: bea.user_id || bea.id, grant: [], deny: ['outreach'] })).status : 0;
  {
    const { page } = await newPage(DESKTOP, 'staff-denied');
    await signIn(page, '/admin/login', staff2);
    await page.goto(`${BASE}/admin/profile`, { waitUntil: 'domcontentloaded' });
    await page.locator('.gg-card').waitFor({ timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(800);
    const card = await text(page, '.gg-card');
    check('staff denied Outreach: no Gmail line and no "Unavailable" on Your profile', denied === 200 && !/Gmail/.test(card) && !/Unavailable/.test(card), `${denied} ${card}`);
    check('…/api/gmail answers 403', (await api(page, '/api/gmail')).status === 403);
  }

  // ── The volunteer: no Email tile, no Email chip, no Gmail line ──
  {
    const { page } = await newPage(PHONE, 'volunteer');
    await signIn(page, '/login', vol);
    check('volunteer: /api/gmail and gmail.send answer 403', (await api(page, '/api/gmail')).status === 403
      && (await api(page, '/api/actions/gmail.send', { person_id: jane, subject: 'x', body: 'y', client_key: crypto.randomUUID() })).status === 403);
    await page.goto(`${BASE}/people/${jane}`, { waitUntil: 'domcontentloaded' });
    await page.locator('.pf-rate').waitFor({ timeout: 10000 }).catch(() => {});
    check('volunteer: no Email tile and no Email in Reached by', (await page.locator('.pf-rate').count()) === 1 && !(await page.locator('.pf-act:has-text("Email")').count())
      && !(await page.locator('.pf-channel button:has-text("Email")').count()));
    await page.goto(`${BASE}/profile`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    check('volunteer: no Gmail line on Your profile', !/Gmail/.test(await text(page, 'main')));
  }

  // ── Under BASE_PATH: the Gmail connect round trip ──
  {
    const { page } = await newPage(DESKTOP, 'basepath');
    await signUp(page, `${BP}${P}`, '/field', `rae.bp.${tag}@example.org`);
    const set = (await api(page, `${P}/api/actions/gmail.settings`, { review: 'reviewed', on: true })).status;
    await page.goto(`${BP}${P}/desk/profile`, { waitUntil: 'domcontentloaded' });
    await page.locator('.gm-connect a:has-text("Connect Gmail")').click();
    await pickGoogle(page, 'rae');
    await page.locator('.gm-count').waitFor({ timeout: 10000 }).catch(() => {});
    check('under BASE_PATH: Connect Gmail returns to /imaginesurrey/desk/profile, connected', set === 200 && new URL(page.url()).pathname === `${P}/desk/profile`
      && (await text(page, '.gg-note')) === 'Connected' && (await page.locator('.gm-count').count()) === 1, `${set} ${page.url()}`);
  }
} catch (e) {
  check('suite ran to the end', false, e.stack);
} finally {
  await browser?.close();
  for (const p of procs) p.kill('SIGTERM');
  await sleep(300);
  for (const p of procs) if (p.exitCode === null) p.kill('SIGKILL');
  await fake.close();
}
check('no page errors', errors.length === 0, errors.join(' | '));
check('nothing asked of Google itself (every outside address is stopped)', offHost.length === 0, offHost.join(' '));
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
