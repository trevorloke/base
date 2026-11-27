// The website's looks and the public site's shape (WA stages 3a and 3b,
// rebuilt as WEB): the modern heading sizes only for a theme that asks for
// them (every saved theme keeps drawing as it does), the ready looks every
// campaign gets, the hero's picture beside or behind the words, and the
// fixes every theme gets — no empty gaps, one page heading, news cards
// whose title is the link, the legal lines no look can hide. Then the desk:
// the look a website had is kept to go back to, and a preview link can
// show the published page (Theme's live preview).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { renderSite, readSiteAsset } from '../ext/site/render/index.js';
import { drawBody } from '../../shared/site/components/preview.js';
import { MODULE_BY_KIND, newModule, checkProps } from '../../shared/site/catalogue.js';
import * as theme from '../../shared/site/theme.js';
import { baseSample } from './site-samples.js';
import { hit, ok, campaign } from './site-helpers.js';

// The ready looks (a file this work adds: missing, every test that reads it fails on its own).
const { LOOKS = [] } = await import('../../shared/site/looks.js').catch(() => ({}));
const { checkTheme, allLooks, lookOf } = theme;
// Every look a website can pick (this work adds it; before it, the campaign's own list).
const everyLook = theme.everyLook || allLooks;

const ENV = ['STARBASE_BRAND'];
const had = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
after(() => { for (const k of ENV) { if (had[k] === undefined) delete process.env[k]; else process.env[k] = had[k]; } });

const mod = (kind, id, props = {}) => ({ id, kind, hidden: false, props: { ...newModule(kind, id).props, ...props } });
const draw = ({ modules = [], theme = { skin: 'base' }, page = {}, org = {}, data = baseSample.data, path = '/about', ctx = {} } = {}) => renderSite({
  kind: 'page',
  site: { ...baseSample.site, theme, org: { ...baseSample.site.org, ...org } },
  page: { id: 'page-1', slug: 'about', title: 'About', description: '', modules, ...page },
  data,
  ctx: { root: '/', path, ...ctx },
}).html.replace(/<!-- -->/g, '');
const css = () => readSiteAsset('site.css').body.toString();
// A rule's body in site.css (the first one with exactly this selector list).
const rule = (sel) => {
  const s = css();
  const at = s.indexOf(`\n${sel} {`);
  return at < 0 ? '' : s.slice(at, s.indexOf('}', at));
};

// ── The scale and the looks ──
test('a theme keeps the modern heading sizes only when it asks for them; every saved theme stays as it is', () => {
  assert.equal(checkTheme({ skin: 'base', scale: 'modern' }).theme.scale, 'modern');
  assert.equal(checkTheme({ skin: 'base' }).theme.scale, undefined, 'a theme saved before (no scale): as today');
  assert.equal(checkTheme({ skin: 'base', scale: 'huge' }).theme.scale, undefined, 'anything else: as today');
  // A modern look picked, then its colours changed: still modern (the form
  // saves what it shows); a look's own scale is never laid over a saved theme.
  assert.equal(checkTheme({ skin: 'civic-blue', colors: { brand: '#123a7a' } }).theme.scale, undefined);
  assert.equal(checkTheme({ skin: 'civic-blue', colors: { brand: '#123a7a' }, scale: 'modern' }).theme.scale, 'modern');
});

test('the ready looks: Civic blue and Evergreen, for every campaign, modern, readable, nothing of any campaign in them', () => {
  assert.deepEqual(LOOKS.map((l) => [l.key, l.label]), [['civic-blue', 'Civic blue'], ['evergreen', 'Evergreen']]);
  const keys = everyLook().map((l) => l.key);
  assert.deepEqual(keys.slice(0, 1), ['base']);
  // The campaign's own looks stay its own list (another campaign is offered
  // no one else's); the ready ones come after, for every campaign.
  assert.ok(!allLooks().some((l) => LOOKS.includes(l)));
  for (const l of LOOKS) {
    assert.ok(keys.includes(l.key), `${l.key} offered`);
    assert.equal(lookOf(l.key), l);
    assert.equal(l.scale, 'modern', `${l.key} is a new look: the modern sizes`);
    assert.deepEqual(checkTheme(l).problems, [], `${l.key}: every pair reads at 4.5:1`);
    assert.doesNotMatch(JSON.stringify(l), /imagine|surrey/i);
  }
  // Picked and saved, it keeps its name, colours and fonts.
  const { theme } = checkTheme({ ...LOOKS[0], skin: 'civic-blue' });
  assert.equal(theme.skin, 'civic-blue');
  assert.deepEqual(theme.fonts, { heading: 'dm-serif-display', body: 'dm-sans' });
});

