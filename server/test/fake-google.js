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
//   POST /gmail/v1/users/me/messages/send   Gmail's send (GMAIL_API_BASE):
//                                 needs a live token carrying gmail.send;
//                                 keeps each message, decoded (gmailSent)
//   /calendar/v3/…                Google Calendar (GOOGLE_CALENDAR_API_BASE =
//                                 <base>/calendar/v3): POST /calendars, PATCH
//                                 and DELETE /calendars/:id, POST
//                                 /calendars/:id/events, PUT and DELETE
//                                 …/events/:eid. Event ids must be base32hex
//                                 (0-9a-v, 5–1024); deleted ids are kept (insert
//                                 → 409; PUT status confirmed restores)
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
//                                 'gmail': 401, invalidArgument (400),
//                                 insufficientPermissions, rateLimitExceeded,
//                                 dailyLimitExceeded (403s), 429
//                                 ({ retryAfter }), accessNotConfigured (403,
//                                 PERMISSION_DENIED, SERVICE_DISABLED), 500,
//                                 hang (answers only after slowMs)
//   revokeAll(sub)                as if the person removed base.win in
//                                 their Google Account
//   account({ sub, email, hd, name })   add a test account
//   cal.next(kind, { route?, sub?, reason?, retryAfter?, ms? })   the next
//                                 Calendar answer: 404, 410, 403 (reason),
//                                 429, 500, slow — for one route
//                                 (calendars.insert, calendars.patch,
//                                 calendars.delete, events.insert,
//                                 events.update, events.delete) or user
//   cal.calendars(sub) · cal.dropCalendar(id) · cal.dropEvent(cal, eid) ·
//   cal.counts (per route) · cal.calls [{ route, sub, query, at }] · order
//                                 (Calendar calls and revokes, in order)
//   setNarrow(true | false | 'refuse')   how a refresh honours scope=
//   drive                         Drive and Sheets (fake-google-drive.js)
//   counts { auth, token, refresh, revoke, api, discovery, gmail } · revoked
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
  const knobs = { auth: [], token: [], refresh: [], revoke: [], api: [], gmail: [] };
  const counts = { auth: 0, token: 0, refresh: 0, revoke: 0, api: 0, discovery: 0, gmail: 0 };
  const gmailSent = []; // { raw (the message, decoded), headers, body, token sub }
  const revoked = new Map(); // token → times
  const apiCalls = [];
  const order = []; // Calendar calls and revokes, in the order they came
  const orderBy = []; // the same, each with its Google account
  let base = '';
  // ── Google Calendar ──
  const cals = new Map(); // id → { id, sub, body, deleted, events: Map(eid → { body, deleted }) }
  const calKnobs = [];
  const calCounts = {};
  const calCalls = [];
  const CAL_ID = /^[0-9a-v]{5,1024}$/;
  const calAnswer = async (req, res, u, raw) => {
    const parts = u.pathname.replace(/^\/calendar\/v3\//, '').split('/').map(decodeURIComponent);
    const m = req.method;
    let route = null;
    if (parts[0] === 'calendars' && parts.length === 1 && m === 'POST') route = 'calendars.insert';
    else if (parts[0] === 'calendars' && parts.length === 2 && m === 'PATCH') route = 'calendars.patch';
    else if (parts[0] === 'calendars' && parts.length === 2 && m === 'DELETE') route = 'calendars.delete';
    else if (parts[0] === 'calendars' && parts[2] === 'events' && parts.length === 3 && m === 'POST') route = 'events.insert';
    else if (parts[0] === 'calendars' && parts[2] === 'events' && parts.length === 4 && m === 'PUT') route = 'events.update';
    else if (parts[0] === 'calendars' && parts[2] === 'events' && parts.length === 4 && m === 'DELETE') route = 'events.delete';
    if (!route) return json(res, 404, { error: { code: 404, message: 'Not Found' } });
    const bearer = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const t = accessTokens.get(bearer);
    if (!t || !t.alive || t.expiresAt < Date.now()) return json(res, 401, { error: { code: 401, message: 'Invalid Credentials', errors: [{ reason: 'authError' }] } });
    calCounts[route] = (calCounts[route] || 0) + 1;
    const query = Object.fromEntries(u.searchParams);
    calCalls.push({ route, sub: t.sub, query, at: Date.now(), path: u.pathname });
    order.push(route);
    orderBy.push([route, t.sub]);
    const i = calKnobs.findIndex((k) => (!k.route || k.route === route) && (!k.sub || k.sub === t.sub));
    const knob = i >= 0 ? calKnobs.splice(i, 1)[0] : null;
    if (knob?.kind === 'slow') await later(knob.ms || slowMs);
    const err = (code, reason, message) => json(res, code, { error: { code, message, errors: [{ reason, message }] } });
    if (knob?.kind === '404') return err(404, 'notFound', 'Not Found');
    if (knob?.kind === '410') return err(410, 'deleted', 'Resource has been deleted');
    if (knob?.kind === '403') return err(403, knob.reason || 'forbidden', `Forbidden: ${knob.reason || 'forbidden'} (fake google text)`);
    if (knob?.kind === '429') return json(res, 429, { error: { code: 429, message: 'Rate Limit Exceeded', errors: [{ reason: 'rateLimitExceeded' }] } }, knob.retryAfter ? { 'retry-after': String(knob.retryAfter) } : {});
    if (knob?.kind === '500') return err(500, 'backendError', 'Backend Error');
    const body = raw ? JSON.parse(raw) : {};
    if (route === 'calendars.insert') {
      const id = `${randomBytes(12).toString('hex')}@group.calendar.example`;
      cals.set(id, { id, sub: t.sub, body, deleted: false, events: new Map() });
      return json(res, 200, { kind: 'calendar#calendar', id, ...body });
    }
    const cal = cals.get(parts[1]);
    if (!cal || cal.deleted || cal.sub !== t.sub) return err(404, 'notFound', 'Not Found');
    if (route === 'calendars.patch') { Object.assign(cal.body, body); return json(res, 200, { id: cal.id, ...cal.body }); }
    if (route === 'calendars.delete') { cal.deleted = true; res.writeHead(204); return res.end(); }
    if (route === 'events.insert') {
      if (!CAL_ID.test(String(body.id || ''))) return err(400, 'invalid', 'Invalid resource id value.');
      if (cal.events.has(body.id)) return err(409, 'duplicate', 'The requested identifier already exists.');
      cal.events.set(body.id, { body, deleted: false });
      return json(res, 200, { kind: 'calendar#event', ...body });
    }
    const eid = parts[3];
    if (!CAL_ID.test(eid)) return err(400, 'invalid', 'Invalid resource id value.');
    const ev = cal.events.get(eid);
    if (route === 'events.update') {
      if (!ev) return err(404, 'notFound', 'Not Found');
      if (ev.deleted && body.status !== 'confirmed') return err(410, 'deleted', 'Resource has been deleted');
      cal.events.set(eid, { body: { ...body, id: eid }, deleted: false });
      return json(res, 200, { kind: 'calendar#event', ...body, id: eid });
    }
    if (!ev) return err(404, 'notFound', 'Not Found');
    if (ev.deleted) return err(410, 'deleted', 'Resource has been deleted');
    ev.deleted = true;
    res.writeHead(204);
    return res.end();
  };
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
        order.push('revoke');
        const knob = take('revoke');
        if (knob?.kind === 'slow') await later(slowMs);
        if (knob?.kind === '500') return json(res, 500, { error: 'internal_failure' });
        const t = form.token;
        revoked.set(t, (revoked.get(t) || 0) + 1);
        const owner = refreshTokens.get(t) || accessTokens.get(t);
        orderBy.push(['revoke', owner?.sub || null]);
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
      if (u.pathname === '/gmail/v1/users/me/messages/send' && req.method === 'POST') {
        counts.gmail += 1;
        const knob = take('gmail');
        const gerr = (status, reason, message, extra = {}) => json(res, status, { error: { code: status, message, errors: [{ message, domain: 'global', reason }], ...extra } });
        if (knob?.kind === 'hang') { await later(slowMs); return json(res, 200, { id: rand('late-'), threadId: 't' }); }
        if (knob?.kind === '500') return json(res, 500, { error: { code: 500, message: 'Backend Error', status: 'INTERNAL' } });
        if (knob?.kind === '401') return json(res, 401, { error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } });
        if (knob?.kind === 'invalidArgument') return gerr(400, 'invalidArgument', 'Invalid To header');
        if (knob?.kind === 'insufficientPermissions') return gerr(403, 'insufficientPermissions', 'Request had insufficient authentication scopes.', { status: 'PERMISSION_DENIED', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] });
        if (knob?.kind === 'rateLimitExceeded') return gerr(403, 'rateLimitExceeded', 'Rate Limit Exceeded');
        if (knob?.kind === 'dailyLimitExceeded') return gerr(403, 'dailyLimitExceeded', 'Daily Limit Exceeded');
        if (knob?.kind === '429') return json(res, 429, { error: { code: 429, message: 'Too many requests', status: 'RESOURCE_EXHAUSTED' } }, knob.retryAfter ? { 'retry-after': String(knob.retryAfter) } : {});
        if (knob?.kind === 'accessNotConfigured') {
          return gerr(403, 'accessNotConfigured', 'Gmail API has not been used in project 0 before or it is disabled.', {
            status: 'PERMISSION_DENIED', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED' }],
          });
        }
        const bearer = String(req.headers.authorization || '').replace(/^Bearer /, '');
        const t = accessTokens.get(bearer);
        if (!t || !t.alive || t.expiresAt < Date.now()) return json(res, 401, { error: { code: 401, message: 'Invalid Credentials', status: 'UNAUTHENTICATED' } });
        if (!t.scopes.includes('https://www.googleapis.com/auth/gmail.send')) return gerr(403, 'insufficientPermissions', 'Request had insufficient authentication scopes.');
        let msg;
        try { msg = JSON.parse(raw); } catch { return gerr(400, 'invalidArgument', 'Invalid JSON payload'); }
        if (!msg?.raw) return gerr(400, 'invalidArgument', "'raw' RFC822 payload message string or uploading message via /upload/* URL required");
        const text = Buffer.from(String(msg.raw), 'base64url').toString('utf8');
        const [head] = text.split('\r\n\r\n');
        const headers = Object.fromEntries(head.split('\r\n').map((l) => [l.slice(0, l.indexOf(':')).toLowerCase(), l.slice(l.indexOf(':') + 1).trim()]));
        const body = Buffer.from(text.slice(head.length + 4).replace(/\r\n/g, ''), 'base64').toString('utf8');
        const id = rand('18f').slice(0, 16);
        gmailSent.push({ id, raw: text, headers, body, sub: t.sub });
        return json(res, 200, { id, threadId: id, labelIds: ['SENT'] });
      }
      if (u.pathname.startsWith('/calendar/v3/')) return await calAnswer(req, res, u, raw);
      if (u.pathname.startsWith('/__') && req.method === 'POST') {
        const body = raw ? JSON.parse(raw) : {};
        const name = u.pathname.slice(3);
        if (name === 'next') { api.next(body.endpoint, body.knob, body); return json(res, 200, { ok: true }); }
        if (name === 'revokeAll') { api.revokeAll(body.sub); return json(res, 200, { ok: true }); }
        if (name === 'account') { api.account(body); return json(res, 200, { ok: true }); }
        if (name === 'counts') return json(res, 200, counts);
        if (name === 'cal.next') { api.cal.next(body.kind, body); return json(res, 200, { ok: true }); }
        if (name === 'cal.calendars') return json(res, 200, api.cal.calendars(body.sub));
        if (name === 'cal.dropCalendar') { api.cal.dropCalendar(body.id); return json(res, 200, { ok: true }); }
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
    base, server, counts, revoked, apiCalls, gmailSent,
    authorize,
    next: (endpoint, kind, opts = {}) => { knobs[endpoint].push({ kind: String(kind), ...opts }); },
    clearKnobs: () => { for (const k of Object.keys(knobs)) knobs[k].length = 0; calKnobs.length = 0; },
    order,
    orderOf: (sub) => orderBy.filter(([, s]) => s === sub).map(([what]) => what),
    cal: {
      next: (kind, opts = {}) => { calKnobs.push({ ...opts, kind: String(kind) }); },
      // Live calendars (of one Google account, or all), each with its live events.
      calendars: (sub) => [...cals.values()].filter((c) => !c.deleted && (!sub || c.sub === sub)).map((c) => ({
        id: c.id, sub: c.sub, body: { ...c.body },
        events: [...c.events].filter(([, e]) => !e.deleted).map(([id, e]) => ({ id, ...e.body })),
      })),
      dropCalendar: (id) => { const c = cals.get(id); if (c) c.deleted = true; },
      dropEvent: (calId, eid) => { const e = cals.get(calId)?.events.get(eid); if (e) e.deleted = true; },
      counts: calCounts,
      calls: calCalls,
      reset: () => { for (const k of Object.keys(calCounts)) delete calCounts[k]; calCalls.length = 0; order.length = 0; orderBy.length = 0; calKnobs.length = 0; },
    },
    revokeAll: (sub) => revokeGrant(sub),
    setNarrow: (v) => { narrow = v; },
    drive: drive.api,
    account: (a) => people.set(a.sub, { hd: null, ...a }),
    resetCounts: () => { for (const k of Object.keys(counts)) counts[k] = 0; revoked.clear(); apiCalls.length = 0; gmailSent.length = 0; },
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
