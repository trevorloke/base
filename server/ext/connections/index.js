// Services — every outside service base.win talks to, whether it's set up,
// and a live check of each (managers; Settings → Services). INTEGRATIONS.md
// is the long version: where each key comes from and what to point where.
//
//   GET  /api/connections          { services: [{ key, name, for, launch,
//                                    state: 'ready'|'missing'|'default',
//                                    missing: [ENV…], set: [ENV…], detail,
//                                    checkable }], inbound: [{ name, url, how }],
//                                    publicUrl }
//   POST /api/connections/check    { key } → { ok, said, todo? } — one real
//                                    call to the service (8 s at most);
//                                    nothing is sent to anyone, nothing is
//                                    written. todo: something the manager
//                                    must do at the service, said apart.
//
// Keys and tokens are never in an answer: only which settings are present.
import { setting, JOINED, OLD_SETTINGS, OLD_HEALTH_SERVICE } from '@base-win/shared/old-names';
import { olderNames } from '../../lib/adopt-old-names.js';
import { Hono } from 'hono';
import { probeLookup, retiredGoogle, RETIRED_WORDS } from '../../lib/geocode.js';
import { googleKey, googleTilesOn, googleTilesSetting, mapType, probeTiles } from '../../lib/gtiles.js';
import { addressSuggester, placesLogo, placesHealth, probePlaces } from '../../lib/places.js';
import { today as googleToday } from '../../lib/gusage.js';
import { tileConfig, tileSource, cartoView } from '../offline/index.js';
import { jobRunnerOn } from '../../lib/jobs.js';
import { KEY_ENV, KEY_MIN, keyStatus } from '../../lib/twostep.js';
import { basePath } from '../../lib/mount.js';
import { timeZone } from '../../lib/org.js';
// Email (ext/mail): its row follows the sender in use (Resend, SendGrid) and
// carries where that sender's delivery events go.
import { emailService, emailInbound, checkEmail } from '../mail/service.js';
// Mailchimp (ext/mailchimp): its row carries a panel — Connect and Pull now.
import { mailchimpService, mailchimpInbound, checkMailchimp } from '../mailchimp/service.js';
// Online payments (ext/payments): its row carries the webhook address and
// the events to tick in Stripe, and state 'test' in test mode.
import { stripeService, checkStripe, webhookUrl } from '../payments/service.js';
// The dialer (ext/callhub): its row carries a Connect action beside Check.
import { callhubService, callhubInbound, checkCallHub } from '../callhub/service.js';
// Google sign-in and connections (ext/google): a panel, and how many use it.
import { googleService, googleCounts, checkGoogle } from '../google/service.js';
// Gmail (ext/gmail): this campaign's switch and who connected; no Check.
import { gmailService } from '../gmail/service.js';
// Google Drive and Sheets (ext/drive): a panel (the campaign's switches), and
// a Check with the manager's own Drive connection.
import { driveService, checkDrive } from '../drive/service.js';
// The website in other languages (ext/site translate.js): its row carries
// "Check translation", which learns how Google treats names and the key.
import { translateKey, translateWorks, checkTranslation } from '../../lib/translate.js';
// The campaign's website, hosted apart (ext/intake): base.win's own
// unsubscribes sent to it, how many are waiting, and a Check that writes nothing.
import { websiteService, websiteInbound, checkWebsite } from '../intake/service.js';
import { websiteCounts } from '../intake/outbound.js';

