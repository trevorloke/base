// A–Z by last name (lib/az.js): People and its parts, a list's people and
// its CSV, Knows, who lives at an address, a shift's people, a new phone
// bank's numbers (an existing bank keeps its own), the people report,
// volunteers and a crew — all by surname, then the whole name, then id; the
// browser's azSort (shared/names.js) agrees. Walk lists and the full export
// keep their own orders.
// test:pg-safe: unique emails per run, everything scoped to this campaign.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb, Client } from './helpers.js';
import { azSort, foldName } from '@starbase/shared/names';
import { walkOrder } from '../lib/geo.js';

let db, mgr, ws;
const tag = Math.random().toString(36).slice(2, 8);
const mail = (who) => `${who}.az.${tag}@example.org`;
const ok = (r, msg = '') => { assert.equal(r.status, 200, `${msg} ${JSON.stringify(r.json)}`); return r.json; };
// Every tricky neighbour: spaces and hyphens before letters, accents, one
// word, an organisation, a shared surname told apart by the whole name.
const NAMES = ['Jo Van Der Berg', 'Al Vanberg', 'Kim Sandhu Gill', 'Raj Sandhu-Gill', 'Ana Sandhugill', 'Zoë Éxample', 'Ann Example', 'Émile Example',
  'Bo Example', 'Cher', 'Surrey Example Society', 'Thi Nguyễn Example', "Dee D'Souza", 'Dan Dsouza', 'Ana Árbol', 'Al Zed', 'Aaron Aardvark',
  'Mary Anne Example', 'Mary Example', 'Kevin Smith Jr', 'Kevin Smith', 'Zed Abbott'];
const P = {};
const byAz = (rows) => [...rows].sort(azSort).map((r) => r.name);

before(async () => {
  db = await freshDb();
  mgr = new Client();
  ws = (await mgr.signup({ workspaceName: 'Imagine Surrey', email: mail('manager') })).json.workspace.id;
  // Out of order on purpose: the order they were added is not A–Z.
  for (const [i, name] of [...NAMES].reverse().entries()) {
    const id = randomUUID();
    await db.query(
      `insert into persons (id, workspace_id, kind, name, phone, address, city, lat, lng, tags)
       values ($1, $2, $3, $4, $5, '14520 72 Ave', 'Surrey', $6, -122.85, '["az"]')`,
      [id, ws, name === 'Surrey Example Society' ? 'org' : 'person', name, `604-555-${String(100 + i).padStart(4, '0')}`, 49.1 + i / 1000],
    );
    P[name] = id;
  }
});

const want = async () => {
  const { rows } = await db.query('select id, name, last_name from persons where workspace_id = $1 and deleted_at is null and tags @>\'["az"]\'', [ws]);
  return rows;
};

test('the server’s order is the browser’s: surname, then whole name, spaces and hyphens before letters, accents ignored', async () => {
  const people = ok(await mgr.get('/api/persons?tag=az&limit=300')).persons;
  const names = people.map((p) => p.name);
  assert.deepEqual(names, byAz(await want()));
  const at = (n) => names.indexOf(n);
  assert.ok(at('Jo Van Der Berg') < at('Al Vanberg'), 'van der berg before vanberg');
  assert.ok(at('Kim Sandhu Gill') < at('Raj Sandhu-Gill') && at('Raj Sandhu-Gill') < at('Ana Sandhugill'));
  assert.ok(at('Ann Example') < at('Bo Example') && at('Bo Example') < at('Émile Example') && at('Émile Example') < at('Mary Anne Example'));
  assert.equal(names[0], 'Aaron Aardvark');
  assert.ok(at('Zed Abbott') < at('Ana Árbol'), 'accents ignored: abbott, arbol');
  assert.ok(at('Dan Dsouza') < at("Dee D'Souza"));
  assert.ok(at('Surrey Example Society') > at('Mary Example'), 'an organisation by its whole name');
  assert.equal(foldName('Zoë Éxample'), 'zoe example');
});

test('People in parts: ?after= and ?until= meet with no overlap and no gap, across a page boundary inside one surname', async () => {
  const all = ok(await mgr.get('/api/persons?tag=az&limit=300')).persons.map((p) => p.id);
  const seen = [];
  let after = '';
  for (;;) {
    const page = ok(await mgr.get(`/api/persons?tag=az&limit=3${after ? `&after=${after}` : ''}`));
    seen.push(...page.persons.map((p) => p.id));
    if (!page.more) break;
    after = page.persons.at(-1).id;
  }
  assert.deepEqual(seen, all);
  const mid = all[7];
  const upTo = ok(await mgr.get(`/api/persons?tag=az&limit=300&until=${mid}`)).persons.map((p) => p.id);
  assert.deepEqual(upTo, all.slice(0, 8));
});

