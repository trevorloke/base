// One client's own material, kept apart from the product. base.win is the
// same code for every campaign; what belongs to one client — its opponents,
// its city and map, its look, its lists, its membership form, its website —
// is a preset: one folder under server/presets/, used only by the server
// whose STARBASE_BRAND names it. Every other campaign's server answers from
// NEUTRAL below, which holds nothing of anyone's.
//
//   preset()        this server's preset, or NEUTRAL. Read when called,
//                   never kept: the brand is a setting, and tests change it
//                   between cases. So no module keeps a preset value in a
//                   top-level constant, a schema or a route made at load.
//   brandHas(f)     whether this server has a feature a preset brings:
//                   'membership', 'sample', 'donorTiers'.
//   presetFor(key)  a preset by name, whatever this server's brand: tests only.
//
// This is the only file that may import from server/presets/ (a test checks).
// A preset's large files (its website as first made, its sample people, its
// pictures) are named in it and loaded only through it, only under the brand.
import { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import { presetCandidates } from '@starbase/shared/scale';
import IMAGINE_SURREY from '../presets/imagine-surrey/index.js';

const deepFreeze = (v) => {
  if (!v || typeof v !== 'object' || Object.isFrozen(v)) return v;
  const plain = Array.isArray(v) || Object.getPrototypeOf(v) === Object.prototype;
  if (!plain) return v; // a URL, say: left as it is
  Object.freeze(v);
  for (const x of Object.values(v)) deepFreeze(x);
  return v;
};

const PRESETS = deepFreeze({ 'imagine-surrey': IMAGINE_SURREY });
export const PRESET_KEYS = Object.keys(PRESETS);

// What a campaign with no preset has: every key a preset has, holding
// nothing. A value that can be null is read behind brandHas(...) or ?. .
const NEUTRAL = deepFreeze({
  key: 'base',
  orgNames: [],
  org: { city: '', box: null },
  map: null,
  candidates: [],
  brand: null,
  training: { label: 'Training', oldPaths: [] },
  fields: { standard: null, languages: null, interests: null, campuses: [], faiths: null, guesses: {}, bootBackfill: false },
  membership: null,
  donorTiers: [],
  site: { skin: null, css: null, assets: null, seed: null, words: {}, wordsBefore: {}, moduleDefaults: {}, fieldLabels: {} },
  appFiles: {},
  sample: null,
  examples: {},
});

// ── Which brand this server wears ──
//   STARBASE_BRAND   base, or a preset's name (imagine-surrey). Any case.
// Unset, or a word that names nothing, is base — with one exception, kept so
// that a server set up before this setting existed does not change under its
// campaign: a server that is not staging and is named exactly as a preset's
// campaign ("Imagine Surrey") still gets that preset, and its log says to
// set the brand (brandNote). Staging is never worked out to a preset.
const typed = (env) => String(env.STARBASE_BRAND || '').trim().toLowerCase();
const byName = (env) => {
  if (String(env.STARBASE_ENV || '').trim() === 'staging') return null;
  const name = String(env.STARBASE_ORG_NAME || '').trim();
  if (!name) return null;
  return PRESET_KEYS.find((k) => PRESETS[k].orgNames.includes(name)) || null;
};
export const brandKey = (env = process.env) => {
  const set = typed(env);
  if (set === 'base' || PRESETS[set]) return set;
  return byName(env) || 'base';
};
// Said loudly in the log when the server starts (it still starts): the brand
// was worked out from the campaign's name, not set. null when there is
// nothing to say.
export const brandNote = (env = process.env) => {
  const set = typed(env);
  if (set === 'base' || PRESETS[set]) return null;
  const key = byName(env);
  if (!key) return null;
  const name = String(env.STARBASE_ORG_NAME || '').trim();
  return `starbase: WARNING — STARBASE_BRAND is ${set ? `“${set}”, which is not a brand` : 'not set'} on a server named ${name}:`
    + ` it is given ${name}’s own set-up (${key}) because of its name. Set STARBASE_BRAND=${key} so that no longer rests on the name: Render → this service → Environment.`;
};

export const preset = () => PRESETS[brandKey()] || NEUTRAL;
export const presetFor = (key) => PRESETS[key] || NEUTRAL;
export const brandHas = (feature) => {
  const v = preset()[feature];
  return Array.isArray(v) ? v.length > 0 : Boolean(v);
};

// The rating scale's starting list is this server's preset's (shared/scale.js
// asks each time; a typed STARBASE_CANDIDATES still comes first).
presetCandidates(() => preset().candidates);

// ── A preset's own files at the app's addresses ──
// The installed app's icons (preset().appFiles: address → file under the
// preset's folder). Served only under the preset. A file that is not in the
// folder passes to the static files. Under any other brand these addresses
// hold nothing: when nothing else answered them either (the app's page
// would), the answer is 404.
const TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon' };
const EVERY_APP_FILE = new Set(PRESET_KEYS.flatMap((k) => Object.keys(PRESETS[k].appFiles || {})));
const folderOf = (key) => new URL(`../presets/${key}/`, import.meta.url);
export const presetRoutes = new Hono();
presetRoutes.on(['GET', 'HEAD'], '*', async (c, next) => {
  const path = c.req.path;
  if (!EVERY_APP_FILE.has(path)) return next();
  const p = preset();
  const rel = p.appFiles?.[path];
  if (rel && /^[a-z0-9/_-]+\.[a-z0-9]+$/i.test(rel)) {
    const bytes = await readFile(new URL(rel, folderOf(p.key))).catch(() => null);
    if (bytes) return c.body(bytes, 200, { 'Content-Type': TYPES[rel.split('.').pop().toLowerCase()] || 'application/octet-stream' });
  }
  await next();
  // Nothing held the file, so the app's page answered in its place.
  if (/^text\/html/i.test(c.res?.headers.get('content-type') || '')) {
    c.res = undefined;
    c.res = c.text('Not found', 404, { 'Cache-Control': 'no-store' });
  }
  return undefined;
});
