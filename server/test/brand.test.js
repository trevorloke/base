// The brand a campaign wears (lib/brand.js). Before a manager saves one
// (Settings → Brand, ext/brand), it is the preset STARBASE_BRAND names —
// Imagine Surrey's own in production, base.win's on staging and for any
// other campaign, worked out as it always was when unset — and its page is
// exactly what it was. Once saved, the saved brand is the look whatever
// STARBASE_BRAND says: its shades go into the app's page before the
// stylesheets (signed out too: sign-in wears it), with its data for script,
// its pictures asked for early, its icons, the browser's bar colours, the
// tab's title and the name under the home-screen icon — and the manifest
// says the same. Nothing a saved brand holds can put markup, script or CSS
// into a page. It is kept for a minute and dropped on save. Under a
// client's path the addresses are the client's and the shades need none.
// Training is called what the campaign calls it; an email's links take the
// brand's colour as words, with the logo over them when a manager asks.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { freshDb, Client } from './helpers.js';
import { brandKey, brandFor, brandHtml, brandManifest, brandPages, campaignBrand, forgetBrand, learnName } from '../lib/brand.js';
import { emailBody, blastHtml } from '../ext/abtests/send.js';
import { BRANDS } from '@starbase/shared/brand';
import { lookCss } from '@starbase/shared/brand-look';
import { contrast } from '@starbase/shared/site/theme';
import { rewriters } from '../lib/mount.js';
import { png, webp, dataUrl } from './brand-images.js';

const ENV = ['STARBASE_BRAND', 'STARBASE_ENV', 'STARBASE_ORG_NAME'];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const setEnv = (v) => { for (const k of ENV) { if (v[k] === undefined) delete process.env[k]; else process.env[k] = v[k]; } };
after(() => setEnv(saved));

const INDEX = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
const MANIFEST = JSON.parse(readFileSync(new URL('../../web/public/manifest.webmanifest', import.meta.url), 'utf8'));
const blockOf = (html) => /<style id="brand">([^<]*)<\/style>/.exec(html)?.[1] ?? null;
const dataOf = (html) => { const m = /<script id="brand-data">window\.__BRAND__=([^<]*)<\/script>/.exec(html); return m ? JSON.parse(m[1]) : null; };

// A brand as a manager saves it (ext/brand stores it so).
const ID = (n) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const SAVED = {
  v: 1, color: '#fff100', second: '#d81b1e', sidebar: 'brand', corners: 'round', heading: 'montserrat',
  learn: 'Volunteer school', shortName: 'Riverside', emailHeader: true,
  logo: { id: ID(1), type: 'png', w: 640, h: 128 }, logoDark: { id: ID(2), type: 'webp', w: 640, h: 128 }, mark: { id: ID(3), type: 'png', w: 512, h: 512 },
  icons: { i192: ID(4), i512: ID(5), maskable: ID(6), touch: ID(7) },
};

test('unset, the look is worked out: production keeps Imagine Surrey’s; staging and other campaigns get Base’s', () => {
  setEnv({ STARBASE_ENV: 'production', STARBASE_ORG_NAME: 'Imagine Surrey' });
  assert.equal(brandKey(), 'imagine-surrey', 'production as it is on Render today');
  setEnv({ STARBASE_ENV: 'production', STARBASE_ORG_NAME: '  imagine   SURREY ' });
  assert.equal(brandKey(), 'imagine-surrey', 'any spacing or case');
  setEnv({ STARBASE_ENV: 'production' });
  assert.equal(brandKey(), 'imagine-surrey', 'no name at all: as before');
  setEnv({});
  assert.equal(brandKey(), 'imagine-surrey', 'local and tests: as before');
  setEnv({ STARBASE_ENV: 'staging', STARBASE_ORG_NAME: 'Imagine Surrey' });
  assert.equal(brandKey(), 'base', 'staging is generic even before its new settings arrive');
  setEnv({ STARBASE_ENV: 'production', STARBASE_ORG_NAME: 'Another Campaign' });
  assert.equal(brandKey(), 'base', 'another client');
  setEnv({ STARBASE_BRAND: 'base', STARBASE_ENV: 'production', STARBASE_ORG_NAME: 'Imagine Surrey' });
  assert.equal(brandKey(), 'base', 'set, it is what it says');
  setEnv({ STARBASE_BRAND: 'Imagine-Surrey', STARBASE_ENV: 'staging' });
  assert.equal(brandKey(), 'imagine-surrey');
  setEnv({ STARBASE_BRAND: 'purple', STARBASE_ENV: 'staging' });
  assert.equal(brandKey(), 'base', 'a bad value is worked out as unset');
});

