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
// …except a list a volunteer made (by_volunteer — actions.js): its rule
// names who People would show a volunteer, whoever walks, calls or counts
// it. A money tag, the website's money forms, an email, a field kept from
// volunteers match nobody (lib/viewer.js) — or putting their list under a
// sweep or a bank would read those out to them.
const asVolunteer = (ctx) => ({ ...ctx, role: 'volunteer', user: { ...ctx.user, email: '' } });

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
  const eyes = list?.by_volunteer ? asVolunteer(ctx) : ctx;
  const inner = list ? { ...eyes, listTrail: [...(ctx.listTrail || []), list.id] } : ctx;
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

// One page of everyone a list names, in name order, after a person's place
// (after: { key, id } of the last one sent — key is Postgres's own
// lower(name), so the order and the cursor always agree — or null):
// the keyset the Google Sheets export reads a big list by, with no cap.
export const peoplePage = async (db, ctx, { list, after = null, limit = 1000 }) => {
  const w = await whereFor(db, ctx, { list });
  let where = w.where;
  const params = [...w.params];
  if (after) {
    params.push(String(after.key), after.id);
    where += ` and (lower(p.name), p.id) > ($${params.length - 1}::text, $${params.length}::uuid)`;
  }
  params.push(limit);
  const { rows } = await db.query(
    `select p.id, p.name, p.email, p.phone, p.address, p.unit, p.city, p.postal, p.rating, p.tags, p.created_at, lower(p.name) as _key
     from persons p where ${where} order by lower(p.name), p.id limit $${params.length}`,
    params,
  );
  return rows.map((r) => ({ ...r, tags: parseJ(r.tags, []) }));
};
export const peopleCount = async (db, ctx, { list }) => {
  const { where, params } = await whereFor(db, ctx, { list });
  return (await db.query(`select count(*)::int as n from persons p where ${where}`, params)).rows[0].n;
};

// How many a list names; how many emails and texts a send to it would be
// (one per address, one per number); how many people can be called; and how
// many can be reached at all, by any of the three. Each person is read once.
// seq: how far the campaign's books had got when the count read them (the
// same snapshot — $1 is the campaign in every WHERE above).
const countsAt = async (db, ctx, { list = null, filter = null }) => {
  const { where, params } = await whereFor(db, ctx, { list, filter });
  const r = (await db.query(
    `select count(*)::int as total,
       (count(distinct ${emailKey('x.email')}) filter (where x.e))::int as with_email,
       (count(distinct ${last10('x.phone')}) filter (where x.t))::int as with_phone,
       (count(*) filter (where x.c))::int as with_call,
       (count(*) filter (where x.e or x.t or x.c))::int as reachable,
       (select w.event_seq from workspaces w where w.id = $1)::text as seq
     from (select p.email, p.phone, ${REACH.email()} as e, ${REACH.phone()} as t, ${REACH.call()} as c
             from persons p where ${where} offset 0) x`, params,
  )).rows[0];
  return {
    counts: { total: r.total, with_email: r.with_email, with_phone: r.with_phone, with_call: r.with_call, reachable: r.reachable },
    seq: Number(r.seq),
  };
};
export const countsOf = async (db, ctx, opts) => (await countsAt(db, ctx, opts)).counts;

// A list's numbers, kept for a minute (STARBASE_LIST_COUNTS_MS; 0 under the
// test runner): the Lists screen and a send's "To" picker read every list,
// and counting each on every load is slow on a city's voter file. A kept
// count is dropped when the list itself changes (its updated_at: the
// filter, or people put on or taken off), when people change in a way a
// list can read (peopleChanged — ext/lists/index.js says which writes), and,
// for a list that stands on other lists, when any list changes
// (listsChanged). Each change is noted with the place its write takes in
// the campaign's books (the first event it writes): a count that read the
// books before that place missed it, however long the write took to land.
// One list's own page counts now.
const keepMs = () => Number(process.env.STARBASE_LIST_COUNTS_MS ?? (process.env.NODE_TEST_CONTEXT ? 0 : 60_000)) || 0;
const kept = new Map();      // list id → { at, seq, stamp, counts }
const counting = new Map();  // list id + stamp → the count under way ({ counts, seq })
const peopleSeq = new Map(); // campaign → the place in its books of the last change to its people
const listsSeq = new Map();  // campaign → the same, for a change to any of its lists
const stampOf = (list) => String(new Date(list.updated_at).getTime());
const onOtherLists = (list) => list.kind === 'filter' && Boolean(list.filter?.list || list.filter?.notlist);
export const peopleChanged = (ws, seq) => { peopleSeq.set(ws, Math.max(peopleSeq.get(ws) || 0, seq)); };
export const listsChanged = (ws, seq) => { listsSeq.set(ws, Math.max(listsSeq.get(ws) || 0, seq)); };
const missed = (ctx, list, seq) => (peopleSeq.get(ctx.workspaceId) || 0) > seq
  || (onOtherLists(list) && (listsSeq.get(ctx.workspaceId) || 0) > seq);
export const keptCounts = (ctx, list) => {
  const e = kept.get(list.id);
  if (!e || e.stamp !== stampOf(list) || Date.now() - e.at >= keepMs() || missed(ctx, list, e.seq)) return null;
  return e.counts;
};
const countNow = (db, ctx, list) => {
  const stamp = stampOf(list);
  const key = `${list.id}:${stamp}`;
  if (!counting.has(key)) {
    const at = Date.now();
    counting.set(key, countsAt(db, ctx, { list }).then((r) => {
      const e = kept.get(list.id);
      if (!e || e.stamp !== stamp || e.seq <= r.seq) kept.set(list.id, { at, seq: r.seq, stamp, counts: r.counts });
      if (kept.size > 2000) for (const [id, k] of kept) if (Date.now() - k.at > keepMs()) kept.delete(id);
      return r;
    }).finally(() => counting.delete(key)));
  }
  return counting.get(key);
};
export const listCounts = async (db, ctx, list, { fresh = false } = {}) => {
  const hit = fresh ? null : keptCounts(ctx, list);
  if (hit) return hit;
  let r = await countNow(db, ctx, list);
  // A count already under way may have read the books before a change landed: once more.
  if (missed(ctx, list, r.seq)) r = await countNow(db, ctx, list);
  return r.counts;
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
