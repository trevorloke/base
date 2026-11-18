// The website builder's plain parts (WA stage 2a): page starters and their
// sample words (shared/site/starters.js), Publish refusing sample words,
// the live preview's inputs and its browser path (the same renderContext and
// components drawing the same markup), needsReload, and the tap-to-edit
// markers only on the builder's own preview.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { MODULES, MODULE_BY_KIND, checkModules, checkProps, newModule } from '@starbase/shared/site/catalogue';
import { STARTERS, PLACEHOLDERS, starterModules, samplePath } from '@starbase/shared/site/starters';
import { needsReload } from '@starbase/shared/site/components/context';
import { drawBody, markSections } from '@starbase/shared/site/components/preview';
import { problemsOf, problemWords, newModuleId } from '../../web/src/components/site/builder.js';
import { renderSite } from '../ext/site/render/index.js';
import { baseSample, imagineSurrey } from './site-samples.js';
import { hit, ok, campaign } from './site-helpers.js';

const make = (key, opts = {}) => starterModules(key, { newId: newModuleId, ...opts });
const words = (m) => {
  const out = [];
  const walk = (v) => {
    if (typeof v === 'string') { if (v.trim()) out.push(v); } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(m.props);
  return out;
};
const defaultsOf = (kind) => words({ props: MODULE_BY_KIND[kind].defaults });
const ALL_PLACEHOLDERS = new Set(Object.values(PLACEHOLDERS).flat());

test('each starter makes exactly its sections, in order', () => {
  const kinds = (key, opts) => make(key, opts).map((m) => m.kind);
  assert.deepEqual(STARTERS.map((s) => s.label), ['An issue', 'An event', 'A petition', 'About us', 'Contact', 'Get involved', 'Blank']);
  assert.deepEqual(kinds('issue'), ['hero', 'text', 'columns', 'petition', 'band']);
  assert.deepEqual(kinds('event'), ['hero', 'text', 'events', 'volunteer']);
  assert.deepEqual(kinds('petition'), ['hero', 'petition', 'text', 'newsletter']);
  assert.deepEqual(kinds('about'), ['hero', 'text', 'people', 'quote', 'groups']);
  assert.deepEqual(kinds('contact'), ['text', 'contact'], 'no social accounts: Follow along is left out');
  assert.deepEqual(kinds('contact', { social: { accounts: [{ name: 'Instagram', handle: '@example', url: 'https://www.instagram.com/example' }] } }), ['text', 'contact', 'social']);
  assert.deepEqual(kinds('involved'), ['hero', 'volunteer', 'shifts', 'donate', 'newsletter']);
  assert.deepEqual(kinds('blank'), []);
  // Each a valid draft with unique ids.
  for (const s of STARTERS) {
    const list = make(s.key);
    assert.doesNotThrow(() => checkModules(list), s.key);
    assert.equal(new Set(list.map((m) => m.id)).size, list.length);
  }
});

test('the starters’ words: exactly the listed ones, every one beyond the catalogue’s in PLACEHOLDERS', () => {
  const issue = make('issue');
  assert.equal(issue[0].props.titlePrefix, 'Your issue’s headline');
  assert.equal(issue[0].props.text, 'One or two sentences on the problem and what you’d do about it.');
  assert.deepEqual(issue[0].props.primaryCta, MODULE_BY_KIND.hero.defaults.primaryCta, 'buttons: the catalogue’s');
  assert.deepEqual(issue[2].props.items.map((i) => i.icon), ['civic', 'people', 'home']);
  assert.ok(issue[2].props.items.every((i) => i.title === 'A point' && i.body === 'One or two sentences on this point.'));
  assert.equal(issue[2].props.title, 'What we stand for');
  assert.equal(issue[3].props.campaign, '', 'the petition: Publish asks which one');
  const about = make('about');
  assert.equal(about[2].props.seats.length, 2);
  assert.deepEqual(about[3].props, { ...about[3].props, quote: 'A few words from someone who supports you.', name: 'Their name', role: 'Who they are' });
  assert.equal(about[4].props.items.length, 2);
  for (const s of STARTERS) {
    for (const m of make(s.key)) {
      const allowed = new Set([...defaultsOf(m.kind), ...ALL_PLACEHOLDERS]);
      for (const w of words(m)) {
        if (/^\/|^https:/.test(w) || ['civic', 'people', 'home', 'paper', 'surface', 'accent', 'brand', 'ink'].includes(w)) continue;
        assert.ok(allowed.has(w), `${s.key} · ${m.kind}: “${w}” is neither the catalogue’s nor in PLACEHOLDERS`);
      }
    }
  }
  // Nothing in PLACEHOLDERS is about one campaign.
  assert.doesNotMatch(JSON.stringify(PLACEHOLDERS), /Surrey|Imagine|base\.win/);
});

test('Publish refuses each starter’s unchanged sample words, naming the section and the box; real words pass', () => {
  for (const s of STARTERS) {
    let list = make(s.key);
    // The petition is picked (that's its own rule).
    list = list.map((m) => (m.kind === 'petition' ? { ...m, props: { ...m.props, campaign: 'c-parks' } } : m));
    assert.doesNotThrow(() => checkModules(list), `${s.key}: a draft keeps them`);
    for (let guard = 0; guard < 40; guard += 1) {
      const probs = problemsOf(list, { strict: true });
      if (!probs.length) break;
      const p = probs[0];
      assert.equal(p.text, 'still has the sample words', `${s.key}: ${problemWords(p)}`);
      assert.match(problemWords(p), /^Section \d+ \([^)]+\) · .+: still has the sample words$/);
      // The server says the same, by module and field.
      assert.throws(() => checkModules(list, { strict: true }), new RegExp(`modules\\[${p.index}\\]|${p.path.replace(/[[\]]/g, '\\$&')}`));
      // Type real words into that box.
      const m = list[p.index];
      const props = JSON.parse(JSON.stringify(m.props));
      const pm = /^(\w+)(?:\[(\d+)\]\.(\w+))?$/.exec(p.path);
      if (pm[2] != null) props[pm[1]][Number(pm[2])][pm[3]] = `Real words ${guard}`;
      else props[pm[1]] = `Real words ${guard}`;
      list = list.map((x, i) => (i === p.index ? { ...x, props } : x));
    }
    assert.deepEqual(problemsOf(list, { strict: true }), [], `${s.key}: real words publish`);
    assert.doesNotThrow(() => checkModules(list, { strict: true }));
  }
});

