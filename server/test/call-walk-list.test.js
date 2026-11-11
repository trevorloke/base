// Call this list, walk this list — a List feeds the phones and the doors,
// not only email and text:
//   · a phone bank made from a list: the server reads the list itself, so
//     there is no cap on how many (a bank picked by hand still takes 5,000
//     a call); someone who leaves the list (voted, re-rated, do-not-contact)
//     leaves the calls not yet made, at once and with no write — a call
//     already logged stays logged; someone who joins it later comes in on a
//     top-up; the list can't be deleted while an open bank calls it, and a
//     closed bank keeps its numbers when it is;
//   · the Calls read takes ?list= and moves on past its first load (?after=);
//   · a sweep (pass) that walks a list: only doors with someone on it, as
//     the list stands at each load; who narrows it further; the list can't
//     be deleted while the open pass walks it; a volunteer gets the doors,
//     never the list's name.
// test:pg-safe: unique emails per run, everything scoped to this campaign.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb, Client } from './helpers.js';
import { passLine } from '@starbase/shared/passes';

let db, mgr, vic, ws;
const ids = {};
const P = {};
const tag = Math.random().toString(36).slice(2, 8);
const mail = (who) => `${who}.cwl.${tag}@example.org`;
const ok = (r, msg = '') => { assert.equal(r.status, 200, `${msg} ${JSON.stringify(r.json)}`); return r.json; };
const lat = 49.1327; const lng = -122.855;

before(async () => {
  db = await freshDb();
  mgr = new Client();
  ws = (await mgr.signup({ workspaceName: 'Imagine Surrey', email: mail('manager'), jurisdiction: 'bc-municipal' })).json.workspace.id;
  const inv = await mgr.action('member.invite', { email: mail('vic'), role: 'volunteer' });
  vic = new Client();
  ids.vic = ok(await vic.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: 'Vic Example', password: 'cwl-pass-2026' })).user.id;
});

// ── Call this list ──

test('a bank made from a list takes everyone on it who can be called — past the 5,000 a bank picked by hand may take', async () => {
  // 5,100 people on one list (a city's lists are bigger than any snapshot).
  await db.query(
    `insert into persons (id, workspace_id, name, phone, tags)
     select gen_random_uuid(), $1, 'Bulk ' || lpad(g::text, 5, '0') || ' Example', '604-555-' || lpad((g % 10000)::text, 4, '0'), '["bulk"]'::jsonb
       from generate_series(1, 5100) g`, [ws],
  );
  await mgr.createPerson('Bulk Nophone Example', { tags: ['bulk'] });
  await mgr.createPerson('Bulk Nocall Example', { phone: '604-555-0999', tags: ['bulk', 'do-not-contact'] });
  const list = ok(await mgr.action('list.create', { name: 'Everyone bulk', kind: 'filter', filter: { tag: 'bulk' } })).list;
  ids.bulkList = list.id;
  const made = ok(await mgr.action('bank.create', { name: 'Bulk calls', list_id: list.id }));
  assert.equal(made.added, 5100);
  assert.equal(made.skipped, 2, 'no phone, and do-not-contact');
  assert.deepEqual([made.bank.total, made.bank.open, made.bank.gone, made.bank.list_name], [5100, 5100, 0, 'Everyone bulk']);
  // By hand, 5,000 ids a call is still the limit.
  const many = (await db.query("select id from persons where workspace_id = $1 and tags @> '\"bulk\"' order by name limit 5001", [ws])).rows.map((r) => r.id);
  assert.equal((await mgr.action('bank.create', { name: 'Too many by hand', person_ids: many })).status, 400);
  assert.equal(ok(await mgr.action('bank.create', { name: 'By hand', person_ids: many.slice(0, 3) })).added, 3, 'the hand-picked form still works');
  // A list, or people picked by hand — not both; a list that isn't this campaign's.
  assert.equal((await mgr.action('bank.create', { name: 'x', list_id: list.id, person_ids: many.slice(0, 1) })).status, 400);
  assert.equal((await mgr.action('bank.create', { name: 'x', list_id: randomUUID() })).status, 404);
  assert.equal((await vic.action('bank.create', { name: 'x', list_id: list.id })).status, 403);
  // The desk's bank page: the counts are the whole bank; its numbers come 2,000 at a time.
  const page1 = ok(await mgr.get(`/api/banks/${made.bank.id}`));
  assert.equal(page1.bank.total, 5100);
  assert.equal(page1.bank.list_name, 'Everyone bulk');
  assert.equal(page1.numbers.length, 2000);
  const page3 = ok(await mgr.get(`/api/banks/${made.bank.id}?offset=4000`));
  assert.equal(page3.numbers.length, 1100);
  assert.equal(page3.numbers.at(-1).name, 'Bulk 05100 Example', 'in the list’s order, by name');
  assert.ok(page3.numbers.every((n) => n.still === true));
  const listed = ok(await mgr.get('/api/banks')).banks.find((b) => b.id === made.bank.id);
  assert.deepEqual([listed.total, listed.list_name], [5100, 'Everyone bulk']);
});

