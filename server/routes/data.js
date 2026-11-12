// Data routes (desk roles): bulk import with dedupe, batch geocoding, and the
// Imagine Surrey sample dataset. Mounted under /api/data, after auth.
import { civic } from '../lib/address.js';
import { Hono } from 'hono';
import { z } from 'zod';
import { matchRating, offeredCodes, ratingByCode } from '@starbase/shared/scale';
import { OUTCOMES, VOLUNTEER_ROLES, VOLUNTEER_ROLE_CODES } from '@starbase/shared/canvass';
import { dateFrom, parseValue, valueError } from '../ext/fields/kinds.js';
import { timeZone } from '../lib/org.js';
import { fromLocal } from '../lib/tzsql.js';
import { loadScale } from '../ext/scale/rules.js';
import { runAction, newId } from '../lib/events.js';
import { geocodeAddress } from '../lib/geocode.js';
import { buildSample } from '../lib/sample.js';
import { logGift } from '../lib/gifts.js';
import { runHooks } from '../lib/hooks.js';
import { readVoted } from '../ext/voted/import.js';
import { voterNumber } from '../ext/voternumber/index.js';
import { parseSocial } from '@starbase/shared/socials';

const app = new Hono();
const DESK = ['manager', 'treasurer', 'staff'];

app.use('*', async (c, next) => {
  if (!DESK.includes(c.get('ctx').role)) return c.json({ error: 'volunteers cannot do this' }, 403);
  await next();
});

const parseJson = (v, d) => (typeof v === 'string' ? JSON.parse(v) : (v ?? d));
const norm = (s) => String(s ?? '').trim();
const lower = (s) => norm(s).toLowerCase();
const digits = (s) => norm(s).replace(/\D+/g, '');
// Names compare case-insensitively, trimmed, with runs of spaces as one.
const nameKey = (s) => lower(s).replace(/\s+/g, ' ');
// Nothing to tell two people of the same name apart: no email, phone or address.
const nameOnly = (p) => !p.email && !p.phone && !p.address;

// ── Import ──
// The client parses the CSV and maps columns; the server validates, dedupes,
// and writes in one transaction per call (≤ 2000 rows). A row matches a
// person on file by email, then name + phone, then name + address; a row with
// none of the three matches a person of the same name who has none either.
// Anything else is new — so importing the same file again doubles no one.
// A voter number (ext/voternumber) comes before all of them when the row and
// a person on file both have one: the same number is that person. A row found
// the old way on someone with another number (a list numbered afresh, a
// number typed wrong) is counted for the check, and otherNumber says what it
// is: that person, keeping their number (as before there were numbers) or
// taking the file's — or, found by name, someone new. Never by email: an
// email is one person's.
const rowSchema = z.object({
  name: z.string().max(300).nullish(),
  first: z.string().max(150).nullish(),
  middle: z.string().max(150).nullish(),
  last: z.string().max(150).nullish(),
  email: z.string().max(320).nullish(),
  phone: z.string().max(40).nullish(),
  address: z.string().max(1000).nullish(),
  unit: z.string().max(40).nullish(),
  city: z.string().max(120).nullish(),
  postal: z.string().max(20).nullish(),
  // The list of electors' own number for this voter (ext/voternumber).
  voter_number: z.union([z.string().max(60), z.number()]).nullish(),
  tags: z.union([z.string().max(2000), z.array(z.string().max(40)).max(50)]).nullish(),
  rating: z.string().max(80).nullish(), // a code or the scale's words: "4B", "Locke", "Strong yes"
  // A list with the number and the street in two columns: "13450" + "104 Ave".
  house_number: z.union([z.string().max(20), z.number()]).nullish(),
  // A pin already known (a list that was geocoded before).
  lat: z.union([z.string().max(40), z.number()]).nullish(),
  lng: z.union([z.string().max(40), z.number()]).nullish(),
  // Volunteer roles, as the person importing chose them from the file's
  // tags ("Vol: Door Knocker" → doorknocking); the tags stay as they are.
  roles: z.array(z.enum(VOLUNTEER_ROLE_CODES)).max(20).nullish(),
  // The list's last interaction, as the person importing read its status:
  // a knock or a call with this outcome on that day (ext/importhistory).
  history: z.object({
    channel: z.enum(['door', 'phone']),
    outcome: z.enum(OUTCOMES),
    date: z.string().max(40),
  }).nullish(),
  // The Sign column, as they read it: a lawn sign to put up, or one that's up.
  sign: z.enum(['requested', 'installed']).nullish(),
  // 1/0 (yes/no) columns that become the volunteer and donor tags.
  volunteer: z.union([z.string().max(20), z.number(), z.boolean()]).nullish(),
  donor: z.union([z.string().max(20), z.number(), z.boolean()]).nullish(),
  // Social handles, one column each (a handle or a profile link), and one
  // column of links whose network each link says (social).
  instagram: z.string().max(300).nullish(),
  x: z.string().max(300).nullish(),
  tiktok: z.string().max(300).nullish(),
  reddit: z.string().max(300).nullish(),
  facebook: z.string().max(300).nullish(),
  linkedin: z.string().max(300).nullish(),
  youtube: z.string().max(300).nullish(),
  bluesky: z.string().max(300).nullish(),
  threads: z.string().max(300).nullish(),
  social: z.string().max(2000).nullish(),
});
const IMPORT_SOCIALS = ['instagram', 'x', 'tiktok', 'reddit', 'facebook', 'linkedin', 'youtube', 'bluesky', 'threads'];
// Each cell read as the profile reads a paste (shared/socials.js): a cell
// that isn't a handle or a profile link is left out of the person and
// counted (the import says how many, and the first few). The social
// column takes links only: a bare @name there could be any network.
const readSocials = (v) => {
  const socials = {}; const bad = [];
  for (const k of IMPORT_SOCIALS) {
    if (!norm(v[k])) continue;
    const r = parseSocial(norm(v[k]), k);
    if (r.error) bad.push({ column: k, value: norm(v[k]) });
    else if (!socials[r.platform]) socials[r.platform] = r.handle;
  }
  for (const cell of norm(v.social).split(/[\s,;|]+/).filter(Boolean)) {
    const r = parseSocial(cell);
    if (r.error) bad.push({ column: 'social', value: cell });
    else if (!socials[r.platform]) socials[r.platform] = r.handle;
  }
  return { socials, bad };
};
const importInput = z.object({
  rows: z.array(z.record(z.string(), z.unknown())).min(1).max(2000),
  tag: z.string().trim().max(40).nullish(),   // applied to every imported row
  dryRun: z.boolean().default(false),
  // A list from a past election: what it says about support, signs, voting
  // and volunteering comes in as tags with the year ("Strong support 2022",
  // "Lawn sign 2022", "Voted 2022"), never as today's rating, sign, voted
  // mark, knock or role. Names, phones, emails and addresses come in as usual.
  // field_tags: profile fields whose values from that election are tags too
  // ("Support 5 2022", "Sign 2022"), not the field's value today.
  past: z.object({
    year: z.number().int().min(1950).max(2100),
    field_tags: z.array(z.uuid()).max(40).default([]),
  }).nullish(),
  // A row found on someone with another voter number: keep theirs, take the
  // file's, or (found by name) a new person. See the rules above.
  otherNumber: z.enum(['keep', 'take', 'new']).default('keep'),
});

