// The campaign's brand on the server (shared/brand.js has the presets and
// the tokens; ext/brand the action and the read). Stored per workspace in
// workspaces.brand (null until a manager saves one).
//
// Before anyone saves, a deployment can be pre-configured from its
// settings (the hosting's environment) — each optional, anything invalid
// ignored:
//
//   BASE_BRAND_PRESET      ground (default) | civic | night | harvest
//   BASE_BRAND_NAME        the name in the top bar (default: the campaign's
//                          own — the workspace's name, else BASE_ORG_NAME)
//   BASE_BRAND_LOGO        https://… (a picture's address)
//   BASE_BRAND_PRIMARY     #rrggbb   — and BASE_BRAND_ACCENT, _SURFACE,
//   BASE_BRAND_INK, _ON_PRIMARY, _ON_ACCENT (the preset fills any not set)
//   BASE_BRAND_FONT        atkinson | public-sans | inter | source-serif | system
//   BASE_BRAND_CORNERS     sharp | soft | round
//
// Once a manager saves a brand (Settings → Brand), the saved one wins.
//
//   brandHead(db)          the <style> for index.html's <head>: the brand's
//                          CSS custom properties, so the page never flashes
//                          the default look; data-name / data-logo /
//                          data-theme carry the name, logo and bar colour to
//                          the sign-in page before anyone signs in
//   effectiveBrand(saved)  the brand in force: the saved one, else settings
//   brandSource(saved)     'saved' | 'settings' | 'default'
//   loadBrand(db, wsId)    { brand, source, name, updatedAt, updatedBy }
//   brandName(brand, ws)   the name to show
//   publicBrand(ws)        { css, name, logo } for the server's own public
//                          pages (lib/publicpage.js, receipts, unsubscribe)
//   assetUrl(path)         a '/media/…' path under BASE_PATH
//   forgetBrandCache()     after a save
import { brandOf, brandCss, tokens, COLOR_KEYS, PRESETS } from '@base-ground/shared/brand';
import { orgName } from './org.js';

const env = (k) => String(process.env[k] || '').trim();
const ENV_KEYS = {
  preset: 'BASE_BRAND_PRESET',
  name: 'BASE_BRAND_NAME',
  logo: 'BASE_BRAND_LOGO',
  primary: 'BASE_BRAND_PRIMARY',
  accent: 'BASE_BRAND_ACCENT',
  surface: 'BASE_BRAND_SURFACE',
  ink: 'BASE_BRAND_INK',
  onPrimary: 'BASE_BRAND_ON_PRIMARY',
  onAccent: 'BASE_BRAND_ON_ACCENT',
  font: 'BASE_BRAND_FONT',
  corners: 'BASE_BRAND_CORNERS',
};
export const BRAND_SETTINGS = Object.values(ENV_KEYS);

// What the settings say, as a partial brand ('#' optional on colours).
export const settingsBrand = () => {
  const out = {};
  for (const [k, name] of Object.entries(ENV_KEYS)) {
    let v = env(name);
    if (!v) continue;
    if (COLOR_KEYS.includes(k) && /^[0-9a-f]{6}$/i.test(v)) v = `#${v}`;
    out[k] = k === 'preset' || k === 'font' || k === 'corners' ? v.toLowerCase() : v;
  }
  if (out.preset && !PRESETS[out.preset]) delete out.preset;
  return Object.keys(out).length ? out : null;
};

const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
export const savedOf = (wsRow) => {
  const b = parse(wsRow?.brand);
  return b && typeof b === 'object' ? b : null;
};

export const brandSource = (saved) => (saved ? 'saved' : settingsBrand() ? 'settings' : 'default');
export const effectiveBrand = (saved) => brandOf(saved || settingsBrand() || {});
export const brandName = (brand, ws) => brand?.name || ws?.name || orgName() || 'Base Ground';

