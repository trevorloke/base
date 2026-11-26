// The control centre's one way to Render's API, and the only file that
// names Render's host or reads the Render key (a structural test checks).
//
// It is a short, closed list of named calls (CALLS). There is no general
// "send a request" to import: a call that is not in the table cannot be
// made, and nothing that removes, stops or resizes anything is in the
// table. Every change takes a checked target (target() below), never an id.
//
// What comes back is cut down here before anyone else sees it: ids, names
// and states, each checked against the shape it should have. Render's own
// answer never leaves this file, a setting's value is dropped the moment
// it arrives, and nothing is ever printed.
//
// RENDER'S API IS WRITTEN HERE FROM MEMORY AND HAS NOT BEEN CHECKED AGAINST
// THE REAL THING. Every word of Render's that this file relies on is in
// CALLS and SHAPES and in the readers just below them, so a wrong guess is
// fixed in this file alone. "Check Render’s answers" on the Render page
// (check() here) says which answers are as expected.
import http from 'node:http';
import https from 'node:https';
import { cfg, renderKey, RENDER_ID_RE } from './config.mjs';
import { normalizeOrigin } from './campaigns.mjs';
import { READABLE, CANARY, guard, valueFor, domainFor, databaseNameFor, REFUSALS } from './render-guard.mjs';

const API_HOST = 'api.render.com';
const API_PATH = '/v1';
const MAX_BYTES = 512 * 1024;
const CALL_MS = 8000;
const CACHE_MS = 60_000;
const MAX_PAGES = 5;

// ── The whole surface: every request this file can make ──
// {id} a Render id · {owner} the workspace's id · {key} a setting on READABLE
// · {host} a campaign's own address · {cursor} the next page of a list.
export const CALLS = Object.freeze({
  self: ['GET', '/services/{id}'],
  workspaces: ['GET', '/owners?limit=20'],
  services: ['GET', '/services?ownerId={owner}&limit=100{cursor}'],
  service: ['GET', '/services/{id}'],
  lastDeploy: ['GET', '/services/{id}/deploys?limit=1'],
  domains: ['GET', '/services/{id}/custom-domains?limit=20'],
  isSet: ['GET', '/services/{id}/env-vars/{key}'],
  databases: ['GET', '/postgres?ownerId={owner}&limit=100{cursor}'],
  database: ['GET', '/postgres/{id}'],
  blueprints: ['GET', '/blueprints?limit=20'],
  deploy: ['POST', '/services/{id}/deploys'],
  restart: ['POST', '/services/{id}/restart'],
  setOne: ['PUT', '/services/{id}/env-vars/{key}'],
  addDomain: ['POST', '/services/{id}/custom-domains'],
  checkDomain: ['POST', '/services/{id}/custom-domains/{host}/verify'],
  closeDatabase: ['PATCH', '/postgres/{id}'],
});

// ── Every word of Render's this file relies on (all unverified) ──
export const SHAPES = Object.freeze({
  // What a new campaign's service and database are made as (the same words
  // as snippets.mjs renderSnippet and render.yaml's production block; a
  // test keeps the three equal). Nothing is made by this file yet.
  make: Object.freeze({
    servicePlan: 'starter', databasePlan: 'basic-1gb', databasePlanApi: 'basic_1gb', region: 'oregon', postgres: '16',
    branch: 'production', runtime: 'docker', dockerfilePath: './Dockerfile', dockerContext: '.', healthCheckPath: '/api/health', autoDeploy: 'yes',
  }),
  // The build command the control centre's own service should have.
  platformBuild: 'npm ci --omit=dev --ignore-scripts',
  platformBranch: 'production',
  // Answers.
  serviceTypes: ['web_service', 'static_site', 'private_service', 'background_worker', 'cron_job'],
  webService: 'web_service',
  autoDeploy: { yes: true, no: false },
  suspended: { suspended: true, not_suspended: false },
  deployStates: {
    live: 'live',
    created: 'deploying', queued: 'deploying', build_in_progress: 'deploying', update_in_progress: 'deploying', pre_deploy_in_progress: 'deploying',
    build_failed: 'failed', update_failed: 'failed', pre_deploy_failed: 'failed',
    canceled: 'other', deactivated: 'other',
  },
  domainVerified: { verified: true, unverified: false },
  databaseStates: ['creating', 'available', 'unavailable', 'config_restart', 'suspended', 'maintenance_scheduled', 'maintenance_in_progress', 'recovery_failed', 'recovery_in_progress', 'unknown', 'updating_instance'],
  servicePlans: ['free', 'starter', 'starter_plus', 'standard', 'standard_plus', 'pro', 'pro_plus', 'pro_max', 'pro_ultra'],
  databasePlans: ['free', 'basic_256mb', 'basic_1gb', 'basic_4gb', 'pro_4gb', 'pro_8gb', 'pro_16gb', 'pro_32gb', 'pro_64gb', 'basic-256mb', 'basic-1gb', 'basic-4gb', 'starter', 'standard', 'pro'],
  regions: ['oregon', 'ohio', 'virginia', 'frankfurt', 'singapore'],
  // "Anyone on the internet" in a database's allow-list.
  anywhere: ['0.0.0.0/0', '::/0'],
  clearCache: 'do_not_clear',
  // Lists come wrapped: [{ cursor, <thing> }].
  wrap: { services: 'service', databases: 'postgres', deploys: 'deploy', domains: 'customDomain', workspaces: 'owner', blueprints: 'blueprint' },
});