// A 1/0 column: 1, yes, y, true, x (any case) say yes.
// 1 · yes · y · true · t · x (a Postgres export writes t/f); anything else is no.
const yes = (v) => v === true || v === 1 || /^(1|yes|y|true|t|x)$/i.test(norm(v == null ? '' : String(v)));
// A coordinate in range, or null (blank, words, a 0 that means "none").
const coord = (v, max) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  return Number.isFinite(n) && Math.abs(n) <= max ? n : null;
};

// scale: the campaign's (ext/scale). A rating is a code or its words, any
// case; a new rating must be on the list (one taken off it is refused).
// A past election's say about a person, as tags with its year.
const PAST_TALK = { contacted: 'Talked', refused: 'Refused', moved: 'Moved' };
const pastTag = (words, year) => `${String(words).slice(0, 34).trim()} ${year}`;
// A profile field's value from a past election → its tag, or null (a no).
const pastFieldTag = (f, value, year) => {
  if (f.kind === 'yesno') return value === true ? pastTag(f.name, year) : null;
  return pastTag(`${f.name} ${Array.isArray(value) ? value.join(', ') : value}`, year);
};
const pastTags = (row, raw, year, scale, fieldTags = []) => {
  const tags = [...fieldTags];
  if (row.rating) {
    const r = ratingByCode(scale, row.rating);
    // "Strong support 2022", "Undecided 2022", "Voting Locke 2022", "Opposed 2022".
    const words = r?.band === 'opposed' ? (r.name && r.name !== 'Other' ? `Voting ${r.name}` : 'Opposed') : (r?.label || r?.word || `Rated ${row.rating}`);
    tags.push(pastTag(words, year));
  }
  for (const code of row.roles) tags.push(pastTag(VOLUNTEER_ROLES.find((x) => x.code === code)?.label || code, year));
  if (row.history && PAST_TALK[row.history.outcome]) tags.push(pastTag(PAST_TALK[row.history.outcome], year));
  if (row.sign) tags.push(pastTag(row.sign === 'installed' ? 'Lawn sign' : 'Lawn sign request', year));
  if (row.tags.includes('volunteer')) tags.push(pastTag('Volunteer', year));
  if (row.tags.includes('donor')) tags.push(pastTag('Donor', year));
  if (readVoted(raw.voted).value === true) tags.push(pastTag('Voted', year));
  return {
    ...row,
    rating: null, roles: [], history: null, sign: null,
    tags: [...new Set([...row.tags.filter((t) => t !== 'volunteer' && t !== 'donor'), ...tags])].slice(0, 50),
  };
};

const cleanRow = (raw, i, scale, past = null) => {
  const r = rowSchema.safeParse(raw);
  if (!r.success) return { error: `row ${i + 1}: ${r.error.issues[0].path.join('.')} ${r.error.issues[0].message}` };
  const v = r.data;
  // First and last as the file keeps them; a whole name alone is split by
  // the database (ext/names).
  const first = norm(v.first) || null;
  const middle = norm(v.middle) || null;
  const last = norm(v.last) || null;
  const name = norm(v.name) || [first, middle, last].filter(Boolean).join(' ');
  if (!name) return { error: `row ${i + 1}: no name` };
  const email = lower(v.email) || null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: `row ${i + 1}: invalid email “${v.email}”` };
  const said = norm(v.rating);
  const hit = said ? matchRating(scale, said) : null;
  if (said && !hit) return { error: `row ${i + 1}: rating “${v.rating}” is not on the scale` };
  if (hit?.off && !past) return { error: `row ${i + 1}: rating “${v.rating}” is off the list` };
  const rating = hit?.code || null;
  const tags = Array.isArray(v.tags) ? [...v.tags] : norm(v.tags).split(/[;,|]/);
  if (yes(v.volunteer)) tags.push('volunteer');
  if (yes(v.donor)) tags.push('donor');
  const { socials, bad: badHandles } = readSocials(v);
  // "13450" + "104 Ave" → "13450 104 Ave" (Surrey's streets are numbers
  // themselves, so only a street that already begins with this very number
  // keeps it as it is).
  const { house_number, address } = civic({ house_number: v.house_number == null ? '' : String(v.house_number), address: v.address });
  const lat = coord(v.lat, 90); const lng = coord(v.lng, 180);
  const pin = lat != null && lng != null && !(lat === 0 && lng === 0) ? { lat, lng } : null;
  return {
    row: {
      name, first: norm(v.name) ? null : first, middle: norm(v.name) ? null : middle, last: norm(v.name) ? null : last, email, rating, socials, badHandles, pin, house_number,
      phone: norm(v.phone) || null,
      address,
      unit: norm(v.unit) || null,
      city: norm(v.city) || null,
      postal: norm(v.postal).toUpperCase() || null,
      voter_number: voterNumber(v.voter_number),
      tags: [...new Set(tags.map((t) => norm(t)).filter((t) => t && t.length <= 40))].slice(0, 50),
      roles: [...new Set(v.roles || [])],
      // No day (or one in the future): the status stays a profile field only.
      history: v.history && historyDay(v.history.date) ? { ...v.history, day: historyDay(v.history.date) } : null,
      sign: v.sign || null,
    },
  };
};
const historyDay = (raw) => {
  const d = dateFrom(String(raw || ''));
  return d && d <= new Date(Date.now() + 86_400_000).toISOString().slice(0, 10) ? d : null;
};

