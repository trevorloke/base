// Reads for two-step sign-in (lib/twostep.js):
//   GET /two-step        your own: on or not, since when, recovery codes
//                        left, whether you need it here (your role, or an
//                        area you were given); while you're
//                        setting it up, the key and its QR code again (a
//                        reload doesn't lose a key already scanned)
//   GET /two-step/team   managers: whether it's required for desk roles, and
//                        who has it on (Settings → Members)
import { Hono } from 'hono';
import { keyStatus, openSecret, requiredFor, setupFor, twoStepRow } from '../../lib/twostep.js';
import { issuerFor } from './actions.js';

export const api = new Hono();
const parseJ = (v, d) => (typeof v === 'string' ? JSON.parse(v) : (v ?? d));

api.get('/two-step', async (c) => {
  const ctx = c.get('ctx');
  const db = c.get('db');
  const row = await twoStepRow(db, ctx.user.id);
  const on = Boolean(row?.on_since);
  const open = row?.secret ? await openSecret(db, row.secret) : null;
  return c.json({
    on,
    since: row?.on_since || null,
    recovery_left: on ? parseJ(row.recovery, []).length : 0,
    setup: !on && open ? setupFor(open.plain, { account: ctx.user.email, issuer: issuerFor(ctx) }) : null,
    // On, but its key can't be opened here any more (the key setting changed).
    unreadable: on && !open,
    required: requiredFor(ctx.role, ctx.workspace?.settings, ctx.perms),
    must_set_up: Boolean(ctx.twoStep?.mustSetUp),
  });
});

api.get('/two-step/team', async (c) => {
  const ctx = c.get('ctx');
  if (ctx.role !== 'manager') return c.json({ error: 'managers only' }, 403);
  // elsewhere: also in another campaign on this server — reset from the
  // server's shell, not from here (actions.js twostep.reset).
  const rows = (await c.get('db').query(
    `select m.user_id as id, t.on_since,
            exists (select 1 from memberships o where o.user_id = m.user_id and o.workspace_id <> $1) as elsewhere
     from memberships m join two_step t on t.user_id = m.user_id and t.on_since is not null
     where m.workspace_id = $1`,
    [ctx.workspaceId],
  )).rows;
  const ws = (await c.get('db').query('select settings from workspaces where id = $1', [ctx.workspaceId])).rows[0];
  return c.json({
    required: parseJ(ws?.settings, {}).twoStepRequired === true,
    you: Boolean(ctx.twoStep?.on),
    members: rows.map((r) => ({ id: r.id, on: true, since: r.on_since, elsewhere: Boolean(r.elsewhere) })),
    key: keyStatus().source,
  });
});
