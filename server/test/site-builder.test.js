// The Website builder's plain parts (web/src/components/site/builder.js and
// colors.js): a page's sections changed without touching the list given,
// Undo putting a section back where it was, what a save or a publish would
// refuse — named by section and box, the same place the server names — and
// the theme's readable-colour "Fix it".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkModules, MODULES } from '@starbase/shared/site/catalogue';
import { PAIRS, SKINS, contrast, checkTheme } from '@starbase/shared/site/theme';

const B = await import('../../web/src/components/site/builder.js');
const C = await import('../../web/src/components/site/colors.js');

const page = () => [
  { id: 'hero1', kind: 'hero', hidden: false, props: { titlePrefix: 'Town hall' } },
  { id: 'text1', kind: 'text', hidden: false, props: { title: 'Bring your questions' } },
  { id: 'news1', kind: 'newsletter', hidden: false, props: { title: 'Get the newsletter' } },
];

test('new sections: a fresh id each, the catalogue’s defaults, at the place asked', () => {
  const list = page();
  const { list: next, module, index } = B.addModule(list, 'quote', 1);
  assert.equal(list.length, 3, 'the list given is untouched');
  assert.equal(index, 1);
  assert.deepEqual(next.map((m) => m.kind), ['hero', 'quote', 'text', 'newsletter']);
  assert.match(module.id, /^m[a-z0-9]{8}$/);
  assert.deepEqual(module.props, MODULES.find((m) => m.kind === 'quote').defaults);
  assert.doesNotThrow(() => checkModules(next), 'what the builder makes, the server takes');
  const ids = new Set();
  for (let i = 0; i < 500; i += 1) ids.add(B.newModuleId(ids));
  assert.equal(ids.size, 500, 'never the same id twice');
  assert.throws(() => B.addModule(list, 'nope'), /unknown module kind/);
});

test('moving: a section takes the place of the one it lands on', () => {
  const list = page();
  assert.deepEqual(B.moveModule(list, 2, 1).map((m) => m.id), ['hero1', 'news1', 'text1'], 'up: before it');
  assert.deepEqual(B.moveModule(list, 0, 2).map((m) => m.id), ['text1', 'news1', 'hero1'], 'down: after it');
  assert.equal(B.moveModule(list, 1, 1), list, 'nowhere: the same list');
  assert.deepEqual(B.moveModule(list, 0, 9).map((m) => m.id), ['text1', 'news1', 'hero1'], 'past the end: last');
  assert.deepEqual(list.map((m) => m.id), ['hero1', 'text1', 'news1'], 'the list given is untouched');
});

test('duplicate, hide, delete and Undo', () => {
  const list = page();
  const dup = B.duplicateModule(list, 0);
  assert.deepEqual(dup.list.map((m) => m.kind), ['hero', 'hero', 'text', 'newsletter']);
  assert.notEqual(dup.module.id, 'hero1');
  assert.deepEqual(dup.module.props, list[0].props);
  dup.module.props.titlePrefix = 'Changed';
  assert.equal(list[0].props.titlePrefix, 'Town hall', 'a copy, not the same props');
  const hidden = B.setHidden(list, 1, true);
  assert.equal(hidden[1].hidden, true);
  assert.equal(list[1].hidden, false);
  const { list: after, removed } = B.removeModule(list, 1);
  assert.deepEqual(after.map((m) => m.id), ['hero1', 'news1']);
  assert.deepEqual(B.putBack(after, removed).map((m) => m.id), ['hero1', 'text1', 'news1'], 'Undo: back where it was');
  assert.deepEqual(B.putBack(B.moveModule(after, 1, 0), removed).map((m) => m.id), ['news1', 'text1', 'hero1'], 'moved since: at its old place');
  assert.equal(B.putBack(list, removed), list, 'already there: nothing doubles');
  assert.deepEqual(B.setProps(list, 2, { title: 'x' })[2].props, { title: 'x' });
});

