// A campaign's first website (ext/site/seeds): Imagine Surrey's is
// imaginesurrey.ca as it is — the home page's modules in the website's own
// order, its pages, the pledge and the SkyTrain petition, its menu, footer,
// search and organization details, word for word from apps/web — and every
// other campaign's is a clean generic one with nothing made up. Made once:
// a campaign that deletes its pages never has them put back.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { hit, ok, campaign } from './site-helpers.js';
import { Client } from './helpers.js';
import { checkModules } from '@starbase/shared/site/catalogue';
import { checkTheme } from '@starbase/shared/site/theme';
import { seedFor } from '../ext/site/seeds/index.js';

let db, mgr, ws;
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const web = (p) => readFileSync(here(`../../apps/web/src/${p}`), 'utf8');

before(async () => {
  delete process.env.STARBASE_BRAND;
  ({ db, mgr, ws } = await campaign('Imagine Surrey'));
});

test('Imagine Surrey: the home page in the website’s order, mapped to the catalogue; the shop left out', async () => {
  const site = ok(await mgr.get('/api/site'));
  const home = site.pages.find((p) => p.slug === 'home');
  const page = ok(await mgr.get(`/api/site/pages/${home.id}`)).page;
  // DEFAULT_MODULES (apps/web/src/lib/home-modules.ts): hero, actNow, pillars, news, join, pledge, donate,
  // skytrain, organize, board, committees, events, shop, social — the newsletter bar inside join is its own.
  assert.deepEqual(page.published.modules.map((m) => m.kind), [
    'hero', 'actNow', 'columns', 'news', 'join', 'newsletter', 'petition', 'donate', 'petition', 'band', 'people', 'groups', 'events', 'social',
  ]);
  const order = [...web('lib/home-modules.ts').matchAll(/\{ kind: "(\w+)", label/g)].map((m) => m[1]);
  assert.deepEqual(order, ['hero', 'actNow', 'pillars', 'news', 'join', 'pledge', 'donate', 'skytrain', 'organize', 'board', 'committees', 'events', 'shop', 'social']);
  const by = Object.fromEntries(page.published.modules.map((m) => [m.id, m.props]));
  assert.equal(by.hero.titlePrefix, 'Fighting for');
  assert.ok(by.hero.words.includes('SkyTrain') && by.hero.words.length === 15);
  assert.deepEqual(by.hero.secondaryCtas, [{ label: 'Chip in', href: '/donate' }], 'no Shop button');
  assert.equal(by.hero.image.url, '/site-assets/imagine-surrey/hero-park.jpg');
  assert.deepEqual(by.stand.items.map((i) => i.title), ['Safe streets', 'Fast commutes', 'Smart investments', 'Lower costs', 'Strong services']);
  assert.equal(by['act-now'].showCounts, false, 'the website publishes no supporter numbers');
  const camps = ok(await mgr.get('/api/site/campaigns')).campaigns;
  assert.equal(by.stop.campaign, camps.find((c) => c.slug === 'stop-mccallum-pledge').id, 'pledge → the seeded pledge');
  assert.equal(by.skytrain.campaign, camps.find((c) => c.slug === 'skytrain-south-surrey').id, 'skytrain → the seeded petition');
  assert.equal(by.organize.highlight, 'Surrey wins');
  assert.equal(by.about.seats.length, 12);
  assert.equal(by.committees.items.length, 6);
  assert.equal(by.social.accounts.length, 7);
  // Every word on it is the website's own.
  const settingsTs = web('lib/settings.ts');
  for (const s of [by.hero.text, by.stand.intro, by.join.intro, by.donate.intro, by.donate.clubNote, by.about.intro, by.committees.intro]) {
    assert.ok(settingsTs.includes(s), s.slice(0, 50));
  }
  const siteTs = web('content/site.ts');
  for (const i of by.stand.items) assert.ok(siteTs.includes(i.body), i.title);
});

test('Imagine Surrey: the pages, the petitions, the menu and details as the website has them', async () => {
  const site = ok(await mgr.get('/api/site'));
  assert.deepEqual(site.pages.map((p) => [p.slug, p.title]), [
    ['home', 'Imagine Surrey'], ['tracker', 'Safe Surrey promise tracker'], ['volunteer', 'Volunteer'], ['events', 'Events'],
    ['news', 'News'], ['donate', 'Chip in'], ['privacy', 'Privacy policy'], ['accessibility', 'Accessibility'],
  ]);
  const s = site.settings;
  assert.deepEqual(s.nav.menu.map((l) => l.label), ['Promise tracker', 'Volunteer', 'Events', 'Act', 'Join', 'News']);
  assert.deepEqual(s.nav.cta, { label: 'Donate', href: '/donate' });
  assert.ok(!s.footer.links.some((l) => /shop/i.test(l.label)));
  assert.match(s.footer.acknowledgement, /Semiahmoo, Katzie, and Kwantlen First Nations/);
  assert.equal(s.org.email, 'hello@imaginesurrey.ca');
  assert.equal(s.seo.title, 'Imagine Surrey');
  assert.equal(s.social.accounts[0].handle, '@imagine.surrey');
  assert.equal(s.theme.skin, 'imagine-surrey');
  assert.equal(s.theme.colors.brand, '#003979');
  assert.deepEqual(checkTheme(s.theme).problems, [], 'readable');

  const tracker = ok(await mgr.get(`/api/site/pages/${site.pages.find((p) => p.slug === 'tracker').id}`)).page.published;
  const promises = tracker.modules.find((m) => m.kind === 'tracker').props.items;
  assert.equal(promises.length, 26);
  assert.ok(promises.every((p) => p.status === 'pending'), 'every promise starts not started');
  assert.equal(promises[0].title, '0% property tax increases for four years');
  assert.equal(promises[0].due, 'May 15, 2027');
  assert.match(promises[7].title, /^A full-service Surrey General Hospital in Newton$/);
  assert.match(promises[7].note, /^Dedicate 7\.2 acres at 6965 King George Boulevard/, 'a long title’s rest leads its note');
  const privacy = ok(await mgr.get(`/api/site/pages/${site.pages.find((p) => p.slug === 'privacy').id}`)).page.published;
  assert.deepEqual(privacy.modules.map((m) => m.props.title).slice(0, 3), ['Privacy policy', 'What we collect', 'Why we collect it']);
  const camps = ok(await mgr.get('/api/site/campaigns')).campaigns;
  assert.deepEqual(camps.map((c) => [c.slug, c.kind, c.goal, c.status]).sort(), [
    ['skytrain-south-surrey', 'petition', 2500, 'open'], ['stop-mccallum-pledge', 'pledge', 1000, 'open'],
  ]);
  for (const slug of ['home', 'tracker', 'volunteer', 'events', 'news', 'donate', 'privacy', 'accessibility']) {
    assert.equal((await hit(`/site/${slug === 'home' ? '' : slug}`)).status, 200, slug);
  }
});

test('the pictures the seed uses are on the site, and only those', async () => {
  const content = readFileSync(here('../ext/site/seeds/imagine-surrey-content.js'), 'utf8') + readFileSync(here('../ext/site/seeds/imagine-surrey.js'), 'utf8');
  const used = [...new Set([...content.matchAll(/\/site-assets\/imagine-surrey\/([\w.-]+)/g)].map((m) => m[1]))].sort();
  assert.deepEqual(used, ['hero-park.jpg', 'logo-light.png', 'logo.webp', 'members-rally.jpg']);
  for (const f of used) {
    assert.ok(existsSync(here(`../../shared/site/assets/imagine-surrey/${f}`)), f);
    assert.equal((await hit(`/site-assets/imagine-surrey/${f}`)).status, 200, f);
  }
  const { readdirSync } = await import('node:fs');
  assert.deepEqual(readdirSync(here('../../shared/site/assets/imagine-surrey')).sort(), used, 'nothing the seed doesn’t use');
});

test('made once: a campaign that deletes a page doesn’t get it back', async () => {
  const privacy = (await mgr.get('/api/site')).json.pages.find((p) => p.slug === 'privacy');
  ok(await mgr.action('site.page.delete', { id: privacy.id }));
  await hit('/site/');
  assert.ok(!(await mgr.get('/api/site')).json.pages.some((p) => p.slug === 'privacy'));
  const seeds = (await db.query("select count(*)::int as n from events where workspace_id = $1 and action = 'site.seed' and entity_type = 'site_settings'", [ws])).rows[0].n;
  assert.equal(seeds, 1);
});

test('any other campaign: a clean generic site, with its own name and nothing made up', async () => {
  process.env.STARBASE_BRAND = 'base';
  try {
    const other = new Client();
    await other.signup({ workspaceName: 'Riverside Neighbours', email: `base+${Date.now()}@example.org` });
    const site = ok(await other.get('/api/site'));
    assert.deepEqual(site.pages.map((p) => p.slug), ['home', 'donate', 'volunteer', 'news', 'privacy']);
    assert.equal(site.settings.org.name, 'Riverside Neighbours');
    assert.equal(site.settings.theme.skin, 'base');
    assert.deepEqual(site.counts.campaigns, 0);
    const home = ok(await other.get(`/api/site/pages/${site.pages[0].id}`)).page.published;
    assert.deepEqual(home.modules.map((m) => m.kind), ['hero', 'columns', 'newsletter', 'donate', 'volunteer']);
    const all = JSON.stringify(site) + JSON.stringify(home);
    assert.doesNotMatch(all, /Surrey|McCallum|SkyTrain|imaginesurrey/i, 'nothing of Imagine Surrey');
    const seed = await seedFor('base', { name: 'Riverside Neighbours' });
    for (const p of seed.pages) assert.doesNotThrow(() => checkModules(p.modules, { strict: true }), p.slug);
  } finally {
    delete process.env.STARBASE_BRAND;
  }
});

test('both seeds pass the publish check, module for module', async () => {
  for (const brand of ['imagine-surrey', 'base']) {
    const seed = await seedFor(brand, { name: 'Test' });
    const ids = Object.fromEntries((seed.campaigns || []).map((c, i) => [`@campaign:${c.slug}`, `00000000-0000-4000-8000-00000000000${i}`]));
    for (const p of seed.pages) {
      const modules = JSON.parse(JSON.stringify(p.modules).replace(/"@campaign:[^"]+"/g, (m) => JSON.stringify(ids[JSON.parse(m)])));
      assert.doesNotThrow(() => checkModules(modules, { strict: true }), `${brand} ${p.slug}`);
    }
  }
});
