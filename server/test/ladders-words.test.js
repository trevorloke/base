// The words a ladder step is shown in (web/src/components/LaddersWords.js):
// the builder's fields and the step lines say "[first name]" / "[campaign]",
// never the codes, while what's stored underneath stays {{first_name}} /
// {{campaign}} — the very text the server fills in. The email card's number
// has a noun ("67 people said yes").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillIn } from '../ext/ladders/shape.js';

const W = await import('../../web/src/components/LaddersWords.js');

test('codes show as words; words typed are stored as codes', () => {
  assert.equal(W.toWords('Thanks for signing, {{first_name}}'), 'Thanks for signing, [first name]');
  assert.equal(W.toWords('Hi {{ First_Name }} — {{campaign}}'), 'Hi [first name] — [campaign]');
  assert.equal(W.toCodes('Thanks for signing, [first name]'), 'Thanks for signing, {{first_name}}');
  for (const typed of ['[First name]', '[first_name]', '[firstname]', '[ First Name ]']) {
    assert.equal(W.toCodes(`Call ${typed}`), 'Call {{first_name}}', typed);
  }
  assert.equal(W.toCodes('— [Campaign]'), '— {{campaign}}');
  // A round trip through the field changes nothing that was stored.
  for (const stored of ['Thanks, {{first_name}}', 'Thank you for signing for 72 Ave. — {{campaign}}', 'Plain words', '']) {
    assert.equal(W.toCodes(W.toWords(stored)), stored);
  }
  assert.equal(W.toWords(undefined), '');
});

test('what the "+ First name" / "+ Campaign" buttons put in is what the server fills', () => {
  const [first, campaign] = W.FILLS;
  assert.deepEqual([first.button, campaign.button], ['+ First name', '+ Campaign']);
  assert.ok(W.FILLS.every((f) => !/[{}]/.test(f.word) && !/[{}]/.test(f.button)), 'no code on a button or in a field');
  const stored = W.toCodes(`Thanks, ${first.word} — ${campaign.word}`);
  assert.equal(stored, 'Thanks, {{first_name}} — {{campaign}}');
  assert.equal(fillIn(stored, { person: { name: 'Ana Souza' }, campaign: 'Imagine Surrey' }), 'Thanks, Ana — Imagine Surrey');
  assert.equal(W.unfilled(stored), null);
});

test('step lines read in words, not codes', () => {
  assert.equal(W.stepLine({ kind: 'email', subject: 'Thanks for signing, {{first_name}}' }), 'Email · Thanks for signing, [first name]');
  assert.equal(W.stepLine({ kind: 'followup', text: 'Call {{first_name}} to say thanks' }), 'Follow-up · Call [first name] to say thanks');
  assert.equal(W.stepLine({ kind: 'wait', n: 1, unit: 'days' }), 'Wait 1 day');
  assert.equal(W.stepLine({ kind: 'wait', n: 3, unit: 'hours' }), 'Wait 3 hours');
  assert.equal(W.stepLine({ kind: 'tag', tag: 'thanked' }), 'Tag · thanked');
  assert.equal(W.stepLine({ kind: 'stop' }), 'Stop');
});

test('anything that would go out as typed is flagged', () => {
  assert.equal(W.unfilled('Thanks, {first_name}'), '{first_name} won’t fill in — use + First name');
  assert.equal(W.unfilled('From {{campagin}}'), '{{campagin}} won’t fill in — use + Campaign');
  assert.equal(W.unfilled('Hi [name]'), '[name] won’t fill in — use + First name');
  assert.equal(W.unfilled('Hi {{ first_name }}, from {{campaign}}'), null);
  assert.equal(W.unfilled('See the [map] below'), null);
});

