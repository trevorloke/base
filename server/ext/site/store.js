// Reading the website: which campaign a request is for, its settings and
// pages, and the first-use seed. Shared by the admin API, the actions and
// the public routes.
//
// Which campaign: a host listed in some campaign's settings (domains) is
// that campaign's; any other (SITE_HOSTS, or the app's own address at
// /site/) is SITE_WORKSPACE's (a slug) or else the first campaign set up on
// this server — one campaign per deployment (lib/org.js).
import { getDb } from '../../db/client.js';
import { runAction } from '../../lib/events.js';
import { brandKey, brandFor } from '../../lib/brand.js';
import { deriveLook } from '@starbase/shared/brand-look';
import { DEFAULT_TZ } from '../../lib/org.js';
import { checkTheme } from '@starbase/shared/site/theme';
import { SECTION_KEYS, sectionOf, hostOf, consentWording, tagOf } from './shape.js';
import { seedSite } from './seeds/index.js';

export const parseJ = (v, d) => {
  if (v == null) return d;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return d; }
};
const iso = (d) => (d instanceof Date ? d.toISOString() : d ? new Date(d).toISOString() : null);

// ── Hosts ──
// SITE_HOSTS and APP_HOSTS are the operator's: host names or addresses,
// comma-separated (127.0.0.1 for a test), a final dot or not.
const hostList = (raw) => String(raw || '').split(',')
  .map((h) => h.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/\.+$/, ''))
  .filter((h) => /^[a-z0-9.-]{1,253}$/.test(h));
export const envHosts = () => hostList(process.env.SITE_HOSTS);

// Where the app itself answers — never a website domain (on one of those
// only the site answers: no sign-in, no app): base.win and its subdomains
// (the front door), this server's public address (STARBASE_PUBLIC_URL), its
// host's own name (RENDER_EXTERNAL_HOSTNAME) and its other addresses
// (APP_HOSTS: one people used before base.win, say). site.settings.save
// refuses these and the host the save came in on; a domain saved as one
// before is ignored below, so the app can't be locked out of its address.
const DOOR = 'base.win';
export const appHosts = () => {
  const out = [DOOR];
  try {
    const h = new URL(String(process.env.STARBASE_PUBLIC_URL || '').trim()).hostname.toLowerCase().replace(/\.+$/, '');
    if (h && !out.includes(h)) out.push(h);
  } catch { /* not set */ }
  const r = hostOf(process.env.RENDER_EXTERNAL_HOSTNAME);
  if (r && !out.includes(r)) out.push(r);
  for (const h of hostList(process.env.APP_HOSTS)) if (!out.includes(h)) out.push(h);
  return out;
};
export const isAppHost = (host, also = []) => {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  return Boolean(h) && (h === DOOR || h.endsWith(`.${DOOR}`) || appHosts().includes(h) || also.includes(h));
};

// Every address people use the app at, as the API sees them signed in
// (routes/api.js, and /api/auth/me as the app opens), kept in app_hosts:
// the operator may not have listed them all, and site.settings.save refuses
// those too. Written before the answer, at most once an hour per address by
// this server; a write that fails is logged once, never fails the request,
// and is tried again by the next request there.
const HOUR = 3600_000;
const noted = new Map(); // host → when this server last wrote it
let noteFailed = false;
export const noteAppHost = async (db, host) => {
  const h = hostOf(host);
  if (!h || Date.now() - (noted.get(h) || 0) < HOUR) return;
  if (noted.size > 1000) noted.clear();
  noted.set(h, Date.now());
  try {
    await db.query('insert into app_hosts (host) values ($1) on conflict (host) do update set last_seen = now()', [h]);
  } catch (e) {
    // Not written: no hour's wait for the next try, or a save in that hour
    // could make an address people use the app at the website.
    noted.delete(h);
    if (!noteFailed) console.error(`site: couldn’t note where the app answers (${h}): ${e.message}`);
    noteFailed = true;
  }
};
// When people last used the app at a host (null: never, since it was noted).
export const appHostSeen = async (q, host) => (await q.query('select last_seen from app_hosts where host = $1', [host])).rows[0]?.last_seen || null;
// A day as people say it, in the campaign's time zone: November 9, 2026.
const dayOf = (d, ctx) => new Date(d).toLocaleDateString('en-CA', { timeZone: ctx.workspace?.settings?.tz || DEFAULT_TZ, month: 'long', day: 'numeric', year: 'numeric' });
// Why such an address is no website domain: the save's refusal (actions.js)
// and the Website screen's as it's typed (usedHosts) — the same words.
export const usedWhy = (host, seen, ctx) => `People used base.win at ${host} (last on ${dayOf(seen, ctx)}), so the app still answers there. If it should now be only the website, ask whoever runs the server to add it to SITE_HOSTS.`;
// The addresses a save refuses for that, and why ({ host, why }), so the
// Website screen refuses them as they're typed: every one noted but where
// the app itself answers (refused in words of its own) and the site's own
// already (saved, or SITE_HOSTS). The newest 200, and none when the read
// fails (never failing the screen): the save checks them all.
export const usedHosts = async (q, ctx, saved = []) => {
  const site = [...saved, ...envHosts()];
  const rows = await q.query('select host, last_seen from app_hosts order by last_seen desc limit 200').then((r) => r.rows, () => []);
  return rows.filter((r) => !site.includes(r.host) && !isAppHost(r.host, ctx.host ? [ctx.host] : []))
    .map((r) => ({ host: r.host, why: usedWhy(r.host, r.last_seen, ctx) }));
};

