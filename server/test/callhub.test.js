// CallHub (ext/callhub): a call list goes to the dialer, and each call's
// result comes back onto the person. CallHub itself is a stand-in here
// (test/fake-callhub.js at CALLHUB_API_BASE): nothing reaches the real one.
//   · who leaves: a number e164() takes, never do-not-contact or do-not-call
//     (nor a number one of them shares); one contact per number; only the
//     phone, first and last name and city
//   · people not to call go to a CallHub do-not-call list with each push
//   · a throttle or the daily limit waits and carries on by itself; a
//     refusal stops with CallHub's words and "Carry on"
//   · a result: JSON or a form, at the top level or inside `data`; matched
//     by number against what this campaign sent; one phone contact with the
//     mapped outcome, credited to the member whose sign-in email is the
//     agent's; an open phone bank's number crossed off; once only; nothing
//     for a number never sent; a wrong address refused
//   · the outcome table is filled by pattern and correctable; a rating only
//     from a survey answer the desk mapped
//   · Settings → Services: Check reads, Connect writes; never a key in an
//     answer or on the log
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';
import { runDueJobs } from '../lib/jobs.js';
import { verifyChain } from '../lib/events.js';
import { startFakeCallHub } from './fake-callhub.js';

const tag = Math.random().toString(36).slice(2, 8);
const KEY = `chkey-${tag}-not-a-real-key`;
const PUBLIC = 'https://base.example.org';
const ENV = ['CALLHUB_API_KEY', 'CALLHUB_API_BASE', 'STARBASE_PUBLIC_URL'];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

