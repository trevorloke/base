// Services (ext/connections): every outside service, whether it's set up,
// and a live check of each — managers only, never a key in an answer. The
// services themselves are stand-ins here (fetch is replaced).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';
import { mountAt } from '../lib/mount.js';
import { _setResolverForTest } from '../lib/mail/dns.js';

const tag = Math.random().toString(36).slice(2, 8);
const realFetch = globalThis.fetch;
const saved = { ...process.env };
const KEYS = ['RESEND_API_KEY', 'MAIL_FROM', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM', 'STARBASE_PUBLIC_URL',
  'GEOCODER', 'GOOGLE_MAPS_TILES', 'GOOGLE_MAPS_SERVER_KEY', 'DATABASE_URL', 'TWILIO_VOICE', 'STARBASE_TILE_URL',
  'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'BASE_PATH'];
let mgr, staff;
let resendDomains = [];
let resendHooks = [];
let dmarc = null; // the sender's domain's DMARC record (TXT), when it has one
let twilioNumbers = [];
let refuse = false;
const seen = [];
KEYS.push('MAIL_PROVIDER', 'RESEND_WEBHOOK_SECRET', 'SENDGRID_API_KEY');

before(async () => {
  for (const k of KEYS) delete process.env[k];
  await freshDb();
  // The DMARC lookup is base.win's own (lib/mail/dns.js): a stand-in here too.
  _setResolverForTest(async () => { if (!dmarc) throw Object.assign(new Error('queryTxt ENOTFOUND'), { code: 'ENOTFOUND' }); return dmarc; });
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    seen.push({ host: u.hostname, path: u.pathname, auth: opts.headers?.Authorization || null });
    if (u.hostname === 'api.resend.com') {
      if (refuse) return new Response(JSON.stringify({ name: 'validation_error', message: 'API key is invalid' }), { status: 401 });
      return new Response(JSON.stringify({ data: u.pathname === '/webhooks' ? resendHooks : resendDomains }));
    }
    if (u.hostname === 'api.twilio.com') {
      if (refuse) return new Response('{}', { status: 401 });
      return new Response(JSON.stringify({ incoming_phone_numbers: twilioNumbers }));
    }
    if (u.hostname === 'geocoder.api.gov.bc.ca') {
      return new Response(JSON.stringify({ features: [{ geometry: { coordinates: [-122.84, 49.19] }, properties: {
        civicNumber: 100, streetName: '104', streetType: 'Ave', localityName: 'Surrey', fullAddress: '100 104 Ave, Surrey, BC', matchPrecision: 'CIVIC_NUMBER' } }] }));
    }
    if (u.hostname === 'starbase.example.org') return new Response(JSON.stringify({ ok: true, service: 'starbase', env: 'production' }));
    if (u.hostname === 'tile.googleapis.com') return new Response(JSON.stringify({ session: 's', expiry: '9999999999' }), { status: refuse ? 403 : 200 });
    return realFetch(url, opts);
  };
  mgr = new Client();
  await mgr.signup({ workspaceName: `Services ${tag}`, email: `sv-mgr+${tag}@example.org`, jurisdiction: 'bc-municipal' });
  const inv = await mgr.action('member.invite', { email: `sv-staff+${tag}@example.org`, role: 'staff' });
  staff = new Client();
  await staff.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: 'Sam Example', password: 'services-pass-1' });
});
after(() => {
  globalThis.fetch = realFetch;
  _setResolverForTest(null);
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
const list = async () => ok(await mgr.get('/api/connections'));
const byKey = (l) => Object.fromEntries(l.services.map((s) => [s.key, s]));
const check = async (key) => ok(await mgr.post('/api/connections/check', { key }));

test('nothing set: what each service is for and which settings are missing — managers only', async () => {
  const s = byKey(await list());
  assert.deepEqual(Object.keys(s), ['database', 'public', 'email', 'texting', 'geocoder', 'tiles', 'jobs', 'stripe', 'twostep']);
  assert.deepEqual(s.email.missing, ['RESEND_API_KEY', 'MAIL_FROM']);
  assert.equal(s.email.state, 'missing');
  assert.deepEqual(s.texting.missing, ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM']);
  assert.equal(s.public.state, 'missing');
  assert.equal(s.geocoder.state, 'ready', 'the BC geocoder needs no key');
  assert.equal(s.tiles.state, 'default');
  assert.equal((await staff.get('/api/connections')).status, 403);
  assert.equal((await staff.post('/api/connections/check', { key: 'email' })).status, 403);
  assert.equal((await new Client().get('/api/connections')).status, 401);
  assert.equal((await mgr.post('/api/connections/check', { key: 'nope' })).status, 404);
  const e = await check('email');
  assert.deepEqual([e.ok, e.said], [false, 'RESEND_API_KEY isn’t set']);
});

test('email: the key works and the sender’s domain is verified — or says exactly what isn’t', async () => {
  process.env.RESEND_API_KEY = 're_secret_key_123';
  process.env.MAIL_FROM = 'Imagine Surrey <team@imaginesurrey.ca>';
  const l = await list();
  assert.ok(!JSON.stringify(l).includes('re_secret_key_123'), 'never the key itself');
  assert.equal(byKey(l).email.state, 'ready');
  resendDomains = [{ name: 'imaginesurrey.ca', status: 'pending' }];
  assert.match((await check('email')).said, /“pending” in Resend/);
  resendDomains = [{ name: 'imaginesurrey.ca', status: 'verified' }];
  // The key and the domain are right; what email still needs to hear back is said, a sentence each (ext/mail).
  let e = await check('email');
  assert.deepEqual([e.ok, e.said], [false, 'The key works and imaginesurrey.ca is verified. There’s no DMARC record yet: add the one under Sending domain. '
    + 'Resend isn’t sending bounces and complaints here yet: add a webhook to http://localhost/hooks/mail/resend.']);
  dmarc = [['v=DMARC1; p=none']];
  resendHooks = [{ endpoint: 'http://localhost/hooks/mail/resend', status: 'enabled', events: ['email.delivered', 'email.bounced', 'email.complained'] }];
  process.env.RESEND_WEBHOOK_SECRET = 'whsec_c2VjcmV0LWtleQ==';
  e = await check('email');
  assert.deepEqual([e.ok, e.said], [true, 'The key works and imaginesurrey.ca is verified · DMARC is in · bounces and complaints come back here']);
  assert.equal(seen.at(-1).auth, 'Bearer re_secret_key_123');
  assert.ok(!JSON.stringify(await list()).includes('c2VjcmV0LWtleQ'), 'never the webhook’s secret');
  refuse = true;
  assert.deepEqual(Object.values(await check('email')).slice(1), [false, 'Resend refused the key']);
  refuse = false;
});

test('texting: the number is on the account and its replies come here', async () => {
  Object.assign(process.env, { TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM: '+16045550100' });
  twilioNumbers = [];
  assert.match((await check('texting')).said, /isn’t a number on this Twilio account/);
  twilioNumbers = [{ phone_number: '+16045550100', sms_url: 'https://old.example.org/sms' }];
  assert.match((await check('texting')).said, /set STARBASE_PUBLIC_URL/);
  process.env.STARBASE_PUBLIC_URL = 'https://starbase.example.org';
  assert.match((await check('texting')).said, /go to https:\/\/old\.example\.org\/sms — set it to https:\/\/starbase\.example\.org\/api\/public\/twilio\/sms/);
  twilioNumbers = [{ phone_number: '+16045550100', sms_url: 'https://starbase.example.org/api/public/twilio/sms' }];
  const t = await check('texting');
  assert.equal(t.ok, true, t.said);
  const l = await list();
  assert.equal(l.inbound[0].url, 'https://starbase.example.org/api/public/twilio/sms');
  assert.ok(!JSON.stringify(l).includes('tok'), 'never the token');
  // The row says which kind of number it is: in Canada a text to a list wants a verified toll-free number or a short code.
  const kind = async (from) => { process.env.TWILIO_FROM = from; return byKey(await list()).texting.detail; };
  assert.equal(await kind('+16045550100'), 'Number +16045550100 · a local number — for a text to a list in Canada, Twilio asks for a verified toll-free number or a short code');
  assert.equal(await kind('+18335550100'), 'Number +18335550100 · toll-free — Twilio must verify it before it can text');
  assert.equal(await kind('(888) 555-0100'), 'Number (888) 555-0100 · toll-free — Twilio must verify it before it can text');
  assert.equal(await kind('55501'), 'Number 55501 · a short code');
  assert.match(await kind('+18005550100'), /toll-free/);
  assert.match(await kind('+18015550100'), /a local number/, '801 is Utah, not toll-free');
  process.env.TWILIO_FROM = '+16045550100';
});

test('the public address, the address service, the database and Google tiles answer their checks', async () => {
  assert.equal((await check('public')).ok, true);
  const g = await check('geocoder');
  assert.equal(g.ok, true);
  assert.match(g.said, /100 104 Ave, Surrey/);
  assert.match((await check('database')).said, /^Answering · \d+ people on file$/);
  process.env.GOOGLE_MAPS_TILES = '1';
  assert.equal(byKey(await list()).tiles.state, 'missing');
  process.env.GOOGLE_MAPS_SERVER_KEY = 'gkey';
  assert.equal((await check('tiles')).ok, true);
  refuse = true;
  assert.match((await check('tiles')).said, /Google refused the tiles session \(403\)/);
  refuse = false;
  process.env.GEOCODER = 'off';
  assert.equal(byKey(await list()).geocoder.state, 'missing');
  assert.equal((await check('geocoder')).ok, false);
  delete process.env.GEOCODER;
});

test('files in: the desk’s own address — /desk under the client’s path on base.win, /admin at a server’s root', async () => {
  const lists = (l) => l.inbound.find((i) => i.name === 'Lists and voted files').url;
  process.env.STARBASE_PUBLIC_URL = 'https://starbase.example.org';
  assert.equal(lists(await list()), 'https://starbase.example.org/admin/people/import');
  // On base.win the desk is /desk (/admin there is only an old address, sent on).
  process.env.BASE_PATH = '/imaginesurrey';
  process.env.STARBASE_PUBLIC_URL = 'https://base.win/imaginesurrey/';
  assert.equal(lists(await list()), 'https://base.win/imaginesurrey/desk/people/import');
  // No public address: the one the page was opened at, under the client's path or at the server's own root.
  delete process.env.STARBASE_PUBLIC_URL;
  const under = await mountAt(app, '/imaginesurrey')(new Request('http://base.test/imaginesurrey/api/connections', { headers: { cookie: mgr.cookie } }));
  assert.equal(lists(await under.json()), 'http://base.test/imaginesurrey/desk/people/import');
  assert.equal(lists(await list()), 'http://localhost/admin/people/import');
  delete process.env.BASE_PATH;
});
