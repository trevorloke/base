// The brand this page was served in. A brand the campaign's manager saved
// (Settings → Brand) rides in the page as window.__BRAND__; before one is
// saved, the page is marked with the preset the campaign starts from:
// <html data-brand="imagine-surrey|base"> (shared/brand.js BRANDS; both
// written by server/lib/brand.js). No mark — a dev server — is base.win's
// own, the one app.css holds.
// The colours themselves are CSS: the roles in app.css, re-set by the block
// the server writes into the page. This is what script needs: the logo, what
// training is called, a few words. The logo's address is the server's own
// (/brand/…): BrandMark puts a client's path in front of it (base.js at).
import { BRANDS, DEFAULT_BRAND } from '@starbase/shared/brand';

const marked = typeof document !== 'undefined' ? document.documentElement?.dataset?.brand : null;
const preset = BRANDS[marked] || BRANDS[DEFAULT_BRAND];

// What the server wrote, taken only in the shapes it writes.
const saved = typeof window !== 'undefined' && window.__BRAND__ && typeof window.__BRAND__ === 'object' ? window.__BRAND__ : null;
const path = (v) => (typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') ? v : null);
const word = (v, fallback) => (typeof v === 'string' && v.trim() ? v : fallback);
const fromSaved = (s) => ({
  saved: true,
  color: /^#[0-9a-f]{6}$/i.test(s.color || '') ? s.color : preset.color,
  second: /^#[0-9a-f]{6}$/i.test(s.second || '') ? s.second : null,
  sidebar: ['light', 'brand', 'dark'].includes(s.sidebar) ? s.sidebar : 'light',
  sideDark: s.sideDark === true,
  learn: word(s.learn, preset.learn),
  shortName: word(s.shortName, 'base.win'),
  logo: path(s.logo),
  logoDark: path(s.logoDark),
  mark: path(s.mark),
});
export const BRAND = saved ? { ...preset, ...fromSaved(saved) } : preset;

// The brand's ink for what script draws on the always-light map (a turf
// with no colour of its own, a trail): the page's own --brand-ink.
export const brandInk = () => {
  const v = typeof document !== 'undefined' ? getComputedStyle(document.documentElement).getPropertyValue('--brand-ink').trim() : '';
  return /^#[0-9a-f]{6}$/i.test(v) ? v : BRAND.color;
};
