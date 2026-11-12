// Who never goes to the dialer reads a do-not tag whatever its capitals, as
// every other sender does (lib/reach.js): "Do-Not-Call" typed at the desk
// keeps a number out of CallHub too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notToBeCalled } from '../ext/callhub/people.js';

test('a do-not-call or do-not-contact tag counts whatever its capitals', () => {
  assert.equal(notToBeCalled({ tags: ['Do-Not-Call'] }), true);
  assert.equal(notToBeCalled({ tags: JSON.stringify(['DO-NOT-CONTACT']) }), true);
  assert.equal(notToBeCalled({ tags: ['do-not-text', 'volunteer'] }), false, 'texts only: still called');
  assert.equal(notToBeCalled({ tags: null }), false);
});
