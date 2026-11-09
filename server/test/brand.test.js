// The look a deployment wears (lib/brand.js): Imagine Surrey's own in
// production, Base's generic one on staging and for any other campaign.
// Unset, production keeps today's look; the app's page and manifest leave
// marked with the brand (before any paint) and its icons and colours;
// training is "ImagineU" or "Training" on every screen that names it; an
// email's links take the brand's colour; a manager renames the campaign in
// one step (Settings → Campaign) and nobody else can.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { freshDb, Client } from './helpers.js';
import { brandKey, brandHtml, brandManifest, brandPages, learnName } from '../lib/brand.js';
import { emailBody } from '../ext/abtests/send.js';
import { BRANDS } from '@starbase/shared/brand';

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

test('the app’s page: marked on <html>, the brand’s icons and the browser’s colours', () => {
  const base = brandHtml(INDEX, BRANDS.base);
  assert.match(base, /<html lang="en" data-brand="base">/);
  assert.match(base, /<link rel="icon" href="\/base-mark.svg" type="image\/svg\+xml" \/>/);
  assert.match(base, /<link rel="apple-touch-icon" href="\/base-touch-icon.png" \/>/);
  assert.match(base, /<meta name="theme-color" content="#1e293b" media="\(prefers-color-scheme: light\)" \/>/);
  assert.match(base, /<meta name="theme-color" content="#0f172a" media="\(prefers-color-scheme: dark\)" \/>/);
  assert.doesNotMatch(base, /star\.png|#003979|#00224d/, 'nothing of Imagine Surrey’s left');
  const is = brandHtml(INDEX, BRANDS['imagine-surrey']);
  assert.match(is, /<html lang="en" data-brand="imagine-surrey">/);
  assert.equal(is.replace(' data-brand="imagine-surrey"', ''), INDEX, 'Imagine Surrey’s page is the page as built, marked');
  assert.match(brandHtml(is, BRANDS.base), /<html lang="en" data-brand="base">/, 'marked once, never twice');
  assert.equal((brandHtml(is, BRANDS.base).match(/data-brand=/g) || []).length, 1);
  const m = brandManifest(MANIFEST, BRANDS.base);
  assert.deepEqual([m.name, m.theme_color, m.background_color, m.start_url], ['Base', '#1e293b', '#1e293b', MANIFEST.start_url]);
  assert.ok(m.icons.every((i) => i.src.startsWith('/base-')) && m.icons.some((i) => i.purpose === 'maskable'));
  assert.deepEqual(brandManifest(MANIFEST, BRANDS['imagine-surrey']), MANIFEST, 'Imagine Surrey’s manifest as it is');
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
  assert.equal((await man.json()).theme_color, '#1e293b');
  assert.deepEqual(await (await app.request('/api/x')).json(), { html: '<html lang="en">' });
  assert.doesNotMatch(await (await app.request('/u/x')).text(), /data-brand/, 'only the app’s own page');
  setEnv({ STARBASE_BRAND: 'imagine-surrey' });
  assert.match(await (await app.request('/')).text(), /data-brand="imagine-surrey"/);
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

test('an email’s links take the brand’s colour', () => {
  setEnv({ STARBASE_BRAND: 'base' });
  assert.match(emailBody('See [the plan](https://example.org/plan)'), /style="color:#4338ca"/);
  setEnv({ STARBASE_BRAND: 'imagine-surrey' });
  assert.match(emailBody('See https://example.org/plan'), /style="color:#003979"/);
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
