// Live GOTV's load test (GOTV.md, Done means): one server on a real
// Postgres, seeded with LOAD_PEOPLE (300,000) people, 200 turfs, 60 voting
// places and 100 scrutineer posts, under a voting day's traffic for
// LOAD_MINUTES (5):
//   600 live streams (500 canvassers over the turfs, 100 desk)
//   50 scrutineer marks a second from 100 sessions (vote.mark)
//   each canvasser's walk list and /brief once a minute; 20 knocks a second;
//   /voted/status every 60 s from every session; look-ups at about 2 a
//   second each from 20 scrutineers; /voted/changes and /voted/summary
//   a 5,000-row Voted import at minute 2; a full turf-index rebuild at
//   minute 3; a voter guide correction (closed today) at minute 4
// and prints a table against the pass lines. The server runs with
// scripts/load-gotv-probe.mjs, which measures its event loop, memory and pool.
//
//   DATABASE_URL=postgres://postgres@127.0.0.1:5506/gotvload \
//   PORT=5507 node scripts/load-gotv.mjs
//
// Made-up people only. The database is emptied of this script's campaign
// at the start (it signs up a fresh one each run).
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const URL_DB = process.env.DATABASE_URL;
if (!URL_DB) { console.error('DATABASE_URL, please (a real Postgres)'); process.exit(2); }
const PORT = Number(process.env.PORT) || 5507;
const BASE = `http://127.0.0.1:${PORT}`;
const PEOPLE = Number(process.env.LOAD_PEOPLE) || 300_000;
const MINUTES = Number(process.env.LOAD_MINUTES) || 5;
const RUN_MS = MINUTES * 60_000;
const at = (frac) => Math.round(RUN_MS * frac);
const PROBE = `${process.env.LOAD_SCRATCH || '/var/tmp'}/load-gotv-probe-${PORT}.json`;
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const sha = (t) => createHash('sha256').update(t).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };

