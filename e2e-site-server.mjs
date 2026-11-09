// The website's server, in a browser (ext/site; SITE.md).
//
// The desk signs up on the app's own address and opens Website's data
// (the first look makes Imagine Surrey's site); on a shift's Edit it ticks
// "Show on the website". Then the campaign's own domain — here 127.0.0.1,
// with SITE_HOSTS=127.0.0.1 — serves the site at / and nothing of the app
// (no /api, no sign-in cookie). A visitor signs the SkyTrain petition the
// way an island does (JSON), joins the newsletter with a plain form post (no
// JavaScript: back to the page with ?sent=), books the public shift,
// volunteers with two roles, comes through a supporter's referral link, and
// is told in plain words that online giving isn't set up. Each lands in
// base.win: the person, the tags, the list, the booking, the request,
// "Brought in by". Their own preferences link turns email off in base.win
// and /unsubscribe asks before it does it. The desk's preview link shows a
// draft. Phone and desktop: no sideways scroll; tap targets 48px.
//
//   SITE_HOSTS=127.0.0.1 SITE_SECRET=e2e-site-secret-0123456789 STARBASE_OPEN_SIGNUP=1 STARBASE_DATA=memory PORT=5010 node server/index.js &
//   BASE=http://127.0.0.1:5010 SITE_SECRET=e2e-site-secret-0123456789 SHOTS=/tmp/site-server node e2e-site-server.mjs
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = (process.env.BASE || 'http://127.0.0.1:3200').replace(/\/$/, '');
const SITE = BASE.replace('localhost', '127.0.0.1'); // the campaign's own domain (SITE_HOSTS)
const APP = SITE.replace('127.0.0.1', 'localhost'); // the app's own address
const SHOTS = process.env.SHOTS || '/tmp/starbase-site-server';
process.env.SITE_SECRET = process.env.SITE_SECRET || 'e2e-site-secret-0123456789';
const { sign } = await import('./server/ext/site/tokens.js');
mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 240) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Date.now().toString(36);

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const errors = [];
const desk = await browser.newContext({ viewport: { width: 1360, height: 900 }, timezoneId: 'America/Vancouver' });
const page = await desk.newPage();
page.on('pageerror', (e) => errors.push(e.message));
const api = (path, body) => page.evaluate(async ([p, b]) => {
  const r = await fetch('/api' + p, b === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  return { status: r.status, json: await r.json().catch(() => null) };
}, [path, body]);
const shot = (p, n, full = true) => p.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: full });
const overflow = (p) => p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

// ── the desk: sign up on the app's own address; Website's first look ──
await page.goto(`${APP}/signup`, { waitUntil: 'domcontentloaded' });
await page.fill('#su-name', 'Rae Desk');
if (await page.locator('#su-org').count()) await page.fill('#su-org', 'Imagine Surrey');
await page.fill('#su-email', `desk.${tag}@example.org`);
await page.fill('#su-password', 'surrey-forward-2026');
await page.click('button[type="submit"]');
await page.waitForURL(/\/admin\/?$/, { timeout: 15000 });
const site = (await api('/site')).json;
check('Website: the first look makes the site (8 pages, 2 petitions)', site?.pages?.length === 8 && site.counts.campaigns === 2, JSON.stringify(site?.counts));
const campaigns = (await api('/site/campaigns')).json.campaigns;
const sky = campaigns.find((c) => c.slug === 'skytrain-south-surrey');
const ws = (await api('/auth/me')).json?.workspace?.id;

