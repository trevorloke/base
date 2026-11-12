// One brand colour in, every shade the app draws with out.
//
// A campaign picks a colour (and maybe a second one); nobody is asked for the
// rest. Each shade below is worked out from it and kept readable where it is
// used — 4.5:1 for words, 3:1 for edges, rings and marks (WCAG 2.2) — on the
// website's own contrast code (site/theme.js). The grounds are neutral: the
// brand is the accent, never a surface, so it cannot fight the rating
// colours, and a campaign's logo sits on it in its own colours.
//   deriveLook(brand, 'light' | 'dark')   the shades, and every pair checked
//   lookTokens(brand)                     the CSS variables, light and dark
//   lookCss(brand)                        the same as one small style block
// The server writes that block into the app's page before it paints
// (server/lib/brand.js). web/src/app.css holds the base preset's values for a
// page nobody wrote into; server/test/brand-look.test.js keeps the two the
// same and sweeps 5,000 colours through every check.
import { contrast, mix, inkFor, FONT_BY_VALUE } from './site/theme.js';

export const SIDEBARS = ['light', 'brand', 'dark'];
// Small things (key hints, chips in a table), controls, cards.
export const CORNERS = { square: [4, 6, 8], soft: [6, 8, 12], round: [8, 12, 18] };
export const HEADINGS = ['inter', 'barlow-condensed', 'montserrat', 'system', 'serif'];
export const DEFAULT_COLOR = '#4f46e5'; // base.win's indigo

// The grounds: page, a card on it, soft panels, hairlines, text. Neutral in
// both schemes — dark mode is dark, not a darker brand.
const GROUNDS = {
  light: { page: '#fafafb', card: '#ffffff', panel: '#f3f4f6', panel2: '#e9eaee', line: '#e7e8ec', lineStrong: '#d2d5db', text: '#14161a', text2: '#30343b' },
  dark: { page: '#0f1012', card: '#17181c', panel: '#1e2025', panel2: '#282b32', line: '#26282e', lineStrong: '#3a3d46', text: '#f4f5f6', text2: '#d6d8dd' },
};
const SOFT_INK = '#14161a';

const hexOr = (v, fallback) => {
  const s = String(v ?? '').trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(s) ? s : fallback;
};
const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);

// The first step of a toward b that reads at `min` on every ground.
const walk = (a, b, grounds, min, step = 0.03) => {
  for (let t = 0; t <= 1.0001; t += step) {
    const c = mix(a, b, Math.min(1, t));
    if (grounds.every((g) => contrast(c, g) >= min)) return c;
  }
  return b;
};
// Text on a fill: white where it reads and is not much the weaker choice,
// else near-black, else whichever of black and white reads (one always
// does: a colour's contrast with white times its contrast with black is 21).
const inkOn = (bg, soft = SOFT_INK) => {
  const white = contrast('#ffffff', bg);
  if (white >= 4.5 && white >= contrast(soft, bg) * 0.75) return '#ffffff';
  if (contrast(soft, bg) >= 4.5) return soft;
  return inkFor(bg);
};
const away = (ink) => (ink === '#ffffff' ? '#000000' : '#ffffff');

// The sidebar (and the phone's top bar), per the campaign's choice.
function sidebarOf(side, n, a, dark) {
  if (side === 'light') {
    const bg = n.panel;
    return {
      bg, top: n.card, ink: n.text, quiet: walk(mix(n.text, bg, 0.3), n.text, [bg, n.card], 4.6),
      hover: n.panel2, active: n.card, activeInk: walk(a.words, a.toward, [n.card, bg], 4.5), mark: a.edge, edge: n.line,
    };
  }
  const bg = side === 'brand' ? a.fill : (dark ? '#050506' : '#0b0b0d');
  const ink = inkOn(bg, '#111318');
  // Hover and the active item move away from the text, so it only reads better.
  const active = side === 'brand' ? mix(bg, away(ink), 0.22) : '#1d1d21';
  const second = a.second && contrast(a.second, bg) >= 3 && contrast(a.second, active) >= 3 ? a.second : ink;
  return {
    bg, top: bg, ink, quiet: walk(mix(ink, bg, 0.32), ink, [bg, active], 4.6),
    hover: side === 'brand' ? mix(bg, away(ink), 0.1) : '#17171a', active, activeInk: contrast(ink, active) >= 4.5 ? ink : inkFor(active),
    mark: side === 'brand' ? second : walk(a.fill, '#ffffff', [bg, active], 3), edge: mix(bg, ink, 0.14),
  };
}

