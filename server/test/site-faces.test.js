// The site's @font-face rules: a family's Gurmukhi faces (TR) must not hide
// its Latin faces. The browser groups a family's faces by their descriptors
// (weight range, style); faces declared with different weight ranges are
// different faces, and for a weight both cover it picks one of them and never
// looks in the other. So where Gurmukhi is declared under a Latin family's
// name, the Latin files must be declared under the very same weight ranges,
// or Latin text falls through to a fallback face.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const css = readFileSync(fileURLToPath(new URL('../../shared/site/site.css', import.meta.url)), 'utf8');

function faces() {
  const out = [];
  for (const m of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const body = m[1];
    const get = (k) => (body.match(new RegExp(`${k}\\s*:\\s*([^;]+);`)) || [])[1]?.trim() || '';
    out.push({
      family: get('font-family').replace(/["']/g, ''),
      style: get('font-style') || 'normal',
      weight: get('font-weight').replace(/\s+/g, ' '),
      gurmukhi: /gurmukhi/.test(get('src')),
    });
  }
  return out;
}

test('a family with Gurmukhi faces declares its Latin files under the same weight ranges', () => {
  const all = faces();
  const families = [...new Set(all.filter((f) => f.gurmukhi && f.family !== 'Noto Sans Gurmukhi').map((f) => f.family))];
  assert.ok(families.length >= 3, 'TR declares Gurmukhi under the theme faces');
  for (const fam of families) {
    const ranges = (g) => [...new Set(all.filter((f) => f.family === fam && f.style === 'normal' && f.gurmukhi === g).map((f) => f.weight))].sort();
    assert.deepEqual(ranges(false), ranges(true), `${fam}: the Latin and Gurmukhi faces use the same weight ranges`);
  }
});