// Only the people a chunk could match are loaded, not the whole list: those
// with a row's email, or its name and phone digits, or its name and street,
// or (for a row with only a name) its name and nothing else — each lookup
// indexed (db/schema.js), so a call costs its own rows. KEY is looser than
// the matching (case, spaces and punctuation dropped) and computed in SQL on
// both sides, so it never misses; the exact rules then run in JS as before,
// over the people in the same order as the whole list (oldest first), so the
// same person wins a tie. Of the name-only people, only the oldest of each
// spelling can be the one a row matches. Each value is looked up on its own
// (lateral, "offset 0" keeps it so): handed a thousand values at once, the
// planner takes them for most of the list and reads it all.
const KEY = (col) => `regexp_replace(lower(${col}), '[^[:alnum:]]+', '', 'g')`;
const NAME_PHONE = (n, p) => `${KEY(n)} || '|' || regexp_replace(${p}, '[^0-9]+', '', 'g')`;
const NAME_ADDR = (n, a) => `${KEY(n)} || '|' || ${KEY(a)}`;
const NAME_ONLY = "coalesce(email, '') = '' and coalesce(phone, '') = '' and coalesce(address, '') = ''";
const eachValue = (sql) => `select x.id from unnest($2::text[]) as k(v) cross join lateral (${sql} offset 0) as x`;
const candidates = async (tx, workspaceId, clean) => {
  if (!clean.length) return [];
  const keys = { p: [], a: [], n: [] };
  for (const r of (await tx.query(
    `select 'p' as kind, ${NAME_PHONE('n', 'v')} as k from unnest($1::text[], $2::text[]) as t(n, v) where v is not null
     union select 'a', ${NAME_ADDR('n', 'v')} from unnest($1::text[], $3::text[]) as t(n, v) where v is not null
     union select 'n', ${KEY('n')} from unnest($4::text[]) as n`,
    [clean.map((r) => r.name), clean.map((r) => r.phone), clean.map((r) => r.address),
     clean.filter(nameOnly).map((r) => r.name)],
  )).rows) keys[r.kind].push(r.k);
  const emails = [...new Set(clean.map((r) => r.email).filter(Boolean))];
  const voters = [...new Set(clean.map((r) => r.voter_number).filter(Boolean))];
  const live = 'select id from persons where workspace_id = $1 and deleted_at is null';
  const lookups = [
    [voters, eachValue(`${live} and voter_number = k.v`)],
    [emails, eachValue(`${live} and lower(email) = k.v`)],
    [keys.p, eachValue(`${live} and ${NAME_PHONE('name', 'phone')} = k.v`)],
    [keys.a, eachValue(`${live} and ${NAME_ADDR('name', 'address')} = k.v`)],
    [keys.n, eachValue(`select distinct on (name) id from persons where workspace_id = $1 and deleted_at is null
      and ${NAME_ONLY} and ${KEY('name')} = k.v order by name, created_at, id`)],
  ];
  const ids = new Set();
  for (const [values, sql] of lookups) {
    if (values.length) for (const r of (await tx.query(sql, [workspaceId, values])).rows) ids.add(r.id);
  }
  if (!ids.size) return [];
  return (await tx.query(
    `select p.* from unnest($2::uuid[]) as k(id) cross join lateral (
       select id, name, email, phone, address, house_number, unit, city, postal, tags, socials, rating, lat, lng, voter_number, created_at from persons
       where id = k.id and workspace_id = $1 offset 0) as p
     order by p.created_at, p.id`, [workspaceId, [...ids]],
  )).rows.map(({ created_at: _, ...p }) => ({ ...p, tags: parseJson(p.tags, []), socials: parseJson(p.socials, {}) }));
};

// PGlite runs no autovacuum, so persons may never have been analyzed: its
// indexes then still count the rows they had when made (none), every index
// looks alike to the planner, and a lookup can read the whole list. One
// ANALYZE once there are people fixes that for good (the planner scales the
// counts with the table from then on). Hosted Postgres analyzes on its own.
const statsReady = async (db) => {
  try {
    const idx = (await db.query(`select reltuples from pg_class where oid = 'persons_ws_name_idx'::regclass`)).rows[0];
    if (idx && Number(idx.reltuples) <= 0) await db.query('analyze persons');
  } catch { /* only a speed-up */ }
};

