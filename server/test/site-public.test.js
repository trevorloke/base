// Where the website answers (ext/site/public.js, SITE.md "Where the site is
// served"): on the campaign's own domain (SITE_HOSTS, or a domain saved
// under Website) the site is at / and nothing of the app answers there —
// not /api, not /field, not the sign-in cookie — but /media/:id and the
// site's files do; on the app's own address the site is /site/… and every
// app route stays the app's; under a client's path (BASE_PATH) its links
// carry the path. The headers every page carries, robots.txt (all off on
// staging), the sitemap, the 404 page, the site's files, and the data the
// renderer gets — upcoming public shifts with their spots left.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.SITE_HOSTS = 'imaginesurrey.example.org, www.imaginesurrey.example.org';

const { hit, send, ok, campaign } = await import('./site-helpers.js');
const { app } = await import('../index.js');
const { mountAt } = await import('../lib/mount.js');
const { loadData } = await import('../ext/site/loaders.js');
const { siteWorkspace } = await import('../ext/site/store.js');

let db, mgr, ws;
const SITE = 'imaginesurrey.example.org';

before(async () => {
  ({ db, mgr, ws } = await campaign());
  ok(await mgr.get('/api/site'));
});

test('on the campaign’s own domain: the site at /, its pages, its 404', async () => {
  const home = await hit('/', { host: SITE });
  assert.equal(home.status, 200);
  assert.match(home.text, /data-module="hero" id="m-hero"/);
  assert.match(home.text, /data-module="petition" id="m-skytrain"/);
  assert.equal((await hit('/donate', { host: SITE })).status, 200);
  assert.equal((await hit('/www.imaginesurrey.example.org', { host: SITE })).status, 404);
  assert.equal((await hit('/donate', { host: `www.${SITE}` })).status, 200, 'every SITE_HOSTS host');
  const missing = await hit('/no-such-page', { host: SITE });
  assert.equal(missing.status, 404);
  assert.match(missing.text, /<title>Page not found · [^<]+<\/title>/, 'the site’s own 404 page');
  assert.match(missing.text, /<meta name="robots" content="noindex">/, '…never indexed');
  const trailing = await hit('/donate/?x=1', { host: SITE });
  assert.deepEqual([trailing.status, trailing.location], [301, '/donate?x=1'], 'one address per page');
});

test('on the campaign’s own domain nothing of the app answers, and no sign-in cookie is read or set', async () => {
  const mgrCookie = mgr.cookie;
  for (const path of ['/api/health', '/api/auth/setup', '/api/persons', '/field', '/desk', '/admin', '/u/x', '/learn/x', '/in/v1/ping', '/api/site']) {
    const r = await hit(path, { host: SITE, headers: { cookie: mgrCookie } });
    assert.equal(r.status, 404, `${path} is not answered`);
    assert.match(r.text, /<!doctype html>/, `${path}: the site's page, not the app's`);
    assert.equal(r.headers.get('set-cookie'), null);
  }
  const signin = await hit('/api/auth/login', { host: SITE, method: 'POST', body: { email: 'x@example.org', password: 'whatever-1234' } });
  assert.equal(signin.status, 404, 'no sign-in there');
  assert.equal(signin.headers.get('set-cookie'), null);
  // …but a picture, the site's files and the form endpoint do.
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const pic = ok(await mgr.action('site.picture', { data: png }));
  assert.equal((await hit(pic.media.url, { host: SITE })).status, 200);
  const logo = await hit('/site-assets/imagine-surrey/logo.webp', { host: SITE });
  assert.deepEqual([logo.status, logo.headers.get('content-type')], [200, 'image/webp']);
  assert.equal((await hit('/site-assets/../server/index.js', { host: SITE })).status, 404);
  assert.equal((await hit('/site-assets/imagine-surrey/..%2F..%2Fcatalogue.js', { host: SITE })).status, 404, 'never outside the site’s files');
  assert.equal((await hit('/site-assets/catalogue.js', { host: SITE })).status, 404, 'only the kinds of file a site serves');
  const form = await send('newsletter', { email: 'domain@example.org', consent_email: true }, { root: '', host: SITE });
  assert.deepEqual(form.json, { ok: true });
  // The Stripe webhook is passed on to whoever answers it (ext/payments), not the site.
  const hook = await hit('/stripe/webhook', { host: SITE, method: 'POST', body: '{}' });
  assert.doesNotMatch(hook.text, /data-module=/);
});

