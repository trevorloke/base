// BASE_CANDIDATES=none: a campaign with no opponents on its rating scale
// — the four steps and "Not sure", never Imagine Surrey's list. Unset or
// empty is the server's preset's list: Imagine Surrey's five on its own
// server, exactly as before (its production sets nothing), and nobody on any
// other. This whole file runs a server set to "none": the scale it
// hands out, a knock, the import, People's filter, Today's numbers, the walk
// sheet, the sample, and the first candidate a manager adds.
// A phone's copy of this code has no settings and no list of its own, so it
// never adds candidates to a list the server sent.
// Unique emails and campaign names (test:pg runs every file on one database).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// Set for the whole file: the scale's starting list is read whenever it is asked.
process.env.BASE_CANDIDATES = ' None ';
const { freshDb, Client } = await import('./helpers.js');
const { getDb } = await import('../db/client.js');
const S = await import('@base-win/shared/scale');
const { presetFor } = await import('../lib/preset.js');
// Imagine Surrey's list, from its preset (this file runs as its server does).
const IS_LIST = presetFor('imagine-surrey').candidates;

// Another copy of shared/scale.js, read with other settings — or as a
// browser reads it: no settings (browser: 'bare', no process at all — the
// app's build puts an empty object where the settings would be), or a page
// (browser: 'page', a document) whatever else is there.
const SCALE_FILE = new URL('../../shared/scale.js', import.meta.url).href;
const scaleWith = async (tag, value, { browser = null } = {}) => {
  const proc = globalThis.process;
  const had = proc.env.BASE_CANDIDATES;
  if (value === undefined) delete proc.env.BASE_CANDIDATES; else proc.env.BASE_CANDIDATES = value;
  if (browser === 'bare') globalThis.process = undefined;
  if (browser === 'page') globalThis.document = {};
  try {
    const copy = await import(`${SCALE_FILE}?${tag}`);
    if (browser) return copy; // told nothing until it signs in, and it reads no settings
    // A server's copy is told its preset's list, as lib/preset.js tells the
    // real one, and reads its setting each time it is asked: this copy's
    // setting is `value`, whenever it is called.
    copy.presetCandidates(() => IS_LIST);
    const asSet = (fn) => (...args) => {
      const now = proc.env.BASE_CANDIDATES;
      if (value === undefined) delete proc.env.BASE_CANDIDATES; else proc.env.BASE_CANDIDATES = value;
      try { return fn(...args); } finally { if (now === undefined) delete proc.env.BASE_CANDIDATES; else proc.env.BASE_CANDIDATES = now; }
    };
    return Object.fromEntries(Object.entries(copy).map(([k, v]) => [k, typeof v === 'function' ? asSet(v) : v]));
  } finally {
    globalThis.process = proc;
    delete globalThis.document;
    if (had === undefined) delete proc.env.BASE_CANDIDATES; else proc.env.BASE_CANDIDATES = had;
  }
};
const wire = (x) => JSON.parse(JSON.stringify(x)); // as it crosses to a phone

const SURREY = [
  { code: '4D', name: 'McCallum', label: 'Opposed — Doug McCallum supporter' },
  { code: '4B', name: 'Locke', label: 'Opposed — Surrey Connect / Brenda Locke' },
  { code: '4F', name: 'Annis', label: 'Opposed — Surrey First / Linda Annis' },
  { code: '4N', name: 'van Vliet', label: 'Opposed — SurreyNow / Troy van Vliet' },
  { code: '4C', name: 'Randhawa', label: 'Opposed — Surrey Conservatives / Honveer Randhawa' },
];
const SURREY_CODES = SURREY.map((c) => c.code);

const tag = Math.random().toString(36).slice(2, 8);
let mgr; let ws; const P = {};
const ok = (r, msg = '') => { assert.equal(r.status, 200, `${msg} ${JSON.stringify(r.json)}`); return r.json; };
const knock = (person, rating) => mgr.action('contact.log', { person_id: person.id, channel: 'door', outcome: 'contacted', rating });

before(async () => {
  await freshDb();
  mgr = new Client();
  const r = await mgr.signup({ workspaceName: `No opponents ${tag}`, email: `none-mgr+${tag}@example.org`, jurisdiction: 'bc-municipal' });
  ws = r.json.workspace.id;
  P.a = await mgr.createPerson(`Ana None ${tag}`, { address: '100 Example St' });
  P.b = await mgr.createPerson(`Ben None ${tag}`, { address: '102 Example St' });
});

