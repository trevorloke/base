// Services (ext/connections): every outside service, whether it's set up,
// and a live check of each — managers only, never a key in an answer. The
// services themselves are stand-ins here (fetch is replaced).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';
import { mountAt } from '../lib/mount.js';
import { _setResolverForTest } from '../lib/mail/dns.js';
import { _resetForTest as resetTiles } from '../lib/gtiles.js';
import { _resetLookupForTest } from '../lib/geocode.js';

// Google's answer when the key's project has no billing (Map Tiles' shape).
const BILLING_OFF = { error: { code: 403, status: 'PERMISSION_DENIED',
  message: 'This API method requires billing to be enabled. Please enable billing on project #1 by visiting https://console.developers.google.com/billing/enable?project=1 then retry.',
  details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'BILLING_DISABLED', domain: 'googleapis.com' }] } };

const tag = Math.random().toString(36).slice(2, 8);
const realFetch = globalThis.fetch;
const saved = { ...process.env };
const KEYS = ['RESEND_API_KEY', 'MAIL_FROM', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM', 'STARBASE_PUBLIC_URL',
  'GEOCODER', 'GOOGLE_MAPS_TILES', 'GOOGLE_MAPS_SERVER_KEY', 'DATABASE_URL', 'TWILIO_VOICE', 'STARBASE_TILE_URL', 'STARBASE_TILE_PROVIDER', 'STARBASE_TILE_KEY',
  'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'BASE_PATH', 'CALLHUB_API_KEY', 'CALLHUB_API_BASE'];
let mgr, staff;
let resendDomains = [];
let resendHooks = [];
let dmarc = null; // the sender's domain's DMARC record (TXT), when it has one
let twilioNumbers = [];
let refuse = false;
const seen = [];
KEYS.push('GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_TOKEN_KEY', 'GOOGLE_ACCOUNTS_BASE', 'GOOGLE_OAUTH_BASE', 'BASE_DOOR_KEY');
KEYS.push('MAIL_PROVIDER', 'RESEND_WEBHOOK_SECRET', 'SENDGRID_API_KEY', 'MAILCHIMP_API_KEY', 'MAILCHIMP_API_BASE', 'MAILCHIMP_AUDIENCE_ID');

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
    if (u.hostname === 'tile.googleapis.com') {
      return refuse ? new Response(JSON.stringify(BILLING_OFF), { status: 403 }) : new Response(JSON.stringify({ session: 's', expiry: '9999999999' }));
    }
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
  assert.deepEqual(Object.keys(s), ['database', 'public', 'email', 'texting', 'geocoder', 'tiles', 'jobs', 'mailchimp', 'stripe', 'callhub', 'google', 'twostep']);
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
  assert.equal(await kind('+442079460000'), 'Number +442079460000', 'not a North American number: its kind isn’t guessed');
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
  // Pasted with a newline: read the same here as on the map.
  process.env.GOOGLE_MAPS_TILES = '1\n';
  process.env.GOOGLE_MAPS_SERVER_KEY = ' gkey\n';
  resetTiles();
  const toGoogle = () => seen.filter((s) => s.host === 'tile.googleapis.com').length;
  const before = toGoogle();
  const good = await check('tiles');
  assert.deepEqual([good.ok, good.said], [true, 'Working · Google Map Tiles answering']);
  assert.equal(byKey(await list()).tiles.name, 'Map background (Google Map Tiles)');
  assert.equal(toGoogle() - before, 2, 'one session and one tile');
  // Refused: plain words, Google's own words and the step that fixes it.
  refuse = true;
  resetTiles();
  const bad = await check('tiles');
  assert.equal(bad.ok, false);
  assert.equal(bad.said, 'Billing isn’t turned on for this Google Cloud project.');
  assert.match(bad.todo, /^Google said: “This API method requires billing to be enabled\..*”\nSee Going live §5, Recipe B step 2\.$/s);
  assert.match(bad.todo, /https:\/\/console\.developers\.google\.com\/billing\/enable\?project=1/);
  assert.doesNotMatch(JSON.stringify(bad), /gkey/);
  // Checked again within 30 s: the same answer, no second call to Google.
  const calls = toGoogle();
  refuse = false;
  assert.equal((await check('tiles')).ok, false);
  assert.equal(toGoogle(), calls);
  resetTiles();
  process.env.GOOGLE_MAPS_TILES = 'off';
  assert.equal(byKey(await list()).tiles.name, 'Map background (OpenStreetMap and CARTO)');
  assert.match((await check('tiles')).said, /Going live §5/);
  process.env.GOOGLE_MAPS_TILES = '1';
  process.env.GEOCODER = 'off';
  _resetLookupForTest();
  assert.equal(byKey(await list()).geocoder.state, 'missing');
  assert.equal((await check('geocoder')).ok, false);
  _resetLookupForTest();
  delete process.env.GEOCODER;
});