const MANAGER = 'manager';
// What this server's /api/health says it is (server/index.js).
const HEALTH_SERVICE = 'base.win';
const TIMEOUT_MS = 8000;
// A setting by its name, or its older name while that is the one set (shared/old-names.js); any other name as it is.
const env = (k) => String(setting(k) || '').trim();
const has = (k) => Boolean(env(k));
const publicUrl = () => env('BASE_PUBLIC_URL').replace(/\/$/, '');
const twilioBase = () => (env('TWILIO_API_BASE') || 'https://api.twilio.com').replace(/\/$/, '');
const provider = () => (env('GEOCODER') || 'bc').toLowerCase();
// Which kind of number the campaign texts from. Twilio's guidance for Canada:
// the carriers don't take application texts from an ordinary local number,
// so a text to a list wants a verified toll-free number or a short code
// (10DLC registration is a US scheme). One-to-one texts are another case.
const TOLL_FREE = /^1?8(?:00|33|44|55|66|77|88)\d{7}$/;
const numberKind = (number) => {
  const digits = String(number).replace(/\D/g, '');
  if (digits.length >= 5 && digits.length <= 6) return ' · a short code';
  if (TOLL_FREE.test(digits)) return ' · toll-free — Twilio must verify it before it can text';
  // A North American number that isn't toll-free. Anything else: not said.
  if (/^1?[2-9]\d{9}$/.test(digits)) return ' · a local number — for a text to a list in Canada, Twilio asks for a verified toll-free number or a short code';
  return '';
};
// Google's row whenever the map is Google's (one reading of the settings,
// the map's own: lib/gtiles.js), and also for GOOGLE_MAPS_TILES=1 with no key
// — a turned-on setting that can't work is still a mistake to show.
const googleTiles = () => googleTilesOn() || googleTilesSetting() === 'on';
const num = (v) => Number(v || 0).toLocaleString('en-CA');
// "4:12 pm", in the campaign's own time zone.
const clock = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: timeZone(), hour: 'numeric', minute: '2-digit', hour12: true })
  .format(new Date(iso)).replace(/\s*([ap])\.?m\.?$/i, (m, x) => ` ${x.toLowerCase()}m`);
const googleTilesRow = () => {
  const use = googleToday();
  const max = use.ceilings.tiles;
  const full = max != null && use.tiles >= max;
  const lines = [
    `Google ${mapType()} tiles, through this server`,
    'Phones don’t keep Google’s map for no-signal areas (Google’s terms)',
    `Today: ${num(use.tiles)} tiles${max != null ? ` of ${num(max)} (then the free map until midnight)` : ''}`,
    `While Google isn’t answering: ${cartoView() ? 'CARTO’s' : 'OpenStreetMap’s'} free map`,
    full ? `Daily limit reached${use.tilesFullAt ? ` at ${clock(use.tilesFullAt)}` : ''} — the free map until midnight` : '',
    ...use.problems.filter((p) => p.startsWith('GOOGLE_TILES')),
  ].filter(Boolean);
  return row('tiles', 'Map background (Google Map Tiles)', 'The map volunteers walk', false, ['GOOGLE_MAPS_SERVER_KEY'], {
    detail: lines.join('\n'),
    state: googleKey() ? 'ready' : 'missing',
    ...(full && googleKey() ? { flagged: true, flagWord: 'limit reached' } : {}),
  });
};
// Google's address suggestions (lib/places.js): off until the owner turns
// them on, after counsel's or Google's written yes (GOING-LIVE §5).
const placesRow = () => {
  const on = addressSuggester() === 'google';
  const use = googleToday();
  const h = placesHealth();
  const base = (extra) => row('places', 'Address suggestions (Google Places)', 'Addresses as you type, on every form', false, on ? ['GOOGLE_MAPS_SERVER_KEY'] : [], {
    checkable: Boolean(googleKey()),
    ...extra,
  });
  if (!on || !googleKey()) {
    return base({ detail: 'Off · the B.C. service (free) · Google’s suggestions need your confirmation first (GOING-LIVE §5)', state: on ? 'missing' : 'default' });
  }
  if (!placesLogo()) return base({ detail: 'Google’s logo file is missing — see owner item 9', state: 'missing', flagged: true });
  const counts = `Today: ${num(Math.max(use.autocomplete, use.details))} of ${num(use.ceilings.places)} asks · at most ${num(use.ceilings.perPerson)} a person`;
  const problems = use.problems.filter((p) => p.startsWith('GOOGLE_PLACES'));
  if (h.paused) {
    return base({
      detail: [h.paused.plain, h.paused.said ? `Google said: “${h.paused.said}”` : '', h.paused.step ? `See Going live §5, ${h.paused.step}.` : '', 'The B.C. service meanwhile', counts, ...problems].filter(Boolean).join('\n'),
      flagged: true, flagWord: 'not working',
    });
  }
  return base({ detail: ['Google Places, then the B.C. service when Google is busy', counts, ...problems].join(' · ') });
};
// A failed check: what went wrong in plain words, then Google's own words and
// the setup step that fixes it (GOING-LIVE.md §5) — said apart, as a todo.
const refusedBy = (r) => {
  // Google's words quoted on a line of their own, then the step as a sentence
  // (as the map's check says them).
  const todo = [r.said ? `Google said: “${r.said}”` : '', r.fix ? `See Going live §5, ${r.fix}.` : ''].filter(Boolean).join('\n');
  return { ok: false, said: r.plain, ...(todo ? { todo } : {}) };
};

