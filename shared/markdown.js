// A small, safe Markdown renderer for the public website (server) and the
// editor's Preview (web) — one function, so the preview is the page.
//
// Safety first: every character of the source is HTML-escaped before any
// formatting is recognised, so no tag or attribute typed by an editor can
// reach the page. The only HTML out is what this file writes. Links keep
// http(s), mailto and same-site paths (/news); images keep /media/… and
// https. Anything else is shown as plain text.
//
// Supported: # / ## / ### headings, paragraphs, **bold**, *italic* / _italic_,
// `code`, [links](https://…), ![images](/media/…), - and 1. lists,
// > quotes, --- rules, and line breaks (a single newline inside a paragraph).

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ESC[ch]);
const unescape = (s) => s.replace(/&(amp|lt|gt|quot|#39);/g, (m, k) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[k]));

// An escaped URL from the source → a safe attribute value, or null.
const safeUrl = (escaped, { image = false } = {}) => {
  const raw = unescape(escaped).trim();
  // No whitespace, quotes, angle brackets or backslashes anywhere in a URL.
  if (!raw || /[\s"'<>\\`]/.test(raw)) return null;
  const ok = image
    ? /^https:\/\/[^/]/i.test(raw) || /^\/media\/[A-Za-z0-9-]+$/.test(raw)
    : /^(https?:\/\/[^/]|mailto:[^/])/i.test(raw) || /^\/(?!\/)/.test(raw) || /^#[\w-]*$/.test(raw);
  return ok ? escapeHtml(raw) : null;
};

// Inline formatting on one already-escaped line. Links and images become
// numbered placeholders first so their URLs are never touched by * or _.
// A URL may hold one level of (parentheses), as Wikipedia's do.
const inline = (text) => {
  const held = [];
  const hold = (html) => `\u0000${held.push(html) - 1}\u0000`;
  let s = text
    .replace(/`([^`]+)`/g, (m, code) => hold(`<code>${code}</code>`))
    .replace(/!\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, (m, alt, url) => {
      const src = safeUrl(url, { image: true });
      return src ? hold(`<img src="${src}" alt="${alt}" loading="lazy" decoding="async">`) : m;
    })
    .replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, (m, label, url) => {
      const href = safeUrl(url);
      if (!href) return label;
      const outside = /^https?:/i.test(unescape(url));
      return hold(`<a href="${href}"${outside ? ' rel="noopener"' : ''}>${emphasis(label)}</a>`);
    });
  s = emphasis(s);
  return s.replace(/\u0000(\d+)\u0000/g, (m, i) => held[Number(i)]);
};
const emphasis = (s) => s
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/__([^_]+)__/g, '<strong>$1</strong>')
  .replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>')
  .replace(/(^|[^\w])_([^_\s][^_]*?)_(?!\w)/g, '$1<em>$2</em>');

const lines = (block) => block.map((l) => inline(escapeHtml(l.trim()))).join('<br>');

// The blocks of a Markdown body, as typed (not escaped): { t: 'p', lines },
// { t: 'h', level, text }, { t: 'hr' }, { t: 'quote', lines },
// { t: 'list', tag, items: [{ text }] }. A translated page swaps a block's
// words for its own language's (server/ext/site translate.js) and marks a
// block that fell back to English with lang: 'en'; drawBlocks draws them.
export const blocksOf = (src) => {
  const rows = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  let list = null; // { tag, items }
  let quote = [];
  const flushPara = () => { if (para.length) out.push({ t: 'p', lines: para }); para = []; };
  const flushList = () => { if (list) out.push({ t: 'list', tag: list.tag, items: list.items.map((text) => ({ text })) }); list = null; };
  const flushQuote = () => { if (quote.length) out.push({ t: 'quote', lines: quote }); quote = []; };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };

  for (const row of rows) {
    const line = row.trimEnd();
    if (!line.trim()) { flushAll(); continue; }
    let m;
    if ((m = /^(#{1,3})\s+(.+)$/.exec(line))) {
      flushAll();
      // Page titles are h1; a body's # is the page's h2, ## h3, ### h4.
      out.push({ t: 'h', level: m[1].length + 1, text: m[2].trim() });
    } else if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      flushAll();
      out.push({ t: 'hr' });
    } else if ((m = /^>\s?(.*)$/.exec(line))) {
      flushPara(); flushList();
      quote.push(m[1]);
    } else if ((m = /^\s*[-*+]\s+(.+)$/.exec(line))) {
      flushPara(); flushQuote();
      if (list?.tag !== 'ul') { flushList(); list = { tag: 'ul', items: [] }; }
      list.items.push(m[1]);
    } else if ((m = /^\s*\d{1,3}[.)]\s+(.+)$/.exec(line))) {
      flushPara(); flushQuote();
      if (list?.tag !== 'ol') { flushList(); list = { tag: 'ol', items: [] }; }
      list.items.push(m[1]);
    } else if (list && /^\s{2,}\S/.test(row)) {
      // An indented line continues the list item above it.
      list.items[list.items.length - 1] += ` ${line.trim()}`;
    } else {
      flushList(); flushQuote();
      para.push(line);
    }
  }
  flushAll();
  return out;
};

const langAttr = (b) => (b.lang ? ` lang="${escapeHtml(b.lang)}"` : '');
export const drawBlocks = (blocks) => (blocks || []).map((b) => {
  if (b.t === 'h') return `<h${b.level}${langAttr(b)}>${inline(escapeHtml(b.text))}</h${b.level}>`;
  if (b.t === 'hr') return '<hr>';
  if (b.t === 'quote') return `<blockquote${langAttr(b)}><p>${lines(b.lines)}</p></blockquote>`;
  if (b.t === 'list') return `<${b.tag}>${b.items.map((i) => `<li${langAttr(i)}>${inline(escapeHtml(i.text))}</li>`).join('')}</${b.tag}>`;
  return `<p${langAttr(b)}>${lines(b.lines)}</p>`;
}).join('\n');

export const renderMarkdown = (src) => drawBlocks(blocksOf(src));

// Plain text of a Markdown body (meta descriptions, summaries): formatting
// marks dropped, links keep their words. Not HTML — escape it where it goes.
export const markdownText = (src, max = 200) => {
  const t = String(src ?? '')
    .replace(/!\[[^\]]*\]\((?:[^()]|\([^()]*\))*\)/g, '')
    .replace(/\[([^\]]+)\]\((?:[^()]|\([^()]*\))*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)]|>)\s+/gm, '')
    .replace(/[*_`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : t;
};

// The plain-text form of a Markdown body — an email's text part, a notice
// read aloud: the words line for line, formatting marks dropped. A link
// keeps its address after its words ("Donate (https://…)"); a picture is
// its address on its own line; lists, quotes and rules stay as typed, as
// they read fine in plain text. Not HTML — escape it where it goes.
export const markdownPlain = (src) => String(src ?? '')
  .replace(/\r\n?/g, '\n')
  .replace(/!\[[^\]]*\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, '$1')
  .replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, (m, label, url) => (label.trim() === url ? url : `${label} (${url})`))
  .replace(/^#{1,3}\s+(.+)$/gm, '$1')
  .replace(/`([^`]+)`/g, '$1')
  .replace(/\*\*([^*]+)\*\*/g, '$1')
  .replace(/__([^_]+)__/g, '$1')
  .replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?!\w)/g, '$1$2')
  .replace(/(^|[^\w])_([^_\s][^_]*?)_(?!\w)/g, '$1$2')
  .replace(/^(-{3,}|\*{3,})$/gm, '———')
  .trim();
