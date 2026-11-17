// The desk's Today counts the whole list: everyone on file and how they are
// rated (the Supporters number, the support picture, "In all: N people"),
// and GOTV's numbers (ext/voted). At 300,000 people each count is 60–120 ms,
// on every visit by every desk member. They are kept per campaign for half
// a minute and shared, so a desk reloading Today counts nothing over the
// list (MAP's 300K check).
//
// A write to a person or a contact (a new person, an import, a rating, a
// knock, a mark, the sample) drops the kept counts, so whoever made it sees
// it on their next Today. The drop runs inside the write's transaction, just
// before it commits; a count that starts in the few seconds after a drop is
// used but not kept, since it may have read the list before that write
// committed. So a kept count is at most half a minute old, and never older
// than the last write a reader could have seen.
//
//   deskList(db, ws)  { total, ratings: [{ rating, n }] } — one count, kept
//   keptCount(ws, name, count)  any other whole-list count, kept the same way
//   hooks.events      drops the kept counts (these and GOTV's) on a write
import { forgetCounts } from '../voted/brief.js';

const KEEP_MS = 30_000;
const SETTLE_MS = 10_000;
const kept = new Map(); // workspace id → Map(name → { at, value })
const dropped = new Map(); // workspace id → when the last write dropped them

export const forgetList = (ws) => { kept.delete(ws); dropped.set(ws, Date.now()); };

// One whole-list count, by name, kept for this campaign (MOVED's count of
// Needs an address uses it too: ext/moves).
export const keptCount = async (ws, name, count) => {
  const hit = kept.get(ws)?.get(name);
  if (hit && Date.now() - hit.at < KEEP_MS) return hit.value;
  const at = Date.now();
  const value = await count();
  if (at - (dropped.get(ws) || 0) >= SETTLE_MS) {
    if (!kept.has(ws)) kept.set(ws, new Map());
    kept.get(ws).set(name, { at, value });
  }
  return value;
};

// Everyone on file, by rating (null: not rated), in one pass.
export const deskList = (db, ws) => keptCount(ws, 'list', async () => {
  const rows = (await db.query(
    `select rating, count(*)::int as n from persons
     where workspace_id = $1 and deleted_at is null group by rating`, [ws],
  )).rows;
  return { total: rows.reduce((s, r) => s + r.n, 0), ratings: rows.filter((r) => r.rating != null) };
});

const LIST_WRITE = /^(import\.|sample\.)/;
const dropOnWrite = async (tx, meta, events) => {
  if (LIST_WRITE.test(String(meta.action || '')) || events.some((e) => e.entityType === 'person' || e.entityType === 'contact')) {
    forgetList(meta.workspaceId);
    forgetCounts(meta.workspaceId);
  }
};

export const hooks = { events: dropOnWrite };