test('the Calls read takes a list and moves on past its first 300', async () => {
  assert.equal(ok(await mgr.get(`/api/persons/count?list=${ids.bulkList}&has=phone`)).total, 5101, 'every one with a phone, do-not-contact too: Calls shows the chip');
  const seen = new Set();
  let after = '';
  let loads = 0;
  for (;;) {
    const page = ok(await mgr.get(`/api/persons?list=${ids.bulkList}&has=phone&limit=300${after ? `&after=${after}` : ''}`));
    loads += 1;
    for (const p of page.persons) seen.add(p.id);
    if (loads === 1) assert.deepEqual([page.persons.length, page.more], [300, true], 'the first load says more are coming');
    if (!page.more) break;
    after = page.persons.at(-1).id;
  }
  assert.equal(seen.size, 5101, 'everyone, once each');
  assert.equal(loads, 18);
  // A volunteer never sorts people by the desk's lists.
  assert.deepEqual(ok(await vic.get(`/api/persons?list=${ids.bulkList}&limit=5`)).persons, []);
});

test('Calls asks only for who may be called (or texted), counts the same, and a part already loaded keeps its place', async () => {
  const q = `list=${ids.bulkList}&has=phone`;
  // The one place decides: the do-not-contact one is out of the rows and the count alike.
  assert.equal(ok(await mgr.get(`/api/persons/count?${q}&reach=call`)).total, 5100);
  const first = ok(await mgr.get(`/api/persons?${q}&reach=call&limit=300`));
  assert.equal(first.more, true);
  const nocall = (await db.query("select id from persons where workspace_id = $1 and name = 'Bulk Nocall Example'", [ws])).rows[0].id;
  let seen = 0;
  let after = '';
  for (;;) {
    const page = ok(await mgr.get(`/api/persons?${q}&reach=call&limit=2000${after ? `&after=${after}` : ''}`));
    assert.ok(!page.persons.some((p) => p.id === nocall));
    seen += page.persons.length;
    if (!page.more) break;
    after = page.persons.at(-1).id;
  }
  assert.equal(seen, 5100);
  // A text: a number that replied STOP is out, whoever carries it (no tag needed).
  const stopped = first.persons[0];
  await db.query(`insert into texting_optouts (id, workspace_id, phone, opted_out) values ($1, $2, $3, true)`, [randomUUID(), ws, `+1${stopped.phone.replace(/\D/g, '')}`]);
  const texts = ok(await mgr.get(`/api/persons?${q}&reach=text&limit=300`)).persons;
  assert.ok(!texts.some((p) => p.id === stopped.id), 'STOP: not on the text list');
  assert.ok(ok(await mgr.get(`/api/persons?${q}&reach=call&limit=300`)).persons.some((p) => p.id === stopped.id), '…still on the call list');
  assert.equal(ok(await mgr.get(`/api/persons/count?${q}&reach=text`)).total, 5099);
  // A reach it doesn't know, or a bad place to stop: nobody, never everybody.
  assert.deepEqual(ok(await mgr.get(`/api/persons?${q}&reach=fax`)).persons, []);
  assert.equal(ok(await mgr.get(`/api/persons/count?${q}&reach=fax`)).total, 0);
  assert.deepEqual(ok(await mgr.get(`/api/persons?${q}&until=nope`)).persons, []);
  // ?until=: the first part asked again — someone new on the list before its
  // last name comes in, and nobody at its end is pushed out.
  const last = first.persons.at(-1);
  const joiner = await mgr.createPerson('Bulk 00000 Example', { phone: '604-555-0998', tags: ['bulk'] });
  const again = ok(await mgr.get(`/api/persons?${q}&reach=call&until=${last.id}&limit=2000`)).persons;
  assert.equal(again.length, 301);
  assert.equal(again[0].id, joiner.id);
  assert.equal(again.at(-1).id, last.id, 'it still ends where it ended');
  const next = ok(await mgr.get(`/api/persons?${q}&reach=call&after=${last.id}&limit=300`)).persons;
  assert.ok(next.length === 300 && !next.some((p) => again.some((a) => a.id === p.id)), 'the next part starts after it: nobody twice, nobody missed');
  // A volunteer's calls follow the same rule: the do-not-contact one is never theirs to call.
  const theirs = ok(await vic.get('/api/persons?tag=bulk&has=phone&reach=call&limit=2000'));
  assert.ok(theirs.more && !theirs.persons.some((p) => p.id === nocall));
  assert.equal(ok(await vic.get('/api/persons/count?tag=bulk&has=phone&reach=call')).total, 5101, 'the 5,100 and the one who joined');
});

