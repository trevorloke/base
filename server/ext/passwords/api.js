// GET /password-links (managers): whether Settings → Members offers "Make a
// password link" — not on the public demo — whether it would be emailed,
// and who on the team is in another campaign here too (they use Forgot
// password; actions.js refuses them).
import { Hono } from 'hono';
import { demoEmail } from '../../lib/demo.js';
import { emailConfigured } from '../../lib/notify.js';
import { publicBase } from './reset.js';

export const api = new Hono();

api.get('/password-links', async (c) => {
  const ctx = c.get('ctx');
  if (ctx.role !== 'manager') return c.json({ error: 'managers only' }, 403);
  const elsewhere = (await c.get('db').query(
    `select distinct m.user_id from memberships m
      where m.workspace_id = $1 and exists (select 1 from memberships o where o.user_id = m.user_id and o.workspace_id <> $1)`,
    [ctx.workspaceId],
  )).rows.map((r) => r.user_id);
  return c.json({ on: !demoEmail(), address: Boolean(publicBase()), email: emailConfigured(), elsewhere });
});
