// Find people I know (ext/addressbook, shared/contactsfile.js): a desk
// member's contacts file, read in the browser, checked a slice at a time
// against the list — only matches come back, nothing is kept — and the
// ticked people linked into their My people, with nothing else about them
// changed and nobody added.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { freshDb, Client } from './helpers.js';
import { verifyChain } from '../lib/events.js';
import { readContacts, looksLikeContacts } from '@starbase/shared/contactsfile';

const tag = Math.random().toString(36).slice(2, 8);
let db, mgr, ws, staff, staffId, vol, volId, cand, candId, denied, deniedId, counter;
const P = {};
const ok = (r, msg = '') => { assert.equal(r.status, 200, `${msg} ${JSON.stringify(r.json)}`); return r.json; };
const join = async (role, who) => {
  const inv = ok(await mgr.action('member.invite', { email: `ab-${who}+${tag}@example.org`, role }));
  const c = new Client();
  const j = ok(await c.post('/api/auth/join', { token: inv.joinUrl.split('/join/')[1], name: `${who} Example`, password: 'contacts-pass-2026' }));
  return { c, id: j.user.id };
};
const count = async (table) => (await db.query(`select count(*)::int as n from ${table} where workspace_id = $1`, [ws])).rows[0].n;
const counts = async () => Object.fromEntries(await Promise.all(['events', 'jobs', 'persons', 'relationships', 'subscriptions'].map(async (t) => [t, await count(t)])));
// A small CSV reader for the fixtures (quotes and commas inside them).
const csv = (text) => {
  const rows = [];
  for (const line of text.trim().split(/\r?\n/)) {
    const cells = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true; else if (ch === ',') { cells.push(cur); cur = ''; } else cur += ch;
    }
    cells.push(cur);
    rows.push(cells);
  }
  return { headers: rows[0], records: rows.slice(1).map((cells) => ({ cells })) };
};
const fixture = (name) => csv(readFileSync(new URL(`../../samples/${name}`, import.meta.url), 'utf8'));
const check = (c, rows) => c.post('/api/addressbook/check', { rows });

before(async () => {
  db = await freshDb();
  mgr = new Client();
  ws = (await mgr.signup({ workspaceName: `Contacts ${tag}`, email: `ab-mgr+${tag}@example.org`, jurisdiction: 'bc-municipal' })).json.workspace.id;
  ({ c: staff, id: staffId } = await join('staff', 'Sam'));
  ({ c: vol, id: volId } = await join('volunteer', 'Vik'));
  ({ c: cand, id: candId } = await join('volunteer', 'Cam'));
  ({ c: denied, id: deniedId } = await join('staff', 'Dan'));
  ({ c: counter } = await join('staff', 'Cora'));
  ok(await mgr.action('permission.member.set', { user_id: volId, grant: ['people'], deny: [] }));
  ok(await mgr.action('permission.member.set', { user_id: candId, grant: ['people'], deny: [] }));
  ok(await mgr.action('permission.member.set', { user_id: deniedId, grant: [], deny: ['people'] }));
  await db.query(`insert into candidates (id, workspace_id, name, user_id) values (gen_random_uuid(), $1, 'Cam Example', $2)`, [ws, candId]);
  P.ann = (await mgr.createPerson('Ann Example', { email: 'ann.example@example.org', phone: '604-555-0191', tags: ['donor-ish'] })).id;
  P.bo = (await mgr.createPerson('Bo Lee Sample', { email: 'BO.home@example.org' })).id;
  P.cy = (await mgr.createPerson('Cy Example', { phone: '604.555.0103' })).id;
  P.cyOther = (await mgr.createPerson('Cyrus Example', { phone: '604-555-0103' })).id; // same phone, other name
  P.gone = (await mgr.createPerson('Fay Example', { email: 'fay.example@example.org' })).id;
  await db.query('update persons set deleted_at = now() where id = $1', [P.gone]);
});

