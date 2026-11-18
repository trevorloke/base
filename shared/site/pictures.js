// Pictures on a page or a post, and their descriptions (WA decision 26).
// A picture added or replaced since the last publish must say what it
// shows (or be ticked Decorative) before it goes on the site; one already
// on the site without words doesn't block, it's counted so the desk can
// ask for them. "Already on the site" means its address appears somewhere
// in what was published.
//   knownPictures(published)          every address in published content (a Set)
//   picturesIn(fields, props)         [{ path, url, alt, decorative, md }] —
//                                     image fields and Markdown ![words](url)
//   newUndescribed(fields, props, known) the first picture new since publish
//                                     with no description, or null
//   olderUndescribed(fields, props, known) how many published ones have none
//   mdPictures(text)                  [{ alt, url }] in Markdown
//   summaryFrom(body)                 a post's short summary until one is typed
// fields: a catalogue module's (MODULE_BY_KIND[kind].fields) or POST_FIELDS.

import { markdownText } from '../markdown.js';

const MD_IMG = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

export const mdPictures = (text) => [...String(text ?? '').matchAll(MD_IMG)].map((m) => ({ alt: m[1].trim(), url: m[2] }));

export function knownPictures(published) {
  const out = new Set();
  const walk = (v) => {
    if (typeof v === 'string') {
      out.add(v.trim());
      for (const p of mdPictures(v)) out.add(p.url);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(published);
  return out;
}

// The pictures of any field list (a module's, or a post's own fields).
export function picturesIn(fields, props) {
  const out = [];
  const walk = (list, o, prefix) => {
    for (const f of list) {
      const v = o?.[f.key];
      const path = `${prefix}${f.key}`;
      if (f.type === 'image' && v && typeof v === 'object' && String(v.url || '').trim()) {
        out.push({ path: `${path}.alt`, url: String(v.url).trim(), alt: String(v.alt || '').trim(), decorative: v.decorative === true, md: false });
      } else if (f.type === 'markdown') {
        // "picture" is the word the editor's Picture button selects for
        // typing over: left as it is, it says nothing.
        for (const p of mdPictures(v)) out.push({ path, url: p.url, alt: p.alt.toLowerCase() === 'picture' ? '' : p.alt, decorative: false, md: true });
      } else if (f.type === 'list' && Array.isArray(v)) {
        v.forEach((item, i) => walk(f.of, item, `${path}[${i}].`));
      }
    }
  };
  walk(fields, props, '');
  return out;
}

const missing = (p) => !p.alt && !p.decorative;
const has = (known, url) => (known instanceof Set ? known.has(url) : Boolean(known?.has?.(url)));

export function newUndescribed(fields, props, known) {
  return picturesIn(fields, props).find((p) => missing(p) && !has(known, p.url)) || null;
}
export function olderUndescribed(fields, props, known) {
  return picturesIn(fields, props).filter((p) => missing(p) && has(known, p.url)).length;
}

// The words for a picture with none (the catalogue's problem text).
export const describeWords = (p) => (p.md ? 'a picture in it has no description' : 'describe the picture for people who can’t see it');

// A post's fields, as the catalogue would list them (its picture and body).
export const POST_FIELDS = [{ key: 'image', type: 'image' }, { key: 'body', type: 'markdown' }];

// A post's short summary, made from its words: the first 160 characters.
// The desk fills the box with this while it is empty or still holds what
// the words before made (nobody has typed in it).
export const summaryFrom = (body) => markdownText(body, 160);
