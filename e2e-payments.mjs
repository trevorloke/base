// Payments E2E — a donation through Stripe's hosted page, in a browser,
// against a stand-in Stripe (server/test/fake-stripe.js: its own checkout
// page, its signed webhooks) and a stand-in for the campaign website's
// donate form, which does what SITE.md's donate form does: the person
// recorded (matched by email), then checkoutFor in the same write, then
// the browser sent to Stripe. The base.win server runs in this process
// (in memory) so the stand-in can call checkoutFor as the site's own code
// will.
//
//   1. A manager signs up. Settings → Services: Online payments (Stripe) says
//      Test mode, shows the webhook address to paste into Stripe and the ten
//      events; Check reads the webhook from Stripe and says it's right.
//   2. A donor on a phone fills the donate form ($50 once, the declaration),
//      lands on Stripe's page (the campaign, the amount), pays, and comes
//      back to the website's thank-you page. Stripe's webhook has landed.
//   3. Donations: the gift is in the ledger, marked online; opened, its
//      receipt ("Receipt 2026-000N"); Online giving · test mode lists it Paid.
//   4. A monthly gift: the donor is under Monthly donors.
//   5. Over the limit before checkout: a donor the desk logged $1,400 for is
//      refused on the form in plain words, and Stripe is never asked. Over
//      the limit when it lands (the desk logged a gift while the donor was
//      on Stripe's page): no gift, refunded through Stripe by the job
//      runner, and Needs you says so — with "let them know" while email
//      isn't connected.
//   6. A refund made in Stripe: Needs you says the gift is void; Got it.
//   7. Measured on a phone and a desktop: no sideways scroll, one yellow
//      button, targets ≥48px; no page errors.
//
//   PORT=5310 SHOTS=/tmp/payments node e2e-payments.mjs     (after npm run build)
// Ports: PORT (base.win), PORT+1 (Stripe), PORT+2 (the website).
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import http from 'node:http';

const PORT = Number(process.env.PORT) || 5310;
const BASE = `http://127.0.0.1:${PORT}`;
const SITE = `http://127.0.0.1:${PORT + 2}`;
const SHOTS = process.env.SHOTS || '/tmp/starbase-payments';
mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 240) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Date.now().toString(36);
const SECRET = `whsec_e2e_${tag}`;
const KEY = `sk_test_e2e_${tag}`;
const yr = new Date().getFullYear();

