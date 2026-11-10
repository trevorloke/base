// Gifts made in another tool, brought in from its spreadsheet (ext/
// giftimport): the cells are read one way (shared/giftfile.js); the check
// saves nothing and says what would happen; a donor is found by email, or by
// first and last name with the same phone, postal code or street — one sure
// match, or the gift waits for a person; every gift goes through the one
// gift path, so the year's limit is checked and the gift that crosses it is
// flagged — yet no receipt number is used, nothing is emailed, no ladder
// starts and it is not in To thank; the same file adds nothing twice; the
// pile is settled by a person; an import is taken back whole within a day.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';
import { runDueJobs } from '../lib/jobs.js';
import { campaignDay } from '../lib/gifts.js';
import {
  readAmount, readGiftDate, dateOrderOf, readMethod, flipName, giftKey, keyRows,
} from '@starbase/shared/giftfile';

const tag = Math.random().toString(36).slice(2, 8);
const mail = (who) => `${who}.gi.${tag}@example.org`;
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
// Gifts dated last year: never in the future, whenever this runs. The limit
// is set for every year (settings.capCents), so a year needs no rule.
const yr = new Date().getFullYear() - 1;
const CAP = 100000; // $1,000
let db, mgr, treas, staff, vol, ws;
const P = {};

const member = async (role, who) => {
  const c = new Client();
  const r = await c.signup({ workspaceName: `Temp ${who} ${tag}`, email: mail(who) });
  await db.query('update memberships set workspace_id = $2, role = $3 where user_id = $1', [r.json.user.id, ws, role]);
  await db.query('update sessions set workspace_id = $2 where user_id = $1', [r.json.user.id, ws]);
  return c;
};
const person = async (first, last, extra = {}) => ok(await mgr.action('person.create', { kind: 'person', first_name: first, last_name: last, ...extra })).person;
const raw = async (client, path) => {
  const res = await app.request(path, { headers: client.cookie ? { cookie: client.cookie } : {} });
  return { status: res.status, text: await res.text() };
};
// One row of a file, as the screen sends it.
let rowNo = 1;
const row = (over = {}) => ({ row: (rowNo += 1), amount_cents: 5000, date: `${yr}-03-01`, method: 'cheque', ...over });
const check = async (rows, client = treas) => ok(await client.action('gift.import', { import_id: randomUUID(), file_name: 'gifts.csv', rows, dry_run: true }));
const bring = async (rows, { id = randomUUID(), client = treas, file = 'gifts.csv' } = {}) => ({ id, ...ok(await client.action('gift.import', { import_id: id, file_name: file, rows })) });
const states = (r) => r.results.map((x) => x.state);
const giftsOf = async (personId) => (await db.query(
  'select id, amount_cents, date, flagged, flag_reason, attrs, deleted_at from gifts where workspace_id = $1 and person_id = $2 order by date, created_at', [ws, personId],
)).rows.map((g) => ({ ...g, attrs: typeof g.attrs === 'string' ? JSON.parse(g.attrs) : g.attrs }));
const count = async (sql, params = [ws]) => Number((await db.query(sql, params)).rows[0].n);

before(async () => {
  db = await freshDb();
  mgr = new Client();
  const r = await mgr.signup({ workspaceName: `Gift file ${tag}`, email: mail('mgr'), jurisdiction: 'bc-municipal' });
  ws = r.json.workspace.id;
  await db.query(`update workspaces set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{capCents}', $2::jsonb) where id = $1`, [ws, String(CAP)]);
  treas = await member('treasurer', 'treas');
  staff = await member('staff', 'staff');
  vol = await member('volunteer', 'vol');
  P.ana = await person('Ana', 'Example', { email: mail('ana'), phone: '604-555-0101', address: '13450 104 Ave', city: 'Surrey', postal: 'V3T 1V8' });
  P.ben = await person('Ben', 'Example', { phone: '(604) 555-0102', address: '9 Oak Ave', postal: 'V3T 2C3' });
  P.cy = await person('Cy', 'Example', { address: '77 Pine St', postal: 'V4N 0N2' });
  // Two records with one name in one postal code: never a sure match.
  P.dee1 = await person('Dee', 'Twin', { postal: 'V3S 1A1', address: '1 Main St' });
  P.dee2 = await person('Dee', 'Twin', { postal: 'V3S 1A1', address: '2 Main St' });
  // A couple who share one email.
  P.eli = await person('Eli', 'Shared', { email: mail('family') });
  P.fay = await person('Fay', 'Shared', { email: mail('family') });
});

test('the cells of a gift file are read one way', () => {
  assert.equal(readAmount('$1,250.00'), 125000);
  assert.equal(readAmount('49.99'), 4999);
  assert.equal(readAmount('50,00'), 5000, 'a decimal comma');
  assert.equal(readAmount('CA$ 50'), 5000);
  assert.equal(readAmount(20), 2000);
  for (const bad of ['', 'abc', '0', '-5', '(5.00)', '33.3333', '2000000']) assert.equal(readAmount(bad), null, bad);
  assert.equal(readGiftDate('2026-03-01'), '2026-03-01');
  assert.equal(readGiftDate('Mar 1, 2026'), '2026-03-01');
  assert.equal(readGiftDate('1 March 2026'), '2026-03-01');
  assert.equal(readGiftDate('03/04/2026'), '2026-03-04', 'month first unless told');
  assert.equal(readGiftDate('03/04/2026', { order: 'dmy' }), '2026-04-03');
  assert.equal(readGiftDate('31/02/2026', { order: 'dmy' }), null, 'not a day');
  // An instant is the day it was in the campaign's time zone: New Year's Eve stays in its year.
  assert.equal(readGiftDate('2026-01-01T02:00:00Z', { timeZone: 'America/Vancouver' }), '2025-12-31');
  assert.equal(dateOrderOf(['03/04/2026', '13/04/2026']), 'dmy');
  assert.equal(dateOrderOf(['03/14/2026']), 'mdy');
  assert.equal(dateOrderOf(['03/04/2026']), 'either');
  assert.equal(dateOrderOf(['03/14/2026', '14/03/2026']), 'mixed');
  assert.equal(dateOrderOf(['2026-03-01']), null);
  assert.deepEqual(['Visa', 'Cheque', 'Check', 'Interac e-Transfer', 'Cash', 'Pre-authorized debit', 'In-Kind', 'Wire'].map(readMethod),
    ['card', 'cheque', 'cheque', 'etransfer', 'cash', 'pad', 'in-kind', null]);
  assert.equal(flipName('Example, Ana'), 'Ana Example');
  assert.equal(flipName('Ana Example'), 'Ana Example');
  // The other tool's id is the gift; without one, donor + amount + date + method.
  assert.equal(giftKey({ source_id: ' GL-7 ', name: 'x', amount_cents: 1 }), 'id:GL-7');
  assert.equal(giftKey({ first: 'Ana', last: 'Example', amount_cents: 5000, date: '2026-03-01', method: 'cash' }),
    giftKey({ name: 'ana  EXAMPLE', amount_cents: 5000, date: '2026-03-01', method: 'cash' }));
  const keyed = keyRows([
    { name: 'Ana Example', amount_cents: 2000, date: '2026-03-01', method: 'cash' },
    { name: 'Ana Example', amount_cents: 2000, date: '2026-03-01', method: 'cash' },
    { source_id: 'A1', amount_cents: 2000 }, { source_id: 'A1', amount_cents: 2000 },
  ]);
  assert.deepEqual(keyed.map((k) => [k.nth, k.alike, k.repeat]), [[1, false, false], [2, true, false], [1, false, false], [1, false, true]]);
  assert.notEqual(keyed[0].key, keyed[1].key, 'two $20 cash gifts on one day are two gifts');
});

