// The person's page back from Google's connect page (web/src/components/
// gmailWords.js): they are already signed in, so no word of Google's refusal
// tells them to use their password or calls it sign-in.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { connectWords } = await import('../../web/src/components/gmailWords.js');

// Every code the start and callback routes send back for a connect.
const CODES = ['connected', 'cancelled', 'blocked', 'unavailable', 'off', 'not-set-up', 'too-many', 'expired',
  'taken', 'domain', 'wrong-address', 'two-step-first', 'not-allowed', 'missing-scope', 'other-account', 'something-new'];

test('back from connecting Gmail, nothing says password or sign-in', () => {
  for (const code of CODES) {
    const said = connectWords(code);
    assert.ok(said && !/password|sign[ -]?in/i.test(said), `${code}: ${said}`);
  }
});

test('the refusals the checker met read as connecting, not signing in', () => {
  assert.equal(connectWords('cancelled'), 'Connecting Gmail was cancelled.');
  assert.equal(connectWords('blocked'), 'Your Google Workspace admin hasn’t allowed base.win — ask them to mark it Trusted.');
  assert.equal(connectWords('unavailable'), 'Google isn’t answering right now. Try again in a minute.');
  assert.equal(connectWords('connected'), 'Connected');
});
