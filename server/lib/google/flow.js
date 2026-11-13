// Talking to Google's token endpoint (/token and /revoke): the code
// exchange, refreshing, revoking — and the one server-wide pause that
// follows a refusal there (the map tiles' pattern, lib/gtiles.js). Only
// sign-in's start and back obey this pause; an API host's trouble never
// stops anyone signing in (tokens.js keeps those pauses apart).
//
//   tokenCall(form)        → { ok, status, body, error, trouble }
//   tokenPaused()          → { code, until, plain } | null
//   readIdToken(idToken, { nonce }) → claims | { refused: '<which check>' }
//   scrubbed(text)         Google's words, no code/state/token/key in them
//
// Nothing here logs a code, a state, a verifier, a nonce, a token, a sub or
// a Google email.
import { clientId, clientSecret, oauthBase, TOKEN_PATH, REVOKE_PATH } from './config.js';

// One timeout for the token endpoint: 8 s (a test makes it shorter).
let TOKEN_TIMEOUT_MS = 8000;
export const tokenTimeoutMs = () => TOKEN_TIMEOUT_MS;
export const _setTokenTimeoutForTest = (ms) => { TOKEN_TIMEOUT_MS = ms; };

// Error text that reaches a log or an answer: the connections scrub
// (ext/connections), extended to a code, a state and any token.
export const scrubbed = (text) => String(text ?? '')
  .replace(/([?&]?\b(key|token|apikey|code|state|access_token|refresh_token|id_token|client_secret)=)[^&\s"']+/gi, '$1…')
  .replace(/\bya29\.[\w.-]+/g, '…').replace(/\b1\/\/[\w.-]+/g, '…')
  .slice(0, 300);

// ── The server-wide pause ──
const CLIENT_PAUSE_MS = 60_000;
const DOWN_PAUSE_MS = 30_000;
let pause = null; // { code, until, plain, at }
let lastRefusal = null; // for Services: { at, code, plain }
export const tokenPaused = () => (pause && Date.now() < pause.until ? { ...pause } : null);
export const lastTokenRefusal = () => (lastRefusal ? { ...lastRefusal } : null);
export const _resetPausesForTest = () => { pause = null; lastRefusal = null; };

const PLAIN = {
  client: 'Google doesn’t recognise this server’s client ID and secret',
  unavailable: 'Google isn’t answering right now',
};
const pauseFor = (code) => {
  const at = Date.now();
  const ms = code === 'client' ? CLIENT_PAUSE_MS : DOWN_PAUSE_MS;
  const already = Boolean(tokenPaused());
  pause = { code, until: at + ms, plain: PLAIN[code], at };
  lastRefusal = { at, code, plain: code === 'client' ? 'wrong client ID or secret' : 'no answer' };
  if (!already) {
    console.warn(code === 'client'
      ? `google: client refused (invalid_client) — no calls to Google for ${ms / 1000} s`
      : `google: token endpoint not answering — no calls to Google for ${ms / 1000} s`);
  }
  return { code, plain: PLAIN[code], until: pause.until };
};

// One POST to Google's token endpoint (or /revoke), within 8 s. →
// { ok, status, body, error, trouble }: trouble is set (and the pause
// begun) for a wrong client, a timeout, a network error or a 5xx; error is
// Google's OAuth error code otherwise (invalid_grant, …).
export const tokenCall = async (form, { path = TOKEN_PATH, withClient = true } = {}) => {
  const paused = tokenPaused();
  if (paused) return { ok: false, status: 0, body: null, error: null, trouble: { code: paused.code, plain: paused.plain, until: paused.until } };
  const params = new URLSearchParams(withClient ? { ...form, client_id: clientId(), client_secret: clientSecret() } : form);
  let res;
  try {
    res = await fetch(`${oauthBase()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, status: 0, body: null, error: null, trouble: pauseFor('unavailable') };
  }
  const text = await res.text().catch(() => '');
  let body = null;
  try { body = JSON.parse(text); } catch { body = { text }; }
  if (res.status >= 500) return { ok: false, status: res.status, body, error: null, trouble: pauseFor('unavailable') };
  const error = res.ok ? null : String(body?.error || `http_${res.status}`);
  if (error === 'invalid_client' || error === 'unauthorized_client') {
    return { ok: false, status: res.status, body, error, trouble: pauseFor('client') };
  }
  return { ok: res.ok, status: res.status, body, error, trouble: null };
};

export const revokeCall = (token) => tokenCall({ token }, { path: REVOKE_PATH, withClient: false });

// The ID token from Google's token endpoint, straight from Google over TLS,
// so its claims are read without checking a signature (OpenID Connect Core
// §3.1.3.7). → the claims, or { refused: which check }.
const SLACK_S = 300;
export const readIdToken = (idToken, { nonce, nowMs = Date.now() } = {}) => {
  let claims;
  try {
    const part = String(idToken || '').split('.')[1];
    claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return { refused: 'unreadable' };
  }
  const now = Math.floor(nowMs / 1000);
  if (!['https://accounts.google.com', 'accounts.google.com'].includes(claims?.iss)) return { refused: 'iss' };
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!clientId() || !aud.includes(clientId())) return { refused: 'aud' };
  if (!(Number(claims.exp) > now - SLACK_S)) return { refused: 'exp' };
  if (!(Number(claims.iat) <= now + 600 + SLACK_S)) return { refused: 'iat' };
  if (!nonce || claims.nonce !== nonce) return { refused: 'nonce' };
  if (!claims.sub || typeof claims.sub !== 'string') return { refused: 'sub' };
  return {
    sub: claims.sub,
    email: String(claims.email || '').toLowerCase(),
    hd: claims.hd ? String(claims.hd).toLowerCase() : null,
    name: claims.name ? String(claims.name) : null,
  };
};

// The person's own Google sign-in link, as /api/auth/me tells it.
export const loginOf = async (q, userId) => (await q.query(
  'select email, hd from google_logins where user_id = $1', [userId],
)).rows[0] || null;
