// shared/letters.js (LTE stage 2): counting by each paper's unit, the
// writer-against-campaign comparison and its round trip, the campaign's
// share of a letter, the shared-run check and the email link — in English,
// Punjabi (Gurmukhi) and Chinese.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tokens, size, wordDiff, applyHunks, campaignShare, sharedRuns, mailtoFor, mailtoMax, MAILTO_PHONE, MAILTO_OTHER,
} from '@starbase/shared/letters';

const EN = 'Surrey needs more buses on the King George corridor, and it needs them before the next school year starts in the fall.';
const PA = 'ਸਰੀ ਨੂੰ ਕਿੰਗ ਜਾਰਜ ਸੜਕ ਉੱਤੇ ਹੋਰ ਬੱਸਾਂ ਦੀ ਲੋੜ ਹੈ। ਸਕੂਲ ਸ਼ੁਰੂ ਹੋਣ ਤੋਂ ਪਹਿਲਾਂ।';
// 120 Chinese characters, no punctuation.
const ZH_UNIT = '萨里需要更多的公共汽车和更好的道路学校旁边的人行道也要修好了';
const ZH = ZH_UNIT.repeat(4);
// The last 人行道 (footpath) made a 自行车道 (bike lane).
const bike = (t) => t.slice(0, -10) + t.slice(-10).replace('人行道', '自行车道');
const take = (hunks, pick) => new Set(hunks.map((h, k) => (h.kind === 'change' && pick(h, k) ? k : -1)).filter((k) => k >= 0));

test('tokens and size: English words, Punjabi by its spaces, Chinese by character in either unit', () => {
  assert.deepEqual(tokens('Don’t wait, Surrey!').length, 3);
  assert.deepEqual(tokens('The KING George'), ['the', 'king', 'george']);
  assert.equal(size(EN), EN.split(/\s+/).length);
  assert.equal(size(EN, 'characters'), EN.replace(/\s/g, '').length);
  assert.equal(size(PA), PA.trim().split(/\s+/).length, 'a Punjabi word count matches its spaces');
  assert.equal(ZH_UNIT.length, 30);
  assert.equal(size(ZH), 120);
  assert.equal(size(ZH, 'characters'), 120);
  assert.equal(size('  '), 0);
  assert.equal(size(''), 0);
});

test('wordDiff + applyHunks: all taken is the campaign’s text, none the writer’s, one taken that change only', () => {
  for (const [a, b] of [
    [EN, EN.replace('more buses', 'more frequent buses').replace('the fall.', 'the autumn!')],
    [PA, PA.replace('ਹੋਰ ਬੱਸਾਂ', 'ਬਹੁਤ ਹੋਰ ਬੱਸਾਂ')],
    [ZH, bike(ZH.replace('公共汽车', '巴士'))],
    ['  Leading space.\n\nTwo paragraphs here.', 'Leading space.\nTwo paragraphs, here.'],
    ['', 'All new.'],
    ['Something.', ''],
  ]) {
    const h = wordDiff(a, b);
    assert.equal(applyHunks(a, b, take(h, () => true)), b, `all: ${b}`);
    assert.equal(applyHunks(a, b), a, `none: ${a}`);
    assert.equal(h.map((x) => x.from.map((p) => p.text).join('')).join(''), a);
    assert.equal(h.map((x) => x.to.map((p) => p.text).join('')).join(''), b);
  }
  const b = EN.replace('more buses', 'more frequent buses').replace('the fall.', 'the autumn!');
  const h = wordDiff(EN, b);
  const changes = h.filter((x) => x.kind === 'change');
  assert.equal(changes.length, 2);
  assert.deepEqual(changes[0].to.map((p) => p.word), ['frequent']);
  const first = h.indexOf(changes[0]);
  assert.equal(applyHunks(EN, b, new Set([first])), EN.replace('more buses', 'more frequent buses'));
  // Chinese: one change, by character.
  const zb = bike(ZH);
  const zh = wordDiff(ZH, zb).filter((x) => x.kind === 'change');
  assert.deepEqual(zh.flatMap((x) => x.from.map((p) => p.word)), ['人']);
  assert.deepEqual(zh.flatMap((x) => x.to.map((p) => p.word)), ['自', '车']);
});