test('unset: the preset’s page, as before — base.win’s is the page as built; Imagine Surrey’s carries its shades and wordmark', () => {
  // Settings with no brand: the preset, whatever else they hold.
  assert.equal(brandFor({ permissions: {} }, 'base'), brandFor(undefined, 'base'));
  const base = brandHtml(INDEX, brandFor({}, 'base'));
  assert.equal(base.replace(' data-brand="base"', ''), INDEX, 'base.win’s page is the page as built, marked');
  assert.doesNotMatch(base, /<style id="brand">|<script id="brand-data">|star\.png|#003979|imagine/i, 'nothing injected, nothing of Imagine Surrey’s');
  const is = brandHtml(INDEX, brandFor({}, 'imagine-surrey'));
  assert.match(is, /<html lang="en" data-brand="imagine-surrey">/);
  assert.match(blockOf(is), /--accent:#003979;[^]*--second:#ffc72c;[^]*@media \(prefers-color-scheme:dark\)/);
  assert.ok(is.indexOf('<style id="brand">') < is.indexOf('<link rel="stylesheet"'), 'before the first stylesheet');
  assert.equal(dataOf(is), null, 'a preset is known to the app by its mark alone');
  assert.match(is, /<link rel="icon" href="\/star.png" type="image\/png" \/>/);
  assert.match(is, /<link rel="preload" as="image" href="\/site-assets\/imagine-surrey\/logo\.webp" data-brand media="\(prefers-color-scheme: light\)" \/>/);
  assert.match(is, /<link rel="preload" as="image" href="\/site-assets\/imagine-surrey\/logo-light\.png" data-brand media="\(prefers-color-scheme: dark\)" \/>/);
  assert.match(is, /<meta name="theme-color" content="#ffffff" media="\(prefers-color-scheme: light\)" \/>/);
  assert.match(is, /<title>base\.win<\/title>/);
  assert.match(is, /apple-mobile-web-app-title" content="base\.win"/);
  // Branded once, never twice — and back to base.win's leaves nothing behind.
  assert.equal(brandHtml(is, brandFor({}, 'imagine-surrey')), is);
  assert.equal(brandHtml(is, brandFor({}, 'base')), base);
  // A navy rail: the bar is the brand and the status-bar text is light.
  const rail = brandHtml(INDEX, { ...BRANDS['imagine-surrey'], sidebar: 'brand' });
  assert.match(rail, /<meta name="theme-color" content="#003979" media="\(prefers-color-scheme: light\)" \/>/);
  assert.match(rail, /status-bar-style" content="black"/);
  assert.match(rail, /href="\/site-assets\/imagine-surrey\/logo-light\.png" data-brand \/>/, 'the light logo, whatever the scheme');

  assert.deepEqual(brandManifest(MANIFEST, brandFor({}, 'base')), MANIFEST, 'base.win’s manifest is the one built');
  const im = brandManifest(MANIFEST, brandFor({}, 'imagine-surrey'));
  assert.deepEqual([im.name, im.short_name, im.theme_color, im.background_color, im.start_url, im.icons[0].src], ['base.win', 'base.win', '#ffffff', '#fafafb', MANIFEST.start_url, '/icon-192.png']);
});

test('a saved brand: its shades before the stylesheets, its data for script, its pictures, icons, bar colours and names', () => {
  const b = brandFor({ brand: SAVED }, 'base');
  const page = brandHtml(INDEX, b);
  const block = blockOf(page);
  assert.equal(block, lookCss(SAVED), 'the shades the one rule works out for it');
  assert.match(block, /--accent:#fff100;--accent-ink:#14161a;/, 'the colour as chosen, dark text on it');
  assert.doesNotMatch(block.split('@media')[0], /--accent-words:#fff100/, 'yellow is never words on white (on a dark page it is)');
  assert.ok(page.indexOf('<style id="brand">') < page.indexOf('<link rel="stylesheet"'), 'before the first stylesheet');
  assert.ok(page.indexOf('<script id="brand-data">') < page.indexOf('<script type="module"'), 'before the app’s script');
  assert.deepEqual(dataOf(page), {
    key: 'base', saved: true, color: '#fff100', second: '#d81b1e', sidebar: 'brand', sideDark: false, corners: 'round', heading: 'montserrat',
    learn: 'Volunteer school', shortName: 'Riverside',
    logo: `/brand/${ID(1)}.png`, logoDark: `/brand/${ID(2)}.webp`, logoSize: { w: 640, h: 128 }, mark: `/brand/${ID(3)}.png`,
  }, 'a yellow sidebar is a light ground: the standard logo goes there');
  // A light ground: the standard logo on it in both schemes; the dark one for the sign-in card in dark mode.
  assert.match(page, new RegExp(`<link rel="preload" as="image" href="/brand/${ID(1)}\\.png" data-brand media="\\(prefers-color-scheme: light\\)" />`));
  assert.match(page, new RegExp(`<link rel="preload" as="image" href="/brand/${ID(2)}\\.webp" data-brand media="\\(prefers-color-scheme: dark\\)" />`));
  assert.match(page, new RegExp(`<link rel="icon" href="/brand/${ID(4)}\\.png" type="image/png" />`));
  assert.match(page, new RegExp(`<link rel="apple-touch-icon" href="/brand/${ID(7)}\\.png" />`));
  assert.match(page, /<meta name="theme-color" content="#fff100" media="\(prefers-color-scheme: light\)" \/>/, 'the bar is the brand-coloured sidebar');
  assert.match(page, /<meta name="theme-color" content="#fff100" media="\(prefers-color-scheme: dark\)" \/>/);
  assert.match(page, /status-bar-style" content="default"/, 'dark status-bar text on a yellow bar');
  assert.match(page, /<title>Riverside — base\.win<\/title>/);
  assert.match(page, /apple-mobile-web-app-title" content="Riverside"/);
  assert.equal(brandHtml(page, b), page, 'branded once, never twice');
  assert.equal(brandHtml(page, brandFor({}, 'base')), brandHtml(INDEX, brandFor({}, 'base')), 'back to the preset leaves nothing behind');

  const m = brandManifest(MANIFEST, b);
  assert.deepEqual([m.name, m.short_name, m.theme_color, m.id, m.start_url, m.scope], ['Riverside — base.win', 'Riverside', '#fff100', MANIFEST.id, MANIFEST.start_url, MANIFEST.scope]);
  assert.deepEqual(m.icons, [
    { src: `/brand/${ID(4)}.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: `/brand/${ID(5)}.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: `/brand/${ID(6)}.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ]);
  // A navy sidebar is a dark ground: both logos on screen whatever the scheme.
  const navy = brandHtml(INDEX, brandFor({ brand: { ...SAVED, color: '#003979' } }, 'base'));
  assert.equal(dataOf(navy).sideDark, true);
  assert.match(navy, new RegExp(`href="/brand/${ID(2)}\\.webp" data-brand />`));
  assert.match(navy, /status-bar-style" content="black"/);
  // No mark: base.win's own icons; base.win under the icon unless named.
  const plain = brandFor({ brand: { v: 1, color: '#0f766e' } }, 'imagine-surrey');
  assert.deepEqual([plain.icon.href, plain.title, plain.shortName, plain.learn, plain.logo], ['/base-mark.svg', 'base.win', 'base.win', 'ImagineU', null]);
  assert.deepEqual(brandManifest(MANIFEST, plain).icons, MANIFEST.icons);
  assert.equal(dataOf(brandHtml(INDEX, plain)).logo, null, 'no logo: the campaign’s initials stand in');
});

test('nothing a saved brand holds can put markup, script or CSS into the page', () => {
  const hostile = {
    v: 1, color: '#fff100;}</style><script>alert(1)</script>', second: 'red', sidebar: '"><script>', corners: '}*{color:red', heading: '</style>',
    learn: '</script><script>alert(1)</script>', shortName: '"><img src=x onerror=alert(1)>\u2028',
    logo: { id: '../../etc/passwd', type: 'png' }, logoDark: { id: ID(2), type: 'svg' }, mark: { id: ID(3), type: 'png" onerror="x' },
    icons: { i192: 'javascript:alert(1)', i512: ID(5), maskable: ID(6), touch: ID(7) },
  };
  const page = brandHtml(INDEX, brandFor({ brand: hostile }, 'imagine-surrey'));
  const head = page.slice(0, page.indexOf('</head>'));
  assert.equal((head.match(/<script\b/g) || []).length, 1, 'one script element: the brand’s data');
  assert.doesNotMatch(page, /alert\(1\)<\/script>|<img src=x|javascript:|etc\/passwd|onerror="x|\u2028/);
  assert.doesNotMatch(blockOf(page), /[<>"]|url\(|\}\s*\*|color:red/, 'colours, sizes and a font from the list only');
  assert.match(blockOf(page), /--accent:#003979;/, 'a colour that isn’t one is the preset’s');
  const data = dataOf(page);
  assert.equal(data.learn, '</script><script>alert(1)</script>', 'the words, as words, inside the data');
  assert.match(page, /\\u003c\/script\\u003e\\u003cscript\\u003e/, 'escaped where the page reads them');
  assert.deepEqual([data.sidebar, data.corners, data.heading, data.logo, data.logoDark, data.mark, data.second], ['light', 'soft', 'inter', null, null, null, null]);
  assert.match(page, /<title>&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt; — base\.win<\/title>/);
  assert.match(page, /<link rel="icon" href="\/base-mark\.svg"/, 'icons that aren’t ids: base.win’s own');
});

test('under a client’s path: the icons and the logo are the client’s; the shades and the script’s data need no address', () => {
  const b = brandFor({ brand: SAVED }, 'base');
  const page = rewriters('/riverside').html(brandHtml(INDEX, b));
  assert.match(page, new RegExp(`<link rel="icon" href="/riverside/brand/${ID(4)}\\.png"`));
  assert.match(page, new RegExp(`<link rel="apple-touch-icon" href="/riverside/brand/${ID(7)}\\.png"`));
  assert.match(page, new RegExp(`<link rel="preload" as="image" href="/riverside/brand/${ID(1)}\\.png"`));
  assert.equal(blockOf(page), blockOf(brandHtml(INDEX, b)), 'the block is the same under any path');
  assert.equal(dataOf(page).logo, `/brand/${ID(1)}.png`, 'the app puts its path in front (base.js at)');
  assert.match(page, /<head><script>window\.__BASE__="\/riverside"<\/script>/);
  const m = rewriters('/riverside').manifest(brandManifest(MANIFEST, b));
  assert.ok(m.icons.every((i) => i.src.startsWith('/riverside/brand/')), JSON.stringify(m.icons));
});

let db, mgr, vol;
before(async () => {
  db = await freshDb();
  mgr = new Client();
  await mgr.signup({ workspaceName: 'Riverside Forward', jurisdiction: 'bc-municipal' });
  const inv = await mgr.action('member.invite', { email: 'brand.vol@example.org', role: 'volunteer' });
  vol = new Client();
  await vol.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: 'Vol Example', password: 'vol-pass-123' });
});

// The static files' side of server/index.js: the page and the manifest as
// they come off disk (with their length), through brandPages — no sign-in.
const pages = () => {
  const app = new Hono();
  app.use('*', brandPages);
  const sized = (body, type) => (c) => c.body(body, 200, { 'content-type': type, 'content-length': String(Buffer.byteLength(body)) });
  app.get('/', sized(INDEX, 'text/html; charset=utf-8'));
  app.get('/manifest.webmanifest', sized(JSON.stringify(MANIFEST, null, 2), 'application/manifest+json'));
  app.get('/api/x', (c) => c.json({ html: '<html lang="en">' }));
  app.get('/u/x', (c) => c.html('<!doctype html><html lang="en"><body>An unsubscribe page</body></html>'));
  return app;
};
const uploaded = async (kind, buf, type) => { const r = await mgr.action('brand.picture', { kind, data: dataUrl(buf, type) }); assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json.picture.id; };

test('on the way out, signed out: the preset until a manager saves; the saved brand at once after, whatever STARBASE_BRAND says', async () => {
  setEnv({ STARBASE_BRAND: 'base' });
  forgetBrand();
  const app = pages();
  const first = await app.request('/');
  const html = await first.text();
  assert.equal(html.replace(' data-brand="base"', ''), INDEX, 'nothing saved: the page as built');
  assert.equal(first.headers.get('content-length'), null, 'not the file’s length any more');
  assert.deepEqual(await (await app.request('/manifest.webmanifest')).json(), MANIFEST);

  const logo = await uploaded('logo', png(640, 128));
  const r = await mgr.action('brand.save', { color: '#d81b1e', sidebar: 'dark', short_name: 'Riverside', logo: { id: logo } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const page = await (await app.request('/')).text();
  assert.match(blockOf(page), /--accent:#d81b1e;/, 'the new brand at once: the server’s copy was dropped on save');
  assert.equal(dataOf(page).logo, `/brand/${logo}.png`);
  assert.match(page, /<\/html>\s*$/, 'the whole page, longer than the file');
  const man = await (await app.request('/manifest.webmanifest')).json();
  assert.deepEqual([man.short_name, man.theme_color], ['Riverside', '#0b0b0d'], 'a dark sidebar: the bar is its ground');
  assert.equal((await campaignBrand()).saved, true);

  // STARBASE_BRAND only chooses where a campaign starts.
  setEnv({ STARBASE_BRAND: 'imagine-surrey' });
  forgetBrand();
  assert.match(blockOf(await (await app.request('/')).text()), /--accent:#d81b1e;/);

  // Kept for a minute: a change that didn't come through Settings → Brand
  // shows once the copy is dropped.
  await db.query(`update workspaces set settings = jsonb_set(settings, '{brand,color}', '"#0f766e"') where id = (select id from workspaces order by created_at, id limit 1)`);
  assert.match(blockOf(await (await app.request('/')).text()), /--accent:#d81b1e;/, 'the copy kept');
  forgetBrand();
  assert.match(blockOf(await (await app.request('/')).text()), /--accent:#0f766e;/);

  // Back to the look it started in.
  assert.equal((await mgr.action('brand.reset', {})).json.reset, true);
  const back = await (await app.request('/')).text();
  assert.match(back, /data-brand="imagine-surrey"/);
  assert.match(blockOf(back), /--accent:#003979;/);
  assert.equal(dataOf(back), null);

  // Only the app's own page and the manifest are touched.
  assert.deepEqual(await (await app.request('/api/x')).json(), { html: '<html lang="en">' });
  assert.doesNotMatch(await (await app.request('/u/x')).text(), /data-brand|brand-data/, 'only the app’s own page');
});

test('training is called what the campaign calls it: Permissions, the public lessons', async () => {
  setEnv({ STARBASE_BRAND: 'base' });
  assert.equal(learnName({}), 'Training');
  const label = async () => (await mgr.get('/api/admin/permissions')).json.areas.find((a) => a.key === 'learn').label;
  assert.equal(await label(), 'Training');
  setEnv({ STARBASE_BRAND: 'imagine-surrey' });
  assert.equal(await label(), 'ImagineU', 'unsaved: the preset’s');
  assert.equal((await mgr.action('brand.save', { color: '#003979', learn: 'Volunteer school' })).status, 200);
  setEnv({ STARBASE_BRAND: 'base' });
  assert.equal(await label(), 'Volunteer school', 'saved: the campaign’s, whatever the preset');
  const slug = (await mgr.get('/api/auth/me')).json.workspace.slug;
  const html = await (await (await import('../index.js')).app.request(`/learn/${slug}`)).text();
  assert.match(html, /<h1>Volunteer school<\/h1>/);
  assert.doesNotMatch(html, /ImagineU|>Training</);
});

test('an email’s links take the brand’s colour, as words that read; the logo heads it only when asked, as a picture mail apps draw', async () => {
  setEnv({ STARBASE_BRAND: 'base' });
  assert.match(emailBody('See [the plan](https://example.org/plan)'), /style="color:#4f46e5"/, 'unsaved: the preset’s');
  setEnv({ STARBASE_BRAND: 'imagine-surrey' });
  assert.match(emailBody('See https://example.org/plan'), /style="color:#003979"/);
  const ctx = (brand) => ({ publicUrl: 'https://riverside.example', workspace: { name: 'Riverside & Co', settings: { brand } } });
  const linkIn = (html) => /<a href="[^"]*" style="color:(#[0-9a-f]{6})"/.exec(html)[1];
  for (const color of ['#f9a8d4', '#fff100', '#003979', '#d81b1e']) {
    const html = blastHtml(ctx({ v: 1, color }), 'newsletter', 'See https://example.org/plan', 'https://riverside.example/u/x', null, []);
    const link = linkIn(html);
    for (const ground of ['#ffffff', '#f4f5fa']) assert.ok(contrast(link, ground) >= 4.5, `${color} → ${link} on ${ground}: ${contrast(link, ground).toFixed(2)}`);
    assert.doesNotMatch(html, /<img src="https:\/\/riverside\.example\/media/, 'no header unless asked');
  }
  const logo = { id: ID(1), type: 'png', w: 640, h: 128 };
  const head = blastHtml(ctx({ v: 1, color: '#d81b1e', emailHeader: true, logo }), 'newsletter', 'Hello', null, null, []);
  assert.match(head, new RegExp(`<img src="https://riverside\\.example/media/${ID(1)}\\.png" alt="Riverside &amp; Co" width="200" height="40"`), 'its name as its words; its size in the tag');
  assert.match(head, /border-bottom:3px solid #d81b1e/, 'over a rule in the brand’s colour');
  assert.ok(head.indexOf(`/media/${ID(1)}`) < head.indexOf('Hello'), 'above the message');
  const wide = blastHtml(ctx({ v: 1, color: '#d81b1e', emailHeader: true, logo: { ...logo, w: 1024, h: 64 } }), 'newsletter', 'Hello', null, null, []);
  assert.match(wide, /width="560" height="35"/, 'never wider than the letter');
  const webpLogo = blastHtml(ctx({ v: 1, color: '#d81b1e', emailHeader: true, logo: { ...logo, type: 'webp' } }), 'newsletter', 'Hello', null, null, []);
  assert.doesNotMatch(webpLogo, /\/media\//, 'a WebP logo: many mail apps would show nothing, so no header');
});

test('a saved logo is served to anyone at its /brand and /media addresses (sign-in shows it before anyone signs in)', async () => {
  const id = await uploaded('logoDark', webp(640, 128), 'image/webp');
  const { app } = await import('../index.js');
  for (const path of [`/brand/${id}.webp`, `/media/${id}.webp`, `/brand/${id}`]) {
    const res = await app.request(path);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get('content-type'), 'image/webp', path);
  }
});

test('the app’s public pages wear the campaign’s brand: unsubscribe, a receipt, a ladder’s unsubscribe, public lessons', async () => {
  setEnv({ STARBASE_BRAND: 'base' });
  const logo = await uploaded('logo', png(640, 128));
  const dark = await uploaded('logoDark', webp(640, 128), 'image/webp');
  const saved = await mgr.action('brand.save', { color: '#d81b1e', heading: 'barlow-condensed', corners: 'square', logo: { id: logo }, logo_dark: { id: dark } });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  const { app } = await import('../index.js');
  const get = async (path) => { const r = await app.request(path); return { status: r.status, html: await r.text() }; };
  const ws = (await mgr.get('/api/auth/me')).json.workspace;
  const subId = randomUUID();
  await db.query("insert into subscriptions (id, workspace_id, email) values ($1, $2, 'reader@example.org')", [subId, ws.id]);
  const person = await mgr.createPerson('Dana Example', { email: 'dana@example.org', address: '12 Example St' });
  const gift = await mgr.action('gift.log', { person_id: person.id, amount_cents: 5000, date: '2026-10-01' });
  assert.equal(gift.status, 200, JSON.stringify(gift.json));
  const receipt = (await mgr.get(`/api/receipts/gift/${gift.json.gift.id}`)).json.receipt;
  const token = (await db.query('select token from receipts where id = $1', [receipt.id])).rows[0].token;
  const ladder = randomUUID();
  const run = randomUUID();
  await db.query("insert into ladders (id, workspace_id, name, trigger_kind) values ($1, $2, 'Welcome', 'manual')", [ladder, ws.id]);
  await db.query('insert into ladder_runs (id, workspace_id, ladder_id, person_id) values ($1, $2, $3, $4)', [run, ws.id, ladder, person.id]);
  const wears = (what, html) => {
    assert.match(html, /--mark:#d81b1e;--mark-ink:#ffffff;/, `${what}: the brand colour fills the button`);
    assert.match(html, /--r-ctrl:6px;[^]*--heading:'Barlow Condensed'/, `${what}: its corners and heading face`);
    assert.match(html, /<link rel="stylesheet" href="\/fonts\/fonts\.css">/, `${what}: the app’s faces`);
    assert.doesNotMatch(html, /Georgia|#f2c40f|#6d4aff|#7d5fff|text-transform:uppercase|ui-monospace/, `${what}: none of the old palettes`);
  };
  for (const [what, path] of [['unsubscribe', `/u/${subId}`], ['receipt', `/r/${token}`], ['ladder unsubscribe', `/lu/${run}`], ['lessons', `/learn/${ws.slug}`]]) {
    const { status, html } = await get(path);
    assert.equal(status, 200, `${what}: ${html.slice(0, 200)}`);
    wears(what, html);
    assert.match(html, new RegExp(`<div class="camp"><span class="camp-logo"><picture><source srcset="/media/${dark}\\.webp" media="\\(prefers-color-scheme: dark\\)"><img src="/media/${logo}\\.png" alt=""></picture></span><p class="camp-name">Riverside Forward</p></div>`), `${what}: the logo over the campaign’s name`);
  }
  // The receipt's facts are as they were.
  const r = (await get(`/r/${token}`)).html;
  for (const words of ['Contribution receipt', receipt.number, 'Dana Example', '$50.00', 'Print']) assert.ok(r.includes(words), words);
  // A link that names no campaign wears the campaign's look too.
  for (const path of [`/u/${randomUUID()}`, `/lu/${randomUUID()}`, `/r/${'0'.repeat(48)}`]) {
    const { status, html } = await get(path);
    assert.equal(status, 404, path);
    wears(path, html);
  }
  // No logo for dark grounds: in dark mode the logo sits on a light chip.
  assert.equal((await mgr.action('brand.save', { color: '#d81b1e', logo: { id: logo } })).status, 200);
  assert.match((await get(`/u/${subId}`)).html, new RegExp(`<span class="camp-logo on-light"><picture><img src="/media/${logo}\\.png" alt=""></picture></span>`));
  // No logo at all: the name alone.
  assert.equal((await mgr.action('brand.reset', {})).status, 200);
  assert.match((await get(`/u/${subId}`)).html, /<div class="camp"><p class="camp-name">Riverside Forward<\/p><\/div>/);
});

test('Settings → Campaign: a manager renames the campaign in one step; nobody else can', async () => {
  const r = await mgr.action('workspace.update', { name: 'Demo Campaign' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal((await mgr.get('/api/auth/me')).json.workspace.name, 'Demo Campaign');
  assert.equal((await vol.get('/api/auth/me')).json.workspace.name, 'Demo Campaign', 'everyone sees the new name');
  const ev = (await db.query(`select payload from events where entity_type = 'workspace' and op = 'update' and action = 'workspace.update' order by seq desc limit 1`)).rows[0];
  const payload = typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload;
  assert.equal(payload.name, 'Demo Campaign', 'the rename is in the record');
  assert.equal((await vol.action('workspace.update', { name: 'Taken Over' })).status, 403);
  assert.equal((await mgr.action('workspace.update', { name: '   ' })).status, 400, 'a name, not blanks');
  assert.equal((await mgr.get('/api/audit/verify')).json.ok, true);
});
