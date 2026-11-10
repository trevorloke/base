// One brand colour in, every shade the app draws with out (shared/brand-look.js):
// each pair the shell and the shared pieces draw is readable for any colour a
// manager could pick — 4.5:1 for words, 3:1 for edges and marks (WCAG 2.2) —
// in light and dark and under each sidebar. The two built-in looks are
// presets through the same rule, and app.css's own values are the base
// preset's, so a page nobody branded looks the same as one the server did.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { contrast } from '@starbase/shared/site/theme';
import { BRANDS } from '@starbase/shared/brand';
import { deriveLook, lookTokens, lookCss, SIDEBARS, CORNERS } from '@starbase/shared/brand-look';

const SCHEMES = ['light', 'dark'];
const failing = (look) => look.checks.filter((c) => !c.ok).map((c) => `${c.what} ${c.ratio.toFixed(2)} < ${c.min} (${c.fg} on ${c.bg})`);

test('the two built-in looks: every pair reads, light and dark', () => {
  for (const key of Object.keys(BRANDS)) for (const scheme of SCHEMES) {
    const look = deriveLook(BRANDS[key], scheme);
    assert.deepEqual(failing(look), [], `${key} ${scheme}`);
    assert.ok(look.checks.length >= 30, 'the pairs the shell draws are all checked');
  }
});

test('the brand colour is the fill exactly as chosen; words and edges are walked to readable', () => {
  const navy = deriveLook({ color: '#003979', second: '#ffc72c' }, 'light');
  assert.deepEqual([navy.accent, navy.accentInk, navy.accentWords, navy.accentEdge], ['#003979', '#ffffff', '#003979', '#003979'], 'a dark brand is its own words and edge');
  const yellow = deriveLook({ color: '#fff100' }, 'light');
  assert.equal(yellow.accent, '#fff100', 'the fill is the colour chosen');
  assert.equal(yellow.accentInk, '#14161a', 'dark text on a light fill');
  assert.notEqual(yellow.accentWords, '#fff100', 'yellow words would not read on white');
  assert.ok(contrast(yellow.accentWords, '#ffffff') >= 4.5 && contrast(yellow.accentEdge, '#ffffff') >= 3);
  const dark = deriveLook({ color: '#003979' }, 'dark');
  assert.equal(dark.accent, '#003979', 'the fill is the brand in dark too');
  assert.ok(contrast(dark.accentWords, dark.card) >= 4.5, 'navy words are lightened on a dark card');
  assert.equal(deriveLook({ color: '#003979', second: '#ffc72c' }, 'light').second, '#ffc72c');
  assert.equal(deriveLook({ color: '#003979' }, 'light').second, '#003979', 'no second colour: the brand stands in');
});

