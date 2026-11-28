// The website on the campaign's own domain (SITE.md "On its own domain"):
// BASE_SITE_DOMAIN names it (set per service in Render). There the site
// is at / and names the domain in its canonical, og:url, og:image, sitemap
// and robots, whichever of the pair (the www. name, or the bare one) was
// asked; the pair sends a page on to the domain; nothing of the desk or the
// API answers there. /site on the app's address sends people on to the
// domain for good — but a preview, what a preview loads and a form sent
// from a page opened before stay. The present website's old addresses go to
// the base.win page that does the same thing, where one is live, and its own
// email links to it at its own address (BASE_SITE_FORMER_URL). Links
// base.win hands out name the domain, and the unsubscribe sync says its two
// settings come off once the website is base.win's own.
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.SITE_HOSTS;
const DOMAIN = 'campaign.example.org';
process.env.BASE_SITE_DOMAIN = DOMAIN;

const { hit, send, ok, campaign } = await import('./site-helpers.js');
const { mainAddress, siteHost } = await import('../ext/site/store.js');
const { baseOf } = await import('../ext/socials/share-api.js');
const { websiteState } = await import('../ext/intake/website.js');
const { whyOff, checkWebsite } = await import('../ext/intake/service.js');
const { bootNotes } = await import('../index.js');

const WWW = `www.${DOMAIN}`;
const HTTPS = { 'x-forwarded-proto': 'https' };
const ENV = ['BASE_SITE_DOMAIN', 'BASE_SITE_FORMER_URL', 'BASE_BRAND', 'SITE_HOSTS', 'BASE_PUBLIC_URL', 'APP_HOSTS',
  'RENDER_EXTERNAL_HOSTNAME', 'BASE_WEBSITE_URL', 'BASE_WEBSITE_KEY', 'BASE_ENV'];
const START = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV) {
    if (START[k] === undefined) delete process.env[k];
    else process.env[k] = START[k];
  }
});

let mgr;
before(async () => {
  ({ mgr } = await campaign());
  ok(await mgr.get('/api/site'));
});

const head = (html) => ({
  canonical: /<link rel="canonical" href="([^"]+)">/.exec(html)?.[1] || null,
  url: /<meta property="og:url" content="([^"]+)">/.exec(html)?.[1] || null,
  image: /<meta property="og:image" content="([^"]+)">/.exec(html)?.[1] || null,
});
const newsletter = (email) => ({ email, first_name: 'Pat', consent_email: true, client_key: `k-${Math.random().toString(36).slice(2)}` });

