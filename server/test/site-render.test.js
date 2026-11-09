// The website renderer (server/ext/site/render, shared/site/components):
// every module kind with its defaults and with rich props, in both skins;
// everything a visitor or an admin typed escaped (XSS in text, Markdown,
// links, pictures, settings, data and island props); Markdown sanitized;
// the page, post, campaign, not-found and preview templates; the head (SEO,
// Open Graph, theme); the islands' markup; the forms' exact field names
// (SITE.md); the plain-post thank-you and errors; payments not set up; the
// site's own files (site.css, fonts, the island script).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSite, readSiteAsset, siteAssetFile } from '../ext/site/render/index.js';
import { MODULES, newModule, checkModules } from '../../shared/site/catalogue.js';
import { checkTheme, themeCss, themeColors, contrast, SKINS, COLOR_KEYS, PAIRS } from '../../shared/site/theme.js';
import { ISLANDS } from '../../shared/site/components/islands.js';
import { linkFor, safeUrl, locFrom, imageFor } from '../../shared/site/components/links.js';
import { shareLinks, withSource, money, parseDollars, jsonForScript, when } from '../../shared/site/components/util.js';
import { videoEmbed } from '../../shared/site/components/modules.js';
import { imagineSurrey, baseSample, samplePost, sampleData } from './site-samples.js';

const SKIN_NAMES = ['base', 'imagine-surrey'];
const site = (skin = 'base', extra = {}) => ({ theme: { skin }, org: { name: 'Example Campaign', email: 'hello@example.org' }, ...extra });
const data = baseSample.data;
const page = (modules, extra = {}) => ({ id: 'page-1', slug: 'about', title: 'About', description: 'About us.', modules, ...extra });
const render = ({ modules = [], skin = 'base', ctx = {}, siteExtra = {}, dataOver = data, pageExtra = {} } = {}) => renderSite({
  kind: 'page', site: site(skin, siteExtra), page: page(modules, pageExtra), data: dataOver, ctx: { root: '/', path: '/about', ...ctx },
});
const mod = (kind, id, props) => ({ id, kind, hidden: false, props });