const DOMAINS_MS = 30_000;
let domainMap = null; // host → { workspaceId, siteId, gone }
let domainsAt = 0;
let refreshing = null;

// Every website address on this server, in this order — an address already
// set is never taken by a later one: the campaigns' main sites (SITE_HOSTS
// are read in siteHost), their other websites' addresses, then the
// addresses those once had and still close (held_domains, and a deleted
// website's): those answer "This website has closed" (gone), never the
// app. The app's own addresses are never in it.
const loadDomains = async () => {
  const db = await getDb();
  const map = new Map();
  const put = (h0, v) => {
    const h = hostOf(h0);
    if (h && !isAppHost(h) && !map.has(h)) map.set(h, v);
  };
  const rows = (await db.query(
    "select workspace_id, domains from site_settings where jsonb_typeof(domains) = 'array' and jsonb_array_length(domains) > 0",
  )).rows;
  for (const r of rows) for (const d of parseJ(r.domains, [])) put(d, { workspaceId: r.workspace_id, siteId: null, gone: false });
  const micro = await db.query('select id, workspace_id, domains, held_domains, deleted_at from microsites order by created_at, id').then((r) => r.rows, () => []);
  for (const m of micro) {
    if (!m.deleted_at) for (const d of parseJ(m.domains, [])) put(d, { workspaceId: m.workspace_id, siteId: m.id, gone: false });
  }
  for (const m of micro) {
    for (const d of [...parseJ(m.held_domains, []), ...(m.deleted_at ? parseJ(m.domains, []) : [])]) {
      put(d, { workspaceId: m.workspace_id, siteId: m.id, gone: true });
    }
  }
  domainMap = map;
  domainsAt = Date.now();
};

// The campaigns' own domains, read at most every 30 s (and at once after a
// settings save, forgetDomains). A database that doesn't answer in 2 s
// leaves the last list in place: the app's own routes never wait on it.
const domains = async () => {
  if (domainMap && Date.now() - domainsAt < DOMAINS_MS) return domainMap;
  if (!refreshing) {
    refreshing = new Promise((resolve) => {
      const t = setTimeout(resolve, 2000);
      t.unref?.();
      loadDomains().catch(() => { domainsAt = Date.now() - DOMAINS_MS + 5000; }).finally(() => { clearTimeout(t); resolve(); });
    }).finally(() => { refreshing = null; });
  }
  await refreshing;
  return domainMap || new Map();
};
export const forgetDomains = () => { domainsAt = 0; };

// The host a request came to: lowercase, no port, no dots at the end — a
// browser sends imaginesurrey.ca. as it was typed, and it is
// imaginesurrey.ca. The site gate and the noting both read it here, so a
// website domain is the site's however it's written, and never noted as
// the app's.
export const hostOfRequest = (c) => {
  try { return new URL(c.req.url).hostname.toLowerCase().replace(/\.+$/, ''); } catch { return ''; }
};

// → { host, workspaceId, siteId, gone } when this request is to a website's
// own domain (workspaceId null: SITE_HOSTS, the default campaign; siteId:
// another website of the campaign, null for the main one; gone: an address
// a closed or moved website still holds), else null.
export const siteHost = async (c) => {
  const host = hostOfRequest(c);
  if (!host) return null;
  if (envHosts().includes(host)) {
    const map = domainMap && Date.now() - domainsAt < DOMAINS_MS ? domainMap : null;
    const at = map?.get(host);
    return { host, workspaceId: at && !at.siteId ? at.workspaceId : null, siteId: null, gone: false };
  }
  const map = await domains();
  return map.has(host) ? { host, ...map.get(host) } : null;
};

// The main site's public address, for another website's link back, its
// privacy link and a petition's canonical address: its first saved domain,
// else the first SITE_HOSTS, else the app's own /site (fallback: the
// request's origin and the client's path, when STARBASE_PUBLIC_URL isn't set).
export const mainAddress = (settings, fallback = '') => {
  const saved = (Array.isArray(settings?.domains) ? settings.domains : []).map(hostOf).find(Boolean);
  if (saved) return `https://${saved}`;
  const env = envHosts().find((h) => hostOf(h));
  if (env) return `https://${env}`;
  try {
    const u = new URL(String(process.env.STARBASE_PUBLIC_URL || '').trim());
    if (/^https?:$/.test(u.protocol)) return `${u.origin}${u.pathname.replace(/\/+$/, '')}/site`;
  } catch { /* not set */ }
  return fallback;
};