test('the page says it is modern only for a modern theme: a classic page’s markup is as it was', () => {
  assert.match(draw({ theme: { skin: 'civic-blue', scale: 'modern' } }), /<html lang="en" data-scale="modern" data-skin="civic-blue"/);
  assert.doesNotMatch(draw({ theme: { skin: 'base' } }), /data-scale/);
  // Every modern rule in site.css hangs on that attribute.
  assert.match(css(), /html\[data-scale="modern"\] \.hero-title \{[^}]*font-size: clamp\(40px, 6vw, 72px\)/);
  // The heavy shadow stays on the hero and the bands: other headings drop it.
  assert.match(css(), /html\[data-scale="modern"\] \.section:not\(\.hero\):not\(\.band\):not\(\.page-head\) \.display \{[^}]*--pop-c: transparent/);
});

// ── The hero's picture ──
test('the hero: its picture beside the words (as today) or behind them; no picture, the words alone', () => {
  const f = MODULE_BY_KIND.hero.fields.find((x) => x.key === 'layout');
  assert.ok(f, 'a hero field for where the picture goes');
  assert.deepEqual(f.options.map((o) => o.value), ['beside', 'behind']);
  assert.equal(f.translate, false);
  assert.equal(checkProps('hero', {}).layout, 'beside', 'a hero saved before: beside, as today');
  const image = { url: '/media/11111111-1111-4111-8111-111111111111', alt: 'A sample picture', width: 1600, height: 1200, sizes: [{ url: '/media/11111111-1111-4111-8111-111111111112', w: 800 }] };
  const beside = draw({ modules: [mod('hero', 'h1', { image })] });
  assert.match(beside, /<section data-module="hero" id="m-h1" class="section tone-brand on-dark hero has-picture">/);
  const behind = draw({ modules: [mod('hero', 'h1', { image, layout: 'behind' })] });
  assert.match(behind, /class="section tone-brand on-dark hero has-picture hero--behind"/);
  assert.match(behind, /class="hero-image"[^>]*sizes="100vw"/, 'behind: the picture is the hero’s width');
  const none = draw({ modules: [mod('hero', 'h1', { layout: 'behind' })] });
  assert.match(none, /class="section tone-brand on-dark hero"/, 'no picture: nothing behind the words');
  assert.doesNotMatch(none, /Your picture/, 'the public site never shows a stand-in picture');
  // The builder's preview (its own frame, ?edit=1) of a modern hero with no picture: a plain box saying so.
  assert.match(draw({ modules: [mod('hero', 'h1')], theme: { skin: 'base', scale: 'modern' }, ctx: { preview: true, edit: true } }), /<div class="hero-ph" role="img" aria-label="Your picture">Your picture<\/div>/);
  // Any other preview (Theme's preview of the published page): as visitors see it, no box.
  assert.doesNotMatch(draw({ modules: [mod('hero', 'h1')], theme: { skin: 'base', scale: 'modern' }, ctx: { preview: true } }), /hero-ph|Your picture/, 'a preview outside the builder: no stand-in picture');
  // Behind: the words sit on a solid panel of the brand colour, never on the photo.
  assert.match(rule('.hero--behind .hero-copy'), /background: var\(--brand\)/);
});

