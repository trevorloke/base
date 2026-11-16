// Activity's map frame (web/src/pages/dashFrame.js): framed on the campaign's
// own data — the turfs first, else the period's contacts without the stray
// one far away, with who was seen today — and never thrown wide by one dot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameOf } from '../../web/src/pages/dashFrame.js';

const NOW = Date.parse('2026-11-16T20:00:00Z');
// 50 doors in Newton, made up, spread over a few streets.
const newton = Array.from({ length: 50 }, (_, i) => ({ lat: 49.12 + (i % 10) * 0.002, lng: -122.85 + Math.floor(i / 10) * 0.003 }));

test('turfs win over dots', () => {
  const turfs = [
    { polygon: [[49.10, -122.80], [49.11, -122.80], [49.11, -122.79]] },
    { polygon: [[49.15, -122.75], [49.16, -122.74], [49.15, -122.74]] },
    { polygon: null },
  ];
  assert.deepEqual(frameOf({ turfs, dots: newton, people: [], today: NOW }), [[49.10, -122.80], [49.16, -122.74]]);
});

test('50 dots in Newton and one at Kelowna frame Newton only', () => {
  const dots = [...newton, { lat: 49.888, lng: -119.496 }];
  const [[s, w], [n, e]] = frameOf({ turfs: [], dots, people: [], today: NOW });
  assert.ok(n < 49.2 && e < -122.8, `framed ${s},${w} – ${n},${e}`);
  assert.ok(s >= 49.12 && w >= -122.85);
});

test('a position seen today counts; one seen yesterday is ignored', () => {
  const today = { where: { lat: 49.19, lng: -122.70, at: new Date(NOW - 60_000).toISOString() } };
  const yesterday = { where: { lat: 49.25, lng: -122.60, at: new Date(NOW - 26 * 3600_000).toISOString() } };
  const [, [n, e]] = frameOf({ turfs: [], dots: newton, people: [today, yesterday, { where: null }], today: NOW });
  assert.equal(n, 49.19);
  assert.equal(e, -122.70);
  // Only yesterday's position and nothing else: nothing to frame.
  assert.equal(frameOf({ turfs: [], dots: [], people: [yesterday], today: NOW }), null);
});

test('nothing → null (the map opens on the city)', () => {
  assert.equal(frameOf({ turfs: [], dots: [], people: [], today: NOW }), null);
  assert.equal(frameOf({}), null);
});