// The screen's side (web/src/components/GiftColumns.js): no tool's column
// names are assumed — a column is matched by what its heading means, then
// by its values, and a row is read into what the server takes.
test('columns are matched by what their headings mean; rows are read; the check is added up', async () => {
  const { guessGiftMapping, giftRow, fileRows, callsOf, newTally, addToTally, overLimit } = await import('../../web/src/components/GiftColumns.js');
  const slates = [{ code: 'council', label: 'Council' }, { code: 'school', label: 'School board' }];
  const recs = (rows) => rows.map((cells, i) => ({ cells, row: i + 2 }));
  // One export's words…
  const a = recs([
    ['7001', 'Example, Ana', 'ana@example.org', '604-555-0101', '13450 104 Ave', 'V3T 1V8', '$1,250.00', '03/14/2026', 'Visa', 'Council', 'R-17', 'Spring appeal'],
    ['7002', 'Ben Example', 'ben@example.org', '6045550102', '9 Oak Ave', 'V3T 2C3', '50', '04/02/2026', 'Cheque', 'School board trustees', '', 'Spring appeal'],
  ]);
  assert.deepEqual(
    guessGiftMapping(['Transaction ID', 'Donor', 'Donor Email', 'Phone', 'Billing Address', 'Postal Code', 'Amount', 'Date Received', 'Payment Method', 'Designation', 'Receipt #', 'Campaign Name'], a, { slates }),
    ['source_id', 'name', 'email', 'phone', 'address', 'postal', 'amount', 'date', 'method', 'slate', 'receipt', ''],
  );
  // …and another's: first and last apart, the gift's own date beside the record's, no slate to match with one slate.
  const b = recs([
    ['Cy', 'Example', 'cy@example.org', '2026-05-01 09:12', '2026-05-03', '20.00', 'E-Transfer', 'General', 'Fall Gala'],
    ['Dee', 'Twin', 'dee@example.org', '2026-05-02 10:00', '2026-05-04', '35.50', 'Cash', 'General', 'Fall Gala'],
  ]);
  assert.deepEqual(
    guessGiftMapping(['First Name', 'Last Name', 'E-mail', 'Created At', 'Donation Date', 'Gift Amount', 'Paid By', 'Fund', 'Event name'], b, { slates: [slates[0]] }),
    ['first', 'last', 'email', '', 'date', 'amount', 'method', '', ''],
    'the date named for the gift is taken; a name beside first and last is not the donor’s',
  );
  // A heading that says Amount over cells that aren't amounts is not taken.
  assert.deepEqual(guessGiftMapping(['Name', 'Amount', 'Date'], recs([['Ana Example', 'pending', 'soon']]), {}), ['name', '', '']);
  // No headings at all: from the values.
  assert.deepEqual(guessGiftMapping(['Column 1', 'Column 2', 'Column 3', 'Column 4'], recs([['Ana Example', 'ana@example.org', '$50.00', 'Mar 1, 2026'], ['Ben Example', 'ben@example.org', '$20.00', 'Mar 2, 2026']]), { noHeader: true }),
    ['name', 'email', 'amount', 'date']);

  const mapping = ['source_id', 'name', 'email', 'phone', 'address', 'postal', 'amount', 'date', 'method', 'slate', 'receipt', ''];
  assert.deepEqual(giftRow(a[0].cells, mapping, { slates }).row, {
    name: 'Ana Example', email: 'ana@example.org', phone: '604-555-0101', address: '13450 104 Ave', postal: 'V3T 1V8',
    source_id: '7001', amount_cents: 125000, date: '2026-03-14', method: 'card', paid_as: 'Visa', slate: 'council', receipt: 'R-17',
  });
  assert.equal(giftRow(a[1].cells, mapping, { slates }).row.slate, 'school', 'a slate by the word it holds');
  assert.equal(giftRow(a[1].cells, mapping, { slates, order: 'dmy' }).row.date, '2026-02-04');
  assert.equal(giftRow(a[1].cells, mapping, { slates, methodMap: { cheque: 'cash' }, slateMap: { 'school board trustees': '' } }).row.method, 'cash', 'what the person says a value means');
  assert.equal(giftRow(a[1].cells, mapping, { slates, methodMap: { cheque: '' } }).row.paid_as, 'Cheque', 'the file’s own word goes with it, whatever it was read as');
  assert.equal(giftRow(a[1].cells, mapping, { slates, slateMap: { 'school board trustees': '' } }).row.slate, undefined);
  assert.match(giftRow(['1', 'Ana Example', '', '', '', '', 'n/a', '03/14/2026'], mapping).error, /“n\/a” isn’t an amount/);
  assert.match(giftRow(['1', 'Ana Example', '', '', '', '', '5', 'someday'], mapping).error, /“someday” isn’t a date/);
  assert.match(giftRow(['1.6047E+10', 'Ana Example', '', '', '', '', '5', '03/14/2026'], mapping).error, /lost its last digits in Excel/);
  assert.equal(giftRow(['1', 'Ana Example', '', '1.6047E+10', '', '', '5', '03/14/2026'], mapping).row.phone, undefined, 'a phone Excel cut short is dropped');

  // A file's rows: a gift number met twice is that gift again; rows alike with no number are each a gift.
  const f = fileRows(recs([
    ['9', 'Ana Example', '', '', '', '', '20', '2026-03-01'], ['9', 'Ana Example', '', '', '', '', '20', '2026-03-01'],
    ['', 'Ben Example', '', '', '', '', '20', '2026-03-01'], ['', 'Ben Example', '', '', '', '', '20', '2026-03-01'],
    ['', 'Cy Example', '', '', '', '', '', '2026-03-01'],
  ]), mapping, {});
  assert.deepEqual([f.rows.length, f.repeats, f.alike, f.unread.length], [3, 1, 1, 1]);
  assert.deepEqual(f.rows.map((r) => [r.row, r.nth]), [[2, undefined], [4, undefined], [5, 2]]);
  assert.deepEqual(f.unread, [{ row: 6, text: 'No amount.' }]);
  // A file that lists the newest first is sent oldest first: the gift that crosses a limit is the later one.
  const newestFirst = fileRows(recs([
    ['3', 'Ana Example', '', '', '', '', '20', '2026-09-01'], ['2', 'Ana Example', '', '', '', '', '20', '2026-02-01'], ['1', 'Ben Example', '', '', '', '', '20', '2026-02-01'],
  ]), mapping, {});
  assert.deepEqual(newestFirst.rows.map((r) => [r.date, r.row]), [['2026-02-01', 3], ['2026-02-01', 4], ['2026-09-01', 2]]);
  // A gift number that isn't one — the donor's own number, the same on each of their gifts — is not taken for it.
  assert.deepEqual(guessGiftMapping(['ID', 'Donor', 'Amount', 'Date'], recs([['77', 'Ana Example', '$20.00', '2026-03-01'], ['77', 'Ana Example', '$30.00', '2026-04-01']]), {}),
    ['', 'name', 'amount', 'date']);
  assert.deepEqual(guessGiftMapping(['ID', 'Donor', 'Amount', 'Date'], recs([['77', 'Ana Example', '$20.00', '2026-03-01'], ['78', 'Ana Example', '$30.00', '2026-04-01']]), {}),
    ['source_id', 'name', 'amount', 'date']);
  // An email cell that isn't an address ("n/a") is left out, and counted: the gift still comes in.
  const noMail = fileRows(recs([['', 'Ana Example', 'n/a', '', '', '', '20', '2026-03-01'], ['', 'Ben Example', 'ben@example.org', '', '', '', '20', '2026-03-01']]), mapping, {});
  assert.deepEqual([noMail.rows.map((r) => r.email), noMail.badEmails], [[undefined, 'ben@example.org'], 1]);

  // Calls stay small: by rows, and by size.
  const many = Array.from({ length: 450 }, (_, i) => ({ row: i, name: 'Ana Example', amount_cents: 100 }));
  assert.deepEqual(callsOf(many).map((p) => p.length), [100, 100, 100, 100, 50]);
  assert.ok(callsOf(many.map((r) => ({ ...r, address: 'x'.repeat(900) }))).every((p) => JSON.stringify(p).length < 200_000));

  // The check, added up over two calls: a donor the file takes over the limit across them.
  const t = newTally();
  addToTally(t, { results: [
    { state: 'new', person_id: 'p1', person_name: 'Ana Example', by: 'email', name_differs: false, year: 2026, slate: 'council', amount_cents: 60000 },
    { state: 'waiting', candidates: 0 }, { state: 'already' }, { state: 'invalid', error: 'The date is in the future.' },
  ], donors: [{ person_id: 'p1', name: 'Ana Example', year: 2026, slate: 'council', on_file_cents: 30000, cap_cents: 100000 }] },
  [{ row: 2, name: 'Ana Example' }, { row: 3, name: 'New Donor', amount_cents: 2500 }, { row: 4 }, { row: 5 }]);
  assert.deepEqual(overLimit(t), [], 'not over yet');
  addToTally(t, { results: [
    { state: 'new', person_id: 'p1', person_name: 'Ana Example', by: 'email', name_differs: true, year: 2026, slate: 'council', amount_cents: 20000 },
    { state: 'new', person_id: 'p2', person_name: 'Ben Example', by: 'phone', name_differs: false, year: 2026, slate: 'council', amount_cents: 5000 },
  ], donors: [
    { person_id: 'p1', name: 'Ana Example', year: 2026, slate: 'council', on_file_cents: 30000, cap_cents: 100000 },
    { person_id: 'p2', name: 'Ben Example', year: 2026, slate: 'council', on_file_cents: 0, cap_cents: null },
  ] }, [{ row: 6, name: 'A. Example' }, { row: 7, name: 'Ben Example' }]);
  assert.deepEqual([t.fresh, t.waiting, t.already, t.invalid.length, t.people.size, t.cents, t.differs], [3, 1, 1, 1, 2, 87500, 1]);
  assert.deepEqual(overLimit(t), [{ person_id: 'p1', name: 'Ana Example', year: 2026, slate: 'council', total_cents: 110000, cap_cents: 100000 }]);
  assert.deepEqual(t.invalid, [{ row: 5, text: 'The date is in the future.' }]);
  assert.equal(t.matches[0].differs, true, 'a match under another name is listed first');
});

