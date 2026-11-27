// The Theme screen's draft (pages/WebsiteTheme.jsx), kept apart so a test
// can read it without a browser.
import { COLOR_KEYS, FONT_BY_VALUE, RADII, SKINS, lookOf } from '@starbase/shared/site/theme';
import { isAdded } from '@starbase/shared/site/fonts';
import { hexOf } from '../components/site/colors.js';

// A theme as the server keeps it, with every key there (a skin's for any
// missing). A look this browser doesn't know yet (a preset's own, learnt
// from GET /api/site, which may answer after the website's theme) keeps its
// name: the server knows it, and a Save must not turn it into Base.
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const full = (t) => {
  const skin = lookOf(t?.skin) || SKINS.base;
  const out = {
    skin: lookOf(t?.skin) ? skin.key : (typeof t?.skin === 'string' && NAME.test(t.skin) ? t.skin : skin.key),
    colors: Object.fromEntries(COLOR_KEYS.map((k) => [k, hexOf(t?.colors?.[k]) || skin.colors[k]])),
    fonts: {
      heading: FONT_BY_VALUE[t?.fonts?.heading] || isAdded(t?.fonts?.heading) ? t.fonts.heading : skin.fonts.heading,
      body: FONT_BY_VALUE[t?.fonts?.body] || isAdded(t?.fonts?.body) ? t.fonts.body : skin.fonts.body,
    },
    radius: RADII.some((r) => r.value === t?.radius) ? t.radius : skin.radius,
    logo: { url: t?.logo?.url || '', alt: t?.logo?.alt || '' },
  };
  // A look with its own switches (the heading shadow, where theme.js has it) keeps them.
  if (typeof t?.pop === 'boolean' || typeof skin.pop === 'boolean') out.pop = typeof t?.pop === 'boolean' ? t.pop : Boolean(skin.pop);
  return out;
};