test('handing out a big bank is one write: any count, in the bank’s order, in turn across a team; a caller’s list comes 500 at a time', async () => {
  const bank = ok(await mgr.get('/api/banks')).banks.find((b) => b.name === 'Bulk calls');
  const me = ok(await mgr.get('/api/auth/me')).user.id;
  // More than the 5,000 one call once took, to one caller.
  const first = ok(await mgr.action('bank.assign', { id: bank.id, user_id: ids.vic, count: 5050 }));
  assert.deepEqual([first.handed, first.given, first.open], [5050, { [ids.vic]: 5050 }, 50]);
  // The rest to a team of two, in turn, starting with whoever joined the team first.
  const team = ok(await mgr.action('team.create', { name: 'Bulk callers' })).team;
  ok(await mgr.action('team.member.add', { team_id: team.id, user_id: ids.vic }));
  ok(await mgr.action('team.member.add', { team_id: team.id, user_id: me }));
  const rest = ok(await mgr.action('bank.assign', { id: bank.id, team_id: team.id }));
  assert.deepEqual([rest.handed, rest.given, rest.open, rest.assigned], [50, { [ids.vic]: 25, [me]: 25 }, 0, 5100]);
  const edge = ok(await mgr.get(`/api/banks/${bank.id}?offset=5048&limit=6`)).numbers;
  assert.deepEqual(edge.map((n) => n.assigned_to), [ids.vic, ids.vic, ids.vic, me, ids.vic, me], 'in the bank’s order');
  assert.equal(ok(await mgr.action('bank.assign', { id: bank.id, user_id: me })).handed, 0, 'nothing left to hand out');
  // Vic's list: the first 500 to call, and how many in all — never five thousand people to a phone.
  const mine = ok(await vic.get(`/api/banks/${bank.id}/mine`));
  assert.deepEqual([mine.persons.length, mine.bank.total, mine.bank.done, mine.bank.left], [500, 5075, 0, 5075]);
  assert.equal(mine.persons[0].name, 'Bulk 00001 Example');
  // A call logged: that number is crossed off, and the next one comes in at the end.
  ok(await vic.action('contact.log', { person_id: mine.persons[0].id, channel: 'phone', outcome: 'contacted' }));
  const next = ok(await vic.get(`/api/banks/${bank.id}/mine`));
  assert.deepEqual([next.persons.length, next.bank.total, next.bank.done, next.bank.left], [500, 5075, 1, 5074]);
  assert.deepEqual([next.persons[0].id, next.persons[498].id], [mine.persons[1].id, mine.persons[499].id]);
  assert.equal(ok(await vic.get('/api/banks/mine')).banks.find((b) => b.id === bank.id).left, 5074);
  ok(await mgr.action('bank.release', { id: bank.id }));
});

