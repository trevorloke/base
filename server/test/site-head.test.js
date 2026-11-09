// What a live page tells search engines and the apps a link is shared to
// (ext/site/public.js → the renderer's head, SITE.md ctx.origin): the
// canonical address, og:url and og:image, absolute — on the campaign's own
// domain, on the app's own address (/site/) and under a client's path
// (base.win/<client>, where STARBASE_PUBLIC_URL says the public address).
// A page's own share picture comes before the site's (seo.shareImage), and
// that before the hero's. A cached page never carries another host's
// address (www and the bare domain, or a made-up Host on the app's copy).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.SITE_HOSTS = 'imaginesurrey.example.org, www.imaginesurrey.example.org';

const { hit, ok, campaign } = await import('./site-helpers.js');
const { app } = await import('../index.js');
const { mountAt } = await import('../lib/mount.js');

const SITE = 'imaginesurrey.example.org';
const HTTPS = { 'x-forwarded-proto': 'https' };
let mgr;
before(async () => {
  ({ mgr } = await campaign());
  ok(await mgr.get('/api/site'));
});

const head = (html) => ({
  canonical: /<link rel="canonical" href="([^"]+)">/.exec(html)?.[1] || null,
  url: /<meta property="og:url" content="([^"]+)">/.exec(html)?.[1] || null,
  image: /<meta property="og:image" content="([^"]+)">/.exec(html)?.[1] || null,
  card: /<meta name="twitter:card" content="([^"]+)">/.exec(html)?.[1] || null,
});

test('the campaign’s own domain: canonical, og:url and og:image are absolute', async () => {
  const home = head((await hit('/', { host: SITE, headers: HTTPS })).text);
  assert.deepEqual(home, {
    canonical: `https://${SITE}/`, url: `https://${SITE}/`,
    image: `https://${SITE}/site-assets/imagine-surrey/members-rally.jpg`, card: 'summary_large_image',
  }, 'the site’s share picture (Settings → Search and sharing)');
  const donate = head((await hit('/donate', { host: SITE, headers: HTTPS })).text);
  assert.equal(donate.canonical, `https://${SITE}/donate`);
  assert.equal(donate.url, `https://${SITE}/donate`);
  assert.ok(donate.image?.startsWith(`https://${SITE}/`), donate.image);
  // Without JavaScript, the share links carry the whole address too.
  const act = (await hit('/act/skytrain-south-surrey', { host: SITE, headers: HTTPS })).text;
  assert.match(act, new RegExp(`https://wa\\.me/\\?text=[^"]*${encodeURIComponent(`https://${SITE}/act/skytrain-south-surrey`).replace(/[.]/g, '\\.')}`), 'the petition’s WhatsApp link');
});

test('www and the bare domain, and a made-up Host on the app’s copy, never get each other’s address from the cache', async () => {
  for (let i = 0; i < 2; i += 1) {
    assert.equal(head((await hit('/donate', { host: SITE, headers: HTTPS })).text).canonical, `https://${SITE}/donate`);
    assert.equal(head((await hit('/donate', { host: `www.${SITE}`, headers: HTTPS })).text).canonical, `https://www.${SITE}/donate`);
  }
  const spoofed = head((await hit('/site/donate', { host: 'evil.example' })).text);
  assert.equal(spoofed.canonical, 'http://evil.example/site/donate', 'a request’s own Host is only ever its own answer');
  const mirror = head((await hit('/site/donate')).text);
  assert.equal(mirror.canonical, 'http://localhost/site/donate', '…never the next visitor’s');
  assert.equal(mirror.image, 'http://localhost/site-assets/imagine-surrey/members-rally.jpg');
});

test('a page’s own share picture comes first; then the site’s; then its hero’s', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const pic = ok(await mgr.action('site.picture', { data: png })).media;
  const pages = ok(await mgr.get('/api/site')).pages;
  const donate = pages.find((p) => p.slug === 'donate');
  ok(await mgr.action('site.page.save', { id: donate.id, image: { url: pic.url, alt: 'A volunteer at the door' } }));
  ok(await mgr.action('site.page.publish', { id: donate.id }));
  const h = head((await hit('/donate', { host: SITE, headers: HTTPS })).text);
  assert.equal(h.image, `https://${SITE}${pic.url}`, 'the page’s own (Page details → Share picture)');
  assert.match((await hit('/donate', { host: SITE, headers: HTTPS })).text, /<meta property="og:image:alt" content="A volunteer at the door">/);
  // The preview shows the draft's picture the same way.
  const tok = ok(await mgr.post('/api/site/preview-token', { pageId: donate.id }));
  assert.equal(head((await hit(tok.url)).text).image, `http://localhost${pic.url}`);
  // No page picture: the site's; no site picture either: the hero's.
  ok(await mgr.action('site.page.save', { id: donate.id, image: null }));
  ok(await mgr.action('site.page.publish', { id: donate.id }));
  assert.equal(head((await hit('/donate', { host: SITE, headers: HTTPS })).text).image, `https://${SITE}/site-assets/imagine-surrey/members-rally.jpg`);
  const s = ok(await mgr.get('/api/site')).settings;
  ok(await mgr.action('site.settings.save', { seo: { ...s.seo, shareImage: { url: '', alt: '' } } }));
  assert.equal(head((await hit('/', { host: SITE, headers: HTTPS })).text).image, `https://${SITE}/site-assets/imagine-surrey/hero-park.jpg`, 'the home page’s hero');
  ok(await mgr.action('site.settings.save', { seo: s.seo }));
});

test('under a client’s path (base.win/<client>): the public address is STARBASE_PUBLIC_URL’s, the client’s path once', async () => {
  const mounted = mountAt(app, '/imaginesurrey');
  const get = async (path) => (await mounted(new Request(`http://starbase-test.onrender.com${path}`, { headers: { 'x-forwarded-for': '192.0.2.40', 'x-forwarded-proto': 'https' } }))).text();
  process.env.STARBASE_PUBLIC_URL = 'https://base.win/imaginesurrey';
  try {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const pic = ok(await mgr.action('site.picture', { data: png })).media;
    const donate = ok(await mgr.get('/api/site')).pages.find((p) => p.slug === 'donate');
    ok(await mgr.action('site.page.save', { id: donate.id, image: { url: pic.url, alt: 'A picture' } }));
    ok(await mgr.action('site.page.publish', { id: donate.id }));
    const h = head(await get('/imaginesurrey/site/donate'));
    assert.equal(h.canonical, 'https://base.win/imaginesurrey/site/donate');
    assert.equal(h.url, 'https://base.win/imaginesurrey/site/donate');
    assert.equal(h.image, `https://base.win/imaginesurrey${pic.url}`, 'an uploaded picture, at the client’s path');
    assert.equal(head(await get('/imaginesurrey/site/')).image, 'https://base.win/imaginesurrey/site-assets/imagine-surrey/members-rally.jpg');
    // The sitemap and robots.txt name the same addresses.
    assert.match(await get('/imaginesurrey/site/sitemap.xml'), /<loc>https:\/\/base\.win\/imaginesurrey\/site\/donate<\/loc>/);
    assert.match(await get('/imaginesurrey/site/robots.txt'), /Sitemap: https:\/\/base\.win\/imaginesurrey\/site\/sitemap\.xml/);
    ok(await mgr.action('site.page.save', { id: donate.id, image: null }));
    ok(await mgr.action('site.page.publish', { id: donate.id }));
  } finally {
    delete process.env.STARBASE_PUBLIC_URL;
  }
});