test('the tiles row reads the map’s own setting: the Stadia preset is named, ready, and never called OpenStreetMap', async () => {
  const google = process.env.GOOGLE_MAPS_TILES;
  delete process.env.GOOGLE_MAPS_TILES;
  process.env.STARBASE_TILE_PROVIDER = 'stadia';
  process.env.STARBASE_TILE_KEY = 'stadiakey';
  try {
    const t = byKey(await list()).tiles;
    assert.equal(t.name, 'Map background (Stadia Maps)');
    assert.equal(t.state, 'ready');
    assert.match(t.detail, /^Stadia Maps, straight to the phones/);
    const c = await check('tiles');
    assert.equal(c.ok, true);
    assert.equal(c.said, 'Stadia Maps’ tiles come straight to each phone');
    assert.doesNotMatch(JSON.stringify([t, c]), /OpenStreetMap|stadiakey/);
    // A name the map doesn't know: said, and the free map meanwhile.
    process.env.STARBASE_TILE_PROVIDER = 'mapbox';
    process.env.GOOGLE_MAPS_TILES = 'yes please';
    const u = byKey(await list()).tiles;
    // The free map draws meanwhile; every setting it couldn't use is named.
    assert.equal(u.state, 'default');
    assert.match(u.detail, /GOOGLE_MAPS_TILES=yes please isn’t understood — use 1 · /);
    delete process.env.GOOGLE_MAPS_TILES;
    assert.match(u.detail, /STARBASE_TILE_PROVIDER=mapbox isn’t known — use stadia/);
    delete process.env.STARBASE_TILE_PROVIDER;
    const d = byKey(await list()).tiles;
    assert.deepEqual([d.name, d.state], ['Map background (OpenStreetMap and CARTO)', 'default']);
  } finally {
    delete process.env.STARBASE_TILE_PROVIDER;
    delete process.env.STARBASE_TILE_KEY;
    if (google != null) process.env.GOOGLE_MAPS_TILES = google;
  }
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

test('Google (sign-in and connections): missing, default, ready — never a value; the Check against a stand-in Google', async () => {
  const { startFakeGoogle } = await import('./fake-google.js');
  globalThis.fetch = realFetch;
  const secret = `secret-${tag}-value`;
  const key = `google-token-key-${tag}-0123456789abcdefghij`;
  const g = await startFakeGoogle({ port: 0, clientId: `id-${tag}.apps.example`, secret, redirectUris: ['https://base.example.org/api/auth/google/back'] });
  try {
    let row = byKey(await list()).google;
    assert.deepEqual([row.state, row.missing, row.panel, row.launch], ['missing', ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'], 'google', false]);
    Object.assign(process.env, { GOOGLE_OAUTH_CLIENT_ID: `id-${tag}.apps.example`, GOOGLE_OAUTH_CLIENT_SECRET: secret, GOOGLE_ACCOUNTS_BASE: g.base, GOOGLE_OAUTH_BASE: g.base });
    row = byKey(await list()).google;
    assert.equal(row.state, 'missing');
    assert.match(row.detail, /Set STARBASE_PUBLIC_URL \(https:\/\/…\) first/);
    process.env.STARBASE_PUBLIC_URL = 'https://base.example.org';
    row = byKey(await list()).google;
    assert.equal(row.state, 'default', 'sign-in works; connections need the key');
    assert.match(row.detail, /^Redirect address for Google Cloud: https:\/\/base\.example\.org\/api\/auth\/google\/back · Connections need GOOGLE_TOKEN_KEY/);
    assert.match(row.detail, /0 people sign in with Google · 0 connected accounts/);
    assert.match(row.detail, /Test address in use/);
    process.env.GOOGLE_TOKEN_KEY = key;
    row = byKey(await list()).google;
    assert.equal(row.state, 'ready');
    assert.match(row.detail, /Connections: ready/);
    assert.doesNotMatch(row.detail, /BASE_DOOR_KEY/);
    process.env.BASE_PATH = '/imaginesurrey';
    assert.match(byKey(await list()).google.detail, /Google sign-in limits count everyone through base\.win as one address — set BASE_DOOR_KEY/);
    delete process.env.BASE_PATH;
    const body = JSON.stringify(await list());
    for (const v of [secret, key, `id-${tag}.apps.example`]) assert.ok(!body.includes(v), 'no value in the answer');

    // The Check: discovery, the redirect address, the id and secret.
    let c = await check('google');
    assert.equal(c.ok, true, c.said);
    assert.match(c.said, /^Working · Google knows this redirect address · Google accepts this client ID and secret$/);
    process.env.STARBASE_PUBLIC_URL = 'https://other.example.org';
    c = await check('google');
    assert.equal(c.ok, false);
    assert.match(c.said, /Add https:\/\/other\.example\.org\/api\/auth\/google\/back to the client’s Authorized redirect URIs/);
    process.env.STARBASE_PUBLIC_URL = 'https://base.example.org';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'wrong-secret';
    c = await check('google');
    assert.equal(c.ok, false);
    assert.match(c.said, /Google doesn’t recognise this client ID and secret\. Copy them again/);
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = secret;
    // Google moved its addresses (here: the discovery document names others).
    process.env.GOOGLE_OAUTH_BASE = g.base.replace('127.0.0.1', 'localhost');
    c = await check('google');
    assert.equal(c.ok, false);
    assert.match(c.said, /^Google has moved its sign-in addresses — base\.win needs an update/);
    assert.ok(!JSON.stringify(c).includes(secret));
  } finally {
    for (const k of ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_TOKEN_KEY', 'GOOGLE_ACCOUNTS_BASE', 'GOOGLE_OAUTH_BASE', 'STARBASE_PUBLIC_URL', 'BASE_PATH']) delete process.env[k];
    await g.close();
  }
});
