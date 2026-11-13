// GET /api/moves/door?person=<id>   any signed-in role (area People).
// Who lives at the new address and still at the old one, for that person's
// latest move still standing — the lists person.move answers with, under
// the same rules (lists.js), for a phone that saved with no signal and asks
// once its outbox has sent. 404 with no such move — and, for a volunteer,
// with no such move of their own (left is theirs only because they stood at
// that door).
import { Hono } from 'hono';
import { doorLists, mayMoveAnyone } from './lists.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const api = new Hono();

api.get('/moves/door', async (c) => {
  const ctx = c.get('ctx');
  const db = c.get('db');
  const id = String(c.req.query('person') || '');
  if (!UUID_RE.test(id)) return c.json({ error: 'not found' }, 404);
  const move = (await db.query(
    `select m.* from person_moves m join persons p on p.id = m.person_id and p.deleted_at is null
      where m.workspace_id = $1 and m.person_id = $2 and m.undone_at is null
      order by m.created_at desc, m.id desc limit 1`,
    [ctx.workspaceId, id],
  )).rows[0];
  if (!move || (!mayMoveAnyone(ctx) && move.created_by !== ctx.user.id)) return c.json({ error: 'no move on file' }, 404);
  return c.json(await doorLists(db, ctx, move));
});