app.post('/import', async (c) => {
  const ctx = c.get('ctx');
  const parsed = importInput.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0].message }, 400);
  const { rows, tag, dryRun, past, otherNumber } = parsed.data;

  // Features' own columns (ext/fields: a person's profile fields), checked
  // with the row — a cell that doesn't fit refuses it — and filled after it.
  const extras = [];
  await runHooks('importRows', c.get('db'), ctx, extras);
  const fillExtras = async (tx, personId, r, write, emit, fresh = false) => {
    const out = [];
    for (const [k, x] of extras.entries()) out.push(...await x.apply(tx, personId, r.extras[k], { write, fresh }, emit));
    return out;
  };

  const errors = [];
  const clean = [];
  const scale = await loadScale(c.get('db'), ctx.workspaceId);
  // A past election's profile fields to tag: read here, by id, so their
  // cells never reach the fields as today's values.
  const tagFields = new Map(past?.field_tags?.length ? (await c.get('db').query(
    'select id, name, kind, choices from person_fields where workspace_id = $1 and id = any($2::uuid[])',
    [ctx.workspaceId, past.field_tags],
  )).rows.map((f) => [f.id, f]) : []);
  rows.forEach((raw, i) => {
    let given = raw;
    const fieldTags = [];
    let fieldError = null;
    if (past && tagFields.size && raw?.fields && typeof raw.fields === 'object' && !Array.isArray(raw.fields)) {
      const fields = { ...raw.fields };
      for (const [id, f] of tagFields) {
        if (!(id in fields)) continue;
        const cell = fields[id];
        delete fields[id];
        const v = parseValue(f, typeof cell === 'number' || typeof cell === 'boolean' || cell === null ? cell : String(cell ?? ''));
        if (v.error) { fieldError ||= `row ${i + 1}: ${valueError(f, v.error)}`; continue; }
        if (!v.empty) { const t = pastFieldTag(f, v.value, past.year); if (t) fieldTags.push(t); }
      }
      given = { ...raw, fields };
    }
    const r0 = cleanRow(given, i, scale, past);
    const r = r0.error || !past ? r0 : { row: pastTags(r0.row, given, past.year, scale, fieldTags) };
    // A past election's Voted column is a tag, never today's voted mark.
    const more = r.error ? [] : extras.map((x) => x.check(past ? { ...given, voted: null } : given));
    if (!r.error && fieldError) { errors.push(fieldError); return; }
    const bad = more.find((m) => m.error);
    if (r.error) errors.push(r.error);
    else if (bad) errors.push(`row ${i + 1}: ${bad.error}`);
    else clean.push({ ...r.row, tags: tag ? [...new Set([...r.row.tags, tag])] : r.row.tags, index: i, extras: more.map((m) => m.value) });
  });

  await statsReady(c.get('db'));
  // Volunteer roles: the ones a row names that the person doesn't have yet.
  const addRoles = async (tx, personId, roles, write, emit, fresh = false) => {
    if (!roles.length) return [];
    const have = fresh ? new Set() : new Set((await tx.query(
      'select role from volunteer_roles where workspace_id = $1 and person_id = $2', [ctx.workspaceId, personId],
    )).rows.map((x) => x.role));
    const add = roles.filter((r) => !have.has(r));
    if (write) {
      for (const role of add) {
        const id = newId();
        await tx.query('insert into volunteer_roles (id, workspace_id, person_id, role) values ($1, $2, $3, $4)', [id, ctx.workspaceId, personId, role]);
        emit('volunteer_role', id, 'create', { id, person_id: personId, role, source: 'import' });
      }
    }
    return add;
  };
  // The list's last interaction: once — importing the file again finds it.
  const addHistory = async (tx, personId, h, write, emit, fresh = false) => {
    if (!h) return false;
    const at = `${fromLocal(`($1::date + time '12:00')`, '$2::text')}`;
    if (!fresh) {
      const had = (await tx.query(
        `select 1 from contacts where workspace_id = $3 and person_id = $4 and source = 'import'
            and channel = $5 and outcome = $6 and created_at = ${at} limit 1`,
        [h.day, timeZone(), ctx.workspaceId, personId, h.channel, h.outcome],
      )).rows[0];
      if (had) return false;
    }
    if (write) {
      const id = newId();
      const row = (await tx.query(
        `insert into contacts (id, workspace_id, person_id, channel, outcome, note, source, created_at)
         values ($3, $4, $5, $6, $7, 'From an imported list', 'import', ${at}) returning created_at`,
        [h.day, timeZone(), id, ctx.workspaceId, personId, h.channel, h.outcome],
      )).rows[0];
      emit('contact', id, 'create', { id, person_id: personId, channel: h.channel, outcome: h.outcome, source: 'import', created_at: new Date(row.created_at).toISOString() });
    }
    return true;
  };
  // The Sign column: a lawn sign at their home, unless they have a sign.
  const addSign = async (tx, p, status, write, emit, fresh = false) => {
    if (!status) return false;
    if (!String(p.address || '').trim() && (p.lat == null || p.lng == null)) return false; // nowhere to send a crew
    if (!fresh && (await tx.query(
      "select 1 from signs where workspace_id = $1 and person_id = $2 and status <> 'removed' limit 1", [ctx.workspaceId, p.id],
    )).rows[0]) return false;
    if (write) {
      const id = newId();
      await tx.query(
        `insert into signs (id, workspace_id, person_id, address, lat, lng, kind, status, note)
         values ($1, $2, $3, $4, $5, $6, 'lawn', $7, 'From an imported list')`,
        [id, ctx.workspaceId, p.id, p.address || null, p.lat ?? null, p.lng ?? null, status],
      );
      emit('sign', id, 'create', { id, kind: 'lawn', status, person_id: p.id, address: p.address || null, source: 'import' });
    }
    return true;
  };
  // write=false is the dry run: identical decisions, no writes.
  const run = async (tx, emit, write = true) => {
    const existing = await candidates(tx, ctx.workspaceId, clean);
    const byEmail = new Map(); const byNamePhone = new Map(); const byNameAddr = new Map();
    const byName = new Map(); // name-only people (the oldest of a name wins)
    const byVoter = new Map(); // by voter number (the oldest with a number wins)
    const index = (p) => {
      if (p.voter_number && !byVoter.has(p.voter_number)) byVoter.set(p.voter_number, p);
      if (p.email) byEmail.set(lower(p.email), p);
      if (p.phone) byNamePhone.set(`${nameKey(p.name)}|${digits(p.phone)}`, p);
      if (p.address) byNameAddr.set(`${nameKey(p.name)}|${lower(p.address)}|${lower(p.unit)}`, p);
      const k = nameKey(p.name);
      if (nameOnly(p)) { if (!byName.has(k)) byName.set(k, p); } else if (byName.get(k) === p) byName.delete(k);
    };
    existing.forEach(index);

    let created = 0; let merged = 0; let unchanged = 0;
    let otherNumbers = 0; const otherRows = [];
    const decisions = [];
    for (const r of clean) {
      // The same voter number is the same person. Without one in common the
      // row is found as before there were numbers; found on someone with
      // another number, it is counted, and otherNumber decides.
      const byNumber = r.voter_number && byVoter.get(r.voter_number);
      const email = !byNumber && r.email && byEmail.get(r.email);
      const named = byNumber || email ? [] : [
        r.phone && byNamePhone.get(`${nameKey(r.name)}|${digits(r.phone)}`),
        r.address && byNameAddr.get(`${nameKey(r.name)}|${lower(r.address)}|${lower(r.unit)}`),
        nameOnly(r) && byName.get(nameKey(r.name)),
      ].filter(Boolean);
      const differs = (p) => !!(p && r.voter_number && p.voter_number && p.voter_number !== r.voter_number);
      const found = byNumber || email || named[0];
      if (differs(found)) {
        otherNumbers += 1;
        if (otherRows.length < 50) {
          otherRows.push({ row: r.index + 1, name: r.name, person: found.name, on_file: found.voter_number, in_file: r.voter_number, email: !!email });
        }
      }
      const match = byNumber || email || (otherNumber === 'new' ? named.find((p) => !differs(p)) : named[0]);
      if (match) {
        // Merge: fill blanks, union tags — never overwrite what's on file
        // (but a voter number, when the person said to take the file's).
        const patch = {};
        for (const k of ['email', 'phone', 'address', 'unit', 'city', 'postal', 'house_number', 'voter_number']) {
          if (!match[k] && r[k]) patch[k] = r[k];
        }
        if (otherNumber === 'take' && differs(match)) patch.voter_number = r.voter_number;
        const tags = [...new Set([...(match.tags || []), ...r.tags])].slice(0, 50);
        if (tags.length !== (match.tags || []).length) patch.tags = tags;
        if (!match.rating && r.rating) patch.rating = r.rating;
        // A pin from the list goes on only where there is none.
        if (r.pin && match.lat == null) { patch.lat = r.pin.lat; patch.lng = r.pin.lng; }
        // Handles fill only the platforms with none on file.
        const newHandles = Object.entries(r.socials).filter(([k]) => !String(match.socials?.[k] || '').trim());
        if (newHandles.length) patch.socials = { ...(match.socials || {}), ...Object.fromEntries(newHandles) };
        const filled = await fillExtras(tx, match.id, r, write, emit);
        if ((await addRoles(tx, match.id, r.roles, write, emit)).length) filled.push('roles');
        if (await addHistory(tx, match.id, r.history, write, emit)) filled.push('history');
        if (await addSign(tx, { ...match, ...patch, id: match.id }, r.sign, write, emit)) filled.push('sign');
        if (Object.keys(patch).length === 0 && !filled.length) { unchanged += 1; decisions.push({ row: r.index + 1, name: r.name, action: 'unchanged', id: match.id }); continue; }
        merged += 1;
        decisions.push({ row: r.index + 1, name: r.name, action: 'merged', id: match.id, fields: [...Object.keys(patch), ...filled] });
        if (write && Object.keys(patch).length) {
          const next = { ...match, ...patch };
          await tx.query(
            `update persons set email = $3, phone = $4, address = $5, unit = $6, city = $7, postal = $8, tags = $9,
               rating = $10, socials = $11, lat = $12, lng = $13, house_number = $14, voter_number = $15, updated_at = now() where id = $1 and workspace_id = $2`,
            [match.id, ctx.workspaceId, next.email, next.phone, next.address, next.unit, next.city, next.postal,
             JSON.stringify(next.tags || []), next.rating || null, JSON.stringify(next.socials || {}),
             next.lat ?? null, next.lng ?? null, next.house_number || null, next.voter_number || null],
          );
          emit('person', match.id, 'update', { ...patch, source: 'import' });
          // A number given up finds them no more.
          if (patch.voter_number && match.voter_number && byVoter.get(match.voter_number) === match) byVoter.delete(match.voter_number);
          Object.assign(match, patch);
          // The lookups key on name, email, phone and address: only a change
          // to those moves this person in them (a house number read off an
          // address they already had, or a pin, changes no key).
          if (Object.keys(patch).some((k) => !['house_number', 'lat', 'lng'].includes(k))) index(match);
        }
      } else {
        created += 1;
        const id = newId();
        decisions.push({ row: r.index + 1, name: r.name, action: 'created', id });
        const p = { id, name: r.name, email: r.email, phone: r.phone, address: r.address, unit: r.unit,
          city: r.city, postal: r.postal, tags: r.tags, socials: r.socials, rating: r.rating,
          lat: r.pin?.lat ?? null, lng: r.pin?.lng ?? null, house_number: r.house_number,
          ...(r.voter_number ? { voter_number: r.voter_number } : {}),
          ...(r.first || r.middle || r.last ? { first_name: r.first, middle_name: r.middle, last_name: r.last } : {}) };
        if (write) {
          await tx.query(
            `insert into persons (id, workspace_id, name, email, phone, address, unit, city, postal, tags, socials, rating, lat, lng, house_number, first_name, last_name, middle_name, voter_number)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
            [id, ctx.workspaceId, p.name, p.email, p.phone, p.address, p.unit, p.city, p.postal,
             JSON.stringify(p.tags), JSON.stringify(p.socials), p.rating, p.lat, p.lng, p.house_number,
             r.first || null, r.last || null, r.middle || null, r.voter_number],
          );
          emit('person', id, 'create', { ...p, source: 'import' });
        }
        await fillExtras(tx, id, r, write, emit, true);
        await addRoles(tx, id, r.roles, write, emit, true);
        await addHistory(tx, id, r.history, write, emit, true);
        await addSign(tx, p, r.sign, write, emit, true);
        index(p); // later rows in the same file dedupe against this one
      }
    }
    // What the features held back for a batch (a new person's profile fields).
    if (write) for (const x of extras) if (x.finish) await x.finish(tx);
    return { created, merged, unchanged, decisions, other_numbers: otherNumbers, other_number_rows: otherRows };
  };

  // Handles that didn't read as a handle or a profile link: left out, said.
  const leftOut = clean.flatMap((r) => r.badHandles.map((b) => ({ row: r.index + 1, ...b })));
  const handles = { handles_left_out: leftOut.length, handles_left_out_rows: leftOut.slice(0, 5) };
  if (dryRun) {
    const db = c.get('db');
    const result = await run({ query: (...a) => db.query(...a) }, () => {}, false);
    return c.json({ dryRun: true, ...result, ...handles, invalid: errors, decisions: result.decisions.slice(0, 50) });
  }
  const { result } = await runAction(c.get('db'), { workspaceId: ctx.workspaceId, actorId: ctx.user.id, action: 'import.persons' }, run);
  return c.json({ ...result, ...handles, invalid: errors, decisions: result.decisions.slice(0, 50) });
});

// ── Geocoding: place unlocated people on the map, a batch at a time ──
app.post('/geocode', async (c) => {
  const ctx = c.get('ctx');
  const db = c.get('db');
  const { limit: rawLimit } = await c.req.json().catch(() => ({}));
  const limit = Math.min(Math.max(Number(rawLimit) || 20, 1), 50);
  const todo = (await db.query(
    `select id, address, unit, city, postal from persons
     where workspace_id = $1 and deleted_at is null and address is not null and lat is null
       and coalesce(attrs->'geocode'->>'status', '') not in ('nomatch', 'weak')
     order by created_at limit $2`,
    [ctx.workspaceId, limit],
  )).rows;
  let located = 0; let missed = 0; let errored = 0; let lastError = null;
  for (const p of todo) {
    const g = await geocodeAddress(p);
    if (g?.error) { errored += 1; lastError = g.error; continue; } // transient: retry next batch
    const status = g && !g.weak ? 'ok' : g?.weak ? 'weak' : 'nomatch';
    await runAction(db, { workspaceId: ctx.workspaceId, actorId: ctx.user.id, action: 'person.geocode' }, async (tx, emit) => {
      if (status === 'ok') {
        await tx.query(
          `update persons set lat = $3, lng = $4, attrs = jsonb_set(attrs, '{geocode}', $5::jsonb), updated_at = now()
           where id = $1 and workspace_id = $2 and lat is null`,
          [p.id, ctx.workspaceId, g.lat, g.lng, JSON.stringify({ status, at: new Date().toISOString(), matched: g.matched, score: g.score })],
        );
        emit('person', p.id, 'update', { lat: g.lat, lng: g.lng, geocoded: g.matched });
      } else {
        await tx.query(
          `update persons set attrs = jsonb_set(attrs, '{geocode}', $3::jsonb) where id = $1 and workspace_id = $2`,
          [p.id, ctx.workspaceId, JSON.stringify({ status, at: new Date().toISOString(), matched: g?.matched || null })],
        );
      }
    });
    if (status === 'ok') located += 1; else missed += 1;
    if (errored > 3) break;
  }
  const remaining = (await db.query(
    `select count(*)::int as n from persons where workspace_id = $1 and deleted_at is null and address is not null
       and lat is null and coalesce(attrs->'geocode'->>'status', '') not in ('nomatch', 'weak')`,
    [ctx.workspaceId],
  )).rows[0].n;
  const unmatched = (await db.query(
    `select count(*)::int as n from persons where workspace_id = $1 and deleted_at is null and lat is null
       and attrs->'geocode'->>'status' in ('nomatch', 'weak')`,
    [ctx.workspaceId],
  )).rows[0].n;
  return c.json({ processed: todo.length, located, missed, errored, lastError, remaining, unmatched });
});

// ── Sample data ──
// POST /sample records every row it creates, by id, in settings.sample.ids;
// DELETE /sample removes exactly those rows and nothing else. What you made
// yourself stays, even when it hangs on a sample row — a gift, sign, knock,
// role, booking, link to someone they know or profile detail you set on a
// sample voter keeps that voter (no longer marked sample), and a booking you
// made on the sample shift keeps that shift. Sample gifts are voided (an event on the books, never a silent
// delete); everything else sample-made is deleted with a 'void' event.
const SAMPLE_TAG = 'sample';
const SAMPLE_KEYS = ['persons', 'contacts', 'roles', 'gifts', 'signs', 'shifts', 'assignments',
  'subscriptions', 'turfs', 'relationships'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idLists = (src = {}) => Object.fromEntries(SAMPLE_KEYS.map((k) => [
  k, Array.isArray(src[k]) ? [...new Set(src[k].filter((v) => UUID_RE.test(String(v))))] : [],
]));

// "sample-town-hall-newton" is taken when a kept sample event still holds it.
app.post('/sample', async (c) => {
  const ctx = c.get('ctx');
  if (ctx.role !== 'manager') return c.json({ error: 'managers only' }, 403);
  const db = c.get('db');
  const S = buildSample();
  const year = new Date().getUTCFullYear();
  const W = ctx.workspaceId;
  const { result } = await runAction(db, { workspaceId: W, actorId: ctx.user.id, action: 'sample.load' }, async (tx, emit) => {
    // Checked under the workspace lock runAction holds: two taps load once.
    const cur = (await tx.query('select settings from workspaces where id = $1', [W])).rows[0];
    if (parseJson(cur?.settings, {}).sample) return { conflict: true };

    const ids = idLists();
    const id = {};
    // Made-up ratings use only what this campaign's scale offers: a candidate
    // it took off the list becomes plain 4 (Not sure).
    const offered = new Set(offeredCodes(await loadScale(tx, W)));
    const everyone = [...S.people, ...S.media.map((m) => ({ ...m, key: m.name }))];
    // A sample person already on the list — one an earlier Clear kept (your
    // records on them), or whoever holds the sample's email (the sample
    // volunteer Priya Nair's own sign-in record) — is used again, never added
    // a second time with the same email. Not recorded as the sample's: the
    // next Clear leaves them (and takes the sample's links, roles, bookings…
    // on them, which are recorded).
    const onList = (await tx.query(
      `select p.id, p.name, lower(p.email) as email,
              exists (select 1 from events e where e.workspace_id = $1 and e.entity_type = 'person'
                        and e.entity_id = p.id and e.op = 'create' and e.payload->>'sample' = 'true') as was_sample
       from persons p
       where p.workspace_id = $1 and p.deleted_at is null and (lower(p.email) = any($2::text[]) or p.name = any($3::text[]))
       order by p.created_at, p.id`,
      [W, everyone.filter((p) => p.email).map((p) => p.email.toLowerCase()), everyone.map((p) => p.name)],
    )).rows;
    const reused = new Set();
    const already = (p) => {
      const e = p.email ? p.email.toLowerCase() : null;
      const hit = (e && onList.find((r) => r.email === e && !reused.has(r.id)))
        || onList.find((r) => r.was_sample && r.name === p.name && !reused.has(r.id));
      if (hit) reused.add(hit.id);
      return hit || null;
    };
    for (const s0 of everyone) {
      const have = already(s0);
      if (have) { id[s0.key] = have.id; continue; }
      const p = s0.rating && !offered.has(s0.rating) ? { ...s0, rating: '4' } : s0;
      const pid = newId();
      id[p.key] = pid;
      ids.persons.push(pid);
      const tags = [SAMPLE_TAG, ...(S.tags[p.key] || []), ...(p.tags || [])];
      // Spread the knocks across the past week so Today has a realistic
      // picture. A rated person was rated by that knock, so rated_at is the
      // contact's own time (now() is fixed for the transaction: the two match).
      const hoursAgo = String((Object.keys(id).length * 7) % 150);
      await tx.query(
        `insert into persons (id, workspace_id, name, email, phone, address, city, lat, lng, tags, socials, rating, rated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                 case when $12::text is null then null else now() - ($13 || ' hours')::interval end)`,
        [pid, W, p.name, p.email || null, p.phone || null, p.address || null, p.city || null,
         p.lat ?? null, p.lng ?? null, JSON.stringify(tags), JSON.stringify(p.socials || {}), p.rating || null, hoursAgo],
      );
      emit('person', pid, 'create', { name: p.name, sample: true });
      if (p.rating) {
        const cid = newId();
        await tx.query(
          `insert into contacts (id, workspace_id, person_id, channel, outcome, rating, created_by, created_at)
           values ($1, $2, $3, $4, 'contacted', $5, $6, now() - ($7 || ' hours')::interval)`,
          [cid, W, pid, p.channel || 'door', p.rating, ctx.user.id, hoursAgo],
        );
        ids.contacts.push(cid);
        emit('contact', cid, 'create', { person_id: pid, rating: p.rating, sample: true });
      }
    }
    for (const [who, role, detail] of S.roles) {
      // Someone used again may hold that role already (yours).
      if (reused.has(id[who]) && (await tx.query(
        'select 1 from volunteer_roles where workspace_id = $1 and person_id = $2 and role = $3', [W, id[who], role],
      )).rows.length) continue;
      const rid = newId();
      await tx.query('insert into volunteer_roles (id, workspace_id, person_id, role, detail) values ($1, $2, $3, $4, $5)',
        [rid, W, id[who], role, detail || null]);
      ids.roles.push(rid);
      emit('volunteer_role', rid, 'create', { person_id: id[who], role, sample: true });
    }
    // Who knows whom (ext/relationships): each pair kept in order, once — a
    // pair someone used again already has (your link) is left as it is.
    for (const [a, b, kind, note, broughtIn, close] of S.relationships) {
      const lid = newId();
      const link = (await tx.query(
        `insert into relationships (id, workspace_id, person_a, person_b, kind, note, brought_in, from_person, created_by, close)
         values ($1, $2, least($3::uuid, $4::uuid), greatest($3::uuid, $4::uuid), $5, $6, $7, $3, $8, $9)
         on conflict (workspace_id, person_a, person_b) where removed_at is null do nothing
         returning person_a, person_b`,
        [lid, W, id[a], id[b], kind, note || null, broughtIn && !reused.has(id[b]) ? id[b] : null, ctx.user.id, Boolean(close)],
      )).rows[0];
      if (!link) continue;
      ids.relationships.push(lid);
      emit('relationship', lid, 'create', { ...link, kind, close: Boolean(close), sample: true });
    }
    // Dates relative to today: monthly gifts are current (last week), one-time
    // gifts spread back through the year — never in the future, never before Jan 1.
    const jan1 = Date.UTC(year, 0, 1);
    for (const [i, [who, cents, cadence, method]] of S.gifts.entries()) {
      const daysBack = cadence === 'monthly' ? 3 + i : 14 + i * 11;
      const when = new Date(Math.max(jan1, Date.now() - daysBack * 86400e3)).toISOString().slice(0, 10);
      const { gift } = await logGift(tx, ctx.workspace, {
        person_id: id[who], amount_cents: cents, date: when, method, cadence, note: 'sample',
      }, emit);
      ids.gifts.push(gift.id);
    }
    for (const [who, kind, status, address, lat, lng] of S.signs) {
      const sid = newId();
      const p = who ? S.people.find((x) => x.key === who) : null;
      await tx.query(
        `insert into signs (id, workspace_id, person_id, address, lat, lng, kind, status, note) values ($1, $2, $3, $4, $5, $6, $7, $8, 'sample')`,
        [sid, W, who ? id[who] : null, p?.address || address, p?.lat ?? lat, p?.lng ?? lng, kind, status],
      );
      ids.signs.push(sid);
      emit('sign', sid, 'create', { kind, status, sample: true });
    }
    // An upcoming Saturday shift, the Newton turf.
    const sat = new Date(); sat.setUTCDate(sat.getUTCDate() + ((6 - sat.getUTCDay() + 7) % 7 || 7)); sat.setUTCHours(17, 0, 0, 0);
    const shiftId = newId();
    await tx.query(
      `insert into shifts (id, workspace_id, title, role, location, starts_at, ends_at, instructions, link, capacity, created_by)
       values ($1, $2, 'Saturday canvass — Newton (sample)', 'doorknocking', 'Newton Rec Centre, 13730 72 Ave', $3, $4,
               'Meet at the north entrance. Bring water and comfortable shoes.', null, 8, $5)`,
      [shiftId, W, sat.toISOString(), new Date(sat.getTime() + 3 * 3600e3).toISOString(), ctx.user.id],
    );
    ids.shifts.push(shiftId);
    emit('shift', shiftId, 'create', { sample: true });
    for (const who of ['Sam Ortiz', 'Gurpreet Sandhu', 'Priya Nair']) {
      const aid = newId();
      await tx.query('insert into shift_assignments (id, workspace_id, shift_id, person_id) values ($1, $2, $3, $4)',
        [aid, W, shiftId, id[who]]);
      ids.assignments.push(aid);
      emit('shift_assignment', aid, 'create', { shift_id: shiftId, person_id: id[who], sample: true });
    }
    for (const email of S.subscribers) {
      // An address already on the list is yours: it is left alone, and not recorded.
      const row = (await tx.query(
        `insert into subscriptions (id, workspace_id, email, status, source) values ($1, $2, $3, 'subscribed', 'sample')
         on conflict (workspace_id, email) do nothing returning id`,
        [newId(), W, email],
      )).rows[0];
      if (row) {
        ids.subscriptions.push(row.id);
        emit('subscription', row.id, 'create', { sample: true });
      }
    }
    const turfId = newId();
    await tx.query('insert into turfs (id, workspace_id, name, polygon, color) values ($1, $2, $3, $4, $5)',
      [turfId, W, S.turf.name, JSON.stringify(S.turf.polygon), '#2b6cb0']);
    await tx.query('insert into turf_members (workspace_id, turf_id, user_id) values ($1, $2, $3)', [W, turfId, ctx.user.id]);
    ids.turfs.push(turfId);
    emit('turf', turfId, 'create', { sample: true });
    // Features' own sample rows (ext/fields: three profile fields and a few values).
    await runHooks('sampleLoaded', tx, ctx, { people: id, emit });

    await tx.query(
      `update workspaces set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{sample}', $2::jsonb) where id = $1`,
      [W, JSON.stringify({ loadedAt: new Date().toISOString(), ids })],
    );
    return { people: ids.persons.length, signs: ids.signs.length, gifts: ids.gifts.length };
  });
  if (result.conflict) return c.json({ error: 'sample data is already loaded — clear it first' }, 409);
  return c.json({ loaded: true, ...result });
});

