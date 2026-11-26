// The sample campaign (staging only): a made-up campaign in Vancouver for
// the demo on the base.win website (lib/demo.js). Nobody in it is real:
// every name comes from lib/samplecast.js, where each was made up for it;
// the emails are example.org, the phones are in the 555-01xx range kept for
// fiction, and the house numbers (9900-9999) exist on none of these
// streets. Each pin is in the roadway once its street's piece of
// centreline is in samplecast.js (SEGMENTS); until then, in the
// neighbourhood's box.
//   STARBASE_SAMPLE=vancouver   make it when the database holds no
//                               campaign, and make it again by itself when
//                               a release carries a newer SAMPLE_VERSION:
//                               the demo account (STARBASE_DEMO_EMAIL) as
//                               its manager, people in four neighbourhoods,
//                               turfs, knocks, shifts and gifts
//   STARBASE_SAMPLE_RESET       a word of your choosing (the owner's by-hand
//                               override). When it is one this database
//                               hasn't seen, EVERYTHING in the database is
//                               dropped first, and the sample is made in its
//                               place. The same word again does nothing.
// Both are read only where STARBASE_ENV is exactly "staging": a client's
// production server never makes a sample and never drops anything.
//
// Made again by itself only when every one of these holds (the guards):
//   G1, G2  STARBASE_ENV is exactly staging and STARBASE_SAMPLE is vancouver
//           (sampleWanted; checked before the database is even asked for)
//   G3      STARBASE_DEMO_EMAIL is set (lib/demo.js: '' on production)
//   G4      the sample recorded is older than this code's, or failed, or
//           died while being made, or is for another demo email
//   G5      the database holds exactly one campaign and its first manager
//           is the recorded demo account (demoOwnsIt), checked once before
//           and again under sign-up's lock in the write that drops
//   G6      this process won the claim on sample_meta.made
import { randomBytes } from 'node:crypto';
import { bootstrap } from '../db/schema.js';
import { getDb } from '../db/client.js';
import { SESSION_COOKIE } from './auth.js';
import { demoEmail } from './demo.js';
import { orgName } from './org.js';
import { SIGNUP_LOCK } from './setup.js';
import { AREAS, FIRST_NAMES, SURNAMES, TAGS, SHIFTS, SEGMENTS, HOUSE_FIRST, HOUSE_LAST } from './samplecast.js';

const onStaging = () => String(process.env.STARBASE_ENV || '').trim() === 'staging';
export const sampleWanted = () => onStaging() && String(process.env.STARBASE_SAMPLE || '').trim().toLowerCase() === 'vancouver';
const resetWord = () => (sampleWanted() ? String(process.env.STARBASE_SAMPLE_RESET || '').trim().slice(0, 100) : '');

// What the sample holds, as a number. Raise it by one whenever that
// changes: this file, samplecast.js, the staging block's STARBASE_ORG_NAME,
// STARBASE_JURISDICTION or STARBASE_TZ (all stored when the campaign is
// made), or the fields a new campaign starts with. Not for
// STARBASE_CANDIDATES (a campaign doesn't store its opponents until someone
// saves its Rating scale screen) or STARBASE_DEMO_EMAIL (a change of it
// makes the sample again by itself). The first sample, before this
// number, counts as 0. The next release that starts on staging drops the
// old sample and makes this one, once (G1 to G6 above).
export const SAMPLE_VERSION = 2;
// A make still under way after this long has died (the process stopped).
const MAKING_MINUTES = 10;

// ── The people ──
// Every proper noun comes from lib/samplecast.js.
export { AREAS };

// The same sample every time: a small seeded generator, never Math.random.
const rng = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
// A number from a word, for a pin that depends only on the address.
const seedOf = (text) => {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
  return h | 0;
};

// Where a house's dot goes: (number - 9900) / 100 of the way along its
// street's piece of centreline (samplecast.js SEGMENTS), so it is in the
// roadway, numbers rise along the street, and one address is one dot.
// A street with no piece yet: a point in the neighbourhood's box that
// depends only on the address.
export const pinFor = (area, number, street) => {
  const seg = SEGMENTS[street];
  if (seg) {
    const f = (number - HOUSE_FIRST) / 100;
    const [[a, b], [c, d]] = seg;
    return { lat: Number((a + f * (c - a)).toFixed(6)), lng: Number((b + f * (d - b)).toFixed(6)) };
  }
  const r = rng(seedOf(`${number} ${street}`));
  const [s, w, n, e] = area.box;
  return { lat: Number((s + r() * (n - s)).toFixed(6)), lng: Number((w + r() * (e - w)).toFixed(6)) };
};

