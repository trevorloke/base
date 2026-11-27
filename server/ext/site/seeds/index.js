// A campaign's first website, written once when the campaign has no website
// settings yet (store.js ensureSiteTx): base.js, a clean generic site —
// or, for a campaign whose set-up brings its own website, that one
// (server/lib/preset.js: preset().site.seed, loaded only on that campaign's
// server). Pages and petitions only when it has no pages at all, so a
// campaign that deleted every page never has them put back.
//
// A seed module's default export is (workspace) → {
//   theme, settings: { nav, footer, announcement, seo, org, social },
//   campaigns: [{ slug, kind, title, excerpt, body, statement, goal }],
//   pages: [{ slug, title, description, show_in_nav, nav_order,
//             modules: [{ id, kind, hidden?, props }] }],
// }
// A module prop '@campaign:<slug>' names one of the seed's campaigns; it
// becomes that campaign's id here. Every page is published, its modules
// checked as a publish checks them (strict): a seed that wouldn't pass
// fails loudly (the tests seed both brands).
import { newId } from '../../../lib/events.js';
import { checkModules } from '@starbase/shared/site/catalogue';
import { checkTheme } from '@starbase/shared/site/theme';
import { SECTIONS } from '../shape.js';
import { preset } from '../../../lib/preset.js';
import '../from-preset.js';

// The set-up's own seed only when `brand` names this server's set-up; any
// other name (and every other server) gets base.js.
const load = async (brand) => {
  const p = preset();
  const own = brand === p.key ? p.site.seed : null;
  return own ? (await own()).default : (await import('./base.js')).default;
};

const resolveRefs = (v, ids) => {
  if (typeof v === 'string' && v.startsWith('@campaign:')) {
    const id = ids.get(v.slice('@campaign:'.length));
    if (!id) throw new Error(`site seed: no campaign ${v}`);
    return id;
  }
  if (Array.isArray(v)) return v.map((x) => resolveRefs(x, ids));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveRefs(x, ids)]));
  return v;
};

export const seedFor = async (brand, ws) => (await load(brand))(ws);

export const seedSite = async (tx, ws, emit, brand) => {
  const seed = await seedFor(brand, ws);
  const settings = {};
  for (const k of Object.keys(SECTIONS)) settings[k] = SECTIONS[k].parse(seed.settings?.[k] ?? {});
  const { theme } = checkTheme(seed.theme || {}, brand);
  await tx.query(
    `insert into site_settings (workspace_id, theme, nav, footer, announcement, seo, org, social, domains)
     values ($1, $2, $3, $4, $5, $6, $7, $8, '[]') on conflict (workspace_id) do nothing`,
    [ws.id, JSON.stringify(theme), JSON.stringify(settings.nav), JSON.stringify(settings.footer), JSON.stringify(settings.announcement),
     JSON.stringify(settings.seo), JSON.stringify(settings.org), JSON.stringify(settings.social)],
  );
  emit('site_settings', ws.id, 'create', { seed: brand });

  const anyPages = (await tx.query('select 1 from site_pages where workspace_id = $1 limit 1', [ws.id])).rows[0];
  if (anyPages) return { seeded: brand, pages: 0, campaigns: 0 };

  const ids = new Map();
  for (const c of seed.campaigns || []) {
    const id = newId();
    ids.set(c.slug, id);
    await tx.query(
      `insert into site_campaigns (id, workspace_id, slug, kind, title, excerpt, body, statement, goal, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'open')`,
      [id, ws.id, c.slug, c.kind, c.title, c.excerpt || '', c.body || '', c.statement || '', c.goal ?? null],
    );
    emit('site_campaign', id, 'create', { slug: c.slug, kind: c.kind, title: c.title, seed: brand });
  }
  let order = 0;
  for (const p of seed.pages || []) {
    const id = newId();
    // Complete, though a generic seed's hero holds sample words (its first
    // Publish asks for real ones).
    const modules = checkModules(resolveRefs(p.modules || [], ids), { strict: true, samples: false });
    const content = { title: p.title, description: p.description || '', modules };
    await tx.query(
      `insert into site_pages (id, workspace_id, slug, title, description, draft, published, version, status, show_in_nav, nav_order, published_at)
       values ($1, $2, $3, $4, $5, $6, $6, 1, 'published', $7, $8, now())`,
      [id, ws.id, p.slug, p.title, p.description || '', JSON.stringify(content), Boolean(p.show_in_nav), p.nav_order ?? order],
    );
    order += 1;
    emit('site_page', id, 'create', { slug: p.slug, title: p.title, published: true, version: 1, seed: brand });
  }
  return { seeded: brand, pages: (seed.pages || []).length, campaigns: (seed.campaigns || []).length };
};
