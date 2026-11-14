// shared/maps.js: Directions in Google Maps (no key, no charge, never an
// origin) and the search link texts, emails and calendar files keep.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { directionsUrl, searchUrl } from '../../shared/maps.js';
import { mapUrl, whereWords, pinName } from '../../shared/shiftkinds.js';

const DIR = 'https://www.google.com/maps/dir/?api=1&destination=';

test('a pin: its point; words: encoded with the city and province, unless the words already name them', () => {
  assert.equal(directionsUrl({ lat: 49.1, lng: -122.8 }), `${DIR}49.1,-122.8`);
  assert.equal(directionsUrl({ lat: '49.19', lng: '-122.84', address: '13450 104 Ave' }), `${DIR}49.19,-122.84`, 'the pin wins');
  assert.equal(directionsUrl({ address: '13450 104 Ave', city: 'Surrey', province: 'BC' }), `${DIR}${encodeURIComponent('13450 104 Ave, Surrey, BC')}`);
  assert.equal(directionsUrl({ address: 'Holland Park, Surrey BC', city: 'Surrey', province: 'BC' }), `${DIR}${encodeURIComponent('Holland Park, Surrey BC')}`);
  // "name, street" is how people write a place: the comma is no reason to leave the city out.
  assert.equal(directionsUrl({ address: 'Newton Library, 7183 136 St', city: 'Surrey', province: 'BC' }), `${DIR}${encodeURIComponent('Newton Library, 7183 136 St, Surrey, BC')}`);
  assert.equal(directionsUrl({ address: 'Newton Library, Surrey', city: 'Surrey', province: 'BC' }), `${DIR}${encodeURIComponent('Newton Library, Surrey, BC')}`);
  assert.equal(directionsUrl({ address: '7183 136 St, Surrey, B.C. V3W 1A1', city: 'Surrey', province: 'BC' }), `${DIR}${encodeURIComponent('7183 136 St, Surrey, B.C. V3W 1A1')}`);
  assert.equal(directionsUrl({ address: '10355 King George Blvd & 88 Ave' }), `${DIR}${encodeURIComponent('10355 King George Blvd & 88 Ave')}`);
});

test('travelmode only for the four modes; never an origin; null with neither a pin nor an address', () => {
  for (const mode of ['walking', 'driving', 'bicycling', 'transit']) {
    assert.equal(directionsUrl({ lat: 49.1, lng: -122.8 }, { mode }), `${DIR}49.1,-122.8&travelmode=${mode}`);
  }
  assert.equal(directionsUrl({ lat: 49.1, lng: -122.8 }, { mode: 'flying' }), `${DIR}49.1,-122.8`);
  for (const u of [directionsUrl({ lat: 49.1, lng: -122.8 }, { mode: 'walking' }), directionsUrl({ address: '1 A St' })]) assert.doesNotMatch(u, /origin/);
  assert.equal(directionsUrl({}), null);
  assert.equal(directionsUrl({ lat: null, lng: null, address: '  ' }), null);
  assert.equal(directionsUrl(), null);
});

test('mapUrl is today’s search link, byte for byte', () => {
  assert.equal(mapUrl({ lat: 49.1234, lng: -122.8456 }), 'https://www.google.com/maps/search/?api=1&query=49.1234,-122.8456');
  assert.equal(mapUrl, searchUrl);
  assert.equal(whereWords(pinName(49.1234, -122.8456)), 'see the map — https://www.google.com/maps/search/?api=1&query=49.1234,-122.8456');
});