// A sample loaded before ids were recorded (settings.sample has only shift,
// turf and sign ids). Every row that load inserted carries
// its transaction's now() as created_at — the same instant as its
// 'sample.load' events — so that instant names them exactly; its knocks were
// back-dated to before it, onto people created in it.
const legacySampleIds = async (tx, W, marks) => {
  const T = `(select server_ts from events where workspace_id = $1 and action = 'sample.load' order by seq desc limit 1)`;
  const list = async (sql) => (await tx.query(sql, [W])).rows.map((r) => r.id);
  const created = (table, extra = '') => list(`select id from ${table} where workspace_id = $1 and created_at = ${T}${extra}`);
  return idLists({
    persons: await created('persons'),
    contacts: await list(`select c.id from contacts c join persons p on p.id = c.person_id
      where c.workspace_id = $1 and p.created_at = ${T} and c.created_at <= p.created_at`),
    roles: await created('volunteer_roles'),
    gifts: await created('gifts'),
    assignments: await created('shift_assignments'),
    subscriptions: await created('subscriptions', ` and source = 'sample'`),
    relationships: await created('relationships'),
    signs: marks.signIds,
    shifts: marks.shiftIds,
    turfs: marks.turfIds,
  });
};

const nOf = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// What a kept record is, in the campaign's words.
const KINDS = [
  ['gift', 'gift', 'gifts'], ['sign', 'sign', 'signs'],
  ['door', 'door knock', 'door knocks'], ['phone', 'call', 'calls'], ['text', 'text', 'texts'],
  ['in_person', 'talk in person', 'talks in person'], ['connection', 'connection', 'connections'],
  ['role', 'volunteer role', 'volunteer roles'], ['booking', 'shift booking', 'shift bookings'],
  ['field', 'profile detail', 'profile details'],
  ['request', 'request from the doors', 'requests from the doors'], ['vote', 'voted mark', 'voted marks'],
];
const kindList = (byKind) => KINDS.filter(([k]) => byKind[k]).map(([k, one, many]) => nOf(byKind[k], one, many)).join(', ');