// The server's own paths ('/media/…') under the app's prefix (SUITE.md,
// BASE_PATH). An https:// logo is left as it is.
export const assetUrl = (p) => {
  if (!p) return null;
  if (!p.startsWith('/')) return p;
  const base = env('BASE_PATH').replace(/\/+$/, '');
  return `${base}${p}`;
};

export const loadBrand = async (db, workspaceId) => {
  const row = (await db.query(
    `select w.name, w.brand, w.brand_updated_at, u.name as updated_by
     from workspaces w left join users u on u.id = w.brand_updated_by where w.id = $1`, [workspaceId],
  )).rows[0];
  if (!row) return null;
  const saved = savedOf(row);
  const brand = effectiveBrand(saved);
  return {
    brand,
    source: brandSource(saved),
    name: brandName(brand, row),
    updatedAt: row.brand_updated_at || null,
    updatedBy: row.updated_by || null,
  };
};

const attr = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

// The brand's <style> for a page's <head>. html:root outranks app.css's
// :root defaults wherever the two land in the head.
export const brandStyle = (brand, name) => {
  const t = tokens(brand);
  return `<style id="base-brand" data-name="${attr(name)}" data-logo="${attr(assetUrl(brand.logo) || '')}" data-theme="${attr(t['--nav-bg'])}">${brandCss(brand, 'html:root')}</style>`;
};

// One deployment is one campaign: index.html carries the brand of its
// workspace (the first one made). In a test or dev database with more
// than one, the app applies the signed-in person's own after it loads.
// Kept for a few seconds; a save forgets it at once.
const CACHE_MS = 15_000;
let cache = null;
export const forgetBrandCache = () => { cache = null; };

export const brandHead = async (db) => {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.html;
  // The name: the brand's, else the campaign's; empty before first-run
  // setup names it (the page then says "Base Ground").
  const nameOf = (brand, row) => brand.name || row?.name || orgName() || '';
  let row = null;
  try {
    row = (await db.query('select name, brand from workspaces order by created_at, id limit 1')).rows[0] || null;
  } catch {
    // No answer from the database: the settings' brand, never a broken page.
  }
  const brand = effectiveBrand(savedOf(row));
  const html = brandStyle(brand, nameOf(brand, row));
  // Kept only once the campaign exists (first-run setup is about to name it).
  if (row) cache = { at: Date.now(), html };
  return html;
};

// For the server's own public pages. Their stylesheets read --paper,
// --card, --ink, --ink2, --rule, --mark (the button), --mark-ink, --bad;
// this :root sets them from the brand (and wins over their own dark-mode
// guess: the brand decides light or dark).
export const publicBrand = (ws) => {
  const brand = effectiveBrand(savedOf(ws));
  const t = tokens(brand);
  const vars = {
    '--paper': t['--paper'],
    '--card': t['--paper-0'],
    '--ink': t['--ink'],
    '--ink2': t['--text-3'],
    '--rule': t['--rule-2'],
    '--mark': t['--mark'],
    '--mark-ink': t['--mark-ink'],
    '--accent': t['--accent'],
    '--link': t['--link'],
    '--focus': t['--focus'],
    '--bad': t['--danger'],
    'color-scheme': t['color-scheme'],
  };
  const css = `html:root{${Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(';')}}`;
  return { css, name: brandName(brand, ws), logo: assetUrl(brand.logo), brand };
};

// The campaign line at the top of a public page: the logo (when there is
// one) and the name. esc is the page's own escaper.
export const publicMasthead = (pb, esc) => `<div class="camp">${pb.logo ? `<img class="camp-logo" src="${esc(pb.logo)}" alt="" height="40">` : ''}<span>${esc(pb.name)}</span></div>`;
export const PUBLIC_MASTHEAD_CSS = '.camp{display:flex;align-items:center;gap:12px}.camp-logo{height:40px;width:auto;max-width:160px;object-fit:contain;flex:none}';