test('campaignShare: a whole rewrite ≥ 0.9; one changed word ≈ 0; the writer’s own new words 0; Keep mine 0', () => {
  const rewrite = 'Our city deserves frequent transit service along every major road, and council should fund it in this budget without delay or excuses.';
  assert.ok(campaignShare(EN, [rewrite], rewrite) >= 0.9, String(campaignShare(EN, [rewrite], rewrite)));
  const oneWord = EN.replace('buses', 'transit');
  assert.ok(campaignShare(EN, [oneWord], oneWord) <= 0.05, String(campaignShare(EN, [oneWord], oneWord)));
  const ownWords = `${EN} My children ride the 96 every morning and it is always full.`;
  assert.equal(campaignShare(EN, [rewrite], ownWords), 0);
  assert.equal(campaignShare(EN, [rewrite], EN), 0, 'Keep mine');
  assert.equal(campaignShare(EN, [], EN), 0);
  // Taken in full, then the writer adds a line of their own: still mostly the campaign’s.
  const later = `${rewrite} I ride the bus.`;
  assert.ok(campaignShare(EN, [rewrite], later) > 0.7);
  // Chinese, by character.
  const zr = '我们的城市需要在每一条主要道路上提供更频繁的公交服务议会应该在今年的预算中拨款';
  assert.ok(campaignShare(ZH, [zr], zr) >= 0.9);
});

test('sharedRuns: an 8-word run found and 7 ignored; 20 Han characters found and 19 ignored', () => {
  const eight = 'we need more buses on the corridor now';
  const seven = 'we need more buses on the corridor';
  const hit = sharedRuns(`Honestly, ${eight}. Thanks.`, `Points: ${eight}!`);
  assert.equal(hit.length, 8);
  assert.equal(hit.text, eight);
  assert.equal(sharedRuns(`Honestly, ${seven}. Thanks.`, `Points: ${seven}!`), null);
  assert.equal(sharedRuns(`Honestly, ${seven}. Thanks.`, `Points: ${seven}!`, 7).length, 7);
  const twenty = ZH.slice(0, 20);
  const z = sharedRuns(`我认为${twenty}。`, `要点：${twenty}！`);
  assert.equal(z.length, 20);
  assert.equal(z.text, twenty);
  assert.equal(sharedRuns(`我认为${twenty.slice(0, 19)}。`, `要点：${twenty.slice(0, 19)}！`), null);
  // Case and punctuation don’t hide a copy.
  assert.equal(sharedRuns('WE NEED, more buses on the corridor NOW', eight).length, 8);
});

test('mailtoFor: line breaks as %0A, the subject given, Punjabi and Chinese encoded; a 250-word letter fits a phone’s link but not a computer’s', () => {
  const body = Array.from({ length: 250 }, (_, i) => ['Surrey', 'needs', 'buses', 'now'][i % 4]).join(' ').replace(/(now) /g, '$1.\n');
  assert.equal(body.split(/\s+/).length, 250);
  const signoff = 'Priya Example\nSurrey\n604-555-0123';
  const phone = mailtoFor({ to: 'letters@example.org', subject: 'Letter: buses', body, signoff, max: MAILTO_PHONE });
  assert.equal(phone.bodyInLink, true);
  assert.ok(phone.href.startsWith('mailto:letters@example.org?subject=Letter%3A%20buses&body='));
  assert.ok(phone.href.includes('%0A') && !phone.href.includes('%0D'));
  assert.ok(decodeURIComponent(phone.href.split('&body=')[1]).endsWith('Priya Example\nSurrey\n604-555-0123'));
  assert.ok(phone.href.length <= MAILTO_PHONE);
  const desk = mailtoFor({ to: 'letters@example.org', subject: 'Letter: buses', body, signoff, max: MAILTO_OTHER });
  assert.deepEqual(desk, { href: 'mailto:letters@example.org?subject=Letter%3A%20buses', bodyInLink: false });
  for (const text of [PA, ZH]) {
    const m = mailtoFor({ to: 'letters@example.org', subject: text.slice(0, 10), body: text, signoff: 'ਪ੍ਰਿਆ', max: MAILTO_PHONE });
    assert.equal(m.bodyInLink, true);
    assert.equal(decodeURIComponent(m.href.split('&body=')[1]), `${text}\n\nਪ੍ਰਿਆ`);
    assert.equal(decodeURIComponent(m.href.split('?subject=')[1].split('&body=')[0]), text.slice(0, 10));
    assert.ok(!/[^\x21-\x7e]/.test(m.href), 'every byte percent-encoded');
  }
  assert.equal(mailtoMax({ userAgentData: { mobile: true } }), MAILTO_PHONE);
  assert.equal(mailtoMax({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' }), MAILTO_PHONE);
  assert.equal(mailtoMax({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' }), MAILTO_OTHER);
});
