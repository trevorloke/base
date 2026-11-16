// Finding a person (GET /api/search/people, ext/search): the start of each
// part of a name in any order, accents and apostrophes ignored; a phone with
// or without its area code; a house number; an email's start on the desk.
// Pages in A–Z order with an exact count, or "more than" past the cap; the
// fold the server indexes is the browser's, letter for letter.
// test:pg-safe: unique emails per run, everything scoped to this campaign.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb, Client } from './helpers.js';
import { FOLD_FROM, FOLD_TO, foldName, foldTerm, azSort } from '@starbase/shared/names';
import { setSearchCap, setSearchTrace } from '../ext/search/index.js';

let db, mgr, vol, ws;
const P = {};
const tag = Math.random().toString(36).slice(2, 8);
const mail = (who) => `${who}.srch.${tag}@example.org`;
const ok = (r, msg = '') => { assert.equal(r.status, 200, `${msg} ${JSON.stringify(r.json)}`); return r.json; };
const SAMPLE_FIRST = ['Zoë', 'Aaron', 'Bea', 'Cal', 'Dana', 'Eli', 'Fay', 'Gus', 'Hana', 'Ivo', 'Jade', 'Kai', 'Lia', 'Max', 'Nia', 'Oli', 'Pia', 'Quin', 'Raj', 'Sia',
  'Tao', 'Uma', 'Vic', 'Wes', 'Xia', 'Yan', 'Zed', 'Ada', 'Ben', 'Cy', 'Dev', 'Eve', 'Finn', 'Gia', 'Hal', 'Ian', 'Joy', 'Kit', 'Lou', 'Mo'];

const add = async (name, extra = {}) => {
  const id = randomUUID();
  await db.query(
    `insert into persons (id, workspace_id, kind, name, phone, email, address, city)
     values ($1, $2, $3, $4, $5, $6, $7, 'Surrey')`,
    [id, ws, extra.kind || 'person', name, extra.phone || null, extra.email || null, extra.address || null],
  );
  return id;
};

before(async () => {
  db = await freshDb();
  mgr = new Client();
  ws = (await mgr.signup({ workspaceName: 'Imagine Surrey', email: mail('manager') })).json.workspace.id;
  const inv = await mgr.action('member.invite', { email: mail('vol'), role: 'volunteer' });
  vol = new Client();
  ok(await vol.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: 'Vol Example', password: 'search-pass-2026' }));
  for (const [i, f] of SAMPLE_FIRST.entries()) P[`sample${i}`] = await add(`${f} Sample`, { address: `${200 + i} Sample St` });
  P.kevin1 = await add('Kevin Smith', { address: '101 First St', phone: '604-555-0101' });
  P.kevin2 = await add('Kevin Smith', { address: '102 Second St' });
  P.kevin3 = await add('Kevin Smith', { address: '103 Third St' });
  P.kevinJr = await add('Kevin Smith Jr', { address: '104 Fourth St' });
  P.jose1 = await add('José Example');
  P.jose2 = await add('Jose Example');
  P.berg = await add('Jo Van Der Berg');
  P.gill = await add('Amrit Sandhu-Gill');
  P.dsouza = await add("Dee D'Souza");
  P.anne = await add('Mary Anne Example');
  P.jean = await add('Jean-Luc Example');
  P.thi = await add('Thi Nguyễn Example');
  P.society = await add('Surrey Example Society', { kind: 'org' });
  P.lena = await add('Lena Example', { phone: '604-555-0142', email: 'lena@example.org', address: '14520 72 Ave' });
  P.omar = await add('Omar Example', { phone: '(778) 555-0199', email: 'omar.k@example.org' });
  P.pat = await add('Pat Example', { phone: '+1 604 555 0177 ext. 22' });
  // 51 who share one surname: past the cap once it is lowered to 50.
  await db.query(
    `insert into persons (id, workspace_id, name) select gen_random_uuid(), $1, 'Bn' || chr(65 + (g % 26)) || g || ' Bigname' from generate_series(1, 51) g`, [ws],
  );
  // A list of 600, and ten more of the same surname who aren't on it.
  await db.query(
    `insert into persons (id, workspace_id, name) select gen_random_uuid(), $1, 'Lm' || lpad(g::text, 3, '0') || ' Listmember' from generate_series(1, 610) g`, [ws],
  );
  P.list = ok(await mgr.action('list.create', { name: 'Six hundred', kind: 'people' })).list.id;
  await db.query(
    `insert into list_members (list_id, workspace_id, person_id)
     select $2, $1, id from persons where workspace_id = $1 and last_name = 'Listmember' and name <= 'Lm600 Listmember'`, [ws, P.list],
  );
  for (const k of [0, 1, 2]) {
    await db.query('insert into volunteer_roles (id, workspace_id, person_id, role) values ($1, $2, $3, $4)', [randomUUID(), ws, P[`sample${k}`], 'driver']);
  }
  await db.query('analyze persons');
});

