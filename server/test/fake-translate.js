// A stand-in for Google Cloud Translation (Basic, v2), so the website's
// language tests run with no key and no network (TR). Point base.win at it
// with GOOGLE_TRANSLATE_API_BASE=http://127.0.0.1:<port>.
//
//   In a test:   const fake = await startFakeTranslate()
//   On its own:  PORT=5471 node server/test/fake-translate.js
//
//   POST /language/translate/v2            JSON body (key in X-goog-api-key)
//                                          or a form body (key in it)
//   GET  /language/translate/v2/languages  the key check
//
// Its "translation" is made up but deterministic and in the right script:
// each Latin word becomes a word of Gurmukhi letters with vowel signs above
// and below the line for pa, or of CJK characters for zh-CN; every tag and
// placeholder is kept. Like Google it entity-encodes what it sends back
// (&#39; &amp; &quot;) and collapses newlines.
//
// For tests (fake.set({...}) or POST /__set with JSON):
//   fail: 429 | 500 | 403            every call answers that (Google's error body)
//   headerKey: false                 the header key is refused (400 "API key not
//                                    valid"); only a key in a form body works
//   drop: { contains, what }         for a segment containing that text, drop its
//                                    'x' placeholder, 'br' or 'name' (a span) every time
//   transliterate: true              names inside translate="no" come back changed
//   reorder: true                    <b>/<u> parts are moved to the front
//   heroDiffer: true                 each <b> sentence gets its own outside text
//   stall: ms                        answer that much later (past a timeout)
//   holdWhile: () => boolean         assert no call arrives while it is true
// fake.calls: [{ at, target, q, chars, keyIn, url, headers }]
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const GURMUKHI = ['ਕ', 'ਖ', 'ਗ', 'ਘ', 'ਚ', 'ਛ', 'ਜ', 'ਝ', 'ਟ', 'ਠ', 'ਡ', 'ਤ', 'ਥ', 'ਦ', 'ਧ', 'ਨ', 'ਪ', 'ਫ', 'ਬ', 'ਭ', 'ਮ', 'ਯ', 'ਰ', 'ਲ', 'ਵ', 'ਸ', 'ਹ'];
const SIGNS = ['ਿ', 'ੀ', 'ੁ', 'ੂ', 'ੇ', 'ੈ', 'ੋ', 'ੌ', 'ੰ', 'ੱ'];
const CJK = ['人', '民', '社', '区', '学', '校', '交', '通', '城', '市', '支', '持', '参', '与', '投', '票', '选', '举', '团', '结', '安', '全', '家', '园', '发', '展', '议', '会'];
const hash = (s) => { let h = 7; for (const c of s) h = (h * 31 + c.codePointAt(0)) >>> 0; return h; };

export const fakeWord = (word, target) => {
  const h = hash(word);
  if (target === 'pa') {
    const n = Math.max(1, Math.min(4, Math.ceil(word.length / 2)));
    let out = '';
    for (let i = 0; i < n; i += 1) out += GURMUKHI[(h >>> (i * 3)) % GURMUKHI.length] + SIGNS[(h >>> (i * 2 + 1)) % SIGNS.length];
    return out;
  }
  const n = Math.max(1, Math.min(3, Math.ceil(word.length / 3)));
  let out = '';
  for (let i = 0; i < n; i += 1) out += CJK[(h >>> (i * 4)) % CJK.length];
  return out;
};

