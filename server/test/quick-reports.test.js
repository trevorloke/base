// Quick reports (ext/reports/quick.js): the menu and who may pull what; the
// six lists of people, A–Z, with "Do not contact" from lib/reach.js's own
// reasons; the paper walking list (no phone, no email; the size check before
// anyone is read); the streamed CSV; and the plans that keep each recipe off
// a pass over all of persons. Made-up people only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';
import { RECIPES, WALK_DOORS_MAX } from '../ext/reports/quick.js';
import { movedCounts, movedOpenIds } from '../ext/moves/index.js';
import { csvStream } from '../lib/csv.js';
import { SURREY_CANDIDATES } from '@starbase/shared/scale';

const tag = Math.random().toString(36).slice(2, 8);
const lat = 49.1327; const lng = -122.855;
let db, ws, mgr, staff, noMoney, mapOnly, noMap, volData;
const P = {};
const ok = (r, msg = '') => { assert.ok([200, 201].includes(r.status), `${msg} ${JSON.stringify(r.json)}`); return r.json; };
const raw = (c, path) => app.request(path, { headers: { cookie: c.cookie } });
// The bytes as sent (text() would drop the byte-order mark).
const bytes = async (res) => Buffer.from(await res.arrayBuffer()).toString('utf8');
const csvRows = (text) => text.replace(/^﻿/, '').split('\r\n').filter(Boolean).map((l) => l.split(','));
const ymd = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const today = ymd(new Date());
const y = Number(today.slice(0, 4));
const ctxOf = () => ({ workspaceId: ws, workspace: { settings: {} }, role: 'manager' });

// Every query the app runs, while `fn` runs.
const spy = async (fn) => {
  const seen = [];
  const real = db.query;
  db.query = (sql, params) => { seen.push(String(sql)); return real.call(db, sql, params); };
  try { await fn(); } finally { db.query = real; }
  return seen;
};
const join = async (role, name, perms) => {
  const email = `${name.split(' ')[0].toLowerCase()}.${tag}@example.org`;
  const inv = ok(await mgr.action('member.invite', { email, role }));
  const c = new Client();
  ok(await c.post('/api/auth/join', { token: inv.joinUrl.split('/join/')[1], name, password: 'quick-reports-1' }));
  const me = ok(await c.get('/api/auth/me')).user;
  if (perms) ok(await mgr.action('permission.member.set', { user_id: me.id, ...perms }));
  return c;
};
const gift = (person, cents, date, extra = {}) => db.query(
  `insert into gifts (id, workspace_id, person_id, amount_cents, date, method, cadence, attrs, deleted_at, created_at)
   values ($1, $2, $3, $4, $5, 'cash', $6, $7, $8, coalesce($9::timestamptz, now()))`,
  [randomUUID(), ws, person.id, cents, date, extra.cadence || 'one-time', JSON.stringify(extra.attrs || {}), extra.deleted_at || null, extra.created_at || null],
);
// Many made-up people at once, straight into the table.
const bulk = (n, { last = 'Same', tags = [], lat0 = null, lng0 = null, street = null } = {}) => db.query(
  `insert into persons (id, workspace_id, name, first_name, last_name, tags, address, house_number, lat, lng)
   select gen_random_uuid(), $1, 'P' || lpad(i::text, 5, '0') || ' ' || $3, 'P' || lpad(i::text, 5, '0'), $3, $4::jsonb,
          case when $7::text is null then null else (1000 + i * 2)::text || ' ' || $7 end,
          case when $7::text is null then null else (1000 + i * 2)::text end,
          case when $5::float8 is null then null else $5 + (i % 50) * 0.00002 end,
          case when $6::float8 is null then null else $6 + (i / 50) * 0.00002 end
     from generate_series(1, $2) i`,
  [ws, n, last, JSON.stringify(tags), lat0, lng0, street],
);

