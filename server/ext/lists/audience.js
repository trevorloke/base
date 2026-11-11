// Who is on a list, and who of them can be reached. One WHERE for a saved
// filter (lib/audience.js personsWhere) or the members of a hand-picked
// list, then the reach — who may be emailed, texted or called is decided in
// one place (lib/reach.js), the same for a list's numbers, a send's
// recipients and a phone bank: 'email' one row per address, 'phone' (a
// text) one row per number, 'call' everyone with a number.
import { personsWhere, joinWhere } from '../../lib/audience.js';
import { mayReach, person, emailKey, last10 } from '../../lib/reach.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const parseJ = (v, d) => { try { return typeof v === 'string' ? JSON.parse(v) : (v ?? d); } catch { return d; } };

export const loadList = async (db, ws, id) => {
  if (!UUID.test(String(id || ''))) return null;
  const row = (await db.query('select * from lists where id = $1 and workspace_id = $2 and deleted_at is null', [id, ws])).rows[0];
  return row ? { ...row, filter: parseJ(row.filter, {}) } : null;
};

// A list is the desk's: who it names never depends on who is looking. A
// volunteer's call list or walk list narrowed by one reads it as the desk does.
export const asDesk = (ctx) => (ctx.role === 'volunteer' ? { ...ctx, role: 'staff' } : ctx);

// The WHERE (alias p) and params for a list, or for a filter on its own.
// ctx.listTrail: the lists being read on the way here ("is on another
// list" — ext/lists/index.js), so a list that names itself ends.
export const whereFor = async (db, ctx, { list = null, filter = null }) => {
  if (list && list.kind === 'people') {
    return {
      where: 'p.workspace_id = $1 and p.deleted_at is null and exists (select 1 from list_members m where m.list_id = $2 and m.person_id = p.id)',
      params: [ctx.workspaceId, list.id],
    };
  }
  const inner = list ? { ...ctx, listTrail: [...(ctx.listTrail || []), list.id] } : ctx;
  const { where, params } = await personsWhere(db, inner, list ? list.filter : (filter || {}));
  params[3] = 100000;
  return { where, params };
};

// "This person (alias p) is on the list, as things stand" — SQL for inside
// another query over persons p; its params are added to `params`.
export const onListSql = async (db, ctx, list, params) => `(${joinWhere(params, await whereFor(db, asDesk(ctx), { list }))})`;

// $1 is the campaign in every WHERE above. Asked for as each query is
// written, so the one place's answer is always today's.
const P = person('p', '$1');
const REACH = {
  email: () => mayReach('email', 'list', P),
  phone: () => mayReach('text', 'list', P),
  call: () => mayReach('call', 'bank', P),
};
export const REACHES = Object.keys(REACH);

// Everyone a list names (the people rows), or only those with the reach.
export const peopleOf = async (db, ctx, { list = null, filter = null, reach = null, limit = 100000, offset = 0, q = '' }) => {
  const w = await whereFor(db, ctx, { list, filter });
  let where = w.where;
  const params = [...w.params];
  if (q) { params.push(`%${q.replace(/[%_\\]/g, (m) => '\\' + m)}%`); where += ` and (p.name ilike $${params.length} or p.email ilike $${params.length} or p.phone ilike $${params.length})`; }
  if (reach) where += ` and ${REACH[reach]()}`;
  params.push(limit, offset);
  const { rows } = await db.query(
    `select p.id, p.name, p.email, p.phone, p.address, p.unit, p.city, p.postal, p.rating, p.tags, p.created_at, count(*) over()::int as total
     from persons p where ${where} order by lower(p.name), p.id limit $${params.length - 1} offset $${params.length}`,
    params,
  );
  return { people: rows.map((r) => ({ ...r, tags: parseJ(r.tags, []) })), total: rows[0]?.total ?? 0 };
};

// How many a list names; how many emails and texts a send to it would be
// (one per address, one per number); how many people can be called; and how
// many can be reached at all, by any of the three. Each person is read once.
export const countsOf = async (db, ctx, { list = null, filter = null }) => {
  const { where, params } = await whereFor(db, ctx, { list, filter });
  const r = (await db.query(
    `select count(*)::int as total,
       (count(distinct ${emailKey('x.email')}) filter (where x.e))::int as with_email,
       (count(distinct ${last10('x.phone')}) filter (where x.t))::int as with_phone,
       (count(*) filter (where x.c))::int as with_call,
       (count(*) filter (where x.e or x.t or x.c))::int as reachable
     from (select p.email, p.phone, ${REACH.email()} as e, ${REACH.phone()} as t, ${REACH.call()} as c
             from persons p where ${where} offset 0) x`, params,
  )).rows[0];
  return { total: r.total, with_email: r.with_email, with_phone: r.with_phone, with_call: r.with_call, reachable: r.reachable };
};

// A list's numbers, kept for a minute (STARBASE_LIST_COUNTS_MS; 0 under the
// test runner): the Lists screen and a send's "To" picker read every list,
// and counting each on every load is slow on a city's voter file. A kept
// count is dropped when the list itself changes (its updated_at: the
// filter, or people put on or taken off) and when many people change at
// once (peopleChanged: an import, a merge). One list's own page counts now.
const keepMs = () => Number(process.env.STARBASE_LIST_COUNTS_MS ?? (process.env.NODE_TEST_CONTEXT ? 0 : 60_000)) || 0;
const SETTLE_MS = 5000; // a change is noted before its write commits
const kept = new Map();      // list id → { at, stamp, counts }
const counting = new Map();  // list id + stamp → the count under way
const changedAt = new Map(); // campaign → when its people last changed in bulk
const stampOf = (list) => String(new Date(list.updated_at).getTime());
export const peopleChanged = (ws) => { changedAt.set(ws, Date.now()); };
export const keptCounts = (ctx, list) => {
  const e = kept.get(list.id);
  if (!e || e.stamp !== stampOf(list) || Date.now() - e.at >= keepMs()) return null;
  const changed = changedAt.get(ctx.workspaceId);
  return changed && e.at < changed + SETTLE_MS ? null : e.counts;
};
export const listCounts = (db, ctx, list, { fresh = false } = {}) => {
  const hit = fresh ? null : keptCounts(ctx, list);
  if (hit) return Promise.resolve(hit);
  const key = `${list.id}:${stampOf(list)}`;
  if (!counting.has(key)) {
    counting.set(key, countsOf(db, ctx, { list }).then((counts) => {
      kept.set(list.id, { at: Date.now(), stamp: stampOf(list), counts });
      if (kept.size > 2000) for (const [id, e] of kept) if (Date.now() - e.at > keepMs()) kept.delete(id);
      return counts;
    }).finally(() => counting.delete(key)));
  }
  return counting.get(key);
};

// The recipients of a send: one per address or number, the first person
// (by name) to carry it.
export const recipientsOf = async (db, ctx, { list = null, filter = null, reach }) => {
  const { where, params } = await whereFor(db, ctx, { list, filter });
  const key = reach === 'email' ? emailKey('p.email') : last10('p.phone');
  const { rows } = await db.query(
    `select distinct on (${key}) p.id, p.name, p.email, p.phone
     from persons p where ${where} and ${REACH[reach]()}
     order by ${key}, lower(p.name), p.id`,
    params,
  );
  return rows;
};

// An audience as a send names it: { list_id } or { filter }.
export const audienceOf = async (db, ctx, audience) => {
  if (audience?.list_id) {
    const list = await loadList(db, ctx.workspaceId, audience.list_id);
    if (!list) return null;
    return { list, filter: null, name: list.name };
  }
  return { list: null, filter: audience?.filter || {}, name: null };
};