const encode = (s) => s.replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;');
// Google's input is HTML: its text is decoded first, then made up, then
// encoded again.
const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const fakeText = (text, target) => {
  const words = decode(text).replace(/\s*\n\s*/g, ' ').replace(/[A-Za-z][A-Za-z’']*/g, (w) => fakeWord(w, target));
  return encode(words).replace(/</g, '&lt;').replace(/>/g, '&gt;');
};

export const fakeTranslate = (html, target, opts = {}) => {
  const parts = String(html).split(/(<[^>]+>)/);
  let inNo = false;
  let out = parts.map((p) => {
    if (p.startsWith('<')) {
      if (/^<span translate="no">$/.test(p)) inNo = true;
      if (p === '</span>') inNo = false;
      return p;
    }
    if (inNo) return opts.transliterate ? fakeText(p, target) : encode(p);
    return fakeText(p, target);
  }).join('');
  if (opts.drop && html.includes(opts.drop.contains)) {
    if (opts.drop.what === 'x') out = out.replace(/<x i="\d+"\/>/, '');
    if (opts.drop.what === 'br') out = out.replace(/<br i="\d+"\/>/, ' ');
    if (opts.drop.what === 'name') out = out.replace(/<span translate="no">[^<]*<\/span>/, 'ਨਾਮ');
  }
  if (opts.reorder) {
    const m = /^(.*?)(<([bu])>.*?<\/\3>)(.*)$/s.exec(out);
    if (m) out = `${m[2]} ${m[1]}${m[4]}`.replace(/\s+/g, ' ').trim();
  }
  if (opts.heroDiffer && /<b>/.test(out)) {
    out = out.replace(/^(.*?)<b>/s, (all, before) => `${before}${fakeWord(`v${hash(out)}`, target)} <b>`);
  }
  return out;
};

export const startFakeTranslate = async ({ port = 0 } = {}) => {
  const calls = [];
  let opts = {};
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const googleError = (status) => ({
    error: { code: status, message: status === 429 ? 'Rate Limit Exceeded' : status === 403 ? 'The request is missing a valid API key.' : 'Internal error', status: status === 429 ? 'RESOURCE_EXHAUSTED' : status === 403 ? 'PERMISSION_DENIED' : 'INTERNAL' },
  });
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      const url = new URL(req.url, 'http://x');
      try {
        if (req.method === 'POST' && url.pathname === '/__set') { opts = { ...opts, ...JSON.parse(raw || '{}') }; return json(res, 200, { ok: true }); }
        if (req.method === 'GET' && url.pathname === '/__calls') return json(res, 200, { calls });
        if (req.method === 'GET' && url.pathname === '/language/translate/v2/languages') {
          if (!req.headers['x-goog-api-key'] && !url.searchParams.get('key')) return json(res, 403, googleError(403));
          return json(res, 200, { data: { languages: [{ language: 'pa' }, { language: 'zh-CN' }, { language: 'zh-TW' }] } });
        }
        if (req.method === 'POST' && url.pathname === '/language/translate/v2') {
          const form = String(req.headers['content-type'] || '').startsWith('application/x-www-form-urlencoded');
          let body;
          if (form) {
            const p = new URLSearchParams(raw);
            body = { q: p.getAll('q'), source: p.get('source'), target: p.get('target'), format: p.get('format'), model: p.get('model'), key: p.get('key') };
          } else body = JSON.parse(raw || '{}');
          const q = Array.isArray(body.q) ? body.q : [body.q];
          const keyIn = form ? (body.key ? 'body' : 'none') : (req.headers['x-goog-api-key'] ? 'header' : 'none');
          const call = { at: Date.now(), target: body.target, q, chars: q.reduce((n, t) => n + String(t).length, 0), keyIn, url: req.url, headers: { ...req.headers } };
          calls.push(call);
          if (typeof opts.holdWhile === 'function' && opts.holdWhile()) call.duringWrite = true;
          if (opts.stall) await new Promise((r) => setTimeout(r, opts.stall));
          if (opts.fail) return json(res, opts.fail, googleError(opts.fail));
          if (keyIn === 'none') return json(res, 403, googleError(403));
          if (keyIn === 'header' && opts.headerKey === false) {
            return json(res, 400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } });
          }
          return json(res, 200, { data: { translations: q.map((t) => ({ translatedText: fakeTranslate(t, body.target, opts) })) } });
        }
        return json(res, 404, { error: { message: 'not found' } });
      } catch (e) {
        return json(res, 500, { error: { message: String(e.message) } });
      }
    });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const api = {
    calls,
    url: `http://127.0.0.1:${server.address().port}`,
    port: server.address().port,
    set: (o) => { opts = { ...opts, ...o }; },
    reset: () => { opts = {}; calls.length = 0; },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
  return api;
};

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const fake = await startFakeTranslate({ port: Number(process.env.PORT) || 5471 });
  console.log(`fake translate on ${fake.url}`);
}
