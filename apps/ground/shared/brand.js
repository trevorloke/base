// base ground's brand: the presets, the fields a manager sets (Settings →
// Brand), and the design tokens they become. Shared by the server (it
// writes the tokens into every page it sends — server/lib/brand.js — so
// there's no flash of the default look) and the browser (the Brand page's
// live preview and contrast check, and the open app after a save).
//
// A brand is:
//   { preset, name, logo, primary, accent, surface, ink, onPrimary,
//     onAccent, font, corners }
//   preset     a key of PRESETS — the look it started from
//   name       shown in the top bar and on public pages (null: the
//              campaign's own name)
//   logo       '/media/<id>' (an upload) or an https:// URL (null: base
//              ground's own mark)
//   colours    '#rrggbb'; surface is the page, ink the text on it,
//              onPrimary / onAccent the text on those
//   font       a key of FONTS (all bundled in web/public/fonts — no
//              third-party font requests)
//   corners    'sharp' | 'soft' | 'round'
//
//   brandOf(input)        any partial brand → a whole, valid one (what's
//                         missing or invalid comes from its preset)
//   tokens(brand)         { '--paper': '#…', … } — every CSS custom property
//                         web/src/app.css reads
//   brandCss(brand)       ':root{…}' with those tokens
//   checks(brand)         the contrast pairs, each with its ratio and line
//   failing(brand)        the pairs under their line
//   validBrandInput(raw)  null, or the first thing wrong with a brand a
//                         manager sent (bad hex, unknown preset/font/…)
import { AA, AAA, UI, contrast, ensure, isDark, luminance, mix, normHex, readableOn, rgbList } from './contrast.js';

export const COLOR_KEYS = ['primary', 'accent', 'surface', 'ink', 'onPrimary', 'onAccent'];
export const COLOR_LABELS = {
  primary: 'Primary',
  accent: 'Accent',
  surface: 'Background',
  ink: 'Text',
  onPrimary: 'Text on primary',
  onAccent: 'Text on accent',
};

// The faces a brand may use. `sans` is everything people read; `display`
// the headlines and labels.
const SYSTEM = "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
export const FONTS = {
  atkinson: {
    label: 'Atkinson Hyperlegible',
    about: 'Made for low vision: every letter tells itself apart. Reads in sun.',
    sans: `'Atkinson Hyperlegible Next', ${SYSTEM}`,
    display: `'Atkinson Hyperlegible Next', ${SYSTEM}`,
    displayWeight: 800,
    tracking: '-0.01em',
  },
  'public-sans': {
    label: 'Public Sans',
    about: 'Plain and civic: the face of government forms that work.',
    sans: `'Public Sans', ${SYSTEM}`,
    display: `'Public Sans', ${SYSTEM}`,
    displayWeight: 800,
    tracking: '-0.015em',
  },
  inter: {
    label: 'Inter with Barlow Condensed',
    about: 'Inter to read, tall condensed headlines.',
    sans: `'Inter', ${SYSTEM}`,
    display: `'Barlow Condensed', 'Arial Narrow', 'Inter', ${SYSTEM}`,
    displayWeight: 700,
    tracking: '0.005em',
  },
  'source-serif': {
    label: 'Inter with Source Serif',
    about: 'Inter to read, warm serif headlines.',
    sans: `'Inter', ${SYSTEM}`,
    display: `'Source Serif 4', Georgia, 'Times New Roman', serif`,
    displayWeight: 700,
    tracking: '-0.01em',
  },
  system: {
    label: 'The device’s own',
    about: 'Whatever the phone or computer uses. Nothing to download.',
    sans: SYSTEM,
    display: SYSTEM,
    displayWeight: 700,
    tracking: '-0.01em',
  },
};
export const FONT_KEYS = Object.keys(FONTS);

