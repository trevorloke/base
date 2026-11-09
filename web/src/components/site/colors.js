// The theme screen's plain parts (no React), tested in
// server/test/site-builder.test.js:
//   hexOf(s)              '#FFF', 'ffffff', ' #A1b2C3 ' → '#ffffff' / '#a1b2c3'; null if not a colour
//   pairsOf(colors)       every pair theme.js says must stay readable (PAIRS),
//                         with its ratio and whether it reaches 4.5:1
//   readableInk(fg, bg)   "Fix it": the colour nearest fg (same hue, darker
//                         or lighter) that reads at 4.5:1 on bg — else black
//                         or white, whichever reads better (theme.js inkFor)
//   colorWords(key)       what a colour is for, in plain words
import { PAIRS, contrast, inkFor } from '@starbase/shared/site/theme';

export const MIN_RATIO = 4.5;

export const hexOf = (s) => {
  const t = String(s ?? '').trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{6}$/.test(t)) return `#${t}`;
  if (/^[0-9a-f]{3}$/.test(t)) return `#${t.split('').map((c) => c + c).join('')}`;
  return null;
};

const rgb = (h) => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const toHex = (c) => `#${c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
// a moved toward b by t (0 = a, 1 = b).
export const mix = (a, b, t) => {
  const x = rgb(a); const y = rgb(b);
  return toHex(x.map((v, i) => v + (y[i] - v) * t));
};

// Ratio rounded down to one place, as the screen says it: a 4.49 is "4.4",
// never a "4.5" that the server then refuses.
export const ratioWords = (r) => `${(Math.floor(r * 10) / 10).toFixed(1)}:1`;

export const pairsOf = (colors) => PAIRS.map((p) => {
  const ratio = contrast(colors?.[p.fg], colors?.[p.bg]);
  return { ...p, ratio, ok: ratio >= MIN_RATIO };
});

export const readableInk = (fg, bg, min = MIN_RATIO) => {
  const f = hexOf(fg); const b = hexOf(bg);
  if (!b) return '#000000';
  if (f && contrast(f, b) >= min) return f;
  if (f) {
    // Toward black or white, whichever side reads better on this background.
    const toward = contrast('#000000', b) >= contrast('#ffffff', b) ? '#000000' : '#ffffff';
    for (let t = 0.05; t <= 1.0001; t += 0.05) {
      const c = mix(f, toward, Math.min(1, t));
      if (contrast(c, b) >= min) return c;
    }
  }
  return inkFor(b);
};

const WORDS = {
  brand: 'Brand colour (title bar, buttons, bands)',
  brandInk: 'Text on the brand colour',
  accent: 'Accent colour (highlights)',
  accentInk: 'Text on the accent colour',
  ink: 'Text',
  paper: 'Page background',
  surface: 'Soft panels',
  line: 'Lines and borders',
  link: 'Links',
  action: 'Action buttons (Donate, Sign)',
  actionInk: 'Text on action buttons',
};
export const colorWords = (key) => WORDS[key] || String(key).replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