export const samplePeople = (n = 320) => {
  const r = rng(20261117);
  const pick = (list) => list[Math.floor(r() * list.length)];
  const out = [];
  for (let i = 0; i < n; i++) {
    const area = AREAS[i % AREAS.length];
    const first = pick(FIRST_NAMES);
    const last = pick(SURNAMES);
    const tags = TAGS.filter(() => r() < 0.12);
    const number = HOUSE_FIRST + Math.floor(r() * (HOUSE_LAST - HOUSE_FIRST + 1));
    const street = pick(area.streets);
    out.push({
      area: area.name,
      first_name: first,
      last_name: last,
      address: `${number} ${street}`,
      city: 'Vancouver',
      ...pinFor(area, number, street),
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

// The sample's own sign-up, made in this process: open on an empty
// database even where the control centre's key closes sign-up to everyone
// else (routes/auth.js). A secret that never leaves this process.
const SAMPLE_HEADER = 'x-sample-signup';
const SAMPLE_KEY = randomBytes(32).toString('base64url');
export const sampleSignup = (c) => c.req.header(SAMPLE_HEADER) === SAMPLE_KEY;

// ── Which sample this database holds ──
// One row, outside the schema that is dropped: the version made (or being
// made), for which demo email, how it went, and how many tries at it.
const META = `
create schema if not exists sample_meta;
create table if not exists sample_meta.made (
  id int primary key check (id = 1),
  version int not null,
  state text not null check (state in ('making', 'made', 'failed')),
  email text not null,
  attempts int not null default 0,
  at timestamptz not null default now()
)`;
const readMade = async (db) => (await db.query(
  `select version, state, email, attempts, at, at > now() - interval '${MAKING_MINUTES} minutes' as fresh
     from sample_meta.made where id = 1`,
)).rows[0] || null;
const setState = (db, state) => db.query('update sample_meta.made set state = $1, at = now() where id = 1', [state]);

// Is the sample still being made, by this process or another? (The demo's
// door says "being refreshed" meanwhile: routes/auth.js.) Never asks
// anything of a server that makes no sample.
export const sampleMaking = async (db) => {
  if (!sampleWanted()) return false;
  try {
    const row = await readMade(db);
    return Boolean(row && row.state === 'making' && row.fresh);
  } catch { return false; } // no sample_meta yet: nothing is being made
};

// G5: the database holds exactly one campaign, and its first manager is
// `owner` (the demo account the sample was made for). Anything else is
// somebody's work, and is never dropped.
export const demoOwnsIt = async (db, owner) => {
  const row = (await db.query(
    `select lower(u.email) as email, (select count(*) from workspaces) as n
       from workspaces w join memberships m on m.workspace_id = w.id and m.role = 'manager'
       join users u on u.id = m.user_id
      where w.id = (select id from workspaces order by created_at, id limit 1)
      order by m.created_at, u.created_at limit 1`,
  )).rows[0];
  return Boolean(row && Number(row.n) === 1 && row.email === String(owner || '').toLowerCase());
};

const NOT_OURS = 'sample: this database’s first campaign is not the demo account’s, so nothing was dropped. To start over, set STARBASE_SAMPLE_RESET to a new word.';

// ── Making it ──
// Through the app's own doors (sign-up, then its actions), so everything the
// app keeps in step — names, the event log, the lists — is in step.
// → what was made, or null when the sample's own sign-up was refused.
const makeSample = async (app, log, n, email) => {
  let cookie = '';
  const call = async (path, body) => {
    const res = await app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SAMPLE_HEADER]: SAMPLE_KEY, ...(cookie ? { cookie } : {}) },
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
  for (const [title, location, days, hour] of SHIFTS) {
    await act('shift.create', { title, location, starts_at: at(days, hour), ends_at: at(days, hour + 2), capacity: 8 }, 'shifts');
  }
  log(`sample: made ${JSON.stringify(made)}`);
  return made;
};

// Drop the old sample, keeping the server's instance (the control centre
// knows staging by it: apps/platform/campaigns.mjs) and the control
// centre's entries (their campaign and account go with the old sample).
// Only while G5 still holds, checked again under sign-up's lock. → true
// when dropped.
const dropOld = async (db, log, owner) => {
  const kept = await db.transaction(async (tx) => {
    await tx.query(`select pg_advisory_xact_lock(${SIGNUP_LOCK})`);
    if (!(await demoOwnsIt(tx, owner))) return null;
    const instance = (await tx.query('select instance from platform_identity where id = 1')).rows[0]?.instance || null;
    const entries = (await tx.query(
      'select nonce, operator_id, kid, iat, exp, used_at from operator_entries where exp > now()',
    )).rows;
    await tx.query('drop schema public cascade');
    await tx.query('create schema public');
    return { instance, entries };
  });
  if (!kept) return false;
  await bootstrap(db);
  if (kept.instance) await db.query('update platform_identity set instance = $1 where id = 1', [kept.instance]);
  for (const e of kept.entries) {
    await db.query(
      `insert into operator_entries (nonce, operator_id, kid, workspace_id, user_id, iat, exp, used_at)
       values ($1, $2, $3, null, null, $4, $5, $6) on conflict (nonce) do nothing`,
      [e.nonce, e.operator_id, e.kid, e.iat, e.exp, e.used_at],
    );
  }
  log('sample: the old sample was dropped (this server keeps its instance)');
  return true;
};

// One timer at a time, for a make another process started: if it died,
// this looks again once it would count as dead.
let retry = null;
const laterDefault = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; };

// At every start on staging (server/index.js, after the server listens).
// → what was made, or null when nothing was.
// `later` and `beforeDrop` are for the tests: a timer they can see, and a
// moment between the decision and the drop.
export const seedSample = async (app, log = console.log, n = 320, { later = laterDefault, beforeDrop = null } = {}) => {
  // G1, G2: before the database is even asked for, so a client's server
  // never waits on this.
  if (!sampleWanted()) return null;
  // G3.
  const email = demoEmail();
  if (!email) { log('sample: STARBASE_DEMO_EMAIL is not set — no sample made'); return null; }
  const db = await getDb();
  await db.exec(META);
  // The owner's by-hand override, as before.
  await resetIfAsked(db, log);

  // Decide: skip, make (an empty database) or remake (drop the old sample).
  const row = await readMade(db);
  const hasCampaign = Boolean((await db.query('select 1 from workspaces limit 1')).rows[0]);
  const owner = row?.email || email;
  if (row?.state === 'making' && row.fresh) {
    // Another process is at it. Look again once it would count as dead.
    const ms = Math.max(0, new Date(row.at).getTime() + MAKING_MINUTES * 60_000 + 5_000 - Date.now());
    if (retry) clearTimeout(retry);
    retry = later(() => { retry = null; seedSample(app, log, n, { later, beforeDrop }).catch((e) => log(`sample: ${e.message}`)); }, ms);
    return null;
  }
  let remake = false;
  if (!hasCampaign) remake = false; // an empty sample server always makes the sample
  else if (row?.state === 'made' && row.version === SAMPLE_VERSION && row.email === email) return null; // the usual start
  else if (row && row.version > SAMPLE_VERSION) {
    log(`sample: this database holds sample version ${row.version}, newer than this release's ${SAMPLE_VERSION}; nothing changed`);
    return null;
  } else if (row && row.version === SAMPLE_VERSION && row.attempts >= 3) {
    log(`sample: version ${SAMPLE_VERSION} could not be made in 3 tries`);
    return null;
  } else if (await demoOwnsIt(db, owner)) remake = true; // G4 and G5
  else { log(NOT_OURS); return null; }

  // G6: claim it. Another process making it (and alive) keeps it.
  const won = (await db.query(
    `insert into sample_meta.made as made (id, version, email, state, attempts, at)
     values (1, $1, $2, 'making', 1, now())
     on conflict (id) do update set version = $1, email = $2, state = 'making', at = now(),
       attempts = case when made.version = $1 then made.attempts + 1 else 1 end
     where made.state <> 'making' or made.at < now() - interval '${MAKING_MINUTES} minutes'
     returning 1`,
    [SAMPLE_VERSION, email],
  )).rows[0];
  if (!won) return null;

  if (remake && beforeDrop) await beforeDrop(db);
  if (remake && !(await dropOld(db, log, owner))) {
    log(NOT_OURS);
    await setState(db, 'failed');
    return null;
  }
  let made;
  try {
    made = await makeSample(app, log, n, email);
  } catch (e) {
    log(`sample: making it failed: ${e.message}`);
    await setState(db, 'failed');
    return null;
  }
  // Refused: a campaign appeared since the decision (the control centre's
  // first entry can make one). Never dropped.
  if (!made) { await setState(db, 'failed'); return null; }
  if (made.failed) log(`sample: ${made.failed} of its steps failed; it stays as made`);
  await db.query("update sample_meta.made set state = 'made', version = $1, attempts = 0, at = now() where id = 1", [SAMPLE_VERSION]);
  return made;
};
