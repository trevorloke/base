// The workspace API. Reads are cursor-paginated and workspace-scoped; writes
// go exclusively through POST /api/actions/:name. GET /api/events is the
// sync protocol AND the public API — the same endpoint the app uses — and
// GET /api/export is the contractual one-click full-fidelity export.
import { mayRun, decide, areaOfPath } from '../lib/perms.js';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { getDb } from '../db/client.js';
import { loadContext, SESSION_COOKIE } from '../lib/auth.js';
import { openWhileSettingUp, SETUP_FIRST } from '../lib/twostep.js';
import { runAction, verifyChain } from '../lib/events.js';
import { ACTIONS, httpError } from '../actions/index.js';
import { tierFor } from '../lib/tiers.js';
import { emailConfigured, textConfigured } from '../lib/notify.js';
import { RECORD_TYPES } from '@starbase/shared/registry';
import { staleTimeZoneData } from '../lib/tzcheck.js';
import { startOfDay } from '../lib/tzsql.js';
import { DEFAULT_TZ } from '../lib/org.js';
import { crossSiteWrite } from '../lib/guard.js';
import dataRoutes from './data.js';
import { pointInPolygon, groupDoors, walkOrder } from '../lib/geo.js';
import { checkCap } from '../lib/cap.js';
import { EXTENSIONS } from '../ext.js';
import { runHooks } from '../lib/hooks.js';
import { forViewer, loginEmail } from '../lib/viewer.js';
import { personsWhere } from '../lib/audience.js';
// Which saved newsletter / press rows Try again would reach (ext/abtests).
import { goingRow, retryable, sendJobOn } from '../ext/abtests/send.js';
import { attachmentsOf } from '../ext/abtests/attach.js';
// The open pass (ext/passes) and the door rule it shares with the phone.
import { openPass } from '../ext/passes/rule.js';
import { doorState, inPass } from '@starbase/shared/passes';
// Where people use the app: never a website domain (ext/site).
import { hostOfRequest, noteAppHost } from '../ext/site/store.js';
// The records a maybe one donor names, by name (ext/payments).
import { maybesNamed } from '../ext/payments/limits.js';

// Gift rows flagged as maybe one donor (idsOf: the ids a row names, as
// stored) get maybe_same_as: those records by name, as things stand.
const nameMaybes = async (db, wsId, rows, idsOf) => {
  const named = await maybesNamed(db, wsId, rows.filter((g) => Array.isArray(idsOf(g)) && idsOf(g).length).map((g) => g.id));
  for (const g of rows) if (named.has(g.id)) g.maybe_same_as = named.get(g.id);
};

// A date column as YYYY-MM-DD (both backends hand back a Date at UTC midnight).
const dateOnly = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

const app = new Hono();

// A write must come from the app itself (lib/guard.js): the browser says
// same-origin (or nothing), and the body is JSON. A form on another site —
// or another host under the campaign's domain — can't post with the cookie.
app.use('*', async (c, next) => {
  const why = crossSiteWrite(c);
  if (why) return c.json({ error: why }, c.req.header('sec-fetch-site') && !/JSON/.test(why) ? 403 : 415);
  await next();
});

// Auth + context middleware.
app.use('*', async (c, next) => {
  const db = await getDb();
  const ctx = await loadContext(db, getCookie(c, SESSION_COOKIE));
  if (!ctx) return c.json({ error: 'not signed in' }, 401);
  // Two-step sign-in the campaign requires for this role and not set up yet
  // (lib/twostep.js): the set-up answers, nothing else does. 401, so the
  // phone keeps anything still to send until it's done.
  if (ctx.twoStep?.mustSetUp && !openWhileSettingUp(c.req.method, c.req.path)) {
    return c.json({ error: SETUP_FIRST, two_step: 'set_up' }, 401);
  }
  // Public base URL for links in outbound mail (unsubscribe).
  ctx.publicUrl = (process.env.STARBASE_PUBLIC_URL || `${new URL(c.req.url).origin}${c.env?.base || ''}`).replace(/\/$/, '');
  // The host this request came in on (the app answers there: never a website
  // domain), as the site gate reads it, noted for the saves to come
  // (ext/site/store.js hostOfRequest, noteAppHost).
  ctx.host = hostOfRequest(c);
  await noteAppHost(db, ctx.host);
  c.set('db', db);
  c.set('ctx', ctx);
  await next();
});

// '/surveys/:id/results' → /^\/api\/surveys\/[^/]+\/results$/ (a RegExp passes through).
const pathPattern = (p) => (p instanceof RegExp ? p : new RegExp(`^/api${p
  .split('/').map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&'))).join('/')}$`));

// Volunteers canvass, phone, and place signs; they never see money, the
// subscriber/signature lists, the raw event log, the campaign-wide contact
// feed (who knocked whom, with notes), or bulk exports.
const DESK_ONLY_READS = [
  /^\/api\/records\//, /^\/api\/export$/, /^\/api\/events$/, /^\/api\/audit\/verify$/,
  /^\/api\/subscriptions$/, /^\/api\/blasts$/, /^\/api\/members$/,
  /^\/api\/contacts$/, /^\/api\/shifts\/board$/,
  // Feature modules name their own desk-only reads (paths under /api).
  ...EXTENSIONS.flatMap((e) => (e.deskOnlyReads || []).map(pathPattern)),
];

// What a volunteer's browser may receive about a person (lib/viewer.js):
// phone and address, never anyone else's email, never a money tag. Applied
// to every person row a volunteer reads: /persons, /persons/:id, /map/doors
// and /turfs/:id/walk (and the features' own person rows, "My people").
// …unless a manager granted them the area, and never an area a manager
// denied this person or their role (lib/perms.js).
app.use('*', async (c, next) => {
  const ctx = c.get('ctx');
  const d = decide(ctx.perms, areaOfPath(c.req.path));
  if (d === false) return c.json({ error: 'not for you — ask a manager under Admin → Permissions' }, 403);
  if (ctx.role === 'volunteer' && c.req.method === 'GET' && d !== true
      && DESK_ONLY_READS.some((re) => re.test(c.req.path))) {
    return c.json({ error: 'volunteers cannot view this' }, 403);
  }
  await next();
});

// Path ids are uuids; anything else is simply not found (not a 500).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const badId = (c) => !UUID_RE.test(c.req.param('id') || '');