// ── The server ──
const server = spawn(process.execPath, ['--import', './scripts/load-gotv-probe.mjs', 'server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), BASE_OPEN_SIGNUP: '1', LOAD_PROBE_FILE: PROBE, GEOCODE_ON_SAVE: 'off', PG_POOL_MAX: process.env.PG_POOL_MAX || '10' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
const stop = () => { try { server.kill('SIGTERM'); } catch { /* gone */ } };
process.on('exit', stop);
for (let i = 0; i < 120; i += 1) {
  try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* starting */ }
  await sleep(1000);
}

const call = async (cookie, method, path, body) => {
  const t0 = performance.now();
  const r = await fetch(`${BASE}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { status: r.status, ms: performance.now() - t0, json: (() => { try { return JSON.parse(text); } catch { return null; } })(), headers: r.headers };
};

// ── Seed ──
const tag = randomBytes(3).toString('hex');
const su = await fetch(`${BASE}/api/auth/signup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Load Manager Example', email: `load-mgr+${tag}@example.org`, password: 'load-test-2026', workspaceName: `Load ${tag}`, jurisdiction: 'bc-municipal' }),
});
const suJson = await su.json();
const MGR = su.headers.get('set-cookie').split(';')[0];
const ws = suJson.workspace.id;
const db = new pg.Pool({ connectionString: URL_DB, max: 4 });
const tSeed = Date.now();
const S = 49.0; const N = 49.2; const W = -122.9; const E = -122.7;
await db.query(
  `insert into persons (id, workspace_id, name, first_name, last_name, address, house_number, lat, lng, rating)
   select gen_random_uuid(), $1, f.n || ' ' || l.n, f.n, l.n,
          ((g % 180) * 100 + 10000)::text || ' ' || (g % 120 + 1)::text || ' Ave', ((g % 180) * 100 + 10000)::text,
          $2::float8 + random() * ($3::float8 - $2::float8), $4::float8 + random() * ($5::float8 - $4::float8), (array['1','2','3','4',null])[1 + g % 5]
     from generate_series(1, $6::int) g
     cross join lateral (select 'Given' || chr(65 + g % 26) || chr(65 + (g / 26) % 26) || chr(97 + (g / 676) % 26) as n) f
     cross join lateral (select 'Family' || chr(65 + (g / 17) % 26) || chr(97 + (g / 442) % 26) || chr(97 + (g / 11492) % 26) as n) l`,
  [ws, S, N, W, E, PEOPLE],
);
// 200 turfs: a 20 × 10 grid over the box.
const turfs = [];
for (let r = 0; r < 20; r += 1) for (let c = 0; c < 10; c += 1) {
  const s = S + (r * (N - S)) / 20; const n = S + ((r + 1) * (N - S)) / 20;
  const w = W + (c * (E - W)) / 10; const e = W + ((c + 1) * (E - W)) / 10;
  turfs.push({ id: randomUUID(), box: [s, w, n, e], polygon: [[n, w], [n, e], [s, e], [s, w]] });
}
for (const t of turfs) await db.query('insert into turfs (id, workspace_id, name, polygon) values ($1, $2, $3, $4)', [t.id, ws, `Turf ${t.id.slice(0, 4)}`, JSON.stringify(t.polygon)]);
const turfOf = (lat, lng) => turfs.findIndex((t) => lat >= t.box[0] && lat < t.box[2] && lng >= t.box[1] && lng < t.box[3]);
// People: users, memberships and sessions straight in (a load test's
// sign-ins; the password is never used).
const mkUsers = async (n, role, label) => {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const id = randomUUID(); const token = randomBytes(32).toString('hex');
    out.push({ id, cookie: `mv2_session=${token}`, token });
    await db.query('insert into users (id, email, name, password_hash) values ($1, $2, $3, $4)', [id, `load-${label}${i}+${tag}@example.org`, `${label} ${i} Example`, 'x']);
    await db.query('insert into memberships (user_id, workspace_id, role) values ($1, $2, $3)', [id, ws, role]);
    await db.query("insert into sessions (token_hash, user_id, workspace_id, expires_at) values ($1, $2, $3, now() + interval '1 day')", [sha(token), id, ws]);
  }
  return out;
};
const canvassers = await mkUsers(500, 'volunteer', 'canvasser');
const desk = await mkUsers(100, 'staff', 'desk');
const scrutineers = await mkUsers(100, 'volunteer', 'scrutineer');
const importer = desk[0];
canvassers.forEach((u, i) => { u.turf = i % 200; });
for (const u of canvassers) await db.query('insert into turf_members (workspace_id, turf_id, user_id) values ($1, $2, $3)', [ws, turfs[u.turf].id, u.id]);
// The voter guide: today a general day; 60 places voting today; published.
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver' }).format(new Date());
await db.query("insert into vote_days (id, workspace_id, day, kind, opens, closes) values ($1, $2, $3, 'general', '00:01', '23:59')", [randomUUID(), ws, today]);
const places = [];
for (let i = 0; i < 60; i += 1) {
  const id = randomUUID();
  places.push(id);
  await db.query("insert into places (id, workspace_id, name, address, lat, lng, source, kind) values ($1, $2, $3, $4, $5, $6, 'typed', 'voting')", [id, ws, `Voting Place ${i} Example`, `${i + 1} Example Ave`, S + 0.1, W + 0.1 + i * 0.001]);
  await db.query('insert into vote_place_info (place_id, workspace_id, days, position) values ($1, $2, $3, $4)', [id, ws, JSON.stringify([{ day: today }]), i]);
}
await db.query("insert into vote_guide (workspace_id, status, rev) values ($1, 'published', 1) on conflict (workspace_id) do update set status = 'published'", [ws]);
scrutineers.forEach((u, i) => { u.place = places[i % 60]; });
for (const u of scrutineers) await db.query("insert into gotv_posts (id, workspace_id, user_id, role, place_id) values ($1, $2, $3, 'scrutineer', $4)", [randomUUID(), ws, u.id, u.place]);
await db.query('analyze persons');
// GOTV On, names live (the CEO's yes recorded), as a manager.
for (const body of [{ ceo_answer: { allows_live: true, note: 'Load test' } }, { send: 'live' }, { mode: 'on', election_day: today }]) {
  const r = await call(MGR, 'POST', '/api/actions/vote.settings', body);
  if (r.status !== 200) throw new Error(`vote.settings ${JSON.stringify(r.json)}`);
}
const people = (await db.query('select id, lat, lng from persons where workspace_id = $1 and lat is not null', [ws])).rows;
// What a scrutineer types: a given name and a family name, as written.
const lookups = (await db.query('select first_name, last_name from persons where workspace_id = $1 order by random() limit 2000', [ws])).rows
  .map((r, i) => (i % 2 ? `${r.last_name}, ${r.first_name}` : `${r.first_name} ${r.last_name}`));
