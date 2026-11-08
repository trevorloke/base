// The front door: base.win itself. Each client has a subdomain of its own
// (SUITE.md "Addresses"), so each is a separate browser origin; this sends
// <client>.base.win to that client's own apps and keeps nothing of its own —
// no database, no sessions, no client list on show.
//
//   <client>.base.win/            → 302 /field/
//   <client>.base.win/air/…       → the client's Base Air
//   <client>.base.win/web         → 302 to the client's Base Web admin, signed in
//   <client>.base.win/…           → the client's Base Ground (field, desk, api, its pages)
//   base.win/                     → a plain landing page (www. redirects here)
//   any host /healthz             → { ok: true }
//
// BASE_HOST is the apex this front door serves: base.win in production,
// staging.base.win on staging (clients are then <client>.staging.base.win).
// Clients come from settings, one per app, so a Render Blueprint can fill
// them with each service's private address:
//   BASE_CLIENT_IMAGINESURREY_GROUND=base-ground-imaginesurrey:10000
//   BASE_CLIENT_IMAGINESURREY_AIR=base-air-imaginesurrey:10000
//   BASE_CLIENT_IMAGINESURREY_WEB=https://imaginesurrey.ca
// The slug is the part between BASE_CLIENT_ and the app, lower-cased, with _
// read as - (BASE_CLIENT_NORTH_SHORE_GROUND → north-shore.base.win).
//
// The path is passed on unchanged. Bodies stream both ways (300 MB list
// imports, server-sent events); a chunked body is re-chunked, never passed
// on without its framing; WebSocket upgrades are spliced only after the app
// answers 101.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

const APPS = ['GROUND', 'AIR', 'WEB'];
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
// Subdomains that are Base's own, never a client's.
const RESERVED = new Set(['www', 'staging', 'api', 'admin', 'app', 'mail', 'status', 'docs', 'help']);

// A target written as host:port (Render's private "hostport") is plain http
// inside the private network; anything else must be a full URL.
const toUrl = (value) => {
  const v = String(value || '').trim();
  if (!v) return null;
  try {
    return new URL(/^https?:\/\//i.test(v) ? v : `http://${v}`);
  } catch {
    return null;
  }
};

export const readClients = (env = process.env) => {
  const clients = new Map();
  const problems = [];
  for (const [key, value] of Object.entries(env)) {
    const m = /^BASE_CLIENT_([A-Z0-9_]+)_(GROUND|AIR|WEB)$/.exec(key);
    if (!m) continue;
    const slug = m[1].toLowerCase().replace(/_/g, '-');
    const url = toUrl(value);
    if (!SLUG.test(slug) || RESERVED.has(slug)) { problems.push(`${key}: "${slug}" can't be a client's address`); continue; }
    if (!url) { problems.push(`${key}: not an address`); continue; }
    if (m[2] === 'WEB' && url.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1)$/.test(url.hostname)) {
      problems.push(`${key}: Base Web is the public site, so it must be https://`);
      continue;
    }
    const c = clients.get(slug) || {};
    c[m[2].toLowerCase()] = url;
    clients.set(slug, c);
  }
  for (const [slug, c] of clients) {
    if (!c.ground) problems.push(`${slug}: no Base Ground (BASE_CLIENT_${slug.toUpperCase().replace(/-/g, '_')}_GROUND); its addresses answer 404`);
  }
  return { clients, problems };
};

// The host a request names: lower-case, without a port or a trailing dot.
const hostOf = (raw) => String(raw || '').trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');