test('the check saves nothing and says what would happen', async () => {
  const before = await count('select count(*) as n from events where workspace_id = $1');
  const r = await check([
    row({ first: 'Ana', last: 'Example', email: mail('ana').toUpperCase(), amount_cents: 60000 }),
    row({ name: 'Ana Example', email: mail('ana'), amount_cents: 60000, date: `${yr}-04-01` }),
    row({ first: 'Ben', last: 'Example', phone: '6045550102', amount_cents: 2500 }),
    row({ name: 'Nobody Known', email: mail('nobody'), amount_cents: 7500 }),
    row({ first: 'Dee', last: 'Twin', postal: 'v3s1a1' }),
    row({ name: 'No Amount', amount_cents: 0 }),
    row({ amount_cents: 5000 }),
    row({ name: 'Bad Day', date: '03/04/2026' }),
    row({ name: 'Tomorrow Person', date: '2099-01-01' }),
  ]);
  assert.equal(r.dry_run, true);
  assert.deepEqual(states(r), ['new', 'new', 'new', 'waiting', 'waiting', 'invalid', 'invalid', 'invalid', 'invalid']);
  assert.deepEqual(r.counts, { new: 3, waiting: 2, already: 0, invalid: 4 });
  assert.equal(r.results[0].person_id, P.ana.id);
  assert.equal(r.results[0].by, 'email');
  assert.equal(r.results[2].person_id, P.ben.id);
  assert.equal(r.results[2].by, 'phone');
  assert.equal(r.results[3].candidates, 0);
  assert.equal(r.results[4].candidates, 2, 'two records it could be');
  assert.match(r.results[5].error, /amount/i);
  assert.match(r.results[6].error, /name/i);
  assert.match(r.results[7].error, /date/i);
  assert.match(r.results[8].error, /future/i);
  // What each donor has on file for the year and the limit, so the screen
  // can say who the file would take over it.
  const ana = r.donors.find((d) => d.person_id === P.ana.id);
  assert.deepEqual([ana.name, ana.year, ana.on_file_cents, ana.cap_cents], ['Ana Example', yr, 0, CAP]);
  assert.equal(await count('select count(*) as n from gifts where workspace_id = $1'), 0, 'no gift');
  assert.equal(await count('select count(*) as n from gift_imports where workspace_id = $1'), 0, 'no import kept');
  assert.equal(await count('select count(*) as n from gift_import_rows where workspace_id = $1'), 0);
  assert.equal(await count('select count(*) as n from events where workspace_id = $1'), before, 'nothing on the books');
});