test('what a publish refuses: the section, the box, in plain words — hidden ones needn’t be finished', () => {
  const campaigns = [{ id: 'c-sky', kind: 'petition', title: 'Get SkyTrain to South Surrey', status: 'open' }];
  const list = [...page(), { id: 'pet1', kind: 'petition', hidden: false, props: { campaign: '' } }];
  assert.deepEqual(B.problemsOf(list), [], 'a draft may be unfinished');
  const ps = B.problemsOf(list, { strict: true, campaigns, pages: [] });
  assert.equal(ps.length, 1);
  assert.deepEqual([ps[0].index, ps[0].id, ps[0].path, ps[0].text], [3, 'pet1', 'campaign', 'pick one']);
  assert.equal(B.problemWords(ps[0]), 'Section 4 (Petition or pledge) · Which one: pick one');
  assert.deepEqual(B.problemsOf(list.map((m) => (m.id === 'pet1' ? { ...m, hidden: true } : m)), { strict: true, campaigns }), [], 'hidden: fine');
  const gone = B.problemsOf([{ ...list[3], props: { campaign: 'c-gone' } }], { strict: true, campaigns });
  assert.match(B.problemWords(gone[0]), /^Section 1 \(Petition or pledge\) · Which one: the petition or pledge it shows is gone/);
  assert.deepEqual(B.problemsOf([{ ...list[3], props: { campaign: 'c-sky' } }], { strict: true, campaigns }), []);
  // Deeper boxes: a list item's field, a button's link, a picture.
  const cols = { id: 'cols1', kind: 'columns', props: { items: [{ title: 'ok' }, { title: 'x'.repeat(61) }] } };
  assert.equal(B.problemWords(B.problemsOf([cols])[0]), 'Section 1 (What we stand for) · Points · 2nd · Title: at most 60 characters');
  const hero = { id: 'hero2', kind: 'hero', props: { primaryCta: { label: 'Go', href: 'javascript:alert(1)' } } };
  assert.equal(B.problemWords(B.problemsOf([hero])[0]), 'Section 1 (Hero) · Main button · Link: a link starting with /, # or https://');
  const pic = { id: 'img1', kind: 'image', props: {} };
  assert.equal(B.problemWords(B.problemsOf([pic], { strict: true })[0]), 'Section 1 (Picture) · Picture: add a picture');
  const people = { id: 'ppl1', kind: 'people', props: { seats: [{ photo: { url: 'ftp://x', alt: '' } }] } };
  assert.equal(B.problemWords(B.problemsOf([people])[0]), 'Section 1 (Board or team) · People · 1st · Photo: a link starting with /, # or https://');
  // The same place the server names, from its words.
  assert.deepEqual(B.sectionFromServer('The 4th module (Petition or pledge): campaign: pick one'), { index: 3, path: 'campaign', text: 'pick one' });
  assert.deepEqual(B.sectionFromServer('The 2nd module (Board or team): seats[0].photo.url: a link starting with /, # or https://'),
    { index: 1, path: 'seats[0].photo.url', text: 'a link starting with /, # or https://' });
  assert.deepEqual(B.sectionFromServer('The 1st module (Petition or pledge): the petition or pledge it shows is gone — pick another'),
    { index: 0, path: '', text: 'the petition or pledge it shows is gone — pick another' });
  assert.equal(B.sectionFromServer('Give the page a title'), null);
  // A bad id or a kind no longer known is said too, never thrown.
  assert.match(B.problemsOf([{ id: 'x', kind: 'text', props: {} }])[0].text, /removing and adding again/);
  assert.match(B.problemsOf([{ id: 'abcd', kind: 'gone', props: {} }])[0].text, /isn’t known/);
});

