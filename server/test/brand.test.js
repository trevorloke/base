// The brand a deployment wears (lib/brand.js): Imagine Surrey's own in
// production, base.win's on staging and for any other campaign — two presets
// through one rule. Unset, it is worked out as it always was; the app's page
// leaves marked with the brand, its shades written in before the stylesheets
// (none for base.win's own: app.css holds those), its logo asked for early,
// its icons and the browser's bar colours, and so does the manifest; training
// is "ImagineU" or "Training" on every screen that names it; an email's links
// take the brand's colour; a manager renames the campaign in one step
// (Settings → Campaign) and nobody else can.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { freshDb, Client } from './helpers.js';
import { brandKey, brandHtml, brandManifest, brandPages, learnName } from '../lib/brand.js';
import { emailBody } from '../ext/abtests/send.js';
import { BRANDS } from '@starbase/shared/brand';
import { contrast } from '@starbase/shared/site/theme';
import { rewriters } from '../lib/mount.js';

const ENV = ['STARBASE_BRAND', 'STARBASE_ENV', 'STARBASE_ORG_NAME'];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const setEnv = (v) => { for (const k of ENV) { if (v[k] === undefined) delete process.env[k]; else process.env[k] = v[k]; } };
after(() => setEnv(saved));

const INDEX = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
const MANIFEST = JSON.parse(readFileSync(new URL('../../web/public/manifest.webmanifest', import.meta.url), 'utf8'));

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
});

test('set, it is what it says (a bad value is worked out as unset)', () => {
  setEnv({ STARBASE_BRAND: 'base', STARBASE_ENV: 'production', STARBASE_ORG_NAME: 'Imagine Surrey' });
  assert.equal(brandKey(), 'base');
  setEnv({ STARBASE_BRAND: 'Imagine-Surrey', STARBASE_ENV: 'staging' });
  assert.equal(brandKey(), 'imagine-surrey');
  setEnv({ STARBASE_BRAND: 'purple', STARBASE_ENV: 'staging' });
  assert.equal(brandKey(), 'base');
});