test('someone who leaves the list leaves the calls not yet made; a call already logged stays; someone back on it comes back', async () => {
  const mk = async (key, name, phone) => { P[key] = await mgr.createPerson(name, { phone, tags: ['gotv'] }); };
  await mk('ana', 'Ana Gotv Example', '604-555-0201');
  await mk('ben', 'Ben Gotv Example', '604-555-0202');
  await mk('cy', 'Cy Gotv Example', '604-555-0203');
  await mk('dee', 'Dee Gotv Example', '604-555-0204');
  await mk('eve', 'Eve Gotv Example', '604-555-0205');
  for (const k of ['ana', 'ben', 'cy', 'dee', 'eve']) ok(await mgr.action('contact.log', { person_id: P[k].id, channel: 'door', outcome: 'contacted', rating: '1' }));
  const list = ok(await mgr.action('list.create', { name: 'Supporters not voted', kind: 'filter', filter: { tag: 'gotv', rating: '1,2', voted: 'no' } })).list;
  ids.gotvList = list.id;
  const bank = ok(await mgr.action('bank.create', { name: 'Get out the vote calls', list_id: list.id })).bank;
  ids.gotvBank = bank.id;
  assert.equal(bank.total, 5);
  ok(await mgr.action('bank.assign', { id: bank.id, user_id: ids.vic }));
  const names = async () => ok(await vic.get(`/api/banks/${bank.id}/mine`)).persons.map((p) => p.name.split(' ')[0]);
  assert.deepEqual(await names(), ['Ana', 'Ben', 'Cy', 'Dee', 'Eve']);
  // Dee is called first; then the day goes on.
  ok(await vic.action('contact.log', { person_id: P.dee.id, channel: 'phone', outcome: 'contacted' }));
  ok(await mgr.action('vote.mark', { person_id: P.ana.id }));                                          // Ana voted
  ok(await mgr.action('contact.log', { person_id: P.ben.id, channel: 'door', outcome: 'contacted', rating: '4' })); // Ben re-rated at the door
  ok(await mgr.action('person.update', { id: P.cy.id, tags: ['gotv', 'do-not-contact'] }));          // Cy asked not to be called
  ok(await mgr.action('vote.mark', { person_id: P.dee.id }));                                          // Dee voted after the call
  assert.deepEqual(await names(), ['Eve'], 'off the caller’s list at once');
  const mineAll = ok(await vic.get(`/api/banks/${bank.id}/mine`)).bank;
  assert.deepEqual([mineAll.total, mineAll.done], [2, 1], 'Dee’s call stays counted; the three who left are out of the count');
  assert.equal(ok(await vic.get('/api/banks/mine')).banks.find((b) => b.id === bank.id).left, 1);
  const desk = ok(await mgr.get(`/api/banks/${bank.id}`));
  assert.deepEqual([desk.bank.total, desk.bank.done, desk.bank.gone, desk.bank.open], [5, 1, 3, 0]);
  const dee = desk.numbers.find((n) => n.person_id === P.dee.id);
  assert.equal(dee.outcome, 'contacted', 'the call is still on the record');
  assert.deepEqual(desk.numbers.filter((n) => !n.still).map((n) => n.name.split(' ')[0]).sort(), ['Ana', 'Ben', 'Cy', 'Dee']);
  assert.deepEqual(desk.bank.callers.map((c) => [c.name, c.total, c.done]), [['Vic Example', 2, 1]]);
  const row = ok(await mgr.get('/api/banks')).banks.find((b) => b.id === bank.id);
  assert.deepEqual([row.total, row.done, row.open, row.gone, row.callers.map((c) => [c.total, c.done])], [5, 1, 0, 3, [[2, 1]]],
    'the list of banks says what the bank’s page says');
  // Ana's vote is taken back (marked by mistake): she is on the list again, so on the calls again.
  ok(await mgr.action('vote.mark', { person_id: P.ana.id, voted: false }));
  assert.deepEqual(await names(), ['Ana', 'Eve']);
});

