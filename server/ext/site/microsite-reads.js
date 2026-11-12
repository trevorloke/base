// The Website area's reads of the campaign's other websites (SITE.md "Other
// websites"), mounted on api.js's /site (so the 'site' area guard covers
// them). Counts only, never people: anyone with the area may see how many
// signed and where they came from, and the People filter (web=site:<id>,
// its own rules) is where names are. The money forms (join, donate) are
// left out for anyone who can't open Donations, as the filter does.
//
//   GET /site/microsites       { microsites: [{ …, signups_7, signups_30,
//                              home }], closed: [deleted websites that still
//                              hold an address], limit }
//   GET /site/microsites/:id   { microsite, deleted, pages, home, checklist,
//                              signups_7, signups_30, sources: [{ source, n }]
//                              (top 8, 30 days), render_host, urls, brand_theme }
//   GET /site/microsites/host?host=&id=   { host, why } — the domain save's
//                              own refusal for an address, as it's typed
import { areasFor } from '../../lib/perms.js';
import { here } from '../../lib/mount.js';
import { brandFor } from '../../lib/brand.js';
import { hostOf } from './shape.js';
import { readSettings, pageOut, parseJ, themeFromBrand } from './store.js';
import { micrositeOut, liveChecklist, hostProblem, MAX_SITES } from './microsites.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONEY = ['join', 'donate'];

// The kinds this viewer may count: every one, or none of the money forms.
const kindsWhere = (ctx, params) => {
  if (areasFor(ctx).includes('money')) return '';
  params.push(MONEY);
  return ` and a.kind <> all($${params.length}::text[])`;
};

const signups = async (db, ctx, ws, ids) => {
  if (!ids.length) return new Map();
  const params = [ws, ids];
  const not = kindsWhere(ctx, params);
  const rows = (await db.query(
    `select a.site_id::text as id,
            count(*) filter (where a.created_at > now() - interval '7 days')::int as n7,
            count(*)::int as n30
       from site_actions a
      where a.workspace_id = $1 and a.site_id = any($2::uuid[]) and a.created_at > now() - interval '30 days'${not}
      group by a.site_id`, params,
  )).rows;
  return new Map(rows.map((r) => [r.id, r]));
};

const homeOf = async (db, ws, siteId) => {
  const r = (await db.query(
    "select id, status from site_pages where workspace_id = $1 and site_id = $2 and slug = 'home' and deleted_at is null", [ws, siteId],
  )).rows[0];
  return r ? { id: r.id, status: r.status } : null;
};

const brief = (r) => {
  const { theme, ...rest } = micrositeOut(r); // eslint-disable-line no-unused-vars
  return rest;
};

export const mountMicrositeReads = (api, opened) => {
  api.get('/site/microsites', async (c) => {
    const ws = await opened(c);
    const db = c.get('db');
    const ctx = c.get('ctx');
    const rows = (await db.query(
      'select * from microsites where workspace_id = $1 and deleted_at is null order by created_at, id', [ws],
    )).rows;
    const counts = await signups(db, ctx, ws, rows.map((r) => r.id));
    const microsites = [];
    for (const r of rows) {
      const n = counts.get(r.id) || {};
      microsites.push({ ...brief(r), signups_7: n.n7 || 0, signups_30: n.n30 || 0, home: await homeOf(db, ws, r.id) });
    }
    // A deleted website's addresses stay closed until a manager releases
    // them (or restores it): listed so that can be done.
    const closed = (await db.query(
      `select * from microsites where workspace_id = $1 and deleted_at is not null
          and (jsonb_array_length(domains) > 0 or jsonb_array_length(held_domains) > 0)
        order by deleted_at desc limit 20`, [ws],
    )).rows.map(brief);
    return c.json({ microsites, closed, limit: MAX_SITES });
  });

  // Before /:id. The save's own words, for an address as it's typed.
  api.get('/site/microsites/host', async (c) => {
    const ws = await opened(c);
    const raw = String(c.req.query('host') || '').slice(0, 300);
    const h = hostOf(raw);
    if (!h) return c.json({ host: null, why: raw.trim() ? 'A web address, like yourcampaign.ca' : null });
    const id = UUID.test(c.req.query('id') || '') ? c.req.query('id') : null;
    const had = id ? parseJ((await c.get('db').query('select domains from microsites where id = $1 and workspace_id = $2', [id, ws])).rows[0]?.domains, []) : [];
    const p = await hostProblem(c.get('db'), c.get('ctx'), h, { selfMicro: id, already: had });
    return c.json({ host: h, why: p.why || null });
  });

  api.get('/site/microsites/:id', async (c) => {
    if (!UUID.test(c.req.param('id'))) return c.json({ error: 'not found' }, 404);
    const ws = await opened(c);
    const db = c.get('db');
    const ctx = c.get('ctx');
    const r = (await db.query('select * from microsites where id = $1 and workspace_id = $2', [c.req.param('id'), ws])).rows[0];
    if (!r) return c.json({ error: 'That website is gone — reload' }, 404);
    const pages = (await db.query(
      `select * from site_pages where workspace_id = $1 and site_id = $2 and deleted_at is ${r.deleted_at ? 'not null' : 'null'}
        order by nav_order, created_at`, [ws, r.id],
    )).rows.map((p) => pageOut(p, { full: false }));
    const n = (await signups(db, ctx, ws, [r.id])).get(r.id) || {};
    const params = [ws, r.id];
    const not = kindsWhere(ctx, params);
    const sources = (await db.query(
      `select coalesce(nullif(a.source, ''), 'direct') as source, count(*)::int as n from site_actions a
        where a.workspace_id = $1 and a.site_id = $2 and a.created_at > now() - interval '30 days'${not}
        group by 1 order by n desc, source limit 8`, params,
    )).rows;
    const checklist = (await liveChecklist(db, ws, r.id)).map(({ key, done, why }) => ({ key, done, why }));
    const out = micrositeOut(r);
    const campaign = ctx.workspace;
    const settings = await readSettings(db, ws);
    return c.json({
      microsite: out,
      deleted: Boolean(r.deleted_at),
      pages,
      home: pages.find((p) => p.slug === 'home') || null,
      checklist,
      signups_7: n.n7 || 0,
      signups_30: n.n30 || 0,
      sources,
      // Where the domain's DNS points (Render's own name for the service).
      render_host: hostOf(process.env.RENDER_EXTERNAL_HOSTNAME) || null,
      urls: {
        site: here(c, `/site/sites/${r.key}/`),
        domains: out.domains.map((d) => `https://${d}/`),
      },
      // "Start from the campaign's brand" (Look) copies this once.
      brand_theme: themeFromBrand(brandFor(campaign.settings), settings?.theme || {}, campaign.name),
    });
  });
};