// The map's own reading of its settings (offline's tileConfig), so this row
// and the map never disagree about where the tiles come from.
// The free default is OpenStreetMap's tiles for Standard, Muted and Dark,
// and, with the campaign's CARTO key, CARTO's for Clean: both are named.
// free: the default (no provider of the campaign's own).
const FREE_BOTH = 'OpenStreetMap and CARTO';
const freeTiles = () => {
  const cfg = tileConfig();
  const source = tileSource(cfg.url);
  const free = source === 'OpenStreetMap';
  return { cfg, free, source: free && cartoView() ? FREE_BOTH : source };
};
const CARTO_NEEDS_KEY = 'CARTO needs a key now (BASE_TILE_CARTO_KEY)';
// Why Clean isn't offered on the free map (a choice, not a fault: unflagged).
const cleanOff = () => {
  if (cartoView()) return '';
  return env('BASE_TILE_CARTO_KEY') && setting('BASE_TILE_CLEAN') === 'off'
    ? ' · Clean is off (BASE_TILE_CLEAN=off)'
    : ' · Clean is off: CARTO’s free map needs a key (BASE_TILE_CARTO_KEY)';
};
const freeTilesRow = () => {
  const { cfg, free, source } = freeTiles();
  const own = !free;
  // Every setting the map couldn't use, not only the first.
  const why = [
    googleTilesSetting() === 'unknown' && `GOOGLE_MAPS_TILES=${env('GOOGLE_MAPS_TILES').slice(0, 40)} isn’t understood — use 1`,
    cfg.ignored.includes('provider') && `BASE_TILE_PROVIDER=${env('BASE_TILE_PROVIDER').toLowerCase().slice(0, 40)} isn’t known — use stadia`,
    cfg.ignored.includes('url') && 'BASE_TILE_URL needs http(s) and {z}/{x}/{y}',
  ].filter(Boolean).join(' · ');
  // An address of the campaign's own on CARTO, with no key: CARTO sends a
  // notice instead of streets, so the row isn't shown as ready.
  const cartoKeyless = cfg.ignored.includes('carto-key');
  const words = cartoKeyless ? [why, CARTO_NEEDS_KEY].filter(Boolean).join(' · ')
    : why ? `${why} · ${source} meanwhile`
      : own ? `${source}, straight to the phones`
        : `${source === FREE_BOTH ? 'OpenStreetMap’s and CARTO’s' : 'OpenStreetMap’s'} free tiles — not for a large team in election week (see Going live §5)${cleanOff()}`;
  return row('tiles', `Map background (${source})`, 'The map volunteers walk', false, [], {
    detail: words,
    // A setting it couldn't use leaves the free map drawing: that is what the badge says.
    state: own && !why && !cartoKeyless ? 'ready' : 'default',
  });
};

// Settings on this server still under their older names in Render
// (lib/adopt-old-names.js): they keep working; each line says what to rename
// it to. Not shown at all once there are none. Names only, never a value.
// One line per setting. Set under both names and different: the new one is
// used, so it is checked before the older one goes. The two-step key is read
// under both names together (every key still opens), so the older name may go
// only once the new one holds every key it holds.
const olderLine = ({ old, now, differs, copied }) => {
  if (JOINED.includes(now)) {
    if (differs) return `${old} → ${now}: ${now} does not hold the same key as ${old}; both are used for now. Do not delete ${old}: make ${now} hold ${old}'s value too (after a comma, keeping what ${now} has), until this line says it holds every key`;
    if (copied) return `${old} → ${now}: ${now} holds every key ${old} holds: you can delete ${old} now`;
    return `${old} → ${now}: add ${now} with exactly the same value, copied (never press Generate); keep ${old} until this line says ${now} holds every key`;
  }
  if (differs) return `${old} → ${now}: ${now} is set and differs from ${old}; ${now} is used. Check ${now} before deleting ${old}`;
  return `${old} → ${now}: add ${now}, copy the value exactly, then delete ${old}`;
};
const olderNamesRow = () => {
  const older = olderNames();
  if (!older.length) return null;
  return {
    key: 'older-names', name: 'Older setting names still on this server', for: 'Render → this service → Environment: rename each one, then this goes away',
    launch: false, missing: [], set: [], state: 'ready', checkable: false, flagged: true, flagWord: 'rename in Render',
    detail: older.map(olderLine).join('\n'),
    older,
  };
};