test('someone who joins the list later comes in on a top-up; only numbers still to call are handed out', async () => {
  const fay = await mgr.createPerson('Fay Gotv Example', { phone: '604-555-0206', tags: ['gotv'] });
  ok(await mgr.action('contact.log', { person_id: fay.id, channel: 'door', outcome: 'contacted', rating: '2' }));
  ok(await mgr.action('bank.release', { id: ids.gotvBank, user_id: ids.vic }));
  const up = ok(await mgr.action('bank.topup', { id: ids.gotvBank }));
  assert.equal(up.added, 1);
  assert.equal(up.total, 6);
  assert.equal(ok(await mgr.action('bank.topup', { id: ids.gotvBank })).added, 0, 'nobody new: nothing added twice');
  // Ben (re-rated) and Cy (do-not-contact) stay behind; Ana, Eve and Fay are handed out.
  const given = ok(await mgr.action('bank.assign', { id: ids.gotvBank, user_id: ids.vic }));
  assert.equal(given.handed, 3);
  assert.deepEqual(ok(await vic.get(`/api/banks/${ids.gotvBank}/mine`)).persons.map((p) => p.name.split(' ')[0]), ['Ana', 'Eve', 'Fay']);
  const byHand = (await mgr.get('/api/banks')).json.banks.find((b) => b.name === 'By hand');
  assert.equal((await mgr.action('bank.topup', { id: byHand.id })).status, 409, 'a bank picked by hand has no list to follow');
  assert.equal((await vic.action('bank.topup', { id: ids.gotvBank })).status, 403);
  // An open bank calls the list: it can't be deleted from under it — everyone who had left would be back on the calls.
  const refused = await mgr.action('list.delete', { id: ids.gotvList });
  assert.equal(refused.status, 409);
  assert.match(refused.json.error, /“Get out the vote calls” calls this list — close it first/);
  assert.deepEqual(ok(await vic.get(`/api/banks/${ids.gotvBank}/mine`)).persons.map((p) => p.name.split(' ')[0]), ['Ana', 'Eve', 'Fay']);
  // Closed, the calling is over: the list can go, and the bank keeps the numbers it has.
  ok(await mgr.action('bank.update', { id: ids.gotvBank, closed: true }));
  ok(await mgr.action('list.delete', { id: ids.gotvList }));
  assert.deepEqual(ok(await vic.get(`/api/banks/${ids.gotvBank}/mine`)).persons.map((p) => p.name.split(' ')[0]), ['Ana', 'Eve', 'Fay']);
  assert.equal((await mgr.action('bank.topup', { id: ids.gotvBank })).status, 409);
  assert.equal(ok(await mgr.get(`/api/banks/${ids.gotvBank}`)).bank.list_name, null);
  assert.equal(ok(await mgr.get('/api/audit/verify')).ok, true);
});

// ── Walk this list ──

