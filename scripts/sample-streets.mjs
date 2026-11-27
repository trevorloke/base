// Looks up the street pieces staging's sample puts its dots on, and checks
// that its made-up house numbers (9900-9999) are on none of its streets.
// Run by hand when the sample's streets change; staging never runs it.
//
//   NODE_USE_ENV_PROXY=1 node scripts/sample-streets.mjs   (behind a proxy)
//   node scripts/sample-streets.mjs
//
// Both come from the City of Vancouver's open data (opendata.vancouver.ca),
// under the Open Government Licence – Vancouver
// (https://opendata.vancouver.ca/pages/licence/):
//   - "Public streets": the centreline of every city street, one block at a
//     time. For each of the 20 streets in server/lib/samplecast.js, it takes
//     the longest straight run of blocks inside the neighbourhood's box
//     (every corner along it within 1.5 m of the straight line between its
//     ends), its low-numbered end first, and prints SEGMENTS to copy in.
//   - "Property addresses": every civic number on each street, to show
//     none is 9900-9999. That list holds the addresses VanMap shows, which
//     the City says is not every address there is. So it also looks at
//     every block number on every street, and at the addresses in the
//     "Business licences" list.
// It prints; it changes nothing. Nothing here is real people's data.
import { pathToFileURL } from 'node:url';
import { AREAS, HOUSE_FIRST, HOUSE_LAST } from '../server/lib/samplecast.js';

const BASE = 'https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets';
const STRAIGHT = 1.5; // metres: how far a corner may sit off the line

// The City's spelling: "E 10th Ave" is E 10TH AV, "Cotton Dr" is COTTON DRIVE.
const cityName = (street) => street.toUpperCase().replace(/\s+/g, ' ').replace(/ AVE(NUE)?$/, ' AV').replace(/ STREET$/, ' ST').replace(/ DR$/, ' DRIVE');

const all = async (dataset, where, select) => {
  const url = `${BASE}/${dataset}/exports/json?${new URLSearchParams(where ? { where, select } : { select })}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${dataset}: ${r.status} ${await r.text()}`);
  return r.json();
};

// Metres between two [lng, lat] points, near enough at this size.
const metres = ([x1, y1], [x2, y2]) => Math.hypot((x2 - x1) * 111320 * Math.cos((y1 * Math.PI) / 180), (y2 - y1) * 110540);
const offLine = (p, a, b) => {
  const k = Math.cos((a[1] * Math.PI) / 180);
  const [px, py, ax, ay, bx, by] = [p[0] * k, p[1], a[0] * k, a[1], b[0] * k, b[1]];
  const len = Math.hypot(bx - ax, by - ay);
  return (Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len) * 110540;
};
const key = ([x, y]) => `${x.toFixed(6)},${y.toFixed(6)}`;

// A block's number and street: "2500 MAIN ST" is the 2500 block of MAIN ST.
// null when it has no number.
export const parseBlock = (hblock) => {
  const m = /^(\d+) (.*)$/.exec(hblock);
  return m ? { low: Number(m[1]), high: Number(m[1]), name: m[2] } : null;
};

// Every block of every street, fetched once.
let blocksOnce;
const streets = () => (blocksOnce ||= all('public-streets', '', 'hblock,geom').then((rows) => rows.filter((r) => r.hblock)));

