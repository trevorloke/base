// The website's fonts (WA stage 1): the faces base.win ships, the twelve
// ready-made pairings, and the Google fonts a campaign adds (fetched once by
// the server and kept with the campaign: server/ext/site/fonts.js). Every
// face is served from the site's own address; no visitor ever asks Google.
//
// A theme's fonts.heading / fonts.body is a built-in value ('inter') or an
// added font, 'g:<slug>'. `added` is the campaign's added fonts:
// [{ slug, family, category, bodySafe, faces: [{ subset, weight, style,
// unicode_range, sha256, bytes }] }].

export const LATIN = 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';
export const LATIN_EXT = 'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF';

// TR's Gurmukhi file, preloaded on /pa pages and counted in their budget.
export const GURMUKHI_FILE = 'fonts/noto-gurmukhi-400.woff2';

// The size of every built-in file a first visit may preload (bytes; a unit
// test reads the files and checks these).
export const FILE_BYTES = {
  'fonts/inter-latin.woff2': 48432,
  'fonts/montserrat-latin.woff2': 35508,
  'fonts/barlow-condensed-600-latin.woff2': 14844,
  'fonts/barlow-condensed-800-latin.woff2': 14764,
  'fonts/noto-gurmukhi-400.woff2': 11400,
  'fonts/space-grotesk-latin.woff2': 22288,
  'fonts/oswald-latin.woff2': 28488,
  'fonts/source-sans-3-latin.woff2': 28872,
  'fonts/archivo-black-400-latin.woff2': 18604,
  'fonts/archivo-latin.woff2': 34928,
  'fonts/dm-serif-display-400-latin.woff2': 24744,
  'fonts/dm-sans-latin.woff2': 36932,
  'fonts/fraunces-latin.woff2': 36620,
  'fonts/playfair-display-latin.woff2': 38404,
  'fonts/merriweather-400-latin.woff2': 49168,
  'fonts/merriweather-700-latin.woff2': 48660,
  'fonts/lato-400-latin.woff2': 23580,
  'fonts/lato-700-latin.woff2': 23040,
  'fonts/nunito-latin.woff2': 39128,
  'fonts/nunito-sans-latin.woff2': 31076,
};

// How a heading face is drawn: big headings (.display), the wordmark, a
// petition's title and the rail's title. Built-ins keep exactly the values
// site.css gave them before (WA decision 12); any other face gets one worked
// out from its weights (profileFor).
const P = (weight, tracking, leading, kase, wordmark, title, rail) => ({
  weight, tracking, leading, case: kase, synthesis: 'weight style',
  wordmark: { weight: wordmark[0], tracking: wordmark[1], case: wordmark[2] || 'none', size: wordmark[3] || '24px' },
  title: { weight: title[0], tracking: title[1] }, rail: { weight: rail[0], tracking: rail[1] },
});
const PROFILES = {
  montserrat: P(900, '0.025em', 1.05, 'none', [900, '0.02em'], [900, 'normal'], [900, '0.025em']),
  inter: P(800, '-0.025em', 1.04, 'none', [800, '-0.01em'], [800, '-0.02em'], [800, '-0.02em']),
  system: P(800, '-0.025em', 1.04, 'none', [800, '-0.01em'], [800, '-0.02em'], [900, '0.025em']),
  'barlow-condensed': P(800, '0.005em', 0.98, 'uppercase', [800, '-0.01em', 'uppercase', '28px'], [900, 'normal'], [900, '0.025em']),
  serif: P(700, '-0.01em', 1.05, 'none', [800, '-0.01em'], [900, 'normal'], [900, '0.025em']),
};

