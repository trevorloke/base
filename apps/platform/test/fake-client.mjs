// Tests only: a stand-in for a campaign's server, for e2e-ops.mjs until the
// real one (builder A's /api/auth/operator and the Enter page) is merged.
// It answers /api/health with every field the control centre reads, and
// serves /admin/enter: a page that drops the #t= fragment, posts the token
// to /api/auth/operator (checked with the campaign side's rules, written
// again in verify-entry.mjs), and lands on /admin/ (or Settings → Members
// for an invite) with "You’re in as base.win support".
//   startFakeClient({ port, env, publicKey, address?, ownOrigin?, instance?, commit? }) → { close, reset, state }
// state.over: health fields a test changes for a while (store, setupOpen, commit…).
//
// startPublicAddresses({ port, clients: { <name>: its origin } }) stands in
// for every client's public address (https://<name>.base.win) on one port:
// with OPS_PUBLIC_TEMPLATE=http://127.0.0.1:<port>/{name}, /<name>/… there
// is that client's server, as a custom domain on its service would be.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { verifyEntry, parseKeys } from './verify-entry.mjs';

const ENTER_JS = `(() => {
  const say = (t) => { document.getElementById('say').textContent = t; };
  const m = /^#t=(.+)$/.exec(location.hash);
  history.replaceState(null, '', location.pathname);
  if (!m) return say('Nothing to open here.');
  say('Opening the desk…');
  fetch('/api/auth/operator', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: decodeURIComponent(m[1]) }) })
    .then(async (r) => {
      const body = await r.json();
      if (!r.ok) return say(body.error || 'That link has run out. Open the desk again from the control centre.');
      location.replace(body.go === '/desk/settings/members' ? '/admin/settings/members' : '/admin/');
    })
    .catch(() => say('Not answering.'));
})();`;

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;margin:0;padding:0}.bar{background:#eef;border-bottom:2px solid #c80;padding:12px 16px}main{padding:16px}</style></head><body>${body}</body></html>`;

export const startFakeClient = ({ port, env = 'production', publicKey, address = null, ownOrigin = `http://127.0.0.1:${port}`, instance = randomBytes(16).toString('base64url'), commit = 'f00dfee' }) => {
  const keys = parseKeys(publicKey);
  const state = { nonces: new Set(), sessions: new Map(), invites: [], refused: [], made: false, over: {} };
  const own = `http://127.0.0.1:${port}`;
  const health = () => ({
    ok: true, database: 'ok', store: 'postgres', service: 'base.win', env, organization: 'Example Campaign', commit, build: 'index-test.js', tzdataCurrent: true,
    ownOrigin, instance, address: address || own, entry: keys.length ? 'ready' : 'no-key',
    platformKids: keys.map((k) => k.kid), setupOpen: false, campaignMade: state.made, ...state.over,
  });
  const sessionOf = (req) => {
    const sid = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    return sid && state.sessions.get(sid);
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url, own);
    const send = (status, type, body, headers = {}) => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers }); res.end(body); };
    const json = (status, body, headers) => send(status, 'application/json', JSON.stringify(body), headers);
    if (url.pathname === '/api/health') return json(200, health());
    if (url.pathname === '/admin/enter') return send(200, 'text/html; charset=utf-8', page('Opening the desk', '<main><p id="say" role="status" aria-live="polite"></p></main><script src="/admin/enter.js"></script>'));
    if (url.pathname === '/admin/enter.js') return send(200, 'text/javascript', ENTER_JS);
    if (url.pathname === '/api/auth/operator' && req.method === 'POST') {
      let raw = '';
      req.on('data', (d) => { raw += d; });
      req.on('end', () => {
        const no = (why) => { state.refused.push(why); return json(401, { error: 'That link has run out. Open the desk again from the control centre.', code: 'entry' }); };
        if (req.headers.origin !== own) return no('origin');
        let token;
        try { token = JSON.parse(raw).token; } catch { return no('body'); }
        const r = verifyEntry(token, { keys, aud: own, env, inst: instance });
        if (!r.ok) return no(r.why);
        if (state.nonces.has(r.payload.nonce)) return no('replay');
        state.nonces.add(r.payload.nonce);
        state.made = true; // the first entry makes the workspace
        const sid = randomBytes(16).toString('hex');
        state.sessions.set(sid, { until: Date.now() + 2 * 3600_000, op: r.payload.op.id });
        if (r.payload.invite) state.invites.push(r.payload.invite.email);
        return json(200, { go: r.payload.go, invite: r.payload.invite }, { 'set-cookie': `sid=${sid}; Path=/; HttpOnly; SameSite=Lax` });
      });
      return undefined;
    }
    if (url.pathname === '/admin/' || url.pathname === '/admin/settings/members') {
      const s = sessionOf(req);
      if (!s) return send(200, 'text/html; charset=utf-8', page('Sign in', '<main><h1>Sign in</h1></main>'));
      const until = new Date(s.until).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' });
      const members = url.pathname.endsWith('/members')
        ? `<h2>Members</h2><ul>${state.invites.map((e) => `<li>Invited ${e}</li>`).join('')}</ul>` : '<h1>Today</h1>';
      return send(200, 'text/html; charset=utf-8', page('Desk', `<div class="bar" role="status">You’re in as base.win support · until ${until}</div><main><p>Signed in</p>${members}</main>`));
    }
    return json(404, { error: 'Not found' });
  });
  server.listen(port, '127.0.0.1');
  return {
    state, instance, own,
    reset: () => { state.sessions.clear(); state.invites.length = 0; state.made = false; state.over = {}; },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
};

// Every client's public address on one port: /<name>/<path> is passed to
// that client's own server (GET only, which is all a health check needs).
// clients may be changed while it runs; `down` names are not answering.
export const startPublicAddresses = ({ port, clients = {} }) => {
  const down = new Set();
  const server = createServer(async (req, res) => {
    const m = /^\/([a-z0-9-]+)(\/.*)$/.exec(req.url || '');
    const origin = m && !down.has(m[1]) ? clients[m[1]] : null;
    if (!origin || req.method !== 'GET') { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"error":"Not found"}'); }
    try {
      const r = await fetch(`${origin}${m[2]}`, { redirect: 'manual' });
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json', 'cache-control': 'no-store' });
      return res.end(await r.text());
    } catch {
      res.writeHead(502, { 'content-type': 'application/json' });
      return res.end('{"error":"Not answering"}');
    }
  });
  server.listen(port, '127.0.0.1');
  return {
    clients, down, template: `http://127.0.0.1:${port}/{name}`,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
};

// node apps/platform/test/fake-client.mjs  (PORT, BASE_ENV, BASE_PLATFORM_PUBKEY, BASE_PUBLIC_URL)
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const c = startFakeClient({ port: Number(process.env.PORT) || 5601, env: process.env.BASE_ENV || 'production', publicKey: process.env.BASE_PLATFORM_PUBKEY, address: process.env.BASE_PUBLIC_URL || null });
  console.log(`fake campaign server on ${c.own}`);
}
