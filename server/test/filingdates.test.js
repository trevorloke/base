// The financial agent's two filing dates (ext/filingdates): a name and a
// date each, typed in — no law, date or name comes with the product.
// Managers and treasurers set them; the desk that handles donations reads
// them with the days left; Today carries the ones within 30 days for money
// roles; a volunteer never receives one.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { campaignDay } from '../lib/gifts.js';

const tag = Math.random().toString(36).slice(2, 8);
const mail = (who) => `${who}.fd.${tag}@example.org`;
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
let db, mgr, treas, staff, vol, ws;

const member = async (role, who) => {
  const c = new Client();
  const r = await c.signup({ workspaceName: `Temp ${who} ${tag}`, email: mail(who) });
  await db.query('update memberships set workspace_id = $2, role = $3 where user_id = $1', [r.json.user.id, ws, role]);
  await db.query('update sessions set workspace_id = $2 where user_id = $1', [r.json.user.id, ws]);
  return c;
};
// A day n days from today, on the campaign's calendar.
const today = () => campaignDay(new Date(), 'America/Vancouver');
const plus = (n) => {
  const [y, m, d] = today().split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const read = async (c) => ok(await c.get('/api/money/filing-dates'));
const onToday = async (c) => ok(await c.get('/api/brief')).filing;

before(async () => {
  db = await freshDb();
  mgr = new Client();
  ws = (await mgr.signup({ workspaceName: `Filing ${tag}`, email: mail('mgr'), jurisdiction: 'bc-municipal' })).json.workspace.id;
  treas = await member('treasurer', 'treas');
  staff = await member('staff', 'staff');
  vol = await member('volunteer', 'vol');
});

test('nothing comes with the product: no dates until the agent types them', async () => {
  const r = await read(treas);
  assert.deepEqual(r.dates, []);
  assert.equal(r.can_edit, true);
  assert.equal((await read(staff)).can_edit, false);
  assert.deepEqual(await onToday(treas), []);
});

test('two dates, each a name and a day, with the days left', async () => {
  const saved = ok(await treas.action('filing.dates', { dates: [
    { name: '  Disclosure statement due ', due_on: plus(12) },
    { name: 'Annual report due', due_on: plus(80) },
  ] }));
  assert.deepEqual(saved.dates.map((d) => [d.slot, d.name, d.due_on, d.days]), [
    [1, 'Disclosure statement due', plus(12), 12],
    [2, 'Annual report due', plus(80), 80],
  ]);
  for (const c of [mgr, treas, staff]) {
    assert.deepEqual((await read(c)).dates.map((d) => [d.name, d.days]), [['Disclosure statement due', 12], ['Annual report due', 80]]);
  }
  assert.equal((await read(treas)).today, today());
});

test('Today carries the ones within 30 days, for money roles only', async () => {
  for (const c of [mgr, treas, staff]) {
    assert.deepEqual(await onToday(c), [{ name: 'Disclosure statement due', due_on: plus(12), days: 12 }]);
  }
  assert.equal((await onToday(vol)), undefined, 'a volunteer’s Today has none');
  // Donations counts down to both, however far, from the same read.
  assert.deepEqual(ok(await treas.get('/api/brief')).filingAll.map((d) => [d.slot, d.name, d.days]),
    [[1, 'Disclosure statement due', 12], [2, 'Annual report due', 80]]);
  assert.equal(ok(await vol.get('/api/brief')).filingAll, undefined);
  // The day itself and the 30th day count; the 31st does not; one that has passed is off Today.
  ok(await mgr.action('filing.dates', { dates: [{ name: 'Due today', due_on: plus(0) }, { name: 'Due in thirty', due_on: plus(30) }] }));
  assert.deepEqual((await onToday(staff)).map((d) => d.days), [0, 30]);
  ok(await mgr.action('filing.dates', { dates: [{ name: 'Was due', due_on: plus(-3) }, { name: 'Due in thirty-one', due_on: plus(31) }] }));
  assert.deepEqual(await onToday(treas), []);
  assert.deepEqual((await read(treas)).dates.map((d) => [d.name, d.days]), [['Was due', -3], ['Due in thirty-one', 31]], 'Donations still shows both');
});

test('who may: managers and treasurers set them; staff read; volunteers neither', async () => {
  const one = { dates: [{ name: 'Statement', due_on: plus(5) }] };
  assert.equal((await staff.action('filing.dates', one)).status, 403);
  assert.equal((await vol.action('filing.dates', one)).status, 403);
  assert.equal((await vol.get('/api/money/filing-dates')).status, 403);
  ok(await mgr.action('filing.dates', one));
  assert.deepEqual((await read(staff)).dates.map((d) => [d.slot, d.name]), [[1, 'Statement']], 'the second was cleared: it was left out');
});

test('a name needs its date and a date its name; an empty pair clears it; never more than two', async () => {
  assert.equal((await treas.action('filing.dates', { dates: [{ name: 'No day', due_on: null }] })).status, 400);
  assert.equal((await treas.action('filing.dates', { dates: [{ name: '', due_on: plus(4) }] })).status, 400);
  assert.equal((await treas.action('filing.dates', { dates: [{ name: 'Bad', due_on: '15/01/2027' }] })).status, 400);
  assert.equal((await treas.action('filing.dates', { dates: [{ name: 'a', due_on: plus(1) }, { name: 'b', due_on: plus(2) }, { name: 'c', due_on: plus(3) }] })).status, 400);
  assert.deepEqual((await read(treas)).dates.map((d) => d.name), ['Statement'], 'a refused save changes nothing');
  // The first cleared, the second set: each keeps its place.
  ok(await treas.action('filing.dates', { dates: [{ name: '', due_on: null }, { name: 'Second only', due_on: plus(9) }] }));
  assert.deepEqual((await read(treas)).dates.map((d) => [d.slot, d.name, d.days]), [[2, 'Second only', 9]]);
  ok(await treas.action('filing.dates', { dates: [] }));
  assert.deepEqual((await read(treas)).dates, []);
});

test('on the books, in the export, and the record checks out', async () => {
  ok(await treas.action('filing.dates', { dates: [{ name: 'Disclosure statement due', due_on: plus(20) }] }));
  const ev = (await db.query(
    `select action, payload, actor_id from events where workspace_id = $1 and entity_type = 'filing_dates' order by seq desc limit 1`, [ws],
  )).rows[0];
  assert.equal(ev.action, 'filing.dates');
  assert.ok(ev.actor_id, 'by the person who typed it');
  const exported = ok(await mgr.get('/api/export'));
  assert.deepEqual(exported.filing_dates.map((d) => d.name), ['Disclosure statement due']);
  assert.equal(ok(await mgr.get('/api/audit/verify')).ok, true);
});
