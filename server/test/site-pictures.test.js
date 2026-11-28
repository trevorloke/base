// Pictures and posts (WA stage 2b): a picture's smaller copies (site.picture
// sizes), the image field's sizes / focus / decorative, descriptions
// required for pictures added since the last publish (pages and posts,
// image fields and Markdown ![words](url)), older ones counted not refused,
// Img's srcset / sizes / fetchpriority / lazy / object-position, and a
// post's summary made from its words.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { checkImage, checkProps } from '@base-win/shared/site/catalogue';
import { knownPictures, summaryFrom } from '@base-win/shared/site/pictures';
import { renderSite } from '../ext/site/render/index.js';
import { baseSample } from './site-samples.js';
import { ok, campaign } from './site-helpers.js';

// Bytes a server reads as a JPEG / WebP / PNG (it sniffs the first bytes).
const jpeg = (n = 200) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n)]).toString('base64');
const webp = (n = 200) => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(n)]).toString('base64');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let mgr; let db;
before(async () => { ({ mgr, db } = await campaign()); });

const upload = async (extra = {}) => ok(await mgr.action('site.picture', {
  data: `data:image/jpeg;base64,${jpeg(4000)}`, name: 'rally.jpg', width: 2000, height: 1500,
  sizes: [{ data: jpeg(300), width: 480, height: 360 }, { data: webp(600), width: 960, height: 720 }, { data: jpeg(900), width: 1600, height: 1200 }],
  ...extra,
})).media;

test('site.picture keeps up to 3 smaller copies (JPEG or WebP), each its own /media address, and the list keeps them with the picture', async () => {
  const m = await upload();
  assert.equal(m.width, 2000);
  assert.deepEqual(m.sizes.map((z) => z.w), [480, 960, 1600]);
  assert.ok(m.sizes.every((z) => /^\/media\/[0-9a-f-]{36}$/.test(z.url)));
  const copy = (await db.query('select content_type, size_of from media where id = $1', [m.sizes[1].url.slice(7)])).rows[0];
  assert.deepEqual(copy, { content_type: 'image/webp', size_of: m.id });
  const list = ok(await mgr.get('/api/site/pictures')).pictures;
  const mine = list.find((p) => p.id === m.id);
  assert.deepEqual(mine.sizes, m.sizes, 'picked again, the picture brings its copies');
  assert.ok(!list.some((p) => m.sizes.some((z) => z.url === p.url)), 'the copies aren’t listed as pictures of their own');
  // Without sizes: as before.
  const plain = ok(await mgr.action('site.picture', { data: `data:image/png;base64,${png}`, width: 1, height: 1 })).media;
  assert.equal(plain.sizes, undefined);
});

test('site.picture refuses a copy over 600 KB, a PNG copy and a 4th copy', async () => {
  const big = await mgr.action('site.picture', { data: jpeg(), sizes: [{ data: jpeg(605 * 1024), width: 480, height: 360 }] });
  assert.equal(big.status, 400);
  assert.match(big.json.error, /600 KB at most/);
  const pngCopy = await mgr.action('site.picture', { data: jpeg(), sizes: [{ data: png, width: 1, height: 1 }] });
  assert.equal(pngCopy.status, 400);
  assert.match(pngCopy.json.error, /JPG or WebP/);
  const four = await mgr.action('site.picture', { data: jpeg(), sizes: [1, 2, 3, 4].map((i) => ({ data: jpeg(), width: i * 100, height: i * 100 })) });
  assert.equal(four.status, 400);
  assert.equal((await db.query('select count(*)::int as n from media where name is null and bytes = 204')).rows[0].n, 0, 'nothing stored by a refused upload');
});

test('the image field keeps sizes, focus and decorative; refuses another site’s copies and a spot off the picture', () => {
  const sizes = [{ url: '/media/0f2e7c1a-3b4d-4e5f-8a9b-0c1d2e3f4a5b', w: 480 }];
  const v = checkImage({ url: '/media/0f2e7c1a-3b4d-4e5f-8a9b-0c1d2e3f4a5c', alt: '', width: 2000, height: 1500, sizes, focus: { x: 20, y: 75 }, decorative: true, junk: 1 });
  assert.deepEqual(v, { url: '/media/0f2e7c1a-3b4d-4e5f-8a9b-0c1d2e3f4a5c', alt: '', width: 2000, height: 1500, sizes, focus: { x: 20, y: 75 }, decorative: true });
  assert.deepEqual(checkImage({ url: '/media/x', alt: 'A', focus: { x: 50, y: 50 } }), { url: '/media/x', alt: 'A' }, 'the middle is the default');
  assert.throws(() => checkImage({ url: '/media/x', sizes: [{ url: 'https://elsewhere.example/a.jpg', w: 480 }] }), /a size must be an uploaded picture/);
  assert.throws(() => checkImage({ url: '/media/x', sizes: [1, 2, 3, 4].map(() => sizes[0]) }), /at most 3 sizes/);
  assert.throws(() => checkImage({ url: '/media/x', focus: { x: 101, y: 0 } }), /off the picture/);
  assert.throws(() => checkImage({ url: '/media/x', focus: { x: 10.5, y: 0 } }), /off the picture/);
  assert.deepEqual(checkProps('image', { image: { url: '', alt: '', focus: { x: 3, y: 3 } } }).image, { url: '', alt: '' }, 'no picture: nothing else kept');
});

