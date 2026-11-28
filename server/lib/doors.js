// A door's parts, worked out once and kept beside the row for SQL (UNITS §4).
//
// shared/units.js reads a door (the civic address, the unit written in the
// Unit column or inside the address, what kind of door it is). The map's
// dots, Path to win, a pass's stats, Today and the lit drop count doors in
// SQL over a whole voter list, and can't run that parser per row per
// request. So the server stores what it reads, in four columns of persons:
//
//   door_civic  the civic address, one spelling ('10388 134 st')
//   door_unit   the unit's key ('' the main door, 'BSMT', '1203', 'B', …)
//   door_kind   main | suite | unit | letter | other
//   door_src    '<UNIT_V>|<address>|<unit>': what they were worked out from
//
// address and unit are never rewritten, and neither is updated_at. A row
// whose door_src no longer matches its own address and unit (edited since,
// or never worked out) is stale: every reader below then falls back to the
// key used before (lower(trim(address)) | lower(trim(unit))), so a stale
// value is never read. The parts are filled:
//   - right after a write that touched a person commits (watchDoorWrites:
//     one listener on the write spine, lib/events.js onCommitted);
//   - by the sweeper (startDoorSweeper), at start until none is stale, then
//     every 60 s: the safety net for any writer that changes a row outside
//     runAction, and for every row after a parser change (UNIT_V).
// For rows written in the last moment (or before the first sweep after a
// deploy) one door can be half fresh, half not, and count as two for a
// little while; the numbers settle once the sweep is done.
//
// The parser's door key in JS is shared/units.js doorKey; FRESH/doorSql here
// are the same key for SQL, and the only copy of it.
import { UNIT_V, doorParts, doorKey, placeOf } from '../../shared/units.js';
import { REACH } from '../../shared/buildings.js';

export { UNIT_V };

// What the parts are worked out from, as SQL and as JS build it (one shape).
const srcSql = (a) => `'${UNIT_V}|' || coalesce(${a}.address, '') || '|' || coalesce(${a}.unit, '')`;
export const srcOf = (address, unit) => `${UNIT_V}|${address ?? ''}|${unit ?? ''}`;

// The row's parts are its own (worked out from its address and unit as they are now).
export const FRESH = (a = 'p') => `${a}.door_src is not distinct from (${srcSql(a)})`;
// The stale rows' test, written exactly as the partial index's predicate,
// so the sweeper's read uses it (without the table's alias).
const STALE_PRED = `door_src is distinct from ('${UNIT_V}|' || coalesce(address, '') || '|' || coalesce(unit, ''))`;
// The index's name carries the parser version: after UNIT_V changes, the
// new one is made and the old one dropped at start (db/schema.js).
export const STALE_INDEX = `persons_door_stale_v${UNIT_V}_idx`;
export const STALE_INDEX_RE = /^persons_door_stale_v\d+_idx$/;
export const doorSchemaSql = () => `
alter table persons add column if not exists door_civic text;
alter table persons add column if not exists door_unit text;
alter table persons add column if not exists door_kind text;
alter table persons add column if not exists door_src text;
create index if not exists persons_ws_door_idx on persons (workspace_id, door_civic, door_unit) where deleted_at is null;
create index if not exists persons_ws_door_civic_prefix_idx on persons (workspace_id, door_civic text_pattern_ops)
  where deleted_at is null and door_civic is not null;
create index if not exists ${STALE_INDEX} on persons (workspace_id) where ${STALE_PRED};
`;

// The key used before the parts were stored: what a stale row reads as.
const OLD_KEY = (a) => `lower(trim(${a}.address)) || '|' || lower(trim(coalesce(${a}.unit, '')))`;
// The one SQL door key: the person when there is no address, the fresh
// parts, else the old key.
export const doorSql = (a = 'p') => `(case when nullif(trim(${a}.address), '') is null then ${a}.id::text
  when ${FRESH(a)} then ${a}.door_civic || '|' || ${a}.door_unit
  else ${OLD_KEY(a)} end)`;
// The door's kind, fresh, else as the old key read it (no unit: the main door).
export const doorKindSql = (a = 'p') => `(case when ${FRESH(a)} then ${a}.door_kind
  when nullif(trim(coalesce(${a}.unit, '')), '') is null then 'main' else 'unit' end)`;