// ── a shift shown on the website, from its Edit screen ──
const starts = new Date(Date.now() + 3 * 864e5);
starts.setUTCHours(18, 0, 0, 0); // 10 a.m. in Surrey
const shift = (await api('/actions/shift.create', { title: 'Town hall in Newton', location: 'Newton Seniors Centre', starts_at: starts.toISOString(), capacity: 2 })).json.shift;
await page.goto(`${APP}/admin/shifts/${shift.id}`, { waitUntil: 'domcontentloaded' });
await page.getByRole('button', { name: 'Edit' }).click();
const toggle = page.locator('label.ops-check');
await toggle.waitFor();
check('Edit shift: "Show on the website", off', (await toggle.innerText()).includes('Show on the website') && !(await toggle.locator('input').isChecked()));
const box = await toggle.boundingBox();
check('the switch is a 48px tap target', box && box.height >= 48, box && box.height);
await toggle.locator('input').check();
await shot(page, '1-desk-edit-shift');
await page.getByRole('button', { name: 'Save' }).click();
await page.locator('.chip', { hasText: 'On the website' }).waitFor({ timeout: 8000 });
check('saved: the shift says "On the website"', true);
check('server: the shift is public', (await api(`/shifts/${shift.id}`)).json.shift.public === true);
await page.setViewportSize({ width: 390, height: 844 });
await page.getByRole('button', { name: 'Edit' }).click();
await toggle.waitFor();
await sleep(300);
check('Edit shift on a phone: no sideways scroll', (await overflow(page)) <= 0);
await shot(page, '2-desk-edit-shift-phone');
await page.getByRole('button', { name: 'Cancel' }).click();
await page.setViewportSize({ width: 1360, height: 900 });

// ── the campaign's own domain: the site at /, nothing of the app ──
const visitor = await browser.newContext({ viewport: { width: 1360, height: 900 }, timezoneId: 'America/Vancouver' });
const v = await visitor.newPage();
v.on('pageerror', (e) => errors.push(e.message));
const home = await v.goto(`${SITE}/`, { waitUntil: 'domcontentloaded' });
check('the site at / on its own domain', home.status() === 200 && await v.locator('[data-module="hero"]#m-hero').count() === 1);
const csp = home.headers()['content-security-policy'] || '';
check('a CSP of self, the video players and Stripe; never framed', /default-src 'self'/.test(csp) && /player\.vimeo\.com/.test(csp) && /checkout\.stripe\.com/.test(csp) && /frame-ancestors 'none'/.test(csp), csp);
await shot(v, '3-site-home');
const appOnSite = await v.goto(`${SITE}/api/health`, { waitUntil: 'domcontentloaded' });
check('no app route answers on the site’s domain (/api/health: the site’s 404)', appOnSite.status() === 404);
const field = await v.goto(`${SITE}/field`, { waitUntil: 'domcontentloaded' });
check('no app screen either (/field: 404)', field.status() === 404);
check('no sign-in cookie on the site’s domain', !(await visitor.cookies(SITE)).some((c) => c.name === 'mv2_session'));
await v.goto(`${SITE}/`, { waitUntil: 'domcontentloaded' });

