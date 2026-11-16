// Media's outlets and its three lists (LTE, server/ext/media): an outlet is
// a paper, station or show with its letters and op-ed rules; a contact may
// be on Op-ed editors, Letters editors and Show hosts, any or all. Lists
// only ever narrow a release's audience, and every list read counts only
// contacts still on the media list. Its own file: media.test.js makes as
// many sign-ins as one address may in 15 minutes. The email service is a
// stand-in (fake-mail.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { startFakeMail } from './fake-mail.js';

const tag = Math.random().toString(36).slice(2, 8);
const mail = (who) => `${who}.md.${tag}@example.org`;
const KEYS = ['MAIL_PROVIDER', 'MAIL_FROM', 'RESEND_API_KEY', 'RESEND_API_BASE', 'SENDGRID_API_KEY', 'STARBASE_PUBLIC_URL', 'MAILCHIMP_API_KEY', 'MAILCHIMP_API_BASE'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let db, resend;

const emailOn = () => {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, { RESEND_API_KEY: 're_test_key', RESEND_API_BASE: resend.url, MAIL_FROM: 'Imagine Surrey <team@example.org>', STARBASE_PUBLIC_URL: 'https://base.example' });
};
const ok = (r, msg = '') => { assert.equal(r.status, 200, `${msg} ${JSON.stringify(r.json)}`); return r.json; };
const rowsOf = async (blastId) => (await db.query('select * from blast_recipients where blast_id = $1 order by email', [blastId])).rows;
const sentTo = (blastId) => rowsOf(blastId).then((rs) => rs.map((r) => r.email).sort());