// ── Typed strings: anything that isn't the shape it should be is null ──
const str = (v, max = 200) => (typeof v === 'string' && v.length <= max ? v : null);
const T = {
  id: (v) => (str(v) && RENDER_ID_RE.test(v) ? v : null),
  name: (v) => (str(v) && /^[a-z0-9][a-z0-9.-]{0,80}$/.test(v) ? v : null),
  commit: (v) => (str(v) && /^[0-9a-f]{7,40}$/.test(v) ? v.slice(0, 7) : null),
  oneOf: (list) => (v) => (typeof v === 'string' && list.includes(v) ? v : null),
  mapped: (map) => (v) => (typeof v === 'string' && Object.hasOwn(map, v) ? map[v] : null),
  time: (v) => { const t = str(v, 40) ? Date.parse(v) : NaN; return Number.isFinite(t) ? new Date(t).toISOString() : null; },
  origin: (v) => (str(v, 300) ? normalizeOrigin(/^https?:\/\//.test(v) ? v : `https://${v}`) : null),
  repo: (v) => (str(v, 300) && /^https:\/\/(github|gitlab)\.com\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(v.replace(/\.git$/, '')) ? v.replace(/\.git$/, '') : null),
  branch: (v) => (str(v, 120) && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/.test(v) ? v : null),
  // A workspace's name as shown: letters, numbers and plain marks; never an email.
  label: (v) => (str(v, 60) && /^[\p{L}\p{N}][\p{L}\p{N} .,'’&()_-]{0,59}$/u.test(v) ? v : null),
  version: (v) => (str(String(v ?? ''), 4) && /^\d{1,3}$/.test(String(v)) ? String(v) : null),
  cidr: (v) => (str(v, 60) && /^[0-9a-fA-F:.]{2,45}\/\d{1,3}$/.test(v) ? v : null),
};
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

// A reader notes which fields it needed and didn't get (by our own names
// for them, never Render's words).
const reading = () => {
  const need = [];
  const missing = [];
  return {
    must: (field, v) => { if (v == null) need.push(field); return v ?? null; },
    may: (field, v) => { if (v == null) missing.push(field); return v ?? null; },
    done: (value) => (need.length ? { value: null, need, missing } : { value, need, missing }),
  };
};

const serviceOf = (raw) => {
  const s = obj(raw);
  const d = obj(s.serviceDetails);
  const r = reading();
  return r.done({
    id: r.must('id', T.id(s.id)),
    name: r.must('name', T.name(s.name)),
    type: r.must('type', T.oneOf(SHAPES.serviceTypes)(s.type)),
    ownerId: r.must('ownerId', T.id(s.ownerId)),
    repo: r.may('repo', T.repo(s.repo)),
    branch: r.may('branch', T.branch(s.branch)),
    auto: r.may('autoDeploy', T.mapped(SHAPES.autoDeploy)(s.autoDeploy)),
    suspended: r.may('suspended', T.mapped(SHAPES.suspended)(s.suspended)),
    url: r.may('serviceDetails.url', T.origin(d.url)),
    plan: r.may('serviceDetails.plan', T.oneOf(SHAPES.servicePlans)(d.plan)),
    region: r.may('serviceDetails.region', T.oneOf(SHAPES.regions)(d.region)),
    createdAt: r.may('createdAt', T.time(s.createdAt)),
  });
};
// The control centre's own service: where it is, and how it is built.
const selfOf = (raw) => {
  const s = obj(raw);
  const d = obj(s.serviceDetails);
  const r = reading();
  const build = str(obj(d.envSpecificDetails).buildCommand, 500) ?? str(d.buildCommand, 500);
  return r.done({
    id: r.must('id', T.id(s.id)),
    ownerId: r.must('ownerId', T.id(s.ownerId)),
    repo: r.must('repo', T.repo(s.repo)),
    branch: r.may('branch', T.branch(s.branch)),
    // Only whether it is the build command it should be; the command itself is not kept.
    build: r.may('build command', build == null ? null : (build.trim() === SHAPES.platformBuild ? 'ignore-scripts' : 'other')),
  });
};
const databaseOf = (raw) => {
  const p = obj(raw);
  const r = reading();
  const list = Array.isArray(p.ipAllowList) ? p.ipAllowList : null;
  const blocks = list ? list.map((e) => T.cidr(obj(e).cidrBlock)) : null;
  const allow = blocks && blocks.every((b) => b != null) ? blocks : null;
  return r.done({
    id: r.must('id', T.id(p.id)),
    name: r.must('name', T.name(p.name)),
    ownerId: r.must('owner.id', T.id(obj(p.owner).id)),
    plan: r.may('plan', T.oneOf(SHAPES.databasePlans)(p.plan)),
    version: r.may('version', T.version(p.version)),
    region: r.may('region', T.oneOf(SHAPES.regions)(p.region)),
    status: r.may('status', T.oneOf(SHAPES.databaseStates)(p.status)),
    createdAt: r.may('createdAt', T.time(p.createdAt)),
    // Who may connect: whether "anyone" is on the list, and how many others. The addresses are not kept.
    open: r.may('ipAllowList', allow ? allow.some((b) => SHAPES.anywhere.includes(b)) : null),
    others: allow ? allow.filter((b) => !SHAPES.anywhere.includes(b)).length : null,
  });
};
const deployOf = (raw) => {
  const d = obj(raw);
  const r = reading();
  return r.done({
    state: r.must('status', typeof d.status === 'string' ? (SHAPES.deployStates[d.status] || 'other') : null),
    commit: r.may('commit.id', T.commit(obj(d.commit).id)),
    at: r.may('createdAt', T.time(d.finishedAt) || T.time(d.createdAt)),
    started: T.time(d.createdAt),
  });
};
const domainOf = (raw) => {
  const d = obj(raw);
  const r = reading();
  return r.done({
    name: r.must('name', T.name(str(d.name)?.toLowerCase())),
    verified: r.must('verificationStatus', T.mapped(SHAPES.domainVerified)(d.verificationStatus)),
  });
};
const blueprintOf = (raw) => {
  const b = obj(raw);
  const r = reading();
  return r.done({
    label: r.may('name', T.label(b.name)),
    branch: r.may('branch', T.branch(b.branch)),
    autoSync: r.may('autoSync', typeof b.autoSync === 'boolean' ? b.autoSync : null),
  });
};

// ── Problems, by name ──
const problemOf = (status) => {
  if (status === 401 || status === 403) return 'refused-key';
  if (status === 404) return 'not-found';
  if (status === 409) return 'conflict';
  if (status === 400 || status === 422) return 'invalid';
  if (status === 402) return 'payment';
  if (status === 429) return 'busy';
  return 'error';
};
const fail = (problem, { status = null, unsure = false, field = null } = {}) => ({ ok: false, status, problem, unsure, ...(field ? { field } : {}) });
const named = (name) => { const e = new Error(name); e.name = name; return e; };

// ── The transport: the only place a request is made ──
// → { status, json, retryAfter }; throws an Error whose name says why.
const transport = (key, base) => (method, path, body, { timeoutMs = CALL_MS } = {}) => new Promise((resolve, reject) => {
  // base is '' for Render itself; a test's stand-in is http://127.0.0.1:<port>/v1 (config.mjs allows no other).
  const local = base ? new URL(base) : null;
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const req = (local ? http : https).request({
    method,
    host: local ? local.hostname : API_HOST,
    port: local ? local.port : 443,
    path: `${local ? local.pathname.replace(/\/+$/, '') : API_PATH}${path}`,
    agent: false,
    timeout: timeoutMs,
    headers: {
      Authorization: `Bearer ${key}`,
      accept: 'application/json',
      'user-agent': 'base.win-control-centre',
      ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
    },
  }, (res) => {
    const chunks = [];
    let size = 0;
    let over = false;
    res.on('data', (d) => {
      size += d.length;
      if (size > MAX_BYTES) { over = true; res.destroy(); return reject(named('too-big')); }
      return chunks.push(d);
    });
    res.on('end', () => {
      if (over) return;
      const text = Buffer.concat(chunks).toString('utf8');
      let json = null;
      let unreadable = false;
      if (text.trim()) { try { json = JSON.parse(text); } catch { unreadable = true; } }
      const wait = Number(res.headers['retry-after']);
      resolve({ status: res.statusCode, json, unreadable, retryAfter: Number.isFinite(wait) ? wait : null });
    });
    res.on('error', () => (over ? null : reject(named('dropped'))));
  });
  // The whole answer within the time, not only each pause in it.
  const timer = setTimeout(() => req.destroy(named('timeout')), timeoutMs);
  timer.unref?.();
  req.on('close', () => clearTimeout(timer));
  req.on('timeout', () => req.destroy(named('timeout')));
  req.on('error', (e) => reject(named(e.name === 'timeout' || e.name === 'too-big' ? e.name : 'dropped')));
  req.end(payload || undefined);
});

const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const CURSOR_RE = /^[A-Za-z0-9_=-]{1,200}$/;
const PARAM_OK = {
  id: (v) => RENDER_ID_RE.test(v),
  owner: (v) => RENDER_ID_RE.test(v),
  key: (v) => READABLE.includes(v),
  host: (v) => HOST_RE.test(v) && v.length <= 200,
};

// → the client, or null with no key. `send` is how a test stands in for the
// transport; everything above it (the table, the id checks, the readers)
// is the same either way.
export const makeRender = ({ key = renderKey(), base = cfg().renderApi, send, timeoutMs = CALL_MS, cacheMs = CACHE_MS } = {}) => {
  if (!key) return null;
  const wire = send || transport(key, base);

  // One call from the table → { status, json } or { failed }.
  const call = async (name, params = {}, body) => {
    if (!Object.hasOwn(CALLS, name)) return { failed: fail('error') };
    const [method, template] = CALLS[name];
    const write = method !== 'GET';
    let bad = false;
    const path = template.replace(/\{(\w+)\}/g, (_, p) => {
      const v = params[p];
      if (p === 'cursor') {
        if (v == null) return '';
        if (typeof v !== 'string' || !CURSOR_RE.test(v)) { bad = true; return ''; }
        return `&cursor=${encodeURIComponent(v)}`;
      }
      if (typeof v !== 'string' || !PARAM_OK[p]?.(v)) { bad = true; return ''; }
      return encodeURIComponent(v);
    });
    // An id that isn't an id never reaches the wire.
    if (bad) return { failed: fail('error') };
    const once = async () => {
      let timer;
      try {
        return await Promise.race([
          wire(method, path, body, { timeoutMs }),
          new Promise((_, no) => { timer = setTimeout(() => no(named('timeout')), timeoutMs + 250); timer.unref?.(); }),
        ]);
      } catch (e) {
        return { thrown: e?.name === 'timeout' ? 'timeout' : e?.name === 'too-big' ? 'unexpected-answer' : 'error' };
      } finally { clearTimeout(timer); }
    };
    let res = await once();
    if (res.status === 429) {
      // Asked to slow down: one more try, after the wait Render names (5 s at most).
      const wait = Math.min(Math.max(Number(res.retryAfter ?? 1) || 0, 0), 5) * 1000;
      await new Promise((r) => { setTimeout(r, wait); });
      res = await once();
    }
    // No answer: a change may or may not have happened.
    if (res.thrown) return { failed: fail(res.thrown, { unsure: write && res.thrown !== 'unexpected-answer' }) };
    const status = Number(res.status);
    if (!(status >= 200 && status < 300)) return { failed: fail(problemOf(status), { status, unsure: write && status >= 500 }) };
    if (res.unreadable) return { failed: fail('unexpected-answer', { status }) };
    return { status, json: res.json };
  };

  // ── What was read, kept a minute (the cut-down shapes only) ──
  const cache = new Map();
  const cached = async (k, fresh, read) => {
    const hit = cache.get(k);
    if (!fresh && hit && Date.now() - hit.at < cacheMs) return hit.value;
    const value = await read();
    if (value.ok && cacheMs > 0) cache.set(k, { at: Date.now(), value });
    return value;
  };
  const forget = () => cache.clear();

  const one = (reader) => (res) => {
    if (res.failed) return res.failed;
    const { value, need, missing } = reader(res.json);
    if (!value) return fail('unexpected-answer', { status: res.status, field: need[0] });
    return { ok: true, ...value, missing };
  };
  // A wrapped list → its items, read one by one. An item that can't be read is left out and counted.
  const items = (res, wrap, reader) => {
    if (res.failed) return res.failed;
    if (!Array.isArray(res.json)) return fail('unexpected-answer', { status: res.status, field: 'a list' });
    const list = [];
    const need = new Set();
    let last = null;
    for (const row of res.json) {
      const inner = obj(row)[wrap];
      if (inner === undefined) { need.add(wrap); continue; }
      const { value, need: n } = reader(inner);
      if (value) list.push(value); else for (const f of n) need.add(f);
      last = typeof obj(row).cursor === 'string' ? obj(row).cursor : null;
    }
    return { ok: true, list, cursor: last, count: res.json.length, missing: [...need] };
  };

  // ── Reads ──
  const self = ({ fresh = false } = {}) => cached('self', fresh, async () => {
    const own = cfg().ownService;
    if (!own) return fail('no-own-id');
    const res = await call('self', { id: own });
    // The key can't see this very service: it belongs to some other workspace.
    if (res.failed?.problem === 'not-found') return fail('other-workspace', { status: 404 });
    return one(selfOf)(res);
  });
  // Every page of a list (five at most), ours only.
  const all = async (name, wrap, reader, fresh) => cached(name, fresh, async () => {
    const me = await self();
    if (!me.ok) return me;
    const list = [];
    const missing = new Set();
    let cursor = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const got = items(await call(name, { owner: me.ownerId, cursor }), wrap, reader);
      if (!got.ok) return got;
      for (const x of got.list) if (x.ownerId === me.ownerId) list.push(x);
      for (const f of got.missing) missing.add(f);
      if (got.count < 100 || !got.cursor || !CURSOR_RE.test(got.cursor)) break;
      cursor = got.cursor;
    }
    return { ok: true, list, missing: [...missing] };
  });
  const workspaces = ({ fresh = false } = {}) => cached('workspaces', fresh, async () => {
    const me = await self();
    if (!me.ok) return me;
    const got = items(await call('workspaces'), SHAPES.wrap.workspaces, (raw) => {
      const r = reading();
      // The email Render sends with each is never read.
      return r.done({ id: r.must('id', T.id(obj(raw).id)), label: r.may('name', T.label(obj(raw).name)) });
    });
    if (!got.ok) return got;
    const mine = got.list.find((o) => o.id === me.ownerId);
    return { ok: true, count: got.list.length, label: mine?.label || null, missing: got.missing };
  });
  const services = ({ fresh = false } = {}) => all('services', SHAPES.wrap.services, serviceOf, fresh);
  const databases = ({ fresh = false } = {}) => all('databases', SHAPES.wrap.databases, databaseOf, fresh);
  const service = (id, { fresh = false } = {}) => cached(`service ${id}`, fresh, async () => one(serviceOf)(await call('service', { id })));
  const database = (id, { fresh = false } = {}) => cached(`database ${id}`, fresh, async () => one(databaseOf)(await call('database', { id })));
  const lastDeploy = (id, { fresh = false } = {}) => cached(`deploy ${id}`, fresh, async () => {
    const got = items(await call('lastDeploy', { id }), SHAPES.wrap.deploys, deployOf);
    if (!got.ok) return got;
    if (got.missing.length && !got.list.length) return fail('unexpected-answer', { field: got.missing[0] });
    // The commit's message comes with it and is never read.
    return got.list[0] ? { ok: true, ...got.list[0], missing: [] } : { ok: true, state: 'none', commit: null, at: null, started: null, missing: [] };
  });
  const domains = (id, { fresh = false } = {}) => cached(`domains ${id}`, fresh, async () => {
    const got = items(await call('domains', { id }), SHAPES.wrap.domains, domainOf);
    if (!got.ok) return got;
    if (got.missing.length) return fail('unexpected-answer', { field: got.missing[0] });
    return { ok: true, list: got.list, missing: [] };
  });
  // Is this setting set? The answer carries its value; it is dropped here
  // and only "set" or "not set" goes on.
  const isSet = (id, key, { fresh = false } = {}) => cached(`set ${id} ${key}`, fresh, async () => {
    if (!READABLE.includes(key)) return fail('not-allowed');
    const res = await call('isSet', { id, key });
    if (res.failed?.problem === 'not-found') return { ok: true, set: false };
    if (res.failed) return res.failed;
    if (obj(res.json).key !== key) return fail('unexpected-answer', { status: res.status, field: 'key' });
    return { ok: true, set: true };
  });
  const blueprints = ({ fresh = false } = {}) => cached('blueprints', fresh, async () => {
    const got = items(await call('blueprints'), SHAPES.wrap.blueprints, blueprintOf);
    return got.ok ? { ok: true, list: got.list, missing: got.missing } : got;
  });

  // ── Targets: the only thing a change may be made to ──
  // A target is made here, after the guard, and kept in a private set: a
  // change handed anything else (an id, a look-alike object) is refused.
  const targets = new WeakSet();
  const about = new WeakMap();
  const refused = (code) => ({ ok: false, refusal: REFUSALS[code] || REFUSALS.unread, code });
  const fits = (t, kind) => targets.has(t) && t.kind === kind;

  // The service saved for this campaign, read again now and checked.
  // health: the newest check of the campaign's saved Render address.
  const target = async (campaign, envRow, health, { database: wantDb = false } = {}) => {
    if (!envRow?.render_service || !T.id(envRow.render_service)) return refused('changed');
    const me = await self({ fresh: true });
    if (!me.ok) return me;
    const svc = await service(envRow.render_service, { fresh: true });
    if (!svc.ok) return svc.problem === 'not-found' ? refused('changed') : svc;
    let db;
    if (wantDb) {
      if (!envRow.render_db || !T.id(envRow.render_db)) return refused('database');
      db = await database(envRow.render_db, { fresh: true });
      if (!db.ok) return db.problem === 'not-found' ? refused('database') : db;
    }
    const no = guard({ campaign, envRow, health, self: me, svc, db, ownId: cfg().ownService, phase: 'use' });
    if (no) return refused(no);
    const t = Object.freeze({
      kind: wantDb ? 'database' : 'service', id: wantDb ? db.id : svc.id, service: svc.id,
      name: wantDb ? db.name : svc.name, label: svc.name, url: svc.url, branch: svc.branch, campaign: campaign.name,
    });
    targets.add(t);
    about.set(t, { campaign });
    return { ok: true, target: t, svc, db: db || null };
  };

  // Connect: the one web service at the campaign's saved address, checked
  // the same way, and the database named after it. Nothing is changed.
  const candidate = async (campaign, envRow, health) => {
    const me = await self({ fresh: true });
    if (!me.ok) return me;
    const list = await services({ fresh: true });
    if (!list.ok) return list;
    const at = list.list.filter((s) => s.type === SHAPES.webService && s.url && s.url === envRow?.server_url);
    if (!at.length) return refused('address');
    if (at.length > 1) return refused('two');
    const svc = at[0];
    const no = guard({ campaign, envRow, health, self: me, svc, ownId: cfg().ownService, phase: 'link' });
    if (no) return refused(no);
    const dbs = await databases({ fresh: true });
    if (!dbs.ok) return dbs;
    const mine = dbs.list.filter((d) => d.name === databaseNameFor(svc.name));
    return { ok: true, service: svc, database: mine.length === 1 ? mine[0] : null };
  };

  // ── Changes: each takes a target ──
  const done = (res) => (res.failed ? res.failed : { ok: true });
  const NOT_ALLOWED = fail('not-allowed');
  const deploy = async (t) => {
    if (!fits(t, 'service')) return NOT_ALLOWED;
    return done(await call('deploy', { id: t.id }, { clearCache: SHAPES.clearCache }));
  };
  const restart = async (t) => {
    if (!fits(t, 'service')) return NOT_ALLOWED;
    return done(await call('restart', { id: t.id }));
  };
  // Set one setting. The caller names it; its value is worked out by
  // render-guard.mjs from base.win's own key. No caller can hand a value in.
  const setOne = async (t, key) => {
    if (!fits(t, 'service')) return NOT_ALLOWED;
    const value = valueFor(about.get(t).campaign, key);
    if (value == null) return NOT_ALLOWED;
    return done(await call('setOne', { id: t.id, key }, { value }));
  };
  // Add the campaign's own address at base.win. The address is built from
  // the campaign's short name, never typed.
  const addDomain = async (t) => {
    const host = fits(t, 'service') ? domainFor(about.get(t).campaign) : null;
    if (!host) return NOT_ALLOWED;
    return done(await call('addDomain', { id: t.id }, { name: host }));
  };
  const checkDomain = async (t) => {
    const host = fits(t, 'service') ? domainFor(about.get(t).campaign) : null;
    if (!host) return NOT_ALLOWED;
    return done(await call('checkDomain', { id: t.id, host }));
  };
  // Close a database to the internet: read who may connect, send the same
  // list back without the "anyone" entries. It can only make the list
  // shorter: every entry sent is one that was just read.
  const closeDatabase = async (t) => {
    if (!fits(t, 'database')) return NOT_ALLOWED;
    const read = await call('database', { id: t.id });
    if (read.failed) return read.failed;
    const held = obj(read.json).ipAllowList;
    if (!Array.isArray(held)) return fail('unexpected-answer', { field: 'ipAllowList' });
    const entries = [];
    for (const e of held) {
      const block = T.cidr(obj(e).cidrBlock);
      if (!block) return fail('unexpected-answer', { field: 'ipAllowList' });
      const words = obj(e).description;
      entries.push(typeof words === 'string' ? { cidrBlock: block, description: words } : { cidrBlock: block });
    }
    const keep = entries.filter((e) => !SHAPES.anywhere.includes(e.cidrBlock));
    if (keep.length === entries.length) return { ok: true, already: true };
    const was = new Set(entries.map((e) => JSON.stringify(e)));
    if (keep.length >= entries.length || keep.some((e) => !was.has(JSON.stringify(e)))) return NOT_ALLOWED;
    return done(await call('closeDatabase', { id: t.id }, { ipAllowList: keep }));
  };

  // ── Check Render’s answers: every read, and whether it came back as expected ──
  // ids: the sample's saved service and database (staging holds only made-up
  // data), or neither before the sample is connected.
  const check = async ({ service: sid = null, database: did = null } = {}) => {
    forget();
    const line = (name, r, extra = []) => ({
      call: name,
      ok: Boolean(r.ok) && !(r.missing || []).length && !extra.length,
      problem: r.ok ? null : r.problem,
      status: r.ok ? null : r.status,
      fields: r.ok ? [...(r.missing || []), ...extra] : (r.field ? [r.field] : []),
    });
    const out = [];
    const me = await self({ fresh: true });
    out.push(line('self', me));
    out.push(line('workspaces', await workspaces({ fresh: true })));
    out.push(line('services', await services({ fresh: true })));
    out.push(line('databases', await databases({ fresh: true })));
    out.push(line('blueprints', await blueprints({ fresh: true })));
    if (sid && T.id(sid)) {
      out.push(line('service', await service(sid, { fresh: true })));
      out.push(line('lastDeploy', await lastDeploy(sid, { fresh: true })));
      out.push(line('domains', await domains(sid, { fresh: true })));
      const set = await isSet(sid, CANARY, { fresh: true });
      // Every campaign service has this setting: "not set" means one setting can't be read alone.
      out.push(line('isSet', set, set.ok && !set.set ? ['one setting read alone'] : []));
    }
    if (did && T.id(did)) out.push(line('database', await database(did, { fresh: true })));
    forget();
    return out;
  };

  return Object.freeze({
    self, workspaces, services, service, lastDeploy, domains, isSet, databases, database, blueprints,
    target, candidate, deploy, restart, setOne, addDomain, checkDomain, closeDatabase, check, forget,
  });
};

// The control centre's own client: made when a key is there, made again
// when the key or the stand-in address changes (tests set them mid-run).
let shared = null;
export const sharedRender = () => {
  const key = renderKey();
  const base = cfg().renderApi;
  if (!key) { shared = null; return null; }
  if (!shared || shared.key !== key || shared.base !== base) shared = { key, base, client: makeRender({ key, base }) };
  return shared.client;
};
