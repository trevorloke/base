// Where a link goes. Every link and picture the website draws passes the
// catalogue's safe-url rule here, and is put under the site's root. Server
// side only (the islands get their links already worked out).
import { isSafeUrl } from '../catalogue.js';
import { str } from './util.js';

// A link passes the catalogue's safe-url rule (/path, #anchor, http(s),
// mailto, tel) and, stricter, has no whitespace, control characters, quotes,
// angle brackets or backslashes anywhere: a browser drops a tab inside
// "/\t/evil.example" and reads "\" as "/", either of which would make a
// site path into a link to another site.
export const safeUrl = (raw) => {
  const s = str(raw).trim();
  if (!s || s.length > 2000) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f"'<>\\`]/.test(s)) return null;
  if (!isSafeUrl(s) || /^https?:\/\/$/i.test(s)) return null;
  return s;
};

// Where the site lives: ctx.root ('/' on the campaign's domain, '/site/' on
// the app's), ctx.assets (the site's css, fonts and island script) and,
// when the server knows it, the origin for absolute links (share, canonical).
const cleanBase = (v, fallback) => {
  let s = str(v).trim();
  if (!s) return fallback;
  if (!s.startsWith('/') && !/^https?:\/\//i.test(s)) s = `/${s}`;
  if (!s.endsWith('/')) s += '/';
  return /^(https?:\/\/[^\s"'<>\\]+|\/(?!\/)[A-Za-z0-9/_.~-]*)$/.test(s) ? s : fallback;
};
export function locFrom(ctx = {}) {
  const root = cleanBase(ctx.root, '/');
  const assets = cleanBase(ctx.assets, `${root}site-assets/`);
  // Uploaded pictures (/media/…): as they are, or under the client's path
  // when the server says so (its og:image is absolute, past mount.js).
  const media = cleanBase(ctx.media, '/media/');
  // The public address in front of root: https://imaginesurrey.ca, or with
  // the client's path under BASE_PATH (https://base.win/imaginesurrey).
  const o = str(ctx.origin).trim().replace(/\/+$/, '');
  const origin = /^https?:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._~-]+)*$/i.test(o) ? o : '';
  // ctx.path: this page, relative to the site's root ('/', '/about',
  // '/news/a-post'); a path that still has the root in front is taken off.
  let path = str(ctx.path).split(/[?#]/)[0] || '/';
  if (root !== '/' && (path === root.slice(0, -1) || path.startsWith(root))) path = `/${path.slice(root.length)}`;
  if (!path.startsWith('/')) path = `/${path}`;
  if (!/^\/[A-Za-z0-9/_.~%-]*$/.test(path)) path = '/';
  return { root, assets, media, origin, path };
}

// A site link as the visitor's browser needs it: site paths under the site's
// root ('/donate' → '/site/donate' on the app's address), pictures at
// /media (ctx.media), /site-assets/… under the assets path, and everything
// else (https, mailto, tel, #anchor) as typed. null when unsafe.
export function linkFor(loc, raw) {
  const url = safeUrl(raw);
  if (!url) return null;
  if (url.startsWith('#') || !url.startsWith('/')) return url;
  if (url === '/media' || url.startsWith('/media/')) return (loc.media || '/media/') + url.slice('/media/'.length);
  if (url === '/site-assets' || url.startsWith('/site-assets/')) return loc.assets + url.slice('/site-assets/'.length);
  return loc.root + url.slice(1);
}

// A picture's address: a site path, /media/…, /site-assets/… or https.
export function imageFor(loc, raw) {
  const url = safeUrl(raw);
  if (!url || /^(mailto:|tel:|#|http:)/i.test(url)) return null;
  return linkFor(loc, url);
}

// An absolute address for a site path when the origin is known (share links,
// canonical, Open Graph); the path as it is otherwise.
export const absolute = (loc, path) => (loc.origin && str(path).startsWith('/') ? loc.origin + path : str(path));

// The current page's path under the site's root ('/news/x' → '/site/news/x').
export const pagePath = (loc, path = loc.path) => loc.root + str(path).replace(/^\//, '');

// Is this nav link the page being shown?
export function isCurrent(loc, href) {
  const url = safeUrl(href);
  if (!url || !url.startsWith('/') || url.includes('#')) return false;
  const p = url.split('?')[0].replace(/\/+$/, '') || '/';
  const here = loc.path.replace(/\/+$/, '') || '/';
  return p === here || (p !== '/' && here.startsWith(`${p}/`));
}
