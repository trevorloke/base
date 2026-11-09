// The public pages, kept in memory once drawn: the key names the campaign,
// the address, the page's version and the settings' version, so a publish
// or a settings save is a new key at once — and every site.* admin action
// also clears the campaign's pages outright (actions.js). Live numbers on a
// page (signatures, spots left) are at most SITE_CACHE_SECONDS old (60 by
// default; 0 turns the cache off). Only plain GETs are kept: a thank-you
// (?sent=), a preview or a page with an error is drawn fresh each time.
// One process's memory: a second server clears its own on its own clock.
const PAGES = new Map(); // key → { status, html, csp, at }
const MAX = 500;

const ttl = () => {
  const n = Number(process.env.SITE_CACHE_SECONDS);
  return (Number.isFinite(n) && n >= 0 ? n : 60) * 1000;
};

export const cacheKey = (workspaceId, parts) => `${workspaceId}|${parts.join('|')}`;

export const cacheGet = (key) => {
  const hit = PAGES.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at >= ttl()) { PAGES.delete(key); return null; }
  return hit;
};

export const cachePut = (key, value) => {
  if (ttl() <= 0) return;
  if (PAGES.size >= MAX) PAGES.delete(PAGES.keys().next().value); // the oldest goes
  PAGES.set(key, { ...value, at: Date.now() });
};

export const cacheClear = (workspaceId) => {
  for (const k of [...PAGES.keys()]) if (!workspaceId || k.startsWith(`${workspaceId}|`)) PAGES.delete(k);
};

export const cacheSize = (workspaceId) => [...PAGES.keys()].filter((k) => !workspaceId || k.startsWith(`${workspaceId}|`)).length;
