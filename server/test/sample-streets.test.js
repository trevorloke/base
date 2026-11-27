// The by-hand street lookup (scripts/sample-streets.mjs) reads the City's
// blocks as the City writes them: "2500 MAIN ST" and also a range,
// "1500-1600 E 10TH AV". No network: the rows here are made up, a straight
// street on a grid near the sample's boxes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBlock, segmentFor, blockCheck } from '../../scripts/sample-streets.mjs';

test('a block number, a range of them, or none', () => {
  assert.deepEqual(parseBlock('2500 MAIN ST'), { low: 2500, high: 2500, name: 'MAIN ST' });
  assert.deepEqual(parseBlock('1500-1600 E 10TH AV'), { low: 1500, high: 1600, name: 'E 10TH AV' });
  assert.deepEqual(parseBlock('0-100 W 60TH AV'), { low: 0, high: 100, name: 'W 60TH AV' });
  assert.equal(parseBlock("STAMP'S LANDING"), null);
});

// A made-up street running east, one block every 0.001 degrees of longitude.
const row = (hblock, x1, x2, y = 49.25) => ({ hblock, geom: { geometry: { type: 'LineString', coordinates: [[x1, y], [x2, y]] } } });
const BOX = [49.24, -123.2, 49.26, -123.0];

test('a range block at the end of a straight run is part of the run', () => {
  const rows = [
    row('0-100 TEST ST', -123.104, -123.103),
    row('200 TEST ST', -123.103, -123.102),
    row('300 TEST ST', -123.102, -123.101),
    row('400-500 TEST ST', -123.101, -123.100),
    row('300 OTHER ST', -123.102, -123.101, 49.251),
  ];
  const got = segmentFor(rows, 'Test St', BOX);
  assert.deepEqual(got.segment, [[49.25, -123.104], [49.25, -123.1]], 'the whole street, its low-numbered end first');
  assert.deepEqual(got.blocks, [0, 400]);
  assert.ok(got.metres > 280 && got.metres < 300, `${got.metres} m: four blocks of about 73 m`);
});

test('the low-numbered end first when the range block is the low end', () => {
  const rows = [row('900 TEST ST', -123.104, -123.103), row('800-850 TEST ST', -123.103, -123.102)];
  assert.deepEqual(segmentFor(rows, 'Test St', BOX).segment, [[49.25, -123.102], [49.25, -123.104]]);
});

test('a block from 9900 up is caught, a range one too', () => {
  const rows = [row('9300 A ST', 0, 1), row('100 B ST', 0, 1), row('UNNAMED ST', 0, 1)];
  assert.deepEqual(blockCheck(rows, 9900), { highest: 9300, from: [] });
  assert.deepEqual(blockCheck([...rows, row('9900-10000 X ST', 0, 1)], 9900), { highest: 10000, from: ['9900-10000 X ST'] });
  assert.deepEqual(blockCheck([...rows, row('9800-9900 Y ST', 0, 1)], 9900), { highest: 9900, from: ['9800-9900 Y ST'] }, 'a range reaching 9900 counts');
  assert.deepEqual(blockCheck([...rows, row('9900 Z ST', 0, 1)], 9900), { highest: 9900, from: ['9900 Z ST'] });
});
