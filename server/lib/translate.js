// Google Cloud Translation (Basic, v2) for the website's languages
// (ext/site/translate.js; TR decisions 13 and 16). Plain fetch, no SDK.
//
//   prepare(text, { kind, names, nameMethod }) → { q, held }
//     one English segment as the HTML that is sent: escaped, kept names
//     wrapped, slots ({amount}), Markdown links and marks as neutral tags the
//     service keeps, line breaks as <br i="n"/>. No newline is ever sent.
//   readBack(html, held) → { text } | { error: 'plain words' }
//     the service's answer decoded (entities), checked (every placeholder,
//     link, mark, break and kept name back exactly once, no other tag, not
//     empty, not over 3× the English + 200) and mapped back to plain text or
//     Markdown. Nothing Google sends reaches a page as HTML.
//   translateBatch({ target, q, keyIn, signal }) → { texts, chars, keyIn }
//     one call: POST {base}/language/translate/v2, the key in the
//     X-goog-api-key header — or, when Google refuses the header key, once
//     more with the key in a form body (keyIn 'body' is then kept). Never in
//     the address, so it never reaches a log. A 429 or 5xx throws with
//     .busy; any other refusal or a timeout throws with Google's plain words.
//   checkTranslation() → { works, namesKept, headerAccepted, placeholdersKept, … }
//     Settings → Services' "Check translation": one fixed sentence.
//
// Kinds: 'plain' (a heading, a paragraph, fixed words with {slots}),
// 'markdown' (one block of a Markdown field), 'composed' (a headline with
// its <u>…</u> or <b>…</b> part kept as markup).
import { decodeEntities } from './entities.js';
import { googleTrouble } from './googleerr.js';

export const translateBase = () => String(process.env.GOOGLE_TRANSLATE_API_BASE || 'https://translation.googleapis.com').replace(/\/+$/, '');
export const translateKey = () => String(process.env.GOOGLE_TRANSLATE_KEY || '').trim();
export const MAX_SEGMENTS = 128;
export const MAX_CHARS = 25_000;
export const CALL_MS = 15_000;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const HOLD = (n) => `\u0000${n}\u0000`;

