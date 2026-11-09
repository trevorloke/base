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

// Colour tokens and the pairs that must stay readable. `action` is the
// colour of the buttons that ask for something (Donate, Sign, Join) and of
// the heading shadow; until it is set it follows the brand colour.
export const COLOR_KEYS = ['brand', 'brandInk', 'accent', 'accentInk', 'ink', 'paper', 'surface', 'line', 'link', 'action', 'actionInk'];
export const COLOR_LABELS = {
  brand: 'Brand colour', brandInk: 'Text on brand colour', accent: 'Accent colour', accentInk: 'Text on accent colour',
  ink: 'Text', paper: 'Page background', surface: 'Soft panels', line: 'Lines and borders', link: 'Links',
  action: 'Action buttons (Donate, Sign)', actionInk: 'Text on action buttons',
};
export const PAIRS = [
  { fg: 'ink', bg: 'paper', label: 'Text on the page' },
  { fg: 'ink', bg: 'surface', label: 'Text on soft panels' },
  { fg: 'brandInk', bg: 'brand', label: 'Text on brand colour (buttons, bands)' },
  { fg: 'accentInk', bg: 'accent', label: 'Text on accent colour' },
  { fg: 'link', bg: 'paper', label: 'Links on the page' },
  { fg: 'actionInk', bg: 'action', label: 'Text on action buttons (Donate, Sign)' },
];