const seedMs = Date.now() - tSeed;
console.log(`seeded ${PEOPLE.toLocaleString('en-CA')} people, 200 turfs, 60 places, 100 posts in ${(seedMs / 1000).toFixed(0)} s`);
// The first request after GOTV turns on waits for the turf index: once, here.
await call(canvassers[0].cookie, 'GET', '/api/voted/status');
await call(desk[0].cookie, 'GET', '/api/voted/summary');
server.kill('SIGUSR2'); // the probe starts counting now

// ── The streams ──
const subs = [];
const openStream = (u, kind) => {
  const sub = { u, kind, got: new Map(), guideAt: null, ok: false, closed: false };
  subs.push(sub);
  (async () => {
    try {
      const r = await fetch(`${BASE}/api/voted/live`, { headers: { cookie: u.cookie } });
      sub.ok = r.status === 200;
      if (!sub.ok) return;
      const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          if (block.startsWith(':')) continue;
          const ev = Object.fromEntries(block.split('\n').map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]));
          const now = performance.now();
          if (ev.event === 'voted') for (const c of JSON.parse(ev.data)) if (!c.x && c.v && !sub.got.has(c.p)) sub.got.set(c.p, now);
          if (ev.event === 'guide' && !sub.guideAt) {
            sub.guideAt = now;
            const g = await call(u.cookie, 'GET', `/api/guide?rev=${JSON.parse(ev.data).rev}`);
            guideReads.push(g.ms);
          }
        }
      }
    } catch { /* closed at the end */ }
    sub.closed = true;
  })();
};
const guideReads = [];
for (const u of canvassers) openStream(u, 'canvasser');
for (const u of desk) openStream(u, 'desk');
await sleep(3000);

