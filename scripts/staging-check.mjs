// The daily staging check: walks the deployed demo the way a visitor does
// and says whether anything on it is real.
//
//   node scripts/staging-check.mjs https://staging.base.win
//
// It enters by the demo's own door (/api/auth/demo), reads what the demo
// walk test reads (server/test/staging-paths.js), and fails when:
//   - a read answers a status other than the one recorded (a page of the
//     public website is only reported: visitors can publish pages);
//   - an answer holds a listed real name (server/test/real-names.js), a
//     phone outside 604-555-01xx, an email outside example.org,
//     example.com and base.win, or a link to a host other than staging
//     itself, base.win, example.org, example.com, schema.org, the free
//     map's tiles or the map's own tile host (/api/map/config);
//   - the sample is not the current one, or what NEUTRAL took away is back;
//   - there are fewer than 320 people, 4 turfs or 5 shifts (more is
//     reported, not failed: visitors add things);
//   - a live email or texting key is set (a system sender, or texting or
//     calls on), unless STAGING_TEST_KEYS=1 says test keys are wanted.
// It changes nothing on staging: every request is a read, apart from the
// demo's own sign-in.
//
// .github/workflows/staging-check.yml runs it daily and by hand, and opens
// or updates one issue when it fails. It does not hold up a release.
import { API_PATHS, PAGES, ANON, GONE } from '../server/test/staging-paths.js';
import { wrongIn } from '../server/test/real-names.js';
import { STARTING_FIELDS } from '../server/test/sample-prints.js';
import { OPPONENTS } from '../server/lib/samplecast.js';

const base = String(process.argv[2] || '').replace(/\/+$/, '');
if (!/^https?:\/\/[^/]+$/.test(base)) {
  console.error('usage: node scripts/staging-check.mjs https://staging.base.win');
  process.exit(2);
}
const testKeys = process.env.STAGING_TEST_KEYS === '1';
const failures = [];
const notes = [];
const fail = (line) => { failures.push(line); console.log(`FAIL  ${line}`); };
const note = (line) => { notes.push(line); console.log(`note  ${line}`); };

// What to do when the sample was not made again (STAGING.md 4d).
const RESET_WORD = 'If the staging server’s log says “this database’s first campaign is not the demo account’s” or “could not be made in 3 tries”: '
  + 'make up one new word (for example fresh-2026-11) and set it as STARBASE_SAMPLE_RESET in Render → base-win-staging → Environment. '
  + 'Nobody issues the word and it is not a secret.';

// One read; a read that breaks off is a status of 0, with the reason.
const request = async (path, cookie, extra = {}) => {
  try {
    const res = await fetch(`${base}${path}`, {
      redirect: 'manual', headers: { ...(cookie ? { cookie } : {}), ...extra }, signal: AbortSignal.timeout(30_000),
    });
    const type = res.headers.get('content-type') || '';
    const body = Buffer.from(await res.arrayBuffer());
    const text = /^(text\/|application\/(json|javascript|xml|manifest\+json))|\+xml|charset=/i.test(type) ? body.toString('utf8') : '';
    return { status: res.status, type, text, headers: res.headers };
  } catch (e) {
    return { status: 0, type: '', text: '', headers: new Headers(), error: e.cause?.message || e.message };
  }
};
const json = (r) => { try { return JSON.parse(r.text); } catch { return null; } };

// ── In by the demo's door ──
const door = await request('/api/auth/demo');
const cookie = (door.headers.get('set-cookie') || '').split(';')[0];
if (door.status !== 302 || !cookie) {
  fail(`the demo’s door answered ${door.status}: ${(json(door)?.error || door.text).slice(0, 200)}`);
  if (door.status === 503) console.log(`\n${RESET_WORD}`);
  console.log(`\n${failures.length} failed.`);
  process.exit(1);
}

const health = json(await request('/api/health', cookie)) || {};
console.log(`staging: commit ${health.commit || 'unknown'}, build ${health.build || 'unknown'}, env ${health.env}`);
if (health.env !== 'staging') fail(`/api/health says env ${health.env}, not staging`);

// The map's own tile host may be named in answers.
const tiles = json(await request('/api/map/config', cookie))?.tiles?.url || '';
const own = [new URL(base).host];
try { own.push(new URL(tiles.replace(/\{[a-z]\}/g, 'a')).host); } catch { /* no tiles */ }

