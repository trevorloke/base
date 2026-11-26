// The front door at base.win: every client at its own address,
// <client>.base.win, each on its own server and database.
//
//   <client>.base.win/         the volunteers' app ─┐
//   <client>.base.win/admin    the office's (the desk) ├─ that client's
//   <client>.base.win/site/…   the campaign's public website │  base.win, at
//   <client>.base.win/api…     (and everything else) ─┘  its root
//   <client>.base.win/desk…    → /admin… — the desk by its name
//   <client>.base.win/field…   → /… — the volunteers' app by its name
//   base.win/                  base.win's own page
//   base.win/<client>/…        → <client>.base.win/… — the address from
//                              before, which only sends people on (a link
//                              already sent still opens the same screen)
//
// The path goes through as it came (the server answers at its root), and
// the door decides nothing about who may see what: signing in, and who may
// open the desk, are the server's own.
//
// Who is asking: every request reaches a client's server from the door's
// own address, so the door says whose it is — x-base-client-ip, the
// visitor's address as the proxy in front of the door wrote it (the entry
// BASE_TRUSTED_PROXIES from the right of X-Forwarded-For, default 1: Render's;
// never what the visitor wrote further left), else whoever connected — and
// proves it is the door with x-base-door: BASE_DOOR_KEY, the one secret it
// holds, which each client's server holds too (server/lib/guard.js). That
// is how the server's limits per address (sign-in tries, the website's
// forms) tell visitors apart. Whatever a visitor sent in those two headers
// is dropped. Without the key the door sends neither, and everyone behind
// it is one address to the server.
//
// BASE_CLIENTS (JSON): { "imaginesurrey": { "name": "Imagine Surrey",
//   "server": "https://…" } } — the client's server, an origin (no path).
// ("ground" is the older name for "server" and still read; "web" and "air"
// entries left from before are ignored.)
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
// Names kept for base.win itself (ops.base.win is the control centre, which
// never goes through the door). The control centre refuses the same list.
export const RESERVED = ['ops', 'staging', 'hub', 'api', 'admin', 'platform', '_ops', '_hooks', 'www', 'door', 'status', 'help', 'mail', 'app', 'desk', 'field', 'site', 'login', 'assets', 'sample'];

export const readClients = (raw = process.env.BASE_CLIENTS) => {
  let parsed;
  try { parsed = JSON.parse(raw || '{}'); } catch { throw new Error('BASE_CLIENTS is not JSON'); }
  const out = new Map();
  for (const [key, c] of Object.entries(parsed || {})) {
    const name = key.toLowerCase();
    if (RESERVED.includes(name)) throw new Error(`BASE_CLIENTS: “${key}” is kept for base.win; use another name`);
    if (!NAME_RE.test(name)) throw new Error(`BASE_CLIENTS: “${key}” isn’t a usable name (letters, digits, dashes)`);
    const given = c?.server ?? c?.ground;
    if (given == null || given === '') throw new Error(`BASE_CLIENTS: ${name} needs a server address`);
    const origin = String(given).replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s/]+$/i.test(origin)) throw new Error(`BASE_CLIENTS: ${name}.server must be an origin like https://host (no path)`);
    out.set(name, { name: String(c?.name || name), origin });
  }
  return out;
};

// The door's own domain (BASE_APEX, default base.win; "localhost:8080" for
// a door on this machine, where <client>.localhost:8080 opens a client).
export const apexOf = (raw = process.env.BASE_APEX) => String(raw || 'base.win').trim().toLowerCase().replace(/^\.+|\.+$/g, '').replace(/:\d+$/, '');
const apexPort = (raw = process.env.BASE_APEX) => (/:(\d+)$/.exec(String(raw || '').trim()) || [])[1] || '';
const isLocal = (apex) => apex === 'localhost' || apex.endsWith('.localhost');
// → https://<client>.base.win (http and the port on this machine).
export const clientOrigin = (key, apex = apexOf(), port = apexPort()) =>
  `${isLocal(apex) ? 'http' : 'https'}://${key}.${apex}${isLocal(apex) && port ? `:${port}` : ''}`;