// ── The campaign ──
const WS_COLS = 'id, name, slug, jurisdiction, settings';
export const siteWorkspace = async (db, workspaceId = null) => {
  let row = null;
  if (workspaceId) row = (await db.query(`select ${WS_COLS} from workspaces where id = $1`, [workspaceId])).rows[0];
  const slug = String(process.env.SITE_WORKSPACE || '').trim();
  if (!row && slug) row = (await db.query(`select ${WS_COLS} from workspaces where slug = $1`, [slug])).rows[0];
  if (!row) row = (await db.query(`select ${WS_COLS} from workspaces order by created_at, id limit 1`)).rows[0];
  return row ? { ...row, settings: parseJ(row.settings, {}) } : null;
};

// ── First use: the brand's site (seeds/<brandKey()>.js) ──
// A campaign with no website settings gets them, and — when it has no pages
// at all — its brand's pages and petitions, in the same write.
export const ensureSiteTx = async (tx, ws, emit) => {
  const has = (await tx.query('select 1 from site_settings where workspace_id = $1', [ws.id])).rows[0];
  if (has) return false;
  await seedSite(tx, ws, emit, brandKey());
  return true;
};
export const ensureSite = async (db, ws, actorId = null) => {
  const has = (await db.query('select 1 from site_settings where workspace_id = $1', [ws.id])).rows[0];
  if (has) return false;
  const { result } = await runAction(db, { workspaceId: ws.id, actorId, action: 'site.seed' }, (tx, emit) => ensureSiteTx(tx, ws, emit));
  return result;
};

// ── Settings ──
export const readSettings = async (q, workspaceId) => {
  const r = (await q.query('select * from site_settings where workspace_id = $1', [workspaceId])).rows[0];
  if (!r) return null;
  const out = { theme: parseJ(r.theme, {}), domains: parseJ(r.domains, []), updated_at: iso(r.updated_at) };
  for (const k of SECTION_KEYS) out[k] = sectionOf(k, parseJ(r[k], {}));
  return out;
};

// The published pages marked "show in menu", in their order — by their
// published title (a draft's new title isn't on the site yet).
// siteId: another website's (null: the main site's).
export const menuPages = async (q, workspaceId, siteId = null) => (await q.query(
  `select slug, coalesce(nullif(published->>'title', ''), title) as title from site_pages
    where workspace_id = $1 and deleted_at is null and status = 'published' and show_in_nav
      and site_id is not distinct from $2::uuid
    order by nav_order, created_at`, [workspaceId, siteId],
)).rows;

// The website's theme as the campaign's brand makes it (lib/brand.js, the
// shades by shared/brand-look.js): the brand colour and the text on it, the
// second colour as the accent, the brand as words for links, the brand for
// the buttons that ask for something, the app's neutral grounds, its
// heading face and corners, and its logo (the site's own when the brand has
// none). What a website that follows the brand wears, and what "Give the
// website its own look" starts from.
export const themeFromBrand = (brand, own, name = '') => {
  const l = deriveLook(brand, 'light');
  const { theme } = checkTheme({
    ...own,
    colors: {
      brand: l.accent, brandInk: l.accentInk, accent: l.second, accentInk: l.secondInk,
      ink: l.text, paper: l.card, surface: l.panel, line: l.line, link: l.accentWords,
      action: l.accent, actionInk: l.accentInk,
    },
    fonts: { heading: l.heading, body: 'inter' },
    radius: l.corners,
    logo: brand.publicLogo ? { url: brand.publicLogo, alt: name } : own?.logo,
    pop: false,
    follow: own?.follow === true,
  }, brandKey());
  return theme;
};

