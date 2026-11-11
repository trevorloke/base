// The sender's domain, guided (server/ext/mail/domain.js, service.js): the
// Email row of Settings → Services names the sender in use, shows where its
// delivery events go, and carries a "Sending domain" panel — the DNS records
// the sender asks for, each in or not found yet, base.win's own DMARC lookup,
// Check again and Add domain. Nothing is stored: the domain is MAIL_FROM's,
// found at the sender each time. Managers only; never a key in an answer.
// The sender and the DNS lookup are stand-ins.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { startFakeMail } from './fake-mail.js';
import { _setResolverForTest, dmarcOf } from '../lib/mail/dns.js';

const tag = Math.random().toString(36).slice(2, 8);
const KEYS = ['MAIL_PROVIDER', 'MAIL_FROM', 'RESEND_API_KEY', 'RESEND_API_BASE', 'RESEND_WEBHOOK_SECRET', 'RESEND_REGION', 'SENDGRID_API_KEY', 'SENDGRID_API_BASE',
  'SENDGRID_WEBHOOK_PUBLIC_KEY', 'STARBASE_PUBLIC_URL', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const DOMAIN = 'imaginesurrey.example';
const HOOK = 'https://base.example/hooks/mail/resend';
const EVENTS = ['email.delivered', 'email.bounced', 'email.complained', 'email.delivery_delayed', 'email.suppressed', 'email.failed'];
let db, mgr, staff, ws, resend, grid;
let txt = {}; // name → TXT records, or an Error to throw
const lookups = [];

const env = (set) => { for (const k of KEYS) delete process.env[k]; Object.assign(process.env, { STARBASE_PUBLIC_URL: 'https://base.example', ...set }); };
const useResend = (more = {}) => env({ RESEND_API_KEY: 're_domain_secret', RESEND_API_BASE: resend.url, MAIL_FROM: `Imagine Surrey <team@${DOMAIN}>`, ...more });
const useSendgrid = (more = {}) => env({ MAIL_PROVIDER: 'sendgrid', SENDGRID_API_KEY: 'SG.domain_secret', SENDGRID_API_BASE: grid.url, MAIL_FROM: `Imagine Surrey <team@${DOMAIN}>`, ...more });
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
const panel = async () => ok(await mgr.get('/api/mail/domain'));
const emailRow = async () => ok(await mgr.get('/api/connections')).services.find((s) => s.key === 'email');
const check = async () => ok(await mgr.post('/api/connections/check', { key: 'email' }));
const notFound = () => Object.assign(new Error('queryTxt ENOTFOUND'), { code: 'ENOTFOUND' });
const stubTxt = async (name) => {
  lookups.push(name);
  const v = txt[name];
  if (v instanceof Error) throw v;
  if (!v) throw notFound();
  return v;
};

before(async () => {
  db = await freshDb();
  resend = await startFakeMail({ provider: 'resend' });
  grid = await startFakeMail({ provider: 'sendgrid' });
  _setResolverForTest(stubTxt);
  env({});
  mgr = new Client();
  const r = await mgr.signup({ workspaceName: `Domain ${tag}`, email: `dom-mgr+${tag}@example.org`, jurisdiction: 'bc-municipal' });
  ws = r.json.workspace.id;
  const inv = await mgr.action('member.invite', { email: `dom-staff+${tag}@example.org`, role: 'staff' });
  staff = new Client();
  await staff.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: 'Sam Example', password: 'domain-pass-1' });
});
after(async () => {
  _setResolverForTest(null);
  await resend.close();
  await grid.close();
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

test('the Email row follows the sender: its name, the settings it needs, where its delivery events go', async () => {
  // Nothing set: Resend, as before; no webhook or domain to show yet.
  let row = await emailRow();
  assert.deepEqual([row.name, row.state, row.missing], ['Email (Resend)', 'missing', ['RESEND_API_KEY', 'MAIL_FROM']]);
  assert.deepEqual([row.hook, row.webhook], [undefined, undefined]);
  assert.equal(row.domainPanel, undefined);
  // Resend, set up.
  useResend();
  row = await emailRow();
  assert.deepEqual([row.name, row.state, row.missing, row.domainPanel], ['Email (Resend)', 'ready', [], true]);
  assert.deepEqual(row.hook, { url: HOOK, events: EVENTS, where: 'Resend: Webhooks → Add webhook', note: 'Then set RESEND_WEBHOOK_SECRET to the webhook’s signing secret.' });
  // Never under `webhook`: a page cached from before this row had one prints Stripe's own sentence
  // ("in Stripe: Developers → Webhooks → Add endpoint") over whatever comes under that name.
  assert.equal(row.webhook, undefined, 'an old cached page shows nothing here, not Stripe’s instructions over the email address');
  process.env.RESEND_WEBHOOK_SECRET = 'whsec_c2V0';
  assert.equal((await emailRow()).hook.note, undefined, 'the secret is in: nothing more to say');
  // SendGrid, named: its own settings, its own address.
  env({ MAIL_PROVIDER: 'sendgrid' });
  row = await emailRow();
  assert.deepEqual([row.name, row.state, row.missing], ['Email (SendGrid)', 'missing', ['SENDGRID_API_KEY', 'MAIL_FROM']]);
  assert.match(row.detail, /SendGrid needs a sender/);
  useSendgrid();
  row = await emailRow();
  assert.deepEqual([row.name, row.state, row.domainPanel], ['Email (SendGrid)', 'ready', true]);
  assert.equal(row.hook.url, 'https://base.example/hooks/mail/sendgrid');
  assert.deepEqual(row.hook.events, ['delivered', 'bounce', 'dropped', 'deferred', 'spamreport']);
  assert.equal(row.hook.where, 'SendGrid: Settings → Mail Settings → Event Webhooks');
  assert.match(row.hook.note, /SENDGRID_WEBHOOK_PUBLIC_KEY/);
  assert.equal(row.webhook, undefined);
  // Only SendGrid's key set, no MAIL_PROVIDER: it is the one with a key.
  env({ SENDGRID_API_KEY: 'SG.domain_secret' });
  row = await emailRow();
  assert.deepEqual([row.name, row.state, row.missing], ['Email (SendGrid)', 'missing', ['MAIL_FROM']]);
  // A sender base.win doesn't know: said plainly, on the row and on Check.
  env({ MAIL_PROVIDER: 'mailgun', RESEND_API_KEY: 're_domain_secret' });
  row = await emailRow();
  assert.deepEqual([row.name, row.state, row.missing], ['Email', 'missing', ['MAIL_PROVIDER']]);
  assert.match(row.detail, /MAIL_PROVIDER is “mailgun”.*resend or sendgrid/);
  assert.deepEqual(await check(), { key: 'email', ok: false, said: 'MAIL_PROVIDER is “mailgun”: base.win knows resend and sendgrid' });
  // Stripe's webhook block says where it goes, in the same shape.
  const stripe = ok(await mgr.get('/api/connections')).services.find((s) => s.key === 'stripe');
  assert.equal(stripe.webhook.where, 'Stripe: Developers → Webhooks → Add endpoint');
  useResend({ RESEND_WEBHOOK_SECRET: 'whsec_c2VjcmV0LXZhbHVl' });
  const all = JSON.stringify(ok(await mgr.get('/api/connections')));
  assert.ok(!all.includes('re_domain_secret') && !all.includes('c2VjcmV0LXZhbHVl'), 'never a key or a secret in an answer');
});

test('Sending domain: the sender’s DNS records, each in or not found yet, and base.win’s own DMARC lookup', async () => {
  useResend();
  resend.domains([]);
  txt = {};
  // Not on the sender's account yet.
  let p = await panel();
  assert.deepEqual(p, {
    provider: 'resend', name: 'Resend', from: `Imagine Surrey <team@${DOMAIN}>`, domain: DOMAIN, canManage: true, found: false, status: null, records: [],
    dmarc: { found: false, add: { type: 'TXT', name: '_dmarc', value: 'v=DMARC1; p=none' } },
  });
  assert.deepEqual(lookups.at(-1), `_dmarc.${DOMAIN}`);
  // Add domain: the sender now holds it and says what to put in DNS. On the log; nothing stored here.
  assert.equal((await staff.action('mail.domain.add', { domain: DOMAIN })).status, 403);
  assert.equal((await mgr.action('mail.domain.add', { domain: 'someone-elses.example' })).status, 400, 'only MAIL_FROM’s own domain');
  const seq = async () => Number((await db.query('select event_seq from workspaces where id = $1', [ws])).rows[0].event_seq);
  const before = await seq();
  const added = ok(await mgr.action('mail.domain.add', { domain: DOMAIN }));
  assert.deepEqual([added.found, added.status, added.records.length], [true, 'pending', 3]);
  assert.deepEqual(added.records[0], { purpose: 'SPF', type: 'MX', name: 'send', value: 'feedback-smtp.us-east-1.amazonses.example', priority: 10, ok: false });
  assert.deepEqual(added.records[2], { purpose: 'DKIM', type: 'TXT', name: 'resend._domainkey', value: 'p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQfake', ok: false });
  assert.equal(await seq(), before + 1, 'one line on the log: who added it');
  assert.equal(resend.calls.at(-1).auth, 'Bearer re_domain_secret');
  const ev = ok(await mgr.get('/api/events?since=0&limit=1000')).events.at(-1);
  assert.deepEqual([ev.action, ev.entity_type, ev.op, ev.payload], ['mail.domain.add', 'mail_domain', 'create', { provider: 'resend', domain: DOMAIN }]);
  assert.ok(ev.actor_id, 'by the manager who tapped');
  // The same read again finds it by name (nothing was kept here).
  p = await panel();
  assert.deepEqual([p.found, p.status, p.records.map((r) => r.ok)], [true, 'pending', [false, false, false]]);
  // Check again before the records are in: still not found. After: in, and verified.
  assert.equal((await staff.action('mail.domain.check', {})).status, 403);
  let c = ok(await mgr.action('mail.domain.check', {}));
  assert.deepEqual([c.status, c.records.map((r) => r.ok)], ['pending', [false, false, false]]);
  resend.publish(DOMAIN);
  txt[`_dmarc.${DOMAIN}`] = [['v=spf1 -all'], ['v=DMARC1; p=quarantine; ', 'rua=mailto:dmarc@imaginesurrey.example']];
  c = ok(await mgr.action('mail.domain.check', {}));
  assert.deepEqual([c.status, c.records.map((r) => r.ok)], ['verified', [true, true, true]]);
  assert.deepEqual(c.dmarc, { found: true, at: `_dmarc.${DOMAIN}`, value: 'v=DMARC1; p=quarantine; rua=mailto:dmarc@imaginesurrey.example' });
  assert.ok(!JSON.stringify([p, added, c]).includes('re_domain_secret'));
  // Managers only, on the read too.
  assert.equal((await staff.get('/api/mail/domain')).status, 403);
  assert.equal((await new Client().get('/api/mail/domain')).status, 401);
});

test('Sending domain, honestly: a sending-only key, no MAIL_FROM, a lookup that failed, a sender that didn’t answer', async () => {
  useResend();
  resend.domains([{ id: 'd-1', name: DOMAIN, status: 'verified' }]);
  txt = { [`_dmarc.${DOMAIN}`]: Object.assign(new Error('queryTxt ETIMEOUT'), { code: 'ETIMEOUT' }) };
  // The DNS lookup itself failed: unknown, never "not found".
  let p = await panel();
  assert.deepEqual([p.status, p.dmarc], ['verified', { found: null }]);
  // A sending-only key can't read or add domains: said, with the DMARC line still base.win's own.
  resend.sendingOnly();
  txt = {};
  p = await panel();
  assert.deepEqual([p.canManage, p.found, p.status, p.records, p.dmarc.found], [false, null, null, [], false]);
  const refused = await mgr.action('mail.domain.add', { domain: DOMAIN });
  assert.equal(refused.status, 409);
  assert.match(refused.json.error, /sending-only key/);
  assert.equal((await mgr.action('mail.domain.check', {})).status, 409);
  resend.sendingOnly(false);
  // A subdomain sender: the DMARC record of the domain above it counts, and says where it is.
  process.env.MAIL_FROM = `team@mail.${DOMAIN}`;
  txt = { [`_dmarc.${DOMAIN}`]: [['v=DMARC1; p=none']] };
  p = await panel();
  assert.deepEqual([p.domain, p.found, p.dmarc], [`mail.${DOMAIN}`, false, { found: true, at: `_dmarc.${DOMAIN}`, value: 'v=DMARC1; p=none' }]);
  // No MAIL_FROM: nothing to look up — said, not guessed.
  delete process.env.MAIL_FROM;
  p = await panel();
  assert.deepEqual(p, { provider: 'resend', name: 'Resend', from: null, domain: null, canManage: true, found: false, status: null, records: [], dmarc: null });
  assert.equal((await mgr.action('mail.domain.add', { domain: DOMAIN })).status, 409);
  // The sender didn't answer: an error to show ("Unavailable — Try again"), never an empty panel.
  useResend({ RESEND_API_BASE: 'http://127.0.0.1:9' });
  const down = await mgr.get('/api/mail/domain');
  assert.equal(down.status, 502);
  assert.match(down.json.error, /^Resend didn’t answer/);
  assert.ok(!JSON.stringify(down.json).includes('re_domain_secret'));
  // No sender at all: nothing to show.
  env({});
  assert.deepEqual(await panel(), { provider: null });
});

test('the DMARC lookup: “no record” only when DNS answers for the domain — a server whose DNS is down never says it', async () => {
  txt = {};
  try {
    // Every name "not found", and nothing answers for the domain either (DNS down or filtered): unknown.
    _setResolverForTest(stubTxt, async () => false);
    assert.deepEqual(await dmarcOf(DOMAIN), { found: null });
    assert.deepEqual(await dmarcOf(`mail.${DOMAIN}`), { found: null });
    // DNS answers for the domain, and it has no DMARC record: said.
    const asked = [];
    _setResolverForTest(stubTxt, async (d) => { asked.push(d); return true; });
    assert.deepEqual(await dmarcOf(`mail.${DOMAIN}`), { found: false });
    assert.deepEqual(asked, [DOMAIN], 'asked of the domain itself, once');
    assert.deepEqual(lookups.slice(-2), [`_dmarc.mail.${DOMAIN}`, `_dmarc.${DOMAIN}`], 'the sender’s own domain, then the one above — never the bare suffix');
    // A record that is there needs no second question; other TXT records beside it are passed over.
    txt = { [`_dmarc.${DOMAIN}`]: [['google-site-verification=abc'], ['V=DMARC1; p=reject']] };
    _setResolverForTest(stubTxt, async () => { throw new Error('never asked'); });
    assert.deepEqual(await dmarcOf(DOMAIN), { found: true, at: `_dmarc.${DOMAIN}`, value: 'V=DMARC1; p=reject' });
    // Not a domain: nothing to ask.
    assert.deepEqual(await dmarcOf('localhost'), { found: false });
    assert.deepEqual(await dmarcOf(''), { found: false });
  } finally { _setResolverForTest(stubTxt); txt = {}; }
});

test('Sending domain on SendGrid: its own records and words, the same panel', async () => {
  useSendgrid();
  grid.domains([]);
  txt = {};
  let p = await panel();
  assert.deepEqual([p.provider, p.name, p.found, p.records], ['sendgrid', 'SendGrid', false, []]);
  const added = ok(await mgr.action('mail.domain.add', { domain: DOMAIN }));
  assert.deepEqual([added.found, added.status], [true, 'pending']);
  assert.deepEqual(added.records, [
    { purpose: 'SPF', type: 'CNAME', name: `em1234.${DOMAIN}`, value: 'u1234.wl.sendgrid.example', ok: false },
    { purpose: 'DKIM', type: 'CNAME', name: `s1._domainkey.${DOMAIN}`, value: 's1.domainkey.u1234.wl.sendgrid.example', ok: false },
    { purpose: 'DKIM', type: 'CNAME', name: `s2._domainkey.${DOMAIN}`, value: 's2.domainkey.u1234.wl.sendgrid.example', ok: false },
  ]);
  grid.publish(DOMAIN);
  const c = ok(await mgr.action('mail.domain.check', {}));
  assert.deepEqual([c.status, c.records.map((r) => r.ok)], ['verified', [true, true, true]]);
  p = await panel();
  assert.deepEqual([p.found, p.status], [true, 'verified']);
  grid.sendingOnly();
  p = await panel();
  assert.deepEqual([p.canManage, p.found], [false, null]);
  grid.sendingOnly(false);
  assert.ok(!JSON.stringify([p, added, c]).includes('SG.domain_secret'));
});

test('Check on Email: the key, the domain, DMARC and where delivery events go — each shortfall one sentence', async () => {
  const hook = (more = {}) => ({ id: 'wh_1', endpoint: HOOK, status: 'enabled', events: EVENTS, created_at: '2026-11-01T00:00:00.000Z', ...more });
  useResend({ RESEND_WEBHOOK_SECRET: 'whsec_c2V0' });
  resend.reset();
  resend.domains([{ id: 'd-1', name: DOMAIN, status: 'verified' }]);
  resend.hooks([hook()]);
  txt = { [`_dmarc.${DOMAIN}`]: [['v=DMARC1; p=none']] };
  assert.deepEqual(await check(), { key: 'email', ok: true, said: `The key works and ${DOMAIN} is verified · DMARC is in · bounces and complaints come back here` });
  // Each thing missing, in plain words.
  txt = {};
  let c = await check();
  assert.deepEqual([c.ok, c.said], [false, `The key works and ${DOMAIN} is verified. There’s no DMARC record yet: add the one under Sending domain.`]);
  txt = { [`_dmarc.${DOMAIN}`]: Object.assign(new Error('queryTxt ESERVFAIL'), { code: 'ESERVFAIL' }) };
  assert.match((await check()).said, /DMARC couldn’t be looked up just now\.$/);
  txt = { [`_dmarc.${DOMAIN}`]: [['v=DMARC1; p=none']] };
  resend.hooks([]);
  c = await check();
  assert.deepEqual([c.ok, c.said], [false, `The key works and ${DOMAIN} is verified. Resend isn’t sending bounces and complaints here yet: add a webhook to ${HOOK}.`]);
  resend.hooks([hook({ endpoint: 'https://elsewhere.example/hooks/mail/resend' })]);
  assert.match((await check()).said, /isn’t sending bounces and complaints here yet/);
  resend.hooks([hook({ status: 'disabled' })]);
  assert.match((await check()).said, /The webhook to https:\/\/base\.example\/hooks\/mail\/resend is off in Resend: turn it back on\.$/);
  resend.hooks([hook({ events: ['email.delivered', 'email.bounced'] })]);
  assert.match((await check()).said, /The webhook is there, but it doesn’t send email\.complained\.$/);
  resend.hooks([hook({ endpoint: `${HOOK}/` })]);
  delete process.env.RESEND_WEBHOOK_SECRET;
  c = await check();
  assert.deepEqual([c.ok, c.said], [false, `The key works and ${DOMAIN} is verified. Set RESEND_WEBHOOK_SECRET to the webhook’s signing secret.`]);
  // Two things missing: both said.
  txt = {};
  resend.hooks([]);
  assert.equal((await check()).said, `The key works and ${DOMAIN} is verified. There’s no DMARC record yet: add the one under Sending domain. Resend isn’t sending bounces and complaints here yet: add a webhook to ${HOOK}.`);
  // The domain comes first: until it's verified, that is the one thing said (as before).
  resend.domains([{ id: 'd-1', name: DOMAIN, status: 'pending' }]);
  assert.deepEqual(await check(), { key: 'email', ok: false, said: `The key works; ${DOMAIN} is “pending” in Resend — finish its DNS records` });
  resend.domains([]);
  assert.deepEqual(await check(), { key: 'email', ok: false, said: `The key works, but ${DOMAIN} isn’t a domain on this Resend account` });
  // A sending-only key: the key is fine; what can't be read is said, and the secret still matters.
  resend.sendingOnly();
  process.env.RESEND_WEBHOOK_SECRET = 'whsec_c2V0';
  txt = { [`_dmarc.${DOMAIN}`]: [['v=DMARC1; p=none']] };
  assert.deepEqual(await check(), { key: 'email', ok: true, said: 'The key works (a sending-only key: the domain can’t be checked from here) · DMARC is in' });
  delete process.env.RESEND_WEBHOOK_SECRET;
  c = await check();
  assert.deepEqual([c.ok, c.said], [false, 'The key works (a sending-only key: the domain can’t be checked from here). Bounces and complaints aren’t coming back yet: add the webhook below, then set RESEND_WEBHOOK_SECRET.']);
  resend.sendingOnly(false);
  assert.ok(resend.calls.length > 10 && resend.calls.every((x) => x.method === 'GET'), 'Check only ever reads');
  assert.equal(resend.sent.length, 0, 'and sends nothing');
});

test('Check on Email with SendGrid: the key, the domain, DMARC — and delivery events only once one has come in', async () => {
  useSendgrid();
  grid.domains([]);
  txt = { [`_dmarc.${DOMAIN}`]: [['v=DMARC1; p=none']] };
  assert.deepEqual(await check(), { key: 'email', ok: false, said: `The key works, but ${DOMAIN} isn’t an authenticated domain on this SendGrid account` });
  grid.domains([{ id: 7, domain: DOMAIN, valid: false }]);
  assert.deepEqual(await check(), { key: 'email', ok: false, said: `The key works; ${DOMAIN} isn’t verified in SendGrid yet — finish its DNS records` });
  grid.domains([{ id: 7, domain: DOMAIN, valid: true }]);
  let c = await check();
  assert.deepEqual([c.ok, c.said], [false, `The key works and ${DOMAIN} is verified. Set SENDGRID_WEBHOOK_PUBLIC_KEY to the Event Webhook’s verification key.`]);
  process.env.SENDGRID_WEBHOOK_PUBLIC_KEY = grid.publicKey;
  c = await check();
  assert.deepEqual([c.ok, c.said], [false, `The key works and ${DOMAIN} is verified. No delivery event has come in from SendGrid yet: send a test email, then check again.`]);
  await db.query("insert into mail_events (provider, id, workspace_id, kind) values ('sendgrid', $1, $2, 'delivered')", [`check-${tag}`, ws]);
  assert.deepEqual(await check(), { key: 'email', ok: true, said: `The key works and ${DOMAIN} is verified · DMARC is in · bounces and complaints come back here` });
  grid.fail(false);
  process.env.SENDGRID_API_KEY = '';
  assert.deepEqual(await check(), { key: 'email', ok: false, said: 'SENDGRID_API_KEY isn’t set' });
});