const row = (key, name, purpose, launch, needs, extra = {}) => {
  const missing = needs.filter((k) => !has(k));
  return { key, name, for: purpose, launch, missing, set: needs.filter(has), state: missing.length ? 'missing' : 'ready', checkable: true, ...extra };
};

export const services = (base = publicUrl()) => {
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
    emailService(base),
    row('texting', 'Texting and calls (Twilio)', 'One-to-one texts, text blasts, STOP/START, calls through the campaign’s number, SMS shift alerts', false,
      ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM'], {
        detail: has('TWILIO_FROM') ? `Number ${env('TWILIO_FROM')}${numberKind(env('TWILIO_FROM'))}${env('TWILIO_VOICE') === 'off' ? ' · calls off (TWILIO_VOICE=off)' : pub ? '' : ' · calls need the public address'}` : 'Without it, Call and Text use the phone’s own apps',
      }),
    // Pins (the B.C. service, or Nominatim): Google no longer places them.
    ((retired) => row('geocoder', `Map pins (${{ bc: 'BC Address Geocoder', google: 'BC Address Geocoder', nominatim: 'OpenStreetMap Nominatim', off: 'off' }[geo] || geo})`,
      'Placing people on the map', true, [], {
        detail: [geo === 'off' ? 'Turned off (GEOCODER=off): pins by hand only'
          : geo === 'nominatim' ? 'Pins: OpenStreetMap Nominatim (free, no key; light use only)'
            : `Pins: B.C. Address Geocoder (free)${has('BC_GEOCODER_KEY') ? ' · key set for higher limits' : ''}${env('GEOCODER_FALLBACK') && env('GEOCODER_FALLBACK').toLowerCase() !== 'google' ? ` · then ${env('GEOCODER_FALLBACK')} for what it can’t place` : ''}`,
        retired.length ? RETIRED_WORDS : ''].filter(Boolean).join('\n'),
        state: geo === 'off' ? 'missing' : 'ready',
        ...(geo === 'off' ? { missing: ['GEOCODER'] } : {}),
        ...(retired.length ? { flagged: true, flagWord: 'needs a change', todo: `Take ${retired.map((k) => `${k}=google`).join(' and ')} away in Render` } : {}),
      }))(retiredGoogle()),
    googleTiles() ? googleTilesRow() : freeTilesRow(),
    row('jobs', 'Background work', 'Sends that go out later, ladder steps, receipts, the address run', true, [], {
      detail: jobRunnerOn() ? 'Running on this server' : 'Off on this server (BASE_JOBS=off — take that setting away): scheduled sends wait',
      state: jobRunnerOn() ? 'ready' : 'missing',
      checkable: false,
    }),
    mailchimpService(),
    websiteService(),
    stripeService(base),
    callhubService(),
    googleService(),
    driveService(),
    row('translate', 'Translation (Google)', 'The website in ਪੰਜਾਬੀ and 中文: new wording translated when it’s published, for people to check', false, ['GOOGLE_TRANSLATE_KEY'], {
      detail: translateKey() ? 'Set: new wording is translated after each publish (Website → Languages)' : 'Not set: the website stays in English (a language already showing keeps its words)',
      panel: 'translate',
    }),
    // Two-step sign-in's key (lib/twostep.js): without it base.win keeps
    // one in the database — it works, but a copy of the database would
    // give the authenticator keys away.
    // A value too short to use under either name is said even while the
    // other holds a good one (a copy missing a character works only until
    // the older name is deleted).
    ((k) => row('twostep', 'Two-step sign-in key', 'Seals everyone’s authenticator key (two-step sign-in)', false, [KEY_ENV], {
      detail: [k.source === 'env' ? 'Set: authenticator keys are sealed with it'
        : k.problem === 'short' ? `Too short (${KEY_MIN} characters or more): base.win keeps a key in its database meanwhile`
          : `Not set: base.win keeps a key in its database, so a copy of the database could open them — ${KEY_MIN}+ random characters`,
      ...(k.source === 'env' ? (k.short || []).map((name) => `${name} is too short (${KEY_MIN} characters or more) and is not used${name === KEY_ENV ? ` — copy ${OLD_SETTINGS[KEY_ENV]}’s value into it exactly before deleting ${OLD_SETTINGS[KEY_ENV]}` : ''}`) : [])].join('\n'),
      state: k.source === 'env' ? 'ready' : 'missing',
      missing: k.source === 'env' ? [] : [KEY_ENV],
      checkable: false,
      ...(k.source === 'env' && k.short ? { flagged: true, flagWord: 'needs a change' } : {}),
    }))(keyStatus()),
    placesRow(),
  ];
  const older = olderNamesRow();
  if (older) list.unshift(older);
  return list;
};