// ── Actions: the only write path ──
app.post('/actions/:name', async (c) => {
  const name = c.req.param('name');
  const action = Object.hasOwn(ACTIONS, name) ? ACTIONS[name] : null;
  if (!action) return c.json({ error: `unknown action '${name}'` }, 404);
  const ctx = c.get('ctx');
  if (!mayRun(ctx, name, action)) {
    return c.json({ error: `role '${ctx.role}' may not perform ${name}` }, 403);
  }
  const parsed = action.input.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return c.json({ error: `${i.path.join('.') || 'input'}: ${i.message}` }, 400);
  }
  try {
    // Slow work that must never hold the campaign's write lock (a slow
    // hash): done first, and handed to the handler.
    const ready = action.before ? await action.before(c.get('db'), ctx, parsed.data) : undefined;
    const { result, lastSeq } = await runAction(
      c.get('db'),
      { workspaceId: ctx.workspaceId, actorId: ctx.user.id, action: name },
      (tx, emit) => action.handler(tx, ctx, parsed.data, emit, ready),
    );
    if (!action.after) return c.json({ ...result, seq: lastSeq });
    // Committed: now the work that must never hold the campaign lock (an
    // email send). Its writes are runActions of their own.
    const done = await action.after(c.get('db'), ctx, result);
    return c.json({ ...done.result, seq: done.lastSeq ?? lastSeq });
  } catch (e) {
    if (e.status) return c.json({ error: e.message }, e.status);
    throw e;
  }
});

app.get('/actions', (c) => {
  const ctx = c.get('ctx');
  const names = Object.entries(ACTIONS)
    .filter(([name, a]) => mayRun(ctx, name, a))
    .map(([name]) => name);
  return c.json({ actions: names });
});

// ── Persons: search (picker), filters (tag / rating / role / has), map, profile ──
const parseJson = (v, fallback) => (typeof v === 'string' ? JSON.parse(v) : (v ?? fallback));
const personRow = (r) => ({
  ...r,
  tags: parseJson(r.tags, []),
  socials: parseJson(r.socials, {}),
});

app.get('/persons', async (c) => {
  const ctx = c.get('ctx');
  const limit = Math.min(Number(c.req.query('limit')) || 25, 2000);
  // The one WHERE behind People, saved lists and a send's audience (lib/audience.js).
  const { where, params } = await personsWhere(c.get('db'), ctx, c.req.query());
  params[3] = limit;
  // note: their own words from the volunteer form (attrs.note), so the call
  // card needs no per-person fetch. Nothing else from attrs is exposed.
  const { rows } = await c.get('db').query(
    `select p.id, p.kind, p.name, p.first_name, p.middle_name, p.last_name, p.email, p.phone, p.address, p.house_number, p.unit, p.city, p.postal,
            p.lat, p.lng, p.tags, p.socials, p.rating, p.rated_at, p.voted_at, p.attrs->>'note' as note
     from persons p where ${where}
     order by lower(p.name) limit $4`,
    params,
  );
  return c.json({ persons: rows.map(personRow).map(forViewer(ctx)) });
});

// Everything a door card needs, keyed by address: persons at that address,
// their ratings, and any signs. Only located persons (lat/lng set).
// A manager may keep a volunteer's map to the turfs they walk (Admin →
// Permissions → Volunteers' map): then only the doors inside those turfs
// (and their own) reach the phone — and its kept copy. A volunteer given
// Map & turfs sees every door, as the desk does.
const turfsOnly = (ctx) => ctx.role === 'volunteer'
  && ctx.workspace?.settings?.permissions?.volunteerDoors === 'turfs'
  && decide(ctx.perms, 'map') !== true;

// Up to MAP_ALL located people the map loads them all at once (and keeps a
// copy on the phone). A bigger list — a city's voter file — is loaded by the
// part of the map in view (?bbox=south,west,north,east, at most MAP_VIEW
// people), and from further out as a count per patch (/map/density).
const MAP_ALL = () => Number(process.env.STARBASE_MAP_ALL) || 5000;
// At most this many people in one view load (STARBASE_MAP_VIEW, for tests).
const mapView = () => Number(process.env.STARBASE_MAP_VIEW) || MAP_VIEW_DEFAULT;
const MAP_VIEW_DEFAULT = 8000;
const bboxParam = (v) => {
  const b = String(v || '').split(',').map(Number);
  return b.length === 4 && b.every(Number.isFinite) && b[0] <= b[2] && b[1] <= b[3] && b[0] >= -90 && b[2] <= 90 ? b : null;
};
const DOOR_COLS = 'id, name, phone, email, address, house_number, unit, lat, lng, rating, rated_at, voted_at, tags';

// The doors inside the turfs someone walks (and their own record): read by
// the turfs' corners, then kept to the outlines.
const turfDoors = async (db, ctx) => {
  const rings = (await db.query(
    `select t.polygon from turfs t join turf_members m on m.turf_id = t.id and m.user_id = $2
     where t.workspace_id = $1 and t.deleted_at is null`,
    [ctx.workspaceId, ctx.user.id],
  )).rows.map((t) => parseJson(t.polygon, []).map(([lat, lng]) => [Number(lat), Number(lng)])).filter((r) => r.length >= 3);
  const inTurf = (lat, lng) => lat != null && rings.some((r) => pointInPolygon(Number(lat), Number(lng), r));
  const mine = loginEmail(ctx);
  const boxes = rings.map(boxOf).filter(Boolean);
  const params = [ctx.workspaceId, mine || ''];
  const near = boxes.map((b) => {
    params.push(...b);
    const k = params.length;
    return `(lat between $${k - 3} and $${k - 1} and lng between $${k - 2} and $${k})`;
  });
  // The boxes bound the read; the outlines decide who's in (never a cut by
  // address first, which could drop doors inside a long turf's box).
  const byAddress = (a, b) => String(a.address || '').toLowerCase().localeCompare(String(b.address || '').toLowerCase())
    || String(a.name || '').toLowerCase().localeCompare(String(b.name || '').toLowerCase());
  const persons = (await db.query(
    `select ${DOOR_COLS} from persons
     where workspace_id = $1 and deleted_at is null and lat is not null and lng is not null
       and (${[...near, `($2 <> '' and lower(email) = $2)`].join(' or ')})`,
    params,
  )).rows.map(personRow).filter((p) => inTurf(p.lat, p.lng) || (mine && String(p.email || '').trim().toLowerCase() === mine))
    .sort(byAddress).slice(0, 20000);
  // A sign is theirs if it stands in a turf, or belongs to someone who
  // lives there (a sign asked for before its person had a pin has none).
  const ids = new Set(persons.map((p) => p.id));
  const signs = (await db.query(
    `select id, person_id, address, lat, lng, kind, status from signs where workspace_id = $1 and status <> 'removed'`,
    [ctx.workspaceId],
  )).rows.filter((s) => inTurf(s.lat, s.lng) || (s.person_id && ids.has(s.person_id)));
  return { rings, persons, signs };
};

