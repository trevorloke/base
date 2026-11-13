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
//   GET /templates/:ref              ref: an id or starter:<key> → { ref, name, use,
//                                    subject, body, placeholders, version?, updated_at? }
//   GET /blasts/:id/message          "Use again": a past newsletter's or email's
//                                    { kind, subject, body } (Outreach, desk only)
// Subjects and bodies are as stored (codes); the screens show them in words.
import { Hono } from 'hono';
import { placeholders } from '@starbase/shared/email/words';
import { STARTERS, starterOf } from '@starbase/shared/email/starters';
import { footOf } from '../abtests/send.js';
import { GONE, USES, maySave, mayStart, refusal } from './rules.js';

export const api = new Hono();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
  });
});

api.get('/templates/:ref', async (c) => {
  const ctx = c.get('ctx');
  const ref = c.req.param('ref');
  if (ref.startsWith('starter:')) {
    const s = starterOf(ref.slice('starter:'.length));
    if (!s) return c.json({ error: GONE }, 404);
    if (!mayStart(ctx, s.use)) return c.json({ error: refusal(s.use) }, 403);
    return c.json({ ref, name: s.name, use: s.use, subject: s.subject, body: s.body, placeholders: placeholders(`${s.subject}\n${s.body}`) });
  }
  if (!UUID_RE.test(ref)) return c.json({ error: GONE }, 404);
  const t = (await c.get('db').query(
    'select * from email_templates where id = $1 and workspace_id = $2 and deleted_at is null', [ref, ctx.workspaceId],
  )).rows[0];
  if (!t) return c.json({ error: GONE }, 404);
  if (!mayStart(ctx, t.use)) return c.json({ error: refusal(t.use) }, 403);
  return c.json({
    ref, name: t.name, use: t.use, subject: t.subject, body: t.body,
    placeholders: placeholders(`${t.subject}\n${t.body}`), version: Number(t.version), updated_at: t.updated_at,
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