// The files of a built-in face: [file, weight, style, subset]. `from` is
// the npm package the catalogue script copies them from (scripts/
// google-fonts-catalogue.mjs --files); the first five faces were here before.
const V = (value, family, from, axis, italic) => ['latin', 'latin-ext'].flatMap((subset) => [
  { family, value, from, file: `fonts/${value}-${subset}.woff2`, source: `${value}-${subset}-wght-normal.woff2`, weight: axis, style: 'normal', subset },
  ...(italic ? [{ family, value, from, file: `fonts/${value}-italic-${subset}.woff2`, source: `${value}-${subset}-wght-italic.woff2`, weight: axis, style: 'italic', subset }] : []),
]);
const S = (value, family, from, weights, italic) => ['latin', 'latin-ext'].flatMap((subset) => [
  ...weights.map((w) => ({ family, value, from, file: `fonts/${value}-${w}-${subset}.woff2`, source: `${value}-${subset}-${w}-normal.woff2`, weight: String(w), style: 'normal', subset })),
  ...(italic ? [{ family, value, from, file: `fonts/${value}-400-italic-${subset}.woff2`, source: `${value}-${subset}-400-italic.woff2`, weight: '400', style: 'italic', subset }] : []),
]);
export const BUILT_FILES = [
  ...V('space-grotesk', 'Space Grotesk', '@fontsource-variable/space-grotesk', '300 700', false),
  ...V('oswald', 'Oswald', '@fontsource-variable/oswald', '200 700', false),
  ...V('source-sans-3', 'Source Sans 3', '@fontsource-variable/source-sans-3', '200 900', true),
  ...S('archivo-black', 'Archivo Black', '@fontsource/archivo-black', [400], false),
  ...V('archivo', 'Archivo', '@fontsource-variable/archivo', '100 900', true),
  ...S('dm-serif-display', 'DM Serif Display', '@fontsource/dm-serif-display', [400], false),
  ...V('dm-sans', 'DM Sans', '@fontsource-variable/dm-sans', '100 1000', true),
  ...V('fraunces', 'Fraunces', '@fontsource-variable/fraunces', '100 900', false),
  ...V('playfair-display', 'Playfair Display', '@fontsource-variable/playfair-display', '400 900', false),
  ...S('merriweather', 'Merriweather', '@fontsource/merriweather', [400, 700, 900], true),
  ...S('lato', 'Lato', '@fontsource/lato', [400, 700, 900], true),
  ...V('nunito', 'Nunito', '@fontsource-variable/nunito', '200 1000', true),
  ...V('nunito-sans', 'Nunito Sans', '@fontsource-variable/nunito-sans', '200 1000', true),
];

const SANS = "system-ui, -apple-system, 'Segoe UI', Roboto, Arial";
const SERIF = "Georgia, 'Times New Roman'";
// The fallback after a face for each kind of font.
const FALLBACK = { 'sans-serif': SANS, serif: SERIF, display: SANS, handwriting: SANS, monospace: "ui-monospace, Menlo, Consolas, 'Courier New'" };