test('who the donor is: each rule, and when a row waits', async () => {
  const r = await check([
    row({ name: 'Somebody Else', email: mail('ana') }),                         // 0 the same email: that person
    row({ first: 'Ben', last: 'Example', phone: '604 555 0102' }),              // 1 name + phone
    row({ first: 'ben', last: 'EXAMPLE', postal: 'v3t-2c3' }),                  // 2 name + postal code
    row({ name: 'Cy Example', address: '77  pine st' }),                        // 3 name + street
    row({ first: 'Cy', last: 'Example' }),                                      // 4 the name alone is never enough
    row({ first: 'Cy', last: 'Example', postal: 'V9Z 9Z9', phone: '6045550199' }), // 5 nothing shared
    row({ first: 'Dee', last: 'Twin', postal: 'V3S 1A1' }),                     // 6 two it could be
    row({ first: 'Dee', last: 'Twin', address: '2 Main St' }),                  // 7 the street tells them apart
    row({ name: 'Someone Shared', email: mail('family') }),                     // 8 one email, two records
    row({ first: 'Fay', last: 'Shared', email: mail('family') }),               // 9 …and the name says which
    row({ first: 'Ben', last: 'Example', email: mail('ana'), phone: '6045550102' }), // 10 the email is Ana's, the name and phone are Ben's
    row({ first: 'Ana', last: 'Example', email: mail('new-address'), phone: '6045550101' }), // 11 a new email, the same person
  ].map((r, i) => ({ ...r, source_id: `RULE-${i}` }))); // each its own gift
  const got = r.results.map((x) => (x.state === 'new' ? [x.person_id, x.by] : [x.state, x.candidates]));
  assert.deepEqual(got, [
    [P.ana.id, 'email'],
    [P.ben.id, 'phone'],
    [P.ben.id, 'postal code'],
    [P.cy.id, 'address'],
    ['waiting', 0],
    ['waiting', 0],
    ['waiting', 2],
    [P.dee2.id, 'address'],
    ['waiting', 2],
    [P.fay.id, 'email'],
    ['waiting', 2],
    [P.ana.id, 'phone'],
  ]);
  assert.equal(r.results[0].name_differs, true, 'matched by email under another name: the screen says so');
  assert.equal(r.results[1].name_differs, false);
});

