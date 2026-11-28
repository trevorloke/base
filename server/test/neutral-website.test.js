// A campaign's public website holds nothing of Imagine Surrey's unless it is
// Imagine Surrey's own server. Its look, its logo and photographs, its
// stylesheet, its star icons, its first site, its membership ("Become a
// member": the section, the form, the rules and their fourteen sentences)
// and its starting words for a new section are its set-up's
// (server/presets/, read only through lib/preset.js and
// ext/site/from-preset.js). Another campaign gets Base: a finished generic
// site, one look, neutral words — and those addresses hold nothing.
// Then the same server as Imagine Surrey's, with the brand set after the
// server was loaded (as the test helper does): everything as it was.
// Unique emails and campaign names (test:pg can run a file twice on one
// database), and the site at /site/ is named so it is this file's own.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { freshDb, Client } from './helpers.js';
import { hit, send } from './site-helpers.js';
import { app } from '../index.js';
import { forgetBrand } from '../lib/brand.js';
import { presetFor } from '../lib/preset.js';
import { renderSite } from '../ext/site/render/index.js';
import { seedFor } from '../ext/site/seeds/index.js';
import { liveStrings } from '../ext/site/translate.js';
import { siteWords } from '../ext/site/from-preset.js';
import { cacheClear } from '../ext/site/cache.js';
import { PROBE_SENTENCE } from '../lib/translate.js';
import { checkTheme, allLooks, SKINS } from '@base-win/shared/site/theme';
import { MODULES, checkModules, checkProps, newModule } from '@base-win/shared/site/catalogue';
import { UI_WORDS, translateMessage, fillWords } from '../../shared/site/ui-words.js';
import { offered, groups } from '../../web/src/components/site/builder.js';

const tag = Math.random().toString(36).slice(2, 8);
const ok = (r, msg = '') => { assert.ok(r.status === 200 || r.status === 201, `${msg} ${r.status} ${JSON.stringify(r.json)}`); return r.json; };
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const md5 = (b) => createHash('md5').update(b).digest('hex');
const IS = presetFor('imagine-surrey');
const PICTURES = ['hero-park.jpg', 'members-rally.jpg', 'logo.webp', 'logo-light.png'];
const ICONS = ['/star.png', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];
const SITE = `neutral-${tag}.example`;
// The fourteen sentences of Imagine Surrey's membership, and its own example
// of a postal code: none may be in what another campaign is handed.
const OWN_SENTENCES = Object.values(IS.site.words);

