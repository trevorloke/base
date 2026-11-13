// What the Google tests share: a browser with a cookie jar and an address of
// its own, the fake Google wired in through the test addresses, and one
// round trip to Google and back.
import assert from 'node:assert/strict';
import { app } from '../index.js';
import { startFakeGoogle } from './fake-google.js';
import { base32Decode, hotp, totpStep } from '../lib/twostep.js';
import { _resetPausesForTest } from '../lib/google/flow.js';
import { _resetTokensForTest } from '../lib/google/tokens.js';

export const CLIENT_ID = 'fake-client.apps.example';
export const SECRET = 'fake-client-secret';
export const TOKEN_KEY = 'google-token-key-for-tests-0123456789abcdef';
export const PUBLIC = 'http://localhost';
export const tag = Math.random().toString(36).slice(2, 8);
// Google accounts of this file's own (a shared database under test:pg).
export const acct = (n, extra = {}) => ({
  sub: `1${String(parseInt(tag, 36)).padStart(12, '0')}${String(n).padStart(4, '0')}`,
  email: `g${n}.${tag}@gmail.example`, hd: null, name: `G${n} Example`, ...extra,
});

const KEYS = ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_TOKEN_KEY', 'GOOGLE_ACCOUNTS_BASE', 'GOOGLE_OAUTH_BASE', 'STARBASE_PUBLIC_URL', 'NODE_ENV', 'BASE_PATH', 'STARBASE_JOBS'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
export const restoreEnv = () => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } };

export const startGoogle = async (accounts) => {
  const fake = await startFakeGoogle({
    port: 0, clientId: CLIENT_ID, secret: SECRET, accounts, slowMs: 1500,
    redirectUris: [`${PUBLIC}/api/auth/google/back`, `${PUBLIC}/imaginesurrey/api/auth/google/back`],
  });
  googleEnv(fake);
  return fake;
};
export const googleEnv = (fake) => {
  Object.assign(process.env, {
    GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET: SECRET, GOOGLE_TOKEN_KEY: TOKEN_KEY,
    GOOGLE_ACCOUNTS_BASE: fake.base, GOOGLE_OAUTH_BASE: fake.base, STARBASE_PUBLIC_URL: PUBLIC,
  });
  delete process.env.NODE_ENV;
  _resetPausesForTest();
  _resetTokensForTest();
};

let ipSeq = 0;
export class Browser {
  constructor({ fetch = (url, init) => app.request(url, init), origin = 'http://localhost' } = {}) {
    this.jar = new Map(); this.raw = []; this.fetchFn = fetch; this.origin = origin;
    ipSeq += 1;
    this.ip = `203.0.113.${ipSeq % 250}`;
  }
  get cookie() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '); }
  async send(method, path, body) {
    const url = /^https?:/.test(path) ? path : `${this.origin}${path}`;
    const res = await this.fetchFn(url, {
      method,
      redirect: 'manual',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': this.ip, ...(this.jar.size ? { cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.getSetCookie();
    this.raw.push(...set);
    for (const sc of set) {
      const [pair] = sc.split(';');
      const i = pair.indexOf('=');
      const [k, v] = [pair.slice(0, i), pair.slice(i + 1)];
      if (!v || /max-age=0/i.test(sc)) this.jar.delete(k); else this.jar.set(k, v);
    }
    return res;
  }
  async req(method, path, body) {
    const res = await this.send(method, path, body);
    let json = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, json };
  }
  get(p) { return this.req('GET', p); }
  post(p, b) { return this.req('POST', p, b); }
  action(name, input = {}) { return this.post(`/api/actions/${name}`, input); }
  signIn(email, password = 'google-2026-pass') { return this.post('/api/auth/login', { email, password }); }

  // GET start → (Google: pick an account) → GET back. → { start, location,
  // google (the code in ?google=), at (the start's Location), back (back's
  // Location), code, state }.
  async google(fake, query, pick, { mangle } = {}) {
    const start = await this.send('GET', `/api/auth/google/start?${new URLSearchParams(query)}`);
    const at = start.headers.get('location') || '';
    if (!at.startsWith(fake.base)) return { start, at, location: at, google: new URL(at, PUBLIC).searchParams.get('google') };
    let backUrl = fake.authorize(at, pick);
    if (mangle) backUrl = mangle(backUrl);
    const u = new URL(backUrl);
    const back = await this.send('GET', `${u.pathname}${u.search}`);
    const location = back.headers.get('location') || '';
    return {
      start, at, back, location, google: new URL(location, PUBLIC).searchParams.get('google'),
      code: u.searchParams.get('code'), state: u.searchParams.get('state'), nonce: new URL(at).searchParams.get('nonce'),
    };
  }
}

// An invite, joined with a new account (its own browser, signed in).
export const join = async (mgr, email, role, name = 'Example Person') => {
  const inv = await mgr.action('member.invite', { email, role });
  assert.equal(inv.status, 200, JSON.stringify(inv.json));
  const b = new Browser();
  const j = await b.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name, password: 'google-2026-pass' });
  assert.equal(j.status, 200, JSON.stringify(j.json));
  return { b, id: j.json.user.id, email };
};

export const signup = async (workspaceName, email) => {
  const b = new Browser();
  const r = await b.post('/api/auth/signup', { name: 'Mo Example', email, password: 'google-2026-pass', workspaceName, jurisdiction: 'bc-municipal' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return { b, id: r.json.user.id, ws: r.json.workspace.id, email };
};

// Two-step sign-in turned on for a signed-in browser's account → its key.
export const twoStepOn = async (b) => {
  const s = await b.action('twostep.start');
  assert.equal(s.status, 200, JSON.stringify(s.json));
  const key = s.json.setup.key;
  const c = await b.action('twostep.confirm', { code: hotp(base32Decode(key), totpStep(Date.now())) });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  return key;
};
