// Another client's server, set up exactly as the control centre's New
// campaign block sets one (apps/platform/snippets.mjs envLines; here
// Kamloops), answers nothing of Imagine Surrey's: every read the preset
// dump makes (scripts/preset-dump.sh: 110 API reads and 47 pages signed in,
// 8 pages signed out) is searched for the words in neutral-words/*.txt —
// the same lists the build is scanned with (scripts/neutral-bundle.mjs).
// And no read answers 500.
//
// A list with a .pending marker beside it belongs to work not done yet: its
// finds are counted here and do not fail (the marker's own lines excuse the
// few words of another list that the same unfinished work still leaves).
// The work that finishes a part deletes its marker, and its list is live.
//
// Unique emails and campaign names (test:pg runs every file on one database).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';
import { getDb } from '../db/client.js';
import { forgetBrand } from '../lib/brand.js';
import { envLines } from '../../apps/platform/snippets.mjs';
import { loadWords, findIn } from '../../scripts/neutral-bundle.mjs';

const tag = Math.random().toString(36).slice(2, 8);

// The block a new campaign's server is given. Left out: NODE_ENV and the
// public address (they change cookies and hosts, which this in-process
// server has already read), and the keys, which are random.
const LEFT_OUT = new Set(['NODE_ENV', 'STARBASE_PUBLIC_URL', 'BASE_PLATFORM_PUBKEY', 'STARBASE_TWO_STEP_KEY', 'GOOGLE_TOKEN_KEY']);
const BLOCK = Object.fromEntries(envLines({
  name: 'kamloops', display: 'Kamloops Forward',
  values: { rules: 'bc-municipal', province: 'BC', tz: 'America/Vancouver', city: 'Kamloops', races: ['council'], bounds: '50.6,-120.5|50.8,-120.2' },
}).filter((l) => !LEFT_OUT.has(l.key)).map((l) => [l.key, String(l.value).replace(/^"|"$/g, '')]));
const saved = Object.fromEntries(Object.keys(BLOCK).map((k) => [k, process.env[k]]));
after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } forgetBrand(); });

// The dump's own lists, read from the script so the two never drift.
const DUMP = readFileSync(new URL('../../scripts/preset-dump.sh', import.meta.url), 'utf8');
const listOf = (name) => new RegExp(`^${name}="([^"]+)"`, 'm').exec(DUMP)[1].split(/\s+/).filter(Boolean);
const API = listOf('API');
const PAGES = listOf('PAGES');
const ANON = ['/', '/join', '/donate', '/site/', '/manifest.webmanifest', '/signup', '/login', '/api/auth/setup'];

let c;
let alone = true;
before(async () => {
  await freshDb();
  Object.assign(process.env, BLOCK);
  forgetBrand();
  c = new Client();
  const r = await c.signup({ workspaceName: `Kamloops Forward ${tag}`, email: `kamloops+${tag}@example.org`, jurisdiction: 'bc-municipal' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  // Pages nobody signs in to (the app's page, the public website) answer for
  // the database's first campaign. On a database shared with other test
  // files (test:pg) that is somebody else's, so those reads are left out.
  const first = (await (await getDb()).query('select id from workspaces order by created_at, id limit 1')).rows[0]?.id;
  alone = first === r.json.workspace.id;
});

const read = async (path, cookie) => {
  const res = await app.request(path, { headers: cookie ? { cookie } : {} });
  const type = res.headers.get('content-type') || '';
  const text = /^(text\/|application\/(json|javascript|xml|manifest\+json))|\+xml|charset=/i.test(type) ? await res.text() : '';
  return { status: res.status, text: `${text}\n${res.headers.get('location') || ''}` };
};

test('the block is the control centre’s: brand base, Kamloops, nobody on the scale', () => {
  assert.equal(BLOCK.STARBASE_BRAND, 'base');
  assert.equal(BLOCK.STARBASE_CITY, 'Kamloops');
  assert.equal(BLOCK.STARBASE_GEO_BOUNDS, '50.6,-120.5|50.8,-120.2');
  assert.equal(BLOCK.STARBASE_CANDIDATES, 'none');
  assert.ok(API.length >= 100 && PAGES.length >= 40, `${API.length} API reads, ${PAGES.length} pages`);
});

test('a neutral campaign’s server: no read answers 500, and none holds a word of Imagine Surrey’s', async (t) => {
  const words = loadWords();
  const reads = [
    ...API.map((a) => ({ name: `GET /api/${a}`, path: `/api/${a}`, cookie: c.cookie })),
    ...PAGES.map((p) => ({ name: `GET ${p}`, path: p, cookie: c.cookie, first: true })),
    ...ANON.map((p) => ({ name: `GET ${p} (signed out)`, path: p, cookie: null, first: p !== '/api/auth/setup' })),
  ].filter((r) => alone || !r.first);
  const broken = [];
  const finds = [];
  for (const r of reads) {
    const got = await read(r.path, r.cookie);
    if (got.status >= 500) broken.push(`${r.name} → ${got.status}`);
    finds.push(...findIn(got.text, r.name, words));
  }
  assert.deepEqual(broken, [], 'no read answers 500');
  const failing = finds.filter((f) => !f.pending && !f.owedTo);
  const waiting = finds.filter((f) => f.pending || f.owedTo);
  const pending = words.groups.filter((g) => g.pending).map((g) => g.group);
  t.diagnostic(`${reads.length} reads${alone ? '' : ' (a shared database: the pages that answer for its first campaign were left out)'}; `
    + `live lists: ${words.groups.filter((g) => !g.pending).map((g) => g.group).join(', ')}; `
    + `waiting on ${pending.join(', ') || 'nothing'}: ${waiting.length} finds`);
  for (const f of waiting) t.diagnostic(`  waiting (${f.owedTo || f.group}): “${f.word}” in ${f.at}`);
  assert.deepEqual(failing.map((f) => `${f.group}: “${f.word}” in ${f.at} …${f.near}…`), [], 'a word of one client’s is in what another client’s server answers');
  // What this campaign is told about itself is its own.
  const me = (await c.get('/api/auth/me')).json;
  assert.deepEqual([me.org.city, me.org.candidates, me.org.features], ['Kamloops', [], []]);
  assert.deepEqual(me.org.map, { centre: [50.7, -120.35], zoom: 12, bounds: [[50.6, -120.5], [50.8, -120.2]] });
});
