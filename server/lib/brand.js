// Which look this deployment wears (shared/brand.js BRANDS): Imagine
// Surrey's own, or Base's generic one. Production for Imagine Surrey wears
// theirs; staging, and any other campaign, wears Base's.
//
//   STARBASE_BRAND   imagine-surrey | base. Unset, it is worked out, so a
//                    deployment that never heard of this setting looks as it
//                    always did:
//                      staging (STARBASE_ENV=staging)             → base
//                      a campaign named anything but Imagine Surrey → base
//                      otherwise (Imagine Surrey, or no name set)  → imagine-surrey
//
// The app's page (index.html) is marked <html data-brand="…"> on its way
// out, with the brand's icons and browser colours, and so is the install
// manifest — before the first paint, so the page never flashes the other
// look. (Under a client's path, lib/mount.js then adds the path as usual.)
import { BRANDS } from '@starbase/shared/brand';
import { envName, orgName } from './org.js';

export const brandKey = () => {
  const set = String(process.env.STARBASE_BRAND || '').trim().toLowerCase();
  if (BRANDS[set]) return set;
  if (envName() === 'staging') return 'base';
  const org = String(orgName() || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (org && org !== 'imagine surrey') return 'base';
  return 'imagine-surrey';
};
export const brand = () => BRANDS[brandKey()];
// What the campaign's training is called (the Learn area): "ImagineU" for
// Imagine Surrey, "Training" otherwise.
export const learnName = () => brand().learn;

const attr = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

// index.html as built → this deployment's: the mark on <html>, the tab's
// icon, the home-screen icon and the browser's bar colours.
export const brandHtml = (html, b = brand()) => {
  let out = html.replace(/<html\b([^>]*)>/i, (m, rest) => `<html${rest.replace(/\sdata-brand="[^"]*"/i, '')} data-brand="${attr(b.key)}">`);
  out = out.replace(/<link\s+rel="icon"[^>]*>/i, `<link rel="icon" href="${attr(b.icon.href)}" type="${attr(b.icon.type)}" />`);
  out = out.replace(/<link\s+rel="apple-touch-icon"[^>]*>/i, `<link rel="apple-touch-icon" href="${attr(b.touchIcon)}" />`);
  out = out.replace(/<meta\s+name="theme-color"\s+content="[^"]*"\s+media="\(prefers-color-scheme:\s*light\)"\s*\/?>/i,
    `<meta name="theme-color" content="${attr(b.theme)}" media="(prefers-color-scheme: light)" />`);
  out = out.replace(/<meta\s+name="theme-color"\s+content="[^"]*"\s+media="\(prefers-color-scheme:\s*dark\)"\s*\/?>/i,
    `<meta name="theme-color" content="${attr(b.themeDark)}" media="(prefers-color-scheme: dark)" />`);
  return out;
};

export const brandManifest = (m, b = brand()) => ({ ...m, theme_color: b.theme, background_color: b.theme, icons: b.icons });

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
