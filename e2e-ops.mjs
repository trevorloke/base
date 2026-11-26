// base.win's control centre (apps/platform), in a real browser.
//
// The owner sets it up (the setup code, about you, the authenticator with a
// code made from the key on the page, the recovery codes), lands on an
// empty Campaigns with both ways in, makes campaign "a" (its map area; its
// .env block's two random values filled by the page's own script, its own
// address a.base.win, no opponents, nothing of the door), pastes its
// address (Answering) and gets the card that gives it its own address:
// a.base.win isn't answering yet (said on the card and as a chip), then it
// is and the checklist ticks by itself; with no signing key the block is
// replaced by the key page's warning; sets the sample's address; opens
// both desks in new tabs, each landing on that campaign's own address with
// "You’re in as base.win support"; with a code more than 10 minutes old,
// Open asks for a code in the new tab and opens the desk in that same tab
// (no third tab); the chips for the built-in database, open sign-up and a
// Promote that is waiting come and go with what the servers say; invites
// the first manager (the invite shows on Members, the checklist says "Done
// by itself"); a server reporting another address shows "This server says
// it is somewhere else" and no Open; on a real campaign server
// (node server/index.js, fresh, holding base.win's key) Campaign made stays
// unticked until Invite and open the desk makes the campaign, and the desk
// opens with the invite on Members; a campaign that was already running is
// added and its set-up page is the short one; the log is intact with every
// kind of line; and a recovery code signs in. Screens at 1440x900 and
// 390x844: one primary button at most (exactly one where the screen has a
// main action), controls at least 48 px on the phone, no sideways scroll.
// Then, with a Render key set mid-run and a stand-in for Render's API
// (apps/platform/test/fake-render.mjs): Render in the menu says Connected;
// Check Render’s answers; Connect the sample and campaign a; a's page names
// BASE_PLATFORM_PUBKEY as missing; Set base.win’s key, Restart (a code even
// inside a fresh 10-minute window), Add its address and Close the database,
// each through a page that says what will happen and asks for a code;
// Render down shows one line of words and the rest is as before.
//
// Ports 5600–5609: 5600 the console (in this process, so the test can age
// the code in its database), 5601 campaign "a" (production), 5602 the
// sample (staging), 5603 every client's public address (a stand-in for
// https://<name>.base.win: /a is campaign a's server, as a custom domain on
// its service would be), 5604 campaign "c" (already running), 5605 a
// server that says it is 5601, 5606 campaign "b" — a real campaign server
// (node server/index.js, in memory; needs npm run build). 5601, 5602, 5604
// and 5605 are apps/platform/test/fake-client.mjs, which checks each token
// with the campaign side's rules; "b" checks them with its own. 5608 is the
// stand-in for Render's API (only once the first part has run with no key).
//
// Run (system node, under the browser lock):
//   flock -o SP/batch6/locks/browser.lock node e2e-ops.mjs
//   SHOTS=<dir> to keep the screenshots elsewhere.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

// The fixtures here are Imagine Surrey's, so the server runs as its production
// does (render.yaml sets this brand); a brand set by hand is left as set.
if (process.env.STARBASE_BRAND === undefined) process.env.STARBASE_BRAND = 'imagine-surrey';

