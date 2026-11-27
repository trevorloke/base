// Test helpers: the settings a console under test runs with, a fresh
// database per app, form posts with the console's Origin, and a cookie jar.
import { openDb } from '../db.mjs';
import { makeApp } from '../server.mjs';

export const HOST = 'ops.example.org';
export const SETUP_CODE = 'test-setup-code-0123456789abcdef';
export const SECRET = 'test-ops-secret-0123456789abcdefghij';
export const SIGNING = 'test-only-platform-signing-key-0123456789abcdef';

export const baseEnv = () => {
  Object.assign(process.env, {
    OPS_HOST: HOST, OPS_SETUP_CODE: SETUP_CODE, OPS_SECRET: SECRET, PLATFORM_SIGNING_KEY: SIGNING, OPS_INSECURE_COOKIES: '1',
  });
  delete process.env.OPS_ALLOW_LOCAL;
  // A client's public address is https://<name>.base.win unless a test
  // names a stand-in (OPS_PUBLIC_TEMPLATE, with {name} in it).
  delete process.env.OPS_PUBLIC_TEMPLATE;
};
baseEnv();

// The database under test: DATABASE_URL (npm run test:platform:pg) or PGlite.
export const freshApp = async () => {
  const db = await openDb(process.env.DATABASE_URL || '', { max: Number(process.env.PG_POOL_MAX) || 5 });
  if (process.env.DATABASE_URL) await wipe(db);
  return { db, app: makeApp({ db }) };
};
// Over the wire each file shares one database: start from nothing.
const wipe = async (db) => {
  await db.query('delete from ops_sessions; delete from operator_setup; delete from setup_tries; delete from operators');
  await db.query('delete from render_jobs');
  await db.query('delete from checklist; delete from checks; delete from environments; delete from campaigns');
  await db.query('delete from ops_log; update ops_chain set seq = 0, last_hash = \'\'');
  await db.exec((await import('node:fs')).readFileSync(new URL('../db.sql', import.meta.url), 'utf8'));
};

// A browser of one: keeps cookies, posts forms from the console's origin.
export const browser = (app, { ip = '203.0.113.9' } = {}) => {
  const jar = new Map();
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const keep = (res) => {
    for (const line of res.headers.getSetCookie?.() || []) {
      const [pair, ...attrs] = line.split(';');
      const at = pair.indexOf('=');
      const k = pair.slice(0, at).trim();
      const v = pair.slice(at + 1).trim();
      const gone = attrs.some((a) => /max-age=0\b/i.test(a.trim())) || v === '';
      if (gone) jar.delete(k); else jar.set(k, v);
    }
    return res;
  };
  const send = async (method, path, { form, headers = {}, host = process.env.OPS_HOST } = {}) => {
    const h = { 'x-forwarded-for': ip, ...headers };
    if (jar.size) h.cookie = cookieHeader();
    let body;
    if (form) {
      body = new URLSearchParams(form).toString();
      if (!('content-type' in h)) h['content-type'] = 'application/x-www-form-urlencoded';
      if (!('origin' in h)) h.origin = `${process.env.OPS_INSECURE_COOKIES === '1' ? 'http' : 'https'}://${process.env.OPS_HOST}`;
    }
    for (const k of Object.keys(h)) if (h[k] === null) delete h[k];
    return keep(await app.request(`http://${host}${path}`, { method, headers: h, body }));
  };
  return {
    jar,
    get: (path, opts) => send('GET', path, opts),
    post: (path, form, opts = {}) => send('POST', path, { ...opts, form }),
  };
};

export const text = async (res) => res.text();

// ── The operator, set up through the real screens ──
import { totp, base32Decode } from '../../../server/lib/twostep.js';
export const EMAIL = 'owner@example.org';
export const PASSWORD = 'a long test password 1';

export const keyFromPage = (body) => /class="oc-key"[^>]*>([A-Z2-7 ]+)</.exec(body)[1].replace(/ /g, '');
// A code the app would show now. The step a code used can't be used again,
// so tests that need another forget the last one first.
export const codeNow = async (db, secret) => {
  await db.query('update operators set totp_last_step = null');
  return totp(base32Decode(secret), Date.now());
};

export const setUp = async (app, db, { email = EMAIL, password = PASSWORD, name = 'Olive Example', ip } = {}) => {
  const b = browser(app, { ip });
  let res = await b.post('/setup', { code: process.env.OPS_SETUP_CODE });
  if (res.status !== 303) throw new Error(`setup code: ${res.status}`);
  res = await b.post('/setup/you', { name, email, password });
  if (res.status !== 303) throw new Error(`setup you: ${res.status} ${await res.text()}`);
  const secret = keyFromPage(await (await b.get('/setup/app')).text());
  res = await b.post('/setup/app', { code: totp(base32Decode(secret), Date.now()) });
  if (res.status !== 303) throw new Error(`setup app: ${res.status} ${await res.text()}`);
  const codesPage = await (await b.get('/setup/codes')).text();
  const codes = [...codesPage.matchAll(/<li>([a-z0-9-]+)<\/li>/g)].map((m) => m[1]);
  return { b, secret, codes, email, password };
};

export const signInAs = async (app, db, { email = EMAIL, password = PASSWORD, secret, ip } = {}) => {
  const b = browser(app, { ip });
  const res = await b.post('/signin', { email, password, code: await codeNow(db, secret) });
  if (res.status !== 303) throw new Error(`signin: ${res.status}`);
  return b;
};