// Corner radius: controls (buttons, fields), cards, and buttons themselves
// (round makes buttons pills).
export const CORNERS = {
  sharp: { label: 'Sharp', ctrl: '2px', card: '3px', btn: '2px' },
  soft: { label: 'Soft', ctrl: '8px', card: '12px', btn: '8px' },
  round: { label: 'Round', ctrl: '14px', card: '20px', btn: '999px' },
};
export const CORNER_KEYS = Object.keys(CORNERS);

export const PRESETS = {
  ground: {
    label: 'Ground',
    about: 'Field-ready and high-contrast: deep forest green, signal amber, warm off-white. base ground’s own.',
    primary: '#17462b',
    accent: '#ffb000',
    surface: '#f6f3ea',
    ink: '#111a14',
    onPrimary: '#ffffff',
    onAccent: '#1b1606',
    font: 'atkinson',
    corners: 'soft',
  },
  civic: {
    label: 'Civic',
    about: 'Navy and marigold, condensed headlines: a city-hall look.',
    primary: '#003979',
    accent: '#ffc72c',
    surface: '#f5f7fa',
    ink: '#121a28',
    onPrimary: '#ffffff',
    onAccent: '#00224d',
    font: 'inter',
    corners: 'soft',
  },
  night: {
    label: 'Night',
    about: 'Dark: mint and amber on green-black, for evening phone banks.',
    primary: '#6bd49a',
    accent: '#ffc24a',
    surface: '#0e1511',
    ink: '#e9f1eb',
    onPrimary: '#06140c',
    onAccent: '#1d1503',
    font: 'atkinson',
    corners: 'soft',
  },
  harvest: {
    label: 'Harvest',
    about: 'Warm: brick red and mustard on cream, serif headlines, round corners.',
    primary: '#9a3412',
    accent: '#e8b33a',
    surface: '#fbf5ea',
    ink: '#2a1a12',
    onPrimary: '#ffffff',
    onAccent: '#2a1a12',
    font: 'source-serif',
    corners: 'round',
  },
};
export const PRESET_KEYS = Object.keys(PRESETS);
export const DEFAULT_PRESET = 'ground';

