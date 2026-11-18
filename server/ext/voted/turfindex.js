// The turf index: who is inside each turf, kept in memory per campaign while
// GOTV is On or Practice. A volunteer's scope (scope.js), the live feed's
// fan-out (live.js) and the summary's turf numbers (api.js) read it instead
// of loading every located person on every request.
//
//   turfId → Set(personId)   and   personId → [turfId]
//
// It never blocks the server: a build reads each turf's bounding box on
// persons_ws_geo_idx and runs pointInPolygon in slices of 5,000 points with
// a setImmediate between them, then swaps the new index in with one
// assignment (readers use the old one until then). Kept up to date in small
// steps from live.js after each commit (a turf event rebuilds that turf; a
// person's create, locate, move, delete or merge updates that person), with
// a full sliced rebuild when GOTV or practice turns on, at the first read
// after a start, and once an hour as a safety net.
import { pointInPolygon } from '../../lib/geo.js';

const SLICE = 5_000;
const REBUILD_MS = 60 * 60_000;
const parseJ = (v, d) => { try { return typeof v === 'string' ? JSON.parse(v) : (v ?? d); } catch { return d; } };
const yieldNow = () => new Promise((r) => setImmediate(r));

const indexes = new Map(); // ws → { turfs: Map(turfId → { ring, box, ids:Set }), byPerson: Map(personId → turfIds[]), at }
const building = new Map(); // ws → Promise
const missed = new Map(); // ws → { persons: Set, turfs: Set } — changes during a build
const note = (ws, kind, id) => {
  if (!building.has(ws)) return false;
  if (!missed.has(ws)) missed.set(ws, { persons: new Set(), turfs: new Set() });
  missed.get(ws)[kind].add(id);
  return true;
};

const boxOf = (ring) => {
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
  for (const [lat, lng] of ring) { s = Math.min(s, lat); n = Math.max(n, lat); w = Math.min(w, lng); e = Math.max(e, lng); }
  return { s, w, n, e };
};
const ringOf = (polygon) => {
  const p = parseJ(polygon, []);
  return Array.isArray(p) ? p.filter((pt) => Array.isArray(pt) && pt.length >= 2 && Number.isFinite(+pt[0]) && Number.isFinite(+pt[1])).map(([a, b]) => [+a, +b]) : [];
};

// One turf's people: its box from the geo index, then the polygon, sliced.
const turfPeople = async (db, ws, ring) => {
  const ids = new Set();
  if (ring.length < 3) return ids;
  const b = boxOf(ring);
  const rows = (await db.query(
    `select id, lat, lng from persons where workspace_id = $1 and deleted_at is null and lat is not null
       and lat between $2 and $3 and lng between $4 and $5`,
    [ws, b.s, b.n, b.w, b.e],
  )).rows;
  for (let i = 0; i < rows.length; i += SLICE) {
    const end = Math.min(rows.length, i + SLICE);
    for (let k = i; k < end; k += 1) {
      const r = rows[k];
      if (pointInPolygon(Number(r.lat), Number(r.lng), ring)) ids.add(r.id);
    }
    if (end < rows.length) await yieldNow();
  }
  return ids;
};

const reverse = (turfs) => {
  const byPerson = new Map();
  for (const [tid, t] of turfs) for (const pid of t.ids) {
    const list = byPerson.get(pid);
    if (list) list.push(tid); else byPerson.set(pid, [tid]);
  }
  return byPerson;
};

// A full build, swapped in when done. Concurrent asks share one build.
export const rebuild = (db, ws) => {
  if (building.has(ws)) return building.get(ws);
  const job = (async () => {
    const turfs = new Map();
    const rows = (await db.query('select id, polygon from turfs where workspace_id = $1 and deleted_at is null', [ws])).rows;
    for (const t of rows) {
      const ring = ringOf(t.polygon);
      turfs.set(t.id, { ring, box: ring.length ? boxOf(ring) : null, ids: await turfPeople(db, ws, ring) });
      await yieldNow();
    }
    const idx = { turfs, byPerson: reverse(turfs), at: Date.now() };
    indexes.set(ws, idx);
    // What changed while it was being read (a person added, a turf redrawn)
    // is applied now, so nothing is lost to the build.
    const late = missed.get(ws);
    missed.delete(ws);
    building.delete(ws);
    for (const t of late?.turfs || []) await updateTurf(db, ws, t);
    for (const pid of late?.persons || []) await updatePerson(db, ws, pid);
    return idx;
  })().finally(() => building.delete(ws));
  building.set(ws, job);
  return job;
};

// The index, built at the first ask (that one request waits; later ones
// never do: an hourly rebuild runs behind the old index).
export const turfIndex = async (db, ws) => {
  const idx = indexes.get(ws);
  if (!idx) return rebuild(db, ws);
  if (Date.now() - idx.at > REBUILD_MS && !building.has(ws)) rebuild(db, ws).catch((e) => console.error(`turf index: ${e.message}`));
  return idx;
};
export const hasIndex = (ws) => indexes.has(ws);
export const dropIndex = (ws) => { indexes.delete(ws); };

// One turf drawn, redrawn or removed: only that turf is read again.
export const updateTurf = async (db, ws, turfId) => {
  if (note(ws, 'turfs', turfId)) return;
  const idx = indexes.get(ws);
  if (!idx) return;
  const t = (await db.query('select polygon from turfs where id = $1 and workspace_id = $2 and deleted_at is null', [turfId, ws])).rows[0];
  const turfs = new Map(idx.turfs);
  if (t) {
    const ring = ringOf(t.polygon);
    turfs.set(turfId, { ring, box: ring.length ? boxOf(ring) : null, ids: await turfPeople(db, ws, ring) });
  } else turfs.delete(turfId);
  indexes.set(ws, { turfs, byPerson: reverse(turfs), at: idx.at });
};

// One person added, moved, located, removed or merged away: their entries.
export const updatePerson = async (db, ws, personId) => {
  if (note(ws, 'persons', personId)) return;
  const idx = indexes.get(ws);
  if (!idx) return;
  const p = (await db.query(
    'select lat, lng from persons where id = $1 and workspace_id = $2 and deleted_at is null and lat is not null and lng is not null', [personId, ws],
  )).rows[0];
  const now = [];
  for (const [tid, t] of idx.turfs) {
    const inside = Boolean(p && t.box && p.lat >= t.box.s && p.lat <= t.box.n && p.lng >= t.box.w && p.lng <= t.box.e
      && pointInPolygon(Number(p.lat), Number(p.lng), t.ring));
    if (inside) { t.ids.add(personId); now.push(tid); } else t.ids.delete(personId);
  }
  if (now.length) idx.byPerson.set(personId, now); else idx.byPerson.delete(personId);
};

// One turf's people read now, outside the index (a turf drawn a moment
// ago, while the index catches up).
export const peopleInTurf = async (db, ws, turfId) => {
  const t = (await db.query('select polygon from turfs where id = $1 and workspace_id = $2 and deleted_at is null', [turfId, ws])).rows[0];
  return t ? turfPeople(db, ws, ringOf(t.polygon)) : new Set();
};

export const turfsOfPerson = (ws, personId) => indexes.get(ws)?.byPerson.get(personId) || [];
