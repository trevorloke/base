// The sample campaign (staging only): a made-up campaign in Vancouver for
// the demo on the base.win website (lib/demo.js). Nobody in it is real:
// the names are drawn from two short lists, the emails are example.org, the
// phones are in the 555-01xx range kept for fiction, and the house numbers
// are made up.
//   STARBASE_SAMPLE=vancouver   make it, once, when the database holds no
//                               campaign: the demo account
//                               (STARBASE_DEMO_EMAIL) as its manager, people
//                               in four neighbourhoods, turfs, knocks, shifts
//                               and gifts
//   STARBASE_SAMPLE_RESET       a word of your choosing. When it is one this
//                               database hasn't seen, EVERYTHING in the
//                               database is dropped first, and the sample is
//                               made in its place. The same word again does
//                               nothing.
// Both are read only where STARBASE_ENV is exactly "staging": a client's
// production server never makes a sample and never drops anything.
import { randomBytes } from 'node:crypto';
import { bootstrap } from '../db/schema.js';
import { getDb } from '../db/client.js';
import { SESSION_COOKIE } from './auth.js';
import { demoEmail } from './demo.js';
import { orgName } from './org.js';

const onStaging = () => String(process.env.STARBASE_ENV || '').trim() === 'staging';
export const sampleWanted = () => onStaging() && String(process.env.STARBASE_SAMPLE || '').trim().toLowerCase() === 'vancouver';
const resetWord = () => (sampleWanted() ? String(process.env.STARBASE_SAMPLE_RESET || '').trim().slice(0, 100) : '');

// ── The people ──
const FIRSTS = ['Avery', 'Jordan', 'Mei', 'Arjun', 'Sofia', 'Liam', 'Noor', 'Ethan', 'Priya', 'Lucas', 'Hana', 'Owen', 'Camille', 'Diego', 'Amara', 'Felix',
  'Yuki', 'Nadia', 'Marcus', 'Elena', 'Kofi', 'Isla', 'Rohan', 'Chloe', 'Tariq', 'Naomi', 'Henrik', 'Leila', 'Joon', 'Maya', 'Callum', 'Ines'];
const LASTS = ['Hartley', 'Okafor', 'Lindqvist', 'Marlowe', 'Castellan', 'Whitlock', 'Varga', 'Ashdown', 'Delacroix', 'Fenwick', 'Okonjo', 'Thackeray',
  'Yamane', 'Brightwater', 'Kessler', 'Montrose', 'Achebe', 'Stroud', 'Vasquez-Lund', 'Pemberton', 'Ravensworth', 'Tanaka-Holt', 'Corbin', 'Ellery',
  'Nakashima', 'Draycott', 'Sorensen', 'Bellamy', 'Abara', 'Winterbourne'];

// Four neighbourhoods as boxes [south, west, north, east], with streets that
// are there. The house numbers are made up.
export const AREAS = [
  { name: 'Mount Pleasant', box: [49.2555, -123.1100, 49.2675, -123.0905], color: '#2f6fed', streets: ['E 10th Ave', 'E 12th Ave', 'Quebec St', 'Ontario St', 'Main St'] },
  { name: 'Kitsilano', box: [49.2625, -123.1700, 49.2720, -123.1505], color: '#1f9d6b', streets: ['W 4th Ave', 'W 6th Ave', 'Yew St', 'Vine St', 'Balsam St'] },
  { name: 'Grandview-Woodland', box: [49.2685, -123.0750, 49.2800, -123.0600], color: '#c7411f', streets: ['Charles St', 'Kitchener St', 'Graveley St', 'Cotton Dr', 'Victoria Dr'] },
  { name: 'Sunset', box: [49.2180, -123.1000, 49.2300, -123.0805], color: '#8a4fd3', streets: ['E 49th Ave', 'E 51st Ave', 'Prince Edward St', 'Fraser St', 'Ross St'] },
];
const TAGS = ['volunteer', 'lawn sign', 'donor', 'newsletter', 'renter', 'small business'];

// The same sample every time: a small seeded generator, never Math.random.
const rng = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export const samplePeople = (n = 320) => {
  const r = rng(20261117);
  const pick = (list) => list[Math.floor(r() * list.length)];
  const out = [];
  for (let i = 0; i < n; i++) {
    const area = AREAS[i % AREAS.length];
    const [s, w, nn, e] = area.box;
    const first = pick(FIRSTS);
    const last = pick(LASTS);
    const tags = TAGS.filter(() => r() < 0.12);
    out.push({
      area: area.name,
      first_name: first,
      last_name: last,
      address: `${1000 + Math.floor(r() * 3800)} ${pick(area.streets)}`,
      city: 'Vancouver',
      lat: Number((s + r() * (nn - s)).toFixed(6)),
      lng: Number((w + r() * (e - w)).toFixed(6)),
      email: r() < 0.6 ? `${first}.${last}.${i}@example.org`.toLowerCase() : null,
      phone: r() < 0.7 ? `604-555-01${String(Math.floor(r() * 100)).padStart(2, '0')}` : null,
      tags: tags.length ? tags : null,
      // What happened at the door, for about half of them.
      knock: r() < 0.55 ? (r() < 0.62 ? { outcome: 'contacted', rating: pick(['1', '1', '2', '2', '2', '3', '3', '4']) } : { outcome: pick(['no_answer', 'no_answer', 'left_lit', 'refused']) }) : null,
      gift: r() < 0.08 ? pick([2500, 5000, 5000, 10000, 20000]) : null,
    });
  }
  return out;
};

