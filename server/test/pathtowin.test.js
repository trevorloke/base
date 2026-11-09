// Path to win (ext/pathtowin): the win number per race (typed in, or
// eligible × turnout × share — the campaign's own numbers), supporters found
// against supporters needed, the weekly pace to election day beside the last
// 4 weeks', the week-by-week trend from the ratings, and the turfs ranked by
// a score whose four parts and reasons add up. Desk only; managers change
// the numbers; every change is in the books. Made-up people throughout.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb, Client } from './helpers.js';
import {
  winNumber, tenths, paceOf, trendFrom, gainedOver, rankTurfs, addDays, daysBetween, RULES,
} from '../ext/pathtowin/rules.js';

// Counted fresh on every read, unless a test says otherwise.
process.env.STARBASE_PTW_CACHE_MS = '0';

const tokenOf = (url) => url.split('/join/')[1];
const ok = (r, msg = '') => { assert.equal(r.status, 200, `${msg} ${JSON.stringify(r.json)?.slice(0, 400)}`); return r.json; };
let db, mgr, staff, treas, vol, ws, trendMgr, trendWs;
const ids = {};
const T = {};

const joinAs = async (role, name) => {
  const inv = await mgr.action('member.invite', { email: `${name.toLowerCase()}.ptw@example.org`, role });
  const cl = new Client();
  const r = await cl.post('/api/auth/join', { token: tokenOf(inv.json.joinUrl), name, password: 'path-to-win-2026' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  ids[name] = r.json.user.id;
  return cl;
};
// Straight into the tables, so dates can be in the past.
const addPerson = async (w, p) => {
  const id = randomUUID();
  await db.query(
    `insert into persons (id, workspace_id, name, address, unit, lat, lng, rating, rated_at, created_at, deleted_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, now() - make_interval(days => $9::int), now() - make_interval(days => $10::int),
             case when $11::boolean then now() end)`,
    [id, w, p.name, p.address ?? null, p.unit ?? null, p.lat ?? null, p.lng ?? null, p.rating ?? null,
     p.ratedDaysAgo ?? null, p.createdDaysAgo ?? 200, Boolean(p.deleted)],
  );
  return id;
};
const addContact = async (w, personId, { channel = 'door', outcome = 'contacted', rating = null, daysAgo = 0 } = {}) => {
  await db.query(
    `insert into contacts (id, workspace_id, person_id, channel, outcome, rating, created_at)
     values ($1, $2, $3, $4, $5, $6, now() - make_interval(days => $7::int))`,
    [randomUUID(), w, personId, channel, outcome, rating, daysAgo],
  );
};
const rect = (s, w, n, e) => [[s, w], [s, e], [n, e], [n, w]];

before(async () => {
  db = await freshDb();
  mgr = new Client();
  const s = await mgr.signup({ workspaceName: 'Path to win', email: 'mgr.ptw@example.org', jurisdiction: 'bc-municipal' });
  ws = s.json.workspace.id;
  ids.mgr = s.json.user.id;
  staff = await joinAs('staff', 'Sam');
  treas = await joinAs('treasurer', 'Tara');
  vol = await joinAs('volunteer', 'Vic');

  // ── Four turfs, far apart (made-up blocks) ──
  // A · Newton: 40 doors (door 1 has two people), 25 knocked 3 days ago; ten
  //   supporters behind knocked doors; four persuadables, two opposed behind
  //   doors not knocked yet.
  // B · Fleetwood: 60 doors, 15 knocked 40 days ago (five supporters there),
  //   ten persuadables; a phone call is not a knock.
  // C · Guildford: 8 doors, never knocked, nobody rated.
  // D · Done block: 5 doors, all knocked 10 days ago, three supporters.
  for (const [k, name, poly] of [
    ['A', 'Newton', rect(49.100, -122.860, 49.110, -122.850)],
    ['B', 'Fleetwood', rect(49.150, -122.800, 49.160, -122.790)],
    ['C', 'Guildford', rect(49.050, -122.760, 49.060, -122.750)],
    ['D', 'Done block', rect(49.180, -122.700, 49.190, -122.690)],
  ]) T[k] = ok(await mgr.action('turf.create', { name, polygon: poly })).turf.id;

  for (let g = 1; g <= 40; g += 1) {
    const rating = g <= 10 ? (g % 2 ? '1' : '2') : g <= 25 ? null : g <= 29 ? '3' : g === 30 ? '4D' : g === 31 ? '4' : null;
    const id = await addPerson(ws, { name: `Newton ${g} Example`, address: `${g} Newton Example St`, lat: 49.1005 + g * 0.0002, lng: -122.855, rating });
    if (g <= 25) await addContact(ws, id, { daysAgo: 3 });
    if (g === 1) await addPerson(ws, { name: 'Newton Housemate Example', address: '1 NEWTON example st ', lat: 49.1007, lng: -122.855 });
  }
  // Inside A but deleted; and someone with an address and no pin yet.
  await addPerson(ws, { name: 'Gone Example', address: '99 Newton Example St', lat: 49.105, lng: -122.856, rating: '1', deleted: true });
  await addPerson(ws, { name: 'Unplaced Example', address: '98 Newton Example St', rating: '3' });
  for (let g = 1; g <= 60; g += 1) {
    const rating = g <= 5 ? '1' : g >= 16 && g <= 25 ? '3' : null;
    const id = await addPerson(ws, { name: `Fleetwood ${g} Example`, address: `${g} Fleetwood Example Ave`, lat: 49.1505 + g * 0.00015, lng: -122.795, rating });
    if (g <= 15) await addContact(ws, id, { daysAgo: 40, outcome: g % 3 ? 'contacted' : 'no_answer' });
    if (g === 20) await addContact(ws, id, { channel: 'phone', daysAgo: 1 });
  }
  for (let g = 1; g <= 8; g += 1) {
    await addPerson(ws, { name: `Guildford ${g} Example`, address: `${g} Guildford Example Rd`, lat: 49.051 + g * 0.001, lng: -122.755 });
  }
  for (let g = 1; g <= 5; g += 1) {
    const id = await addPerson(ws, { name: `Done ${g} Example`, address: `${g} Done Example Way`, lat: 49.181 + g * 0.0015, lng: -122.695, rating: g <= 3 ? '2' : null });
    await addContact(ws, id, { daysAgo: 10, outcome: 'left_lit' });
  }
  // Far from every turf.
  await addPerson(ws, { name: 'Far Example', address: '1 Far Example Rd', lat: 49.3, lng: -122.5, rating: '1' });

  // ── A second campaign for the trend: ratings over time, no turfs ──
  trendMgr = new Client();
  trendWs = (await trendMgr.signup({ workspaceName: 'Path to win trend', email: 'trend.ptw@example.org', jurisdiction: 'bc-municipal' })).json.workspace.id;
  const tw = trendWs;
  // Ana: strong yes 73 days ago (10 weeks back).
  const ana = await addPerson(tw, { name: 'Ana Example', rating: '1', ratedDaysAgo: 73, createdDaysAgo: 300 });
  await addContact(tw, ana, { rating: '1', daysAgo: 73 });
  // Ben: undecided 45 days ago (6 weeks back), lean yes 17 days ago (2 back).
  const ben = await addPerson(tw, { name: 'Ben Example', rating: '2', ratedDaysAgo: 17, createdDaysAgo: 300 });
  await addContact(tw, ben, { rating: '3', daysAgo: 45 });
  await addContact(tw, ben, { channel: 'phone', rating: '2', daysAgo: 17 });
  // Cy: strong yes 38 days ago (5 back), opposed 10 days ago (1 back).
  const cy = await addPerson(tw, { name: 'Cy Example', rating: '4', ratedDaysAgo: 10, createdDaysAgo: 300 });
  await addContact(tw, cy, { rating: '1', daysAgo: 38 });
  await addContact(tw, cy, { rating: '4', daysAgo: 10 });
  // Di: a lean yes that came with a list 140 days ago (no conversation).
  await addPerson(tw, { name: 'Di Example', rating: '2', createdDaysAgo: 140 });
  // Ed: a strong yes 3 days ago, since deleted.
  const ed = await addPerson(tw, { name: 'Ed Example', rating: '1', ratedDaysAgo: 3, createdDaysAgo: 300, deleted: true });
  await addContact(tw, ed, { rating: '1', daysAgo: 3 });
  // Flo: knocked 5 days ago, no rating.
  const flo = await addPerson(tw, { name: 'Flo Example', createdDaysAgo: 300 });
  await addContact(tw, flo, { daysAgo: 5 });
  // Gus: strong yes 2 days ago (this week).
  const gus = await addPerson(tw, { name: 'Gus Example', rating: '1', ratedDaysAgo: 2, createdDaysAgo: 300 });
  await addContact(tw, gus, { rating: '1', daysAgo: 2 });
  // Hal: undecided from a list 24 days ago (3 back); a call with no rating since.
  const hal = await addPerson(tw, { name: 'Hal Example', rating: '3', createdDaysAgo: 24 });
  await addContact(tw, hal, { channel: 'phone', daysAgo: 5 });
});

// ── The arithmetic (no database) ──

test('the win number: typed in, or eligible voters × turnout × share, rounded up; supporters to find for it', () => {
  assert.deepEqual(winNumber({ how: 'direct', votes: 30000 }), { votes: 30000, supporters: 30000, how: 'direct' });
  assert.deepEqual(winNumber({ how: 'worked', eligible: 400000, turnout: 30, share: 25 }), { votes: 30000, supporters: 30000, how: 'worked' });
  assert.equal(winNumber({ how: 'worked', eligible: 400000, turnout: 30, share: 25, vote_rate: 80 }).supporters, 37500, '30,000 votes ÷ 80% who vote');
  assert.deepEqual(winNumber({ how: 'worked', eligible: 1000, turnout: 30, share: 25.5, vote_rate: 80 }), { votes: 77, supporters: 97, how: 'worked' },
    '76.5 votes is 77; 77 ÷ 80% = 96.25 is 97');
  assert.equal(winNumber({ how: 'worked', eligible: 10000, turnout: 33.3, share: 50 }).votes, 1665, 'exactly, no rounding error');
  assert.equal(winNumber({ how: 'worked', eligible: 7, turnout: 10, share: 10 }).votes, 1, 'a part of a vote is a vote');
  assert.equal(winNumber({ how: 'direct', votes: 30000, vote_rate: 70 }).supporters, 42858);
  for (const bad of [null, {}, { how: 'direct' }, { how: 'direct', votes: 0 }, { how: 'direct', votes: 2.5 },
    { how: 'worked', eligible: 1000, turnout: 30 }, { how: 'worked', eligible: 1000, turnout: 0, share: 25 },
    { how: 'worked', eligible: 1000, turnout: 30, share: 100.5 }, { how: 'worked', eligible: 1000, turnout: 33.33, share: 25 },
    { how: 'guess', votes: 10 }]) {
    assert.equal(winNumber(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual(['32.5', 0.1, 100, 0.05, 33.33, '', null, 'x'].map(tenths), [325, 1, 1000, null, null, null, null, null]);
});

test('the pace: still to find, a week to election day, the last 4 weeks, and where that leads', () => {
  assert.equal(daysBetween('2026-11-09', '2030-10-19'), 1440);
  const p = paceOf({ found: 1240, needed: 30000, today: '2026-11-09', electionDay: '2030-10-19', last4: 208 });
  assert.deepEqual(p, {
    found: 1240, needed: 30000, still: 28760, pct: 4, days_left: 1440, weeks_left: 205.7,
    per_week_needed: 140, // 28,760 × 7 ÷ 1,440 = 139.8 → 140
    per_week_last4: 52, // 208 ÷ 4
    projected: 11937, // 1,240 + 52 a week × 205.7 weeks
    on_pace: false,
  });
  assert.equal(paceOf({ found: 4, needed: 10, today: '2026-11-09', electionDay: '2027-01-18', last4: 1 }).per_week_needed, 1, '6 in 10 weeks: 0.6 a week is 1');
  const none = paceOf({ found: 5, needed: 10, today: '2026-11-09', electionDay: null, last4: 4 });
  assert.deepEqual([none.days_left, none.per_week_needed, none.projected, none.on_pace, none.per_week_last4], [null, null, null, null, 1]);
  const past = paceOf({ found: 5, needed: 10, today: '2026-11-09', electionDay: '2026-10-17', last4: 4 });
  assert.deepEqual([past.days_left, past.per_week_needed, past.on_pace], [-23, null, null]);
  const there = paceOf({ found: 12, needed: 10, today: '2026-11-09', electionDay: '2030-10-19', last4: 0 });
  assert.deepEqual([there.still, there.pct, there.on_pace, there.per_week_needed], [0, 100, true, 0]);
  assert.equal(paceOf({ found: 0, needed: 100, today: '2026-11-09', electionDay: '2026-11-23', last4: 200 }).on_pace, true, '50 a week keeps up with 50');
});

test('the trend from rows: each week’s count is what began by then less what ended; gained is the week’s net', () => {
  const rows = [
    { band: 'support', w: 12, n: 1 }, { band: 'support', w: 10, n: 1 }, { band: 'support', w: 5, n: 1 },
    { band: 'support', w: 2, n: 1 }, { band: 'support', w: 1, n: -1 }, { band: 'support', w: 0, n: 1 },
    { band: 'undecided', w: 6, n: 1 }, { band: 'undecided', w: 2, n: -1 }, { band: 'undecided', w: 3, n: 1 },
    { band: 'opposed', w: 1, n: 1 }, { band: 'nonsense', w: 1, n: 5 }, { band: 'support', w: 13, n: 9 },
  ];
  const pts = trendFrom(rows, '2026-11-09');
  assert.equal(pts.length, 12);
  assert.deepEqual(pts.map((p) => p.supporters), [1, 2, 2, 2, 2, 2, 3, 3, 3, 4, 3, 4]);
  assert.deepEqual(pts.map((p) => p.gained), [0, 1, 0, 0, 0, 0, 1, 0, 0, 1, -1, 1]);
  assert.deepEqual(pts.map((p) => p.persuadables), [0, 0, 0, 0, 0, 1, 1, 1, 2, 1, 1, 1]);
  assert.deepEqual(pts.map((p) => p.opposed), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1]);
  assert.deepEqual([pts[11].start, pts[11].end, pts[0].start, pts[0].end], ['2026-11-03', '2026-11-09', '2026-08-18', '2026-08-24']);
  assert.equal(gainedOver(pts), 1, 'the last 4 weeks: +1 −1 +1');
  assert.equal(addDays('2026-11-09', -77), '2026-08-24');
});

// The four turfs' numbers, as numbers.js counts them (checked against the
// server below).
const ROWS = [
  { id: 'a', name: 'Newton', doors: 40, knocked: 25, people: 41, supporters: 10, persuadables: 4, opposed: 2, sup_at_knocked: 10, last_day: '2026-11-06' },
  { id: 'b', name: 'Fleetwood', doors: 60, knocked: 15, people: 60, supporters: 5, persuadables: 10, opposed: 0, sup_at_knocked: 5, last_day: '2026-09-30' },
  { id: 'c', name: 'Guildford', doors: 8, knocked: 0, people: 8, supporters: 0, persuadables: 0, opposed: 0, sup_at_knocked: 0, last_day: null },
  { id: 'd', name: 'Done block', doors: 5, knocked: 5, people: 5, supporters: 3, persuadables: 0, opposed: 0, sup_at_knocked: 3, last_day: '2026-10-30' },
];
const REASONS = {
  b: ['45 doors not yet knocked × 40 per 100 doors (your turfs’ average — under 20 knocked here) ≈ 18 supporters to find', '10 persuadables left (rated 3)', 'Last knocked 40 days ago'],
  a: ['15 doors not yet knocked × 40 supporters per 100 doors ≈ 6 supporters to find', '4 persuadables left (rated 3)', 'Last knocked 3 days ago'],
  c: ['8 doors not yet knocked × 40 per 100 doors (your turfs’ average — under 20 knocked here) ≈ 3 supporters to find', 'No persuadables left', 'Never knocked'],
  d: ['Nothing left to do: every door knocked, no persuadables'],
};

test('the ranking: four parts that add up — supporters to find (60), persuadables (30), time since the last knock (10)', () => {
  const { turfs, campaign_rate } = rankTurfs(ROWS, { today: '2026-11-09' });
  assert.equal(campaign_rate, 40, '18 supporters behind 45 knocked doors across the turfs');
  assert.deepEqual(turfs.map((t) => [t.id, t.rank, t.score, t.priority]), [['b', 1, 100, 'next'], ['a', 2, 33, 'soon'], ['c', 3, 21, 'later'], ['d', 4, 0, 'done']]);
  const by = Object.fromEntries(turfs.map((t) => [t.id, t]));
  // A has 25 knocked: its own 10 per 25 doors = 40 per 100; 15 doors left → 6 to find.
  assert.deepEqual([by.a.rate, by.a.rate_from, by.a.doors_left, by.a.to_find, by.a.days_since], [40, 'turf', 15, 6, 3]);
  // B has 15 knocked (under 20): the turfs' 40 per 100; 45 left → 18, the most → all 60.
  assert.deepEqual([by.b.rate, by.b.rate_from, by.b.doors_left, by.b.to_find, by.b.days_since], [40, 'campaign', 45, 18, 40]);
  assert.deepEqual(by.b.parts, { find: 60, persuade: 30, rest: 10 });
  assert.deepEqual(by.a.parts, { find: 20, persuade: 12, rest: 1 }, '6 of 18 → 20; 4 of 10 → 12; 3 of 28 days → 1');
  assert.deepEqual(by.c.parts, { find: 11, persuade: 0, rest: 10 }, '3.2 of 18 → 10.7 → 11; never knocked → all 10');
  assert.deepEqual(by.d.parts, { find: 0, persuade: 0, rest: 0 });
  for (const t of turfs) {
    assert.equal(t.score, t.parts.find + t.parts.persuade + t.parts.rest, `${t.name}: the parts add up`);
    assert.deepEqual(t.reasons.map((r) => r.text), REASONS[t.id], t.name);
    if (t.priority !== 'done') assert.deepEqual(t.reasons.map((r) => r.points), [t.parts.find, t.parts.persuade, t.parts.rest]);
  }
});

test('the ranking with nothing knocked anywhere: doors left stand in for supporters to find; ties go by name', () => {
  const rows = [
    { id: 'x', name: 'Zed block', doors: 50, knocked: 0, persuadables: 0, sup_at_knocked: 0 },
    { id: 'y', name: 'Alder block', doors: 50, knocked: 0, persuadables: 0, sup_at_knocked: 0 },
    { id: 'z', name: 'Small block', doors: 20, knocked: 0, persuadables: 5, sup_at_knocked: 0 },
    { id: 'w', name: 'Empty block', doors: 0, knocked: 0, persuadables: 0, sup_at_knocked: 0 },
  ];
  const { turfs, campaign_rate } = rankTurfs(rows, { today: '2026-11-09' });
  assert.equal(campaign_rate, null);
  assert.deepEqual(turfs.map((t) => [t.name, t.score]), [['Small block', 64], ['Alder block', 70], ['Zed block', 70], ['Empty block', 0]].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
  const small = turfs.find((t) => t.id === 'z');
  assert.deepEqual(small.parts, { find: 24, persuade: 30, rest: 10 }, '20 of 50 doors → 24');
  assert.equal(small.reasons[0].text, '20 doors not yet knocked (no doors knocked anywhere yet)');
  assert.equal(turfs.find((t) => t.id === 'w').reasons[0].text, 'Nobody on the map inside this turf yet');
  assert.equal(RULES.find + RULES.persuade + RULES.rest, 100);
});

// ── The server ──

test('GET /api/pathtowin: the turfs counted in SQL, ranked, with their reasons — and they agree with the turf list', async () => {
  const r = ok(await mgr.get('/api/pathtowin'));
  assert.equal(r.turfs.length, 4);
  assert.equal(r.campaign_rate, 40);
  const want = { [T.B]: 'b', [T.A]: 'a', [T.C]: 'c', [T.D]: 'd' };
  assert.deepEqual(r.turfs.map((t) => want[t.id]), ['b', 'a', 'c', 'd']);
  const by = Object.fromEntries(r.turfs.map((t) => [want[t.id], t]));
  const pick = (t) => ({ doors: t.doors, knocked: t.knocked, people: t.people, supporters: t.supporters, persuadables: t.persuadables, opposed: t.opposed, sup_at_knocked: t.sup_at_knocked });
  for (const row of ROWS) assert.deepEqual(pick(by[row.id]), pick(row), row.name);
  assert.deepEqual(r.turfs.map((t) => t.score), [100, 33, 21, 0]);
  assert.deepEqual(r.turfs.map((t) => t.priority), ['next', 'soon', 'later', 'done']);
  for (const [k, words] of Object.entries(REASONS)) assert.deepEqual(by[k].reasons.map((x) => x.text), words, k);
  assert.deepEqual([by.a.days_since, by.b.days_since, by.c.days_since, by.d.days_since], [3, 40, null, 10]);
  assert.ok(by.a.last_at && by.c.last_at === null);
  assert.deepEqual(by.a.polygon, rect(49.100, -122.860, 49.110, -122.850), 'the outline, for the map');
  // The turf list (routes/api.js, counted in the browser's way) agrees.
  const list = ok(await mgr.get('/api/turfs')).turfs;
  for (const t of list) {
    const mine = r.turfs.find((x) => x.id === t.id);
    assert.deepEqual([mine.doors, mine.people, mine.knocked], [t.doors, t.people, t.doorsDone], t.name);
  }
  // Everyone on file, by band (the deleted one left out; the unplaced one in).
  assert.deepEqual(r.standing, { people: 116, strong: 11, lean: 8, persuadables: 15, opposed: 2, unrated: 80, supporters: 19 });
  assert.deepEqual(r.rules, { ...RULES, weeks: 12, pace_weeks: 4 });
});

test('the trend from the ratings over time: this week’s count is the people on file now', async () => {
  const r = ok(await trendMgr.get('/api/pathtowin'));
  assert.equal(r.trend.length, 12);
  assert.equal(r.trend.at(-1).end, r.today);
  assert.deepEqual(r.trend.map((p) => p.supporters), [1, 2, 2, 2, 2, 2, 3, 3, 3, 4, 3, 4]);
  assert.deepEqual(r.trend.map((p) => p.gained), [0, 1, 0, 0, 0, 0, 1, 0, 0, 1, -1, 1]);
  assert.deepEqual(r.trend.map((p) => p.persuadables), [0, 0, 0, 0, 0, 1, 1, 1, 2, 1, 1, 1]);
  assert.deepEqual(r.trend.map((p) => p.opposed), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1]);
  assert.deepEqual(r.standing, { people: 7, strong: 2, lean: 2, persuadables: 1, opposed: 1, unrated: 1, supporters: 4 });
  assert.equal(r.trend.at(-1).supporters, r.standing.supporters);
  assert.equal(r.trend.at(-1).persuadables, r.standing.persuadables);
  assert.deepEqual([r.last4, r.per_week_last4], [1, 0.25]);
  assert.deepEqual(r.turfs, []);
  assert.equal(r.campaign_rate, null);
});

test('races: nothing set at first; a manager sets them; the pace counts down to election day', async () => {
  let r = ok(await trendMgr.get('/api/pathtowin'));
  assert.deepEqual(r.races.map((x) => [x.code, x.label, x.set]), [['council', 'City council', false], ['school_board', 'School board', false]]);
  assert.deepEqual(r.election, { day: null, from: null, days_left: null, weeks_left: null });
  assert.equal(r.can_edit, true);
  const day = addDays(r.today, 70);
  ok(await trendMgr.action('pathtowin.save', {
    election_day: day,
    races: {
      council: { how: 'direct', votes: 10 },
      school_board: { how: 'worked', eligible: 1000, turnout: 30, share: 25.5, vote_rate: 80 },
    },
  }));
  r = ok(await trendMgr.get('/api/pathtowin'));
  assert.deepEqual(r.election, { day, from: 'here', days_left: 70, weeks_left: 10 });
  const [council, board] = r.races;
  assert.deepEqual(
    { set: council.set, how: council.how, votes: council.votes, needed: council.supporters_needed, found: council.found, still: council.still, pct: council.pct, per_week_needed: council.per_week_needed, per_week_last4: council.per_week_last4, projected: council.projected, on_pace: council.on_pace },
    { set: true, how: 'direct', votes: 10, needed: 10, found: 4, still: 6, pct: 40, per_week_needed: 1, per_week_last4: 0.25, projected: 6, on_pace: false },
  );
  assert.deepEqual(council.inputs, { how: 'direct', votes: 10 });
  assert.deepEqual([board.how, board.votes, board.supporters_needed, board.still, board.per_week_needed], ['worked', 77, 97, 93, 10], '93 in 10 weeks: 9.3 a week is 10');
  assert.deepEqual(board.inputs, { how: 'worked', eligible: 1000, turnout: 30, share: 25.5, vote_rate: 80 });
  // A race left out stays; null clears one; election day left out stays.
  ok(await trendMgr.action('pathtowin.save', { races: { council: null } }));
  r = ok(await trendMgr.get('/api/pathtowin'));
  assert.deepEqual([r.races[0].set, r.races[1].set, r.election.day], [false, true, day]);
  // Switching how a race is worked out keeps only what that way uses.
  const saved = ok(await trendMgr.action('pathtowin.save', { races: { school_board: { how: 'direct', votes: 500, eligible: 99, turnout: 50 } } })).settings;
  assert.deepEqual(saved.races.school_board, { how: 'direct', votes: 500 });
});

test('GOTV & voting days’ election day wins over the one set here', async () => {
  ok(await trendMgr.action('vote.settings', { on: false, election_day: '2030-10-19' }));
  const r = ok(await trendMgr.get('/api/pathtowin'));
  assert.equal(r.election.day, '2030-10-19');
  assert.equal(r.election.from, 'gotv');
  assert.equal(r.election.days_left, daysBetween(r.today, '2030-10-19'));
  assert.ok(r.settings.election_day && r.settings.election_day !== '2030-10-19', 'the one set here is kept, unused');
  ok(await trendMgr.action('pathtowin.save', { election_day: null }));
  assert.equal(ok(await trendMgr.get('/api/pathtowin')).settings.election_day, null);
});

test('the numbers are checked: whole votes, percents from 0.1 to 100 (one decimal), real races and dates', async () => {
  const bad = [
    [{ races: { council: { how: 'direct' } } }, /votes/],
    [{ races: { council: { how: 'worked', eligible: 1000, turnout: 30 } } }, /share/],
    [{ races: { council: { how: 'worked', eligible: 1000, turnout: 0, share: 25 } } }, /turnout/],
    [{ races: { council: { how: 'worked', eligible: 1000, turnout: 33.33, share: 25 } } }, /turnout: a percent/],
    [{ races: { council: { how: 'direct', votes: 12.5 } } }, /votes/],
    [{ races: { council: { how: 'direct', votes: 10, vote_rate: 120 } } }, /vote_rate/],
    [{ races: { mayor: { how: 'direct', votes: 10 } } }, /no race called mayor/],
    [{ election_day: '2030-02-30' }, /election_day/],
    [{ election_day: '1999-10-16' }, /election day/],
  ];
  for (const [input, re] of bad) {
    const r = await mgr.action('pathtowin.save', input);
    assert.equal(r.status, 400, JSON.stringify(input));
    assert.match(r.json.error, re, JSON.stringify(input));
  }
});

test('desk only: volunteers never read it (unless given Data); only managers change the numbers', async () => {
  assert.equal((await new Client().get('/api/pathtowin')).status, 401);
  assert.equal((await vol.get('/api/pathtowin')).status, 403);
  const s = ok(await staff.get('/api/pathtowin'));
  assert.equal(s.can_edit, false);
  assert.equal(s.turfs.length, 4);
  assert.equal(ok(await treas.get('/api/pathtowin')).can_edit, false);
  assert.equal(ok(await mgr.get('/api/pathtowin')).can_edit, true);
  for (const who of [staff, treas, vol]) {
    assert.equal((await who.action('pathtowin.save', { races: { council: { how: 'direct', votes: 5 } } })).status, 403);
  }
  // A volunteer given Data reads it; a staffer kept out of Data doesn't.
  ok(await mgr.action('permission.member.set', { user_id: ids.Vic, grant: ['data'] }));
  assert.equal((await vol.get('/api/pathtowin')).status, 200);
  ok(await mgr.action('permission.member.set', { user_id: ids.Vic, grant: [], deny: [] }));
  assert.equal((await vol.get('/api/pathtowin')).status, 403);
  ok(await mgr.action('permission.member.set', { user_id: ids.Sam, deny: ['data'] }));
  assert.equal((await staff.get('/api/pathtowin')).status, 403);
  ok(await mgr.action('permission.member.set', { user_id: ids.Sam, grant: [], deny: [] }));
  // Given Admin, a staffer may change the numbers (a manager-only action is Admin's).
  ok(await mgr.action('permission.member.set', { user_id: ids.Sam, grant: ['admin'] }));
  assert.equal(ok(await staff.get('/api/pathtowin')).can_edit, true);
  assert.equal((await staff.action('pathtowin.save', { races: { council: { how: 'direct', votes: 5 } } })).status, 200);
  ok(await mgr.action('permission.member.set', { user_id: ids.Sam, grant: [], deny: [] }));
  // Only this campaign's numbers.
  const other = ok(await trendMgr.get('/api/pathtowin'));
  assert.notEqual(other.races[0].votes, 5);
  assert.equal(other.turfs.length, 0);
});

test('kept a minute: a second look is the same count; ?fresh=1 and a new turf count again', async () => {
  process.env.STARBASE_PTW_CACHE_MS = '60000';
  try {
    const first = ok(await mgr.get('/api/pathtowin'));
    const p = await addPerson(ws, { name: 'Newcomer Example', address: '77 Guildford Example Rd', lat: 49.0555, lng: -122.7555, rating: '1' });
    await addContact(ws, p, { daysAgo: 0 });
    const second = ok(await mgr.get('/api/pathtowin'));
    assert.equal(second.computed_at, first.computed_at, 'kept');
    assert.equal(second.standing.supporters, first.standing.supporters);
    // A saved number shows at once: the races are worked out on every read.
    ok(await mgr.action('pathtowin.save', { races: { council: { how: 'direct', votes: 400 } } }));
    const saved = ok(await mgr.get('/api/pathtowin'));
    assert.equal(saved.computed_at, first.computed_at);
    assert.deepEqual([saved.races[0].votes, saved.races[0].found], [400, first.standing.supporters]);
    const fresh = ok(await mgr.get('/api/pathtowin?fresh=1'));
    assert.notEqual(fresh.computed_at, first.computed_at);
    assert.equal(fresh.standing.supporters, first.standing.supporters + 1);
    const guildford = fresh.turfs.find((t) => t.id === T.C);
    assert.deepEqual([guildford.doors, guildford.knocked, guildford.days_since], [9, 1, 0]);
    assert.equal(guildford.reasons.at(-1).text, 'Knocked today');
    // A new turf drops the kept count.
    const e = ok(await mgr.action('turf.create', { name: 'East edge', polygon: rect(49.20, -122.70, 49.21, -122.69) })).turf.id;
    const after = ok(await mgr.get('/api/pathtowin'));
    assert.notEqual(after.computed_at, fresh.computed_at);
    assert.ok(after.turfs.some((t) => t.id === e && t.doors === 0 && t.priority === 'done'));
    ok(await mgr.action('turf.delete', { id: e }));
    assert.ok(!ok(await mgr.get('/api/pathtowin')).turfs.some((t) => t.id === e), 'a removed turf is gone at once');
  } finally {
    process.env.STARBASE_PTW_CACHE_MS = '0';
  }
});

test('in the books: each change is an event, the chain verifies, the export carries the numbers', async () => {
  const events = ok(await mgr.get('/api/events?limit=1000')).events.filter((e) => e.entity_type === 'path_to_win');
  assert.ok(events.length >= 2, `${events.length} events`);
  assert.equal(events.at(-1).action, 'pathtowin.save');
  assert.equal(events.at(-1).entity_id, ws);
  assert.deepEqual(events.at(-1).payload, { races: { council: { how: 'direct', votes: 400 } } });
  assert.equal(ok(await mgr.get('/api/audit/verify')).ok, true);
  assert.equal(ok(await trendMgr.get('/api/audit/verify')).ok, true);
  const exp = ok(await mgr.get('/api/export'));
  assert.equal(exp.path_to_win.length, 1);
  assert.equal(exp.path_to_win[0].workspace_id, ws);
});