before(async () => {
  db = await freshDb();
  mgr = new Client();
  ws = ok(await mgr.signup({ workspaceName: `Quick ${tag}`, jurisdiction: 'bc-municipal', email: `quick.desk+${tag}@example.org` })).workspace.id;
  staff = await join('staff', 'Sam Example');
  noMoney = await join('staff', 'Nia Example', { deny: ['money'] });
  mapOnly = await join('staff', 'Max Example', { deny: ['people', 'shifts', 'money', 'signs', 'outreach', 'data', 'learn', 'media'] });
  noMap = await join('staff', 'Noor Example', { deny: ['map'] });
  volData = await join('volunteer', 'Vic Example', { grant: ['data'] });
  const mk = async (key, first, last, extra = {}) => { P[key] = await mgr.createPerson(null, { first_name: first, last_name: last, ...extra }); };
  await mk('alpha', 'Ann', 'Alpha', { phone: '604-555-0101', email: `ann.${tag}@example.org`, tags: ['do-not-call'] });
  await mk('beta', 'Bo', 'Beta', { phone: '604-555-0102' });
  await mk('gamma', 'Cy', 'Gamma', { phone: '604-555-0103' });
  await mk('imp', 'Ida', 'Import', { phone: '604-555-0104', email: `ida.${tag}@example.org`, tags: ['Do-Not-Call'] });
  await mk('monthly', 'Mo', 'Monthly', { phone: '604-555-0105', email: `mo.${tag}@example.org` });
  await mk('van', 'Dee', 'Van Sample', { phone: '604-555-0106', email: `dee.${tag}@example.org` });
  await mk('void', 'Vi', 'Void', { phone: '604-555-0107' });
  await gift(P.alpha, 5000, `${y}-01-01`, { created_at: new Date(Date.now() - 864e5).toISOString() });
  await gift(P.alpha, 3000, today);
  await gift(P.beta, 10000, `${y - 1}-06-15`);
  await gift(P.gamma, 2000, `${y - 2}-06-15`);
  await gift(P.imp, 100000, today, { attrs: { source: 'import' } });
  await gift(P.monthly, 25000, today, { cadence: 'monthly' });
  await gift(P.van, 1000, today);
  await gift(P.void, 9900, today, { deleted_at: new Date().toISOString() });
  // Email reasons: Dee's address bounced; Mo and Ida left the newsletter.
  await db.query(`insert into email_suppressions (id, workspace_id, email, reason, source) values ($1, $2, $3, 'bounce', 'test')`, [randomUUID(), ws, `dee.${tag}@example.org`]);
  for (const e of [`mo.${tag}@example.org`, `ida.${tag}@example.org`]) {
    await db.query(`insert into subscriptions (id, workspace_id, email, status) values ($1, $2, $3, 'unsubscribed')`, [randomUUID(), ws, e]);
  }
});
after(() => {});

test('the menu: seven, in order; can per role and grant; a volunteer granted Data is refused', async () => {
  const m = ok(await mgr.get('/api/quick-reports-menu')).reports;
  assert.deepEqual(m.map((r) => r.name), ['walk', 'donors', 'running', 'volunteers', 'members', 'signs', 'moved']);
  assert.deepEqual(m.map((r) => r.title), ['Walking list', 'Donors', 'Interested in being a candidate', 'Volunteers', 'Members', 'Signs to put up', 'Moved — needs an address']);
  assert.ok(m.every((r) => r.can), 'a manager may pull all of them');
  const can = async (c) => Object.fromEntries(ok(await c.get('/api/quick-reports-menu')).reports.map((r) => [r.name, r.can]));
  assert.deepEqual(await can(noMoney), { walk: true, donors: false, running: true, volunteers: true, members: false, signs: true, moved: true });
  assert.deepEqual(await can(mapOnly), { walk: true, donors: false, running: false, volunteers: false, members: false, signs: false, moved: false });
  assert.equal((await volData.get('/api/quick-reports-menu')).status, 403);
  const vd = await volData.get('/api/quick-reports/donors');
  assert.equal(vd.status, 403); assert.equal(vd.json.error, 'desk only');
});