// The civic address alone (no unit), fresh, else the old reading: the
// address with a "1203-" in front taken off, in small letters.
export const doorCivicSql = (a = 'p') => `(case when ${FRESH(a)} then ${a}.door_civic
  when strpos(${a}.address, '-') > 0 then regexp_replace(lower(btrim(${a}.address)), '^\\s*#?\\d{1,4}[a-z]?\\s*-\\s*(?=\\d{4,})', '')
  else lower(btrim(coalesce(${a}.address, ''))) end)`;
// The unit, fresh, else the old door (the address and unit as written):
// two rows are one door only when today's key says so.
export const doorUnitSql = (a = 'p') => `(case when ${FRESH(a)} then ${a}.door_unit
  else lower(btrim(coalesce(${a}.address, ''))) || '|' || lower(btrim(coalesce(${a}.unit, ''))) end)`;
// Kind for counting a building, fresh, else: a row with a unit (in its
// column or "1203-" in front of the address) is a numbered unit.
export const doorUnitKindSql = (a = 'p') => `(case when ${FRESH(a)} then ${a}.door_kind
  when nullif(btrim(coalesce(${a}.unit, '')), '') is not null
    or ${a}.address ~ '^\\s*#?\\d{1,4}[A-Za-z]?\\s*-\\s*\\d{4,}' then 'unit' else 'main' end)`;

// Which of these rows' doors is at a house with suites: the doors at the
// same civic address within a building's reach (as the map and the walk
// list group them; with no pin, every door at that civic address), and
// shared/units.js placeOf over them. Those rows get place: 'house', so a
// list words the door as every other screen does ("Suite B · 10500 134 St",
// "Main · 10388 134 St"); others are left as they are. Read by the stored
// civic (indexed); a row not worked out yet counts only itself. → rows.
export const markHouses = async (db, workspaceId, rows) => {
  const mine = new Map();
  for (const r of rows || []) {
    if (!String(r?.address || '').trim()) continue;
    const { civic } = doorParts(r);
    if (civic) mine.set(r, civic);
  }
  if (!mine.size) return rows;
  const civics = [...new Set(mine.values())];
  const others = (await db.query(
    `select p.id, p.address, p.unit, p.lat, p.lng from persons p
      where p.workspace_id = $1 and p.deleted_at is null and p.door_civic = any($2::text[]) and ${FRESH('p')}`,
    [workspaceId, civics],
  )).rows;
  const byCivic = new Map();
  const add = (x) => {
    const c = doorParts(x).civic;
    if (!c) return;
    if (!byCivic.has(c)) byCivic.set(c, new Map());
    byCivic.get(c).set(x.id, x);
  };
  for (const x of others) add(x);
  for (const r of mine.keys()) add(r);
  const near = (r, x) => r.lat == null || r.lng == null || (x.lat != null && x.lng != null
    && Math.abs(Number(x.lat) - Number(r.lat)) <= REACH && Math.abs(Number(x.lng) - Number(r.lng)) <= REACH);
  const seen = new Map();
  for (const [r, civic] of mine) {
    const memo = `${civic}|${r.lat ?? ''}|${r.lng ?? ''}`;
    if (!seen.has(memo)) {
      const doors = new Map();
      for (const x of byCivic.get(civic).values()) if (near(r, x)) doors.set(doorKey(x), x);
      seen.set(memo, placeOf([...doors.values()]) === 'house');
    }
    if (seen.get(memo)) r.place = 'house';
  }
  return rows;
};

// One person's parts as stored.
export const partsRow = (p) => {
  const d = doorParts({ address: p.address, unit: p.unit });
  return { id: p.id, c: d.civic, u: d.unit, k: d.kind, s: srcOf(p.address, p.unit) };
};

export const BATCH = 2000;

