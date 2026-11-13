// A stand-in for Google's sign-in and token endpoints, so Google sign-in and
// connections are tested with no Google account and no network. Point
// base.win at it with GOOGLE_ACCOUNTS_BASE and GOOGLE_OAUTH_BASE (both
// http://127.0.0.1:<port>; ignored in production).
//
//   In a test:   const g = await startFakeGoogle({ port: 0, clientId, secret, redirectUris })
//   On its own:  PORT=5301 CLIENT_ID=… CLIENT_SECRET=… REDIRECT_URIS=http://127.0.0.1:5300/api/auth/google/back \
//                node server/test/fake-google.js
//
// What base.win calls:
//   GET  /o/oauth2/v2/auth        the sign-in page: one button per test
//                                 account, and Cancel (an unregistered
//                                 redirect_uri → 400 redirect_uri_mismatch;
//                                 the Check's bare request → 302)
//   GET  /o/oauth2/v2/auth/pick   a button: → redirect_uri?code=…&state=…
//                                 (or error=access_denied for Cancel)
//   POST /token                   authorization_code (PKCE S256, the exact
//                                 redirect address) and refresh_token
//                                 (scope= narrows it)
//   POST /revoke                  token= ends the whole grant (every token
//                                 of that account for this client)
//   GET  /.well-known/openid-configuration
//   ANY  /test-api/*              an API host stand-in: needs a live access
//                                 token (Authorization: Bearer)
//
// In code, for tests (or over HTTP: POST /__name with JSON):
//   authorize(authUrl, sub | { cancel }) → the back address Google would
//                                 send the browser to (no HTTP)
//   next(endpoint, knob, opts)    the next answer of 'auth' | 'token' |
//                                 'refresh' | 'revoke' | 'api': invalid_client,
//                                 invalid_grant, admin_policy_enforced, slow,
//                                 500, 503, 429 ({ retryAfter }), quota
//                                 (403 userRateLimitExceeded), 401,
//                                 partial_scope, no_refresh, wrong_aud,
//                                 wrong_nonce, wrong_iss, expired
//   revokeAll(sub)                as if the person removed base.win in
//                                 their Google Account
//   account({ sub, email, hd, name })   add a test account
//   setNarrow(true | false | 'refuse')   how a refresh honours scope=
//   drive                         Drive and Sheets (fake-google-drive.js)
//   counts { auth, token, refresh, revoke, api, discovery } · revoked
//   (tokens revoked, each with its count) · tokens() (every token issued)
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { fakeDrive } from './fake-google-drive.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const rand = (p) => `${p}${randomBytes(18).toString('base64url')}`;

export const DEFAULT_ACCOUNTS = [
  { sub: '100000000000000000001', email: 'ann.example@gmail.com', hd: null, name: 'Ann Example' },
  { sub: '100000000000000000002', email: 'bo@campaign.example.org', hd: 'campaign.example.org', name: 'Bo Example' },
  { sub: '100000000000000000003', email: 'cy.example@gmail.com', hd: null, name: 'Cy Example' },
];