// Where a request goes. Pure, so it's tested on its own.
export const route = (clients, apex, rawHost, requested) => {
  // Dot segments (also written %2e) are resolved first, so /a/../b can't be
  // read differently upstream.
  let rawPath;
  try {
    const u = new URL(requested, 'http://front.door');
    rawPath = u.pathname + u.search;
  } catch {
    return { kind: 'unknown' };
  }
  const q = rawPath.indexOf('?');
  const path = q === -1 ? rawPath : rawPath.slice(0, q);
  const query = q === -1 ? '' : rawPath.slice(q);
  if (path === '/healthz') return { kind: 'health' };
  const host = hostOf(rawHost);
  if (host === apex) return path === '/' ? { kind: 'landing' } : { kind: 'unknown' };
  if (host === `www.${apex}`) return { kind: 'redirect', location: `https://${apex}${rawPath}` };
  if (!host.endsWith(`.${apex}`)) return { kind: 'unknown' };
  const slug = host.slice(0, -(apex.length + 1));
  const client = SLUG.test(slug) ? clients.get(slug) : null; // one label only: a.b.base.win is nobody
  if (!client || !client.ground) return { kind: 'unknown' };
  if (path === '/') return { kind: 'redirect', location: `/field/${query}` };
  const first = path.split('/')[1];
  if (first === 'web') {
    // Only the bare /web address: the site's own pages live on its domain.
    if (!client.web || (path !== '/web' && path !== '/web/')) return { kind: 'unknown' };
    const to = new URL('/auth/base', client.web);
    to.searchParams.set('next', '/admin');
    return { kind: 'redirect', location: to.href };
  }
  if (first === 'air') {
    if (!client.air) return { kind: 'unknown' };
    return { kind: 'proxy', target: client.air, path: rawPath, slug, app: 'air' };
  }
  return { kind: 'proxy', target: client.ground, path: rawPath, slug, app: 'ground' };
};

// ── Pages of its own ──

const page = (status, title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><meta name="robots" content="noindex">
<style>
:root{color-scheme:light dark;--ink:#121614;--muted:#5b625e;--bg:#f6f5f1;--line:#dcdad2}
@media (prefers-color-scheme:dark){:root{--ink:#eceee9;--muted:#a5aba6;--bg:#111412;--line:#2a2f2b}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);
font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:34rem;padding:2.5rem 1.5rem}
.mark{font-weight:800;font-size:2.4rem;letter-spacing:-.04em;margin:0 0 .25rem}
.mark span{display:inline-block;width:.42em;height:.42em;border-radius:50%;background:currentColor;margin-left:.08em}
p{margin:.6rem 0;color:var(--muted)}h1{font-size:1.15rem;margin:1.5rem 0 .25rem}
code{background:var(--line);padding:.1em .35em;border-radius:4px;color:var(--ink)}
</style></head><body><main>
<p class="mark" aria-label="Base">Base<span aria-hidden="true"></span></p>
${body}
</main></body></html>`;

const LANDING = page(200, 'Base', `<p>The broad application for social engagement: organizing, the website and attention, for one campaign at a time.</p>
<h1>Looking for your campaign?</h1>
<p>Its address looks like <code><i>your-campaign</i>.base.win/field</code>. Ask whoever invited you for the link.</p>`);
const UNKNOWN = page(404, 'Not here', `<h1>Nothing at this address</h1>
<p>Check the link you were sent. A campaign's address looks like <code><i>your-campaign</i>.base.win/field</code>.</p>`);
const DOWN = page(502, 'Back soon', `<h1>This campaign's app isn't answering</h1>
<p>It may be starting up or being updated. Try again in a minute; anything you saved on your phone stays there until it's sent.</p>`);

const send = (res, status, html, extra = {}) => {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    ...extra,
  });
  res.end(html);
};

// ── Passing a request on ──

// Hop-by-hop headers are the connection's own and never forwarded.
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

const forwardHeaders = (req, target) => {
  const out = {};
  const named = String(req.headers.connection || '').toLowerCase().split(',').map((s) => s.trim());
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP.has(k) || named.includes(k)) continue;
    out[k] = v;
  }
  const ip = req.socket.remoteAddress || '';
  out['x-forwarded-for'] = req.headers['x-forwarded-for'] ? `${req.headers['x-forwarded-for']}, ${ip}` : ip;
  out['x-forwarded-proto'] = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
  out['x-forwarded-host'] = req.headers.host || ''; // never a visitor's own say-so
  out.host = target.host;
  return out;
};

const transportFor = (target) => (target.protocol === 'https:' ? https : http);

// A body framed by Transfer-Encoding (Node has already decoded it) is sent
// on chunked again: dropped framing would let the body be read upstream as a
// second request on a reused connection. Both framings at once is refused
// outright (RFC 9112 §6.1).
export const framingProblem = (headers) => (headers['transfer-encoding'] && headers['content-length'] !== undefined
  ? 'both Content-Length and Transfer-Encoding'
  : null);

