// Tests only: Render's API as render-api.mjs believes it to be, in memory.
// It speaks at the transport level (send(method, path, body) → { status,
// json }), so every suite runs the real client, its table of calls and its
// shapes. The same world can sit behind a real listener (startFakeRender)
// for the transport test, the leak test and e2e-ops.mjs.
//
// Its world: the control centre's own service, staging, a hand-made
// production service (base-win) with a client's settings, two more
// clients, and a service in somebody else's workspace; each with its
// database. Every name and value is made up. Every service holds settings
// that must never be read: an email key and a database address, as
// sentinels a test can look for.
//
// It keeps two lists a suite checks at its end:
//   world.calls      every request, in order
//   world.forbidden  every request the control centre must never make (any
//                    delete, a whole-settings write or read, a suspend, a
//                    change to a service, a setting off the readable list,
//                    a database change that isn't a shorter allow-list, or
//                    a path it doesn't know). Always [].
import { createServer } from 'node:http';

export const KEY = 'rnd_SENTINELRENDERKEY0123456789abcdef';
export const OWNER = 'tea-basewin000000000001';
export const OTHER_OWNER = 'tea-someoneelse00000001';
export const REPO = 'https://github.com/example-org/base';
export const IDS = {
  platform: 'srv-platform00000000001', platformDb: 'dpg-platform00000000001',
  staging: 'srv-staging000000000001', stagingDb: 'dpg-staging000000000001',
  first: 'srv-first00000000000001', firstDb: 'dpg-first00000000000001',
  a: 'srv-clienta000000000001', aDb: 'dpg-clienta000000000001',
  b: 'srv-clientb000000000001', bDb: 'dpg-clientb000000000001',
  other: 'srv-stranger00000000001', otherDb: 'dpg-stranger00000000001',
};
export const SENTINELS = {
  client: 'SENTINEL-CLIENT-SECRET-3b7e9a1c5d2f4e60',
  db: 'SENTINEL-DB-PASS-8c1d4f7a2e5b9c30',
  newDb: 'SENTINEL-NEW-DB-PASS-6a2c9e4b1f7d3a50',
};
// The names the control centre may ask about one at a time (its own copy:
// if render-guard.mjs grows a name, this fake calls it forbidden).
const READABLE = ['NODE_ENV', 'STARBASE_ENV', 'STARBASE_PUBLIC_URL', 'STARBASE_BRAND', 'STARBASE_ORG_NAME', 'STARBASE_JURISDICTION', 'STARBASE_TZ',
  'STARBASE_CITY', 'STARBASE_SLATES', 'STARBASE_PROVINCE', 'STARBASE_GEO_BOUNDS', 'STARBASE_CANDIDATES', 'BASE_PLATFORM_PUBKEY'];

const secrets = (id) => ({
  RESEND_API_KEY: `${SENTINELS.client}-${id}`,
  DATABASE_URL: `postgres://u:${SENTINELS.db}-${id}@dpg-x/db`,
  STARBASE_TWO_STEP_KEY: `${SENTINELS.client}-two-step-${id}`,
});
const clientSettings = (name, display) => ({
  NODE_ENV: 'production', STARBASE_ENV: 'production', STARBASE_PUBLIC_URL: `https://${name}.base.win`, STARBASE_BRAND: 'base',
  STARBASE_ORG_NAME: display, STARBASE_JURISDICTION: 'bc-municipal', STARBASE_TZ: 'America/Vancouver', STARBASE_CITY: 'Exampleton',
  STARBASE_SLATES: 'council:City council', STARBASE_PROVINCE: 'BC', STARBASE_GEO_BOUNDS: '50.6,-120.5|50.8,-120.2', STARBASE_CANDIDATES: 'none',
});

const service = ({ id, name, ownerId = OWNER, repo = REPO, branch = 'production', url = `https://${name}.onrender.com`, plan = 'starter', docker = true, build = null, createdAt = '2026-10-01T18:00:00Z' }) => ({
  id, name, type: 'web_service', ownerId, repo, branch, autoDeploy: 'yes', suspended: 'not_suspended', createdAt,
  serviceDetails: {
    url, plan, region: 'oregon', env: docker ? 'docker' : 'node',
    envSpecificDetails: docker ? { dockerfilePath: './Dockerfile', dockerContext: '.' } : { buildCommand: build, startCommand: 'node apps/platform/server.mjs' },
  },
});
const database = ({ id, name, ownerId = OWNER, plan = 'basic_1gb', open = false, extra = [] }) => ({
  id, name, owner: { id: ownerId }, plan, version: '16', region: 'oregon', status: 'available', createdAt: '2026-10-01T17:50:00Z',
  ipAllowList: [...(open ? [{ cidrBlock: '0.0.0.0/0', description: 'everywhere' }] : []), ...extra],
});
const deployOf = (n, status = 'live', commit = 'd9130ae4c2b7f1e8a6d5c4b3a2918f7e6d5c4b3a') => ({
  id: `dep-fake${String(n).padStart(12, '0')}`, status, commit: { id: commit, message: `SENTINEL-COMMIT-MESSAGE ${n}` },
  createdAt: '2026-11-20T22:00:00Z', finishedAt: status === 'live' ? '2026-11-20T22:10:00Z' : null,
});