export function deriveLook(brand, scheme = 'light') {
  const dark = scheme === 'dark';
  const n = GROUNDS[dark ? 'dark' : 'light'];
  const accent = hexOr(brand?.color, DEFAULT_COLOR);
  const secondSet = hexOr(brand?.second, null);
  const second = secondSet || accent; // none chosen: the brand stands in
  const sidebar = oneOf(brand?.sidebar, SIDEBARS, 'light');
  const corners = oneOf(brand?.corners, Object.keys(CORNERS), 'soft');
  const heading = oneOf(brand?.heading, HEADINGS, 'inter');
  const toward = dark ? '#ffffff' : '#000000';
  const grounds = [n.page, n.card, n.panel];

  // Quiet text: as light as still reads on every ground it sits on.
  const quiet = walk(mix(n.text, n.card, 0.42), n.text, [...grounds, n.panel2], 4.6);
  // A field's edge: 3:1 against the page, a card and a soft panel.
  const fieldEdge = walk(n.lineStrong, n.text, grounds, 3);

  // The brand as a fill, exactly as chosen, and the text on it.
  const accentInk = inkOn(accent);
  const accentHover = mix(accent, away(accentInk), accentInk === '#ffffff' ? 0.14 : 0.18);
  // A little of the brand in a card (a selected row, a soft chip): as much
  // as leaves quiet text readable on it.
  const tintOf = (steps) => {
    for (const k of steps) {
      const c = mix(n.card, accent, k);
      if (contrast(quiet, c) >= 4.5 && contrast(n.text, c) >= 7) return c;
    }
    return n.panel;
  };
  const tint = tintOf(dark ? [0.16, 0.12, 0.09, 0.06, 0.03] : [0.08, 0.06, 0.04, 0.02]);
  const tint2 = tintOf(dark ? [0.26, 0.2, 0.15, 0.1, 0.06, 0.03] : [0.15, 0.11, 0.08, 0.05, 0.02]);
  // Faint text: lighter than quiet where it can be, and still read on the tints.
  const faint = walk(mix(n.text, n.card, 0.56), n.text, [...grounds, tint, tint2], 4.5);
  // The brand as words and small marks (and the text on it where a screen
  // fills with it); as an edge, a bar, the focus ring.
  const accentWords = walk(accent, toward, [...grounds, tint, tint2], 4.5);
  const accentWordsInk = inkOn(accentWords);
  const accentEdge = walk(accent, toward, [...grounds, tint, tint2], 3);
  const secondInk = inkOn(second);

  const side = sidebarOf(sidebar, n, { fill: accent, words: accentWords, edge: accentEdge, toward, second: secondSet }, dark);
  // Toasts and tooltips: the other scheme's ground.
  const inverse = dark ? '#f4f5f6' : '#1b1d22';
  const inverseInk = dark ? '#14161a' : '#ffffff';
  const inverse2 = mix(inverse, inverseInk, 0.12);
  const inverseQuiet = mix(inverseInk, inverse, 0.25);

  const look = {
    scheme: dark ? 'dark' : 'light', sidebar, corners, heading, radii: CORNERS[corners],
    ...n, quiet, faint, fieldEdge,
    accent, accentInk, accentHover, accentWords, accentWordsInk, accentEdge, tint, tint2, second, secondInk,
    side, inverse, inverse2, inverseInk, inverseQuiet,
  };
  const C = (what, fg, bg, min = 4.5) => { const ratio = contrast(fg, bg); return { what, fg, bg, min, ratio, ok: ratio >= min }; };
  look.checks = [
    C('text on the brand fill', accentInk, accent), C('text on the hover fill', accentInk, accentHover), C('text on a fill of the brand as words', accentWordsInk, accentWords),
    C('brand words on the page', accentWords, n.page), C('brand words on a card', accentWords, n.card), C('brand words on a soft panel', accentWords, n.panel),
    C('brand words on the tint', accentWords, tint), C('brand words on the deeper tint', accentWords, tint2),
    C('text on the tint', n.text, tint), C('text on the deeper tint', n.text, tint2), C('quiet text on the tint', quiet, tint), C('quiet text on the deeper tint', quiet, tint2),
    C('faint text on the tint', faint, tint), C('faint text on the deeper tint', faint, tint2),
    C('quiet text on the page', quiet, n.page), C('quiet text on a card', quiet, n.card), C('quiet text on a soft panel', quiet, n.panel), C('quiet text on a deeper panel', quiet, n.panel2),
    C('faint text on the page', faint, n.page), C('faint text on a card', faint, n.card), C('faint text on a soft panel', faint, n.panel),
    C('second text on the page', n.text2, n.page), C('second text on a deeper panel', n.text2, n.panel2),
    C('focus ring on the page', accentEdge, n.page, 3), C('focus ring on a card', accentEdge, n.card, 3), C('focus ring on a soft panel', accentEdge, n.panel, 3), C('selected edge on the deeper tint', accentEdge, tint2, 3),
    C('field edge on the page', fieldEdge, n.page, 3), C('field edge on a card', fieldEdge, n.card, 3), C('field edge on a soft panel', fieldEdge, n.panel, 3),
    C('sidebar: text', side.ink, side.bg), C('sidebar: text on hover', side.ink, side.hover), C('sidebar: quiet text', side.quiet, side.bg), C('sidebar: quiet text on the top bar', side.quiet, side.top),
    C('sidebar: the active item', side.activeInk, side.active), C('sidebar: the active item’s mark', side.mark, side.active, 3),
    C('text on the second colour', secondInk, second), C('toast text', inverseInk, inverse), C('quiet text on a toast', inverseQuiet, inverse),
  ];
  return look;
}

