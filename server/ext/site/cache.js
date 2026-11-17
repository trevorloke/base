// The public pages, kept in memory once drawn: the key names the campaign,
// the address, the page's version and the settings' version, so a publish
// or a settings save is a new key at once — and every site.* admin action
// also clears the campaign's pages outright (actions.js). Live numbers on a
// page (signatures, spots left) are at most SITE_CACHE_SECONDS old (60 by
// default; 0 turns the cache off). Only plain GETs are kept: a thank-you
// (?sent=), a preview or a page with an error is drawn fresh each time.
// One process's memory: a second server clears its own on its own clock.
// A page may also carry an absolute expiry (until, epoch ms): one drawn
// while the voter guide is published is never served past the guide's
// next boundary (a poll opening or closing), however young it is.
import { now } from '../../lib/clock.js';

const PAGES = new Map(); // key → { status, html, csp, geo, at, until }
const MAX = 500;

const ttl = () => {
  const n = Number(process.env.SITE_CACHE_SECONDS);
  return (Number.isFinite(n) && n >= 0 ? n : 60) * 1000;
};

export const cacheKey = (workspaceId, parts) => `${workspaceId}|${parts.join('|')}`;

export const cacheGet = (key) => {
  const hit = PAGES.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at >= ttl() || (hit.until != null && now() >= hit.until)) { PAGES.delete(key); return null; }
  return hit;
};

export const cachePut = (key, value, { until } = {}) => {
  if (ttl() <= 0) return;
  if (PAGES.size >= MAX) PAGES.delete(PAGES.keys().next().value); // the oldest goes
  PAGES.set(key, { ...value, at: Date.now(), until: Number.isFinite(until) ? until : null });
};

// How many times pages were cleared: the voter guide's memo (ext/voteguide)
// reads its rows again after any Website action.
let gen = 0;
export const cacheGen = () => gen;

export const cacheClear = (workspaceId) => {
  gen += 1;
  for (const k of [...PAGES.keys()]) if (!workspaceId || k.startsWith(`${workspaceId}|`)) PAGES.delete(k);
};

// What a request reads before the cache can answer (the campaign, its
// website settings, a live page by its address), kept per process until
// the next Website action (a new cacheGen) or SITE_CACHE_SECONDS, whichever
// comes first: a page already kept costs the database nothing (VG: a crowd
// on the voter guide). A read started before a clear is never served after
// it. One read at a time per key: a crowd waits for the one. Kept per
// database handle (a new one, as tests make, starts empty).
const READS = new WeakMap(); // db → key → { gen, at, value: Promise }
export const remember = (db, key, read) => {
  const t = ttl();
  if (t <= 0) return read();
  if (!READS.has(db)) READS.set(db, new Map());
  const reads = READS.get(db);
  const was = reads.get(key);
  if (was && was.gen === gen && Date.now() - was.at < t) return was.value;
  if (reads.size >= MAX * 4) reads.delete(reads.keys().next().value);
  const entry = { gen, at: Date.now(), value: Promise.resolve().then(read) };
  reads.set(key, entry);
  entry.value.catch(() => { if (reads.get(key) === entry) reads.delete(key); });
  return entry.value;
};

export const cacheSize = (workspaceId) => [...PAGES.keys()].filter((k) => !workspaceId || k.startsWith(`${workspaceId}|`)).length;
