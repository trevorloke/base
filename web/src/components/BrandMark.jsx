// The campaign's own mark, wherever the app says whose it is (the nav, the
// sign-in card): its logo in its own colours — the version for dark grounds
// when the ground is dark and the campaign has one — or, with no logo, its
// initials on the brand colour. The logo's alt text is the campaign's name,
// so a picture that didn't load (no signal) still says whose app this is.
//   side   the mark sits on the sidebar (which a campaign may colour or
//          darken); otherwise on a card, light in light mode
import { initials } from '../api.js';
import { at } from '../base.js';
import { BRAND } from '../brand.js';

export const HAS_LOGO = Boolean(BRAND.logo);

export default function BrandMark({ name, side = false }) {
  if (!BRAND.logo) return name ? <span className="brand-mono" aria-hidden="true">{initials(name)}</span> : null;
  // A dark sidebar, or one in a brand colour that takes white text, is dark
  // in both schemes (a saved brand says which: sideDark, server/lib/brand.js).
  const darkGround = side && (typeof BRAND.sideDark === 'boolean' ? BRAND.sideDark : BRAND.sidebar !== 'light');
  // A pale brand colour on the sidebar is a light ground in both schemes:
  // the logo for dark backgrounds never goes there.
  const paleSide = side && BRAND.sidebar === 'brand' && BRAND.sideDark === false;
  const swaps = BRAND.logoDark && !darkGround && !paleSide;
  const cls = `brand-logo${swaps || (darkGround && BRAND.logoDark) ? ' has-dark' : ''}${darkGround && !BRAND.logoDark ? ' on-chip' : ''}`;
  return (
    <picture className={cls}>
      {swaps && <source srcSet={at(BRAND.logoDark)} media="(prefers-color-scheme: dark)" />}
      <img className="brand-mark" src={at(darkGround && BRAND.logoDark ? BRAND.logoDark : BRAND.logo)} alt={name || ''} />
    </picture>
  );
}