const pictureModule = (url, extra = {}) => ({ id: 'pic001', kind: 'image', props: { image: { url, alt: '', ...extra }, caption: '' } });
const textModule = (body) => ({ id: 'txt001', kind: 'text', props: { title: 'How we started', body } });

test('Publish: a picture added without a description is refused, naming the section; decorative or described passes', async () => {
  const m = await upload();
  const { page } = ok(await mgr.action('site.page.create', { title: 'Rally', modules: [textModule('We met at the library.'), pictureModule(m.url)] }));
  const r = await mgr.action('site.page.publish', { id: page.id });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /The 2nd module \(Picture\): image\.alt: describe the picture for people who can’t see it/);
  ok(await mgr.action('site.page.save', { id: page.id, modules: [textModule('We met at the library.'), pictureModule(m.url, { decorative: true })] }));
  const pub = ok(await mgr.action('site.page.publish', { id: page.id }));
  assert.equal(pub.undescribed, undefined);
  // Replaced by another picture: new again.
  const n = await upload();
  ok(await mgr.action('site.page.save', { id: page.id, modules: [textModule('We met at the library.'), pictureModule(n.url)] }));
  assert.equal((await mgr.action('site.page.publish', { id: page.id })).status, 400);
  ok(await mgr.action('site.page.save', { id: page.id, modules: [textModule('We met at the library.'), pictureModule(n.url, { alt: 'Neighbours at the library' })] }));
  ok(await mgr.action('site.page.publish', { id: page.id }));
});

test('an old page with a published picture that has no description republishes after a text change, and the answer counts it', async () => {
  const m = await upload();
  const mods = [textModule('We met at the library.'), pictureModule(m.url)];
  const { page } = ok(await mgr.action('site.page.create', { title: 'Older', modules: mods }));
  // Published before descriptions were asked for.
  await db.query("update site_pages set published = draft, status = 'published', version = 1 where id = $1", [page.id]);
  ok(await mgr.action('site.page.save', { id: page.id, modules: [textModule('We met at the old library.'), mods[1]] }));
  const pub = ok(await mgr.action('site.page.publish', { id: page.id }));
  assert.equal(pub.undescribed, 1);
  assert.equal(pub.page.status, 'published');
});

test('Markdown pictures: an added ![](url) blocks Publish; one with words passes; an old one doesn’t block', async () => {
  const m = await upload();
  const { page } = ok(await mgr.action('site.page.create', { title: 'Words', modules: [textModule(`Here we are.\n\n![](${m.url})`)] }));
  const r = await mgr.action('site.page.publish', { id: page.id });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /The 1st module \(Text block\): body: a picture in it has no description/);
  ok(await mgr.action('site.page.save', { id: page.id, modules: [textModule(`Here we are.\n\n![Our table at the market](${m.url})`)] }));
  ok(await mgr.action('site.page.publish', { id: page.id }));
  // The same check, in the catalogue: known addresses don't block.
  const known = knownPictures({ modules: [textModule(`![](${m.url})`)] });
  assert.doesNotThrow(() => checkProps('text', textModule(`Again ![](${m.url})`).props, { strict: true, known }));
  assert.throws(() => checkProps('text', textModule('![](/media/new)').props, { strict: true, known }), /body: a picture in it has no description/);
  assert.doesNotThrow(() => checkProps('text', textModule('![](/media/new)').props, { strict: true }), 'no known list (a seed): no rule');
});