test('anything a manager could type falls back to a safe choice', () => {
  const look = deriveLook({ color: 'javascript:alert(1)', second: 'red', sidebar: 'purple', corners: 'spiky', heading: '</style>' }, 'light');
  assert.equal(look.accent, BRANDS.base.color, 'a bad colour is base.win’s');
  assert.equal(look.sidebar, 'light');
  assert.deepEqual(look.radii, CORNERS.soft);
  const css = lookCss({ color: '#12ab9c', heading: '</style><script>' });
  assert.doesNotMatch(css, /[<>]|url\(|javascript/i, 'nothing but colours, sizes and a font from the list');
  assert.equal(deriveLook({ color: '#ABCDEF' }, 'light').accent, '#abcdef', 'any case');
  assert.equal(deriveLook({}, 'light').accent, deriveLook(undefined, 'light').accent);
});

test('the tokens: every role, light and dark, with no address in them', () => {
  const t = lookTokens(BRANDS['imagine-surrey']);
  for (const scheme of SCHEMES) {
    for (const name of ['--page', '--card', '--panel', '--panel-2', '--line', '--line-strong', '--field-edge', '--text', '--text-2', '--quiet', '--faint',
      '--accent', '--accent-ink', '--accent-hover', '--accent-words', '--accent-edge', '--accent-edge-ink', '--focus', '--tint', '--tint-2', '--second', '--second-ink',
      '--side', '--side-top', '--side-ink', '--side-quiet', '--side-hover', '--side-active', '--side-active-ink', '--side-mark', '--side-edge',
      '--inverse', '--inverse-2', '--inverse-ink', '--inverse-quiet']) {
      assert.match(t[scheme][name] || '', /^#[0-9a-f]{6}$/, `${scheme} ${name}`);
    }
  }
  assert.deepEqual([t.light['--r-sm'], t.light['--r-ctrl'], t.light['--r-card'], t.light['--r-sheet']], ['6px', '8px', '12px', '16px'], 'soft corners');
  assert.match(t.light['--font-display'], /^'Inter'/);
  assert.equal(t.dark['--r-ctrl'], undefined, 'shapes are said once, not per scheme');
  const css = lookCss(BRANDS['imagine-surrey']);
  assert.match(css, /^:root\{[^{}]+\}@media \(prefers-color-scheme:dark\)\{:root\{[^{}]+\}\}$/);
  assert.doesNotMatch(css, /url\(|\/\//, 'no addresses: a client’s path never has to be written into it');
  assert.ok(css.length < 3200, `small enough to ride in every page (${css.length} bytes)`);
});

test('corners and headings', () => {
  assert.deepEqual(deriveLook({ color: '#003979', corners: 'square' }, 'light').radii, [4, 6, 8]);
  assert.deepEqual(deriveLook({ color: '#003979', corners: 'round' }, 'light').radii, [8, 12, 18]);
  assert.match(lookTokens({ color: '#003979', heading: 'barlow-condensed' }).light['--font-display'], /^'Barlow Condensed'/);
});

// 5,000 colours (half with a second colour) x light and dark x each sidebar:
// no pair the shell draws falls under its floor, whatever the colour.
test('any colour is safe: a sweep of 5,000, each sidebar, light and dark', () => {
  let seed = 11;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const colour = () => `#${[0, 1, 2].map(() => Math.floor(rand() * 256).toString(16).padStart(2, '0')).join('')}`;
  const edge = ['#fff100', '#d81b1e', '#f9a8d4', '#111111', '#000000', '#ffffff', '#777777', '#a3e635', '#f26b21', '#0f766e', '#4f46e5', '#003979', '#ffc72c'];
  const colours = [...edge.map((c) => [c, null]), ...edge.map((c, i) => [c, edge[(i + 5) % edge.length]])];
  for (let i = colours.length; i < 5000; i += 1) colours.push([colour(), rand() < 0.5 ? colour() : null]);
  let checks = 0;
  const bad = {};
  for (const sidebar of SIDEBARS) for (const [color, second] of colours) for (const scheme of SCHEMES) {
    const look = deriveLook({ color, second, sidebar }, scheme);
    checks += look.checks.length;
    for (const c of look.checks) if (!c.ok) (bad[`${sidebar} ${scheme}: ${c.what}`] ||= []).push(`${color}${second ? `+${second}` : ''} ${c.ratio.toFixed(2)}`);
  }
  assert.deepEqual(Object.fromEntries(Object.entries(bad).map(([k, v]) => [k, `${v.length}, e.g. ${v[0]}`])), {});
  assert.ok(checks > 900000, `${checks} pairs checked`);
});

const APP_CSS = readFileSync(new URL('../../web/src/app.css', import.meta.url), 'utf8');
const pairs = (text) => Object.fromEntries([...String(text || '').matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const marked = (name) => new RegExp(`/\\* ${name} \\*/([\\s\\S]*?)/\\* end \\*/`).exec(APP_CSS)?.[1];

test('status words read on every ground (the brand never recolours them, so they are said once)', () => {
  for (const scheme of SCHEMES) {
    const status = pairs(marked(`status:${scheme}`));
    const look = deriveLook(BRANDS.base, scheme);
    for (const name of ['--ok', '--warn', '--danger']) {
      assert.match(status[name] || '', /^#[0-9a-f]{6}$/, `${scheme} ${name} is in app.css`);
      for (const ground of [look.page, look.card, look.panel]) {
        assert.ok(contrast(status[name], ground) >= 4.5, `${scheme} ${name} ${status[name]} on ${ground}: ${contrast(status[name], ground).toFixed(2)}`);
      }
    }
  }
});

test('app.css’s own values are the base preset’s, through the same rule', () => {
  const want = lookTokens(BRANDS.base);
  assert.ok(marked('look:light') && marked('look:dark'), 'app.css marks the two blocks the rule writes');
  assert.deepEqual(pairs(marked('look:light')), want.light, 'light: `node scripts/look-tokens.mjs` prints the block to paste');
  assert.deepEqual(pairs(marked('look:dark')), want.dark, 'dark: `node scripts/look-tokens.mjs` prints the block to paste');
});