// A campaign of its own for each test: a manager, staff denied Outreach
// (Media kept), a volunteer granted Media only, and a volunteer with neither.
let n = 0;
const campaign = async () => {
  n += 1;
  const mgr = new Client();
  const r = await mgr.signup({ workspaceName: `Media ${n} ${tag}`, email: mail(`mgr${n}`), jurisdiction: 'bc-municipal' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const join = async (role, name) => {
    const inv = ok(await mgr.action('member.invite', { email: mail(`${name}${n}`), role }));
    const c = new Client();
    const j = ok(await c.post('/api/auth/join', { token: inv.joinUrl.split('/join/')[1], name: `${name} Example`, password: 'media-pass-1234' }));
    return { c, id: j.user.id };
  };
  const staff = await join('staff', 'sid');
  ok(await mgr.action('permission.member.set', { user_id: staff.id, grant: [], deny: ['outreach'] }));
  const vol = await join('volunteer', 'vic');
  ok(await mgr.action('permission.member.set', { user_id: vol.id, grant: ['media'], deny: [] }));
  const plain = await join('volunteer', 'uma');
  return { mgr, ws: r.json.workspace.id, staff: staff.c, vol: vol.c, plain: plain.c };
};
const person = (c, name, email, tags, extra = {}) => c.createPerson(name, { email, tags, ...extra });

before(async () => {
  db = await freshDb();
  resend = await startFakeMail({ provider: 'resend' });
  emailOn();
});
after(async () => {
  await resend.close();
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

// ── Outlets and the three lists (LTE) ──

test('outlets: add, edit, rename (contacts follow), checked, remove; a name taken is 409; a volunteer granted Media reads only', async () => {
  const { mgr, ws, vol, plain } = await campaign();
  const daily = ok(await mgr.action('media.outlet.save', {
    name: 'Example Daily', kind: 'paper', letters_email: 'Letters@Example.org', letters_limit: 250, rules: 'Name and city printed',
  })).outlet;
  assert.equal(daily.letters_email, 'letters@example.org');
  assert.deepEqual([daily.limit_unit, daily.asks_phone, daily.asks_address, daily.exclusive, daily.confirmed_on], ['words', true, false, true, null]);
  assert.equal((await mgr.action('media.outlet.save', { name: 'example daily', kind: 'online' })).status, 409);
  assert.match((await mgr.action('media.outlet.save', { name: 'Example Daily', kind: 'online' })).json.error, /There’s already an outlet called Example Daily/);
  assert.equal((await mgr.action('media.outlet.save', { name: 'X', kind: 'paper', letters_form: 'javascript:alert(1)' })).status, 400);
  assert.equal((await mgr.action('media.outlet.save', { name: 'X', kind: 'paper', letters_limit: 20 })).status, 400);
  assert.equal((await mgr.action('media.outlet.save', { name: 'X', kind: 'paper', oped_email: 'not an email' })).status, 400);

  const dana = ok(await mgr.action('media.contact.add', { name: 'Dana Example', kind: 'media', email: mail('dana'), outlet: 'example daily' }));
  const edited = ok(await mgr.action('media.outlet.save', {
    id: daily.id, name: 'Example Daily News', kind: 'paper', asks_address: true, limit_unit: 'characters', letters_limit: 600, rules: '', checked: true,
  })).outlet;
  assert.deepEqual([edited.asks_address, edited.limit_unit, edited.letters_limit, edited.rules, edited.letters_email], [true, 'characters', 600, null, 'letters@example.org']);
  assert.match(edited.confirmed_on, /^\d{4}-\d{2}-\d{2}$/);
  const row = (await db.query('select outlet from media_contacts where workspace_id = $1 and person_id = $2', [ws, dana.person_id])).rows[0];
  assert.equal(row.outlet, 'Example Daily News', 'the contact follows the rename');

  const read = ok(await vol.get('/api/media/outlets')).outlets;
  assert.deepEqual(read.map((o) => o.name), ['Example Daily News']);
  assert.equal(read[0].confirmed_by_name, 'Avery Chen');
  assert.equal((await vol.action('media.outlet.save', { name: 'Mine', kind: 'paper' })).status, 403);
  assert.equal((await vol.action('media.outlet.remove', { id: daily.id })).status, 403);
  assert.equal((await plain.get('/api/media/outlets')).status, 403);

  ok(await mgr.action('media.outlet.remove', { id: daily.id }));
  assert.deepEqual(ok(await mgr.get('/api/media/outlets')).outlets, []);
  ok(await mgr.action('media.outlet.save', { name: 'Example Daily News', kind: 'paper' })); // the name is free again
  const ev = (await db.query("select payload from events where workspace_id = $1 and entity_type = 'media_outlet' order by seq", [ws])).rows;
  assert.equal(ev.length, 4);
});

test('lists: add (joins what they have), save, clear; an unknown list is 400; counts, the filter and Copy emails count only who is live', async () => {
  const { mgr, ws, vol } = await campaign();
  const dana = ok(await mgr.action('media.contact.add', { name: 'Dana Example', kind: 'media', email: mail('dana'), outlet: 'Example Daily', lists: ['letters', 'op_ed', 'letters'] }));
  const listsOf = async (id) => (await db.query('select lists from media_contacts where workspace_id = $1 and person_id = $2', [ws, id])).rows[0].lists;
  assert.deepEqual(await listsOf(dana.person_id), ['op_ed', 'letters'], 'de-duplicated, in order');
  ok(await mgr.action('media.contact.add', { name: 'Dana Example', kind: 'media', email: mail('dana'), lists: ['show'] }));
  assert.deepEqual(await listsOf(dana.person_id), ['op_ed', 'letters', 'show'], 'added to, never taken away');
  ok(await mgr.action('media.contact.save', { person_id: dana.person_id, note: 'Calls back' }));
  assert.deepEqual(await listsOf(dana.person_id), ['op_ed', 'letters', 'show'], 'absent keeps');
  ok(await mgr.action('media.contact.save', { person_id: dana.person_id, lists: ['show'] }));
  assert.deepEqual(await listsOf(dana.person_id), ['show']);
  ok(await mgr.action('media.contact.save', { person_id: dana.person_id, lists: [] }));
  assert.deepEqual(await listsOf(dana.person_id), []);
  assert.equal((await mgr.action('media.contact.save', { person_id: dana.person_id, lists: ['host'] })).status, 400);
  assert.equal((await vol.action('media.contact.save', { person_id: dana.person_id, lists: ['show'] })).status, 403);

  ok(await mgr.action('media.contact.save', { person_id: dana.person_id, lists: ['op_ed', 'letters', 'show'] }));
  const lee = ok(await mgr.action('media.contact.add', { name: 'Lee Example', kind: 'media', email: mail('lee'), lists: ['letters'] }));
  const dee = ok(await mgr.action('media.contact.add', { name: 'Dee Example', kind: 'influencer', email: mail('dee'), lists: ['letters'] }));
  ok(await mgr.action('person.update', { id: dee.person_id, tags: ['influencer', 'do-not-email'] }));
  const bo = ok(await mgr.action('media.contact.add', { name: 'Bo Example', kind: 'media', email: mail('bo'), lists: ['letters'] }));
  await db.query(`insert into email_suppressions (id, workspace_id, email, reason, source) values (gen_random_uuid(), $1, $2, 'bounce', 'test')`, [ws, mail('bo')]);
  const gone = ok(await mgr.action('media.contact.add', { name: 'Gus Example', kind: 'media', email: mail('gus'), lists: ['letters'] }));
  ok(await mgr.action('media.contact.remove', { person_id: gone.person_id }));

  const read = ok(await mgr.get('/api/media/contacts'));
  assert.deepEqual(read.counts.lists, { op_ed: 1, letters: 4, show: 1 }, 'Gus left the media list: not counted');
  assert.deepEqual(read.contacts.find((c) => c.person.name === 'Dana Example').lists, ['op_ed', 'letters', 'show']);
  const names = async (q) => ok(await mgr.get(`/api/media/contacts?list=${q}`)).contacts.map((c) => c.person.name).sort();
  assert.deepEqual(await names('letters'), ['Bo Example', 'Dana Example', 'Dee Example', 'Lee Example']);
  assert.deepEqual(await names('show'), ['Dana Example']);
  assert.equal((await mgr.get('/api/media/contacts?list=host')).status, 400);
  const emails = ok(await mgr.get('/api/media/contacts?list=letters&emails=1')).emails;
  assert.deepEqual(emails, [mail('dana'), mail('lee')].sort(), 'no do-not-email, no bounced, no one who left');
  assert.equal((await vol.get('/api/media/contacts?list=letters&emails=1')).status, 403);
  const vread = ok(await vol.get('/api/media/contacts?list=letters'));
  assert.equal(vread.contacts.length, 4, 'a volunteer granted Media sees the list');
  assert.ok(vread.contacts.every((c) => c.person.email === null && c.person.phone === null));
  assert.ok(lee.person_id);
});

test('media.send to.lists: only live media contacts on that list; do-not-email still out; without lists unchanged', async () => {
  const { mgr } = await campaign();
  const add = (who, kind, lists) => mgr.action('media.contact.add', { name: `${who} Example`, kind, email: mail(who), lists }).then(ok);
  await add('ann', 'media', ['show']);
  await add('bea', 'media', ['letters']);
  await add('ivy', 'influencer', ['show']);
  const dee = await add('dee', 'media', ['show']);
  ok(await mgr.action('person.update', { id: dee.person_id, tags: ['media', 'do-not-email'] }));
  const gus = await add('gus', 'media', ['show']);
  ok(await mgr.action('media.contact.remove', { person_id: gus.person_id }));
  const show = ok(await mgr.action('media.send', { subject: 'Booking', body: 'On air?', to: { kinds: ['media'], lists: ['show'] } }));
  assert.deepEqual(await sentTo(show.blast.id), [mail('ann')]);
  assert.deepEqual(show.blast.audience_count, 1);
  const both = ok(await mgr.action('media.send', { subject: 'Booking 2', body: 'On air?', to: { kinds: ['media', 'influencer'], lists: ['show', 'letters'] } }));
  assert.deepEqual(await sentTo(both.blast.id), [mail('ann'), mail('bea'), mail('ivy')].sort());
  const all = ok(await mgr.action('media.send', { subject: 'All', body: 'News' }));
  assert.deepEqual(await sentTo(all.blast.id), [mail('ann'), mail('bea')].sort(), 'without lists: every reachable media contact');
  const rel = ok(await mgr.get(`/api/media/releases/${show.blast.id}`)).release;
  assert.deepEqual(rel.audience, { media: ['media'], lists: ['show'] });
  assert.equal(ok(await mgr.get(`/api/media/releases/${all.blast.id}`)).release.audience, null);
  assert.equal((await mgr.action('media.send', { subject: 'X', body: 'Y', to: { kinds: ['media'], lists: ['hosts'] } })).status, 400);
});

test('merging two contacts unions their lists; the lists migration runs twice on rows that exist', async () => {
  const { mgr, ws } = await campaign();
  const keep = ok(await mgr.action('media.contact.add', { name: 'Kay Example', kind: 'media', email: mail('kay'), lists: ['show'] }));
  const drop = ok(await mgr.action('media.contact.add', { name: 'Kay E.', kind: 'media', email: mail('kay2'), lists: ['letters', 'op_ed'] }));
  ok(await mgr.action('person.merge', { keep: keep.person_id, drop: drop.person_id }));
  const rows = (await db.query('select person_id, lists from media_contacts where workspace_id = $1', [ws])).rows;
  assert.deepEqual(rows, [{ person_id: keep.person_id, lists: ['op_ed', 'letters', 'show'] }]);
  const { sql } = await import('../ext/media/index.js');
  await db.exec(sql);
  await db.exec(sql);
  assert.deepEqual((await db.query('select lists from media_contacts where workspace_id = $1', [ws])).rows[0].lists, ['op_ed', 'letters', 'show']);
  await assert.rejects(db.query(`update media_contacts set lists = '["host"]' where workspace_id = $1`, [ws]));
});