// ── No empty gaps ──
test('no empty gaps: a still headline keeps no room for a second line; points fill the row', () => {
  const still = draw({ modules: [mod('hero', 'h1', { words: [] })] });
  assert.match(still, /<h1 class="hero-title display">/);
  const rotating = draw({ modules: [mod('hero', 'h1', { words: ['safer', 'kinder'] })] });
  assert.match(rotating, /class="hero-title display hero-title--words"/);
  assert.match(rule('.hero-title'), /min-height: 0/);
  assert.match(rule('.hero-title--words'), /min-height: 2\.2em/);
  const two = draw({ modules: [mod('columns', 'c1', { items: [{ icon: 'civic', title: 'One', body: '' }, { icon: 'home', title: 'Two', body: '' }] })] });
  assert.match(two, /<div class="pillars" style="--cols-n:2">/);
  const five = draw({ modules: [mod('columns', 'c1', { items: Array.from({ length: 5 }, (_, i) => ({ icon: 'civic', title: `Point ${i}`, body: 'Words.' })) })] });
  assert.match(five, /<div class="pillars" style="--cols-n:3">/);
  assert.doesNotMatch(two, /<p><\/p>/, 'an empty point paragraph takes no room');
  // One point fills the row at every width (a tablet's two columns too).
  assert.match(css(), /\.pillars > \.pillar:only-child \{[^}]*grid-column: 1 \/ -1/);
  assert.match(rule('.section'), /padding-top: clamp\(48px, 7vw, 96px\)/);
  assert.match(css(), /\.section\.tone-paper \+ \.section\.tone-paper \{[^}]*padding-top: clamp\(24px, 3vw, 40px\)/);
});

// ── One page heading ──
test('one page heading: a first section titled as the page is the page’s heading; /news has one', () => {
  const news = draw({ page: { slug: 'news', title: 'News' }, modules: [mod('news', 'news-all', { title: 'News', limit: 24 })], path: '/news' });
  assert.equal((news.match(/<h1\b/g) || []).length, 1);
  assert.doesNotMatch(news, /page-head/);
  assert.match(news, /<h1 id="m-news-all-title" class="display">News<\/h1>/);
  const sample = draw({ page: { slug: 'sample-page', title: 'Sample page' }, modules: [mod('text', 't1', { title: '  sample   PAGE ', body: 'Words.' })] });
  assert.equal((sample.match(/<h1\b/g) || []).length, 1);
  assert.doesNotMatch(sample, /page-head/);
  // With words under its title too (Imagine Surrey's News page): one heading,
  // the section's; the words stay the page's description for search and shares.
  const described = draw({ page: { title: 'News', description: 'What we’ve been up to.' }, modules: [mod('text', 't1', { title: 'News', body: 'Releases and updates.', tone: 'brand' })] });
  assert.equal((described.match(/<h1\b/g) || []).length, 1);
  assert.doesNotMatch(described, /page-head/);
  assert.match(described, /<meta name="description" content="What we’ve been up to\.">/);
  // A page whose first heading is something else keeps its title band.
  assert.match(draw({ page: { title: 'About' }, modules: [mod('text', 't1', { title: 'Our story', body: 'Words.' })] }), /page-head[\s\S]*<h1 class="display">About<\/h1>/);
});

test('one page heading: a first section that draws no heading leaves the page its title band', () => {
  const one = (html) => (html.match(/<h1\b/g) || []).length;
  // A page "Questions" opening with a list of questions not written yet (a FAQ draws nothing then).
  const faq = draw({ page: { slug: 'faq', title: 'Questions' }, modules: [mod('faq', 'q1', { title: 'Questions', items: [] }), mod('text', 't1', { title: 'More', body: 'Words.' })] });
  assert.equal(one(faq), 1, 'one h1');
  assert.match(faq, /page-head[\s\S]*<h1 class="display">Questions<\/h1>/, 'the title band says the page’s title');
  // Questions with no words in them are no questions either.
  const blank = draw({ page: { slug: 'faq', title: 'Questions' }, modules: [mod('faq', 'q1', { title: 'Questions', items: [{ q: '  ', a: 'An answer.' }] })] });
  assert.match(blank, /page-head[\s\S]*<h1 class="display">Questions<\/h1>/);
  // A membership section on a site with no membership draws nothing.
  const join = draw({ page: { slug: 'join', title: 'Become a member' }, modules: [mod('join', 'j1', { title: 'Become a member' })], data: { ...baseSample.data, membership: false } });
  assert.equal(one(join), 1);
  assert.match(join, /page-head[\s\S]*<h1 class="display">Become a member<\/h1>/);
  // Once there is a question, the FAQ's own heading is the page's.
  const asked = draw({ page: { slug: 'faq', title: 'Questions' }, modules: [mod('faq', 'q1', { title: 'Questions', items: [{ q: 'When?', a: 'Soon.' }] })] });
  assert.equal(one(asked), 1);
  assert.doesNotMatch(asked, /page-head/);
  assert.match(asked, /<h1 id="m-q1-title" class="display">Questions<\/h1>/);
});

