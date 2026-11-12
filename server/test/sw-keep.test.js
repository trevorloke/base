// What the service worker keeps for no signal (web/public/sw.js): the build's
// own files, as always — and now the app's face: the fonts (the stylesheet
// the page names, and the font files it names) and the campaign's own
// pictures (the links the server marks data-brand, server/lib/brand.js), so a
// phone opened in a dead zone still looks like the campaign's app. Fonts and
// pictures keep their names when they change, so they are asked for again
// whenever the page changes; with no answer, the copy already kept stands.
// Under a client's path every address is the client's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { brandHtml, brandFor } from '../lib/brand.js';
import { rewriters } from '../lib/mount.js';
import { BRANDS } from '@starbase/shared/brand';

const SW = readFileSync(new URL('../../web/public/sw.js', import.meta.url), 'utf8');
const FONTS_CSS = readFileSync(new URL('../../web/public/fonts/fonts.css', import.meta.url), 'utf8');
const ORIGIN = 'https://campaign.example';

// The worker's own functions, run against a stand-in for the browser: a
// cache that is a Map, and a network that is a table of answers.
const worker = (base, net) => {
  const stores = new Map();
  const abs = (k) => new URL(typeof k === 'string' ? k : k.url, ORIGIN).href;
  const caches = {
    open: async (name) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const m = stores.get(name);
      return {
        match: async (k) => m.get(abs(k))?.clone(),
        put: async (k, res) => { m.set(abs(k), res); },
        delete: async (k) => m.delete(abs(k)),
        keys: async () => [...m.keys()].map((url) => ({ url })),
      };
    },
    keys: async () => [...stores.keys()],
  };
  const asked = [];
  const fetch = async (path, opts) => {
    asked.push([String(path), opts?.cache || 'default']);
    const body = net.get(String(path));
    if (body === undefined) throw new TypeError('offline');
    if (body === null) return new Response('<!doctype html><div id="root"></div>', { status: 200, headers: { 'content-type': 'text/html' } }); // the app's page, for a file that is not there
    return new Response(body, { status: 200, headers: { 'content-type': /\.css$/.test(path) ? 'text/css' : 'application/octet-stream' } });
  };
  const on = {};
  const self = { registration: { scope: `${ORIGIN}${base}/` }, location: { origin: ORIGIN }, addEventListener(type, fn) { on[type] = fn; }, skipWaiting: async () => {}, clients: { claim: async () => {} } };
  const api = new Function('self', 'caches', 'fetch', `${SW}\nreturn { refsIn, syncAssets, ASSETS };`)(self, caches, fetch);
  const kept = async () => [...(stores.get(api.ASSETS)?.keys() || [])].map((u) => new URL(u).pathname).sort();
  // A request the page makes, through the worker's own fetch handler: its
  // answer, or null when the worker leaves it to the network.
  const answer = async (path) => {
    let res = null;
    on.fetch({ request: new Request(`${ORIGIN}${path}`), respondWith: (r) => { res = r; }, waitUntil() {} });
    return res && (await res).text();
  };
  return { ...api, asked, kept, stores, answer };
};

const page = (base, brand) => {
  const html = brandHtml('<!doctype html><html lang="en"><head><link rel="icon" href="/star.png" type="image/png" /><link rel="stylesheet" href="/fonts/fonts.css" /><script type="module" src="/assets/index-a1.js"></script><link rel="stylesheet" href="/assets/index-b2.css"></head><body><div id="root"></div></body></html>', brand);
  return base ? rewriters(base).html(html) : html;
};

