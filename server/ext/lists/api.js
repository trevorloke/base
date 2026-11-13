// GET /lists                      every list with its numbers: how many it names; how many can be
//                                 emailed, texted and called; how many can be reached at all
// GET /lists?counts=later         the names at once — each list's numbers only where they are still
//                                 kept from the last minute (counts: null otherwise; ask /lists/:id/counts)
// GET /lists/:id/counts           one list's numbers, kept for a minute (?fresh=1: counted now)
// GET /lists/preview?tag=…        the counts for a filter not yet saved (People's own query keys)
// GET /lists/tags                 the campaign's tags with how many carry each
// GET /lists/:id                  one list: its people (?q, ?limit, ?offset, ?reach) and counts, counted now
// GET /lists/:id/export.csv       the list as a spreadsheet
// All desk (people area); volunteers are refused.
import { Hono } from 'hono';
import { csvResponse } from '../../lib/csv.js';
import { cleanFilter } from '../../lib/audience.js';
import { countsOf, keptCounts, listCounts, loadList, parseJ, peopleOf, REACHES } from './audience.js';
import { listRows } from './rows.js';

export const api = new Hono();
const DESK = ['manager', 'treasurer', 'staff'];
const refuse = (c) => c.json({ error: 'desk only' }, 403);
// by_volunteer: a volunteer made it — its rule is read with a volunteer's eyes (audience.js).
const listOut = (l) => ({ id: l.id, name: l.name, kind: l.kind, filter: parseJ(l.filter, {}), note: l.note, by_volunteer: !!l.by_volunteer, created_at: l.created_at, updated_at: l.updated_at });

api.get('/lists', async (c) => {
  const ctx = c.get('ctx'); const db = c.get('db');
  if (!DESK.includes(ctx.role)) return refuse(c);
  const later = c.req.query('counts') === 'later';
  const rows = (await db.query('select * from lists where workspace_id = $1 and deleted_at is null order by lower(name)', [ctx.workspaceId])).rows;
  const lists = [];
  for (const l of rows) {
    const list = { ...l, filter: parseJ(l.filter, {}) };
    lists.push({ ...listOut(list), counts: later ? keptCounts(ctx, list) : await listCounts(db, ctx, list) });
  }
  return c.json({ lists });
});

api.get('/lists/preview', async (c) => {
  const ctx = c.get('ctx');
  if (!DESK.includes(ctx.role)) return refuse(c);
  const filter = cleanFilter(c.req.query());
  return c.json({ filter, counts: await countsOf(c.get('db'), ctx, { filter }) });
});

api.get('/lists/tags', async (c) => {
  const ctx = c.get('ctx');
  if (!DESK.includes(ctx.role)) return refuse(c);
  const { rows } = await c.get('db').query(
    `select t.tag, count(*)::int as n from persons p, jsonb_array_elements_text(p.tags) t(tag)
     where p.workspace_id = $1 and p.deleted_at is null group by t.tag order by n desc, t.tag limit 200`, [ctx.workspaceId],
  );
  return c.json({ tags: rows });
});

api.get('/lists/:id/counts', async (c) => {
  const ctx = c.get('ctx'); const db = c.get('db');
  if (!DESK.includes(ctx.role)) return refuse(c);
  const list = await loadList(db, ctx.workspaceId, c.req.param('id'));
  if (!list) return c.json({ error: 'not found' }, 404);
  return c.json({ id: list.id, counts: await listCounts(db, ctx, list, { fresh: c.req.query('fresh') === '1' }) });
});

api.get('/lists/:id', async (c) => {
  const ctx = c.get('ctx'); const db = c.get('db');
  if (!DESK.includes(ctx.role)) return refuse(c);
  const list = await loadList(db, ctx.workspaceId, c.req.param('id'));
  if (!list) return c.json({ error: 'not found' }, 404);
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 100, 1), 2000);
  const offset = Math.max(Number(c.req.query('offset')) || 0, 0);
  const q = String(c.req.query('q') || '').trim();
  const reach = REACHES.includes(c.req.query('reach')) ? c.req.query('reach') : null;
  const { people, total } = await peopleOf(db, ctx, { list, reach, limit, offset, q });
  return c.json({ list: listOut(list), counts: await listCounts(db, ctx, list, { fresh: true }), people, total, limit, offset });
});

api.get('/lists/:id/export.csv', async (c) => {
  const ctx = c.get('ctx'); const db = c.get('db');
  if (!DESK.includes(ctx.role)) return refuse(c);
  const list = await loadList(db, ctx.workspaceId, c.req.param('id'));
  if (!list) return c.json({ error: 'not found' }, 404);
  const { head, rows } = await listRows(db, ctx, list);
  return csvResponse(c, `list-${list.name}`, head, rows);
});