test('donors: each period, totals and tier, A–Z (Van Sample under V) and largest first; the People filter', async () => {
  const get = async (q) => ok(await mgr.get(`/api/quick-reports/donors?${q}`), q);
  const lasts = (r) => r.rows.map((x) => x.last_name);
  const yr = await get('period=year');
  assert.deepEqual(lasts(yr), ['Alpha', 'Import', 'Monthly', 'Van Sample'], 'live gifts this year, A–Z; a voided gift is no gift');
  assert.equal(yr.total, 4);
  assert.equal(yr.said, 'This year · A–Z by last name');
  const ann = yr.rows[0];
  assert.deepEqual([ann.first_name, ann.total, ann.gifts, ann.last_gift, ann.last_amount, ann.monthly, ann.tier], ['Ann', '80.00', 2, today, '30.00', '', '']);
  assert.equal(yr.rows[1].tier, 'Star', 'an imported $1,000 this year');
  assert.deepEqual([yr.rows[2].monthly, yr.rows[2].tier], ['Yes', 'Superstar']);
  assert.equal(yr.filter, 'gave=year');
  const people = ok(await mgr.get('/api/persons?gave=year&limit=500')).persons.map((p) => p.id).sort();
  assert.deepEqual(yr.rows.map((r) => r.id).sort(), people, 'the same people as People’s gave=year');
  assert.deepEqual(lasts(await get('period=last_year')), ['Beta']);
  assert.deepEqual(lasts(await get('period=all')), ['Alpha', 'Beta', 'Gamma', 'Import', 'Monthly', 'Van Sample']);
  const lapsed = await get('period=lapsed');
  assert.deepEqual(lasts(lapsed), ['Beta', 'Gamma'], 'a donor whose last gift was two years ago is lapsed');
  assert.equal(lapsed.filter, 'gave=lapsed');
  const stew = ok(await mgr.get('/api/stewardship')).lapsed.map((r) => r.person_id).sort();
  assert.deepEqual(lapsed.rows.map((r) => r.id).sort(), stew, 'Stewardship’s lapsed people');
  assert.deepEqual(lasts(await get('period=monthly')), ['Monthly']);
  assert.equal((await get('period=all')).filter, null);
  assert.deepEqual(lasts(await get('period=year&order=largest')), ['Import', 'Monthly', 'Alpha', 'Van Sample']);
  assert.deepEqual(ok(await mgr.get('/api/quick-reports/donors/count?period=year')), { count: 4, extra: { cents: 100000 + 25000 + 8000 + 1000 } });
});

test('do not contact: the words from reach.js on screen, the number in the CSV with the reason beside it', async () => {
  const yr = ok(await mgr.get('/api/quick-reports/donors?period=year'));
  const row = (last) => yr.rows.find((r) => r.last_name === last);
  assert.equal(row('Alpha').phone, 'Do not call');
  assert.equal(row('Alpha').no_contact, 'Do not call');
  assert.equal(row('Van Sample').email, 'Email bounced');
  assert.equal(row('Van Sample').phone, '604-555-0106');
  assert.equal(row('Monthly').email, 'Unsubscribed');
  assert.equal(row('Import').no_contact, 'Do not call; Unsubscribed', 'any capitals; in reach.js’s order');
  assert.deepEqual(Object.keys(row('Alpha')).filter((k) => k === 'mask'), [], 'no mask on the wire');
  const res = await raw(mgr, '/api/quick-reports/donors.csv?period=year');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), new RegExp(`donors-this-year-${today}\\.csv`));
  const text = await bytes(res);
  assert.ok(text.startsWith('﻿Last name,First name,Total,Gifts,First gift,Last gift'), text.slice(0, 80));
  const alpha = csvRows(text).find((r) => r[0] === 'Alpha');
  assert.ok(alpha.includes('604-555-0101'), 'the CSV keeps the number');
  assert.equal(alpha.at(-1), 'Do not call');
});