test('readContacts: Google’s layout — names, the first email of several, phones, ::: cells, Labels and Notes never read', () => {
  const g = readContacts(fixture('contacts-google.csv'));
  assert.equal(g.total, 8);
  assert.equal(g.unusable, 1, 'Gil: a name, nothing to match on');
  const by = Object.fromEntries(g.rows.map((r) => [r.name, r]));
  assert.deepEqual(by['Ann Example'], { ref: 0, name: 'Ann Example', email: 'ann.example@example.org', phone: '604-555-0101' });
  assert.equal(by['Bo Lee Sample'].email, 'bo.home@example.org', 'the first of a ::: cell');
  assert.equal(by['Cy Example'].phone, '+1 (604) 555-0103');
  assert.equal(by['Cy Example'].email, undefined);
  assert.equal(by['Example Hardware'].phone, '604-555-0105', 'a name from the organization');
  assert.equal(by['Fay Example'].email, 'fay.example@example.org', 'E-mail 2 when 1 is empty');
  const all = JSON.stringify(g);
  for (const never of ['myContacts', 'Friends', 'Door code', 'farmers market', '1990-01-01', 'Example St']) assert.ok(!all.includes(never), never);
  assert.equal(looksLikeContacts(fixture('contacts-google.csv').headers), true);
});

test('readContacts: an Outlook-style file — Mobile over Home over Business, a Company name; 10,001 refused', () => {
  const o = readContacts(fixture('contacts-outlook.csv'));
  const by = Object.fromEntries(o.rows.map((r) => [r.name, r]));
  assert.equal(by['Hal Example'].phone, '604-555-0113', 'mobile first');
  assert.equal(by['Ida Example'].phone, '604-555-0121', 'home over business');
  assert.equal(by['Example Bakery'].phone, '604-555-0131');
  assert.equal(by['Jo Example'].email, 'jo.two@example.org');
  assert.ok(!JSON.stringify(o).includes('Notes here'));
  assert.equal(looksLikeContacts(fixture('contacts-outlook.csv').headers), true);
  const imp = readFileSync(new URL('../../samples/surrey-import-test.csv', import.meta.url), 'utf8').split(/\r?\n/)[0].split(',');
  assert.equal(looksLikeContacts(imp), false, 'the import’s own sample is no contacts file');
  assert.equal(looksLikeContacts(['Name', 'Email', 'Phone', 'Address']), false);
  const big = readContacts({ headers: ['Name', 'E-mail 1 - Value'], records: Array.from({ length: 10_001 }, (_, i) => [`P${i} Example`, `p${i}@example.org`]) });
  assert.equal(big.error, 'That file has 10,001 contacts. Export one label at a time (10,000 at most).');
});

test('check: matches only, by email and by name + phone; a deleted person never; mine for someone already linked; nothing kept', async () => {
  const before = await counts();
  const rows = readContacts(fixture('contacts-google.csv')).rows;
  const warns = [];
  const real = { warn: console.warn, log: console.log, error: console.error };
  for (const k of Object.keys(real)) console[k] = (...a) => warns.push(a.join(' '));
  let r;
  try { r = ok(await check(staff, rows)); } finally { Object.assign(console, real); }
  assert.equal(r.checked, rows.length);
  const by = Object.fromEntries(r.rows.map((x) => [x.person.name, x]));
  assert.deepEqual(Object.keys(by).sort(), ['Ann Example', 'Bo Lee Sample', 'Cy Example']);
  assert.equal(by['Ann Example'].how, 'email');
  assert.equal(by['Bo Lee Sample'].how, 'email', 'case does not matter');
  assert.equal(by['Cy Example'].how, 'phone');
  assert.equal(by['Cy Example'].person.id, P.cy, 'the name decides between two with the phone');
  assert.deepEqual(Object.keys(by['Ann Example'].person).sort(), ['address', 'id', 'name', 'rating', 'unit']);
  assert.ok(!JSON.stringify(r).includes('dee.example'), 'no row for anyone not on the list');
  assert.ok(!r.rows.some((x) => x.person.id === P.gone));
  assert.deepEqual(await counts(), before, 'nothing written anywhere');
  assert.ok(!warns.join('\n').includes('example.org'), 'no row in a log line');
  // Already in My people.
  ok(await staff.action('relationship.add', { person_id: P.ann }));
  const again = ok(await check(staff, rows));
  assert.equal(again.rows.find((x) => x.person.id === P.ann).mine, true);
  assert.equal(again.rows.find((x) => x.person.id === P.cy).mine, false);
});