// Whose address is this? The Host a request came in on:
//   { client, key }  <client>.base.win, a client the door knows
//   { unknown }      another name under base.win (nobody's, or one kept for
//                    base.win itself): a plain page, never anyone's server
//   null             base.win itself, www, or the door's own address
// Only the door's own domain names a client, so a made-up Host can never
// reach a server or send a visitor anywhere else.
export const hostClient = (clients, hostHeader, apex = apexOf()) => {
  const host = String(hostHeader || '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  if (!apex || !host.endsWith(`.${apex}`)) return null;
  const label = host.slice(0, -(apex.length + 1));
  if (label === 'www') return null;
  if (!NAME_RE.test(label) || RESERVED.includes(label) || !clients.has(label)) return { unknown: true };
  return { client: clients.get(label), key: label };
};

// On a client's own address: the desk and the volunteers' app by the names
// people say (/desk, /field) open where the server has them (/admin, /).
// → a path to send the browser to, or null (the request goes to the server).
export const named = (pathname) => {
  let m;
  if ((m = /^\/desk(\/.*)?$/i.exec(pathname))) return `/admin${m[1] || '/'}`;
  if ((m = /^\/field(\/.*)?$/i.exec(pathname))) return m[1] || '/';
  return null;
};

// base.win/<client>/… — the address from before — → the same screen at
// <client>.base.win: the name alone was the public website, /field the
// volunteers' app, /desk (and /admin) the office's, /web the website's back
// office (the desk's Website area now); anything else keeps its path.
// → a whole address, or null (no client by that name).
export const moved = (clients, pathname, search = '', apex = apexOf(), port = apexPort()) => {
  const m = /^\/([^/]+)(\/.*)?$/.exec(pathname);
  if (!m) return null;
  const key = m[1].toLowerCase();
  if (!clients.has(key) || RESERVED.includes(key)) return null;
  const rest = m[2] || '';
  let path = rest;
  if (rest === '' || rest === '/') path = '/site/';
  else if (/^\/web(?:\/|$)/i.test(rest)) path = '/admin/website';
  else path = named(rest) || rest;
  return `${clientOrigin(key, apex, port)}${path}${search}`;
};

// Hop-by-hop headers stay on this side of the door.
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length']);
// Only the door says these (above): a visitor's own never go through.
const DOOR_SAYS = new Set(['x-base-client-ip', 'x-base-door']);

// The visitor's address: the entry the proxy in front of the door appended
// to X-Forwarded-For (`hops` from the right), else who connected.
export const visitorIp = (req, hops = Math.max(1, Number(process.env.BASE_TRUSTED_PROXIES) || 1)) => {
  const raw = req.headers['x-forwarded-for'];
  const parts = String(Array.isArray(raw) ? raw.join(',') : raw || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ip = parts.length ? parts[Math.max(0, parts.length - hops)] : req.socket?.remoteAddress;
  return String(ip || '').slice(0, 64);
};
export const doorKeyOf = (raw = process.env.BASE_DOOR_KEY) => String(raw || '').trim();

// base.win itself: the coming-soon page (home.html), where the product can
// later be mounted. It names no client.
const HOME = readFileSync(new URL('./home.html', import.meta.url), 'utf8');

const page = (status, title, body) => ({
  status,
  headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff' },
  body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:#f4f5fa;color:#161a2e;padding:24px;box-sizing:border-box}main{max-width:420px}h1{margin:0 0 8px}p{color:#4a5070;line-height:1.5}@media (prefers-color-scheme:dark){body{background:#0d1226;color:#e8eaf6}p{color:#9aa1c2}}</style></head>
<body><main>${body}</main></body></html>`,
});

export const handler = (clients, { fetchImpl = fetch, doorKey = doorKeyOf() } = {}) => async (req, res) => {
  const url = new URL(req.url, 'http://door');
  const send = ({ status, headers, body }) => { res.writeHead(status, headers); res.end(body); };
  if (url.pathname === '/healthz') return send({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: true, service: 'base-door', clients: clients.size }) });
  const keep = req.method !== 'GET' && req.method !== 'HEAD';
  const sendOn = (location) => send({ status: keep ? 307 : 302, headers: { location, 'cache-control': 'no-store' }, body: '' });
  const nobody = () => send(page(404, 'Not found — base.win', '<h1>Not here</h1><p>There’s no campaign at this address on base.win. Check the link your campaign sent you.</p>'));
  const at = hostClient(clients, req.headers.host);
  if (at?.unknown) return nobody();
  if (!at) {
    // base.win itself: its own page, and the addresses from before.
    if (url.pathname === '/' || url.pathname === '') return send({ ...page(200, 'base.win', ''), body: HOME });
    const to = moved(clients, url.pathname, url.search);
    return to ? sendOn(to) : nobody();
  }
  const say = named(url.pathname);
  if (say) return sendOn(`${say}${url.search}`);
  const r = { client: at.client, upstream: at.client.origin };

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP.has(k) || DOOR_SAYS.has(k) || v == null) continue;
    for (const one of Array.isArray(v) ? v : [v]) headers.append(k, one);
  }
  const visitor = visitorIp(req);
  if (doorKey && visitor) {
    headers.set('x-base-client-ip', visitor);
    headers.set('x-base-door', doorKey);
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
    if (doorKeyOf().length < 32) {
      console.warn('base.win door: BASE_DOOR_KEY is not set (32 or more random characters, the same on each client’s server) — the servers see everyone who comes through the door as one address, so one visitor’s sign-in tries count against all');
    }
  });
}
