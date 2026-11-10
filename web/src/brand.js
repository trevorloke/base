// The brand this page was served in (shared/brand.js BRANDS), as the server
// marked it: <html data-brand="imagine-surrey|base"> (server/lib/brand.js). No
// mark — a dev server — is base.win's own, the one app.css holds.
// The colours themselves are CSS: the roles in app.css, re-set by the block
// the server writes into the page. This is what script needs: the logo, what
// training is called, a few words.
import { BRANDS, DEFAULT_BRAND } from '@starbase/shared/brand';

const marked = typeof document !== 'undefined' ? document.documentElement?.dataset?.brand : null;
export const BRAND = BRANDS[marked] || BRANDS[DEFAULT_BRAND];

// The brand's ink for what script draws on the always-light map (a turf
// with no colour of its own, a trail): the page's own --brand-ink.
export const brandInk = () => {
  const v = typeof document !== 'undefined' ? getComputedStyle(document.documentElement).getPropertyValue('--brand-ink').trim() : '';
  return /^#[0-9a-f]{6}$/i.test(v) ? v : BRAND.color;
};
