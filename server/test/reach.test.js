// Who may be emailed, texted or called is decided in one place
// (lib/reach.js), read by an email or a text to a list, the newsletter, a
// press release, a ladder's steps, a phone bank and a list's own numbers.
//   · the senders differ today, each as it was before the one place;
//   · a do-not-… tag counts whatever its capitals;
//   · the SQL reads a phone exactly as the texting rules' e164() does;
//   · one more reason is one line: a dead address (email) and do-not-call
//     were added so, and every reader follows them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb, Client } from './helpers.js';
import { RULES, mayReach, whyNot, person, address, dialable, e164Sql, last10, emailKey } from '../lib/reach.js';
import { e164, PHONE_DIGITS_SQL } from '../ext/texting/rules.js';

let db, mgr, ws;
const P = {};
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
const tag = Math.random().toString(36).slice(2, 8);
const mail = (who) => `${who}.reach.${tag}@example.org`;
const ENV = ['RESEND_API_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM'];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

before(async () => {
  // Nothing connected: a send is saved with who it would go to, and nothing leaves.
  for (const k of ENV) delete process.env[k];
  db = await freshDb();
  mgr = new Client();
  ws = (await mgr.signup({ workspaceName: 'Imagine Surrey', email: mail('manager'), jurisdiction: 'bc-municipal' })).json.workspace.id;
  const mk = async (key, name, extra) => { P[key] = await mgr.createPerson(name, { tags: ['reach'], ...extra, ...(extra.tags ? { tags: ['reach', ...extra.tags] } : {}) }); };
  await mk('ana', 'Ana Example', { email: mail('ana'), phone: '604-555-0101' });                      // subscribed
  await mk('ben', 'Ben Example', { email: mail('ben'), phone: '604-555-0102' });                      // never asked for email
  await mk('cy', 'Cy Example', { email: mail('cy'), phone: '604-555-0103' });                         // left the newsletter
  await mk('dee', 'Dee Example', { email: mail('dee'), phone: '604-555-0104', tags: ['do-not-email'] });
  await mk('eli', 'Eli Example', { email: mail('eli'), phone: '604-555-0105', tags: ['Do-Not-Contact'] }); // typed with capitals
  await mk('fay', 'Fay Example', { email: mail('fay'), phone: '604-555-0106', tags: ['do-not-text', 'media'] });
  await mk('gus', 'Gus Example', { phone: '555-0107' });                                              // no address; seven digits
  await mk('hal', 'Hal Example', { email: mail('hal'), phone: '604-555-0108' });                      // replied STOP
  await mk('ivy', 'Ivy Example', { email: mail('ivy') });                                             // subscribed, no phone
  for (const who of ['ana', 'cy', 'ivy', 'fay']) ok(await mgr.action('subscription.add', { email: mail(who) }));
  const cy = (await db.query('select id from subscriptions where workspace_id = $1 and email = $2', [ws, mail('cy')])).rows[0];
  ok(await mgr.action('subscription.remove', { id: cy.id }));
  await db.query(`insert into texting_optouts (id, workspace_id, phone, opted_out, keyword) values ($1, $2, '+16045550108', true, 'stop')`, [randomUUID(), ws]);
});
after(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const names = async (sql) => (await db.query(
  `select p.name from persons p where p.workspace_id = $1 and p.deleted_at is null and p.tags @> '"reach"'::jsonb and ${sql} order by p.name`, [ws],
)).rows.map((r) => r.name.split(' ')[0]);

test('each sender, as it was: a list send goes to everyone who hasn’t said no; the newsletter and a ladder only to subscribers', async () => {
  const pp = person('p', '$1');
  assert.deepEqual(await names(mayReach('email', 'list', pp)), ['Ana', 'Ben', 'Fay', 'Hal', 'Ivy'],
    'an address, not unsubscribed (Cy), not do-not-email (Dee), not do-not-contact (Eli, typed with capitals)');
  assert.deepEqual(await names(mayReach('email', 'ladder', pp)), ['Ana', 'Fay', 'Ivy'], 'only the subscribed — Ben and Hal never asked for email');
  // Flipped on purpose (ext/media): a release now honours do-not-email (Dee)
  // and do-not-contact (Eli) — and still reaches one who left the newsletter
  // (Cy): they leave the media list by a release's own link.
  assert.deepEqual(await names(mayReach('email', 'press', pp)), ['Ana', 'Ben', 'Cy', 'Fay', 'Hal', 'Ivy'],
    'a press release: an address, not do-not-email (Dee), not do-not-contact (Eli); the newsletter isn’t asked');
  assert.deepEqual(await names(mayReach('text', 'list', pp)), ['Ana', 'Ben', 'Cy', 'Dee'],
    'a number that can be texted: not do-not-contact (Eli), do-not-text (Fay), seven digits (Gus), STOP (Hal), none (Ivy)');
  assert.deepEqual(await names(mayReach('call', 'bank', pp)), ['Ana', 'Ben', 'Cy', 'Dee', 'Fay', 'Gus', 'Hal'], 'a phone, not do-not-contact');
  // The newsletter is asked about addresses, not people.
  const subs = (await db.query(
    `select n.email from subscriptions n where n.workspace_id = $1 and ${mayReach('email', 'newsletter', address('n.email'))} order by n.email`, [ws],
  )).rows.map((r) => r.email.split('.')[0]);
  assert.deepEqual(subs, ['ana', 'fay', 'ivy']);
});

test('the same question about one person, as a send goes: the first reason, in the ladder’s order', async () => {
  const why = (channel, sender, key, more = {}) => whyNot(db, channel, sender, {
    workspaceId: ws, personId: P[key].id, email: P[key].email, phone: P[key].phone, tags: P[key].tags, ...more,
  });
  assert.deepEqual(await Promise.all(['ana', 'ben', 'cy', 'dee', 'eli', 'gus'].map((k) => why('email', 'ladder', k))),
    [null, 'no_consent', 'unsubscribed', 'do_not_email', 'do_not_contact', 'no_email']);
  assert.deepEqual(await Promise.all(['ana', 'ben', 'cy', 'dee', 'eli'].map((k) => why('email', 'list', k))),
    [null, null, 'unsubscribed', 'do_not_email', 'do_not_contact']);
  assert.equal(await whyNot(db, 'email', 'newsletter', { workspaceId: ws, email: mail('ana').toUpperCase() }), null, 'an address, whatever its capitals');
  assert.equal(await whyNot(db, 'email', 'newsletter', { workspaceId: ws, email: mail('cy') }), 'unsubscribed');
  assert.equal(await whyNot(db, 'email', 'newsletter', { workspaceId: ws, email: mail('ben') }), 'no_consent');
  assert.deepEqual(await Promise.all(['ana', 'eli', 'fay', 'ivy', 'gus', 'hal'].map((k) => why('text', 'ladder', k))),
    [null, 'do_not_contact', 'do_not_text', 'no_phone', 'bad_number', 'opted_out']);
  assert.deepEqual(await Promise.all(['ana', 'eli', 'ivy', 'gus'].map((k) => why('call', 'bank', k))), [null, 'do_not_contact', 'no_phone', null]);
  // Reasons only read as a send goes: asked to stop in words (until START), and — a ladder — no to texts on the website.
  const conv = randomUUID();
  await db.query(`insert into texting_conversations (id, workspace_id, person_id, phone) values ($1, $2, $3, '+16045550102')`, [conv, ws, P.ben.id]);
  const reply = (keyword, body) => db.query(
    `insert into texting_messages (id, workspace_id, conversation_id, direction, phone, body, status, keyword) values ($1, $2, $3, 'in', '+16045550102', $4, 'received', $5)`,
    [randomUUID(), ws, conv, body, keyword],
  );
  await reply('asks_stop', 'Please stop texting me');
  assert.equal(await why('text', 'list', 'ben'), 'asked_to_stop');
  assert.equal(await why('text', 'ladder', 'ben'), 'asked_to_stop');
  assert.deepEqual(await names(mayReach('text', 'list', person('p', '$1'))), ['Ana', 'Ben', 'Cy', 'Dee'], 'still named by the list: the send itself leaves the number out, on the record');
  await new Promise((r) => { setTimeout(r, 5); });
  await reply('start', 'START');
  assert.equal(await why('text', 'list', 'ben'), null, 'START takes it back');
  await db.query(`insert into consent_events (id, workspace_id, person_id, channel, granted, source) values ($1, $2, $3, 'sms', false, 'test')`, [randomUUID(), ws, P.ana.id]);
  assert.equal(await why('text', 'ladder', 'ana'), 'no_text_consent');
  assert.equal(await why('text', 'list', 'ana'), null, 'a text to a list doesn’t read website consent today');
  // The number on the send is the one asked about, not the one the person has now.
  assert.equal(await why('text', 'list', 'ana', { phone: '+16045550108' }), 'opted_out');
});

test('the SQL reads a phone as the texting rules do', async () => {
  const phones = [
    '604-555-0101', '(604) 555 0102', '+1 604 555 0103', '1-604-555-0104', '604-555-0105 ext 2', '6045550106 x22', '604.555.0109#3',
    '16045550110', '555-0107', '104-555-0108', '26045550111', '+44 20 7946 0958', '+12', 'n/a', '   ', '604 555 01', '+1 (604) 555-0112 Ext. 9',
    'X604', 'ext 604 555 0101', '+1604 555 0101 EXT9', ' +16045550101', '+1234567', '+12345678', '+123456789012345', '+1234567890123456',
    '2345678901', '12345678901', '123456789012', '+ 1 604', '604-555-0101 #22 x', 'tel: 604 555 0101', '1 (800) 555-0199', '0045550101',
  ];
  const other = new Client();
  const ows = (await other.signup({ workspaceName: 'Phones', email: mail('phones') })).json.workspace.id;
  for (const [i, phone] of phones.entries()) {
    await db.query('insert into persons (id, workspace_id, name, phone) values ($1, $2, $3, $4)', [randomUUID(), ows, `Phone ${i} Example`, phone]);
  }
  const rows = (await db.query(
    `select p.phone, ${dialable('p.phone')} as ok, ${e164Sql('p.phone')} as e164, ${last10('p.phone')} as l10, ${PHONE_DIGITS_SQL('p.phone')} as d10
       from persons p where p.workspace_id = $1 and p.phone is not null`, [ows],
  )).rows;
  assert.equal(rows.length, phones.length);
  for (const r of rows) {
    assert.equal(r.e164, e164(r.phone), `e164 of ${JSON.stringify(r.phone)}`);
    assert.equal(r.ok, e164(r.phone) !== null, `dialable ${JSON.stringify(r.phone)}`);
    assert.equal(r.l10, r.d10, `last ten digits of ${JSON.stringify(r.phone)}`);
  }
  assert.equal((await db.query(`select ${emailKey("'  Ana@Example.ORG '")} as k`)).rows[0].k, 'ana@example.org');
});

test('a list’s numbers, a send’s recipients and a phone bank all read it', async () => {
  const list = ok(await mgr.action('list.create', { name: 'Reach', kind: 'filter', filter: { tag: 'reach' } })).list;
  const counts = ok(await mgr.get(`/api/lists/${list.id}`)).counts;
  assert.deepEqual(counts, { total: 9, with_email: 5, with_phone: 4, with_call: 7, reachable: 8 }, 'reachable: everyone but Eli (do-not-contact)');
  const email = ok(await mgr.action('blast.send', { kind: 'eblast', subject: 'Hello', body: 'Hi', audience: { list_id: list.id } }));
  assert.equal(email.blast.audience_count, counts.with_email, 'the count is the send');
  const text = ok(await mgr.action('blast.send', { kind: 'text', body: 'Imagine Surrey here: hello.', audience: { list_id: list.id } }));
  assert.equal(text.blast.audience_count, counts.with_phone);
  const bank = ok(await mgr.action('bank.create', { name: 'Reach calls', list_id: list.id }));
  assert.equal(bank.added, counts.with_call);
  const news = ok(await mgr.action('blast.send', { kind: 'newsletter', subject: 'News', body: 'Hi' }));
  assert.equal(news.blast.audience_count, 3, 'Ana, Fay and Ivy are subscribed');
  const press = ok(await mgr.action('blast.send', { kind: 'press', subject: 'Release', body: 'Hi' }));
  assert.equal(press.blast.audience_count, 1, 'Fay is tagged media');
});

test('a dead address (the suppression list) and do-not-call: every reader follows them', async () => {
  const list = (await mgr.get('/api/lists')).json.lists.find((l) => l.name === 'Reach');
  const before = ok(await mgr.get(`/api/lists/${list.id}`)).counts;
  // "Do not call" (a tag; CallHub's results set it too), and an address that
  // bounced for good (ext/mail's suppression list, as its webhook writes it).
  assert.ok(RULES.call.some((r) => r.code === 'do_not_call') && RULES.email.some((r) => r.code === 'suppressed'), 'one line each in its channel');
  const sup = randomUUID();
  await db.query(`insert into email_suppressions (id, workspace_id, email, reason, source) values ($1, $2, $3, 'bounce', 'test')`, [sup, ws, mail('ivy')]);
  try {
    ok(await mgr.action('person.update', { id: P.ana.id, tags: [...P.ana.tags, 'do-not-call'] }));
    const now = ok(await mgr.get(`/api/lists/${list.id}`)).counts;
    assert.equal(now.with_call, before.with_call - 1, 'Ana can’t be called');
    assert.equal(now.with_email, before.with_email - 1, 'Ivy’s address can’t be emailed');
    assert.equal(now.reachable, before.reachable - 1, 'Ivy had only her address; Ana can still be emailed and texted');
    assert.equal(ok(await mgr.action('bank.create', { name: 'After', list_id: list.id })).added, before.with_call - 1);
    assert.equal(ok(await mgr.action('bank.create', { name: 'By hand', person_ids: [P.ana.id, P.ben.id] })).added, 1, 'picked by hand: the same rule');
    assert.equal(ok(await mgr.action('blast.send', { kind: 'eblast', subject: 'Again', body: 'Hi', audience: { list_id: list.id } })).blast.audience_count, before.with_email - 1);
    assert.equal(ok(await mgr.action('blast.send', { kind: 'newsletter', subject: 'News 2', body: 'Hi' })).blast.audience_count, 2, 'the newsletter leaves the address out too');
    assert.equal(await whyNot(db, 'email', 'ladder', { workspaceId: ws, email: mail('ivy'), tags: [] }), 'suppressed', 'and a ladder’s email step');
    assert.equal(await whyNot(db, 'call', 'bank', { workspaceId: ws, phone: '604-555-0101', tags: ['do-not-call'] }), 'do_not_call');
    // A caller's list drops Ana at once, from a bank made before the reason existed.
    const old = (await mgr.get('/api/banks')).json.banks.find((b) => b.name === 'Reach calls');
    const me = (await mgr.get('/api/auth/me')).json.user.id;
    ok(await mgr.action('bank.assign', { id: old.id, user_id: me }));
    const mine = ok(await mgr.get(`/api/banks/${old.id}/mine`));
    assert.ok(!mine.persons.some((p) => p.id === P.ana.id), 'not on the caller’s list');
    assert.equal(mine.persons.length, before.with_call - 1);
    assert.equal(await whyNot(db, 'email', 'list', { workspaceId: ws, email: ` ${mail('ivy').toUpperCase()} `, tags: [] }), 'suppressed', 'the address whatever its capitals');
    // The desk lifts it: reachable again.
    await db.query('update email_suppressions set lifted_at = now() where id = $1', [sup]);
    assert.equal(await whyNot(db, 'email', 'ladder', { workspaceId: ws, email: mail('ivy'), tags: [] }), null);
  } finally {
    await db.query('delete from email_suppressions where id = $1', [sup]);
    ok(await mgr.action('person.update', { id: P.ana.id, tags: P.ana.tags }));
  }
});
