// Services — every outside service base ground talks to, whether it's set up,
// and a live check of each (managers; Settings → Services). INTEGRATIONS.md
// is the long version: where each key comes from and what to point where.
//
//   GET  /api/connections          { services: [{ key, name, for, launch,
//                                    state: 'ready'|'missing'|'default',
//                                    missing: [ENV…], set: [ENV…], detail,
//                                    checkable }], inbound: [{ name, url, how }],
//                                    publicUrl }
//   POST /api/connections/check    { key } → { ok, said } — one real call to
//                                    the service (8 s at most); nothing is
//                                    sent to anyone, nothing is written.
//
// Keys and tokens are never in an answer: only which settings are present.
import { Hono } from 'hono';
import { suggestAddresses } from '../../lib/geocode.js';
import { jobRunnerOn } from '../../lib/jobs.js';

const MANAGER = 'manager';
const TIMEOUT_MS = 8000;
const env = (k) => String(process.env[k] || '').trim();
const has = (k) => Boolean(env(k));
const publicUrl = () => env('BASE_PUBLIC_URL').replace(/\/$/, '');
const twilioBase = () => (env('TWILIO_API_BASE') || 'https://api.twilio.com').replace(/\/$/, '');
const provider = () => (env('GEOCODER') || 'bc').toLowerCase();
const googleTiles = () => env('GOOGLE_MAPS_TILES') === '1';

const row = (key, name, purpose, launch, needs, extra = {}) => {
  const missing = needs.filter((k) => !has(k));
  return { key, name, for: purpose, launch, missing, set: needs.filter(has), state: missing.length ? 'missing' : 'ready', checkable: true, ...extra };
};

export const services = () => {
  const pub = publicUrl();
  const geo = provider();
  const list = [
    row('database', 'Database', 'Everything the campaign records', true, [], {
      detail: has('DATABASE_URL') ? 'Postgres (DATABASE_URL)' : 'Built in, on this server’s disk — fine on a laptop; a deployment uses Postgres (DATABASE_URL)',
      state: has('DATABASE_URL') || process.env.NODE_ENV !== 'production' ? 'ready' : 'missing',
      missing: has('DATABASE_URL') || process.env.NODE_ENV !== 'production' ? [] : ['DATABASE_URL'],
    }),
    row('public', 'Public address', 'Links in every email (invites, unsubscribe, receipts), texting’s delivery reports and calls', true, ['BASE_PUBLIC_URL'], {
      detail: pub ? `${pub}${/^https:\/\//.test(pub) ? '' : ' — must start with https://'}` : 'Not set: links use whatever address the page was opened at',
      state: pub && /^https:\/\//.test(pub) ? 'ready' : 'missing',
    }),
    row('email', 'Email (Resend)', 'Invites, newsletters, press releases, ladder emails, shift alerts, donation receipts', true, ['RESEND_API_KEY', 'MAIL_FROM'], {
      detail: has('MAIL_FROM') ? `From ${env('MAIL_FROM')}` : 'MAIL_FROM not set: Resend’s test sender only reaches the account’s owner',
    }),
    row('texting', 'Texting and calls (Twilio)', 'One-to-one texts, text blasts, STOP/START, calls through the campaign’s number, SMS shift alerts', false,
      ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM'], {
        detail: has('TWILIO_FROM') ? `Number ${env('TWILIO_FROM')}${env('TWILIO_VOICE') === 'off' ? ' · calls off (TWILIO_VOICE=off)' : pub ? '' : ' · calls need the public address'}` : 'Without it, Call and Text use the phone’s own apps',
      }),
    row('geocoder', `Address lookup (${{ bc: 'BC Address Geocoder', google: 'Google Geocoding', nominatim: 'OpenStreetMap Nominatim', off: 'off' }[geo] || geo})`,
      'Address suggestions as you type, placing people on the map', true,
      geo === 'google' ? ['GOOGLE_MAPS_SERVER_KEY'] : [], {
        detail: geo === 'off' ? 'Turned off (GEOCODER=off): pins by hand only'
          : geo === 'bc' ? `Free, no key needed${has('BC_GEOCODER_KEY') ? ' · key set for higher limits' : ''}${env('GEOCODER_FALLBACK') ? ` · then ${env('GEOCODER_FALLBACK')} for what it can’t place` : ''}`
            : geo === 'nominatim' ? 'Free, no key; light use only' : 'Google Cloud key with the Geocoding API',
        state: geo === 'off' ? 'missing' : (geo === 'google' && !has('GOOGLE_MAPS_SERVER_KEY')) ? 'missing' : 'ready',
        ...(geo === 'off' ? { missing: ['GEOCODER'] } : {}),
      }),
    row('tiles', googleTiles() ? 'Map background (Google Map Tiles)' : 'Map background (OpenStreetMap)', 'The map volunteers walk', false,
      googleTiles() ? ['GOOGLE_MAPS_SERVER_KEY'] : [], {
        detail: googleTiles() ? `Google ${env('GOOGLE_MAPS_TILE_TYPE') || 'roadmap'} tiles, through this server`
          : has('BASE_TILE_URL') ? `Tiles from ${env('BASE_TILE_URL').replace(/^https?:\/\//, '').split('/')[0]}`
            : 'OpenStreetMap’s free tiles — not for a large team in election week (GOOGLE_MAPS_TILES=1 or BASE_TILE_URL)',
        state: googleTiles() ? (has('GOOGLE_MAPS_SERVER_KEY') ? 'ready' : 'missing') : has('BASE_TILE_URL') ? 'ready' : 'default',
      }),
    row('jobs', 'Background work', 'Sends that go out later, ladder steps, receipts, the address run', true, [], {
      detail: jobRunnerOn() ? 'Running on this server' : 'Off on this server (BASE_JOBS=off — take that setting away): scheduled sends wait',
      state: jobRunnerOn() ? 'ready' : 'missing',
      checkable: false,
    }),
  ];
  return list;
};

