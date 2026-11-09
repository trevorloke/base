// base.win, one product: the name, two-step sign-in and the command bar.
//
// A manager signs up and finds every desk screen says base.win — never
// Ground, Web or Air — with no app switcher. The command bar, keyboard
// only: Ctrl+K opens it (a combobox: ↑ ↓ move, Enter opens, Esc closes and
// focus goes back), "don" → Donations, "gift" → Log a gift with its form
// open, a name or a phone typed any way → the person's profile; a staffer
// without Donations is never offered it, and the field app has no command
// bar. Two-step sign-in: the manager turns it on in Your profile (QR code,
// the key, a wrong code refused, the right one, ten recovery codes shown
// once); sign-in then asks for the code (wrong, then right), and a recovery
// code works once. The manager requires it for desk roles: a staffer
// already signed in is stopped at the set-up until it's on; a volunteer
// signs in with a password as before. The manager resets the staffer's
// (they're signed out, and set it up again at sign-in). Phones: no
// sideways scroll; screenshots of every new screen, desktop and phone.
//
//   STARBASE_OPEN_SIGNUP=1 STARBASE_DATA=memory PORT=4150 node server/index.js &
//   BASE=http://127.0.0.1:4150 SHOTS=/tmp/platform node e2e-platform.mjs
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { base32Decode, hotp, totpStep } from './server/lib/twostep.js';

const BASE = process.env.BASE || 'http://localhost:3200';
const SHOTS = process.env.SHOTS || '/tmp/starbase-platform';
mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 260) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Date.now().toString(36);
const PASSWORD = 'surrey-forward-2026';
const OLD = /\bGround\b|\bAir\b|\bWeb\b|Base Web|Starsign/;
const DESKTOP = { width: 1360, height: 900 };
const PHONE = { width: 390, height: 844 };

// A code from the app: the step after the last one used (a code works once),
// never ahead of the clock by more than one — wait for it otherwise.
const used = {};
const codeFor = async (who, key) => {
  for (;;) {
    const now = totpStep(Date.now());
    const step = used[who] == null ? now : Math.max(used[who] + 1, now);
    if (step <= now + 1) { used[who] = step; return hotp(base32Decode(key), step); }
    await sleep(1000);
  }
};

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const errors = [];
const newPage = async (viewport = DESKTOP, label = 'manager') => {
  const ctx = await browser.newContext({ viewport, timezoneId: 'America/Vancouver', ...(viewport === PHONE ? { isMobile: true, hasTouch: true } : {}) });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`[${label}] ${e.message}`));
  return { ctx, page };
};
const { ctx, page } = await newPage();
const api = (p, path, body) => p.evaluate(async ([u, b]) => {
  const r = await fetch(`/api${u}`, b === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  return { status: r.status, json: await r.json().catch(() => null) };
}, [path, body]);
const shot = (p, name, full = false) => p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: full });
const noSideways = async (p) => p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const text = async (p, sel = 'body') => ((await p.innerText(sel).catch(() => '')) || '').replace(/\s+/g, ' ');
const signIn = async (p, email) => {
  await p.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await p.fill('#login-email', email);
  await p.fill('#login-password', PASSWORD);
  await p.click('button[type="submit"]');
};
const signOut = async (p) => {
  await p.click('.acct-btn');
  await p.getByRole('button', { name: 'Sign out' }).click();
  await p.waitForURL(/\/login$/, { timeout: 10000 });
};

// ── The manager signs up ──
await page.goto(`${BASE}/signup`, { waitUntil: 'domcontentloaded' });
await page.fill('#su-name', 'Rae Example');
if (await page.locator('#su-org').count()) await page.fill('#su-org', 'Imagine Surrey');
const mgrEmail = `rae.${tag}@example.org`;
await page.fill('#su-email', mgrEmail);
await page.fill('#su-password', PASSWORD);
await page.click('button[type="submit"]');
await page.waitForURL(/\/admin\/?$/, { timeout: 15000 });
await page.waitForSelector('.brand-name');
const lena = (await api(page, '/actions/person.create', { name: 'Lena Example', phone: '604-555-0142', email: `lena.${tag}@example.org` })).json.person;
check('a person to find later', Boolean(lena?.id));