const proxy = (req, res, r) => {
  const { target } = r;
  const headers = forwardHeaders(req, target);
  if (req.headers['transfer-encoding']) {
    headers['transfer-encoding'] = 'chunked';
    delete headers['content-length'];
  }
  const upstream = transportFor(target).request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    method: req.method,
    path: r.path,
    headers,
  }, (up) => {
    const headers = { ...up.headers };
    for (const h of HOP) delete headers[h];
    res.writeHead(up.statusCode || 502, up.statusMessage, headers);
    up.pipe(res);
  });
  upstream.setTimeout(0); // server-sent events stay open; the apps time out their own work
  upstream.on('error', (err) => {
    log('upstream', r.slug, r.app, err.code || err.message);
    if (!res.headersSent) send(res, 502, DOWN);
    else res.destroy();
  });
  req.on('aborted', () => upstream.destroy());
  req.pipe(upstream);
};

const upgrade = (clients, apex) => (req, socket, head) => {
  const r = route(clients, apex, req.headers.host, req.url || '/');
  if (r.kind !== 'proxy' || framingProblem(req.headers)) { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return; }
  const { target } = r;
  const port = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
  const up = target.protocol === 'https:'
    ? tls.connect({ host: target.hostname, port, servername: target.hostname })
    : net.connect({ host: target.hostname, port });
  const close = () => { socket.destroy(); up.destroy(); };
  up.on('error', close);
  socket.on('error', close);
  up.once(target.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
    const headers = forwardHeaders(req, target);
    headers.connection = 'Upgrade';
    headers.upgrade = req.headers.upgrade;
    const lines = [`${req.method} ${r.path} HTTP/1.1`, ...Object.entries(headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}: ${x}`) : [`${k}: ${v}`]))];
    up.write(`${lines.join('\r\n')}\r\n\r\n`);
    // The two sockets are joined only once the app has said 101. Anything else
    // is passed back as the answer and both connections close, so a request
    // that merely claims Upgrade can't turn the connection into a raw tunnel.
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) { if (buf.length > 16384) close(); return; }
      up.off('data', onData);
      const switching = /^HTTP\/1\.1 101 /.test(buf.subarray(0, Math.min(end, 64)).toString('latin1'));
      socket.write(buf);
      if (!switching) { socket.end(); up.destroy(); return; }
      if (head?.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    };
    up.on('data', onData);
  });
};

const log = (...parts) => console.log(new Date().toISOString(), ...parts);

export const createGateway = (env = process.env) => {
  const { clients, problems } = readClients(env);
  const apex = hostOf(env.BASE_HOST || 'base.win');
  for (const p of problems) console.warn(`Base front door: ${p}`);
  const server = http.createServer((req, res) => {
    if (framingProblem(req.headers)) {
      res.writeHead(400, { connection: 'close', 'content-type': 'text/plain' });
      res.end('Bad request');
      return;
    }
    const r = route(clients, apex, req.headers.host, req.url || '/');
    switch (r.kind) {
      case 'health':
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: true, service: 'base-gateway', commit: String(env.RENDER_GIT_COMMIT || '').slice(0, 7) || null }));
        return;
      case 'landing':
        send(res, 200, req.method === 'HEAD' ? '' : LANDING);
        return;
      case 'redirect':
        res.writeHead(302, { location: r.location, 'cache-control': 'no-store' });
        res.end();
        return;
      case 'proxy':
        proxy(req, res, r);
        return;
      default:
        send(res, 404, UNKNOWN);
    }
  });
  server.on('upgrade', upgrade(clients, apex));
  // Keep-alive longer than Render's load balancer so it never reuses a
  // connection this side has just closed.
  server.keepAliveTimeout = 75_000;
  server.headersTimeout = 80_000;
  server.requestTimeout = 0; // big uploads take as long as they take
  return { server, clients, apex };
};

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const { server, clients, apex } = createGateway();
  const port = Number(process.env.PORT) || 10000;
  server.listen(port, () => log(`Base front door on :${port} for ${apex}, ${clients.size} client${clients.size === 1 ? '' : 's'}: ${[...clients.keys()].join(', ') || 'none'}`));
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
