// Settings → Brand's plain parts (no React, no canvas), tested in
// server/test/brand-notes.test.js.
//   hiddenShare(pixels, ground)   how much of a picture can't be seen on a
//                                 ground: the share of its solid pixels under
//                                 3:1 against it (pixels: RGBA bytes, as a
//                                 canvas gives them). A picture with no
//                                 see-through part carries its own ground:
//                                 { boxed: true }, nothing hidden.
//   logoGrounds(brand)            where each logo will sit, per the sidebar
//   brandNotes(brand, seen)       what only a person can decide, in words:
//                                 every shade is worked out and checked by
//                                 rule (shared/brand-look.js), so this list
//                                 reports and never blocks a save.
import { contrast } from '@starbase/shared/site/theme';
import { deriveLook } from '@starbase/shared/brand-look';

export const HIDDEN_TOO_MUCH = 0.4;
const lum = (r, g, b) => {
  const f = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const rgbOf = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

export const hiddenShare = (pixels, ground) => {
  const lg = lum(...rgbOf(ground));
  let solid = 0; let clear = 0; let hidden = 0;
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) { clear += 1; continue; }
    solid += 1;
    const l = lum(pixels[i], pixels[i + 1], pixels[i + 2]);
    if ((Math.max(l, lg) + 0.05) / (Math.min(l, lg) + 0.05) < 3) hidden += 1;
  }
  if (!solid) return { share: 1, boxed: false };
  // No see-through part to speak of: a box in its own colours, seen anywhere.
  if (clear < (solid + clear) * 0.01) return { share: 0, boxed: true };
  return { share: hidden / solid, boxed: false };
};

// The grounds a logo is drawn on (BrandMark.jsx, app.css). The standard logo:
// a white card (sign-in) and the sidebar where that is light or a pale brand
// colour — on a dark one it sits on a white chip, or the logo for dark
// backgrounds takes its place. That one: the dark sidebar (or the brand's,
// where it takes white text), and dark mode's sidebar and card.
export const logoGrounds = (brand) => {
  const light = deriveLook(brand, 'light');
  const dark = deriveLook(brand, 'dark');
  const sideDark = light.sidebar !== 'light' && light.side.ink === '#ffffff';
  return {
    sideDark,
    paleSide: light.sidebar === 'brand' && !sideDark,
    logo: sideDark ? [light.card] : [light.card, light.side.bg],
    logoDark: sideDark ? [light.side.bg, dark.card] : [dark.side.bg, dark.card],
  };
};

// How far apart two colours look, roughly (0–441): near enough to tell a
// brand red from the red that means Opposed.
const apart = (a, b) => { const x = rgbOf(a); const y = rgbOf(b); return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]); };
// The colours ratings are drawn in (app.css --ok/--warn/--danger, the map's pins).
const RATINGS = [
  ['Opposed', ['#c8151b', '#d43c3c']],
  ['Supporter', ['#1f7a4d', '#138a52']],
  ['Undecided', ['#f5a524']],
];

const worst = (list) => (list && list.length ? Math.max(...list.map((s) => s.share)) : 0);

// seen: { logo: [{ share, boxed }…], logoDark: […] } against logoGrounds(), or
// absent while a picture is still being read. → [{ kind: ok|note|warn, text, fix? }]
export const brandNotes = (brand, seen = {}) => {
  const l = deriveLook(brand, 'light');
  const g = logoGrounds(brand);
  const out = [{ kind: 'ok', text: 'Every shade on screen is worked out from your colour and checked: text reads at 4.5:1 and edges at 3:1, in light and in dark.' }];
  if (l.accentInk !== '#ffffff') out.push({ kind: 'note', text: 'Your colour is light, so your buttons have dark text.' });
  // Said when it shows: a shade or two darker is not news.
  if (apart(l.accent, l.accentWords) > 40) out.push({ kind: 'note', text: `As words, your colour becomes ${l.accentWords} so it can be read on every background.` });
  for (const [word, colours] of RATINGS) {
    if (colours.some((c) => apart(l.accent, c) < 70)) out.push({ kind: 'note', text: `Your colour is close to the one that means ${word}. Ratings keep their own colours.` });
  }
  if (contrast(l.second, l.card) < 1.3 && brand.second) out.push({ kind: 'note', text: 'Your second colour is nearly white: it shows only on a brand-coloured or dark sidebar.' });
  if (brand.logo) {
    const [onCard, onSide] = seen.logo || [];
    if (onCard?.boxed) out.push({ kind: 'note', text: 'Your logo has a solid background. A PNG with a see-through background sits better on every screen.' });
    if (onCard && onCard.share > HIDDEN_TOO_MUCH) {
      out.push({ kind: 'warn', text: 'Most of your logo is too light to see on a light background. If this is the version for dark backgrounds, add it there and use a darker one here.' });
    } else if (g.paleSide && onSide && onSide.share > HIDDEN_TOO_MUCH) {
      out.push({ kind: 'warn', text: 'Your logo is hard to see on the brand-coloured sidebar. Keep the light sidebar, or use a logo that stands out on your colour.', fix: { sidebar: 'light', label: 'Use the light sidebar' } });
    }
    if (!brand.logoDark) out.push({ kind: 'note', text: `${g.sideDark ? 'On your sidebar and in' : 'In'} dark mode your logo sits on a white chip. Add a version for dark backgrounds to do without it.` });
  }
  if (brand.logoDark && worst(seen.logoDark) > HIDDEN_TOO_MUCH) {
    out.push({ kind: 'warn', text: 'Your logo for dark backgrounds is hard to see on a dark background. Use a white or light version.' });
  }
  return out;
};