app.get('/map/doors', async (c) => {
  const ctx = c.get('ctx');
  const db = c.get('db');
  if (turfsOnly(ctx)) {
    // Only the turfs they walk (and their own record).
    const { rings, persons, signs } = await turfDoors(db, ctx);
    return c.json({ persons: persons.map(forViewer(ctx)), signs, unlocated: 0, scope: 'turfs', turfs: rings.length });
  }
  const unlocated = (await db.query(
    `select count(*)::int as n from persons where workspace_id = $1 and deleted_at is null and address is not null and lat is null`,
    [ctx.workspaceId],
  )).rows[0].n;
  const bbox = bboxParam(c.req.query('bbox'));
  if (bbox) {
    // Over the cap, the ones nearest the middle of the box (what's on
    // screen) are kept and the margin is dropped — and the map is told.
    const rows = (await db.query(
      `select ${DOOR_COLS} from persons
       where workspace_id = $1 and deleted_at is null and lat between $2 and $4 and lng between $3 and $5
       order by abs(lat - ($2 + $4) / 2) + abs(lng - ($3 + $5) / 2)
       limit ${mapView() + 1}`,
      [ctx.workspaceId, ...bbox],
    )).rows;
    // A sign stands where it was put, or (asked for before its person had a
    // pin) at its person's door.
    const signs = (await db.query(
      `select s.id, s.person_id, s.address, s.lat, s.lng, s.kind, s.status from signs s
       left join persons p on p.id = s.person_id and p.workspace_id = s.workspace_id
       where s.workspace_id = $1 and s.status <> 'removed'
         and coalesce(s.lat, p.lat) between $2 and $4 and coalesce(s.lng, p.lng) between $3 and $5`,
      [ctx.workspaceId, ...bbox],
    )).rows;
    return c.json({ persons: rows.slice(0, mapView()).map(personRow).map(forViewer(ctx)), signs, unlocated, scope: 'view', truncated: rows.length > mapView() });
  }
  const total = (await db.query(
    'select count(*)::int as n from persons where workspace_id = $1 and deleted_at is null and lat is not null and lng is not null',
    [ctx.workspaceId],
  )).rows[0].n;
  // Too many for one load: the map asks by the part in view instead.
  if (total > MAP_ALL()) {
    // Where they live, so the map opens on them: the middle 98% (a few
    // stray places far away don't zoom the whole map out).
    const b = (await db.query(
      `select percentile_disc(0.01) within group (order by lat) as s, percentile_disc(0.01) within group (order by lng) as w,
              percentile_disc(0.99) within group (order by lat) as n, percentile_disc(0.99) within group (order by lng) as e
       from persons where workspace_id = $1 and deleted_at is null and lat is not null and lng is not null`,
      [ctx.workspaceId],
    )).rows[0];
    const bounds = [b.s, b.w, b.n, b.e].map(Number);
    // A volunteer's own turfs come whole (and stay on their phone for a
    // canvass with no signal); the rest loads by view like the desk's.
    const own = ctx.role === 'volunteer' ? await turfDoors(db, ctx) : null;
    return c.json({
      persons: own ? own.persons.map(forViewer(ctx)) : [], signs: own ? own.signs : [], unlocated, big: true, total,
      bounds: bounds.every(Number.isFinite) ? bounds : null, ...(own ? { turfs: own.rings.length } : {}),
    });
  }
  const persons = (await db.query(
    `select ${DOOR_COLS} from persons
     where workspace_id = $1 and deleted_at is null and lat is not null and lng is not null
     order by lower(address), lower(name)`,
    [ctx.workspaceId],
  )).rows.map(personRow);
  const signs = (await db.query(
    `select id, person_id, address, lat, lng, kind, status from signs
     where workspace_id = $1 and status <> 'removed'`,
    [ctx.workspaceId],
  )).rows;
  return c.json({ persons: persons.map(forViewer(ctx)), signs, unlocated, total });
});

// From further out, a big list as a count per patch of the map, by rating:
// ?bbox=south,west,north,east&cell=dlat,dlng → cells [[row, col, rating, n]]
// (the patch is row*dlat…, col*dlng…). Not for a map kept to its turfs.
app.get('/map/density', async (c) => {
  const ctx = c.get('ctx');
  const db = c.get('db');
  if (turfsOnly(ctx)) return c.json({ error: 'your map shows your turfs' }, 403);
  const bbox = bboxParam(c.req.query('bbox'));
  const cell = String(c.req.query('cell') || '').split(',').map(Number);
  if (!bbox || cell.length !== 2 || !cell.every((x) => Number.isFinite(x) && x > 0)) return c.json({ error: 'bbox and cell, please' }, 400);
  // A sane grid: about a big screen's worth of patches (only those with
  // people in them come back). Asked for finer than that (a very wide
  // screen), the patches double until they fit; the answer says which.
  const span = () => ((bbox[2] - bbox[0]) / cell[0]) * ((bbox[3] - bbox[1]) / cell[1]);
  while (span() > 150000) { cell[0] *= 2; cell[1] *= 2; }
  const rows = (await db.query(
    `select floor(lat / $6)::int as y, floor(lng / $7)::int as x, coalesce(rating, '') as r, count(*)::int as n
     from persons
     where workspace_id = $1 and deleted_at is null and lat between $2 and $4 and lng between $3 and $5
     group by 1, 2, 3`,
    [ctx.workspaceId, ...bbox, cell[0], cell[1]],
  )).rows;
  return c.json({ cell, cells: rows.map((r) => [r.y, r.x, r.r, r.n]) });
});

