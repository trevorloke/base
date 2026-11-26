// The website's look: a handful of tokens an admin edits in Website → Theme,
// turned into CSS variables on every public page. One look ships, Base; a
// campaign whose set-up brings its own look has it added when the program
// starts (presetLooks below), and no other campaign is ever offered it.
// Contrast is checked here — a pair that fails WCAG 2.2 AA (4.5:1 for
// text) can't be saved — so no admin can skin the site into unreadable.

// The faces (built-in and a campaign's added Google fonts) live in fonts.js.
import { FONTS, FONT_BY_VALUE, FONT_WORDS, fontFor, firstVisitKb, profileFor, profileCss } from './fonts.js';
export { FONTS, FONT_BY_VALUE };

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
// Every pair of colours an admin picks that the site draws text in. The
// rest of the site's text is in colours worked out from these, each kept
// readable where it is used (themeColors) — e2e-site-render.mjs sweeps
// themes at this check's edge and reads every piece of text on every
// module, background and form state.
export const PAIRS = [
  { fg: 'ink', bg: 'paper', label: 'Text on the page' },
  { fg: 'ink', bg: 'surface', label: 'Text on soft panels' },
  { fg: 'brandInk', bg: 'brand', label: 'Text on brand colour (buttons, bands)' },
  { fg: 'accentInk', bg: 'accent', label: 'Text on accent colour' },
  { fg: 'link', bg: 'paper', label: 'Links on the page' },
  { fg: 'link', bg: 'surface', label: 'Links and headings on soft panels' },
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
};

// The looks a campaign has beyond Base: its set-up's own, if it has one.
// Whoever runs this code says what they are — the server from its settings
// (server/ext/site/from-preset.js), the Website screens from GET /api/site
// (skins), a draft's preview from the page's own data — and they are asked
// each time, so nothing is kept here. Nothing registered: Base alone.
let extraLooks = () => [];
export const presetLooks = (fn) => { extraLooks = typeof fn === 'function' ? fn : () => []; };
const isLook = (l) => Boolean(l && typeof l === 'object' && typeof l.key === 'string' && l.key && l.key !== 'base' && l.colors && l.fonts);
// Base first, then the campaign's own.
export const allLooks = () => {
  let more = [];
  try { more = extraLooks(); } catch { more = []; }
  return [SKINS.base, ...(Array.isArray(more) ? more.filter(isLook) : [])];
};
// A look by its name, or null: a name this campaign doesn't have is no look.
export const lookOf = (name) => (typeof name === 'string' && name ? allLooks().find((l) => l.key === name) || null : null);

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

