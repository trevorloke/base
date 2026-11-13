// Settings → Services: "Google (sign-in and connections)". Which settings
// are present (never their values), the redirect address to paste into
// Google Cloud, and a Check of three calls to Google that writes nothing.
import { basePath } from '../../lib/mount.js';
import { doorKeySet } from '../../lib/guard.js';
import { jobRunnerOn } from '../../lib/jobs.js';
import { timeZone } from '../../lib/org.js';
import {
  accountsBase, oauthBase, AUTH_PATH, TOKEN_PATH, REVOKE_PATH, DISCOVERY_PATH, GOOGLE_ACCOUNTS, GOOGLE_OAUTH,
  clientId, clientSecret, googleSetup, redirectUri, testBaseInUse,
} from '../../lib/google/config.js';
import { lastTokenRefusal, scrubbed } from '../../lib/google/flow.js';

const NEEDS = ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'];
const has = (k) => Boolean(String(process.env[k] || '').trim());
const TIMEOUT_MS = 8000;

const clock = (ms) => new Date(ms).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit', timeZone: timeZone() })
  .replace(/\./g, '').replace(/\s+/g, ' ');

// The row, without the counts (googleCounts adds them: they need the database).
export const googleService = () => {
  const s = googleSetup();
  const client = NEEDS.every(has);
  const refusal = lastTokenRefusal();
  const detail = [
    s.signin ? `Redirect address for Google Cloud: ${s.redirectUri}` : client ? 'Set STARBASE_PUBLIC_URL (https://…) first' : 'Lets the team sign in with Google, and Gmail, Drive and Calendar connect',
    client && (s.connect ? 'Connections: ready' : 'Connections need GOOGLE_TOKEN_KEY (32+ random characters)'),
    refusal && `Google refused at ${clock(refusal.at)}: ${refusal.code === 'client' ? 'wrong client ID or secret' : 'no answer'}`,
    client && basePath() && !doorKeySet() && 'Google sign-in limits count everyone through base.win as one address — set BASE_DOOR_KEY',
    client && !jobRunnerOn() && 'Background work is off — disconnecting can’t tell Google',
    testBaseInUse() && 'Test address in use (GOOGLE_ACCOUNTS_BASE / GOOGLE_OAUTH_BASE)',
  ].filter(Boolean);
  return {
    key: 'google', name: 'Google (sign-in and connections)',
    for: 'Sign in with Google; the Google account Gmail, Drive and Calendar use',
    launch: false,
    missing: NEEDS.filter((k) => !has(k)),
    set: [...NEEDS, 'GOOGLE_TOKEN_KEY'].filter(has),
    state: !s.signin ? 'missing' : s.connect ? 'ready' : 'default',
    detail: detail.join(' · '),
    // The same, one item a line (the panel draws these; detail stays for
    // pages cached from before), and the redirect address for its Copy.
    lines: detail,
    redirect: s.redirectUri,
    checkable: client,
    panel: 'google',
  };
};

// "12 people sign in with Google · 3 connected accounts" — this campaign's.
export const googleCounts = async (db, workspaceId, row) => {
  if (!row || row.state === 'missing') return row;
  const n = (await db.query(
    `select (select count(*)::int from google_logins g join memberships m on m.user_id = g.user_id and m.workspace_id = $1) as logins,
            (select count(*)::int from google_grants g join memberships m on m.user_id = g.user_id and m.workspace_id = $1) as grants`,
    [workspaceId],
  )).rows[0];
  const people = `${n.logins.toLocaleString('en-CA')} ${n.logins === 1 ? 'person signs' : 'people sign'} in with Google · ${n.grants.toLocaleString('en-CA')} connected ${n.grants === 1 ? 'account' : 'accounts'}`;
  const parts = [...row.lines];
  parts.splice(2, 0, people); // after the redirect address and the connections line
  // GCA's "Shifts in Google Calendar", while it's on (ext/gcal).
  const cal = (await db.query(
    `select coalesce((settings->'gcal'->>'on')::boolean, false) as on,
            (select count(*)::int from gcal_links where workspace_id = $1 and state in ('ok', 'reconnect', 'gone')) as people
       from workspaces where id = $1`,
    [workspaceId],
  )).rows[0];
  if (cal?.on) {
    parts.splice(3, 0, `Shifts in Google Calendar: on · ${cal.people.toLocaleString('en-CA')} ${cal.people === 1 ? 'person' : 'people'}`);
    if (!jobRunnerOn()) parts.splice(4, 0, 'Background work is off on this server — Google Calendar won’t update.');
  }
  return { ...row, detail: parts.join(' · '), lines: parts };
};