const ask = async (q, more = '', who = mgr) => ok(await who.get(`/api/search/people?q=${encodeURIComponent(q)}${more}`), q);
const names = async (q, more = '&limit=50', who = mgr) => (await ask(q, more, who)).persons.map((p) => p.name);

test('a surname: the exact count, 25 a page in A–Z order, and the rest after the 25th — no repeats, no gaps', async () => {
  const one = await ask('sample', '&limit=25');
  assert.deepEqual([one.total, one.many, one.more, one.persons.length], [40, false, true, 25]);
  const two = await ask('sample', `&limit=25&after=${one.persons.at(-1).id}`);
  assert.deepEqual([two.total, two.many, two.more, two.persons.length], [null, false, false, 15]);
  const all = [...one.persons, ...two.persons];
  assert.equal(new Set(all.map((p) => p.id)).size, 40);
  assert.deepEqual(all.map((p) => p.id), [...all].sort(azSort).map((p) => p.id), 'A–Z, the browser’s order too');
  assert.equal(all[0].name, 'Aaron Sample');
  assert.ok(all.some((p) => p.name === 'Zoë Sample'));
  assert.deepEqual(await names('zoe'), ['Zoë Sample'], 'an accent not typed');
});

test('a name every way round; accents, apostrophes, two-part and hyphenated surnames, middle names', async () => {
  const kevins = ['Kevin Smith', 'Kevin Smith', 'Kevin Smith', 'Kevin Smith Jr'];
  for (const q of ['kevin smith', 'smith kevin', 'Smith, Kevin', 'kev smi']) assert.deepEqual((await names(q)).sort(), kevins, q);
  for (const q of ['jose', 'josé', 'josé']) assert.deepEqual((await names(q)).sort(), ['Jose Example', 'José Example'], q);
  assert.deepEqual(await names('nguyen'), ['Thi Nguyễn Example']);
  for (const q of ['berg', 'van der berg']) assert.deepEqual(await names(q), ['Jo Van Der Berg'], q);
  assert.deepEqual(await names('gill'), ['Amrit Sandhu-Gill']);
  for (const q of ['dsouza', "d'souza", 'd’souza']) assert.deepEqual(await names(q), ["Dee D'Souza"], q);
  assert.deepEqual(await names('anne'), ['Mary Anne Example']);
  for (const q of ['jean luc', 'jean-luc']) assert.deepEqual(await names(q), ['Jean-Luc Example'], q);
  assert.deepEqual(await names('surrey ex'), ['Surrey Example Society']);
  // The middle of a word, a later part of a hyphenated first name or a group's name: not found.
  for (const q of ['ena', 'der', 'luc', 'society', 'l', '50%_\\']) assert.deepEqual(await names(q), [], q);
});

test('a phone with or without its area code, a house number, an address; two digits alone ask for more', async () => {
  for (const q of ['604 555 0142', '555 0142', '(604) 555-0142', '+1 604 555 0142']) assert.deepEqual(await names(q), ['Lena Example'], q);
  assert.deepEqual((await names('604 555 01')).sort(), ['Kevin Smith', 'Lena Example', 'Pat Example']);
  for (const q of ['145', '14520', '14520 72', '14520 72 AVE']) assert.deepEqual(await names(q), ['Lena Example'], q);
  const two = await ask('14');
  assert.deepEqual([two.persons, two.total, two.hint], [[], 0, 'digits']);
});

test('an email’s start on the desk, with or without the @; a volunteer is never matched on one and never sees one', async () => {
  for (const q of ['lena@example.org', 'lena@', 'lena']) assert.deepEqual(await names(q), ['Lena Example'], q);
  assert.deepEqual(await names('omar.k'), ['Omar Example'], 'one word with a dot: the email’s start');
  for (const q of ['lena@example.org', 'lena@', 'omar.k']) assert.deepEqual(await names(q, '', vol), [], `volunteer ${q}`);
  const seen = (await ask('lena', '', vol)).persons;
  assert.deepEqual([seen.length, seen[0].name, seen[0].email], [1, 'Lena Example', null]);
});