// ── The day's traffic ──
const lat = { mark: [], changes: [], summary: [], walk: [], brief: [], status: [], find: [], knock: [] };
const counts = { mark503: 0, markErr: 0, find429: 0, otherErr: 0 };
const committed = new Map(); // person → when vote.mark answered
const t0 = Date.now();
const until = t0 + RUN_MS;
const every = (ms, fn) => { const h = setInterval(() => { if (Date.now() < until) fn().catch(() => { counts.otherErr += 1; }); }, ms); return h; };
const shuffled = people.map((p) => p.id).sort(() => Math.random() - 0.5);
let next = 0;
const timers = [];
// 50 marks a second, round the 100 scrutineers, each a fresh person.
timers.push(every(20, async () => {
  const u = scrutineers[next % 100]; const pid = shuffled[next++];
  const r = await call(u.cookie, 'POST', '/api/actions/vote.mark', { person_id: pid, source: 'scrutineer', place_id: u.place, client_id: randomUUID() });
  lat.mark.push(r.ms);
  if (r.status === 503) counts.mark503 += 1; else if (r.status !== 200) counts.markErr += 1; else committed.set(pid, performance.now());
}));
// 20 knocks a second, by canvassers on their own turfs' people.
const byTurf = new Map(); const personTurf = new Map();
for (const p of people) { const t = turfOf(p.lat, p.lng); personTurf.set(p.id, t); if (!byTurf.has(t)) byTurf.set(t, []); byTurf.get(t).push(p.id); }
let k = 0;
timers.push(every(50, async () => {
  const u = canvassers[k++ % 500]; const list = byTurf.get(u.turf) || [];
  const r = await call(u.cookie, 'POST', '/api/actions/contact.log', { person_id: list[k % list.length], channel: 'door', outcome: 'contacted', client_id: randomUUID() });
  lat.knock.push(r.ms);
}));
// Each canvasser's walk list and /brief once a minute (spread out).
let w = 0;
timers.push(every(120, async () => {
  const u = canvassers[w++ % 500];
  const a = await call(u.cookie, 'GET', `/api/turfs/${turfs[u.turf].id}/walk`); lat.walk.push(a.ms);
  const b = await call(u.cookie, 'GET', '/api/brief'); lat.brief.push(b.ms);
}));
// /voted/status every 60 s from every session (~700 a minute).
const everyone = [...canvassers, ...desk, ...scrutineers];
let s2 = 0;
timers.push(every(86, async () => { const r = await call(everyone[s2++ % everyone.length].cookie, 'GET', '/api/voted/status'); lat.status.push(r.ms); }));
// Look-ups: 20 scrutineers, about 2 a second each.
let f = 0;
timers.push(every(26, async () => {
  const u = scrutineers[f++ % 20];
  const pick = lookups[(f * 7919) % lookups.length];
  const r = await call(u.cookie, 'GET', `/api/gotv/find?q=${encodeURIComponent(pick)}`);
  lat.find.push(r.ms); if (r.status === 429) counts.find429 += 1;
}));
// The catch-up read and the desk's summary.
let c = 0;
timers.push(every(200, async () => { const u = canvassers[c++ % 500]; const r = await call(u.cookie, 'GET', `/api/voted/changes?since=${Math.max(1, (await db.query('select max(feed_id) as f from voted_marks')).rows[0].f - 200)}`); lat.changes.push(r.ms); }));
timers.push(every(1000, async () => { const r = await call(desk[c % 100].cookie, 'GET', '/api/voted/summary'); lat.summary.push(r.ms); }));

const events = [];
// Minute 2: a 5,000-row Voted import (chunks of 250 while GOTV is on).
setTimeout(async () => {
  const rows = Array.from({ length: 5000 }, (_, i) => ({ name: `Import ${i} Example`, phone: `604-555-${String(1000 + (i % 9000)).padStart(4, '0')}`, voted: '1' }));
  const ti = Date.now();
  for (let i = 0; i < rows.length; i += 250) {
    const r = await call(importer.cookie, 'POST', '/api/data/import', { rows: rows.slice(i, i + 250) });
    if (r.status !== 200) { events.push(`import refused: ${r.status} ${JSON.stringify(r.json).slice(0, 120)}`); break; }
    await sleep(200);
  }
  events.push(`import of 5,000 rows: ${((Date.now() - ti) / 1000).toFixed(1)} s`);
}, at(0.4));
// Minute 3: a full turf-index rebuild (a settings commit rebuilds it).
setTimeout(async () => {
  const r = await call(MGR, 'POST', '/api/actions/vote.settings', { mode: 'on' });
  events.push(`turf-index rebuild asked: ${r.status}`);
}, at(0.6));
// Minute 4: a guide correction.
let guideSentAt = null;
setTimeout(async () => {
  const p = places[3];
  guideSentAt = performance.now();
  const r = await call(MGR, 'POST', '/api/actions/site.guide.place.save', { id: p, name: 'Voting Place 3 Example', address: '4 Example Ave', days: [{ day: today }], closed: true });
  events.push(`guide correction: ${r.status}${r.status !== 200 ? ` ${JSON.stringify(r.json).slice(0, 120)}` : ''}`);
}, at(0.8));

