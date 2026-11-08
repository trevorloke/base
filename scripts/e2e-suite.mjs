// Base, end to end on one machine: the front door, Base Ground and Base Air,
// one sign-in carried from ground to air through the front door.
// Needs each app installed (npm install in apps/ground, pnpm install in apps/air).
//   node scripts/e2e-suite.mjs
import { spawn } from 'node:child_process';
import http from 'node:http';

const ROOT = new URL('../apps', import.meta.url).pathname;
const HOST = 'imaginesurrey.base.test:4300';
const SECRET = 'e2e-secret-' + 'x'.repeat(40);
const procs = [];
const start = (name, cwd, args, env, ready) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env } });
  procs.push(p);
  const t = setTimeout(() => reject(new Error(`${name} didn't start`)), 60000);
  const look = (b) => { if (ready.test(String(b))) { clearTimeout(t); resolve(); } };
  p.stdout.on('data', look); p.stderr.on('data', (b) => { look(b); if (/error/i.test(String(b))) process.stderr.write(`[${name}] ${b}`); });
});
const stop = () => procs.forEach((p) => p.kill());

const jar = {};
const keep = (setCookie) => { for (const c of [].concat(setCookie || [])) { const [kv] = c.split(';'); const [k, v] = kv.split('='); if (v === '' ) delete jar[k]; else jar[k] = v; } };
const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
const ask = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const u = new URL(path, `http://${HOST}`);
  const req = http.request({ host: '127.0.0.1', port: 4300, method, path: u.pathname + u.search, headers: { host: HOST, cookie: cookie(), ...headers } }, (res) => {
    let text = ''; res.on('data', (c) => { text += c; });
    res.on('end', () => { keep(res.headers['set-cookie']); resolve({ status: res.statusCode, location: res.headers.location, text }); });
  });
  req.on('error', reject); if (body) req.write(body); req.end();
});
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${extra}`}`); if (!ok) fails += 1; };

try {
  await start('ground', `${ROOT}/ground`, ['server/index.js'], {
    PORT: '4301', NODE_ENV: 'development', BASE_DATA: 'memory', BASE_ORG_NAME: 'Imagine Surrey', BASE_JURISDICTION: 'bc-municipal',
    BASE_PUBLIC_URL: `http://${HOST}`, BASE_CLIENT: 'imaginesurrey', BASE_TRUSTED_PROXIES: '1',
    BASE_AIR_URL: `http://${HOST}/air`, BASE_AIR_SSO_SECRET: SECRET, BASE_JOBS: 'off',
  }, /on :4301/);
  await start('air', `${ROOT}/air/apps/api`, ['--import', 'tsx', 'src/main.ts'], {
    PORT: '4302', NODE_ENV: 'development', PGLITE_PATH: `${process.env.TMPDIR || '/tmp'}/base-e2e-air-${process.pid}`, BASE_PATH: '/air',
    BASE_AIR_PUBLIC_URL: `http://${HOST}/air`, BASE_GROUND_URL: `http://${HOST}`, BASE_GROUND_INTERNAL_URL: '127.0.0.1:4301',
    BASE_SSO_SECRET: SECRET, BASE_AIR_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
  }, /Base Air .* on http/);
  await start('gateway', `${ROOT}/gateway`, ['server.js'], {
    PORT: '4300', BASE_HOST: 'base.test', BASE_CLIENT_IMAGINESURREY_GROUND: '127.0.0.1:4301', BASE_CLIENT_IMAGINESURREY_AIR: '127.0.0.1:4302',
  }, /front door on :4300/);

  const email = 'trevor@example.org';
  let r = await ask('/', {});
  check('the client root opens the field app', r.status === 302 && r.location === '/field/', `${r.status} ${r.location}`);
  r = await ask('/field/', {});
  check('the field app is served with its brand', r.status === 200 && /base-brand/.test(r.text), r.status);
  r = await ask('/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ email, password: 'ground-pass-123456', name: 'Trevor' }) });
  check('first sign-up on Base Ground', r.status === 200 || r.status === 201, `${r.status} ${r.text.slice(0, 200)}`);
  const groundCookie = { ...jar };

  // Base Air's own owner account, with the same email and its own password.
  for (const k of Object.keys(jar)) delete jar[k];
  r = await ask('/air/v1/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json', 'x-base-air-csrf': '1' }, body: JSON.stringify({ email, password: 'air-pass-123456', name: 'Trevor', workspaceName: 'Imagine Surrey' }) });
  check('first sign-up on Base Air', r.status === 201, `${r.status} ${r.text.slice(0, 200)}`);
  for (const k of Object.keys(jar)) delete jar[k];
  Object.assign(jar, groundCookie); // signed in to ground only

  const hop = async () => {
    let a = await ask('/air/auth/base?next=/');
    const toGround = a.location && new URL(a.location, `http://${HOST}`);
    check('Base Air sends the browser to Base Ground', a.status === 302 && toGround?.pathname === '/api/sso/authorize', `${a.status} ${a.location}`);
    a = await ask(toGround.pathname + toGround.search);
    const back = a.location && new URL(a.location, `http://${HOST}`);
    check('Base Ground answers with a one-time code', a.status === 302 && back?.pathname === '/air/auth/base/callback' && back.searchParams.get('code'), `${a.status} ${a.location} ${a.text.slice(0, 200)}`);
    return ask(back.pathname + back.search);
  };

  r = await hop();
  check('first time: Base Air asks for its own password to link the account', r.status === 200 && /Link your Base Air account/i.test(r.text) && /type="password"/.test(r.text), `${r.status} ${r.location} ${r.text.slice(0, 300)}`);
  check('the page names no Base Ground identity in a URL', !/sub=|code=/.test(r.text), '');
  check('no email or identity in that address', !/@|example\.org|sub=/.test(r.location || ''), r.location);
  r = await ask('/air/auth/base/link', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: `http://${HOST}` }, body: 'password=wrong-password-1' });
  check('a wrong Base Air password links nothing', !jar.base_air_session, `${r.status}`);
  r = await ask('/air/auth/base/link', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: `http://${HOST}` }, body: 'password=air-pass-123456' });
  check('the right password links and signs in to Base Air', Boolean(jar.base_air_session) && r.status === 303, `${r.status} ${r.location} ${r.text.slice(0, 200)}`);
  r = await ask('/air/v1/auth/session', { headers: { 'x-base-air-csrf': '1' } });
  check('Base Air knows who it is', r.status === 200 && r.text.includes(email), `${r.status} ${r.text.slice(0, 200)}`);

  delete jar.base_air_session;
  r = await hop();
  check('next time: linked, signed straight in', r.status === 302 && Boolean(jar.base_air_session) && !/link/.test(r.location || ''), `${r.status} ${r.location}`);

  r = await ask('/api/suite');
  check('Base Ground\'s switcher lists Base Air', r.status === 200 && /"air"/.test(r.text), `${r.status} ${r.text.slice(0, 200)}`);
  r = await ask('/api/health');
  check('health names no organization', r.status === 200 && !/Imagine Surrey/.test(r.text), r.text);
} catch (e) {
  console.error(e); fails += 1;
} finally {
  stop();
  console.log(fails ? `${fails} failed` : 'all passed');
  process.exit(fails ? 1 : 0);
}
