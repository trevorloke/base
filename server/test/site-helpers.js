// Helpers for the website's tests (site-*.test.js): requests to the public
// site on any host, form posts from a fresh address each time (the per-IP
// limit is tested on its own), and a campaign with its manager.
import { app } from '../index.js';
import { freshDb, Client } from './helpers.js';

let ipN = 0;
export const nextIp = () => { ipN += 1; return `198.51.${Math.floor(ipN / 250) % 250}.${(ipN % 250) + 1}`; };

// → { status, text, json, headers, location }
export const hit = async (path, { method = 'GET', host = 'localhost', body, form, headers = {}, ip } = {}) => {
  const h = { 'x-forwarded-for': ip || nextIp(), ...headers };
  let payload;
  if (form) {
    h['content-type'] = 'application/x-www-form-urlencoded';
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) for (const x of (Array.isArray(v) ? v : [v])) p.append(k, String(x));
    payload = p.toString();
  } else if (body !== undefined) {
    h['content-type'] = h['content-type'] || 'application/json';
    payload = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await app.request(`http://${host}${path}`, { method: payload !== undefined && method === 'GET' ? 'POST' : method, headers: h, body: payload });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* HTML */ }
  return { status: res.status, text, json, headers: res.headers, location: res.headers.get('location') };
};

// A form on the app's own address (/site/…), as an island sends it.
export const send = (kind, body, opts = {}) => hit(`${opts.root ?? '/site'}/api/forms/${kind}`, { method: 'POST', body, ...opts });

export const ok = (r, msg = '') => {
  if (r.status !== 200) throw new Error(`${msg} ${r.status} ${r.text.slice(0, 300)}`);
  return r.json;
};

// A campaign with its manager (the first one set up on this database: the
// one the site at /site/ belongs to).
export const campaign = async (name = 'Imagine Surrey') => {
  const db = await freshDb();
  const mgr = new Client();
  const r = await mgr.signup({ workspaceName: name, email: `mgr+${Math.random().toString(36).slice(2, 8)}@example.org`, jurisdiction: 'bc-municipal' });
  return { db, mgr, ws: r.json.workspace.id, user: r.json.user };
};

// Someone else on the team, by invite.
export const member = async (mgr, role, name = 'Sam Example') => {
  const email = `${role}+${Math.random().toString(36).slice(2, 8)}@example.org`;
  const inv = await mgr.action('member.invite', { email, role });
  const c = new Client();
  const r = await c.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name, password: 'site-tests-2026' });
  return { client: c, id: r.json.user.id, email };
};

export const personBy = async (db, ws, where, params = []) => (await db.query(
  `select * from persons where workspace_id = $1 and deleted_at is null and ${where}`, [ws, ...params],
)).rows;