const form = (kind, body) => v.evaluate(async ([k, b]) => {
  const r = await fetch(`/api/forms/${k}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  return { status: r.status, json: await r.json().catch(() => null) };
}, [kind, body]);

// ── a petition, as an island sends it ──
const signed = await form('petition', { first_name: 'Ana', last_name: 'Example', email: `ana.${tag}@example.org`, postal_code: 'V3T 1V8', campaign: sky.id, consent_email: true, client_key: `k-${tag}-1`, page_id: site.pages[0].id, module_id: 'skytrain' });
check('petition: { ok: true } and nothing else', JSON.stringify(signed.json) === '{"ok":true}', JSON.stringify(signed));
const again = await form('petition', { first_name: 'Ana', last_name: 'Example', email: `ana.${tag}@example.org`, campaign: sky.id, client_key: `k-${tag}-1` });
check('a retry with the same key: the same answer', again.status === 200);
const people = (await api('/persons?limit=200')).json.persons;
const ana = people.filter((p) => p.email === `ana.${tag}@example.org`);
check('in People once, tagged "Signed: Get SkyTrain to South Surrey"', ana.length === 1 && ana[0].tags.includes('Signed: Get SkyTrain to South Surrey') && ana[0].tags.includes('Website: petition'), JSON.stringify(ana.map((p) => p.tags)));
check('the signature counted', (await api(`/site/campaigns/${sky.id}`)).json.campaign.signatures === 1);
const subs = (await api('/subscriptions')).json.subscriptions;
check('the ticked box: on the newsletter list', subs.some((s) => s.email === `ana.${tag}@example.org` && s.status === 'subscribed'));

// ── a plain form post (no JavaScript) ──
await v.evaluate((email) => {
  const f = document.createElement('form');
  f.method = 'post';
  f.action = '/api/forms/newsletter';
  for (const [k, val] of Object.entries({ first_name: 'Ben', last_name: 'Example', email, consent_email: 'on', module_id: 'newsletter' })) {
    const i = document.createElement('input');
    i.type = 'hidden'; i.name = k; i.value = val;
    f.append(i);
  }
  document.body.append(f);
  f.submit();
}, `ben.${tag}@example.org`);
await v.waitForURL(/\?sent=newsletter#m-newsletter$/, { timeout: 10000 });
check('a plain post comes back to the page with ?sent=newsletter#m-newsletter', /\/\?sent=newsletter#m-newsletter$/.test(v.url()), v.url());
await shot(v, '4-site-after-plain-post');

// ── the public shift: booked through the app's own booking ──
const rsvp =await form('rsvp', { first_name: 'Cy', last_name: 'Example', email: `cy.${tag}@example.org`, shift_id: shift.id });
check('rsvp: ok', rsvp.status === 200 && rsvp.json.ok === true, JSON.stringify(rsvp));
const assignees = (await api(`/shifts/${shift.id}`)).json.assignees;
check('booked on the shift', assignees.some((a) => a.email === `cy.${tag}@example.org`), JSON.stringify(assignees.map((a) => a.email)));
await form('rsvp', { first_name: 'Di', email: `di.${tag}@example.org`, shift_id: shift.id });
const full = await form('rsvp', { first_name: 'Ed', email: `ed.${tag}@example.org`, shift_id: shift.id });
check('the third for two spots: "full", in plain words, on the field', full.status === 400 && full.json.field === 'shift_id' && /full/.test(full.json.error), JSON.stringify(full.json));

// ── volunteer, plain post with two roles → a request for the desk ──
await v.goto(`${SITE}/volunteer`, { waitUntil: 'domcontentloaded' });
await v.evaluate((email) => {
  const f = document.createElement('form');
  f.method = 'post';
  f.action = '/api/forms/volunteer';
  const add = (k, val) => { const i = document.createElement('input'); i.type = 'hidden'; i.name = k; i.value = val; f.append(i); };
  add('first_name', 'Fay'); add('last_name', 'Example'); add('email', email); add('roles', 'Doorknocking'); add('roles', 'Phoning');
  add('availability', 'Saturdays'); add('module_id', 'volunteer-form');
  document.body.append(f);
  f.submit();
}, `fay.${tag}@example.org`);
await v.waitForURL(/\/volunteer\?sent=volunteer#m-volunteer-form$/, { timeout: 10000 });
const reqs = (await api('/requests')).json.requests;
check('volunteer: a request for the desk with both roles', reqs.some((r) => r.kind === 'volunteer' && /Doorknocking, Phoning/.test(r.note) && /Saturdays/.test(r.note)), JSON.stringify(reqs.map((r) => r.note)));

// ── a referral link: Ana's own preferences page (a signed link, as an
// email carries) shows her link to share ──
const prefT = await sign('person', { w: ws, p: ana[0].id }, 3600);
await v.goto(`${SITE}/preferences?t=${encodeURIComponent(prefT)}`, { waitUntil: 'domcontentloaded' });
const share = (await v.locator('.share').innerText().catch(() => '')).trim();
const refCode = share.split('/r/')[1];
check('their own preferences page shows their link to share', /\/r\/[a-z0-9]{8}$/.test(share), share);
const friend = await browser.newContext({ viewport: { width: 390, height: 844 } });
const f = await friend.newPage();
await f.goto(`${SITE}/r/${refCode}`, { waitUntil: 'domcontentloaded' });
check('the referral link lands on the home page', new URL(f.url()).pathname === '/', f.url());
check('…and remembers who sent them', (await friend.cookies(SITE)).some((c) => c.name === 'site_ref' && c.value === refCode && c.httpOnly));
const viaRef = await f.evaluate(async (email) => (await fetch('/api/forms/newsletter', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ first_name: 'Gus', last_name: 'Example', email, consent_email: true }) })).status, `gus.${tag}@example.org`);
const gus = (await api('/persons?limit=200')).json.persons.find((p) => p.email === `gus.${tag}@example.org`);
const knows = gus && (await api(`/persons/${gus.id}/knows`)).json;
check('someone new through the link: "Brought in by" Ana', viaRef === 200 && knows?.brought_in_by?.id === ana[0].id, JSON.stringify(knows?.brought_in_by));

// ── online giving isn't set up: plain words ──
const give = await form('donate', { email: `hal.${tag}@example.org`, amount_cents: 5000, declaration: true });
check('donate without payments set up: 503 in plain words', give.status === 503 && /Online payments aren’t set up/.test(give.json.error), JSON.stringify(give.json));

// ── their own email choices (a signed link from an email) ──
await v.setViewportSize({ width: 1360, height: 900 });
await v.goto(`${SITE}/preferences?t=${encodeURIComponent(prefT)}`, { waitUntil: 'domcontentloaded' });
check('preferences: email shown on', await v.locator('input[name="email"]').isChecked());
await shot(v, '5-preferences');
await v.keyboard.press('Tab');
await v.keyboard.press('Tab');
const focused = await v.evaluate(() => document.activeElement?.getAttribute('name') || document.activeElement?.tagName);
check('keyboard: Tab reaches the choices', ['email', 'A'].includes(focused), focused);
await v.locator('input[name="email"]').uncheck();
await v.getByRole('button', { name: 'Save my choices' }).click();
await v.locator('.done', { hasText: 'Saved' }).waitFor({ timeout: 8000 });
const after = (await api('/subscriptions')).json.subscriptions.find((s) => s.email === `ana.${tag}@example.org`);
check('email off: off base.win’s own newsletter list', after?.status === 'unsubscribed', JSON.stringify(after));
await v.setViewportSize({ width: 390, height: 844 });
await sleep(200);
check('preferences on a phone: no sideways scroll', (await overflow(v)) <= 0);
const tapOk = await v.evaluate(() => [...document.querySelectorAll('button, label.check')].every((el) => el.getBoundingClientRect().height >= 48));
check('preferences on a phone: every tap target at least 48px', tapOk);
await shot(v, '6-preferences-phone');

// ── /unsubscribe: asks first ──
const benRow = (await api('/persons?limit=200')).json.persons.find((p) => p.email === `ben.${tag}@example.org`);
const unT = await sign('person', { w: ws, p: benRow.id }, 3600);
await v.goto(`${SITE}/unsubscribe?t=${encodeURIComponent(unT)}`, { waitUntil: 'domcontentloaded' });
check('unsubscribe: asks first', /Stop emails from/.test(await v.locator('h1').innerText()));
check('…and opening it changed nothing', (await api('/subscriptions')).json.subscriptions.find((s) => s.email === `ben.${tag}@example.org`)?.status === 'subscribed');
await shot(v, '7-unsubscribe-phone');
await v.getByRole('button', { name: 'Unsubscribe' }).click();
await v.locator('h1', { hasText: 'You’re unsubscribed' }).waitFor({ timeout: 8000 });
check('the button does it', (await api('/subscriptions')).json.subscriptions.find((s) => s.email === `ben.${tag}@example.org`)?.status === 'unsubscribed');
await shot(v, '8-unsubscribed-phone');
await v.goto(`${SITE}/preferences?t=nope`, { waitUntil: 'domcontentloaded' });
check('a link that doesn’t work: a plain dead end', /doesn’t work any more/.test(await v.locator('h1').innerText()));
await shot(v, '9-link-expired-phone');

// ── the site on a phone ──
await v.goto(`${SITE}/`, { waitUntil: 'domcontentloaded' });
await sleep(200);
check('the site on a phone: no sideways scroll', (await overflow(v)) <= 0);
await shot(v, '10-site-home-phone');

// ── the desk's preview link ──
const donate = site.pages.find((p) => p.slug === 'donate');
await api('/actions/site.page.save', { id: donate.id, modules: [{ id: 'preview-text', kind: 'text', props: { title: 'Draft words for the preview' } }] });
const prev = (await api('/site/preview-token', { pageId: donate.id })).json;
const pr = await page.goto(`${APP}${prev.url}`, { waitUntil: 'domcontentloaded' });
check('the preview shows the draft', /Draft words for the preview/.test(await page.content()));
check('…not indexed, framed by the app only', /noindex/.test(pr.headers()['x-robots-tag'] || '') && /frame-ancestors 'self'/.test(pr.headers()['content-security-policy'] || ''));
const live = await v.goto(`${SITE}/donate`, { waitUntil: 'domcontentloaded' });
check('…while the site still shows what is published', live.status() === 200 && !/Draft words for the preview/.test(await v.content()));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