test('the email card\'s number says what it counts', () => {
  assert.equal(W.emailWho(67), 'Goes only to people who said yes to email · 67 people said yes');
  assert.equal(W.emailWho(1), 'Goes only to people who said yes to email · 1 person said yes');
  assert.equal(W.emailWho(0), 'Goes only to people who said yes to email · 0 people said yes');
  assert.equal(W.emailWho(undefined), 'Goes only to people who said yes to email · …');
});

test('"Send to a web address": the card names where it goes, never the whole address; the log says what the address answered', () => {
  const step = { kind: 'webhook', url: 'https://hooks.zapier.com/hooks/catch/123/s3cret-key/', label: 'Zapier' };
  assert.equal(W.stepLine(step), 'Send to a web address · Zapier');
  // One short line: where it goes and what it never carries (who gets an
  // email or a mobile passed on is said once, under the fields).
  assert.equal(W.hookWho(step), 'To hooks.zapier.com · no ratings, notes or money');
  assert.ok(!W.hookWho(step).includes('s3cret-key'), 'the rest of an address can be a key');
  assert.equal(W.hookWho({ kind: 'webhook', url: '', label: '' }), 'No ratings, notes or money');
  assert.ok(W.hookWho(step).split(/\s+/).filter((w) => /\w/.test(w)).length <= 12, 'about twelve words at most');

  assert.equal(W.hookMissing({ url: '', label: 'Zapier' }), 'Add the web address');
  assert.equal(W.hookMissing({ url: 'http://hooks.example.org/x', label: 'Zapier' }), 'The address must start with https://');
  assert.equal(W.hookMissing({ url: 'hooks.example.org/x', label: 'Zapier' }), 'The address must start with https://');
  assert.equal(W.hookMissing({ url: 'https://', label: 'Zapier' }), 'That isn’t a web address');
  assert.equal(W.hookMissing({ url: 'https://hooks.example.org/x', label: '  ' }), 'Add a label');
  assert.equal(W.hookMissing(step), null);

  const line = (e) => W.hookLogLine({ kind: 'webhook', label: 'Zapier', ...e });
  assert.equal(line({ result: 'sent', status: 200 }), 'Zapier: Sent · 200');
  assert.equal(line({ result: 'failed', reason: 'gave_up', status: 500, tries: 3 }), 'Zapier: Failed · 500 after 3 tries');
  assert.equal(line({ result: 'failed', reason: 'will_retry', status: 503, tries: 1 }), 'Zapier: Didn’t go (503) — trying again');
  assert.equal(line({ result: 'failed', reason: 'gave_up', why: 'timeout', tries: 3 }), 'Zapier: Failed · no answer after 3 tries');
  assert.equal(line({ result: 'failed', reason: 'gave_up', why: 'not_found', tries: 3 }), 'Zapier: Failed · address not found after 3 tries');
  assert.equal(line({ result: 'failed', reason: 'refused', why: 'private', tries: 1 }), 'Zapier: Not sent — the address points inside a private network');
  assert.equal(line({ result: 'failed', reason: 'refused', why: 'bad_address', tries: 1 }), 'Zapier: Not sent — the address can’t be used');
  assert.equal(line({ result: 'failed', reason: 'will_retry', why: 'unreachable', tries: 2 }), 'Zapier: Didn’t go (couldn’t connect) — trying again');
  assert.equal(line({ result: 'skipped', reason: 'do_not_contact' }), 'Zapier: Skipped — do not contact');
  assert.equal(line({ result: 'unsure' }), 'Zapier: Not sure it went');
  assert.equal(line({ result: 'sending' }), 'Zapier: Sending');
  assert.equal(W.hookLogLine({ kind: 'webhook', result: 'sent', status: 204 }), 'Web address: Sent · 204');
  // A redirect is never followed or tried again; an address that has stopped answering isn't called.
  assert.equal(line({ result: 'failed', reason: 'redirect', status: 302, tries: 1 }), 'Zapier: Answered with a redirect (302) — not followed');
  assert.equal(line({ result: 'failed', reason: 'will_retry', why: 'not_answering', tries: 1 }), 'Zapier: Didn’t go (the address isn’t answering) — trying again');
  assert.equal(line({ result: 'failed', reason: 'gave_up', why: 'not_answering', tries: 3 }), 'Zapier: Failed · the address isn’t answering after 3 tries');
  // One try and no other (someone taken off while the address was being called; a test): no count.
  assert.equal(line({ result: 'failed', reason: 'gave_up', status: 500, tries: 1 }), 'Zapier: Failed · 500');
  assert.equal(line({ result: 'failed', reason: 'gave_up', why: 'timeout', tries: 1 }), 'Zapier: Failed · no answer');
  // The same words without the label: what "Send a test" answers.
  assert.equal(W.hookSaid({ result: 'sent', status: 200 }), 'Sent · 200');
  assert.equal(W.hookSaid({ result: 'failed', reason: 'gave_up', status: 404 }), 'Failed · 404');
});