export const startFakeGoogle = async ({ port = 0, clientId, secret, redirectUris = [], accounts = DEFAULT_ACCOUNTS, slowMs = 9000 } = {}) => {
  const people = new Map(accounts.map((a) => [a.sub, { ...a }]));
  const codes = new Map(); // code → { sub, redirectUri, challenge, nonce, scopes, used }
  const grants = new Map(); // sub → { scopes:Set, alive:true }
  const refreshTokens = new Map(); // token → { sub, alive }
  const accessTokens = new Map(); // token → { sub, scopes, expiresAt, alive }
  const knobs = { auth: [], token: [], refresh: [], revoke: [], api: [] };
  const counts = { auth: 0, token: 0, refresh: 0, revoke: 0, api: 0, discovery: 0 };
  const revoked = new Map(); // token → times
  const apiCalls = [];
  let base = '';
  // How a refresh with scope= answers: true narrows it; false answers every
  // scope the grant has (as if Google ignored it); 'refuse' is invalid_scope.
  let narrow = true;
  // Drive and Sheets (fake-google-drive.js).
  const drive = fakeDrive({ accessTokens, people, base: () => base });

  const take = (endpoint) => knobs[endpoint].shift() || null;
  const json = (res, status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
  const later = (ms) => new Promise((r) => { setTimeout(r, ms).unref?.(); });

  const idToken = (sub, nonce, knob) => {
    const p = people.get(sub);
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: knob?.kind === 'wrong_iss' ? 'https://evil.example.org' : 'https://accounts.google.com',
      aud: knob?.kind === 'wrong_aud' ? 'someone-else.apps.example' : clientId,
      exp: knob?.kind === 'expired' ? now - 3600 : now + 3600,
      iat: knob?.kind === 'expired' ? now - 7200 : now,
      nonce: knob?.kind === 'wrong_nonce' ? 'not-the-nonce' : nonce,
      sub, email: p.email, email_verified: true, name: p.name, ...(p.hd ? { hd: p.hd } : {}),
    };
    return `${b64url({ alg: 'RS256', kid: 'fake' })}.${b64url(claims)}.${Buffer.from('not-a-signature').toString('base64url')}`;
  };
  const issueAccess = (sub, scopes) => {
    const token = rand('ya29.fake-');
    accessTokens.set(token, { sub, scopes: [...scopes], expiresAt: Date.now() + 3600_000, alive: true });
    return token;
  };
  const revokeGrant = (sub) => {
    const g = grants.get(sub);
    if (g) g.alive = false;
    for (const t of refreshTokens.values()) if (t.sub === sub) t.alive = false;
    for (const t of accessTokens.values()) if (t.sub === sub) t.alive = false;
  };

  const authorize = (authUrl, pick) => {
    const u = new URL(authUrl);
    const q = Object.fromEntries(u.searchParams);
    const back = new URL(q.redirect_uri);
    const knob = take('auth');
    counts.auth += 1;
    if (pick?.cancel) back.searchParams.set('error', 'access_denied');
    else if (knob?.kind === 'admin_policy_enforced') back.searchParams.set('error', 'admin_policy_enforced');
    else {
      const sub = typeof pick === 'string' ? pick : pick?.sub;
      if (!people.has(sub)) throw new Error(`fake google: no account ${sub}`);
      const code = rand('4/fake-');
      codes.set(code, {
        sub, redirectUri: q.redirect_uri, challenge: q.code_challenge, method: q.code_challenge_method,
        nonce: q.nonce, scopes: String(q.scope || '').split(' ').filter(Boolean), incremental: q.include_granted_scopes === 'true',
        offline: q.access_type === 'offline', used: false, at: Date.now(),
      });
      back.searchParams.set('code', code);
    }
    if (q.state) back.searchParams.set('state', q.state);
    return back.toString();
  };

  const tokenAnswer = async (res, form) => {
    if (form.client_id !== clientId || form.client_secret !== secret) return json(res, 401, { error: 'invalid_client', error_description: 'The OAuth client was not found.' });
    if (form.grant_type === 'authorization_code') {
      counts.token += 1;
      const knob = take('token');
      if (knob?.kind === 'slow') await later(slowMs);
      if (knob?.kind === 'invalid_client') return json(res, 401, { error: 'invalid_client' });
      if (knob?.kind === '500') return json(res, 500, { error: 'internal_failure' });
      const c = codes.get(form.code);
      if (!c || c.used || knob?.kind === 'invalid_grant') return json(res, 400, { error: 'invalid_grant', error_description: 'Bad Request' });
      if (c.redirectUri !== form.redirect_uri) return json(res, 400, { error: 'redirect_uri_mismatch' });
      const challenge = createHash('sha256').update(String(form.code_verifier || '')).digest('base64url');
      if (c.method !== 'S256' || challenge !== c.challenge) return json(res, 400, { error: 'invalid_grant', error_description: 'Missing code verifier.' });
      c.used = true;
      const g = grants.get(c.sub);
      const scopes = new Set([...(c.incremental && g?.alive ? g.scopes : []), ...c.scopes]);
      if (knob?.kind === 'partial_scope') for (const s of [...scopes]) if (!['openid', 'email', 'profile'].includes(s)) { scopes.delete(s); break; }
      grants.set(c.sub, { scopes, alive: true });
      const out = {
        access_token: issueAccess(c.sub, scopes), expires_in: 3599, token_type: 'Bearer',
        scope: [...scopes].join(' '), id_token: idToken(c.sub, c.nonce, knob),
      };
      if (c.offline && knob?.kind !== 'no_refresh') {
        out.refresh_token = rand('1//fake-');
        refreshTokens.set(out.refresh_token, { sub: c.sub, alive: true });
      }
      return json(res, 200, out);
    }
    if (form.grant_type === 'refresh_token') {
      counts.refresh += 1;
      const knob = take('refresh');
      if (knob?.kind === 'slow') await later(slowMs);
      if (knob?.kind === 'invalid_client') return json(res, 401, { error: 'invalid_client' });
      if (knob?.kind === '500') return json(res, 500, { error: 'internal_failure' });
      const t = refreshTokens.get(form.refresh_token);
      if (!t || !t.alive || knob?.kind === 'invalid_grant') return json(res, 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
      const g = grants.get(t.sub);
      let scopes = [...g.scopes];
      if (form.scope) {
        const want = String(form.scope).split(' ').filter(Boolean);
        if (want.some((s) => !g.scopes.has(s)) || narrow === 'refuse') return json(res, 400, { error: 'invalid_scope' });
        if (narrow !== false) scopes = want;
      }
      return json(res, 200, { access_token: issueAccess(t.sub, scopes), expires_in: 3599, token_type: 'Bearer', scope: scopes.join(' ') });
    }
    return json(res, 400, { error: 'unsupported_grant_type' });
  };

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://fake');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const form = Object.fromEntries(new URLSearchParams(raw));
    try {
      if (u.pathname === '/.well-known/openid-configuration') {
        counts.discovery += 1;
        return json(res, 200, { issuer: 'https://accounts.google.com', authorization_endpoint: `${base}/o/oauth2/v2/auth`, token_endpoint: `${base}/token`, revocation_endpoint: `${base}/revoke` });
      }
      if (u.pathname === '/o/oauth2/v2/auth') {
        const q = Object.fromEntries(u.searchParams);
        if (q.client_id !== clientId) return json(res, 401, { error: 'invalid_client' });
        if (!redirectUris.includes(q.redirect_uri)) { res.writeHead(400, { 'content-type': 'text/html' }); return res.end('<p>Error 400: redirect_uri_mismatch</p>'); }
        // The Services Check: no state, nobody choosing — Google's chooser.
        if (!q.state) { res.writeHead(302, { location: `${base}/signin/chooser` }); return res.end(); }
        const pick = (extra) => `/o/oauth2/v2/auth/pick?${new URLSearchParams({ ...q, ...extra })}`;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>Sign in – Google Accounts (fake)</title>
<h1>Choose an account</h1><p>to continue to base.win</p>
${[...people.values()].map((p) => `<p><a class="acct" data-sub="${esc(p.sub)}" href="${esc(pick({ pick: p.sub }))}">${esc(p.name)} — ${esc(p.email)}</a></p>`).join('\n')}
<p><a id="cancel" href="${esc(pick({ cancel: '1' }))}">Cancel</a></p>`);
      }
      if (u.pathname === '/o/oauth2/v2/auth/pick') {
        const q = Object.fromEntries(u.searchParams);
        const auth = new URL(`${base}/o/oauth2/v2/auth`);
        for (const [k, v] of Object.entries(q)) if (k !== 'pick' && k !== 'cancel') auth.searchParams.set(k, v);
        res.writeHead(302, { location: authorize(auth.toString(), q.cancel ? { cancel: true } : q.pick) });
        return res.end();
      }
      if (u.pathname === '/token' && req.method === 'POST') return await tokenAnswer(res, form);
      if (await drive.handle(req, res, u, raw, form)) return;
      if (u.pathname === '/revoke' && req.method === 'POST') {
        counts.revoke += 1;
        const knob = take('revoke');
        if (knob?.kind === 'slow') await later(slowMs);
        if (knob?.kind === '500') return json(res, 500, { error: 'internal_failure' });
        const t = form.token;
        revoked.set(t, (revoked.get(t) || 0) + 1);
        const owner = refreshTokens.get(t) || accessTokens.get(t);
        if (!owner || !owner.alive) return json(res, 400, { error: 'invalid_token' });
        revokeGrant(owner.sub);
        return json(res, 200, {});
      }
      if (u.pathname.startsWith('/test-api/')) {
        counts.api += 1;
        const knob = take('api');
        apiCalls.push({ path: u.pathname, host: req.headers.host });
        if (knob?.kind === 'slow') await later(slowMs);
        if (knob?.kind === '500' || knob?.kind === '503') return json(res, Number(knob.kind), { error: { code: Number(knob.kind), message: 'Backend Error' } });
        if (knob?.kind === '429') return json(res, 429, { error: { code: 429, message: 'Too many requests' } }, knob.retryAfter ? { 'retry-after': String(knob.retryAfter) } : {});
        if (knob?.kind === 'quota') return json(res, 403, { error: { code: 403, message: 'User Rate Limit Exceeded', errors: [{ reason: 'userRateLimitExceeded' }] } });
        if (knob?.kind === '403') return json(res, 403, { error: { code: 403, message: 'Insufficient Permission', errors: [{ reason: 'insufficientPermissions' }] } });
        const bearer = String(req.headers.authorization || '').replace(/^Bearer /, '');
        const t = accessTokens.get(bearer);
        if (knob?.kind === '401' || !t || !t.alive || t.expiresAt < Date.now()) return json(res, 401, { error: { code: 401, message: 'Invalid Credentials' } });
        return json(res, 200, { ok: true, path: u.pathname, scopes: t.scopes });
      }
      if (u.pathname.startsWith('/__') && req.method === 'POST') {
        const body = raw ? JSON.parse(raw) : {};
        const name = u.pathname.slice(3);
        if (name === 'next') { api.next(body.endpoint, body.knob, body); return json(res, 200, { ok: true }); }
        if (name === 'revokeAll') { api.revokeAll(body.sub); return json(res, 200, { ok: true }); }
        if (name === 'account') { api.account(body); return json(res, 200, { ok: true }); }
        if (name === 'counts') return json(res, 200, counts);
        if (name === 'narrow') { narrow = body.narrow; return json(res, 200, { ok: true }); }
      }
      return json(res, 404, { error: 'not_found' });
    } catch (e) {
      return json(res, 500, { error: String(e.message) });
    }
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const api = {
    base, server, counts, revoked, apiCalls,
    authorize,
    next: (endpoint, kind, opts = {}) => { knobs[endpoint].push({ kind: String(kind), ...opts }); },
    clearKnobs: () => { for (const k of Object.keys(knobs)) knobs[k].length = 0; },
    revokeAll: (sub) => revokeGrant(sub),
    setNarrow: (v) => { narrow = v; },
    drive: drive.api,
    account: (a) => people.set(a.sub, { hd: null, ...a }),
    resetCounts: () => { for (const k of Object.keys(counts)) counts[k] = 0; revoked.clear(); apiCalls.length = 0; },
    tokens: () => [...refreshTokens.keys(), ...accessTokens.keys()],
    close: () => new Promise((r) => server.close(r)),
  };
  return api;
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const g = await startFakeGoogle({
    port: Number(process.env.PORT) || 5301,
    clientId: process.env.CLIENT_ID || 'fake-client.apps.example',
    secret: process.env.CLIENT_SECRET || 'fake-secret',
    redirectUris: String(process.env.REDIRECT_URIS || '').split(',').filter(Boolean),
  });
  console.log(`fake google on ${g.base}`);
}
