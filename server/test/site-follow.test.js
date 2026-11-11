// The website and the campaign's brand (ext/site store.js siteOf): a new
// website follows the brand (theme.follow, seeded on for a new generic
// website) until it is given its own look; a website that already has its
// own (Imagine Surrey's is live) never changes when the brand does. A theme
// save that doesn't say otherwise keeps following as it was. Every website
// gets the campaign's mark as its icon, on the campaign's own domain too.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { hit, ok, campaign } from './site-helpers.js';
import { png, webp, dataUrl } from './brand-images.js';
import { checkTheme, contrast } from '@starbase/shared/site/theme';
import { deriveLook } from '@starbase/shared/brand-look';

const ENV = ['STARBASE_BRAND', 'SITE_HOSTS'];
const had = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
after(() => { for (const k of ENV) { if (had[k] === undefined) delete process.env[k]; else process.env[k] = had[k]; } });

let db, mgr, ws;
before(async () => {
  process.env.STARBASE_BRAND = 'base';
  ({ db, mgr, ws } = await campaign('Riverside Forward'));
});

// The theme's variables as the site's page carries them.
const themeOf = (html) => Object.fromEntries([...(/<style>:root\{([^}]*)\}<\/style>/.exec(html)?.[1] || '').matchAll(/--([a-z-]+):([^;]+)/g)].map((m) => [m[1], m[2]]));
const picture = async (kind, buf, type) => {
  const r = await mgr.action('brand.picture', { kind, data: dataUrl(buf, type) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.picture.id;
};

let logo, dark, icons;
test('a new website follows the campaign’s brand: base.win’s look until one is saved, then the campaign’s at once', async () => {
  const site = ok(await mgr.get('/api/site'));
  assert.equal(site.settings.theme.follow, true, 'seeded following');
  let t = themeOf((await hit('/site/')).text);
  const base = deriveLook({ color: '#4f46e5' }, 'light');
  assert.deepEqual([t.brand, t.link, t['brand-ink']], [base.accent, base.accentWords, base.accentInk], 'base.win’s own brand, unsaved');

  logo = await picture('logo', png(640, 128));
  dark = await picture('logoDark', webp(640, 128), 'image/webp');
  const r = await mgr.action('brand.save', { color: '#0f766e', second: '#ffc72c', heading: 'montserrat', corners: 'round', logo: { id: logo }, logo_dark: { id: dark } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const html = (await hit('/site/')).text;
  t = themeOf(html);
  const l = deriveLook(r.json.brand, 'light');
  assert.deepEqual(
    [t.brand, t['brand-ink'], t.accent, t['accent-ink'], t.link, t.action, t.paper, t.surface, t.radius],
    ['#0f766e', '#ffffff', '#ffc72c', l.secondInk, l.accentWords, '#0f766e', '#ffffff', l.panel, '22px'],
    'the brand colour, the second as the accent, the brand as words for links — at once: the kept pages went on save',
  );
  assert.match(t['font-heading'], /^'Montserrat'/);
  assert.match(html, new RegExp(`/media/${logo}\\.png`), 'the brand’s logo in the title bar');
  assert.match(html, new RegExp(`/media/${dark}\\.webp`), 'the logo for dark backgrounds in the dark footer');
  const followed = ok(await mgr.get('/api/site')).brand_theme;
  assert.deepEqual(followed.colors, { brand: '#0f766e', brandInk: '#ffffff', accent: '#ffc72c', accentInk: l.secondInk, ink: l.text, paper: '#ffffff', surface: l.panel, line: l.line, link: l.accentWords, action: '#0f766e', actionInk: '#ffffff' });
  assert.deepEqual(checkTheme(followed).problems, [], 'every pair the website checks reads');
});

test('any brand colour makes a website that reads: the pairs the website checks pass', () => {
  for (const color of ['#fff100', '#f9a8d4', '#111111', '#d81b1e', '#ffffff']) {
    for (const second of [null, '#fff100', '#003979']) {
      const l = deriveLook({ color, second }, 'light');
      const colors = { brand: l.accent, brandInk: l.accentInk, accent: l.second, accentInk: l.secondInk, ink: l.text, paper: l.card, surface: l.panel, line: l.line, link: l.accentWords, action: l.accent, actionInk: l.accentInk };
      assert.deepEqual(checkTheme({ colors }).problems.map((p) => `${p.pair.label} ${p.ratio.toFixed(2)}`), [], `${color} ${second}`);
      assert.ok(contrast(colors.link, '#ffffff') >= 4.5);
    }
  }
});

test('given its own look, the website stops following; a save that doesn’t say keeps following as it was', async () => {
  const own = ok(await mgr.get('/api/site')).settings.theme;
  // The theme screen saving something else: still following.
  ok(await hit('/site/'));
  let r = await mgr.action('site.settings.save', { theme: { ...own, follow: undefined, radius: 'square' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(ok(await mgr.get('/api/site')).settings.theme.follow, true);
  assert.equal(themeOf((await hit('/site/')).text).brand, '#0f766e', 'still the brand');
  // "Give the website its own look": the brand's theme, kept, not following.
  const followed = ok(await mgr.get('/api/site')).brand_theme;
  r = await mgr.action('site.settings.save', { theme: { ...followed, colors: { ...followed.colors, brand: '#003979', action: '#003979' }, follow: false } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(themeOf((await hit('/site/')).text).brand, '#003979');
  // The brand changes; the website's own look doesn't.
  assert.equal((await mgr.action('brand.save', { color: '#d81b1e' })).status, 200);
  assert.equal(themeOf((await hit('/site/')).text).brand, '#003979', 'its own look stands');
  // "Use the campaign's brand again".
  r = await mgr.action('site.settings.save', { theme: { ...ok(await mgr.get('/api/site')).settings.theme, follow: true } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(themeOf((await hit('/site/')).text).brand, '#d81b1e');
});

test('a website made before following existed (Imagine Surrey’s) keeps its own look whatever the brand', async () => {
  await db.query("update site_settings set theme = theme - 'follow' where workspace_id = $1", [ws]);
  assert.equal((await mgr.action('brand.save', { color: '#6d28d9' })).status, 200);
  const t = themeOf((await hit('/site/')).text);
  assert.notEqual(t.brand, '#6d28d9');
  assert.equal(ok(await mgr.get('/api/site')).settings.theme.follow, undefined, 'no such key: not following');
});

test('the website’s icon is the campaign’s mark, on the app’s address and the campaign’s own domain', async () => {
  assert.doesNotMatch((await hit('/site/')).text, /<link rel="icon"/, 'no mark: no icon (as before)');
  icons = {
    i192: await picture('icon192', png(192, 192)), i512: await picture('icon512', png(512, 512)),
    maskable: await picture('maskable', png(512, 512)), touch: await picture('touch', png(180, 180)),
  };
  assert.equal((await mgr.action('brand.save', { color: '#0f766e', mark: { id: await picture('mark', png(512, 512)) }, icons })).status, 200);
  const links = `<link rel="icon" href="/media/${icons.i192}.png" type="image/png"><link rel="apple-touch-icon" href="/media/${icons.touch}.png">`;
  assert.ok((await hit('/site/')).text.includes(links), 'on the app’s address');
  process.env.SITE_HOSTS = 'riverside.example';
  const atHome = await hit('/', { host: 'riverside.example' });
  assert.equal(atHome.status, 200);
  assert.ok(atHome.text.includes(links), 'on the campaign’s own domain');
  for (const id of [icons.i192, icons.touch]) assert.equal((await hit(`/media/${id}.png`, { host: 'riverside.example' })).status, 200, 'and the pictures answer there');
  delete process.env.SITE_HOSTS;
});