// ── One name: base.win ──
check('the desk says base.win, the campaign under it', (await page.innerText('.brand-name')).trim() === 'base.win' && /Imagine Surrey/.test(await page.innerText('.brand-org')));
check('no app switcher', (await page.locator('.apps-btn, .apps-panel').count()) === 0);
const SCREENS = ['/', '/map', '/people', '/shifts', '/money', '/signs', '/outreach/email', '/imagineu', '/lists', '/reports', '/data',
  '/settings', '/settings/teams', '/settings/permissions', '/settings/services', '/settings/campaign', '/rating-scale', '/profile', '/people/import'];
const said = [];
for (const s of SCREENS) {
  await page.goto(`${BASE}/admin${s === '/' ? '' : s}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('main.page h1, main.page .page-head, main.page .ops-head, main.page [class*="-page"]', { timeout: 10000 }).catch(() => {});
  await sleep(350);
  const t = await text(page);
  if (OLD.test(t)) said.push(`${s}: ${t.match(OLD)[0]}`);
}
check(`no desk screen says Ground, Web or Air (${SCREENS.length} screens)`, said.length === 0, said.join(' | '));
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.brand-name');
check('the field app says base.win; no switcher, no command bar there', (await page.innerText('.brand-name')).trim() === 'base.win'
  && !OLD.test(await text(page)) && (await page.locator('.apps-btn, .cmd-btn').count()) === 0);
await page.keyboard.press('Control+k');
await sleep(200);
check('Ctrl+K does nothing in the field app', (await page.locator('.cmd').count()) === 0);
const manifest = await (await ctx.request.get(`${BASE}/manifest.webmanifest`)).json();
check('installed, it is base.win', manifest.name === 'base.win' && manifest.short_name === 'base.win');
const sw = await (await ctx.request.get(`${BASE}/sw.js`)).text();
check('the offline page says base.win', /base\.win · offline/.test(sw) && !/Base · offline/.test(sw));

// ── The command bar, keyboard only ──
await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.cmd-btn');
const kbd = await page.innerText('.cmd-btn__kbd');
check('the Search button says its shortcut', /Ctrl K|⌘K/.test(kbd), kbd);
await page.locator('main.page').click({ position: { x: 5, y: 5 } }).catch(() => {});
await page.keyboard.press('Control+k');
await page.waitForSelector('.cmd [role="combobox"]');
const combo = page.locator('.cmd [role="combobox"]');
const a11y = await page.evaluate(() => {
  const i = document.activeElement;
  const list = document.getElementById(i.getAttribute('aria-controls'));
  return { focused: i.getAttribute('role'), expanded: i.getAttribute('aria-expanded'), list: list?.getAttribute('role'), modal: document.querySelector('.cmd').getAttribute('aria-modal'), label: i.getAttribute('aria-label') };
});
check('Ctrl+K opens it with the box focused: a combobox controlling a listbox, in a modal dialog',
  a11y.focused === 'combobox' && a11y.expanded === 'true' && a11y.list === 'listbox' && a11y.modal === 'true' && /Search/.test(a11y.label), JSON.stringify(a11y));
const empty = await page.$$eval('.cmd [role="option"]', (els) => els.map((e) => e.querySelector('.cmd-opt__label').textContent));
check('with nothing typed: the jobs, then the screens', empty[0] === 'Add person' && empty.includes('Log a gift') && empty.includes('Donations') && empty.includes('Members'), empty.slice(0, 10).join(', '));
await shot(page, '01-command-bar-desktop');
await combo.fill('don');
await sleep(150);
const activeLabel = () => page.evaluate(() => {
  const id = document.activeElement.getAttribute('aria-activedescendant');
  const el = id && document.getElementById(id);
  return el ? { label: el.querySelector('.cmd-opt__label').textContent, selected: el.getAttribute('aria-selected') } : null;
});
const first = await activeLabel();
check('"don": Donations first, highlighted (aria-activedescendant, aria-selected)', first?.label === 'Donations' && first.selected === 'true', JSON.stringify(first));
await page.keyboard.press('ArrowDown');
const second = await activeLabel();
await page.keyboard.press('ArrowUp');
const back = await activeLabel();
check('↓ moves the highlight, ↑ brings it back', second && second.label !== 'Donations' && back?.label === 'Donations', JSON.stringify([second, back]));
await page.keyboard.press('Enter');
await page.waitForURL(/\/admin\/money$/, { timeout: 8000 });
check('Enter opens Donations, and the box closes', (await page.locator('.cmd').count()) === 0, page.url());
await page.keyboard.press('Control+k');
await combo.fill('gift');
await sleep(150);
check('"gift": Log a gift first', (await activeLabel())?.label === 'Log a gift');
await page.keyboard.press('Enter');
await page.waitForURL(/\/admin\/money\?new=1$/, { timeout: 8000 });
await page.locator('form[aria-label="Log a gift"]').waitFor({ timeout: 8000 });
check('…and the gift form is open', await page.locator('form[aria-label="Log a gift"]').isVisible());
await page.keyboard.press('Control+k');
await combo.fill('Lena Exa');
await page.locator('.cmd-opt--person', { hasText: 'Lena Example' }).waitFor({ timeout: 8000 });
const groups = await page.$$eval('.cmd [role="group"]', (els) => els.map((e) => e.getAttribute('aria-label')));
check('a name: the People group, with their phone to tell them apart', groups.includes('People')
  && /604-555-0142/.test(await page.innerText('.cmd-opt--person')), groups.join(','));
await page.keyboard.press('Enter');
await page.waitForURL(new RegExp(`/admin/people/${lena.id}$`), { timeout: 8000 });
check('Enter opens their profile', true);
await page.keyboard.press('Control+k');
await combo.fill('604 555 0142');
await page.locator('.cmd-opt--person', { hasText: 'Lena Example' }).waitFor({ timeout: 8000 }).catch(() => {});
check('a phone typed with spaces finds them too', await page.locator('.cmd-opt--person', { hasText: 'Lena Example' }).count() === 1);
await combo.fill('ena Exam');
await page.locator('.cmd-opt--person', { hasText: 'Lena Example' }).waitFor({ timeout: 8000 }).catch(() => {});
check('the middle of a name: found by People’s own search when the quick one finds nobody', await page.locator('.cmd-opt--person', { hasText: 'Lena Example' }).count() === 1);
await combo.fill('604 555 0142');
await page.locator('.cmd-opt--person', { hasText: 'Lena Example' }).waitFor({ timeout: 8000 }).catch(() => {});
const status = await page.innerText('.cmd-status');
check('the result count is said (a polite live region)', /\d+ results?/.test(status) && (await page.getAttribute('.cmd-status', 'aria-live')) === 'polite', status);
await page.keyboard.press('Escape');
check('Esc closes it', (await page.locator('.cmd').count()) === 0);
await page.click('.cmd-btn');
await page.waitForSelector('.cmd');
await page.keyboard.press('Tab');
const tabbed = await page.evaluate(() => document.activeElement.className);
await page.keyboard.press('Tab');
const tabbedBack = await page.evaluate(() => document.activeElement.getAttribute('role'));
check('Tab stays inside the box (Close, then back to the search)', /cmd-close/.test(tabbed) && tabbedBack === 'combobox', `${tabbed} → ${tabbedBack}`);
await page.keyboard.press('Escape');
await sleep(150);
check('closed from the button: focus goes back to it', await page.evaluate(() => document.activeElement?.classList.contains('cmd-btn')));
await page.keyboard.press('Control+k');
await combo.fill('zzqx');
await sleep(400);
check('nothing found says so', /Nothing for “zzqx”/.test(await text(page, '.cmd')));
await page.keyboard.press('Escape');

// On a phone: the whole screen, big rows.
{
  const { ctx: pctx, page: pp } = await newPage(PHONE, 'manager phone');
  await pctx.addCookies(await ctx.cookies());
  await pp.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
  await pp.waitForSelector('.cmd-btn');
  const btn = await pp.$eval('.cmd-btn', (e) => { const r = e.getBoundingClientRect(); return { w: r.width, h: r.height, name: e.innerText.trim() }; });
  check('on a phone: a 44px search button in the top bar, still named Search', btn.w >= 44 && btn.h >= 44 && /Search/.test(btn.name), JSON.stringify(btn));
  await shot(pp, '02-desk-phone-header');
  await pp.tap('.cmd-btn');
  await pp.locator('.cmd [role="combobox"]').fill('s');
  await sleep(300);
  const rows = await pp.$$eval('.cmd [role="option"]', (els) => els.map((e) => e.getBoundingClientRect().height));
  check('on a phone: every row at least 48px tall', rows.length > 0 && rows.every((h) => h >= 48), rows.slice(0, 5).join(','));
  check('on a phone: the box fills the screen, no sideways scroll', (await noSideways(pp)) <= 0
    && (await pp.$eval('.cmd', (e) => Math.round(e.getBoundingClientRect().width))) === 390);
  await shot(pp, '03-command-bar-phone');
  await pctx.close();
}

// ── Two-step sign-in: the manager turns it on ──
await page.click('.acct-btn');
await page.getByRole('link', { name: 'Your profile' }).click();
await page.waitForURL(/\/admin\/profile$/);
await page.getByRole('button', { name: 'Turn on two-step sign-in' }).waitFor();
check('Your profile: two-step sign-in, off', /Two-step sign-in Off/.test(await text(page, '.ts-card')));
await shot(page, '04-profile-off');
await page.getByRole('button', { name: 'Turn on two-step sign-in' }).click();
await page.locator('.ts-qr').waitFor({ timeout: 8000 });
const mgrKey = await page.getAttribute('.ts-key', 'data-key');
check('a QR code to scan (named for screen readers) and the key to type in', /^[A-Z2-7]{32}$/.test(mgrKey || '')
  && (await page.getAttribute('.ts-qr', 'aria-label')) === 'QR code for your authenticator app'
  && (await page.innerText('.ts-key')).replace(/ /g, '') === mgrKey);
await page.fill('#ts-confirm', '000000');
await page.getByRole('button', { name: 'Turn on' }).click();
await page.locator('.ts-setup [role="alert"]').waitFor({ timeout: 8000 });
check('a wrong code is refused, in words', /doesn’t match/.test(await page.innerText('.ts-setup [role="alert"]')));
await shot(page, '05-setup-desktop', true);
{
  const { ctx: pctx, page: pp } = await newPage(PHONE, 'manager phone');
  await pctx.addCookies(await ctx.cookies());
  await pp.goto(`${BASE}/admin/profile`, { waitUntil: 'domcontentloaded' });
  await pp.locator('.ts-qr').waitFor({ timeout: 8000 });
  check('setting up on a phone: the same key after a reload, no sideways scroll', (await pp.getAttribute('.ts-key', 'data-key')) === mgrKey && (await noSideways(pp)) <= 0);
  await shot(pp, '06-setup-phone', true);
  await pctx.close();
}
await page.fill('#ts-confirm', await codeFor('mgr', mgrKey));
await page.getByRole('button', { name: 'Turn on' }).click();
await page.locator('.ts-codelist').waitFor({ timeout: 8000 });
const mgrCodes = await page.$$eval('.ts-codelist code', (els) => els.map((e) => e.textContent));
check('on: ten recovery codes, shown once', mgrCodes.length === 10 && mgrCodes.every((c) => /^[a-z2-9]{5}-[a-z2-9]{5}$/.test(c)), mgrCodes.join(' '));
check('the codes’ heading takes focus (said by screen readers)', await page.evaluate(() => document.activeElement?.textContent.includes('Two-step sign-in is on')));
await shot(page, '07-recovery-codes-desktop');
await page.getByRole('button', { name: /I’ve saved them/ }).click();
await page.getByText('10 recovery codes left').waitFor({ timeout: 8000 });
check('Your profile: on, ten codes left', /Two-step sign-in On/.test(await text(page, '.ts-card')));
await shot(page, '08-profile-on');

// ── Signing in asks for the code ──
await signOut(page);
await signIn(page, mgrEmail);
await page.getByRole('heading', { name: 'Enter your code' }).waitFor({ timeout: 8000 });
check('after the password: the code step', await page.locator('#login-code').isVisible());
await page.fill('#login-code', '123456');
await page.getByRole('button', { name: 'Sign in' }).click();
await page.locator('.auth-page [role="alert"]').waitFor({ timeout: 8000 });
check('a wrong code: said, still on the code step', /doesn’t match/.test(await page.innerText('.auth-page [role="alert"]')) && await page.locator('#login-code').isVisible());
await shot(page, '09b-signin-code-desktop');
{
  const { page: pp, ctx: pctx } = await newPage(PHONE, 'sign-in phone');
  await signIn(pp, mgrEmail);
  await pp.getByRole('heading', { name: 'Enter your code' }).waitFor({ timeout: 8000 });
  check('the code step on a phone: no sideways scroll', (await noSideways(pp)) <= 0);
  await shot(pp, '09-signin-code-phone');
  await pctx.close();
}
await page.fill('#login-code', await codeFor('mgr', mgrKey));
await page.getByRole('button', { name: 'Sign in' }).click();
await page.waitForURL(/\/admin\/?$/, { timeout: 10000 });
check('the right code: the desk', true);
await signOut(page);
await signIn(page, mgrEmail);
await page.getByRole('heading', { name: 'Enter your code' }).waitFor({ timeout: 8000 });
await page.fill('#login-code', mgrCodes[0]);
await page.getByRole('button', { name: 'Sign in' }).click();
await page.waitForURL(/\/admin\/?$/, { timeout: 10000 });
await page.goto(`${BASE}/admin/profile`, { waitUntil: 'domcontentloaded' });
await page.getByText('9 recovery codes left').waitFor({ timeout: 8000 }).catch(() => {});
check('a recovery code signs in; nine left', /9 recovery codes left/.test(await text(page, '.ts-card')));

// ── A staffer and a volunteer join ──
const join = async (email, role, name) => {
  const inv = (await api(page, '/actions/member.invite', { email, role })).json;
  const { ctx: c2, page: p2 } = await newPage(DESKTOP, role);
  await p2.goto(inv.joinUrl.replace(/^https?:\/\/[^/]+/, BASE), { waitUntil: 'domcontentloaded' });
  await p2.fill('#join-name', name);
  await p2.fill('#join-password', PASSWORD);
  await p2.getByRole('button', { name: 'Join' }).click();
  return { c2, p2 };
};
const samEmail = `sam.${tag}@example.org`;
const { c2: samCtx, p2: sam } = await join(samEmail, 'staff', 'Sam Example');
await sam.waitForURL(/\/admin\/?$/, { timeout: 15000 });
check('the staffer is at the desk', await sam.locator('.nav .links').isVisible());
const valEmail = `val.${tag}@example.org`;
const { c2: valCtx, p2: val } = await join(valEmail, 'volunteer', 'Val Example');
await val.waitForURL(new RegExp(`${BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?$`), { timeout: 15000 });

// ── The manager requires it for desk roles ──
await page.goto(`${BASE}/admin/settings`, { waitUntil: 'domcontentloaded' });
const req = page.getByLabel('Require two-step sign-in for desk roles');
await req.waitFor({ timeout: 8000 });
check('Settings → Members: the manager’s own row says two-step is on', /Two-step on/.test(await text(page, '.ot-list')));
await req.check();
await page.waitForTimeout(600);
check('required, and it says what happens', await req.isChecked() && /set it up at their next sign-in/.test(await text(page, '.tm-2step-sec')));
await shot(page, '10-members-required-desktop', true);
{
  const { ctx: pctx, page: pp } = await newPage(PHONE, 'manager phone');
  await pctx.addCookies(await ctx.cookies());
  await pp.goto(`${BASE}/admin/settings`, { waitUntil: 'domcontentloaded' });
  await pp.getByLabel('Require two-step sign-in for desk roles').waitFor({ timeout: 8000 });
  check('Settings → Members on a phone: no sideways scroll', (await noSideways(pp)) <= 0);
  await shot(pp, '10b-members-phone', true);
  await pp.goto(`${BASE}/admin/profile`, { waitUntil: 'domcontentloaded' });
  await pp.getByText(/recovery codes left/).waitFor({ timeout: 8000 });
  check('Your profile (on) on a phone: no sideways scroll', (await noSideways(pp)) <= 0);
  await shot(pp, '08b-profile-on-phone');
  await pctx.close();
}

// The staffer, already signed in: the set-up before anything else.
await sam.goto(`${BASE}/admin/people`, { waitUntil: 'domcontentloaded' });
await sam.getByRole('heading', { name: 'Set up two-step sign-in' }).waitFor({ timeout: 10000 });
check('a staffer already signed in: the set-up, and nothing else (no tabs)', (await sam.locator('.nav').count()) === 0 && /asks everyone at the desk/.test(await text(sam)));
await shot(sam, '11b-required-gate-desktop');
const blocked = await api(sam, '/persons');
check('…and the server answers nothing else meanwhile', blocked.status === 401 && blocked.json?.two_step === 'set_up', JSON.stringify(blocked));
{
  const { ctx: pctx, page: pp } = await newPage(PHONE, 'staff phone');
  await pctx.addCookies(await samCtx.cookies());
  await pp.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
  await pp.getByRole('heading', { name: 'Set up two-step sign-in' }).waitFor({ timeout: 10000 });
  check('the set-up on a phone: no sideways scroll', (await noSideways(pp)) <= 0);
  await shot(pp, '11-required-gate-phone', true);
  await pctx.close();
}
await sam.getByRole('button', { name: 'Set it up' }).click();
await sam.locator('.ts-qr').waitFor({ timeout: 8000 });
const samKey = await sam.getAttribute('.ts-key', 'data-key');
await sam.fill('#ts-confirm', await codeFor('sam', samKey));
await sam.getByRole('button', { name: 'Turn on' }).click();
await sam.locator('.ts-codelist').waitFor({ timeout: 8000 });
await shot(sam, '12-required-codes-desktop');
await sam.getByRole('button', { name: 'I’ve saved them — open base.win' }).click();
await sam.locator('.nav .links').waitFor({ timeout: 10000 });
check('set up: the desk opens for the staffer', (await api(sam, '/persons')).status === 200);

// A volunteer: the password alone, as before.
await signOut(val);
await signIn(val, valEmail);
await val.waitForURL(new RegExp(`${BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?$`), { timeout: 10000 });
check('a volunteer signs in with a password alone, to the field app', (await val.locator('#login-code').count()) === 0 && (await val.innerText('.brand-name')).trim() === 'base.win');
await val.click('.acct-btn');
await val.getByRole('link', { name: 'Your profile' }).click();
await val.getByRole('button', { name: 'Turn on two-step sign-in' }).waitFor({ timeout: 8000 });
check('a volunteer can turn it on for themselves (Your profile, in the field app)', /Volunteer · Imagine Surrey/.test(await text(val, 'main.page')));

// ── The manager resets the staffer's (a lost phone) ──
await page.goto(`${BASE}/admin/settings`, { waitUntil: 'domcontentloaded' });
const samRow = page.locator('.ot-item', { hasText: 'Sam Example' });
await samRow.getByText('Two-step on').waitFor({ timeout: 8000 });
await samRow.getByRole('button', { name: 'Reset two-step' }).click();
await samRow.getByRole('button', { name: 'Yes, reset' }).click();
await samRow.getByText(/Two-step sign-in reset/).waitFor({ timeout: 8000 });
check('reset: said in place, and the chip is gone', (await samRow.getByText('Two-step on').count()) === 0);
await sam.goto(`${BASE}/admin/people`, { waitUntil: 'domcontentloaded' });
await sam.waitForURL(/\/login$/, { timeout: 10000 });
check('the staffer is signed out', true);
await signIn(sam, samEmail);
await sam.getByRole('heading', { name: 'Set up two-step sign-in' }).waitFor({ timeout: 10000 });
check('their password signs them in to the set-up again (it’s required)', true);
const log = (await api(page, '/events?since=0&limit=1000')).json;
const resets = (log?.events || []).filter((e) => e.entity_type === 'two_step' && e.action === 'twostep.reset');
check('the reset is on the event log, by the manager', resets.length === 1, JSON.stringify(resets).slice(0, 200));

// ── Staff without Donations: never offered it ──
await api(page, '/actions/permission.role.set', { role: 'staff', grant: [], deny: ['money'] });
await api(page, '/actions/twostep.require', { on: false });
await sam.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
await sam.waitForSelector('.cmd-btn', { timeout: 10000 });
await sam.keyboard.press('Control+k');
await sam.locator('.cmd [role="combobox"]').fill('gift');
await sleep(300);
const samGift = await sam.$$eval('.cmd [role="option"]', (els) => els.map((e) => e.textContent));
await sam.locator('.cmd [role="combobox"]').fill('donations');
await sleep(300);
const samDon = await sam.$$eval('.cmd [role="option"]', (els) => els.map((e) => e.textContent));
check('a staffer without Donations: no gift, no Donations', !samGift.some((t) => /Log a gift/.test(t)) && !samDon.some((t) => /^Donations/.test(t)), JSON.stringify([samGift, samDon]));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
