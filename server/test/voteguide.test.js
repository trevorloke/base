// The voter guide (ext/voteguide, VG stage 1): who may do what, publish's
// checklist in order, one list of places with Shifts and GOTV, the ballot
// matched to the slate, the import's preview against a fake address
// service, closed for one day, clearing, the public pages in every state
// by a moved clock (the banner, the cache's expiry, the query string, the
// headers), the address lookup that keeps nothing, the embed, the field's
// read, todayOf, web=guide, the export and the books. Made-up places and
// people only; the days are relative to today. test:pg-safe: one campaign.
process.env.NODE_ENV = 'test';
process.env.SITE_CACHE_SECONDS = '60';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { campaign, member, hit, send } from './site-helpers.js';
import { atLocal, localDay } from '../lib/tzrule.js';
import { sign } from '../ext/site/tokens.js';
import { cacheClear } from '../ext/site/cache.js';
import { forgetGuide } from '../ext/voteguide/read.js';
import { placesFor } from '../ext/schedule/places.js';
import { todayOf } from '../ext/pathtowin/numbers.js';

const TZ = 'America/Vancouver';
const DAY_MS = 24 * 3600e3;
const today = localDay(Date.now(), TZ);
const plus = (n) => localDay(atLocal(today, '12:00', TZ) + n * DAY_MS, TZ);
const A1 = plus(10); const A2 = plus(13); const G = plus(20);
const DAYS = [
  { day: A1, kind: 'advance', opens: '08:00', closes: '20:00' },
  { day: A2, kind: 'advance', opens: '08:00', closes: '20:00' },
  { day: G, kind: 'general', opens: '08:00', closes: '20:00' },
];
// Move the server's clock (lib/clock.js) to a wall time on the campaign's clock.
const moveTo = (day, hm) => { process.env.STARBASE_CLOCK_SHIFT_MS = String(atLocal(day, hm, TZ) - Date.now()); };
const moveBack = () => { delete process.env.STARBASE_CLOCK_SHIFT_MS; };

let db; let mgr; let ws; let staff; let vol; let fake; let lookups = [];
const ok = (r, msg = '') => { assert.equal(r.status, 200, `${msg} ${JSON.stringify(r.json)}`); return r.json; };
const no = (r, status, words) => { assert.equal(r.status, status, JSON.stringify(r.json)); if (words) assert.equal(r.json.error, words); return r.json; };

