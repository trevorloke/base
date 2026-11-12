// Other websites (SITE.md "Other websites"; web/src/pages/WebsiteSites.jsx,
// WebsiteSite.jsx), in a browser, with Chromium sending dougdidnt.test to
// this server.
//
// A manager signs up; Other websites is empty. "New website": "Doug Didn’t
// Example" at dougdidnt.test (checked as typed: the app's own address is
// refused in the save's words). Its overview is a draft with the checklist;
// "Go live" says "Publish the home page first" in place; the checklist's
// link opens its home in the builder, "On Doug Didn’t Example", and it is
// published. Settings → Organization: Authorized by. Go live. Domain shows
// the three steps. http://dougdidnt.test:<port>/?utm_source=flyer shows its
// name, the © and Authorized-by lines naming the organization, the link back
// and the privacy line; a sign-up there shows on the overview as 1 sign-up
// from "flyer", and People with web=site:<id> finds the person. Staff with
// the Website area see no Go live and no ⋯. Take offline → "Coming soon";
// delete → "This website has closed" (410) at dougdidnt.test, even at
// /login — never the sign-in page. Every screen is looked at 1440×900 and
// 390×844 (no sideways scroll; 48px targets on the phone).
//
//   STARBASE_OPEN_SIGNUP=1 STARBASE_DATA=memory PORT=5130 node server/index.js &
//   BASE=http://127.0.0.1:5130 SHOTS=/tmp/microsites node e2e-microsites.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = (process.env.BASE || 'http://127.0.0.1:5130').replace(/\/$/, '');
const PORT = new URL(BASE).port;
const SHOTS = process.env.SHOTS || '/tmp/starbase-microsites';
const DOUG = 'dougdidnt.test';
const SITE = `http://${DOUG}:${PORT}`;
const ORG = 'Harbour City Example';
mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 240) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Date.now().toString(36);

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', `--host-resolver-rules=MAP ${DOUG} 127.0.0.1`] });
const errors = [];
const desk = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, timezoneId: 'America/Vancouver' });
const page = await desk.newPage();
page.on('pageerror', (e) => errors.push(e.message));
const text = async (p = page) => ((await p.innerText('main.page').catch(() => '')) || '').replace(/\s+/g, ' ');
const overflow = (p = page) => p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const api = (path) => page.evaluate(async (p) => { const r = await fetch('/api' + p); return { status: r.status, json: await r.json().catch(() => null) }; }, path);
const go = async (path, p = page) => {
  await p.goto(`${BASE}/admin${path}`, { waitUntil: 'domcontentloaded' });
  await p.locator('h1').first().waitFor({ timeout: 15000 });
  await sleep(600);
};
// Both sizes: the screen as it is, then on a phone (no sideways scroll; its
// buttons and links at least 44px tall — 48 with the touch control size).
const phoneIssues = [];
const both = async (name, p = page, ready = null) => {
  const vp = p.viewportSize();
  await p.screenshot({ path: `${SHOTS}/${name}-desk.png`, fullPage: true });
  await p.setViewportSize({ width: 390, height: 844 });
  await sleep(400);
  if (ready) await ready();
  const o = await overflow(p);
  const small = await p.evaluate(() => [...document.querySelectorAll('main .btn, main button, main input:not([type=checkbox]):not([type=radio]), .ms-check a, .ms-link')]
    .filter((el) => el.offsetParent && !el.closest('.ws-sr'))
    .map((el) => [el.textContent.trim().slice(0, 30) || el.getAttribute('aria-label') || el.id, Math.round(el.getBoundingClientRect().height)])
    .filter(([, h]) => h < 44));
  if (o > 0 || small.length) phoneIssues.push([name, o, small]);
  await p.screenshot({ path: `${SHOTS}/${name}-phone.png`, fullPage: true });
  await p.setViewportSize(vp);
  await sleep(200);
};
const primaries = (p = page) => p.evaluate(() => [...document.querySelectorAll('main .btn-primary')].filter((b) => b.offsetParent).map((b) => b.textContent.trim()));

