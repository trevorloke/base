// GET /api/senders — the From addresses a send may go from:
// { system: { name, email } | null, senders: [{ id, name, email, raw }],
//   defaults: { email, press }, domain, canChoose }.
// system: MAIL_FROM. canChoose: only the desk picks a From on a send (the
// server ignores anyone else's pick). Read by the desk and by anyone who
// may send (Outreach or Media).
import { Hono } from 'hono';
import { areasFor } from '../../lib/perms.js';
import { mailFrom } from '../../lib/mail/index.js';
import { defaultsOf, isDesk, rawOf, sendersOf, settingsOf } from './rules.js';

export const api = new Hono();

api.get('/senders', async (c) => {
  const ctx = c.get('ctx');
  const areas = areasFor(ctx);
  if (!isDesk(ctx) && !areas.includes('outreach') && !areas.includes('media')) {
    return c.json({ error: 'not for you — ask a manager under Admin → Permissions' }, 403);
  }
  const settings = settingsOf((await c.get('db').query('select settings from workspaces where id = $1', [ctx.workspaceId])).rows[0]);
  const from = mailFrom();
  return c.json({
    system: from.email ? { name: from.name || null, email: from.email } : null,
    senders: sendersOf(settings).map((s) => ({ ...s, raw: rawOf(s) })),
    defaults: defaultsOf(settings),
    domain: from.domain || null,
    canChoose: isDesk(ctx),
  });
});