before(async () => {
  ({ db, mgr, ws } = await campaign('Guide Example Campaign'));
  staff = (await member(mgr, 'staff', 'Sam Staff')).client;
  vol = (await member(mgr, 'volunteer', 'Vic Volunteer')).client;
  ok(await mgr.action('permission.role.set', { role: 'staff', grant: ['site'], deny: [] }));
  // A fake B.C. address service: in the box unless the words say otherwise.
  fake = createServer((req, res) => {
    const q = new URL(req.url, 'http://x').searchParams.get('addressString') || '';
    lookups.push(q);
    res.setHeader('content-type', 'application/json');
    if (/nowhere/i.test(q)) return res.end(JSON.stringify({ features: [] }));
    if (/weak/i.test(q)) return res.end(JSON.stringify({ features: [{ geometry: { coordinates: [-122.8, 49.1] }, properties: { score: 40, matchPrecision: 'LOCALITY', fullAddress: q } }] }));
    if (/faraway/i.test(q)) return res.end(JSON.stringify({ features: [{ geometry: { coordinates: [-119.5, 50.9] }, properties: { score: 99, matchPrecision: 'CIVIC_NUMBER', fullAddress: q } }] }));
    const n = Number(/(\d+)/.exec(q)?.[1] || 1);
    return res.end(JSON.stringify({ features: [{ geometry: { coordinates: [-122.8, 49.1 + n / 100000] }, properties: { score: 99, matchPrecision: 'CIVIC_NUMBER', fullAddress: q } }] }));
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  process.env.GEOCODER = 'bc';
  process.env.BC_GEOCODER_URL = `http://127.0.0.1:${fake.address().port}`;
  process.env.STARBASE_GEO_BOUNDS = '49.002,-122.92|49.222,-122.67';
});
after(() => { fake?.close(); moveBack(); });

const place = (name, address, extra = {}) => ({ name, address, days: DAYS.map((d) => ({ day: d.day })), ...extra });
const authorize = () => mgr.action('site.settings.save', { org: { name: 'Guide Example Campaign', agentName: 'Pat Example', agentContact: 'agent@example.org' } });

test('who may do what: Website staff edit and check; a volunteer is refused; publish, unpublish, clear and embed are a manager’s', async () => {
  ok(await staff.action('site.guide.days', { days: DAYS }), 'staff saves days');
  ok(await staff.action('site.guide.place.save', place('Example Community Hall', '100 Example Ave', { lat: 49.15, lng: -122.8, area: 'Newton' })));
  ok(await staff.action('site.guide.ballot', { contests: [] }));
  ok(await staff.action('site.guide.save', { rules: { who: '' } }));
  ok(await staff.action('site.guide.check', { section: 'days', checked: true }));
  for (const [name, input] of [['site.guide.days', { days: DAYS }], ['site.guide.save', {}], ['site.guide.check', { section: 'days', checked: false }], ['site.guide.publish', {}], ['site.guide.place.save', place('X', 'Y')]]) {
    assert.equal((await vol.action(name, input)).status, 403, `volunteer: ${name}`);
  }
  for (const [name, input] of [['site.guide.publish', {}], ['site.guide.unpublish', {}], ['site.guide.clear', {}], ['site.guide.embed', { origins: [] }]]) {
    no(await staff.action(name, input), 403, 'Only a manager can do this');
  }
  assert.equal((await vol.get('/api/site/guide')).status, 403);
  ok(await staff.get('/api/site/guide'));
});

test('publish is refused for the first thing missing, in order, then goes live; GOTV gets the days', async () => {
  ok(await mgr.action('site.guide.clear', {}));
  const step = async (words) => no(await mgr.action('site.guide.publish', {}), 400, words);
  await step('Add at least one voting day');
  ok(await mgr.action('site.guide.days', { days: [{ ...DAYS[0] }] }));
  await step('Add election day (a General day)');
  ok(await mgr.action('site.guide.days', { days: [{ day: plus(-5), kind: 'general', opens: '08:00', closes: '20:00' }] }));
  await step('Every voting day has passed — add the next election’s days');
  ok(await mgr.action('site.guide.days', { days: DAYS }));
  await step('Add at least one voting place');
  ok(await mgr.action('site.guide.place.save', place('Example Community Hall', '100 Example Ave', { lat: 49.15, lng: -122.8, area: 'Newton' })));
  await step('Say whether voters can vote at any voting place');
  ok(await mgr.action('site.guide.save', { vote_anywhere: true }));
  await step('Add the elections office’s link');
  no(await mgr.action('site.guide.save', { official_url: 'http://example.org/vote' }), 400, 'Use a link that starts with https://');
  ok(await mgr.action('site.guide.save', { official_url: 'https://elections.example.org/vote', official_label: 'Example City: elections.example.org' }));
  await step('Tick ‘I checked this against the official notice’ under Voting days');
  ok(await mgr.action('site.guide.check', { section: 'days', checked: true }));
  await step('Tick ‘I checked this against the official notice’ under Voting places');
  ok(await mgr.action('site.guide.check', { section: 'places', checked: true }));
  await step('Add who authorized it (your financial agent) in Website → Settings');
  ok(await authorize());
  ok(await mgr.action('site.guide.ballot', { contests: [{ office: 'Mayor', vote_for: 1, names: [{ name: 'Ann Example' }, { name: 'Bo Example' }] }] }));
  await step('Tick ‘I checked this against the official notice’ under On the ballot');
  ok(await mgr.action('site.guide.check', { section: 'ballot', checked: true }));
  ok(await mgr.action('site.guide.save', { rules: { bring_listed: 'Bring what the elections office lists.' } }));
  await step('Tick ‘I checked this’ under What to bring and who can vote');
  ok(await mgr.action('site.guide.check', { section: 'rules', checked: true }));
  // No polls-close setting: an unknown key is refused by the schema.
  assert.equal((await mgr.action('site.guide.publish', { polls_close: '20:00' })).status, 400);
  const before = (await db.query("select count(*)::int as n from events where workspace_id = $1 and entity_type = 'workspace' and op = 'update'", [ws])).rows[0].n;
  const pub = ok(await mgr.action('site.guide.publish', { gotv_days: true }));
  assert.equal(pub.status, 'published');
  const after = (await db.query("select count(*)::int as n from events where workspace_id = $1 and entity_type = 'workspace' and op = 'update'", [ws])).rows[0].n;
  assert.equal(after - before, 1, 'one workspace update event, as vote.settings writes');
  const status = ok(await vol.get('/api/voted/status'));
  assert.deepEqual(status.advance_days, [A1, A2]);
  assert.equal(status.election_day, G);
  const desk = ok(await mgr.get('/api/site/guide'));
  assert.equal(desk.state, 'live');
  assert.ok(desk.checklist.every((c) => c.done));
});

test('one list of places: a guide place is a voting place in Shifts; adopting, clashing, 409s, keeping a used place', async () => {
  const p = (await db.query("select p.id, p.kind from places p join vote_place_info i on i.place_id = p.id where p.workspace_id = $1 and p.deleted_at is null and p.name = 'Example Community Hall'", [ws])).rows[0];
  assert.equal(p.kind, 'voting');
  const picker = await placesFor(db, ws, null);
  assert.equal(picker.places.find((x) => x.id === p.id)?.voting, true);
  // Published: Shifts can't change it.
  no(await mgr.action('place.rename', { id: p.id, name: 'Renamed Hall' }), 409, 'This place is in the published voter guide — change it under Website → Voter guide');
  no(await mgr.action('place.remove', { id: p.id }), 409, 'This place is in the published voter guide — change it under Website → Voter guide');
  // A Shifts place with the same name and address is adopted; another address is refused.
  const shiftsPlace = ok(await mgr.action('place.save', { name: 'Sample Secondary School', address: '200 Sample Street' })).place;
  const adopted = ok(await mgr.action('site.guide.place.save', place('sample secondary school', '200 Sample St', { lat: 49.12, lng: -122.81 })));
  assert.equal(adopted.place.id, shiftsPlace.id, 'the same row');
  assert.equal((await db.query("select count(*)::int as n from places where workspace_id = $1 and lower(name) = 'sample secondary school' and deleted_at is null", [ws])).rows[0].n, 1);
  ok(await mgr.action('place.save', { name: 'Example Arena', address: '400 Example Blvd' }));
  no(await mgr.action('site.guide.place.save', place('Example Arena', '999 Other Rd')), 400, 'A place with this name is already at another address');
  // A shift there: taking it out of the guide keeps the places row.
  const sh = await mgr.action('shift.create', { title: 'Scrutineer shift', starts_at: new Date(Date.now() + 5 * DAY_MS).toISOString(), place_id: shiftsPlace.id, location: 'Sample Secondary School' });
  assert.ok([200, 201].includes(sh.status), JSON.stringify(sh.json));
  const del = ok(await mgr.action('site.guide.place.delete', { id: shiftsPlace.id }));
  assert.equal(del.kept, true);
  const row = (await db.query('select deleted_at, kind from places where id = $1', [shiftsPlace.id])).rows[0];
  assert.equal(row.deleted_at, null);
  assert.equal(row.kind, 'voting');
  assert.equal(ok(await mgr.get('/api/site/guide')).gotv_only, 1);
  ok(await mgr.action('site.guide.place.restore', { id: shiftsPlace.id }));
  assert.equal(ok(await mgr.get('/api/site/guide')).gotv_only, 0);
});

test('300 voting places never push the campaign’s own 10 off the Shifts list', async () => {
  const db2 = db;
  const own = Array.from({ length: 10 }, (_, i) => `Zed Own Place ${i}`);
  for (const n of own) await db2.query("insert into places (id, workspace_id, name) values (gen_random_uuid(), $1, $2)", [ws, n]);
  await db2.query(`insert into places (id, workspace_id, name, kind) select gen_random_uuid(), $1, 'Aa Voting ' || g, 'voting' from generate_series(1, 300) g`, [ws]);
  const { places } = await placesFor(db2, ws, null);
  for (const n of own) assert.ok(places.some((p) => p.name === n), n);
  assert.ok(places.findIndex((p) => p.voting) > places.findIndex((p) => p.name === own[9]), 'voting places after the campaign’s own');
  await db2.query("update places set deleted_at = now() where workspace_id = $1 and (name like 'Aa Voting %' or name like 'Zed Own Place %')", [ws]);
});

test('the ballot: a name matching the slate links to it and is ours, typed either way; input candidate_id is ignored', async () => {
  ok(await mgr.action('candidate.save', { name: 'Linda Example', office: 'Councillor', race: 'council' }).then((r) => (r.status === 400 ? mgr.action('candidate.save', { name: 'Linda Example', office: 'Councillor', race: '' }) : r)));
  const cand = (await db.query("select id from candidates where workspace_id = $1 and name = 'Linda Example'", [ws])).rows[0];
  const out = ok(await mgr.action('site.guide.ballot', {
    contests: [{ office: 'Councillor', vote_for: 8, names: [{ name: 'EXAMPLE, Linda', candidate_id: '00000000-0000-0000-0000-000000000000' }, { name: 'Other Example' }, { name: 'Linda Example', ours: false }] }],
  }));
  const [a, b, c] = out.contests[0].names;
  assert.equal(a.candidate_id, cand.id);
  assert.equal(a.ours, true);
  assert.equal(b.candidate_id, null);
  assert.equal(b.ours, false);
  assert.equal(c.ours, false, 'unticked stays unticked');
  ok(await mgr.action('site.guide.check', { section: 'ballot', checked: true }));
});

test('import: preview statuses, the fence, weak answers, a stale token, replace — and no lookup inside the write', async () => {
  const text = [
    'Name,Address,Days,Accessible,Area',
    `Example Community Hall,100 Example Ave,All,yes,Newton`,
    'Example Library,300 Example Rd,Election day,no,Fleetwood',
    'Faraway Hall,500 Faraway Rd,,,',
    'Weak Hall,600 Weak St,,,',
    'Nowhere Hall,700 Nowhere Rd,,,',
    'Bad Day Hall,800 Example Way,next tuesday,,',
    'Example Arena,999 Other Rd,,,',
  ].join('\n');
  const pv = ok(await mgr.post('/api/site/guide/import/preview', { text }));
  const by = Object.fromEntries(pv.rows.map((r) => [r.name, r]));
  assert.equal(by['Example Community Hall'].status, 'Changed');
  assert.ok(by['Example Community Hall'].changes.includes('accessible'));
  assert.equal(by['Example Library'].status, 'New');
  assert.equal(by['Example Library'].on_map, true);
  assert.equal(by['Faraway Hall'].on_map, false);
  assert.equal(by['Faraway Hall'].reason, 'Looked up outside the campaign’s area');
  assert.equal(by['Weak Hall'].on_map, false, 'a weak answer is no pin');
  assert.equal(by['Nowhere Hall'].on_map, false);
  assert.equal(by['Bad Day Hall'].status, 'Problem');
  assert.equal(by['Bad Day Hall'].reason, 'Use dates like YYYY-MM-DD or Oct 19, or Advance, Election day or All');
  assert.equal(by['Example Arena'].status, 'Problem');
  assert.equal(by['Example Arena'].reason, 'A place with this name is already at another address');
  assert.equal(pv.counts.not_on_map, 3);
  assert.ok(pv.counts.not_in_list >= 1, 'Sample Secondary School is not in this list');
  // Same: a second preview of a saved place.
  // A changed row or a forged token is refused.
  const forged = pv.rows.map((r) => (r.name === 'Example Library' ? { ...r, lat: 10 } : r));
  no(await mgr.action('site.guide.places.import', { rows: forged, replace: false, token: pv.token }), 400, 'This preview is out of date — preview again');
  no(await mgr.action('site.guide.places.import', { rows: pv.rows, replace: false, token: (await sign('vg-import', { w: ws, u: 'x', h: 'y' }, -10)) }), 400, 'This preview is out of date — preview again');
  const calls = lookups.length;
  const saved = ok(await mgr.action('site.guide.places.import', { rows: pv.rows, replace: true, token: pv.token }));
  assert.equal(lookups.length, calls, 'nothing looked up in the write');
  assert.ok(saved.added >= 4);
  assert.equal(saved.removed, 1, 'replace: Sample Secondary School out of the guide');
  const kept = (await db.query("select deleted_at from places where workspace_id = $1 and lower(name) = 'sample secondary school'", [ws])).rows[0];
  assert.equal(kept.deleted_at, null, 'its shift keeps the place');
  const again = ok(await mgr.post('/api/site/guide/import/preview', { text: 'Example Library,300 Example Rd,Election day,no' }));
  assert.equal(again.rows[0].status, 'Same');
  process.env.GEOCODER = 'off';
  const off = ok(await mgr.post('/api/site/guide/import/preview', { text: 'Example New Hall,900 Example Ave' }));
  assert.equal(off.lookup, 'off');
  assert.equal(off.rows[0].on_map, false);
  process.env.GEOCODER = 'bc';
});

test('a published place edited carries before and after and changed_at; closed is today only', async () => {
  const lib = (await db.query("select id from places where workspace_id = $1 and name = 'Example Library'", [ws])).rows[0];
  moveTo(A1, '10:00');
  ok(await mgr.action('site.guide.place.save', { id: lib.id, ...place('Example Library', '300 Example Rd'), closed: true, closed_note: 'Water leak' }));
  const info = (await db.query("select to_char(closed_on, 'YYYY-MM-DD') as d, changed_at from vote_place_info where place_id = $1", [lib.id])).rows[0];
  assert.equal(info.d, A1);
  assert.ok(info.changed_at);
  const ev = (await db.query("select payload from events where workspace_id = $1 and entity_type = 'vote_place' and entity_id = $2 order by seq desc limit 1", [ws, lib.id])).rows[0].payload;
  const pl = typeof ev === 'string' ? JSON.parse(ev) : ev;
  assert.equal(pl.before.closed_on, null);
  assert.equal(pl.after.closed_on, A1);
  const g1 = ok(await vol.get('/api/guide'));
  assert.equal(g1.places.find((p) => p.id === lib.id).closed, true);
  moveTo(A2, '10:00');
  forgetGuide(ws);
  const g2 = ok(await vol.get('/api/guide'));
  const p2 = g2.places.find((p) => p.id === lib.id);
  assert.equal(p2.closed, false, 'open again the next voting day');
  assert.equal(ok(await mgr.get('/api/site/guide')).guide.places.find((p) => p.id === lib.id).closed, false, 'the desk’s switch reads off');
  moveBack();
});

test('the field read: published with links and moments; same rev; draft only for Website staff; no person in it', async () => {
  const pg = ok(await mgr.action('site.guide.page', {}));
  ok(await mgr.action('site.page.publish', { id: pg.page.id }));
  const g = ok(await vol.get('/api/guide'));
  assert.ok(g.rev > 0);
  assert.ok(Number.isFinite(g.now));
  assert.ok(g.times.days.every((d) => Number.isFinite(d.opensAt) && Number.isFinite(d.closesAt)));
  assert.match(g.links.en, /\/voter-guide$/);
  assert.equal(JSON.stringify(g).includes('email'), false);
  assert.equal(ok(await vol.get(`/api/guide?rev=${g.rev}`)).same, true);
  // A correction moves rev; the next read with the old rev gets the guide.
  const hall = g.places.find((p) => p.name === 'Example Community Hall');
  ok(await mgr.action('site.guide.place.save', { id: hall.id, ...place(hall.name, hall.address, { area: 'Newton' }), closed: true }));
  const next = ok(await vol.get(`/api/guide?rev=${g.rev}`));
  assert.ok(next.rev > g.rev);
  assert.ok(next.places.find((p) => p.id === hall.id).closed_on);
  ok(await mgr.action('site.guide.place.save', { id: hall.id, ...place(hall.name, hall.address, { area: 'Newton' }), closed: false }));
  ok(await mgr.action('site.guide.unpublish', {}));
  assert.equal(ok(await vol.get('/api/guide')).status, 'not_out');
  assert.equal(ok(await vol.get('/api/guide?draft=1')).status, 'not_out', 'a volunteer can’t see the draft');
  assert.equal(ok(await staff.get('/api/guide?draft=1')).status, 'published', 'Website staff see it as a canvasser would');
});

test('the public guide: not out (draft too) with its sign-up; the draft in a preview', async () => {
  const r = await hit('/site/voter-guide');
  assert.equal(r.status, 200);
  assert.match(r.text, /Voting information isn’t out yet\./);
  assert.match(r.text, /Tell me when it’s out/);
  assert.match(r.text, /"source":"voter-guide"/);
  for (const d of [A1, A2, G]) assert.doesNotMatch(r.text, new RegExp(d));
  assert.doesNotMatch(r.text, /Example Community Hall|Ann Example/);
  const page = (await db.query("select id from site_pages where workspace_id = $1 and slug = 'voter-guide'", [ws])).rows[0];
  const t = await sign('preview', { w: ws, p: page.id }, 600);
  const pv = await hit(`/site/__preview/${page.id}?t=${encodeURIComponent(t)}`);
  assert.match(pv.text, /Example Community Hall/);
  // The sign-up lands with its source; web=guide finds them.
  const sent = await send('newsletter', { email: 'asks@example.org', first_name: 'Asha', page_id: page.id, module_id: 'x', source: 'voter-guide', consent_email: true });
  assert.ok([200, 201].includes(sent.status), sent.text);
  const people = ok(await mgr.get('/api/persons?web=guide'));
  const list = people.persons || people.items || people.rows || people;
  assert.ok(JSON.stringify(list).includes('Asha'), 'web=guide finds who asked');
  ok(await mgr.action('site.guide.publish', {}));
});

test('the public guide by the clock: before, open, between, over; the banner; Permissions-Policy', async () => {
  cacheClear(ws);
  moveTo(plus(5), '12:00');
  let r = await hit('/site/voter-guide');
  assert.match(r.text, /Voting starts /);
  assert.match(r.headers.get('permissions-policy'), /geolocation=\(self\)/);
  r = await hit('/site/voter-guide');
  assert.match(r.headers.get('permissions-policy'), /geolocation=\(self\)/, 'served from the cache, the same header');
  let home = await hit('/site/');
  assert.match(home.text, /class="vote-banner"/, 'the banner within a week');
  assert.match(home.headers.get('permissions-policy'), /geolocation=\(\)/);
  assert.doesNotMatch(r.text, /class="vote-banner"/, 'not on the guide page');
  cacheClear(ws);
  moveTo(plus(1), '12:00');
  home = await hit('/site/');
  assert.doesNotMatch(home.text, /class="vote-banner"/, 'not before the week');
  cacheClear(ws);
  moveTo(A1, '10:00');
  r = await hit('/site/voter-guide');
  assert.match(r.text, /Voting is open now · until 8 p\.m\./);
  home = await hit('/site/');
  assert.match(home.text, /Vote today until 8 p\.m\./);
  cacheClear(ws);
  moveTo(A1, '21:00');
  r = await hit('/site/voter-guide');
  assert.match(r.text, /Next day to vote: /);
  cacheClear(ws);
  moveTo(A2, '06:00');
  r = await hit('/site/voter-guide');
  assert.match(r.text, /Voting opens today at 8 a\.m\./);
  // Kept at 19:59:30, not served at 20:00:01.
  cacheClear(ws);
  process.env.STARBASE_CLOCK_SHIFT_MS = String(atLocal(A2, '19:59', TZ) + 30_000 - Date.now());
  r = await hit('/site/voter-guide');
  assert.match(r.text, /Voting is open now/);
  process.env.STARBASE_CLOCK_SHIFT_MS = String(atLocal(A2, '20:00', TZ) + 1000 - Date.now());
  r = await hit('/site/voter-guide');
  assert.match(r.text, /Next day to vote: /, 'the kept page expired at the close');
  cacheClear(ws);
  moveTo(G, '20:30');
  r = await hit('/site/voter-guide');
  assert.match(r.text, /Voting is over\. Thank you for voting\./);
  assert.doesNotMatch(r.text, /Example Community Hall/);
  home = await hit('/site/');
  assert.doesNotMatch(home.text, /class="vote-banner"/);
  moveBack();
  cacheClear(ws);
});

test('the query string: ?area= kept per area, ?q= never kept, ?near= the plain page; an edit clears', async () => {
  moveTo(A1, '10:00');
  cacheClear(ws);
  let r = await hit('/site/voter-guide?area=Newton');
  assert.match(r.text, /Example Community Hall/);
  assert.doesNotMatch(r.text, /<p class="vg-place-name">Example Library/);
  r = await hit('/site/voter-guide');
  assert.match(r.text, /<p class="vg-place-name">(?:<s>)?Example Library/, 'the plain page has every place');
  r = await hit('/site/voter-guide?area=Newton');
  assert.doesNotMatch(r.text, /<p class="vg-place-name">Example Library/, 'and the filtered one only Newton’s');
  r = await hit('/site/voter-guide?area=Nowhere');
  assert.match(r.text, /<p class="vg-place-name">(?:<s>)?Example Library/, 'an unknown area: the plain page');
  r = await hit('/site/voter-guide?near=49.19,-122.85');
  assert.match(r.text, /<p class="vg-place-name">(?:<s>)?Example Library/);
  r = await hit('/site/voter-guide?q=library');
  assert.match(r.headers.get('cache-control'), /no-cache|no-store/);
  // An edit is on the page at the next request.
  ok(await mgr.action('site.guide.save', { ballot_note: 'Names are printed as the office lists them.' }));
  r = await hit('/site/voter-guide');
  assert.match(r.text, /Names are printed as the office lists them\./);
  ok(await mgr.action('site.guide.check', { section: 'rules', checked: true }));
  // The ballot hidden until checked; empty rules not drawn.
  ok(await mgr.action('site.guide.unpublish', {}));
  ok(await mgr.action('site.guide.check', { section: 'ballot', checked: false }));
  r = await hit('/site/voter-guide');
  assert.doesNotMatch(r.text, /Look for these names/);
  assert.doesNotMatch(r.text, /Who can vote/);
  ok(await mgr.action('site.guide.check', { section: 'ballot', checked: true }));
  ok(await mgr.action('site.guide.publish', {}));
  r = await hit('/site/voter-guide');
  assert.match(r.text, /Look for these names/);
  // vote_anywhere false: the office's link, and nothing else about it.
  ok(await mgr.action('site.guide.save', { vote_anywhere: false }));
  r = await hit('/site/voter-guide');
  assert.match(r.text, /Check where you vote: /);
  assert.doesNotMatch(r.text, /Vote at any voting place/);
  ok(await mgr.action('site.guide.save', { vote_anywhere: true }));
  moveBack();
});

test('find an address: rounded, refused with its words, limited, and nothing kept', async () => {
  const tables = (await db.query("select table_name from information_schema.tables where table_schema = current_schema() and table_type = 'BASE TABLE'")).rows.map((r) => r.table_name);
  const counts = async () => Object.fromEntries(await Promise.all(tables.map(async (t) => [t, (await db.query(`select count(*)::int as n from "${t}"`)).rows[0].n])));
  const was = await counts();
  const find = (address, ip) => hit('/site/api/guide/find', { method: 'POST', body: { address }, ip });
  const r = await find('12345 Example Ave', '203.0.113.9');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.lat, Math.round(r.json.lat * 1000) / 1000);
  no(await find('Weak Ave', '203.0.113.9'), 400, 'We couldn’t find that address. Try the house number and street name.');
  no(await find('Nowhere Rd', '203.0.113.9'), 400, 'We couldn’t find that address. Try the house number and street name.');
  process.env.GEOCODER = 'off';
  no(await find('1 Example Ave', '203.0.113.9'), 503, 'Looking up addresses isn’t available. Use your location or search by street.');
  process.env.GEOCODER = 'bc';
  for (let i = 0; i < 26; i += 1) await find('1 Example Ave', '203.0.113.9');
  no(await find('1 Example Ave', '203.0.113.9'), 429, 'Too many tries from here — wait a minute and try again');
  let last;
  for (let i = 0; i < 300; i += 1) last = await find('1 Example Ave', `198.18.${Math.floor(i / 200)}.${(i % 200) + 1}`);
  no(last, 429, 'Busy — use your location or search by street');
  assert.deepEqual(await counts(), was, 'no row anywhere');
});

test('the embed: framed only by the saved addresses, its authorization line; refused addresses', async () => {
  let r = await hit('/site/embed/voter-guide');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.match(r.text, /Authorized by Pat Example/);
  assert.match(r.headers.get('permissions-policy'), /geolocation=\(self\)/);
  no(await mgr.action('site.guide.embed', { origins: ['https://www.example.ca/page'] }), 400, 'Use the website’s address, like https://www.example.ca');
  no(await mgr.action('site.guide.embed', { origins: ['https://base.win'] }), 400, 'That’s base.win itself');
  no(await mgr.action('site.guide.embed', { origins: ['https://a.example.ca', 'https://b.example.ca', 'https://c.example.ca', 'https://d.example.ca', 'https://e.example.ca', 'https://f.example.ca'] }), 400, '5 addresses is the most');
  ok(await mgr.action('site.guide.embed', { origins: ['https://www.example.ca', 'http://localhost:5514'] }));
  r = await hit('/site/embed/voter-guide');
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors https:\/\/www\.example\.ca http:\/\/localhost:5514/);
  assert.equal(r.headers.get('x-frame-options'), null);
  ok(await mgr.action('site.guide.embed', { origins: ['https://news.example.ca'] }));
  r = await hit('/site/embed/voter-guide');
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors https:\/\/news\.example\.ca;/, 'the next answer has the new list');
  r = await hit('/site/');
  assert.equal(r.headers.get('x-frame-options'), 'DENY', 'every other page still DENY');
  const js = await hit('/site-assets/embed.js');
  assert.equal(js.status, 200);
  assert.ok(Buffer.byteLength(js.text) <= 1024, 'the snippet’s script is small');
  assert.match(js.text, /basewin:height/);
  assert.match((await hit('/site/voter-guide')).text, /voteguide\.css\?v=/, 'the guide’s own styles');
  // Every language's app answers the guide's routes too (TR).
  assert.equal((await hit('/site/pa/api/guide/clock')).status, 302, 'a language not offered goes to English');
});

