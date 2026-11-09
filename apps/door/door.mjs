// The front door at base.win: one address for every client, each client's
// base.win on its own server and database.
//
//   base.win/<client>          → /<client>/site/ — the campaign's public website
//   base.win/<client>/site/…   the website ─┐
//   base.win/<client>/field    the volunteers' app ├─ that client's base.win
//   base.win/<client>/desk     the office's        │  (BASE_PATH=/<client>)
//   base.win/<client>/api…     (and everything else)┘
//   base.win/<client>/web…     → /<client>/desk/website — the website's back
//                                office is the desk's Website area now
//
// The path goes through as it came (the server knows it lives under it), so
// the door holds no secrets and decides nothing about who may see what:
// signing in, and who may open the desk, are the server's own.
//
// BASE_CLIENTS (JSON): { "imaginesurrey": { "name": "Imagine Surrey",
//   "server": "https://…" } } — the client's server, an origin (no path).
// ("ground" is the older name for "server" and still read; "web" and "air"
// entries left from before are ignored.)
import { createServer } from 'node:http';
import { Readable } from 'node:stream';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const readClients = (raw = process.env.BASE_CLIENTS) => {
  let parsed;
  try { parsed = JSON.parse(raw || '{}'); } catch { throw new Error('BASE_CLIENTS is not JSON'); }
  const out = new Map();
  for (const [key, c] of Object.entries(parsed || {})) {
    const name = key.toLowerCase();
    if (!NAME_RE.test(name)) throw new Error(`BASE_CLIENTS: “${key}” isn’t a usable name (letters, digits, dashes)`);
    const given = c?.server ?? c?.ground;
    if (given == null || given === '') throw new Error(`BASE_CLIENTS: ${name} needs a server address`);
    const origin = String(given).replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s/]+$/i.test(origin)) throw new Error(`BASE_CLIENTS: ${name}.server must be an origin like https://host (no path)`);
    out.set(name, { name: String(c?.name || name), origin });
  }
  return out;
};

// → { client, upstream } | { redirect } | null
export const route = (clients, pathname) => {
  const m = /^\/([^/]+)(\/.*)?$/.exec(pathname);
  if (!m) return null;
  const key = m[1].toLowerCase();
  const client = clients.get(key);
  if (!client) return null;
  const rest = m[2] || '';
  // The client's name alone: their public website.
  if (rest === '' || rest === '/') return { redirect: `/${key}/site/` };
  if (m[1] !== key) return { redirect: `/${key}${rest}` };
  // Where the website's back office was: the desk's Website area now.
  if (/^\/web(?:\/|$)/.test(rest)) return { redirect: `/${key}/desk/website` };
  return { client, upstream: client.origin };
};

// Hop-by-hop headers stay on this side of the door.
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length']);

const page = (status, title, body) => ({
  status,
  headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff' },
  body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:#f4f5fa;color:#161a2e;padding:24px;box-sizing:border-box}main{max-width:420px}h1{margin:0 0 8px}p{color:#4a5070;line-height:1.5}@media (prefers-color-scheme:dark){body{background:#0d1226;color:#e8eaf6}p{color:#9aa1c2}}</style></head>
<body><main>${body}</main></body></html>`,
});

export const handler = (clients, { fetchImpl = fetch } = {}) => async (req, res) => {
  const url = new URL(req.url, 'http://door');
  const send = ({ status, headers, body }) => { res.writeHead(status, headers); res.end(body); };
  if (url.pathname === '/healthz') return send({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: true, service: 'base-door', clients: clients.size }) });
  if (url.pathname === '/' || url.pathname === '') {
    return send(page(200, 'base.win', '<h1>base.win</h1><p>Your campaign has its own address on base.win — ask its organizers for it.</p>'));
  }
  const r = route(clients, url.pathname);
  if (!r) return send(page(404, 'Not found — base.win', '<h1>Not here</h1><p>There’s no campaign at this address on base.win. Check the link your campaign sent you.</p>'));
  if (r.redirect) return send({ status: 302, headers: { location: `${r.redirect}${url.search}`, 'cache-control': 'no-store' }, body: '' });

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP.has(k) || v == null) continue;
    for (const one of Array.isArray(v) ? v : [v]) headers.append(k, one);
  }
  const host = req.headers.host || '';
  headers.set('x-forwarded-host', host);
  headers.set('x-forwarded-proto', req.headers['x-forwarded-proto'] || (req.socket?.encrypted ? 'https' : 'http'));
  const prior = req.headers['x-forwarded-for'];
  const ip = req.socket?.remoteAddress || '';
  headers.set('x-forwarded-for', prior ? `${prior}, ${ip}` : ip);
  const init = { method: req.method, headers, redirect: 'manual' };
  if (req.method !== 'GET' && req.method !== 'HEAD') { init.body = Readable.toWeb(req); init.duplex = 'half'; }
  let up;
  try {
    up = await fetchImpl(`${r.upstream}${url.pathname}${url.search}`, init);
  } catch {
    return send(page(502, 'Not answering — base.win', `<h1>Not answering</h1><p>${r.client.name} isn’t answering on base.win right now. Try again in a minute.</p>`));
  }
  const out = {};
  const cookies = typeof up.headers.getSetCookie === 'function' ? up.headers.getSetCookie() : [];
  for (const [k, v] of up.headers) {
    if (HOP.has(k) || k === 'set-cookie' || k === 'content-encoding') continue;
    out[k] = v;
  }
  if (cookies.length) out['set-cookie'] = cookies;
  // fetch hands back a decoded body; it goes on decoded (no content-encoding).
  res.writeHead(up.status, out);
  if (!up.body || req.method === 'HEAD') return res.end();
  Readable.fromWeb(up.body).on('error', () => res.destroy()).pipe(res);
  return undefined;
};

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const clients = readClients();
  const port = Number(process.env.PORT) || 8080;
  createServer(handler(clients)).listen(port, () => {
    console.log(`base.win door on :${port} — ${clients.size} client${clients.size === 1 ? '' : 's'}: ${[...clients.keys()].join(', ') || 'none yet'}`);
  });
}