test('the page names its build, the fonts’ stylesheet and the campaign’s logos — and nothing else', () => {
  const w = worker('', new Map());
  assert.deepEqual(w.refsIn(page('', BRANDS['imagine-surrey'])).sort(), [
    '/assets/index-a1.js', '/assets/index-b2.css', '/fonts/fonts.css',
    '/site-assets/imagine-surrey/logo-light.png', '/site-assets/imagine-surrey/logo.webp',
  ], 'the tab’s icon is the browser’s to keep; the logos are the links marked data-brand');
  assert.deepEqual(w.refsIn(page('', BRANDS.base)).sort(), ['/assets/index-a1.js', '/assets/index-b2.css', '/fonts/fonts.css'], 'no logo: none kept');
  const fonts = w.refsIn(FONTS_CSS, true);
  assert.ok(fonts.includes('/fonts/inter-latin.woff2') && fonts.includes('/fonts/inter-latin-ext.woff2'), 'the stylesheet names the font files');
  assert.ok(fonts.every((f) => f.startsWith('/fonts/')), fonts.join(' '));
  assert.deepEqual(w.refsIn('@font-face{src:url("/site-assets/fonts/montserrat-latin.woff2")} .x{background:url(//cdn.example/fonts/a.woff2)}', true), [], 'the website’s fonts, and anyone else’s, are not the app’s');
  assert.deepEqual(w.refsIn('<link rel="preload" as="image" href="//evil.example/x.png" data-brand /><link rel="preload" as="image" href="https://evil.example/y.png" data-brand />'), [], 'only this server’s own pictures');
});

test('under a client’s path every kept address is the client’s', () => {
  const w = worker('/imaginesurrey', new Map());
  assert.deepEqual(w.refsIn(page('/imaginesurrey', BRANDS['imagine-surrey'])).sort(), [
    '/imaginesurrey/assets/index-a1.js', '/imaginesurrey/assets/index-b2.css', '/imaginesurrey/fonts/fonts.css',
    '/imaginesurrey/site-assets/imagine-surrey/logo-light.png', '/imaginesurrey/site-assets/imagine-surrey/logo.webp',
  ]);
  const css = rewriters('/imaginesurrey').css(FONTS_CSS);
  assert.ok(w.refsIn(css, true).includes('/imaginesurrey/fonts/inter-latin.woff2'));
  assert.deepEqual(w.refsIn('<link rel="preload" as="image" href="/othercampaign/brand/x.png" data-brand />'), [], 'never another campaign’s');
});