// ── Starting over ──
// The words this database has seen are kept outside the schema that is
// dropped, so a deploy with the same word never drops it twice.
export const resetIfAsked = async (db, log = console.log) => {
  const word = resetWord();
  if (!word) return false;
  await db.query('create schema if not exists sample_meta');
  await db.query('create table if not exists sample_meta.resets (word text primary key, at timestamptz not null default now())');
  if ((await db.query('select 1 from sample_meta.resets where word = $1', [word])).rows[0]) return false;
  log('sample: a new reset word on staging — dropping everything in the database');
  await db.query('drop schema public cascade');
  await db.query('create schema public');
  await bootstrap(db);
  await db.query('insert into sample_meta.resets (word) values ($1)', [word]);
  return true;
};

// ── Making it ──
// Through the app's own doors (sign-up, then its actions), so everything the
// app keeps in step — names, the event log, the lists — is in step.
export const seedSample = async (app, log = console.log, n = 320) => {
  if (!sampleWanted()) return null;
  const email = demoEmail();
  if (!email) { log('sample: STARBASE_DEMO_EMAIL is not set — no sample made'); return null; }
  const db = await getDb();
  await resetIfAsked(db, log);
  if ((await db.query('select 1 from workspaces limit 1')).rows[0]) return null;

  let cookie = '';
  const call = async (path, body) => {
    const res = await app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set && set.startsWith(`${SESSION_COOKIE}=`)) cookie = set.split(';')[0];
    let json = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    return { ok: res.status < 300, status: res.status, json };
  };
  const made = { people: 0, turfs: 0, knocks: 0, shifts: 0, gifts: 0, failed: 0 };
  const act = async (name, input, count) => {
    const r = await call(`/api/actions/${name}`, input);
    if (r.ok) made[count] += 1;
    else if ((made.failed += 1) <= 5) log(`sample: ${name} → ${r.status} ${JSON.stringify(r.json)?.slice(0, 200)}`);
    return r.ok ? r.json : null;
  };

  // The demo account is the campaign's manager. Its password is thrown
  // away: the only way in is the demo's own door (/api/auth/demo).
  const up = await call('/api/auth/signup', {
    name: 'Demo Visitor', email, password: randomBytes(24).toString('base64url'),
    workspaceName: orgName() || 'Sample Campaign', jurisdiction: process.env.STARBASE_JURISDICTION || 'bc-municipal',
  });
  if (!up.ok) { log(`sample: sign-up → ${up.status} ${JSON.stringify(up.json)?.slice(0, 200)}`); return null; }

  for (const a of AREAS) {
    const [s, w, n, e] = a.box;
    await act('turf.create', { name: a.name, color: a.color, polygon: [[s, w], [s, e], [n, e], [n, w]] }, 'turfs');
  }
  for (const p of samplePeople(n)) {
    const { area: _area, knock, gift, ...person } = p;
    const got = await act('person.create', person, 'people');
    const id = got?.person?.id;
    if (!id) continue;
    if (knock) await act('contact.log', { person_id: id, channel: 'door', ...knock }, 'knocks');
    if (gift) await act('gift.log', { person_id: id, amount_cents: gift, date: new Date().toISOString().slice(0, 10), method: 'card' }, 'gifts');
  }
  const day = 86400_000;
  const at = (days, hour) => { const d = new Date(Date.now() + days * day); d.setUTCHours(hour, 0, 0, 0); return d.toISOString(); };
  // Evening and weekend shifts on Vancouver's clock, as UTC hours.
  const shifts = [
    ['Door knocking: Mount Pleasant', 'Main St at E 12th Ave', 1, 1],
    ['Phone bank', 'Campaign office', 2, 2],
    ['Door knocking: Kitsilano', 'W 4th Ave at Yew St', 3, 1],
    ['Sign crew', 'Campaign office', 4, 18],
    ['Door knocking: Sunset', 'Fraser St at E 49th Ave', 5, 19],
  ];
  for (const [title, location, days, hour] of shifts) {
    await act('shift.create', { title, location, starts_at: at(days, hour), ends_at: at(days, hour + 2), capacity: 8 }, 'shifts');
  }
  log(`sample: made ${JSON.stringify(made)}`);
  return made;
};