app.get('/persons/:id', async (c) => {
  if (badId(c)) return c.json({ error: 'not found' }, 404);
  const ctx = c.get('ctx');
  const db = c.get('db');
  const person = (await db.query(
    `select id, kind, name, first_name, middle_name, last_name, email, phone, address, house_number, unit, city, postal, lat, lng, tags, socials, rating, rated_at, voted_at, created_at,
            attrs->>'note' as note
     from persons where id = $1 and workspace_id = $2 and deleted_at is null`,
    [c.req.param('id'), ctx.workspaceId],
  )).rows[0];
  if (!person) {
    // Made one with another record (ext/duplicates): say which.
    const into = (await db.query(
      `select attrs->>'merged_into' as id from persons where id = $1 and workspace_id = $2 and deleted_at is not null`,
      [c.req.param('id'), ctx.workspaceId],
    )).rows[0]?.id;
    return c.json(into ? { error: 'merged into another record', merged_into: into } : { error: 'not found' }, 404);
  }
  const gifts = (await db.query(
    `select id, amount_cents, date, method, cadence, note, flagged, flag_reason from gifts
     where workspace_id = $1 and person_id = $2 and deleted_at is null order by date desc limit 200`,
    [ctx.workspaceId, person.id],
  )).rows;
  const totals = (await db.query(
    `select extract(year from date)::int as year, sum(amount_cents)::bigint as total_cents
     from gifts where workspace_id = $1 and person_id = $2 and deleted_at is null
     group by 1 order by 1 desc`,
    [ctx.workspaceId, person.id],
  )).rows;
  const contacts = (await db.query(
    `select c.id, c.channel, c.outcome, c.rating, c.note, c.created_at, u.name as by_name
     from contacts c left join users u on u.id = c.created_by
     where c.workspace_id = $1 and c.person_id = $2 order by c.created_at desc limit 100`,
    [ctx.workspaceId, person.id],
  )).rows;
  const roles = (await db.query(
    'select id, role, detail from volunteer_roles where workspace_id = $1 and person_id = $2 order by role',
    [ctx.workspaceId, person.id],
  )).rows;
  const signs = (await db.query(
    'select id, kind, status, note, created_at from signs where workspace_id = $1 and person_id = $2 order by created_at desc',
    [ctx.workspaceId, person.id],
  )).rows;
  const shifts = (await db.query(
    `select a.id as assignment_id, a.status, s.id, s.title, s.starts_at, s.location
     from shift_assignments a join shifts s on s.id = a.shift_id
     where a.workspace_id = $1 and a.person_id = $2 and s.deleted_at is null order by s.starts_at desc limit 50`,
    [ctx.workspaceId, person.id],
  )).rows;
  const donor = await tierFor(db, ctx.workspaceId, person.id);
  const household = (await db.query(
    `select id, name, rating from persons
     where workspace_id = $1 and deleted_at is null and id <> $2 and address is not null
       and lower(address) = lower($3) and coalesce(unit, '') = coalesce($4, '')`,
    [ctx.workspaceId, person.id, person.address || '', person.unit || null],
  )).rows;
  if (ctx.role === 'volunteer') {
    return c.json({
      person: forViewer(ctx)(personRow(person)), gifts: [], totals: [], contacts, roles, signs, shifts, donor: null, household,
    });
  }
  return c.json({ person: personRow(person), gifts, totals, contacts, roles, signs, shifts, donor, household });
});

app.route('/data', dataRoutes); // import · geocode · sample (desk roles; own guard)