// ── News cards ──
test('news cards: the picture on top, the title is the one link, the summary cut at two lines', () => {
  const posts = baseSample.data.posts.map((p, i) => (i === 0 ? { ...p, image: { url: '/media/22222222-2222-4222-8222-222222222222', alt: '', width: 1200, height: 675 } } : p));
  const html = draw({ modules: [mod('news', 'n1', { title: 'Latest news', limit: 3 })], data: { ...baseSample.data, posts } });
  const p = posts[0];
  assert.match(html, new RegExp(`<article class="card has-picture"><img class="news-card-image"[^>]*>`));
  assert.match(html, new RegExp(`<h3 class="h3"><a href="/news/${p.slug}">${p.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</a></h3>`));
  assert.doesNotMatch(html, /card-link/, 'no separate “Read more” link');
  assert.match(html, /<article class="card">/, 'a post with no picture: the soft card');
  assert.match(css(), /\.news \.card \.h3 a::after \{[^}]*inset: 0/);
  assert.match(css(), /\.news \.card p:not\(\.eyebrow\) \{[^}]*-webkit-line-clamp: 2/);
});

// ── The legal lines ──
test('the legal lines: each on its own line, readable, in every look, and no look can hide them', () => {
  const org = { authorization: '', agentName: 'Ada Example', agentContact: '604-555-0100' };
  for (const l of everyLook()) {
    const html = draw({ theme: { ...l, skin: l.key }, org });
    assert.match(html, /<div class="footer-bottom">[\s\S]*Authorized by Ada Example, 604-555-0100/, l.key);
  }
  // A campaign's own look too, with its own stylesheet linked (Imagine
  // Surrey's server: its brand, for this check only). Whether a stylesheet
  // can hide the line is read in a browser (e2e-site-render, every look).
  const brand = process.env.STARBASE_BRAND;
  process.env.STARBASE_BRAND = 'imagine-surrey';
  try {
    const keys = everyLook().map((l) => l.key);
    assert.ok(keys.includes('imagine-surrey'), `the campaign's own look is checked too: ${keys.join(', ')}`);
    for (const l of everyLook()) {
      const html = draw({ theme: { ...l, skin: l.key }, org });
      assert.match(html, /<link rel="stylesheet" href="[^"]*imagine-surrey\/look\.css[^"]*">/, `${l.key}: the campaign's own stylesheet`);
      assert.match(html, /<div class="footer-bottom">[\s\S]*Authorized by Ada Example, 604-555-0100/, `${l.key} on the campaign's own server`);
    }
  } finally {
    process.env.STARBASE_BRAND = brand;
  }
  const block = rule('.footer-bottom');
  for (const want of ['display: flex !important', 'flex-direction: column !important', 'visibility: visible !important', 'opacity: 1 !important', 'position: static !important', 'font-size: 15px !important']) {
    assert.ok(block.includes(want), `.footer-bottom: ${want}`);
  }
  assert.match(css(), /\.footer-bottom p,\n\.footer-bottom \.footer-authorization \{[^}]*display: block !important[^}]*color: var\(--brand-soft\) !important/);
  assert.match(rule('.form-small'), /font-size: 15px/);
});

// ── The desk: the look before, and the published page in Theme's preview ──
let mgr;
before(async () => {
  process.env.STARBASE_BRAND = 'base';
  ({ mgr } = await campaign('Riverside Forward'));
});