test('an import: through the one gift path, quiet, once only', async () => {
  // A ladder that starts on any gift, and the desk's own gift to compare.
  const ladder = ok(await mgr.action('ladder.create', { name: 'Thanks', trigger: { kind: 'gift' }, steps: [{ kind: 'tag', tag: 'thanked-by-ladder' }] })).ladder;
  ok(await mgr.action('ladder.setActive', { id: ladder.id, active: true }));
  const runs = () => count('select count(*) as n from ladder_runs where workspace_id = $1');
  const deskGift = ok(await mgr.action('gift.log', { person_id: P.cy.id, amount_cents: 1000, date: `${yr}-02-01`, method: 'cash' })).gift;
  assert.equal(await runs(), 1, 'a gift typed at the desk starts the ladder');
  const receiptsBefore = await count('select count(*) as n from receipts where workspace_id = $1');
  assert.equal(receiptsBefore, 1);

  const rows = [
    row({ first: 'Ana', last: 'Example', email: mail('ana'), amount_cents: 60000, source_id: 'GL-1', receipt: 'GL-R-0001' }),
    row({ first: 'Ana', last: 'Example', email: mail('ana'), amount_cents: 60000, date: `${yr}-04-01`, source_id: 'GL-2', receipt: 'GL-R-0002' }),
    row({ first: 'Ben', last: 'Example', phone: '6045550102', amount_cents: 2500, source_id: 'GL-3' }),
    row({ name: 'Nobody Known', email: mail('nobody'), phone: '604-555-0177', amount_cents: 7500, source_id: 'GL-4' }),
    row({ name: 'Nobody Known', email: mail('nobody'), phone: '604-555-0177', amount_cents: 2500, date: `${yr}-05-01`, source_id: 'GL-5' }),
    row({ name: 'No Amount', amount_cents: 0, source_id: 'GL-6' }),
  ];
  // Email connected (a stand-in): were a receipt to be emailed, it would be seen here.
  const realFetch = globalThis.fetch;
  const sent = [];
  process.env.RESEND_API_KEY = 'test-key';
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.resend.com/')) { sent.push(JSON.parse(init.body)); return new Response(JSON.stringify({ id: 'msg' }), { status: 200 }); }
    return realFetch(url, init);
  };
  let first;
  try {
    first = await bring(rows);
    await db.query(`update jobs set run_at = now() where workspace_id = $1 and status = 'pending'`, [ws]);
    await runDueJobs(db, { workspaceId: ws });
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.RESEND_API_KEY;
  }
  P.importId = first.id;
  assert.deepEqual(states(first), ['new', 'new', 'new', 'waiting', 'waiting', 'invalid']);
  assert.deepEqual(first.totals, { gifts: 3, cents: 122500, waiting: 2, waiting_cents: 10000, flagged: 1 });

  // On the books as gifts, marked as brought in, with the other tool's id and receipt number kept as text.
  const ana = await giftsOf(P.ana.id);
  assert.deepEqual(ana.map((g) => [Number(g.amount_cents), g.attrs.source, g.attrs.import_ref, g.attrs.import_receipt]),
    [[60000, 'import', 'GL-1', 'GL-R-0001'], [60000, 'import', 'GL-2', 'GL-R-0002']]);
  assert.equal(ana[0].attrs.import_id, first.id);
  // Counted by the limit, exactly as a gift typed at the desk: the gift that crosses it is the one flagged.
  assert.equal(ana[0].flagged, false);
  assert.equal(ana[1].flagged, true);
  assert.match(ana[1].flag_reason, /Ana Example is at \$1200\.00 for \d{4} — over the \$1000\.00 limit/);
  assert.equal(first.results[1].flagged, true);
  const brief = ok(await treas.get('/api/brief'));
  assert.ok(brief.flagged.some((g) => g.id === ana[1].id), 'in Needs you like any gift over the limit');

  // Quiet: no receipt number used, nothing emailed, no ladder, not in To thank.
  assert.equal(await count('select count(*) as n from receipts where workspace_id = $1'), receiptsBefore, 'no receipt for a gift brought in');
  assert.equal(sent.length, 0, 'nothing emailed');
  assert.equal(await count(`select count(*) as n from jobs where workspace_id = $1 and kind = 'receipt.email'`), 0);
  assert.equal(await runs(), 1, 'no ladder started');
  const stew = ok(await treas.get('/api/stewardship'));
  assert.deepEqual(stew.to_thank.map((g) => g.gift_id), [deskGift.id], 'only the desk’s gift is to thank');
  // …and the next gift typed at the desk takes the very next receipt number.
  const next = ok(await mgr.action('gift.log', { person_id: P.cy.id, amount_cents: 1000, date: `${yr}-02-02`, method: 'cash' })).gift;
  const numbers = (await db.query('select number from receipts where workspace_id = $1 order by seq', [ws])).rows.map((x) => x.number);
  assert.deepEqual(numbers, [`${yr}-0001`, `${yr}-0002`], 'no gap in the numbers');
  ok(await mgr.action('gift.void', { id: next.id }));

  // It counts: totals, the donor's profile and tier, lapsed, the disclosure.
  assert.equal(brief.money.totalCents, 1000 + 122500);
  const profile = ok(await treas.get(`/api/persons/${P.ana.id}`));
  assert.equal(profile.gifts.length, 2);
  assert.ok(profile.gifts.every((g) => g.source === 'import'), 'her profile can mark them Imported');
  assert.equal(ok(await treas.get(`/api/persons/${P.cy.id}`)).gifts[0].source, null, 'a gift typed at the desk is not');
  assert.equal(Number(profile.totals.find((t) => t.year === yr).total_cents), 120000);
  assert.ok(stew.lapsed.some((d) => d.person_id === P.ana.id && d.last_year_cents === 120000), 'gave last year, not yet this one');
  // The gifts spreadsheet says which came from a file, with the other tool's receipt number.
  const sheet = (await raw(treas, '/api/export/gifts.csv')).text.replace(/^\uFEFF/, '').split('\r\n');
  const head = sheet[0].split(',');
  assert.ok(head.includes('imported') && head.includes('their_receipt'), sheet[0]);
  const anaLine = sheet.find((l) => l.includes('GL-R-0001')).split(',');
  assert.deepEqual([anaLine[head.indexOf('donor')], anaLine[head.indexOf('imported')], anaLine[head.indexOf('their_receipt')]], ['Ana Example', 'yes', 'GL-R-0001']);
  assert.equal(sheet.find((l) => l.startsWith('Cy Example,')).split(',')[head.indexOf('imported')], '', 'a gift typed at the desk is not');
  const csv = (await raw(treas, `/api/receipts/disclosure.csv?period=${yr}`)).text;
  assert.match(csv, new RegExp(`Ana Example,.*,1200\\.00,Yes,${yr}-03-01,600\\.00,GL-R-0001`), csv);
  assert.match(csv, /Ana Example,.*,600\.00,GL-R-0002/);

  // The same file again adds nothing, and says so.
  const again = await bring(rows);
  assert.deepEqual(states(again), ['already', 'already', 'already', 'already', 'already', 'invalid']);
  assert.deepEqual(again.totals, { gifts: 0, cents: 0, waiting: 0, waiting_cents: 0, flagged: 0 });
  assert.equal((await giftsOf(P.ana.id)).length, 2);
  assert.deepEqual(states(await check(rows)), ['already', 'already', 'already', 'already', 'already', 'invalid']);
  // A call sent twice (its answer lost on the way) is the same import: nothing doubles.
  const resent = await bring(rows, { id: first.id });
  assert.deepEqual(states(resent), ['resent', 'resent', 'resent', 'resent', 'resent', 'invalid']);
  // …and its totals are the import's as it stands — the flagged gift too, though this answer's rows don't say.
  assert.deepEqual(resent.totals, { gifts: 3, cents: 122500, waiting: 2, waiting_cents: 10000, flagged: 1 });
});

test('without an id: donor, amount, date and method are the gift — and two that read alike are two gifts', async () => {
  const two = keyRows([
    row({ first: 'Ben', last: 'Example', phone: '6045550102', amount_cents: 2000, date: `${yr}-06-01`, method: 'cash' }),
    row({ first: 'Ben', last: 'Example', phone: '6045550102', amount_cents: 2000, date: `${yr}-06-01`, method: 'cash' }),
  ]);
  const a = await bring(two);
  assert.deepEqual(states(a), ['new', 'new']);
  assert.deepEqual(states(await bring(two)), ['already', 'already'], 'the file again: nothing');
  // A gift of theirs the desk voided stays voided when the file comes in again.
  const mine = (await giftsOf(P.ben.id)).filter((g) => Number(g.amount_cents) === 2000);
  assert.equal(mine.length, 2);
  ok(await treas.action('gift.void', { id: mine[1].id }));
  assert.deepEqual(states(await bring(two)), ['already', 'already']);
  assert.equal((await giftsOf(P.ben.id)).filter((g) => Number(g.amount_cents) === 2000 && !g.deleted_at).length, 1);
});