test('interested in being a candidate: the paper form’s tick; a renamed field is unavailable', async () => {
  const form = ok(await mgr.action('membership.enter', { first_name: 'Ren', last_name: 'Runner', phone: '604-555-0110', candidate: true }));
  assert.ok(form);
  await mgr.action('membership.enter', { first_name: 'Nat', last_name: 'Notrunning', phone: '604-555-0111' });
  const r = ok(await mgr.get('/api/quick-reports/running'));
  assert.deepEqual(r.rows.map((x) => [x.last_name, x.first_name]), [['Runner', 'Ren']]);
  assert.match(r.rows[0].said_on, /^\d{4}-\d{2}-\d{2}$/);
  const field = (await db.query("select id from person_fields where workspace_id = $1 and lower(name) = 'interested in being a candidate'", [ws])).rows[0].id;
  assert.equal(r.filter, `field=${field}:yes`);
  assert.deepEqual(ok(await mgr.get('/api/quick-reports/running/count')), { count: 1 });
  await db.query("update person_fields set name = 'Might run' where id = $1", [field]);
  try {
    for (const path of ['/api/quick-reports/running', '/api/quick-reports/running/count']) {
      const x = await mgr.get(path);
      assert.equal(x.status, 409);
      assert.equal(x.json.error, 'Unavailable — the profile field “Interested in being a candidate” was renamed or taken off');
    }
    assert.equal((await raw(mgr, '/api/quick-reports/running.csv')).status, 409, 'a refusal, never a broken file');
  } finally {
    await db.query("update person_fields set name = 'Interested in being a candidate' where id = $1", [field]);
  }
});

test('members: current, ending in 60 days, lapsed; a voided term is no term', async () => {
  const term = async (person, ends, voided = false) => db.query(
    `insert into member_terms (id, workspace_id, person_id, term_years, starts_on, ends_on, source, voided_at)
     values ($1, $2, $3, 1, $4::date - 365, $4::date, 'paper', $5)`,
    [randomUUID(), ws, person.id, ends, voided ? new Date().toISOString() : null],
  );
  const add = (d) => new Date(Date.parse(`${today}T00:00:00Z`) + d * 864e5).toISOString().slice(0, 10);
  await term(P.beta, add(200));
  await term(P.gamma, add(30));
  await term(P.void, add(-10));
  await term(P.van, add(100), true);
  const who = async (w) => ok(await mgr.get(`/api/quick-reports/members?who=${w}`)).rows.map((r) => r.last_name);
  assert.deepEqual(await who('current'), ['Beta', 'Gamma']);
  assert.deepEqual(await who('ending'), ['Gamma']);
  assert.deepEqual(await who('lapsed'), ['Void']);
  const g = ok(await mgr.get('/api/quick-reports/members?who=ending')).rows[0];
  assert.deepEqual([g.ends_on, g.status, g.joined_by], [add(30), 'Current', 'Paper']);
});

test('signs to put up: requested only, in walking order, by kind', async () => {
  for (const [address, kind] of [['13212 72 Ave', 'lawn'], ['100 Abbey Rd', 'window'], ['13225 72 Ave', 'lawn'], ['13213 72 Ave', 'window'], ['13224 72 Ave', 'lawn']]) {
    ok(await mgr.action('sign.place', { kind, address, person_id: address === '13213 72 Ave' ? P.alpha.id : null }));
  }
  ok(await mgr.action('sign.place', { kind: 'lawn', address: '13215 72 Ave', status: 'installed' }));
  const r = ok(await mgr.get('/api/quick-reports/signs'));
  assert.deepEqual(r.rows.map((x) => x.address), ['13213 72 Ave', '13225 72 Ave', '13224 72 Ave', '13212 72 Ave', '100 Abbey Rd'], 'odd up, even back, street by street');
  assert.equal(r.rows[0].phone, 'Do not call');
  assert.equal(r.rows[0].kind, 'Window sign');
  assert.deepEqual(ok(await mgr.get('/api/quick-reports/signs?kind=window')).rows.map((x) => x.address), ['13213 72 Ave', '100 Abbey Rd']);
  assert.deepEqual(ok(await mgr.get('/api/quick-reports/signs/count')), { count: 5 });
});