const colours = (l) => ({
  '--page': l.page, '--card': l.card, '--panel': l.panel, '--panel-2': l.panel2,
  '--line': l.line, '--line-strong': l.lineStrong, '--field-edge': l.fieldEdge,
  '--text': l.text, '--text-2': l.text2, '--quiet': l.quiet, '--faint': l.faint,
  '--accent': l.accent, '--accent-ink': l.accentInk, '--accent-hover': l.accentHover,
  '--accent-words': l.accentWords, '--accent-words-ink': l.accentWordsInk, '--accent-edge': l.accentEdge, '--focus': l.accentEdge,
  '--tint': l.tint, '--tint-2': l.tint2, '--second': l.second, '--second-ink': l.secondInk,
  '--side': l.side.bg, '--side-top': l.side.top, '--side-ink': l.side.ink, '--side-quiet': l.side.quiet, '--side-hover': l.side.hover,
  '--side-active': l.side.active, '--side-active-ink': l.side.activeInk, '--side-mark': l.side.mark, '--side-edge': l.side.edge,
  '--inverse': l.inverse, '--inverse-2': l.inverse2, '--inverse-ink': l.inverseInk, '--inverse-quiet': l.inverseQuiet,
});

// The CSS variables: colours per scheme; shapes, the heading face and the
// brand's own inks (map markers on always-light tiles) once, with light.
export function lookTokens(brand) {
  const light = deriveLook(brand, 'light');
  const dark = deriveLook(brand, 'dark');
  const [sm, ctrl, card] = light.radii;
  return {
    light: {
      ...colours(light),
      '--brand-ink': light.accentWords, '--brand-ink-2': light.secondInk, '--brand-spark': light.second,
      '--r-sm': `${sm}px`, '--r-ctrl': `${ctrl}px`, '--r-card': `${card}px`, '--r-sheet': `${card + 4}px`,
      '--font-display': FONT_BY_VALUE[light.heading].stack,
    },
    dark: colours(dark),
  };
}

const block = (vars) => Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(';');
export function lookCss(brand) {
  const t = lookTokens(brand);
  return `:root{${block(t.light)}}@media (prefers-color-scheme:dark){:root{${block(t.dark)}}}`;
}

// The browser's bar and the installed app's splash: the phone's top bar, so
// the status bar above it matches.
export function lookChrome(brand) {
  const light = deriveLook(brand, 'light');
  const dark = deriveLook(brand, 'dark');
  return { theme: light.side.top, themeDark: dark.side.top, background: light.sidebar === 'light' ? light.page : light.side.top };
}