// Kept names as whole words, longest first, case as typed.
const nameRe = (names) => {
  const list = [...new Set((names || []).map((n) => String(n).trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  return list.length ? new RegExp(`(?<![\\p{L}\\p{N}])(${list.map(reEsc).join('|')})(?![\\p{L}\\p{N}])`, 'gu') : null;
};

export function prepare(text, { kind = 'plain', names = [], nameMethod = 'placeholder', slots = true } = {}) {
  const src = String(text ?? '');
  const held = { kind, x: [], a: [], br: 0, marks: { b: 0, i: 0, u: 0 }, names: [], spans: [], srcLength: src.length };
  const pieces = []; // what each \u0000n\u0000 becomes in the HTML
  const hold = (html) => HOLD(pieces.push(html) - 1);
  const x = (value) => hold(`<x i="${held.x.push(value)}"/>`);

  // What is never translated, held before the text is escaped.
  const protect = (s) => {
    let out = s;
    if (slots) out = out.replace(/\{([a-z]+)\}/gi, (m) => x({ raw: m }));
    const re = nameRe(names);
    if (re) {
      out = out.replace(re, (m) => {
        held.names.push(m);
        if (nameMethod === 'span') { held.spans.push(m); return hold(`<span translate="no">${esc(m)}</span>`); }
        return x({ raw: m, name: true });
      });
    }
    return out;
  };

  let s = src.replace(/\r\n?/g, '\n');
  if (kind === 'markdown') {
    s = s
      .replace(/`([^`]+)`/g, (m) => x({ raw: m }))
      .replace(/!\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, (m) => x({ raw: m }));
    // Links: their words are translated, the address is kept here.
    s = s.replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, (m, label, url) => {
      const n = held.a.push(url);
      return `${hold(`<a i="${n}">`)}${label}${hold('</a>')}`;
    });
    s = s.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (m, a1, a2) => { held.marks.b += 1; return `${hold('<b>')}${a1 ?? a2}${hold('</b>')}`; });
    s = s.replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?!\w)|(^|[^\w])_([^_\s][^_]*?)_(?!\w)/g, (m, p1, i1, p2, i2) => {
      held.marks.i += 1;
      return `${p1 ?? p2 ?? ''}${hold('<i>')}${i1 ?? i2}${hold('</i>')}`;
    });
  } else if (kind === 'composed') {
    s = s.replace(/<(\/?)([ub])>/g, (m, close, tag) => { if (!close) held.marks[tag] += 1; return hold(`<${close}${tag}>`); });
  }
  s = protect(s);
  s = s.split('\n').map((line) => line).join(`\u0001`);
  let q = esc(s);
  q = q.replace(/\u0001/g, () => `<br i="${(held.br += 1)}"/>`);
  q = q.replace(/\u0000(\d+)\u0000/g, (m, i) => pieces[Number(i)]);
  return { q, held };
}

// The tags an answer may hold: exactly the ones sent.
const TAG = /<\s*(\/?)\s*([a-z]+)((?:\s+[a-z-]+\s*=\s*"[^"]*")*)\s*(\/?)\s*>/gi;
const attrOf = (attrs, name) => new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(attrs || '')?.[1];

export function readBack(answer, held) {
  const html = String(answer ?? '').replace(/\s*\n\s*/g, ' ');
  const seen = { x: new Map(), a: new Map(), br: new Map(), b: 0, i: 0, u: 0, spans: [] };
  const out = [];
  let last = 0;
  let span = null; // inside <span translate="no">
  let bad = null;
  const text = (t) => { if (span) span.text += t; else out.push({ t: 'text', v: t }); };
  for (const m of html.matchAll(TAG)) {
    text(decodeEntities(html.slice(last, m.index)));
    last = m.index + m[0].length;
    const [, close, tag0, attrs, self] = m;
    const tag = tag0.toLowerCase();
    const n = Number(attrOf(attrs, 'i'));
    if (tag === 'x' && !close) {
      seen.x.set(n, (seen.x.get(n) || 0) + 1);
      if (span) { bad = 'A placeholder came back inside a kept name'; break; }
      out.push({ t: 'x', n });
    } else if (tag === 'x' && close) {
      // <x i="1"></x>: its closing half
    } else if (tag === 'br' && !close) {
      seen.br.set(n, (seen.br.get(n) || 0) + 1);
      out.push({ t: 'br' });
    } else if (tag === 'br' && close) {
      // </br>: nothing
    } else if (tag === 'a') {
      if (!close) { seen.a.set(n, (seen.a.get(n) || 0) + 1); out.push({ t: 'a', n }); } else out.push({ t: '/a' });
    } else if (['b', 'i', 'u'].includes(tag)) {
      if (!close) seen[tag] += 1;
      out.push({ t: close ? `/${tag}` : tag });
    } else if (tag === 'span' && !close && /translate\s*=\s*"no"/i.test(attrs || '')) {
      span = { text: '' };
    } else if (tag === 'span' && close && span) {
      seen.spans.push(span.text);
      out.push({ t: 'name', v: span.text });
      span = null;
    } else {
      bad = 'Something unexpected came back in the translation';
      break;
    }
    if (self && !['x', 'br'].includes(tag)) { bad = 'Something unexpected came back in the translation'; break; }
  }
  if (bad) return { error: bad };
  text(decodeEntities(html.slice(last)));
  if (span) return { error: 'A kept name came back changed' };

  // Every placeholder, link, mark, break and kept name, exactly once.
  const once = (map, count) => map.size === count && [...map.entries()].every(([k, v]) => v === 1 && k >= 1 && k <= count);
  const nameXs = held.x.map((v, i) => (v.name ? i + 1 : 0)).filter(Boolean);
  if (!once(seen.x, held.x.length)) {
    return { error: nameXs.some((k) => seen.x.get(k) !== 1) ? 'A kept name came back changed' : 'A placeholder came back changed' };
  }
  if (held.spans.length !== seen.spans.length || held.spans.some((n) => !seen.spans.includes(n)) || seen.spans.some((n) => !held.spans.includes(n))) {
    return { error: 'A kept name came back changed' };
  }
  if (!once(seen.br, held.br)) return { error: 'A line break came back changed' };
  if (!once(seen.a, held.a.length)) return { error: 'A link came back changed' };
  if (seen.b !== held.marks.b || seen.i !== held.marks.i || seen.u !== held.marks.u) return { error: 'Bold, italic or underlined words came back changed' };

  // Back to plain text, Markdown or a composed headline.
  const md = held.kind === 'markdown';
  const parts = out.map((p) => {
    switch (p.t) {
      case 'text': return p.v;
      case 'name': return p.v;
      case 'x': return held.x[p.n - 1].raw;
      case 'br': return '\n';
      case 'a': return '[';
      case '/a': return '';
      case 'b': return md ? '**' : held.kind === 'composed' ? '<b>' : '';
      case '/b': return md ? '**' : held.kind === 'composed' ? '</b>' : '';
      case 'i': return md ? '*' : '';
      case '/i': return md ? '*' : '';
      case 'u': return held.kind === 'composed' ? '<u>' : '';
      case '/u': return held.kind === 'composed' ? '</u>' : '';
      default: return '';
    }
  });
  // A link's address goes back after its words: "[words](url)".
  let s = '';
  const stack = [];
  out.forEach((p, i) => {
    if (p.t === 'a') stack.push(p.n);
    if (p.t === '/a') { const n = stack.pop(); s += `](${held.a[(n || 1) - 1]})`; return; }
    s += parts[i];
  });
  s = s.replace(/[ \t]+/g, ' ').split('\n').map((l) => l.trim()).join('\n').trim();
  if (!s) return { error: 'The translation came back empty' };
  if (s.length > held.srcLength * 3 + 200) return { error: 'The translation came back far longer than the English' };
  return { text: s };
}

// ── The call ──
const keyRefused = (status, body) => [400, 401, 403].includes(status) && /api key|api_key_invalid|key not valid|missing.*key/i.test(JSON.stringify(body || ''));
const trouble = (status, body) => {
  const t = googleTrouble(status, body, { service: 'translate' });
  const e = new Error(t.plain);
  e.status = status;
  e.code = t.code;
  e.said = t.said;
  return e;
};

const post = async ({ q, target, keyIn, key, signal }) => {
  const url = `${translateBase()}/language/translate/v2`;
  const fields = { q, source: 'en', target, format: 'html', model: 'nmt' };
  let init;
  if (keyIn === 'body') {
    const form = new URLSearchParams();
    for (const t of q) form.append('q', t);
    for (const k of ['source', 'target', 'format', 'model']) form.append(k, fields[k]);
    form.append('key', key);
    init = { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString(), signal };
  } else {
    init = { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(fields), signal };
  }
  const res = await fetch(url, init);
  const raw = await res.text();
  let body;
  try { body = JSON.parse(raw); } catch { body = { text: raw.slice(0, 300) }; }
  return { status: res.status, body };
};

export async function translateBatch({ target, q, keyIn = 'header', signal = null, key = translateKey() }) {
  if (!key) throw Object.assign(new Error('Add the translation key to translate new wording.'), { code: 'no-key' });
  const chars = q.reduce((n, t) => n + t.length, 0);
  const sig = signal || AbortSignal.timeout(CALL_MS);
  let used = keyIn === 'body' ? 'body' : 'header';
  let r;
  try {
    r = await post({ q, target, keyIn: used, key, signal: sig });
    if (used === 'header' && keyRefused(r.status, r.body)) {
      used = 'body';
      r = await post({ q, target, keyIn: used, key, signal: sig });
    }
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw Object.assign(new Error('Google Translation didn’t answer in time.'), { code: 'timeout', timeout: true });
    throw Object.assign(new Error('Google Translation couldn’t be reached.'), { code: 'unreachable' });
  }
  if (r.status === 429 || r.status >= 500) throw Object.assign(trouble(r.status, r.body), { busy: true });
  if (r.status !== 200) throw trouble(r.status, r.body);
  const list = r.body?.data?.translations;
  if (!Array.isArray(list) || list.length !== q.length) throw Object.assign(new Error('Google Translation’s answer didn’t match what was sent.'), { code: 'shape' });
  return { texts: list.map((t) => String(t?.translatedText ?? '')), chars, keyIn: used };
}

// Settings → Services → Translation: does the key work (the languages list,
// one bounded call), and — on demand — does Google keep names, the header
// key and the placeholders (one fixed sentence to Punjabi).
export async function translateWorks({ key = translateKey() } = {}) {
  if (!key) return { state: 'not-set' };
  try {
    const res = await fetch(`${translateBase()}/language/translate/v2/languages?target=en`, { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(5000) });
    const body = await res.json().catch(() => ({}));
    if (res.status === 200) return { state: 'works' };
    return { state: 'refused', ...googleTrouble(res.status, body, { service: 'translate' }) };
  } catch {
    return { state: 'refused', code: 'unreachable', plain: 'Google Translation couldn’t be reached.' };
  }
}
export const PROBE_SENTENCE = 'Join <span translate="no">Imagine Surrey</span> at the town hall & bring <x i="1"/> friend to the next meeting.';
export async function checkTranslation({ key = translateKey() } = {}) {
  if (!key) return { works: false, plain: 'Add the translation key first.' };
  try {
    const r = await translateBatch({ target: 'pa', q: [PROBE_SENTENCE], keyIn: 'header', key });
    const t = r.texts[0];
    return {
      works: true,
      headerAccepted: r.keyIn === 'header',
      keyIn: r.keyIn,
      namesKept: /<span translate="no">Imagine Surrey<\/span>/.test(t),
      placeholdersKept: (t.match(/<x i="1"\s*\/?>/g) || []).length === 1,
      at: new Date().toISOString(),
    };
  } catch (e) {
    return { works: false, plain: e.message };
  }
}