const saved = { brand: process.env.BASE_BRAND, site: process.env.SITE_WORKSPACE };
const wear = (brand) => { process.env.BASE_BRAND = brand; forgetBrand(); };
after(() => {
  for (const [k, v] of [['BASE_BRAND', saved.brand], ['SITE_WORKSPACE', saved.site]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  forgetBrand();
});

let db, mgr, ws;
// The Join form's island props, from a page's markup.
const joinProps = (html) => [...html.matchAll(/<script type="application\/json" data-island-props="[^"]+">([\s\S]*?)<\/script>/g)]
  .map((m) => JSON.parse(m[1])).find((p) => p.kind === 'join');
const pageOf = async (slug) => {
  const site = ok(await mgr.get('/api/site'));
  const row = site.pages.find((p) => p.slug === slug);
  return row ? ok(await mgr.get(`/api/site/pages/${row.id}`)).page : null;
};

before(async () => {
  db = await freshDb();
  wear('base');
  mgr = new Client();
  const r = ok(await mgr.signup({ workspaceName: `Kamloops Forward ${tag}`, email: `neutral.site.${tag}@example.org`, jurisdiction: 'bc-municipal' }));
  ws = r.workspace.id;
  process.env.SITE_WORKSPACE = (await db.query('select slug from workspaces where id = $1', [ws])).rows[0].slug;
  ok(await mgr.get('/api/site')); // first look: the site is made
  ok(await mgr.action('site.settings.save', { domains: [SITE] }));
});

test('the set-up’s folder holds the pictures, the stylesheet and the icons; the shared folders hold none of them', () => {
  for (const f of [...PICTURES, 'look.css']) assert.ok(existsSync(here(`../presets/imagine-surrey/assets/site/${f}`)), f);
  for (const f of ICONS) assert.ok(existsSync(here(`../presets/imagine-surrey/assets/app${f}`)), f);
  assert.ok(!existsSync(here('../../shared/site/assets')), 'shared/site/assets is gone');
  for (const f of ICONS) assert.ok(!existsSync(here(`../../web/public${f}`)), `web/public${f} is gone`);
  assert.ok(!existsSync(here('../ext/site/seeds/imagine-surrey.js')) && !existsSync(here('../lib/sample.js')));
  assert.deepEqual(readdirSync(here('../ext/site/seeds')).sort(), ['base.js', 'index.js']);
});

test('another campaign: the four pictures, the stylesheet and the four icons are not found, on the app’s address and on the website’s own domain', async () => {
  wear('base');
  for (const f of [...PICTURES, 'look.css']) {
    const path = `/site-assets/imagine-surrey/${f}`;
    assert.equal((await hit(path)).status, 404, `the app's address: ${path}`);
    assert.equal((await hit(path, { host: SITE })).status, 404, `the website's domain: ${path}`);
    assert.equal((await hit(`/site${path}`)).status, 404, `under /site: ${path}`);
  }
  for (const path of ICONS) {
    const app = await hit(path);
    assert.equal(app.status, 404, `the app's address: ${path}`);
    assert.doesNotMatch(app.headers.get('content-type') || '', /image/, path);
    assert.equal((await hit(path, { host: SITE })).status, 404, `the website's domain: ${path}`);
  }
  // The product's own files are still there.
  assert.equal((await hit('/site-assets/site.css')).status, 200);
  assert.equal((await hit('/site-assets/site.css', { host: SITE })).status, 200);
});

test('Imagine Surrey: the same pictures, stylesheet and icons at the same addresses, byte for byte', async () => {
  wear('imagine-surrey');
  try {
    for (const f of [...PICTURES, 'look.css']) {
      const res = await app.request(`http://localhost/site-assets/imagine-surrey/${f}`);
      assert.equal(res.status, 200, f);
      assert.equal(md5(Buffer.from(await res.arrayBuffer())), md5(readFileSync(here(`../presets/imagine-surrey/assets/site/${f}`))), f);
    }
    for (const path of ICONS) {
      const res = await app.request(`http://localhost${path}`);
      assert.equal(res.status, 200, path);
      assert.equal(res.headers.get('content-type'), 'image/png', path);
      assert.equal(md5(Buffer.from(await res.arrayBuffer())), md5(readFileSync(here(`../presets/imagine-surrey/assets/app${path}`))), path);
    }
    // The heading shadow is its stylesheet's alone, word for word as site.css had it.
    const look = readFileSync(here('../presets/imagine-surrey/assets/site/look.css'), 'utf8');
    assert.match(look, /\.display \{\s+text-shadow:\s+0\.02em 0\.02em 0 var\(--pop-c\),/);
    assert.equal((look.match(/var\(--pop-c\)/g) || []).length, 7);
  } finally { wear('base'); }
});

test('another campaign: no shadow in the served stylesheet, no page links the other one', async () => {
  wear('base');
  const css = readFileSync(here('../../shared/site/site.css'), 'utf8');
  assert.doesNotMatch(css, /text-shadow/);
  assert.doesNotMatch(css, /imagine|surrey/i);
  for (const path of ['/site/', '/site/donate', '/site/volunteer', '/site/news', '/site/privacy', '/site/no-such-page']) {
    const r = await hit(path);
    assert.doesNotMatch(r.text, /look\.css/, path);
    assert.doesNotMatch(r.text, /imagine-surrey|Imagine Surrey|imaginesurrey/i, path);
    assert.equal((r.text.match(/<link rel="stylesheet"/g) || []).length, 1, `${path}: site.css alone`);
  }
});

test('Imagine Surrey: every page links its stylesheet once, right after site.css', () => {
  wear('imagine-surrey');
  try {
    const { html } = renderSite({ kind: 'page', site: { theme: { skin: 'imagine-surrey' }, org: { name: 'Imagine Surrey' } }, page: { id: 'p1', slug: 'home', title: 'Home', modules: [] }, data: {}, ctx: { root: '/', path: '/' } });
    assert.match(html, /<link rel="stylesheet" href="\/site-assets\/site\.css\?v=[a-f0-9]{12}"><link rel="stylesheet" href="\/site-assets\/imagine-surrey\/look\.css\?v=[a-f0-9]{12}">/);
    assert.match(html, /data-skin="imagine-surrey"/);
  } finally { wear('base'); }
});

test('another campaign: one look, Base; a theme saved as “imagine-surrey” is saved as Base', async () => {
  wear('base');
  const site = ok(await mgr.get('/api/site'));
  assert.deepEqual(site.skins.map((s) => s.key), ['base'], 'the Theme screen is offered one look');
  assert.deepEqual(site.skins[0], SKINS.base);
  assert.deepEqual(site.moduleDefaults, {});
  assert.deepEqual(site.fieldLabels, {});
  assert.doesNotMatch(JSON.stringify(site), /Imagine Surrey|imagine-surrey|#003979|#fff100|#d81b1e|Join us|\/join/);
  assert.deepEqual(allLooks().map((l) => l.key), ['base']);

  ok(await mgr.action('site.settings.save', { theme: { skin: 'imagine-surrey' } }));
  const theme = ok(await mgr.get('/api/site')).settings.theme;
  assert.equal(theme.skin, 'base');
  assert.deepEqual(theme.colors, SKINS.base.colors, 'no colour of the other look came with the name');
  assert.deepEqual(theme.fonts, SKINS.base.fonts);
  assert.equal(theme.pop, false);
  // The name alone, checked where every page checks it.
  assert.equal(checkTheme({ skin: 'imagine-surrey' }).theme.skin, 'base');
  assert.equal(checkTheme({}, 'imagine-surrey').theme.skin, 'base');
  // Colours chosen by hand stay as chosen (a theme is stored whole).
  const mine = { ...SKINS.base.colors, brand: '#0a5c36', link: '#0a5c36', action: '#0a5c36' };
  ok(await mgr.action('site.settings.save', { theme: { skin: 'imagine-surrey', colors: mine, pop: true, follow: false } }));
  const kept = ok(await mgr.get('/api/site')).settings.theme;
  assert.equal(kept.skin, 'base');
  assert.equal(kept.colors.brand, '#0a5c36');
  assert.equal(kept.pop, true);
  // A saved "shadow under headings" draws nothing: its stylesheet is not served here.
  const home = await hit('/site/');
  assert.match(home.text, /data-skin="base"/);
  assert.match(home.text, /--brand:#0a5c36/);
  assert.doesNotMatch(home.text, /look\.css|text-shadow/);
  ok(await mgr.action('site.settings.save', { theme: { ...SKINS.base, follow: true } }));
});

test('Imagine Surrey: its look is offered beside Base, and a theme saved by its name keeps it', () => {
  wear('imagine-surrey');
  try {
    assert.deepEqual(allLooks().map((l) => l.key), ['base', 'imagine-surrey']);
    const { theme, problems } = checkTheme({ skin: 'imagine-surrey' });
    assert.deepEqual(problems, []);
    assert.equal(theme.skin, 'imagine-surrey');
    assert.deepEqual(theme.colors, { ...IS.site.skin.colors });
    assert.equal(theme.pop, true);
    assert.equal(checkTheme({}, 'imagine-surrey').theme.skin, 'imagine-surrey', 'a theme with no name is its own look there');
  } finally { wear('base'); }
});

test('another campaign: its first site is the generic one, finished, with no way to a membership', async () => {
  wear('base');
  const site = ok(await mgr.get('/api/site'));
  assert.deepEqual(site.pages.map((p) => [p.slug, p.status]), [['home', 'published'], ['donate', 'published'], ['volunteer', 'published'], ['news', 'published'], ['privacy', 'published']]);
  const seed = await seedFor('base', { name: 'Kamloops Forward' });
  assert.deepEqual(await seedFor('imagine-surrey', { name: 'Kamloops Forward' }), seed, 'the other name gets the generic site here too');
  const home = await hit('/site/');
  assert.equal(home.status, 200);
  assert.match(home.text, /<header[ >]/);
  assert.match(home.text, /<footer[ >]/);
  assert.match(home.text, /data-module="hero"/);
  assert.ok((home.text.match(/<section data-module="/g) || []).length >= 3, 'a hero and at least two more sections');
  assert.match(home.text, new RegExp(`Kamloops Forward ${tag}`));
  for (const path of ['/site/', '/site/donate', '/site/volunteer', '/site/news', '/site/privacy']) {
    const r = await hit(path);
    assert.equal(r.status, 200, path);
    assert.doesNotMatch(r.text, /href="[^"]*\/join["#?]/, `${path}: no link to a Join page`);
    assert.doesNotMatch(r.text, /data-module="join"|api\/forms\/join|Become a member/i, path);
    assert.doesNotMatch(r.text, /Surrey|McCallum|SkyTrain|Newton/i, path);
  }
  assert.doesNotMatch(JSON.stringify(seed), /\/join|member/i);
  // Every page but the home passes Publish as made; the home's hero holds
  // sample words by design, and publishes once they are the campaign's own.
  for (const p of seed.pages) {
    if (p.slug !== 'home') assert.doesNotThrow(() => checkModules(p.modules, { strict: true }), p.slug);
  }
  const page = await pageOf('home');
  const modules = page.draft.modules.map((m) => (m.kind === 'hero' ? { ...m, props: { ...m.props, titlePrefix: 'A fair deal for Kamloops', text: 'We are neighbours working for better transit and safer streets.' } } : m));
  ok(await mgr.action('site.page.save', { id: page.id, modules }));
  const live = ok(await mgr.action('site.page.publish', { id: page.id })).page;
  assert.equal(live.status, 'published');
  assert.match((await hit('/site/')).text, /A fair deal for Kamloops/);
});

test('Imagine Surrey: its first site is still its own, from its set-up’s folder', async () => {
  wear('imagine-surrey');
  try {
    const seed = await seedFor('imagine-surrey', { name: 'Imagine Surrey' });
    assert.equal(seed.theme.skin ?? seed.theme.key, 'imagine-surrey');
    assert.equal(seed.theme.logo.url, '/site-assets/imagine-surrey/logo.webp');
    assert.deepEqual(seed.pages.map((p) => p.slug), ['home', 'tracker', 'volunteer', 'events', 'news', 'donate', 'privacy', 'accessibility']);
    assert.ok(seed.pages[0].modules.some((m) => m.kind === 'join'));
    assert.deepEqual((await seedFor('base', { name: 'X' })).pages.map((p) => p.slug), ['home', 'donate', 'volunteer', 'news', 'privacy'], 'the generic one is still there by its name');
  } finally { wear('base'); }
});

test('another campaign: a join form is not found, a Join section draws nothing, and “Add a section” does not offer one', async () => {
  wear('base');
  const before = (await db.query('select count(*)::int as n from persons where workspace_id = $1', [ws])).rows[0].n;
  const body = { first_name: 'Ana', last_name: 'Example', email: `ana.${tag}@example.org`, address: '123 Main St', city: 'Kamloops', postal_code: 'V2C 1A1', declaration: true, term: 1, amount_cents: 1000, birth_date: '1990-04-21', citizenship: 'citizen' };
  const json = await send('join', body);
  assert.equal(json.status, 404, JSON.stringify(json.json));
  assert.deepEqual(json.json, { error: 'not found' });
  assert.equal((await hit('/site/api/forms/join', { method: 'POST', form: body })).status, 404, 'a plain post too');
  assert.equal((await send('join', body, { root: '', host: SITE })).status, 404, 'on the website’s own domain too');
  assert.equal((await send('join', {})).status, 404, 'before anything is read');
  assert.equal((await db.query('select count(*)::int as n from persons where workspace_id = $1', [ws])).rows[0].n, before, 'nobody was made');
  assert.equal((await db.query("select count(*)::int as n from site_actions where workspace_id = $1 and kind = 'join'", [ws])).rows[0].n, 0);
  // The other forms are as they were.
  assert.equal((await send('newsletter', { first_name: 'Ana', email: `ana.${tag}@example.org`, consent_email: true })).status, 200);

  // A page that holds a Join section (made by hand, or kept from before).
  const made = ok(await mgr.action('site.page.create', {
    title: `Get involved ${tag}`,
    modules: [
      { id: 'txt1', kind: 'text', props: { title: 'How to help', body: 'Three ways to take part.' } },
      { id: 'join1', kind: 'join', props: { title: 'Become a member', intro: 'Join us today.' } },
      { id: 'team1', kind: 'people', props: { title: 'Our team', seats: [{ role: 'Chair', name: '' }] } },
    ],
  })).page;
  ok(await mgr.action('site.page.publish', { id: made.id }));
  const r = await hit(`/site/${made.slug}`);
  assert.equal(r.status, 200);
  assert.match(r.text, /id="m-txt1"/);
  assert.doesNotMatch(r.text, /id="m-join1"|data-module="join"|Become a member|Join us today|api\/forms\/join/);
  assert.match(r.text, /id="m-team1"/);
  assert.match(r.text, /Seat open/);
  assert.doesNotMatch(r.text, /Put your name forward/, 'an open seat links to no membership form');

  // The builder's list of sections (the page says no membership: brand.js).
  assert.ok(!offered().some((m) => m.kind === 'join'));
  assert.ok(!groups().flatMap((g) => g.modules).some((m) => m.kind === 'join'));
  assert.equal(offered().length, MODULES.length - 1);
  assert.ok(offered({ membership: true }).some((m) => m.kind === 'join'), 'a campaign with a membership is offered it');
});

test('another campaign: the live numbers say nothing of members', async () => {
  wear('base');
  const made = ok(await mgr.action('site.page.create', { title: `Act now ${tag}`, modules: [{ id: 'act1', kind: 'actNow', props: { title: 'Act now', showCounts: true } }] })).page;
  ok(await mgr.action('site.page.publish', { id: made.id }));
  const r = await hit(`/site/${made.slug}`);
  assert.match(r.text, /id="m-act1"/);
  assert.doesNotMatch(r.text, /count-label">members</);
  assert.equal(MODULES.find((m) => m.kind === 'actNow').fields.find((f) => f.key === 'showCounts').label, 'Show live numbers (signatures)');
});

test('another campaign: the fixed words, the translation list, the pages and the public script hold none of the fourteen sentences', async () => {
  wear('base');
  assert.equal(OWN_SENTENCES.length, 15, 'fourteen sentences and its example of a postal code');
  assert.equal(siteWords(), UI_WORDS, 'the product’s words and nothing laid over them');
  const product = Object.values(UI_WORDS);
  for (const s of OWN_SENTENCES) assert.ok(!product.includes(s), s);
  for (const k of Object.keys(IS.site.words)) if (k !== 'err.postal_code') assert.ok(!(k in UI_WORDS), k);
  assert.equal(UI_WORDS['err.postal_code'], 'Enter a postal code like A1A 1A1');
  const strings = (await liveStrings(db, { id: ws })).map((g) => g.text);
  assert.ok(strings.length > 300);
  for (const s of OWN_SENTENCES) assert.ok(!strings.includes(s), `to translate: ${s}`);
  for (const path of ['/site/', '/site/donate', '/site/volunteer']) {
    const html = (await hit(path)).text;
    for (const s of OWN_SENTENCES) assert.ok(!html.includes(s), `${path}: ${s}`);
    assert.doesNotMatch(html, /"own":/, `${path}: no island is sent words of its own`);
  }
  // The built script every campaign's visitors load, when it has been built.
  for (const f of ['../../web/dist/site-islands.js', '../../web/dist/site-preview.js']) {
    if (!existsSync(here(f))) continue;
    const js = readFileSync(here(f), 'utf8');
    // Each as a whole string of the script (some are also part of a longer,
    // general sentence: the donor's declaration names citizens too).
    for (const s of OWN_SENTENCES) for (const q of ['"', "'", '`']) assert.ok(!js.includes(`${q}${s}${q}`), `${f}: ${s}`);
  }
});

test('Imagine Surrey: the same words in the same places; a Join form in Punjabi and its errors read as before', async () => {
  wear('imagine-surrey');
  try {
    const words = siteWords();
    for (const [k, v] of Object.entries(IS.site.words)) assert.equal(words[k], v, k);
    assert.equal(Object.keys(words).length, Object.keys(UI_WORDS).length + 14);
    // Each sits where it always did in the list a translator works through.
    const keys = Object.keys(words);
    const after = (k) => keys[keys.indexOf(k) + 1];
    assert.equal(after('join.pr'), 'field.term');
    assert.equal(after('field.fourYears'), 'field.comment');
    assert.equal(after('srv.birthLike'), 'srv.members14');
    assert.equal(after('srv.oneOrFour'), 'srv.pickAmount');
    assert.equal(after('srv.mostMonthly'), 'srv.membershipYear');
    assert.equal(after('srv.membershipFourYouth'), 'srv.declareJoin');
    assert.equal(after('pay.onceOrMonthly'), 'pay.duesOnce');
    assert.equal(after('pay.declare'), 'pay.oneOrFour');
    assert.equal(after('pay.citizen'), 'pay.monthlyMost');

    // A translated page: every label of the Join form is the page's language.
    const tr = { look: (t) => ({ text: `«${t}»`, lang: 'pa', v: 1 }) };
    const page = { id: 'p1', slug: 'join', title: 'Join', modules: [{ id: 'join1', kind: 'join', props: { title: 'Become a member' } }] };
    const data = { membership: true, payments: { ready: true, limit_cents: 142970, membership_suggested: IS.membership.suggested } };
    const site = { theme: { skin: 'imagine-surrey' }, org: { name: 'Imagine Surrey', email: 'hello@example.org' } };
    const pa = renderSite({ kind: 'page', site, page, data, ctx: { root: '/', path: '/join', lang: 'pa', tr } }).html;
    const props = joinProps(pa);
    const term = props.fields.find((f) => f.name === 'term');
    assert.equal(term.label, '«How long»');
    assert.deepEqual(term.options, [{ value: 1, label: '«1 year»' }, { value: 4, label: '«4 years»' }]);
    assert.equal(props.w['err.postal_code'], '«Enter a postal code like V3T 1A1»');
    assert.equal(props.w['field.term'], '«How long»');
    assert.deepEqual(props.amount.presets, [1000, 2500, 5000, 10000]);
    // The English page: the same form, with its own example of a postal code.
    const en = renderSite({ kind: 'page', site, page, data, ctx: { root: '/', path: '/join' } }).html;
    const enProps = joinProps(en);
    assert.equal(enProps.fields.find((f) => f.name === 'term').label, 'How long');
    assert.equal(enProps.w, undefined, 'an English page is not a translated one');
    assert.equal(enProps.own['err.postal_code'], 'Enter a postal code like V3T 1A1');

    // The server's answers to a join, found again by their English.
    const w = (k, slots) => fillWords(`«${words[k]}»`, slots);
    assert.equal(translateMessage('Members are 14 or older', w, words), '«Members are 14 or older»');
    assert.equal(translateMessage('One year or four', w, words), '«One year or four»');
    assert.equal(translateMessage('The membership is at least $20.00 for four years (aged 14 to 30)', w, words), '«The membership is at least $20.00 for four years (aged 14 to 30)»');
    assert.equal(translateMessage('Choose 1 or 4 years.', w, words), '«Choose 1 or 4 years.»');
    // And with the product's words alone they are nobody's.
    assert.equal(translateMessage('Members are 14 or older', (k) => `«${UI_WORDS[k]}»`), 'Members are 14 or older');
  } finally { wear('base'); }
});

test('another campaign: a new band and a new hero start with neutral words, and Publish refuses the band until they are its own', async () => {
  wear('base');
  const band = newModule('band', 'band1');
  assert.deepEqual(band.props, { title: 'Your headline,', highlight: 'in a few words', cta: { label: 'Volunteer', href: '/volunteer' }, tone: 'accent' });
  assert.deepEqual(newModule('hero', 'hero1').props.primaryCta, { label: 'Volunteer', href: '/volunteer' });
  assert.deepEqual(checkProps('band', {}), band.props);
  assert.throws(() => checkModules([band], { strict: true }), /title: still has the sample words/);
  assert.throws(() => checkModules([{ ...band, props: { ...band.props, title: 'Better transit,' } }], { strict: true }), /highlight: still has the sample words/);
  assert.doesNotThrow(() => checkModules([{ ...band, props: { ...band.props, title: 'Better transit,', highlight: 'sooner' } }], { strict: true }));

  const made = ok(await mgr.action('site.page.create', { title: `Transit ${tag}`, modules: [band] })).page;
  const refused = await mgr.action('site.page.publish', { id: made.id });
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /^The 1st module \(Call to action band\): title: still has the sample words$/);
  ok(await mgr.action('site.page.save', { id: made.id, modules: [{ ...band, props: { ...band.props, title: 'Better transit,', highlight: 'sooner' } }] }));
  ok(await mgr.action('site.page.publish', { id: made.id }));
  assert.match((await hit(`/site/${made.slug}`)).text, /Better transit,/);
});

test('Imagine Surrey: a new band and hero start with its own words, a stored band with none of its own reads as before, and it still publishes', () => {
  wear('imagine-surrey');
  try {
    const band = newModule('band', 'band1');
    assert.deepEqual(band.props, { title: 'When we organize,', highlight: 'we win', cta: { label: 'Join us', href: '/join' }, tone: 'accent' });
    assert.deepEqual(newModule('hero', 'hero1').props.primaryCta, { label: 'Join us', href: '/join' });
    assert.deepEqual(checkProps('band', {}), band.props, 'what a stored band with no words of its own is filled with');
    assert.deepEqual(checkProps('band', { tone: 'brand' }), { ...band.props, tone: 'brand' });
    assert.doesNotThrow(() => checkModules([band], { strict: true }), 'its band publishes as made');
    const { html } = renderSite({ kind: 'page', site: { theme: { skin: 'imagine-surrey' }, org: { name: 'Imagine Surrey' } }, page: { id: 'p1', slug: 'x', title: 'X', modules: [{ id: 'band1', kind: 'band', props: {} }] }, data: {}, ctx: { root: '/', path: '/x' } });
    assert.match(html, /When we organize,/);
    assert.match(html, /we win/);
    assert.match(html, /href="\/join"/);
  } finally { wear('base'); }
});

test('“Check translation” sends Google a made-up sentence that names no campaign, whoever asks', () => {
  for (const brand of ['base', 'imagine-surrey']) {
    wear(brand);
    assert.equal(PROBE_SENTENCE, 'Join <span translate="no">Sample Campaign</span> at the town hall & bring <x i="1"/> friend to the next meeting.');
    assert.doesNotMatch(PROBE_SENTENCE, /Imagine|Surrey/i);
  }
  wear('base');
});

test('a web address that is not one: the example in the message is neutral, and Imagine Surrey’s is its own', async () => {
  wear('base');
  const r = await mgr.action('site.settings.save', { domains: ['not a domain'] });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, '“not a domain” isn\'t a web address (like yourcampaign.ca)');
  wear('imagine-surrey');
  try {
    const is = await mgr.action('site.settings.save', { domains: ['not a domain'] });
    assert.equal(is.json.error, '“not a domain” isn\'t a web address (like imaginesurrey.ca)');
  } finally { wear('base'); cacheClear(ws); }
});