// ── base.win, in this process, with Stripe pointed at the stand-in ──
for (const k of ['DATABASE_URL', 'RESEND_API_KEY', 'MAIL_FROM', 'STARBASE_PUBLIC_URL', 'BASE_PATH', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM']) delete process.env[k];
Object.assign(process.env, {
  STARBASE_OPEN_SIGNUP: '1', STARBASE_DATA: 'memory', GEOCODE_ON_SAVE: 'off',
  STRIPE_SECRET_KEY: KEY, STRIPE_WEBHOOK_SECRET: SECRET,
});
const { startFakeStripe } = await import('./server/test/fake-stripe.js');
const fake = await startFakeStripe({ port: PORT + 1, secret: SECRET, webhookUrl: `${BASE}/stripe/webhook`, apiKey: KEY });
process.env.STRIPE_API_BASE = fake.url;
const { serve } = await import('@hono/node-server');
const { app } = await import('./server/index.js');
const { getDb } = await import('./server/db/client.js');
const { runAction } = await import('./server/lib/events.js');
const { ACTIONS } = await import('./server/actions/index.js');
const { checkoutFor, DECLARATION, STRIPE_EVENTS } = await import('./server/ext/payments/index.js');
const { startJobRunner, stopJobRunner } = await import('./server/lib/jobs.js');
const server = serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' });
startJobRunner(await getDb(), { everyMs: 1000 }); // refunds run after the webhook, as on a real server
await sleep(300);

// ── The website's donate form, stood in for ──
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const sitePage = (title, inner) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;font:17px/1.5 system-ui,sans-serif;color:#0f1e33;background:#fff}main{max-width:560px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:28px;margin:0 0 16px}fieldset{border:0;padding:0;margin:0 0 16px}legend{font-weight:700;margin-bottom:8px}label{display:block;margin:0 0 12px}
input[type=text],input[type=email]{display:block;width:100%;box-sizing:border-box;min-height:48px;font:inherit;padding:8px 12px;border:1px solid #8a94a6;border-radius:8px}
.opts{display:flex;flex-wrap:wrap;gap:8px}.opts label{display:flex;align-items:center;gap:8px;min-height:48px;padding:0 14px;border:1px solid #8a94a6;border-radius:8px;margin:0}
.decl{display:flex;gap:10px;align-items:flex-start;min-height:48px}.decl input{width:24px;height:24px;margin-top:2px}
button{width:100%;min-height:56px;border:0;border-radius:10px;background:#003979;color:#fff;font:700 18px system-ui,sans-serif}
.err{border-left:5px solid #b3261e;background:#fdecea;padding:12px;margin:0 0 16px}</style></head><body><main>${inner}</main></body></html>`;
const donateForm = (error) => sitePage('Donate', `<h1>Donate</h1>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}
<form method="post" action="/donate">
<fieldset><legend>Amount</legend><div class="opts">
${[25, 50, 100].map((d) => `<label><input type="radio" name="amount" value="${d}"${d === 50 ? ' checked' : ''}> $${d}</label>`).join('')}
</div></fieldset>
<fieldset><legend>How often</legend><div class="opts">
<label><input type="radio" name="cadence" value="once" checked> Once</label><label><input type="radio" name="cadence" value="monthly"> Monthly</label>
</div></fieldset>
<label>First name<input type="text" name="first_name" autocomplete="given-name" required></label>
<label>Last name<input type="text" name="last_name" autocomplete="family-name" required></label>
<label>Email<input type="email" name="email" autocomplete="email" required></label>
<label>Street address<input type="text" name="address" autocomplete="street-address" required></label>
<label>Postal code<input type="text" name="postal_code" autocomplete="postal-code" required></label>
<label class="decl"><input type="checkbox" name="declaration" value="true"> <span>${esc(DECLARATION)}</span></label>
<button type="submit">Donate</button></form>`);

const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => r(b)); });
const site = http.createServer(async (req, res) => {
  const url = new URL(req.url, SITE);
  const send = (status, html, headers = {}) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers }); res.end(html); };
  try {
    if (req.method === 'GET' && url.pathname === '/donate') return send(200, donateForm(url.searchParams.get('error')));
    if (req.method === 'GET' && url.pathname === '/thanks') {
      return send(200, sitePage('Thank you', `<h1>Thank you</h1><p>Your contribution is on its way. A receipt follows by email.</p><p class="ref">Reference ${esc(url.searchParams.get('session') || '')}</p>`));
    }
    if (req.method === 'POST' && url.pathname === '/donate') {
      const f = new URLSearchParams(await readBody(req));
      const db = await getDb();
      const wsId = (await db.query('select id from workspaces order by created_at limit 1')).rows[0].id;
      const email = String(f.get('email') || '').trim().toLowerCase();
      try {
        const { result } = await runAction(db, { workspaceId: wsId, actorId: null, action: 'site.form.donate' }, async (tx, emit) => {
          // The person: the same email on file, or a new one (SITE.md's forms).
          let personId = (await tx.query('select id from persons where workspace_id = $1 and lower(email) = $2 and deleted_at is null limit 1', [wsId, email])).rows[0]?.id;
          if (!personId) {
            personId = (await ACTIONS['person.create'].handler(tx, { workspaceId: wsId }, {
              kind: 'person', first_name: f.get('first_name'), last_name: f.get('last_name'), email,
              address: f.get('address'), city: 'Surrey', postal: String(f.get('postal_code') || '').toUpperCase(),
            }, emit)).person.id;
          }
          return checkoutFor(tx, { workspaceId: wsId }, {
            personId, kind: 'donation', amountCents: Number(f.get('amount')) * 100, cadence: f.get('cadence'),
            declaration: f.get('declaration') === 'true', successUrl: `${SITE}/thanks?session={CHECKOUT_SESSION_ID}`, cancelUrl: `${SITE}/donate`,
            metadata: { source: 'e2e' },
          }, emit);
        });
        return send(303, '', { location: result.url });
      } catch (e) {
        if (e.status === 400) return send(303, '', { location: `/donate?error=${encodeURIComponent(e.message)}` });
        return send(503, sitePage('Not now', `<h1>${esc(e.message)}</h1>`));
      }
    }
    return send(404, sitePage('Not found', '<h1>Not found</h1>'));
  } catch (e) {
    return send(500, sitePage('Error', `<h1>${esc(e.message)}</h1>`));
  }
});
await new Promise((r) => site.listen(PORT + 2, '127.0.0.1', r));

