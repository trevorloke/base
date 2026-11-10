// Prints the two token blocks web/src/app.css holds between its
// /* look:light */ and /* look:dark */ marks: the base preset through the
// one rule (shared/brand-look.js). Run it and paste when the rule or the
// preset changes; server/test/brand-look.test.js fails until they match.
//   node scripts/look-tokens.mjs            the base preset
//   node scripts/look-tokens.mjs '#003979'  any colour, to see its shades
import { BRANDS } from '@starbase/shared/brand';
import { deriveLook, lookTokens } from '@starbase/shared/brand-look';

const color = process.argv[2];
const brand = color ? { ...BRANDS.base, color, second: process.argv[3] || null } : BRANDS.base;
const t = lookTokens(brand);
const lines = (vars, pad) => {
  const out = [];
  let row = [];
  for (const [k, v] of Object.entries(vars)) {
    row.push(`${k}: ${v};`);
    if (row.join(' ').length > 84 || k === '--panel-2' || k === '--field-edge' || k === '--faint' || k === '--focus' || k === '--second-ink' || k === '--side-edge' || k === '--inverse-quiet' || k === '--brand-spark' || k === '--r-sheet') { out.push(pad + row.join(' ')); row = []; }
  }
  if (row.length) out.push(pad + row.join(' '));
  return out.join('\n');
};
console.log(`  /* look:light */\n${lines(t.light, '  ')}\n  /* end */`);
console.log(`\n    /* look:dark */\n${lines(t.dark, '    ')}\n    /* end */`);
for (const scheme of ['light', 'dark']) {
  const bad = deriveLook(brand, scheme).checks.filter((c) => !c.ok);
  if (bad.length) console.error(`${scheme}: ${bad.map((c) => `${c.what} ${c.ratio.toFixed(2)}`).join('; ')}`);
}
