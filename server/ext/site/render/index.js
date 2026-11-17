// The website's renderer: renderSite(...) → { status, html } — see SITE.md
// "Rendering". The page itself is React (shared/site/components, written
// with htm so Node runs it as it is) rendered to a string; the <head> is
// written here: title, description, canonical, Open Graph, the theme's CSS
// variables, the site's stylesheet and fonts. Interactive parts are islands
// that web/src/site-islands.js hydrates; without that script (tests, an old
// browser, a blocked script) every form still posts and every link works.
//
//   kind     'page' | 'post' | 'campaign' | 'notFound'
//   site     { theme, nav, footer, announcement, seo, org, social }
//   data     { posts, events, counts, campaigns, payments, roles }
//   ctx      { root, assets, islands, preview, path, sent, error, referral,
//              source, origin, timeZone } — and on a translated page (TR):
//              lang, tr (the language's words), legal (the approved legal
//              words), names (approved renderings), offered, langRoots
//              (each language's root), indexed (languages search may list),
//              checkFirst (show only checked words)
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { themeCss } from '../../../../shared/site/theme.js';
import { renderContext } from '../../../../shared/site/components/context.js';
import { SiteBody, headFor } from '../../../../shared/site/components/templates.js';
import { jsonForScript, str } from '../../../../shared/site/components/util.js';
import { withFallbacks } from '../../../../shared/site/components/lang.js';
import { propsFor } from '../../../../shared/site/components/modules.js';
import { moduleSegments } from '../../../../shared/site/segments.js';
import { LANG_BY_CODE } from '../../../../shared/site/languages.js';
import { assetUrl, islandsBuilt } from './assets.js';

// The switch's slide from one language to the next (TR): cross-document
// view transitions, only on a website that draws the switch, and never for
// someone who asked for less motion.
const VIEW_TRANSITION = '@media (prefers-reduced-motion: no-preference){@view-transition{navigation:auto}}';

export { readSiteAsset, siteAssetFile, islandsBuilt, assetUrl } from './assets.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const KINDS = new Set(['page', 'post', 'campaign', 'notFound']);

