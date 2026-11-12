// GET /banks            desk: every phone bank with its counts and who has what
// GET /banks/mine       anyone: the banks with numbers handed to me, how many are left
// GET /banks/:id        desk: one bank — its counts, who has what, and its numbers
//                       (?limit, ?offset: 2,000 at a time), each done or not, still to call or not
// GET /banks/:id/mine   anyone: my numbers in this bank that are left, as people (the Calls screen's list) —
//                       the first 500 to call now; bank.left says how many in all
// A call-time bank (candidate_id: ext/candidates) is the desk's to see as
// "Call time · <name>", and its candidate's to work on /call-time alone:
// it is never on anyone's /banks/mine.
// "Left" and "still to call" are as things stand (numbers.js): someone who
// can no longer be called — or, in a bank made from a list, has left the
// list — is off the caller's list and out of their count at once.
import { Hono } from 'hono';
import { forViewer } from '../../lib/viewer.js';
import { bankCounts, callersOf, stillOn } from './numbers.js';

export const api = new Hono();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const parseJ = (v, d) => { try { return typeof v === 'string' ? JSON.parse(v) : (v ?? d); } catch { return d; } };
const isDesk = (ctx) => ctx.role !== 'volunteer';
// The list of banks reads the numbers as stored — one quick read for all of
// them — and then, for an open bank made from a list, as things stand (the
// same numbers as its own page: someone who left the list isn't to call).
const COUNTS = `count(n.person_id)::int as total, count(n.assigned_to)::int as assigned, count(n.done_at)::int as done,
  count(*) filter (where n.assigned_to is null and n.done_at is null)::int as open`;
const NUMBERS_PAGE = 2000;
// A caller's list comes this many at a time: enough for a long sitting, light enough for a phone to keep.
const MINE_PAGE = 500;

api.get('/banks', async (c) => {
  const ctx = c.get('ctx'); const db = c.get('db'); const ws = ctx.workspaceId;
  if (!isDesk(ctx)) return c.json({ error: 'desk only' }, 403);
  const banks = (await db.query(
    `select b.id, b.name, b.script, b.created_at, b.closed_at, b.list_id, l.name as list_name, u.name as created_by,
            b.candidate_id, b.ask_cents, cd.name as candidate_name, ${COUNTS}
       from call_banks b left join users u on u.id = b.created_by left join call_bank_numbers n on n.bank_id = b.id
       left join lists l on l.id = b.list_id and l.deleted_at is null
       left join candidates cd on cd.id = b.candidate_id
      where b.workspace_id = $1 and b.deleted_at is null group by b.id, u.name, l.name, cd.name order by b.closed_at nulls first, b.created_at desc`, [ws],
  )).rows;
  const callers = (await db.query(
    `select n.bank_id, n.assigned_to as user_id, u.name, count(*)::int as total, count(n.done_at)::int as done
       from call_bank_numbers n join users u on u.id = n.assigned_to where n.workspace_id = $1 and n.assigned_to is not null
      group by n.bank_id, n.assigned_to, u.name order by lower(u.name)`, [ws],
  )).rows;
  const out = [];
  for (const b of banks) {
    const row = { ...b, closed: !!b.closed_at, callers: callers.filter((x) => x.bank_id === b.id).map(({ bank_id, ...x }) => x) };
    if (b.list_id && !b.closed_at) Object.assign(row, await bankCounts(db, ctx, b), { callers: await callersOf(db, ctx, b) });
    out.push(row);
  }
  return c.json({ banks: out });
});

// My numbers in one bank: how many in all (done, or still to call) and how many done.
const mineIn = async (db, ctx, bank) => {
  const params = [bank.id, ctx.user.id];
  const still = await stillOn(db, ctx, bank, params);
  return (await db.query(
    `select (count(*) filter (where n.done_at is not null or ${still}))::int as total, count(n.done_at)::int as done
       from call_bank_numbers n join persons p on p.id = n.person_id
      where n.bank_id = $1 and n.assigned_to = $2`, params,
  )).rows[0];
};

api.get('/banks/mine', async (c) => {
  const ctx = c.get('ctx'); const db = c.get('db');
  const banks = (await db.query(
    `select b.id, b.name, b.script, b.list_id from call_banks b
      where b.workspace_id = $1 and b.deleted_at is null and b.closed_at is null and b.candidate_id is null
        and exists (select 1 from call_bank_numbers n where n.bank_id = b.id and n.assigned_to = $2)
      order by b.created_at desc`, [ctx.workspaceId, ctx.user.id],
  )).rows;
  const out = [];
  for (const { list_id: listId, ...b } of banks) {
    const n = await mineIn(db, ctx, { id: b.id, list_id: listId });
    out.push({ ...b, total: n.total, done: n.done, left: n.total - n.done });
  }
  return c.json({ banks: out });
});