test('the app’s page: marked on <html>, the brand’s shades, icons and the browser’s colours', () => {
  // base.win's own: the page as built (app.css holds its shades), marked.
  const base = brandHtml(INDEX, BRANDS.base);
  assert.match(base, /<html lang="en" data-brand="base">/);
  assert.equal(base.replace(' data-brand="base"', ''), INDEX, 'base.win’s page is the page as built, marked');
  assert.doesNotMatch(base, /<style id="brand">|star\.png|#003979|imagine/i, 'no block, and nothing of Imagine Surrey’s');
  assert.match(base, /<link rel="icon" href="\/base-mark.svg" type="image\/svg\+xml" \/>/);
  // Imagine Surrey's: its shades before the stylesheets, its logo asked for early.
  const is = brandHtml(INDEX, BRANDS['imagine-surrey']);
  assert.match(is, /<html lang="en" data-brand="imagine-surrey">/);
  assert.match(is, /<link rel="icon" href="\/star.png" type="image\/png" \/>/);
  assert.match(is, /<link rel="apple-touch-icon" href="\/apple-touch-icon.png" \/>/);
  const block = /<style id="brand">([^<]*)<\/style>/.exec(is);
  assert.ok(block, 'the shades are in the page');
  assert.match(block[1], /--accent:#003979;/, 'Surrey Navy is the accent');
  assert.match(block[1], /--second:#ffc72c;/, 'marigold is the second colour');
  assert.match(block[1], /@media \(prefers-color-scheme:dark\)/, 'dark too');
  assert.doesNotMatch(block[1], /url\(|\/\//, 'no addresses in it');
  assert.ok(is.indexOf('<style id="brand">') < is.indexOf('<link rel="stylesheet"'), 'before the first stylesheet');
  assert.match(is, /<link rel="preload" as="image" href="\/site-assets\/imagine-surrey\/logo\.webp" data-brand media="\(prefers-color-scheme: light\)" \/>/);
  assert.match(is, /<link rel="preload" as="image" href="\/site-assets\/imagine-surrey\/logo-light\.png" data-brand media="\(prefers-color-scheme: dark\)" \/>/);
  // A light sidebar: the browser's bar is the phone's top bar, not a slab of navy.
  assert.match(is, /<meta name="theme-color" content="#ffffff" media="\(prefers-color-scheme: light\)" \/>/);
  assert.match(is, /<meta name="theme-color" content="#17181c" media="\(prefers-color-scheme: dark\)" \/>/);
  assert.match(is, /apple-mobile-web-app-status-bar-style" content="default"/);
  // Branded once, never twice — and back to base.win's leaves nothing behind.
  assert.equal(brandHtml(is, BRANDS['imagine-surrey']), is);
  assert.equal(brandHtml(is, BRANDS.base), base);
  assert.equal((brandHtml(is, BRANDS.base).match(/data-brand=/g) || []).length, 1);
  // A brand-coloured sidebar: the bar is the brand, and the status bar text is light.
  const rail = brandHtml(INDEX, { ...BRANDS['imagine-surrey'], sidebar: 'brand' });
  assert.match(rail, /<meta name="theme-color" content="#003979" media="\(prefers-color-scheme: light\)" \/>/);
  assert.match(rail, /status-bar-style" content="black"/);
  assert.match(rail, /href="\/site-assets\/imagine-surrey\/logo-light\.png" data-brand \/>/, 'the light logo, whatever the scheme');

  const m = brandManifest(MANIFEST, BRANDS.base);
  assert.deepEqual(m, MANIFEST, 'base.win’s manifest is the one built');
  assert.deepEqual([m.name, m.theme_color, m.background_color], ['base.win', '#ffffff', '#fafafb']);
  assert.ok(m.icons.every((i) => i.src.startsWith('/base-')) && m.icons.some((i) => i.purpose === 'maskable'));
  const im = brandManifest(MANIFEST, BRANDS['imagine-surrey']);
  assert.deepEqual([im.name, im.theme_color, im.background_color, im.start_url, im.icons[0].src], ['base.win', '#ffffff', '#fafafb', MANIFEST.start_url, '/icon-192.png']);
});

test('under a client’s path: the icons and the logo are found there; the shades need no address', () => {
  const page = rewriters('/imaginesurrey').html(brandHtml(INDEX, BRANDS['imagine-surrey']));
  assert.match(page, /<link rel="icon" href="\/imaginesurrey\/star.png"/);
  assert.match(page, /<link rel="preload" as="image" href="\/imaginesurrey\/site-assets\/imagine-surrey\/logo\.webp"/);
  assert.equal(/<style id="brand">([^<]*)<\/style>/.exec(page)[1], /<style id="brand">([^<]*)<\/style>/.exec(brandHtml(INDEX, BRANDS['imagine-surrey']))[1], 'the block is the same under any path');
});

test('on the way out: the page and the manifest are branded; the API and other files pass as they came', async () => {
  setEnv({ STARBASE_BRAND: 'base' });
  const app = new Hono();
  app.use('*', brandPages);
  // As the static files come: with their length, which the branded copy
  // must not keep (a longer page would be cut short, a shorter one hang).
  const sized = (body, type) => (c) => c.body(body, 200, { 'content-type': type, 'content-length': String(Buffer.byteLength(body)) });
  app.get('/', sized(INDEX, 'text/html; charset=utf-8'));
  app.get('/manifest.webmanifest', sized(JSON.stringify(MANIFEST, null, 2), 'application/manifest+json'));
  app.get('/api/x', (c) => c.json({ html: '<html lang="en">' }));
  app.get('/u/x', (c) => c.html('<!doctype html><html lang="en"><body>An unsubscribe page</body></html>'));
  const page = await app.request('/');
  const body = await page.text();
  assert.match(body, /data-brand="base"/);
  assert.match(body, /<\/html>\s*$/, 'the whole page');
  assert.equal(page.headers.get('content-length'), null, 'not the file’s length any more');
  const man = await app.request('/manifest.webmanifest');
  assert.equal(man.headers.get('content-length'), null);
  assert.ok((await man.json()).icons.every((i) => i.src.startsWith('/base-')));
  assert.deepEqual(await (await app.request('/api/x')).json(), { html: '<html lang="en">' });
  assert.doesNotMatch(await (await app.request('/u/x')).text(), /data-brand/, 'only the app’s own page');
  setEnv({ STARBASE_BRAND: 'imagine-surrey' });
  const is = await (await app.request('/')).text();
  assert.match(is, /data-brand="imagine-surrey"/);
  assert.match(is, /<style id="brand">:root\{[^<]*--accent:#003979;/, 'Imagine Surrey’s shades ride in the page');
  assert.match(is, /<\/html>\s*$/, 'the whole page, longer than the file');
  assert.equal((await (await app.request('/manifest.webmanifest')).json()).icons[0].src, '/icon-192.png');
});

let mgr, vol, db;
before(async () => {
  db = await freshDb();
  mgr = new Client();
  await mgr.signup({ workspaceName: 'Imagine Surrey', jurisdiction: 'bc-municipal' });
  const inv = await mgr.action('member.invite', { email: 'brand.vol@example.org', role: 'volunteer' });
  vol = new Client();
  await vol.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: 'Vol Example', password: 'vol-pass-123' });
});

test('training is called what the deployment calls it: Permissions, the public pages', async () => {
  setEnv({ STARBASE_BRAND: 'base' });
  assert.equal(learnName(), 'Training');
  const perms = (await mgr.get('/api/admin/permissions')).json;
  assert.equal(perms.areas.find((a) => a.key === 'learn').label, 'Training');
  const slug = (await mgr.get('/api/auth/me')).json.workspace.slug;
  const list = await (await import('../index.js')).app.request(`/learn/${slug}`);
  const html = await list.text();
  assert.match(html, /<h1>Training<\/h1>/);
  assert.doesNotMatch(html, /ImagineU/);
  setEnv({ STARBASE_BRAND: 'imagine-surrey' });
  assert.equal((await mgr.get('/api/admin/permissions')).json.areas.find((a) => a.key === 'learn').label, 'ImagineU');
});

test('an email’s links take the brand’s colour, as words that read', () => {
  setEnv({ STARBASE_BRAND: 'base' });
  assert.match(emailBody('See [the plan](https://example.org/plan)'), /style="color:#4f46e5"/);
  setEnv({ STARBASE_BRAND: 'imagine-surrey' });
  assert.match(emailBody('See https://example.org/plan'), /style="color:#003979"/);
  // The colour is the brand as words (4.5:1 on white and on the mail's pale ground).
  for (const key of Object.keys(BRANDS)) {
    setEnv({ STARBASE_BRAND: key });
    const colour = /style="color:(#[0-9a-f]{6})"/.exec(emailBody('See https://example.org/plan'))[1];
    for (const ground of ['#ffffff', '#f4f5fa']) assert.ok(contrast(colour, ground) >= 4.5, `${key} ${colour} on ${ground}`);
  }
});

test('Settings → Campaign: a manager renames the campaign in one step; nobody else can', async () => {
  const r = await mgr.action('workspace.update', { name: 'Demo Campaign' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal((await mgr.get('/api/auth/me')).json.workspace.name, 'Demo Campaign');
  assert.equal((await vol.get('/api/auth/me')).json.workspace.name, 'Demo Campaign', 'everyone sees the new name');
  const ev = (await db.query(`select payload from events where entity_type = 'workspace' and op = 'update' order by seq desc limit 1`)).rows[0];
  const payload = typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload;
  assert.equal(payload.name, 'Demo Campaign', 'the rename is in the record');
  assert.equal((await vol.action('workspace.update', { name: 'Taken Over' })).status, 403);
  assert.equal((await mgr.action('workspace.update', { name: '   ' })).status, 400, 'a name, not blanks');
  assert.equal((await mgr.get('/api/audit/verify')).json.ok, true);
});