test('a sweep that walks a list: only doors with someone on it, as the list stands at each load', async () => {
  const mk = async (key, name, address, dLng, tags) => { P[key] = await mgr.createPerson(name, { address, lat, lng: lng + dLng, tags }); };
  await mk('wa', 'Wanda Walk Example', '13213 72 Ave', 0.0000, ['walk']);
  await mk('wb', 'Wes Walk Example', '13225 72 Ave', 0.0003, []);
  await mk('wc', 'Win Walk Example', '13224 72 Ave', 0.0003, ['walk']);
  await mk('wd', 'Wyn Walk Example', '13212 72 Ave', 0.0000, []);
  await mk('we', 'Wil Walk Example', '13212 72 Ave', 0.0000, ['walk']); // a second person at Wyn's door
  const turf = ok(await mgr.action('turf.create', {
    name: 'Newton block', polygon: [[lat + 0.001, lng - 0.001], [lat + 0.001, lng + 0.002], [lat - 0.001, lng + 0.002], [lat - 0.001, lng - 0.001]],
  })).turf;
  ok(await mgr.action('turf.assign', { turf_id: turf.id, user_id: ids.vic }));
  const list = ok(await mgr.action('list.create', { name: 'Walk these', kind: 'filter', filter: { tag: 'walk' } })).list;
  const walk = async (c = mgr) => ok(await c.get(`/api/turfs/${turf.id}/walk`));
  const doors = async (c = mgr) => (await walk(c)).doors.map((d) => d.address);
  const turfRow = async (c = mgr) => ok(await c.get('/api/turfs')).turfs.find((t) => t.id === turf.id);
  assert.equal((await turfRow()).doors, 4, 'no pass: every door');
  assert.equal((await mgr.action('pass.start', { name: 'x', kind: 'persuasion', list_id: randomUUID() })).status, 404);
  const pass = ok(await mgr.action('pass.start', { name: 'Walk the list', kind: 'persuasion', list_id: list.id, tries: 2 })).pass;
  assert.deepEqual([pass.list_id, pass.list_name], [list.id, 'Walk these']);
  assert.deepEqual(await doors(), ['13213 72 Ave', '13224 72 Ave', '13212 72 Ave'], 'Wes’s door: nobody there is on the list');
  assert.equal((await turfRow()).doors, 3);
  // The volunteer walks the same doors, and never learns the list's name.
  assert.deepEqual(await doors(vic), ['13213 72 Ave', '13224 72 Ave', '13212 72 Ave']);
  const wyn = (await walk(vic)).doors.find((d) => d.address === '13212 72 Ave');
  assert.deepEqual(wyn.persons.map((p) => [p.name.split(' ')[0], p.pass_listed]).sort(), [['Wil', true], ['Wyn', false]]);
  const theirs = ok(await vic.get('/api/passes')).open;
  assert.equal(theirs.list_id, list.id);
  assert.equal(theirs.list_name, undefined);
  assert.equal(ok(await mgr.get('/api/passes')).open.list_name, 'Walk these');
  assert.equal(passLine({ ...pass, list_name: 'Walk these' }), 'Persuasion · List: Walk these · 2 tries');
  // Wanda's door: no answer — it comes back. Then she leaves the list, and her door leaves the walk.
  ok(await mgr.action('contact.log', { person_id: P.wa.id, channel: 'door', outcome: 'no_answer' }));
  assert.equal((await walk()).doors.find((d) => d.address === '13213 72 Ave').state, 'again');
  ok(await mgr.action('person.update', { id: P.wa.id, tags: [] }));
  ok(await mgr.action('person.update', { id: P.wb.id, tags: ['walk'] }));
  assert.deepEqual(await doors(), ['13225 72 Ave', '13224 72 Ave', '13212 72 Ave'], 'Wes joined, Wanda left');
  assert.equal(ok(await mgr.get('/api/passes')).open.stats.doors_knocked, 1, 'the knock stays on the record');
  // Who narrows the list further: only supporters on it.
  ok(await mgr.action('contact.log', { person_id: P.wc.id, channel: 'door', outcome: 'contacted', rating: '1' }));
  const narrowed = ok(await mgr.action('pass.update', { id: pass.id, who: 'support' })).pass;
  assert.equal(passLine(narrowed), 'Persuasion · List: Walk these · Yes (1–2) · 2 tries');
  assert.deepEqual(await doors(), ['13224 72 Ave']);
  // Every door again (the list taken off the pass), then a hand-picked list.
  ok(await mgr.action('pass.update', { id: pass.id, who: 'all', list_id: null }));
  assert.equal((await turfRow()).doors, 4);
  const picked = ok(await mgr.action('list.create', { name: 'Picked doors', kind: 'people', person_ids: [P.wd.id] })).list;
  ok(await mgr.action('pass.update', { id: pass.id, list_id: picked.id }));
  assert.deepEqual(await doors(), ['13212 72 Ave']);
  // The open pass walks it: the list can't be deleted until the pass ends.
  const del = await mgr.action('list.delete', { id: picked.id });
  assert.equal(del.status, 409);
  assert.match(del.json.error, /Walk the list/);
  ok(await mgr.action('pass.end', { id: pass.id }));
  ok(await mgr.action('list.delete', { id: picked.id }));
  assert.equal((await turfRow()).doors, 4, 'no pass open: every door');
});

test('a get-out-the-vote sweep of a list leaves a door once everyone on the list there has voted', async () => {
  const list = (await mgr.get('/api/lists')).json.lists.find((l) => l.name === 'Walk these');
  ok(await mgr.action('pass.start', { name: 'GOTV walk', kind: 'gotv', list_id: list.id }));
  const turf = (await mgr.get('/api/turfs')).json.turfs.find((t) => t.name === 'Newton block');
  const doors = async () => ok(await mgr.get(`/api/turfs/${turf.id}/walk`)).doors.map((d) => d.address);
  assert.deepEqual(await doors(), ['13225 72 Ave', '13224 72 Ave', '13212 72 Ave']);
  ok(await mgr.action('vote.mark', { person_id: P.we.id }));
  assert.deepEqual(await doors(), ['13225 72 Ave', '13224 72 Ave'], 'Wil voted; Wyn is not on the list');
});
