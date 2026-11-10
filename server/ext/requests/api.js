// Requests from the doors, read (mounted under /api, signed in).
//
//   GET /requests?open=1|all     desk: newest first (500 at most) — open ones
//                                by default, every one with open=all — each
//                                with the person (name, phone, address, unit,
//                                rating, tags), who asked and who marked it done
//   GET /requests/count          desk: { open: n } for Today's "Needs you"
//   GET /persons/:id/requests    any role: a person's requests, newest first.
//                                The desk gets everything; a volunteer only
//                                { id, kind, created_at, done } — enough for
//                                "Asked the office · 2:10 pm", never what was
//                                said, who asked, or what the office did.
//
// Only people still on the list: a request about someone removed drops out.
// /requests and /requests/count are desk-only reads (index.js) and each
// handler checks the role again.
import { Hono } from 'hono';

export const api = new Hono();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isDesk = (c) => c.get('ctx').role !== 'volunteer';
const refuse = (c) => c.json({ error: 'volunteers cannot view this' }, 403);
const LIMIT = 500;
const tagsOf = (v) => { try { const t = typeof v === 'string' ? JSON.parse(v) : v; return Array.isArray(t) ? t : []; } catch { return []; } };

const rowOut = (r) => ({
  id: r.id, kind: r.kind, note: r.note, created_at: r.created_at, done_at: r.done_at, done_note: r.done_note,
  person: {
    id: r.person_id, name: r.person_name, phone: r.person_phone, address: r.person_address, unit: r.person_unit, rating: r.person_rating,
    // So the desk's Call is not offered for someone tagged do-not-call.
    tags: tagsOf(r.person_tags),
  },
  asked_by_name: r.asked_by_name || null,
  done_by_name: r.done_by_name || null,
});

api.get('/requests/count', async (c) => {
  if (!isDesk(c)) return refuse(c);
  const n = (await c.get('db').query(
    `select count(*)::int as n from door_requests r join persons p on p.id = r.person_id and p.deleted_at is null
     where r.workspace_id = $1 and r.done_at is null`,
    [c.get('ctx').workspaceId],
  )).rows[0].n;
  return c.json({ open: n });
});

api.get('/requests', async (c) => {
  if (!isDesk(c)) return refuse(c);
  const all = c.req.query('open') === 'all';
  const rows = (await c.get('db').query(
    `select r.id, r.kind, r.note, r.created_at, r.done_at, r.done_note, r.person_id,
       p.name as person_name, p.phone as person_phone, p.address as person_address,
       p.unit as person_unit, p.rating as person_rating, p.tags as person_tags,
       a.name as asked_by_name, d.name as done_by_name
     from door_requests r
     join persons p on p.id = r.person_id and p.deleted_at is null
     left join users a on a.id = r.asked_by
     left join users d on d.id = r.done_by
     where r.workspace_id = $1 ${all ? '' : 'and r.done_at is null'}
     order by r.created_at desc, r.id
     limit ${LIMIT}`,
    [c.get('ctx').workspaceId],
  )).rows;
  return c.json({ requests: rows.map(rowOut) });
});

api.get('/persons/:id/requests', async (c) => {
  const id = c.req.param('id');
  if (!UUID_RE.test(id || '')) return c.json({ error: 'not found' }, 404);
  const ctx = c.get('ctx');
  const db = c.get('db');
  const person = (await db.query(
    'select id from persons where id = $1 and workspace_id = $2 and deleted_at is null', [id, ctx.workspaceId],
  )).rows[0];
  if (!person) return c.json({ error: 'not found' }, 404);
  const rows = (await db.query(
    `select r.id, r.kind, r.note, r.created_at, r.done_at, r.done_note, r.person_id,
       a.name as asked_by_name, d.name as done_by_name
     from door_requests r
     left join users a on a.id = r.asked_by
     left join users d on d.id = r.done_by
     where r.workspace_id = $1 and r.person_id = $2
     order by r.created_at desc, r.id
     limit 100`,
    [ctx.workspaceId, id],
  )).rows;
  if (!isDesk(c)) {
    return c.json({ requests: rows.map((r) => ({ id: r.id, kind: r.kind, created_at: r.created_at, done: Boolean(r.done_at) })) });
  }
  return c.json({
    requests: rows.map((r) => ({
      id: r.id, kind: r.kind, note: r.note, created_at: r.created_at, done_at: r.done_at, done_note: r.done_note,
      asked_by_name: r.asked_by_name || null, done_by_name: r.done_by_name || null,
    })),
  });
});