api.get('/banks/:id', async (c) => {
  const ctx = c.get('ctx'); const db = c.get('db'); const ws = ctx.workspaceId;
  const id = c.req.param('id');
  if (!UUID.test(id)) return c.json({ error: 'not found' }, 404);
  if (!isDesk(ctx)) return c.json({ error: 'desk only' }, 403);
  const b = (await db.query(
    `select b.*, l.name as list_name, cd.name as candidate_name from call_banks b
       left join lists l on l.id = b.list_id and l.deleted_at is null left join candidates cd on cd.id = b.candidate_id
      where b.id = $1 and b.workspace_id = $2 and b.deleted_at is null`, [id, ws],
  )).rows[0];
  if (!b) return c.json({ error: 'not found' }, 404);
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || NUMBERS_PAGE, 1), NUMBERS_PAGE);
  const offset = Math.max(Number(c.req.query('offset')) || 0, 0);
  const counts = await bankCounts(db, ctx, b);
  const params = [id];
  const still = await stillOn(db, ctx, b, params);
  const page = [...params, limit, offset];
  const numbers = (await db.query(
    `select n.person_id, n.position, n.assigned_to, n.assigned_at, n.done_at, n.outcome, n.tries, n.next_at, u.name as caller,
            p.name, p.phone, p.rating, p.address, p.city, ${still} as still
       from call_bank_numbers n join persons p on p.id = n.person_id left join users u on u.id = n.assigned_to
      where n.bank_id = $1 order by n.position, n.person_id limit $${page.length - 1} offset $${page.length}`, page,
  )).rows.map((n) => ({ ...n, still: !!n.still }));
  // Who has what: a caller's total is what they have done and what is still theirs to call.
  const callers = await callersOf(db, ctx, b);
  const { deleted_at: _gone, ...bank } = b;
  return c.json({ bank: { ...bank, ...counts, closed: !!b.closed_at, callers }, numbers, limit, offset });
});

api.get('/banks/:id/mine', async (c) => {
  const ctx = c.get('ctx'); const db = c.get('db'); const ws = ctx.workspaceId;
  const id = c.req.param('id');
  if (!UUID.test(id)) return c.json({ error: 'not found' }, 404);
  const b = (await db.query('select id, name, script, closed_at, retry_hours, max_tries, list_id from call_banks where id = $1 and workspace_id = $2 and deleted_at is null and candidate_id is null', [id, ws])).rows[0];
  if (!b) return c.json({ error: 'not found' }, 404);
  const params = [id, ctx.user.id];
  const still = await stillOn(db, ctx, b, params);
  // Done numbers stay in the count; one not done counts only while it is
  // still to call. A number to call back is counted under "later", with the
  // soonest time, until its time has come.
  const due = '(n.next_at is null or n.next_at <= now())';
  const n = (await db.query(
    `select (count(*) filter (where n.done_at is not null or x.still))::int as total, count(n.done_at)::int as done,
            (count(*) filter (where n.done_at is null and x.still and ${due}))::int as left,
            (count(*) filter (where n.done_at is null and x.still and not ${due}))::int as later,
            min(n.next_at) filter (where n.done_at is null and x.still and not ${due}) as next_at
       from call_bank_numbers n join persons p on p.id = n.person_id
       cross join lateral (select ${still} as still) x
      where n.bank_id = $1 and n.assigned_to = $2`, params,
  )).rows[0];
  // The people to call now, in the bank's order: the first MINE_PAGE of
  // them. Each call logged crosses one off, and the next comes in behind.
  const rows = (await db.query(
    `select p.id, p.name, p.email, p.phone, p.address, p.house_number, p.unit, p.city, p.postal, p.lat, p.lng, p.tags, p.socials, p.rating, p.rated_at, p.voted_at,
            p.attrs->>'note' as note, n.tries
       from call_bank_numbers n join persons p on p.id = n.person_id
      where n.bank_id = $1 and n.assigned_to = $2 and n.done_at is null and ${due} and ${still}
      order by n.position, p.id limit ${MINE_PAGE}`, params,
  )).rows;
  const persons = rows.map((p) => ({ ...p, tags: parseJ(p.tags, []), socials: parseJ(p.socials, {}) })).map(forViewer(ctx));
  return c.json({
    bank: {
      id: b.id, name: b.name, script: b.script, closed: !!b.closed_at, total: n.total, done: n.done, left: n.left,
      later: n.later, next_at: n.next_at ? new Date(n.next_at).toISOString() : null, retry_hours: b.retry_hours, max_tries: b.max_tries,
    },
    persons,
  });
});