const clearSample = async (tx, W, emit) => {
  const rows = async (sql, params) => (await tx.query(sql, params)).rows;
  const ws = (await rows('select settings from workspaces where id = $1', [W]))[0];
  const marks = parseJson(ws?.settings, {}).sample;
  if (!marks) return { cleared: 0, kept: 0, removed: {}, message: 'No sample data is loaded.' };
  const ids = marks.ids ? idLists(marks.ids) : await legacySampleIds(tx, W, marks);

  // ── 1. What of yours hangs on sample rows ──
  const people = await rows(
    `select id, name, tags, (rated_at is not null and rated_at <= created_at) as sample_rating
     from persons where workspace_id = $1 and id = any($2::uuid[])`, [W, ids.persons],
  );
  const P = people.map((p) => p.id);
  const real = new Set();            // 'kind:id': each of your records, once
  const keptPeople = new Map();      // sample person id → { kind: n }
  const note = (kind, id) => real.add(`${kind}:${id}`);
  const onPerson = async (kind, sql, exclude) => {
    for (const r of await rows(sql, exclude ? [W, P, exclude] : [W, P])) {
      note(kind, r.id);
      const k = kind === 'contact' ? r.channel : kind; // door / phone / text
      const by = keptPeople.get(r.person_id) || {};
      by[k] = (by[k] || 0) + 1;
      keptPeople.set(r.person_id, by);
    }
  };
  // Voided gifts count too: they are still in the books, and still name their donor.
  await onPerson('gift', `select id, person_id from gifts where workspace_id = $1 and person_id = any($2::uuid[]) and not (id = any($3::uuid[]))`, ids.gifts);
  await onPerson('sign', `select id, person_id from signs where workspace_id = $1 and person_id = any($2::uuid[]) and not (id = any($3::uuid[]))`, ids.signs);
  await onPerson('contact', `select id, person_id, channel from contacts where workspace_id = $1 and person_id = any($2::uuid[]) and not (id = any($3::uuid[]))`, ids.contacts);
  await onPerson('role', `select id, person_id from volunteer_roles where workspace_id = $1 and person_id = any($2::uuid[]) and not (id = any($3::uuid[]))`, ids.roles);
  await onPerson('booking', `select id, person_id from shift_assignments where workspace_id = $1 and person_id = any($2::uuid[]) and not (id = any($3::uuid[]))`, ids.assignments);
  // A profile detail you set (ext/fields): the sample's own values are marked sample.
  await onPerson('field', `select id, person_id from person_field_values where workspace_id = $1 and person_id = any($2::uuid[]) and not sample`);
  // A request from the doors (ext/requests) or a Voted mark (ext/voted): the
  // sample has none of its own, so every one is yours.
  await onPerson('request', `select id, person_id from door_requests where workspace_id = $1 and person_id = any($2::uuid[])`);
  await onPerson('vote', `select id, person_id from voted_marks where workspace_id = $1 and person_id = any($2::uuid[])`);
  // A link you made (ext/relationships) keeps the sample people at both ends.
  for (const r of await rows(
    `select id, person_a, person_b from relationships where workspace_id = $1 and removed_at is null
       and (person_a = any($2::uuid[]) or person_b = any($2::uuid[])) and not (id = any($3::uuid[]))`,
    [W, P, ids.relationships],
  )) {
    note('connection', r.id);
    [r.person_a, r.person_b].filter((pid) => P.includes(pid)).forEach((pid, i) => {
      const by = keptPeople.get(pid) || {};
      if (i === 0) by.connection = (by.connection || 0) + 1; // counted once per link
      keptPeople.set(pid, by);
    });
  }

  // Sample shifts with your bookings on them.
  const keepHosts = async (kind, hostSql, childSql, hostIds, exclude = null) => {
    const hosts = await rows(hostSql, [W, hostIds]);
    const children = await rows(childSql, exclude ? [W, hostIds, exclude] : [W, hostIds]);
    for (const ch of children) note(kind, ch.id);
    return hosts.map((h) => ({ ...h, n: children.filter((ch) => ch.host === h.id).length }));
  };
  const shifts = await keepHosts('booking',
    'select id, title, deleted_at is null as live from shifts where workspace_id = $1 and id = any($2::uuid[])',
    `select id, shift_id as host from shift_assignments
     where workspace_id = $1 and shift_id = any($2::uuid[]) and not (id = any($3::uuid[]))`, ids.shifts, ids.assignments);
  // A host you already deleted yourself keeps its records, hidden as you left it.
  const kept = (hosts) => hosts.filter((h) => h.n > 0);
  const told = (hosts) => kept(hosts).filter((h) => h.live);
  const gone = (hosts) => hosts.filter((h) => h.n === 0).map((h) => h.id);

  // ── 2. Remove what the sample made ──
  const removed = {};
  // Money: voided, never deleted — the gift leaves every total and the books say why.
  const gifts = await rows(
    `update gifts set deleted_at = now(), updated_at = now()
     where workspace_id = $1 and id = any($2::uuid[]) and deleted_at is null returning id`, [W, ids.gifts],
  );
  for (const g of gifts) emit('gift', g.id, 'void', { sample: true });
  removed.gifts = gifts.length;

  const drop = async (key, entity, sql, list, payload = () => ({})) => {
    const out = list.length ? await rows(sql, [W, list]) : [];
    for (const r of out) emit(entity, r.id, 'void', { sample: true, ...payload(r) });
    removed[key] = out.length;
  };
  await drop('contacts', 'contact', 'delete from contacts where workspace_id = $1 and id = any($2::uuid[]) returning id, person_id',
    ids.contacts, (r) => ({ person_id: r.person_id }));
  await drop('relationships', 'relationship',
    'delete from relationships where workspace_id = $1 and id = any($2::uuid[]) returning id, person_a, person_b',
    ids.relationships, (r) => ({ person_a: r.person_a, person_b: r.person_b }));
  await drop('roles', 'volunteer_role', 'delete from volunteer_roles where workspace_id = $1 and id = any($2::uuid[]) returning id, person_id',
    ids.roles, (r) => ({ person_id: r.person_id }));
  await drop('signs', 'sign', 'delete from signs where workspace_id = $1 and id = any($2::uuid[]) returning id, kind, status, person_id, address',
    ids.signs, (r) => ({ kind: r.kind, status: r.status, person_id: r.person_id || null, address: r.address || null }));
  await drop('bookings', 'shift_assignment', 'delete from shift_assignments where workspace_id = $1 and id = any($2::uuid[]) returning id, shift_id, person_id',
    ids.assignments, (r) => ({ shift_id: r.shift_id, person_id: r.person_id }));
  await drop('shifts', 'shift', 'delete from shifts where workspace_id = $1 and id = any($2::uuid[]) returning id, title',
    gone(shifts), (r) => ({ title: r.title }));
  await drop('turfs', 'turf', 'delete from turfs where workspace_id = $1 and id = any($2::uuid[]) returning id, name',
    ids.turfs, (r) => ({ name: r.name }));
  await drop('subscriptions', 'subscription',
    `delete from subscriptions where workspace_id = $1 and id = any($2::uuid[]) and source = 'sample' returning id`,
    ids.subscriptions);

  // People: those holding your records stay, no longer marked sample (and
  // unrated, if their only rating was the sample's made-up knock).
  for (const p of people.filter((x) => keptPeople.has(x.id))) {
    const tags = parseJson(p.tags, []).filter((t) => t !== SAMPLE_TAG);
    await tx.query(
      `update persons set tags = $3, rating = case when $4 then null else rating end,
         rated_at = case when $4 then null else rated_at end, updated_at = now()
       where id = $1 and workspace_id = $2`,
      [p.id, W, JSON.stringify(tags), p.sample_rating],
    );
    emit('person', p.id, 'update', { tags, sample: false, ...(p.sample_rating ? { rating: null } : {}), kept: keptPeople.get(p.id) });
  }
  // Features' own sample rows (ext/fields), each with a void event, while
  // the people they hang on are still here (a delete below would take them
  // by cascade, off the books).
  const said = [];
  await runHooks('sampleCleared', tx, { workspaceId: W }, { emit, said });
  // The rest go. One whose voided sample gift is still in the books stays as
  // a hidden (deleted) row so that gift keeps its donor; the others are deleted.
  const leave = P.filter((pid) => !keptPeople.has(pid));
  const donors = new Set((await rows(
    'select distinct person_id from gifts where workspace_id = $1 and person_id = any($2::uuid[])', [W, leave],
  )).map((r) => r.person_id));
  const hide = leave.filter((pid) => donors.has(pid));
  const del = leave.filter((pid) => !donors.has(pid));
  if (hide.length) {
    await tx.query('update persons set deleted_at = now(), updated_at = now() where workspace_id = $1 and id = any($2::uuid[]) and deleted_at is null', [W, hide]);
  }
  if (del.length) await tx.query('delete from persons where workspace_id = $1 and id = any($2::uuid[])', [W, del]);
  for (const pid of leave) emit('person', pid, 'void', { sample: true });
  removed.people = leave.length;

  await tx.query(`update workspaces set settings = settings - 'sample' where id = $1`, [W]);

  // ── 3. Say exactly what happened ──
  const parts = [`Sample data cleared — ${nOf(leave.length, 'sample person', 'sample people')} removed.`];
  if (keptPeople.size) {
    const byKind = {};
    for (const by of keptPeople.values()) for (const [k, n] of Object.entries(by)) byKind[k] = (byKind[k] || 0) + n;
    parts.push(`Kept ${nOf(keptPeople.size, 'sample person', 'sample people')} with your own records on them (${kindList(byKind)}); they’re no longer marked sample.`);
  }
  for (const s of told(shifts)) parts.push(`Kept the shift “${s.title}”: ${nOf(s.n, 'booking on it is', 'bookings on it are')} yours.`);
  parts.push(...said);
  const summary = {
    cleared: leave.length,
    kept: real.size,
    keptPeople: keptPeople.size,
    keptShifts: kept(shifts).length,
    removed,
    message: parts.join(' '),
  };
  emit('workspace', W, 'update', {
    sampleCleared: leave.length, removed, kept: real.size,
    keptPeople: [...keptPeople.keys()], keptShifts: kept(shifts).map((s) => s.id),
  });
  return summary;
};

app.delete('/sample', async (c) => {
  const ctx = c.get('ctx');
  if (ctx.role !== 'manager') return c.json({ error: 'managers only' }, 403);
  const { result } = await runAction(c.get('db'), { workspaceId: ctx.workspaceId, actorId: ctx.user.id, action: 'sample.clear' },
    (tx, emit) => clearSample(tx, ctx.workspaceId, emit));
  return c.json(result);
});

export default app;
