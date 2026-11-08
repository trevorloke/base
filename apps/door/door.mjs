// The front door at base.win: one address for every client, each client's
// apps on their own servers.
//
//   base.win/<client>/field   the volunteers' app ─┐
//   base.win/<client>/desk    the office's         ├─ that client's Base Ground
//   base.win/<client>/api…    (and everything else)┘   (BASE_PATH=/<client>)
//   base.win/<client>/web     that client's Base Web   (its base path /<client>/web)
//   base.win/<client>/air     that client's Base Air   (its base path /<client>/air)
//   base.win/<client>         → /<client>/field/
//
// The path goes through as it came (each app knows it lives under it), so
// the door holds no secrets and decides nothing about who may see what:
// signing in, and who may open the desk, Web and Air, are each app's own.
//
// BASE_CLIENTS (JSON): { "imaginesurrey": { "name": "Imagine Surrey",
//   "ground": "https://…",
//   "web": { "redirect": "https://imaginesurrey.ca/admin" },
//   "air": "https://…" } }
// Each app is either an origin — the door passes requests through, and the
// app lives under /<client>/<app> (Ground, with BASE_PATH) — or
// { "redirect": "https://…" } — the door sends people on to where the app
// already runs, the rest of the path after it (Web and Air today: they run
// at their own addresses, with their own sign-in). A client without web or
// air simply has none (a plain "not set up" page). Ground is always passed
// through.
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
    const url = (u, what) => {
      if (u == null || u === '') return null;
      const s = String(u).replace(/\/+$/, '');
      if (!/^https?:\/\/[^\s/]+$/i.test(s)) throw new Error(`BASE_CLIENTS: ${name}.${what} must be an origin like https://host (no path)`);
      return s;
    };
    // An app: an origin to pass through to, or { redirect: "https://…" }.
    const app = (v, what) => {
      if (v && typeof v === 'object') {
        const to = String(v.redirect || '').replace(/\/+$/, '');
        if (!/^https:\/\/[^\s]+$/i.test(to)) throw new Error(`BASE_CLIENTS: ${name}.${what}.redirect must be an https address`);
        return { redirect: to };
      }
      const origin = url(v, what);
      return origin ? { origin } : null;
    };
    const ground = url(c?.ground, 'ground');
    if (!ground) throw new Error(`BASE_CLIENTS: ${name} needs a ground address`);
    out.set(name, { name: String(c?.name || name), ground: { origin: ground }, web: app(c?.web, 'web'), air: app(c?.air, 'air') });
  }
  return out;
};

// → { client, app: 'ground'|'web'|'air', upstream } | { redirect } | null
export const route = (clients, pathname) => {
  const m = /^\/([^/]+)(\/.*)?$/.exec(pathname);
  if (!m) return null;
  const client = clients.get(m[1].toLowerCase());
  if (!client) return null;
  const rest = m[2] || '';
  if (rest === '' || rest === '/') return { redirect: `/${m[1].toLowerCase()}/field/` };
  if (m[1] !== m[1].toLowerCase()) return { redirect: `/${m[1].toLowerCase()}${rest}` };
  const app = /^\/web(?:\/|$)/.test(rest) ? 'web' : /^\/air(?:\/|$)/.test(rest) ? 'air' : 'ground';
  const target = client[app];
  if (!target) return { client, app, upstream: null };
  // Sent on: what came after /<client>/<app>, after the app's own address.
  if (target.redirect) return { redirect: `${target.redirect}${rest.slice(app.length + 1)}`, away: true };
  return { client, app, upstream: target.origin };
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
    return send(page(200, 'Base', '<h1>Base</h1><p>A broad application for social engagement.</p><p>Your campaign has its own address on base.win — ask its organizers for it.</p>'));
  }
  const r = route(clients, url.pathname);
  if (!r) return send(page(404, 'Not found — Base', '<h1>Not here</h1><p>There’s no Base at this address. Check the link your campaign sent you.</p>'));
  if (r.redirect) return send({ status: 302, headers: { location: `${r.redirect}${url.search}`, 'cache-control': 'no-store', ...(r.away ? { 'referrer-policy': 'no-referrer' } : {}) }, body: '' });
  if (!r.upstream) return send(page(404, 'Not set up — Base', `<h1>Not set up</h1><p>${r.client.name} doesn’t have Base ${r.app === 'web' ? 'Web' : 'Air'} yet.</p>`));

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
    return send(page(502, 'Not answering — Base', `<h1>Not answering</h1><p>${r.client.name}’s Base isn’t answering right now. Try again in a minute.</p>`));
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
    console.log(`base door on :${port} — ${clients.size} client${clients.size === 1 ? '' : 's'}: ${[...clients.keys()].join(', ') || 'none yet'}`);
  });
}
