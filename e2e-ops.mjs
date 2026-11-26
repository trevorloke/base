// base.win's control centre (apps/platform), in a real browser.
//
// The owner sets it up (the setup code, about you, the authenticator with a
// code made from the key on the page, the recovery codes), lands on an
// empty Campaigns with both ways in, makes campaign "a" (its .env block's
// two random values filled by the page's own script), pastes its address
// (Answering) and gets the door's whole value ("Adds: a"); sets the
// sample's address; opens both desks in new tabs, each landing on that
// campaign's own address with "You’re in as base.win support"; with a code
// more than 10 minutes old, Open asks for a code in the new tab and opens
// the desk in that same tab (no third tab); invites the first manager (the
// invite shows on Members, the checklist says "Done by itself", the door
// knows it); a server reporting another address shows "This server says it
// is somewhere else" and no Open; on a real campaign server
// (node server/index.js, fresh, holding base.win's key) Campaign made stays
// unticked until Invite and open the desk makes the campaign, and the desk
// opens with the invite on Members; the log is intact with every kind of
// line; and a recovery code signs in. Screens at 1440x900 and 390x844: one
// primary button at most (exactly one where the screen has a main action),
// controls at least 48 px on the phone, no sideways scroll.
//
// Ports 5600–5609: 5600 the console (in this process, so the test can age
// the code in its database), 5601 campaign "a" (production, BASE_PATH=/a),
// 5602 the sample (staging), 5603 the door, 5605 a server that says it is
// 5601, 5606 campaign "b" — a real campaign server (node server/index.js,
// in memory; needs npm run build). 5601, 5602 and 5605 are
// apps/platform/test/fake-client.mjs, which checks each token with the
// campaign side's rules; "b" checks them with its own.
//
// Run (system node, under the browser lock):
//   flock -o SP/batch6/locks/browser.lock node e2e-ops.mjs
//   SHOTS=<dir> to keep the screenshots elsewhere.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const ROOT = new URL('.', import.meta.url).pathname;
Object.assign(process.env, {
  OPS_HOST: '127.0.0.1:5600', OPS_INSECURE_COOKIES: '1', OPS_ALLOW_LOCAL: '1', OPS_CLIENT_ORIGIN: 'http://127.0.0.1:5603/{name}',
  OPS_SETUP_CODE: 'e2e-ops-setup-code-0123456789abcdef', OPS_SECRET: 'e2e-ops-secret-0123456789abcdefghijk',
  PLATFORM_SIGNING_KEY: 'test-only-platform-signing-key-0123456789abcdef',
});
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { serve } = await import('@hono/node-server');
const { openDb } = await import(`${ROOT}apps/platform/db.mjs`);
const { makeApp } = await import(`${ROOT}apps/platform/server.mjs`);
const { publicKeyOf } = await import(`${ROOT}apps/platform/keys.mjs`);
const { startFakeClient } = await import(`${ROOT}apps/platform/test/fake-client.mjs`);
const { handler, readClients } = await import(`${ROOT}apps/door/door.mjs`);
const { totp, base32Decode } = await import(`${ROOT}server/lib/twostep.js`);

const OUT = process.env.SHOTS || '/tmp/starbase-ops';
mkdirSync(OUT, { recursive: true });
const B = 'http://127.0.0.1:5600';
const KEY = publicKeyOf(process.env.PLATFORM_SIGNING_KEY).publicKey;
let failures = 0;
const fail = (what) => { failures += 1; console.log(`FAIL ${what}`); };
const ok = (cond, what) => { if (cond) console.log(`ok   ${what}`); else fail(what); };