let db, fake, mgr, staff, vol, ws;
const P = {};
const ids = {};
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
const tokenOf = (url) => url.split('/join/')[1];
const joinAs = async (role, name, email) => {
  const inv = await mgr.action('member.invite', { email, role });
  const cl = new Client();
  const r = await cl.post('/api/auth/join', { token: tokenOf(inv.json.joinUrl), name, password: 'dialer-pass-2026' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  ids[name] = r.json.user.id;
  return cl;
};
// Every job of this campaign that is due, until none is left.
const drain = async () => {
  for (let i = 0; i < 40; i += 1) {
    const r = await runDueJobs(db, { workspaceId: ws });
    if (!r.ran && !r.failed) return;
  }
  throw new Error('jobs never settled');
};
const pushesOf = async (q) => ok(await mgr.get(`/api/callhub/pushes?${q}`)).pushes;
const contactsOf = async (personId) => ok(await mgr.get(`/api/persons/${personId}`)).contacts;
const person = async (id) => ok(await mgr.get(`/api/persons/${id}`)).person;
const hookPath = () => new URL(fake.webhooks.find((w) => w.event === 'cc.notes' && w.target.startsWith(PUBLIC)).target).pathname;
// The phonebook a push made at the stand-in, by its name.
const bookOf = (name) => [...fake.phonebooks.values()].find((b) => b.name === name);

before(async () => {
  db = await freshDb();
  fake = await startFakeCallHub({
    apiKey: KEY,
    deliver: async (raw, headers, target) => {
      const res = await app.request(new URL(target).pathname, { method: 'POST', headers, body: raw });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
  });
  // One a second in real life; the tests don't wait.
  (await import('../ext/callhub/push.js').catch(() => null))?._setPaceForTest(0);
  for (const k of ENV) delete process.env[k];
  mgr = new Client();
  const r = await mgr.signup({ name: 'Marco Example', workspaceName: 'Imagine Surrey', email: `marco+${tag}@example.org`, jurisdiction: 'bc-municipal' });
  ws = r.json.workspace.id;
  staff = await joinAs('staff', 'Sam Example', `sam+${tag}@example.org`);
  vol = await joinAs('volunteer', 'Val Example', `val+${tag}@example.org`);
  const mk = async (key, name, extra = {}) => { P[key] = await mgr.createPerson(name, extra); };
  await mk('ana', 'Ana Example', { phone: '604-555-0101', city: 'Surrey', email: `ana+${tag}@example.org`, address: '13450 104 Ave', tags: ['newton', 'donor-prospect'] });
  await mk('ben', 'Ben Example', { phone: '(604) 555-0102', city: 'Surrey' });
  await mk('cy', 'Cy Example', { phone: '604 555 0103 ext 4' });
  await mk('alex', 'Alex Example', { phone: '604-555-0110', city: 'Surrey' });
  await mk('zoe', 'Zoe Example', { phone: '(604) 555-0110' });
  await mk('dee', 'Dee Example', { phone: '604-555-0120', tags: ['do-not-contact'] });
  await mk('noel', 'Noel Example', { phone: '604-555-0121', tags: ['do-not-call'] });
  await mk('pat', 'Pat Example', { phone: '604-555-0130', tags: ['do-not-call'] });
  await mk('quinn', 'Quinn Example', { phone: '604 555 0130' });
  await mk('short', 'Short Example', { phone: '555-0199' });
  await mk('none', 'No Phone Example');
  // A number that replied STOP to a text (ext/texting).
  await db.query(
    `insert into texting_optouts (id, workspace_id, phone, opted_out, keyword) values (gen_random_uuid(), $1, '+16045550140', true, 'STOP')`, [ws],
  );
  ids.list = ok(await mgr.action('list.create', { name: 'Undecided in Newton', kind: 'people', person_ids: Object.values(P).map((p) => p.id) })).list.id;
  // Rated before any call, so a result that carries no mapped answer can be seen to leave it alone.
  ok(await mgr.action('contact.log', { person_id: P.cy.id, channel: 'door', outcome: 'contacted', rating: '3' }));
});

after(async () => {
  await fake?.close();
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const connectCallHub = () => {
  process.env.CALLHUB_API_KEY = KEY;
  process.env.CALLHUB_API_BASE = `${fake.url}/v1/`;
  process.env.STARBASE_PUBLIC_URL = PUBLIC;
};

test('not set up: the desk is told CallHub is off, a push says so, the address answers 503, nothing leaves', async () => {
  assert.deepEqual(ok(await staff.get('/api/integrations')), { callhub: false });
  assert.equal((await vol.get('/api/integrations')).status, 403, 'volunteers are not told');
  const row = ok(await mgr.get('/api/connections')).services.find((s) => s.key === 'callhub');
  assert.equal(row.name, 'Phone dialer (CallHub)');
  assert.deepEqual([row.state, row.launch, row.missing], ['missing', false, ['CALLHUB_API_KEY']]);
  assert.match(row.detail, /^Built from CallHub’s published documentation\. Before your first calling night: press Check, then make one test call and see its result arrive on the person\.$/);
  assert.deepEqual(ok(await mgr.post('/api/connections/check', { key: 'callhub' })), { key: 'callhub', ok: false, said: 'CALLHUB_API_KEY isn’t set' });
  const r = await mgr.action('callhub.push', { list_id: ids.list });
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.equal(r.json.error, 'CallHub isn’t connected');
  const c = await mgr.action('callhub.connect', {});
  assert.deepEqual([c.status, c.json.ok, c.json.said], [200, false, 'CALLHUB_API_KEY isn’t set']);
  const hook = await app.request(`/hooks/callhub/${'a'.repeat(32)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(hook.status, 503);
  assert.equal(fake.calls.length, 0, 'CallHub was never asked');
});

test('Settings → Services: Check reads and says what is missing; Connect is its own step; never the key in an answer', async () => {
  connectCallHub();
  assert.deepEqual(ok(await staff.get('/api/integrations')), { callhub: true });
  let l = ok(await mgr.get('/api/connections'));
  const row = l.services.find((s) => s.key === 'callhub');
  assert.deepEqual([row.state, row.missing, row.checkable], ['ready', [], true]);
  assert.equal(row.connect.action, 'callhub.connect');
  assert.equal((await staff.get('/api/connections')).status, 403);

  let c = ok(await mgr.post('/api/connections/check', { key: 'callhub' }));
  assert.deepEqual([c.ok, c.said], [false, 'The key works, but CallHub isn’t sending results here yet — tap Connect']);
  assert.deepEqual(fake.calls.map((x) => `${x.method} ${x.path}`), ['GET /v1/agents/', 'GET /v1/webhooks/'], 'Check only reads');
  assert.equal(fake.calls[0].auth, `Token ${KEY}`);
  assert.equal(fake.webhooks.length, 0, 'Check never writes');

  assert.equal((await staff.action('callhub.connect', {})).status, 403, 'managers only');
  const done = ok(await mgr.action('callhub.connect', {}));
  assert.deepEqual([done.ok, done.said], [true, 'CallHub now sends each call’s result here']);
  assert.equal(fake.webhooks.length, 1);
  assert.equal(fake.webhooks[0].event, 'cc.notes');
  assert.match(fake.webhooks[0].target, new RegExp(`^${PUBLIC}/hooks/callhub/[0-9a-f]{32}$`));
  const again = ok(await mgr.action('callhub.connect', {}));
  assert.deepEqual([again.ok, again.said], [true, 'CallHub already sends each call’s result here']);
  assert.equal(fake.webhooks.length, 1, 'connecting twice is one webhook');
  // After a new key the address is new: Connect gives CallHub the new one and
  // takes the old one of this base.win away — never another tool's webhook,
  // however many pages CallHub lists them on.
  const mine = fake.webhooks[0].target;
  fake.webhooks.length = 0;
  for (let i = 0; i < 12; i += 1) fake.webhooks.push({ id: 900 + i, event: i % 2 ? 'sb.reply' : 'cc.notes', target: `https://other-tool.example.org/hook/${i}` });
  fake.webhooks.push({ id: 950, event: 'cc.notes', target: `${PUBLIC}/hooks/callhub/${'f'.repeat(32)}` });
  let c2 = ok(await mgr.post('/api/connections/check', { key: 'callhub' }));
  assert.match(c2.said, /isn’t sending results here yet — tap Connect$/, 'an old address is not this one');
  assert.equal(ok(await mgr.action('callhub.connect', {})).said, 'CallHub now sends each call’s result here');
  assert.deepEqual(fake.webhooks.filter((w) => w.target.startsWith(PUBLIC)).map((w) => w.target), [mine], 'the old address is gone, the new one is there');
  assert.equal(fake.webhooks.filter((w) => w.target.startsWith('https://other-tool.example.org/')).length, 12, 'other tools’ webhooks are untouched');
  c2 = ok(await mgr.post('/api/connections/check', { key: 'callhub' }));
  assert.equal(c2.ok, true, 'found on the second page');
  // (From here on only this base.win hears results.)
  for (let i = fake.webhooks.length - 1; i >= 0; i -= 1) if (!fake.webhooks[i].target.startsWith(PUBLIC)) fake.webhooks.splice(i, 1);

  c = ok(await mgr.post('/api/connections/check', { key: 'callhub' }));
  assert.deepEqual([c.ok, c.said], [true, 'The key works · results come back here']);

  // A wrong key, or the wrong address for this account.
  process.env.CALLHUB_API_KEY = 'someone-elses-key';
  c = ok(await mgr.post('/api/connections/check', { key: 'callhub' }));
  assert.equal(c.ok, false);
  assert.match(c.said, /^CallHub refused the key — is the address right\? Some accounts use api-na1\.callhub\.io \(CALLHUB_API_BASE\)$/);
  process.env.CALLHUB_API_KEY = KEY;

  // Never the key, never the address's last part: not in the list, a check, or the log.
  const secretPath = hookPath().split('/').pop();
  l = ok(await mgr.get('/api/connections'));
  const said = JSON.stringify([l, c, done, again, (await db.query('select payload from events where workspace_id = $1', [ws])).rows]);
  assert.ok(!said.includes(KEY), 'never the key');
  assert.ok(!said.includes(secretPath), 'never the address CallHub was given');
  assert.ok(l.inbound.some((i) => i.url === `${PUBLIC}/hooks/callhub/…`), 'Coming in names the address, without its last part');
});

test('a push: do-not-call and do-not-contact never leave, one contact per number, only phone, names and city', async () => {
  const before = fake.calls.length;
  assert.equal((await vol.action('callhub.push', { list_id: ids.list })).status, 403, 'not a volunteer’s to send');
  assert.equal((await mgr.action('callhub.push', {})).status, 400, 'a list or a phone bank');
  assert.equal((await mgr.action('callhub.push', { list_id: ids.list, bank_id: ids.list })).status, 400);
  const pre = ok(await staff.get(`/api/callhub/preview?list=${ids.list}`));
  assert.deepEqual([pre.numbers, pre.people, pre.left_out], [4, 5, 6], 'four numbers for five people; six left out');

  const r = ok(await staff.action('callhub.push', { list_id: ids.list }));
  ids.push = r.push.id;
  assert.deepEqual([r.push.status, r.push.total, r.push.sent, r.push.skipped], ['queued', 4, 0, 6]);
  assert.match(r.push.name, /^Undecided in Newton — [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [ap]m$/);
  assert.equal(fake.calls.length, before, 'nothing is sent inside the tap: a background job does it');
  assert.equal((await staff.action('callhub.push', { list_id: ids.list })).status, 409, 'not twice at once');

  await drain();
  const [p] = await pushesOf(`list=${ids.list}`);
  assert.deepEqual([p.status, p.total, p.sent, p.skipped, p.by], ['sent', 4, 4, 6, 'Sam Example']);
  assert.ok(p.sent_at);
  const book = bookOf(p.name);
  assert.ok(book, 'a phonebook by the push’s name');
  assert.deepEqual(fake.sent(book.id), [
    { contact: '+16045550110', first_name: 'Alex', last_name: 'Example', city: 'Surrey', country_code: 'CA' },
    { contact: '+16045550101', first_name: 'Ana', last_name: 'Example', city: 'Surrey', country_code: 'CA' },
    { contact: '+16045550102', first_name: 'Ben', last_name: 'Example', city: 'Surrey', country_code: 'CA' },
    { contact: '+16045550103', first_name: 'Cy', last_name: 'Example', country_code: 'CA' },
  ], 'in name order: one contact per number, the first by name; nothing but phone, names and city');
  const left = JSON.stringify(fake.upserts().map((c) => c.params));
  for (const never of ['newton', 'donor-prospect', 'example.org', '104 Ave', '5550120', '5550121', '5550130', '5550199', 'Dee', 'Noel', 'Pat', 'Quinn', 'Zoe', 'Short', 'No Phone']) {
    assert.ok(!left.includes(never), `${never} never left`);
  }
  // The do-not-call list gets a number and its kind, never a name.
  for (const c of fake.calls.filter((x) => x.path === '/v1/dnc_contacts/')) assert.deepEqual(Object.keys(c.params).sort(), ['category', 'dnc', 'phone_number']);
  assert.ok(fake.upserts().every((c) => c.idem), 'every write carries an idempotency key');
  assert.ok(fake.calls.slice(before).every((c) => c.auth === `Token ${KEY}`));

  // Who was sent is on the log, by whom — never a number, never the key.
  const ev = (await db.query(`select action, entity_type, op, payload, actor_id from events where workspace_id = $1 and action = 'callhub.push' order by seq`, [ws])).rows;
  assert.deepEqual(ev[0].payload, { source_kind: 'list', source_id: ids.list, name: p.name, total: 4, skipped: 6 });
  assert.equal(ev[0].actor_id, ids['Sam Example']);
  assert.equal(ev.filter((e) => e.entity_type === 'callhub_contact').length, 4, 'one line per number sent');
  assert.ok(!JSON.stringify(ev).includes('555'), 'no phone number on the log');
});

test('people not to call go to a CallHub do-not-call list with the push: once each, by kind', async () => {
  assert.deepEqual(fake.dncLists.map((l) => l.name), ['base.win']);
  const byNumber = Object.fromEntries(fake.dnc.map((d) => [d.phone_number, d.category]));
  assert.deepEqual(byNumber, {
    '+16045550120': 3, // do-not-contact: no calls, no texts
    '+16045550121': 1, // do-not-call: calls only
    '+16045550130': 1,
    '+16045550140': 2, // replied STOP: texts only
  });
  // A second push sends nobody twice, and makes no second list.
  const r = ok(await mgr.action('callhub.push', { list_id: ids.list }));
  await drain();
  assert.equal(fake.dncLists.length, 1);
  assert.equal(fake.dnc.length, 4, 'what was sent is remembered');
  const [p2] = await pushesOf(`list=${ids.list}`);
  assert.deepEqual([p2.id, p2.status, p2.sent], [r.push.id, 'sent', 4]);
  // Someone newly marked goes with the next push.
  ok(await mgr.action('person.update', { id: P.ben.id, tags: ['do-not-call'] }));
  const r3 = ok(await mgr.action('callhub.push', { list_id: ids.list }));
  assert.deepEqual([r3.push.total, r3.push.skipped], [3, 7]);
  await drain();
  assert.deepEqual(fake.dnc.at(-1).phone_number, '+16045550102');
  assert.equal(fake.dnc.length, 5);
  ok(await mgr.action('person.update', { id: P.ben.id, tags: [] }));
  ids.push = r3.push.id; // the newest push: where results for Ana, Cy and the shared number land
});

test('a result becomes a phone contact with the mapped outcome, the notes and the answers — on the person, never on a guess', async () => {
  const res = await fake.note({
    contact: '+16045550101', first_name: 'Ana', last_name: 'Example', disposition: 'Meaningful conversation', campaign: 'Fall voter ID',
    notes: 'Wants a lawn sign. Call after six.', surveys: [{ question: 'Can we count on your support?', answer: 'Leaning yes' }, { question: 'Top issue', answer: 'Transit' }],
    record_url: 'https://recordings.example.org/a1', agent: { id: 9, username: 'jo', email: 'jo@elsewhere.example' },
  });
  assert.deepEqual([res.status, res.body], [200, { received: true, filed: true }]);
  const [c] = await contactsOf(P.ana.id);
  assert.deepEqual([c.channel, c.outcome, c.rating, c.by_name], ['phone', 'contacted', null, null]);
  assert.equal(c.note, [
    'CallHub: Fall voter ID.',
    'Result: Meaningful conversation.',
    'Caller: jo.',
    'Notes: Wants a lawn sign. Call after six.',
    'Can we count on your support? Leaning yes.',
    'Top issue: Transit.',
  ].join('\n'));
  const row = (await db.query('select source, created_by from contacts where id = $1', [c.id])).rows[0];
  assert.deepEqual([row.source, row.created_by], ['callhub', null]);
  assert.equal((await person(P.ana.id)).rating, null, 'no rating: nobody said which answer means what');
  // On the log as the system; the raw result is kept.
  const ev = (await db.query(`select action, actor_id, payload from events where workspace_id = $1 and entity_id = $2`, [ws, c.id])).rows[0];
  assert.deepEqual([ev.action, ev.actor_id, ev.payload.source, ev.payload.person_id], ['callhub.result', null, 'callhub', P.ana.id]);
  const kept = (await db.query('select via, push_id, person_id, contact_id, phone, disposition, raw from callhub_results where contact_id = $1', [c.id])).rows[0];
  assert.deepEqual([kept.via, kept.push_id, kept.person_id, kept.phone, kept.disposition], ['webhook', ids.push, P.ana.id, '+16045550101', 'Meaningful conversation']);
  assert.equal(kept.raw.data.notes, 'Wants a lawn sign. Call after six.', 'as it came');
});

test('the same result twice is one contact', async () => {
  const fields = { contact: '6045550103', disposition: 'No Answer', campaign: 'Fall voter ID', agent: { username: 'jo', email: 'jo@elsewhere.example' } };
  assert.deepEqual((await fake.note(fields)).body, { received: true, filed: true });
  assert.deepEqual((await fake.note(fields)).body, { received: true, duplicate: true });
  assert.deepEqual((await fake.note(fields, { envelope: 'flat', as: 'form' })).body, { received: true, duplicate: true }, 'however it is sent again');
  const calls = (await contactsOf(P.cy.id)).filter((c) => c.channel === 'phone');
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].outcome, calls[0].rating], ['no_answer', null]);
  assert.equal((await person(P.cy.id)).rating, '3', 'the rating from the door stands');
  // Fifteen minutes on, the same words are another call (there is no call id to tell).
  await db.query(`update callhub_results set created_at = created_at - interval '16 minutes' where workspace_id = $1 and phone = '+16045550103'`, [ws]);
  assert.deepEqual((await fake.note(fields)).body, { received: true, filed: true });
  assert.equal((await contactsOf(P.cy.id)).filter((c) => c.channel === 'phone').length, 2);
});

test('JSON or a form, at the top level or inside data: each is read', async () => {
  const shapes = [
    [{ envelope: 'data', as: 'json' }, 'Left voicemail', 'left_message'],
    [{ envelope: 'flat', as: 'json' }, 'Wrong number', 'inaccessible'],
    [{ envelope: 'data', as: 'form' }, 'Not interested', 'refused'],
    [{ envelope: 'flat', as: 'form' }, 'Moved away', 'moved'],
  ];
  for (const [options, disposition, outcome] of shapes) {
    const res = await fake.note({ contact: '(604) 555-0101', mobile: '', disposition, campaign: 'Shapes', notes: `as ${options.envelope} ${options.as}`,
      surveys: [{ question: 'Sign?', answer: 'Yes' }], agent: { username: 'jo', email: 'jo@elsewhere.example' } }, options);
    assert.deepEqual([res.status, res.body], [200, { received: true, filed: true }], JSON.stringify(options));
    const [c] = await contactsOf(P.ana.id);
    assert.equal(c.outcome, outcome, `${disposition} → ${outcome}`);
    assert.match(c.note, new RegExp(`Notes: as ${options.envelope} ${options.as}\\.\\nSign\\? Yes\\.$`), 'the notes and the survey, whichever way they came');
    assert.match(c.note, /Caller: jo\./);
  }
  // The number under `mobile` when `contact` is empty.
  const viaMobile = await fake.note({ contact: '', mobile: '+1 604 555 0101', disposition: 'Busy', campaign: 'Shapes' });
  assert.deepEqual(viaMobile.body, { received: true, filed: true });
  assert.equal((await contactsOf(P.ana.id))[0].outcome, 'no_answer');
});

test('two people on one number make one contact, and the result lands on the first by name', async () => {
  const res = await fake.note({ contact: '+16045550110', disposition: 'Answered', campaign: 'Fall voter ID', agent: { username: 'jo' } });
  assert.deepEqual(res.body, { received: true, filed: true });
  assert.equal((await contactsOf(P.alex.id)).length, 1, 'Alex, first by name');
  assert.equal((await contactsOf(P.zoe.id)).length, 0);
});

test('a result for a number never sent files nothing and never makes a person; a wrong address is refused', async () => {
  const people = (await db.query('select count(*)::int as n from persons where workspace_id = $1', [ws])).rows[0].n;
  const contacts = (await db.query('select count(*)::int as n from contacts where workspace_id = $1', [ws])).rows[0].n;
  // Never pushed: a stranger, and someone on file who was left out (do-not-call).
  for (const number of ['+16045550177', '+16045550121']) {
    const res = await fake.note({ contact: number, first_name: 'Nobody', last_name: 'Example', disposition: 'Answered', notes: 'Supportive', campaign: 'Other list' });
    assert.deepEqual([res.status, res.body], [200, { received: true, filed: false }]);
  }
  // Not a number at all.
  assert.deepEqual((await fake.note({ contact: 'unknown', disposition: 'Answered' })).body, { received: true, filed: false });
  assert.equal((await db.query('select count(*)::int as n from persons where workspace_id = $1', [ws])).rows[0].n, people, 'nobody was made');
  assert.equal((await db.query('select count(*)::int as n from contacts where workspace_id = $1', [ws])).rows[0].n, contacts, 'nothing was filed');
  assert.equal((await contactsOf(P.noel.id)).length, 0);
  const unfiled = (await db.query('select phone, person_id, contact_id from callhub_results where workspace_id = $1 and contact_id is null order by created_at', [ws])).rows;
  assert.deepEqual(unfiled.map((u) => [u.phone, u.person_id]), [['+16045550177', null], ['+16045550121', null], [null, null]], 'kept, unfiled, for the desk');
  const check = ok(await mgr.post('/api/connections/check', { key: 'callhub' }));
  assert.match(check.said, /^The key works · results come back here · \d+ results so far · 3 for numbers base\.win never sent$/);

  // The address is the lock: a wrong last part is not found, and nothing is read.
  const body = JSON.stringify({ data: { contact: '+16045550101', disposition: 'Answered', notes: 'forged' } });
  const stored = (await db.query('select count(*)::int as n from callhub_results where workspace_id = $1', [ws])).rows[0].n;
  for (const path of [`/hooks/callhub/${'0'.repeat(32)}`, '/hooks/callhub/', `${hookPath()}x`, hookPath().toUpperCase()]) {
    const res = await app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal(res.status, 404, path);
  }
  assert.equal((await app.request(hookPath(), { method: 'GET' })).status, 404, 'only POST');
  assert.equal((await db.query('select count(*)::int as n from callhub_results where workspace_id = $1', [ws])).rows[0].n, stored);
  assert.ok(!(await contactsOf(P.ana.id)).some((c) => /forged/.test(c.note || '')));
  // Not a result at all: said so, nothing kept.
  const junk = await app.request(hookPath(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' });
  assert.equal(junk.status, 400);
});

test('an agent whose email is a member’s sign-in is credited with the call', async () => {
  const res = await fake.note({ contact: '+16045550101', disposition: 'Answered', campaign: 'Fall voter ID', notes: 'Credit check',
    agent: { id: 3, username: 'sam.e', email: `SAM+${tag}@Example.org` } });
  assert.deepEqual(res.body, { received: true, filed: true });
  const [c] = await contactsOf(P.ana.id);
  assert.equal(c.by_name, 'Sam Example', 'their own call, in their own numbers');
  assert.doesNotMatch(c.note, /Caller:/, 'the name is on the contact already');
  const row = (await db.query('select created_by from contacts where id = $1', [c.id])).rows[0];
  assert.equal(row.created_by, ids['Sam Example']);
  // Someone who is on another campaign only is not credited here.
  const other = new Client();
  await other.signup({ name: 'Otto Example', workspaceName: `Elsewhere ${tag}`, email: `otto+${tag}@example.org` });
  await fake.note({ contact: '+16045550101', disposition: 'Answered', campaign: 'Fall voter ID', notes: 'Not ours', agent: { username: 'otto', email: `otto+${tag}@example.org` } });
  const [c2] = await contactsOf(P.ana.id);
  assert.equal(c2.by_name, null);
  assert.match(c2.note, /Caller: otto\./);
});

test('a result crosses the number off an open phone bank — whoever it was handed to', async () => {
  const bank = ok(await mgr.action('bank.create', { name: 'Newton evening', person_ids: [P.ana.id, P.alex.id, P.zoe.id, P.cy.id], retry_hours: 4, max_tries: 2 }));
  ids.bank = bank.bank.id;
  ok(await mgr.action('bank.assign', { id: ids.bank, user_id: ids['Val Example'], count: 2 }));
  const numbers = async () => Object.fromEntries(ok(await mgr.get(`/api/banks/${ids.bank}`)).numbers.map((n) => [n.name, n]));
  // A talk is final: done, though the number was Val's and the dialer made the call.
  await fake.note({ contact: '+16045550101', disposition: 'Answered', campaign: 'Fall voter ID', notes: 'Bank check' });
  let n = await numbers();
  assert.ok(n['Ana Example'].done_at);
  assert.equal(n['Ana Example'].outcome, 'contacted');
  // The shared number: everyone on it is crossed off (the call reached that line).
  await fake.note({ contact: '+16045550110', disposition: 'Refused', campaign: 'Fall voter ID', notes: 'Bank check' });
  n = await numbers();
  assert.ok(n['Alex Example'].done_at && n['Zoe Example'].done_at);
  assert.equal(n['Alex Example'].outcome, 'refused');
  // No answer is not final: it comes back by the bank's own rule, then is done.
  await fake.note({ contact: '+16045550103', disposition: 'No answer', campaign: 'Fall voter ID', notes: 'Bank check 1' });
  n = await numbers();
  assert.equal(n['Cy Example'].done_at, null);
  assert.equal(n['Cy Example'].tries, 1);
  assert.ok(new Date(n['Cy Example'].next_at) > new Date(), 'back on the list later');
  await fake.note({ contact: '+16045550103', disposition: 'No answer', campaign: 'Fall voter ID', notes: 'Bank check 2' });
  n = await numbers();
  assert.ok(n['Cy Example'].done_at, 'its tries are spent');
  assert.equal(n['Cy Example'].outcome, 'no_answer');
});

test('a phone bank is sent the same way: its numbers still to call', async () => {
  const bank = ok(await mgr.action('bank.create', { name: 'Whalley calls', person_ids: [P.ana.id, P.ben.id, P.alex.id, P.zoe.id] }));
  ok(await mgr.action('bank.done', { id: bank.bank.id, person_id: P.ana.id, outcome: 'wrong number' }));
  const pre = ok(await mgr.get(`/api/callhub/preview?bank=${bank.bank.id}`));
  assert.deepEqual([pre.numbers, pre.people, pre.left_out], [2, 3, 0]);
  const r = ok(await mgr.action('callhub.push', { bank_id: bank.bank.id }));
  assert.deepEqual([r.push.total, r.push.skipped], [2, 0]);
  await drain();
  const [p] = await pushesOf(`bank=${bank.bank.id}`);
  assert.deepEqual([p.status, p.sent], ['sent', 2]);
  assert.deepEqual(fake.sent(bookOf(p.name).id).map((c) => c.contact), ['+16045550110', '+16045550102'], 'Alex’s shared number and Ben; Ana was already crossed off');
  assert.equal((await mgr.get(`/api/callhub/pushes?bank=${ids.list}`)).json.pushes.length, 0, 'a list’s pushes are not a bank’s');
  ids.bankPush = p.id;
});

test('the outcome table is filled by pattern and correctable; a correction also re-files what is already in', async () => {
  for (const [contact, disposition] of [['+16045550102', 'Call back later'], ['+16045550110', 'Call back later'], ['+16045550102', 'Supporter']]) {
    await fake.note({ contact, disposition, campaign: 'Whalley', notes: `${disposition} ${contact}` });
  }
  let [p] = await pushesOf(`bank=${ok(await mgr.get('/api/banks')).banks.find((b) => b.name === 'Whalley calls').id}`);
  assert.equal(p.results, 3);
  assert.deepEqual(p.dispositions, [
    { disposition: 'Call back later', n: 2, outcome: 'contacted', auto: true, suggested: 'contacted' },
    { disposition: 'Supporter', n: 1, outcome: 'contacted', auto: true, suggested: 'contacted' },
  ]);
  assert.equal((await staff.action('callhub.map', { id: p.id, outcomes: { 'Call back later': 'talked' } })).status, 400, 'an outcome base.win has');
  assert.equal((await vol.action('callhub.map', { id: p.id, outcomes: { 'Call back later': 'no_answer' } })).status, 403);
  const fixed = ok(await staff.action('callhub.map', { id: p.id, outcomes: { 'call back LATER ': 'no_answer' } }));
  assert.equal(fixed.changed, 2, 'the two already filed');
  [p] = await pushesOf(`bank=${ok(await mgr.get('/api/banks')).banks.find((b) => b.name === 'Whalley calls').id}`);
  assert.deepEqual(p.dispositions[0], { disposition: 'Call back later', n: 2, outcome: 'no_answer', auto: false, suggested: 'contacted' });
  const ben = (await contactsOf(P.ben.id)).filter((c) => /Whalley/.test(c.note || ''));
  assert.deepEqual(ben.map((c) => c.outcome).sort(), ['contacted', 'no_answer']);
  // …and the next one with that result follows the correction.
  await fake.note({ contact: '+16045550102', disposition: 'CALL BACK LATER', campaign: 'Whalley', notes: 'third' });
  assert.equal((await contactsOf(P.ben.id))[0].outcome, 'no_answer');
  // Back to the pattern.
  ok(await staff.action('callhub.map', { id: p.id, outcomes: { 'Call back later': null } }));
  assert.equal((await contactsOf(P.ben.id))[0].outcome, 'contacted');
});

test('“do not call” marks the person, and they are left out from then on', async () => {
  const res = await fake.note({ contact: '+16045550102', disposition: 'Do Not Call', campaign: 'Whalley', notes: 'Asked to be taken off the list' });
  assert.deepEqual(res.body, { received: true, filed: true });
  const [c] = await contactsOf(P.ben.id);
  assert.equal(c.outcome, 'refused');
  assert.ok((await person(P.ben.id)).tags.includes('do-not-call'));
  const pre = ok(await mgr.get(`/api/callhub/preview?list=${ids.list}`));
  assert.equal(pre.numbers, 3, 'Ben’s number no longer goes');
  ok(await mgr.action('person.update', { id: P.ben.id, tags: [] }));
});

test('a rating only ever comes from a survey answer the desk mapped — never guessed, and never over a newer one', async () => {
  const bankId = ok(await mgr.get('/api/banks')).banks.find((b) => b.name === 'Whalley calls').id;
  const survey = (answer) => [{ question: 'Can we count on your support?', answer }, { question: 'Top issue', answer: 'Transit' }];
  await fake.note({ contact: '+16045550102', disposition: 'Answered', campaign: 'Whalley', notes: 'r1', surveys: survey('Yes, definitely') });
  await fake.note({ contact: '+16045550110', disposition: 'Answered', campaign: 'Whalley', notes: 'r2', surveys: survey('Not sure yet') });
  assert.equal((await person(P.ben.id)).rating, null, 'nothing mapped: nobody’s rating moves');
  let [p] = await pushesOf(`bank=${bankId}`);
  const q = p.questions.find((x) => x.question === 'Can we count on your support?');
  assert.deepEqual(q.answers.map((a) => [a.answer, a.n, a.rating]), [['Not sure yet', 1, null], ['Yes, definitely', 1, null]], 'the answers seen, none counting yet');
  assert.equal(p.rating, null);

  // Alex was rated at the door after the call: the mapping must not undo that.
  ok(await mgr.action('contact.log', { person_id: P.alex.id, channel: 'door', outcome: 'contacted', rating: '2' }));
  assert.equal((await staff.action('callhub.map', { id: p.id, rating: { question: 'Can we count on your support?', answers: { 'Yes, definitely': '9' } } })).status, 400, 'a step on the campaign’s scale');
  const mapped = ok(await staff.action('callhub.map', { id: p.id, rating: { question: 'Can we count on your support?', answers: { 'Yes, definitely': '1', 'Not sure yet': '3' } } }));
  assert.equal(mapped.changed, 2);
  assert.equal((await person(P.ben.id)).rating, '1', 'what is already in is rated');
  assert.equal((await person(P.alex.id)).rating, '2', 'the newer rating from the door stands');
  const alexCall = (await contactsOf(P.alex.id)).find((c) => /r2/.test(c.note || ''));
  assert.equal(alexCall.rating, '3', 'the call still says what they answered');
  [p] = await pushesOf(`bank=${bankId}`);
  assert.equal(p.rating.question, 'Can we count on your support?');
  assert.deepEqual(p.questions.find((x) => x.question === 'Can we count on your support?').answers.map((a) => a.rating), ['3', '1']);
  assert.deepEqual(p.questions.map((x) => [x.question, x.support]), [['Can we count on your support?', true], ['Top issue', false]]);

  // From now on a mapped answer rates as it arrives; an answer nobody mapped never does.
  await fake.note({ contact: '+16045550102', disposition: 'Answered', campaign: 'Whalley', notes: 'r3', surveys: survey('not sure YET') });
  assert.equal((await person(P.ben.id)).rating, '3');
  assert.equal((await contactsOf(P.ben.id))[0].rating, '3');
  await fake.note({ contact: '+16045550102', disposition: 'Answered', campaign: 'Whalley', notes: 'r4', surveys: survey('Probably') });
  assert.equal((await person(P.ben.id)).rating, '3', '“Probably” was never mapped');
  assert.equal((await contactsOf(P.ben.id))[0].rating, null);
  // The next push starts with the same table and question.
  const again = ok(await mgr.action('callhub.push', { list_id: ids.list }));
  await drain();
  const [p2] = await pushesOf(`list=${ids.list}`);
  assert.equal(p2.id, again.push.id);
  assert.equal(p2.rating.question, 'Can we count on your support?');
  // Every number in the bank has been called by now: there is nothing to send.
  const empty = await mgr.action('callhub.push', { bank_id: bankId });
  assert.deepEqual([empty.status, empty.json.error], [409, 'No one here to send: no numbers left to call']);
});

test('a throttle mid-push waits and resumes where it stopped: nobody is sent twice', async () => {
  const people = [];
  for (let i = 0; i < 7; i += 1) people.push((await mgr.createPerson(`Throttle${i} Example`, { phone: `604-555-015${i}` })).id);
  const list = ok(await mgr.action('list.create', { name: 'Throttle list', kind: 'people', person_ids: people })).list.id;
  fake.throttle(3, 45); // three go, then CallHub says wait 45 seconds
  const r = ok(await mgr.action('callhub.push', { list_id: list }));
  await drain();
  let [p] = await pushesOf(`list=${list}`);
  assert.deepEqual([p.status, p.total, p.sent], ['sending', 7, 3]);
  assert.match(p.note, /^CallHub asked us to wait: “Request was throttled\. Expected available in 45 seconds\.”$/);
  const wait = new Date(p.resume_at) - Date.now();
  assert.ok(wait > 30_000 && wait < 60_000, `carries on in about 45 s (${wait})`);
  const book = bookOf(p.name);
  assert.equal(fake.sent(book.id).length, 3);
  // Nothing more until then.
  await drain();
  assert.equal(fake.sent(book.id).length, 3);
  // The wait is over (and CallHub is taking contacts again).
  fake.throttle(false);
  await db.query(`update jobs set run_at = now() where workspace_id = $1 and kind = 'callhub.push' and status = 'pending'`, [ws]);
  await drain();
  [p] = await pushesOf(`list=${list}`);
  assert.deepEqual([p.id, p.status, p.sent, p.note, p.resume_at], [r.push.id, 'sent', 7, null, null]);
  const numbers = fake.sent(book.id).map((c) => c.contact);
  assert.equal(numbers.length, 7);
  assert.equal(new Set(numbers).size, 7, 'each number once');
  assert.equal([...fake.phonebooks.values()].filter((b) => b.name === p.name).length, 1, 'one phonebook');
});

test('CallHub’s daily limit: said in plain words, and the rest carries on by itself', async () => {
  const people = [];
  for (let i = 0; i < 5; i += 1) people.push((await mgr.createPerson(`Daily${i} Example`, { phone: `604-555-016${i}` })).id);
  const list = ok(await mgr.action('list.create', { name: 'Daily list', kind: 'people', person_ids: people })).list.id;
  const { _setDailyLimitForTest } = await import('../ext/callhub/push.js');
  const sentToday = (await db.query(`select count(*)::int as n from callhub_contacts where sent_at > now() - interval '24 hours'`)).rows[0].n;
  _setDailyLimitForTest(sentToday + 2);
  try {
    ok(await mgr.action('callhub.push', { list_id: list }));
    await drain();
    let [p] = await pushesOf(`list=${list}`);
    assert.deepEqual([p.status, p.sent, p.total], ['sending', 2, 5]);
    assert.equal(p.note, `CallHub takes ${(sentToday + 2).toLocaleString('en-CA')} contacts a day. The rest carry on by themselves.`);
    assert.ok(new Date(p.resume_at) > new Date());
    _setDailyLimitForTest(3600);
    await db.query(`update jobs set run_at = now() where workspace_id = $1 and kind = 'callhub.push' and status = 'pending'`, [ws]);
    await drain();
    [p] = await pushesOf(`list=${list}`);
    assert.deepEqual([p.status, p.sent, p.note], ['sent', 5, null]);
  } finally {
    _setDailyLimitForTest(3600);
  }
});

test('a refusal stops the push with CallHub’s words; Carry on picks up where it stopped', async () => {
  const people = [];
  for (let i = 0; i < 4; i += 1) people.push((await mgr.createPerson(`Stop${i} Example`, { phone: `604-555-017${i}` })).id);
  const list = ok(await mgr.action('list.create', { name: 'Stopped list', kind: 'people', person_ids: people })).list.id;
  const r = ok(await mgr.action('callhub.push', { list_id: list }));
  // The key stops working after the phonebook and two contacts.
  const realFetch = globalThis.fetch;
  let upserts = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/upsert_contact/') && (upserts += 1) > 2) {
      return new Response(JSON.stringify({ detail: 'Invalid token.' }), { status: 401, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(url, init);
  };
  try { await drain(); } finally { globalThis.fetch = realFetch; }
  let [p] = await pushesOf(`list=${list}`);
  assert.deepEqual([p.status, p.sent, p.total], ['failed', 2, 4]);
  assert.equal(p.note, 'CallHub said “Invalid token.”');
  assert.equal((await vol.action('callhub.resume', { id: r.push.id })).status, 403);
  ok(await staff.action('callhub.resume', { id: r.push.id }));
  await drain();
  [p] = await pushesOf(`list=${list}`);
  assert.deepEqual([p.status, p.sent, p.note], ['sent', 4, null]);
  const numbers = fake.sent(bookOf(p.name).id).map((c) => c.contact);
  assert.equal(new Set(numbers).size, 4);
  assert.equal(numbers.length, 4, 'the two that went are not sent again');
  assert.equal((await staff.action('callhub.resume', { id: r.push.id })).status, 409, 'nothing to carry on');
});

test('someone marked do-not-call while a push waits is not sent', async () => {
  const a = await mgr.createPerson('Late A Example', { phone: '604-555-0180' });
  const b = await mgr.createPerson('Late B Example', { phone: '604-555-0181' });
  const list = ok(await mgr.action('list.create', { name: 'Late list', kind: 'people', person_ids: [a.id, b.id] })).list.id;
  ok(await mgr.action('callhub.push', { list_id: list }));
  ok(await mgr.action('person.update', { id: b.id, tags: ['do-not-call'] }));
  await drain();
  const [p] = await pushesOf(`list=${list}`);
  assert.deepEqual([p.status, p.total, p.sent, p.skipped], ['sent', 1, 1, 1]);
  assert.deepEqual(fake.sent(bookOf(p.name).id).map((c) => c.contact), ['+16045550180']);
  // …and a result for that number is for a number never sent.
  assert.deepEqual((await fake.note({ contact: '+16045550181', disposition: 'Answered' })).body, { received: true, filed: false });
});

test('the address answers on the campaign’s own website domain too, and only there for CallHub', async () => {
  const { forgetDomains } = await import('../ext/site/store.js');
  ok(await mgr.get('/api/site'));
  await db.query(`update site_settings set domains = '["vote.example.net"]' where workspace_id = $1`, [ws]);
  forgetDomains();
  try {
    const at = (path, init) => app.request(`http://vote.example.net${path}`, init);
    const body = JSON.stringify({ data: { contact: '+16045550101', disposition: 'Answered', campaign: 'Site domain', notes: 'via the site domain' } });
    const res = await at(hookPath(), { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { received: true, filed: true });
    const wrong = await at(`/hooks/callhub/${'0'.repeat(32)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal(wrong.status, 404);
    assert.equal((await at('/api/integrations')).status, 404, 'the app itself does not answer there');
  } finally {
    await db.query(`update site_settings set domains = '[]' where workspace_id = $1`, [ws]);
    forgetDomains();
  }
});

test('CallHub not answering: tried again by itself, then stopped with its words — and Carry on finishes it', async () => {
  const a = await mgr.createPerson('Outage A Example', { phone: '604-555-0182' });
  const b = await mgr.createPerson('Outage B Example', { phone: '604-555-0183' });
  const list = ok(await mgr.action('list.create', { name: 'Outage list', kind: 'people', person_ids: [a.id, b.id] })).list.id;
  const due = () => db.query(`update jobs set run_at = now() where workspace_id = $1 and kind = 'callhub.push' and status = 'pending'`, [ws]);
  const r = ok(await mgr.action('callhub.push', { list_id: list }));
  fake.refuse(503);
  await drain();
  let [p] = await pushesOf(`list=${list}`);
  assert.deepEqual([p.status, p.sent], ['sending', 0]);
  assert.equal(p.note, 'CallHub said “Simulated outage” — trying again shortly');
  await due(); await drain();
  [p] = await pushesOf(`list=${list}`);
  assert.equal(p.status, 'sending', 'a second try');
  await due(); await drain();
  [p] = await pushesOf(`list=${list}`);
  assert.deepEqual([p.status, p.note], ['failed', 'CallHub said “Simulated outage”'], 'three tries, then it stops and says so');
  await due(); await drain();
  assert.equal((await pushesOf(`list=${list}`))[0].status, 'failed', 'and stays stopped until someone carries on');
  fake.refuse(false);
  ok(await mgr.action('callhub.resume', { id: r.push.id }));
  await drain();
  [p] = await pushesOf(`list=${list}`);
  assert.deepEqual([p.status, p.sent, p.note], ['sent', 2, null]);
});

test('two records made one: results for the number follow the record that was kept', async () => {
  const keep = await mgr.createPerson('Mara Example', { phone: '604-555-0184' });
  const drop = await mgr.createPerson('Mara Exampl', { phone: '604 555 0184' });
  const solo = await mgr.createPerson('Milo Example', { phone: '604-555-0185' });
  const list = ok(await mgr.action('list.create', { name: 'Merge list', kind: 'people', person_ids: [keep.id, drop.id, solo.id] })).list.id;
  ok(await mgr.action('callhub.push', { list_id: list }));
  await drain();
  // "Mara Exampl" sorts first, so it was the one sent; it is then merged away.
  ok(await mgr.action('person.merge', { keep: keep.id, drop: drop.id }));
  assert.deepEqual((await fake.note({ contact: '+16045550184', disposition: 'Answered', notes: 'after the merge' })).body, { received: true, filed: true });
  assert.match((await contactsOf(keep.id))[0].note, /after the merge/);
  // A record taken off the file altogether gets nothing.
  await db.query('update persons set deleted_at = now() where id = $1', [solo.id]);
  assert.deepEqual((await fake.note({ contact: '+16045550185', disposition: 'Answered', notes: 'gone' })).body, { received: true, filed: false });
});

test('who may: the desk only, and never someone a manager took People away from', async () => {
  for (const path of [`/api/callhub/pushes?list=${ids.list}`, `/api/callhub/preview?list=${ids.list}`]) {
    assert.equal((await vol.get(path)).status, 403, path);
    assert.equal((await staff.get(path)).status, 200, path);
    assert.equal((await new Client().get(path)).status, 401, path);
  }
  assert.equal((await staff.get('/api/callhub/pushes')).status, 400, 'a list or a phone bank');
  assert.equal((await staff.get('/api/callhub/preview?list=nope')).status, 400);
  assert.equal((await staff.get(`/api/callhub/preview?list=${ids.push}`)).status, 404, 'not a list');
  const seen = JSON.stringify((await staff.get(`/api/callhub/pushes?list=${ids.list}`)).json);
  assert.ok(!seen.includes('555') && !seen.includes(KEY), 'counts and CallHub’s words: never a number, never the key');
  ok(await mgr.action('permission.member.set', { user_id: ids['Sam Example'], grant: [], deny: ['people'] }));
  try {
    assert.equal((await staff.get(`/api/callhub/pushes?list=${ids.list}`)).status, 403);
    assert.equal((await staff.action('callhub.push', { list_id: ids.list })).status, 403);
    assert.equal((await staff.action('callhub.map', { id: ids.push, outcomes: {} })).status, 403);
  } finally {
    ok(await mgr.action('permission.member.set', { user_id: ids['Sam Example'], grant: [], deny: [] }));
  }
});

test('every write is on the hash chain, as the person who pushed or as the system; the books verify; the export carries it', async () => {
  const rows = (await db.query(`select action, actor_id from events where workspace_id = $1 and action like 'callhub.%'`, [ws])).rows;
  const actions = [...new Set(rows.map((r) => r.action))].sort();
  assert.deepEqual(actions, ['callhub.connect', 'callhub.map', 'callhub.push', 'callhub.result', 'callhub.resume']);
  assert.ok(rows.filter((r) => r.action === 'callhub.result').every((r) => r.actor_id === null), 'results are the system’s');
  assert.ok(rows.filter((r) => r.action === 'callhub.push').every((r) => r.actor_id), 'a push is the sender’s');
  assert.equal((await verifyChain(db, ws)).ok, true);
  const exported = ok(await mgr.get('/api/export'));
  for (const t of ['callhub_pushes', 'callhub_contacts', 'callhub_results', 'callhub_dnc']) assert.ok(Array.isArray(exported[t]) && exported[t].length, t);
  const everything = JSON.stringify([exported.events, exported.callhub_pushes]);
  assert.ok(!everything.includes(KEY));
  assert.ok(!everything.includes(hookPath().split('/').pop()));
});

test('the rules, with no database: the outcome a result counts as, how a delivery is read, the address’s key', async () => {
  const { outcomeFor, readDelivery, surveyPairs } = await import('../ext/callhub/results.js');
  const { pathKey, apiBase } = await import('../ext/callhub/callhub.js');
  for (const [said, outcome] of [
    ['No answer', 'no_answer'], ['BUSY', 'no_answer'], ['Not home', 'no_answer'],
    ['Voicemail', 'left_message'], ['Left Message', 'left_message'], ['Answering machine', 'left_message'],
    ['Wrong Number', 'inaccessible'], ['Disconnected', 'inaccessible'], ['Invalid number', 'inaccessible'],
    ['Refused', 'refused'], ['Not interested', 'refused'], ['Hung up', 'refused'],
    ['Do not call', 'do_not_call'], ['DNC', 'do_not_call'], ['Remove from list', 'do_not_call'],
    ['Moved', 'moved'], ['Answered', 'contacted'], ['Supporter', 'contacted'], ['', 'contacted'], [null, 'contacted'],
  ]) assert.equal(outcomeFor(said), outcome, String(said));
  assert.equal(outcomeFor('Wrong number', { 'wrong number': 'refused' }), 'refused', 'the desk’s own word wins');
  assert.equal(outcomeFor('Wrong number', { 'wrong number': 'nonsense' }), 'inaccessible', 'unless it is no outcome at all');

  const json = (o) => readDelivery(Buffer.from(JSON.stringify(o)), 'application/json');
  assert.equal(json({ data: { contact: '1' } }).fields.contact, '1');
  assert.equal(json({ contact: '2', 'agent.email': 'a@example.org' }).fields.agent.email, 'a@example.org', 'dotted keys');
  assert.equal(json({ data: JSON.stringify({ contact: '3' }) }).fields.contact, '3', 'data as text');
  assert.equal(readDelivery(Buffer.from('contact=4&agent%5Bemail%5D=b%40example.org&surveys=%5B%5D'), 'application/x-www-form-urlencoded').fields.agent.email, 'b@example.org', 'bracket keys');
  assert.equal(readDelivery(Buffer.from('{"contact":"5"}'), '').fields.contact, '5', 'JSON with no type said');
  assert.equal(readDelivery(Buffer.from('not json'), 'application/json'), null);
  assert.equal(readDelivery(Buffer.from('[1,2]'), 'application/json'), null);
  assert.deepEqual(surveyPairs([{ question: 'A?', answer: 'x' }, { 'B?': 'y' }, ['C?', 'z'], { key: 'D?', value: ['p', 'q'] }]), [['A?', 'x'], ['B?', 'y'], ['C?', 'z'], ['D?', 'p, q']]);
  assert.deepEqual(surveyPairs({ 'E?': 'w', 'F?': '' }), [['E?', 'w']]);
  assert.deepEqual(surveyPairs('[{"question":"G?","response":"v"}]'), [['G?', 'v']]);
  assert.deepEqual(surveyPairs(null), []);

  const keep = { k: process.env.CALLHUB_API_KEY, b: process.env.CALLHUB_API_BASE };
  try {
    process.env.CALLHUB_API_KEY = 'one';
    const one = pathKey();
    assert.match(one, /^[0-9a-f]{32}$/);
    process.env.CALLHUB_API_KEY = 'two';
    assert.notEqual(pathKey(), one, 'a new key is a new address');
    assert.ok(!one.includes('one'));
    for (const [set, want] of [[undefined, 'https://api.callhub.io'], ['https://api-na1.callhub.io/v1/', 'https://api-na1.callhub.io'], ['api-na1.callhub.io', 'https://api-na1.callhub.io'], ['http://127.0.0.1:4981', 'http://127.0.0.1:4981']]) {
      if (set === undefined) delete process.env.CALLHUB_API_BASE; else process.env.CALLHUB_API_BASE = set;
      assert.equal(apiBase(), want);
    }
  } finally {
    process.env.CALLHUB_API_KEY = keep.k;
    if (keep.b === undefined) delete process.env.CALLHUB_API_BASE; else process.env.CALLHUB_API_BASE = keep.b;
  }
});