test('moved: ext/moves’s own Needs an address, and its count', async () => {
  for (const p of [P.beta, P.gamma]) ok(await mgr.action('contact.log', { person_id: p.id, channel: 'door', outcome: 'moved' }));
  const r = ok(await mgr.get('/api/quick-reports/moved'));
  const ids = r.rows.map((x) => x.id).sort();
  assert.deepEqual(ids, (await movedOpenIds(db, ws)).sort());
  assert.deepEqual(ids, ok(await mgr.get('/api/persons?moved=open&limit=500')).persons.map((p) => p.id).sort());
  assert.deepEqual(r.rows.map((x) => x.last_name), ['Beta', 'Gamma']);
  assert.equal(ok(await mgr.get('/api/quick-reports/moved/count')).count, (await movedCounts(db, ws)).open);
  assert.equal(r.filter, 'moved=open');
  assert.match(r.rows[0].marked_on, /^\d{4}-\d{2}-\d{2}$/);
});

test('refusals: a bad choice, an unknown report, a missing area', async () => {
  const bad = await mgr.get('/api/quick-reports/donors?period=decade');
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'Pick one of: This year, Last year, All time, Lapsed, Monthly');
  assert.equal((await mgr.get('/api/quick-reports/nope')).status, 404);
  assert.equal((await mgr.get('/api/quick-reports/nope/count')).status, 404);
  for (const path of ['/api/quick-reports/donors', '/api/quick-reports/members/count', '/api/quick-reports/donors.csv']) {
    const r = await noMoney.get(path);
    assert.equal(r.status, 403, path);
    assert.equal(r.json.error, 'not for you — ask a manager under Admin → Permissions');
  }
  assert.equal((await mapOnly.get('/api/quick-reports/running')).status, 403, 'Data first');
  assert.equal((await staff.get('/api/quick-reports/running')).status, 200);
});

test('paging: keyset pages have no gap and no overlap across a surname that spans them', async () => {
  // Donors, three to a page, many named Same.
  const same = [];
  for (let i = 0; i < 7; i++) {
    const p = await mgr.createPerson(null, { first_name: `S${i}`, last_name: 'Same' });
    same.push(p.id);
    await gift(p, 100 + (i % 3), `${y - 3}-03-0${i + 1}`);
  }
  for (const order of ['az', 'largest']) {
    const seen = [];
    let after = '';
    for (let n = 0; n < 20; n++) {
      const r = ok(await mgr.get(`/api/quick-reports/donors?period=all&order=${order}&limit=3${after ? `&after=${after}` : ''}`));
      seen.push(...r.rows.map((x) => x.id));
      if (!r.next) break;
      after = encodeURIComponent(r.next);
    }
    assert.equal(new Set(seen).size, seen.length, `${order}: no overlap`);
    const all = ok(await mgr.get(`/api/quick-reports/donors?period=all&order=${order}`)).rows.map((x) => x.id);
    assert.deepEqual(seen, all, `${order}: no gap, the same order`);
    assert.ok(same.every((id) => seen.includes(id)));
  }
});

test('volunteers: more than 5,000, all in the CSV; the id set built once; the role choice; 2,000-row pages', async () => {
  await bulk(5100, { last: 'Helper', tags: ['volunteer'] });
  ok(await mgr.action('volunteer.assign', { person_id: P.beta.id, role: 'driver' }));
  const seen = await spy(async () => {
    const res = await raw(mgr, '/api/quick-reports/volunteers.csv');
    assert.equal(res.status, 200);
    const rows = csvRows(await res.text());
    assert.equal(rows[0].join(','), 'Last name,First name,Phone,Email,Roles,Shifts done,Next shift,Do not contact');
    assert.equal(rows.length - 1, 5101, 'no 5,000 cap');
  });
  assert.equal(seen.filter((s) => s.includes('union select person_id from shift_assignments')).length, 1, 'the union once per request');
  const d = ok(await mgr.get('/api/quick-reports/volunteers?role=driver'));
  assert.deepEqual(d.rows.map((r) => [r.last_name, r.roles]), [['Beta', 'Driver']]);
  assert.equal(d.said, 'Driver');
  const ids = [];
  let after = '';
  for (let n = 0; n < 5; n++) {
    const r = ok(await mgr.get(`/api/quick-reports/volunteers${after ? `?after=${after}` : ''}`));
    assert.ok(r.rows.length <= 2000);
    assert.equal(r.total, 5101);
    ids.push(...r.rows.map((x) => x.id));
    if (!r.next) break;
    after = r.next;
  }
  assert.equal(ids.length, 5101);
  assert.equal(new Set(ids).size, 5101, 'no overlap across the Helpers');
});