// One built-in face. regular: the file body text loads first; heading: the
// file its heading weight loads (preloaded).
const F = (value, label, family, kind, body, regular, heading, extra = {}) => ({ value, label, family, kind, body, files: { regular, heading }, ...extra });
const BUILTIN = [
  F('inter', 'Inter', 'Inter', 'sans-serif', true, 'fonts/inter-latin.woff2', 'fonts/inter-latin.woff2', { desk: true }),
  F('montserrat', 'Montserrat', 'Montserrat', 'sans-serif', true, 'fonts/montserrat-latin.woff2', 'fonts/montserrat-latin.woff2', { fallback: "'Inter', system-ui, Arial" }),
  F('barlow-condensed', 'Barlow Condensed', 'Barlow Condensed', 'sans-serif', false, 'fonts/barlow-condensed-600-latin.woff2', 'fonts/barlow-condensed-800-latin.woff2', { fallback: "'Arial Narrow', 'Inter', system-ui", desk: true }),
  F('system', 'System', '', 'sans-serif', true, null, null, { fallback: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial", desk: true }),
  F('serif', 'Serif', '', 'serif', true, null, null, { desk: true }),
  F('space-grotesk', 'Space Grotesk', 'Space Grotesk', 'sans-serif', true, 'fonts/space-grotesk-latin.woff2', 'fonts/space-grotesk-latin.woff2', { axis: [300, 700] }),
  F('oswald', 'Oswald', 'Oswald', 'sans-serif', false, 'fonts/oswald-latin.woff2', 'fonts/oswald-latin.woff2', { axis: [200, 700] }),
  F('source-sans-3', 'Source Sans 3', 'Source Sans 3', 'sans-serif', true, 'fonts/source-sans-3-latin.woff2', 'fonts/source-sans-3-latin.woff2', { axis: [200, 900] }),
  F('archivo-black', 'Archivo Black', 'Archivo Black', 'sans-serif', false, 'fonts/archivo-black-400-latin.woff2', 'fonts/archivo-black-400-latin.woff2', { weights: [400] }),
  F('archivo', 'Archivo', 'Archivo', 'sans-serif', true, 'fonts/archivo-latin.woff2', 'fonts/archivo-latin.woff2', { axis: [100, 900] }),
  F('dm-serif-display', 'DM Serif Display', 'DM Serif Display', 'serif', false, 'fonts/dm-serif-display-400-latin.woff2', 'fonts/dm-serif-display-400-latin.woff2', { weights: [400] }),
  F('dm-sans', 'DM Sans', 'DM Sans', 'sans-serif', true, 'fonts/dm-sans-latin.woff2', 'fonts/dm-sans-latin.woff2', { axis: [100, 1000] }),
  F('fraunces', 'Fraunces', 'Fraunces', 'serif', false, 'fonts/fraunces-latin.woff2', 'fonts/fraunces-latin.woff2', { axis: [100, 900] }),
  F('playfair-display', 'Playfair Display', 'Playfair Display', 'serif', false, 'fonts/playfair-display-latin.woff2', 'fonts/playfair-display-latin.woff2', { axis: [400, 900] }),
  F('merriweather', 'Merriweather', 'Merriweather', 'serif', true, 'fonts/merriweather-400-latin.woff2', 'fonts/merriweather-700-latin.woff2', { weights: [400, 700, 900] }),
  F('lato', 'Lato', 'Lato', 'sans-serif', true, 'fonts/lato-400-latin.woff2', 'fonts/lato-700-latin.woff2', { weights: [400, 700, 900] }),
  F('nunito', 'Nunito', 'Nunito', 'sans-serif', true, 'fonts/nunito-latin.woff2', 'fonts/nunito-latin.woff2', { axis: [200, 1000] }),
  F('nunito-sans', 'Nunito Sans', 'Nunito Sans', 'sans-serif', true, 'fonts/nunito-sans-latin.woff2', 'fonts/nunito-sans-latin.woff2', { axis: [200, 1000] }),
];

// A font's CSS stack: its face, a fallback for its kind, Gurmukhi (TR), the
// reader's Chinese faces where a page is in Chinese (TR's --cjk), and the
// generic family.
export function stackFor(font) {
  const serif = font.kind === 'serif';
  const fallback = font.fallback || FALLBACK[font.kind] || SANS;
  const face = font.family ? `'${String(font.family).replace(/['\\]/g, '')}', ` : '';
  return `${face}${fallback}, 'Noto Sans Gurmukhi', var(--cjk, ${serif ? 'serif' : 'system-ui'}), ${serif ? 'serif' : 'sans-serif'}`;
}

export const FONTS = BUILTIN.map((f) => ({ ...f, stack: stackFor(f) }));
export const FONT_BY_VALUE = Object.fromEntries(FONTS.map((f) => [f.value, f]));

// The twelve ready-made pairings (owner item 2; swap one here). kb: what the
// pair adds to a first visit, worked out from the files by the catalogue
// script and checked by a unit test.
export const PAIRINGS = [
  { key: 'montserrat-montserrat', heading: 'montserrat', body: 'montserrat', feel: 'Strong', kb: 35 },
  { key: 'barlow-condensed-inter', heading: 'barlow-condensed', body: 'inter', feel: 'Strong', kb: 62 },
  { key: 'montserrat-inter', heading: 'montserrat', body: 'inter', feel: 'Modern', kb: 82 },
  { key: 'inter-inter', heading: 'inter', body: 'inter', feel: 'Modern', kb: 48 },
  { key: 'space-grotesk-inter', heading: 'space-grotesk', body: 'inter', feel: 'Modern', kb: 70 },
  { key: 'oswald-source-sans-3', heading: 'oswald', body: 'source-sans-3', feel: 'Strong', kb: 57 },
  { key: 'archivo-black-archivo', heading: 'archivo-black', body: 'archivo', feel: 'Strong', kb: 53 },
  { key: 'dm-serif-display-dm-sans', heading: 'dm-serif-display', body: 'dm-sans', feel: 'Classic', kb: 61 },
  { key: 'fraunces-inter', heading: 'fraunces', body: 'inter', feel: 'Classic', kb: 84 },
  { key: 'playfair-display-source-sans-3', heading: 'playfair-display', body: 'source-sans-3', feel: 'Classic', kb: 66 },
  { key: 'merriweather-lato', heading: 'merriweather', body: 'lato', feel: 'Classic', kb: 71 },
  { key: 'nunito-nunito-sans', heading: 'nunito', body: 'nunito-sans', feel: 'Friendly', kb: 69 },
];
export const FEELS = ['Modern', 'Classic', 'Strong', 'Friendly'];

// The files a pairing's first visit loads (for its kb).
export const pairFiles = (p) => [...new Set([FONT_BY_VALUE[p.body].files.regular, FONT_BY_VALUE[p.heading].files.heading].filter(Boolean))];

export const isAdded = (value) => /^g:[a-z0-9-]{1,80}$/.test(String(value || ''));
// 'Roboto Slab' → 'roboto-slab'
export const slugFor = (family) => String(family || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

// "100 900" or "400" → [min, max]
const range = (w) => { const [a, b] = String(w).split(/\s+/).map(Number); return [a, b || a]; };

// An added font as a face like the built-ins.
function addedFont(row) {
  const faces = Array.isArray(row?.faces) ? row.faces : [];
  const normal = faces.filter((f) => f.style !== 'italic');
  const ranges = normal.map((f) => range(f.weight));
  const variable = ranges.some(([a, b]) => b > a);
  const font = {
    value: `g:${row.slug}`, label: row.family, family: row.family, kind: row.category || 'sans-serif',
    body: Boolean(row.bodySafe ?? row.body_safe), added: true, faces,
    ...(variable ? { axis: [Math.min(...ranges.map((r) => r[0])), Math.max(...ranges.map((r) => r[1]))] } : { weights: [...new Set(ranges.map((r) => r[0]))].sort((a, b) => a - b) }),
  };
  const fileFor = (w) => {
    const f = normal.find((x) => x.subset === 'latin' && range(x.weight)[0] <= w && range(x.weight)[1] >= w)
      || normal.find((x) => x.subset === 'latin');
    return f ? `fonts/g/${f.sha256}.woff2` : null;
  };
  font.files = { regular: fileFor(400), heading: fileFor(profileFor(font).weight) };
  font.bytes = Object.fromEntries(faces.map((f) => [`fonts/g/${f.sha256}.woff2`, Number(f.bytes) || 0]));
  font.stack = stackFor(font);
  return font;
}

// The font for a theme value, or null (unknown, or an added font that isn't
// the campaign's).
export function fontFor(value, added = []) {
  if (FONT_BY_VALUE[value]) return FONT_BY_VALUE[value];
  if (!isAdded(value)) return null;
  const row = (Array.isArray(added) ? added : []).find((a) => a && `g:${a.slug}` === value);
  return row ? addedFont(row) : null;
}

// How a heading face is drawn (WA decision 12): a built-in's own values,
// else its heaviest weight up to 800, no letter-spacing (a little less for
// a bold sans serif), a little more line height for serif and script faces.
export function profileFor(font) {
  if (!font) return PROFILES.inter;
  if (PROFILES[font.value]) return PROFILES[font.value];
  let weight = 400;
  if (font.axis) weight = Math.max(font.axis[0], Math.min(800, font.axis[1]));
  else if (font.weights?.length) weight = font.weights.filter((w) => w <= 800).pop() || font.weights[0];
  const only400 = !font.axis && (font.weights || []).every((w) => w === 400);
  const tracking = font.kind === 'sans-serif' && weight >= 700 ? '-0.01em' : '0';
  const leading = font.kind === 'serif' || font.kind === 'handwriting' ? 1.15 : 1.1;
  return {
    weight, tracking, leading, case: 'none', synthesis: only400 ? 'none' : 'weight style',
    wordmark: { weight, tracking, case: 'none', size: '24px' }, title: { weight, tracking }, rail: { weight, tracking },
  };
}

// The CSS variables for a heading profile (site.css reads them).
export function profileCss(p) {
  return `--heading-weight:${p.weight};--heading-tracking:${p.tracking};--heading-leading:${p.leading};--heading-case:${p.case};--heading-synthesis:${p.synthesis};`
    + `--wordmark-weight:${p.wordmark.weight};--wordmark-tracking:${p.wordmark.tracking};--wordmark-case:${p.wordmark.case};--wordmark-size:${p.wordmark.size};`
    + `--title-weight:${p.title.weight};--title-tracking:${p.title.tracking};--rail-weight:${p.rail.weight};--rail-tracking:${p.rail.tracking};`;
}

// The files a page preloads (at most two): the body's regular and the
// heading's weight; on a Punjabi page the body's and Gurmukhi's (TR).
export function fontFilesFor(theme, added, lang) {
  const body = fontFor(theme?.fonts?.body, added);
  const heading = fontFor(theme?.fonts?.heading, added);
  if (lang === 'pa') return [body?.files?.regular, GURMUKHI_FILE].filter(Boolean);
  return [...new Set([body?.files?.regular, heading?.files?.heading].filter(Boolean))];
}

const bytesOf = (file, fonts) => FILE_BYTES[file] ?? fonts.reduce((n, f) => n || f?.bytes?.[file] || 0, 0);
// What a first visit downloads in fonts, in KB (WA decision 10).
export function firstVisitKb(theme, added, lang) {
  const fonts = [fontFor(theme?.fonts?.body, added), fontFor(theme?.fonts?.heading, added)];
  const bytes = fontFilesFor(theme, added, lang).reduce((n, file) => n + bytesOf(file, fonts), 0);
  return Math.ceil(bytes / 1024);
}

// The @font-face rules for added fonts, in the page head. `assets` is the
// site root's site-assets/ with no language prefix (one cached file serves
// every language).
const cssStr = (s) => String(s).replace(/[^A-Za-z0-9 \-]/g, '');
export function faceCss(fonts, assets) {
  const seen = new Set();
  let css = '';
  for (const font of fonts) {
    if (!font?.added || seen.has(font.value)) continue;
    seen.add(font.value);
    for (const f of font.faces) {
      if (!/^[a-f0-9]{64}$/.test(f.sha256)) continue;
      const range = String(f.unicode_range || '').replace(/[^A-Fa-f0-9U+,\- ]/g, '');
      css += `@font-face{font-family:'${cssStr(font.family)}';font-style:${f.style === 'italic' ? 'italic' : 'normal'};font-weight:${String(f.weight).replace(/[^0-9 ]/g, '')};font-display:swap;`
        + `src:url(${assets}fonts/g/${f.sha256}.woff2) format('woff2')${range ? `;unicode-range:${range}` : ''}}`;
    }
  }
  return css;
}

// The heading font for an email (ET): its name, then a web-safe face of its
// kind. Emails never load font files.
export function emailFontStack(theme, added) {
  const font = fontFor(theme?.fonts?.heading, added) || FONT_BY_VALUE.inter;
  const safe = font.kind === 'serif' ? "Georgia, 'Times New Roman', serif" : 'Arial, Helvetica, sans-serif';
  return font.family ? `'${cssStr(font.family)}', ${safe}` : safe;
}

// The words for a font that doesn't belong where it was put, or a budget
// broken (refused), and the soft notes (shown, not refused).
export const FONT_WORDS = {
  body: 'That font is made for headings. Pick a different one for body text.',
  budget: (kb) => `These fonts would add ${kb} KB to every first visit, which is slow on phones. Pick a lighter pair.`,
  slower: (kb) => `Adds ${kb} KB — a little slower on phones.`,
  display: 'Hard to read in long headings. Keep headings short.',
};
