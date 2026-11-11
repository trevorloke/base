// One audience, everywhere — the list side:
//   · "Save these people as they are now": a hand-picked list of exactly who
//     a filter (or a list) names at that moment, in one write;
//   · each list's numbers — people · can be emailed · texted · called ·
//     reachable by any — kept for a minute, counted again when the list or
//     its people change, and never in the way of the list of names;
//   · People's real total, however long the list, and a call list that
//     carries on past its first load.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';

let db, mgr, vol, ws;
const P = {};
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
const tag = Math.random().toString(36).slice(2, 8);
const mail = (who) => `${who}.la.${tag}@example.org`;
const keep = process.env.STARBASE_LIST_COUNTS_MS;

before(async () => {
  db = await freshDb();
  mgr = new Client();
  ws = (await mgr.signup({ workspaceName: 'Imagine Surrey', email: mail('manager'), jurisdiction: 'bc-municipal' })).json.workspace.id;
  const inv = await mgr.action('member.invite', { email: mail('vol'), role: 'volunteer' });
  vol = new Client();
  ok(await vol.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: 'Vic Volunteer', password: 'lists-pass-2026' }));
  const mk = async (key, name, extra = {}) => { P[key] = await mgr.createPerson(name, extra); };
  await mk('ana', 'Ana Example', { email: mail('ana'), phone: '604-555-0121', tags: ['member'] });
  await mk('ben', 'Ben Example', { email: mail('ben'), phone: '604-555-0122', tags: ['member'] });
  await mk('cy', 'Cy Example', { phone: '604-555-0123', tags: ['member', 'do-not-contact'] });
  await mk('dee', 'Dee Example', { email: mail('dee'), tags: ['volunteer'] });
});
after(() => { if (keep === undefined) delete process.env.STARBASE_LIST_COUNTS_MS; else process.env.STARBASE_LIST_COUNTS_MS = keep; });

const namesOn = async (id) => ok(await mgr.get(`/api/lists/${id}`)).people.map((p) => p.name.split(' ')[0]);

test('“Save these people as they are now”: exactly who a filter names at that moment, and they stay', async () => {
  const snap = ok(await mgr.action('list.snapshot', { name: 'Members on Nov 10', filter: { tag: 'member', bogus: 'x' } }));
  assert.equal(snap.added, 3);
  assert.deepEqual([snap.list.kind, snap.list.filter], ['people', {}], 'a hand-picked list: no rule to follow');
  assert.deepEqual(await namesOn(snap.list.id), ['Ana', 'Ben', 'Cy']);
  // The people change; the saved list doesn't. The filter does.
  const live = ok(await mgr.action('list.create', { name: 'Members', kind: 'filter', filter: { tag: 'member' } })).list;
  ok(await mgr.action('person.update', { id: P.ana.id, tags: ['former'] }));
  ok(await mgr.action('person.update', { id: P.dee.id, tags: ['volunteer', 'member'] }));
  assert.deepEqual(await namesOn(snap.list.id), ['Ana', 'Ben', 'Cy']);
  assert.deepEqual(await namesOn(live.id), ['Ben', 'Cy', 'Dee']);
  // From a list as it stands; from everyone (no filter at all); a list that isn't there.
  const again = ok(await mgr.action('list.snapshot', { name: 'Members now', list_id: live.id }));
  assert.deepEqual(await namesOn(again.list.id), ['Ben', 'Cy', 'Dee']);
  assert.equal(ok(await mgr.action('list.snapshot', { name: 'Everyone today' })).added, 4);
  assert.equal(ok(await mgr.action('list.snapshot', { name: 'Nobody', filter: { tag: 'nobody-has-this' } })).added, 0);
  assert.equal((await mgr.action('list.snapshot', { name: 'x', list_id: randomUUID() })).status, 404);
  assert.equal((await mgr.action('list.snapshot', { name: 'x', list_id: live.id, filter: { tag: 'member' } })).status, 400, 'a filter or a list, not both');
  assert.equal((await vol.action('list.snapshot', { name: 'x', filter: {} })).status, 403);
  // Another campaign's people never come along.
  const other = new Client();
  await other.signup({ workspaceName: 'Elsewhere', email: mail('other') });
  await other.createPerson('Otto Elsewhere', { tags: ['member'] });
  assert.equal(ok(await other.action('list.snapshot', { name: 'Theirs', filter: { tag: 'member' } })).added, 1);
  // It is a list like any other: add, remove, and on the record.
  ok(await mgr.action('list.remove', { id: snap.list.id, person_ids: [P.cy.id] }));
  assert.deepEqual(await namesOn(snap.list.id), ['Ana', 'Ben']);
  const ev = ok(await mgr.get('/api/events?since=0&limit=1000')).events.filter((e) => e.action === 'list.snapshot');
  assert.deepEqual(ev[0].payload.as_of, { filter: { tag: 'member' } });
  assert.equal(ev[0].payload.added, 3);
  assert.equal(ev[1].payload.as_of.list_name, 'Members');
  assert.equal(ok(await mgr.get('/api/audit/verify')).ok, true);
});

