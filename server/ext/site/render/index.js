// Placeholder renderer — the real one (React + htm components from
// shared/site/components, islands, the site stylesheet) replaces this file.
// It keeps the contract in SITE.md so the site server can be built and
// tested on its own: renderSite(...) → { status, html }, every module's
// outer element marked data-module="<kind>" id="m-<id>".
import { themeCss } from '@starbase/shared/site/theme';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function renderSite({ kind, site, page, post, campaign, ctx = {} }) {
  const title = kind === 'post' ? post?.title : kind === 'campaign' ? campaign?.title : kind === 'notFound' ? 'Not found' : page?.title;
  const modules = kind === 'page' ? (page?.modules || []).filter((m) => !m.hidden) : [];
  const body = kind === 'notFound'
    ? '<main><h1>Not found</h1></main>'
    : `<main>${kind === 'page' ? '' : `<h1>${esc(title)}</h1>`}${modules.map((m) => `<section data-module="${esc(m.kind)}" id="m-${esc(m.id)}"><h2>${esc(m.props?.title || m.props?.titlePrefix || m.kind)}</h2></section>`).join('')}</main>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title || site?.seo?.title || '')}</title>${ctx.preview ? '<meta name="robots" content="noindex">' : ''}<style>${themeCss(site?.theme)}</style></head><body>${body}</body></html>`;
  return { status: kind === 'notFound' ? 404 : 200, html };
}