// What other services call here: Twilio's webhooks (all checked against
// TWILIO_AUTH_TOKEN), and the ways in for the campaign's own files.
const inbound = (base) => [
  { name: 'Twilio — a message comes in', url: `${base}/api/public/twilio/sms`, how: 'Set by hand: Twilio → the number → Messaging → “A message comes in”, HTTP POST' },
  { name: 'Twilio — delivery reports, calls', url: `${base}/api/public/twilio/…`, how: 'Sent by base ground with each text and call (from the public address); nothing to set' },
  { name: 'The website — people in', url: `${base}/in/v1/people`, how: 'From the website’s server with a website key (below): sign-ups, petitions, volunteers, the newsletter' },
  { name: 'Lists and voted files', url: `${base}/admin/people/import`, how: 'People → Import: a CSV or spreadsheet (a “voted” column marks who voted)' },
];

const within = (p) => Promise.race([p, new Promise((_, rej) => { setTimeout(() => rej(new Error('no answer in 8 s')), TIMEOUT_MS); })]);

// One real call per service; never a send, never a write.
const CHECKS = {
  database: async (db, ws) => {
    await db.query('select 1');
    const n = (await db.query('select count(*)::int as n from persons where workspace_id = $1 and deleted_at is null', [ws])).rows[0].n;
    return { ok: true, said: `Answering · ${n.toLocaleString('en-CA')} people on file` };
  },
  public: async () => {
    const pub = publicUrl();
    if (!pub) return { ok: false, said: 'BASE_PUBLIC_URL isn’t set' };
    const res = await fetch(`${pub}/api/health`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await res.json().catch(() => null);
    if (!res.ok || body?.service !== 'base-ground') return { ok: false, said: `${pub} answered ${res.status}, not this base ground` };
    return { ok: true, said: `${pub} reaches this base ground (${body.env})` };
  },
  email: async () => {
    if (!has('RESEND_API_KEY')) return { ok: false, said: 'RESEND_API_KEY isn’t set' };
    const res = await fetch('https://api.resend.com/domains', {
      headers: { Authorization: `Bearer ${env('RESEND_API_KEY')}` }, signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401 && /restricted/i.test(`${body?.name || ''} ${body?.message || ''}`)) {
      return { ok: true, said: 'The key works (a sending-only key: the domain can’t be checked from here)' };
    }
    if (res.status === 401 || res.status === 403) return { ok: false, said: 'Resend refused the key' };
    if (!res.ok) return { ok: false, said: `Resend answered ${res.status}` };
    const from = env('MAIL_FROM');
    const domain = (from.match(/@([^>\s]+)/) || [])[1]?.toLowerCase();
    if (!domain) return { ok: false, said: 'The key works; MAIL_FROM isn’t set, so mail comes from Resend’s test sender' };
    const d = (body.data || []).find((x) => String(x.name).toLowerCase() === domain);
    if (!d) return { ok: false, said: `The key works, but ${domain} isn’t a domain on this Resend account` };
    if (d.status !== 'verified') return { ok: false, said: `The key works; ${domain} is “${d.status}” in Resend — finish its DNS records` };
    return { ok: true, said: `The key works and ${domain} is verified` };
  },
  texting: async () => {
    const need = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM'].filter((k) => !has(k));
    if (need.length) return { ok: false, said: `${need.join(', ')} not set` };
    const sid = env('TWILIO_ACCOUNT_SID');
    const auth = Buffer.from(`${sid}:${env('TWILIO_AUTH_TOKEN')}`).toString('base64');
    const url = `${twilioBase()}/2010-04-01/Accounts/${encodeURIComponent(sid)}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(env('TWILIO_FROM'))}`;
    const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 401 || res.status === 403) return { ok: false, said: 'Twilio refused the account SID and token' };
    if (!res.ok) return { ok: false, said: `Twilio answered ${res.status}` };
    const n = (await res.json()).incoming_phone_numbers?.[0];
    if (!n) return { ok: false, said: `${env('TWILIO_FROM')} isn’t a number on this Twilio account` };
    const want = publicUrl() ? `${publicUrl()}/api/public/twilio/sms` : null;
    if (!want) return { ok: false, said: 'The number is on the account; set BASE_PUBLIC_URL so replies and delivery reports reach base ground' };
    if (String(n.sms_url || '').replace(/\/$/, '') !== want) {
      return { ok: false, said: `The number is on the account, but its incoming messages go to ${n.sms_url || 'nowhere'} — set it to ${want}` };
    }
    return { ok: true, said: `${env('TWILIO_FROM')} is on the account and its replies come here` };
  },
  geocoder: async () => {
    if (provider() === 'off') return { ok: false, said: 'Turned off (GEOCODER=off)' };
    const r = await suggestAddresses('100', { limit: 3 });
    if (!Array.isArray(r)) return { ok: false, said: `The address service didn’t answer: ${r.error}` };
    return { ok: true, said: `Answering${r.length ? ` · e.g. ${r[0].label}` : ''}` };
  },
  tiles: async () => {
    if (!googleTiles()) {
      const url = env('BASE_TILE_URL');
      return { ok: true, said: url ? 'Tiles come straight from that host to each phone' : 'OpenStreetMap’s tiles come straight to each phone' };
    }
    if (!has('GOOGLE_MAPS_SERVER_KEY')) return { ok: false, said: 'GOOGLE_MAPS_SERVER_KEY isn’t set' };
    const api = (env('GOOGLE_MAPS_TILES_URL') || 'https://tile.googleapis.com/v1').replace(/\/$/, '');
    const res = await fetch(`${api}/createSession?key=${encodeURIComponent(env('GOOGLE_MAPS_SERVER_KEY'))}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mapType: env('GOOGLE_MAPS_TILE_TYPE') || 'roadmap', language: 'en-CA', region: 'CA' }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, said: `Google refused the tiles session (${res.status}) — is the Map Tiles API on for this key?` };
    return { ok: true, said: 'Google Map Tiles answering' };
  },
};

export const api = new Hono();
const managerOnly = (c) => (c.get('ctx').role === MANAGER ? null : c.json({ error: 'managers only' }, 403));

api.get('/connections', (c) => {
  const denied = managerOnly(c);
  if (denied) return denied;
  const base = publicUrl() || new URL(c.req.url).origin;
  return c.json({ services: services(), inbound: inbound(base), publicUrl: publicUrl() || null });
});

api.post('/connections/check', async (c) => {
  const denied = managerOnly(c);
  if (denied) return denied;
  const { key } = await c.req.json().catch(() => ({}));
  const fn = CHECKS[key];
  if (!fn) return c.json({ error: 'no such service' }, 404);
  try {
    return c.json({ key, ...(await within(fn(c.get('db'), c.get('ctx').workspaceId))) });
  } catch (e) {
    // Never a key in the words: a failed URL carries its query string.
    return c.json({ key, ok: false, said: `No answer: ${String(e.message).replace(/([?&](key|token|apikey)=)[^&\s]+/gi, '$1…').slice(0, 160)}` });
  }
});

export const deskOnlyReads = ['/connections'];