// How it was paid is part of what makes a gift the same gift — as the file
// writes it, not as the person read it this time. The screen asks what an
// unknown word ("Wire") means on every import, and the answer can differ:
// the same row must still be the same gift.
test('once only doesn’t hang on what the person says an unknown “Paid by” word means', async () => {
  const wire = (method) => [row({ first: 'Cy', last: 'Example', address: '77 Pine St', amount_cents: 3300, date: `${yr}-08-01`, method, paid_as: ' Wire ' })];
  assert.deepEqual(states(await bring(wire(null))), ['new'], 'left as not recorded');
  assert.deepEqual(states(await bring(wire('etransfer'))), ['already'], 'called an e-transfer the next time: the same gift');
  assert.deepEqual(states(await check(wire('cheque').map((r) => ({ ...r, paid_as: 'WIRE' })))), ['already'], 'capitals don’t count');
  assert.equal((await giftsOf(P.cy.id)).filter((g) => Number(g.amount_cents) === 3300).length, 1);
  // Another word is another way of paying — a second gift, as it would be without the file's word.
  assert.deepEqual(states(await check(wire(null).map((r) => ({ ...r, paid_as: 'Bank draft' })))), ['new']);
  // The same holds on the screen's side, where rows that read alike are told apart (shared/giftfile.js).
  assert.equal(giftKey({ name: 'Cy Example', amount_cents: 3300, date: '2026-08-01', method: null, paid_as: 'Wire' }),
    giftKey({ name: 'Cy Example', amount_cents: 3300, date: '2026-08-01', method: 'etransfer', paid_as: 'wire' }));
  assert.equal(giftKey({ name: 'Cy Example', amount_cents: 3300, date: '2026-08-01', method: 'cash' }),
    'row:cy example|3300|2026-08-01|cash', 'with no word from the file, the method itself');
});

test('the pile: imported gifts that need a donor, settled by a person', async () => {
  let list = ok(await staff.get('/api/gifts/imports'));
  assert.deepEqual(list.waiting, { gifts: 2, cents: 10000 });
  // Donations reads the count with Today's brief (one read): money roles only.
  assert.deepEqual(ok(await staff.get('/api/brief')).giftsWaiting, { gifts: 2, cents: 10000 });
  assert.equal(ok(await vol.get('/api/brief')).giftsWaiting, undefined, 'a volunteer’s brief has none');
  let pile = ok(await staff.get('/api/gifts/imports/waiting'));
  assert.equal(pile.groups.length, 1, 'one donor, as the file names them');
  const g = pile.groups[0];
  assert.equal(g.donor.name, 'Nobody Known');
  assert.equal(g.donor.email, mail('nobody'));
  assert.equal(g.gifts.length, 2);
  assert.equal(g.cents, 10000);
  assert.deepEqual(g.candidates, []);
  assert.equal(g.gifts[0].file_name, 'gifts.csv');

  // A new person, made from what the file says, then the gifts are theirs.
  const made = ok(await staff.action('person.create', { kind: 'person', name: g.donor.name, email: g.donor.email, phone: g.donor.phone }));
  const done = ok(await staff.action('gift.importSettle', { ids: g.gifts.map((x) => x.id), person_id: made.person.id }));
  assert.equal(done.settled, 2);
  const theirs = await giftsOf(made.person.id);
  assert.deepEqual(theirs.map((x) => [Number(x.amount_cents), x.attrs.source, x.attrs.import_ref]), [[7500, 'import', 'GL-4'], [2500, 'import', 'GL-5']]);
  assert.equal(await count('select count(*) as n from receipts r join gifts g on g.id = r.gift_id where g.person_id = $1', [made.person.id]), 0, 'settled quietly too');
  assert.ok(!ok(await treas.get('/api/stewardship')).to_thank.some((x) => x.person_id === made.person.id));
  list = ok(await staff.get('/api/gifts/imports'));
  assert.deepEqual(list.waiting, { gifts: 0, cents: 0 });
  assert.deepEqual(ok(await staff.get('/api/brief')).giftsWaiting, { gifts: 0, cents: 0 });
  assert.equal((await staff.action('gift.importSettle', { ids: g.gifts.map((x) => x.id), person_id: made.person.id })).status, 409, 'settled once');

  // A row that could be two people shows them; the limit is checked when it is settled.
  const twins = await bring([
    row({ first: 'Dee', last: 'Twin', postal: 'V3S 1A1', amount_cents: 90000, source_id: 'GL-20' }),
    row({ first: 'Dee', last: 'Twin', postal: 'V3S 1A1', amount_cents: 20000, date: `${yr}-07-01`, source_id: 'GL-21' }),
    row({ name: 'Left Out', amount_cents: 100, source_id: 'GL-22' }),
  ]);
  assert.deepEqual(states(twins), ['waiting', 'waiting', 'waiting']);
  pile = ok(await treas.get('/api/gifts/imports/waiting'));
  const dee = pile.groups.find((x) => x.donor.name === 'Dee Twin');
  assert.deepEqual(dee.candidates.map((c) => c.id).sort(), [P.dee1.id, P.dee2.id].sort());
  assert.ok(dee.candidates.every((c) => c.why === 'same name and postal code'), JSON.stringify(dee.candidates));
  const settled = ok(await treas.action('gift.importSettle', { ids: dee.gifts.map((x) => x.id), person_id: P.dee2.id }));
  assert.equal(settled.settled, 2);
  assert.equal(settled.gifts.filter((x) => x.flagged).length, 1, 'the second takes them over the limit');
  const dees = await giftsOf(P.dee2.id);
  assert.deepEqual(dees.map((x) => x.flagged), [false, true]);
  // One the desk leaves out stays out when the file comes in again.
  const out = pile.groups.find((x) => x.donor.name === 'Left Out');
  ok(await treas.action('gift.importSettle', { ids: out.gifts.map((x) => x.id), leave_out: true }));
  assert.deepEqual(ok(await treas.get('/api/gifts/imports')).waiting, { gifts: 0, cents: 0 });
  assert.deepEqual(states(await check([row({ name: 'Left Out', amount_cents: 100, source_id: 'GL-22' })])), ['already']);
});