test('on the app’s own address the site is /site/…, and every app route is the app’s', async () => {
  assert.equal((await hit('/site/')).status, 200);
  assert.equal((await hit('/site')).status, 200);
  assert.equal((await hit('/site/donate')).status, 200);
  assert.equal((await hit('/api/health')).status, 200, 'the app answers');
  assert.equal((await hit('/donate')).status !== 200 || !(await hit('/donate')).text.includes('data-module'), true, 'no site page at the app’s root');
  assert.equal((await hit('/site-assets/imagine-surrey/hero-park.jpg')).status, 200);
  const r = await hit('/site/');
  assert.match(r.headers.get('x-robots-tag') || '', /noindex/, 'the app’s copy of a site with its own domain isn’t indexed');
});

test('every page carries the headers: a CSP of self, the video players and Stripe; never framed', async () => {
  const r = await hit('/', { host: SITE });
  const csp = r.headers.get('content-security-policy');
  for (const part of ["default-src 'self'", "script-src 'self'", "img-src 'self' data:", 'frame-src https://www.youtube-nocookie.com https://www.youtube.com https://player.vimeo.com',
    "form-action 'self' https://checkout.stripe.com", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'"]) {
    assert.ok(csp.includes(part), part);
  }
  assert.ok(!/unsafe-eval/.test(csp) && !/script-src[^;]*unsafe-inline/.test(csp));
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(r.headers.get('content-type'), 'text/html; charset=UTF-8');
  const secure = await hit('/', { host: SITE, headers: { 'x-forwarded-proto': 'https' } });
  assert.match(secure.headers.get('strict-transport-security'), /max-age=/);
});

test('robots.txt and the sitemap; staging keeps every crawler out', async () => {
  const robots = await hit('/robots.txt', { host: SITE });
  assert.match(robots.text, /Disallow: \/__preview\//);
  assert.match(robots.text, /Sitemap: http:\/\/imaginesurrey\.example\.org\/sitemap\.xml/);
  const map = await hit('/sitemap.xml', { host: SITE });
  assert.match(map.headers.get('content-type'), /application\/xml/);
  for (const path of ['/', '/tracker', '/donate', '/news', '/act/skytrain-south-surrey', '/act/stop-mccallum-pledge']) {
    assert.ok(map.text.includes(`<loc>http://${SITE}${path}</loc>`), path);
  }
  const draft = ok(await mgr.action('site.page.create', { title: 'Secret plans' })).page;
  assert.ok(!(await hit('/sitemap.xml', { host: SITE })).text.includes('secret-plans'), 'never a draft');
  ok(await mgr.action('site.page.delete', { id: draft.id }));
  process.env.STARBASE_ENV = 'staging';
  try {
    assert.equal((await hit('/robots.txt', { host: SITE })).text, 'User-agent: *\nDisallow: /\n');
    assert.match((await hit('/', { host: SITE })).headers.get('x-robots-tag'), /noindex/);
  } finally {
    delete process.env.STARBASE_ENV;
  }
});

test('a domain saved under Website is the site’s too', async () => {
  assert.equal((await hit('/api/health', { host: 'vote.example.net' })).status, 200, 'not yet');
  ok(await mgr.action('site.settings.save', { domains: ['vote.example.net'] }));
  const r = await hit('/', { host: 'vote.example.net' });
  assert.equal(r.status, 200);
  assert.match(r.text, /data-module="hero"/);
  assert.equal((await hit('/api/health', { host: 'vote.example.net' })).status, 404);
  ok(await mgr.action('site.settings.save', { domains: [] }));
  assert.equal((await hit('/api/health', { host: 'vote.example.net' })).status, 200, 'and back');
});

test('under a client’s path (BASE_PATH) the site’s links, redirects and cookies carry it', async () => {
  const mounted = mountAt(app, '/imaginesurrey');
  const req = (path, init = {}) => mounted(new Request(`http://localhost${path}`, { redirect: 'manual', ...init }));
  const home = await req('/imaginesurrey/site/');
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.match(html, /data-module="hero"/);
  const code = (await db.query("select attrs->>'ref_code' as c from persons where workspace_id = $1 and attrs ? 'ref_code' limit 1", [ws])).rows[0].c;
  const r = await req(`/imaginesurrey/site/r/${code}`);
  assert.equal(r.headers.get('location'), '/imaginesurrey/site/');
  assert.match(r.headers.get('set-cookie'), /Path=\/imaginesurrey\/site/);
  const plain = await req('/imaginesurrey/site/api/forms/contact', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '192.0.2.9' }, body: 'email=base%40example.org&message=hi&module_id=contact',
  });
  assert.equal(plain.headers.get('location'), '/imaginesurrey/site/?sent=contact#m-contact');
  const tok = ok(await mgr.get('/api/site')) && (await mounted(new Request('http://localhost/imaginesurrey/api/site/preview-token', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: mgr.cookie }, body: JSON.stringify({ pageId: (await mgr.get('/api/site')).json.pages[0].id }),
  })).then((x) => x.json()));
  assert.match(tok.url, /^\/imaginesurrey\/site\/__preview\//, 'the preview link carries the path');
});