test('the setting: "none" in any case is no opponents; unset or empty is Imagine Surrey’s on its own server, as before', async () => {
  for (const typed of ['none', 'None', 'NONE', '  none  ', '\tNone\n']) {
    assert.deepEqual(S.startingCandidates(typed, IS_LIST), [], JSON.stringify(typed));
  }
  for (const typed of [undefined, null, '', '   ']) {
    assert.equal(S.startingCandidates(typed, IS_LIST), IS_LIST, `${JSON.stringify(typed)}: Imagine Surrey’s list`);
    assert.deepEqual(S.startingCandidates(typed), [], `${JSON.stringify(typed)}: with no preset, nobody`);
  }
  assert.deepEqual(wire(IS_LIST), SURREY, 'the list itself is untouched');
  // A list is a list; one that can't be read is, as before, Imagine Surrey's.
  assert.deepEqual(wire(S.startingCandidates('4A:Hartwell:Opposed — Hartwell supporter;4B:Quist', IS_LIST)), [
    { code: '4A', name: 'Hartwell', label: 'Opposed — Hartwell supporter' }, { code: '4B', name: 'Quist', label: 'Opposed — Quist' },
  ]);
  assert.equal(S.startingCandidates('nobody', IS_LIST), IS_LIST);
  assert.deepEqual(wire(S.startingCandidates('none;4B:Quist', IS_LIST)), [{ code: '4B', name: 'Quist', label: 'Opposed — Quist' }], '"none" is the whole setting, or it is not that word');

  // A server that sets nothing: the scale the app always had.
  const unset = await scaleWith('unset', undefined);
  assert.deepEqual(wire(unset.defaultCandidates()), SURREY);
  assert.deepEqual(unset.offeredCodes(unset.defaultScale()), ['1', '2', '3', '4', ...SURREY_CODES]);
  assert.deepEqual(unset.defaultScale().candidates.map((c) => [c.code, c.name, c.label, c.off]), SURREY.map((c) => [c.code, c.name, c.label, false]));
  const empty = await scaleWith('empty', '');
  assert.deepEqual(wire(empty.defaultScale()), wire(unset.defaultScale()));
});

test('“none”: the scale is the four steps and Not sure', () => {
  assert.deepEqual(S.defaultCandidates(), []);
  const s = S.defaultScale();
  assert.deepEqual(s.candidates, []);
  assert.deepEqual(s.steps.map((x) => [x.code, x.band, x.word, x.label]), [
    ['1', 'support', 'Strong yes', 'Strong support'], ['2', 'support', 'Lean yes', 'Lean support'],
    ['3', 'undecided', 'Undecided', 'Undecided'], ['4', 'opposed', 'Opposed', 'Opposed — support unknown'],
  ]);
  assert.deepEqual(S.offeredCodes(s), ['1', '2', '3', '4']);
  assert.deepEqual(S.allCodes(s), ['1', '2', '3', '4']);
  assert.deepEqual(S.offeredCandidates(s), []);
  assert.deepEqual(S.retiredCandidates(s), []);
  // People's and Calls' band filters.
  assert.deepEqual([S.codesInBand(s, 'support'), S.codesInBand(s, 'undecided'), S.codesInBand(s, 'opposed')], [['1', '2'], ['3'], ['4']]);
  // The buttons: 4, then "Voting for?" has only Not sure.
  assert.equal(S.ratingText(s, '4'), '4 · Opposed');
  assert.equal(S.ratingWho(s, '4'), 'Not sure');
  assert.equal(S.ratingSay(s, '3'), 'Undecided');
  // A spreadsheet's words: the steps read; no opponent's name does.
  assert.deepEqual(S.matchRating(s, 'not sure'), { code: '4', off: false });
  assert.deepEqual(S.matchRating(s, 'Opposed'), { code: '4', off: false });
  for (const said of ['Locke', 'McCallum', '4B', '4d', 'Opposed — Surrey Connect / Brenda Locke']) assert.equal(S.matchRating(s, said), null, said);
  // A code on a row from somewhere else still reads as opposed, by no name.
  const stray = S.ratingByCode(s, '4B');
  assert.deepEqual([stray.band, stray.name, stray.unknown, stray.label], ['opposed', 'Other', true, 'Opposed — not on the list']);
  // The default vocabulary (shared/scale.js ratings()): the four steps.
  assert.deepEqual(S.ratingCodes(), ['1', '2', '3', '4']);
  assert.equal(S.ratings().length, 4);
  // A saved scale with nobody on it stays that way; one with people keeps them.
  assert.deepEqual(S.normalizeScale({ v: 2, words: { 1: 'Definitely' }, candidates: [] }).candidates, []);
  assert.deepEqual(S.normalizeScale({ v: 3, candidates: [{ code: '4S', name: 'Sample' }] }).candidates.map((c) => [c.code, c.name, c.label, c.off]),
    [['4S', 'Sample', 'Opposed — Sample', false]]);
});

