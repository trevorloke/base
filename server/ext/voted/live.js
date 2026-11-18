// The live feed: who voted, pushed to canvassers within seconds.
//
// After each commit (lib/events.js onCommitted) one listener reads the
// write's events: a person's voted_at, a practice mark, a merge. Each change
// { p: person, v: voted_at | null, f: feed_id, x: practice } goes to the
// campaign's hub, which hands it to every open stream whose scope holds that
// person (the desk, a volunteer given People, and scope 'campaign' get all;
// practice changes only reach the practice group), batched at most once a
// second. One Render instance holds every stream, so no LISTEN/NOTIFY.
//
//   GET /voted/live    (api.js) SSE: event voted (data [{p,v,x}]), event mode
//                      (the caller's new status, on every settings commit;
//                      the stream closes when GOTV is no longer active for
//                      them), event guide ({rev}: the voter guide changed),
//                      ": ping" every 25 s. Holds no database connection:
//                      the scope is read at connect and every 60 s.
//   notifyGuide(ws, rev)    event guide to every stream of the campaign
//   touchVotedFeed(tx, ws, personId)  a merge moved marks onto this person:
//                      their latest mark gets a fresh feed_id, so the
//                      catch-up read (/voted/changes) returns them
//   liveCount(ws)      open streams, for the desk's "Phones live"
//
// The feed's order is commit order: every voted_marks / gotv_practice
// insert (and every feed bump) happens inside runAction under the
// campaign's row lock, held until commit (sql.js).
import { onCommitted } from '../../lib/events.js';
import { getDb } from '../../db/client.js';
import { forgetSettings, forgetPosts, forgetScopes, gotvFor, scopeOf, isDesk, rowOf, onNow } from './state.js';
import { DEFAULT_TZ } from '../../lib/org.js';
import { forgetHours } from './clock.js';
import { forgetCounts, forgetSupporters } from './brief.js';
import { updateTurf, updatePerson, rebuild, hasIndex, turfsOfPerson } from './turfindex.js';
import { decide } from '../../lib/perms.js';
import { forgetSummary, forgetSupporterIds } from './summary.js';

const BATCH_MS = 1_000;
const MAX_BATCH = 500;
const PER_USER = 3;
const SCOPE_MS = 60_000;
export const pingMs = () => Number(process.env.STARBASE_GOTV_PING_MS) || 25_000;

const hubs = new Map(); // ws → Set(sub)
const subsOf = (ws) => { let h = hubs.get(ws); if (!h) { h = new Set(); hubs.set(ws, h); } return h; };
export const liveCount = (ws) => hubs.get(ws)?.size || 0;

export const touchVotedFeed = async (tx, ws, personId) => {
  await tx.query(
    `update voted_marks set feed_id = nextval('voted_feed_seq')
      where id = (select id from voted_marks where workspace_id = $1 and person_id = $2 order by created_at desc, inserted_at desc limit 1)`,
    [ws, personId],
  );
};

// Everything one subscriber needs, none of it a database connection.
// sub = { ctx, all, ids, group, queue: Map(p → {p,v,x}), last, timer, send, close, at, scopeAt }
const flush = (sub) => {
  sub.timer = null;
  if (sub.closed || !sub.queue.size) return;
  const all = [...sub.queue.values()];
  sub.queue.clear();
  for (let i = 0; i < all.length; i += MAX_BATCH) sub.send({ event: 'voted', id: String(sub.last), data: JSON.stringify(all.slice(i, i + MAX_BATCH)) });
};
const offer = (sub, change) => {
  if (sub.closed) return;
  if (change.x && !sub.group) return;
  // In scope: as read at connect, or (someone new since) by the turf
  // index as it stands now.
  if (!sub.all && !sub.ids.has(change.p) && !turfsOfPerson(sub.ctx.workspaceId, change.p).some((t) => sub.turfs?.has(t))) return;
  sub.queue.set(`${change.p}:${change.x ? 1 : 0}`, { p: change.p, v: change.v, x: change.x ? 1 : 0 });
  if (change.f && change.f > sub.last) sub.last = change.f;
  if (!sub.timer) sub.timer = setTimeout(() => flush(sub), BATCH_MS);
};
export const publish = (ws, change) => { for (const sub of hubs.get(ws) || []) offer(sub, change); };

// A stream's scope: everything for the desk, a volunteer given People and
// scope 'campaign'; else their turfs' and phone bank's people.
export const scopeFor = async (db, ctx, g) => {
  const all = isDesk(ctx) || decide(ctx.perms, 'people') === true || g.s.scope === 'campaign';
  if (all) return { all, ids: new Set(), turfs: new Set() };
  const scope = await scopeOf(db, ctx);
  return { all, ids: scope.ids, turfs: scope.turfs };
};

export const subscribe = (ws, sub) => {
  const set = subsOf(ws);
  // At most 3 streams per person: the oldest gives way.
  const mine = [...set].filter((s) => s.ctx.user.id === sub.ctx.user.id).sort((a, b) => a.at - b.at);
  while (mine.length >= PER_USER) mine.shift().close();
  set.add(sub);
  return () => { set.delete(sub); if (!set.size) hubs.delete(ws); };
};