// What other services call here: Twilio's webhooks (all checked against
// TWILIO_AUTH_TOKEN), and the ways in for the campaign's own files.
const inbound = (base, desk) => [
  { name: 'Twilio — a message comes in', url: `${base}/api/public/twilio/sms`, how: 'Set by hand: Twilio → the number → Messaging → “A message comes in”, HTTP POST' },
  { name: 'Twilio — delivery reports, calls', url: `${base}/api/public/twilio/…`, how: 'Sent by base.win with each text and call (from the public address); nothing to set' },
  emailInbound(base),
  mailchimpInbound(base),
  { name: 'The website — people in', url: `${base}/in/v1/people`, how: 'From the website’s server with a website key (below): sign-ups, petitions, volunteers, the newsletter' },
  websiteInbound(base),
  { name: 'Lists and voted files', url: `${desk}/people/import`, how: 'People → Import: a CSV or spreadsheet (a “voted” column marks who voted)' },
  { name: 'Stripe — payments, refunds, disputes', url: webhookUrl(base), how: 'Set by hand: Stripe → Developers → Webhooks → Add endpoint, with the events under Online payments (above)' },
  callhubInbound(base),
];
// This Base's own address as the outside world reaches it: the public
// address, else the one this page was opened at (with the client's path).
const baseOf = (c) => publicUrl() || `${new URL(c.req.url).origin}${c.env?.base || ''}`;
// The desk at that address: /desk under the client's path on base.win
// (lib/mount.js; /admin there is only an old address, sent on), /admin at
// a server's root.
const deskOf = (c, base) => {
  const client = c.env?.base || basePath();
  let path = '';
  try { path = new URL(base).pathname.replace(/\/+$/, ''); } catch { /* not an address: as at a root */ }
  return `${base}${client && path === client ? '/desk' : '/admin'}`;
};

const within = (p) => Promise.race([p, new Promise((_, rej) => { setTimeout(() => rej(new Error('no answer in 8 s')), TIMEOUT_MS); })]);

// One real call per service; never a send, never a write.
const CHECKS = {
  stripe: (db, ws, base) => checkStripe(base),
  callhub: checkCallHub,
  google: checkGoogle,
  drive: checkDrive,
  translate: async () => {
    const r = await translateWorks();
    if (r.state === 'not-set') return { ok: false, said: 'GOOGLE_TRANSLATE_KEY isn’t set' };
    return r.state === 'works' ? { ok: true, said: 'Working · Google Translation answering' } : refusedBy(r);
  },
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
    // A server still on the older code (mid-rollout) answers with the older word.
    if (!res.ok || ![HEALTH_SERVICE, OLD_HEALTH_SERVICE].includes(body?.service)) return { ok: false, said: `${pub} answered ${res.status}, not this base.win` };
    return { ok: true, said: `${pub} reaches this base.win (${body.env})` };
  },
  email: (db, ws, base) => checkEmail(db, base),
  mailchimp: checkMailchimp,
  website: checkWebsite,
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
    if (!want) return { ok: false, said: 'The number is on the account; set BASE_PUBLIC_URL so replies and delivery reports reach base.win' };
    if (String(n.sms_url || '').replace(/\/$/, '') !== want) {
      return { ok: false, said: `The number is on the account, but its incoming messages go to ${n.sms_url || 'nowhere'} — set it to ${want}` };
    }
    return { ok: true, said: `${env('TWILIO_FROM')} is on the account and its replies come here` };
  },
  geocoder: async () => {
    const r = await probeLookup();
    if (r.ok) return { ok: true, said: `Answering${r.example ? ` · e.g. ${r.example}` : ''}` };
    return refusedBy(r);
  },
  // Google Places: one autocomplete (lib/places.js), whenever a key is set —
  // also while suggestions are off, so the key can be tested first.
  places: async () => {
    if (!googleKey()) return { ok: false, said: 'GOOGLE_MAPS_SERVER_KEY isn’t set', todo: 'See Going live §5, Recipe B step 6.' };
    const r = await probePlaces();
    return r.ok ? { ok: true, said: `Working${r.example ? ` · e.g. ${r.example}` : ''}` } : refusedBy(r);
  },
  // Google: one live session and tile (lib/gtiles.js), its own words when it
  // refuses. The free maps come straight to each phone: nothing to ask here.
  tiles: async () => {
    if (!googleTiles()) {
      const { source, free } = freeTiles();
      // Only the free default needs the pointer to choosing a provider.
      const whose = source === FREE_BOTH ? 'OpenStreetMap’s and CARTO’s' : `${source}${source.endsWith('s') ? '’' : '’s'}`;
      return { ok: true, said: `${whose} tiles come straight to each phone${free ? ' · to choose a provider, see Going live §5' : ''}` };
    }
    if (!googleKey()) return { ok: false, said: 'GOOGLE_MAPS_SERVER_KEY isn’t set', todo: 'See Going live §5, Recipe B step 6.' };
    const r = await probeTiles();
    return r.ok ? { ok: true, said: 'Working · Google Map Tiles answering' } : refusedBy(r);
  },
};