test('past the cap: “more than”, the first page in A–Z order, and paging walks the whole surname', async () => {
  setSearchCap(50);
  try {
    const first = await ask('bigname', '&limit=20');
    assert.deepEqual([first.total, first.many, first.cap, first.more], [null, true, 50, true]);
    const seen = [...first.persons];
    let page = first;
    while (page.more) {
      page = await ask('bigname', `&limit=20&after=${seen.at(-1).id}`);
      assert.deepEqual([page.total, page.many], [null, false]);
      seen.push(...page.persons);
    }
    assert.equal(seen.length, 51);
    assert.equal(new Set(seen.map((p) => p.id)).size, 51);
    assert.deepEqual(seen.map((p) => p.id), [...seen].sort(azSort).map((p) => p.id));
    // A first name with the crowded surname leads on the rarer word: exact.
    const both = await ask('bnc2 bigname', '&limit=50');
    assert.deepEqual([both.many, both.total], [false, seen.filter((p) => foldName(p.first_name).startsWith('bnc2')).length]);
    assert.ok(both.total >= 1);
    // A crowded first name (they all start "Bn"): its walk of the A–Z index
    // pages through all 51 too.
    const walked = [];
    let p = await ask('bn', '&limit=20');
    assert.deepEqual([p.many, p.total], [true, null]);
    walked.push(...p.persons);
    while (p.more) { p = await ask('bn', `&limit=20&after=${walked.at(-1).id}`); walked.push(...p.persons); }
    assert.deepEqual(walked.map((x) => x.id), seen.map((x) => x.id));
  } finally { setSearchCap(5000); }
});

test('role, not and list; a bad after; the limit', async () => {
  assert.deepEqual((await names('sample', '&limit=50&role=driver')).sort(), ['Aaron Sample', 'Bea Sample', 'Zoë Sample']);
  assert.deepEqual(await names('sample', '&role=nonsense'), []);
  const without = await ask('kevin smith', `&limit=50&not=${P.kevin1}`);
  assert.deepEqual([without.total, without.persons.some((p) => p.id === P.kevin1)], [3, false]);
  // The list: every member flagged, nobody else; not for a volunteer.
  const flags = [];
  let page = await ask('listmember', `&limit=50&list=${P.list}`);
  flags.push(...page.persons);
  while (page.more) { page = await ask('listmember', `&limit=50&list=${P.list}&after=${flags.at(-1).id}`); flags.push(...page.persons); }
  assert.equal(flags.length, 610);
  assert.equal(flags.filter((p) => p.on_list === true).length, 600);
  assert.equal(flags.filter((p) => p.on_list === false).length, 10);
  assert.ok((await ask('listmember', `&list=${P.list}`, vol)).persons.every((p) => !('on_list' in p)), 'ignored for a volunteer');
  assert.deepEqual((await ask('sample', '&after=nonsense')).persons, []);
  assert.deepEqual((await ask('sample', `&after=${randomUUID()}`)).persons, [], 'not in this campaign');
  assert.equal((await ask('sample', '&limit=500')).persons.length, 40, 'at most 50');
  assert.equal((await ask('listmember', '&limit=500')).persons.length, 50);
  assert.equal((await ask('sample')).persons.length, 6, 'the command bar’s 6');
});

test('signed out 401; denied People 403', async () => {
  assert.equal((await new Client().get('/api/search/people?q=sample')).status, 401);
  const inv = await mgr.action('member.invite', { email: mail('staff'), role: 'staff' });
  const staff = new Client();
  const j = ok(await staff.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: 'Sam Example', password: 'search-pass-2026' }));
  await mgr.action('permission.member.set', { user_id: j.user.id, grant: [], deny: ['people'] });
  const r = await staff.get('/api/search/people?q=sample');
  assert.deepEqual([r.status, r.json.error], [403, 'not for you — ask a manager under Admin → Permissions']);
});

