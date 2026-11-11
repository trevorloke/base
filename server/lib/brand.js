// The brand the campaign wears. Until a manager saves one (Settings → Brand,
// ext/brand), it is one of the two built-in looks (shared/brand.js BRANDS —
// Imagine Surrey's own, or base.win's), each a preset through the one rule
// that turns a brand colour into every shade on screen
// (shared/brand-look.js). Once saved, the saved brand is the look:
// STARBASE_BRAND only chooses the preset a campaign STARTS from.
//
//   STARBASE_BRAND   imagine-surrey | base. Unset, it is worked out, so a
//                    deployment that never heard of this setting starts where
//                    it always did:
//                      staging (STARBASE_ENV=staging)             → base
//                      a campaign named anything but Imagine Surrey → base
//                      otherwise (Imagine Surrey, or no name set)  → imagine-surrey
//
// The app's page (index.html) leaves marked <html data-brand="…"> (the
// preset it started from), with the brand's shades written into it as CSS
// variables (before the stylesheets, so it never paints in another look),
// its logo asked for early, its icons, the browser's bar colours and the
// name under the home-screen icon — and so does the install manifest. A
// saved brand also rides in the page as window.__BRAND__ (what script needs:
// the logos, the sidebar, what training is called; web/src/brand.js). The
// base preset's shades are the ones app.css already holds, so its page
// carries no block. Signed out, it is the same page: sign-in wears the brand.
// (Under a client's path, lib/mount.js then adds the path to every address
// in an attribute; the block has no address in it, and the app puts the
// path in front of the ones in window.__BRAND__ itself.)
//
// Every value that reaches the page is checked here on the way out, whatever
// is stored: colours are six-digit hex, choices come from fixed lists,
// pictures are ids, words are escaped — a saved brand can never put markup,
// script or CSS into a page.
import { APP_NAME, BRANDS } from '@starbase/shared/brand';
import { deriveLook, lookCss, lookChrome, SIDEBARS, CORNERS, HEADINGS } from '@starbase/shared/brand-look';
import { envName, orgName } from './org.js';
import { getDb } from '../db/client.js';

