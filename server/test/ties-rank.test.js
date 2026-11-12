// One order for a person's ties (shared/ties.js): the server's key read and
// the screens' key line both name the same people first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankTies } from '@starbase/shared/ties';

const tie = (id, over = {}) => ({ kind: 'other', close: false, linked_at: '2026-01-01T00:00:00Z', ...over, person: { id, name: id, rating: null, ...(over.person || {}) } });
const order = (ties) => rankTies(ties).map((t) => t.person.id);

test('close first, then a supporter, then by kind, then the newest, then by name and id', () => {
  assert.deepEqual(order([tie('a'), tie('b', { close: true })]), ['b', 'a'], 'close first');
  assert.deepEqual(order([tie('a', { kind: 'family' }), tie('b', { person: { rating: '2' } }), tie('c', { person: { rating: '1' }, kind: 'work' })]),
    ['c', 'b', 'a'], 'a 1 or a 2 before any kind (a 1 and a 2 alike, then the kind)');
  assert.deepEqual(order([tie('b', { close: true }), tie('a', { close: true, person: { rating: '1' } })]), ['a', 'b'], 'among close ties, the supporter');
  assert.deepEqual(order([tie('a', { person: { rating: '3' } }), tie('b', { person: { rating: '4' } })]), ['a', 'b'], 'a 3 or a 4 is not a supporter');
  const kinds = ['other', 'community', 'work', 'neighbour', 'friend', 'family'];
  assert.deepEqual(rankTies(kinds.map((k, i) => tie(`p${i}`, { kind: k }))).map((t) => t.kind), [...kinds].reverse());
  assert.deepEqual(order([tie('a', { linked_at: '2026-01-01T00:00:00Z' }), tie('b', { linked_at: '2026-05-01T00:00:00Z' })]), ['b', 'a'], 'the newest');
  assert.deepEqual(order([tie('x', { person: { name: 'zed' } }), tie('y', { person: { name: 'Amy' } })]), ['y', 'x'], 'by name, any capitals');
  assert.deepEqual(order([tie('b', { person: { name: 'Sam' } }), tie('a', { person: { name: 'sam' } })]), ['a', 'b'], 'then by id');
});

test('a do-not-contact person is never a key tie; the input is left as it was', () => {
  const ties = [tie('a', { close: true, person: { dnc: true } }), tie('b')];
  assert.deepEqual(order(ties), ['b']);
  assert.equal(ties.length, 2);
  assert.equal(ties[0].person.id, 'a', 'a new array: the input keeps its order');
  assert.deepEqual(rankTies(null), []);
});
