// lib/geo.js walk order (HR-1): the units of one house number come out
// floor by floor, and one tower written several ways is one street.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAddress, walkOrder } from '../lib/geo.js';

const d = (address, unit = null) => ({ address, unit, lat: 49.19, lng: -122.85, persons: [] });
const label = (x) => `${x.address}${x.unit ? ` ${x.unit}` : ''}`;

test('parseAddress: plain lines as they always were', () => {
  assert.deepEqual(parseAddress('12345 72 Ave'), { number: 12345, street: '72 ave' });
  assert.deepEqual(parseAddress('12345A 72 Ave'), { number: 12345, street: '72 ave' });
  assert.deepEqual(parseAddress('  General Delivery '), { number: Infinity, street: 'general delivery' });
  assert.deepEqual(parseAddress(''), { number: Infinity, street: '' });
  assert.deepEqual(parseAddress(), { number: Infinity, street: '' });
  // One street, however it is spelled; the unit inside the address is not the house number.
  assert.deepEqual(parseAddress('13450 104 Avenue.'), { number: 13450, street: '104 ave' });
  assert.deepEqual(parseAddress('1203-13450 104 Ave'), { number: 13450, street: '104 ave' });
});

test('walkOrder: one house number’s units in floor order, the street order unchanged', () => {
  const out = walkOrder([
    d('13450 104 Ave', '1203'), d('13451 104 Ave'), d('13450 104 Ave', '201'), d('13452 104 Ave'),
    d('13450 104 Ave', 'PH1'), d('13449 104 Ave'), d('13450 104 Ave', '1001'), d('5 Oak St'),
  ]);
  assert.deepEqual(out.map(label), [
    '13449 104 Ave', '13451 104 Ave',
    '13452 104 Ave', '13450 104 Ave 201', '13450 104 Ave 1001', '13450 104 Ave 1203', '13450 104 Ave PH1',
    '5 Oak St',
  ]);
});

test('walkOrder: a tower written four ways comes out consecutive and floor by floor', () => {
  const out = walkOrder([
    d('13450 104 Ave', '305'), d('13460 104 Ave'), d('1203-13450 104 Ave'), d('13450 104 Avenue', '201'),
    d('13448 104 Ave'), d('13450 104 Ave.', '1001'), d('13450 104 Ave', '202'),
  ]);
  assert.deepEqual(out.map(label), [
    '13460 104 Ave',
    '13450 104 Avenue 201', '13450 104 Ave 202', '13450 104 Ave 305', '13450 104 Ave. 1001', '1203-13450 104 Ave',
    '13448 104 Ave',
  ]);
});