// ── Turfs + walk lists ──
const parseJ = (v, d) => (typeof v === 'string' ? JSON.parse(v) : (v ?? d));
// door_knocked: anyone ever knocked on this person's door (a 'door' contact),
// so a walk list can tell a door reached only by phone or text from a knock.
// pass_tries / pass_last_outcome: this person's door contacts in the open
// pass (passId; ext/passes) — how many tries (every door contact; a lit drop is a not-home too)
// and the latest outcome. 0 / null with no pass open.
const loadLocated = async (db, ws, passId = null, box = null) => (await db.query(
  `select p.id, p.name, p.email, p.phone, p.address, p.house_number, p.unit, p.lat, p.lng, p.rating, p.tags, p.voted_at,
          (select max(c.created_at) from contacts c where c.person_id = p.id and c.workspace_id = p.workspace_id) as last_contact_at,
          (select c.outcome from contacts c where c.person_id = p.id and c.workspace_id = p.workspace_id order by c.created_at desc limit 1) as last_outcome,
          exists (select 1 from contacts c where c.person_id = p.id and c.workspace_id = p.workspace_id and c.channel = 'door') as door_knocked,
          (select count(*)::int from contacts c where c.person_id = p.id and c.workspace_id = p.workspace_id and c.channel = 'door' and c.pass_id = $2::uuid) as pass_tries,
          (select c.outcome from contacts c where c.person_id = p.id and c.workspace_id = p.workspace_id and c.channel = 'door' and c.pass_id = $2::uuid order by c.created_at desc limit 1) as pass_last_outcome
   from persons p where p.workspace_id = $1 and p.deleted_at is null and p.lat is not null and p.lng is not null
     ${box ? 'and p.lat between $3 and $5 and p.lng between $4 and $6' : ''}`,
  box ? [ws, passId, ...box] : [ws, passId],
)).rows.map((p) => ({ ...p, tags: parseJ(p.tags, []), door_knocked: !!p.door_knocked }));
// A polygon's corners, [south, west, north, east] (null for no polygon).
const boxOf = (polygon) => {
  const pts = (polygon || []).map(([lat, lng]) => [Number(lat), Number(lng)]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  if (pts.length < 3) return null;
  return [Math.min(...pts.map((x) => x[0])), Math.min(...pts.map((x) => x[1])), Math.max(...pts.map((x) => x[0])), Math.max(...pts.map((x) => x[1]))];
};

// Without a pass a door is done once someone there has been knocked (a
// 'door' contact, any outcome). A call or a text alone never finishes a door:
// the walk list still sends a canvasser there; the phone mark beside it is
// information only. With a pass open (ext/passes) the rule is
// shared/passes.js doorState: a door in the pass's universe is open, to try
// again (a no-answer short of the try limit) or done in THIS pass.
const doneDoor = (d, pass) => doorState(d, pass) === 'done';

// The turf's counts over the doors a pass lists (every door with no pass).
const turfStats = (polygon, located, pass) => {
  const inside = located.filter((p) => pointInPolygon(p.lat, p.lng, polygon));
  const doors = groupDoors(inside).filter((d) => inPass(d, pass));
  return {
    doors: doors.length,
    people: doors.reduce((n, d) => n + d.persons.length, 0),
    doorsDone: doors.filter((d) => doneDoor(d, pass)).length,
    doorsAgain: doors.filter((d) => doorState(d, pass) === 'again').length,
    rated: doors.reduce((n, d) => n + d.persons.filter((p) => p.rating).length, 0),
  };
};

app.get('/turfs', async (c) => {
  const ctx = c.get('ctx');
  const db = c.get('db');
  const desk = ctx.role !== 'volunteer';
  const turfs = (await db.query(
    desk
      ? 'select * from turfs where workspace_id = $1 and deleted_at is null order by created_at'
      : `select t.* from turfs t join turf_members m on m.turf_id = t.id and m.user_id = $2
         where t.workspace_id = $1 and t.deleted_at is null order by t.created_at`,
    desk ? [ctx.workspaceId] : [ctx.workspaceId, ctx.user.id],
  )).rows;
  const members = (await db.query(
    `select m.turf_id, u.id, u.name from turf_members m join users u on u.id = m.user_id where m.workspace_id = $1`,
    [ctx.workspaceId],
  )).rows;
  const pass = await openPass(db, ctx.workspaceId);
  // Each turf reads only the people inside its own corners (an index finds
  // them), never the whole list: a city-wide voter file stays quick.
  const out = [];
  for (const t of turfs) {
    const polygon = parseJ(t.polygon, []);
    const box = boxOf(polygon);
    const located = box ? await loadLocated(db, ctx.workspaceId, pass?.id, box) : [];
    out.push({
      id: t.id, name: t.name, color: t.color, notes: t.notes, polygon, created_at: t.created_at,
      members: members.filter((m) => m.turf_id === t.id).map(({ id, name }) => ({ id, name })),
      ...turfStats(polygon, located, pass),
    });
  }
  return c.json({ turfs: out, pass });
});

app.get('/turfs/:id/walk', async (c) => {
  if (badId(c)) return c.json({ error: 'not found' }, 404);
  const ctx = c.get('ctx');
  const db = c.get('db');
  const t = (await db.query('select * from turfs where id = $1 and workspace_id = $2 and deleted_at is null',
    [c.req.param('id'), ctx.workspaceId])).rows[0];
  if (!t) return c.json({ error: 'not found' }, 404);
  if (ctx.role === 'volunteer') {
    const mine = (await db.query('select 1 from turf_members where turf_id = $1 and user_id = $2', [t.id, ctx.user.id])).rows[0];
    if (!mine) return c.json({ error: 'this turf is not assigned to you' }, 403);
  }
  const polygon = parseJ(t.polygon, []);
  const pass = await openPass(db, ctx.workspaceId);
  const box = boxOf(polygon);
  const located = box ? await loadLocated(db, ctx.workspaceId, pass?.id, box) : [];
  const doors = walkOrder(groupDoors(located.filter((p) => pointInPolygon(p.lat, p.lng, polygon))).filter((d) => inPass(d, pass)));
  const view = forViewer(ctx);
  // Each door's signs (requested or up), matched the way the map matches
  // them — by a person there, or by the address of a door with no unit — so
  // "Wants a sign?" never offers a kind the door already has.
  const signs = (await db.query(
    `select id, person_id, address, kind, status from signs where workspace_id = $1 and status <> 'removed'`,
    [ctx.workspaceId],
  )).rows;
  const signsAt = (d) => {
    const ids = new Set(d.persons.map((p) => p.id));
    const addr = !d.unit && d.address ? String(d.address).trim().toLowerCase() : null;
    return signs
      .filter((s) => (s.person_id ? ids.has(s.person_id) : addr && String(s.address || '').trim().toLowerCase() === addr))
      .map(({ id, kind, status }) => ({ id, kind, status }));
  };
  return c.json({
    turf: { id: t.id, name: t.name, color: t.color, notes: t.notes, polygon },
    // Each door's state in the open pass (open · again · done) and the most
    // tries anyone there has had; done is state === 'done' (the old rule
    // with no pass). pass_tries / pass_last_outcome stay on the person rows
    // (forViewer keeps them: not an email, not a money tag) — the phone
    // lays its own knocks over them with the same rule.
    doors: doors.map((d) => {
      const state = doorState(d, pass);
      return { ...d, persons: d.persons.map(view), signs: signsAt(d), state, tries: Math.max(0, ...d.persons.map((p) => p.pass_tries || 0)), done: state === 'done' };
    }),
    pass: pass ? { id: pass.id, name: pass.name, kind: pass.kind, who: pass.who, tries: pass.tries, started_at: pass.started_at } : null,
    stats: turfStats(polygon, located, pass),
  });
});

// Team members for assignment pickers (desk roles; /team stays manager-only).
app.get('/members', async (c) => {
  const ctx = c.get('ctx');
  const { rows } = await c.get('db').query(
    `select u.id, u.name, m.role from memberships m join users u on u.id = m.user_id
     where m.workspace_id = $1 order by u.name`, [ctx.workspaceId],
  );
  return c.json({ members: rows });
});

// ── Team (managers) ──
app.get('/team', async (c) => {
  const ctx = c.get('ctx');
  if (ctx.role !== 'manager') return c.json({ error: 'managers only' }, 403);
  const db = c.get('db');
  const members = (await db.query(
    `select u.id, u.name, u.email, m.role, m.created_at from memberships m join users u on u.id = m.user_id
     where m.workspace_id = $1 order by m.created_at`,
    [ctx.workspaceId],
  )).rows;
  const invites = (await db.query(
    `select id, email, role, created_at, expires_at from invites
     where workspace_id = $1 and accepted_at is null and expires_at > now() order by created_at desc`,
    [ctx.workspaceId],
  )).rows;
  return c.json({ members, invites });
});

// ── Field reads ──
app.get('/signs', async (c) => {
  const ctx = c.get('ctx');
  const { rows } = await c.get('db').query(
    `select s.*, p.name as person_name from signs s left join persons p on p.id = s.person_id
     where s.workspace_id = $1 order by s.status, s.created_at desc limit 1000`,
    [ctx.workspaceId],
  );
  return c.json({ signs: rows });
});

app.get('/contacts', async (c) => {
  const ctx = c.get('ctx');
  const limit = Math.min(Number(c.req.query('limit')) || 100, 500);
  const { rows } = await c.get('db').query(
    `select c.id, c.person_id, p.name as person_name, c.channel, c.outcome, c.rating, c.note, c.created_at, u.name as by_name
     from contacts c join persons p on p.id = c.person_id left join users u on u.id = c.created_by
     where c.workspace_id = $1 order by c.created_at desc limit $2`,
    [ctx.workspaceId, limit],
  );
  return c.json({ contacts: rows });
});

// mine: the caller's own supporter record — the person whose email is their
// login email — is actively on shift s (assigned or confirmed). $2 is that
// email, lower-cased; '' (no email) is never anyone.
const MINE_ON_SHIFT = `exists (
  select 1 from shift_assignments a join persons p on p.id = a.person_id
  where a.shift_id = s.id and a.workspace_id = s.workspace_id and a.status in ('assigned', 'confirmed')
    and p.deleted_at is null and $2::text <> '' and lower(p.email) = $2::text)`;

// The shifts list: what is coming up — everything not yet over at the start
// of today, on the campaign's clock — soonest first. Past shifts only when
// asked (?past=1), newest first. A page at a time: 500 coming up (100 past),
// and `next` is the cursor for the page after (?cursor=…), null at the end.
// Each row is the shift's own columns plus filled, mine and its saved
// place's pin (place_lat, place_lng: ext/schedule). A caller's own shifts
// past the first page of 500 come with it all the same, so "Your next
// shift" is never one the list left out.
const SHIFTS_PAGE = 500;
const PAST_PAGE = 100;
const SHIFT_ROW = `s.*, pl.lat as place_lat, pl.lng as place_lng,
            (select count(*)::int from shift_assignments a where a.shift_id = s.id and a.status in ('assigned', 'confirmed', 'completed')) as filled,
            ${MINE_ON_SHIFT} as mine`;
const SHIFT_FROM = 'from shifts s left join places pl on pl.id = s.place_id where s.workspace_id = $1 and s.deleted_at is null';
// The start of the campaign's today ($3: its zone).
const TODAY_START = startOfDay('$3::text');
const NOT_OVER = `coalesce(s.ends_at, s.starts_at) >= ${TODAY_START}`;
const shiftCursor = (raw) => {
  const [at, id] = String(raw || '').split(',');
  return UUID_RE.test(id || '') && !Number.isNaN(Date.parse(at)) ? [new Date(at).toISOString(), id] : null;
};
const cursorOf = (s) => `${new Date(s.starts_at).toISOString()},${s.id}`;

app.get('/shifts', async (c) => {
  const ctx = c.get('ctx');
  const db = c.get('db');
  const past = c.req.query('past') === '1';
  const page = past ? PAST_PAGE : SHIFTS_PAGE;
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || page, 1), SHIFTS_PAGE);
  const cursor = shiftCursor(c.req.query('cursor'));
  const params = [ctx.workspaceId, loginEmail(ctx), ctx.workspace?.settings?.tz || DEFAULT_TZ, limit + 1];
  if (cursor) params.push(...cursor);
  const after = cursor ? `and (s.starts_at, s.id) ${past ? '<' : '>'} ($5::timestamptz, $6::uuid)` : '';
  const rows = (await db.query(
    past
      ? `select ${SHIFT_ROW} ${SHIFT_FROM} and not (${NOT_OVER}) ${after} order by s.starts_at desc, s.id desc limit $4`
      : `select ${SHIFT_ROW} ${SHIFT_FROM} and ${NOT_OVER} ${after} order by s.starts_at, s.id limit $4`,
    params,
  )).rows;
  const more = rows.length > limit;
  const shifts = more ? rows.slice(0, limit) : rows;
  const next = more ? cursorOf(shifts[shifts.length - 1]) : null;
  if (more && !past && !cursor) {
    const [at, id] = shiftCursor(next);
    shifts.push(...(await db.query(
      `select ${SHIFT_ROW} ${SHIFT_FROM} and ${NOT_OVER} and (s.starts_at, s.id) > ($4::timestamptz, $5::uuid) and ${MINE_ON_SHIFT}
       order by s.starts_at, s.id limit 50`,
      [ctx.workspaceId, loginEmail(ctx), ctx.workspace?.settings?.tz || DEFAULT_TZ, at, id],
    )).rows);
  }
  return c.json({ shifts: shifts.map((s) => ({ ...s, mine: !!s.mine })), next });
});