// Island props from the page: { [id]: { name, props } }.
function islands(html) {
  const out = {};
  for (const m of html.matchAll(/<div class="island" data-island="([a-z]+)" id="([^"]+)">/g)) out[m[2]] = { name: m[1] };
  for (const m of html.matchAll(/<script type="application\/json" data-island-props="([^"]+)">([\s\S]*?)<\/script>/g)) {
    if (out[m[1]]) out[m[1]].props = JSON.parse(m[2]);
  }
  return out;
}
// The names a form in the page posts (inputs, selects, textareas).
function formNames(html, moduleId) {
  const section = new RegExp(`id="m-${moduleId}"[\\s\\S]*?</section>`).exec(html)?.[0] || '';
  const forms = [...section.matchAll(/<form[\s\S]*?<\/form>/g)].map((m) => m[0]);
  return forms.map((f) => new Set([...f.matchAll(/<(?:input|select|textarea)\b[^>]*?\bname="([^"]+)"/g)].map((m) => m[1])));
}

// SITE.md "Form fields": every name a form may send.
const ALLOWED = new Set(['first_name', 'last_name', 'email', 'phone', 'postal_code', 'consent_email', 'consent_sms', 'website', 'client_key', 'ref', 'page_id', 'module_id', 'source',
  'campaign', 'comment', 'roles', 'availability', 'note', 'shift_id', 'topic', 'message', 'address', 'city', 'birth_date', 'citizenship', 'declaration', 'term', 'amount_cents', 'cadence', 'slate']);

test('every module kind renders with its defaults, in both skins', () => {
  for (const skin of SKIN_NAMES) {
    for (const m of MODULES) {
      const instance = newModule(m.kind, `def-${m.kind}`);
      const { status, html } = render({ modules: [instance], skin });
      assert.equal(status, 200, `${skin} ${m.kind}`);
      assert.ok(html.includes(`data-module="${m.kind}" id="m-def-${m.kind}"`), `${skin} ${m.kind}: data-module and id`);
    }
  }
});

test('the sample sites render every module with rich props, in both skins', () => {
  for (const sample of [imagineSurrey, baseSample]) {
    for (const skin of SKIN_NAMES) {
      checkModules(sample.page.modules, { strict: true }); // the samples are valid pages
      const { status, html } = renderSite({ kind: 'page', site: { ...sample.site, theme: { ...sample.site.theme, skin } }, page: sample.page, data: sample.data, ctx: { root: '/', path: '/', origin: 'https://example.org' } });
      assert.equal(status, 200);
      for (const m of sample.page.modules) assert.ok(html.includes(`data-module="${m.kind}" id="m-${m.id}"`), `${skin} ${m.kind}`);
      assert.equal((html.match(/<h1[ >]/g) || []).length, 1, 'one h1: the hero headline');
      assert.ok(!/<section[^>]*data-module="hero"[^>]*>[\s\S]*?<h2/.test(html.split('</section>')[0]), 'the first hero has no h2 of its own');
    }
  }
});

test('hidden modules and unknown kinds are not drawn', () => {
  const { html } = render({ modules: [{ ...newModule('text', 'shown1'), props: { title: 'Shown', body: '', cta: {}, tone: 'paper' } }, { ...newModule('text', 'gone01'), hidden: true }, { id: 'odd001', kind: 'no-such-kind', props: {} }] });
  assert.ok(html.includes('id="m-shown1"'));
  assert.ok(!html.includes('m-gone01'));
  assert.ok(!html.includes('m-odd001'));
});

const XSS = '<script>alert(1)</script>"><img src=x onerror=alert(1)>';
const BAD_LINKS = ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>alert(1)</script>', '//evil.example/x', '/\t/evil.example', '\\\\evil.example', 'vbscript:x', ' javascript:alert(1)'];
const MD = `${XSS}\n\n[click](javascript:alert(1)) [ok](/about) ![pic](javascript:alert(1)) <a href="javascript:alert(1)">raw</a>\n\n<iframe src=//evil.example></iframe>`;

function hostileProps(kind) {
  const def = MODULES.find((m) => m.kind === kind);
  const out = {};
  for (const f of def.fields) {
    switch (f.type) {
      case 'text': case 'textarea': out[f.key] = XSS; break;
      case 'markdown': out[f.key] = MD; break;
      case 'url': out[f.key] = BAD_LINKS[0]; break;
      case 'link': out[f.key] = { label: XSS, href: BAD_LINKS[0] }; break;
      case 'image': out[f.key] = { url: BAD_LINKS[0], alt: XSS }; break;
      case 'words': out[f.key] = [XSS, '100']; break;
      case 'list': out[f.key] = BAD_LINKS.map((href, i) => Object.fromEntries(f.of.map((s) => [s.key, s.type === 'url' ? href : s.type === 'image' ? { url: href, alt: XSS } : s.type === 'markdown' ? MD : s.type === 'select' ? s.options[i % s.options.length].value : `${XSS} ${i}`]))).slice(0, f.max || 8); break;
      case 'campaign': out[f.key] = 'c-evil'; break;
      default: break;
    }
  }
  return out;
}
const assertClean = (html, where) => {
  assert.ok(!/<script>alert/i.test(html), `${where}: a script tag got through`);
  assert.ok(!/<img src=x/i.test(html), `${where}: a raw img got through`);
  // An event handler on a real tag (typed text shows them escaped, as words,
  // and inside an attribute's quoted value they are just letters).
  const handlers = [...html.matchAll(/<[a-z][^<>]*>/gi)].map((m) => m[0].replace(/"[^"]*"/g, '""')).filter((tag) => /\son[a-z]+\s*=/i.test(tag));
  assert.deepEqual(handlers, [], `${where}: an event handler attribute got through`);
  assert.ok(!/(href|src|action|poster|formaction)="\s*(javascript|vbscript|data):/i.test(html), `${where}: an unsafe link`);
  assert.ok(!/(href|src)="\/\/evil/i.test(html), `${where}: a protocol-relative link`);
  assert.ok(!/(href|src)="[^"]*\\/.test(html), `${where}: a backslash link`);
  assert.ok(!/<iframe src=\/\/evil/i.test(html), `${where}: an iframe got through`);
  assert.ok(!/<\/script><script>/i.test(html), `${where}: island props broke out of their script`);
};

test('everything typed is escaped: XSS in text, Markdown, links and pictures of every module kind', () => {
  const evilData = {
    ...data,
    posts: [{ slug: 'p1', title: XSS, excerpt: XSS, image: { url: BAD_LINKS[0], alt: XSS }, published_at: '2026-11-01T00:00:00Z' }],
    events: [{ id: 'e1', title: XSS, starts_at: '2026-12-01T18:00:00Z', ends_at: '2026-12-01T20:00:00Z', location: XSS, spots_left: 3, lat: 49.1, lng: -122.8 }],
    shifts: [{ id: '"><script>alert(1)</script>', title: XSS, starts_at: '2026-12-02T18:00:00Z', location: XSS, spots_left: 1 }],
    campaigns: { 'c-evil': { id: 'c-evil', slug: '"><script>', kind: 'petition', title: XSS, excerpt: XSS, statement: XSS, goal: 10, count: 3, status: 'open' } },
    roles: [XSS],
  };
  for (const skin of SKIN_NAMES) {
    const modules = MODULES.map((m) => ({ id: `x-${m.kind}`, kind: m.kind, hidden: false, props: hostileProps(m.kind) }));
    const { status, html } = render({ modules, skin, dataOver: evilData });
    assert.equal(status, 200);
    for (const m of modules) assert.ok(html.includes(`data-module="${m.kind}" id="m-x-${m.kind}"`), `${m.kind} still drawn`);
    assertClean(html, skin);
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'the text is shown, escaped');
    // Island props are JSON with < > & escaped, so text can't close the script.
    for (const { props } of Object.values(islands(html))) assert.ok(props, 'island props parse');
    assert.ok(html.includes('\\u003cscript\\u003ealert(1)\\u003c/script\\u003e'));
  }
});

test('the site settings are escaped too: org, nav, announcement, footer, SEO, social, logo', () => {
  const evilSite = {
    theme: { skin: 'imagine-surrey', logo: { url: 'javascript:alert(1)', alt: XSS } },
    org: { name: XSS, email: 'a@example.org"><script>alert(1)</script>', phone: XSS, address: XSS, authorization: XSS, privacy_url: 'javascript:alert(1)' },
    nav: { items: [{ label: XSS, href: 'javascript:alert(1)' }, { label: XSS, href: '/ok' }], cta: { label: XSS, href: '//evil.example' } },
    announcement: { enabled: true, text: XSS, link: { label: XSS, href: 'javascript:alert(1)' } },
    footer: { acknowledgement: MD, links: [{ label: XSS, href: 'data:text/html,x' }] },
    seo: { title: XSS, description: XSS, image: { url: 'javascript:alert(1)', alt: XSS } },
    social: [{ name: XSS, handle: XSS, url: 'javascript:alert(1)' }, { name: 'Ok', handle: XSS, url: 'https://example.org/ok' }],
  };
  for (const kind of ['page', 'post', 'campaign', 'notFound']) {
    const { html } = renderSite({ kind, site: evilSite, page: page([newModule('hero', 'hero01')], { title: XSS, description: XSS }), post: { ...samplePost, title: XSS, excerpt: XSS, body: MD }, campaign: { id: 'c1', slug: 'c1', kind: 'pledge', title: XSS, excerpt: XSS, statement: XSS, body: MD, goal: 5, count: 1, status: 'open' }, data, ctx: { root: '/', path: '/', origin: 'https://example.org', preview: true } });
    assertClean(html, kind);
    const head = html.split('</head>')[0];
    assert.ok(!head.includes('<script>alert'), `${kind}: head escaped`);
    assert.ok(head.includes('&lt;script&gt;'), `${kind}: the title is there, escaped`);
  }
});

test('Markdown is sanitized and its site links follow the site root', () => {
  const { html } = render({ ctx: { root: '/site/', path: '/about' }, modules: [mod('text', 'md0001', { title: 'T', body: '**Bold** and *it*. [About](/about) · [Out](https://example.org/x) · [Mail](mailto:a@example.org) · [Bad](javascript:alert(1))\n\n- one\n- two\n\n![Pic](/media/abc123)', cta: { label: '', href: '' }, tone: 'paper' })] });
  const body = /id="m-md0001"[\s\S]*?<\/section>/.exec(html)[0];
  assert.match(body, /<strong>Bold<\/strong>/);
  assert.match(body, /<em>it<\/em>/);
  assert.match(body, /<a href="\/site\/about">About<\/a>/);
  assert.match(body, /<a href="https:\/\/example\.org\/x" rel="noopener">Out<\/a>/);
  assert.match(body, /<a href="mailto:a@example\.org">Mail<\/a>/);
  assert.ok(!/href="javascript/.test(body) && body.includes('Bad'), 'the bad link is plain words');
  assert.match(body, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(body, /<img src="\/media\/abc123" alt="Pic" loading="lazy" decoding="async">/);
});

test('links: the catalogue’s safe-url rule, stricter, and under the site root', () => {
  const loc = locFrom({ root: '/site/' });
  assert.equal(linkFor(loc, '/donate'), '/site/donate');
  assert.equal(linkFor(loc, '/#m-join'), '/site/#m-join');
  assert.equal(linkFor(loc, '#m-join'), '#m-join');
  assert.equal(linkFor(loc, '/media/abc'), '/media/abc');
  assert.equal(linkFor(loc, '/site-assets/img/a.jpg'), '/site/site-assets/img/a.jpg');
  assert.equal(linkFor(loc, 'https://example.org/a?b=1'), 'https://example.org/a?b=1');
  assert.equal(linkFor(loc, 'mailto:a@example.org'), 'mailto:a@example.org');
  assert.equal(linkFor(loc, 'tel:+16045550100'), 'tel:+16045550100');
  for (const bad of BAD_LINKS) assert.equal(linkFor(loc, bad), null, JSON.stringify(bad));
  assert.equal(safeUrl('https://'), null);
  assert.equal(imageFor(loc, 'http://insecure.example/a.jpg'), null, 'pictures only over https');
  assert.equal(imageFor(loc, 'mailto:a@example.org'), null);
  assert.equal(linkFor(locFrom({}), '/donate'), '/donate', 'on the campaign’s domain the root is /');
  assert.deepEqual(locFrom({ root: '/site/', path: '/site/news/a' }), { root: '/site/', assets: '/site/site-assets/', origin: '', path: '/news/a' });
  assert.equal(locFrom({ origin: 'javascript:alert(1)' }).origin, '');
  // Under BASE_PATH the address in front of the root has the client's path.
  assert.equal(locFrom({ origin: 'https://base.win/imaginesurrey/' }).origin, 'https://base.win/imaginesurrey');
  const based = renderSite({ kind: 'post', site: baseSample.site, post: samplePost, data, ctx: { root: '/site/', path: '/news/sample-post-one', origin: 'https://base.win/imaginesurrey' } });
  assert.match(based.html, /<link rel="canonical" href="https:\/\/base\.win\/imaginesurrey\/site\/news\/sample-post-one">/);
  const share = Object.values(islands(based.html)).find((i) => i.name === 'share').props;
  assert.equal(share.url, 'https://base.win/imaginesurrey/site/news/sample-post-one');
  assert.equal(share.here, '/site/news/sample-post-one');
});

test('the head: title, description, canonical, Open Graph, theme, fonts, stylesheet', () => {
  const { html } = renderSite({ kind: 'page', site: imagineSurrey.site, page: imagineSurrey.page, data: imagineSurrey.data, ctx: { root: '/', path: '/', origin: 'https://imaginesurrey.ca' } });
  const head = html.split('</head>')[0];
  assert.match(head, /<title>Imagine Surrey<\/title>/);
  assert.match(head, /<meta name="description" content="Imagine Surrey is residents organizing/);
  assert.match(head, /<link rel="canonical" href="https:\/\/imaginesurrey\.ca\/">/);
  assert.match(head, /<meta property="og:image" content="https:\/\/imaginesurrey\.ca\/media\/members-rally">/);
  assert.match(head, /<meta property="og:title" content="Imagine Surrey">/);
  assert.match(head, /<meta name="twitter:card" content="summary_large_image">/);
  assert.match(head, /<link rel="preload" href="\/site-assets\/fonts\/montserrat-latin\.woff2" as="font" type="font\/woff2" crossorigin>/);
  assert.match(head, /<link rel="stylesheet" href="\/site-assets\/site\.css\?v=[a-f0-9]{12}">/);
  assert.ok(head.includes(`<style>${themeCss(imagineSurrey.site.theme)}</style>`));
  assert.match(head, /<script type="application\/ld\+json">\{"@context":"https:\/\/schema\.org","@type":"Organization","name":"Imagine Surrey"/);
  assert.match(html, /<html lang="en" data-skin="imagine-surrey" data-heading="montserrat" data-body="montserrat">/);
  assert.ok(!head.includes('noindex'));
  // The hero picture is preloaded (it is the first thing seen), in the head.
  assert.match(head, /<link rel="preload" as="image" href="\/media\/hero-park"\/>/);
  // A page other than home: "Title · Site".
  const about = render({ modules: [newModule('text', 'about1')] });
  assert.match(about.html, /<title>About · Example Campaign<\/title>/);
});

test('templates: post, campaign, not found, preview', () => {
  const ctx = { root: '/', path: '/news/sample-post-one', origin: 'https://example.org' };
  const post = renderSite({ kind: 'post', site: baseSample.site, post: samplePost, data, ctx });
  assert.equal(post.status, 200);
  assert.match(post.html, /<meta property="og:type" content="article">/);
  assert.match(post.html, /<meta property="article:published_time" content="2026-11-02T17:00:00Z">/);
  assert.match(post.html, /<h1 class="display">Sample post: what the news module shows<\/h1>/);
  assert.match(post.html, /<p class="eyebrow eyebrow--accent">November 2, 2026<\/p>/);
  assert.match(post.html, /data-island="share"/);
  assert.match(post.html, /<a class="text-link" href="\/news">← All news<\/a>/);

  const camp = renderSite({ kind: 'campaign', site: imagineSurrey.site, campaign: imagineSurrey.campaign, data: imagineSurrey.data, ctx: { root: '/', path: '/act/skytrain-south-surrey', origin: 'https://imaginesurrey.ca' } });
  assert.equal(camp.status, 200);
  assert.match(camp.html, /id="m-campaign" data-template="campaign"/);
  assert.match(camp.html, /<form class="site-form form-card"[^>]*action="\/api\/forms\/petition" method="post"/);
  assert.match(camp.html, /<input type="hidden" name="campaign" value="c-skytrain"\/>/);
  assert.match(camp.html, /<input type="hidden" name="module_id" value="campaign"\/>/);
  assert.match(camp.html, /<progress class="goal-bar" max="2500" value="842" aria-label="842 of 2,500"><\/progress>/);
  assert.match(camp.html, /<blockquote class="act-statement">/);
  const share = Object.values(islands(camp.html)).find((i) => i.name === 'share');
  assert.equal(share.props.url, 'https://imaginesurrey.ca/act/skytrain-south-surrey');
  const closed = renderSite({ kind: 'campaign', site: imagineSurrey.site, campaign: { ...imagineSurrey.campaign, status: 'closed' }, data: imagineSurrey.data, ctx: {} });
  assert.match(closed.html, /This petition is closed\./);
  assert.ok(!closed.html.includes('api/forms/petition'));

  const nf = renderSite({ kind: 'notFound', site: baseSample.site, data, ctx: { root: '/site/' } });
  assert.equal(nf.status, 404);
  assert.match(nf.html, /<meta name="robots" content="noindex">/);
  assert.match(nf.html, /<a class="text-link" href="\/site\/">Home page<\/a>/);
  assert.equal(renderSite({ kind: 'page', site: baseSample.site, page: null, data, ctx: {} }).status, 404, 'no page → not found');
  assert.equal(renderSite({ kind: 'nonsense', site: baseSample.site, data, ctx: {} }).status, 404);

  const preview = renderSite({ kind: 'page', site: baseSample.site, page: baseSample.page, data, ctx: { preview: true, origin: 'https://example.org' } });
  assert.match(preview.html, /<div class="preview-banner" role="note">/);
  assert.match(preview.html, /<meta name="robots" content="noindex">/);
  assert.ok(!preview.html.includes('rel="canonical"'), 'a draft has no canonical');
});

test('a site_pages row as it is: published, or the draft in a preview', () => {
  const row = { id: 'row1', slug: 'about', status: 'published',
    published: { title: 'Published title', description: 'Live.', modules: [mod('text', 'live01', { title: 'Live words', body: '', cta: {}, tone: 'paper' })] },
    draft: { title: 'Draft title', description: 'Not yet.', modules: [mod('text', 'draft1', { title: 'Draft words', body: '', cta: {}, tone: 'paper' })] } };
  const live = renderSite({ kind: 'page', site: site(), page: row, data, ctx: {} });
  assert.match(live.html, /<h1 class="display">Published title<\/h1>/);
  assert.ok(live.html.includes('id="m-live01"') && !live.html.includes('m-draft1'));
  assert.match(live.html, /<input type="hidden" name="page_id"|data-module="text" id="m-live01"/);
  const preview = renderSite({ kind: 'page', site: site(), page: row, data, ctx: { preview: true } });
  assert.match(preview.html, /<h1 class="display">Draft title<\/h1>/);
  assert.ok(preview.html.includes('id="m-draft1"') && !preview.html.includes('m-live01'));
});

test('a page whose first module isn’t a hero gets the page head (one h1)', () => {
  const { html } = render({ modules: [mod('text', 'txt001', { title: 'Hello', body: 'Body', cta: {}, tone: 'paper' })] });
  assert.match(html, /<section class="section tone-brand on-dark page-head">[\s\S]*?<h1 class="display">About<\/h1>[\s\S]*?<p class="lede">About us\.<\/p>/);
  assert.equal((html.match(/<h1[ >]/g) || []).length, 1);
  assert.match(html, /<h2 id="m-txt001-title" class="display">Hello<\/h2>/);
});

test('the shell: skip link, announcement, header with logo, Donate and Menu, footer', () => {
  const { html } = renderSite({ kind: 'page', site: baseSample.site, page: baseSample.page, data, ctx: { root: '/site/', path: '/' } });
  assert.match(html, /<body><a class="skip-link" href="#main">Skip to content<\/a>/);
  assert.match(html, /<div class="announcement" role="region" aria-label="Announcement">[\s\S]*?Sample announcement[\s\S]*?<a class="announcement-link" href="\/site\/#m-events">Save your seat<\/a>/);
  assert.match(html, /<a class="logo-link" href="\/site\/" aria-current="page"><span class="wordmark">Harbour City Together<\/span><\/a>/);
  assert.match(html, /<a class="btn btn--action nav-cta" href="\/site\/donate">Donate<\/a>/);
  assert.match(html, /<a class="nav-link nav-bar-link" href="\/site\/plan">Our plan<\/a>/);
  assert.match(html, /data-island="menu"/);
  assert.match(html, /<main id="main" tabindex="-1">/);
  assert.match(html, /<footer class="site-footer">[\s\S]*?unceded territory of the <strong>sample nations<\/strong>[\s\S]*?Authorized by Ada Example/);
  assert.match(html, /<a class="social" href="https:\/\/www\.instagram\.com\/example" rel="noopener noreferrer" aria-label="Harbour City Together on Instagram" title="Instagram">IG<\/a>/);
  const menu = Object.values(islands(html)).find((i) => i.name === 'menu');
  assert.deepEqual(menu.props.items.map((i) => i.href), ['/site/plan', '/site/about', '/site/volunteer', '/site/news']);
  // The theme's logo when there is one.
  const is = renderSite({ kind: 'page', site: imagineSurrey.site, page: imagineSurrey.page, data: imagineSurrey.data, ctx: {} });
  assert.match(is.html, /<img class="logo" src="\/media\/is-logo" alt="Imagine Surrey" height="56" decoding="async"\/>/);
  // No Donate button when the nav says so.
  const none = render({ siteExtra: { nav: { items: [], cta: null } }, modules: [newModule('text', 'nocta1')] });
  assert.ok(!none.html.includes('nav-cta'));
  assert.ok(!none.html.includes('data-island="menu"'), 'no pages, no Menu');
});

test('islands: markup and props for each, the same ids, and the script only where needed', () => {
  const { html } = renderSite({ kind: 'page', site: baseSample.site, page: baseSample.page, data, ctx: { root: '/', path: '/', islands: true } });
  const found = islands(html);
  const names = new Set(Object.values(found).map((i) => i.name));
  for (const n of ['form', 'words', 'menu', 'openings']) assert.ok(names.has(n), n);
  for (const [id, i] of Object.entries(found)) {
    assert.ok(ISLANDS[i.name], `${i.name} is a known island`);
    assert.ok(i.props && i.props.uid && `i-${i.props.uid}` === id, `${id}: props with its uid`);
  }
  assert.match(html, /<script type="module" src="\/site-assets\/site-islands\.js(\?v=[a-f0-9]+)?"><\/script><\/body>/);
  // A page with only the Menu loads no script; islands: false never does.
  const plain = render({ modules: [mod('text', 'plain1', { title: 'Plain', body: 'Words.', cta: {}, tone: 'paper' })], ctx: { islands: true }, siteExtra: { nav: { items: [{ label: 'About', href: '/about' }] } } });
  assert.ok(plain.html.includes('data-island="menu"') && !plain.html.includes('<script type="module"'));
  const off = renderSite({ kind: 'page', site: baseSample.site, page: baseSample.page, data, ctx: { islands: false } });
  assert.ok(!off.html.includes('<script type="module"'));
  const custom = renderSite({ kind: 'page', site: baseSample.site, page: baseSample.page, data, ctx: { islands: '/assets/x.js' } });
  assert.match(custom.html, /<script type="module" src="\/assets\/x\.js"><\/script>/);
  // JSON that can't close its script tag.
  assert.equal(jsonForScript({ t: '</script><b>&\u2028' }), '{"t":"\\u003c/script\\u003e\\u003cb\\u003e\\u0026\\u2028"}');
});

test('forms: they post to {root}api/forms/<kind> with SITE.md’s field names, exactly', () => {
  const { html } = renderSite({ kind: 'page', site: baseSample.site, page: baseSample.page, data, ctx: { root: '/site/', path: '/' } });
  const expect = {
    newsletter: ['first_name', 'email', 'phone', 'consent_sms', 'consent_email', 'website', 'page_id', 'module_id'],
    pledge: ['first_name', 'last_name', 'email', 'postal_code', 'phone', 'comment', 'consent_email', 'consent_sms', 'campaign', 'website', 'page_id', 'module_id'],
    volunteer: ['first_name', 'last_name', 'email', 'phone', 'postal_code', 'roles', 'availability', 'note', 'consent_email', 'consent_sms', 'website', 'page_id', 'module_id'],
    contact: ['first_name', 'last_name', 'email', 'phone', 'topic', 'message', 'consent_email', 'website', 'page_id', 'module_id'],
    join: ['first_name', 'last_name', 'email', 'phone', 'address', 'city', 'postal_code', 'birth_date', 'citizenship', 'term', 'amount_cents', 'declaration', 'consent_email', 'consent_sms', 'website', 'page_id', 'module_id'],
    donate: ['cadence', 'amount_cents', 'first_name', 'last_name', 'email', 'phone', 'address', 'city', 'postal_code', 'declaration', 'consent_email', 'consent_sms', 'website', 'page_id', 'module_id'],
  };
  const moduleOf = { newsletter: 'newsletter', pledge: 'pledge', volunteer: 'volunteer', contact: 'contact', join: 'join', donate: 'donate' };
  for (const [kind, names] of Object.entries(expect)) {
    const [form] = formNames(html, moduleOf[kind]);
    assert.ok(form, `${kind}: a form`);
    assert.deepEqual([...form].sort(), [...names].sort(), kind);
    for (const n of form) assert.ok(ALLOWED.has(n), `${kind}: ${n} is in SITE.md`);
    assert.match(html, new RegExp(`action="/site/api/forms/${kind}" method="post"`), `${kind}: action`);
  }
  // RSVPs: one small form per opening, with its shift.
  const rsvps = formNames(html, 'openings');
  assert.ok(rsvps.length >= 2);
  for (const f of rsvps) assert.deepEqual([...f].sort(), ['email', 'first_name', 'module_id', 'page_id', 'phone', 'shift_id', 'website']);
  assert.match(html, /action="\/site\/api\/forms\/rsvp" method="post"/);
  assert.match(html, /<input type="hidden" name="shift_id" value="shift-1"\/>/);
  // Tick boxes send "true"; none is ticked for the person.
  assert.ok(!/<input type="checkbox"[^>]*checked/.test(html));
  for (const m of html.matchAll(/<input type="checkbox"[^>]*name="(consent_email|consent_sms|declaration)"[^>]*>/g)) assert.match(m[0], /value="true"/);
  // Newsletter: consent to email is the form itself (said beside the button).
  assert.match(html, /<input type="hidden" name="consent_email" value="true"\/>/);
  assert.match(html, /By signing up you agree to get email from Harbour City Together/);
  // The island props say the same as the markup.
  const nl = Object.values(islands(html)).find((i) => i.props?.kind === 'newsletter').props;
  assert.equal(nl.action, '/site/api/forms/newsletter');
  assert.equal(nl.impliedConsent, 'consent_email');
  assert.deepEqual(nl.hidden, { page_id: 'page-base-home', module_id: 'newsletter', ref: '', source: '' });
  // No client_key in the HTML: the browser makes one per form (pages may be cached).
  assert.ok(!html.includes('name="client_key"'));
});

test('forms carry the referral and share source the server hands over', () => {
  const { html } = render({ modules: [newModule('newsletter', 'nl0001')], ctx: { referral: 'ABCD2345', source: 'share-whatsapp' } });
  assert.match(html, /<input type="hidden" name="ref" value="ABCD2345"\/>/);
  assert.match(html, /<input type="hidden" name="source" value="share-whatsapp"\/>/);
});

test('donate: suggested amounts never above the limit; monthly; payments not set up', () => {
  const dataLow = { ...data, payments: { ready: true, limit_cents: 12000, monthly_max_cents: 1000 } };
  const donate = mod('donate', 'give01', { title: 'Give', intro: '', text: '', amounts: ['25', '50', '100', '250', '$1,000'], allowMonthly: true, monthlyNote: 'Monthly helps.', clubNote: '' });
  const { html } = render({ modules: [donate], dataOver: dataLow });
  const props = Object.values(islands(html)).find((i) => i.props?.kind === 'donate').props;
  assert.deepEqual(props.amount.presets, [2500, 5000, 10000], 'nothing above $120');
  assert.equal(props.amount.limit, 12000);
  assert.equal(props.amount.monthlyMax, 1000);
  assert.equal(props.amount.defaultCents, 5000);
  assert.equal(props.amount.monthly, true);
  assert.match(html, /<input type="radio" id="give01-form-amt-5000" name="amount_cents" checked="" value="5000"\/>/);
  assert.match(html, /The most anyone can give in a year is \$120\./);
  assert.match(html, /<input type="radio" id="give01-form-cadence-monthly" name="cadence" value="monthly"\/>/);
  const once = render({ modules: [{ ...donate, props: { ...donate.props, allowMonthly: false } }] });
  assert.match(once.html, /<input type="hidden" name="cadence" value="once"\/>/, 'once only: cadence still sent');
  const off = render({ modules: [donate, newModule('join', 'join01')], dataOver: { ...data, payments: { ready: false, limit_cents: 0 } } });
  assert.match(off.html, /Online giving isn’t set up yet\./);
  assert.match(off.html, /Online membership isn’t set up yet\./);
  assert.ok(!off.html.includes('api/forms/donate') && !off.html.includes('api/forms/join'));
  assert.match(off.html, /To give now, email <a href="mailto:hello@example\.org">hello@example\.org<\/a>\./);
});

test('after a plain form post: the thank-you, or the error on its field', () => {
  const modules = [newModule('newsletter', 'news01'), newModule('contact', 'cont01')];
  const sent = render({ modules, ctx: { sent: 'newsletter' } });
  assert.match(sent.html, /id="m-news01"[\s\S]*?<div class="success-card" role="status" tabindex="-1"><h3 class="success-card__title">You’re on the list<\/h3>/);
  assert.ok(!/id="m-news01"[^]*?<form/.test(sent.html.split('id="m-cont01"')[0]), 'no newsletter form');
  assert.ok(sent.html.includes('action="/api/forms/contact"'), 'the other form is still there');
  const err = render({ modules, ctx: { error: { field: 'email', module_id: 'cont01' } } });
  const contact = /id="m-cont01"[\s\S]*?<\/section>/.exec(err.html)[0];
  assert.match(contact, /aria-invalid="true" aria-describedby="cont01-form-email-error"/);
  assert.match(contact, /<p class="field-error" id="cont01-form-email-error"><span class="visually-hidden">Error: <\/span>Enter your email address \(or a phone number\)<\/p>/);
  assert.match(contact, /<div class="form-alert" role="alert">Please check the highlighted field\.<\/div>/);
  assert.ok(!/field-error/.test(/id="m-news01"[\s\S]*?<\/section>/.exec(err.html)[0]), 'only the form it came from');
  // A plain ?error=<field> marks every form with that field.
  const plain = render({ modules, ctx: { error: 'message' } });
  assert.match(plain.html, /Write your message/);
  // ?sent=rsvp on a page with openings.
  const rsvp = renderSite({ kind: 'page', site: baseSample.site, page: baseSample.page, data, ctx: { sent: 'rsvp' } });
  assert.match(rsvp.html, /<p class="rsvp-done rsvp-done--page" role="status">/);
});

test('petition module: the campaign from data, statement, goal, closed and missing', () => {
  const p = mod('petition', 'pet001', { campaign: 'c-parks', eyebrow: '', tone: 'brand' });
  const { html } = render({ modules: [p] });
  assert.match(html, /class="section tone-brand on-dark petition petition--dark"/);
  assert.match(html, /<p class="eyebrow">The pledge<\/p>/);
  assert.match(html, /<blockquote class="statement"><p>I pledge to stand up for the Harbourside pool/);
  assert.match(html, /<progress class="goal-bar" max="500" value="312"/);
  const form = Object.values(islands(html)).find((i) => i.props?.kind === 'pledge').props;
  assert.equal(form.thanks.share.url, '/act/keep-the-pool-open');
  assert.equal(form.hidden.campaign, 'c-parks');
  const missing = render({ modules: [{ ...p, props: { ...p.props, campaign: 'nope' } }] });
  assert.match(missing.html, /This petition isn’t available any more\./);
});

test('openings and events: dates in the campaign’s time zone, spots, full, map links', () => {
  // A summer date: Pacific time is UTC−7 then, whatever the time-zone data says about winters.
  const ev = { id: 'e1', title: 'Canvass', starts_at: '2026-07-11T17:00:00Z', ends_at: '2026-07-11T19:00:00Z', location: 'Office', spots_left: 0, lat: 49.19, lng: -122.85 };
  const { html } = render({ modules: [newModule('shifts', 'shift1')], dataOver: { ...data, shifts: [ev, { ...ev, id: 'e2', spots_left: 2 }] } });
  const props = Object.values(islands(html)).find((i) => i.name === 'openings').props;
  assert.equal(props.items[0].date, 'Saturday, July 11');
  assert.equal(props.items[0].time.replace(/[\u00a0\u2009\u202f]/g, ' '), '10:00 a.m.–12:00 p.m.');
  assert.equal(props.items[0].day, '11');
  assert.equal(props.items[0].mon, 'Jul');
  assert.equal(props.items[0].full, true);
  assert.equal(props.items[1].spots, '2 spots left');
  assert.equal(props.items[1].low, true);
  assert.match(props.items[0].map, /^https:\/\/www\.openstreetmap\.org\/\?mlat=49\.19000&mlon=-122\.85000/);
  assert.match(html, /This one is full\./);
  assert.deepEqual(when('not a date'), null);
  const none = render({ modules: [newModule('shifts', 'shift2'), newModule('events', 'event2')], dataOver: { ...data, events: [], shifts: [] } });
  assert.match(none.html, /No openings right now\./);
  assert.match(none.html, /New events are on the way/);
});

test('video: YouTube and Vimeo play from their privacy-friendly hosts; anything else is a link', () => {
  assert.deepEqual(videoEmbed('https://www.youtube.com/watch?v=M7lc1UVf-VE'), { src: 'https://www.youtube-nocookie.com/embed/M7lc1UVf-VE', provider: 'YouTube' });
  assert.deepEqual(videoEmbed('https://youtu.be/M7lc1UVf-VE'), { src: 'https://www.youtube-nocookie.com/embed/M7lc1UVf-VE', provider: 'YouTube' });
  assert.deepEqual(videoEmbed('https://vimeo.com/76979871'), { src: 'https://player.vimeo.com/video/76979871?dnt=1', provider: 'Vimeo' });
  assert.equal(videoEmbed('https://example.org/video.mp4'), null);
  const { html } = render({ modules: [mod('video', 'vid001', { title: 'Watch', url: 'https://youtu.be/M7lc1UVf-VE', caption: 'A talk' })] });
  assert.match(html, /<iframe src="https:\/\/www\.youtube-nocookie\.com\/embed\/M7lc1UVf-VE" title="Watch" loading="lazy"/);
});

test('pictures are lazy with a width and height (the hero, at the top, is not lazy)', () => {
  const { html } = renderSite({ kind: 'page', site: imagineSurrey.site, page: imagineSurrey.page, data: imagineSurrey.data, ctx: {} });
  const imgs = [...html.matchAll(/<img [^>]*>/g)].map((m) => m[0]).filter((t) => !t.includes('class="logo"'));
  assert.ok(imgs.length >= 2);
  for (const tag of imgs) {
    assert.match(tag, /width="\d+"/, tag);
    assert.match(tag, /height="\d+"/, tag);
    if (tag.includes('hero-image')) assert.ok(!tag.includes('loading='), 'the hero picture loads at once');
    else assert.match(tag, /loading="lazy"/, tag);
  }
});

test('share links: WhatsApp first, each tagged ?source=share-<channel>', () => {
  const links = shareLinks({ url: 'https://example.org/act/x?source=old#top', text: 'Sign this', subject: 'Sign' });
  assert.deepEqual(Object.keys(links), ['whatsapp', 'sms', 'facebook', 'x', 'email', 'copy']);
  assert.equal(links.whatsapp, `https://wa.me/?text=${encodeURIComponent('Sign this https://example.org/act/x?source=share-whatsapp#top')}`);
  assert.ok(links.sms.startsWith('sms:?&body=') && decodeURIComponent(links.sms).includes('source=share-sms'));
  assert.ok(decodeURIComponent(links.facebook).includes('source=share-facebook'));
  assert.ok(decodeURIComponent(links.x).includes('source=share-x'));
  assert.ok(links.email.startsWith('mailto:?subject=Sign&body=') && decodeURIComponent(links.email).includes('source=share-email'));
  assert.equal(links.copy, 'https://example.org/act/x?source=share-copy#top');
  assert.equal(withSource('/a?b=1&source=x', 'y'), '/a?b=1&source=y');
});

test('money: whole dollars plainly, cents when there are some; typed amounts', () => {
  assert.equal(money(5000), '$50');
  assert.equal(money(142970), '$1,429.70');
  assert.equal(money(100000000), '$1,000,000');
  assert.equal(parseDollars('$1,000'), 100000);
  assert.equal(parseDollars('25.5'), 2550);
  assert.equal(parseDollars('abc'), null);
});

test('theme: the action colour and the heading shadow are additive; derived colours stay readable', () => {
  assert.ok(COLOR_KEYS.includes('action') && COLOR_KEYS.includes('actionInk'));
  assert.ok(PAIRS.some((p) => p.fg === 'actionInk' && p.bg === 'action'));
  for (const skin of SKIN_NAMES) {
    const { theme, problems } = checkTheme({ skin });
    assert.deepEqual(problems, [], skin);
    const c = themeColors(theme);
    assert.ok(contrast(c.muted, c.paper) >= 4.5 && contrast(c.muted, c.surface) >= 4.5, `${skin}: muted text`);
    assert.ok(contrast(c.fieldLine, c.paper) >= 3, `${skin}: field borders`);
    assert.ok(contrast(c.brandSoft, c.brand) >= 4.5, `${skin}: soft text on brand`);
    assert.ok(contrast(c.brandInk, c.brandDeep) >= 4.5, `${skin}: footer text`);
    assert.ok(contrast(c.danger, c.paper) >= 4.5, `${skin}: errors`);
    assert.ok(contrast(c.accentOnBrand, c.brand) >= 4.5 && contrast(c.headingOnAccent, c.accent) >= 4.5, `${skin}: highlights`);
  }
  assert.equal(checkTheme({ skin: 'imagine-surrey' }).theme.colors.action, '#d81b1e');
  assert.equal(checkTheme({ skin: 'imagine-surrey' }).theme.pop, true);
  assert.equal(checkTheme({ skin: 'base' }).theme.pop, false);
  // A theme saved before the action colour existed: it follows a changed brand.
  assert.equal(checkTheme({ skin: 'base', colors: { brand: '#0a7d55' } }).theme.colors.action, '#0a7d55');
  assert.equal(checkTheme({ skin: 'imagine-surrey', colors: { ...SKINS['imagine-surrey'].colors, action: undefined } }).theme.colors.action, '#d81b1e');
  // A dark page: the derived colours flip and still read.
  const dark = themeColors({ skin: 'base', colors: { paper: '#111318', ink: '#f5f5f5', surface: '#1c1f26', link: '#9db4ff' } });
  assert.ok(contrast(dark.muted, '#111318') >= 4.5 && contrast(dark.danger, '#111318') >= 4.5);
  const css = themeCss({ skin: 'imagine-surrey' });
  assert.match(css, /--action:#d81b1e;--action-ink:#ffffff;/);
  assert.match(css, /--pop:#d81b1e;--pop-alt:#002957\}/);
  assert.match(themeCss({ skin: 'base' }), /--pop:transparent;--pop-alt:transparent\}/);
  assert.ok(checkTheme({ skin: 'base', colors: { action: '#ffff00', actionInk: '#ffffff' } }).problems.some((p) => p.pair.fg === 'actionInk'));
});

test('the site’s own files: site.css, the fonts, the island script; nothing else', () => {
  const css = readSiteAsset('site.css');
  assert.equal(css.type, 'text/css; charset=utf-8');
  assert.match(String(css.body), /--action/);
  assert.equal(css.cache, 'public, max-age=300');
  const v = /site\.css\?v=([a-f0-9]+)/.exec(render().html)[1];
  assert.equal(readSiteAsset(`site.css?v=${v}`).cache, 'public, max-age=31536000, immutable');
  for (const f of ['montserrat-latin', 'inter-latin', 'inter-latin-ext', 'barlow-condensed-600-latin', 'barlow-condensed-700-latin-ext', 'barlow-condensed-800-latin']) {
    const a = readSiteAsset(`fonts/${f}.woff2`);
    assert.ok(a && a.type === 'font/woff2' && a.body.length > 5000, f);
  }
  for (const bad of ['../package.json', 'fonts/../site.css', '/etc/passwd', 'fonts/x.ttf', 'site.js', '']) assert.equal(readSiteAsset(bad), null, bad);
  assert.match(siteAssetFile('site-islands.js'), /web\/dist\/site-islands\.js$/);
  // Every face the stylesheet names is there.
  for (const m of String(css.body).matchAll(/url\("fonts\/([^"]+)"\)/g)) assert.ok(readSiteAsset(`fonts/${m[1]}`), m[1]);
});

test('odd shapes never stop a page: objects for text, strings for lists, junk data and settings', () => {
  const odd = MODULES.map((m) => ({ id: `odd-${m.kind}`, kind: m.kind, props: Object.fromEntries(m.fields.map((f) => [f.key, f.type === 'list' || f.type === 'words' ? 'not a list' : { not: 'text' }])) }));
  const junkData = { posts: [{ slug: {}, title: [] }, 'x'], events: 'x', shifts: [{ id: 1, title: { a: 1 } }], counts: 'x', campaigns: { a: 'x', b: { title: { x: 1 }, slug: 2 } }, payments: 'x', roles: [1, {}, 'Driver'] };
  const junkSite = { theme: 'x', nav: 'x', footer: [], announcement: 5, seo: 5, org: [], social: 'x' };
  for (const kind of ['page', 'post', 'campaign', 'notFound']) {
    const r = renderSite({ kind, site: junkSite, page: { id: {}, slug: [], title: {}, description: 5, modules: odd }, post: { title: {}, body: [], image: 'x' }, campaign: { title: [], kind: 'x', statement: {}, goal: 'x' }, data: junkData, ctx: { root: 5, path: {}, sent: 7, error: [] } });
    assert.ok(r.status === 200 || r.status === 404, kind);
    assert.match(r.html, /<\/html>$/);
    if (kind === 'page') for (const m of odd) assert.ok(r.html.includes(`data-module="${m.kind}" id="m-odd-${m.kind}"`), m.kind);
  }
});

test('the sample data helper gives upcoming events', () => {
  const d = sampleData({});
  assert.ok(d.events.every((e) => new Date(e.starts_at) > new Date()));
});
