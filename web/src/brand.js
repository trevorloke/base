// This deployment's look (shared/brand.js BRANDS), as the server marked the
// page: <html data-brand="imagine-surrey|base"> (server/lib/brand.js). No
// mark — a dev server — is Imagine Surrey's, as everything was before.
// The colours themselves are CSS (app.css, brand-base.css); this is what
// script needs: the mark's picture, what training is called, a few words.
import { BRANDS, DEFAULT_BRAND } from '@starbase/shared/brand';

const marked = typeof document !== 'undefined' ? document.documentElement?.dataset?.brand : null;
export const BRAND = BRANDS[marked] || BRANDS[DEFAULT_BRAND];