export const brandKey = () => {
  const set = String(process.env.STARBASE_BRAND || '').trim().toLowerCase();
  if (BRANDS[set]) return set;
  if (envName() === 'staging') return 'base';
  const org = String(orgName() || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (org && org !== 'imagine surrey') return 'base';
  return 'imagine-surrey';
};

// ── A saved brand, read back ──
const HEX = /^#[0-9a-f]{6}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PICTURE_TYPES = ['png', 'jpg', 'webp'];
const ICONS = ['i192', 'i512', 'maskable', 'touch'];
const hexOf = (v) => { const s = String(v ?? '').trim().toLowerCase(); return HEX.test(s) ? s : null; };
const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);
const size = (n) => (Number.isInteger(n) && n > 0 && n <= 20000 ? n : null);
// Words people read (under the icon, in the menu): no control or
// direction-changing characters, one line, at most max long.
export const plainWords = (s, max) => (typeof s === 'string'
  ? s.replace(/[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const picture = (p) => (p && typeof p === 'object' && UUID.test(String(p.id || '').toLowerCase()) && PICTURE_TYPES.includes(p.type)
  ? { id: String(p.id).toLowerCase(), type: p.type, w: size(p.w), h: size(p.h) } : null);
const iconIds = (icons) => (icons && typeof icons === 'object' && ICONS.every((k) => UUID.test(String(icons[k] || '').toLowerCase()))
  ? Object.fromEntries(ICONS.map((k) => [k, String(icons[k]).toLowerCase()])) : null);

// What the shades are worked out from, and with them the browser's bar
// colours, the brand as words (an email's links) and as an edge (a rule on
// white) — each readable on a light ground by the rule.
// sideDark: the sidebar and the phone's top bar are a dark ground in both
// schemes (a dark sidebar, or a brand colour that takes white text) — the
// logo for dark backgrounds goes there; a pale brand colour is a light one.
const derived = (b) => {
  const light = deriveLook(b, 'light');
  const sideDark = light.sidebar !== 'light' && light.side.ink === '#ffffff';
  return { ...b, ...lookChrome(b), sideDark, link: light.accentWords, edge: light.accentEdge, css: lookCss(b) };
};

// A preset as the campaign wears it before anything is saved: its own
// pictures (bundled files, at the same address on the app and the website),
// base.win under the home-screen icon, no email header.
const presets = new Map();
const presetBrand = (key = brandKey()) => {
  if (!presets.has(key)) {
    const p = BRANDS[key] || BRANDS.base;
    presets.set(key, derived({
      ...p, saved: false, shortName: APP_NAME, title: APP_NAME, emailHeader: false,
      publicLogo: p.logo, publicLogoDark: p.logoDark, emailLogo: null, logoSize: null, mark: null, siteIcon: null,
    }));
  }
  return presets.get(key);
};

// A brand a manager saved (workspaces.settings.brand, ext/brand): complete in
// itself. Its pictures are the campaign's uploads: at /brand/<id> in the
// app (the service worker keeps them for no signal, sw.js) and at
// /media/<id> on the public pages, the website and in emails (the same
// bytes; /media answers on the campaign's own domain too).
const savedBrand = (s, key) => {
  const start = BRANDS[key] || BRANDS.base;
  const logo = picture(s.logo);
  const logoDark = picture(s.logoDark);
  const mark = picture(s.mark);
  const icons = iconIds(s.icons);
  const app = (p) => (p ? `/brand/${p.id}.${p.type}` : null);
  const pub = (p) => (p ? `/media/${p.id}.${p.type}` : null);
  const shortName = plainWords(s.shortName, 30) || APP_NAME;
  // No mark: the icons of the look it started from, as its colour and
  // training's name fall back to that look (Imagine Surrey keeps its star).
  const own = start;
  return derived({
    key: BRANDS[key] ? key : 'base',
    saved: true,
    color: hexOf(s.color) || start.color,
    second: hexOf(s.second),
    sidebar: oneOf(s.sidebar, SIDEBARS, 'light'),
    corners: oneOf(s.corners, Object.keys(CORNERS), 'soft'),
    heading: oneOf(s.heading, HEADINGS, 'inter'),
    learn: plainWords(s.learn, 40) || start.learn,
    shortName,
    // The tab's name: the campaign's, with base.win after it.
    title: shortName === APP_NAME ? APP_NAME : `${shortName} — ${APP_NAME}`,
    emailHeader: s.emailHeader === true,
    logo: app(logo),
    logoDark: app(logoDark),
    logoSize: logo?.w && logo?.h ? { w: logo.w, h: logo.h } : null,
    mark: app(mark),
    publicLogo: pub(logo),
    publicLogoDark: pub(logoDark),
    // Mail apps draw PNG and JPG; many don't draw WebP.
    emailLogo: logo && logo.type !== 'webp' ? pub(logo) : null,
    icon: icons ? { href: `/brand/${icons.i192}.png`, type: 'image/png' } : own.icon,
    touchIcon: icons ? `/brand/${icons.touch}.png` : own.touchIcon,
    icons: icons ? [
      { src: `/brand/${icons.i192}.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: `/brand/${icons.i512}.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: `/brand/${icons.maskable}.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ] : own.icons,
    siteIcon: icons ? { icon: `/media/${icons.i192}.png`, touch: `/media/${icons.touch}.png` } : null,
    sitePlaceholder: start.sitePlaceholder,
    sampleLede: start.sampleLede,
  });
};

// A campaign's brand from its settings: the saved one, or the preset it
// starts from. Worked out once per brand (the shades take a few
// milliseconds), so public pages and emails can ask freely.
const resolved = new Map();
export const brandFor = (settings, key = brandKey()) => {
  const s = settings?.brand;
  if (!s || typeof s !== 'object' || s.v !== 1) return presetBrand(key);
  const id = `${key}|${JSON.stringify(s)}`;
  if (!resolved.has(id)) {
    if (resolved.size >= 50) resolved.clear();
    resolved.set(id, savedBrand(s, key));
  }
  return resolved.get(id);
};
// The preset alone, for code with no campaign's settings at hand (prefer
// brandFor(settings): it is the saved brand when there is one).
export const brand = () => presetBrand();
// What the campaign's training is called (the Learn area): "ImagineU" for
// Imagine Surrey's look, "Training" for base.win's, or what a manager set.
export const learnName = (settings) => brandFor(settings).learn;

// ── The campaign's brand, for pages nobody signed in to (the app's page,
// the manifest): the first workspace's, as the sign-in page takes its name.
// One campaign per deployment. Kept for a minute and dropped when a manager
// saves (ext/brand); a database slow to answer gets the brand last seen (or
// the preset) rather than an app that won't open.
const BRAND_TTL_MS = 60_000;
const SLOW_MS = 2_000;
let known = null; // { brand, at }: the copy kept for a minute
let lastSeen = null; // the brand last read, for a database slow to answer
let reading = null;
let generation = 0;
// After a save: the copy goes, and so does a read already under way (it may
// have taken the row before the save), so the next page reads afresh.
export const forgetBrand = () => { known = null; reading = null; generation += 1; };
const readBrand = async () => {
  const db = await getDb();
  const row = (await db.query('select settings from workspaces order by created_at, id limit 1')).rows[0];
  const settings = typeof row?.settings === 'string' ? JSON.parse(row.settings) : (row?.settings || {});
  return brandFor(settings);
};
export const campaignBrand = async () => {
  if (known && Date.now() - known.at < BRAND_TTL_MS) return known.brand;
  const fallback = () => lastSeen || presetBrand();
  if (!reading) {
    const gen = generation;
    const read = readBrand().then((b) => {
      if (gen === generation) { known = { brand: b, at: Date.now() }; lastSeen = b; }
      return b;
    });
    reading = read;
    read.catch(() => {}).finally(() => { if (reading === read) reading = null; });
  }
  let timer;
  const slow = new Promise((resolve) => { timer = setTimeout(resolve, SLOW_MS); timer.unref?.(); });
  try {
    return await Promise.race([reading.catch(fallback), slow.then(fallback)]);
  } finally {
    clearTimeout(timer);
  }
};

// ── Into the page ──
const attr = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
// JSON that can sit in a <script>: nothing in it can close the element, start
// a comment, or look like an attribute to lib/mount.js.
const scriptJson = (v) => JSON.stringify(v).replace(/[<>&'\u2028\u2029]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
const BASE_CSS = presetBrand('base').css;

// What script needs of a saved brand (web/src/brand.js): no address in it
// but the campaign's own pictures, which the app puts its path in front of.
const forScript = (b) => ({
  key: b.key, saved: true, color: b.color, second: b.second, sidebar: b.sidebar, sideDark: b.sideDark, corners: b.corners, heading: b.heading,
  learn: b.learn, shortName: b.shortName, logo: b.logo, logoDark: b.logoDark, logoSize: b.logoSize, mark: b.mark,
});

// What goes into the page's head for a brand: its shades (none when they are
// app.css's own), a saved brand's data, and its logo asked for early — which
// is also how the service worker learns which pictures to keep for no
// signal (sw.js). So is a heading face from outside the app's /fonts/: the
// website's Montserrat (web/public/fonts/fonts.css declares it).
const MONTSERRAT = '/site-assets/fonts/montserrat-latin.woff2';
const brandHead = (b) => {
  const out = [];
  if (b.css !== BASE_CSS) out.push(`<style id="brand">${b.css}</style>`);
  if (b.saved) out.push(`<script id="brand-data">window.__BRAND__=${scriptJson(forScript(b))}</script>`);
  // On a dark sidebar both logos are on screen whatever the scheme.
  if (b.logo) out.push(`<link rel="preload" as="image" href="${attr(b.logo)}" data-brand${b.logoDark && !b.sideDark ? ' media="(prefers-color-scheme: light)"' : ''} />`);
  if (b.logoDark) out.push(`<link rel="preload" as="image" href="${attr(b.logoDark)}" data-brand${b.sideDark ? '' : ' media="(prefers-color-scheme: dark)"'} />`);
  if (b.heading === 'montserrat') out.push(`<link rel="preload" as="font" type="font/woff2" href="${MONTSERRAT}" crossorigin data-brand />`);
  return out.join('');
};

const asBrand = (b) => (b?.css ? b : derived({ ...presetBrand(b?.key || 'base'), ...b }));

// index.html as built → the campaign's: the mark on <html>, the shades, the
// tab's icon and title, the home-screen icon and name, the browser's bar
// colours. b: the campaign's brand (campaignBrand, brandFor) or a preset.
// Each piece goes in by a function, never as a replacement string, which
// would read a name's "$'" or "$`" as "copy the page here".
export const brandHtml = (html, brand = presetBrand()) => {
  const b = asBrand(brand);
  const put = (s, re, piece) => s.replace(re, () => piece);
  let out = html.replace(/<html\b([^>]*)>/i, (m, rest) => `<html${rest.replace(/\sdata-brand="[^"]*"/i, '')} data-brand="${attr(b.key)}">`);
  // Branded once, never twice.
  out = out.replace(/<style id="brand">[^<]*<\/style>/gi, '').replace(/<script id="brand-data">[^<]*<\/script>/gi, '')
    .replace(/<link rel="preload" as="(?:image|font)"[^>]*\sdata-brand[^>]*>/gi, '');
  out = put(out, /<title>[^<]*<\/title>/i, `<title>${attr(b.title || APP_NAME)}</title>`);
  out = put(out, /<meta\s+name="apple-mobile-web-app-title"\s+content="[^"]*"\s*\/?>/i,
    `<meta name="apple-mobile-web-app-title" content="${attr(b.shortName || APP_NAME)}" />`);
  out = put(out, /<link\s+rel="icon"[^>]*>/i, `<link rel="icon" href="${attr(b.icon.href)}" type="${attr(b.icon.type)}" />`);
  out = put(out, /<link\s+rel="apple-touch-icon"[^>]*>/i, `<link rel="apple-touch-icon" href="${attr(b.touchIcon)}" />`);
  out = put(out, /<meta\s+name="theme-color"\s+content="[^"]*"\s+media="\(prefers-color-scheme:\s*light\)"\s*\/?>/i,
    `<meta name="theme-color" content="${attr(b.theme)}" media="(prefers-color-scheme: light)" />`);
  out = put(out, /<meta\s+name="theme-color"\s+content="[^"]*"\s+media="\(prefers-color-scheme:\s*dark\)"\s*\/?>/i,
    `<meta name="theme-color" content="${attr(b.themeDark)}" media="(prefers-color-scheme: dark)" />`);
  // A light top bar wants dark status-bar text on an installed iPhone app.
  out = put(out, /<meta\s+name="apple-mobile-web-app-status-bar-style"\s+content="[^"]*"\s*\/?>/i,
    `<meta name="apple-mobile-web-app-status-bar-style" content="${b.sideDark ? 'black' : 'default'}" />`);
  const head = brandHead(b);
  if (!head) return out;
  // Before the first stylesheet; a page with none, before </head>.
  return /<link\s+rel="stylesheet"/i.test(out) ? out.replace(/<link\s+rel="stylesheet"/i, (m) => `${head}${m}`) : out.replace(/<\/head>/i, (m) => `${head}${m}`);
};

// The install manifest: the bar colours, the icons, and what the installed
// app is called (the name under the icon: base.win unless a manager chose
// the campaign's). Its id, start and scope never change, so an installed
// app stays the same app.
export const brandManifest = (m, brand = presetBrand()) => {
  const b = asBrand(brand);
  return { ...m, name: b.title || APP_NAME, short_name: b.shortName || APP_NAME, theme_color: b.theme, background_color: b.background, icons: b.icons };
};

// Middleware in front of the static files (server/index.js): the app's page
// and the manifest leave in the campaign's brand. Everything else passes as
// it came.
export const brandPages = async (c, next) => {
  await next();
  const res = c.res;
  if (!res?.body || c.req.method !== 'GET') return;
  const type = (res.headers.get('content-type') || '').toLowerCase();
  const isHtml = type.includes('text/html');
  const isManifest = type.includes('manifest+json');
  if (!isHtml && !isManifest) return;
  const text = await res.text();
  let out = text;
  if (isHtml) out = text.includes('id="root"') ? brandHtml(text, await campaignBrand()) : text;
  else { try { out = JSON.stringify(brandManifest(JSON.parse(text), await campaignBrand())); } catch { out = text; } }
  const headers = new Headers(res.headers);
  headers.delete('content-length');
  headers.delete('etag');
  // Hono copies the old answer's headers onto a new one (its length too,
  // which would cut the page short): let go of the old one first.
  c.res = undefined;
  c.res = new Response(out, { status: res.status, statusText: res.statusText, headers });
};