test('a phone never adds candidates of its own to the list the server sent', async () => {
  // The phone's copy of this code has no settings to read.
  const phone = await scaleWith('phone', undefined, { browser: 'bare' });
  assert.deepEqual(phone.defaultCandidates(), [], 'it has no list of its own: the same nobody for every campaign');
  // GET /api/scale from a server set to "none".
  const sent = wire(S.defaultScale());
  assert.deepEqual(phone.normalizeScale(sent).candidates, [], 'no opponents: none on the phone either');
  assert.deepEqual(phone.offeredCodes(phone.normalizeScale(sent)), ['1', '2', '3', '4']);
  // The scale as the sign-in carries it (stored: v, words, candidates).
  assert.deepEqual(phone.normalizeScale({ v: 1, words: { 1: 'Definitely' }, candidates: [] }).candidates, []);
  assert.deepEqual(phone.normalizeScale({ v: 2, candidates: [{ code: '4S', name: 'Sample' }] }).candidates.map((c) => c.code), ['4S']);
  // A campaign with its own list (as staging's): only its own.
  const listed = await scaleWith('listed', '4A:Hartwell:Opposed — Hartwell supporter;4B:Quist');
  assert.deepEqual(phone.normalizeScale(wire(listed.defaultScale())).candidates.map((c) => [c.code, c.name, c.off]), [['4A', 'Hartwell', false], ['4B', 'Quist', false]]);
  // Imagine Surrey's phones read what they always did.
  const surrey = await scaleWith('surrey', undefined);
  assert.deepEqual(wire(phone.normalizeScale(wire(surrey.defaultScale()))), wire(surrey.defaultScale()));
  const edited = surrey.normalizeScale({ v: 4, words: { 1: 'Definitely' }, candidates: [{ code: '4B', name: 'Brenda Locke' }, { code: '4D', name: 'McCallum', off: true, off_at: '2026-10-01T00:00:00.000Z' }] });
  assert.deepEqual(edited.candidates.map((c) => [c.code, c.off]), [['4B', false], ['4D', true], ['4F', true], ['4N', true], ['4C', true]],
    'the server still brings back a starting candidate a stored list lacks, off the list');
  assert.deepEqual(wire(phone.normalizeScale(wire(edited))), wire(edited));
  // A page is a browser whatever else it holds.
  const page = await scaleWith('page', undefined, { browser: 'page' });
  assert.deepEqual(page.normalizeScale(sent).candidates, []);
  assert.deepEqual(wire(page.normalizeScale(wire(edited))), wire(edited));
});

test('the server set to “none”: the scale it hands out, a knock, the filter, Today’s numbers', async () => {
  const s = ok(await mgr.get('/api/scale')).scale;
  assert.deepEqual(s.candidates, []);
  assert.deepEqual(s.steps.map((x) => x.word), ['Strong yes', 'Lean yes', 'Undecided', 'Opposed']);
  assert.equal(s.version, 0);
  ok(await knock(P.a, '4'), 'opposed, not sure who');
  ok(await knock(P.b, '1'));
  for (const code of SURREY_CODES) {
    const r = await knock(P.b, code);
    assert.equal(r.status, 400, code);
    assert.match(r.json.error, /is not on the scale/);
  }
  assert.equal(ok(await mgr.get(`/api/persons/${P.b.id}`)).person.rating, '1');
  // People → Opposed (the band's codes, as the screen sends them).
  const opposed = ok(await mgr.get(`/api/persons?rating=${S.codesInBand(s, 'opposed').join(',')}`)).persons;
  assert.deepEqual(opposed.map((p) => p.id), [P.a.id]);
  const support = ok(await mgr.get(`/api/persons?rating=${S.codesInBand(s, 'support').join(',')}`)).persons;
  assert.deepEqual(support.map((p) => p.id), [P.b.id]);
  // Today's numbers count by code.
  const ratings = ok(await mgr.get('/api/brief')).ratings;
  assert.deepEqual([Number(ratings['1']), Number(ratings['4'])], [1, 1]);
  assert.ok(Object.keys(ratings).every((c) => !SURREY_CODES.includes(c)));
});