test('check: the desk only — a volunteer or candidate granted People, and staff denied People, get 403; 501 rows is 400; the 41st an hour is 429', async () => {
  const rows = [{ ref: 0, name: 'Ann Example', email: 'ann.example@example.org' }];
  for (const c of [vol, cand, denied]) {
    const r = await check(c, rows);
    assert.equal(r.status, 403);
    assert.equal(r.json.error, 'For the desk');
  }
  ok(await check(mgr, rows));
  const big = await check(staff, Array.from({ length: 501 }, (_, i) => ({ ref: i, name: `P${i} Example`, email: `p${i}@example.org` })));
  assert.equal(big.status, 400);
  assert.ok(!JSON.stringify(big.json).includes('example.org'), 'an error never echoes a row');
  for (let i = 0; i < 40; i += 1) ok(await check(counter, rows), `check ${i + 1}`);
  const over = await check(counter, rows);
  assert.equal(over.status, 429);
  assert.equal(over.json.error, 'That’s a lot of checking — wait an hour, or use a smaller file');
});

test('link: the ticked people join my people and nothing else changes; already linked; a deleted one skipped with nothing left behind', async () => {
  const tagsBefore = (await db.query('select tags, email from persons where id = $1', [P.bo])).rows[0];
  const subsBefore = await count('subscriptions');
  const jobsBefore = await count('jobs');
  const personsBefore = await count('persons');
  const evBefore = (await db.query('select max(seq)::int as s from events where workspace_id = $1', [ws])).rows[0].s;
  const r = ok(await staff.action('addressbook.link', { person_ids: [P.bo, P.ann, P.gone, P.cy, P.bo] }));
  assert.equal(r.linked, 2);
  assert.equal(r.already, 1, 'Ann was linked already');
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].why, 'person not found');
  const mine = ok(await staff.get('/api/relationships/mine'));
  const ids = JSON.stringify(mine);
  for (const id of [P.ann, P.bo, P.cy]) assert.ok(ids.includes(id));
  assert.deepEqual((await db.query('select tags, email from persons where id = $1', [P.bo])).rows[0], tagsBefore, 'nothing else about them');
  assert.equal(await count('subscriptions'), subsBefore);
  assert.equal(await count('jobs'), jobsBefore);
  assert.equal(await count('persons'), personsBefore, 'nobody added (Sam’s own record existed)');
  const evs = (await db.query('select entity_type, entity_id, op, action from events where workspace_id = $1 and seq > $2', [ws, evBefore])).rows;
  assert.ok(evs.every((e) => e.action === 'addressbook.link'));
  assert.ok(!evs.some((e) => e.entity_id === P.gone || JSON.stringify(e).includes(P.gone)), 'no event from the skipped one');
  assert.deepEqual([...new Set(evs.map((e) => e.entity_type))], ['relationship']);
  assert.equal((await verifyChain(db, ws)).ok, true);
});

test('link: refused for a volunteer granted People; empty, malformed or a new person is 400', async () => {
  const v = await vol.action('addressbook.link', { person_ids: [P.ann] });
  assert.equal(v.status, 403);
  assert.equal((await cand.action('addressbook.link', { person_ids: [P.ann] })).status, 403);
  assert.equal((await denied.action('addressbook.link', { person_ids: [P.ann] })).status, 403);
  assert.equal((await staff.action('addressbook.link', { person_ids: [] })).status, 400);
  assert.equal((await staff.action('addressbook.link', { person_ids: ['not-an-id'] })).status, 400);
  assert.equal((await staff.action('addressbook.link', { person_ids: [''] })).status, 400);
  assert.equal((await staff.action('addressbook.link', { person_ids: [P.ann], person: { name: 'New Example', email: 'new@example.org' } })).status, 400);
  assert.equal((await staff.action('addressbook.link', { person: { name: 'New Example', email: 'new@example.org' } })).status, 400);
  // That's you: skipped with its words.
  const self = (await db.query('select id from persons where workspace_id = $1 and lower(email) = $2', [ws, `ab-sam+${tag}@example.org`])).rows[0].id;
  const r = ok(await staff.action('addressbook.link', { person_ids: [self] }));
  assert.equal(r.skipped[0].why, 'that’s you — add someone you know');
});