test('the catalogue’s own hero sample words are refused at Publish, typed with a plain apostrophe too; hidden sections aren’t checked', () => {
  const hero = newModule('hero', 'hero0001');
  assert.throws(() => checkProps('hero', hero.props, { strict: true }), /titlePrefix: still has the sample words$/);
  assert.throws(() => checkProps('hero', { ...hero.props, titlePrefix: 'A real headline' }, { strict: true }), /text: still has the sample words$/);
  assert.doesNotThrow(() => checkProps('hero', hero.props), 'a draft may hold them');
  assert.equal(samplePath('hero', { titlePrefix: "  Your issue's headline " }), 'titlePrefix');
  assert.equal(samplePath('columns', { items: [{ title: 'Homes' }, { title: 'A point' }] }), 'items[1].title');
  assert.equal(samplePath('text', { title: 'Our story so far' }), null, 'only the exact words');
  assert.doesNotThrow(() => checkModules([{ ...hero, hidden: true }], { strict: true }));
});

test('needsReload: only a petition or pledge the preview’s data doesn’t hold', () => {
  const data = baseSample.data;
  const pet = (campaign) => ({ id: 'p1', kind: 'petition', props: { campaign } });
  assert.equal(needsReload([pet('c-parks')], data), false);
  assert.equal(needsReload([pet('')], data), false, 'none picked yet');
  assert.equal(needsReload([pet('c-new')], data), true);
  assert.equal(needsReload([{ id: 'e', kind: 'events', props: {} }, { id: 'n', kind: 'news', props: {} }, newModule('hero', 'h1')], data), false, 'live sections are in every page’s data');
  assert.equal(needsReload([pet('c-new')], { campaigns: [{ id: 'c-new' }] }), false, 'a list works too');
  assert.equal(needsReload([], {}), false);
});

// The live preview's inputs, as the browser reads them from the page.
const waOf = (html) => {
  const m = /<script type="application\/json" id="wa-rc">([\s\S]*?)<\/script>/.exec(html);
  return m ? JSON.parse(m[1]) : null;
};
const bodyOf = (html) => /<body>([\s\S]*?)(?:<script type="module"[^>]*><\/script>)?(?:<script type="application\/json" id="wa-rc">|<\/body>)/.exec(html)[1];
const previewOf = (sample, modules, ctx = {}) => renderSite({
  kind: 'page', site: sample.site, page: { ...sample.page, modules }, data: sample.data,
  ctx: { root: '/site/', assets: '/site/site-assets/', path: '/', origin: 'https://example.org', preview: true, islands: false, ...ctx },
});

