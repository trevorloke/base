// The website's own files, served at {site root}site-assets/…:
//
//   site.css                  shared/site/site.css
//   fonts/<name>.woff2        shared/site/fonts/
//   site-islands.js           web/dist/site-islands.js (built by `npm run build`)
//
// readSiteAsset(path) → { body, type, cache } or null, for the site's public
// routes to send as is. Links carry ?v=<hash of the file> (assetUrl), and a
// request with the current hash may be cached for a year.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SHARED = fileURLToPath(new URL('../../../../shared/site/', import.meta.url));
const DIST = fileURLToPath(new URL('../../../../web/dist/', import.meta.url));
const TYPES = { css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', woff2: 'font/woff2' };

export function siteAssetFile(name) {
  const n = String(name || '').split(/[?#]/)[0].replace(/^\/+/, '');
  if (n === 'site.css') return `${SHARED}site.css`;
  if (/^fonts\/[a-z0-9-]+\.woff2$/.test(n)) return `${SHARED}${n}`;
  if (n === 'site-islands.js') return `${DIST}site-islands.js`;
  return null;
}

const cache = new Map(); // file → { mtime, body, hash }
function load(file) {
  let st;
  try { st = statSync(file); } catch { return null; }
  const hit = cache.get(file);
  if (hit && hit.mtime === st.mtimeMs) return hit;
  const body = readFileSync(file);
  const entry = { mtime: st.mtimeMs, body, hash: createHash('sha256').update(body).digest('hex').slice(0, 12) };
  cache.set(file, entry);
  return entry;
}

export const islandsBuilt = () => existsSync(`${DIST}site-islands.js`);

// The ?v= for a file (its content hash), '' when it isn't there.
export function assetVersion(name) {
  const file = siteAssetFile(name);
  return (file && load(file)?.hash) || '';
}

// "site.css" → "<assets>site.css?v=…"
export function assetUrl(assets, name) {
  const v = assetVersion(name);
  return `${assets}${name}${v ? `?v=${v}` : ''}`;
}

export function readSiteAsset(path) {
  const file = siteAssetFile(path);
  if (!file) return null;
  const entry = load(file);
  if (!entry) return null;
  const ext = file.split('.').pop();
  const v = /[?&]v=([a-f0-9]+)/.exec(String(path))?.[1];
  return {
    body: entry.body,
    type: TYPES[ext] || 'application/octet-stream',
    cache: v && v === entry.hash ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
    etag: `"${entry.hash}"`,
  };
}