test('the fold: 269 letters and marks in, 265 out, by the stated rule; the server’s and the browser’s agree', async () => {
  assert.equal(FOLD_FROM.length, 269);
  assert.equal(FOLD_TO.length, 265);
  const extras = { Đ: 'd', đ: 'd', Ð: 'd', ð: 'd', Ł: 'l', ł: 'l', Ø: 'o', ø: 'o', Ħ: 'h', ħ: 'h', ı: 'i', Ŧ: 't', ŧ: 't', ſ: 's' };
  for (const [i, ch] of [...FOLD_FROM.slice(0, 265)].entries()) {
    const nfd = ch.normalize('NFD');
    const want = /^[A-Za-z][̀-ͯ]+$/.test(nfd) ? nfd[0].toLowerCase() : extras[ch];
    assert.equal(FOLD_TO[i], want, ch);
  }
  assert.equal(FOLD_FROM.slice(265), "'’ʼ.");
  const left = [...'ÆæÞþßĲĳĸĿŀŉŊŋŒœ'];
  const samples = [...FOLD_FROM, ...left, 'ÆΣ', 'Kevin  Smith', ' José\tExample ', "Dee D'Souza", 'St. Pierre', 'Thi Nguyễn', 'Van Der Berg', 'Sandhu-Gill',
    'ŁUKASZ Żółć', 'Ægir Þórsson', 'Ørsted', 'Œuvre', 'Strauß', 'İlker Işık', 'Đặng Văn', 'MÜLLER', 'Ñúñez', 'Čapek', 'Dvořák', 'Ångström',
    'Zoë', 'Renée', 'François', 'Søren', 'Björk', 'Gonçalves', 'Siân', 'Mỹ Lê', 'Trần', 'Phạm', 'Hồ', 'Đỗ', 'Bùi', 'Võ', 'Đinh', 'Dương', 'Lý', 'Tô', 'O’Brien'];
  const { rows } = await db.query('select t, person_fold(t) as f, person_fold_tail(t) as tail from unnest($1::text[]) t', [samples]);
  for (const r of rows) assert.equal(r.f, foldName(r.t), JSON.stringify(r.t));
  for (const ch of left) assert.equal(foldName(ch), ch.replace(/[A-Z]/g, (x) => x.toLowerCase()), `${ch} left as it is`);
  assert.equal(foldName('ÆΣ'), 'ÆΣ');
  assert.equal(rows.find((r) => r.t === 'Van Der Berg').tail, 'berg');
  assert.equal(rows.find((r) => r.t === 'Sandhu-Gill').tail, 'gill');
  assert.equal(foldTerm('José'), 'jose');
  assert.equal(foldName('José'), 'josé', 'a stored decomposed name keeps its mark');
});

test('Postgres 17 maintenance: the indexes on our functions rebuild with only pg_catalog on the path', async () => {
  await db.transaction(async (tx) => {
    await tx.query('set local search_path = pg_catalog');
    await tx.query('reindex index public.persons_ws_last_tail_idx');
    await tx.query('reindex index public.persons_ws_az_idx');
    await tx.query('analyze public.persons');
  });
});

// Every query a search runs, explained with table reads turned off: each
// reads an index of ours, and none reads persons end to end.
const plansOf = async (q, more = '') => {
  const seen = [];
  setSearchTrace((text, params, meta) => seen.push({ text, params, walk: meta?.walk }));
  try { await ask(q, more); } finally { setSearchTrace(null); }
  const out = [];
  for (const { text, params, walk } of seen) {
    out.push(await db.transaction(async (tx) => {
      await tx.query('set local enable_seqscan = off');
      // A crowded way's walk runs with sorting off, as the search runs it.
      if (walk) { await tx.query('set local enable_sort = off'); await tx.query('set local enable_bitmapscan = off'); }
      return (await tx.query(`explain ${text}`, params)).rows.map((r) => Object.values(r)[0]).join('\n');
    }));
  }
  return out.join('\n----\n');
};

test('each way in reads its index: name, last name, its last word, middle name, phone, phone without area code, email, address, A–Z', async () => {
  const want = [
    ['kevin', /persons_ws_name_fold_idx/], ['smith', /persons_ws_last_fold_idx/], ['gill', /persons_ws_last_tail_idx/],
    ['anne', /persons_ws_middle_fold_idx/], ['604 555 0142', /persons_ws_phone10_idx/], ['555 0142', /persons_ws_phone7_idx/],
    ['lena@ex', /persons_ws_email_(prefix_)?idx/], ['14520 72', /persons_ws_addr_prefix_idx/],
  ];
  for (const [q, index] of want) {
    const plan = await plansOf(q);
    assert.match(plan, index, `${q}\n${plan}`);
    assert.doesNotMatch(plan, /Seq Scan on persons/, `${q}\n${plan}`);
  }
  setSearchCap(50);
  try {
    for (const q of ['bigname', 'bn']) {
      const plan = await plansOf(q, '&limit=20');
      assert.match(plan, /persons_ws_az_idx/, plan);
      assert.doesNotMatch(plan, /Seq Scan on persons/, plan);
    }
  } finally { setSearchCap(5000); }
});

after(() => { setSearchCap(5000); setSearchTrace(null); });