test('fonts and logos are kept with the build, asked for again when the page changes, and stand when there is no answer', async (t) => {
  const net = new Map([
    ['/assets/index-a1.js', 'import("./Map-c3.js")'], ['/assets/index-b2.css', '.a{}'], ['/assets/Map-c3.js', 'x'],
    ['/fonts/fonts.css', '@font-face{src:url(\'/fonts/inter-latin.woff2\')}'], ['/fonts/inter-latin.woff2', 'FONT-1'],
    ['/site-assets/imagine-surrey/logo.webp', 'LOGO-1'], ['/site-assets/imagine-surrey/logo-light.png', 'LIGHT-1'],
  ]);
  const w = worker('', net);
  const html = page('', BRANDS['imagine-surrey']);
  await w.syncAssets(html);
  assert.deepEqual(await w.kept(), ['/assets/Map-c3.js', '/assets/index-a1.js', '/assets/index-b2.css', '/fonts/fonts.css', '/fonts/inter-latin.woff2',
    '/site-assets/imagine-surrey/logo-light.png', '/site-assets/imagine-surrey/logo.webp'], 'the build, its lazy chunk, the fonts and both logos');
  const text = async (path) => (await (await (await w.stores.get(w.ASSETS)).get(`${ORIGIN}${path}`)).clone().text());

  // A new page (a new build): the build's old files stay one more day (a tab
  // opened before the deploy can still open its screens), then go; the font
  // and the logo, under the same names, are fetched afresh — never served
  // stale for ever.
  net.set('/assets/index-d4.js', 'y'); net.set('/fonts/inter-latin.woff2', 'FONT-2'); net.set('/site-assets/imagine-surrey/logo.webp', 'LOGO-2');
  w.asked.length = 0;
  await w.syncAssets(html.replace('index-a1.js', 'index-d4.js'));
  assert.ok((await w.kept()).includes('/assets/index-d4.js') && (await w.kept()).includes('/assets/index-a1.js') && (await w.kept()).includes('/assets/Map-c3.js'), 'the build before: one more day');
  const realNow = Date.now;
  let ahead = 0;
  const dayLater = () => { ahead += 25 * 3600 * 1000; Date.now = () => realNow() + ahead; };
  t.after(() => { Date.now = realNow; });
  dayLater();
  await w.syncAssets(html.replace('index-a1.js', 'index-d4.js'));
  assert.ok((await w.kept()).includes('/assets/index-d4.js') && !(await w.kept()).includes('/assets/index-a1.js') && !(await w.kept()).includes('/assets/Map-c3.js'), 'a day on: gone');
  assert.equal(await text('/fonts/inter-latin.woff2'), 'FONT-2');
  assert.equal(await text('/site-assets/imagine-surrey/logo.webp'), 'LOGO-2');
  assert.deepEqual(w.asked.filter(([p]) => p === '/assets/index-b2.css'), [], 'a file named by its content is never asked for twice');
  assert.ok(w.asked.some(([p, c]) => p === '/fonts/fonts.css' && c === 'no-cache'), 'a file that keeps its name is checked with the server');

  // The page changes while a logo cannot be reached: the copy kept stands, and nothing else is lost.
  net.delete('/site-assets/imagine-surrey/logo.webp'); net.set('/assets/index-e5.js', 'z');
  await w.syncAssets(html.replace('index-a1.js', 'index-e5.js'));
  assert.equal(await text('/site-assets/imagine-surrey/logo.webp'), 'LOGO-2', 'no answer: the logo already kept is still there');
  dayLater();
  await w.syncAssets(html.replace('index-a1.js', 'index-e5.js'));
  assert.ok((await w.kept()).includes('/assets/index-e5.js') && !(await w.kept()).includes('/assets/index-d4.js'));

  // A campaign that drops its logo: the pictures go a day after the next page.
  await w.syncAssets(page('', BRANDS.base).replace('index-a1.js', 'index-e5.js'));
  dayLater();
  await w.syncAssets(page('', BRANDS.base).replace('index-a1.js', 'index-e5.js'));
  assert.deepEqual((await w.kept()).filter((p) => p.startsWith('/site-assets/')), [], 'no longer named: no longer kept');

  // A font the server answers with the app's page (it is not there) is never stored as a font.
  net.set('/fonts/inter-latin.woff2', null);
  await w.syncAssets(html.replace('index-a1.js', 'index-e5.js'));
  assert.equal(await text('/fonts/inter-latin.woff2'), 'FONT-2', 'the page in a font’s place is not kept; the font already here stands');
});

test('a brand whose headings are Montserrat (the website’s file): the page names it, the worker keeps it and answers it with no signal', async () => {
  const mont = brandFor({ brand: { v: 1, color: '#0f766e', heading: 'montserrat' } }, 'base');
  const FONT = '/site-assets/fonts/montserrat-latin.woff2';
  assert.ok(worker('', new Map()).refsIn(page('', mont)).includes(FONT));
  assert.ok(worker('/imaginesurrey', new Map()).refsIn(page('/imaginesurrey', mont)).includes(`/imaginesurrey${FONT}`), 'under a client’s path, the client’s');
  assert.ok(!worker('', new Map()).refsIn(page('', BRANDS.base)).includes(FONT), 'Inter headings: not fetched');
  const net = new Map([['/assets/index-a1.js', 'x'], ['/assets/index-b2.css', '.a{}'], ['/fonts/fonts.css', ''], [FONT, 'MONT-1']]);
  const w = worker('', net);
  await w.syncAssets(page('', mont));
  assert.ok((await w.kept()).includes(FONT));
  net.clear(); // no signal
  assert.equal(await w.answer(FONT), 'MONT-1', 'from what the worker kept');
});
