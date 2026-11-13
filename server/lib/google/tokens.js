// Google connections: what the Gmail, Drive and Calendar features call.
// One grant per person (google_grants), server-wide, holding every purpose
// they connected; its refresh token sealed (seal.js); access tokens only in
// this process's memory, never in a table, a log, an event or an answer
// (narrowToken's, for the browser, is the one sanctioned exception).
//
//   grantFor(db, { userId, workspaceId }, purpose)
//       → { id, userId, workspaceId, purpose, email, state, said, pausedUntil } | null
//       Checks mayUse and the purpose's domain every time: state
//       'not-allowed' or 'domain' (never written: another campaign may
//       still allow it).
//   googleFetch(db, grant, url, init = {}, opts = {})
//       → { ok, status, body, trouble, reached }
//       opts: timeoutMs (10 000), stream (body unparsed), retry 'auth' |
//       'auth-only', quotaPauseMs (60 000). Never inside a write: called
//       with the plain db, outside any runAction.
//   narrowToken(db, grant, scopes) → { token, expiresAt } | { trouble }
//   markReconnect(db, grant, said)
//   dropPurpose(db, { workspaceId, actorId }, grant, purpose)
//   revokeIfUnshared(q, { workspaceId, sub, sealed })   the only way
//       anything revokes: a google.revoke job, unless another row holds
//       the same Google account (revoking ends every scope at once)
//
// trouble: { code, plain, said?, until? } — code one of client,
// unavailable, reconnect, paused, denied, not-allowed, domain.
import { runAction } from '../events.js';
import { enqueueJob } from '../jobs.js';
import { openToken, sealToken } from './seal.js';
import { tokenCall, revokeCall, scrubbed, tokenTimeoutMs } from './flow.js';
import { domainFor, mayUse, purposeOf } from './purposes.js';

export const SAID_STOPPED = 'Google stopped letting base.win use this account';
export const SAID_KEY_CHANGED = 'Connect again — this server’s Google key changed';
export const PLAIN = {
  client: 'Google sign-in isn’t working on this server — tell your campaign manager.',
  unavailable: 'Google isn’t answering right now. Try again in a minute.',
  reconnect: 'Connect Google again to keep using this.',
  paused: 'Google asked base.win to wait. Try again later.',
  denied: 'Google refused this.',
  'not-allowed': 'You can’t use this in this campaign any more.',
  domain: 'This Google account isn’t at the campaign’s domain.',
};
const trouble = (code, extra = {}) => ({ code, plain: PLAIN[code], ...extra });
const keyOf = (purpose) => (typeof purpose === 'string' ? purpose : purpose?.key);
const list = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.replace(/^\{|\}$/g, '').split(',').filter(Boolean) : []);
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : (v || {}));

// The google_grant event's payload, pinned: no email, no sub, no scopes.
export const grantPayload = (userId, purposes, state) => ({ holder: 'user', user_id: userId, purposes: [...purposes], state });

// ── Reading a grant ──
export const grantRowOf = async (q, userId, { lock = false } = {}) => {
  const r = (await q.query(`select * from google_grants where user_id = $1${lock ? ' for update' : ''}`, [userId])).rows[0];
  return r ? { ...r, purposes: list(r.purposes), scopes: list(r.scopes) } : null;
};

export const grantFor = async (db, { userId, workspaceId }, purpose) => {
  const key = keyOf(purpose);
  if (!purposeOf(key) || !userId || !workspaceId) return null;
  const row = await grantRowOf(db, userId);
  if (!row || !row.purposes.includes(key)) return null;
  const out = {
    id: row.id, userId, workspaceId, purpose: key, email: row.email,
    state: row.state, said: row.said || null, pausedUntil: row.paused_until ? new Date(row.paused_until).toISOString() : null,
  };
  if (!(await mayUse(db, { userId, workspaceId }, key))) return { ...out, state: 'not-allowed', said: PLAIN['not-allowed'] };
  const settings = parse((await db.query('select settings from workspaces where id = $1', [workspaceId])).rows[0]?.settings);
  const domain = domainFor(key, settings);
  if (domain && row.hd !== domain) return { ...out, state: 'domain', said: `Your campaign only allows Google accounts at ${domain} for this` };
  return out;
};

// ── Access tokens, in memory only ──
const access = new Map(); // grant id → { token, expiresAt }
const refreshing = new Map(); // grant id → the refresh in flight
const narrowed = new Map(); // `${grant id} ${scopes}` → { token, expiresAt }
const hostPauses = new Map(); // API host → until (ms)
const HOST_PAUSE_MS = 30_000;
const MAX_QUOTA_PAUSE_MS = 3_600_000;
export const _resetTokensForTest = () => { access.clear(); refreshing.clear(); narrowed.clear(); hostPauses.clear(); };
export const forgetAccess = (grantId) => forget(grantId);
const forget = (grantId) => {
  access.delete(grantId);
  for (const k of narrowed.keys()) if (k.startsWith(`${grantId} `)) narrowed.delete(k);
};

