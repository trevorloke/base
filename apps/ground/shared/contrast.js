// Colour contrast, the WCAG 2 way — shared by the server (the brand it
// writes into every page, tests) and the browser (Settings → Brand's
// contrast check and live preview), so both say the same ratio.
//
//   parseHex('#1f4d2e') → { r, g, b } (0–255) or null; '#abc' works too
//   normHex(v)          → '#rrggbb' (lower case) or null
//   luminance(hex)      → relative luminance, 0 (black) … 1 (white)
//   contrast(a, b)      → the ratio, 1 … 21 (order doesn't matter)
//   mix(a, b, t)        → a moved t (0–1) of the way to b, in sRGB — what
//                         CSS color-mix(in srgb, b t%, a) draws
//   ensure(fg, bgs, min, toward) → fg, moved toward `toward` in small steps
//                         until it reaches `min` against every background
//                         (or as near as it gets)
//   readableOn(bg)      → near-black or white, whichever reads better
//
// The lines: 4.5:1 for text (AA), 7:1 for body text on field screens
// (AAA — volunteers read them outdoors, in sun), 3:1 for focus rings and
// other non-text marks.
export const AA = 4.5;
export const AAA = 7;
export const UI = 3;

export const parseHex = (v) => {
  const s = String(v ?? '').trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(s)) {
    return { r: parseInt(s[0] + s[0], 16), g: parseInt(s[1] + s[1], 16), b: parseInt(s[2] + s[2], 16) };
  }
  if (/^[0-9a-f]{6}$/i.test(s)) {
    return { r: parseInt(s.slice(0, 2), 16), g: parseInt(s.slice(2, 4), 16), b: parseInt(s.slice(4, 6), 16) };
  }
  return null;
};

const hex2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
export const toHex = ({ r, g, b }) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;
export const normHex = (v) => {
  const c = parseHex(v);
  return c ? toHex(c) : null;
};

const channel = (c) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

export const luminance = (hex) => {
  const c = parseHex(hex);
  if (!c) return NaN;
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
};

export const contrast = (a, b) => {
  const la = luminance(a);
  const lb = luminance(b);
  if (Number.isNaN(la) || Number.isNaN(lb)) return NaN;
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
};

// Rounded down to two places, so "4.49" never shows as a passing "4.5".
export const ratioText = (r) => (Number.isFinite(r) ? `${(Math.floor(r * 100) / 100).toFixed(2)}:1` : '—');

export const mix = (a, b, t) => {
  const x = parseHex(a);
  const y = parseHex(b);
  if (!x || !y) return normHex(a) || normHex(b);
  const k = Math.max(0, Math.min(1, t));
  return toHex({ r: x.r + (y.r - x.r) * k, g: x.g + (y.g - x.g) * k, b: x.b + (y.b - x.b) * k });
};

export const ensure = (fg, bgs, min, toward) => {
  const list = Array.isArray(bgs) ? bgs : [bgs];
  const worst = (c) => Math.min(...list.map((bg) => contrast(c, bg)));
  let out = normHex(fg);
  for (let t = 0.05; worst(out) < min && t <= 1.0001; t += 0.05) out = mix(fg, toward, t);
  return out;
};

const NEAR_BLACK = '#111111';
export const readableOn = (bg) => (contrast(NEAR_BLACK, bg) >= contrast('#ffffff', bg) ? NEAR_BLACK : '#ffffff');

export const isDark = (hex) => luminance(hex) < 0.18;

// '#1f4d2e' → '31, 77, 46', for rgba() shadows and scrims.
export const rgbList = (hex) => {
  const c = parseHex(hex) || { r: 0, g: 0, b: 0 };
  return `${c.r}, ${c.g}, ${c.b}`;
};