// The desk's week board: every shift starting in [from, to) with who holds
// a spot on it (booked, confirmed or checked in — names only, as many as
// "filled" counts), and the tray — the people to put on shifts: anyone
// holding a volunteer role, signed in as a volunteer (matched by email),
// who asked to volunteer (the website's form, a door, Mainstreeting:
// `asked` while that is still open) or who has been on a shift (a spot
// taken on the website is one). Names and roles only. Read from those small
// tables first, so a city-wide voter list is never gone through for it.
// The client sorts shifts by the part of the day they start in
// (shared/dayparts.js). At most 15 days per read.
app.get('/shifts/board', async (c) => {
  const ctx = c.get('ctx');
  const db = c.get('db');
  const from = new Date(c.req.query('from') || '');
  const to = new Date(c.req.query('to') || '');
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from || to - from > 15 * 864e5) {
    return c.json({ error: 'from and to: a week, as timestamps' }, 400);
  }
  const shifts = (await db.query(
    `select s.id, s.title, s.role, s.location, s.starts_at, s.ends_at, s.capacity,
            s.kind, s.place_id, s.need, s.series_id, s.public,
            (select count(*)::int from shift_assignments a where a.shift_id = s.id and a.status in ('assigned', 'confirmed', 'completed')) as filled
     from shifts s where s.workspace_id = $1 and s.deleted_at is null and s.starts_at >= $2 and s.starts_at < $3
     order by s.starts_at, s.title limit 500`,
    [ctx.workspaceId, from.toISOString(), to.toISOString()],
  )).rows;
  const ids = shifts.map((s) => s.id);
  const assignments = ids.length ? (await db.query(
    `select a.id, a.shift_id, a.person_id, a.status, p.name
     from shift_assignments a join persons p on p.id = a.person_id
     where a.workspace_id = $1 and a.shift_id = any($2::uuid[]) and a.status in ('assigned', 'confirmed', 'completed')
     order by lower(p.name)`,
    [ctx.workspaceId, ids],
  )).rows : [];
  const people = (await db.query(
    `with ids as (
       select person_id as id from volunteer_roles where workspace_id = $1
       union select person_id from shift_assignments where workspace_id = $1
       union select person_id from door_requests where workspace_id = $1 and kind = 'volunteer'
       union select p.id from memberships m
         join users u on u.id = m.user_id
         join persons p on p.workspace_id = $1 and p.deleted_at is null and p.email is not null and lower(p.email) = lower(u.email)
         where m.workspace_id = $1 and m.role = 'volunteer')
     select p.id, p.name,
            coalesce((select json_agg(distinct v.role) from volunteer_roles v
                      where v.person_id = p.id and v.workspace_id = p.workspace_id), '[]'::json) as roles,
            exists (select 1 from door_requests r
                    where r.workspace_id = p.workspace_id and r.person_id = p.id and r.kind = 'volunteer' and r.done_at is null) as asked
     from persons p join ids on ids.id = p.id
     where p.workspace_id = $1 and p.deleted_at is null
     order by lower(p.name), p.id limit 1000`,
    [ctx.workspaceId],
  )).rows.map((p) => ({ ...p, roles: typeof p.roles === 'string' ? JSON.parse(p.roles) : p.roles, asked: !!p.asked }));
  return c.json({ shifts, assignments, people });
});

app.get('/shifts/:id', async (c) => {
  if (badId(c)) return c.json({ error: 'not found' }, 404);
  const ctx = c.get('ctx');
  const db = c.get('db');
  // With its saved place's pin, when it has one (ext/schedule).
  const shift = (await db.query(
    `select s.*, pl.lat as place_lat, pl.lng as place_lng from shifts s left join places pl on pl.id = s.place_id
     where s.id = $1 and s.workspace_id = $2 and s.deleted_at is null`,
    [c.req.param('id'), ctx.workspaceId],
  )).rows[0];
  if (!shift) return c.json({ error: 'not found' }, 404);
  const myEmail = String(ctx.user.email || '').toLowerCase();
  const assignees = (await db.query(
    `select a.id as assignment_id, a.status, a.notified_at, a.notify_email, a.notify_text,
            p.id, p.name, p.email, p.phone, (lower(p.email) = $3) as is_me
     from shift_assignments a join persons p on p.id = a.person_id
     where a.shift_id = $1 and a.workspace_id = $2 order by p.name`,
    [shift.id, ctx.workspaceId, myEmail],
  )).rows.map((a) => ({ ...a, is_me: !!a.is_me }));
  // Volunteers see who else is on the shift, not how to reach them.
  if (ctx.role === 'volunteer') {
    return c.json({
      shift,
      assignees: assignees.map((a) => (a.is_me ? a : { ...a, email: null, phone: null, notify_email: null, notify_text: null })),
    });
  }
  return c.json({ shift, assignees });
});

