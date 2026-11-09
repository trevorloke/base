// The theme check covers every colour pair the site draws text in
// (shared/site/theme.js): what an admin picks is checked as a pair (PAIRS,
// refused under 4.5:1 by Website → Theme and site.settings.save), and every
// other colour text is drawn in is worked out from those and kept readable
// on the background it is drawn on (themeColors). e2e-site-render.mjs reads
// every piece of text on every module and background in themes at this
// check's edge; this is the same rule without a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkTheme, contrast, mix, themeColors, themeCss, PAIRS } from '../../shared/site/theme.js';

test('links and headings on soft panels are a checked pair: the review’s pale panels (4.0:1) are refused', () => {
  assert.ok(PAIRS.some((p) => p.fg === 'link' && p.bg === 'surface'));
  const { problems } = checkTheme({ skin: 'base', colors: { accent: '#3b3fd8', accentInk: '#ffffff', surface: '#a9b0bb' } });
  assert.deepEqual(problems.map((p) => [p.pair.label, Number(p.ratio.toFixed(2))]), [['Links and headings on soft panels', 4.02]]);
});

// Themes at the check's edge: each text colour just reaches 4.5:1 on what
// the check names for it, from a random colour (seeded).
let seed = 7;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const color = (lo = 0, hi = 255) => `#${[0, 1, 2].map(() => Math.round(lo + rand() * (hi - lo)).toString(16).padStart(2, '0')).join('')}`;
const barely = (colors, fg) => {
  const bgs = PAIRS.filter((p) => p.fg === fg).map((p) => colors[p.bg]);
  for (let tries = 0; tries < 40; tries += 1) {
    const start = color();
    for (const toward of ['#000000', '#ffffff']) {
      for (let t = 0; t <= 1.0001; t += 0.02) {
        const c = mix(start, toward, Math.min(1, t));
        if (bgs.every((bg) => contrast(c, bg) >= 4.5)) return c;
      }
    }
  }
  return null;
};
const themes = [{ skin: 'base', colors: { brand: '#ffcc00', brandInk: '#000000' } }];
while (themes.length < 400) {
  const dark = rand() < 0.4;
  const paper = dark ? color(0, 70) : color(190, 255);
  const colors = { paper, surface: mix(paper, dark ? '#ffffff' : '#000000', rand() * 0.2), brand: color(), accent: color(), action: color() };
  for (const fg of ['ink', 'link', 'brandInk', 'accentInk', 'actionInk']) colors[fg] = barely(colors, fg);
  if (Object.values(colors).every(Boolean) && !checkTheme({ skin: 'base', colors }).problems.length) themes.push({ skin: 'base', colors, pop: rand() < 0.5 });
}

test('every colour worked out from a theme reads where the site draws text in it', () => {
  const bad = [];
  for (const t of themes) {
    const c = themeColors(t);
    // [the text colour, what it is drawn on, where]
    const drawn = [
      [c.muted, c.paper, 'muted text on the page'], [c.muted, c.surface, 'muted text on soft panels'],
      [c.brandSoft, c.brand, 'soft text on the brand colour'], [c.brandSoft, c.brandDeep, 'soft text in the footer and dark panels'],
      [c.brandInk, c.brandDeep, 'text in the footer and dark panels'],
      [c.inkSoft, c.ink, 'soft text on the Dark background'], [c.accentOnInk, c.ink, 'the highlight on the Dark background'],
      [c.paper, c.ink, 'text on the Dark background'],
      [c.accentOnBrand, c.brand, 'the highlight on the brand colour'], [c.accentOnDeep, c.brandDeep, 'the highlight in the footer'],
      [c.headingOnAccent, c.accent, 'headings on the accent colour'],
      [c.actionInk, c.actionRow, 'the events’ rows on the action colour'],
      [c.danger, c.paper, 'errors on the page'], [c.danger, c.surface, 'errors on soft panels'],
      [c.paper, c.danger, '“Broken” on the error colour'],
      [c.paper, c.link, 'a chosen amount, the WhatsApp button'],
    ];
    for (const [fg, bg, where] of drawn) {
      const r = contrast(fg, bg);
      if (!(r >= 4.5)) bad.push(`${where}: ${fg} on ${bg} ${r.toFixed(2)} (${JSON.stringify(t.colors)})`);
    }
  }
  assert.deepEqual(bad.slice(0, 5), [], `${bad.length} unreadable in ${themes.length} themes`);
});

test('the page carries them: --ink-soft, --accent-on-ink, --action-row', () => {
  const css = themeCss({ skin: 'base', colors: { brand: '#ffcc00', brandInk: '#000000' } });
  for (const v of ['--ink-soft', '--accent-on-ink', '--action-row']) assert.match(css, new RegExp(`${v}:#[0-9a-f]{6}`));
});
