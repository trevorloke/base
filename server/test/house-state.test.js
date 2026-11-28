// The map's house door switch (web/src/components/houseState.js): each
// door's state comes from the server's answer for the open round first,
// then knocks made on this phone, and a walk list kept on the phone only
// when the server can't answer (offline), and only that round's. No browser
// needed. Every name and address is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keptFor, serverStates, houseDoorState, firstToKnock } from '../../web/src/components/houseState.js';

const door = (key, ids) => ({ key, persons: ids.map((id) => ({ id })) });
const MAIN = door('10388 134 st|', ['ana']);
const BSMT = door('10388 134 st|BSMT', ['ben']);
const kept = (passId, doors, at = 1) => ({ at, data: { pass: passId ? { id: passId } : null, doors } });

test('the server answer wins: a door knocked from another phone is not "Not knocked"', () => {
  const server = serverStates({ pass: { id: 'r2' }, doors: [
    { key: MAIN.key, unit: '', state: 'again', in_round: true },
    { key: BSMT.key, unit: 'BSMT', state: 'open', in_round: true },
  ] });
  assert.equal(houseDoorState(MAIN, { server }), 'again');
  assert.equal(houseDoorState(BSMT, { server }), 'open');
  // A knock made on this phone (sent, or still in the outbox) is newer than the answer.
  assert.equal(houseDoorState(BSMT, { server, knocks: { ben: { outcome: 'refused' } } }), 'done');
  assert.equal(houseDoorState(BSMT, { server, knocks: { ben: { outcome: 'no_answer' } } }), 'again');
  // Done on the server stays done.
  const done = serverStates({ doors: [{ key: MAIN.key, state: 'done', in_round: true }] });
  assert.equal(houseDoorState(MAIN, { server: done, knocks: { ana: { outcome: 'no_answer' } } }), 'done');
  // Not on this round.
  const off = serverStates({ doors: [{ key: BSMT.key, state: 'open', in_round: false }] });
  assert.equal(houseDoorState(BSMT, { server: off }), 'off');
  // A door the server didn't name (added on this phone since): not knocked.
  assert.equal(houseDoorState(door('10388 134 st|COACH', ['cy']), { server }), 'open');
  // Voted wins (Election day).
  assert.equal(houseDoorState(MAIN, { server, voted: true }), 'voted');
  // With the server's answer, a kept list is not read at all.
  const old = keptFor([kept('r2', [{ civic: '10388 134 st', state: 'done', persons: [{ id: 'ana' }] }])]);
  assert.equal(houseDoorState(MAIN, { server, kept: old }), 'again');
});

test('offline: only the walk lists kept for the open round are read', () => {
  // The newest list is this round's (r2); an older list from the round before says Main is done.
  const lists = [
    kept('r2', [{ civic: '10388 134 st', state: 'open', persons: [{ id: 'ana' }], house_doors: [{ unit: '', in_round: true }, { unit: 'BSMT', in_round: false }] }], 3),
    kept('r1', [{ civic: '10388 134 st', state: 'done', persons: [{ id: 'ana' }] }, { civic: '10388 134 st', state: 'done', persons: [{ id: 'ben' }] }], 2),
  ];
  const k = keptFor(lists);
  assert.equal(houseDoorState(MAIN, { kept: k }), 'open', 'last round\'s Done is not this round\'s');
  assert.equal(houseDoorState(BSMT, { kept: k }), 'off', 'this round leaves the suite out');
  // The round the server named (answered for another house earlier) picks the lists.
  assert.equal(houseDoorState(MAIN, { kept: keptFor(lists, 'r1') }), 'done');
  assert.equal(houseDoorState(MAIN, { kept: keptFor(lists, 'r9') }), 'open', 'no list for that round: nothing kept is read');
  // No list at all: not knocked, and this phone's own knocks still count.
  assert.equal(houseDoorState(MAIN, {}), 'open');
  assert.equal(houseDoorState(MAIN, { knocks: { ana: { outcome: 'no_answer' } } }), 'again');
  assert.equal(houseDoorState(MAIN, { kept: keptFor([]) }), 'open');
});

test('a tap on the house opens the first door not knocked, else the first to try again, else Main', () => {
  const states = (m) => (d) => m[d.key];
  const coach = door('10388 134 st|COACH', ['cy']);
  const doors = [MAIN, BSMT, coach];
  assert.equal(firstToKnock(doors, states({ [MAIN.key]: 'again', [BSMT.key]: 'open', [coach.key]: 'open' })), BSMT);
  assert.equal(firstToKnock(doors, states({ [MAIN.key]: 'done', [BSMT.key]: 'again', [coach.key]: 'done' })), BSMT);
  assert.equal(firstToKnock(doors, states({ [MAIN.key]: 'done', [BSMT.key]: 'done', [coach.key]: 'off' })), MAIN);
  assert.equal(firstToKnock(doors, states({ [MAIN.key]: 'open', [BSMT.key]: 'open', [coach.key]: 'open' })), MAIN);
  assert.equal(firstToKnock([], () => 'open'), null);
});