test('csvStream: BOM, CRLF, formulas made harmless; a failure part way errors the download', async () => {
  const h = new Hono();
  h.get('/ok', (c) => csvStream(c, 'fine', ['A', 'B'], (async function* () { yield [['=1+1', 'x']]; yield [['a,b', 'y']]; })()));
  h.get('/bad', (c) => csvStream(c, 'broken', ['A'], (async function* () { yield [['one']]; throw new Error('the database went away'); })()));
  const good = await h.request('/ok');
  assert.equal(good.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.equal(good.headers.get('cache-control'), 'no-store');
  assert.match(good.headers.get('content-disposition'), /filename="fine\.csv"/);
  assert.equal(await bytes(good), '﻿A,B\r\n\'=1+1,x\r\n"a,b",y\r\n');
  // A last page that comes back empty (the rows were an exact number of pages).
  h.get('/even', (c) => csvStream(c, 'even', ['A'], (async function* () { yield [['one']]; yield []; yield [['two']]; yield []; })()));
  assert.equal(await bytes(await h.request('/even')), '﻿A\r\none\r\ntwo\r\n');
  const bad = await h.request('/bad');
  const real = console.error; console.error = () => {};
  try { await assert.rejects(bad.text()); } finally { console.error = real; }
});

test('the walking list: the turf’s doors, names apart, no phone or email; left vs all; the scale’s words', async () => {
  const mk = async (key, first, last, house, extra = {}) => {
    P[key] = await mgr.createPerson(null, { first_name: first, last_name: last, address: `${house} 72 Ave`, house_number: house, lat, lng: lng + (Number(house) % 7) * 0.00005, ...extra });
  };
  await mk('w1', 'Ana', 'Walker', '13213', { phone: '604-555-0121', email: `ana.${tag}@example.org`, rating: '2' });
  await mk('w2', 'Ben', 'Walker', '13225', { tags: ['Do-Not-Contact'] });
  await mk('w3', 'Cy', 'Walker', '13224', { rating: '4B' });
  await mk('w4', 'Dee', 'Walker', '13212');
  for (const [k, r] of [['w1', '2'], ['w3', '4B']]) await db.query('update persons set rating = $2 where id = $1', [P[k].id, r]);
  const turf = ok(await mgr.action('turf.create', {
    name: 'Newton block', polygon: [[lat + 0.001, lng - 0.001], [lat + 0.001, lng + 0.002], [lat - 0.001, lng + 0.002], [lat - 0.001, lng - 0.001]],
  })).turf;
  const before = ok(await mgr.get(`/api/turfs/${turf.id}/walk`));
  assert.ok(before.doors[0].persons.every((p) => !('first_name' in p) && 'email' in p), 'the walk list itself is as it was');
  // No pass: every door, whatever was knocked.
  const all0 = ok(await mgr.get(`/api/quick-reports/walk?turf=${turf.id}&doors=left`));
  assert.equal(all0.doors_shown, 'all');
  assert.deepEqual(all0.doors.map((d) => d.address), before.doors.map((d) => d.address), 'the same doors in the same order');
  ok(await mgr.action('pass.start', { name: 'First pass', kind: 'id' }));
  ok(await mgr.action('contact.log', { person_id: P.w4.id, channel: 'door', outcome: 'contacted', rating: '1' }));
  const walkList = ok(await mgr.get(`/api/turfs/${turf.id}/walk`));
  const every = ok(await mgr.get(`/api/quick-reports/walk?turf=${turf.id}&doors=all`));
  assert.deepEqual(every.doors.map((d) => [d.address, d.state]), walkList.doors.map((d) => [d.address, d.state]));
  assert.deepEqual(every.doors.map((d) => d.address), ['13213 72 Ave', '13225 72 Ave', '13224 72 Ave', '13212 72 Ave']);
  const left = ok(await mgr.get(`/api/quick-reports/walk?turf=${turf.id}`));
  assert.equal(left.doors_shown, 'left');
  assert.deepEqual(left.doors.map((d) => d.address), ['13213 72 Ave', '13225 72 Ave', '13224 72 Ave'], 'a done door is not still to knock');
  assert.equal(left.pass.name, 'First pass');
  for (const d of every.doors) {
    assert.deepEqual([d.house_number, d.street], [d.address.split(' ')[0], '72 Ave']);
    for (const p of d.persons) {
      assert.deepEqual(Object.keys(p).sort(), ['first_name', 'id', 'last_name', 'name', 'no_contact', 'rating', 'rating_word', 'voted_at']);
    }
  }
  const person = (id) => every.doors.flatMap((d) => d.persons).find((p) => p.id === id);
  assert.deepEqual([person(P.w1.id).first_name, person(P.w1.id).last_name, person(P.w1.id).rating_word], ['Ana', 'Walker', 'Lean yes']);
  assert.equal(person(P.w2.id).no_contact, 'Do not contact', 'kept, and marked');
  assert.equal(person(P.w3.id).rating_word, 'Voting for Locke');
  assert.equal(every.scale.steps.length, 4);
  assert.deepEqual(every.scale.steps.map((s) => s.word), ['Strong yes', 'Lean yes', 'Undecided', 'Opposed']);
  assert.deepEqual(every.scale.candidates.map((c) => c.code), ['4D', '4B', '4F', '4N', '4C']);
  assert.equal(every.campaign, `Quick ${tag}`);
  assert.deepEqual(every.counts, { doors: 4, people: 4 });
  // A candidate taken off the list is not offered on paper.
  await db.query(`update workspaces set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{scale}', $2::jsonb) where id = $1`,
    [ws, JSON.stringify({ candidates: SURREY_CANDIDATES.map((c) => ({ ...c, off: c.code === '4C' })) })]);
  assert.deepEqual(ok(await mgr.get(`/api/quick-reports/walk?turf=${turf.id}`)).scale.candidates.map((c) => c.code), ['4D', '4B', '4F', '4N']);
  // The CSV: the sheet's doors, Street with its capitals, no phone or email.
  const res = await raw(mgr, `/api/quick-reports/walk.csv?turf=${turf.id}&doors=all`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), new RegExp(`walking-list-newton-block-${today}\\.csv`));
  const rows = csvRows(await res.text());
  assert.deepEqual(rows[0], ['Street', 'Number', 'Unit', 'Last name', 'First name', 'Support', 'Support code', 'Voted', 'Do not contact', 'Door']);
  assert.deepEqual(rows[1], ['72 Ave', '13213', '', 'Walker', 'Ana', 'Lean yes', '2', '', '', 'To knock']);
  assert.ok(!rows.flat().some((x) => /604-555|@example\.org/.test(x)), 'no phone, no email');
  assert.equal(rows.at(-1).at(-1), 'Done');
  // Who may: Map alone is enough; Map denied is not.
  for (const path of [`/api/quick-reports/walk?turf=${turf.id}`, `/api/quick-reports/walk.csv?turf=${turf.id}`, '/api/quick-reports/walk/unplaced']) {
    assert.equal((await raw(mapOnly, path)).status, 200, path);
    assert.equal((await raw(noMap, path)).status, 403, path);
  }
  assert.equal((await mgr.get(`/api/quick-reports/walk?turf=${randomUUID()}`)).status, 404);
  assert.equal((await mgr.get(`/api/quick-reports/walk?turf=${turf.id}&doors=some`)).status, 400);
});