export const SKINS = {
  base: {
    key: 'base',
    label: 'Base',
    colors: { brand: '#3b3fd8', brandInk: '#ffffff', accent: '#ffcf33', accentInk: '#1a1d29', ink: '#1a1d29', paper: '#ffffff', surface: '#f3f4f8', line: '#d9dce6', link: '#2f33c4', action: '#3b3fd8', actionInk: '#ffffff' },
    fonts: { heading: 'inter', body: 'inter' },
    radius: 'soft',
    logo: { url: '', alt: '' },
    pop: false,
  },
  'imagine-surrey': {
    key: 'imagine-surrey',
    label: 'Imagine Surrey',
    // Navy, yellow, ink, surface and line as on imaginesurrey.ca
    // (apps/web/src/app/globals.css: --navy, --yellow, --ink, --surface, --line);
    // action is its red for fills with white text (--red-fill, 5.1:1), and
    // headings carry the brand's layered red shadow (.pop).
    colors: { brand: '#003979', brandInk: '#ffffff', accent: '#fff100', accentInk: '#0f1e33', ink: '#0f1e33', paper: '#ffffff', surface: '#f2f4f8', line: '#e3e7ef', link: '#003979', action: '#d81b1e', actionInk: '#ffffff' },
    fonts: { heading: 'montserrat', body: 'montserrat' },
    radius: 'soft',
    logo: { url: '', alt: 'Imagine Surrey' },
    pop: true,
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
  const given = (k) => (hex(input?.colors?.[k]) ? `#${String(input.colors[k]).trim().replace('#', '').toLowerCase()}` : null);
  for (const k of COLOR_KEYS) colors[k] = given(k) ?? base.colors[k];
  // A changed brand colour carries the action buttons with it until the
  // action colour is set itself (a theme saved before it existed).
  if (!given('action') && colors.brand !== base.colors.brand) {
    colors.action = colors.brand;
    if (!given('actionInk')) colors.actionInk = colors.brandInk;
  }
  const fonts = {
    heading: FONT_BY_VALUE[input?.fonts?.heading] ? input.fonts.heading : base.fonts.heading,
    body: FONT_BY_VALUE[input?.fonts?.body] ? input.fonts.body : base.fonts.body,
  };
  const radius = RADII.some((r) => r.value === input?.radius) ? input.radius : base.radius;
  const logo = {
    url: typeof input?.logo?.url === 'string' && /^(\/(?!\/)|https:\/\/)/.test(input.logo.url) ? input.logo.url.slice(0, 500) : base.logo.url,
    alt: typeof input?.logo?.alt === 'string' ? input.logo.alt.slice(0, 200) : base.logo.alt,
  };
  // pop: the layered shadow under big headings, in the action colour.
  const pop = typeof input?.pop === 'boolean' ? input.pop : Boolean(base.pop);
  const theme = { skin: base.key, colors, fonts, radius, logo, pop };
  const problems = PAIRS.map((p) => ({ pair: p, ratio: contrast(colors[p.fg], colors[p.bg]) })).filter((x) => x.ratio < 4.5);
  return { theme, problems };
}

// ── Colours worked out from a theme (an admin never types these) ──
const toHex = (rgb) => `#${rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
// a moved toward b by t (0 = a, 1 = b).
export const mix = (a, b, t) => {
  const x = hex(a); const y = hex(b);
  return x && y ? toHex(x.map((v, i) => v + (y[i] - v) * t)) : a;
};
// The first of `steps` (a toward b) that reads at `min` on every background.
const readable = (a, b, steps, bgs, min) => {
  for (const t of steps) {
    const c = mix(a, b, t);
    if (bgs.every((bg) => contrast(c, bg) >= min)) return c;
  }
  return mix(a, b, steps[steps.length - 1]);
};

// The derived colours, each kept readable where the site uses it: muted
// text on the page and soft panels (4.5:1), soft text on the brand colour,
// form-field borders (3:1, WCAG 1.4.11), a deep brand for the footer and
// dark panels, and the error colour.
export function themeColors(theme) {
  const { theme: t } = checkTheme(theme);
  const c = t.colors;
  const light = contrast(c.paper, '#000000') > contrast(c.paper, '#ffffff');
  const deep = mix(c.brand, '#000000', 0.28);
  return {
    ...c,
    muted: readable(c.ink, c.paper, [0.3, 0.24, 0.18, 0.12, 0.06, 0], [c.paper, c.surface], 4.6),
    brandSoft: readable(c.brandInk, c.brand, [0.18, 0.12, 0.06, 0], [c.brand], 4.6),
    fieldLine: readable(c.ink, c.paper, [0.5, 0.42, 0.34, 0.26, 0.18, 0], [c.paper], 3.1),
    brandDeep: contrast(c.brandInk, deep) >= 4.5 ? deep : c.brand,
    danger: readable(light ? '#b42318' : '#ff8a80', c.ink, [0, 0.2, 0.4, 0.6, 0.8, 1], [c.paper, c.surface], 4.6),
    // The accent as a highlight on the brand colour and on the deep brand
    // (the hero's rotating word, the footer's headings), else plain text.
    accentOnBrand: contrast(c.accent, c.brand) >= 4.5 ? c.accent : c.brandInk,
    // Headings on the accent colour: the link colour (the brand's, usually)
    // when it reads there, as on imaginesurrey.ca's yellow band; else the
    // text-on-accent colour.
    headingOnAccent: contrast(c.link, c.accent) >= 4.5 ? c.link : c.accentInk,
    accentOnDeep: contrast(c.accent, contrast(c.brandInk, deep) >= 4.5 ? deep : c.brand) >= 4.5 ? c.accent : c.brandInk,
    pop: t.pop ? c.action : 'transparent',
    popAlt: t.pop ? (contrast(c.brandInk, deep) >= 4.5 ? deep : c.ink) : 'transparent',
  };
}

// The CSS variables for a theme (the renderer puts them in the page head).
export function themeCss(theme) {
  const { theme: t } = checkTheme(theme);
  const c = themeColors(t);
  const r = RADII.find((x) => x.value === t.radius)?.px ?? 10;
  return `:root{--brand:${c.brand};--brand-ink:${c.brandInk};--accent:${c.accent};--accent-ink:${c.accentInk};--ink:${c.ink};--paper:${c.paper};--surface:${c.surface};--line:${c.line};--link:${c.link};--radius:${r}px;--font-heading:${FONT_BY_VALUE[t.fonts.heading].stack};--font-body:${FONT_BY_VALUE[t.fonts.body].stack};`
    + `--action:${c.action};--action-ink:${c.actionInk};--muted:${c.muted};--brand-soft:${c.brandSoft};--field-line:${c.fieldLine};--brand-deep:${c.brandDeep};--danger:${c.danger};--accent-on-brand:${c.accentOnBrand};--accent-on-deep:${c.accentOnDeep};--heading-on-accent:${c.headingOnAccent};--pop:${c.pop};--pop-alt:${c.popAlt}}`;
}