export const api = new Hono();
const managerOnly = (c) => (c.get('ctx').role === MANAGER ? null : c.json({ error: 'managers only' }, 403));

api.get('/connections', async (c) => {
  const denied = managerOnly(c);
  if (denied) return denied;
  const base = baseOf(c);
  const list = services(base);
  const g = list.findIndex((s) => s.key === 'google');
  if (g >= 0) list[g] = await googleCounts(c.get('db'), c.get('ctx').workspaceId, list[g]);
  if (g >= 0) list.splice(g + 1, 0, await gmailService(c.get('db'), c.get('ctx').workspaceId));
  // The website's row with this campaign's counts: how many unsubscribes are waiting, and why.
  const w = list.findIndex((s) => s.key === 'website');
  if (w >= 0 && list[w].state === 'ready') list[w] = websiteService(await websiteCounts(c.get('db'), c.get('ctx').workspaceId));
  return c.json({ services: list, inbound: inbound(base, deskOf(c, base)), publicUrl: publicUrl() || null });
});

api.post('/connections/check', async (c) => {
  const denied = managerOnly(c);
  if (denied) return denied;
  const { key } = await c.req.json().catch(() => ({}));
  const fn = CHECKS[key];
  if (!fn) return c.json({ error: 'no such service' }, 404);
  try {
    return c.json({ key, ...(await within(fn(c.get('db'), c.get('ctx').workspaceId, baseOf(c), c.get('ctx')))) });
  } catch (e) {
    // Never a key in the words: a failed URL carries its query string.
    return c.json({ key, ok: false, said: `No answer: ${String(e.message).replace(/([?&](key|token|apikey)=)[^&\s]+/gi, '$1…').slice(0, 160)}` });
  }
});

// "Check translation" (managers): one fixed sentence to Punjabi, sent with
// the key in the header (and in the body if Google refuses that), up to
// 15 s. What it learns — does Google keep names, the header key, the
// placeholders — is kept as the translation sweep's own bookkeeping
// (site_translate_runtime.probe, like the sweep's claim; not campaign data)
// and chooses how names and the key are sent from then on.
api.post('/connections/translate-probe', async (c) => {
  const denied = managerOnly(c);
  if (denied) return denied;
  const r = await checkTranslation();
  if (!r.works) return c.json({ ok: false, said: r.plain });
  const probe = { namesKept: r.namesKept, headerAccepted: r.headerAccepted, placeholdersKept: r.placeholdersKept, keyIn: r.keyIn, at: r.at };
  await c.get('db').query(
    `insert into site_translate_runtime (workspace_id, probe) values ($1, $2)
     on conflict (workspace_id) do update set probe = coalesce(site_translate_runtime.probe, '{}'::jsonb) || $2::jsonb`,
    [c.get('ctx').workspaceId, JSON.stringify(probe)],
  );
  const yes = (b) => (b ? 'yes' : 'no');
  return c.json({ ok: true, ...probe, said: `Names kept: ${yes(r.namesKept)} · Header accepted: ${yes(r.headerAccepted)} · Placeholders kept: ${yes(r.placeholdersKept)}` });
});

export const deskOnlyReads = ['/connections'];
