// How fast buildings are on a city's voter file (HR-1): 300,000 made-up
// people in a scratch Postgres (PGlite's wire-protocol server on port 5522,
// as npm run test:pg uses), with about 110 towers of 200–700 people, 900
// walk-ups and townhouse complexes, and houses for the rest. The tree before
// buildings (BASE, a read-only export of the commit HR-1 started from) and
// this tree are timed in the same run, on the same data, by turns:
//   the building read on the biggest tower        p95 ≤ 300 ms (this tree)
//   the busy map's dots over City Centre (doorDots) no more than 10% slower
//   a walk list over a turf with three towers       no more than 10% slower
//
//   node scripts/bench-buildings.mjs <BASE tree> [people]
// BASE must have its own node_modules, with the workspace packages linked to
// its own folders (see
// TESTING.md). Nothing outside this machine is touched.
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { bothNames } from '../shared/old-names.js';

const PORT = 5522;
const RUNS = 15;
const here = resolve(new URL('..', import.meta.url).pathname);
const [mode] = process.argv.slice(2);

const percentile = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)];
const fmt = (xs) => `median ${percentile(xs, 50).toFixed(0)} ms · p95 ${percentile(xs, 95).toFixed(0)} ms`;

// ── A child: the app of one tree against the shared database ──
const appOf = async (tree) => {
  // Both names: the tree before reads the older ones, this tree the new ones.
  for (const k of bothNames('BASE_OPEN_SIGNUP')) process.env[k] = '1';
  process.env.GEOCODE_ON_SAVE = 'off';
  for (const k of bothNames('BASE_MAP_ALL')) process.env[k] = '20';
  const { app } = await import(join(tree, 'server/index.js'));
  const { getDb } = await import(join(tree, 'server/db/client.js'));
  let cookie = '';
  const req = async (path, opts = {}) => {
    const res = await app.request(path, { ...opts, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) } });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return res;
  };
  return { req, db: await getDb() };
};
const ACCOUNT = { email: 'hr-bench@example.org', password: 'hr-bench-2026' };

// The made-up city: towers on a grid in City Centre (200–700 people, ~1.5
// a unit, floors from 2, half with the unit written in front of the
// address), 900 walk-ups and townhouse complexes (units 1–N), and houses
// (about two people each) for the rest.
const CC = { s: 49.18, w: -122.86 };
const cityRows = (N) => {
  const rows = [];
  const push = (address, unit, lat, lng, k) => rows.push([`P${rows.length} Example`, address, unit, lat, lng, k % 3 === 0 ? '1' : k % 7 === 0 ? '3' : null]);
  const towers = [];
  for (let t = 0; t < 110; t += 1) {
    const people = 200 + ((t * 37) % 501);
    const lat = CC.s + (t % 11) * 0.0018;
    const lng = CC.w + Math.floor(t / 11) * 0.0018;
    const civic = `${13000 + t * 2} ${100 + (t % 11)} Ave`;
    towers.push({ civic, lat, lng, people });
    for (let i = 0; i < people; i += 1) {
      const u = Math.floor(i / 1.5);
      const unit = String((2 + Math.floor(u / 10)) * 100 + (u % 10) + 1);
      if (u % 2) push(`${unit}-${civic}`, null, lat, lng, i); else push(civic, unit, lat, lng, i);
    }
  }
  for (let k = 0; k < 900; k += 1) {
    const lat = 49.0 + ((k * 7919) % 2200) / 10000;
    const lng = -122.92 + ((k * 104729) % 2500) / 10000;
    const n = 20 + (k % 61);
    for (let i = 0; i < n; i += 1) push(`${5000 + k} ${60 + (k % 90)} St`, String(1 + Math.floor(i / 1.4)), lat, lng, i);
  }
  for (let g = 0; rows.length < N; g += 1) {
    const lat = 49.0 + ((g * 7919) % 220000) / 1000000;
    const lng = -122.92 + ((g * 104729) % 250000) / 1000000;
    for (let i = 0; i < 1 + (g % 3) && rows.length < N; i += 1) push(`${1000 + (g % 9000)} ${60 + (g % 120)} Ave`, g % 9 === 0 && i === 1 ? 'A' : null, lat, lng, g + i);
  }
  return { rows, towers };
};
// A turf round the first three towers (neighbours on one street of the grid).
const turfPolygon = () => {
  const d = 0.0006;
  const lng = CC.w;
  return [[CC.s - d, lng - d], [CC.s + 0.0036 + d, lng - d], [CC.s + 0.0036 + d, lng + d], [CC.s - d, lng + d]];
};