const db = await openDb('');
const platform = serve({ fetch: makeApp({ db }).fetch, port: 5600, hostname: '127.0.0.1' });
const a = startFakeClient({ port: 5601, env: 'production', publicKey: KEY, basePath: '/a' });
const sample = startFakeClient({ port: 5602, env: 'staging', publicKey: KEY });
const liar = startFakeClient({ port: 5605, env: 'staging', publicKey: KEY, ownOrigin: 'http://127.0.0.1:5601' });
const door = createServer(handler(readClients('{"a":{"server":"http://127.0.0.1:5601"}}'), { doorKey: '' })).listen(5603, '127.0.0.1');
// Campaign "b": a real, fresh campaign server holding base.win's key, as New campaign sets one up.
const REAL = 'http://127.0.0.1:5606';
const realEnv = { ...process.env, PORT: '5606', STARBASE_DATA: 'memory', STARBASE_JOBS: 'off', STARBASE_ENV: 'production', BASE_PLATFORM_PUBKEY: KEY, STARBASE_OWN_URL: REAL };
for (const k of ['STARBASE_OPEN_SIGNUP', 'STARBASE_DEMO_EMAIL', 'RENDER_EXTERNAL_URL', 'STARBASE_PUBLIC_URL', 'BASE_PATH', 'DATABASE_URL', 'MAIL_PROVIDER', 'RESEND_API_KEY', 'SENDGRID_API_KEY']) delete realEnv[k];
let realLog = '';
const real = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: realEnv, stdio: ['ignore', 'pipe', 'pipe'] });
real.stdout.on('data', (d) => { realLog += d; });
real.stderr.on('data', (d) => { realLog += d; });
process.on('exit', () => { try { real.kill('SIGTERM'); } catch { /* gone */ } });
for (let i = 0; i < 120; i += 1) {
  if ((await fetch(`${REAL}/api/health`).then((r) => r.json()).catch(() => null))?.ok) break;
  await new Promise((r) => setTimeout(r, 250));
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ deviceScaleFactor: 1, viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
const watch = (p) => p.on('console', (m) => { if (m.type() === 'error') errors.push(`${p.url()}: ${m.text()}`); });
watch(page);
ctx.on('page', watch);
let secret = '';
const code = async () => { await db.query('update operators set totp_last_step = null'); return totp(base32Decode(secret), Date.now()); };

// The house rules on every screen, at both sizes; a screenshot of each.
const look = async (p, name, { primaries = 1 } = {}) => {
  for (const [w, h, tag] of [[1440, 900, 'desk'], [390, 844, 'phone']]) {
    await p.setViewportSize({ width: w, height: h });
    await p.waitForTimeout(60);
    const r = await p.evaluate(() => ({
      sideways: document.documentElement.scrollWidth > window.innerWidth,
      primaries: [...document.querySelectorAll('.btn-primary')].filter((e) => e.offsetParent).length,
      small: [...document.querySelectorAll('button, .btn, input:not([type=hidden]):not([type=checkbox]), select, .oc-nav a, .oc-check-label')]
        .filter((e) => e.offsetParent && e.getBoundingClientRect().height < 48).map((e) => (e.textContent.trim() || e.name || e.className).slice(0, 40)),
    }));
    if (r.sideways) fail(`${name} ${tag}: sideways scroll`);
    if (tag === 'phone' && r.small.length) fail(`${name} phone: under 48 px: ${r.small.join(' | ')}`);
    if (primaries === 1 ? r.primaries !== 1 : r.primaries > primaries) fail(`${name} ${tag}: ${r.primaries} primary buttons`);
    await p.screenshot({ path: `${OUT}/${name}-${tag}.png`, fullPage: true });
  }
  await p.setViewportSize({ width: 1440, height: 900 });
};
const text = (p) => p.textContent('body');
// A desk tab lands, or says why not.
const land = async (tab, url) => {
  try { await tab.waitForURL(url, { timeout: 10_000 }); } catch (e) {
    console.log(`  at ${tab.url()}: ${(await tab.textContent('body').catch(() => '')).trim().slice(0, 300)}; refused: ${[...a.state.refused, ...sample.state.refused].join(', ')}`);
    throw e;
  }
};
const newTab = async (click) => {
  const [tab] = await Promise.all([ctx.waitForEvent('page'), click()]);
  await tab.waitForLoadState();
  return tab;
};

try {
  // 1. Setup.
  await page.goto(`${B}/signin`);
  await look(page, '01-signin');
  await page.goto(`${B}/setup`);
  await look(page, '02-setup-code');
  await page.fill('#code', process.env.OPS_SETUP_CODE);
  await page.click('.btn-primary');
  await page.waitForURL(/\/setup\/you$/);
  await look(page, '03-about-you');
  await page.fill('#name', 'Olive Example');
  await page.fill('#email', 'owner@example.org');
  await page.fill('#password', 'a long test password 1');
  await page.click('.btn-primary');
  await page.waitForURL(/\/setup\/app$/);
  ok(await page.locator('a[href^="otpauth://"]').count() === 1, 'the authenticator page links to an app on this phone');
  await look(page, '04-authenticator');
  secret = (await page.textContent('.oc-key')).replace(/\s/g, '');
  await page.fill('#code', totp(base32Decode(secret), Date.now()));
  await page.click('.btn-primary');
  await page.waitForURL(/\/setup\/codes$/);
  const recovery = (await page.$$eval('.oc-codes li', (els) => els.map((e) => e.textContent.trim())));
  ok(recovery.length === 10, 'ten recovery codes, shown once');
  await look(page, '05-recovery-codes');
  await page.click('.btn-primary');
  await page.waitForURL(`${B}/`);
  const empty = await text(page);
  ok(/No campaigns yet\./.test(empty) && await page.locator('a.btn-primary', { hasText: 'New campaign' }).count() === 1
    && await page.locator('a', { hasText: 'Add a campaign that’s already running' }).count() === 1, 'Campaigns: empty, with both ways in');
  await look(page, '06-campaigns-empty');

  // The too-short setup code says so (and only that).
  const longCode = process.env.OPS_SETUP_CODE;
  process.env.OPS_SETUP_CODE = 'short';
  const shortTab = await ctx.newPage();
  await shortTab.goto(`${B}/setup`);
  ok(/The setup code in Render is too short, or isn’t one Render made\./.test(await text(shortTab)), 'a short setup code: the one line');
  await look(shortTab, '02b-setup-code-too-short', { primaries: 0 });
  await shortTab.close();
  // That page answers 503 on purpose (setup can't open); the browser notes it.
  for (let i = errors.length - 1; i >= 0; i--) if (/\/setup: Failed to load resource: .* 503/.test(errors[i])) errors.splice(i, 1);
  process.env.OPS_SETUP_CODE = longCode;

  // 2. New campaign "a".
  await page.click('a.btn-primary:has-text("New campaign")');
  await page.waitForURL(/\/new$/);
  await look(page, '07-new-campaign');
  await page.fill('#name', 'a');
  await page.fill('#display', 'Example Campaign');
  await page.fill('#city', 'Exampleton');
  await page.selectOption('#province', 'AB');
  ok(await page.inputValue('#tz') === 'America/Edmonton', 'the time zone follows the province');
  await page.selectOption('#province', 'BC');
  await page.click('.btn-primary');
  await page.waitForURL(/\/c\/a\/setup$/);
  const randoms = await page.$$eval('[data-random]', (els) => els.map((e) => e.textContent));
  ok(randoms.length === 2 && randoms.every((r) => /^[A-Za-z0-9_-]{43}$/.test(r)) && randoms[0] !== randoms[1], 'the .env block’s two random values, made by the page');
  ok(/BASE_PLATFORM_PUBKEY=/.test(await page.textContent('#env-block')) && (await page.textContent('#env-block')).includes(KEY), 'the .env block carries base.win’s key');
  await look(page, '08-setup-before-address');
  await page.fill('#server_url', 'http://127.0.0.1:5601');
  await page.click('button:has-text("Save address")');
  await page.waitForURL(/\/c\/a\/setup$/);
  const setupText = await text(page);
  ok(/Answering/.test(setupText), 'the address answers');
  ok(/Give it its address/.test(setupText) && (await page.textContent('#own-address')) === 'a.base.win', 'the address card names a.base.win');
  ok(/Answering at a\.base\.win/.test(setupText), 'its own address answers');
  await look(page, '09-setup-all-cards');
  await page.click('summary:has-text("More")');
  await look(page, '09b-setup-render-yaml');

  // 3. The sample's address, from the list.
  await page.goto(`${B}/`);
  await page.fill('#sample-url', 'http://127.0.0.1:5602');
  await page.click('button:has-text("Set its address")');
  await page.waitForURL(/\/c\/sample$/);
  ok(/Answering/.test(await text(page)) || /<dd>Yes/.test(await page.content()), 'the sample answers');
  await page.goto(`${B}/`);
  await look(page, '10-campaigns-healthy');

  // 4. Open desk on a, and on the sample: new tabs on their own addresses.
  await page.goto(`${B}/c/a`);
  await look(page, '11-one-campaign');
  const tabA = await newTab(() => page.click('form[action="/c/a/open"] button'));
  await land(tabA, 'http://127.0.0.1:5601/admin/');
  ok(/You’re in as base\.win support/.test(await text(tabA)), 'Open desk on a: the banner, on 5601');
  ok(!tabA.url().includes('#t='), 'no token left in the address');
  await tabA.close();
  await page.goto(`${B}/c/sample`);
  const tabS = await newTab(() => page.click('form[action="/c/sample/open"] button'));
  await land(tabS, 'http://127.0.0.1:5602/admin/');
  ok(/You’re in as base\.win support/.test(await text(tabS)), 'Open desk on the sample: the banner, on 5602');
  await tabS.close();

  // 5. A stale code: Type your code in the new tab, then the desk in that same tab.
  await db.query("update ops_sessions set code_at = now() - interval '11 minutes'");
  await page.goto(`${B}/c/a`);
  const before = ctx.pages().length;
  const tabC = await newTab(() => page.click('form[action="/c/a/open"] button'));
  await tabC.waitForSelector('h1:has-text("Type your code")');
  await look(tabC, '12-type-your-code');
  await tabC.fill('#code', await code());
  await tabC.click('.btn-primary');
  await land(tabC, 'http://127.0.0.1:5601/admin/');
  ok(/You’re in as base\.win support/.test(await text(tabC)), 'after the code, the desk opens in the same tab');
  ok(ctx.pages().length === before + 1, 'no third tab');
  await tabC.close();

  // 6. Invite the first manager, on a fresh campaign server.
  a.reset();
  await page.goto(`${B}/c/a`);
  await page.fill('#invite-a', 'sam@example.org');
  const tabI = await newTab(() => page.click('button:has-text("Invite and open the desk")'));
  await land(tabI, 'http://127.0.0.1:5601/admin/settings/members');
  ok(/Invited sam@example\.org/.test(await text(tabI)), 'Members shows the invite');
  await tabI.close();
  await page.reload();
  const campaignText = (await text(page)).replace(/\s+/g, ' ');
  ok(/First manager invited Done by itself/.test(campaignText), 'the checklist: First manager invited · Done by itself');
  ok(/Its own address answers: a\.base\.win Done by itself/.test(campaignText), 'the checklist: its own address answers');
  await look(page, '13-one-campaign-invited');

  // 7. A server that says it is somewhere else.
  await page.goto(`${B}/c/sample/edit`);
  await look(page, '14-edit');
  await page.fill('#server_url', 'http://127.0.0.1:5605');
  await page.click('.btn-primary');
  await page.waitForURL(/\/c\/sample$/);
  ok(/This server says it is somewhere else/.test(await text(page)), 'the chip and the line');
  ok(await page.locator('form[action="/c/sample/open"]').count() === 0, 'no Open button');
  await look(page, '15-one-campaign-elsewhere', { primaries: 0 });
  await page.goto(`${B}/`);
  await look(page, '16-campaigns-with-chip');

  // 7b. A real campaign server, fresh: Campaign made waits for the first entry.
  await page.goto(`${B}/new`);
  await page.fill('#name', 'b');
  await page.fill('#display', 'Example B');
  await page.fill('#city', 'Exampleton');
  await page.selectOption('#province', 'BC');
  await page.click('.btn-primary');
  await page.waitForURL(/\/c\/b\/setup$/);
  await page.fill('#server_url', REAL);
  await page.click('button:has-text("Save address")');
  await page.waitForURL(/\/c\/b\/setup$/);
  ok(/Answering/.test(await text(page)), 'the real server answers');
  const freshHealth = await fetch(`${REAL}/api/health`).then((r) => r.json());
  ok(freshHealth.setupOpen === false && freshHealth.campaignMade === false, 'the fresh real server: sign-up closed, no campaign yet');
  await page.goto(`${B}/c/b`);
  await page.click('form[action="/c/b/check-now"] button');
  await page.waitForURL(/\/c\/b$/);
  ok(!/Campaign made Done by itself/.test((await text(page)).replace(/\s+/g, ' ')), 'the checklist: Campaign made not ticked before any entry');
  await page.fill('#invite-b', 'kim@example.org');
  const tabB = await newTab(() => page.click('button:has-text("Invite and open the desk")'));
  try { await tabB.waitForURL(`${REAL}/admin/settings/members`, { timeout: 15_000 }); } catch (e) {
    console.log(`  at ${tabB.url()}: ${(await tabB.textContent('body').catch(() => '')).trim().slice(0, 300)}\n${realLog.slice(-1500)}`);
    throw e;
  }
  await tabB.waitForSelector('text=You’re in as base.win support', { timeout: 10_000 });
  ok(true, 'Invite and open the desk on the real server: the banner');
  await tabB.waitForSelector('text=kim@example.org', { timeout: 10_000 }).then(() => ok(true, 'the real desk shows the invite'), () => fail('the real desk shows the invite'));
  await tabB.close();
  ok((await fetch(`${REAL}/api/health`).then((r) => r.json())).campaignMade === true, 'the first entry made the campaign');
  await page.goto(`${B}/c/b`);
  await page.click('form[action="/c/b/check-now"] button');
  await page.waitForURL(/\/c\/b$/);
  const bText = (await text(page)).replace(/\s+/g, ' ');
  ok(/Campaign made Done by itself/.test(bText), 'the checklist: Campaign made, once the server says so');
  ok(/First manager invited Done by itself/.test(bText), 'the checklist: First manager invited (real server)');
  await look(page, '16b-one-campaign-real-server');

  await page.goto(`${B}/existing`);
  await look(page, '17-add-running');
  await page.goto(`${B}/key`);
  ok((await page.textContent('#key-value')).trim() === KEY, 'base.win’s key');
  await look(page, '18-key');

  // 8. The log.
  await page.goto(`${B}/log`);
  const logText = await text(page);
  ok(/Log intact · \d+ lines/.test(logText), 'Log intact');
  for (const words of ['Set up the control centre', 'Made the campaign', 'Recognised the production server', 'Recognised the staging server',
    'Opened the production desk', 'Opened the staging desk', 'Typed a fresh code', 'Invited the first manager and opened the production desk']) {
    ok(logText.includes(words), `log: ${words}`);
  }
  await look(page, '19-log', { primaries: 0 });

  // 9. Sign out, then in with a recovery code.
  await page.click('button:has-text("Sign out")');
  await page.waitForURL(/\/signin$/);
  await page.fill('#email', 'owner@example.org');
  await page.fill('#password', 'a long test password 1');
  await page.fill('#code', recovery[0]);
  await page.click('.btn-primary');
  await page.waitForURL(`${B}/`);
  ok(/Campaigns/.test(await text(page)), 'a recovery code signs in');
  ok((await db.query("select count(*)::int n from ops_log where action = 'recovery.used'")).rows[0].n === 1, 'the recovery code is logged');

  ok(errors.length === 0, `no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  ok(a.state.refused.length === 0 && sample.state.refused.length === 0, 'the campaign side refused no token');
} catch (e) {
  fail(`threw: ${e.stack || e}`);
} finally {
  await browser.close();
  platform.close();
  door.close();
  await Promise.all([a.close(), sample.close(), liar.close()]);
  try { real.kill('SIGTERM'); } catch { /* gone */ }
  await db.close();
}
console.log(failures ? `${failures} failed` : 'e2e-ops: all passed');
process.exit(failures ? 1 : 0);
