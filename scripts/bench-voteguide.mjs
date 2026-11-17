// The voter guide under load (VG): a server of its own on 5512 (a child
// process, scripts/bench-voteguide-server.mjs, that counts its database
// queries) over the Postgres wire protocol — DATABASE_URL when set, else
// PGlite's socket server on 5514, as npm run test:pg does — a published
// guide with 60 places, 5 days and 2 contests, and the fake address service
// on 5513. Then, each for SECONDS (60 by default):
//   1. 400 clients (from four threads, so the clients' own event loop is
//      not what is measured) on the guide page and the home page (10 % with
//      a valid ?area=): no errors, p95 ≤ 150 ms, and each address's page drawn from
//      the database at most once per SITE_CACHE_SECONDS (its data read
//      once per draw);
//   2. 500 phones polling GET /api/guide?rev=&tag= every 5 s (60× the real
//      rate): p95 ≤ 50 ms, ≤ 13 rev reads a minute; a place edited mid-run
//      reaches the next page request (≤ 1 s) and every phone's next poll;
//   3. 50 finds a second from 200 made-up addresses: 429 past 30 a minute
//      from one address, "Busy …" past 300 a minute for the campaign, the
//      address service sees at most 300 lookups a minute, and the page's
//      p95 stays under 200 ms meanwhile.
// Runs by hand (not in CI); paste the numbers into the pull request.
//
//   node scripts/bench-voteguide.mjs            SECONDS=10 for a quick look
import { fork } from 'node:child_process';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { createServer } from 'node:http';
import { Worker } from 'node:worker_threads';