// The grant's state as Google left it: reconnect, with plain words. Its own
// bookkeeping is the grant's row; the event goes on the chain of the
// campaign whose feature made the call, after Google has answered.
export const markReconnect = async (db, grant, said) => {
  forget(grant.id);
  const { result } = await runAction(db, { workspaceId: grant.workspaceId, actorId: grant.userId, action: 'google.grant.state' }, async (tx, emit) => {
    const r = (await tx.query(
      `update google_grants set state = 'reconnect', said = $2, updated_at = now()
       where id = $1 and (state <> 'reconnect' or said is distinct from $2) returning user_id, purposes, state`,
      [grant.id, String(said || SAID_STOPPED).slice(0, 300)],
    )).rows[0];
    if (r) emit('google_grant', grant.id, 'update', grantPayload(r.user_id, list(r.purposes), r.state));
    return Boolean(r);
  });
  grant.state = 'reconnect';
  grant.said = String(said || SAID_STOPPED);
  return result;
};

// A fresh access token from the sealed refresh token. scope: a narrower set
// (narrowToken). → { token, expiresAt } | { trouble }.
const refresh = async (db, grant, scope = null) => {
  const row = (await db.query('select refresh_sealed from google_grants where id = $1', [grant.id])).rows[0];
  if (!row) return { trouble: trouble('reconnect') };
  const open = openToken(row.refresh_sealed);
  if (!open) {
    await markReconnect(db, grant, SAID_KEY_CHANGED);
    return { trouble: trouble('reconnect', { said: SAID_KEY_CHANGED }) };
  }
  const r = await tokenCall({ grant_type: 'refresh_token', refresh_token: open.plain, ...(scope ? { scope } : {}) });
  if (r.trouble) return { trouble: r.trouble };
  if (r.error === 'invalid_grant') {
    await markReconnect(db, grant, SAID_STOPPED);
    return { trouble: trouble('reconnect', { said: SAID_STOPPED }) };
  }
  if (!r.ok || !r.body?.access_token) {
    return { trouble: trouble(r.error === 'invalid_scope' ? 'denied' : 'unavailable', { said: scrubbed(r.body?.error_description || r.error || '') }) };
  }
  // Sealed with an older key (or Google handed a new refresh token): kept
  // under the current one.
  const fresh = r.body.refresh_token || (open.current ? null : open.plain);
  if (fresh) await db.query('update google_grants set refresh_sealed = $2, updated_at = now() where id = $1', [grant.id, sealToken(fresh)]);
  return { token: String(r.body.access_token), expiresAt: Date.now() + Math.max(60, Number(r.body.expires_in) || 3600) * 1000 };
};

// Used until 60 s before it expires; one refresh in flight per grant.
const accessFor = async (db, grant, { renew = false } = {}) => {
  const have = access.get(grant.id);
  if (!renew && have && have.expiresAt - 60_000 > Date.now()) return have;
  if (!refreshing.has(grant.id)) {
    refreshing.set(grant.id, refresh(db, grant).finally(() => refreshing.delete(grant.id)));
  }
  const got = await refreshing.get(grant.id);
  if (got.token) access.set(grant.id, got);
  return got;
};

// The row's state now (another request may have marked it), and its pause.
const blocked = async (db, grant) => {
  if (!grant?.id) return trouble('reconnect');
  if (grant.state && grant.state !== 'ok') {
    return { ...trouble(PLAIN[grant.state] ? grant.state : 'reconnect'), ...(grant.said ? { said: grant.said } : {}) };
  }
  const row = (await db.query('select state, said, paused_until from google_grants where id = $1', [grant.id])).rows[0];
  if (!row) return trouble('reconnect');
  if (row.state !== 'ok') return trouble('reconnect', { said: row.said || SAID_STOPPED });
  const until = row.paused_until ? new Date(row.paused_until).getTime() : 0;
  if (until > Date.now()) return trouble('paused', { until: new Date(until).toISOString() });
  return null;
};

const QUOTA_REASONS = ['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded'];
const reasonOf = (body) => body?.error?.errors?.[0]?.reason || body?.error?.details?.find?.((d) => d?.reason)?.reason || null;
const saidOf = (body) => scrubbed(body?.error?.message || body?.error_description || (typeof body?.error === 'string' ? body.error : '') || body?.text || '');

