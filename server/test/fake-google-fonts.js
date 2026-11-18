// A stand-in for Google Fonts, so the fonts tests run with no network
// (WA stage 1). Point base.win at it with
//   GOOGLE_FONTS_CSS_BASE=http://127.0.0.1:<port>
//   GOOGLE_FONTS_FILE_HOSTS=127.0.0.1:<port>
// (both ignored in production). It serves the made-up families base.win
// lists while it is in use (server/ext/site/fonts.js TEST_FAMILIES) — and
// any other family name — with real woff2 bytes from shared/site/fonts/.
//
//   GET /css2?family=<Family>:<axes>&display=swap
//       a stylesheet with cyrillic, vietnamese, latin-ext and latin faces
//       (a browser's User-Agent; any other gets TTF addresses, as Google does)
//   GET /css2?family=<Family>:wght@<w>&text=<letters>   one small face
//   GET /s/<slug>/v7/<file>.woff2                      a file
//
//   In a test:   const fake = await startFakeGoogleFonts()
//                fake.mode = 'ok' | 500 | 403 | 'stall' | 'notwoff2' | 'big'
//                  | 'nine' | 'otherhost'      (what the next answers do)
//                fake.requests   every request: { path, ua }
//                fake.url, fake.host, fake.close()
//   On its own:  PORT=5491 node server/test/fake-google-fonts.js
//                (POST /__mode with { mode } changes it; GET /__requests lists them)
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FONTS = fileURLToPath(new URL('../../shared/site/fonts/', import.meta.url));
const file = (name) => readFileSync(`${FONTS}${name}`);
const BYTES = {
  // "Fake Display" draws in Montserrat's letters, everything else in Inter's.
  display: { latin: file('montserrat-latin.woff2'), 'latin-ext': file('inter-latin-ext.woff2') },
  other: { latin: file('inter-latin.woff2'), 'latin-ext': file('inter-latin-ext.woff2') },
  sample: file('barlow-condensed-600-latin.woff2'),
};
const RANGES = {
  cyrillic: 'U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116',
  vietnamese: 'U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB',
  'latin-ext': 'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF',
  latin: 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
};
const slugOf = (f) => f.toLowerCase().replace(/[^a-z0-9]+/g, '');

// "ital,wght@0,100..900;1,100..900" | "wght@400;700" → [{ style, weight }]
const tuples = (axes) => {
  const [names, values] = String(axes || 'wght@400').split('@');
  const keys = names.split(',');
  return (values || '400').split(';').map((v) => {
    const parts = v.split(',');
    const o = Object.fromEntries(keys.map((k, i) => [k, parts[i]]));
    return { style: o.ital === '1' ? 'italic' : 'normal', weight: (o.wght || '400').replace('..', ' ') };
  });
};

export async function startFakeGoogleFonts({ port = 0 } = {}) {
  const fake = { mode: 'ok', requests: [] };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const ua = req.headers['user-agent'] || '';
    if (url.pathname === '/__mode' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { try { fake.mode = JSON.parse(body).mode; } catch { /* as it was */ } res.end('{}'); });
      return;
    }
    if (url.pathname === '/__requests') return res.end(JSON.stringify(fake.requests));
    fake.requests.push({ path: req.url, ua });
    const mode = fake.mode;
    if (mode === 'stall') return; // never answers; the caller's timeout ends it
    if (mode === 500 || mode === 403) { res.writeHead(mode); return res.end('no'); }
    if (url.pathname === '/css2') {
      const [family, axes] = String(url.searchParams.get('family') || '').split(':');
      const name = family.replace(/\+/g, ' ');
      const base = mode === 'otherhost' ? 'https://evil.example' : fake.url;
      const browser = /Chrome\//.test(ua);
      const ext = browser ? 'woff2' : 'ttf';
      const text = url.searchParams.get('text');
      if (text !== null) {
        res.writeHead(200, { 'content-type': 'text/css' });
        return res.end(`@font-face {\n  font-family: '${name}';\n  font-style: normal;\n  font-weight: 400;\n  src: url(${base}/s/${slugOf(name)}/v7/sample.${ext}) format('${browser ? 'woff2' : 'truetype'}');\n}\n`);
      }
      let css = '';
      const face = (subset, t, i = 0) => {
        css += `/* ${subset} */\n@font-face {\n  font-family: '${name}';\n  font-style: ${t.style};\n  font-weight: ${t.weight};\n  font-display: swap;\n`
          + `  src: url(${base}/s/${slugOf(name)}/v7/${subset}-${t.style}-${t.weight.replace(' ', '-')}${i ? `-${i}` : ''}.${ext}) format('${browser ? 'woff2' : 'truetype'}');\n  unicode-range: ${RANGES[subset]};\n}\n`;
      };
      for (const t of tuples(axes)) for (const subset of ['cyrillic', 'vietnamese', 'latin-ext', 'latin']) face(subset, t);
      if (mode === 'nine') for (let i = 1; i <= 9; i += 1) face('latin', { style: 'normal', weight: '400' }, i);
      res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
      return res.end(css);
    }
    const m = /^\/s\/([a-z0-9]+)\/v7\/(.+)\.(woff2|ttf)$/.exec(url.pathname);
    if (m) {
      let body;
      if (mode === 'notwoff2') body = Buffer.from('<html>not a font</html>');
      else if (mode === 'big') body = Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(400 * 1024)]);
      else if (m[2] === 'sample') body = BYTES.sample;
      else body = (m[1] === 'fakedisplay' ? BYTES.display : BYTES.other)[m[2].startsWith('latin-ext') ? 'latin-ext' : 'latin'];
      res.writeHead(200, { 'content-type': m[3] === 'ttf' ? 'font/ttf' : 'font/woff2', 'content-length': body.length });
      return res.end(body);
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const { port: p } = server.address();
  fake.host = `127.0.0.1:${p}`;
  fake.url = `http://${fake.host}`;
  fake.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  return fake;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const fake = await startFakeGoogleFonts({ port: Number(process.env.PORT) || 5491 });
  console.log(`fake Google Fonts at ${fake.url}`);
}