test('the people row says when a web address never got someone, and why', () => {
  const hook = (e) => ({ kind: 'webhook', label: 'Zapier', ...e });
  const sent = hook({ result: 'sent', status: 200 });
  assert.equal(W.hookRowNote([sent, { kind: 'end', result: 'finished' }]), null);
  assert.equal(W.hookRowNote([hook({ result: 'failed', reason: 'will_retry', status: 500, tries: 1 }), sent]), null, 'it went on a later try');
  assert.equal(W.hookRowNote([hook({ result: 'failed', reason: 'gave_up', status: 500, tries: 3 })]), 'not sent to Zapier');
  assert.equal(W.hookRowNote([hook({ result: 'failed', reason: 'refused', why: 'private', tries: 1 })]), 'not sent to Zapier');
  assert.equal(W.hookRowNote([hook({ result: 'skipped', reason: 'do_not_contact' })]), 'not sent to Zapier (do not contact)');
  assert.equal(W.hookRowNote([hook({ result: 'failed', reason: 'redirect', status: 301, tries: 1 })]), 'Zapier answered with a redirect');
  assert.equal(W.hookRowNote([{ kind: 'webhook', result: 'skipped' }]), 'not sent to the web address (do not contact)');
  assert.equal(W.hookRowNote([{ kind: 'email', result: 'failed', reason: 'gave_up' }]), null);
  assert.equal(W.hookRowNote(undefined), null);
});

test('a step kind this page doesn’t know is said so and saved as it is, never as a Stop', () => {
  // A tab left open from before a release that added a step kind.
  const later = { kind: 'call', number: '604-555-0100', after: 2 };
  assert.equal(W.stepLine(later), 'A step this page doesn’t know — reload');
  assert.deepEqual(W.cleanStep(later), later, 'saving its card (or another one) hands it back unchanged');
  assert.deepEqual(W.cleanStep({ kind: 'stop', extra: 1 }), { kind: 'stop' });
  assert.deepEqual(W.cleanStep({ kind: 'webhook', url: ' https://hooks.example.org/x ', label: ' Zapier ' }), { kind: 'webhook', url: 'https://hooks.example.org/x', label: 'Zapier' });
  assert.deepEqual(W.cleanStep({ kind: 'wait', n: '2.4', unit: 'hours' }), { kind: 'wait', n: 2, unit: 'hours' });
  assert.deepEqual(W.cleanStep({ kind: 'email', subject: ' S ', body: ' B ' }), { kind: 'email', subject: 'S', body: 'B' });
  assert.deepEqual(W.cleanStep({ kind: 'untag', tag: ' old ' }), { kind: 'untag', tag: 'old' });
  assert.deepEqual(W.cleanStep({ kind: 'followup', text: ' Call ' }), { kind: 'followup', text: 'Call' });
  assert.deepEqual(W.cleanStep({ kind: 'text', body: ' Hi ' }), { kind: 'text', body: 'Hi' });
});