// The longest straight run of this street's blocks inside the box, from
// the City's rows ({ hblock, geom }).
export const segmentFor = (rows, street, box) => {
  const [s, w, n, e] = box;
  const inBox = ([x, y]) => y >= s && y <= n && x >= w && x <= e;
  const name = cityName(street);
  const blocks = rows
    .map((r) => ({ block: parseBlock(r.hblock || ''), geometry: r.geom?.geometry }))
    .filter(({ block, geometry }) => block?.name === name && geometry?.type === 'LineString')
    .map(({ block, geometry }) => ({ number: block.low, line: geometry.coordinates }))
    .filter((b) => b.line.every(inBox));
  // Join blocks end to end into lines (a street is broken at every corner).
  const ends = new Map();
  for (const b of blocks) for (const p of [b.line[0], b.line.at(-1)]) ends.set(key(p), [...(ends.get(key(p)) || []), b]);
  const used = new Set();
  const lines = [];
  for (const start of blocks) {
    if (used.has(start)) continue;
    // Walk back to one end of this line, then forward to the other.
    let b = start; let at = start.line[0];
    const seen = new Set([b]);
    for (;;) {
      const next = (ends.get(key(at)) || []).find((o) => !seen.has(o));
      if (!next) break;
      seen.add(next);
      at = key(next.line[0]) === key(at) ? next.line.at(-1) : next.line[0];
      b = next;
    }
    const points = []; const numbers = [];
    let from = at; let cur = b;
    while (cur && !used.has(cur)) {
      used.add(cur);
      const line = key(cur.line[0]) === key(from) ? cur.line : [...cur.line].reverse();
      for (const p of points.length ? line.slice(1) : line) { points.push(p); numbers.push(cur.number); }
      from = line.at(-1);
      cur = (ends.get(key(from)) || []).find((o) => !used.has(o));
    }
    lines.push({ points, numbers });
  }
  let best = null;
  for (const { points, numbers } of lines) {
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        if (!points.slice(i + 1, j).every((p) => offLine(p, points[i], points[j]) <= STRAIGHT)) continue;
        const len = metres(points[i], points[j]);
        if (!best || len > best.len) best = { len, a: points[i], b: points[j], na: numbers[i], nb: numbers[j] };
      }
    }
  }
  if (!best) throw new Error(`${street}: no block of it inside the box`);
  // The low-numbered end first, so numbers rise the way the street's do.
  const [a, b] = best.na <= best.nb ? [best.a, best.b] : [best.b, best.a];
  const ll = ([x, y]) => [Number(y.toFixed(6)), Number(x.toFixed(6))];
  return { segment: [ll(a), ll(b)], metres: Math.round(best.len), blocks: [Math.min(best.na, best.nb), Math.max(best.na, best.nb)] };
};

// The highest block number on any street, and every block from `from` up.
export const blockCheck = (rows, from) => {
  const blocks = rows.map((r) => ({ hblock: r.hblock, block: parseBlock(r.hblock || '') })).filter((b) => b.block);
  return {
    highest: Math.max(...blocks.map((b) => b.block.high)),
    from: blocks.filter((b) => b.block.high >= from).map((b) => b.hblock),
  };
};

// Every civic number on the street in the City's address list.
const numbersOn = async (street) => {
  const rows = await all('property-addresses', `std_street = "${cityName(street)}"`, 'civic_number');
  return rows.map((r) => Number(String(r.civic_number).replace(/\D.*$/, ''))).filter(Number.isFinite);
};

// Run as a script (not when a test imports it).
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const segments = {};
  let clash = 0;
  for (const area of AREAS) {
    for (const street of area.streets) {
      const { segment, metres: m, blocks } = segmentFor(await streets(), street, area.box);
      segments[street] = segment;
      const nums = await numbersOn(street);
      const ours = nums.filter((x) => x >= HOUSE_FIRST && x <= HOUSE_LAST);
      clash += ours.length;
      console.log(`${street}: ${m} m (the ${blocks[0]} to ${blocks[1]} blocks); ${nums.length} addresses, highest ${Math.max(...nums)}, ${ours.length} from ${HOUSE_FIRST} to ${HOUSE_LAST}${ours.length ? `: ${ours.join(', ')}` : ''}`);
    }
  }
  // No street in the city has a block numbered 9900 or more.
  const { highest, from: blocks99 } = blockCheck(await streets(), HOUSE_FIRST);
  console.log(`The highest block number on any street in the city: ${highest}${blocks99.length ? `; from ${HOUSE_FIRST} up: ${blocks99.join(', ')}` : ''}`);
  // Business licences (same licence) give addresses too: none at 9900-9999 on these streets.
  const ours = new Set(AREAS.flatMap((a) => a.streets.map(cityName)));
  const onOurs = (await all('business-licences', '', 'house,street')).filter((r) => ours.has(cityName(String(r.street || '').trim())));
  const licences = onOurs.filter((r) => Number(r.house) >= HOUSE_FIRST && Number(r.house) <= HOUSE_LAST);
  clash += licences.length;
  console.log(`Business licences on these streets: ${onOurs.length}, highest ${Math.max(...onOurs.map((r) => Number(r.house)).filter(Number.isFinite))}; from ${HOUSE_FIRST} to ${HOUSE_LAST}: ${licences.length ? licences.map((r) => `${r.house} ${r.street}`).join(', ') : 'none'}`);
  console.log('\nSEGMENTS = {');
  for (const [street, seg] of Object.entries(segments)) console.log(`  '${street}': ${JSON.stringify(seg).replace(/,/g, ', ')},`);
  console.log('}');
  process.exit(clash || blocks99.length ? 1 : 0);
}
