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
  delete process.env.OPS_DOOR_ORIGIN;
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