test('a list’s numbers: people · by email · by text · by phone · reachable by any', async () => {
  const live = (await mgr.get('/api/lists')).json.lists.find((l) => l.name === 'Members');
  assert.deepEqual(live.counts, { total: 3, with_email: 2, with_phone: 1, with_call: 1, reachable: 2 },
    'Ben and Dee can be emailed; only Ben can be texted or called (Cy is do-not-contact, Dee has no number); Cy can’t be reached at all');
  assert.deepEqual(ok(await mgr.get(`/api/lists/${live.id}/counts`)), { id: live.id, counts: live.counts });
  assert.deepEqual(ok(await mgr.get('/api/lists/preview?tag=member')).counts, live.counts);
  assert.deepEqual(ok(await mgr.get(`/api/lists/${live.id}?reach=call`)).people.map((p) => p.name), ['Ben Example']);
  assert.equal((await vol.get(`/api/lists/${live.id}/counts`)).status, 403);
  assert.equal((await mgr.get(`/api/lists/${randomUUID()}/counts`)).status, 404);
});

test('counts are kept for a minute, counted again when the list or its people change, and never hold up the names', async () => {
  process.env.STARBASE_LIST_COUNTS_MS = '60000';
  const seen = [];
  const real = db.query.bind(db);
  db.query = (sql, params) => { seen.push(String(sql)); return real(sql, params); };
  const counting = () => seen.filter((s) => /count\(distinct/.test(s)).length;
  try {
    const every = ok(await mgr.get('/api/lists?counts=later')).lists;
    const live = every.find((l) => l.name === 'Members');
    const lists = every.length;
    // (Every list just changed, so nothing counted earlier in this file is still kept.)
    for (const l of every) ok(await mgr.action('list.update', { id: l.id, name: l.name }));
    // Names first: nothing is counted, and what isn't kept yet says so (null — never a zero).
    seen.length = 0;
    const later = ok(await mgr.get('/api/lists?counts=later')).lists;
    assert.equal(later.length, lists);
    assert.equal(counting(), 0, 'no list was counted for the names');
    assert.ok(later.every((l) => l.counts === null));
    // Asked for: counted once, then kept.
    const first = ok(await mgr.get(`/api/lists/${live.id}/counts`)).counts;
    assert.equal(counting(), 1);
    assert.deepEqual(ok(await mgr.get(`/api/lists/${live.id}/counts`)).counts, first);
    assert.deepEqual(ok(await mgr.get('/api/lists?counts=later')).lists.find((l) => l.id === live.id).counts, first, 'the names carry what is kept');
    assert.equal(counting(), 1, 'kept: not counted again');
    // The whole list of lists (an older screen still asks this way): each list once, then kept.
    seen.length = 0;
    ok(await mgr.get('/api/lists'));
    const cold = counting();
    assert.equal(cold, lists - 1, 'every list but the one already kept');
    ok(await mgr.get('/api/lists'));
    assert.equal(counting(), cold, 'a second load counts nothing');
    // Someone's tags change: the kept number stands for its minute…
    ok(await mgr.action('person.update', { id: P.ben.id, tags: ['former'] }));
    assert.deepEqual(ok(await mgr.get(`/api/lists/${live.id}/counts`)).counts, first);
    // …but one list's own page, and a send's "To", count now.
    assert.equal(ok(await mgr.get(`/api/lists/${live.id}`)).counts.total, first.total - 1);
    assert.equal(ok(await mgr.get(`/api/lists/${live.id}/counts`)).counts.total, first.total - 1, 'and what they counted is what is kept');
    ok(await mgr.action('person.update', { id: P.ben.id, tags: ['member'] }));
    assert.equal(ok(await mgr.get(`/api/lists/${live.id}/counts?fresh=1`)).counts.total, first.total);
    // The list itself changes — its filter, or who is on a hand-picked one: counted again at once.
    ok(await mgr.action('list.update', { id: live.id, filter: { tag: 'volunteer' } }));
    assert.equal(ok(await mgr.get(`/api/lists/${live.id}/counts`)).counts.total, 1);
    ok(await mgr.action('list.update', { id: live.id, filter: { tag: 'member' } }));
    const picked = ok(await mgr.action('list.create', { name: 'Picked', kind: 'people', person_ids: [P.ana.id] })).list;
    assert.equal(ok(await mgr.get(`/api/lists/${picked.id}/counts`)).counts.total, 1);
    await new Promise((r) => { setTimeout(r, 5); });
    ok(await mgr.action('list.add', { id: picked.id, person_ids: [P.ben.id, P.dee.id] }));
    assert.equal(ok(await mgr.get(`/api/lists/${picked.id}/counts`)).counts.total, 3);
    await new Promise((r) => { setTimeout(r, 5); });
    ok(await mgr.action('list.remove', { id: picked.id, person_ids: [P.ben.id] }));
    assert.equal(ok(await mgr.get(`/api/lists/${picked.id}/counts`)).counts.total, 2);
    // Many people at once (an import): every list is counted again.
    assert.equal(ok(await mgr.get(`/api/lists/${live.id}/counts`)).counts.total, 3);
    const imp = await mgr.post('/api/data/import', { rows: [{ name: 'Gil Imported Example', tags: 'member' }] });
    assert.equal(imp.status, 200, JSON.stringify(imp.json));
    assert.equal(ok(await mgr.get(`/api/lists/${live.id}/counts`)).counts.total, 4);
  } finally {
    db.query = real;
    process.env.STARBASE_LIST_COUNTS_MS = '0';
  }
});

test('People’s real total, and a call list that carries on past its first load', async () => {
  const other = new Client();
  const ows = (await other.signup({ workspaceName: 'A long list', email: mail('long') })).json.workspace.id;
  // 23 people, two of them with the very same name.
  for (let i = 0; i < 23; i += 1) {
    await db.query('insert into persons (id, workspace_id, name, phone, tags) values ($1, $2, $3, $4, $5)',
      [randomUUID(), ows, i === 7 || i === 8 ? 'Twin Example' : `Caller ${String(i).padStart(2, '0')} Example`, i % 5 === 0 ? null : `604-555-01${String(30 + i)}`, JSON.stringify(i % 2 ? ['odd'] : [])]);
  }
  assert.equal(ok(await other.get('/api/persons/count')).total, 23);
  assert.equal(ok(await other.get('/api/persons/count?has=phone')).total, 18);
  assert.equal(ok(await other.get('/api/persons/count?tag=odd&has=phone')).total, 9);
  assert.equal(ok(await other.get('/api/persons/count?q=twin')).total, 2);
  assert.equal(ok(await other.get('/api/persons/count?knocked=nonsense')).total, 0);
  // The rows stop at their limit and say whether anyone comes after.
  const page = async (after) => ok(await other.get(`/api/persons?has=phone&limit=5${after ? `&after=${after}` : ''}`));
  const all = [];
  let cursor = null;
  for (let n = 0; n < 10; n += 1) {
    const p = await page(cursor);
    all.push(...p.persons);
    if (!p.more) break;
    assert.equal(p.persons.length, 5);
    cursor = p.persons.at(-1).id;
  }
  assert.equal(all.length, 18, 'every person with a phone, once');
  assert.equal(new Set(all.map((p) => p.id)).size, 18);
  assert.deepEqual(all.map((p) => p.name), [...all.map((p) => p.name)].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())), 'in the list’s order');
  assert.equal(all.filter((p) => p.name === 'Twin Example').length, 2, 'two people of one name are both there');
  const first = ok(await other.get('/api/persons?limit=300'));
  assert.deepEqual([first.persons.length, first.more], [23, false]);
  assert.deepEqual(ok(await other.get(`/api/persons?after=${randomUUID()}`)).persons, [], 'after someone who isn’t here: no one');
  assert.deepEqual(ok(await other.get('/api/persons?after=nonsense')).persons, []);
  // Someone leaves the list between two loads (they voted): the next load still starts after the last name shown.
  const one = await page(null);
  await db.query('update persons set phone = null where id = $1', [one.persons[1].id]);
  const two = await page(one.persons.at(-1).id);
  assert.equal(two.persons[0].id, all[5].id);
  // Another campaign's person is never a place to start from.
  assert.deepEqual(ok(await mgr.get(`/api/persons?after=${all[3].id}`)).persons, []);
  // A volunteer's count follows the same rules as their list.
  assert.equal(ok(await vol.get('/api/persons/count?tag=donor-prospect')).total, 0);
  assert.ok(ok(await vol.get('/api/persons/count')).total >= 4);
});

test('the list as a spreadsheet still downloads', async () => {
  const live = (await mgr.get('/api/lists')).json.lists.find((l) => l.name === 'Members');
  const csv = await app.request(`/api/lists/${live.id}/export.csv`, { headers: { cookie: mgr.cookie } });
  assert.equal(csv.status, 200);
  assert.match(await csv.text(), /^﻿?Name,Email,Phone/);
});