test('a section’s row words, the catalogue by category, links and addresses', () => {
  assert.equal(B.summaryOf({ kind: 'text', props: { title: 'Bring **your** questions' } }), 'Bring your questions');
  assert.equal(B.summaryOf({ kind: 'petition', props: { campaign: 'c1' } }, { campaigns: [{ id: 'c1', title: 'Get SkyTrain to South Surrey' }] }), 'Get SkyTrain to South Surrey');
  assert.equal(B.summaryOf({ kind: 'petition', props: { campaign: '' } }), 'No petition picked yet');
  assert.equal(B.summaryOf({ kind: 'hero', props: { titlePrefix: 'Fighting for', words: ['Surrey', 'transit'] } }), 'Fighting for Surrey');
  const g = B.groups();
  assert.deepEqual(g.map((x) => x.key), ['basics', 'actions', 'live', 'org']);
  assert.equal(g.reduce((n, x) => n + x.modules.length, 0), MODULES.length, 'every module in one group');
  assert.equal(B.tidyLink('imaginesurrey.ca/donate'), 'https://imaginesurrey.ca/donate');
  assert.equal(B.tidyLink('www.example.org'), 'https://www.example.org');
  assert.equal(B.tidyLink('donate'), '/donate');
  assert.equal(B.tidyLink('/#m-join'), '/#m-join');
  assert.equal(B.tidyLink('mailto:hello@example.org'), 'mailto:hello@example.org');
  assert.equal(B.isSiteLink('javascript:alert(1)'), false);
  assert.equal(B.slugify('Town hall 2030!'), 'town-hall-2030');
  assert.equal(B.slugInput('Town Hall  2030 '), 'town-hall-2030-');
});

test('the theme: every pair theme.js names is checked; "Fix it" keeps the hue and reaches 4.5:1', () => {
  assert.equal(C.hexOf('#FFF'), '#ffffff');
  assert.equal(C.hexOf(' a1B2c3 '), '#a1b2c3');
  assert.equal(C.hexOf('blue'), null);
  const colors = { ...SKINS.base.colors, brand: '#7fb2ff' }; // white text on a light blue
  const pairs = C.pairsOf(colors);
  assert.equal(pairs.length, PAIRS.length);
  const bad = pairs.filter((p) => !p.ok);
  assert.deepEqual(bad.map((p) => p.fg), ['brandInk']);
  const fixed = C.readableInk(colors.brandInk, colors.brand);
  assert.ok(contrast(fixed, colors.brand) >= 4.5, fixed);
  assert.deepEqual(checkTheme({ skin: 'base', colors: { ...colors, brandInk: fixed } }).problems, [], 'the server takes it');
  // Keeps the hue: a mid blue link on white darkens, it doesn't turn black.
  const link = C.readableInk('#6a8cff', '#ffffff');
  assert.ok(contrast(link, '#ffffff') >= 4.5 && link !== '#000000', link);
  assert.equal(C.readableInk('#003979', '#ffffff'), '#003979', 'already readable: unchanged');
  for (const bg of ['#777777', '#808080', '#ff0000', '#00ff00', '#0000ff', '#ffff00']) {
    assert.ok(contrast(C.readableInk('#888888', bg), bg) >= 4.5, bg);
  }
  assert.equal(C.ratioWords(4.4999), '4.4:1', 'never rounded up to a pass');
  assert.equal(C.colorWords('brandInk'), 'Text on the brand colour');
  assert.equal(C.colorWords('somethingNew'), 'Something New');
});

test('a slow answer never throws away words: what was typed since it went stays, the rest is the server’s', () => {
  const sent = { title: 'Library hours ', slug: '', statement: 'Open late', excerpt: '' };
  const server = { title: 'Library hours', slug: 'library-hours', statement: 'Open late', excerpt: '' };
  // Nothing typed meanwhile: the server's copy (its tidied title, the address it made).
  assert.deepEqual(B.rebaseForm(sent, sent, server), server);
  // The excerpt typed while it was out: kept; the rest the server's.
  assert.deepEqual(B.rebaseForm({ ...sent, excerpt: 'Typed while it saved' }, sent, server), { ...server, excerpt: 'Typed while it saved' });
  // A close comes back with the words as saved: every edit not saved yet stays.
  const saved = { title: 'Library hours', slug: 'library-hours', statement: 'Open late', excerpt: '' };
  const edited = { ...saved, statement: 'Open late, and on Sundays' };
  assert.deepEqual(B.rebaseForm(edited, saved, saved), edited);
  // Pictures (objects) compare by what they hold.
  const pic = { url: '/media/a', alt: 'x' };
  assert.deepEqual(B.rebaseForm({ image: { ...pic, alt: 'typed' } }, { image: pic }, { image: { ...pic } }), { image: { ...pic, alt: 'typed' } });
});
