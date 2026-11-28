// Small words about a person shared by People and the person search.
//
//   streetLine(p)          "Basement suite · 10388 134 St", "Unit 4 · 14520 72 Ave":
//                          the door's words, then the street (shared/units.js
//                          doorLine: one way on every screen; a unit written
//                          inside the address reads as one in the Unit column)
//   <UnitSuggestions id>   the Unit field's suggestions (a datalist: Main,
//                          Basement suite, Coach house…); people can still
//                          type anything
import { createElement } from 'react';
import { SUITE_TYPED, doorLine } from '../../../shared/units.js';

// (A row the server sends with place 'house' — a door at a house with
// suites — reads as the map, the walk list and the profile read it:
// "Suite B · 10500 134 St", "Main · 10388 134 St".)
export const streetLine = (p) => (p?.address ? doorLine(p) : '');

export function UnitSuggestions({ id }) {
  return createElement('datalist', { id }, SUITE_TYPED.map((w) => createElement('option', { key: w, value: w })));
}
