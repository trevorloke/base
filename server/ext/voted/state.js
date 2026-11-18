// GOTV's state for one request: the campaign's settings (kept 5 s, dropped
// on every settings commit by live.js), the caller's post, and what follows
// for them — whether GOTV is active for them, whether practice overlays
// their reads, whether their voted reads are kept to their turfs and phone
// banks — plus the scope itself and votedCol, the one column expression
// every field read of voted_at uses.
//
//   rowOf(db, ws)        the settings row, normalized (all defaults filled)
//   postOf(db, ws, uid)  the open post or null (kept 5 s; posts drop it)
//   gotvFor(db, ctx)     { s, on, practice, post, group, active, overlay, limited }
//   scopeOf(db, ctx)     { ids:Set, turfs:Set, bank:Set } — kept 60 s per user
//   votedCol(g, a)       `${a}.voted_at`, or with practice marks over it
import { decide } from '../../lib/perms.js';
import { loginEmail } from '../../lib/viewer.js';
import { localDay } from '../../lib/tzrule.js';
import { now } from '../../lib/clock.js';
import { turfIndex } from './turfindex.js';
import { tzOf } from './clock.js';

const DESK = ['manager', 'treasurer', 'staff'];
export const isDesk = (ctx) => DESK.includes(ctx?.role);
const parseJ = (v, d) => { try { return typeof v === 'string' ? JSON.parse(v) : (v ?? d); } catch { return d; } };
const dateOnly = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : null);

const KEEP_MS = 5_000;
const rows = new Map(); // ws → { at, row }
const posts = new Map(); // `${ws}:${uid}` → { at, post }
const scopes = new Map(); // `${ws}:${uid}` → { at, scope }
export const forgetSettings = (ws) => { rows.delete(ws); };
export const forgetPosts = (ws) => { for (const k of posts.keys()) if (k.startsWith(`${ws}:`)) posts.delete(k); };
export const forgetScopes = (ws) => { for (const k of scopes.keys()) if (!ws || k.startsWith(`${ws}:`)) scopes.delete(k); };

export const rowOf = async (db, ws) => {
  const hit = rows.get(ws);
  if (hit && Date.now() - hit.at < KEEP_MS) return hit.row;
  const r = (await db.query('select * from voted_settings where workspace_id = $1', [ws])).rows[0] || {};
  const row = {
    exists: Boolean(r.workspace_id),
    on_day: Boolean(r.on_day),
    election_day: dateOnly(r.election_day),
    advance_days: [...new Set(parseJ(r.advance_days, []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort(),
    auto: r.workspace_id ? r.auto !== false : true,
    practice: Boolean(r.practice),
    practice_users: (Array.isArray(r.practice_users) ? r.practice_users : parseJ(String(r.practice_users || '').replace(/^\{(.*)\}$/, '[$1]').replace(/([0-9a-f-]{36})/g, '"$1"'), [])).map(String),
    send: r.send === 'live' ? 'live' : 'after_close',
    close_override: parseJ(r.close_override, {}) || {},
    released: parseJ(r.released, []) || [],
    ceo_answer: parseJ(r.ceo_answer, null),
    scope: r.scope === 'campaign' ? 'campaign' : 'turfs',
    ready: parseJ(r.ready, {}) || {},
  };
  rows.set(ws, { at: Date.now(), row });
  return row;
};

export const postOf = async (db, ws, uid) => {
  if (!uid) return null;
  const k = `${ws}:${uid}`;
  const hit = posts.get(k);
  if (hit && Date.now() - hit.at < KEEP_MS) return hit.post;
  const r = (await db.query(
    `select g.id, g.role, g.place_id, g.days, g.appointed, g.created_at, p.name as place_name
       from gotv_posts g left join places p on p.id = g.place_id
      where g.workspace_id = $1 and g.user_id = $2 and g.ended_at is null`, [ws, uid],
  )).rows[0];
  const post = r ? { id: r.id, role: r.role, place_id: r.place_id, place_name: r.place_name || null, days: parseJ(r.days, []), appointed: r.appointed, created_at: r.created_at } : null;
  posts.set(k, { at: Date.now(), post });
  return post;
};

// GOTV on for everyone: by hand, or by itself on a voting day.
export const onNow = (s, tz) => {
  const day = localDay(now(), tz);
  const voting = day === s.election_day || s.advance_days.includes(day);
  return s.on_day || (s.auto && voting);
};

export const gotvFor = async (db, ctx) => {
  const ws = ctx.workspaceId;
  const s = await rowOf(db, ws);
  const on = onNow(s, tzOf(ctx));
  const practice = s.practice && !on;
  const post = await postOf(db, ws, ctx.user?.id);
  const group = practice && Boolean(post || s.practice_users.includes(ctx.user?.id));
  const active = on || group;
  // A volunteer without the People area sees who voted only in their turfs
  // and phone banks while GOTV is active for them (scope 'turfs').
  const limited = active && s.scope === 'turfs' && ctx.role === 'volunteer' && decide(ctx.perms, 'people') !== true;
  return { s, on, practice, post, group, active, overlay: group, limited };
};

// The people a limited volunteer may see voted: inside their turfs (the turf
// index), the numbers assigned to them in a phone bank (not done), and
// their own record.
const SCOPE_MS = 60_000;
export const scopeOf = async (db, ctx) => {
  const ws = ctx.workspaceId;
  const uid = ctx.user.id;
  const k = `${ws}:${uid}`;
  const hit = scopes.get(k);
  if (hit && Date.now() - hit.at < SCOPE_MS) return hit.scope;
  const turfs = new Set((await db.query('select turf_id from turf_members where workspace_id = $1 and user_id = $2', [ws, uid])).rows.map((r) => r.turf_id));
  const ids = new Set();
  if (turfs.size) {
    const idx = await turfIndex(db, ws);
    for (const t of turfs) for (const id of idx.turfs.get(t)?.ids || []) ids.add(id);
  }
  const bank = new Set((await db.query(
    'select person_id from call_bank_numbers where workspace_id = $1 and assigned_to = $2 and done_at is null', [ws, uid],
  )).rows.map((r) => r.person_id));
  for (const id of bank) ids.add(id);
  const email = loginEmail(ctx);
  if (email) for (const r of (await db.query('select id from persons where workspace_id = $1 and lower(email) = $2 and deleted_at is null', [ws, email])).rows) ids.add(r.id);
  const scope = { ids, turfs, bank };
  scopes.set(k, { at: Date.now(), scope });
  return scope;
};

// The voted_at a field read carries: the plain column, or — for a user in
// the practice group while practice runs — the latest practice mark over it.
export const votedCol = (g, a = 'p') => (g?.overlay
  ? `coalesce(${a}.voted_at, (select case when gp.voted then gp.created_at end from gotv_practice gp where gp.workspace_id = ${a}.workspace_id and gp.person_id = ${a}.id order by gp.feed_id desc limit 1))`
  : `${a}.voted_at`);

// Scrutineer-only: an open post, and no turf and no undone bank numbers —
// nothing to receive on the live feed.
export const scrutineerOnly = async (db, ctx, g) => {
  if (!g.post) return false;
  const ws = ctx.workspaceId;
  const uid = ctx.user.id;
  const t = (await db.query('select 1 from turf_members where workspace_id = $1 and user_id = $2 limit 1', [ws, uid])).rows[0];
  if (t) return false;
  const b = (await db.query('select 1 from call_bank_numbers where workspace_id = $1 and assigned_to = $2 and done_at is null limit 1', [ws, uid])).rows[0];
  return !b;
};
