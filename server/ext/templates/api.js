// Template reads, under /api. The area is checked here (email: the desk
// holding Outreach; press: anyone holding Media — a volunteer granted Media
// may start a release from one), so no PATH_AREA line names /templates.
//
//   GET /templates?use=email|press   { starters: [{ key, name, subject, hidden }],
//                                    mine: [{ id, name, subject, made_from, updated_at,
//                                    updated_by_name }], canSave, canHide, foot } — no
//                                    bodies. A hidden ready-made one is left out,
//                                    except for a manager (flagged, to show again).
//                                    foot: the lines at the bottom of every email
//                                    { name, address, contact, auth, missing: ['address'] | [] }
//                                    links: the website's live pages [{ label, url }]
//                                    for the compose's "Link to…" (full addresses:
//                                    an email is read away from the site)
//   GET /templates/:ref              ref: an id or starter:<key> → { ref, name, use,
//                                    subject, body, placeholders, version?, updated_at? }
//   GET /blasts/:id/message          "Use again": a past newsletter's or email's
//                                    { kind, subject, body } (Outreach, desk only)
// Subjects and bodies are as stored (codes); the screens show them in words.
import { Hono } from 'hono';
import { NO_ADDRESS, placeholders } from '@starbase/shared/email/words';
import { STARTERS, starterOf } from '@starbase/shared/email/starters';
import { footOf } from '../abtests/send.js';
import { baseOf } from '../socials/share-api.js';
import { GONE, USES, maySave, mayStart, refusal } from './rules.js';

export const api = new Hono();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// What the compose sends back with blast.send (placeholders_from): the
// bracketed ones, at most 200 (an empty link is checked on the text itself).
const toFill = (t) => placeholders(`${t.subject}\n${t.body}`).filter((p) => !p.startsWith(NO_ADDRESS)).slice(0, 200);
// The website's published pages and open petitions, as Sharing lists them.
const linksOf = async (c, db, ws) => {
  const s = (await db.query('select domains from site_settings where workspace_id = $1', [ws])).rows[0];
  if (!s) return [];
  const domains = typeof s.domains === 'string' ? JSON.parse(s.domains) : s.domains;
  const base = baseOf(c, domains);
  const rows = [
    { path: '/', title: 'Home' },
    ...(await db.query(
      `select '/' || slug as path, coalesce(nullif(published->>'title', ''), title) as title from site_pages
        where workspace_id = $1 and deleted_at is null and site_id is null and status = 'published' and slug <> 'home'
        order by nav_order, created_at limit 100`, [ws],
    )).rows,
    ...(await db.query(
      `select '/act/' || slug as path, title from site_campaigns
        where workspace_id = $1 and deleted_at is null and status = 'open' order by created_at limit 50`, [ws],
    )).rows,
  ];
  return rows.map((r) => ({ label: r.title || r.path, url: r.path === '/' ? `${base}/` : `${base}${r.path}` }));
};
const hiddenOf = (ctx) => {
  const h = ctx.workspace?.settings?.templates?.hidden;
  return new Set(Array.isArray(h) ? h : []);
};

api.get('/templates', async (c) => {
  const ctx = c.get('ctx');
  const use = c.req.query('use') || 'email';
  if (!USES.includes(use)) return c.json({ error: 'use is email or press' }, 400);
  if (!mayStart(ctx, use)) return c.json({ error: refusal(use) }, 403);
  const db = c.get('db');
  const manager = ctx.role === 'manager';
  const hidden = hiddenOf(ctx);
  const starters = STARTERS.filter((s) => s.use === use && (manager || !hidden.has(s.key)))
    .map((s) => ({ key: s.key, name: s.name, subject: s.subject, hidden: hidden.has(s.key) }));
  const mine = (await db.query(
    `select t.id, t.name, t.subject, t.made_from, t.updated_at, u.name as updated_by_name
       from email_templates t left join users u on u.id = t.updated_by
      where t.workspace_id = $1 and t.use = $2 and t.deleted_at is null
      order by lower(t.name) collate "C", t.id`,
    [ctx.workspaceId, use],
  )).rows;
  const f = await footOf(db, ctx.workspaceId);
  return c.json({
    starters, mine, canSave: maySave(ctx, use), canHide: manager,
    foot: { name: ctx.workspace?.name || '', ...f, missing: f.address ? [] : ['address'] },
    links: await linksOf(c, db, ctx.workspaceId),
  });
});

api.get('/templates/:ref', async (c) => {
  const ctx = c.get('ctx');
  const ref = c.req.param('ref');
  if (ref.startsWith('starter:')) {
    const s = starterOf(ref.slice('starter:'.length));
    if (!s) return c.json({ error: GONE }, 404);
    if (!mayStart(ctx, s.use)) return c.json({ error: refusal(s.use) }, 403);
    return c.json({ ref, name: s.name, use: s.use, subject: s.subject, body: s.body, placeholders: toFill(s) });
  }
  if (!UUID_RE.test(ref)) return c.json({ error: GONE }, 404);
  const t = (await c.get('db').query(
    'select * from email_templates where id = $1 and workspace_id = $2 and deleted_at is null', [ref, ctx.workspaceId],
  )).rows[0];
  if (!t) return c.json({ error: GONE }, 404);
  if (!mayStart(ctx, t.use)) return c.json({ error: refusal(t.use) }, 403);
  return c.json({
    ref, name: t.name, use: t.use, subject: t.subject, body: t.body,
    placeholders: toFill(t), version: Number(t.version), updated_at: t.updated_at,
  });
});

api.get('/blasts/:id/message', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) return c.json({ error: 'send not found' }, 404);
  const b = (await c.get('db').query(
    `select kind, subject, body from blasts where id = $1 and workspace_id = $2 and kind in ('newsletter', 'eblast')`,
    [id, ctx.workspaceId],
  )).rows[0];
  if (!b) return c.json({ error: 'send not found' }, 404);
  return c.json({ kind: b.kind, subject: b.subject, body: b.body });
});
