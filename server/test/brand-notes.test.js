// Settings → Brand's plain parts (web/src/components/brand-notes.js): how
// much of a logo can be seen on a ground, where each logo sits, and what the
// screen tells a manager about the brand they are about to save.
import test from 'node:test';
import assert from 'node:assert/strict';
import { hiddenShare, logoGrounds, brandNotes } from '../../web/src/components/brand-notes.js';

// A picture of n pixels: `ink` of them in one colour, the rest see-through
// (or, boxed, a solid white).
const picture = (rgb, { n = 100, ink = 40, boxed = false } = {}) => {
  const px = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i += 1) {
    const on = i < ink;
    px.set(on ? [...rgb, 255] : (boxed ? [255, 255, 255, 255] : [0, 0, 0, 0]), i * 4);
  }
  return px;
};
const texts = (notes) => notes.map((n) => n.text).join(' | ');

test('how much of a logo can be seen: a navy logo on white is all there, a white one is hidden, a boxed one carries its ground', () => {
  assert.equal(hiddenShare(picture([0, 57, 121]), '#ffffff').share, 0);
  assert.equal(hiddenShare(picture([255, 255, 255]), '#ffffff').share, 1);
  assert.equal(hiddenShare(picture([0, 57, 121]), '#003979').share, 1);
  assert.equal(hiddenShare(picture([255, 255, 255]), '#003979').share, 0);
  // Half navy, half white ink, on white: half of it is hidden.
  const half = picture([0, 57, 121], { n: 100, ink: 50 });
  for (let i = 25; i < 50; i += 1) half.set([255, 255, 255, 255], i * 4);
  assert.equal(hiddenShare(half, '#ffffff').share, 0.5);
  assert.deepEqual(hiddenShare(picture([0, 57, 121], { boxed: true }), '#003979'), { share: 0, boxed: true });
  // Nothing but see-through: nothing to see anywhere.
  assert.equal(hiddenShare(picture([0, 0, 0], { ink: 0 }), '#ffffff').share, 1);
});

test('where each logo sits: a light sidebar, a pale brand-coloured one, a dark one', () => {
  const light = logoGrounds({ color: '#003979', sidebar: 'light' });
  assert.deepEqual([light.sideDark, light.paleSide, light.logo.length], [false, false, 2]);
  const yellow = logoGrounds({ color: '#fff100', sidebar: 'brand' });
  assert.deepEqual([yellow.sideDark, yellow.paleSide, yellow.logo[1]], [false, true, '#fff100']);
  const navy = logoGrounds({ color: '#003979', sidebar: 'brand' });
  assert.deepEqual([navy.sideDark, navy.logo.length, navy.logoDark[0]], [true, 1, '#003979']);
});

test('what the screen says about a brand: it reports, in words, what only a person can decide', () => {
  const navy = brandNotes({ color: '#003979', second: '#ffc72c', sidebar: 'light' });
  assert.equal(navy.length, 1, texts(navy));
  assert.equal(navy[0].kind, 'ok');

  const yellow = texts(brandNotes({ color: '#fff100', sidebar: 'light' }));
  assert.match(yellow, /buttons have dark text/);
  assert.match(yellow, /As words, your colour becomes #[0-9a-f]{6}/);

  assert.match(texts(brandNotes({ color: '#c8151b' })), /close to the one that means Opposed/);
  assert.doesNotMatch(texts(brandNotes({ color: '#003979' })), /Opposed|Supporter|Undecided/);

  // A logo with no version for dark backgrounds: the chip is said, once.
  const logo = { id: 'x' };
  const seenFine = { logo: [{ share: 0.04, boxed: false }, { share: 0.04, boxed: false }] };
  assert.match(texts(brandNotes({ color: '#003979', logo }, seenFine)), /In dark mode your logo sits on a white chip/);
  assert.match(texts(brandNotes({ color: '#003979', sidebar: 'brand', logo }, seenFine)), /On your sidebar and in dark mode your logo sits on a white chip/);
  assert.doesNotMatch(texts(brandNotes({ color: '#003979', logo, logoDark: logo }, { ...seenFine, logoDark: [{ share: 0 }, { share: 0 }] })), /chip|hard to see/);

  // A light logo given as the standard one: a warning, never a refusal.
  const white = brandNotes({ color: '#003979', logo }, { logo: [{ share: 1, boxed: false }, { share: 1, boxed: false }] });
  assert.equal(white.filter((n) => n.kind === 'warn').length, 1, texts(white));
  assert.match(texts(white), /too light to see on a light background/);

  // A yellow logo on a yellow sidebar: the remedy is one tap.
  const hid = brandNotes({ color: '#fff100', sidebar: 'brand', logo }, { logo: [{ share: 0.1, boxed: false }, { share: 0.9, boxed: false }] });
  const warn = hid.find((n) => n.kind === 'warn');
  assert.deepEqual(warn?.fix, { sidebar: 'light', label: 'Use the light sidebar' });

  // A dark logo given as the one for dark backgrounds.
  assert.match(texts(brandNotes({ color: '#003979', logo, logoDark: logo }, { ...seenFine, logoDark: [{ share: 0.9 }, { share: 0.8 }] })), /logo for dark backgrounds is hard to see/);
  // A solid background is said, and is not a warning.
  const boxed = brandNotes({ color: '#003979', logo }, { logo: [{ share: 0, boxed: true }, { share: 0, boxed: true }] });
  assert.match(texts(boxed), /solid background/);
  assert.equal(boxed.filter((n) => n.kind === 'warn').length, 0);
});