const ROOT = new URL('.', import.meta.url).pathname;
Object.assign(process.env, {
  OPS_HOST: '127.0.0.1:5600', OPS_INSECURE_COOKIES: '1', OPS_ALLOW_LOCAL: '1', OPS_PUBLIC_TEMPLATE: 'http://127.0.0.1:5603/{name}',
  OPS_SETUP_CODE: 'e2e-ops-setup-code-0123456789abcdef', OPS_SECRET: 'e2e-ops-secret-0123456789abcdefghijk',
  PLATFORM_SIGNING_KEY: 'test-only-platform-signing-key-0123456789abcdef',
});
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { serve } = await import('@hono/node-server');
const { openDb } = await import(`${ROOT}apps/platform/db.mjs`);
const { makeApp } = await import(`${ROOT}apps/platform/server.mjs`);
const { publicKeyOf } = await import(`${ROOT}apps/platform/keys.mjs`);
const { startFakeClient, startPublicAddresses } = await import(`${ROOT}apps/platform/test/fake-client.mjs`);
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
const a = startFakeClient({ port: 5601, env: 'production', publicKey: KEY, address: 'http://127.0.0.1:5603/a' });
const sample = startFakeClient({ port: 5602, env: 'staging', publicKey: KEY });
const running = startFakeClient({ port: 5604, env: 'production', publicKey: KEY, address: 'http://127.0.0.1:5603/c' });
const liar = startFakeClient({ port: 5605, env: 'staging', publicKey: KEY, ownOrigin: 'http://127.0.0.1:5601' });
// Campaign "b": a real, fresh campaign server holding base.win's key, as New campaign sets one up.
const REAL = 'http://127.0.0.1:5606';
// Each client's own address (<name>.base.win), all on one port. Campaign
// a's isn't there yet: its custom domain is added during the run.
const addresses = startPublicAddresses({ port: 5603, clients: { a: 'http://127.0.0.1:5601', b: REAL, c: 'http://127.0.0.1:5604' } });
addresses.down.add('a');
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
    console.log(`  at ${tab.url()}: ${(await tab.textContent('body').catch(() => '')).trim().slice(0, 300)}; refused: ${[...a.state.refused, ...sample.state.refused, ...running.state.refused].join(', ')}`);
    throw e;
  }
};
// Check now on one campaign's page, and its words on one line.
const checkNow = async (name) => {
  await page.goto(`${B}/c/${name}`);
  await page.click(`form[action="/c/${name}/check-now"] button`);
  await page.waitForURL(new RegExp(`/c/${name}$`));
  return (await text(page)).replace(/\s+/g, ' ');
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
  // The map area, as Google Maps copies each corner.
  await page.fill('#sw', '50.61234567, -120.51234567');
  await page.fill('#ne', '50.8, -120.2');
  await page.click('.btn-primary');
  await page.waitForURL(/\/c\/a\/setup$/);
  const randoms = await page.$$eval('[data-random]', (els) => els.map((e) => e.textContent));
  ok(randoms.length === 2 && randoms.every((r) => /^[A-Za-z0-9_-]{43}$/.test(r)) && randoms[0] !== randoms[1], 'the .env block’s two random values, made by the page');
  const block = (await page.textContent('#env-block')).split('\n');
  ok(block.includes(`BASE_PLATFORM_PUBKEY=${KEY}`), 'the .env block carries base.win’s key');
  ok(block.includes('STARBASE_PUBLIC_URL=https://a.base.win'), 'the .env block: its own address, a.base.win');
  ok(block.includes('STARBASE_GEO_BOUNDS=50.61235,-120.51235|50.8,-120.2'), 'the .env block: the map area typed');
  ok(block.includes('STARBASE_CANDIDATES=none'), 'the .env block: no opponents');
  ok(!/BASE_PATH|BASE_DOOR_KEY|BASE_CLIENTS|base\.win\//.test(block.join('\n')) && !/BASE_DOOR_KEY|the door/i.test(await text(page)), 'nothing of the door on the page');
  await look(page, '08-setup-before-address');
  // No usable signing key: the key page's warning where the block would be.
  const signing = process.env.PLATFORM_SIGNING_KEY;
  process.env.PLATFORM_SIGNING_KEY = '';
  await page.reload();
  ok(/PLATFORM_SIGNING_KEY in Render is missing or too short\./.test(await text(page)) && await page.locator('#env-block').count() === 0
    && !/BASE_PLATFORM_PUBKEY=/.test(await text(page)), 'no signing key: the warning, and no block with an empty key');
  await look(page, '08b-setup-no-signing-key');
  process.env.PLATFORM_SIGNING_KEY = signing;
  await page.reload();
  ok(await page.locator('#env-block').count() === 1, 'the block is back with the key');
  await page.fill('#server_url', 'http://127.0.0.1:5601');
  await page.click('button:has-text("Save address")');
  await page.waitForURL(/\/c\/a\/setup$/);
  const setupText = (await text(page)).replace(/\s+/g, ' ');
  ok(/Answering/.test(setupText), 'the address answers');
  ok(/Give it its address/.test(setupText) && /Settings → Custom Domains → add a\.base\.win\./.test(setupText), 'the address card: add a.base.win under Custom Domains');
  ok(/add a CNAME record named a pointing at 127\.0\.0\.1:5601\./.test(setupText), 'the address card: the CNAME record, pointing at the service’s own address');
  ok(/Not answering at a\.base\.win yet\./.test(setupText), 'the address card: a.base.win not answering yet');
  ok(await page.locator('#door-value').count() === 0 && !/Tell the door|BASE_CLIENTS/.test(setupText), 'no door card');
  await look(page, '09-setup-all-cards');
  await page.click('summary:has-text("More")');
  const yaml = await page.textContent('#yaml-snippet');
  ok(/plan: basic-1gb/.test(yaml) && !/BASE_DOOR_KEY|BASE_PATH/.test(yaml) && /value: "https:\/\/a\.base\.win"/.test(yaml), 'the render.yaml block: the database plan, its own address, nothing of the door');
  await look(page, '09b-setup-render-yaml');
  // Before the custom domain is there: a chip; once it is, the checklist ticks by itself.
  let aText = await checkNow('a');
  ok(/a\.base\.win not answering/.test(aText) && /Answers at a\.base\.win Not yet/.test(aText), 'a.base.win not answering: the chip, and not ticked');
  await look(page, '09c-one-campaign-address-not-answering');
  addresses.down.delete('a');
  aText = await checkNow('a');
  ok(!/a\.base\.win not answering/.test(aText) && /Answers at a\.base\.win Done by itself/.test(aText), 'a.base.win answers: no chip, ticked by itself');
  await page.goto(`${B}/c/a/setup`);
  ok(/Answering at a\.base\.win/.test(await text(page)), 'the address card: Answering at a.base.win');

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

  // 5b. What the servers say shows as chips, and goes when it is put right.
  a.state.over = { store: 'embedded', setupOpen: true, campaignMade: false };
  sample.state.over = { commit: 'abc1234def5678' };
  await checkNow('sample');
  aText = await checkNow('a');
  ok(/Not on a real database/.test(aText), 'chip: Not on a real database');
  ok(/Sign-up is open to anyone/.test(aText), 'chip: Sign-up is open to anyone');
  ok(/Production is on f00dfee; staging is on abc1234/.test(aText), 'chip: Production is on f00dfee; staging is on abc1234');
  ok(/Database\s*Built in: not a real database/.test(aText), 'Health: the database is the built-in one');
  await look(page, '12b-one-campaign-chips');
  await page.goto(`${B}/`);
  ok(/Not on a real database/.test(await text(page)), 'the chips show on Campaigns too');
  await look(page, '12c-campaigns-chips');
  a.state.over = {};
  sample.state.over = {};
  await checkNow('sample');
  aText = await checkNow('a');
  ok(!/Not on a real database|Sign-up is open to anyone|Production is on/.test(aText) && await page.locator('.chip').count() === 0, 'put right: the chips are gone');

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
  ok(/Answers at a\.base\.win Done by itself/.test(campaignText), 'the checklist: Answers at a.base.win');
  ok(!/door|Short address/i.test(campaignText), 'the checklist: nothing of the door');
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
  await page.fill('#sw', '50.6, -120.5');
  await page.fill('#ne', '50.8, -120.2');
  await page.click('.btn-primary');
  await page.waitForURL(/\/c\/b\/setup$/);
  await page.fill('#server_url', REAL);
  await page.click('button:has-text("Save address")');
  await page.waitForURL(/\/c\/b\/setup$/);
  ok(/Answering/.test(await text(page)), 'the real server answers');
  const freshHealth = await fetch(`${REAL}/api/health`).then((r) => r.json());
  ok(freshHealth.setupOpen === false && freshHealth.campaignMade === false, 'the fresh real server: sign-up closed, no campaign yet');
  const bBefore = await checkNow('b');
  ok(!/Campaign made Done by itself/.test(bBefore), 'the checklist: Campaign made not ticked before any entry');
  ok(/Answers at b\.base\.win Done by itself/.test(bBefore), 'the checklist: Answers at b.base.win (the real server, at its own address)');
  ok(!/Sign-up is open to anyone/.test(bBefore), 'the real server holds base.win’s key: sign-up is not open');
  // A campaign server that says where it keeps its data: in memory is not a real database.
  ok(freshHealth.store === 'embedded', `the real server, in memory, says store: embedded (it said ${JSON.stringify(freshHealth.store)})`);
  ok(/Not on a real database/.test(bBefore) && /Answers, database fine Not yet/.test(bBefore), 'the real server, in memory: Not on a real database, and not ticked');
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
  const bText = await checkNow('b');
  ok(/Campaign made Done by itself/.test(bText), 'the checklist: Campaign made, once the server says so');
  ok(/First manager invited Done by itself/.test(bText), 'the checklist: First manager invited (real server)');
  await look(page, '16b-one-campaign-real-server');

  // 7c. A campaign that was already running: added, and its set-up page is the short one.
  await page.goto(`${B}/existing`);
  await look(page, '17-add-running');
  ok(/It’s the address: <name>\.base\.win\./.test(await text(page)), 'the short name is the address: <name>.base.win');
  await page.fill('#name', 'c');
  await page.fill('#display', 'Example Running');
  await page.fill('#server_url', 'http://127.0.0.1:5604');
  await page.click('.btn-primary');
  await page.waitForURL(/\/c\/c$/);
  ok(/Answers at c\.base\.win Done by itself/.test((await text(page)).replace(/\s+/g, ' ')), 'the running campaign answers at c.base.win');
  await page.click('summary:has-text("More")');
  await page.click('a:has-text("Set-up steps")');
  await page.waitForURL(/\/c\/c\/setup$/);
  const runningText = (await text(page)).replace(/\s+/g, ' ');
  ok(/its settings live in Render/.test(runningText), 'the running campaign’s set-up page says its settings live in Render');
  ok((await page.textContent('#key-line')).trim() === `BASE_PLATFORM_PUBKEY=${KEY}`, 'it shows the one line to add: base.win’s key');
  ok(/Custom Domains → add c\.base\.win\./.test(runningText) && /Answering at c\.base\.win/.test(runningText), 'and the address step, answering');
  ok(await page.locator('#env-block, #yaml-snippet, [data-random]').count() === 0 && !/STARBASE_|GOOGLE_TOKEN_KEY|undefined/.test(runningText), 'none of the campaign’s settings, no random keys');
  await look(page, '17b-setup-running-campaign', { primaries: 0 });
  await page.goto(`${B}/key`);
  ok((await page.textContent('#key-value')).trim() === KEY, 'base.win’s key');
  await look(page, '18-key');

  // 8. The log.
  await page.goto(`${B}/log`);
  const logText = await text(page);
  ok(/Log intact · \d+ lines/.test(logText), 'Log intact');
  for (const words of ['Set up the control centre', 'Made the campaign', 'Added a campaign that was already running', 'Recognised the production server', 'Recognised the staging server',
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
  ok(a.state.refused.length === 0 && sample.state.refused.length === 0 && running.state.refused.length === 0, 'the campaign side refused no token');

  // 10. Render, with a key (everything above ran without one: exactly as before).
  // The key and Render's stand-in arrive mid-run (settings are read on each
  // request): a stand-in for Render's API on 5608, holding a made-up
  // workspace with staging's service at the sample's address and campaign
  // a's service at a's.
  const { fakeWorld, startFakeRender, KEY: RENDER_KEY, IDS: RENDER_IDS } = await import(`${ROOT}apps/platform/test/fake-render.mjs`);
  const world = fakeWorld();
  world.service('base-win-staging').serviceDetails.url = 'http://127.0.0.1:5602';
  world.service('base-win-a').serviceDetails.url = 'http://127.0.0.1:5601';
  const beforeKey = await page.goto(`${B}/render`);
  ok(beforeKey.status() === 404 && await page.locator('.oc-nav a[href="/render"]').count() === 0, 'no key: no Render page, and (above) no Render in the menu');
  for (let i = errors.length - 1; i >= 0; i--) if (/\/render: Failed to load resource: .* 404/.test(errors[i])) errors.splice(i, 1);
  const fakeRender = await startFakeRender({ port: 5608, world });
  try {
    // The sample back at its own address (step 7 pointed it at a server that says it is somewhere else).
    await page.goto(`${B}/c/sample/edit`);
    await page.fill('#server_url', 'http://127.0.0.1:5602');
    await page.click('.btn-primary');
    await page.waitForURL(/\/c\/sample$/);
    Object.assign(process.env, { RENDER_API_KEY: RENDER_KEY, RENDER_SERVICE_ID: RENDER_IDS.platform, OPS_RENDER_API: 'http://127.0.0.1:5608/v1' });
    const flat = async (p = page) => (await text(p)).replace(/\s+/g, ' ');
    // One change, as the owner makes it: the button, the page that says what
    // will happen (one primary, a Code field), a code typed for it.
    const confirm = async (what, name, shot = null) => {
      await page.click(`form[action="/c/${name}/render/${what}"] button`);
      await page.waitForSelector('#code');
      ok(await page.locator('.btn-primary').count() === 1 && await page.locator('input[name="job"]').count() === 1, `${what} on ${name}: a page that says what will happen, one primary, a code`);
      if (shot) await look(page, shot);
      await page.fill('#code', await code());
      await page.click('.btn-primary');
      await page.waitForURL(new RegExp(`/c/${name}/render$`));
      return flat();
    };

    await page.goto(`${B}/`);
    ok(await page.locator('.oc-nav a[href="/render"]').count() === 1, 'with a key: Render is in the menu');
    await page.click('.oc-nav a[href="/render"]');
    await page.waitForURL(/\/render$/);
    let board = await flat();
    ok(/Connected to Render: base\.win/.test(board), 'Render says Connected');
    ok(/Sample \(staging\) Not connected/.test(board) && /Example Campaign Not connected/.test(board), 'the board lists each campaign, not connected yet');
    await look(page, '20-render-board', { primaries: 0 });
    await page.click('button:has-text("Check Render’s answers")');
    await page.waitForSelector('h1:has-text("Check Render’s answers")');
    ok((await page.locator('dd', { hasText: 'As expected' }).count()) === 5 && /Connect Sample \(staging\) to check the rest/.test(await flat()), 'Check Render’s answers: the five reads that need no campaign are as expected');

    // Connect the sample, then campaign a.
    await page.goto(`${B}/render`);
    let now = await confirm('link', 'sample', '21-render-confirm-connect');
    ok(/Staging: made-up data only\./.test(now) && /Service\s*base-win-staging · main branch/.test(now), 'the sample is connected to staging’s service: made-up data only');
    await page.goto(`${B}/c/a`);
    await page.click('a:has-text("Render: service, deploys, database")');
    await page.waitForURL(/\/c\/a\/render$/);
    ok(/Not connected/.test(await flat()), 'campaign a: not connected yet');
    await look(page, '22-render-not-connected');
    now = await confirm('link', 'a');
    ok(/Service\s*base-win-a · production branch · Starter · Oregon · deploys by itself/.test(now), 'campaign a is connected to its own service');
    ok(/Settings\s*Missing: BASE_PLATFORM_PUBKEY/.test(now), 'a’s page names BASE_PLATFORM_PUBKEY as missing');
    ok(/Addresses\s*a\.base\.win · Not added yet/.test(now) && /Open to anyone on the internet/.test(now), 'and its address not added, its database open');
    await look(page, '23-render-campaign', { primaries: 0 });
    await page.goto(`${B}/render`);
    await page.click('button:has-text("Check Render’s answers")');
    await page.waitForSelector('h1:has-text("Check Render’s answers")');
    ok((await page.locator('dd', { hasText: 'As expected' }).count()) === 10 && /Every answer is as expected\./.test(await flat()), 'Check Render’s answers: all ten reads, against staging, as expected');
    await look(page, '24-render-check', { primaries: 0 });

    // A campaign Render doesn't have at its address: Connect is refused, nothing changes.
    await page.goto(`${B}/c/c/render`);
    await page.click('form[action="/c/c/render/link"] button');
    await page.waitForSelector('h1:has-text("Nothing was changed")');
    ok(/No service in Render has this campaign’s address: check the address on Edit\./.test(await flat()), 'a campaign with no service at its address: Connect is refused in words');
    await look(page, '25-render-refused', { primaries: 0 });
    for (let i = errors.length - 1; i >= 0; i--) if (/Failed to load resource: .* 409/.test(errors[i])) errors.splice(i, 1);

    // Set base.win's key → Deploying → Nothing missing.
    await page.goto(`${B}/c/a/render`);
    now = await confirm('key', 'a', '26-render-confirm-key');
    ok(/Last deploy\s*Deploying/.test(now) && /Settings\s*Nothing missing/.test(now), 'Set base.win’s key: Deploying, then Nothing missing');
    ok(world.settingsOf(RENDER_IDS.a).BASE_PLATFORM_PUBKEY === KEY, 'Render holds base.win’s public key for a, and nothing else changed there');
    world.finishDeploys(RENDER_IDS.a);
    // Restart: the 10-minute window is fresh, and it still asks for a code.
    const age = (await db.query('select extract(epoch from now() - code_at)::float8 as s from ops_sessions order by code_at desc limit 1')).rows[0].s;
    await page.click('form[action="/c/a/render/restart"] button');
    await page.waitForSelector('h1:has-text("Restart")');
    ok(age < 600 && await page.locator('#code[required]').count() === 1, `Restart inside a fresh 10-minute window (${Math.round(age)} s) still asks for a code`);
    await page.fill('#code', await code());
    await page.click('.btn-primary');
    await page.waitForURL(/\/c\/a\/render$/);
    ok(/Render did it\./.test(await flat()) && world.restarts.length === 1, 'Restart: Render did it, once');
    now = await confirm('domain', 'a');
    ok(/Addresses\s*a\.base\.win · Waiting for the DNS record/.test(now), 'Add its address: Waiting for the DNS record');
    now = await confirm('close-db', 'a', '27-render-confirm-close');
    ok(/Closed to the internet/.test(now) && !/Open to anyone on the internet/.test(now), 'Close the database: Closed to the internet');
    await look(page, '28-render-campaign-after', { primaries: 0 });
    await page.goto(`${B}/render`);
    board = await flat();
    ok(/Example Campaign: a\.base\.win is waiting for its DNS record/.test(board) && !/Example Campaign: its database is open/.test(board), 'the board: what still needs a look on a');
    await look(page, '29-render-board-connected', { primaries: 0 });

    // Render down: one line of words; the rest of the console as before.
    world.down();
    await page.click('button:has-text("Check Render’s answers")');
    await page.waitForSelector('h1:has-text("Check Render’s answers")');
    ok(/Render didn’t answer/.test(await flat()) && (await page.locator('dd', { hasText: 'As expected' }).count()) === 0, 'Render down: Check Render’s answers says so');
    await page.goto(`${B}/c/a/render`);
    ok(/Render didn’t answer\. The rest of this page is as usual\./.test(await flat()) && await page.locator('form[action="/c/a/render/restart"]').count() === 0, 'Render down: the words, and no buttons');
    await look(page, '30-render-down', { primaries: 0 });
    const aAsBefore = await checkNow('a');
    ok(/Answering\s*Yes/.test(aAsBefore) && /Answers at a\.base\.win Done by itself/.test(aAsBefore) && await page.locator('form[action="/c/a/open"]').count() === 1, 'Render down: the campaign page is as before, Open desk and all');
    world.up();

    // The log: intact, with the new lines in words.
    await page.goto(`${B}/log`);
    const renderLog = await text(page);
    ok(/Log intact · \d+ lines/.test(renderLog), 'Log intact, after the Render changes');
    for (const words of ['Connected to Render: base-win-staging and base-win-staging-db', 'Connected to Render: base-win-a and base-win-a-db', 'Asked Render to set base.win’s key',
      'Asked Render to restart the server', 'Asked Render to add a.base.win', 'Asked Render to close the database to the internet', 'Render did it']) {
      ok(renderLog.includes(words), `log: ${words}`);
    }
    ok(world.forbidden.length === 0, `Render was asked for nothing forbidden${world.forbidden.length ? `: ${world.forbidden.join(' | ')}` : ''}`);
    ok(world.received.length > 30 && world.received.every((r) => r.auth === `Bearer ${RENDER_KEY}`), 'every request to Render carried the key');
    const sentOut = world.received.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.path}`);
    ok(sentOut.length === 5 && sentOut.every((line) => line.includes(RENDER_IDS.a) || line.includes(RENDER_IDS.aDb)), `five changes went to Render, all to campaign a’s service and database (${sentOut.join(', ')})`);
    ok(!(await page.content()).includes(RENDER_KEY) && !JSON.stringify((await db.query('select * from render_jobs')).rows).includes(RENDER_KEY), 'the key is on no page and in no row');
    ok(errors.length === 0, `no console errors with Render${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  } finally {
    await fakeRender.close();
    for (const k of ['RENDER_API_KEY', 'RENDER_SERVICE_ID', 'OPS_RENDER_API']) delete process.env[k];
  }
} catch (e) {
  fail(`threw: ${e.stack || e}`);
} finally {
  await browser.close();
  platform.close();
  await Promise.all([a.close(), sample.close(), running.close(), liar.close(), addresses.close()]);
  try { real.kill('SIGTERM'); } catch { /* gone */ }
  await db.close();
}
console.log(failures ? `${failures} failed` : 'e2e-ops: all passed');
process.exit(failures ? 1 : 0);