export const fakeWorld = (over = {}) => {
  const world = {
    key: KEY,
    services: [
      service({ id: IDS.platform, name: 'base-platform', branch: over.platformBranch || 'production', docker: false, build: over.platformBuild || 'npm ci --omit=dev --ignore-scripts' }),
      service({ id: IDS.staging, name: 'base-win-staging', branch: 'main', url: 'https://starbase-staging.onrender.com' }),
      service({ id: IDS.first, name: 'base-win' }),
      service({ id: IDS.a, name: 'base-win-a' }),
      service({ id: IDS.b, name: 'base-win-b' }),
      service({ id: IDS.other, name: 'base-win-stranger', ownerId: OTHER_OWNER, repo: 'https://github.com/someone-else/fork' }),
    ],
    databases: [
      database({ id: IDS.platformDb, name: 'base-platform-db', plan: 'basic_256mb' }),
      database({ id: IDS.stagingDb, name: 'base-win-staging-db', open: true }),
      database({ id: IDS.firstDb, name: 'base-win-db' }),
      database({ id: IDS.aDb, name: 'base-win-a-db', open: true, extra: [{ cidrBlock: '203.0.113.7/32', description: 'the office' }] }),
      database({ id: IDS.bDb, name: 'base-win-b-db' }),
      database({ id: IDS.otherDb, name: 'base-win-stranger-db', ownerId: OTHER_OWNER }),
    ],
    settings: {
      [IDS.platform]: { NODE_ENV: 'production', OPS_HOST: 'ops.example.org', RENDER_API_KEY: KEY, ...secrets('platform') },
      [IDS.staging]: {
        NODE_ENV: 'production', STARBASE_ENV: 'staging', STARBASE_SAMPLE: '1', STARBASE_SAMPLE_RESET: 'nightly', STARBASE_DEMO_EMAIL: 'demo@example.org',
        STARBASE_FRAME_HOSTS: 'example.org', STARBASE_ORG_NAME: 'Hartwell Sample Campaign', STARBASE_CITY: 'Vancouver', BASE_PLATFORM_PUBKEY: 'x'.repeat(43), ...secrets('staging'),
      },
      // A hand-made client: its own brand and names, and three settings it never had.
      [IDS.first]: {
        NODE_ENV: 'production', STARBASE_ENV: 'production', STARBASE_PUBLIC_URL: 'https://imaginesurrey.base.win/site', STARBASE_BRAND: 'imagine-surrey',
        STARBASE_ORG_NAME: 'Imagine Surrey', STARBASE_JURISDICTION: 'bc-municipal', STARBASE_TZ: 'America/Vancouver', STARBASE_CITY: 'Surrey',
        STARBASE_SLATES: 'council:City council', BASE_PLATFORM_PUBKEY: 'y'.repeat(43), ...secrets('first'),
      },
      [IDS.a]: { ...clientSettings('a', 'Example A'), ...secrets('a') },
      [IDS.b]: { ...clientSettings('b', 'Example B'), BASE_PLATFORM_PUBKEY: 'z'.repeat(43), ...secrets('b') },
      [IDS.other]: { NODE_ENV: 'production', ...secrets('other') },
    },
    domains: {
      [IDS.platform]: [{ name: 'ops.example.org', verificationStatus: 'verified' }],
      [IDS.staging]: [{ name: 'staging.base.win', verificationStatus: 'verified' }],
      [IDS.first]: [{ name: 'imaginesurrey.base.win', verificationStatus: 'verified' }, { name: 'imaginesurrey.ca', verificationStatus: 'unverified' }],
      [IDS.a]: [], [IDS.b]: [{ name: 'b.base.win', verificationStatus: 'verified' }], [IDS.other]: [],
    },
    deploys: {
      [IDS.platform]: [deployOf(1)], [IDS.staging]: [deployOf(2, 'live', 'e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3')], [IDS.first]: [deployOf(3)],
      [IDS.a]: [deployOf(4)], [IDS.b]: [deployOf(5)], [IDS.other]: [deployOf(6)],
    },
    owners: [{ id: OWNER, name: 'base.win', email: 'SENTINEL-OWNER-EMAIL@example.org', type: 'team' }],
    blueprints: [{ id: 'exs-blueprint0000000001', name: 'base', branch: 'main', autoSync: true }],
    restarts: [],
    calls: [],
    forbidden: [],
    received: [],          // what the listener saw: { method, path, auth, body }
    ignoreOwnerFilter: false,
    pageSize: 100,
    faults: [],
  };
  let deployCount = 100;

  const byId = (id) => world.services.find((s) => s.id === id);
  const dbById = (id) => world.databases.find((d) => d.id === id);
  world.named = (name) => [...world.services, ...world.databases].filter((x) => x.name === name);
  world.settingsOf = (id) => world.settings[id];
  world.service = (name) => world.services.find((s) => s.name === name);
  world.database = (name) => world.databases.find((d) => d.name === name);
  // One more client's service and database, as if made by hand in Render
  // (a test's own campaign; nothing here is ever made through the API).
  let added = 0;
  world.addClient = (name, { url = `https://base-win-${name}.onrender.com`, display = `Example ${name.toUpperCase()}`, open = true, withKey = false } = {}) => {
    added += 1;
    const id = `srv-added${String(added).padStart(14, '0')}`;
    const dbId = `dpg-added${String(added).padStart(14, '0')}`;
    world.services.push(service({ id, name: `base-win-${name}`, url }));
    world.databases.push(database({ id: dbId, name: `base-win-${name}-db`, open }));
    world.settings[id] = { ...clientSettings(name, display), ...(withKey ? { BASE_PLATFORM_PUBKEY: 'k'.repeat(43) } : {}), ...secrets(name) };
    world.domains[id] = [];
    world.deploys[id] = [deployOf(50 + added)];
    return { id, dbId };
  };
  // A deploy that was started here goes live when a test says so.
  world.finishDeploys = (id, status = 'live') => { for (const d of world.deploys[id] || []) if (d.status === 'build_in_progress') { d.status = status; d.finishedAt = '2026-11-25T23:00:00Z'; } };

  // ── Told to fail ── each applies to the next request that matches `on`
  // (a RegExp over "METHOD /path"), `times` times.
  const fault = (kind, opts = {}) => { world.faults.push({ kind, on: opts.on || /./, times: opts.times ?? 1, ...opts }); return world; };
  world.refuse = (status, opts) => fault('refuse', { status, ...opts });          // Render says no; nothing changes
  world.madeButSaid = (status, opts) => fault('made-but-said', { status, ...opts }); // the change happens; the answer says otherwise
  world.madeButTimedOut = (opts) => fault('made-but-timed-out', opts);            // the change happens; no answer comes
  world.slow = (ms, opts) => fault('slow', { ms, ...opts });
  world.big = (opts) => fault('big', opts);
  world.redirect = (opts) => fault('redirect', opts);
  world.dropField = (name, opts) => fault('drop', { field: name, times: Infinity, ...opts });
  world.down = (opts) => fault('refuse', { status: 503, times: Infinity, ...opts });
  world.up = () => { world.faults.length = 0; return world; };
  const faultFor = (line) => {
    const f = world.faults.find((x) => x.times > 0 && x.kind !== 'drop' && x.on.test(line));
    if (f) f.times -= 1;
    return f || null;
  };
  const drop = (line, json) => {
    const names = world.faults.filter((x) => x.kind === 'drop' && x.on.test(line)).map((x) => x.field);
    if (!names.length || json == null) return json;
    const strip = (v) => {
      if (Array.isArray(v)) return v.map(strip);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !names.includes(k)).map(([k, x]) => [k, strip(x)]));
      return v;
    };
    return strip(json);
  };

  const page = (list, key, url) => {
    const limit = Math.min(Number(url.searchParams.get('limit')) || 20, world.pageSize);
    const cursor = url.searchParams.get('cursor');
    const from = cursor ? Number(cursor.replace(/^c/, '')) : 0;
    return list.slice(from, from + limit).map((item, i) => ({ cursor: `c${from + i + 1}`, [key]: item }));
  };
  const no = (line) => { world.forbidden.push(line); return { status: 404, json: { message: `SENTINEL-RENDER-BODY: nothing at ${line}` } }; };

  // One request → { status, json }. Never throws.
  const handle = (method, path, body) => {
    const line = `${method} ${path}`;
    const url = new URL(path, 'http://fake.invalid');
    const parts = url.pathname.split('/').filter(Boolean);
    if (method === 'DELETE') return no(line);
    if (/\/(suspend|resume|scale|rollback|jobs|logs|export|recovery|credentials|secret-files|env-groups|disks|members|webhooks|connection-info)\b/.test(url.pathname)) return no(line);
    if (parts[0] === 'owners' && parts.length === 1 && method === 'GET') return { status: 200, json: page(world.owners, 'owner', url) };
    if (parts[0] === 'blueprints' && parts.length === 1 && method === 'GET') return { status: 200, json: page(world.blueprints, 'blueprint', url) };
    if (parts[0] === 'services') {
      if (parts.length === 1) {
        if (method !== 'GET') return no(line);
        const owner = url.searchParams.get('ownerId');
        const list = world.ignoreOwnerFilter ? world.services : world.services.filter((s) => s.ownerId === owner);
        return { status: 200, json: page(list, 'service', url) };
      }
      const s = byId(parts[1]);
      if (!s) return { status: 404, json: { message: 'SENTINEL-RENDER-BODY: not found' } };
      if (parts.length === 2) return method === 'GET' ? { status: 200, json: s } : no(line);
      if (parts[2] === 'deploys' && parts.length === 3) {
        if (method === 'GET') return { status: 200, json: page([...world.deploys[s.id]].reverse(), 'deploy', url) };
        if (method === 'POST') {
          if (JSON.stringify(Object.keys(body || {})) !== '["clearCache"]') return no(`${line} ${JSON.stringify(body)}`);
          deployCount += 1;
          const d = { ...deployOf(deployCount, 'build_in_progress', 'c41f2aa0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6'), createdAt: new Date().toISOString() };
          world.deploys[s.id].push(d);
          return { status: 201, json: { id: d.id, status: d.status } };
        }
        return no(line);
      }
      if (parts[2] === 'restart' && parts.length === 3 && method === 'POST') { world.restarts.push(s.id); return { status: 200, json: {} }; }
      if (parts[2] === 'env-vars') {
        if (parts.length === 3) return no(line); // the whole list, read or written: never
        const key = decodeURIComponent(parts[3]);
        if (parts.length !== 4 || !READABLE.includes(key)) return no(line);
        if (method === 'GET') {
          return Object.hasOwn(world.settings[s.id], key) ? { status: 200, json: { key, value: world.settings[s.id][key] } } : { status: 404, json: { message: 'SENTINEL-RENDER-BODY: no such setting' } };
        }
        if (method === 'PUT') {
          if (JSON.stringify(Object.keys(body || {})) !== '["value"]' || typeof body.value !== 'string') return no(`${line} ${JSON.stringify(body)}`);
          world.settings[s.id][key] = body.value;
          return { status: 200, json: { key, value: body.value } };
        }
        return no(line);
      }
      if (parts[2] === 'custom-domains') {
        const list = world.domains[s.id];
        if (parts.length === 3 && method === 'GET') return { status: 200, json: page(list, 'customDomain', url) };
        if (parts.length === 3 && method === 'POST') {
          if (JSON.stringify(Object.keys(body || {})) !== '["name"]') return no(`${line} ${JSON.stringify(body)}`);
          if (Object.values(world.domains).flat().some((d) => d.name === body.name)) return { status: 409, json: { message: 'SENTINEL-RENDER-BODY: taken' } };
          list.push({ name: body.name, verificationStatus: 'unverified' });
          return { status: 201, json: [{ name: body.name, verificationStatus: 'unverified' }] };
        }
        if (parts.length === 5 && parts[4] === 'verify' && method === 'POST') {
          const d = list.find((x) => x.name === decodeURIComponent(parts[3]));
          if (!d) return { status: 404, json: { message: 'SENTINEL-RENDER-BODY: no such domain' } };
          if (world.dnsReady?.includes(d.name)) d.verificationStatus = 'verified';
          return { status: 200, json: {} };
        }
        return no(line);
      }
      return no(line);
    }
    if (parts[0] === 'postgres') {
      if (parts.length === 1) {
        if (method !== 'GET') return no(line);
        const owner = url.searchParams.get('ownerId');
        const list = world.ignoreOwnerFilter ? world.databases : world.databases.filter((d) => d.owner.id === owner);
        return { status: 200, json: page(list, 'postgres', url) };
      }
      const d = dbById(parts[1]);
      if (!d) return { status: 404, json: { message: 'SENTINEL-RENDER-BODY: not found' } };
      if (parts.length !== 2) return no(line);
      if (method === 'GET') return { status: 200, json: d };
      if (method === 'PATCH') {
        const held = d.ipAllowList.map((e) => JSON.stringify(e));
        const sent = body?.ipAllowList;
        if (JSON.stringify(Object.keys(body || {})) !== '["ipAllowList"]' || !Array.isArray(sent) || sent.some((e) => !held.includes(JSON.stringify(e)))) return no(`${line} ${JSON.stringify(body)}`);
        if (!world.keepsOpen) d.ipAllowList = sent;
        return { status: 200, json: d };
      }
      return no(line);
    }
    return no(line);
  };

  // The in-memory transport: what render-api.mjs's own send would give back.
  world.send = async (method, path, body) => {
    world.calls.push({ method, path, body: body === undefined ? null : JSON.parse(JSON.stringify(body)) });
    const line = `${method} ${path}`;
    const f = faultFor(line);
    if (f?.kind === 'refuse') return { status: f.status, json: { message: 'SENTINEL-RENDER-BODY: refused' }, retryAfter: 0 };
    if (f?.kind === 'redirect') return { status: 302, json: null };
    if (f?.kind === 'big') { const e = new Error('too-big'); e.name = 'too-big'; throw e; }
    if (f?.kind === 'slow') await new Promise((r) => setTimeout(r, f.ms));
    const res = handle(method, path, body);
    if (f?.kind === 'made-but-said') return { status: f.status, json: { message: 'SENTINEL-RENDER-BODY: an error' } };
    if (f?.kind === 'made-but-timed-out') { const e = new Error('timeout'); e.name = 'timeout'; throw e; }
    return { status: res.status, json: drop(line, res.json) };
  };
  world.handle = handle;
  world.faultFor = faultFor;
  world.drop = drop;
  // Requests that changed something (or tried to).
  world.writes = () => world.calls.filter((c) => c.method !== 'GET');
  return world;
};

