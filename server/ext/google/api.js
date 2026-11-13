// What the app is told about Google (signed in; no area):
//
//   GET /api/google           { setup: { signin, connect, why },
//                               at: { right, address }, rules: { signin, domain },
//                               jobs, me: { login, grant }, purposes: [{ key,
//                               label, ownCard, mine, state }] }
//                             why only for managers; purposes: those this
//                             person may use now, and any they're
//                             connected for that they no longer may
//   GET /api/google/members   managers: [{ user_id, elsewhere }] of members
//                             who sign in with Google (Team's chip; no
//                             Unlink for one in another campaign here too)
//                             — no Google email
//
// Never a sub, a scope list, a token, the client's id or secret, or the key.
import { Hono } from 'hono';
import { configuredUrl } from '../../lib/calendar.js';
import { jobRunnerOn } from '../../lib/jobs.js';
import { googleSetup, signinRules } from '../../lib/google/config.js';
import { allPurposes, mayUse } from '../../lib/google/purposes.js';
import { grantFor, grantRowOf } from '../../lib/google/tokens.js';
import { atPublicAddress } from './routes.js';

export const api = new Hono();

api.get('/google', async (c) => {
  const db = c.get('db');
  const ctx = c.get('ctx');
  const setup = googleSetup();
  const login = (await db.query('select email, hd from google_logins where user_id = $1', [ctx.user.id])).rows[0] || null;
  const row = await grantRowOf(db, ctx.user.id);
  const who = { userId: ctx.user.id, workspaceId: ctx.workspaceId };
  const purposes = [];
  for (const p of allPurposes()) {
    // One already connected stays listed when no longer allowed (state
    // 'not-allowed'), so its Disconnect still shows.
    const g = row?.purposes.includes(p.key) ? await grantFor(db, who, p.key) : null;
    if (!g && !(await mayUse(db, who, p))) continue;
    purposes.push({ key: p.key, label: p.label, ownCard: p.ownCard, mine: Boolean(g), state: g?.state || null, said: g?.said || null });
  }
  return c.json({
    setup: { signin: setup.signin, connect: setup.connect, why: ctx.role === 'manager' ? setup.why : null },
    at: { right: atPublicAddress(c), address: configuredUrl() },
    rules: signinRules(ctx.workspace.settings),
    jobs: jobRunnerOn(),
    me: {
      login: login ? { email: login.email, hd: login.hd || null } : null,
      grant: row ? {
        email: row.email, purposes: row.purposes, state: row.state, said: row.said || null,
        pausedUntil: row.paused_until ? new Date(row.paused_until).toISOString() : null,
      } : null,
    },
    purposes,
  });
});

api.get('/google/members', async (c) => {
  const ctx = c.get('ctx');
  if (ctx.role !== 'manager') return c.json({ error: 'managers only' }, 403);
  const rows = (await c.get('db').query(
    `select g.user_id, exists (select 1 from memberships o where o.user_id = g.user_id and o.workspace_id <> $1) as elsewhere
     from google_logins g join memberships m on m.user_id = g.user_id and m.workspace_id = $1 order by g.user_id`,
    [ctx.workspaceId],
  )).rows;
  return c.json(rows.map((r) => ({ user_id: r.user_id, elsewhere: Boolean(r.elsewhere) })));
});
