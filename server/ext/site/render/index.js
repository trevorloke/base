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
//              source, origin, timeZone }
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { themeCss } from '../../../../shared/site/theme.js';
import { renderContext } from '../../../../shared/site/components/context.js';
import { SiteBody, headFor } from '../../../../shared/site/components/templates.js';
import { jsonForScript } from '../../../../shared/site/components/util.js';
import { assetUrl, islandsBuilt } from './assets.js';

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

export function renderSite({ kind = 'page', site, page, post, campaign, data, ctx = {} } = {}) {
  let k = KINDS.has(kind) ? kind : 'notFound';
  if ((k === 'page' && !page) || (k === 'post' && !post) || (k === 'campaign' && !campaign)) k = 'notFound';
  const rc = renderContext({ kind: k, site, page, post, campaign, data, ctx });
  let body = renderToString(createElement(SiteBody, { rc, kind: k, page, post, campaign }));
  // React writes its resource hints (preloads for pictures at the top of the
  // page) first; they belong in <head>.
  const hints = /^(?:<link [^>]*\/?>)+/.exec(body)?.[0] || '';
  body = body.slice(hints.length);
  const head = headFor(rc, { kind: k, page, post, campaign });
  const t = rc.site.theme;
  // The island script only where it does something people need (a form, a
  // share sheet, sign-ups, the rotating words); the Menu alone works
  // without it, so a plain page loads no JavaScript.
  const script = / data-island="(?!menu")/.test(body) ? islandScript(ctx, rc.loc) : null;
  const meta = (name, content) => (content ? `<meta name="${name}" content="${esc(content)}">` : '');
  const prop = (name, content) => (content ? `<meta property="${name}" content="${esc(content)}">` : '');
  const ogTitle = head.title.replace(/ · [^·]*$/, '') || head.title;
  const html = '<!doctype html>'
    + `<html lang="en" data-skin="${esc(t.skin)}" data-heading="${esc(t.fonts.heading)}" data-body="${esc(t.fonts.body)}">`
    + '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
    + `<title>${esc(head.title)}</title>`
    + meta('description', head.description)
    + (head.noindex ? '<meta name="robots" content="noindex">' : '')
    + (head.canonical ? `<link rel="canonical" href="${esc(head.canonical)}">` : '')
    + prop('og:type', head.type) + prop('og:site_name', head.siteName) + prop('og:title', ogTitle) + prop('og:description', head.description)
    + (head.canonical ? prop('og:url', head.canonical) : '')
    + (head.image ? prop('og:image', head.image.url) + prop('og:image:alt', head.image.alt) : '')
    + prop('og:locale', 'en_CA')
    + (head.published ? prop('article:published_time', head.published) : '')
    + meta('twitter:card', head.image ? 'summary_large_image' : 'summary')
    + meta('theme-color', head.themeColor)
    + head.fonts.map((f) => `<link rel="preload" href="${esc(f)}" as="font" type="font/woff2" crossorigin>`).join('')
    + `<link rel="stylesheet" href="${esc(assetUrl(rc.loc.assets, 'site.css'))}">`
    + `<style>${themeCss(t)}</style>`
    + hints
    + `<script type="application/ld+json">${jsonForScript(head.organization)}</script>`
    + '</head>'
    + `<body>${body}${script ? `<script type="module" src="${esc(script)}"></script>` : ''}</body></html>`;
  return { status: k === 'notFound' ? 404 : 200, html };
}