test('posts: publishing needs every picture described; a published post can’t gain an undescribed one but keeps an old one', async () => {
  const m = await upload();
  const p = ok(await mgr.action('site.post.save', { title: 'Our first rally', body: 'It was big.', image: { url: m.url, alt: '', sizes: m.sizes, focus: { x: 30, y: 40 } } })).post;
  assert.deepEqual(p.image.focus, { x: 30, y: 40 });
  assert.equal(p.image.sizes.length, 3);
  const r = await mgr.action('site.post.publish', { id: p.id });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /The picture: describe it/);
  ok(await mgr.action('site.post.save', { id: p.id, title: 'Our first rally', body: 'It was big.', image: { ...p.image, alt: 'A crowd in the park' } }));
  ok(await mgr.action('site.post.publish', { id: p.id }));
  // Live: a Markdown picture added without words is refused at once.
  const other = await upload();
  const add = await mgr.action('site.post.save', { id: p.id, title: 'Our first rally', body: `It was big.\n\n![](${other.url})` });
  assert.equal(add.status, 400);
  assert.match(add.json.error, /The post: a picture in it has no description/);
  // An old published post whose picture never had words: a text change saves.
  await db.query("update site_posts set image = $2 where id = $1", [p.id, JSON.stringify({ url: m.url, alt: '' })]);
  ok(await mgr.action('site.post.save', { id: p.id, title: 'Our first rally', body: 'It was very big.' }));
  const bad = await mgr.action('site.post.save', { id: p.id, title: 'x', image: { url: m.url, alt: '', focus: { x: 200, y: 0 } } });
  assert.equal(bad.status, 400);
});

const shown = (modules, post = null) => renderSite({
  kind: post ? 'post' : 'page', site: baseSample.site, page: { ...baseSample.page, modules }, ...(post ? { post } : {}), data: baseSample.data,
  ctx: { root: '/', assets: '/site-assets/', path: post ? `/news/${post.slug}` : '/', origin: 'https://example.org', islands: false },
}).html;
const imgTags = (html, cls) => [...html.matchAll(new RegExp(`<img[^>]*class="${cls}"[^>]*>`, 'g'))].map((x) => x[0]);

test('Img: srcset and sizes from the copies, the first section’s picture first and not lazy, lazy below, the spot kept in view', () => {
  const id = (n) => `/media/0f2e7c1a-3b4d-4e5f-8a9b-0c1d2e3f4a5${n}`;
  const pic = { url: id(0), alt: 'A crowd', width: 2000, height: 1500, sizes: [{ url: id(1), w: 480 }, { url: id(2), w: 960 }, { url: id(3), w: 1600 }], focus: { x: 20, y: 80 } };
  const html = shown([
    { id: 'hero01', kind: 'hero', props: { titlePrefix: 'Better buses', text: 'Soon.', image: pic } },
    { id: 'pic002', kind: 'image', props: { image: pic, caption: '' } },
    { id: 'pic003', kind: 'image', props: { image: { url: '/media/b', alt: '' , decorative: true }, caption: '' } },
  ]);
  const [hero] = imgTags(html, 'hero-image');
  assert.match(hero, /srcset="\/media\/\S+1 480w, \/media\/\S+2 960w, \/media\/\S+3 1600w, \/media\/\S+0 2000w"/i);
  assert.match(hero, /sizes="\(min-width: 900px\) 50vw, 100vw"/);
  assert.match(hero, /fetchpriority="high"/i);
  assert.doesNotMatch(hero, /loading="lazy"/);
  assert.match(hero, /object-position:20% 80%/);
  assert.match(hero, /width="2000" height="1500"/);
  const [wide, plain] = imgTags(html, 'wide-image');
  assert.match(wide, /loading="lazy"/);
  assert.doesNotMatch(wide, /fetchpriority/i);
  assert.match(wide, /srcset=/i);
  assert.doesNotMatch(plain, /srcset|object-position/i, 'no copies: drawn as before');
  assert.match(plain, /alt=""/, 'decorative: says nothing');
  const post = shown([], { id: 'p1', slug: 'rally', title: 'Rally', excerpt: '', body: 'Hi', image: pic, published_at: '2026-10-01T17:00:00Z' });
  const [big] = imgTags(post, 'news-image');
  assert.match(big, /sizes="min\(100vw, 760px\)"/);
  assert.match(big, /fetchpriority="high"/i);
});

test('a post’s short summary is made from its words: plain, at most 160 characters', () => {
  assert.equal(summaryFrom('## Big news\n\nWe **won** the [vote](/x).\n\n![A crowd](/media/a)'), 'Big news We won the vote.');
  const long = summaryFrom('word '.repeat(80));
  assert.ok(long.length <= 160 && long.endsWith('…'));
  assert.equal(summaryFrom(''), '');
});