// Check a theme: { theme, problems: [{ pair, ratio } | { font, words }],
// notes } — problems empty when every pair reaches 4.5:1 and the fonts are
// readable and light enough (WA decision 10); notes are shown, never
// refused. Unknown or bad values fall back to the skin's. `added` is the
// campaign's added fonts (fonts.js): an added font that isn't among them
// falls back too. Without `added` (a theme the server already checked, read
// back) an added font's value is kept as it is. `punjabi`: the site is
// offered in Punjabi, whose first visit is counted too. `keepBody`: the body
// font the theme was saved with — a theme saved before the rule (Barlow
// Condensed for body text) keeps working and can still be saved.
export function checkTheme(input, skin = 'base', { added, punjabi = false, keepBody } = {}) {
  const base = lookOf(input?.skin) || lookOf(skin) || SKINS.base;
  const colors = {};
  const given = (k) => (hex(input?.colors?.[k]) ? `#${String(input.colors[k]).trim().replace('#', '').toLowerCase()}` : null);
  for (const k of COLOR_KEYS) colors[k] = given(k) ?? base.colors[k];
  // A changed brand colour carries the action buttons with it until the
  // action colour is set itself (a theme saved before it existed).
  if (!given('action') && colors.brand !== base.colors.brand) {
    colors.action = colors.brand;
    if (!given('actionInk')) colors.actionInk = colors.brandInk;
  }
  const known = (v) => Boolean(FONT_BY_VALUE[v] || (added ? fontFor(v, added) : /^g:[a-z0-9-]{1,80}$/.test(String(v || ''))));
  const fonts = {
    heading: known(input?.fonts?.heading) ? input.fonts.heading : base.fonts.heading,
    body: known(input?.fonts?.body) ? input.fonts.body : base.fonts.body,
  };
  const radius = RADII.some((r) => r.value === input?.radius) ? input.radius : base.radius;
  const logo = {
    url: typeof input?.logo?.url === 'string' && /^(\/(?!\/)|https:\/\/)/.test(input.logo.url) ? input.logo.url.slice(0, 500) : base.logo.url,
    alt: typeof input?.logo?.alt === 'string' ? input.logo.alt.slice(0, 200) : base.logo.alt,
  };
  // pop: the layered shadow under big headings, in the action colour.
  const pop = typeof input?.pop === 'boolean' ? input.pop : Boolean(base.pop);
  // follow: the site wears the campaign's brand (Settings → Brand) instead
  // of these colours, until it is given its own look (server/ext/site
  // store.js siteOf). A website made before this existed has no such key:
  // it keeps its own look.
  const follow = input?.follow === true;
  const theme = { skin: base.key, colors, fonts, radius, logo, pop, follow };
  // kept: a website that had its own look when it began to follow keeps it
  // here underneath, to go back to (the server says so: site.settings.save).
  if (follow && input?.kept === true) theme.kept = true;
  const problems = PAIRS.map((p) => ({ pair: p, ratio: contrast(colors[p.fg], colors[p.bg]) })).filter((x) => x.ratio < 4.5);
  const notes = [];
  if (added) {
    // Body text only in a face checked for long reading.
    const body = fontFor(fonts.body, added);
    if (body && !body.body && fonts.body !== keepBody) problems.push({ font: 'body', words: FONT_WORDS.body });
    const heading = fontFor(fonts.heading, added);
    if (heading && (heading.kind === 'display' || heading.kind === 'handwriting')) notes.push({ font: 'heading', words: FONT_WORDS.display });
    // The speed budget: the larger of the English and Punjabi first visits.
    const kb = Math.max(firstVisitKb(theme, added, 'en'), punjabi ? firstVisitKb(theme, added, 'pa') : 0);
    if (kb > 150) problems.push({ font: 'budget', kb, words: FONT_WORDS.budget(kb) });
    else if (kb > 100) notes.push({ font: 'budget', kb, words: FONT_WORDS.slower(kb) });
  }
  return { theme, problems, notes };
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
// text on the page and soft panels (4.5:1), soft text on the brand colour
// and the deep brand (the footer, dark panels), soft text and the highlight
// on the Dark background (ink), form-field borders (3:1, WCAG 1.4.11), a
// deep brand for the footer and dark panels, the error colour (and the page
// colour reads on it: a "Broken" badge), and the event rows on the action
// colour.
export function themeColors(theme) {
  const { theme: t } = checkTheme(theme);
  const c = t.colors;
  const light = contrast(c.paper, '#000000') > contrast(c.paper, '#ffffff');
  const deep = mix(c.brand, '#000000', 0.28);
  const brandDeep = contrast(c.brandInk, deep) >= 4.5 ? deep : c.brand;
  // The events' rows: a little of the deep brand on the action colour,
  // unless that takes the text on them under 4.5:1.
  const row = mix(c.action, brandDeep, 0.35);
  return {
    ...c,
    muted: readable(c.ink, c.paper, [0.3, 0.24, 0.18, 0.12, 0.06, 0], [c.paper, c.surface], 4.6),
    brandSoft: readable(c.brandInk, c.brand, [0.18, 0.12, 0.06, 0], [c.brand, brandDeep], 4.6),
    inkSoft: readable(c.paper, c.ink, [0.2, 0.14, 0.08, 0], [c.ink], 4.6),
    fieldLine: readable(c.ink, c.paper, [0.5, 0.42, 0.34, 0.26, 0.18, 0], [c.paper], 3.1),
    brandDeep,
    actionRow: contrast(c.actionInk, row) >= 4.5 ? row : c.action,
    danger: readable(light ? '#b42318' : '#ff8a80', c.ink, [0, 0.2, 0.4, 0.6, 0.8, 1], [c.paper, c.surface], 4.6),
    // The accent as a highlight on the Dark background, else plain text.
    accentOnInk: contrast(c.accent, c.ink) >= 4.5 ? c.accent : c.paper,
    // The accent as a highlight on the brand colour and on the deep brand
    // (the hero's rotating word, the footer's headings), else plain text.
    accentOnBrand: contrast(c.accent, c.brand) >= 4.5 ? c.accent : c.brandInk,
    // Headings on the accent colour: the link colour (the brand's, usually)
    // when it reads there (a navy heading on a yellow band, say); else the
    // text-on-accent colour.
    headingOnAccent: contrast(c.link, c.accent) >= 4.5 ? c.link : c.accentInk,
    accentOnDeep: contrast(c.accent, brandDeep) >= 4.5 ? c.accent : c.brandInk,
    pop: t.pop ? c.action : 'transparent',
    popAlt: t.pop ? (brandDeep === deep ? deep : c.ink) : 'transparent',
  };
}

// The CSS variables for a theme (the renderer puts them in the page head).
// `added`: the campaign's added fonts the theme may use.
export function themeCss(theme, added) {
  const { theme: t } = checkTheme(theme, undefined, { added });
  const heading = fontFor(t.fonts.heading, added) || FONT_BY_VALUE[lookOf(t.skin)?.fonts.heading] || FONT_BY_VALUE.inter;
  const body = fontFor(t.fonts.body, added) || FONT_BY_VALUE[lookOf(t.skin)?.fonts.body] || FONT_BY_VALUE.inter;
  const c = themeColors(t);
  const r = RADII.find((x) => x.value === t.radius)?.px ?? 10;
  return `:root{--brand:${c.brand};--brand-ink:${c.brandInk};--accent:${c.accent};--accent-ink:${c.accentInk};--ink:${c.ink};--paper:${c.paper};--surface:${c.surface};--line:${c.line};--link:${c.link};--radius:${r}px;--font-heading:${heading.stack};--font-body:${body.stack};${profileCss(profileFor(heading))}`
    + `--action:${c.action};--action-ink:${c.actionInk};--muted:${c.muted};--brand-soft:${c.brandSoft};--field-line:${c.fieldLine};--brand-deep:${c.brandDeep};--danger:${c.danger};--accent-on-brand:${c.accentOnBrand};--accent-on-deep:${c.accentOnDeep};--heading-on-accent:${c.headingOnAccent};--pop:${c.pop};--pop-alt:${c.popAlt};`
    + `--ink-soft:${c.inkSoft};--accent-on-ink:${c.accentOnInk};--action-row:${c.actionRow}}`;
}