export const googleFetch = async (db, grant, url, init = {}, opts = {}) => {
  const { timeoutMs = 10_000, stream = false, retry = 'auth', quotaPauseMs = 60_000 } = opts;
  const answer = (o) => ({ ok: false, status: 0, body: null, trouble: null, reached: false, ...o });
  const stop = await blocked(db, grant);
  if (stop) return answer({ trouble: stop });
  const host = new URL(url).host;
  const hostUntil = hostPauses.get(host) || 0;
  if (hostUntil > Date.now()) return answer({ trouble: trouble('unavailable', { until: new Date(hostUntil).toISOString() }) });

  let reached = false;
  const once = async (token) => {
    reached = true;
    try {
      return await fetch(url, {
        ...init,
        headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return null; // no answer in time, or the network
    }
  };
  let tok = await accessFor(db, grant);
  if (tok.trouble) return answer({ trouble: tok.trouble });
  let res = await once(tok.token);
  // A 401: the access token is stale — one refresh, one more try.
  if (res && res.status === 401) {
    tok = await accessFor(db, grant, { renew: true });
    if (tok.trouble) return answer({ trouble: tok.trouble, reached });
    res = await once(tok.token);
  } else if ((!res || res.status >= 500) && retry !== 'auth-only') {
    res = await once(tok.token);
  }
  if (!res || res.status >= 500) {
    const until = Date.now() + HOST_PAUSE_MS;
    hostPauses.set(host, until);
    return answer({ status: res?.status || 0, trouble: trouble('unavailable', { until: new Date(until).toISOString() }), reached });
  }
  if (stream && res.ok) {
    await db.query('update google_grants set last_ok_at = now() where id = $1', [grant.id]);
    return answer({ ok: true, status: res.status, body: res.body, reached });
  }
  const text = await res.text().catch(() => '');
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { text }; }
  if (res.ok) {
    await db.query('update google_grants set last_ok_at = now() where id = $1', [grant.id]);
    return answer({ ok: true, status: res.status, body, reached });
  }
  const reason = reasonOf(body);
  if (((res.status === 403 || res.status === 429) && QUOTA_REASONS.includes(reason)) || res.status === 429) {
    const after = Number(res.headers.get('retry-after'));
    const ms = Math.min(MAX_QUOTA_PAUSE_MS, Number.isFinite(after) && after > 0 ? after * 1000 : quotaPauseMs);
    const until = new Date(Date.now() + ms);
    await db.query('update google_grants set paused_until = $2, updated_at = now() where id = $1', [grant.id, until.toISOString()]);
    return answer({ status: res.status, body, trouble: trouble('paused', { until: until.toISOString(), said: saidOf(body) }), reached });
  }
  if (res.status === 401) {
    await markReconnect(db, grant, SAID_STOPPED);
    return answer({ status: res.status, body, trouble: trouble('reconnect', { said: SAID_STOPPED }), reached });
  }
  if (res.status === 403) return answer({ status: res.status, body, trouble: trouble('denied', { said: saidOf(body) }), reached });
  return answer({ status: res.status, body, reached });
};

// A token for the browser that can do only this purpose's work (Drive's
// Picker): refused unless the purpose says browserToken and the scopes are
// its own. Kept in memory only, until five minutes before it expires.
export const narrowToken = async (db, grant, scopes) => {
  const p = purposeOf(grant?.purpose);
  const want = [...new Set((Array.isArray(scopes) ? scopes : [scopes]).map(String))].sort();
  if (!p || !p.browserToken || !want.length || want.some((s) => !p.scopes.includes(s))) return { trouble: trouble('not-allowed') };
  const stop = await blocked(db, grant);
  if (stop) return { trouble: stop };
  const key = `${grant.id} ${want.join(' ')}`;
  const have = narrowed.get(key);
  if (have && have.expiresAt - 300_000 > Date.now()) return { token: have.token, expiresAt: new Date(have.expiresAt).toISOString() };
  const got = await refresh(db, grant, want.join(' '));
  if (got.trouble) return { trouble: got.trouble };
  narrowed.set(key, got);
  return { token: got.token, expiresAt: new Date(got.expiresAt).toISOString() };
};

// ── Disconnecting and revoking ──
const shared = async (q, sub) => Boolean((await q.query('select 1 from google_grants where sub = $1 limit 1', [sub])).rows[0]);

export const revokeIfUnshared = async (q, { workspaceId, sub, sealed }) => {
  if (sub && await shared(q, sub)) return { still_at_google: true };
  await enqueueJob(q, { workspaceId, kind: 'google.revoke', payload: { sealed, purposes: [], revoke: true } });
  return { still_at_google: false };
};

const jobsOff = () => process.env.STARBASE_JOBS === 'off';

// Take purposes off a grant (all of them: the row goes), inside the caller's
// write. A purpose with onRevoke gets its clean-up first, in the revoke job
// (or now, without a token, when this server runs no jobs). The token is
// revoked only when nothing is left and no other row holds the account.
// → { removed, deleted, still_at_google }.
export const removePurposes = async (tx, emit, row, purposes, { workspaceId }) => {
  const gone = row.purposes.filter((p) => purposes.includes(p));
  if (!gone.length) return { removed: [], deleted: false, still_at_google: true };
  const left = row.purposes.filter((p) => !gone.includes(p));
  if (left.length) await tx.query('update google_grants set purposes = $2, updated_at = now() where id = $1', [row.id, left]);
  else await tx.query('delete from google_grants where id = $1', [row.id]);
  forget(row.id);
  emit('google_grant', row.id, left.length ? 'update' : 'void', grantPayload(row.user_id, left, row.state));
  const revoke = !left.length && !(await shared(tx, row.sub));
  const cleanups = gone.filter((k) => purposeOf(k)?.onRevoke);
  if (cleanups.length && jobsOff()) {
    for (const k of cleanups) await purposeOf(k).onRevoke(tx, { userId: row.user_id, workspaceId, fetch: null });
    if (revoke) await enqueueJob(tx, { workspaceId, kind: 'google.revoke', payload: { sealed: row.refresh_sealed, purposes: [], revoke: true } });
  } else if (revoke || cleanups.length) {
    await enqueueJob(tx, {
      workspaceId, kind: 'google.revoke',
      payload: { sealed: row.refresh_sealed, userId: row.user_id, workspaceId, purposes: cleanups, revoke },
    });
  }
  return { removed: gone, deleted: !left.length, still_at_google: !revoke };
};

export const dropPurpose = async (db, { workspaceId, actorId }, grant, purpose) => {
  const key = keyOf(purpose);
  const { result } = await runAction(db, { workspaceId, actorId: actorId || null, action: 'google.disconnect' }, async (tx, emit) => {
    const row = grant?.id ? await grantRowOf(tx, grant.userId, { lock: true }) : null;
    if (!row || row.id !== grant.id) return { removed: [], deleted: false, still_at_google: false };
    return removePurposes(tx, emit, row, [key], { workspaceId });
  });
  return result;
};

// ── The google.revoke job ──
// payload { sealed, userId?, workspaceId?, purposes: [with onRevoke], revoke }.
// Clean-up first (each purpose's onRevoke, with a bounded fetch carrying an
// access token from the sealed refresh token), then /revoke when asked. A
// throw is retried by the runner (5 tries); on the last, it revokes anyway
// and calls onRevoke once more with fetch: null.
const JOB_MAX_ATTEMPTS = 5; // lib/jobs.js MAX_ATTEMPTS
const boundedFetch = (refreshToken) => {
  let token = null;
  return async (url, init = {}) => {
    if (!token) {
      const r = await tokenCall({ grant_type: 'refresh_token', refresh_token: refreshToken });
      if (!r.ok || !r.body?.access_token) throw new Error(`google: no access token for clean-up (${r.trouble?.code || r.error || r.status})`);
      token = r.body.access_token;
    }
    return fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(tokenTimeoutMs()) });
  };
};

