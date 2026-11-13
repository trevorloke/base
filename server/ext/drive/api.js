// What the desk reads about Google Drive (desk roles only; no area):
//
//   GET /api/drive              the campaign's switches and this person's
//                               connection — every Drive button reads it once
//   GET /api/drive/picker       the Picker's settings and its narrowed token
//   GET /api/drive/exports      your last 10 Sheets (managers: everyone's;
//                               ?more=1 the 40 before)
//   GET /api/drive/exports/:id  one, for the progress line
//   GET /api/drive/files/:id(/tabs/:tab.csv | /content)   a picked file (reads.js)
//   GET /api/drive/links        links opened to anyone that are still open
//                               (yours; managers: everyone's)
//
// Never a refresh token, a scope list or the client's secret; the Picker's
// token only in /picker, with no-store.
import { Hono } from 'hono';
import { makeLimiter } from '../../lib/guard.js';
import { signinRules } from '../../lib/google/config.js';
import { grantRowOf } from '../../lib/google/tokens.js';
import { driveRules, driveSetup, pickerKey, pickerScript, projectNumber } from './config.js';
import { FOR_THE_DESK, driveGrant, isDesk } from './grant.js';
import { landing, mayStillSend, STALE_SQL } from './export.js';
import { EXPORTS_FOLDER } from './files.js';
import { pickerToken } from './picker.js';
import { fileContent, fileMeta, tabCsv } from './reads.js';

export const api = new Hono();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const desk = (c) => (isDesk(c.get('ctx')) ? null : c.json({ error: FOR_THE_DESK }, 403));
const pickers = makeLimiter({ windowMs: 15 * 60_000, max: 30 });

api.get('/drive', async (c) => {
  const no = desk(c);
  if (no) return no;
  const db = c.get('db');
  const ctx = c.get('ctx');
  const setup = driveSetup().ok;
  const rules = driveRules(ctx.workspace.settings);
  const row = await grantRowOf(db, ctx.user.id);
  const mine = row?.purposes.includes('drive') ? row : null;
  const place = landing(rules, mine, ctx.workspace.settings);
  const canSend = setup && rules.on && mayStillSend(ctx, rules) && place.ok;
  const out = {
    setup, on: rules.on, sheets: rules.sheets, canSend,
    land: rules.folder ? { kind: 'campaign', id: rules.folder.id, name: rules.folder.name, shared: rules.folder.shared } : { kind: 'mine', name: EXPORTS_FOLDER, shared: false },
    me: { connected: Boolean(mine), email: mine?.email || null, state: mine ? mine.state : null, hd: mine?.hd || null },
    domain: signinRules(ctx.workspace.settings).domain,
  };
  if (ctx.role === 'manager') {
    out.connected = (await db.query(
      `select count(*)::int as n from google_grants g join memberships m on m.user_id = g.user_id and m.workspace_id = $1
        where 'drive' = any(g.purposes) and m.role in ('manager','treasurer','staff')`, [ctx.workspaceId],
    )).rows[0].n;
  }
  return c.json(out);
});

api.get('/drive/picker', async (c) => {
  const no = desk(c);
  if (no) return no;
  c.header('Cache-Control', 'no-store');
  const ctx = c.get('ctx');
  if (pickers(ctx.user.id)) return c.json({ error: 'Too many tries — wait a few minutes' }, 429);
  const rules = driveRules(ctx.workspace.settings);
  if (!driveSetup().ok || !rules.on) return c.json({ ready: false });
  const db = c.get('db');
  const g = await driveGrant(db, ctx);
  if (!g) return c.json({ ready: true, connect: true });
  if (g.state !== 'ok') return c.json({ ready: true, connect: true, said: g.said || 'Connect Google Drive again' });
  const t = await pickerToken(db, g);
  if (t.unsafe) return c.json({ ready: true, unsafe: true, said: 'Google Drive can’t open safely on this server — tell us' });
  if (t.trouble?.code === 'reconnect') return c.json({ ready: true, connect: true, said: 'Connect Google Drive again' });
  if (t.trouble) return c.json({ ready: true, trouble: t.trouble.plain }, t.trouble.code === 'paused' ? 429 : 503);
  return c.json({ ready: true, apiKey: pickerKey(), appId: projectNumber(), script: pickerScript(), email: g.email, token: t.token, expiresAt: t.expiresAt });
});

const shape = (r, ctx) => ({
  id: r.id, name: r.name, source: r.source, rows: r.rows, cols: r.cols, done_rows: r.done_rows,
  status: r.stale ? 'failed' : r.status, said: r.stale ? 'It stopped part-way — Try again' : r.said,
  url: r.url, land: r.land, by: r.by_name, mine: r.user_id === ctx.user.id, created_at: r.created_at, done_at: r.done_at,
});
const SELECT = `select e.*, u.name as by_name, ${STALE_SQL} as stale from drive_exports e join users u on u.id = e.user_id`;

api.get('/drive/exports', async (c) => {
  const no = desk(c);
  if (no) return no;
  const ctx = c.get('ctx');
  const all = ctx.role === 'manager';
  const more = all && c.req.query('more') === '1';
  const rows = (await c.get('db').query(
    `${SELECT} where e.workspace_id = $1 ${all ? '' : 'and e.user_id = $2'} order by e.created_at desc, e.id limit ${more ? 40 : 10} offset ${more ? 10 : 0}`,
    all ? [ctx.workspaceId] : [ctx.workspaceId, ctx.user.id],
  )).rows;
  return c.json({ exports: rows.map((r) => shape(r, ctx)) });
});

api.get('/drive/exports/:id', async (c) => {
  const no = desk(c);
  if (no) return no;
  const ctx = c.get('ctx');
  if (!UUID.test(c.req.param('id'))) return c.json({ error: 'not found' }, 404);
  const r = (await c.get('db').query(`${SELECT} where e.workspace_id = $1 and e.id = $2`, [ctx.workspaceId, c.req.param('id')])).rows[0];
  if (!r || (ctx.role !== 'manager' && r.user_id !== ctx.user.id)) return c.json({ error: 'not found' }, 404);
  return c.json({ export: shape(r, ctx) });
});

// A picked file (reads.js): desk roles only, the person's own grant.
const deskFirst = (fn) => async (c) => desk(c) || fn(c);
api.get('/drive/files/:id', deskFirst((c) => fileMeta(c, pickers)));
api.get('/drive/files/:id/tabs/:tab', deskFirst(tabCsv));
api.get('/drive/files/:id/content', deskFirst(fileContent));

// Links opened to anyone, still open: yours, or (managers) everyone's, so
// someone can make each private again (only the person who opened it can:
// under drive.file nobody else's grant reaches that file).
api.get('/drive/links', async (c) => {
  const no = desk(c);
  if (no) return no;
  const ctx = c.get('ctx');
  const all = ctx.role === 'manager';
  const rows = (await c.get('db').query(
    `select l.id, l.name, l.url, l.user_id, l.created_at, u.name as by_name,
            exists (select 1 from memberships m where m.workspace_id = l.workspace_id and m.user_id = l.user_id) as still_here
       from drive_links l join users u on u.id = l.user_id
      where l.workspace_id = $1 and l.closed_at is null ${all ? '' : 'and l.user_id = $2'}
      order by l.created_at desc, l.id limit 50`,
    all ? [ctx.workspaceId] : [ctx.workspaceId, ctx.user.id],
  )).rows;
  return c.json({
    links: rows.map((r) => ({ id: r.id, name: r.name, url: r.url, by: r.by_name, mine: r.user_id === ctx.user.id, left: !r.still_here, created_at: r.created_at })),
  });
});