const get = (url, init = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });

// 1. Google's discovery document still names the three addresses base.win uses.
const checkDiscovery = async () => {
  const res = await get(`${accountsBase()}${DISCOVERY_PATH}`);
  const doc = await res.json().catch(() => null);
  const real = accountsBase() === GOOGLE_ACCOUNTS;
  const want = {
    authorization_endpoint: `${real ? GOOGLE_ACCOUNTS : accountsBase()}${AUTH_PATH}`,
    token_endpoint: `${real ? GOOGLE_OAUTH : oauthBase()}${TOKEN_PATH}`,
    revocation_endpoint: `${real ? GOOGLE_OAUTH : oauthBase()}${REVOKE_PATH}`,
  };
  const same = res.ok && doc && Object.entries(want).every(([k, v]) => doc[k] === v);
  return same ? { ok: true } : { ok: false, said: 'Google has moved its sign-in addresses — base.win needs an update' };
};

// 2. The redirect address: Google's sign-in page, not followed.
const checkRedirect = async () => {
  const params = new URLSearchParams({ client_id: clientId(), redirect_uri: redirectUri(), response_type: 'code', scope: 'openid' });
  const res = await get(`${accountsBase()}${AUTH_PATH}?${params}`, { redirect: 'manual' });
  const body = res.status >= 300 && res.status < 400 ? '' : await res.text().catch(() => '');
  if (res.status >= 300 && res.status < 400) return { ok: true, said: 'Google knows this redirect address' };
  if (/redirect_uri_mismatch/.test(body)) return { ok: false, said: `Add ${redirectUri()} to the client’s Authorized redirect URIs` };
  if (res.status === 401 || /invalid_client/.test(body)) return { ok: false, said: 'Google doesn’t recognise this client ID' };
  return { ok: false, said: 'Couldn’t confirm the redirect address — sign in with Google once to test it' };
};

// 3. The client's id and secret: a code that can't be real.
const checkClient = async () => {
  const res = await get(`${oauthBase()}${TOKEN_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId(), client_secret: clientSecret(), grant_type: 'authorization_code',
      code: 'base-win-check', redirect_uri: redirectUri(),
    }).toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (body.error === 'invalid_grant') return { ok: true, said: 'Google accepts this client ID and secret' };
  if (body.error === 'invalid_client' || body.error === 'unauthorized_client') {
    return { ok: false, said: 'Google doesn’t recognise this client ID and secret. Copy them again (the secret is shown once — make a new one if it’s lost)' };
  }
  return { ok: false, said: `Google answered ${res.status}${body.error ? ` (${scrubbed(body.error)})` : ''}` };
};

export const checkGoogle = async () => {
  const s = googleSetup();
  if (!s.signin) return { ok: false, said: s.why };
  const settle = (p) => p.catch((e) => ({ ok: false, said: `No answer: ${scrubbed(e.message).slice(0, 120)}` }));
  const [discovery, redirect, client] = await Promise.all([checkDiscovery(), checkRedirect(), checkClient()].map(settle));
  const ok = discovery.ok && redirect.ok && client.ok;
  const said = [discovery.ok ? null : discovery.said, redirect.said, client.said].filter(Boolean).join(' · ');
  return { ok, said: ok ? `Working · ${said}` : said };
};