test('the look a website had is kept to go back to, with when it changed; a save that changes nothing keeps it', async () => {
  const first = ok(await mgr.get('/api/site')).settings;
  assert.equal(first.look_before, null, 'nothing to go back to yet');
  const own = { skin: 'base', colors: { brand: '#2f5d8a', brandInk: '#ffffff' }, follow: false };
  ok(await mgr.action('site.settings.save', { theme: own }));
  const was = ok(await mgr.get('/api/site')).settings;
  ok(await mgr.action('site.settings.save', { theme: { ...LOOKS[1], skin: 'evergreen', follow: false } }));
  const now = ok(await mgr.get('/api/site')).settings;
  assert.equal(now.theme.skin, 'evergreen');
  assert.equal(now.theme.scale, 'modern', 'a ready look picked: the modern sizes');
  assert.deepEqual(now.look_before.theme, was.theme, 'the look it had');
  assert.ok(Date.now() - new Date(now.look_before.at) < 60_000, 'and when it changed');
  // Saving the same look again: still the same look to go back to.
  ok(await mgr.action('site.settings.save', { theme: now.theme }));
  assert.deepEqual(ok(await mgr.get('/api/site')).settings.look_before.theme, was.theme);
  // Going back is a save of that look: the one left is the way back now.
  ok(await mgr.action('site.settings.save', { theme: now.look_before.theme }));
  const back = ok(await mgr.get('/api/site')).settings;
  assert.equal(back.theme.skin, 'base');
  assert.equal(back.theme.scale, undefined);
  assert.equal(back.look_before.theme.skin, 'evergreen');
  // Other settings saved: the way back is untouched.
  ok(await mgr.action('site.settings.save', { announcement: { enabled: true, text: 'Hello', linkLabel: '', linkHref: '' } }));
  assert.equal(ok(await mgr.get('/api/site')).settings.look_before.theme.skin, 'evergreen');
});

test('a preview link for the published page shows the published words, not a newer draft', async () => {
  const pages = ok(await mgr.get('/api/site')).pages;
  const home = pages.find((p) => p.slug === 'home');
  ok(await mgr.action('site.page.save', { id: home.id, modules: [{ id: 'draft-words', kind: 'text', props: { title: 'Words only in the draft' } }] }));
  const draft = ok(await mgr.post('/api/site/preview-token', { pageId: home.id }));
  assert.match((await hit(draft.url)).text, /Words only in the draft/);
  const live = ok(await mgr.post('/api/site/preview-token', { pageId: home.id, live: true }));
  const r = await hit(live.url);
  assert.equal(r.status, 200);
  assert.doesNotMatch(r.text, /Words only in the draft/, 'the published page');
  assert.match(r.text, /id="wa-rc"/, 'with the inputs the preview script redraws a look from');
});

test('Theme’s preview of the published page draws no stand-in picture; the builder’s own frame does', async () => {
  const pages = ok(await mgr.get('/api/site')).pages;
  const home = pages.find((p) => p.slug === 'home');
  // A published home page whose hero has no picture.
  ok(await mgr.action('site.page.save', { id: home.id, modules: [{ id: 'hero-bare', kind: 'hero', props: { ...newModule('hero', 'hero-bare').props, titlePrefix: 'Riverside, together', text: 'A sample campaign.', image: { url: '', alt: '' } } }] }));
  const pub = await mgr.action('site.page.publish', { id: home.id });
  assert.equal(pub.status, 200, JSON.stringify(pub.json));
  const civic = { ...LOOKS[0], skin: 'civic-blue' };
  // What Website → Theme's preview does with a look (site-preview.js tryLook):
  // the page drawn again from its own inputs, in that look.
  const inputs = (text) => JSON.parse(/<script type="application\/json" id="wa-rc">([\s\S]*?)<\/script>/.exec(text)[1]);
  const tried = (wa) => drawBody({ ...wa, site: { ...wa.site, theme: checkTheme(civic).theme } }, wa.page.modules);
  const live = ok(await mgr.post('/api/site/preview-token', { pageId: home.id, live: true }));
  const lr = await hit(live.url);
  assert.equal(lr.status, 200);
  assert.match(lr.text, /data-module="hero"/);
  assert.doesNotMatch(tried(inputs(lr.text)), /hero-ph|Your picture/, 'Theme’s preview: as visitors see it');
  // The builder's own frame (?edit=1) of the same page in a modern look: the box.
  const draft = ok(await mgr.post('/api/site/preview-token', { pageId: home.id }));
  const er = await hit(`${draft.url}${draft.url.includes('?') ? '&' : '?'}edit=1`);
  assert.equal(er.status, 200);
  assert.match(tried(inputs(er.text)), /<div class="hero-ph" role="img" aria-label="Your picture">/);
});