// ── 1. a manager signs up and makes "Doug Didn’t Example" at dougdidnt.test ──
await page.goto(`${BASE}/signup`, { waitUntil: 'domcontentloaded' });
await page.fill('#su-name', 'Rae Example');
if (await page.locator('#su-org').count()) await page.fill('#su-org', ORG);
await page.fill('#su-email', `desk.${tag}@example.org`);
await page.fill('#su-password', 'harbour-forward-2026');
await page.click('button[type="submit"]');
await page.waitForURL(/\/admin\/?$/, { timeout: 15000 });
await go('/website');
check('Overview: one row “Other websites”, none yet', /Other websites\s*None yet/.test(await page.locator('a.ms-home-row').innerText()));
await page.locator('.wb-tabs').getByRole('link', { name: 'Other websites' }).click();
await page.waitForURL(/\/website\/sites$/);
await page.locator('.ms-empty').waitFor();
check('Other websites: empty, “No other websites yet.” and one New website', /No other websites yet\./.test(await text()) && JSON.stringify(await primaries()) === '["New website"]', JSON.stringify(await primaries()));
await both('1-sites-empty');
await page.getByRole('button', { name: 'New website' }).click();
await page.fill('#ms-new-name', 'Doug Didn’t Example');
await page.fill('#ms-new-domain', 'base.win');
await page.waitForFunction(() => /itself answers/.test(document.querySelector('#ms-new-domain-say')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
const refusedWords = await page.locator('#ms-new-domain-say').innerText();
check('the app’s own address is refused as it’s typed, in the save’s words', /base\.win itself answers/.test(refusedWords) && await page.getByRole('button', { name: 'Make it' }).isDisabled(), refusedWords);
await page.fill('#ms-new-domain', DOUG);
await page.waitForFunction((d) => (document.querySelector('#ms-new-domain-say')?.textContent || '').includes(`It answers at ${d}`), DOUG, { timeout: 5000 }).catch(() => {});
check('a free address says where it will answer (and its www.)', (await page.locator('#ms-new-domain-say').innerText()).includes(`www.${DOUG}`));
await both('2-new-website-sheet');
await page.getByRole('button', { name: 'Make it' }).click();
await page.waitForURL(/\/website\/sites\/[0-9a-f-]{36}$/, { timeout: 15000 });
const siteId = page.url().match(/sites\/([0-9a-f-]{36})/)[1];
await page.locator('#ms-check-h').waitFor();

// ── 2. the checklist; publish its home in the builder ──
const t2 = await text();
check('a draft overview: its name with Draft, Go live, the checklist', /Doug Didn’t Example Draft/.test(t2) && /Before it goes live/.test(t2) && JSON.stringify(await primaries()) === '["Go live"]', t2.slice(0, 200));
const ticks = await page.locator('.ms-check').evaluateAll((els) => els.map((e) => [e.innerText.replace(/\s+/g, ' ').trim(), e.hasAttribute('data-done')]));
check('checklist: home not published, Authorized by missing, privacy link there, the address set', JSON.stringify(ticks.map((x) => x[1])) === '[false,false,true,true]' && /Web address: dougdidnt\.test/.test(ticks[3][0]), JSON.stringify(ticks));
await both('3-draft-overview');
await page.getByRole('button', { name: 'Go live' }).click();
await page.waitForFunction(() => /Publish the home page first/.test(document.querySelector('.ms-problem')?.textContent || ''), null, { timeout: 8000 }).catch(() => {});
check('Go live with something missing says the server’s words in place', /Publish the home page first/.test(await page.locator('.ms-problem').innerText().catch(() => '')));
await page.locator('.ms-check a', { hasText: 'Home page published' }).click();
await page.waitForURL(/\/website\/pages\/[0-9a-f-]{36}/, { timeout: 15000 });
await page.locator('.wb-build__on').waitFor({ timeout: 10000 });
check('the builder: its home, “On Doug Didn’t Example”', /On Doug Didn’t Example/.test(await page.locator('.wb-build__on').innerText()));
await page.locator('.wb-build__actions .btn-primary').click();
await page.waitForFunction(() => /Published/.test(document.querySelector('.wb-build__actions .btn-primary')?.textContent || ''), null, { timeout: 15000 }).catch(() => {});
check('published', /Published/.test(await page.locator('.wb-build__actions .btn-primary').innerText()));
await page.getByRole('link', { name: '← Pages' }).click();
await page.waitForURL(new RegExp(`/website/sites/${siteId}/pages$`));
await page.locator('.wb-row').first().waitFor();
check('← Pages: its own pages (only its home)', (await page.locator('.wb-row').count()) === 1 && /Home|Doug/.test(await page.locator('.wb-row__name').first().innerText()));

// ── 3. Settings → Organization: Authorized by ──
await go('/website/settings#org');
await page.locator('#wb-s-agent').waitFor();
await page.fill('#wb-s-name', ORG);
await page.fill('#wb-s-agent', 'Ada Example');
await page.fill('#wb-s-agentc', '604-555-0100');
await page.getByRole('button', { name: 'Save settings' }).click();
await page.waitForFunction(() => document.querySelector('.wb-saved')?.dataset.state === 'saved', null, { timeout: 10000 }).catch(() => {});

// ── 4. go live; Domain ──
await go(`/website/sites/${siteId}`);
check('the checklist is all ticked', (await page.locator('.ms-check[data-done]').count()) === 4);
await page.getByRole('button', { name: 'Go live' }).click();
await page.locator('a.btn-primary', { hasText: 'View site' }).waitFor({ timeout: 10000 });
check('live: the chip says Live, the button View site, no checklist', /Doug Didn’t Example Live/.test(await text()) && !(await page.locator('#ms-check-h').count()) && (await page.locator('a.btn-primary').getAttribute('href')).startsWith(`https://${DOUG}`));
await page.getByRole('link', { name: 'Domain', exact: true }).click();
await page.locator('.ms-steps').waitFor();
const steps = await page.locator('.ms-steps > li').allInnerTexts();
check('Domain: the Render line, then the three steps in order, each with Copy, then Open https://dougdidnt.test',
  /Your Render plan must allow another custom domain/.test(await text()) && steps.length === 3 && /Buy the domain/.test(steps[0]) && /Custom Domains → Add dougdidnt\.test/.test(steps[1]) && /CNAME for www pointing to your Render address/.test(steps[2])
  && (await page.locator('.ms-steps .ms-copy button').count()) === 2 && /Open https:\/\/dougdidnt\.test/.test(await text()), steps.join(' | ').slice(0, 240));
await both('4-domain');

// ── 5. the website on its own domain ──
const visitor = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const v = await visitor.newPage();
v.on('pageerror', (e) => errors.push(e.message));
const r5 = await v.goto(`${SITE}/?utm_source=flyer`, { waitUntil: 'networkidle' });
const look = await v.evaluate(() => ({
  word: document.querySelector('.wordmark')?.textContent || '',
  title: document.title,
  foot: document.querySelector('.site-footer')?.innerText.replace(/\s+/g, ' ') || '',
  parent: document.querySelector('.footer-parent a')?.getAttribute('href') || '',
  small: [...document.querySelectorAll('.form-small')].map((p) => [p.textContent, p.querySelectorAll('a').length, p.querySelector('a')?.getAttribute('href')]),
}));
check('its domain: 200, its name in the header and the title', r5.status() === 200 && look.word === 'Doug Didn’t Example' && /Doug Didn’t Example/.test(look.title), JSON.stringify(look).slice(0, 200));
check('the footer: © and Authorized by name the organization; “A website by …” links back',
  look.foot.includes(`© ${new Date().getFullYear()} ${ORG}`) && look.foot.includes('Authorized by Ada Example, 604-555-0100') && look.foot.includes(`A website by ${ORG}`) && /^https?:\/\//.test(look.parent), look.foot.slice(0, 240));
check('its form: one privacy line naming the organization, one absolute privacy link', look.small.length >= 1 && look.small.every(([t, n, href]) => t.includes(`${ORG} keeps what you send`) && n === 1 && /^https?:\/\/.+\/privacy$/.test(href)), JSON.stringify(look.small));
await both('5-microsite-home', v);
const foot = await v.$('footer.site-footer');
if (foot) await foot.screenshot({ path: `${SHOTS}/5-microsite-footer.png` });

// ── 6. a sign-up from the flyer, counted on the overview ──
const form = v.locator('form[action*="/api/forms/"]').first();
const email = `lee.${tag}@example.org`;
await form.locator('input[type=email]').fill(email);
for (const n of ['first_name', 'last_name']) if (await form.locator(`input[name=${n}]`).count()) await form.locator(`input[name=${n}]`).fill('Lee');
if (await form.locator('input[name=postal_code]').count()) await form.locator('input[name=postal_code]').fill('V3T 1A1');
if (await form.locator('input[name=consent_email]').count()) await form.locator('input[name=consent_email]').check();
await form.locator('button[type=submit]').click();
await v.locator('.success-card').waitFor({ timeout: 10000 }).catch(() => {});
check('the visitor is thanked in place', await v.locator('.success-card').count() > 0);
await go(`/website/sites/${siteId}`);
await page.locator('.ms-su__n').waitFor();
const su = { n: (await page.locator('.ms-su__n').innerText()).trim(), sources: await page.locator('.ms-sources li').allInnerTexts() };
check('the overview: 1 sign-up this week, from “flyer”', /^1\b/.test(su.n) && su.sources.length === 1 && /flyer\s*1/.test(su.sources[0]), JSON.stringify(su));
await page.getByRole('button', { name: '30 days' }).click();
check('7 / 30: thirty days says 1 too', /^1\b/.test((await page.locator('.ms-su__n').innerText()).trim()));
await both('6-live-overview');

// ── 7. People with web=site: ──
await page.getByRole('link', { name: 'See everyone from this site' }).click();
await page.waitForURL(/\/people\?web=site/, { timeout: 10000 });
await page.getByText(email).first().waitFor({ timeout: 10000 }).catch(() => {});
check('People with web=site: finds the person', (await page.locator('body').innerText()).includes(email), page.url());

// A second website (no domain) for the list.
await go('/website/sites');
await page.getByRole('button', { name: 'New website' }).click();
await page.fill('#ms-new-name', 'Second Example');
await page.getByRole('button', { name: 'Make it' }).click();
await page.waitForURL(/\/website\/sites\/[0-9a-f-]{36}$/);
await go('/website/sites');
const rows = await page.locator('.ms-row').allInnerTexts();
check('the list: name first, Live / Draft, the domain or “No domain yet”, sign-ups this week', rows.length === 2
  && /Doug Didn’t Example\s*Live\s*dougdidnt\.test\s*1 sign-up this week/.test(rows[0]) && /Second Example\s*Draft\s*No domain yet\s*0 sign-ups this week/.test(rows[1]), JSON.stringify(rows));
await both('7-sites-two');
await go('/website');
check('Overview: “Other websites · 1 live · 1 draft”', /Other websites\s*1 live · 1 draft/.test(await page.locator('a.ms-home-row').innerText()));

// ── 9. staff with the Website area: no Go live, no ⋯ ──
const inv = (await page.evaluate(async (e) => (await fetch('/api/actions/member.invite', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: e, role: 'staff' }) })).json(), `sam.${tag}@example.org`));
const sctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const sj = await sctx.request.post(`${BASE}/api/auth/join`, { data: { token: inv.joinUrl.split('/join/')[1], name: 'Sam Example', password: 'sam-staff-2026' } });
const staffId = (await sj.json()).user.id;
await page.evaluate(async (id) => fetch('/api/actions/permission.member.set', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: id, grant: ['site'], deny: [] }) }), staffId);
const sp = await sctx.newPage();
sp.on('pageerror', (e) => errors.push(e.message));
const second = (await api('/site/microsites')).json.microsites.find((m) => m.name === 'Second Example');
await go(`/website/sites/${second.id}`, sp);
await sp.locator('#ms-check-h').waitFor({ timeout: 10000 }).catch(() => {});
check('staff: a draft shows the checklist but no Go live and no ⋯', (await sp.locator('#ms-check-h').count()) === 1 && (await primaries(sp)).length === 0 && (await sp.locator('.ms-more').count()) === 0 && /A manager takes it live/.test(await text(sp)));
await both('9-staff-draft-overview', sp);
await go('/website/sites', sp);
check('staff: no New website', (await primaries(sp)).length === 0);
await both('9-staff-sites', sp);
await go(`/website/sites/${siteId}/look`, sp);
check('staff: the Look opens, with “Start from the campaign’s brand” and Save the look', await sp.getByRole('button', { name: 'Start from the campaign’s brand' }).count() === 1 && JSON.stringify(await primaries(sp)) === '["Save the look"]');
await both('9-staff-look', sp);
await sctx.close();

