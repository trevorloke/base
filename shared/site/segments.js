// How the website's words are cut for translation (TR decision 10): the
// unit is the segment — a heading, one paragraph, one Markdown block, one
// list item — never a page or a whole field, so a one-word fix in one
// paragraph sends only that paragraph again and keeps every correction
// to the others. One function cuts a field the same way for the collector
// (server/ext/site/translate.js, what is sent) and the renderer (what is
// looked up), so both always agree.
import { MODULE_BY_KIND } from './catalogue.js';
import { paragraphs } from './components/util.js';
import { blocksOf } from '../markdown.js';

const s = (v) => (typeof v === 'string' ? v : '');

// The form a segment is kept under (its hash is of this): Unicode NFC,
// runs of spaces and tabs as one space, each line trimmed, line breaks
// kept, the whole trimmed.
export const normSeg = (v) => s(v).normalize('NFC').replace(/\r\n?/g, '\n').replace(/[ \t ]+/g, ' ')
  .split('\n').map((l) => l.trim()).join('\n').trim();

// A Markdown block's words as typed (a paragraph's or a quote's lines, one
// per line; a heading's; one list item's).
export const blockText = (b) => (b.t === 'p' || b.t === 'quote' ? b.lines.map((l) => l.trim()).join('\n') : b.t === 'h' ? b.text : '');

// The segments of one field's value, in order, empty ones left out.
export const segmentsOf = (type, value) => {
  if (type === 'textarea') return paragraphs(value).map(normSeg).filter(Boolean);
  if (type === 'markdown') {
    const out = [];
    for (const b of blocksOf(value)) {
      if (b.t === 'list') for (const i of b.items) out.push(normSeg(i.text));
      else if (b.t !== 'hr') out.push(normSeg(blockText(b)));
    }
    return out.filter(Boolean);
  }
  if (type === 'words') return (Array.isArray(value) ? value : []).map(normSeg).filter(Boolean);
  const one = normSeg(value);
  return one ? [one] : [];
};

// Composed headlines: one segment each, with markup (decision 23). The
// band: "{title} <u>{highlight}</u>"; the hero: "{prefix} <b>{word}</b>"
// once per rotating word (just "<b>{word}</b>" with no prefix, just the
// prefix with no words).
export const bandSegment = (title, highlight) => {
  const t = normSeg(title);
  const h = normSeg(highlight);
  if (!h) return t;
  return `${t ? `${t} ` : ''}<u>${h}</u>`;
};
export const heroSegments = (prefix, words) => {
  const p = normSeg(prefix);
  const ws = (Array.isArray(words) ? words : []).map(normSeg).filter(Boolean);
  if (!ws.length) return p ? [p] : [];
  return ws.map((w) => `${p ? `${p} ` : ''}<b>${w}</b>`);
};
// "Before <u>inside</u> after" → { before, inside, after } (null: no <u>).
export const splitMark = (text, tag) => {
  const m = new RegExp(`^([\\s\\S]*?)<${tag}>([\\s\\S]*?)</${tag}>([\\s\\S]*)$`).exec(s(text));
  return m ? { before: m[1], inside: m[2], after: m[3] } : null;
};

// What a field is, for translation: its catalogue type, and its flag —
// true (translated), false (never: names, handles, amounts), 'label' (only
// an option's label; the value posted stays English), 'check-first' (shown
// translated only once a person checked it), 'composed' (one segment with
// the field beside it).
const TRANSLATED = new Set(['text', 'textarea', 'markdown', 'words', 'link', 'image']);
const flagOf = (f) => (f.translate === undefined ? true : f.translate);

// Every translatable piece of one module's props, for the collector:
// [{ text, cls: 'content' | 'check-first', field, kind }] — composed headlines
// already composed.
export const moduleSegments = (kind, props) => {
  const def = MODULE_BY_KIND[kind];
  if (!def) return [];
  const p = props && typeof props === 'object' ? props : {};
  const out = [];
  const add = (texts, cls, field, kind = 'plain') => { for (const text of texts) out.push({ text, cls, field, kind }); };
  const walk = (fields, obj, path) => {
    for (const f of fields) {
      const flag = flagOf(f);
      const v = obj?.[f.key];
      const where = path ? `${path}.${f.key}` : f.key;
      if (flag === false || flag === 'composed') continue;
      if (f.type === 'list') {
        (Array.isArray(v) ? v : []).forEach((item, i) => walk(f.of, item, `${where}#${i}`));
        continue;
      }
      if (!TRANSLATED.has(f.type)) continue;
      const cls = flag === 'check-first' ? 'check-first' : 'content';
      if (f.type === 'link') add(segmentsOf('text', v?.label), cls, `${where}.label`);
      else if (f.type === 'image') add(segmentsOf('text', v?.alt), cls, `${where}.alt`);
      else add(segmentsOf(f.type, v), cls, where, f.type === 'markdown' ? 'markdown' : 'plain');
    }
  };
  walk(def.fields, p, '');
  if (kind === 'hero') add(heroSegments(p.titlePrefix, p.words), 'content', 'headline', 'composed');
  if (kind === 'band') add([bandSegment(p.title, p.highlight)].filter(Boolean), 'content', 'headline', p.highlight ? 'composed' : 'plain');
  return out;
};
