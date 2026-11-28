// The website's languages, piece by piece (TR): segments cut the same way
// for sending and drawing, Markdown unchanged in English, text sent safely
// and read back clean, the renderer leaving no English word on a
// translated page, composed headlines drawn whole, names as written (with
// an approved rendering beside them), Traditional made from Simplified.
// No database, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { renderMarkdown, blocksOf, drawBlocks } from '../../shared/markdown.js';
import { segmentsOf, normSeg, moduleSegments, heroSegments, bandSegment } from '../../shared/site/segments.js';
import { MODULES, MODULE_BY_KIND, checkProps } from '../../shared/site/catalogue.js';
import { LEGAL_ENGLISH, LEGAL_KEYS } from '../../shared/site/wording.js';
import { UI_WORDS, translateMessage, fillWords } from '../../shared/site/ui-words.js';
import { prepare, readBack } from '../lib/translate.js';
import { decodeEntities } from '../lib/entities.js';
import { fakeTranslate } from './fake-translate.js';
import { renderSite } from '../ext/site/render/index.js';
import { convertToTraditional } from '../ext/site/translate.js';
import { imagineSurrey, baseSample, samplePost, sampleData } from './site-samples.js';
import { presetFor } from '../lib/preset.js';

// Imagine Surrey's own server (this file does not load the test helper):
// its sample page has a Join form, whose words are its set-up's.
process.env.BASE_BRAND = 'imagine-surrey';