// ── The browser ──
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const errors = [];
const watch = (page, who) => {
  page.on('pageerror', (e) => errors.push(`[${who}] ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && /key|unique|warning/i.test(m.text())) errors.push(`[${who}] ${m.text()}`); });
};
const blankTiles = (ctx) => ctx.route(/tile\.openstreetmap\.org/, (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"/>' }));
const deskCtx = await browser.newContext({ viewport: { width: 1360, height: 900 }, timezoneId: 'America/Vancouver' });
await blankTiles(deskCtx);
const desk = await deskCtx.newPage();
watch(desk, 'desk');
const api = (path, body) => desk.evaluate(async ([p, b]) => {
  const r = await fetch('/api' + p, b === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  return { status: r.status, json: await r.json().catch(() => null) };
}, [path, body]);
const go = async (path) => { await desk.goto(`${BASE}/admin${path}`, { waitUntil: 'domcontentloaded' }); await sleep(900); };
const text = async (page) => ((await page.innerText('main.page').catch(() => page.innerText('body').catch(() => ''))) || '').replace(/\s+/g, ' ');
const measure = (page, sel) => page.evaluate((targets) => {
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const yellow = [...document.querySelectorAll('main.page .btn-primary')].filter(visible).length;
  const overflow = document.documentElement.scrollWidth - window.innerWidth;
  let minTap = null; let minWho = '';
  for (const el of document.querySelectorAll(targets)) {
    if (!visible(el)) continue;
    const h = el.getBoundingClientRect().height;
    if (minTap == null || h < minTap) { minTap = h; minWho = el.outerHTML.slice(0, 90); }
  }
  return { yellow, overflow, minTap, minWho };
}, sel);
const TARGETS = 'main.page button, main.page a.btn, main.page a.ops-row, main.page input, main.page select';
const measured = async (page, name) => {
  const m = await measure(page, TARGETS);
  check(`${name}: ≤1 yellow, no sideways scroll, targets ≥48px`, m.yellow <= 1 && m.overflow <= 0 && (m.minTap == null || m.minTap >= 47.5),
    `yellow=${m.yellow} overflow=${m.overflow} minTap=${m.minTap} ${m.minTap < 47.5 ? m.minWho : ''}`);
};

// ── 1. The manager; Settings → Services ──
await desk.goto(`${BASE}/signup`, { waitUntil: 'domcontentloaded' });
await desk.fill('#su-name', 'Rae Desk');
if (await desk.locator('#su-org').count()) await desk.fill('#su-org', 'Imagine Surrey');
await desk.fill('#su-email', `desk.${tag}@example.org`);
await desk.fill('#su-password', 'surrey-forward-2026');
await desk.click('button[type="submit"]');
await desk.waitForURL(/\/admin\/?$/, { timeout: 15000 });
const me = (await api('/auth/me')).json;
check('the manager is signed in', !!me?.workspace?.id, JSON.stringify(me).slice(0, 120));

fake.endpoints([{ id: 'we_e2e', url: `${BASE}/stripe/webhook`, status: 'enabled', enabled_events: STRIPE_EVENTS }]);
await go('/settings/services');
const stripeRow = desk.locator('.sv2-row', { hasText: 'Online payments (Stripe)' });
await stripeRow.waitFor({ timeout: 10000 });
const rowText = (await stripeRow.innerText()).replace(/\s+/g, ' ');
check('Services: Stripe says Test mode', /Test mode/.test(rowText), rowText.slice(0, 200));
const hook = (await stripeRow.locator('.sv2-hook__url code').innerText()).trim();
check('Services: the webhook address to paste into Stripe', hook === `${BASE}/stripe/webhook`, hook);
check('Services: the events to send, all ten', (await stripeRow.locator('.sv2-events li').count()) === 10);
await stripeRow.getByRole('button', { name: 'Check' }).click();
const said = stripeRow.locator('.sv2-said');
await said.waitFor({ timeout: 10000 });
const saidText = await said.innerText();
check('Services: Check reads the webhook from Stripe and says it’s right', /✓ The key works \(test mode\) and the webhook sends every event base\.win needs/.test(saidText), saidText);
await desk.screenshot({ path: `${SHOTS}/1-services-desktop.png`, fullPage: false });
await stripeRow.scrollIntoViewIfNeeded();
await desk.screenshot({ path: `${SHOTS}/1b-services-stripe-desktop.png`, fullPage: false });
await measured(desk, 'Settings → Services (desktop)');

// ── 2. A donor on a phone: the form, Stripe's page, back ──
const donorCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'America/Vancouver', isMobile: true, hasTouch: true });
const phone = await donorCtx.newPage();
watch(phone, 'donor');
const donate = async ({ first, last, email, amount = 50, cadence = 'once', declare = true, shots = null }) => {
  await phone.goto(`${SITE}/donate`, { waitUntil: 'domcontentloaded' });
  await phone.check(`input[name="amount"][value="${amount}"]`);
  await phone.check(`input[name="cadence"][value="${cadence}"]`);
  await phone.fill('input[name="first_name"]', first);
  await phone.fill('input[name="last_name"]', last);
  await phone.fill('input[name="email"]', email);
  await phone.fill('input[name="address"]', '13450 104 Ave');
  await phone.fill('input[name="postal_code"]', 'V3T 1V8');
  if (declare) await phone.check('input[name="declaration"]');
  if (shots) await phone.screenshot({ path: `${SHOTS}/${shots}-donate-form-phone.png`, fullPage: true });
  await phone.getByRole('button', { name: 'Donate' }).click();
  await phone.waitForLoadState('domcontentloaded');
};
const ana = { first: 'Ana', last: 'Example', email: `ana.${tag}@example.org` };
await donate({ ...ana, shots: '2' });
check('the form sends the donor to Stripe’s page', phone.url().startsWith(`${fake.url}/pay/cs_test_`), phone.url());
const payText = (await phone.innerText('body')).replace(/\s+/g, ' ');
check('Stripe’s page: the campaign and $50.00', /Contribution to Imagine Surrey/.test(payText) && /\$50\.00/.test(payText), payText.slice(0, 160));
await phone.screenshot({ path: `${SHOTS}/3-stripe-checkout-phone.png`, fullPage: true });
const sessionId = phone.url().split('/pay/')[1];
await phone.getByRole('button', { name: 'Pay' }).click();
await phone.waitForURL(new RegExp(`^${SITE}/thanks`), { timeout: 15000 });
check('back on the website’s thank-you page, with the session', (await phone.innerText('h1')) === 'Thank you' && phone.url().includes(sessionId), phone.url());
await phone.screenshot({ path: `${SHOTS}/4-thanks-phone.png`, fullPage: false });
const hookCall = fake.delivered.find((d) => d.type === 'checkout.session.completed');
check('Stripe’s webhook landed (signed, 200, the gift recorded)', hookCall?.status === 200 && hookCall?.body?.result === 'gift recorded', JSON.stringify(hookCall));

// ── 3. Donations: the gift, marked online, and its receipt ──
const people = (await api(`/persons?q=${encodeURIComponent('Ana Example')}&limit=5`)).json.persons || [];
const anaRec = people.find((p) => p.email === ana.email);
check('the donor is on file, from the form', !!anaRec, JSON.stringify(people).slice(0, 160));
const gift = (await api('/records/gift?limit=50')).json.records.find((g) => g.person_id === anaRec?.id);
check('server: the gift — $50, card, online, the declaration kept', gift && Number(gift.amount_cents) === 5000 && gift.method === 'card' && gift.attrs?.source === 'online' && gift.attrs?.declaration?.text === DECLARATION,
  JSON.stringify(gift || {}).slice(0, 200));
const receipt = (await api(`/receipts/gift/${gift?.id}`)).json?.receipt;
check('server: its receipt, issued by itself', /^\d{4}-\d{4}$/.test(receipt?.number || ''), JSON.stringify(receipt || {}).slice(0, 120));
await go('/money');
const row = desk.locator('#gift-list .ops-row', { hasText: 'Ana Example' });
await row.waitFor({ timeout: 10000 });
const rowSub = (await row.innerText()).replace(/\s+/g, ' ');
check('Donations: the gift in the ledger, marked online, $50.00', /online/.test(rowSub) && /\$50\.00/.test(rowSub), rowSub);
await row.click();
const line = (await desk.locator('.rc-giftline').first().innerText({ timeout: 8000 }).catch(() => '')).replace(/\s+/g, ' ').trim();
check('Donations: opened, its receipt', line.startsWith(`Receipt ${receipt?.number}`), line);
const online = (await desk.locator('#pay-online-h').innerText().catch(() => '')).trim();
check('Donations: Online giving · test mode', /^Online giving · test mode$/i.test(online), online);
const onlineRow = (await desk.locator('#pay-online-list .ops-row', { hasText: 'Ana Example' }).first().innerText().catch(() => '')).replace(/\s+/g, ' ');
check('Donations: the payment, Paid', /Paid/.test(onlineRow) && /\$50\.00/.test(onlineRow), onlineRow);
await desk.screenshot({ path: `${SHOTS}/5-donations-desktop.png`, fullPage: true });

// ── 4. A monthly gift ──
const ben = { first: 'Ben', last: 'Example', email: `ben.${tag}@example.org` };
await donate({ ...ben, amount: 25, cadence: 'monthly' });
const subText = (await phone.innerText('body')).replace(/\s+/g, ' ');
check('monthly: Stripe’s page says $25.00 a month', /\$25\.00 a month/.test(subText) && /Monthly contribution to Imagine Surrey/.test(subText), subText.slice(0, 160));
await phone.getByRole('button', { name: 'Subscribe' }).click();
await phone.waitForURL(new RegExp(`^${SITE}/thanks`), { timeout: 15000 });
await go('/money');
const monthlyH = (await desk.locator('#pay-monthly-h').innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
check('Donations: Monthly donors · 1 · $25 a month', /^Monthly donors · 1 · \$25 a month$/i.test(monthlyH), monthlyH);
const benRow = (await desk.locator('#pay-monthly-list .ops-row', { hasText: 'Ben Example' }).innerText().catch(() => '')).replace(/\s+/g, ' ');
check('Donations: Ben, online, $25.00 a month, since this month', /online/.test(benRow) && /\$25\.00/.test(benRow) && /a month/.test(benRow) && /since/.test(benRow), benRow);

// ── 5. Over the limit before checkout: refused on the form ──
const cy = { first: 'Cy', last: 'Example', email: `cy.${tag}@example.org` };
const cyRec = (await api('/actions/person.create', { name: 'Cy Example', email: cy.email, address: '9 Fraser Hwy', city: 'Surrey' })).json.person;
const today = await desk.evaluate(() => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' }));
await api('/actions/gift.log', { person_id: cyRec.id, amount_cents: 140000, date: today, method: 'cheque' });
const sessionsBefore = fake.sessions.size;
await donate({ ...cy, amount: 50, shots: null });
const refusal = (await phone.locator('.err').innerText({ timeout: 8000 }).catch(() => '')).trim();
check('over the limit: refused on the form, in plain words', refusal === `That would take you over this year’s $1,429.70 limit for contributions to the city council slate. Try a smaller amount.`, refusal);
check('over the limit: never their own giving, and Stripe never asked', !/1,400/.test(refusal) && fake.sessions.size === sessionsBefore, `${fake.sessions.size} vs ${sessionsBefore}`);
await phone.screenshot({ path: `${SHOTS}/6-over-limit-refused-phone.png`, fullPage: false });
// No declaration: refused too.
await donate({ first: 'Di', last: 'Example', email: `di.${tag}@example.org`, declare: false });
const noDecl = (await phone.locator('.err').innerText({ timeout: 8000 }).catch(() => '')).trim();
check('no declaration: refused, and it says why', /tick the declaration/.test(noDecl), noDecl);

// Over the limit when it lands: the desk logs a gift while the donor is on Stripe's page.
const dee = { first: 'Dee', last: 'Example', email: `dee.${tag}@example.org` };
await donate({ ...dee, amount: 100 });
const deeSession = phone.url().split('/pay/')[1];
check('a $100 checkout opens for Dee', phone.url().startsWith(`${fake.url}/pay/`), phone.url());
const deeRec = ((await api(`/persons?q=${encodeURIComponent('Dee Example')}&limit=5`)).json.persons || []).find((p) => p.email === dee.email);
await api('/actions/gift.log', { person_id: deeRec?.id, amount_cents: 140000, date: today, method: 'cheque' });
await phone.getByRole('button', { name: 'Pay' }).click();
await phone.waitForURL(new RegExp(`^${SITE}/thanks`), { timeout: 15000 });
const deePi = fake.sessions.get(deeSession)?.payment_intent;
const refunded = await (async () => { for (let i = 0; i < 40; i += 1) { if (fake.refunds.some((r) => r.payment_intent === deePi)) return true; await sleep(250); } return false; })();
check('over the limit when it landed: refunded through Stripe, by itself', refunded && fake.refunds.find((r) => r.payment_intent === deePi)?.amount === 10000, JSON.stringify(fake.refunds.at(-1)));
const deeGifts = (await api('/records/gift?limit=50')).json.records.filter((g) => g.person_id === deeRec?.id).map((g) => g.amount_cents);
check('no gift for the payment — only the desk’s', JSON.stringify(deeGifts) === '[140000]', JSON.stringify(deeGifts));
await sleep(600);
await go('/money');
const deeNeed = desk.locator('.ops-needs .ops-row', { hasText: 'Dee Example' });
await deeNeed.waitFor({ timeout: 10000 });
check('Needs you: "Returned — over the limit"', /Returned — over the limit/.test(await deeNeed.innerText()));
await deeNeed.click();
const deeLine = (await desk.locator('.ops-needs .pay-line').first().innerText()).trim();
check('Needs you: refunded, no gift, and let them know (email isn’t connected)', deeLine === 'Over this year’s limit when it came in — refunded in full; no gift was logged. Not emailed (email isn’t connected) — let them know.', deeLine);
await desk.screenshot({ path: `${SHOTS}/6b-needs-over-limit-desktop.png`, fullPage: false });
await go('/');
const todayRow = (await desk.locator('.today-need', { hasText: 'Dee Example' }).first().innerText({ timeout: 8000 }).catch(() => '')).replace(/\s+/g, ' ');
check('Today: Needs you has it, "Over limit", $100.00', /Over limit/i.test(todayRow) && /\$100\.00/.test(todayRow), todayRow);
await desk.locator('.today-need', { hasText: 'Dee Example' }).first().scrollIntoViewIfNeeded().catch(() => {});
await desk.screenshot({ path: `${SHOTS}/6c-today-over-limit-desktop.png`, fullPage: false });
await go('/money');
await desk.locator('.ops-needs .ops-row', { hasText: 'Dee Example' }).click();
await desk.locator('.ops-needs').getByRole('button', { name: 'Got it' }).click();
await desk.locator('.toast', { hasText: 'Done' }).waitFor({ timeout: 8000 }).catch(() => {});

// ── 6. A refund made in Stripe: Needs you, Got it ──
const pi = fake.sessions.get(sessionId)?.payment_intent;
const refundHook = await fake.refund(pi);
check('a refund in Stripe: the webhook voids the gift', refundHook.status === 200 && refundHook.body?.result === 'refunded: the gift is void', JSON.stringify(refundHook.body));
await go('/money');
const need = desk.locator('.ops-needs .ops-row', { hasText: 'Ana Example' });
await need.waitFor({ timeout: 10000 });
check('Needs you: the refunded payment, "Refunded"', /Refunded/.test(await need.innerText()));
await need.click();
const needLine = (await desk.locator('.ops-needs .pay-line').first().innerText()).trim();
check('Needs you: "Refunded in Stripe — the gift is void."', needLine === 'Refunded in Stripe — the gift is void.', needLine);
await desk.screenshot({ path: `${SHOTS}/7-needs-refunded-desktop.png`, fullPage: false });
const stillThere = await desk.locator('#gift-list .ops-row', { hasText: 'Ana Example' }).count();
check('the ledger no longer counts it', stillThere === 0, stillThere);
const voidReceipt = (await api(`/receipts/gift/${gift?.id}`)).json?.receipt;
check('its receipt is void', voidReceipt?.void === true, JSON.stringify(voidReceipt || {}).slice(0, 100));
await desk.locator('.ops-needs').getByRole('button', { name: 'Got it' }).click();
await desk.locator('.toast', { hasText: 'Done' }).waitFor({ timeout: 8000 }).catch(() => {});
await sleep(600);
check('Got it: off Needs you', (await desk.locator('.ops-needs .ops-row', { hasText: 'Ana Example' }).count()) === 0);
await measured(desk, 'Donations (desktop)');

// ── 7. The phone ──
await desk.setViewportSize({ width: 390, height: 844 });
await go('/money');
await desk.locator('#pay-online-h').waitFor({ timeout: 10000 });
await desk.screenshot({ path: `${SHOTS}/8-donations-phone.png`, fullPage: true });
await measured(desk, 'Donations (phone)');
await go('/settings/services');
await desk.locator('.sv2-row', { hasText: 'Online payments (Stripe)' }).scrollIntoViewIfNeeded();
await desk.screenshot({ path: `${SHOTS}/9-services-stripe-phone.png`, fullPage: false });
await measured(desk, 'Settings → Services (phone)');
await phone.goto(`${SITE}/donate`, { waitUntil: 'domcontentloaded' });
const formTaps = await measure(phone, 'main input[type=text], main input[type=email], main button');
check('the stand-in form: no sideways scroll, its fields ≥48px', formTaps.overflow <= 0 && formTaps.minTap >= 47.5, JSON.stringify(formTaps));

const v = (await api('/audit/verify')).json;
check('the books verify', v?.ok === true, JSON.stringify(v));
check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
stopJobRunner();
await fake.close();
await new Promise((r) => site.close(r));
server.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