// The other tool's export may list the newest gift first. The gifts of one
// call go on the books in the order they were given, so the one flagged is
// the one that crossed the limit on its day — not whichever came last in the file.
test('the gift that crosses the limit is the later one, whatever order the file lists them in', async () => {
  const ivy = await person('Ivy', 'Order', { email: mail('ivy') });
  const r = await bring([
    row({ first: 'Ivy', last: 'Order', email: mail('ivy'), amount_cents: 60000, date: `${yr}-09-01`, source_id: 'GL-80' }),
    row({ first: 'Ivy', last: 'Order', email: mail('ivy'), amount_cents: 60000, date: `${yr}-02-01`, source_id: 'GL-81' }),
  ]);
  assert.deepEqual(r.results.map((x) => [x.state, x.flagged]), [['new', true], ['new', false]], 'September’s crossed it, not February’s');
  assert.deepEqual((await giftsOf(ivy.id)).map((g) => [Number(g.amount_cents), g.flagged]), [[60000, false], [60000, true]]);
});

// A gift under the limit on its own record is added up with the records
// that may be the same donor (ext/payments limits.js), whatever door it came
// in by — one from a file too. The flag and the import's own marks sit side
// by side on the gift, and a flag that changes later leaves the marks alone:
// they are what keeps the file from coming in twice.
test('an imported gift is added up with a record that may be the same donor; its flag coming and going never costs it its marks', async () => {
  const jo1 = await person('Jo', 'Maybe', { postal: 'V3R 1A1', address: '5 Elm St' });
  const jo2 = await person('Jo', 'Maybe', { email: mail('jo'), postal: 'V3R 1A1', address: '7 Oak St' });
  const desk = ok(await mgr.action('gift.log', { person_id: jo1.id, amount_cents: 70000, date: `${yr}-02-10`, method: 'cheque' })).gift;
  const rows = [row({ first: 'Jo', last: 'Maybe', email: mail('jo'), amount_cents: 60000, date: `${yr}-03-10`, source_id: 'GL-60', receipt: 'GL-R-0060' })];
  const r = await bring(rows);
  assert.deepEqual(r.results.map((x) => [x.state, x.person_id, x.flagged]), [['new', jo2.id, true]]);
  let [g] = await giftsOf(jo2.id);
  assert.match(g.flag_reason, /^Possibly the same donor as Jo Maybe \(same postal code\): together they are at \$1,300\.00 for \d{4} — over the \$1,000\.00 limit/);
  assert.deepEqual(g.attrs.maybe_same_donor, [jo1.id]);
  assert.deepEqual([g.attrs.source, g.attrs.import_ref, g.attrs.import_receipt], ['import', 'GL-60', 'GL-R-0060']);
  assert.ok(ok(await treas.get('/api/brief')).flagged.some((f) => f.id === g.id), 'under Needs you, as any maybe is');
  // The desk's gift leaves the books: together they are under the limit, and the flag goes…
  ok(await mgr.action('gift.void', { id: desk.id }));
  [g] = await giftsOf(jo2.id);
  assert.equal(g.flagged, false);
  // …with the import's marks untouched, so the file still adds nothing.
  assert.deepEqual([g.attrs.source, g.attrs.import_ref, g.attrs.import_receipt, g.attrs.import_id], ['import', 'GL-60', 'GL-R-0060', r.id]);
  assert.deepEqual(states(await bring(rows)), ['already']);
  // Back on the books (the desk's Undo): flagged again, marks still there.
  ok(await mgr.action('gift.restore', { id: desk.id }));
  [g] = await giftsOf(jo2.id);
  assert.equal(g.flagged, true);
  assert.equal(g.attrs.import_key, 'id:GL-60');
  assert.equal(await count('select count(*) as n from receipts r join gifts x on x.id = r.gift_id where x.person_id = $1', [jo2.id]), 0, 'and still no receipt for it');
});

// A ladder whose goal is "Gave" (ext/ladders): a gift brought in is on the
// books today whenever it was given, so it counts by the day it was given —
// one from long before they were put on the ladder ends nothing.
test('a ladder’s goal “Gave”: a gift brought in counts by the day it was given', async () => {
  const ask = ok(await mgr.action('ladder.create', {
    name: 'Ask to give', trigger: { kind: 'tag', ref: 'ask-give' }, goal: 'gift',
    steps: [{ kind: 'wait', n: 3, unit: 'days' }, { kind: 'tag', tag: 'asked' }],
  })).ladder;
  ok(await mgr.action('ladder.setActive', { id: ask.id, active: true }));
  const gia = await person('Gia', 'Longago', { email: mail('gia'), tags: ['ask-give'] });
  const hal = await person('Hal', 'Justnow', { email: mail('hal'), tags: ['ask-give'] });
  const runOf = async (id) => (await db.query(
    'select status, log from ladder_runs where workspace_id = $1 and ladder_id = $2 and person_id = $3', [ws, ask.id, id],
  )).rows[0];
  const last = (run) => (typeof run.log === 'string' ? JSON.parse(run.log) : run.log).slice(-1)[0];
  assert.equal((await runOf(gia.id)).status, 'active');
  const r = await bring([
    row({ first: 'Gia', last: 'Longago', email: mail('gia'), date: `${yr}-03-01`, source_id: 'GL-70' }),
    row({ first: 'Hal', last: 'Justnow', email: mail('hal'), date: campaignDay(new Date(), 'America/Vancouver'), source_id: 'GL-71' }),
  ]);
  assert.deepEqual(states(r), ['new', 'new']);
  assert.equal((await runOf(gia.id)).status, 'active', 'given long before she was put on: still on the ladder');
  const halRun = await runOf(hal.id);
  assert.equal(halRun.status, 'done', 'given since he was put on: off it');
  assert.equal(last(halRun).result, 'goal');
  // The steps that run next look the same way: Gia's ladder runs to its end.
  for (let i = 0; i < 2; i += 1) {
    await db.query(`update jobs set run_at = now() where workspace_id = $1 and kind = 'ladder.step' and status = 'pending'`, [ws]);
    await runDueJobs(db, { workspaceId: ws });
  }
  const giaRun = await runOf(gia.id);
  assert.deepEqual([giaRun.status, last(giaRun).result], ['done', 'finished']);
});