const PORT = 5512; const GEO = 5513; const WIRE = 5514;
const SECONDS = Number(process.env.SECONDS) || 60;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const p95 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? Math.round(s[Math.floor(s.length * 0.95)]) : 0; };
const out = [];
// One thread of page clients: each asks for its page again as soon as the
// last answer is read, until `end`; posts back every time and the errors.
const CLIENTS = `
const { workerData, parentPort } = require('node:worker_threads');
const http = require('node:http');
const { port, end, urls } = workerData;
const agent = new http.Agent({ keepAlive: true, maxSockets: urls.length });
const times = []; let errors = 0;
const one = (path) => new Promise((resolve) => {
  const t = performance.now();
  const req = http.get({ host: '127.0.0.1', port, path, agent }, (res) => {
    if (res.statusCode !== 200) errors += 1;
    res.on('data', () => {});
    res.on('end', () => { times.push(performance.now() - t); resolve(); });
  });
  req.on('error', () => { errors += 1; times.push(performance.now() - t); resolve(); });
});
Promise.all(urls.map(async (u) => { while (Date.now() < end) await one(u); }))
  .then(() => { agent.destroy(); parentPort.postMessage({ times, errors }); });
`;
const say = (name, ok, extra) => { out.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  — ${extra}`); };

let lookups = [];
const geo = createServer((req, res) => {
  lookups.push(Date.now());
  res.setHeader('content-type', 'application/json');
  const q = new URL(req.url, 'http://x').searchParams.get('addressString') || '';
  const n = Number(/(\d+)/.exec(q)?.[1] || 1) % 1000;
  res.end(JSON.stringify({ features: [{ geometry: { coordinates: [-122.8, 49.1 + n / 10000] }, properties: { score: 99, matchPrecision: 'CIVIC_NUMBER', fullAddress: q } }] }));
});
await new Promise((r) => geo.listen(GEO, '127.0.0.1', r));
// The database, over the wire.
let pglite = null; let wire = null;
if (!process.env.DATABASE_URL) {
  pglite = await PGlite.create();
  wire = new PGLiteSocketServer({ db: pglite, port: WIRE, host: '127.0.0.1' });
  await wire.start();
}
const DATABASE_URL = process.env.DATABASE_URL || `postgres://postgres:postgres@127.0.0.1:${WIRE}/postgres`;
const server = fork('scripts/bench-voteguide-server.mjs', [], {
  env: {
    ...process.env, PORT: String(PORT), STARBASE_OPEN_SIGNUP: '1', DATABASE_URL, ...(pglite ? { PG_POOL_MAX: '1' } : {}), STARBASE_JOBS: 'off',
    GEOCODER: 'bc', BC_GEOCODER_URL: `http://127.0.0.1:${GEO}`, STARBASE_GEO_BOUNDS: '49.002,-122.92|49.222,-122.67', SITE_CACHE_SECONDS: '60',
  },
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
const counted = () => new Promise((resolve) => {
  const on = (m) => { if (m?.counts) { server.off('message', on); resolve(m.counts); } };
  server.on('message', on);
  server.send('counts');
});
const resetCounts = () => server.send('reset');
try {
  for (let i = 0; i < 120; i += 1) { try { if ((await fetch(`${ORIGIN}/api/health`)).ok) break; } catch { /* not yet */ } await sleep(250); }
  let cookie = '';
  const call = async (path, body) => {
    const r = await fetch(`${ORIGIN}${path}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc && !cookie) cookie = sc.split(';')[0];
    return r.json().catch(() => null);
  };
  const act = (n, i) => call(`/api/actions/${n}`, i);
  await call('/api/auth/signup', { name: 'Ana Example', email: 'ana@example.org', password: 'voterguide-2027', workspaceName: 'Bench Campaign', jurisdiction: 'bc-municipal' });
  await act('site.settings.save', { org: { name: 'Bench Campaign', agentName: 'Pat Example', agentContact: 'agent@example.org' } });
  const today = new Date(Date.now() - 7 * 3600e3).toISOString().slice(0, 10);
  const plus = (n) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);
  const days = [1, 2, 3, 4, 6].map((n, i) => ({ day: plus(n), kind: i === 4 ? 'general' : 'advance', opens: '08:00', closes: '20:00' }));
  await act('site.guide.days', { days });
  const AREAS = ['Newton', 'Fleetwood', 'Cloverdale', 'Guildford'];
  let firstId = null;
  for (let i = 0; i < 60; i += 1) {
    const r = await act('site.guide.place.save', { name: `Example Place ${i + 1}`, address: `${100 + i} Example Ave`, lat: 49.1 + i / 1000, lng: -122.8, area: AREAS[i % 4], days: days.map((d) => ({ day: d.day })) });
    firstId = firstId || r?.place?.id;
  }
  await act('site.guide.save', { vote_anywhere: true, official_url: 'https://elections.example.org/vote', official_label: 'Example City elections' });
  await act('site.guide.ballot', { contests: [{ office: 'Mayor', vote_for: 1, names: [{ name: 'Ann Example' }, { name: 'Bo Sample' }] }, { office: 'Councillor', vote_for: 8, names: Array.from({ length: 12 }, (_, i) => ({ name: `Councillor Example ${i + 1}` })) }] });
  for (const section of ['days', 'places', 'ballot']) await act('site.guide.check', { section, checked: true });
  const pg = await act('site.guide.page', {});
  await act('site.page.publish', { id: pg.page.id });
  const pub = await act('site.guide.publish', { gotv_days: false });
  if (!pub || pub.error) throw new Error(`publish: ${JSON.stringify(pub)}`);

  // ── 1. Pages ──
  for (const u of ['/site/voter-guide', '/site/voter-guide', '/site/', '/site/']) {
    const t = performance.now(); const r = await fetch(`${ORIGIN}${u}`); const body = await r.text();
    console.log(`      one request ${u}: ${Math.round(performance.now() - t)} ms, ${Math.round(Buffer.byteLength(body) / 1024)} kB`);
  }
  const until = (s) => Date.now() + s * 1000;
  const pageTimes = []; let pageErrors = 0;
  const page = async (u) => { const t = performance.now(); try { const r = await fetch(u); await r.text(); if (!r.ok) pageErrors += 1; } catch { pageErrors += 1; } pageTimes.push(performance.now() - t); };
  resetCounts();
  const end1 = until(SECONDS);
  // The 400 clients from four threads of their own (a hundred each, plain
  // keep-alive http): one event loop reading 400 pages of 40–90 kB is
  // itself the slowest thing in the room, and its own wait is not the
  // server's.
  const urls = Array.from({ length: 400 }, (_, i) => (i % 10 === 0 ? `/site/voter-guide?area=${AREAS[i % 4]}` : i % 2 ? '/site/voter-guide' : '/site/'));
  const results = await Promise.all([0, 1, 2, 3].map((w) => new Promise((resolve, reject) => {
    const worker = new Worker(CLIENTS, { eval: true, workerData: { port: PORT, end: end1, urls: urls.filter((_, i) => i % 4 === w) } });
    worker.once('message', resolve);
    worker.once('error', reject);
  })));
  for (const r of results) { pageTimes.push(...r.times); pageErrors += r.errors; }
  say('400 clients on the pages: no errors, p95 ≤ 150 ms', pageErrors === 0 && p95(pageTimes) <= 150, `${pageTimes.length} requests, ${pageErrors} errors, p95 ${p95(pageTimes)} ms`);
  const c1 = await counted();
  for (const [k, n] of c1.kinds || []) console.log(`      ${n}× ${k}`);
  // Six addresses (the guide page, the home page, the guide page per area).
  const draws = 6 * (Math.ceil(SECONDS / 60) + 1);
  say('each address drawn from the database at most once per SITE_CACHE_SECONDS', c1.page <= draws, `${c1.page} draws (at most ${draws}) for ${pageTimes.length} requests; guide rows read ${c1.rows} times; ${c1.total} queries in all`);

  // ── 2. Phones polling, a place edited mid-run ──
  const pollTimes = []; let pollErrors = 0;
  const start = await call('/api/guide');
  resetCounts();
  const seen = new Map();
  const end2 = until(SECONDS);
  let editedAt = null;
  const phones = Array.from({ length: 500 }, async (_, i) => {
    let rev = start.rev; let tag = start.tag;
    await sleep((i * 10) % 5000);
    while (Date.now() < end2) {
      const t = performance.now();
      try {
        const r = await fetch(`${ORIGIN}/api/guide?rev=${rev}&tag=${tag}`, { headers: { cookie } });
        const j = await r.json(); if (!r.ok) pollErrors += 1;
        if (!j.same) { tag = j.tag; if (j.rev !== rev) { rev = j.rev; if (editedAt) seen.set(i, Date.now() - editedAt); } }
      } catch { pollErrors += 1; }
      pollTimes.push(performance.now() - t);
      await sleep(5000);
    }
  });
  const edit = (async () => {
    await sleep(SECONDS * 500);
    editedAt = Date.now();
    await act('site.guide.place.save', { id: firstId, name: 'Example Place 1', address: '100 Example Ave', note: 'Use the side door', days: days.map((d) => ({ day: d.day })) });
    const t = Date.now();
    const html = await (await fetch(`${ORIGIN}/site/voter-guide`)).text();
    say('the edit is on the next page request (≤ 1 s)', /Use the side door/.test(html) && Date.now() - t <= 1000, `${Date.now() - t} ms`);
  })();
  await Promise.all([...phones, edit]);
  say('500 phones polling every 5 s: p95 ≤ 50 ms', pollErrors === 0 && p95(pollTimes) <= 50, `${pollTimes.length} polls, ${pollErrors} errors, p95 ${p95(pollTimes)} ms`);
  const c2 = await counted();
  const perMinute = Math.round((c2.rev / SECONDS) * 60);
  say('the phones cost ≤ 13 rev reads a minute', perMinute <= 13, `${c2.rev} rev reads in ${SECONDS} s (${perMinute} a minute) for ${pollTimes.length} polls; guide rows read ${c2.rows} times`);
  say('every phone saw the new rev on its next poll', seen.size === 500 && Math.max(...seen.values()) <= 5500, `${seen.size} phones, slowest ${Math.max(0, ...seen.values())} ms`);

  // ── 3. One address asking 35 times: 429 past 30 a minute ──
  const mine = [];
  for (let i = 0; i < 35; i += 1) {
    const r = await fetch(`${ORIGIN}/site/api/guide/find`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.9.9.9' }, body: JSON.stringify({ address: `${i + 1} Example Ave` }) });
    const j = await r.json().catch(() => ({}));
    mine.push(r.status === 429 && !/^Busy/.test(j.error || '') ? 'limited' : r.ok ? 'found' : String(r.status));
  }
  say('one address: 429 past 30 a minute', mine.slice(0, 30).every((x) => x === 'found') && mine.slice(30).every((x) => x === 'limited'), mine.join(' '));
  // ── 3. Finds from 200 addresses, 50 a second ──
  lookups = [];
  let perAddress = 0; let busy = 0; let found = 0; let other = 0;
  const findPages = [];
  const end3 = until(SECONDS);
  let n = 0;
  const pagesDuring = (async () => { while (Date.now() < end3) { const t = performance.now(); await fetch(`${ORIGIN}/site/voter-guide`).then((r) => r.text()); findPages.push(performance.now() - t); await sleep(100); } })();
  while (Date.now() < end3) {
    const from = `10.0.${Math.floor((n % 200) / 250)}.${n % 200}`;
    n += 1;
    fetch(`${ORIGIN}/site/api/guide/find`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': from }, body: JSON.stringify({ address: `${n % 900} Example Ave` }) })
      .then(async (r) => { const j = await r.json().catch(() => ({})); if (r.ok) found += 1; else if (r.status === 429 && /^Busy/.test(j.error || '')) busy += 1; else if (r.status === 429) perAddress += 1; else other += 1; })
      .catch(() => { other += 1; });
    await sleep(20);
  }
  await pagesDuring;
  await sleep(1000);
  const minutes = SECONDS / 60;
  say('finds: the campaign cap holds (≤ 300 lookups a minute reach the address service)', lookups.length <= Math.ceil(300 * Math.max(1, minutes)), `${n} asked, ${found} found, ${busy} busy, ${perAddress} per-address 429, ${other} other; ${lookups.length} lookups`);
  say('the page’s p95 stays under 200 ms during the finds', p95(findPages) < 200, `p95 ${p95(findPages)} ms`);
} finally {
  server.kill('SIGTERM');
  await new Promise((r) => { server.once('exit', r); setTimeout(r, 5000); });
  geo.close();
  if (wire) { await wire.stop(); await pglite.close(); }
}
console.log(`\n${out.filter(Boolean).length}/${out.length} passed`);
process.exit(out.every(Boolean) ? 0 : 1);
