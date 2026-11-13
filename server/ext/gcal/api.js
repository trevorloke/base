// GET /api/gcal — any signed-in role, in no area: whether "Your shifts in
// Google Calendar" can be used here, this person's connection and link, and
// for managers the switch and how many people use it.
//   { available, why: 'off'|'not-set-up'|'jobs-off'|null (managers),
//     google: { connected, email, state },
//     link: { state: ok|updating|gone|reconnect|stopping|left, said, shifts,
//             days, updated_at, paused_until } | null,
//     manager: { on, people } (managers) }
// Never a calendar id, an event id, a scope, a token or Google's words.
import { Hono } from 'hono';
import { googleSetup } from '../../lib/google/config.js';
import { grantFor } from '../../lib/google/tokens.js';
import { campaignOf, PURPOSE } from './push.js';
import { jobsOn } from './actions.js';

const iso = (v) => (v ? new Date(v).toISOString() : null);
export const api = new Hono();

api.get('/gcal', async (c) => {
  const db = c.get('db');
  const ctx = c.get('ctx');
  const ws = ctx.workspaceId;
  const camp = await campaignOf(db, ws);
  const connect = googleSetup().connect;
  const available = camp.on && connect && jobsOn();
  const manager = ctx.role === 'manager';
  const why = !manager ? null : !camp.on ? 'off' : !connect ? 'not-set-up' : !jobsOn() ? 'jobs-off' : null;
  const grant = await grantFor(db, { userId: ctx.user.id, workspaceId: ws }, PURPOSE);
  const row = (await db.query(
    `select l.state, l.said, l.dirty_at, l.wait_until, l.last_ok_at,
            (select count(*)::int from gcal_items i where i.workspace_id = l.workspace_id and i.user_id = l.user_id and i.kind = 'shift' and i.hash not like 'refused:%') as shifts,
            (select count(*)::int from gcal_items i where i.workspace_id = l.workspace_id and i.user_id = l.user_id and i.kind <> 'shift' and i.hash not like 'refused:%') as days
       from gcal_links l where l.workspace_id = $1 and l.user_id = $2`,
    [ws, ctx.user.id],
  )).rows[0];
  let link = null;
  if (row) {
    const pauses = [grant?.pausedUntil, row.wait_until].map((v) => (v ? new Date(v).getTime() : 0)).filter((t) => t > Date.now());
    link = {
      state: row.state === 'ok' && row.dirty_at ? 'updating' : row.state,
      said: row.said || null,
      shifts: row.shifts, days: row.days,
      updated_at: iso(row.last_ok_at),
      paused_until: pauses.length ? new Date(Math.max(...pauses)).toISOString() : null,
    };
  }
  const out = {
    available,
    why,
    google: {
      connected: Boolean(grant),
      email: grant?.email || null,
      state: grant ? (grant.state === 'reconnect' ? 'reconnect' : grant.state === 'ok' ? 'ok' : null) : null,
    },
    link,
  };
  if (manager) {
    const n = (await db.query(`select count(*)::int as n from gcal_links where workspace_id = $1 and state in ('ok', 'reconnect', 'gone')`, [ws])).rows[0].n;
    out.manager = { on: camp.on, people: n };
  }
  return c.json(out);
});