// The campaign, its open pass and the turf, made through this tree's app
// (which also makes the tables); the people go in from the parent.
if (mode === '--seed') {
  const { req } = await appOf(here);
  const ws = (await (await req('/api/auth/signup', { method: 'POST', body: JSON.stringify({ name: 'Bench Example', ...ACCOUNT, workspaceName: 'Buildings bench', jurisdiction: 'bc-municipal' }) })).json()).workspace.id;
  // A pass open (the walk list reads each person's tries in it).
  await req('/api/actions/pass.start', { method: 'POST', body: JSON.stringify({ name: 'Bench', kind: 'persuasion' }) });
  const turf = (await (await req('/api/actions/turf.create', { method: 'POST', body: JSON.stringify({ name: 'Three towers', polygon: turfPolygon() }) })).json()).turf;
  writeFileSync(process.argv[3], JSON.stringify({ ws, turf: turf.id }));
  process.exit(0);
}

if (mode === '--measure') {
  const [, tree, file, label] = process.argv.slice(2);
  const fx = JSON.parse(readFileSync(file, 'utf8'));
  const { req } = await appOf(tree);
  await req('/api/auth/login', { method: 'POST', body: JSON.stringify(ACCOUNT) });
  const time = async (path) => {
    const xs = [];
    let body;
    for (let i = 0; i < RUNS + 2; i += 1) {
      const t0 = performance.now();
      const res = await req(path);
      body = await res.json();
      if (res.status !== 200) throw new Error(`${path}: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
      if (i >= 2) xs.push(performance.now() - t0); // two warm-ups
    }
    return { xs, body };
  };
  const dots = await time(`/api/map/doors?bbox=${fx.box.join(',')}&dots=1`);
  const walk = await time(`/api/turfs/${fx.turf}/walk`);
  const res = { label, dots: dots.xs, dotsN: dots.body.dots?.length, walk: walk.xs, walkN: walk.body.doors.length };
  if (label === 'hr') {
    const b = await time(`/api/buildings/of/${fx.anchor}`);
    res.building = b.xs;
    res.buildingN = [b.body.building.units, b.body.building.people];
    res.squares = dots.body.dots.filter((x) => x[4] >= 4).length;
  }
  console.log(`RESULT ${JSON.stringify(res)}`);
  process.exit(0);
}

// ── The parent: the database, the seed, then both trees by turns ──
const base = resolve(mode || '');
if (!mode) { console.error('usage: node scripts/bench-buildings.mjs <BASE tree> [people]'); process.exit(2); }
const { PGlite } = await import('@electric-sql/pglite');
const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket');
// PGlite mishandles a chunk whose next message starts exactly at byte
// 16,384; hand it one whole message at a time (as scripts/test-pg.mjs does).
const oneMessageAtATime = (db) => {
  const raw = db.execProtocolRaw.bind(db);
  db.execProtocolRaw = async (data, opts) => {
    const view = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const lengths = [];
    for (let i = 0; i < view.length;) {
      if (i + 5 > view.length) return raw(data, opts);
      const len = view.readInt32BE(i + 1);
      if (len < 4 || i + 1 + len > view.length) return raw(data, opts);
      lengths.push(1 + len);
      i += 1 + len;
    }
    if (lengths.length < 2) return raw(data, opts);
    const out = [];
    let at = 0;
    for (const n of lengths) { out.push(Buffer.from(await raw(data.subarray(at, at + n), opts))); at += n; }
    return new Uint8Array(Buffer.concat(out));
  };
  return db;
};
const pglite = oneMessageAtATime(await PGlite.create());
const server = new PGLiteSocketServer({ db: pglite, port: PORT, host: '127.0.0.1' });
await server.start();
const env = { ...process.env, DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${PORT}/postgres`, PG_POOL_MAX: '1' };
const run = (args) => new Promise((ok, no) => {
  let out = '';
  const child = spawn(process.execPath, [join(here, 'scripts/bench-buildings.mjs'), ...args], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  child.stdout.on('data', (b) => { out += b; });
  child.on('exit', (code) => (code === 0 ? ok(out) : no(new Error(`${args[0]} exited ${code}\n${out}`))));
});
const fxFile = join(mkdtempSync(join(tmpdir(), 'hr-bench-')), 'fixture.json');
let t0 = performance.now();
await run(['--seed', fxFile]);
const fx = JSON.parse(readFileSync(fxFile, 'utf8'));
// The people straight into the database (big messages over the socket
// upset PGlite).
const { rows, towers } = cityRows(Number(process.argv[3]) || 300_000);
for (let i = 0; i < rows.length; i += 5000) {
  const c = rows.slice(i, i + 5000);
  await pglite.query(
    `insert into persons (id, workspace_id, name, address, unit, city, lat, lng, rating)
     select gen_random_uuid(), $1, n, a, u, 'Surrey', la, lo, r from unnest($2::text[], $3::text[], $4::text[], $5::float8[], $6::float8[], $7::text[]) as x(n, a, u, la, lo, r)`,
    [fx.ws, ...[0, 1, 2, 3, 4, 5].map((j) => c.map((r) => r[j]))],
  );
}
await pglite.query('analyze persons');
fx.big = towers.reduce((x, y) => (y.people > x.people ? y : x));
fx.anchor = (await pglite.query('select id from persons where workspace_id = $1 and address = $2 limit 1', [fx.ws, fx.big.civic])).rows[0].id;
fx.people = rows.length;
fx.box = [CC.s - 0.001, CC.w - 0.001, CC.s + 0.0195, CC.w + 0.0195];
writeFileSync(fxFile, JSON.stringify(fx));
console.log(`seeded ${fx.people.toLocaleString('en-CA')} people in ${((performance.now() - t0) / 1000).toFixed(0)} s; biggest tower ${fx.big.people} people`);
const all = { base: { dots: [], walk: [] }, hr: { dots: [], walk: [], building: [] } };
for (const round of [1, 2]) {
  for (const [label, tree] of round === 1 ? [['base', base], ['hr', here]] : [['hr', here], ['base', base]]) {
    const line = (await run(['--measure', tree, fxFile, label])).split('\n').find((l) => l.startsWith('RESULT '));
    const r = JSON.parse(line.slice(7));
    all[label].dots.push(...r.dots);
    all[label].walk.push(...r.walk);
    if (r.building) all.hr.building.push(...r.building);
    all[label].meta = r;
  }
}
await server.stop();
await pglite.close();
const ratio = (k) => percentile(all.hr[k], 50) / percentile(all.base[k], 50);
const m = all.hr.meta;
console.log(`building read (${m.buildingN[0]} units, ${m.buildingN[1]} people): ${fmt(all.hr.building)}  ${percentile(all.hr.building, 95) <= 300 ? 'ok' : 'OVER 300 ms'}`);
console.log(`dots over City Centre (${m.dotsN} spots, ${m.squares} buildings): base ${fmt(all.base.dots)} · HR ${fmt(all.hr.dots)} · ${((ratio('dots') - 1) * 100).toFixed(1)}%  ${ratio('dots') <= 1.1 ? 'ok' : 'OVER 10%'}`);
console.log(`walk list, three towers (${m.walkN} doors): base ${fmt(all.base.walk)} · HR ${fmt(all.hr.walk)} · ${((ratio('walk') - 1) * 100).toFixed(1)}%  ${ratio('walk') <= 1.1 ? 'ok' : 'OVER 10%'}`);
