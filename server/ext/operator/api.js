// GET /operator (managers): the switch, whether this is the demo (its
// visitors never see or change the switch), and the base.win support
// accounts here with their last visit.
import { Hono } from 'hono';
import { demoEmail } from '../../lib/demo.js';

export const api = new Hono();
const parseJ = (v, d) => (typeof v === 'string' ? JSON.parse(v) : (v ?? d));

api.get('/operator', async (c) => {
  const ctx = c.get('ctx');
  if (ctx.role !== 'manager') return c.json({ error: 'managers only' }, 403);
  const db = c.get('db');
  const ws = (await db.query('select settings from workspaces where id = $1', [ctx.workspaceId])).rows[0];
  const support = (await db.query(
    `select u.id as user_id, u.name,
            (select max(e.used_at) from operator_entries e where e.user_id = u.id and e.workspace_id = $1) as last_entry_at
       from operator_links l join users u on u.id = l.user_id
       join memberships m on m.user_id = u.id and m.workspace_id = $1
      order by u.name`,
    [ctx.workspaceId],
  )).rows;
  return c.json({ on: parseJ(ws?.settings, {}).operatorEntry !== false, demo: Boolean(demoEmail()), support });
});