test('walk/unplaced counts people with an address and no pin', async () => {
  const before = ok(await mgr.get('/api/quick-reports/walk/unplaced')).count;
  await mgr.createPerson(null, { first_name: 'Una', last_name: 'Unplaced', address: '1 Nowhere Rd' });
  assert.equal(ok(await mgr.get('/api/quick-reports/walk/unplaced')).count, before + 1);
});

test('a turf of 1,600 doors prints 1,500 and says so; one drawn round the city is refused before anyone is read', async () => {
  const lat0 = 49.2; const lng0 = -122.7;
  await bulk(1600, { last: 'Door', lat0, lng0, street: 'Long St' });
  const turf = ok(await mgr.action('turf.create', {
    name: 'A very long turf name here', polygon: [[lat0 - 0.0001, lng0 - 0.0001], [lat0 - 0.0001, lng0 + 0.001], [lat0 + 0.002, lng0 + 0.001], [lat0 + 0.002, lng0 - 0.0001]],
  })).turf;
  const s = ok(await mgr.get(`/api/quick-reports/walk?turf=${turf.id}`));
  assert.equal(s.doors.length, WALK_DOORS_MAX);
  assert.equal(s.more, 100);
  const res = await raw(mgr, `/api/quick-reports/walk.csv?turf=${turf.id}`);
  assert.match(res.headers.get('content-disposition'), /-first-1500-doors\.csv"/);
  const rows = csvRows(await res.text()).slice(1);
  assert.equal(new Set(rows.map((r) => `${r[1]} ${r[0]}`)).size, 1500, 'the same 1,500 doors');
  // Round the city: 6,001 people in its box.
  const lat1 = 49.0; const lng1 = -122.9;
  await bulk(6001, { last: 'Crowd', lat0: lat1, lng0: lng1, street: 'Wide Rd' });
  const big = ok(await mgr.action('turf.create', {
    name: 'Everywhere', polygon: [[lat1 - 0.01, lng1 - 0.01], [lat1 - 0.01, lng1 + 0.05], [lat1 + 0.05, lng1 + 0.05], [lat1 + 0.05, lng1 - 0.01]],
  })).turf;
  const seen = await spy(async () => {
    for (const path of [`/api/quick-reports/walk?turf=${big.id}`, `/api/quick-reports/walk.csv?turf=${big.id}`]) {
      const r = await raw(mgr, path);
      assert.equal(r.status, 409, path);
      assert.equal((await r.json()).error, 'This turf is too big to print — split it on the map');
    }
  });
  assert.ok(!seen.some((q) => q.includes('pass_last_outcome')), 'loadLocated never ran');
});

test('the plans: each recipe starts from its small table, never a pass over persons', async () => {
  const plans = async (fn) => {
    const qs = [];
    const fake = { query: (sql, params) => { qs.push([sql, params]); return db.query(sql, params); } };
    await fn(fake);
    return db.transaction(async (tx) => {
      await tx.query('set local enable_seqscan = off');
      let out = '';
      for (const [sql, params] of qs) {
        if (!/^\s*select/i.test(sql)) continue;
        out += (await tx.query(`explain ${sql}`, params)).rows.map((r) => r['QUERY PLAN']).join('\n');
        out += '\n';
      }
      return out;
    });
  };
  const ctx = ctxOf();
  const run = (name, opts) => async (q) => { await RECIPES[name].count(q, ctx, opts); await RECIPES[name].rows(q, ctx, opts, { limit: 2000 }); };
  const donors = await plans(run('donors', { period: 'year', order: 'az' }));
  assert.match(donors, /gifts_ws_person_date_idx/); assert.doesNotMatch(donors, /Seq Scan on persons/);
  const running = await plans(run('running', {}));
  assert.match(running, /person_field_values_find_idx/); assert.doesNotMatch(running, /Seq Scan on persons/);
  const moved = await plans(async (q) => {
    await RECIPES.moved.count(q, ctx, {});
    const ids = await RECIPES.moved.idsFor(q, ctx, {});
    await RECIPES.moved.rows(q, ctx, {}, { limit: 2000, ids });
  });
  assert.match(moved, /contacts_moved_idx/); assert.doesNotMatch(moved, /Seq Scan on persons/);
  const vols = await plans(async (q) => {
    const ids = await RECIPES.volunteers.idsFor(q, ctx, { role: 'driver' });
    await RECIPES.volunteers.rows(q, ctx, { role: 'driver' }, { limit: 2000, ids });
  });
  assert.doesNotMatch(vols, /Seq Scan on persons/);
});
