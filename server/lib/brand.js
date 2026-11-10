// The brand this deployment wears: one of the two built-in looks
// (shared/brand.js BRANDS — Imagine Surrey's own, or base.win's), each a
// preset through the one rule that turns a brand colour into every shade on
// screen (shared/brand-look.js). Production for Imagine Surrey starts from
// theirs; staging, and any other campaign, from base.win's.
//
//   STARBASE_BRAND   imagine-surrey | base. Unset, it is worked out, so a
//                    deployment that never heard of this setting starts where
//                    it always did:
//                      staging (STARBASE_ENV=staging)             → base
//                      a campaign named anything but Imagine Surrey → base
//                      otherwise (Imagine Surrey, or no name set)  → imagine-surrey
//
// The app's page (index.html) leaves marked <html data-brand="…">, with the
// brand's shades written into it as CSS variables (before the stylesheets,
// so it never paints in another look), its logo asked for early, its icons
// and the browser's bar colours — and so does the install manifest. The
// base preset's shades are the ones app.css already holds, so its page
// carries no block. (Under a client's path, lib/mount.js then adds the path
// as usual: the block has no addresses in it.)
import { BRANDS } from '@starbase/shared/brand';
import { deriveLook, lookCss, lookChrome } from '@starbase/shared/brand-look';
import { envName, orgName } from './org.js';

export const brandKey = () => {
  const set = String(process.env.STARBASE_BRAND || '').trim().toLowerCase();
  if (BRANDS[set]) return set;
  if (envName() === 'staging') return 'base';
  const org = String(orgName() || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (org && org !== 'imagine surrey') return 'base';
  return 'imagine-surrey';
};
// The brand with what the rule works out for it: the browser's bar colours
// (theme, themeDark, background) and a link's colour in an email (link).
const worked = new Map();
const work = (b) => {
  if (!worked.has(b)) worked.set(b, { ...b, ...lookChrome(b), link: deriveLook(b, 'light').accentWords, css: lookCss(b) });
  return worked.get(b);
};
export const brand = () => work(BRANDS[brandKey()]);
// What the campaign's training is called (the Learn area): "ImagineU" for
// Imagine Surrey, "Training" otherwise.
export const learnName = () => brand().learn;

const attr = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const BASE_CSS = lookCss(BRANDS.base);

// What goes into the page's head for a brand: its shades (none when they are
// app.css's own), and its logo asked for early — which is also how the
// service worker learns which pictures to keep for no signal (sw.js).
const brandHead = (b) => {
  const out = [];
  if (b.css !== BASE_CSS) out.push(`<style id="brand">${b.css}</style>`);
  if (b.logo) out.push(`<link rel="preload" as="image" href="${attr(b.logo)}" data-brand${b.logoDark && b.sidebar === 'light' ? ' media="(prefers-color-scheme: light)"' : ''} />`);
  if (b.logoDark) out.push(`<link rel="preload" as="image" href="${attr(b.logoDark)}" data-brand${b.sidebar === 'light' ? ' media="(prefers-color-scheme: dark)"' : ''} />`);
  return out.join('');
};

// index.html as built → this deployment's: the mark on <html>, the shades,
// the tab's icon, the home-screen icon and the browser's bar colours.
export const brandHtml = (html, preset = brand()) => {
  const b = work(preset);
  let out = html.replace(/<html\b([^>]*)>/i, (m, rest) => `<html${rest.replace(/\sdata-brand="[^"]*"/i, '')} data-brand="${attr(b.key)}">`);
  // Branded once, never twice.
  out = out.replace(/<style id="brand">[^<]*<\/style>/gi, '').replace(/<link rel="preload" as="image"[^>]*\sdata-brand[^>]*>/gi, '');
  out = out.replace(/<link\s+rel="icon"[^>]*>/i, `<link rel="icon" href="${attr(b.icon.href)}" type="${attr(b.icon.type)}" />`);
  out = out.replace(/<link\s+rel="apple-touch-icon"[^>]*>/i, `<link rel="apple-touch-icon" href="${attr(b.touchIcon)}" />`);
  out = out.replace(/<meta\s+name="theme-color"\s+content="[^"]*"\s+media="\(prefers-color-scheme:\s*light\)"\s*\/?>/i,
    `<meta name="theme-color" content="${attr(b.theme)}" media="(prefers-color-scheme: light)" />`);
  out = out.replace(/<meta\s+name="theme-color"\s+content="[^"]*"\s+media="\(prefers-color-scheme:\s*dark\)"\s*\/?>/i,
    `<meta name="theme-color" content="${attr(b.themeDark)}" media="(prefers-color-scheme: dark)" />`);
  // A light top bar wants dark status-bar text on an installed iPhone app.
  out = out.replace(/<meta\s+name="apple-mobile-web-app-status-bar-style"\s+content="[^"]*"\s*\/?>/i,
    `<meta name="apple-mobile-web-app-status-bar-style" content="${b.sidebar === 'light' ? 'default' : 'black'}" />`);
  const head = brandHead(b);
  if (!head) return out;
  // Before the first stylesheet; a page with none, before </head>.
  return /<link\s+rel="stylesheet"/i.test(out) ? out.replace(/<link\s+rel="stylesheet"/i, (m) => `${head}${m}`) : out.replace(/<\/head>/i, `${head}</head>`);
};

export const brandManifest = (m, preset = brand()) => {
  const b = work(preset);
  return { ...m, theme_color: b.theme, background_color: b.background, icons: b.icons };
};

// Middleware in front of the static files (server/index.js): the app's page
// and the manifest leave in this deployment's brand. Everything else passes
// as it came.
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
  if (isHtml) out = text.includes('id="root"') ? brandHtml(text) : text;
  else { try { out = JSON.stringify(brandManifest(JSON.parse(text))); } catch { out = text; } }
  const headers = new Headers(res.headers);
  headers.delete('content-length');
  headers.delete('etag');
  // Hono copies the old answer's headers onto a new one (its length too,
  // which would cut the page short): let go of the old one first.
  c.res = undefined;
  c.res = new Response(out, { status: res.status, statusText: res.statusText, headers });
};
