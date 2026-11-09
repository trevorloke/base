// The website's look: a handful of tokens an admin edits in Website → Theme,
// turned into CSS variables on every public page. Two skins ship: the
// generic Base one and Imagine Surrey's (from its website's own palette and
// type). Contrast is checked here — a pair that fails WCAG 2.2 AA (4.5:1 for
// text) can't be saved — so no admin can skin the site into unreadable.

export const FONTS = [
  // Self-hosted (server/ext/site serves the files; no third-party requests).
  { value: 'inter', label: 'Inter', stack: "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif" },
  { value: 'montserrat', label: 'Montserrat', stack: "'Montserrat', 'Inter', system-ui, Arial, sans-serif" },
  { value: 'barlow-condensed', label: 'Barlow Condensed', stack: "'Barlow Condensed', 'Arial Narrow', 'Inter', system-ui, sans-serif" },
  { value: 'system', label: 'System', stack: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif" },
  { value: 'serif', label: 'Serif', stack: "Georgia, 'Times New Roman', serif" },
];
export const FONT_BY_VALUE = Object.fromEntries(FONTS.map((f) => [f.value, f]));

export const RADII = [
  { value: 'square', label: 'Square', px: 2 },
  { value: 'soft', label: 'Soft', px: 10 },
  { value: 'round', label: 'Round', px: 22 },
];

// Colour tokens and the pairs that must stay readable.
export const COLOR_KEYS = ['brand', 'brandInk', 'accent', 'accentInk', 'ink', 'paper', 'surface', 'line', 'link'];
export const PAIRS = [
  { fg: 'ink', bg: 'paper', label: 'Text on the page' },
  { fg: 'ink', bg: 'surface', label: 'Text on soft panels' },
  { fg: 'brandInk', bg: 'brand', label: 'Text on brand colour (buttons, bands)' },
  { fg: 'accentInk', bg: 'accent', label: 'Text on accent colour' },
  { fg: 'link', bg: 'paper', label: 'Links on the page' },
];

export const SKINS = {
  base: {
    key: 'base',
    label: 'Base',
    colors: { brand: '#3b3fd8', brandInk: '#ffffff', accent: '#ffcf33', accentInk: '#1a1d29', ink: '#1a1d29', paper: '#ffffff', surface: '#f3f4f8', line: '#d9dce6', link: '#2f33c4' },
    fonts: { heading: 'inter', body: 'inter' },
    radius: 'soft',
    logo: { url: '', alt: '' },
  },
  'imagine-surrey': {
    key: 'imagine-surrey',
    label: 'Imagine Surrey',
    // Navy, yellow, ink, surface and line as on imaginesurrey.ca
    // (apps/web/src/app/globals.css: --navy, --yellow, --ink, --surface, --line).
    colors: { brand: '#003979', brandInk: '#ffffff', accent: '#fff100', accentInk: '#0f1e33', ink: '#0f1e33', paper: '#ffffff', surface: '#f2f4f8', line: '#e3e7ef', link: '#003979' },
    fonts: { heading: 'montserrat', body: 'montserrat' },
    radius: 'soft',
    logo: { url: '', alt: 'Imagine Surrey' },
  },
};

// ── Contrast (WCAG 2.2) ──
const hex = (s) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(s || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const lum = ([r, g, b]) => {
  const c = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
};
export function contrast(a, b) {
  const x = hex(a); const y = hex(b);
  if (!x || !y) return 0;
  const [hi, lo] = [lum(x), lum(y)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
}
// Black or white, whichever reads better on a colour.
export const inkFor = (bg) => (contrast('#000000', bg) >= contrast('#ffffff', bg) ? '#000000' : '#ffffff');

// Check a theme: { theme, problems: [{ pair, ratio }] } — problems empty when
// every pair reaches 4.5:1. Unknown or bad values fall back to the skin's.
export function checkTheme(input, skin = 'base') {
  const base = SKINS[input?.skin] || SKINS[skin] || SKINS.base;
  const colors = {};
  for (const k of COLOR_KEYS) colors[k] = hex(input?.colors?.[k]) ? `#${String(input.colors[k]).replace('#', '').toLowerCase()}` : base.colors[k];
  const fonts = {
    heading: FONT_BY_VALUE[input?.fonts?.heading] ? input.fonts.heading : base.fonts.heading,
    body: FONT_BY_VALUE[input?.fonts?.body] ? input.fonts.body : base.fonts.body,
  };
  const radius = RADII.some((r) => r.value === input?.radius) ? input.radius : base.radius;
  const logo = {
    url: typeof input?.logo?.url === 'string' && /^(\/(?!\/)|https:\/\/)/.test(input.logo.url) ? input.logo.url.slice(0, 500) : base.logo.url,
    alt: typeof input?.logo?.alt === 'string' ? input.logo.alt.slice(0, 200) : base.logo.alt,
  };
  const theme = { skin: base.key, colors, fonts, radius, logo };
  const problems = PAIRS.map((p) => ({ pair: p, ratio: contrast(colors[p.fg], colors[p.bg]) })).filter((x) => x.ratio < 4.5);
  return { theme, problems };
}

// The CSS variables for a theme (the renderer puts them in the page head).
export function themeCss(theme) {
  const { theme: t } = checkTheme(theme);
  const c = t.colors;
  const r = RADII.find((x) => x.value === t.radius)?.px ?? 10;
  return `:root{--brand:${c.brand};--brand-ink:${c.brandInk};--accent:${c.accent};--accent-ink:${c.accentInk};--ink:${c.ink};--paper:${c.paper};--surface:${c.surface};--line:${c.line};--link:${c.link};--radius:${r}px;--font-heading:${FONT_BY_VALUE[t.fonts.heading].stack};--font-body:${FONT_BY_VALUE[t.fonts.body].stack}}`;
}
