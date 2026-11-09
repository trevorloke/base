// The live site's shell as the server draws it from what Website → Settings
// saved — not from hand-written samples: the Menu (Settings → Menu, then
// each published page marked "In the menu"), the title bar's links and its
// button, the footer's logo and the platform link (SITE.md "Settings";
// store.js siteOf hands the renderer exactly the shape it reads). The
// seeded Imagine Surrey site, with its real settings, is the first case.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { renderSite } from '../ext/site/render/index.js';
import { siteOf } from '../ext/site/store.js';
import { SECTION_KEYS, sectionOf } from '../ext/site/shape.js';
import { seedFor } from '../ext/site/seeds/index.js';

const { hit, ok, campaign } = await import('./site-helpers.js');

let mgr;
before(async () => {
  ({ mgr } = await campaign());
  ok(await mgr.get('/api/site')); // the first look makes the brand's site
});

// An island's props from the page.
const islandProps = (html, name) => {
  const id = new RegExp(`data-island="${name}" id="([^"]+)"`).exec(html)?.[1];
  if (!id) return null;
  const json = new RegExp(`<script type="application/json" data-island-props="${id}">([\\s\\S]*?)</script>`).exec(html)?.[1];
  return json ? JSON.parse(json) : null;
};
const menuOf = (html) => islandProps(html, 'menu')?.items || null;
const barOf = (html) => [...html.matchAll(/<a class="nav-link nav-bar-link" href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((m) => [m[2], m[1]]);

test('the seeded site, as stored, through siteOf: the renderer draws its Menu', async () => {
  const seed = await seedFor('imagine-surrey', {});
  const settings = { theme: seed.theme, domains: [] };
  for (const k of SECTION_KEYS) settings[k] = sectionOf(k, seed.settings[k]);
  const { html } = renderSite({ kind: 'page', site: siteOf(settings, []), page: { id: 'p', slug: 'home', title: 'Home', modules: [] }, ctx: { root: '/', path: '/' } });
  assert.deepEqual(menuOf(html)?.map((l) => l.label), ['Promise tracker', 'Volunteer', 'Events', 'Act', 'Join', 'News'], 'Settings → Menu, in order');
});

test('the live site at /site/: the Menu is Settings → Menu, then the pages marked "In the menu"', async () => {
  const home = await hit('/site/');
  assert.equal(home.status, 200);
  const menu = menuOf(home.text);
  assert.ok(menu, 'the header has the Menu');
  assert.deepEqual(menu.map((l) => [l.label, l.href]), [
    ['Promise tracker', '/site/tracker'], ['Volunteer', '/site/volunteer'], ['Events', '/site/events'],
    ['Act', '/site/act'], ['Join', '/site/#m-join'], ['News', '/site/news'],
  ]);
  assert.match(home.text, /<a class="btn btn--action nav-cta" href="\/site\/donate"[^>]*>Donate<\/a>/, 'the title bar’s button');
  // A page switched on "In the menu" comes after them; one already listed isn't twice.
  const made = ok(await mgr.action('site.page.create', { title: 'Our team', slug: 'our-team', show_in_nav: true, modules: [] })).page;
  ok(await mgr.action('site.page.publish', { id: made.id }));
  const after = menuOf((await hit('/site/')).text);
  assert.deepEqual(after.map((l) => l.label), ['Promise tracker', 'Volunteer', 'Events', 'Act', 'Join', 'News', 'Our team']);
  // The 404 page offers the same places.
  const missing = await hit('/site/no-such-page');
  assert.equal(missing.status, 404);
  for (const label of ['Promise tracker', 'Volunteer', 'Our team']) assert.match(missing.text, new RegExp(`class="text-link" href="[^"]+">${label}</a>`), `404 lists ${label}`);
});

test('Settings → Menu and the title bar’s links change the site: links in the title bar, the menu in the Menu', async () => {
  const s = ok(await mgr.get('/api/site')).settings;
  ok(await mgr.action('site.settings.save', {
    nav: { ...s.nav, menu: [{ label: 'Town halls', href: '/events' }, ...s.nav.menu.slice(0, 2)], links: [{ label: 'Platform', href: '/tracker' }, { label: 'Act', href: '/act' }] },
  }));
  const html = (await hit('/site/')).text;
  assert.deepEqual(barOf(html), [['Platform', '/site/tracker'], ['Act', '/site/act']], 'the title bar’s links, in the title bar');
  const menu = menuOf(html);
  assert.deepEqual(menu.filter((l) => !l.bar).map((l) => l.label), ['Town halls', 'Promise tracker', 'Volunteer', 'News', 'Our team'],
    'the Menu: Settings → Menu, then the pages in the menu that aren’t in it (Events is, as Town halls)');
  assert.deepEqual(menu.filter((l) => l.bar).map((l) => l.label), ['Platform', 'Act'], 'on a phone the title bar’s links are in the Menu too');
  ok(await mgr.action('site.settings.save', { nav: s.nav }));
});

test('the footer: its logo and the platform link from Settings', async () => {
  const html = (await hit('/site/')).text;
  const footer = html.slice(html.indexOf('<footer class="site-footer"'));
  assert.match(footer, /<img class="footer-logo" src="\/site-assets\/imagine-surrey\/logo-light\.png" alt="Imagine Surrey"/, 'Settings → Footer → logo');
  assert.match(footer, /<a href="https:\/\/issuu\.com\/imaginesurrey\/docs\/imagine_surrey_platform_2026_-_signed"[^>]*>Read the 2026 election platform<\/a>/, 'Organization → the platform link, in its words');
  // Without a logo the name stands in its place; without the link's words, plain ones.
  const s = ok(await mgr.get('/api/site')).settings;
  ok(await mgr.action('site.settings.save', { footer: { ...s.footer, logo: { url: '', alt: '' } }, org: { ...s.org, platformLabel: '' } }));
  const plain = (await hit('/site/')).text;
  const foot2 = plain.slice(plain.indexOf('<footer class="site-footer"'));
  assert.doesNotMatch(foot2, /footer-logo/);
  assert.match(foot2, /<p class="footer-name">Imagine Surrey<\/p>/);
  assert.match(foot2, />Read the platform<\/a>/);
  ok(await mgr.action('site.settings.save', { footer: s.footer, org: s.org }));
});
