// The person search on a city's voter file: 300,000 made-up people
// (scripts/search-fixture.mjs, skewed on purpose: one surname on 8%, a second
// on 6% and the middle name of 3% more). Every query a search runs reads an
// index of ours — with table reads switched off, and with the planner left
// to itself — never persons end to end; the crowded surname takes the
// capped plan (an A–Z range of persons_ws_az_idx); and each search answers
// within a generous budget for the in-memory database.
// SEARCH_PEOPLE sets a smaller file for a quick run.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { setSearchTrace } from '../ext/search/index.js';
import { fillPeople, BIG, BIG2 } from '../../scripts/search-fixture.mjs';

const PEOPLE = Number(process.env.SEARCH_PEOPLE) || 300_000;
// Generous: an embedded Postgres compiled to WebAssembly, several times
// slower than a hosted one (scripts/bench-search.mjs holds the real budget).
const SEARCH_MS = Number(process.env.SEARCH_MS) || 3_000;
let db, mgr;

before(async () => {
  db = await freshDb();
  mgr = new Client();
  const ws = (await mgr.signup({ workspaceName: 'Search at scale', email: 'search-scale@example.org', jurisdiction: 'bc-municipal' })).json.workspace.id;
  await fillPeople(db, ws, PEOPLE);
  await db.query('analyze persons');
});

const run = async (q) => {
  const seen = [];
  setSearchTrace((text, params, meta) => seen.push({ text, params, walk: meta?.walk }));
  const t0 = Date.now();
  let r;
  try { r = await mgr.get(`/api/search/people?q=${encodeURIComponent(q)}&limit=25`); } finally { setSearchTrace(null); }
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return { json: r.json, ms: Date.now() - t0, seen };
};
const plan = async ({ text, params, walk }, seqscan) => db.transaction(async (tx) => {
  if (!seqscan) await tx.query('set local enable_seqscan = off');
  // A crowded way's walk runs with sorting off, as the search runs it.
  if (walk) { await tx.query('set local enable_sort = off'); await tx.query('set local enable_bitmapscan = off'); }
  return (await tx.query(`explain ${text}`, params)).rows.map((r) => Object.values(r)[0]).join('\n');
});

test(`${PEOPLE.toLocaleString('en-CA')} people: every search reads our indexes, the crowded surname a range of the A–Z one, each within ${SEARCH_MS} ms`, async () => {
  const terms = [
    [BIG.toLowerCase(), true], [BIG2.toLowerCase(), true], ['si', null], ['145', null], ['14', null],
    ['kevin smith', false], ['smith kevin', false], ['jose', false], ['zzq', false], ['604 555 01', null], [`kevin ${BIG.toLowerCase()}`, null],
  ];
  // The crowded surnames pass the cap (5,000) only on a full-size file.
  for (const [q, cappedAtSize] of terms) {
    const capped = PEOPLE >= 100_000 ? cappedAtSize : null;
    const { json, ms, seen } = await run(q);
    assert.ok(ms < SEARCH_MS, `${q}: ${ms} ms`);
    if (capped !== null) assert.equal(json.many, capped, `${q}: ${JSON.stringify({ total: json.total, many: json.many })}`);
    if (capped) assert.equal(json.persons.length, 25);
    for (const s of seen) {
      for (const seqscan of [false, true]) {
        const p = await plan(s, seqscan);
        assert.doesNotMatch(p, /Seq Scan on persons/, `${q} (seqscan ${seqscan ? 'on' : 'off'})\n${p}`);
      }
    }
    if (capped) assert.match((await plan(seen.at(-1), true)), /persons_ws_az_idx/, q);
  }
  // Paging the crowded surname: page 5 as quick as page 1.
  let page = (await run(BIG.toLowerCase())).json;
  for (let i = 0; i < 4; i += 1) {
    const t0 = Date.now();
    const r = await mgr.get(`/api/search/people?q=${BIG.toLowerCase()}&limit=25&after=${page.persons.at(-1).id}`);
    assert.ok(Date.now() - t0 < SEARCH_MS);
    page = r.json;
    assert.equal(page.persons.length, 25);
  }
});
