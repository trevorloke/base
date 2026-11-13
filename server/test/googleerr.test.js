// lib/googleerr.js: what Google said, in plain words, with the setup step
// that fixes it — and every step it names is a step in GOING-LIVE.md §5.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { googleTrouble, TROUBLES } from '../lib/googleerr.js';

const tiles = (status, message, reason) => ({ error: { code: status, message, status: 'PERMISSION_DENIED', ...(reason ? { details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason }] } : {}) } });
const geo = (status, message) => ({ status, error_message: message, results: [] });

test('every row of the table: by Google’s reason first, then by its words', () => {
  const cases = [
    // [http status, body, code, step]
    [400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } }, 'key-invalid', 'Recipe B step 6'],
    [200, geo('REQUEST_DENIED', 'The provided API key is invalid. '), 'key-invalid', 'Recipe B step 6'],
    [403, tiles(403, 'Requests from referer <empty> are blocked.', 'API_KEY_HTTP_REFERRER_BLOCKED'), 'referrer', 'Recipe B step 4'],
    [200, geo('REQUEST_DENIED', 'API keys with referer restrictions cannot be used with this API.'), 'referrer', 'Recipe B step 4'],
    [403, tiles(403, 'Blocked.', 'API_KEY_IP_ADDRESS_BLOCKED'), 'ip', 'Recipe B step 4'],
    [200, geo('REQUEST_DENIED', 'This IP, site or mobile application is not authorized to use this API key. Request received from IP address 203.0.113.9, with empty referer'), 'ip', 'Recipe B step 4'],
    [403, tiles(403, 'Requests to this API tile.googleapis.com method google.maps.tile.v1.CreateSession are blocked.', 'API_KEY_SERVICE_BLOCKED'), 'api-blocked', 'Recipe B step 4'],
    [403, tiles(403, 'Requests to this API method are blocked.'), 'api-blocked', 'Recipe B step 4'],
    [403, tiles(403, 'Map Tiles API has not been used in project 123 before or it is disabled.', 'SERVICE_DISABLED'), 'api-off', 'Recipe B step 3'],
    [200, geo('REQUEST_DENIED', 'This API project is not authorized to use this API.'), 'api-off', 'Recipe B step 3'],
    [403, tiles(403, 'This API method requires billing to be enabled.', 'BILLING_DISABLED'), 'billing', 'Recipe B step 2'],
    [200, geo('REQUEST_DENIED', 'You must enable Billing on the Google Cloud Project.'), 'billing', 'Recipe B step 2'],
    [429, 'Too Many Requests', 'quota', 'Recipe B step 5'],
    [429, tiles(429, 'Quota exceeded for quota metric.', 'RATE_LIMIT_EXCEEDED'), 'quota', 'Recipe B step 5'],
    [200, geo('OVER_QUERY_LIMIT', 'You have exceeded your daily request quota for this API.'), 'quota', 'Recipe B step 5'],
    [400, { error: { code: 400, message: 'The session token is expired.', status: 'INVALID_ARGUMENT' } }, 'session', null],
    [403, tiles(403, 'Nope.', 'expired'), 'session', null],
    [400, 'Bad Request', 'other', null],
  ];
  for (const [status, body, code, step] of cases) {
    const t = googleTrouble(status, body);
    assert.equal(t.code, code, JSON.stringify(body));
    assert.equal(t.step, step, code);
    assert.equal(t.plain, code === 'other' ? 'Google refused (400).' : code === 'ip' && t.plain.includes('203.') ? t.plain : TROUBLES.find((r) => r.code === code).plain);
  }
  assert.equal(googleTrouble(200, geo('REQUEST_DENIED', 'Something new.')).plain, 'Google refused (REQUEST_DENIED).');
  // Google's own words: Map Tiles' message, or Geocoding's status and message.
  assert.equal(googleTrouble(400, cases[0][1]).said, 'API key not valid. Please pass a valid API key.');
  assert.equal(googleTrouble(200, cases[1][1]).said, 'REQUEST_DENIED: The provided API key is invalid.');
});

test('the address Google saw, said to the manager', () => {
  const t = googleTrouble(200, geo('REQUEST_DENIED', 'This IP, site or mobile application is not authorized to use this API key. Request received from IP address 203.0.113.9, with empty referer'));
  assert.equal(t.plain, 'This key doesn’t allow this server’s address. Remove the IP-address restriction. This server reached Google from 203.0.113.9.');
});

test('Google’s words: a key scrubbed, at most 300 characters, a console link kept whole', () => {
  assert.equal(googleTrouble(400, tiles(400, 'Bad call to https://tile.googleapis.com/v1/x?key=AIzaSECRET&session=1')).said, 'Bad call to https://tile.googleapis.com/v1/x?key=…&session=1');
  const link = 'https://console.cloud.google.com/apis/api/tile.googleapis.com/overview?project=123456789012';
  const long = `Map Tiles API has not been used in project 123456789012 before or it is disabled. ${'Enable it by visiting the page below, then retry. '.repeat(5)}Enable it by visiting ${link} then retry.`;
  assert.ok(long.length > 300);
  const t = googleTrouble(403, tiles(403, long, 'SERVICE_DISABLED'));
  assert.ok(t.said.includes(link), t.said);
  assert.ok(t.said.length <= 300 + link.length + 2);
  assert.ok(t.said.startsWith('Map Tiles API has not been used'));
  assert.equal(googleTrouble(403, tiles(403, 'x'.repeat(400))).said.length, 301);
});

test('every step named is a step of GOING-LIVE.md §5', () => {
  const doc = readFileSync(new URL('../../GOING-LIVE.md', import.meta.url), 'utf8');
  const s5 = doc.slice(doc.indexOf('## 5 ·'), doc.indexOf('## 6 ·'));
  for (const { step } of TROUBLES.filter((t) => t.step)) {
    const [, recipe, n] = step.match(/^Recipe ([AB]) step (\d+)$/);
    const start = s5.indexOf(`#### Recipe ${recipe} `);
    assert.ok(start >= 0, `Recipe ${recipe} in §5`);
    const body = s5.slice(start, s5.indexOf('\n#### ', start + 1));
    assert.match(body, new RegExp(`^${n}\\. `, 'm'), step);
  }
});

test('a key limited to other services: the words name the two APIs base.win uses (Map Tiles and Places (New))', () => {
  const t = googleTrouble(403, { error: { code: 403, message: 'Requests to this API places.googleapis.com method google.maps.places.v1.Places.AutocompletePlaces are blocked.', details: [{ reason: 'API_KEY_SERVICE_BLOCKED' }] } });
  assert.equal(t.code, 'api-blocked');
  assert.equal(t.plain, 'This key is limited to other Google services. Add Map Tiles API and Places API (New) to it.');
  assert.equal(t.step, 'Recipe B step 4');
});