// ── The walk ──
const reads = [
  ...API_PATHS.map(([path, status]) => ({ name: `GET ${path}`, path, status, signedIn: true })),
  ...PAGES.map(([path, status]) => ({ name: `GET ${path}`, path, status, signedIn: true })),
  ...ANON.map(([path, status]) => ({ name: `GET ${path} (signed out)`, path, status, signedIn: false })),
];
for (const r of reads) {
  const got = await request(r.path, r.signedIn ? cookie : '');
  if (got.status !== r.status) {
    if (/^\/site\//.test(r.path) && got.status < 500) note(`${r.name}: ${got.status}, not ${r.status} (a visitor may have changed the website)`);
    else fail(`${r.name}: ${got.status}${got.error ? ` (${got.error})` : ''}, not ${r.status}`);
  }
  for (const line of wrongIn(r.name, got.text, { json: /json/.test(got.type), own })) fail(line);
}

// ── The sample is the current one, and NEUTRAL's removals hold ──
const { persons = [] } = json(await request('/api/persons?limit=2000', cookie)) || {};
const sample = persons.filter((p) => /^99\d\d /.test(p.address || '') && p.city === 'Vancouver');
const turfs = (json(await request('/api/turfs', cookie))?.turfs || []).length;
const shifts = (json(await request('/api/shifts', cookie))?.shifts || []).length;
for (const [what, n, least] of [['people', persons.length, 320], ['turfs', turfs, 4], ['shifts', shifts, 5]]) {
  if (n < least) fail(`${n} ${what}, fewer than the sample’s ${least}`);
  else if (n > least) note(`${n} ${what}: ${n - least} more than the sample’s ${least} (added by visitors)`);
}
let old = false;
if (sample.length < 320) { old = true; fail(`only ${sample.length} people at the sample’s 99xx addresses: staging still holds an older sample`); }
const scale = json(await request('/api/scale', cookie))?.scale;
const names = (scale?.candidates || []).filter((c) => !c.off).map((c) => c.name);
if (JSON.stringify(names) !== JSON.stringify(OPPONENTS.map((o) => o.name))) note(`the rating scale names ${JSON.stringify(names)}, not the cast’s three (a visitor may have saved the Rating scale screen)`);
const fields = (json(await request('/api/fields', cookie))?.fields || []).map((f) => f.name);
const missing = STARTING_FIELDS.filter((f) => !fields.includes(f));
const extra = fields.filter((f) => !STARTING_FIELDS.includes(f));
if (missing.length) note(`fields missing from the ten a campaign starts with: ${missing.join(', ')}`);
if (extra.length) note(`fields beyond the ten (a visitor’s, or an older sample’s): ${extra.join(', ')}`);
for (const path of GONE) {
  const s = (await request(path)).status;
  if (s !== 404) { old = true; fail(`${path} answers ${s}: Imagine Surrey’s pictures are served`); }
}
if ((await request('/api/membership/form', cookie)).status !== 404) { old = true; fail('/api/membership/form answers: the membership form is on staging'); }
const reports = json(await request('/api/quick-reports-menu', cookie))?.reports || [];
if (reports.some((r) => /member/i.test(`${r.name} ${r.title}`))) { old = true; fail('the quick reports offer Members'); }
const skins = (json(await request('/api/site', cookie))?.skins || []).map((s) => s.key);
if (JSON.stringify(skins) !== '["base"]') { old = true; fail(`the website offers the looks ${JSON.stringify(skins)}, not base.win’s alone`); }

// ── Keys that would reach real people ──
const senders = json(await request('/api/senders', cookie)) || {};
const texting = json(await request('/api/texting/settings', cookie)) || {};
const live = [];
if (senders.system) live.push('an email key (a system sender is set up)');
if (texting.sms) live.push('a texting key (texting is on)');
if (texting.voice) live.push('a calling key (calls are on)');
if (live.length && !testKeys) fail(`staging has ${live.join(', ')}: any demo visitor could email or text real people. Unset it in Render → base-win-staging → Environment, or set STAGING_TEST_KEYS=1 in the workflow if they are test keys.`);
else if (live.length) note(`${live.join(', ')}: allowed as test keys (STAGING_TEST_KEYS=1)`);

if (old) console.log(`\n${RESET_WORD}`);
console.log(`\n${reads.length} reads; ${failures.length} failed, ${notes.length} noted.`);
process.exit(failures.length ? 1 : 0);
