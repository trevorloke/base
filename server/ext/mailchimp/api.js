// GET /lists/:id/mailchimp[?counts=1]   desk: this list in Mailchimp — the last sync (or the one on its way), and with
//                                        ?counts=1 how many addresses would go: only the newsletter's subscribers, or everyone
//                                        on the list who can be emailed. Counts only; never an address or a key.
// GET /mailchimp                         managers: what the last pull said, whether one is under way, and how many
//                                        unsubscribes Mailchimp has not been told yet — with its own words for why
//                                        (Settings → Services)
// Both carry `first` while nobody has said yes to the first pull from the audience in use (pull.js, firstOf): the
// audience's name and how many on file it would turn off — the question both screens ask. null once it is open.
import { Hono } from 'hono';
import { jobRunnerOn } from '../../lib/jobs.js';
import { loadList } from '../lists/audience.js';
import { mailchimpOn } from './mailchimp.js';
import { optoutsWaiting, optoutsWhy } from './optout.js';
import { firstOf, pulling } from './pull.js';
import { countsFor, jobLive, syncOut } from './push.js';

const DESK = ['manager', 'treasurer', 'staff'];
export const api = new Hono();

api.get('/lists/:id/mailchimp', async (c) => {
  const ctx = c.get('ctx'); const db = c.get('db'); const ws = ctx.workspaceId;
  if (!DESK.includes(ctx.role)) return c.json({ error: 'desk only' }, 403);
  const list = await loadList(db, ws, c.req.param('id'));
  if (!list) return c.json({ error: 'not found' }, 404);
  // running: whether this server does background work at all (STARBASE_JOBS=off: a sync waits).
  const out = { on: mailchimpOn(), running: jobRunnerOn(), sync: null, first: null };
  // The newest: after a change of audience, the one sent to the audience in use now.
  const row = (await db.query(
    `select s.*, u.name as by from mailchimp_syncs s left join users u on u.id = s.created_by
      where s.workspace_id = $1 and s.list_id = $2 order by s.created_at desc limit 1`, [ws, list.id],
  )).rows[0];
  if (row) {
    // Still going with no job left to do it: it stopped (Try again starts it afresh).
    const stalled = ['queued', 'syncing'].includes(row.status) && !(await jobLive(db, ws, row.id));
    out.sync = { ...syncOut(row), by: row.by || null, stalled };
  }
  if (out.on) out.first = await firstOf(db, ws);
  if (out.on && c.req.query('counts')) out.counts = await countsFor(db, ws, list);
  return c.json(out);
});

api.get('/mailchimp', async (c) => {
  const ctx = c.get('ctx'); const db = c.get('db'); const ws = ctx.workspaceId;
  if (ctx.role !== 'manager') return c.json({ error: 'managers only' }, 403);
  const s = (await db.query('select pulled_at, pull_ok, pull_note from mailchimp_state where workspace_id = $1', [ws])).rows[0];
  const waiting = await optoutsWaiting(db, ws);
  return c.json({
    on: mailchimpOn(),
    first: mailchimpOn() ? await firstOf(db, ws) : null,
    running: jobRunnerOn(),
    pulling: await pulling(db, ws),
    pulled_at: s?.pulled_at || null,
    pull_ok: s?.pull_ok ?? null,
    pull_note: s?.pull_note || null,
    waiting,
    waiting_note: waiting ? await optoutsWhy(db, ws) : null,
  });
});