// What the renderer gets as `site` (SITE.md): the theme checked, the menu
// with the pages that ask to be in it, and the consent boxes' words. The
// nav in the renderer's own words (SITE.md "Rendering": items, bar, cta):
// Settings' menu is the Menu's items, its links the title bar's.
// campaign: the workspace ({ name, settings }) — a website that follows the
// campaign's brand wears it (and the logo for dark backgrounds in its dark
// footer), and every website gets the campaign's mark as its icon.
// micro: another website of the campaign ({ microsite, home, parentUrl },
// public.js) — its own look, name and menu (its pages marked "In the
// menu"); search and sharing from its home page; the organization, its
// social accounts, the consent words and the footer's bottom lines are the
// main site's, so every website names the same sponsor.
export const siteOf = (settings, pages = [], campaign = null, micro = null) => {
  if (micro) return microSiteOf(settings, pages, campaign, micro);
  const own = checkTheme(settings.theme, brandKey()).theme;
  const brand = campaign ? brandFor(parseJ(campaign.settings, {})) : null;
  const following = Boolean(own.follow && brand);
  const theme = following ? themeFromBrand(brand, own, campaign.name || '') : own;
  const footer = following && brand.publicLogoDark ? { ...settings.footer, logo: { url: brand.publicLogoDark, alt: campaign.name || '' } } : settings.footer;
  const listed = new Set(settings.nav.menu.map((l) => l.href));
  const extra = pages
    .map((p) => ({ label: p.title, href: p.slug === 'home' ? '/' : `/${p.slug}` }))
    .filter((l) => !listed.has(l.href));
  return {
    theme,
    nav: { items: [...settings.nav.menu, ...extra], bar: settings.nav.links, cta: settings.nav.cta },
    footer,
    icon: brand?.siteIcon || null,
    announcement: settings.announcement,
    seo: settings.seo,
    org: settings.org,
    social: settings.social,
    consent: consentWording(settings.org, settings.seo),
  };
};

const absolutely = (href, base) => (typeof href === 'string' && /^\/(?!\/)/.test(href) && base ? `${base}${href}` : href);
const microSiteOf = (settings, pages, campaign, { microsite, home, parentUrl }) => {
  const main = siteOf(settings, [], campaign);
  const theme = checkTheme({ ...parseJ(microsite.theme, {}), follow: false }, brandKey()).theme;
  const hero = (home?.modules || []).find((m) => m?.kind === 'hero' && !m.hidden);
  const heroImage = hero?.props?.image?.url ? hero.props.image : null;
  const orgName = settings.org.name || campaign?.name || '';
  return {
    theme,
    nav: { items: pages.map((p) => ({ label: p.title, href: p.slug === 'home' ? '/' : `/${p.slug}` })), bar: [], cta: null },
    footer: { acknowledgement: '', links: [], logo: main.footer.logo },
    icon: main.icon,
    announcement: { enabled: false },
    seo: {
      title: home?.title || microsite.name,
      description: home?.description || '',
      shareImage: home?.image?.url ? home.image : heroImage || settings.seo.shareImage,
    },
    // The main site's, with its own links made absolute on the main site.
    org: { ...settings.org, privacyUrl: absolutely(settings.org.privacyUrl, parentUrl), platformUrl: '' },
    social: settings.social,
    consent: consentWording(settings.org, settings.seo),
    site: { name: microsite.name, key: microsite.key },
    parent: { name: orgName, url: parentUrl },
  };
};

// ── Pages, posts, campaigns as the admin sees them ──
const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
export const pageOut = (r, { full = true } = {}) => {
  const draft = parseJ(r.draft, {});
  const published = parseJ(r.published, null);
  const out = {
    id: r.id, slug: r.slug, title: r.title, description: r.description || '', status: r.status, version: Number(r.version) || 0,
    site_id: r.site_id || null, // another website's page (microsites), else the main site's
    show_in_nav: Boolean(r.show_in_nav), nav_order: Number(r.nav_order) || 0,
    published_at: iso(r.published_at), created_at: iso(r.created_at), updated_at: iso(r.updated_at),
    // Saved since the last publish (or never published).
    changed: !published || !sameJson(draft, published),
    modules: Array.isArray(draft.modules) ? draft.modules.length : 0,
  };
  return full ? { ...out, draft, published } : out;
};
export const postOut = (r, { full = true } = {}) => ({
  id: r.id, slug: r.slug, title: r.title, excerpt: r.excerpt || '', image: parseJ(r.image, {}) || {},
  status: r.status, published_at: iso(r.published_at), created_at: iso(r.created_at), updated_at: iso(r.updated_at),
  ...(full ? { body: r.body || '' } : {}),
});
// signers_tag: the tag a signature puts on the person (forms.js) — People
// lists who signed with ?tag= (the Website screen links there).
export const campaignOut = (r, { full = true } = {}) => ({
  id: r.id, slug: r.slug, kind: r.kind, title: r.title, excerpt: r.excerpt || '', statement: r.statement || '',
  goal: r.goal == null ? null : Number(r.goal), status: r.status, signatures: Number(r.signatures) || 0,
  created_at: iso(r.created_at), updated_at: iso(r.updated_at), signers_tag: tagOf('Signed: ', r.title),
  ...(full ? { body: r.body || '' } : {}),
});

// Signatures: the people who signed (a second signature by the same person
// counts once).
export const SIGNATURES_SQL = `(select count(distinct a.person_id)::int from site_actions a
  where a.workspace_id = c.workspace_id and a.campaign_id = c.id and a.kind in ('petition', 'pledge'))`;
