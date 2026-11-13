// GET /api/gmail — desk roles, Outreach (lib/perms.js PATH_AREA; volunteers
// 403 through deskOnlyReads):
//   { setup, on, review, dailyMax, domain (GSI's, read-only),
//     me: { connected, email, ok, trouble: null|'reconnect'|'paused'|'off',
//           said, pausedUntil, sentToday },
//     apiOff: { until, said } | null,
//     people: [{ name, email }]   managers: who here can send from Gmail }
// Never a token, a scope list or anyone's message.
import { Hono } from 'hono';
import { googleSetup } from '../../lib/google/config.js';
import { domainFor } from '../../lib/google/purposes.js';
import { grantFor } from '../../lib/google/tokens.js';
import { DESK, gmailSettings, sentToday } from './actions.js';
import { apiOffNow, dailyMax } from './send.js';

export const api = new Hono();

api.get('/gmail', async (c) => {
  const db = c.get('db');
  const ctx = c.get('ctx');
  if (!DESK.includes(ctx.role)) return c.json({ error: 'volunteers cannot view this' }, 403);
  const settings = ctx.workspace.settings || {};
  const { on, review } = gmailSettings(settings);
  const g = await grantFor(db, { userId: ctx.user.id, workspaceId: ctx.workspaceId }, 'gmail.send');
  const paused = g?.pausedUntil && new Date(g.pausedUntil).getTime() > Date.now() ? g.pausedUntil : null;
  const trouble = !g ? null : g.state !== 'ok' ? 'reconnect' : paused ? 'paused' : !on ? 'off' : null;
  const out = {
    setup: googleSetup().connect, on, review, dailyMax: dailyMax(),
    domain: domainFor('gmail.send', settings),
    me: {
      connected: Boolean(g), email: g?.email || null, ok: Boolean(g) && !trouble,
      trouble, said: g && g.state !== 'ok' ? g.said : null, pausedUntil: paused, sentToday: await sentToday(db, ctx.user.id),
    },
    apiOff: apiOffNow(),
  };
  if (ctx.role === 'manager') {
    out.people = (await db.query(
      `select u.name, g.email from google_grants g
       join memberships m on m.user_id = g.user_id and m.workspace_id = $1
       join users u on u.id = g.user_id
       where 'gmail.send' = any(g.purposes) order by u.name`,
      [ctx.workspaceId],
    )).rows.map((r) => ({ name: r.name, email: r.email }));
  }
  return c.json(out);
});