// Fill the parts of stale rows: the ids given, or one campaign, or every
// campaign; BATCH at a time, at most max. Writes only the four door
// columns. Each batch is one short transaction that takes the rows it
// reads with "for update skip locked": a row another write holds (an
// import's) is left for the next sweep, never waited for, so the two can
// never deadlock; and a short lock_timeout covers the rest. A row edited
// between the read and the write can't be: it is locked.
export const fillDoorParts = async (db, { workspaceId = null, ids = null, max = Infinity } = {}) => {
  let filled = 0;
  const where = ids ? 'id = any($1::uuid[])' : workspaceId ? 'workspace_id = $1' : 'true';
  const list = ids ? [...new Set(ids)].filter(Boolean) : null;
  if (list && !list.length) return { filled };
  for (let part = 0; ; part += 1) {
    if (filled >= max) break;
    const chunk = list ? list.slice(part * BATCH, (part + 1) * BATCH) : null;
    if (list && !chunk.length) break;
    const limit = Math.min(BATCH, max - filled);
    const n = await db.transaction(async (tx) => {
      if (db.kind === 'postgres') await tx.query("set local lock_timeout = '2s'");
      const rows = (await tx.query(
        `select id, address, unit from persons where ${where} and ${STALE_PRED} limit ${limit} for update skip locked`,
        list ? [chunk] : workspaceId ? [workspaceId] : [],
      )).rows;
      if (!rows.length) return 0;
      const parts = rows.map(partsRow);
      const col = (k) => parts.map((x) => x[k]);
      const r = await tx.query(
        `update persons p set door_civic = x.c, door_unit = x.u, door_kind = x.k, door_src = x.s
           from unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::text[]) as x(id, c, u, k, s)
          where p.id = x.id and p.door_src is distinct from x.s`,
        [col('id'), col('c'), col('u'), col('k'), col('s')],
      );
      return r.affectedRows ?? rows.length;
    });
    filled += n;
    // ids: every chunk once. Otherwise: until a batch comes back short.
    if (!list && n < limit) break;
    // Let requests in between batches (the embedded database is one connection).
    await new Promise((r) => { setImmediate(r); });
  }
  return { filled };
};

// After a write commits: the people it created or whose address or unit it
// may have changed, worked out at once (not awaited by the write; errors are
// said and the sweeper picks the rows up).
const touched = (e) => e.entityType === 'person' && e.op !== 'void'
  && (e.op === 'create' || ['address', 'unit', 'merged', 'undone'].some((k) => e.payload && k in e.payload));
const watched = new WeakSet();
export const watchDoorWrites = (db) => {
  if (watched.has(db)) return;
  watched.add(db);
  // Read when the server asks for it, so scripts that only need the SQL
  // above (scripts/hr-counts.mjs) load nothing of the server.
  import('./events.js').then(({ onCommitted }) => onCommitted(({ events }) => {
    const ids = [...new Set(events.filter(touched).map((e) => e.entityId))];
    if (!ids.length) return null;
    return fillDoorParts(db, { ids }).catch((e) => console.error(`doors: ${e.message}`));
  }));
};

let timer = null;
let running = false;
export const EVERY_MS = 60_000;
// One sweep: every stale row, every campaign. Returns how many it filled.
export const sweepDoors = async (db) => {
  if (running) return 0;
  running = true;
  try {
    let total = 0;
    for (;;) {
      const { filled } = await fillDoorParts(db, { max: BATCH * 10 });
      total += filled;
      if (filled < BATCH * 10) break;
    }
    return total;
  } finally {
    running = false;
  }
};
// At start (after the server listens): the listener, a first sweep until
// nothing is stale, then one every EVERY_MS (unref'd: it never keeps the
// process up).
export const startDoorSweeper = (db, { everyMs = EVERY_MS } = {}) => {
  watchDoorWrites(db);
  const t0 = Date.now();
  sweepDoors(db).then((n) => {
    if (n) console.log(`doors: ${n} addresses worked out in ${Math.round((Date.now() - t0) / 1000)} s`);
  }, (e) => console.error(`doors: ${e.message}`));
  if (!timer) {
    timer = setInterval(() => { sweepDoors(db).catch((e) => console.error(`doors: ${e.message}`)); }, everyMs);
    timer.unref?.();
  }
};
export const stopDoorSweeper = () => { if (timer) clearInterval(timer); timer = null; };

// The key of a door the anchor's way, for a query's parameters: its civic and unit.
export const doorOfParts = (p) => {
  const d = doorParts({ address: p.address, unit: p.unit });
  return { civic: d.civic, unit: d.unit };
};