test('the import: steps by code or words; an opponent’s name is not on the scale', async () => {
  const r = ok(await mgr.post('/api/data/import', {
    dryRun: true,
    rows: [
      { name: `Imp One ${tag}`, rating: 'strong yes' },
      { name: `Imp Two ${tag}`, rating: '4' },
      { name: `Imp Three ${tag}`, rating: 'Not sure' },
      { name: `Imp Four ${tag}`, rating: 'Locke' },
      { name: `Imp Five ${tag}`, rating: '4D' },
    ],
  }));
  assert.equal(r.created, 3);
  assert.deepEqual(r.invalid, ['row 4: rating “Locke” is not on the scale', 'row 5: rating “4D” is not on the scale']);
});

test('the sample people are rated with the steps only', async () => {
  ok(await mgr.post('/api/data/sample', {}));
  const db = await getDb();
  const codes = (await db.query(
    `select distinct rating from persons where workspace_id = $1 and tags @> '["sample"]'::jsonb and rating is not null`, [ws],
  )).rows.map((x) => x.rating).sort();
  assert.ok(codes.length >= 3, String(codes));
  assert.ok(codes.every((c) => ['1', '2', '3', '4'].includes(c)), `only the steps: ${codes}`);
});

test('the first candidate a manager adds is the whole list', async () => {
  const r = ok(await mgr.action('scale.save', { candidates: [{ name: 'Sample Opponent' }] }));
  assert.deepEqual(r.changes.added, [{ code: '4O', name: 'Sample Opponent' }]);
  assert.deepEqual(r.scale.candidates.map((c) => [c.code, c.name, c.label, c.off]), [['4O', 'Sample Opponent', 'Opposed — Sample Opponent', false]]);
  const s = ok(await mgr.get('/api/scale')).scale;
  assert.deepEqual(S.offeredCodes(s), ['1', '2', '3', '4', '4O']);
  ok(await knock(P.b, '4O'));
  assert.equal(S.ratingText(s, '4O'), '4 · Sample Opponent');
  // Taken off again: back to nobody offered, the old rating still readable.
  const off = ok(await mgr.action('scale.save', { candidates: [{ code: '4O', name: 'Sample Opponent', off: true }] }));
  assert.deepEqual(S.offeredCodes(off.scale), ['1', '2', '3', '4']);
  assert.equal(S.ratingText(off.scale, '4O'), '4 · Sample Opponent (off the list)');
  // What the sign-in carries is the list as saved: a phone reads the same.
  const me = ok(await mgr.get('/api/auth/me'));
  const phone = await scaleWith('phone2', undefined, { browser: 'bare' });
  assert.deepEqual(phone.normalizeScale(wire(me.workspace.settings.scale)).candidates.map((c) => [c.code, c.off]), [['4O', true]]);
});

test('a phone with no copy of the scale yet is told this server’s starting list at sign-in', async () => {
  // A campaign that has saved no scale: the sign-in carries none to read.
  const fresh = new Client();
  await fresh.signup({ workspaceName: `No scale yet ${tag}`, email: `none-fresh+${tag}@example.org` });
  const me = ok(await fresh.get('/api/auth/me'));
  assert.equal(me.workspace.settings.scale, undefined);
  assert.deepEqual(me.org.candidates, [], 'nobody: so the phone offers nobody, not its own fallback list');
  const phone = await scaleWith('phone3', undefined, { browser: 'bare' });
  assert.deepEqual(phone.offeredCodes(phone.normalizeScale({ candidates: wire(me).org.candidates })), ['1', '2', '3', '4']);
  // Before sign-in nothing about the scale is said.
  assert.equal(ok(await new Client().get('/api/auth/setup')).org.candidates, undefined);
});