test('on the domain the site is at /, and names the domain: canonical, og:url, og:image, sitemap, robots', async () => {
  const home = await hit('/', { host: DOMAIN, headers: HTTPS });
  assert.equal(home.status, 200);
  assert.match(home.text, /data-module="hero" id="m-hero"/);
  const h = head(home.text);
  assert.equal(h.canonical, `https://${DOMAIN}/`);
  assert.equal(h.url, `https://${DOMAIN}/`);
  assert.match(h.image || '', new RegExp(`^https://${DOMAIN.replace(/\./g, '\\.')}/`), 'og:image on the domain');
  const donate = head((await hit('/donate', { host: DOMAIN, headers: HTTPS })).text);
  assert.equal(donate.canonical, `https://${DOMAIN}/donate`);
  const map = await hit('/sitemap.xml', { host: DOMAIN, headers: HTTPS });
  assert.equal(map.status, 200);
  assert.match(map.text, new RegExp(`<loc>https://${DOMAIN}/donate</loc>`));
  assert.doesNotMatch(map.text, /\/site\//, 'no /site in the sitemap');
  const robots = await hit('/robots.txt', { host: DOMAIN, headers: HTTPS });
  assert.match(robots.text, new RegExp(`Sitemap: https://${DOMAIN}/sitemap.xml`));
  assert.equal(home.headers.get('x-robots-tag'), null, 'the domain is indexed');
  // The setting may be written as a web address, with a final dot, in capitals.
  process.env.BASE_SITE_DOMAIN = `HTTPS://${DOMAIN.toUpperCase()}./`;
  assert.equal(head((await hit('/donate', { host: DOMAIN, headers: HTTPS })).text).canonical, `https://${DOMAIN}/donate`);
});

test('the pair (www.) sends a page on to the domain; a form sent there is answered there', async () => {
  const r = await hit('/donate?ref=abc123', { host: WWW, headers: HTTPS });
  assert.deepEqual([r.status, r.location], [301, `https://${DOMAIN}/donate?ref=abc123`]);
  assert.equal((await hit('/', { host: WWW, headers: HTTPS })).location, `https://${DOMAIN}/`);
  assert.equal((await hit('/', { host: `${WWW}.`, headers: HTTPS })).location, `https://${DOMAIN}/`, 'with a final dot too');
  const sent = await send('newsletter', newsletter(`pair.${Date.now()}@example.org`), { root: '', host: WWW });
  assert.equal(sent.status, 200, sent.text.slice(0, 200));
  assert.equal(sent.json.ok, true);
  // A domain written with its www. has the bare name as its pair.
  process.env.BASE_SITE_DOMAIN = WWW;
  assert.equal((await hit('/donate', { host: DOMAIN, headers: HTTPS })).location, `https://${WWW}/donate`);
  assert.equal((await hit('/donate', { host: WWW, headers: HTTPS })).status, 200);
});

test('nothing of the desk or the API answers on the domain or its pair, and no sign-in cookie', async () => {
  for (const host of [DOMAIN, WWW]) {
    for (const path of ['/api/health', '/api/auth/me', '/api/site', '/api/persons', '/desk', '/admin', '/field', '/in/v1/ping', '/login']) {
      const r = await hit(path, { host, headers: { cookie: mgr.cookie } });
      if (host === WWW) {
        assert.equal(r.status, 301, `${host}${path}`);
        assert.equal(new URL(r.location).host, DOMAIN, `${host}${path} goes on to the domain`);
      } else {
        assert.equal(r.status, 404, `${host}${path} is not answered`);
        assert.match(r.text, /<!doctype html>/, `${path}: the site's page, not the app's`);
      }
      assert.equal(r.headers.get('set-cookie'), null);
    }
    const signin = await hit('/api/auth/login', { host, method: 'POST', body: { email: 'x@example.org', password: 'whatever-1234' } });
    assert.equal(signin.status, 404, `no sign-in on ${host}`);
    assert.equal(signin.headers.get('set-cookie'), null);
    // What services call back still reaches the app, in its own shape.
    assert.deepEqual((await hit('/api/public/twilio/sms', { host, method: 'POST', form: { From: '+16045550100', Body: 'STOP' } })).json, { error: 'bad signature' });
  }
  // The app's own address is the app's.
  assert.equal((await hit('/api/health')).status, 200);
  assert.equal((await mgr.get('/api/site')).status, 200);
});

test('/site on the app’s address sends people on to the domain, for good', async () => {
  const r = await hit('/site/donate?x=1', { headers: HTTPS });
  assert.deepEqual([r.status, r.location], [301, `https://${DOMAIN}/donate?x=1`]);
  assert.match(r.headers.get('cache-control') || '', /max-age=3600/, 'kept an hour, so the way back is quick');
  assert.equal((await hit('/site')).location, `http://${DOMAIN}/`);
  assert.equal((await hit('/site/')).location, `http://${DOMAIN}/`);
  assert.equal((await hit('/site/pa/donate')).location, `http://${DOMAIN}/pa/donate`, 'a language too');
  assert.equal((await hit('/site/r/abc123')).location, `http://${DOMAIN}/r/abc123`, 'a referral link');
  assert.equal((await hit('/site//evil.example/x')).location, `http://${DOMAIN}/evil.example/x`, 'always the domain');
  assert.equal((await hit('/site/donate', { method: 'HEAD' })).status, 301);
  // A link with words of another alphabet (a Punjabi word), an accent or an
  // encoded % goes on as it came, still encoded.
  let r2 = await hit('/site/news/%E0%A8%B8%E0%A8%A4?x=1');
  assert.deepEqual([r2.status, r2.location], [301, `http://${DOMAIN}/news/%E0%A8%B8%E0%A8%A4?x=1`]);
  r2 = await hit('/site/pa/news/caf%C3%A9');
  assert.deepEqual([r2.status, r2.location], [301, `http://${DOMAIN}/pa/news/caf%C3%A9`]);
  assert.equal((await hit('/site/news/a%2541')).location, `http://${DOMAIN}/news/a%2541`);
});

test('/site keeps what can’t move: previews, what they load, forms sent from a page opened before, other websites', async () => {
  const { pages } = ok(await mgr.get('/api/site'));
  const donate = pages.find((p) => p.slug === 'donate');
  const { url } = ok(await mgr.post('/api/site/preview-token', { pageId: donate.id }));
  assert.match(url, /^\/site\/__preview\//);
  const preview = await hit(url);
  assert.equal(preview.status, 200, 'the builder frames it on the app’s own address');
  assert.equal((await hit('/site/api/guide/clock')).status, 200);
  assert.equal((await hit('/site/site-assets/fonts/licences')).status, 200);
  assert.equal((await hit('/site-assets/site.css')).status, 200);
  const sent = await send('newsletter', newsletter(`open.${Date.now()}@example.org`));
  assert.equal(sent.status, 200, 'a form from a page opened before');
  assert.notEqual((await hit('/site/sites/another')).status, 301, 'other websites keep their own addresses');
  // Without the setting, /site is the site as before.
  delete process.env.BASE_SITE_DOMAIN;
  assert.equal((await hit('/site/donate')).status, 200);
});

test('a domain where the app answers is never taken: the desk can’t be locked out', async () => {
  for (const bad of ['imaginesurrey.base.win', 'base.win', 'app.example.net']) {
    process.env.BASE_SITE_DOMAIN = bad;
    process.env.BASE_PUBLIC_URL = 'https://app.example.net';
    assert.equal((await hit('/site/donate')).status, 200, `${bad}: /site stays`);
    assert.equal((await hit('/api/health', { host: bad })).status, 200, `${bad}: the app still answers there`);
    assert.ok(bootNotes(process.env).some((n) => n.includes('BASE_SITE_DOMAIN') && n.includes(bad)), `${bad}: said at start-up`);
  }
  process.env.BASE_SITE_DOMAIN = 'not a domain';
  assert.equal((await hit('/site/donate')).status, 200);
  assert.ok(bootNotes(process.env).some((n) => n.includes('BASE_SITE_DOMAIN')));
  process.env.BASE_SITE_DOMAIN = DOMAIN;
  assert.ok(!bootNotes(process.env).some((n) => n.includes('BASE_SITE_DOMAIN')), 'a good one says nothing');
  assert.equal((await siteHost({ req: { url: `http://${DOMAIN}/` } }))?.host, DOMAIN);
});

test('the present website’s old addresses go to the base.win page that does the same thing', async () => {
  const go = async (path) => { const r = await hit(path, { host: DOMAIN, headers: HTTPS }); return [r.status, r.location]; };
  assert.deepEqual(await go('/stats'), [301, '/']);
  assert.deepEqual(await go('/donate/thanks?session_id=cs_test_1'), [301, '/donate?session_id=cs_test_1']);
  assert.deepEqual(await go('/act/skytrain-south-surrey/print'), [301, '/act/skytrain-south-surrey']);
  assert.deepEqual(await go('/tracker/12?ref=abc123'), [301, '/tracker?ref=abc123']);
  assert.deepEqual(await go('/tracker/methodology'), [301, '/tracker']);
  assert.deepEqual(await go('/volunteer/openings/week.ics'), [301, '/volunteer']);
  assert.deepEqual(await go('/events/town-hall'), [301, '/events']);
  assert.deepEqual(await go('/neighbourhoods/newton'), [301, '/']);
  assert.deepEqual(await go('/shop'), [301, '/']);
  // A page base.win has is never sent on.
  assert.equal((await go('/tracker'))[0], 200);
  assert.equal((await go('/donate'))[0], 200);
  // Only to a page that is live: a petition base.win doesn't have is the 404.
  assert.equal((await go('/act/no-such-petition/print'))[0], 404);
  const r = await hit('/act/skytrain-south-surrey/print', { host: DOMAIN, method: 'POST', body: {} });
  assert.equal(r.status, 404, 'a page is sent on only when it is asked for');
  // Only on the domain: on the app's own address (no domain set) these are the 404.
  delete process.env.BASE_SITE_DOMAIN;
  assert.equal((await hit('/site/stats')).status, 404);
});

test('the old addresses are the campaign’s own: another campaign’s server has none', async () => {
  process.env.BASE_BRAND = 'base';
  const r = await hit('/stats', { host: DOMAIN });
  assert.equal(r.status, 404);
  assert.equal((await hit('/act/skytrain-south-surrey/print', { host: DOMAIN })).status, 404);
});

test('the present website’s own links (in emails it sent) go to it at its own address, when that is set', async () => {
  const at = (path, opts = {}) => hit(path, { host: DOMAIN, ...opts });
  assert.equal((await at('/newsletter/unsubscribe?token=abc')).status, 404, 'unset: the 404');
  process.env.BASE_SITE_FORMER_URL = 'https://former-site.example.net/';
  let r = await at('/newsletter/unsubscribe?token=abc');
  assert.deepEqual([r.status, r.location], [302, 'https://former-site.example.net/newsletter/unsubscribe?token=abc']);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  r = await at('/api/newsletter/unsubscribe?token=abc', { method: 'POST', form: { 'List-Unsubscribe': 'One-Click' } });
  assert.deepEqual([r.status, r.location], [307, 'https://former-site.example.net/api/newsletter/unsubscribe?token=abc'], 'a one-click unsubscribe keeps its POST');
  assert.equal((await at('/me/verify?token=x')).location, 'https://former-site.example.net/me/verify?token=x');
  assert.equal((await at('/admin')).location, 'https://former-site.example.net/admin');
  // A link with words of another alphabet goes on as it came, still encoded.
  r = await at('/me/%E0%A8%B8?x=1');
  assert.deepEqual([r.status, r.location], [302, 'https://former-site.example.net/me/%E0%A8%B8?x=1']);
  assert.equal((await at('/me/caf%C3%A9')).location, 'https://former-site.example.net/me/caf%C3%A9');
  // Never the domain itself, the app's address, or a plain http one.
  for (const bad of [`https://${DOMAIN}`, `https://${WWW}`, 'https://imaginesurrey.base.win', 'http://former-site.example.net']) {
    process.env.BASE_SITE_FORMER_URL = bad;
    assert.equal((await at('/newsletter/unsubscribe?token=abc')).status, 404, bad);
  }
});

test('links base.win hands out name the domain', async () => {
  assert.equal(mainAddress({ domains: ['other.example.org'] }), `https://${DOMAIN}`);
  assert.equal(baseOf({ req: { url: 'http://localhost/api/share', header: () => '' }, env: {} }, []), `https://${DOMAIN}`);
  const site = ok(await mgr.get('/api/site'));
  assert.equal(site.urls.domain, `https://${DOMAIN}/`);
  assert.ok(site.urls.hosts.includes(`https://${DOMAIN}/`));
  delete process.env.BASE_SITE_DOMAIN;
  assert.equal(ok(await mgr.get('/api/site')).urls.domain, null);
});

test('the unsubscribe sync: its two settings come off once the website is base.win’s own', async () => {
  process.env.BASE_PUBLIC_URL = 'https://imaginesurrey.base.win';
  process.env.BASE_WEBSITE_KEY = 'x'.repeat(40);
  for (const url of [`https://${DOMAIN}`, `https://${WWW}/`]) {
    process.env.BASE_WEBSITE_URL = url;
    const s = websiteState();
    assert.equal(s.on, false, url);
    assert.equal(s.problem, 'moved');
    assert.match(whyOff(s), /^BASE_WEBSITE_URL is this campaign’s own website, now on base\.win \(.+\)\. Take both settings away\. Nothing is sent\.$/);
    assert.deepEqual(await checkWebsite(), { ok: false, said: whyOff(s) });
    assert.ok(bootNotes(process.env).some((n) => n.includes('BASE_WEBSITE_URL') && n.includes('Take both settings away')));
  }
  // A SITE_HOSTS host is the website's own too.
  delete process.env.BASE_SITE_DOMAIN;
  process.env.SITE_HOSTS = 'own-site.example.org';
  process.env.BASE_WEBSITE_URL = 'https://own-site.example.org';
  assert.equal(websiteState().problem, 'moved');
  // A website hosted apart is still sent to.
  process.env.BASE_WEBSITE_URL = 'https://hosted-apart.example.org';
  assert.equal(websiteState().on, true);
  assert.ok(!bootNotes(process.env).some((n) => n.includes('BASE_WEBSITE_URL')));
});