// With a list of electors on file, whose gift it is must be found through
// the indexes — the email's, and the same-donor one on last and first name
// (ext/payments sql.js) — never by reading the whole list for each row. A
// campaign of its own with a few thousand made-up people, so the plan is
// one a real list would get.
test('a donor is found through an index, never by reading the whole list', async () => {
  const { findDonors } = await import('../ext/giftimport/match.js');
  const big = new Client();
  const ws2 = (await big.signup({ workspaceName: `Big list ${tag}`, email: mail('biglist') })).json.workspace.id;
  const mk = async (first, last, extra) => ok(await big.action('person.create', { kind: 'person', first_name: first, last_name: last, ...extra })).person;
  const ana = await mk('Ana', 'Listed', { email: mail('ana-listed') });
  const ben = await mk('Ben', 'Listed', { phone: '604-555-0102' });
  await db.query(
    `insert into persons (id, workspace_id, kind, name, email, phone, address)
     select gen_random_uuid(), $1, 'person', 'Filler' || g || ' Person' || g, 'filler' || g || '.' || $2 || '@example.org',
            '604-555-' || lpad((g % 10000)::text, 4, '0'), g || ' Filler St'
       from generate_series(1, 3000) g`, [ws2, tag]);
  await db.query('analyze persons');
  const seen = [];
  const recording = { query: (sql, params) => { seen.push({ sql, params }); return db.query(sql, params); } };
  const donor = (d) => ({ name: null, first: null, last: null, email: null, phone: null, postal: null, address: null, ...d });
  const found = await findDonors(recording, ws2, [
    { i: 0, donor: donor({ name: 'Ana Listed', email: mail('ana-listed') }) },
    { i: 1, donor: donor({ name: 'Ben Listed', first: 'Ben', last: 'Listed', phone: '6045550102' }) },
    { i: 2, donor: donor({ name: 'Filler7 Person7', phone: '604-555-0007' }) },
  ]);
  assert.deepEqual([0, 1, 2].map((i) => found.get(i).person?.name), ['Ana Listed', 'Ben Listed', 'Filler7 Person7']);
  assert.deepEqual([found.get(0).person.id, found.get(1).person.id], [ana.id, ben.id]);
  assert.equal(seen.length, 2, 'one read by email, one by name');
  const plans = [];
  for (const s of seen) plans.push((await db.query(`explain ${s.sql}`, s.params)).rows.map((r) => Object.values(r)[0]).join('\n'));
  assert.match(plans[0], /persons_ws_email_idx/, plans[0]);
  assert.match(plans[1], /persons_same_donor_idx/, plans[1]);
  for (const plan of plans) assert.doesNotMatch(plan, /Seq Scan on persons/, plan);
});

test('who may: treasurers and managers bring a file in; the desk settles; volunteers see none of it', async () => {
  const rows = [row({ first: 'Ana', last: 'Example', email: mail('ana'), source_id: 'GL-90' })];
  for (const c of [staff, vol]) {
    assert.equal((await c.action('gift.import', { import_id: randomUUID(), rows, dry_run: true })).status, 403);
    assert.equal((await c.action('gift.import', { import_id: randomUUID(), rows })).status, 403);
    assert.equal((await c.action('gift.importUndo', { id: P.importId })).status, 403);
  }
  assert.equal((await vol.get('/api/gifts/imports')).status, 403);
  assert.equal((await vol.get('/api/gifts/imports/waiting')).status, 403);
  assert.equal((await vol.action('gift.importSettle', { ids: [randomUUID()], leave_out: true })).status, 403);
  assert.equal(ok(await staff.get('/api/gifts/imports')).can_import, false);
  assert.equal(ok(await treas.get('/api/gifts/imports')).can_import, true);
  assert.equal(states(await check(rows, mgr))[0], 'new', 'a manager may');
  // Too many rows in one call, or none, is refused whole.
  assert.equal((await treas.action('gift.import', { import_id: randomUUID(), rows: [] })).status, 400);
  assert.equal((await treas.action('gift.import', { import_id: randomUUID(), rows: Array.from({ length: 501 }, () => rows[0]) })).status, 400);
});

test('an import is taken back as a whole, for a day', async () => {
  const list = ok(await treas.get('/api/gifts/imports'));
  const mine = list.imports.find((i) => i.id === P.importId);
  assert.deepEqual([mine.file_name, mine.gifts, mine.cents, mine.can_undo], ['gifts.csv', 5, 132500, true]);
  const voidsBefore = await count(`select count(*) as n from events where workspace_id = $1 and entity_type = 'gift' and op = 'void'`);
  const undone = ok(await treas.action('gift.importUndo', { id: P.importId }));
  assert.deepEqual([undone.voided, undone.remaining], [5, 0]);
  // Through the normal void path: each gift's void is on the books, and it left every total.
  assert.equal(await count(`select count(*) as n from events where workspace_id = $1 and entity_type = 'gift' and op = 'void'`), voidsBefore + 5);
  assert.equal((await giftsOf(P.ana.id)).filter((g) => !g.deleted_at).length, 0);
  assert.ok(!ok(await treas.get('/api/brief')).flagged.some((g) => g.person_id === P.ana.id), 'its over-limit flag left Needs you');
  const after = ok(await treas.get('/api/gifts/imports')).imports.find((i) => i.id === P.importId);
  assert.deepEqual([after.gifts, after.can_undo, !!after.undone_at], [0, false, true]);
  assert.equal((await treas.action('gift.importUndo', { id: P.importId })).json.voided, 0, 'taking it back again does nothing');
  assert.equal((await treas.action('gift.import', { import_id: P.importId, rows: [row({ name: 'Late Row' })] })).status, 409, 'nothing more comes in under it');
  // The file can come in again, corrected.
  const again = await bring([row({ first: 'Ana', last: 'Example', email: mail('ana'), amount_cents: 60000, source_id: 'GL-1' })]);
  assert.deepEqual(states(again), ['new']);
  // Past a day it can no longer be taken back.
  await db.query(`update gift_imports set created_at = now() - interval '25 hours' where id = $1`, [again.id]);
  const late = await treas.action('gift.importUndo', { id: again.id });
  assert.equal(late.status, 409);
  assert.match(late.json.error, /day/);
  assert.equal(ok(await treas.get('/api/gifts/imports')).imports.find((i) => i.id === again.id).can_undo, false);
});

test('the record still checks out', async () => {
  assert.equal(ok(await mgr.get('/api/audit/verify')).ok, true);
  const exported = ok(await mgr.get('/api/export'));
  assert.ok(Array.isArray(exported.gift_imports) && exported.gift_imports.length >= 2);
  assert.ok(Array.isArray(exported.gift_import_rows));
});