app.get('/subscriptions', async (c) => {
  const ctx = c.get('ctx');
  const { rows } = await c.get('db').query(
    `select id, email, name, status, source, created_at, unsubscribed_at from subscriptions
     where workspace_id = $1 order by created_at desc limit 5000`,
    [ctx.workspaceId],
  );
  return c.json({
    subscriptions: rows,
    subscribed: rows.filter((r) => r.status === 'subscribed').length,
    unsubscribed: rows.filter((r) => r.status === 'unsubscribed').length,
    slug: ctx.workspace.slug,
  });
});

// Each send carries its recipients by status, so the screen can say exactly
// how many were sent, failed, and are still waiting. queued_count for a
// newsletter counts only addresses still subscribed — the ones Send now
// would actually email (blast.resend drops the rest); retry_count is the
// same for Try again (failed + queued, still subscribed, plus any the email
// service never answered for in 10 minutes). failed_count stays the plain
// record of what happened; sending_count is "not sure it went". going_count:
// on their way now — a send job is carrying the send on (ext/abtests
// send.js goingRow); those are never "not sent" and not in retry_count.
app.get('/blasts', async (c) => {
  const ctx = c.get('ctx');
  const { rows } = await c.get('db').query(
    `select b.id, b.kind, b.subject, b.status, b.provider_note, b.audience_count, b.sent_at, b.created_at, b.audience, b.list_id,
            k.sent_count, k.failed_count, k.queued_count, k.retry_count, k.sending_count, k.going_count
     from blasts b
     cross join lateral (select ${sendJobOn('b.id', 'b.workspace_id')} as job_on) j
     cross join lateral (
       select (count(*) filter (where r.status = 'sent'))::int as sent_count,
              (count(*) filter (where r.status = 'failed'))::int as failed_count,
              (count(*) filter (where r.status = 'queued' and l.live))::int as queued_count,
              (count(*) filter (where ${retryable('r')} and l.live and not (j.job_on and ${goingRow('r')})))::int as retry_count,
              (count(*) filter (where r.status = 'sending'))::int as sending_count,
              (count(*) filter (where j.job_on and ${goingRow('r')} and l.live))::int as going_count
       from blast_recipients r
       cross join lateral (
         select (b.kind <> 'newsletter' or exists (
           select 1 from subscriptions s
           where s.workspace_id = b.workspace_id and lower(s.email) = lower(r.email) and s.status = 'subscribed')) as live
       ) l
       where r.workspace_id = b.workspace_id and r.blast_id = b.id
     ) k
     where b.workspace_id = $1 order by b.created_at desc limit 200`,
    [ctx.workspaceId],
  );
  const media = (await c.get('db').query(
    `select count(*)::int as n from persons where workspace_id = $1 and deleted_at is null and email is not null and tags @> '"media"'::jsonb`,
    [ctx.workspaceId],
  )).rows[0].n;
  const files = await attachmentsOf(c.get('db'), ctx.workspaceId);
  const parseJ = (v) => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };
  return c.json({
    blasts: rows.map((b) => ({ ...b, audience: parseJ(b.audience) || null, attachments: files[b.id] || [] })),
    mediaContacts: media, emailConfigured: emailConfigured(), textConfigured: textConfigured(),
  });
});

// ── Records: generic cursor-paginated reads per registry type ──
app.get('/records/:type', async (c) => {
  const type = c.req.param('type');
  const t = RECORD_TYPES[type];
  if (!t) return c.json({ error: `unknown record type '${type}'` }, 404);
  const ctx = c.get('ctx');
  const limit = Math.min(Number(c.req.query('limit')) || 50, 200);
  const cursor = c.req.query('cursor') || null; // created_at|id tuple cursor
  const params = [ctx.workspaceId, limit];
  let where = 'workspace_id = $1 and deleted_at is null';
  if (cursor) {
    const [ts, id] = cursor.split('~');
    params.push(ts, id);
    where += ` and (created_at, id) < ($3::timestamptz, $4::uuid)`;
  }
  // Gifts carry the donor's name so the ledger needs no per-row lookups.
  const select = type === 'gift'
    ? `select g.*, p.name as person_name from gifts g left join persons p on p.id = g.person_id
       where ${where.replace(/\b(workspace_id|deleted_at|created_at|id)\b/g, 'g.$1')}
       order by g.created_at desc, g.id desc limit $2`
    : `select * from ${t.table} where ${where} order by created_at desc, id desc limit $2`;
  const { rows } = await c.get('db').query(select, params);
  // A maybe in the ledger names its records as the brief does.
  if (type === 'gift') await nameMaybes(c.get('db'), ctx.workspaceId, rows, (g) => g.flagged && g.attrs?.maybe_same_donor);
  const next = rows.length === limit
    ? `${new Date(rows[rows.length - 1].created_at).toISOString()}~${rows[rows.length - 1].id}`
    : null;
  return c.json({ records: rows, next });
});

// ── Events: the sync protocol / public API ──
app.get('/events', async (c) => {
  const ctx = c.get('ctx');
  const since = Number(c.req.query('since') || 0);
  const limit = Math.min(Number(c.req.query('limit')) || 200, 1000);
  const { rows } = await c.get('db').query(
    `select seq, action, entity_type, entity_id, op, payload, actor_id, server_ts, hash
     from events where workspace_id = $1 and seq > $2 order by seq limit $3`,
    [ctx.workspaceId, since, limit],
  );
  return c.json({ events: rows, cursor: rows.length ? Number(rows[rows.length - 1].seq) : since });
});

// ── Audit: verify my books ──
app.get('/audit/verify', async (c) => {
  const ctx = c.get('ctx');
  return c.json(await verifyChain(c.get('db'), ctx.workspaceId));
});

