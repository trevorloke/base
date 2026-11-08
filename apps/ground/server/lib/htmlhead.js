// What the server writes into the app's index.html before sending it — the
// one place for it. Each tag goes in right after <head>, before anything that
// loads a file, so <base href> already applies to the manifest, the icons
// and the built scripts (Vite builds with base './').
//
//   <base href="${BASE_PATH}/">         every relative address resolves under the prefix
//   window.__BASE_PATH__="${BASE_PATH}" the browser's one helper reads it (web/src/paths.js)
//
// headTags({ db }) → the tags as one string. More tags go in the marked list
// below (the brand's CSS variables, say): each part is a string, or a promise
// of one; an empty string adds nothing.
import { basePath } from './basepath.js';
import { brandHead } from './brand.js';

const attr = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
// A string inside <script>: JSON, with < escaped so "</script>" can't end it.
const jsString = (s) => JSON.stringify(String(s)).replace(/[<\u2028\u2029]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);

export const baseTags = (base = basePath()) =>
  `<base href="${attr(`${base}/`)}"><script>window.__BASE_PATH__=${jsString(base)}</script>`;

export const headTags = async ({ db } = {}) => {
  const parts = [
    baseTags(),
    // ── More head tags go here, one entry each (a string or a promise of one). ──
    // The campaign's look as CSS custom properties (lib/brand.js), so the app
    // never flashes the default look. `html:root` outranks app.css wherever
    // the tag sits.
    db ? brandHead(db) : '',
  ];
  return (await Promise.all(parts)).join('');
};

// index.html with the tags in: right after the opening <head> (or at the top
// when a build has none).
export const injectHead = (html, tags) => {
  const at = /<head(\s[^>]*)?>/i.exec(html);
  if (!at) return tags + html;
  const end = at.index + at[0].length;
  return html.slice(0, end) + tags + html.slice(end);
};