test('the data the renderer gets: posts, upcoming public shifts with spots left, counts, petitions, payments, roles', async () => {
  const later = new Date(Date.now() + 3 * 864e5).toISOString();
  const s = (await mgr.action('shift.create', { title: 'Canvass in Newton', location: 'Newton Seniors Centre', starts_at: later, capacity: 4 })).json.shift;
  const hidden = (await mgr.action('shift.create', { title: 'Office only', starts_at: later })).json.shift;
  ok(await mgr.action('shift.public', { id: s.id, public: true }));
  const a = (await mgr.createPerson('Kai Example'));
  const b = (await mgr.createPerson('Lu Example'));
  ok(await mgr.action('shift.assign', { shift_id: s.id, person_id: a.id }));
  const assigned = ok(await mgr.action('shift.assign', { shift_id: s.id, person_id: b.id }));
  ok(await mgr.action('shift.setStatus', { id: assigned.assignment.id, status: 'declined' }));
  const post = ok(await mgr.action('site.post.save', { title: 'Hello Surrey', excerpt: 'First post' })).post;
  ok(await mgr.action('site.post.publish', { id: post.id }));
  const site = await siteWorkspace(db, ws);
  const data = await loadData(db, site);
  assert.deepEqual(Object.keys(data).sort(), ['campaigns', 'counts', 'events', 'payments', 'posts', 'roles']);
  assert.deepEqual(data.events.map((e) => [e.title, e.spots_left, e.location]), [['Canvass in Newton', 3, 'Newton Seniors Centre']], 'public only; a "can’t make it" frees the spot');
  assert.ok(!data.events.some((e) => e.id === hidden.id));
  assert.deepEqual(Object.keys(data.events[0]).sort(), ['ends_at', 'id', 'lat', 'lng', 'location', 'spots_left', 'starts_at', 'title']);
  assert.deepEqual(data.posts.map((p) => p.title), ['Hello Surrey']);
  assert.deepEqual(Object.keys(data.posts[0]).sort(), ['excerpt', 'image', 'published_at', 'slug', 'title']);
  const sky = Object.values(data.campaigns).find((c) => c.slug === 'skytrain-south-surrey');
  assert.deepEqual(Object.keys(sky).sort(), ['count', 'excerpt', 'goal', 'id', 'kind', 'slug', 'statement', 'status', 'title']);
  assert.equal(sky.goal, 2500);
  assert.equal(data.counts.members, 0);
  assert.deepEqual(data.payments.ready, false);
  assert.equal(data.payments.limit_cents, 142970, 'this year’s limit for a BC local campaign (lib/cap.js)');
  assert.equal(data.payments.monthly_max_cents, 11900);
  assert.ok(data.roles.includes('Doorknocking'));
});