// Where the island script comes from: ctx.islands as a path or URL, true for
// the built file under the assets path, false for none; left out, the built
// file when there is one.
function islandScript(ctx, loc) {
  const v = ctx?.islands;
  if (v === false || v === null) return null;
  if (typeof v === 'string' && /^(\/(?!\/)|https:\/\/)[^\s"'<>\\]*$/.test(v)) return v;
  if (v === true || (v === undefined && islandsBuilt())) return assetUrl(loc.assets, 'site-islands.js');
  return null;
}

// A page is { id, slug, title, description, modules }; a site_pages row as
// it is ({ …, draft, published }) works too — the draft in a preview.
function pageOf(page, preview) {
  if (!page || typeof page !== 'object' || Array.isArray(page.modules)) return page;
  const content = preview ? page.draft || page.published : page.published || page.draft;
  if (!content || typeof content !== 'object') return page;
  return { ...page, title: content.title ?? page.title, description: content.description ?? page.description, image: content.image ?? page.image, modules: content.modules };
}

export function renderSite({ kind = 'page', site, page: rawPage, post, campaign, data, ctx = {} } = {}) {
  const page = pageOf(rawPage, Boolean(ctx?.preview));
  let k = KINDS.has(kind) ? kind : 'notFound';
  if ((k === 'page' && !page) || (k === 'post' && !post) || (k === 'campaign' && !campaign)) k = 'notFound';
  const rc = renderContext({ kind: k, site, page, post, campaign, data, ctx });
  // A translated page: its title and the like in its language; the privacy
  // policy in English (with a line saying so) until every word is checked.
  let pg = page;
  if (rc.lang !== 'en' && k === 'page' && page) {
    if (isPolicyPage(rc, page) && !allChecked(rc, page)) { rc.setEnglishPage(true); rc.policyEnglish = true; }
    pg = { ...page, title: rc.tt(page.title), description: rc.tt(page.description), image: page.image ? { ...page.image, alt: rc.tt(page.image.alt) } : page.image };
  }
  const thePost = rc.lang !== 'en' ? rc.post : post;
  const theCampaign = rc.lang !== 'en' ? rc.campaign : campaign;
  let body = withFallbacks(rc.enShown, () => renderToString(createElement(SiteBody, { rc, kind: k, page: pg, post: thePost, campaign: theCampaign })));
  // React writes its resource hints (preloads for pictures at the top of the
  // page) first; they belong in <head>.
  const hints = /^(?:<link [^>]*\/?>)+/.exec(body)?.[0] || '';
  body = body.slice(hints.length);
  const head = headFor(rc, { kind: k, page: pg, post: thePost, campaign: theCampaign });
  const L = LANG_BY_CODE[rc.lang] || LANG_BY_CODE.en;
  // Each language's address of this page, for search engines (only the
  // languages they may list, and English as the default).
  const indexed = Array.isArray(ctx?.indexed) ? ctx.indexed : [];
  const roots = rc.langs.roots;
  const alternates = rc.langs.offered.length && head.canonical && rc.loc.origin
    ? [['en', roots.en], ...rc.langs.offered.filter((c) => indexed.includes(c)).map((c) => [c, roots[c]]), ['x-default', roots.en]]
      .filter(([, r]) => typeof r === 'string')
      .map(([code, r]) => `<link rel="alternate" hreflang="${esc(code)}" href="${esc(`${rc.loc.origin}${r}${rc.loc.path}`)}">`).join('')
    : '';
  const noindex = head.noindex || rc.embed || (rc.lang !== 'en' && !indexed.includes(rc.lang));
  const t = rc.site.theme;
  // The island script only where it does something people need (a form, a
  // share sheet, sign-ups, the rotating words); the Menu alone works
  // without it, so a plain page loads no JavaScript.
  const script = / data-island="(?!menu")/.test(body) ? islandScript(ctx, rc.loc) : null;
  const meta = (name, content) => (content ? `<meta name="${name}" content="${esc(content)}">` : '');
  const prop = (name, content) => (content ? `<meta property="${name}" content="${esc(content)}">` : '');
  const ogTitle = head.title.replace(/ · [^·]*$/, '') || head.title;
  const html = '<!doctype html>'
    + `<html lang="${esc(rc.lang)}" data-skin="${esc(t.skin)}" data-heading="${esc(t.fonts.heading)}" data-body="${esc(t.fonts.body)}">`
    + '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
    + `<title>${esc(head.title)}</title>`
    // The voter guide in another website's frame: its links open in the
    // framing window (Directions say otherwise, in a new tab).
    + (rc.embed ? '<base target="_top">' : '')
    + meta('description', head.description)
    + (noindex ? '<meta name="robots" content="noindex">' : '')
    + (head.canonical ? `<link rel="canonical" href="${esc(head.canonical)}">` : '')
    + alternates
    + prop('og:type', head.type) + prop('og:site_name', head.siteName) + prop('og:title', ogTitle) + prop('og:description', head.description)
    + (head.canonical ? prop('og:url', head.canonical) : '')
    + (head.image ? prop('og:image', head.image.url) + prop('og:image:alt', head.image.alt) : '')
    + prop('og:locale', L.og)
    + (head.published ? prop('article:published_time', head.published) : '')
    + meta('twitter:card', head.image ? 'summary_large_image' : 'summary')
    + meta('theme-color', head.themeColor)
    + (rc.site.icon ? `<link rel="icon" href="${esc(rc.img(rc.site.icon.icon))}" type="image/png"><link rel="apple-touch-icon" href="${esc(rc.img(rc.site.icon.touch))}">` : '')
    + head.fonts.map((f) => `<link rel="preload" href="${esc(f)}" as="font" type="font/woff2" crossorigin>`).join('')
    + `<link rel="stylesheet" href="${esc(assetUrl(rc.loc.assets, 'site.css'))}">`
    + (/ class="(?:vote-banner|vg-embed)"| data-module="voterguide"/.test(body) ? `<link rel="stylesheet" href="${esc(assetUrl(rc.loc.assets, 'voteguide.css'))}">` : '')
    + `<style>${themeCss(t)}${rc.langs.offered.length ? VIEW_TRANSITION : ''}</style>`
    + hints
    + `<script type="application/ld+json">${jsonForScript(head.organization)}</script>`
    + '</head>'
    + `<body>${body}${script ? `<script type="module" src="${esc(script)}"></script>` : ''}</body></html>`;
  return { status: k === 'notFound' ? 404 : 200, html };
}

// The page whose address is the privacy policy (Settings → Organization).
const isPolicyPage = (rc, page) => {
  const href = str(rc.site.org.privacy).trim();
  const slug = /^\/([a-z0-9-]+)\/?$/.exec(href)?.[1];
  return Boolean(slug && slug === page.slug);
};
const allChecked = (rc, page) => {
  const texts = [page.title, page.description];
  for (const m of page.modules || []) if (m && !m.hidden) for (const sg of moduleSegments(m.kind, propsFor(m))) texts.push(sg.text);
  return texts.filter((t) => str(t).trim()).every((t) => rc.t(t, { check: true }).lang !== 'en');
};