// ── 8. offline → Coming soon; deleted → closed, never the sign-in page ──
await go(`/website/sites/${siteId}`);
await page.getByRole('button', { name: 'More for Doug Didn’t Example' }).click();
await page.getByRole('button', { name: 'Take offline' }).click();
check('Take offline asks first, naming the domain', /Take dougdidnt\.test offline\?/.test(await page.locator('.ms-ask').innerText()));
await page.locator('.ms-ask').getByRole('button', { name: 'Yes' }).click();
await page.getByRole('button', { name: 'Go live' }).waitFor({ timeout: 10000 });
await sleep(300);
const r8 = await v.goto(`${SITE}/`, { waitUntil: 'domcontentloaded' });
const soon = await v.evaluate(() => document.body.innerText);
check('offline: its domain says “Coming soon”, with the authorization line', r8.status() === 200 && /Coming soon/.test(soon) && soon.includes('Authorized by Ada Example'), soon.slice(0, 200));
await both('8-coming-soon', v);
await page.getByRole('button', { name: 'More for Doug Didn’t Example' }).click();
await page.getByRole('button', { name: 'Delete' }).click();
await page.locator('.ms-ask').getByRole('button', { name: 'Yes' }).click();
await page.getByText('This website is deleted.').waitFor({ timeout: 10000 });
check('deleted: Undo in the toast; the overview says its address says it has closed', await page.locator('.wb-toast').getByRole('button', { name: /Undo/ }).count() === 1 && /dougdidnt\.test says “This website has closed”/.test(await text()));
await both('8-deleted-overview');
for (const path of ['/', '/login']) {
  const r = await v.goto(`${SITE}${path}`, { waitUntil: 'domcontentloaded' });
  const body = await v.evaluate(() => document.body.innerText);
  check(`deleted: ${path} on its domain is “This website has closed” (410), never the sign-in page`, r.status() === 410 && /This website has closed/.test(body) && !/Sign in|Password/i.test(body) && body.includes('Authorized by Ada Example'), `${r.status()} ${body.slice(0, 120)}`);
}
await both('8-closed', v);
// Its row on the list: under Closed websites.
await go('/website/sites');
check('Other websites lists it under Closed websites', /Closed websites\s*Doug Didn’t Example\s*Deleted\s*dougdidnt\.test says “This website has closed”/.test(await text()));

check('on a phone: no sideways scroll and every control at least 44px tall, on every screen', phoneIssues.length === 0, JSON.stringify(phoneIssues));
check('no page errors', errors.length === 0, errors.join(' | '));
await visitor.close();
await browser.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