test('clear: refused while live, then everything goes but the rules, the link and used places', async () => {
  moveTo(A1, '10:00');
  no(await mgr.action('site.guide.clear', {}), 400, 'Unpublish it first');
  moveTo(G, '21:00');
  const done = ok(await mgr.action('site.guide.clear', {}));
  assert.ok(done.days === 3 && done.places >= 1);
  moveBack();
  const desk = ok(await mgr.get('/api/site/guide'));
  assert.equal(desk.state, 'not_out');
  assert.equal(desk.guide.days.length, 0);
  assert.equal(desk.guide.places.length, 0);
  assert.equal(desk.guide.contests.length, 0);
  assert.equal(desk.guide.vote_anywhere, null);
  assert.equal(desk.guide.ballot_note, '');
  assert.deepEqual(desk.guide.checked, {});
  assert.equal(desk.guide.rules.bring_listed, 'Bring what the elections office lists.');
  assert.equal(desk.guide.official_url, 'https://elections.example.org/vote');
  const used = (await db.query("select deleted_at, kind from places where workspace_id = $1 and lower(name) = 'sample secondary school'", [ws])).rows[0];
  assert.equal(used.deleted_at, null, 'a place a shift uses stays');
});

test('todayOf follows the moved clock, and the database’s otherwise', async () => {
  assert.equal(await todayOf(db, TZ), localDay(Date.now(), TZ));
  moveTo(G, '12:00');
  assert.equal(await todayOf(db, TZ), G);
  moveBack();
});

test('the export carries the guide’s tables; the books verify', async () => {
  const ex = ok(await mgr.get('/api/export'));
  for (const t of ['vote_guide', 'vote_days', 'vote_place_info', 'vote_contests']) assert.ok(Array.isArray(ex[t]), t);
  const v = ok(await mgr.get('/api/audit/verify'));
  assert.equal(v.ok, true, JSON.stringify(v));
});