test('a list’s people and its CSV, Knows, the household, a shift’s people: A–Z', async () => {
  const list = ok(await mgr.action('list.create', { name: 'AZ', kind: 'filter', filter: { tag: 'az' } })).list;
  const expect = byAz(await want());
  assert.deepEqual(ok(await mgr.get(`/api/lists/${list.id}?limit=100`)).people.map((p) => p.name), expect);
  const csv = await (await import('../index.js')).app.request(`/api/lists/${list.id}/export.csv`, { headers: { cookie: mgr.cookie } });
  const lines = (await csv.text()).trim().split(/\r?\n/).slice(1).map((l) => l.split(",")[0]);
  assert.deepEqual(lines.map((l) => l.replace(/^"|"$/g, '')), expect);
  // Knows: everyone else, tied to Kevin Smith.
  const me = P['Kevin Smith'];
  for (const name of NAMES.filter((n) => n !== 'Kevin Smith')) {
    const [a, b] = [me, P[name]].sort();
    await db.query('insert into relationships (id, workspace_id, person_a, person_b, kind) values ($1, $2, $3, $4, $5)', [randomUUID(), ws, a, b, 'friend']);
  }
  const knows = ok(await mgr.get(`/api/persons/${me}/knows`));
  const knowsNames = knows.knows.map((r) => r.person.name);
  assert.deepEqual(knowsNames, expect.filter((n) => n !== 'Kevin Smith'));
  // Who lives here: all at one address.
  const one = ok(await mgr.get(`/api/persons/${me}`));
  assert.deepEqual(one.household.map((h) => h.name), expect.filter((n) => n !== 'Kevin Smith'));
  // A shift's people.
  const shift = randomUUID();
  await db.query("insert into shifts (id, workspace_id, title, starts_at) values ($1, $2, 'Canvass', now() + interval '1 day')", [shift, ws]);
  for (const name of NAMES) {
    await db.query("insert into shift_assignments (id, workspace_id, shift_id, person_id, status) values ($1, $2, $3, $4, 'assigned')", [randomUUID(), ws, shift, P[name]]);
  }
  assert.deepEqual(ok(await mgr.get(`/api/shifts/${shift}`)).assignees.map((a) => a.name), expect);
  const crew = ok(await mgr.get(`/api/crew/${shift}`));
  const booked = (crew.crew || crew.booked || []).map((a) => a.name);
  assert.deepEqual(booked, expect);
});

test('a new bank’s numbers are A–Z; an existing bank keeps its order and a list added later follows it', async () => {
  const list = ok(await mgr.action('list.create', { name: 'AZ bank', kind: 'filter', filter: { tag: 'az' } })).list;
  const bank = ok(await mgr.action('bank.create', { name: 'AZ calls', list_id: list.id })).bank;
  const numbers = ok(await mgr.get(`/api/banks/${bank.id}?limit=100`)).numbers;
  assert.deepEqual(numbers.map((n) => n.name), byAz(await want()));
  // Positions given by hand stay; whoever joins later comes after them, A–Z.
  const byHand = ok(await mgr.action('bank.create', { name: 'By hand', person_ids: [P['Zed Abbott'], P['Aaron Aardvark']] })).bank;
  const before = ok(await mgr.get(`/api/banks/${byHand.id}`)).numbers.map((n) => n.name);
  const added = randomUUID();
  await db.query("insert into persons (id, workspace_id, name, phone, tags) values ($1, $2, 'Abe Aaa', '604-555-0999', '[\"az\"]')", [added, ws]);
  ok(await mgr.action('bank.add', { id: byHand.id, person_ids: [added] }));
  const after = ok(await mgr.get(`/api/banks/${byHand.id}`)).numbers.map((n) => n.name);
  assert.deepEqual(after.slice(0, before.length), before, 'the numbers already there keep their places');
  assert.equal(after.at(-1), 'Abe Aaa');
  await db.query('update persons set deleted_at = now() where id = $1', [added]);
});

test('the people report, volunteers: A–Z; walk lists keep street order', async () => {
  const expect = byAz(await want());
  const report = await (await import('../index.js')).app.request('/api/export/people', { headers: { cookie: mgr.cookie } });
  const text = await report.text();
  const head = text.split(/\r?\n/)[0].split(',');
  const nameAt = head.findIndex((h) => /^"?(name|Name)"?$/.test(h));
  const rows = text.trim().split(/\r?\n/).slice(1).map((l) => l.split(',')[nameAt]?.replace(/^"|"$/g, ''));
  assert.deepEqual(rows.filter((n) => expect.includes(n)), expect);
  for (const name of NAMES) await db.query('insert into volunteer_roles (id, workspace_id, person_id, role) values ($1, $2, $3, $4)', [randomUUID(), ws, P[name], 'driver']);
  const vols = ok(await mgr.get('/api/volunteers'));
  const list = (vols.volunteers || vols.people || []).map((v) => v.name);
  assert.deepEqual(list.filter((n) => expect.includes(n)), expect);
  // Walk order: by street and number, never by name.
  const doors = [{ address: '200 Example St', lat: 49.1, lng: -122.8, people: [{ name: 'Aaron Aardvark' }] },
    { address: '100 Example St', lat: 49.1, lng: -122.8, people: [{ name: 'Zed Abbott' }] }];
  assert.deepEqual(walkOrder(doors).map((d) => d.address), walkOrder([...doors].reverse()).map((d) => d.address));
});