// The 60 s scope refresh, and the status a mode message carries.
export const refreshScope = async (sub) => {
  if (Date.now() - sub.scopeAt < SCOPE_MS) return;
  sub.scopeAt = Date.now();
  const db = await getDb();
  const g = await gotvFor(db, sub.ctx);
  Object.assign(sub, await scopeFor(db, sub.ctx, g), { group: g.group || g.on });
};

export const notifyGuide = (ws, rev) => {
  for (const sub of hubs.get(ws) || []) if (!sub.closed) sub.send({ event: 'guide', data: JSON.stringify({ rev }) });
};

// A settings commit: every stream gets its new status; one no longer active
// is closed after it.
const tellMode = async (ws) => {
  const set = hubs.get(ws);
  if (!set?.size) return;
  const db = await getDb();
  for (const sub of [...set]) {
    try {
      const status = await sub.statusOf(db);
      await sub.send({ event: 'mode', data: JSON.stringify(status) });
      sub.group = status.practice ? status.active : true;
      if (!status.active) sub.close();
    } catch (e) { console.error(`gotv live: ${e.message}`); }
  }
};

const PERSON_PLACE = ['lat', 'lng', 'address', 'house_number', 'merged', 'merged_into'];
const isSettings = (action, ev) => ev.entityType === 'workspace' && ev.op === 'update'
  && (action === 'vote.settings' || action === 'gotv.practice.clear' || action.startsWith('site.guide.'));

onCommitted(async ({ workspaceId: ws, action, events }) => {
  // First, before any await: what the very next request must not read
  // stale (the write's answer goes out as soon as this returns).
  let settings = false;
  let hours = action.startsWith('site.guide.');
  let voted = false;
  for (const ev of events) {
    const p = ev.payload || {};
    if (isSettings(action, ev)) settings = true;
    if (ev.entityType === 'vote_place' || ev.entityType === 'vote_day' || ev.entityType === 'place') hours = true;
    if (ev.entityType === 'gotv_post') forgetPosts(ws);
    if (ev.entityType === 'voted_mark' || ev.entityType === 'gotv_practice' || (ev.entityType === 'person' && 'voted_at' in p)) voted = true;
  }
  // Who is in whose turfs and phone banks: a turf, a bank, a post, or a
  // person added, moved or merged.
  const moved = events.some((e) => e.entityType === 'turf' || (e.entityType === 'person' && (e.op !== 'update' || PERSON_PLACE.some((k) => k in (e.payload || {})))));
  if (moved || action.startsWith('turf.') || action.startsWith('bank.') || events.some((e) => e.entityType === 'gotv_post')) forgetScopes(ws);
  if (voted) { forgetCounts(ws); forgetSummary(ws, false); }
  // A rating changed (a knock, a call, an import, the desk): the supporters.
  if (events.some((e) => e.entityType === 'person' && 'rating' in (e.payload || {})) || events.some((e) => e.entityType === 'contact' && e.payload?.rating)) {
    forgetSupporters(ws); forgetSupporterIds(ws); forgetCounts(ws);
  }
  if (hours) forgetHours(ws);
  if (settings) { forgetSettings(ws); forgetHours(ws); forgetSummary(ws, true); forgetScopes(ws); }

  const db = await getDb();
  const feedOf = new Map(); // person → feed_id, from the marks in this write
  for (const ev of events) if ((ev.entityType === 'voted_mark' || ev.entityType === 'gotv_practice') && ev.payload?.feed_id) feedOf.set(ev.payload.person_id, Number(ev.payload.feed_id));
  for (const ev of events) {
    const p = ev.payload || {};
    if (ev.entityType === 'turf') await updateTurf(db, ws, ev.entityId);
    if (ev.entityType === 'person') {
      if ((ev.op === 'create' || ev.op === 'void' || ev.op === 'merge' || PERSON_PLACE.some((k) => k in p))) await updatePerson(db, ws, ev.entityId);
      if (ev.op === 'update' && 'voted_at' in p) publish(ws, { p: ev.entityId, v: p.voted_at ?? null, f: feedOf.get(ev.entityId) || 0, x: false });
      else if (ev.op === 'update' && 'merged' in p) {
        // A merge: the kept person as they stand now.
        const row = (await db.query('select voted_at from persons where id = $1', [ev.entityId])).rows[0];
        publish(ws, { p: ev.entityId, v: row?.voted_at ? new Date(row.voted_at).toISOString() : null, f: 0, x: false });
      }
    }
    if (ev.entityType === 'gotv_practice' && ev.op === 'create') {
      publish(ws, { p: p.person_id, v: p.voted ? (p.at || new Date().toISOString()) : null, f: Number(p.feed_id) || 0, x: true });
    }
  }
  // A scope read while the index was catching up is dropped once it has.
  if (moved) forgetScopes(ws);
  if (settings) {
    // GOTV or practice just turned on: the turf index is built now, behind.
    const s = await rowOf(db, ws);
    if (hasIndex(ws) || s.practice || onNow(s, DEFAULT_TZ)) rebuild(db, ws).catch((e) => console.error(`turf index: ${e.message}`));
    await tellMode(ws);
  }
  // The voter guide's corrections reach every phone on the stream.
  if (action.startsWith('site.guide.') && hubs.get(ws)?.size) {
    const rev = (await db.query('select rev from vote_guide where workspace_id = $1', [ws])).rows[0]?.rev ?? 0;
    notifyGuide(ws, Number(rev));
  }
});