// ── Brief: Today, composed server-side ──
app.get('/brief', async (c) => {
  const ctx = c.get('ctx');
  const db = c.get('db');
  const ws = ctx.workspaceId;
  const money = (await db.query(
    `select coalesce(sum(amount_cents), 0)::bigint as total,
            coalesce(sum(amount_cents) filter (where date >= current_date - 7), 0)::bigint as week,
            count(*)::int as gifts
     from gifts where workspace_id = $1 and deleted_at is null`, [ws],
  )).rows[0];
  const flagged = (await db.query(
    `select g.id, g.person_id, g.amount_cents, g.date, g.slate, g.flag_reason, g.attrs->'maybe_same_donor' as maybe_same_donor, p.name as donor
     from gifts g join persons p on p.id = g.person_id
     where g.workspace_id = $1 and g.deleted_at is null and g.flagged order by g.date desc limit 10`, [ws],
  )).rows;
  // Each flagged gift carries the donor's total for that gift's year and
  // slate (as it stands now, voids excluded) and the cap — from the same
  // engine that flagged it — so the desk shows "$150 over the $1,250 limit"
  // without parsing flag_reason. Null when no cap rule is known for that
  // year. A maybe (lib/gifts.js) also carries the other records it names
  // (maybe_same_donor: their ids; maybe_same_as: each one's name and what it
  // shares), for the desk's Not the same person, one record at a time.
  if (ctx.role !== 'volunteer') {
    for (const g of flagged) {
      const cap = await checkCap(db, {
        workspaceId: ws, personId: g.person_id, date: dateOnly(g.date),
        jurisdiction: ctx.workspace.jurisdiction, settings: ctx.workspace.settings || {}, slate: g.slate,
      });
      g.total_cents = cap.checked ? Number(cap.totalCents) : null;
      g.cap_cents = cap.checked ? Number(cap.capCents) : null;
    }
    await nameMaybes(db, ws, flagged, (g) => g.maybe_same_donor);
  }
  const people = (await db.query(
    `select count(*)::int as total from persons where workspace_id = $1 and deleted_at is null`, [ws],
  )).rows[0];
  // Field, over the last 7 days (rolling): doors are DISTINCT doors knocked —
  // a household rated twice, or a rating changed, is still one door; the key
  // is the address + unit (the walk list's grouping), or the person when they
  // have no address. Calls and texts count contacts (texts sent through the
  // app are added by the texting feature's brief hook). mine: the same
  // counts over the contacts the caller logged; week: every contact.
  const field = (await db.query(
    `select count(*)::int as week,
            count(distinct w.door) filter (where w.channel = 'door')::int as doors,
            count(*) filter (where w.channel = 'phone')::int as calls,
            count(*) filter (where w.channel = 'text')::int as texts,
            count(distinct w.door) filter (where w.channel = 'door' and w.created_by = $2)::int as my_doors,
            count(*) filter (where w.channel = 'phone' and w.created_by = $2)::int as my_calls,
            count(*) filter (where w.channel = 'text' and w.created_by = $2)::int as my_texts
     from (
       select c.channel, c.created_by,
              case when nullif(trim(p.address), '') is null then p.id::text
                   else lower(trim(p.address)) || '|' || lower(trim(coalesce(p.unit, ''))) end as door
       from contacts c join persons p on p.id = c.person_id
       where c.workspace_id = $1 and c.created_at >= now() - interval '7 days'
     ) w`, [ws, ctx.user.id],
  )).rows[0];
  const ratings = (await db.query(
    `select rating, count(*)::int as n from persons
     where workspace_id = $1 and deleted_at is null and rating is not null group by rating`, [ws],
  )).rows;
  const shifts = (await db.query(
    `select s.id, s.title, s.starts_at, s.location, s.capacity, s.kind, s.need,
            (select count(*)::int from shift_assignments a where a.shift_id = s.id and a.status in ('assigned', 'confirmed', 'completed')) as filled,
            ${MINE_ON_SHIFT} as mine
     from shifts s where s.workspace_id = $1 and s.deleted_at is null and s.starts_at >= now()
     order by s.starts_at limit 5`, [ws, loginEmail(ctx)],
  )).rows.map((s) => ({ ...s, mine: !!s.mine }));
  const signs = (await db.query(
    `select status, count(*)::int as n from signs where workspace_id = $1 group by status`, [ws],
  )).rows;
  const myTurfs = (await db.query(
    `select t.id, t.name from turfs t join turf_members m on m.turf_id = t.id and m.user_id = $2
     where t.workspace_id = $1 and t.deleted_at is null order by t.created_at`, [ws, ctx.user.id],
  )).rows;
  const sampleLoaded = !!(ctx.workspace.settings?.sample);
  const desk = ctx.role !== 'volunteer';
  // The desk's first steps. One of them is whether a gift was ever logged,
  // so — like money — a volunteer never receives it.
  let activation = null;
  if (desk) {
    activation = {
      steps: [
        { key: 'person', label: 'Add your first person', done: people.total > 0 },
        { key: 'gift', label: 'Log your first gift', done: Number(money.gifts) > 0 },
      ],
    };
    activation.complete = activation.steps.every((s) => s.done);
  }
  const body = {
    money: desk ? { totalCents: Number(money.total), weekCents: Number(money.week), gifts: Number(money.gifts) } : null,
    flagged: desk ? flagged : [],
    people,
    field: {
      week: field.week, doors: field.doors, calls: field.calls, texts: field.texts,
      mine: { doors: field.my_doors, calls: field.my_calls, texts: field.my_texts },
    },
    ratings: Object.fromEntries(ratings.map((r) => [r.rating, r.n])),
    shifts,
    signs: Object.fromEntries(signs.map((r) => [r.status, r.n])),
    myTurfs,
    sampleLoaded,
    providers: { email: emailConfigured(), text: textConfigured() },
    activation,
    generatedAt: new Date().toISOString(),
  };
  // Features correct the counts they own (texts sent through the app), and
  // may warn managers of what only they can fix (an account locked by wrong
  // two-step codes: ext/twostep).
  await runHooks('brief', db, ctx, body);
  // Managers hear about a server problem only they can get fixed.
  const tz = ctx.role === 'manager' ? staleTimeZoneData() : null;
  if (tz) body.serverWarnings = [tz, ...(body.serverWarnings || [])];
  return c.json(body);
});

// ── Export: contractual open data — everything, one click ──
// Every campaign table, as rows: the core's below, the record types, and
// each feature's own (exportTables). Never sign-ins, sessions or invites, and
// never a link's secret token (omit).
const CORE_EXPORT = [
  'contacts', 'signs', 'volunteer_roles', 'shifts', 'shift_assignments', 'turfs', 'turf_members',
  'subscriptions', 'blasts', { table: 'blast_recipients', omit: ['token'] },
];
const exportSpec = (spec) => (typeof spec === 'string' ? { table: spec, omit: [] } : { omit: [], ...spec });
app.get('/export', async (c) => {
  const ctx = c.get('ctx');
  const db = c.get('db');
  const ws = ctx.workspaceId;
  const out = {
    format: 'starbase-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    workspace: ctx.workspace,
    persons: (await db.query('select * from persons where workspace_id = $1', [ws])).rows,
    events: (await db.query('select * from events where workspace_id = $1 order by seq', [ws])).rows,
  };
  for (const t of Object.values(RECORD_TYPES)) {
    out[t.table] = (await db.query(`select * from ${t.table} where workspace_id = $1`, [ws])).rows;
  }
  for (const spec of [...CORE_EXPORT, ...EXTENSIONS.flatMap((e) => e.exportTables || [])]) {
    const { table, omit } = exportSpec(spec);
    const rows = (await db.query(`select * from ${table} where workspace_id = $1`, [ws])).rows;
    out[table] = omit.length
      ? rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !omit.includes(k))))
      : rows;
  }
  c.header('Content-Disposition', 'attachment; filename="starbase-export.json"');
  return c.json(out);
});

// Feature modules' signed-in routes, behind the same auth and volunteer guard.
for (const e of EXTENSIONS) if (e.api) app.route('/', e.api);

export default app;
export { httpError };
