// Share kits, read (mounted under /api, signed in).
//
//   GET /share            any role, no area: { code|null, base, brought, kits:
//       [{ id, code, title, text, picture_url, page_title, link }] } — the
//       open kits whose page is live, newest first, at most 20; { ready:
//       false } while the website was never set up. brought: the people who
//       signed something through their link (site_actions.referrer_id).
//   GET /share/kits       Outreach: every kit with live, page_title,
//       signups (people whose sign-up carries kit-<code>) and sharers; plus
//       line (the authorization line) and pages (what a kit may open).
//   GET /share/kits/:id   Outreach: one kit and its top 10 sharers.
//   GET /share/top        Outreach: the top 10 people by people brought in,
//       through any link of theirs, all time.
import { Hono } from 'hono';
import { here } from '../../lib/mount.js';
import { azKey } from '../../lib/az.js';
import { selfPerson } from '../relationships/match.js';
import { authLine, kitOut, kitPage, kitText } from './share.js';

export const shareApi = new Hono();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHARE_MAX = 20;
const TOP_MAX = 10;
const parseJ = (v, d) => (typeof v === 'string' ? JSON.parse(v) : (v ?? d));

// Where a shared link starts: the campaign's own domain, else the app's
// /site address (the public address when the app runs under a client's path).
export const baseOf = (c, domains) => {
  const d = Array.isArray(domains) ? String(domains[0] || '').trim().toLowerCase() : '';
  if (d) return `https://${d}`;
  const url = new URL(c.req.url);
  const proto = (c.req.header('x-forwarded-proto') || '').split(',')[0].trim() === 'https' ? 'https' : url.protocol.replace(':', '');
  let origin = `${proto}://${url.host}`;
  const pub = String(process.env.STARBASE_PUBLIC_URL || '').trim();
  if (c.env?.base && pub) {
    try {
      const u = new URL(pub);
      if (u.pathname.replace(/\/+$/, '') === c.env.base) origin = u.origin;
    } catch { /* the request's own */ }
  }
  return `${origin}${here(c, '/site')}`;
};

const SIGNUPS = `(select count(distinct a.person_id)::int from site_actions a
   where a.workspace_id = k.workspace_id and a.source = 'kit-' || k.code)`;
const SHARERS = `(select count(distinct a.referrer_id)::int from site_actions a
   where a.workspace_id = k.workspace_id and a.source = 'kit-' || k.code and a.referrer_id is not null)`;

shareApi.get('/share', async (c) => {
  const ctx = c.get('ctx');
  const db = c.get('db');
  const ws = ctx.workspaceId;
  const s = (await db.query('select org, domains from site_settings where workspace_id = $1', [ws])).rows[0];
  if (!s) return c.json({ ready: false });
  const me = await selfPerson(db, ctx, null);
  const code = me
    ? (await db.query("select attrs->>'ref_code' as code from persons where id = $1 and workspace_id = $2", [me.id, ws])).rows[0]?.code || null
    : null;
  const base = baseOf(c, parseJ(s.domains, []));
  const line = await authLine(db, ws);
  const rows = (await db.query(
    'select * from share_kits where workspace_id = $1 and deleted_at is null and open order by created_at desc, id limit 100', [ws],
  )).rows;
  const kits = [];
  for (const k of rows) {
    if (kits.length >= SHARE_MAX) break;
    const page = await kitPage(db, ws, k.path);
    if (!page.live) continue;
    kits.push({
      id: k.id, code: k.code, title: k.title, text: kitText(k, line),
      picture_url: k.media_id ? `/media/${k.media_id}` : null,
      page_title: page.title,
      link: code ? `${base}/r/${code}?k=${k.code}` : null,
    });
  }
  const brought = me
    ? (await db.query(
      'select count(distinct person_id)::int as n from site_actions where workspace_id = $1 and referrer_id = $2', [ws, me.id],
    )).rows[0].n
    : 0;
  return c.json({ code, base, brought, kits });
});

shareApi.get('/share/kits', async (c) => {
  const ctx = c.get('ctx');
  const db = c.get('db');
  const ws = ctx.workspaceId;
  const rows = (await db.query(
    `select k.*, ${SIGNUPS} as signups, ${SHARERS} as sharers from share_kits k
      where k.workspace_id = $1 and k.deleted_at is null order by k.created_at desc, k.id`, [ws],
  )).rows;
  const kits = [];
  for (const k of rows) {
    const page = await kitPage(db, ws, k.path);
    kits.push({ ...kitOut(k), live: page.live, page_title: page.title, signups: k.signups, sharers: k.sharers });
  }
  const pages = [
    { path: '/', title: 'Home' },
    ...(await db.query(
      `select '/' || slug as path, coalesce(nullif(published->>'title', ''), title) as title from site_pages
        where workspace_id = $1 and deleted_at is null and status = 'published' and slug <> 'home'
        order by nav_order, created_at`, [ws],
    )).rows,
    ...(await db.query(
      `select '/act/' || slug as path, title from site_campaigns
        where workspace_id = $1 and deleted_at is null and status = 'open' order by created_at`, [ws],
    )).rows,
  ];
  const ready = Boolean((await db.query('select 1 from site_settings where workspace_id = $1', [ws])).rows[0]);
  return c.json({ ready, line: await authLine(db, ws), pages, kits });
});

shareApi.get('/share/kits/:id', async (c) => {
  const ctx = c.get('ctx');
  const db = c.get('db');
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) return c.json({ error: 'not found' }, 404);
  const k = (await db.query(
    `select k.*, ${SIGNUPS} as signups, ${SHARERS} as sharers from share_kits k
      where k.id = $1 and k.workspace_id = $2 and k.deleted_at is null`, [id, ctx.workspaceId],
  )).rows[0];
  if (!k) return c.json({ error: 'not found' }, 404);
  const page = await kitPage(db, ctx.workspaceId, k.path);
  const sharers = (await db.query(
    `select p.id, p.name, count(distinct a.person_id)::int as signups
       from site_actions a join persons p on p.id = a.referrer_id and p.deleted_at is null
      where a.workspace_id = $1 and a.source = $2
      group by p.id, p.name order by signups desc, ${azKey('p')} limit ${TOP_MAX}`,
    [ctx.workspaceId, `kit-${k.code}`],
  )).rows;
  return c.json({ kit: { ...kitOut(k), live: page.live, page_title: page.title, signups: k.signups, sharers: k.sharers }, top: sharers });
});

shareApi.get('/share/top', async (c) => {
  const ctx = c.get('ctx');
  const db = c.get('db');
  const top = (await db.query(
    `select p.id, p.name, count(distinct a.person_id)::int as n
       from site_actions a join persons p on p.id = a.referrer_id and p.deleted_at is null
      where a.workspace_id = $1 and a.referrer_id is not null
      group by p.id, p.name order by n desc, ${azKey('p')} limit ${TOP_MAX}`,
    [ctx.workspaceId],
  )).rows;
  return c.json({ top });
});

// Today: how many posts are waiting to be shared (the "Share · 2 posts" row).
export const briefShare = async (db, ctx, body) => {
  const ws = ctx.workspaceId;
  if (!(await db.query('select 1 from site_settings where workspace_id = $1', [ws])).rows[0]) return;
  const rows = (await db.query(
    'select path from share_kits where workspace_id = $1 and deleted_at is null and open order by created_at desc limit 100', [ws],
  )).rows;
  let n = 0;
  for (const k of rows) {
    if (n >= SHARE_MAX) break;
    if ((await kitPage(db, ws, k.path)).live) n += 1;
  }
  body.share = { kits: n };
};