test('the browser path draws every kind’s markup exactly as the server does, from the same inputs', () => {
  const pages = [
    [baseSample, baseSample.page.modules],
    [imagineSurrey, imagineSurrey.page.modules],
    [baseSample, MODULES.map((d, i) => newModule(d.kind, `kind${String(i).padStart(2, '0')}`))],
  ];
  const kinds = new Set();
  for (const [sample, modules] of pages) {
    const { html } = previewOf(sample, modules);
    const wa = waOf(html);
    assert.ok(wa, 'a preview carries its inputs');
    for (const m of modules) kinds.add(m.kind);
    // Through JSON, as the browser has it: the same body.
    assert.equal(drawBody(wa), bodyOf(html));
    // And section by section, after a change made in the browser only.
    const changed = modules.map((m) => (m.kind === 'text' ? { ...m, props: { ...m.props, title: 'Typed just now' } } : m));
    const server = bodyOf(previewOf(sample, changed).html);
    assert.equal(drawBody(wa, changed), server);
  }
  assert.deepEqual([...kinds].sort(), MODULES.map((m) => m.kind).sort(), 'every kind');
  // An added events section draws the data's events with no reload.
  const events = newModule('events', 'evts0001');
  const { html } = previewOf(baseSample, []);
  const drawn = drawBody(waOf(html), [events]);
  assert.match(drawn, /Sample: volunteer orientation/);
  assert.equal(drawn, bodyOf(previewOf(baseSample, [events]).html));
});

test('the live preview’s inputs and markers: English previews only; the markers only with edit', () => {
  const mods = baseSample.page.modules.slice(0, 3);
  const plain = previewOf(baseSample, mods).html;
  assert.ok(waOf(plain));
  assert.doesNotMatch(plain, /data-wa-/, 'a preview in a new tab: no markers');
  const edit = previewOf(baseSample, mods, { edit: true }).html;
  assert.match(edit, /<html lang="en" data-wa-edit=""/);
  for (const m of mods) assert.match(edit, new RegExp(`id="m-${m.id}" data-wa-section="${m.id}"`));
  assert.equal(markSections(bodyOf(plain)), bodyOf(edit));
  const pub = renderSite({ kind: 'page', site: baseSample.site, page: { ...baseSample.page, modules: mods }, data: baseSample.data, ctx: { root: '/', path: '/', edit: true } }).html;
  assert.doesNotMatch(pub, /data-wa-|id="wa-rc"/, 'never on a public page, whatever ctx says');
});

let mgr;
before(async () => { ({ mgr } = await campaign()); });

test('the builder’s preview link with ?edit=1 marks the sections; the plain link and every public page don’t', async () => {
  const pages = ok(await mgr.get('/api/site')).pages;
  const home = pages.find((p) => p.slug === 'home');
  const { url } = ok(await mgr.post('/api/site/preview-token', { pageId: home.id }));
  const plain = await hit(url);
  assert.equal(plain.status, 200);
  assert.ok(waOf(plain.text), 'the inputs, as data');
  assert.doesNotMatch(plain.text, /data-wa-/);
  const edit = await hit(`${url}&edit=1`);
  assert.equal(edit.status, 200);
  assert.match(edit.text, /data-wa-edit/);
  assert.match(edit.text, /data-wa-section="/);
  assert.match(edit.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  for (const p of pages) {
    const r = await hit(p.slug === 'home' ? '/site/' : `/site/${p.slug}?edit=1`);
    assert.equal(r.status, 200, p.slug);
    assert.doesNotMatch(r.text, /data-wa-|id="wa-rc"/, `${p.slug}: no markers on a public page`);
  }
});

test('a page made from a starter saves as a draft and won’t publish with its sample words', async () => {
  const modules = make('event');
  const { page } = ok(await mgr.action('site.page.create', { title: 'Town hall', modules }));
  assert.equal(page.status, 'draft');
  const r = await mgr.action('site.page.publish', { id: page.id });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /The 1st module \(Hero\): titlePrefix: still has the sample words/);
  const real = modules.map((m) => (m.kind === 'hero' ? { ...m, props: { ...m.props, titlePrefix: 'Town hall, Thursday', text: 'At the library, 7 pm.' } } : m.kind === 'text' ? { ...m, props: { ...m.props, title: 'What happens', body: 'We talk about buses.' } } : m));
  const saved = ok(await mgr.action('site.page.save', { id: page.id, modules: real })).page;
  assert.ok(saved);
  ok(await mgr.action('site.page.publish', { id: page.id }));
});