// Every string the seeds hold.
const seedStrings = async () => {
  const dir = new URL('../ext/site/seeds/', import.meta.url);
  const out = new Set();
  const walk = (v) => { if (typeof v === 'string') out.add(v); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  for (const f of readdirSync(dir)) if (f.endsWith('.js')) walk(await import(new URL(f, dir).href));
  // Imagine Surrey's own website as first made (its set-up's, loaded
  // through lib/preset.js as its server loads it): where the long words are.
  walk((await presetFor('imagine-surrey').site.seed()).default({ name: 'Imagine Surrey' }));
  walk((await import(new URL('base.js', dir).href)).default({ name: 'Example Campaign' }));
  return [...out];
};

test('Markdown in English is drawn exactly as before: markdown(x) === drawBlocks(blocksOf(x)) for every seed string', async () => {
  const strs = await seedStrings();
  assert.ok(strs.length > 100);
  for (const s of strs) assert.equal(renderMarkdown(s), drawBlocks(blocksOf(s)));
  // A block that fell back says so on its own element.
  const b = blocksOf('Para one.\n\n- item one\n- item two');
  b[1].items[1].lang = 'en';
  assert.equal(drawBlocks(b), '<p>Para one.</p>\n<ul><li>item one</li><li lang="en">item two</li></ul>');
});

test('segments: one paragraph, one Markdown block, one list item; normalised the same way', () => {
  assert.deepEqual(segmentsOf('textarea', 'One.\n\nTwo  \t words.\n\n\nThree.'), ['One.', 'Two words.', 'Three.']);
  assert.deepEqual(segmentsOf('markdown', '# Head\n\nPara\nline two\n\n- a\n- b\n\n---\n\n> q1\n> q2'), ['Head', 'Para\nline two', 'a', 'b', 'q1\nq2']);
  assert.equal(normSeg(' a  b \n  c '), 'a b\nc');
  assert.deepEqual(heroSegments('We can', ['win', 'lead']), ['We can <b>win</b>', 'We can <b>lead</b>']);
  assert.equal(bandSegment('When we organize,', 'we win'), 'When we organize, <u>we win</u>');
  // Names, handles and amounts never; roles and topics only as labels; check-first marked.
  const donate = moduleSegments('donate', checkProps('donate', { title: 'Give', intro: 'Every dollar counts.', amounts: ['25', '50'] }));
  assert.deepEqual(donate.map((s) => [s.text, s.cls]), [['Give', 'content'], ['Every dollar counts.', 'check-first']]);
  const people = moduleSegments('people', checkProps('people', { title: 'Team', seats: [{ role: 'Chair', name: 'Linda Chen', bio: 'Bio.' }] }));
  assert.ok(!people.some((s) => s.text === 'Linda Chen'));
  // A role is translated for its label; the value posted stays English (modules.js).
  assert.ok(moduleSegments('volunteer', checkProps('volunteer', { roles: ['Knock on doors'] })).some((s) => s.text === 'Knock on doors'));
});

test('sent safely, read back clean: escaped, entities decoded, breaks kept, names and links held', () => {
  const p = prepare('Q&A <3 with Harbour City Together\nsecond line', { names: ['Harbour City Together'] });
  assert.equal(p.q, 'Q&amp;A &lt;3 with <x i="1"/><br i="1"/>second line');
  assert.ok(!p.q.includes('\n'), 'no newline is ever sent');
  const back = readBack(fakeTranslate(p.q, 'pa'), p.held);
  assert.match(back.text, /&/);
  assert.match(back.text, /<3/);
  assert.match(back.text, /Harbour City Together\n/);
  assert.ok(!/&#39;|&amp;|&quot;/.test(back.text));
  const md = prepare('Read **this** at [our site](https://example.org/a(b)).', { kind: 'markdown' });
  assert.match(readBack(fakeTranslate(md.q, 'zh-CN'), md.held).text, /\*\*[^*]+\*\* .*\[[^\]]+\]\(https:\/\/example\.org\/a\(b\)\)/);
  const slot = prepare('One person may give at most {amount} in a year');
  assert.match(readBack(fakeTranslate(slot.q, 'pa'), slot.held).text, /\{amount\}/);
  // A kept name dropped, or changed inside translate="no", or a lost break: a failure, never stored.
  const n = prepare('Vote Linda Chen', { names: ['Linda Chen'] });
  assert.equal(readBack(fakeTranslate(n.q, 'pa', { drop: { contains: 'Vote', what: 'x' } }), n.held).error, 'A kept name came back changed');
  const sp = prepare('Vote Linda Chen', { names: ['Linda Chen'], nameMethod: 'span' });
  assert.equal(readBack(fakeTranslate(sp.q, 'pa', { transliterate: true }), sp.held).error, 'A kept name came back changed');
  const br = prepare('a line\nanother', {});
  assert.equal(readBack(fakeTranslate(br.q, 'pa', { drop: { contains: 'a line', what: 'br' } }), br.held).error, 'A line break came back changed');
  assert.equal(readBack('', br.held).error, 'A line break came back changed');
  assert.equal(readBack('<script>x</script>', prepare('x').held).error, 'Something unexpected came back in the translation');
  assert.equal(readBack('x'.repeat(500), prepare('short').held).error, 'The translation came back far longer than the English');
  assert.equal(decodeEntities('&#39;&quot;&amp;&nbsp;&#x4E2D;&lt;'), '\'"& 中<');
});

test('the server’s answers in the page’s language, slots and all', () => {
  const w = (k, slots) => fillWords(`«${UI_WORDS[k]}»`, slots);
  assert.equal(translateMessage('One person may give at most $1,250 in a year', w), '«One person may give at most $1,250 in a year»');
  assert.equal(translateMessage('Something nobody wrote', w), 'Something nobody wrote');
});

// A table that "translates" everything, so any English left is a word the
// sweep missed.
const fakeTr = (lang, { checked = true, missing = () => false } = {}) => ({
  look: (english, { check } = {}) => {
    const t = normSeg(english);
    if (missing(t) || (check && !checked)) return { text: String(english), lang: 'en', v: 'en:x' };
    // Words become ж…; tags (<b>, <u>) and slots ({amount}) stay.
    const map = t.split(/(<[^>]+>|\{[a-z]+\})/i).map((x, i) => (i % 2 ? x : x.replace(/[A-Za-z][A-Za-z’'.-]*/g, (m) => `ж${m.length}`))).join('');
    return { text: map, lang, v: '11111111-1111-4111-8111-111111111111' };
  },
});
const legalAll = (lang) => ({
  id: '22222222-2222-4222-8222-222222222222', hash: 'abcdefabcdef',
  words: Object.fromEntries(LEGAL_KEYS.map((k) => [k, `ж ${(LEGAL_ENGLISH[k].match(/\{[a-z]+\}/g) || []).join(' ')}`])),
  current: LEGAL_KEYS, slots: { org: 'Harbour City Together', agent: 'Ada Example', contact: '604-555-0100' },
});
const ctxIn = (lang, extra = {}) => ({
  root: '/pa/', path: '/', origin: 'https://example.org', lang, tr: fakeTr(lang), legal: legalAll(lang),
  offered: ['pa', 'zh-Hans', 'zh-Hant'], langRoots: { en: '', pa: '/pa', 'zh-Hans': '/zh', 'zh-Hant': '/zh-hant' }, indexed: [], ...extra,
});
// The words people read: text between tags, and the attributes they hear.
const visible = (html) => {
  // The English "Authorized by" stays in English beside the translated one (B.C.'s rule).
  const body = html.slice(html.indexOf('<body>')).replace(/<p class="footer-authorization" lang="en">[^<]*<\/p>/, '').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<svg[\s\S]*?<\/svg>/g, '');
  const attrs = [...body.matchAll(/\s(?:aria-label|alt|title|placeholder)="([^"]*)"/g)].map((m) => m[1]);
  const text = body.replace(/<[^>]+>/g, '\n').split('\n');
  return [...text, ...attrs].map((s) => s.replace(/&#x27;|&quot;|&amp;|&lt;|&gt;/g, ' ').trim()).filter(Boolean);
};
// What may stay in Latin letters: names kept as written, contact details,
// addresses, numbers, money, the switch's own "English", brands people know.
const ALLOWED = /^(?:Sam|SE|Language|Harbour|City|Together|Imagine Surrey|Ada Example|Ada|Example|English|Google|Outlook|IG|FB|X|TT|IN|TH|BS|YT|WA|MA|Instagram|Bluesky|Facebook|TikTok|LinkedIn|Threads|Street|AM|PM|am|pm|a\.m|p\.m|V3T|A1|AE|CC|Lead|Seat|ж\d*|\$[\d,.]+)$/;
const englishLeft = (html, extra = []) => {
  const left = [];
  for (const s of visible(html)) {
    if (/@|https?:|^\d|^\+?\d/.test(s)) continue;
    // An event's place is an address: as written.
    if (/^(?:· )?(?:Campaign office|Online|Meet at the community centre|Library meeting room)$/.test(s)) continue;
    for (const word of s.match(/[A-Za-z][A-Za-z’'.-]+/g) || []) {
      if (ALLOWED.test(word) || extra.includes(word)) continue;
      left.push(`${word} ← “${s.slice(0, 80)}”`);
    }
  }
  return left;
};

test('no English left on a translated page: every module kind, a post, a petition, the 404', () => {
  // Every kind, at its defaults (with something in each list), besides the samples' rich pages.
  const every = { id: 'all', slug: 'all', title: 'All', modules: MODULES.map((m, i) => ({ id: `all${i}xx`, kind: m.kind, hidden: false, props: {
    ...JSON.parse(JSON.stringify(m.defaults)),
    ...(m.kind === 'image' ? { image: { url: '/media/abc', alt: 'A crowd at the rally' }, caption: 'The rally' } : {}),
    ...(m.kind === 'video' ? { url: 'https://example.org/clip', caption: 'Our clip' } : {}),
    ...(m.kind === 'social' ? { accounts: [{ name: 'Instagram', handle: '@example', url: 'https://instagram.com/example', cta: '' }] } : {}),
    ...(m.kind === 'tracker' ? { items: [{ title: 'A promise', status: 'progress', due: '2027', note: 'Done some.', source: 'https://example.org' }] } : {}),
  } })) };
  const covered = new Set([...every.modules, ...imagineSurrey.page.modules, ...baseSample.page.modules].map((m) => m.kind));
  for (const k of MODULES.map((m) => m.kind)) assert.ok(covered.has(k), `a ${k}`);
  for (const sample of [imagineSurrey, baseSample, { ...baseSample, page: every }]) {
    const data = sampleData(sample.data.campaigns);
    for (const lang of ['pa', 'zh-Hans']) {
      const { html } = renderSite({ kind: 'page', site: sample.site, page: sample.page, data: { ...sample.data, ...data, payments: { ready: true, limit_cents: 125000 } }, ctx: ctxIn(lang) });
      assert.deepEqual(englishLeft(html, sample === imagineSurrey ? ['Imagine', 'Surrey'] : ['Harbour', 'City', 'Together']), [], `${lang} ${sample.site.org.name}`);
      assert.match(html, new RegExp(`<html lang="${lang}"`));
    }
  }
  const post = renderSite({ kind: 'post', site: baseSample.site, post: samplePost, data: baseSample.data, ctx: ctxIn('pa', { path: '/news/x' }) });
  assert.deepEqual(englishLeft(post.html, ['Harbour', 'City', 'Together']), []);
  const c = renderSite({ kind: 'campaign', site: baseSample.site, campaign: { id: 'c1', slug: 'c1', kind: 'petition', title: 'Fix it', excerpt: 'Now.', statement: 'We ask.', body: 'Body.', goal: 10, count: 2, status: 'open' }, data: baseSample.data, ctx: ctxIn('pa') });
  assert.deepEqual(englishLeft(c.html, ['Harbour', 'City', 'Together']), []);
  const nf = renderSite({ kind: 'notFound', site: baseSample.site, data: baseSample.data, ctx: ctxIn('zh-Hans', { path: '/nope' }) });
  assert.deepEqual(englishLeft(nf.html, ['Harbour', 'City', 'Together']), []);
});

test('a fallback shows in English with lang="en" on its own element; check-first shows English until checked', () => {
  const site = baseSample.site;
  const page = { id: 'p', slug: 'about', title: 'About', modules: [
    { id: 'tx0001', kind: 'text', props: { title: 'Untranslated heading', body: 'Translated para.\n\n- untranslated item\n- translated item' } },
    { id: 'qt0001', kind: 'quote', props: { quote: 'A quote from someone.', name: 'Linda Chen', role: 'Neighbour' } },
  ] };
  const { html } = renderSite({ kind: 'page', site, page, data: baseSample.data, ctx: ctxIn('pa', { tr: fakeTr('pa', { checked: false, missing: (t) => /untranslated/i.test(t) }) }) });
  assert.match(html, /<h2 id="m-tx0001-title" class="display" lang="en">Untranslated heading<\/h2>/);
  assert.match(html, /<li lang="en">untranslated item<\/li><li>ж\d+ ж\d+<\/li>/);
  assert.match(html, /<blockquote><p lang="en">A quote from someone\.<\/p><\/blockquote>/, 'a quote waits for a person to check it');
});

test('composed headlines: the band’s underline wherever it lands; the hero’s whole sentences or its prefix', () => {
  const site = baseSample.site;
  const tr = (answer) => ({ look: (e) => { const r = answer(normSeg(e)); return r ? { text: r, lang: 'pa', v: 'v' } : { text: e, lang: 'en', v: 'en:x' }; } });
  const band = { id: 'p', slug: 'x', title: 'X', modules: [{ id: 'band01', kind: 'band', props: { title: 'When we organize,', highlight: 'we win', cta: { label: '', href: '' } } }] };
  const reordered = renderSite({ kind: 'page', site, page: band, data: {}, ctx: ctxIn('pa', { tr: tr((t) => (t === 'When we organize, <u>we win</u>' ? '<u>ਜਿੱਤ</u> ਜਦੋਂ ਅਸੀਂ' : `ਪ ${t}`)) }) });
  assert.match(reordered.html, /<h2 id="m-band01-title" class="display"><span class="underline">ਜਿੱਤ<\/span> ਜਦੋਂ ਅਸੀਂ<\/h2>/);
  const none = renderSite({ kind: 'page', site, page: band, data: {}, ctx: ctxIn('pa', { tr: tr(() => null) }) });
  assert.match(none.html, /<h2 id="m-band01-title" class="display" lang="en">When we organize, <span class="underline">we win<\/span><\/h2>/);

  const hero = { id: 'p', slug: 'x', title: 'X', modules: [{ id: 'hero01', kind: 'hero', props: { titlePrefix: 'Together we', words: ['build', 'grow'], text: '', primaryCta: { label: '', href: '' }, secondaryCtas: [] } }] };
  const propsOf = (html) => JSON.parse(/data-island-props="i-hero01-words"[^>]*>([^<]+)</.exec(html)[1]);
  const same = renderSite({ kind: 'page', site, page: hero, data: {}, ctx: ctxIn('zh-Hans', { tr: tr((t) => t.replace('Together we', '我们一起').replace('build', '建设').replace('grow', '成长')) }) });
  assert.deepEqual([propsOf(same.html).prefix, propsOf(same.html).words], ['我们一起', ['建设', '成长']]);
  const differ = renderSite({ kind: 'page', site, page: hero, data: {}, ctx: ctxIn('zh-Hans', { tr: tr((t) => (t.includes('build') ? '我们 <b>建设</b> 一起' : '<b>成长</b> 我们')) }) });
  assert.deepEqual([propsOf(differ.html).prefix, propsOf(differ.html).words], ['', ['我们 建设 一起', '成长 我们']]);
  const missing = renderSite({ kind: 'page', site, page: hero, data: {}, ctx: ctxIn('zh-Hans', { tr: tr((t) => (t.includes('build') ? '我们 <b>建设</b>' : null)) }) });
  assert.equal(propsOf(missing.html).lang, 'en');
  assert.deepEqual(propsOf(missing.html).words, ['build', 'grow']);
});

test('names: as written, with an approved rendering beside them only where a manager gave one', () => {
  const site = baseSample.site;
  const page = { id: 'p', slug: 'x', title: 'X', modules: [{ id: 'tx0001', kind: 'text', props: { title: 'Meet Linda Chen and Sam Example', body: '' } }] };
  const tr = { look: (e) => ({ text: `认识 ${normSeg(e).replace(/^Meet /, '')}`, lang: 'zh-Hans', v: 'v' }) };
  const zh = renderSite({ kind: 'page', site, page, data: {}, ctx: ctxIn('zh-Hans', { tr, names: { 'Linda Chen': '陳美玲' } }) });
  assert.match(zh.html, /认识 Linda Chen（陳美玲） and Sam Example/);
  const pa = renderSite({ kind: 'page', site, page, data: {}, ctx: ctxIn('pa', { tr: { look: (e) => ({ text: normSeg(e), lang: 'pa', v: 'v' }) }, names: { 'Linda Chen': 'ਲਿੰਡਾ ਚੇਨ' } }) });
  assert.match(pa.html, /Meet Linda Chen \(ਲਿੰਡਾ ਚੇਨ\) and Sam Example/);
  const en = renderSite({ kind: 'page', site, page, data: {}, ctx: { root: '/', path: '/', names: { 'Linda Chen': '陳美玲' } } });
  assert.match(en.html, /Meet Linda Chen and Sam Example/);
});

test('islands carry their words in their props; English pages carry none', () => {
  const { html } = renderSite({ kind: 'page', site: imagineSurrey.site, page: imagineSurrey.page, data: { ...imagineSurrey.data, payments: { ready: true, limit_cents: 125000 } }, ctx: ctxIn('pa') });
  const islands = [...html.matchAll(/data-island-props="([^"]+)"[^>]*>([^<]+)</g)].map((m) => [m[1], JSON.parse(m[2])]);
  const menu = islands.find(([id]) => id === 'i-menu')[1];
  assert.match(menu.label, /^ж/);
  for (const [id, props] of islands) {
    if (id === 'i-menu') continue;
    assert.ok(props.w && Object.keys(props.w).length, `${id} has its words`);
    for (const v of Object.values(props.w)) assert.ok(!/^[A-Z][a-z]+ [a-z]+/.test(v), `${id}: ${v}`);
  }
  const en = renderSite({ kind: 'page', site: imagineSurrey.site, page: imagineSurrey.page, data: imagineSurrey.data, ctx: { root: '/', path: '/' } });
  assert.ok(!/"w":\{/.test(en.html));
});

test('Traditional is converted from Simplified (Taiwan character forms, no phrase swaps)', async () => {
  assert.equal(await convertToTraditional('汉语简体发展参与软件'), '漢語簡體發展參與軟件');
  assert.equal(await convertToTraditional('Harbour City Together 选举'), 'Harbour City Together 選舉');
});

test('the Traditional dictionary loads only when Traditional is made, never at start-up', () => {
  // About 80 MB once loaded: a campaign that never turns 繁體 on never pays it.
  const probe = `import { registerHooks } from 'node:module';
    registerHooks({ resolve(spec, ctx, next) { if (spec.includes('opencc')) console.log('LOADED ' + spec); return next(spec, ctx); } });
    await import(${JSON.stringify(new URL('../ext/site/index.js', import.meta.url).href)});
    console.log('IMPORTED');`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8', env: { ...process.env, BASE_DATA: 'memory' }, timeout: 60000 });
  assert.match(r.stdout, /IMPORTED/, r.stderr.slice(0, 500));
  assert.doesNotMatch(r.stdout, /LOADED/, 'importing the website does not load the dictionary');
});

test('every module kind’s fields say whether they are translated', () => {
  for (const m of MODULES) for (const f of m.fields) {
    if (['text', 'textarea', 'markdown', 'words'].includes(f.type) && f.translate !== undefined) {
      assert.ok([false, 'label', 'check-first', 'composed'].includes(f.translate), `${m.kind}.${f.key}`);
    }
  }
  assert.equal(MODULE_BY_KIND.quote.fields.find((f) => f.key === 'name').translate, false);
  assert.equal(MODULE_BY_KIND.donate.fields.find((f) => f.key === 'amounts').translate, false);
});