export const isHex = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v.trim());

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const LOGO_MEDIA = new RegExp(`^/media/${UUID}(\\.(png|jpe?g|webp))?$`, 'i');
// An https:// address with nothing in it that could break out of an
// attribute or a CSS url().
const LOGO_URL = /^https:\/\/[a-z0-9.-]+(:\d+)?(\/[^\s"'<>()\\`]*)?$/i;
export const LOGO_MAX = 500;
export const NAME_MAX = 60;
export const isLogo = (v) => typeof v === 'string' && v.length <= LOGO_MAX && (LOGO_MEDIA.test(v) || LOGO_URL.test(v));

// The brand a preset alone makes.
export const presetBrand = (key = DEFAULT_PRESET) => {
  const k = PRESETS[key] ? key : DEFAULT_PRESET;
  const { label, about, ...p } = PRESETS[k];
  return { preset: k, name: null, logo: null, ...p };
};

// Any partial brand → a whole, valid one.
export const brandOf = (input = {}) => {
  const src = input && typeof input === 'object' ? input : {};
  const base = presetBrand(src.preset);
  const out = { ...base };
  for (const k of COLOR_KEYS) if (isHex(src[k])) out[k] = normHex(src[k]);
  if (FONTS[src.font]) out.font = src.font;
  if (CORNERS[src.corners]) out.corners = src.corners;
  const name = typeof src.name === 'string' ? src.name.trim().slice(0, NAME_MAX) : '';
  out.name = name || null;
  out.logo = isLogo(src.logo) ? src.logo : null;
  return out;
};

// null when fine; otherwise what's wrong, in words a manager reads.
export const validBrandInput = (raw) => {
  if (!raw || typeof raw !== 'object') return 'a brand';
  if (raw.preset !== undefined && !PRESETS[raw.preset]) return `preset: one of ${PRESET_KEYS.join(', ')}`;
  for (const k of COLOR_KEYS) {
    if (raw[k] !== undefined && !isHex(raw[k])) return `${COLOR_LABELS[k]}: a colour like #1f4d2e`;
  }
  if (raw.font !== undefined && !FONTS[raw.font]) return `font: one of ${FONT_KEYS.join(', ')}`;
  if (raw.corners !== undefined && !CORNERS[raw.corners]) return `corners: one of ${CORNER_KEYS.join(', ')}`;
  if (raw.name != null && (typeof raw.name !== 'string' || raw.name.trim().length > NAME_MAX)) return `name: at most ${NAME_MAX} characters`;
  if (raw.logo != null && raw.logo !== '' && !isLogo(raw.logo)) return 'logo: an uploaded picture or an https:// address';
  return null;
};

// Status colours a light or a dark page starts from; tokens() deepens them
// until they read on the brand's own cards.
const STATUS = {
  light: { ok: '#17703f', warn: '#8a5300', danger: '#b3261e' },
  dark: { ok: '#6fd69b', warn: '#f2b84b', danger: '#ff8f85' },
};

// Every design token the app reads, from one brand. The quiet tones are
// mixed from the brand's own colours, then pushed until they read: body
// text 7:1, quiet text 4.5:1, focus rings 3:1.
export const tokens = (input) => {
  const b = brandOf(input);
  const dark = luminance(b.surface) < luminance(b.ink);
  const white = '#ffffff';
  const black = '#000000';
  const font = FONTS[b.font];
  const corner = CORNERS[b.corners];

  const paper = b.surface;
  const paper0 = dark ? mix(paper, white, 0.06) : mix(paper, white, 0.7);
  const paper1 = mix(paper0, b.primary, dark ? 0.12 : 0.07);
  const paper2 = mix(paper0, b.primary, dark ? 0.22 : 0.14);
  const pages = [paper, paper0, paper1];

  const text2 = ensure(mix(b.ink, paper, 0.14), pages, AAA, b.ink);
  const text3 = ensure(mix(b.ink, paper, 0.36), pages, AA, b.ink);
  const text4 = mix(b.ink, paper, 0.55);
  const rule = mix(paper, b.ink, dark ? 0.16 : 0.13);
  const rule2 = mix(paper, b.ink, dark ? 0.3 : 0.26);

  // The mark: primary for fills; mark-deep its pressed / hover shade (and
  // a readable primary for text); link and focus always readable.
  const markDeep = mix(b.primary, b.ink, 0.28);
  const markSoft = mix(paper0, b.primary, dark ? 0.2 : 0.12);
  const link = ensure(b.primary, [paper, paper0], AA, b.ink);
  const focus = ensure(dark ? b.primary : markDeep, [paper, paper0], UI, b.ink);

  // The top bar (and the desktop sidebar): primary when its text is the
  // light one; on a dark brand with a light primary, a deep ground with the
  // primary as its spark.
  const navOnPrimary = luminance(b.onPrimary) > luminance(b.primary);
  const navBg = navOnPrimary ? b.primary : mix(paper, black, 0.35);
  const navInk = navOnPrimary ? b.onPrimary : b.ink;
  const navActive = navOnPrimary ? mix(b.primary, black, 0.3) : mix(navBg, b.primary, 0.18);
  const navQuiet = ensure(mix(navInk, navBg, 0.24), [navBg, navActive], AA, navInk);
  const sparkWant = navOnPrimary ? b.accent : b.primary;
  const navSpark = contrast(sparkWant, navBg) >= AA && contrast(sparkWant, navActive) >= UI ? sparkWant : navInk;

  const st = STATUS[dark ? 'dark' : 'light'];
  const ok = ensure(st.ok, [paper, paper0], AA, b.ink);
  const warn = ensure(st.warn, [paper, paper0], AA, b.ink);
  const danger = ensure(st.danger, [paper, paper0], AA, b.ink);

  const shade = dark ? '0, 0, 0' : rgbList(b.ink);
  return {
    '--font-sans': font.sans,
    '--font-display': font.display,
    '--display-weight': String(font.displayWeight),
    '--display-tracking': font.tracking,
    '--r-ctrl': corner.ctrl,
    '--r-card': corner.card,
    '--r-btn': corner.btn,
    '--paper': paper,
    '--paper-0': paper0,
    '--paper-1': paper1,
    '--paper-2': paper2,
    '--ink': b.ink,
    '--text-2': text2,
    '--text-3': text3,
    '--text-4': text4,
    '--rule': rule,
    '--rule-2': rule2,
    '--mark': b.primary,
    '--mark-ink': b.onPrimary,
    '--mark-deep': markDeep,
    '--mark-soft': markSoft,
    '--accent': b.accent,
    '--accent-ink': b.onAccent,
    '--link': link,
    '--focus': focus,
    '--nav-bg': navBg,
    '--nav-ink': navInk,
    '--nav-quiet': navQuiet,
    '--nav-active': navActive,
    '--nav-spark': navSpark,
    '--ok': ok,
    '--warn': warn,
    '--danger': danger,
    '--danger-ink': readableOn(danger),
    '--shadow-1': `0 1px 2px rgba(${shade}, ${dark ? 0.5 : 0.08}), 0 1px 1px rgba(${shade}, ${dark ? 0.3 : 0.04})`,
    '--shadow-2': `0 10px 30px rgba(${shade}, ${dark ? 0.55 : 0.16})`,
    '--scrim': `rgba(${dark ? '0, 0, 0' : rgbList(b.ink)}, ${dark ? 0.55 : 0.35})`,
    'color-scheme': dark ? 'dark' : 'light',
  };
};

// ':root{--paper:#…;…}' — nothing in it comes from a person but checked hex
// colours and keys of FONTS / CORNERS, so it's safe inside <style>.
export const brandCss = (input, selector = ':root') => {
  const t = tokens(input);
  return `${selector}{${Object.entries(t).map(([k, v]) => `${k}:${v}`).join(';')}}`;
};

// The pairs the Brand page checks. field: a field-screen body pair, held to
// 7:1 (volunteers read them outdoors); the rest 4.5:1.
export const checks = (input) => {
  const b = brandOf(input);
  const t = tokens(b);
  const pair = (key, label, fg, bg, min) => {
    const ratio = contrast(fg, bg);
    return { key, label, fg, bg, min, ratio, ok: ratio >= min, field: min === AAA };
  };
  return [
    pair('body', 'Body text on the page (field screens)', b.ink, t['--paper'], AAA),
    pair('card', 'Body text on a card (field screens)', b.ink, t['--paper-0'], AAA),
    pair('quiet', 'Quiet text: hints, labels', t['--text-3'], t['--paper-0'], AA),
    pair('primary', 'Text on primary: buttons', b.onPrimary, b.primary, AA),
    pair('accent', 'Text on accent: badges, the avatar', b.onAccent, b.accent, AA),
    pair('link', 'Links on a card', t['--link'], t['--paper-0'], AA),
    pair('nav', 'Top bar text', t['--nav-ink'], t['--nav-bg'], AA),
    pair('navquiet', 'Top bar, quiet text', t['--nav-quiet'], t['--nav-bg'], AA),
    pair('spark', 'Top bar, the campaign line', t['--nav-spark'], t['--nav-bg'], AA),
    pair('ok', 'Support (rating 1–2) on a card', t['--ok'], t['--paper-0'], AA),
    pair('warn', 'Undecided (rating 3) on a card', t['--warn'], t['--paper-0'], AA),
    pair('danger', 'Opposed, errors on a card', t['--danger'], t['--paper-0'], AA),
  ];
};
export const failing = (input) => checks(input).filter((c) => !c.ok);

// The colour the phone's own bar takes (meta theme-color).
export const themeColor = (input) => tokens(input)['--nav-bg'];

export { isDark };
