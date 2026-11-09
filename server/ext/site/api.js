// The Website area's reads (signed in; the 'site' area — managers, or whoever
// a manager granted it to). Writes are actions (actions.js). See index.js.
import { Hono } from 'hono';
import { areasFor } from '../../lib/perms.js';
import { here } from '../../lib/mount.js';
import { ensureSite, readSettings, pageOut, postOut, campaignOut, SIGNATURES_SQL } from './store.js';
import { sign, PREVIEW_TTL } from './tokens.js';

export const api = new Hono();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (d) => (d instanceof Date ? d.toISOString() : d ? new Date(d).toISOString() : null);

// Everything under /site: the Website area's, or refused — whatever the role.
api.use('/site/*', async (c, next) => {
  if (!areasFor(c.get('ctx')).includes('site')) return c.json({ error: 'the Website is for managers — ask one under Admin → Permissions' }, 403);
  await next();
});
api.use('/site', async (c, next) => {
  if (!areasFor(c.get('ctx')).includes('site')) return c.json({ error: 'the Website is for managers — ask one under Admin → Permissions' }, 403);
  await next();
});

// The campaign's site, made on first look (its brand's seed).
const opened = async (c) => {
  const ctx = c.get('ctx');
  await ensureSite(c.get('db'), ctx.workspace, ctx.user.id);
  return ctx.workspaceId;
};

api.get('/site', async (c) => {
  const ws = await opened(c);
  const db = c.get('db');
  const settings = await readSettings(db, ws);
  const pages = (await db.query(
    'select * from site_pages where workspace_id = $1 and deleted_at is null order by nav_order, created_at', [ws],
  )).rows.map((r) => pageOut(r, { full: false }));
  const count = async (sql) => (await db.query(sql, [ws])).rows[0];
  const posts = await count(`select count(*)::int as n, count(*) filter (where status = 'published')::int as live from site_posts where workspace_id = $1 and deleted_at is null`);
  const campaigns = await count(`select count(*)::int as n, count(*) filter (where status = 'open')::int as open from site_campaigns where workspace_id = $1 and deleted_at is null`);
  const actions = await count(`select count(*)::int as n, count(*) filter (where created_at > now() - interval '7 days')::int as week from site_actions where workspace_id = $1`);
  return c.json({
    settings,
    pages,
    counts: {
      pages: pages.length, published: pages.filter((p) => p.status === 'published').length,
      posts: posts.n, posts_published: posts.live, campaigns: campaigns.n, campaigns_open: campaigns.open,
      actions: actions.n, actions_week: actions.week,
    },
    // Where it can be seen: the app's own address (/site/) until the
    // campaign's domain points here, then that domain too.
    urls: { site: here(c, '/site/'), domains: (settings.domains || []).map((d) => `https://${d}/`) },
  });
});

api.get('/site/pages/:id', async (c) => {
  if (!UUID.test(c.req.param('id'))) return c.json({ error: 'not found' }, 404);
  const ws = await opened(c);
  const r = (await c.get('db').query('select * from site_pages where id = $1 and workspace_id = $2 and deleted_at is null', [c.req.param('id'), ws])).rows[0];
  if (!r) return c.json({ error: 'not found' }, 404);
  return c.json({ page: pageOut(r) });
});

api.get('/site/posts', async (c) => {
  const ws = await opened(c);
  const rows = (await c.get('db').query(
    'select * from site_posts where workspace_id = $1 and deleted_at is null order by coalesce(published_at, created_at) desc limit 500', [ws],
  )).rows;
  return c.json({ posts: rows.map((r) => postOut(r, { full: false })) });
});

api.get('/site/posts/:id', async (c) => {
  if (!UUID.test(c.req.param('id'))) return c.json({ error: 'not found' }, 404);
  const ws = await opened(c);
  const r = (await c.get('db').query('select * from site_posts where id = $1 and workspace_id = $2 and deleted_at is null', [c.req.param('id'), ws])).rows[0];
  if (!r) return c.json({ error: 'not found' }, 404);
  return c.json({ post: postOut(r) });
});

api.get('/site/campaigns', async (c) => {
  const ws = await opened(c);
  const rows = (await c.get('db').query(
    `select c.*, ${SIGNATURES_SQL} as signatures from site_campaigns c where c.workspace_id = $1 and c.deleted_at is null order by c.created_at`, [ws],
  )).rows;
  return c.json({ campaigns: rows.map((r) => campaignOut(r, { full: false })) });
});

api.get('/site/campaigns/:id', async (c) => {
  if (!UUID.test(c.req.param('id'))) return c.json({ error: 'not found' }, 404);
  const ws = await opened(c);
  const r = (await c.get('db').query(
    `select c.*, ${SIGNATURES_SQL} as signatures from site_campaigns c where c.id = $1 and c.workspace_id = $2 and c.deleted_at is null`,
    [c.req.param('id'), ws],
  )).rows[0];
  if (!r) return c.json({ error: 'not found' }, 404);
  return c.json({ campaign: campaignOut(r) });
});

// The pictures on file (the site's and Outreach's — one store), newest first.
api.get('/site/pictures', async (c) => {
  const ws = await opened(c);
  const rows = (await c.get('db').query(
    'select id, content_type, bytes, width, height, name, created_at from media where workspace_id = $1 order by created_at desc limit 200', [ws],
  )).rows;
  return c.json({ pictures: rows.map((r) => ({ ...r, created_at: iso(r.created_at), url: `/media/${r.id}` })) });
});

// A link that shows a page's draft for half an hour (the admin's preview
// frame; anyone holding it can look, so it is short-lived and noindex).
api.post('/site/preview-token', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const pageId = String(body?.pageId || body?.page_id || '');
  if (!UUID.test(pageId)) return c.json({ error: 'pageId: which page' }, 400);
  const ws = await opened(c);
  const r = (await c.get('db').query('select id from site_pages where id = $1 and workspace_id = $2 and deleted_at is null', [pageId, ws])).rows[0];
  if (!r) return c.json({ error: 'not found' }, 404);
  const t = await sign('preview', { w: ws, p: pageId }, PREVIEW_TTL);
  return c.json({ url: here(c, `/site/__preview/${pageId}?t=${encodeURIComponent(t)}`), expires_at: new Date(Date.now() + PREVIEW_TTL * 1000).toISOString() });
});
