// The builder's live preview (WA decisions 20–21), shared by the server
// (server/ext/site/render) and the preview's script (web/src/site-preview.js),
// so a section drawn in the browser is the section the server draws.
//
//   drawBody(wa, modules)   the page's <body> markup from the renderer's own
//                           inputs (`wa` = { kind, site, page, data, ctx }),
//                           with `modules` in place of the page's: the same
//                           renderContext and the same components
//   markSections(html)      each section of the page marked with
//                           data-wa-section="<its id>" (tap to edit: only on
//                           the builder's own preview, never a public page)
//   waInputs(input)         what the server puts in <script id="wa-rc">: the
//                           renderer's inputs, without anything that isn't data
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { renderContext } from './context.js';
import { SiteBody } from './templates.js';
import { withFallbacks } from './lang.js';

export function drawBody(wa, modules) {
  const page = wa.page && modules ? { ...wa.page, modules } : wa.page;
  const rc = renderContext({ kind: wa.kind, site: wa.site, page, data: wa.data, ctx: wa.ctx });
  const body = withFallbacks(rc.enShown, () => renderToString(createElement(SiteBody, { rc, kind: wa.kind, page })));
  // React writes resource hints first; on the server they go in <head>.
  const hints = /^(?:<link [^>]*\/?>)+/.exec(body)?.[0] || '';
  return body.slice(hints.length);
}

export const markSections = (html) => String(html).replace(
  /<section data-module="([A-Za-z0-9_-]+)" id="m-([A-Za-z0-9_-]+)"/g,
  '<section data-module="$1" id="m-$2" data-wa-section="$2"',
);

// JSON keeps the data; functions and the like stay behind.
export const waInputs = ({ kind, site, page, data, ctx }) => JSON.parse(JSON.stringify({ kind, site, page, data, ctx }));
