// The brand this page was served in. What the campaign's own server knows
// about its look rides in the page as window.__BRAND__ (written by
// server/lib/brand.js): a brand its manager saved (Settings → Brand), or the
// look a campaign with a set-up of its own starts in. A page with none — any
// campaign that has saved nothing, or a dev server — is base.win's own look,
// the one app.css holds and the only one this file knows.
// The colours themselves are CSS: the roles in app.css, re-set by the block
// the server writes into the page. This is what script needs: the logo, what
// training is called, a few words, and — only when the server sent them —
// the campaign's own example words, its features and where its maps open.
// The logo's address is the server's own (/brand/…): BrandMark puts a
// client's path in front of it (base.js at).
import { BRANDS, DEFAULT_BRAND } from '@base-win/shared/brand';

// base.win's own values: what a page with nothing written into it wears.
const OWN = { ...BRANDS[DEFAULT_BRAND] };

// What the server wrote, taken only in the shapes it writes.
const sent = typeof window !== 'undefined' && window.__BRAND__ && typeof window.__BRAND__ === 'object' ? window.__BRAND__ : null;
const path = (v) => (typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') ? v : null);
const word = (v, fallback) => (typeof v === 'string' && v.trim() ? v : fallback);
const hex = (v) => (/^#[0-9a-f]{6}$/i.test(v || '') ? v : null);
const words = (v) => Object.fromEntries(Object.entries(v && typeof v === 'object' && !Array.isArray(v) ? v : {})
  .filter(([, w]) => typeof w === 'string' && w.trim()));
const list = (v, ok) => (Array.isArray(v) ? v.filter(ok) : []);
const point = (v) => (Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && Number.isFinite(n)) ? [v[0], v[1]] : null);
// Where maps open: { centre, zoom, bounds } with every number a number.
export const mapOf = (m) => {
  if (!m || typeof m !== 'object') return null;
  const centre = point(m.centre);
  const bounds = Array.isArray(m.bounds) && m.bounds.length === 2 ? [point(m.bounds[0]), point(m.bounds[1])] : null;
  if (!centre || !bounds || !bounds[0] || !bounds[1]) return null;
  return { centre, zoom: Number.isFinite(m.zoom) && m.zoom >= 1 && m.zoom <= 19 ? m.zoom : 12, bounds };
};
const fromPage = (s) => ({
  key: word(s.key, OWN.key),
  saved: s.saved === true,
  color: hex(s.color) || OWN.color,
  second: hex(s.second),
  sidebar: ['light', 'brand', 'dark'].includes(s.sidebar) ? s.sidebar : 'light',
  sideDark: s.sideDark === true,
  corners: word(s.corners, OWN.corners),
  heading: word(s.heading, OWN.heading),
  learn: word(s.learn, OWN.learn),
  shortName: word(s.shortName, 'base.win'),
  logo: path(s.logo),
  logoDark: path(s.logoDark),
  mark: path(s.mark),
  // A campaign's own (a preset's), when its server sent them.
  sitePlaceholder: word(s.sitePlaceholder, OWN.sitePlaceholder),
  // The line on Today's sample card: only a campaign with a sample has one.
  sampleLede: word(s.sampleLede, ''),
  startWord: word(s.startWord, null),
  flag: hex(s.flag),
  learnAliases: list(s.learnAliases, (p) => Boolean(path(p))),
  examples: words(s.examples),
  features: list(s.features, (f) => typeof f === 'string'),
  map: mapOf(s.map),
});
export const BRAND = sent ? { ...OWN, ...fromPage(sent) } : { ...OWN, examples: {}, features: [], learnAliases: [], map: null };

// An example word (the grey words in an empty box): the campaign's own when
// its server sent one, else the neutral one written where it is used.
export const ex = (key, neutral) => BRAND.examples?.[key] ?? neutral;

// Whether this campaign has a feature that only some do ('membership',
// 'sample'): what the sign-in says (me.org.features). A phone opening with
// no signal on a sign-in kept from before the server said so falls back to
// what the page says.
export const hasFeature = (me, name) => {
  const told = me?.org?.features;
  return (Array.isArray(told) ? told : BRAND.features || []).includes(name);
};

// The brand's ink for what script draws on the always-light map (a turf
// with no colour of its own, a trail): the page's own --brand-ink.
export const brandInk = () => {
  const v = typeof document !== 'undefined' ? getComputedStyle(document.documentElement).getPropertyValue('--brand-ink').trim() : '';
  return /^#[0-9a-f]{6}$/i.test(v) ? v : BRAND.color;
};