// The settings a console under test runs with when it holds a Render key.
export const renderEnv = (over = {}) => Object.assign(process.env, { RENDER_API_KEY: KEY, RENDER_SERVICE_ID: IDS.platform, ...over });
export const noRenderEnv = () => { for (const k of ['RENDER_API_KEY', 'RENDER_SERVICE_ID', 'OPS_RENDER_API', 'RENDER']) delete process.env[k]; };

// The same world behind a real listener, as Render's API is behind its own:
// GET/POST/PUT/PATCH under /v1, a Bearer key, JSON in and out.
export const startFakeRender = ({ port = 5608, world = fakeWorld() } = {}) => new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', async () => {
      const path = req.url.replace(/^\/v1/, '');
      let body;
      try { body = raw ? JSON.parse(raw) : undefined; } catch { body = undefined; }
      world.received.push({ method: req.method, path, auth: req.headers.authorization || null, body: body ?? null, headers: { ...req.headers } });
      world.calls.push({ method: req.method, path, body: body ?? null });
      const line = `${req.method} ${path}`;
      const out = (status, json, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(json === null ? '' : JSON.stringify(json)); };
      if (!req.url.startsWith('/v1/')) { world.forbidden.push(line); return out(404, { message: 'not the API' }); }
      if (req.headers.authorization !== `Bearer ${world.key}`) return out(401, { message: 'SENTINEL-RENDER-BODY: unauthorized' });
      const f = world.faultFor(line);
      if (f?.kind === 'refuse') return out(f.status, { message: 'SENTINEL-RENDER-BODY: refused' }, { 'retry-after': '0' });
      if (f?.kind === 'redirect') return out(302, null, { location: `http://127.0.0.1:${port}/elsewhere` });
      if (f?.kind === 'big') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ filler: 'x'.repeat(600 * 1024) })); }
      if (f?.kind === 'slow') await new Promise((r) => setTimeout(r, f.ms));
      const r = world.handle(req.method, path, body);
      if (f?.kind === 'made-but-said') return out(f.status, { message: 'SENTINEL-RENDER-BODY: an error' });
      if (f?.kind === 'made-but-timed-out') return req.socket.destroy();
      return out(r.status, world.drop(line, r.json));
    });
  });
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => resolve({
    world, port: server.address().port, base: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  }));
});