export const revokeJob = async (db, job) => {
  const { sealed, userId = null, workspaceId = null, purposes = [], revoke = true } = job.payload || {};
  const last = Number(job.attempts) >= JOB_MAX_ATTEMPTS;
  const cleanups = purposes.map(purposeOf).filter((p) => p?.onRevoke);
  const open = openToken(sealed);
  if (!open) {
    // Nothing can be revoked: the features still mark their own rows.
    for (const p of cleanups) await p.onRevoke(db, { userId, workspaceId, fetch: null }).catch(() => {});
    return;
  }
  try {
    const f = boundedFetch(open.plain);
    for (const p of cleanups) await p.onRevoke(db, { userId, workspaceId, fetch: f });
  } catch (e) {
    if (!last) throw e;
    if (revoke) await revokeCall(open.plain).catch(() => {});
    for (const p of cleanups) await p.onRevoke(db, { userId, workspaceId, fetch: null }).catch(() => {});
    console.warn('google: clean-up gave up; revoked anyway');
    return;
  }
  if (!revoke) return;
  const r = await revokeCall(open.plain);
  // 400: invalid_token — already gone at Google.
  if (r.ok || r.status === 400) return;
  if (last) console.warn('google: revoke gave up');
  throw new Error(`google revoke: ${r.trouble?.code || `answered ${r.status}`}`);
};