await sleep(RUN_MS + 4000);
for (const t of timers) clearInterval(t);
await sleep(3000);

// ── The numbers ──
const probe = JSON.parse(readFileSync(PROBE, 'utf8'));
const delays = []; let lost = 0; let expected = 0;
for (const sub of subs.filter((x) => x.ok)) {
  for (const [pid, when] of committed) {
    const mine = sub.kind === 'desk' || personTurf.get(pid) === sub.u.turf;
    if (!mine) continue;
    expected += 1;
    const got = sub.got.get(pid);
    if (got === undefined) lost += 1; else delays.push(Math.max(0, got - when));
  }
}
const guideLate = subs.filter((x) => x.ok && (!x.guideAt || x.guideAt - guideSentAt > 5000)).length;
const row = (name, value, pass) => console.log(`${name.padEnd(46)} ${String(value).padEnd(16)} ${pass === undefined ? '' : pass ? 'pass' : 'FAIL'}`);
console.log(`\nLoad: ${PEOPLE.toLocaleString('en-CA')} people, ${MINUTES} min, ${subs.filter((x) => x.ok).length} streams, ${committed.size.toLocaleString('en-CA')} marks\n`);
row('mark → stream p95 (ms)', Math.round(pct(delays, 95) ?? -1), (pct(delays, 95) ?? 1e9) <= 2000);
const maxDelay = delays.reduce((m, x) => Math.max(m, x), 0);
row('mark → stream max (ms)', Math.round(maxDelay), maxDelay <= 5000);
row('lost changes (of expected)', `${lost} of ${expected}`, lost === 0);
row('vote.mark p95 (ms)', Math.round(pct(lat.mark, 95)), pct(lat.mark, 95) <= 250);
row('vote.mark 503s', counts.mark503, counts.mark503 === 0);
row('/voted/changes p95 (ms)', Math.round(pct(lat.changes, 95)), pct(lat.changes, 95) <= 100);
row('/voted/summary p95 (ms)', Math.round(pct(lat.summary, 95)), pct(lat.summary, 95) <= 300);
row('walk list p95 (ms)', Math.round(pct(lat.walk, 95)), pct(lat.walk, 95) <= 800);
row('/brief p95 (ms)', Math.round(pct(lat.brief, 95)), pct(lat.brief, 95) <= 800);
row('/voted/status p95 (ms)', Math.round(pct(lat.status, 95)));
row('look-up p95 (ms) / 429s', `${Math.round(pct(lat.find, 95))} / ${counts.find429}`);
row('knock p95 (ms)', Math.round(pct(lat.knock, 95)));
row('event-loop delay p99 (ms)', probe.p99.toFixed(1), probe.p99 <= 100);
row('event-loop delay max (ms)', probe.max.toFixed(1));
row('server RSS growth (MB)', ((probe.rssMax - probe.rss0) / 1e6).toFixed(0), probe.rssMax - probe.rss0 <= 150e6);
row(`pool most in use (PG_POOL_MAX ${process.env.PG_POOL_MAX || 10})`, probe.poolMax, probe.poolMax <= Number(process.env.PG_POOL_MAX || 10));
row('longest stretch with a pool wait (ms)', probe.waitRunMax, probe.waitRunMax <= 1000);
row('guide event to every stream ≤ 5 s (late)', guideLate, guideLate === 0);
row('guide refetch p95 (ms)', Math.round(pct(guideReads, 95) ?? -1), (pct(guideReads, 95) ?? 1e9) <= 300);
row('other errors', counts.otherErr + counts.markErr);
for (const e of events) console.log(`  ${e}`);
const errs = serverLog.split('\n').filter((l) => /error|Error/.test(l));
if (errs.length) console.log(`server errors (${errs.length}), first: ${errs.slice(0, 3).join(' | ').slice(0, 400)}`);
stop();
await db.end();
process.exit(0);
