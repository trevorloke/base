// CallHub (ext/callhub): a call list goes to the dialer, and each call's
// result comes back onto the person. CallHub itself is a stand-in here
// (test/fake-callhub.js at CALLHUB_API_BASE): nothing reaches the real one.
//   · who leaves: a number e164() takes, never do-not-contact or do-not-call
//     (nor a number one of them shares); one contact per number; only the
//     phone, first and last name and city
//   · people not to call go to a CallHub do-not-call list with each push,
//     and when someone is newly marked
//   · a throttle or the daily limit waits and carries on by itself; a
//     number CallHub won't take is left out and counted; a refusal of the
//     push stops with CallHub's words and "Carry on"
//   · a result: JSON or a form, at the top level or inside `data`; matched
//     by number against what this campaign sent; one phone contact with the
//     mapped outcome, credited to the member whose sign-in email is the
//     agent's; an open phone bank's number crossed off; once only; nothing
//     for a number never sent; a wrong address refused; what can't be read
//     is kept as it came
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
  (await import('../ext/callhub/callhub.js'))._setPaceForTest(0);
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
  assert.equal(ok(await staff.get('/api/integrations')).callhub, false);
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
  // With the key but no public address, Connect has nowhere to point CallHub: it says so and writes nothing.
  process.env.CALLHUB_API_KEY = KEY;
  process.env.CALLHUB_API_BASE = `${fake.url}/v1/`;
  const early = ok(await mgr.action('callhub.connect', {}));
  assert.deepEqual([early.ok, early.said], [false, 'Set the public address first (STARBASE_PUBLIC_URL): CallHub needs somewhere to send results']);
  assert.equal(fake.calls.length, 0, 'CallHub was not asked');
  connectCallHub();
  assert.equal(ok(await staff.get('/api/integrations')).callhub, true);
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
  // The same address as CallHub may hand it back (a last slash, the host's capitals) is still this one.
  const asGiven = fake.webhooks[0].target;
  fake.webhooks[0].target = `${asGiven.replace('base.example.org', 'Base.Example.ORG')}/`;
  assert.equal(ok(await mgr.post('/api/connections/check', { key: 'callhub' })).ok, true);
  assert.equal(ok(await mgr.action('callhub.connect', {})).said, 'CallHub already sends each call’s result here');
  fake.webhooks[0].target = asGiven;
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
  // Should CallHub keep one webhook per event: our own old address makes way for the new one.
  fake.webhooks.length = 0;
  fake.webhooks.push({ id: 951, event: 'cc.notes', target: `${PUBLIC}/hooks/callhub/${'e'.repeat(32)}` });
  fake.oneHookPerEvent(true);
  assert.equal(ok(await mgr.action('callhub.connect', {})).said, 'CallHub now sends each call’s result here');
  assert.deepEqual(fake.webhooks.map((w) => w.target), [mine]);
  // …but never someone else's: CallHub's refusal is passed on in its words.
  fake.webhooks.length = 0;
  fake.webhooks.push({ id: 952, event: 'cc.notes', target: 'https://other-tool.example.org/hook/x' });
  const no = ok(await mgr.action('callhub.connect', {}));
  assert.deepEqual([no.ok, no.said], [false, 'CallHub didn’t take it: event: A webhook for this event already exists.']);
  assert.equal(fake.webhooks.length, 1, 'the other tool’s webhook stands');
  fake.oneHookPerEvent(false);
  fake.webhooks.length = 0;
  ok(await mgr.action('callhub.connect', {}));
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
  // When it was sent, in the campaign's own time — the clock the phonebook's name was stamped with.
  assert.match(p.sent_words, /^\d{1,2}:\d{2} [ap]m$/);
  assert.ok(p.name.endsWith(p.sent_words) || Math.abs(new Date(p.sent_at) - new Date(p.created_at)) > 30_000, `${p.name} / ${p.sent_words}`);
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
  // Someone newly marked does not wait for the next push: a job tells CallHub, as the system.
  ok(await mgr.action('person.update', { id: P.ben.id, tags: ['do-not-call'] }));
  await drain();
  assert.deepEqual([fake.dnc.at(-1).phone_number, fake.dnc.at(-1).category], ['+16045550102', 1]);
  assert.equal(fake.dnc.length, 5);
  const told = (await db.query(`select actor_id, payload from events where workspace_id = $1 and action = 'callhub.dnc'`, [ws])).rows;
  assert.deepEqual(told.map((e) => [e.actor_id, e.payload]), [[null, { do_not_call_told: 1 }]], 'on the log: how many, never which');
  // …and the next push leaves them out, and tells CallHub nothing twice.
  const r3 = ok(await mgr.action('callhub.push', { list_id: ids.list }));
  assert.deepEqual([r3.push.total, r3.push.skipped], [3, 7]);
  await drain();
  assert.equal(fake.dnc.length, 5);
  // The tag taken off again: the number comes off CallHub's list too — by its own entry, as the system.
  ok(await mgr.action('person.update', { id: P.ben.id, tags: [] }));
  await drain();
  assert.equal(fake.dnc.length, 4);
  assert.ok(!fake.dnc.some((d) => d.phone_number === '+16045550102'), 'Ben can be called again, at CallHub too');
  const off = fake.calls.filter((c) => c.method === 'DELETE' && /^\/v1\/dnc_contacts\//.test(c.path));
  assert.deepEqual(off.map((c) => [c.status, Boolean(c.idem)]), [[204, true]]);
  assert.deepEqual((await db.query(`select payload from events where workspace_id = $1 and action = 'callhub.dnc' order by seq desc limit 1`, [ws])).rows[0].payload, { do_not_call_freed: 1 });
  // A tag that changes nothing about calls queues nothing.
  const jobs = async () => (await db.query(`select count(*)::int as n from jobs where workspace_id = $1 and kind = 'callhub.dnc'`, [ws])).rows[0].n;
  const before = await jobs();
  ok(await mgr.action('person.update', { id: P.ben.id, tags: ['newton'] }));
  ok(await mgr.action('person.update', { id: P.ben.id, tags: [] }));
  ok(await mgr.action('person.update', { id: P.ana.id, city: 'Surrey' }));
  assert.equal(await jobs(), before);
  ids.push = r3.push.id; // the newest push: where results for Ana, Cy and the shared number land
});

test('a number CallHub was told for texts only is changed to calls too, not left as it was', async () => {
  // +1 604 555 0140 replied STOP to a text (told as texts only). Now someone on that number asks not to be called.
  const entry = fake.dnc.find((d) => d.phone_number === '+16045550140');
  assert.equal(entry.category, 2);
  fake.uniqueDnc(true); // should CallHub refuse a second entry for a number, the first one must still change
  try {
    await mgr.createPerson('Stop Then Call Example', { phone: '604-555-0140', tags: ['do-not-call'] });
    await drain();
    assert.equal(entry.category, 3, 'no calls and no texts now');
    assert.equal(fake.dnc.filter((d) => d.phone_number === '+16045550140').length, 1, 'the same entry, changed');
    const put = fake.calls.filter((c) => c.method === 'PUT');
    assert.deepEqual(put.map((c) => [c.path, c.params.category, Boolean(c.idem)]), [[`/v1/dnc_contacts/${entry.id}/`, 3, true]]);
    assert.equal((await db.query(`select category from callhub_dnc where workspace_id = $1 and phone = '+16045550140'`, [ws])).rows[0].category, 3);
    // Told once: nothing more goes for it.
    const n = fake.calls.length;
    ok(await mgr.action('person.update', { id: P.noel.id, tags: ['do-not-call', 'newton'] }));
    await drain();
    assert.equal(fake.calls.filter((c, i) => i >= n && /dnc_contacts/.test(c.path)).length, 0);
  } finally {
    fake.uniqueDnc(false);
  }
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
  assert.equal((await app.request(`/hooks/callhub/${'0'.repeat(32)}`, { method: 'GET' })).status, 404);
  assert.equal((await db.query('select count(*)::int as n from callhub_results where workspace_id = $1', [ws])).rows[0].n, stored);
  assert.ok(!(await contactsOf(P.ana.id)).some((c) => /forged/.test(c.note || '')));
});

test('what base.win can’t read as a result is kept as it came, and Check says so; a probe of the address is answered', async () => {
  const post = (body, type = 'application/json') => app.request(hookPath(), { method: 'POST', headers: { 'content-type': type }, body });
  const contacts = (await db.query('select count(*)::int as n from contacts where workspace_id = $1', [ws])).rows[0].n;
  // CallHub's real shape is not confirmed: something else entirely is not thrown away.
  const odd = '<call><number>+16045550101</number><result>Answered</result></call>';
  let res = await post(odd, 'application/xml');
  assert.deepEqual([res.status, await res.json()], [200, { received: true, read: false, filed: false }]);
  res = await post(odd, 'application/xml');
  assert.deepEqual(await res.json(), { received: true, read: false, duplicate: true }, 'the same bytes again are the same delivery');
  res = await post(JSON.stringify([{ contact: '+16045550101' }]));
  assert.deepEqual(await res.json(), { received: true, read: false, filed: false }, 'a list is not a result base.win reads');
  const kept = (await db.query(`select raw, person_id, contact_id from callhub_results where workspace_id = $1 and raw->>'unread' is not null order by created_at`, [ws])).rows;
  assert.deepEqual(kept.map((k) => [k.raw.unread, k.raw.type, k.person_id, k.contact_id]), [[odd, 'application/xml', null, null], ['[{"contact":"+16045550101"}]', 'application/json', null, null]]);
  assert.equal((await db.query('select count(*)::int as n from contacts where workspace_id = $1', [ws])).rows[0].n, contacts, 'nothing is filed from it');
  const check = ok(await mgr.post('/api/connections/check', { key: 'callhub' }));
  assert.match(check.said, /^The key works · results come back here · \d+ results so far · 3 for numbers base\.win never sent · 2 base\.win couldn’t read \(kept as they came\)$/);
  // Nothing sent at all (a service trying the address): fine, and nothing kept.
  res = await post('');
  assert.deepEqual([res.status, await res.json()], [200, { received: true, filed: false }]);
  res = await app.request(hookPath(), { method: 'GET' });
  assert.deepEqual([res.status, await res.json()], [200, { ok: true }]);
  assert.equal((await db.query(`select count(*)::int as n from callhub_results where workspace_id = $1 and raw->>'unread' is not null`, [ws])).rows[0].n, 2);
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
    { disposition: 'Call back later', n: 2, people: 2, outcome: 'contacted', auto: true, suggested: 'contacted' },
    { disposition: 'Supporter', n: 1, people: 1, outcome: 'contacted', auto: true, suggested: 'contacted' },
  ]);
  assert.equal((await staff.action('callhub.map', { id: p.id, outcomes: { 'Call back later': 'talked' } })).status, 400, 'an outcome base.win has');
  assert.equal((await vol.action('callhub.map', { id: p.id, outcomes: { 'Call back later': 'no_answer' } })).status, 403);
  const fixed = ok(await staff.action('callhub.map', { id: p.id, outcomes: { 'call back LATER ': 'no_answer' } }));
  assert.equal(fixed.changed, 2, 'the two already filed');
  [p] = await pushesOf(`bank=${ok(await mgr.get('/api/banks')).banks.find((b) => b.name === 'Whalley calls').id}`);
  assert.deepEqual(p.dispositions[0], { disposition: 'Call back later', n: 2, people: 2, outcome: 'no_answer', auto: false, suggested: 'contacted' });
  const ben = (await contactsOf(P.ben.id)).filter((c) => /Whalley/.test(c.note || ''));
  assert.deepEqual(ben.map((c) => c.outcome).sort(), ['contacted', 'no_answer']);
  // …and the next one with that result follows the correction.
  await fake.note({ contact: '+16045550102', disposition: 'CALL BACK LATER', campaign: 'Whalley', notes: 'third' });
  assert.equal((await contactsOf(P.ben.id))[0].outcome, 'no_answer');
  // However it is spelt it is one row, and Ben — who has it both ways — is one person.
  [p] = await pushesOf(`bank=${ok(await mgr.get('/api/banks')).banks.find((b) => b.name === 'Whalley calls').id}`);
  assert.deepEqual([p.dispositions[0].n, p.dispositions[0].people], [3, 2]);
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

  // One answer at a time joins what is already said; null takes one away; another question starts afresh.
  ok(await staff.action('callhub.map', { id: p.id, rating: { question: 'can we count on your SUPPORT?', answers: { Probably: '2' } } }));
  const mapOf = async () => (await db.query('select rating_map from callhub_pushes where id = $1', [p.id])).rows[0].rating_map;
  assert.deepEqual((await mapOf()).answers, { 'yes, definitely': '1', 'not sure yet': '3', probably: '2' });
  ok(await staff.action('callhub.map', { id: p.id, rating: { question: 'Can we count on your support?', answers: { Probably: null } } }));
  assert.deepEqual((await mapOf()).answers, { 'yes, definitely': '1', 'not sure yet': '3' });
  ok(await staff.action('callhub.map', { id: p.id, rating: { question: 'Top issue', answers: {} } }));
  assert.deepEqual([(await mapOf()).label, (await mapOf()).answers], ['Top issue', {}]);
  assert.equal((await person(P.ben.id)).rating, null, 'another question: the ratings the first one’s answers gave are taken back');
  assert.equal((await person(P.alex.id)).rating, '2', 'the door’s rating is nobody’s to take');
  ok(await staff.action('callhub.map', { id: p.id, rating: { question: 'Can we count on your support?', answers: { 'Yes, definitely': '1', 'Not sure yet': '3' } } }));
  assert.equal((await person(P.ben.id)).rating, '1', 'and picked again, given again');
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
  assert.match(p.resume_words, /^(?:[A-Z][a-z]{2} \d{1,2}, )?\d{1,2}:\d{2} [ap]m$/);
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
  const sentToday = (await db.query(`select count(*)::int as n from (select distinct push_id, phone from callhub_contacts where sent_at > now() - interval '24 hours') x`)).rows[0].n;
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

test('a number CallHub won’t take is left out and counted, with its words; the rest go on', async () => {
  const people = [];
  for (let i = 0; i < 4; i += 1) people.push((await mgr.createPerson(`Picky${i} Example`, { phone: `604-555-019${i}` })).id);
  const list = ok(await mgr.action('list.create', { name: 'Picky list', kind: 'people', person_ids: people })).list.id;
  fake.reject(['+16045550191']);
  ok(await mgr.action('callhub.push', { list_id: list }));
  await drain();
  const [p] = await pushesOf(`list=${list}`);
  assert.deepEqual([p.status, p.total, p.sent, p.refused, p.note], ['sent', 3, 3, 1, null]);
  assert.equal(p.refused_note, 'contact: Enter a valid phone number.');
  assert.deepEqual(fake.sent(bookOf(p.name).id).map((c) => c.contact), ['+16045550190', '+16045550192', '+16045550193']);
  // Whose it was is kept, so the desk can find and fix it: named on the push, on the log and in the export — never the number.
  assert.deepEqual(p.refused_people, [{ id: people[1], name: 'Picky1 Example' }]);
  const kept = (await db.query('select person_id, sent_at, refused from callhub_contacts where push_id = $1 and refused is not null', [p.id])).rows;
  assert.deepEqual(kept.map((k) => [k.person_id, k.sent_at, k.refused]), [[people[1], null, 'contact: Enter a valid phone number.']]);
  const ev = (await db.query(`select payload from events where workspace_id = $1 and entity_type = 'callhub_contact' and entity_id = $2`, [ws, people[1]])).rows;
  assert.deepEqual(ev.map((e) => e.payload), [{ push_id: p.id, refused: true }]);
  // It never reached CallHub, so a result for it is for a number never sent.
  assert.deepEqual((await fake.note({ contact: '+16045550191', disposition: 'Answered' })).body, { received: true, filed: false });
  fake.reject(false);
});

test('CallHub taking none of them is not the numbers: the push stops with its words, and nothing more is dropped', async () => {
  const people = [];
  for (let i = 0; i < 8; i += 1) people.push((await mgr.createPerson(`None${i} Example`, { phone: `604-555-011${i + 1}` })).id);
  const list = ok(await mgr.action('list.create', { name: 'None list', kind: 'people', person_ids: people })).list.id;
  fake.reject('all');
  const r = ok(await mgr.action('callhub.push', { list_id: list }));
  await drain();
  let [p] = await pushesOf(`list=${list}`);
  assert.deepEqual([p.status, p.sent, p.refused, p.total], ['failed', 0, 4, 4], 'four left out, then it stops: the fifth and the rest are still to go');
  assert.equal(p.note, 'CallHub wouldn’t take 5 numbers in a row. It said “contact: Enter a valid phone number.”');
  fake.reject(false);
  ok(await mgr.action('callhub.resume', { id: r.push.id }));
  await drain();
  [p] = await pushesOf(`list=${list}`);
  assert.deepEqual([p.status, p.sent, p.refused, p.total], ['sent', 4, 4, 4]);
});

test('a saved filter is sent as whoever matches it today', async () => {
  for (const [name, phone, tags] of [['Filter A Example', '604-555-0122', ['callhub-filter']], ['Filter B Example', '604-555-0123', ['callhub-filter', 'do-not-call']], ['Filter C Example', '604-555-0124', []]]) {
    await mgr.createPerson(name, { phone, tags });
  }
  const list = ok(await mgr.action('list.create', { name: 'Filter list', kind: 'filter', filter: { tag: 'callhub-filter' } })).list.id;
  const pre = ok(await staff.get(`/api/callhub/preview?list=${list}`));
  assert.deepEqual([pre.numbers, pre.people, pre.left_out, pre.days], [1, 1, 1, 1]);
  ok(await staff.action('callhub.push', { list_id: list }));
  await drain();
  const [p] = await pushesOf(`list=${list}`);
  assert.deepEqual([p.status, p.sent, p.skipped], ['sent', 1, 1]);
  assert.deepEqual(fake.sent(bookOf(p.name).id).map((c) => c.contact), ['+16045550122']);
});

test('a number still waiting to go has not been sent: a result for it files nothing until it has', async () => {
  const a = await mgr.createPerson('Waiting Example', { phone: '604-555-0125' });
  const list = ok(await mgr.action('list.create', { name: 'Waiting list', kind: 'people', person_ids: [a.id] })).list.id;
  ok(await mgr.action('callhub.push', { list_id: list }));
  assert.deepEqual((await fake.note({ contact: '+16045550125', disposition: 'Answered', notes: 'too early' })).body, { received: true, filed: false });
  await drain();
  assert.deepEqual((await fake.note({ contact: '+16045550125', disposition: 'Answered', notes: 'in time' })).body, { received: true, filed: true });
  assert.deepEqual((await contactsOf(a.id)).map((c) => /in time/.test(c.note)), [true]);
});

test('two records on one number made one while the push waits: the number still goes, once', async () => {
  const first = await mgr.createPerson('Twin Exampl', { phone: '604-555-0126' });
  const kept = await mgr.createPerson('Twin Example', { phone: '(604) 555-0126' });
  const list = ok(await mgr.action('list.create', { name: 'Twin list', kind: 'people', person_ids: [first.id, kept.id] })).list.id;
  ok(await mgr.action('callhub.push', { list_id: list }));
  ok(await mgr.action('person.merge', { keep: kept.id, drop: first.id }));
  await drain();
  const [p] = await pushesOf(`list=${list}`);
  assert.deepEqual([p.status, p.total, p.sent], ['sent', 1, 1]);
  assert.deepEqual(fake.sent(bookOf(p.name).id), [{ contact: '+16045550126', first_name: 'Twin', last_name: 'Example', country_code: 'CA' }]);
  assert.deepEqual((await fake.note({ contact: '+16045550126', disposition: 'Answered', notes: 'one record' })).body, { received: true, filed: true });
  assert.match((await contactsOf(kept.id))[0].note, /one record/);
});

test('a row slipped to “Do not call” and put back: the tag comes off again, and so does CallHub’s entry — never a tag set by hand', async () => {
  const people = [];
  for (let i = 0; i < 3; i += 1) people.push(await mgr.createPerson(`Slip${i} Example`, { phone: `604-555-013${i + 1}` }));
  const list = ok(await mgr.action('list.create', { name: 'Slip list', kind: 'people', person_ids: people.map((p) => p.id) })).list.id;
  const r = ok(await mgr.action('callhub.push', { list_id: list }));
  await drain();
  for (let i = 0; i < 3; i += 1) await fake.note({ contact: `+1604555013${i + 1}`, disposition: 'Answered', campaign: 'Slip', notes: `talked ${i}` });
  // The third rang the office herself afterwards: that tag is the desk's, not the table's.
  ok(await mgr.action('person.update', { id: people[2].id, tags: ['do-not-call'] }));
  await drain();
  const tagged = async () => Promise.all(people.map(async (p) => (await person(p.id)).tags.includes('do-not-call')));
  const atCallHub = () => people.map((_, i) => fake.dnc.some((d) => d.phone_number === `+1604555013${i + 1}`));
  assert.deepEqual(atCallHub(), [false, false, true]);

  // One key on the "Answered" row: every supporter reached becomes do-not-call…
  const slip = ok(await staff.action('callhub.map', { id: r.push.id, outcomes: { Answered: 'do_not_call' } }));
  assert.deepEqual([slip.changed, slip.tagged, slip.untagged], [3, 2, 0]);
  await drain();
  assert.deepEqual(await tagged(), [true, true, true]);
  assert.deepEqual(atCallHub(), [true, true, true]);
  assert.equal(ok(await mgr.get(`/api/callhub/preview?list=${list}`)).numbers, 0);
  // …and putting the row back undoes it: the table takes off what the table put on.
  const back = ok(await staff.action('callhub.map', { id: r.push.id, outcomes: { Answered: null } }));
  assert.deepEqual([back.changed, back.tagged, back.untagged], [3, 0, 2]);
  await drain();
  assert.deepEqual(await tagged(), [false, false, true], 'the tag set by hand stays');
  assert.deepEqual(atCallHub(), [false, false, true], 'CallHub’s do-not-call list follows');
  assert.equal(ok(await mgr.get(`/api/callhub/preview?list=${list}`)).numbers, 2, 'they can be sent again');
  assert.deepEqual((await contactsOf(people[0].id)).map((c) => c.outcome), ['contacted']);
  const bank = ok(await mgr.action('bank.create', { name: 'After the slip', person_ids: people.map((p) => p.id) }));
  assert.equal(ok(await mgr.get(`/api/banks/${bank.bank.id}`)).numbers.length, 2, 'and put in a phone bank');
  // Who was untagged is on the log, by the person who changed the table.
  const ev = (await db.query(`select action, actor_id, payload from events where workspace_id = $1 and entity_id = $2 order by seq desc limit 1`, [ws, people[0].id])).rows[0];
  assert.deepEqual([ev.action, ev.actor_id, ev.payload], ['callhub.map', ids['Sam Example'], { tags: [], source: 'callhub' }]);
});

test('a do-not-call tag taken off by hand stays off when another row of the table is corrected', async () => {
  const a = await mgr.createPerson('Retag A Example', { phone: '604-555-0134' });
  const b = await mgr.createPerson('Retag B Example', { phone: '604-555-0135' });
  const list = ok(await mgr.action('list.create', { name: 'Retag list', kind: 'people', person_ids: [a.id, b.id] })).list.id;
  const r = ok(await mgr.action('callhub.push', { list_id: list }));
  await drain();
  await fake.note({ contact: '+16045550134', disposition: 'Do Not Call', campaign: 'Retag', notes: 'take me off' });
  await fake.note({ contact: '+16045550135', disposition: 'Call back later', campaign: 'Retag', notes: 'later' });
  assert.ok((await person(a.id)).tags.includes('do-not-call'));
  // The caller mis-clicked; she rang back to say so, and the desk took the tag off.
  ok(await mgr.action('person.update', { id: a.id, tags: [] }));
  const m = ok(await staff.action('callhub.map', { id: r.push.id, outcomes: { 'Call back later': 'no_answer' } }));
  assert.deepEqual([m.changed, m.tagged, m.untagged], [1, 0, 0]);
  assert.deepEqual((await person(a.id)).tags, [], 'not tagged again by a change that is not about her');
  // Saying again that the row is a "do not call" one is a decision about her: then she is.
  ok(await staff.action('callhub.map', { id: r.push.id, outcomes: { 'Do Not Call': 'refused' } }));
  assert.deepEqual((await person(a.id)).tags, []);
  const again = ok(await staff.action('callhub.map', { id: r.push.id, outcomes: { 'Do Not Call': null } }));
  assert.equal(again.tagged, 1);
  assert.deepEqual((await person(a.id)).tags, ['do-not-call']);
  ok(await staff.action('callhub.map', { id: r.push.id, outcomes: { 'Call back later': null } }));
  await drain();
});

test('an answer mapped by mistake and put back: the rating it gave is taken back — the door’s rating returns, and whoever had none has none', async () => {
  const a = await mgr.createPerson('Rated Before Example', { phone: '604-555-0136' });
  const b = await mgr.createPerson('Never Rated Example', { phone: '604-555-0137' });
  // Rated at the door a month ago.
  ok(await mgr.action('contact.log', { person_id: a.id, channel: 'door', outcome: 'contacted', rating: '2' }));
  await db.query(`update contacts set created_at = now() - interval '30 days' where person_id = $1`, [a.id]);
  await db.query(`update persons set rated_at = now() - interval '30 days' where id = $1`, [a.id]);
  const list = ok(await mgr.action('list.create', { name: 'Mis-tap list', kind: 'people', person_ids: [a.id, b.id] })).list.id;
  const r = ok(await mgr.action('callhub.push', { list_id: list }));
  await drain();
  const survey = [{ question: 'Will you vote?', answer: 'Would rather not say' }];
  await fake.note({ contact: '+16045550136', disposition: 'Answered', campaign: 'Mis-tap', notes: 'a', surveys: survey });
  await fake.note({ contact: '+16045550137', disposition: 'Answered', campaign: 'Mis-tap', notes: 'b', surveys: survey });
  const ratings = async () => [(await person(a.id)).rating, (await person(b.id)).rating];
  const calls = async () => [...(await contactsOf(a.id)), ...(await contactsOf(b.id))].filter((c) => c.channel === 'phone').map((c) => c.rating);
  const map = async (rating) => ok(await mgr.action('callhub.map', { id: r.push.id, rating }));
  assert.deepEqual(await ratings(), ['2', null]);
  // The answer's select slips to "4".
  const wrong = await map({ question: 'Will you vote?', answers: { 'Would rather not say': '4' } });
  assert.deepEqual([wrong.changed, wrong.rated, wrong.unrated], [2, 2, 0]);
  assert.deepEqual(await ratings(), ['4', '4']);
  // "Doesn't rate" again: as it was.
  const back = await map({ question: 'Will you vote?', answers: { 'Would rather not say': null } });
  assert.deepEqual([back.changed, back.rated, back.unrated], [2, 0, 2]);
  assert.deepEqual(await ratings(), ['2', null], 'the door’s rating is back; whoever had none has none');
  assert.deepEqual(await calls(), [null, null], 'the calls carry no rating');
  assert.equal((await db.query('select count(*)::int as n from persons where id = $1 and rated_at < now() - interval \'29 days\'', [a.id])).rows[0].n, 1, 'and when she was rated is as it was');
  // The same with "None — nobody is rated from a call".
  await map({ question: 'Will you vote?', answers: { 'Would rather not say': '4' } });
  assert.deepEqual(await ratings(), ['4', '4']);
  assert.equal((await map(null)).unrated, 2);
  assert.deepEqual(await ratings(), ['2', null]);
  // …and with another question picked instead.
  await map({ question: 'Will you vote?', answers: { 'Would rather not say': '4' } });
  await map({ question: 'Top issue', answers: {} });
  assert.deepEqual(await ratings(), ['2', null]);
  // Someone rated at the door since the call keeps that, whatever the table does.
  await map({ question: 'Will you vote?', answers: { 'Would rather not say': '4' } });
  ok(await mgr.action('contact.log', { person_id: b.id, channel: 'door', outcome: 'contacted', rating: '1' }));
  await map({ question: 'Will you vote?', answers: { 'Would rather not say': '3' } });
  assert.deepEqual(await ratings(), ['3', '1']);
  await map(null);
  assert.deepEqual(await ratings(), ['2', '1']);
  // Two calls, the answers mapped newest first, then the newest unmapped: the older call's answer is what rates her.
  const c = await mgr.createPerson('Two Calls Example', { phone: '604-555-0129' });
  const list2 = ok(await mgr.action('list.create', { name: 'Two calls list', kind: 'people', person_ids: [c.id] })).list.id;
  const r2 = ok(await mgr.action('callhub.push', { list_id: list2 }));
  await drain();
  await fake.note({ contact: '+16045550129', disposition: 'Answered', campaign: 'Two', notes: 'first', surveys: [{ question: 'Will you vote?', answer: 'Yes' }] });
  await db.query(`update contacts set created_at = created_at - interval '1 hour' where person_id = $1`, [c.id]);
  await fake.note({ contact: '+16045550129', disposition: 'Answered', campaign: 'Two', notes: 'second', surveys: [{ question: 'Will you vote?', answer: 'Maybe' }] });
  const map2 = async (rating) => ok(await mgr.action('callhub.map', { id: r2.push.id, rating }));
  await map2({ question: 'Will you vote?', answers: { Maybe: '3' } });
  await map2({ question: 'Will you vote?', answers: { Yes: '1' } });
  assert.equal((await person(c.id)).rating, '3', 'the newer call’s answer');
  await map2({ question: 'Will you vote?', answers: { Maybe: null } });
  assert.equal((await person(c.id)).rating, '1', 'the older call’s answer, still mapped');
  await map2(null);
  assert.equal((await person(c.id)).rating, null);
});

test('a correction moves the phone bank’s number too: a “Talked” that was a No answer comes back, by the bank’s own rule', async () => {
  const a = await mgr.createPerson('Bank Fix Example', { phone: '604-555-0127' });
  const bank = ok(await mgr.action('bank.create', { name: 'Fix bank', person_ids: [a.id], retry_hours: 4, max_tries: 3 }));
  const r = ok(await mgr.action('callhub.push', { bank_id: bank.bank.id }));
  await drain();
  await fake.note({ contact: '+16045550127', disposition: 'Rang out', campaign: 'Fix', notes: 'nobody picked up' });
  const number = async () => ok(await mgr.get(`/api/banks/${bank.bank.id}`)).numbers.find((n) => n.person_id === a.id);
  let n = await number();
  assert.deepEqual([Boolean(n.done_at), n.outcome, n.tries], [true, 'contacted', 1], 'by pattern a conversation: crossed off');
  ok(await staff.action('callhub.map', { id: r.push.id, outcomes: { 'Rang out': 'no_answer' } }));
  n = await number();
  assert.deepEqual([n.done_at, n.outcome, n.tries], [null, null, 1], 'back on the list');
  assert.ok(new Date(n.next_at) > new Date(Date.now() + 3 * 3600_000), 'after the bank’s four hours');
  assert.equal((await contactsOf(a.id))[0].outcome, 'no_answer');
  // …and the other way: it was a refusal after all.
  ok(await staff.action('callhub.map', { id: r.push.id, outcomes: { 'Rang out': 'refused' } }));
  n = await number();
  assert.deepEqual([Boolean(n.done_at), n.outcome, n.tries], [true, 'refused', 1]);
  ok(await staff.action('callhub.map', { id: r.push.id, outcomes: { 'Rang out': null } }));
  assert.equal((await number()).outcome, 'contacted');
});

test('the number is looked for under contact, then under mobile', async () => {
  const a = await mgr.createPerson('Mobile Example', { phone: '604-555-0128' });
  const list = ok(await mgr.action('list.create', { name: 'Mobile list', kind: 'people', person_ids: [a.id] })).list.id;
  ok(await mgr.action('callhub.push', { list_id: list }));
  await drain();
  // CallHub's contact has another line under `contact`; the one base.win sent is its `mobile`.
  const res = await fake.note({ contact: '+16045550198', mobile: '+16045550128', disposition: 'Answered', campaign: 'Mobile', notes: 'via mobile' });
  assert.deepEqual(res.body, { received: true, filed: true });
  assert.match((await contactsOf(a.id))[0].note, /via mobile/);
});

test('a do-not-call number CallHub won’t take is remembered and said, with whose it is — it never stops a push', async () => {
  const odd = await mgr.createPerson('Odd Number Example', { phone: '604-555-0138', tags: ['do-not-contact'] });
  const quiet = await mgr.createPerson('Quiet Example', { phone: '604-555-0139', tags: ['do-not-call'] });
  const people = [];
  for (let i = 0; i < 3; i += 1) people.push((await mgr.createPerson(`Go${i} Example`, { phone: `604-555-014${i + 1}` })).id);
  const list = ok(await mgr.action('list.create', { name: 'Go list', kind: 'people', person_ids: people })).list.id;
  const tries = () => fake.calls.filter((c) => c.path === '/v1/dnc_contacts/' && c.params.phone_number === '+16045550138').length;
  fake.rejectDnc(['+16045550138']);
  try {
    await drain(); // someone newly marked: the job tries it, and CallHub refuses
    assert.equal(tries(), 1);
    assert.ok(fake.dnc.some((d) => d.phone_number === '+16045550139'), 'the number behind it is told all the same');
    ok(await mgr.action('callhub.push', { list_id: list }));
    await drain();
    let seen = ok(await staff.get(`/api/callhub/pushes?list=${list}`));
    assert.deepEqual([seen.pushes[0].status, seen.pushes[0].sent, seen.pushes[0].note], ['sent', 3, null], 'the push goes');
    assert.equal(tries(), 2, 'tried once more with the push');
    assert.deepEqual(seen.not_taken, { n: 1, note: 'phone_number: Enter a valid phone number.', people: [{ id: odd.id, name: 'Odd Number Example' }] });
    // Not tried again each time someone else is marked.
    ok(await mgr.action('person.update', { id: quiet.id, tags: ['do-not-call', 'newton'] }));
    await mgr.createPerson('Late Quiet Example', { phone: '604-555-0144', tags: ['do-not-call'] });
    await drain();
    assert.equal(tries(), 2);
    assert.ok(fake.dnc.some((d) => d.phone_number === '+16045550144'));
    assert.equal((await db.query(`select count(*)::int as n from jobs where workspace_id = $1 and kind = 'callhub.dnc' and status = 'failed'`, [ws])).rows[0].n, 0, 'no job gave up over it');
    // Once CallHub takes it (with the next push), the line goes.
    fake.rejectDnc(false);
    ok(await mgr.action('callhub.push', { list_id: list }));
    await drain();
    seen = ok(await staff.get(`/api/callhub/pushes?list=${list}`));
    assert.equal(seen.not_taken, null);
    assert.ok(fake.dnc.some((d) => d.phone_number === '+16045550138' && d.category === 3));

    // CallHub taking none of them is not the numbers: the push stops with its words, nothing is written off, and Carry on tells them all.
    for (let i = 0; i < 6; i += 1) await db.query(`insert into texting_optouts (id, workspace_id, phone, opted_out, keyword) values (gen_random_uuid(), $1, $2, true, 'STOP')`, [ws, `+1778555010${i}`]);
    fake.rejectDnc('all');
    const r = ok(await mgr.action('callhub.push', { list_id: list }));
    await drain();
    let [p] = await pushesOf(`list=${list}`);
    assert.deepEqual([p.status, p.sent], ['failed', 0]);
    assert.equal(p.note, 'CallHub wouldn’t take 5 do-not-call numbers in a row. It said “phone_number: Enter a valid phone number.”');
    assert.equal((await db.query('select count(*)::int as n from callhub_dnc where workspace_id = $1 and refused is not null', [ws])).rows[0].n, 0);
    fake.rejectDnc(false);
    ok(await mgr.action('callhub.resume', { id: r.push.id }));
    await drain();
    [p] = await pushesOf(`list=${list}`);
    assert.deepEqual([p.status, p.sent], ['sent', 3]);
    assert.equal(fake.dnc.filter((d) => d.phone_number.startsWith('+1778555010')).length, 6);
  } finally {
    fake.rejectDnc(false);
  }
});

test('a number CallHub won’t let go, or never named, stays on its list: nothing stops, and Check says how many', async () => {
  const a = await mgr.createPerson('Held A Example', { phone: '604-555-0146', tags: ['do-not-call'] });
  const b = await mgr.createPerson('Held B Example', { phone: '604-555-0147', tags: ['do-not-call'] });
  await drain();
  assert.equal(fake.dnc.filter((d) => ['+16045550146', '+16045550147'].includes(d.phone_number)).length, 2);
  const check = async () => ok(await mgr.post('/api/connections/check', { key: 'callhub' })).said;
  assert.doesNotMatch(await check(), /nobody here blocks/);
  // CallHub never said which entry the first one was; and it refuses to delete the second.
  await db.query(`update callhub_dnc set entry = null where workspace_id = $1 and phone = '+16045550146'`, [ws]);
  const realFetch = globalThis.fetch;
  let deletes = 0;
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'DELETE' && String(url).includes('/dnc_contacts/')) {
      deletes += 1;
      return new Response(JSON.stringify({ detail: 'Method "DELETE" not allowed.' }), { status: 405, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(url, init);
  };
  try {
    ok(await mgr.action('person.update', { id: a.id, tags: [] }));
    ok(await mgr.action('person.update', { id: b.id, tags: [] }));
    await drain();
    assert.equal(deletes, 1, 'asked once for the one CallHub named');
    assert.match(await check(), / · CallHub’s do-not-call list still has 2 numbers nobody here blocks now — take them off in CallHub$/);
    // Not asked again each time someone's tags change; no job gave up; a push still goes.
    ok(await mgr.action('person.update', { id: b.id, tags: ['newton'] }));
    await drain();
    assert.equal(deletes, 1);
    assert.equal((await db.query(`select count(*)::int as n from jobs where workspace_id = $1 and kind = 'callhub.dnc' and status in ('failed', 'pending')`, [ws])).rows[0].n, 0);
    const list = ok(await mgr.action('list.create', { name: 'Held list', kind: 'people', person_ids: [a.id, b.id] })).list.id;
    ok(await mgr.action('callhub.push', { list_id: list }));
    await drain();
    const [p] = await pushesOf(`list=${list}`);
    assert.deepEqual([p.status, p.sent, p.note], ['sent', 2, null]);
    assert.equal(deletes, 2, 'once more with the push');
  } finally {
    globalThis.fetch = realFetch;
  }
  // Once CallHub lets it go (the next push asks again), one is left: the one it never named.
  const again = ok(await mgr.action('list.create', { name: 'Held list 2', kind: 'people', person_ids: [a.id] })).list.id;
  ok(await mgr.action('callhub.push', { list_id: again }));
  await drain();
  assert.ok(!fake.dnc.some((d) => d.phone_number === '+16045550147'));
  assert.match(await check(), / · CallHub’s do-not-call list still has 1 number nobody here blocks now — take it off in CallHub$/);
  // (Tidy: the stand-in still has it; base.win's record of it goes so later counts are their own.)
  await db.query(`delete from callhub_dnc where workspace_id = $1 and phone = '+16045550146'`, [ws]);
});

test('with many numbers not to call the push says what it is doing first, instead of “0 of N” with no words', async () => {
  const a = await mgr.createPerson('Patient Example', { phone: '604-555-0145' });
  const list = ok(await mgr.action('list.create', { name: 'Patient list', kind: 'people', person_ids: [a.id] })).list.id;
  const rows = Array.from({ length: 55 }, (_, i) => `+1236555${String(100 + i).padStart(4, '0')}`);
  await db.query(
    `insert into texting_optouts (id, workspace_id, phone, opted_out, keyword) select gen_random_uuid(), $1, x, true, 'STOP' from unnest($2::text[]) as x`, [ws, rows],
  );
  await drain();
  ok(await mgr.action('callhub.push', { list_id: list }));
  await runDueJobs(db, { workspaceId: ws, limit: 1 }); // one run: fifty of the fifty-five
  let [p] = await pushesOf(`list=${list}`);
  assert.deepEqual([p.status, p.sent, p.total], ['sending', 0, 1]);
  assert.equal(p.note, 'Telling CallHub who not to call first · 55 to go');
  await drain();
  [p] = await pushesOf(`list=${list}`);
  assert.deepEqual([p.status, p.sent, p.note], ['sent', 1, null]);
  assert.equal(fake.dnc.filter((d) => d.phone_number.startsWith('+12365550')).length, 55);
});

test('a change to a big push’s table moves a first part at once and the rest by itself', async () => {
  const people = [];
  for (let i = 0; i < 5; i += 1) people.push((await mgr.createPerson(`Many${i} Example`, { phone: `604-555-016${i + 5}` })).id);
  const list = ok(await mgr.action('list.create', { name: 'Many list', kind: 'people', person_ids: people })).list.id;
  const r = ok(await mgr.action('callhub.push', { list_id: list }));
  await drain();
  for (let i = 0; i < 5; i += 1) await fake.note({ contact: `+1604555016${i + 5}`, disposition: 'Spoke briefly', campaign: 'Many', notes: `n${i}` });
  const { _setRefileBatchForTest } = await import('../ext/callhub/results.js');
  _setRefileBatchForTest(2);
  try {
    const m = ok(await staff.action('callhub.map', { id: r.push.id, outcomes: { 'Spoke briefly': 'no_answer' } }));
    assert.deepEqual([m.changed, m.more], [2, true], 'the campaign’s other writes are not kept waiting behind thousands of results');
    const outcomes = async () => (await db.query(`select c.outcome from contacts c where c.workspace_id = $1 and c.person_id = any($2::uuid[]) order by c.outcome`, [ws, people])).rows.map((x) => x.outcome);
    assert.deepEqual(await outcomes(), ['contacted', 'contacted', 'contacted', 'no_answer', 'no_answer']);
    assert.equal((await pushesOf(`list=${list}`))[0].moving, true);
    await drain();
    assert.deepEqual(await outcomes(), Array(5).fill('no_answer'));
    assert.equal((await pushesOf(`list=${list}`))[0].moving, false);
    const by = (await db.query(`select distinct action, actor_id from events where workspace_id = $1 and entity_type = 'contact' and op = 'update' and entity_id in (select id from contacts where person_id = any($2::uuid[]))`, [ws, people])).rows;
    assert.deepEqual(by, [{ action: 'callhub.map', actor_id: ids['Sam Example'] }], 'all of it as the person who changed the table');
  } finally {
    _setRefileBatchForTest(500);
  }
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
  assert.deepEqual(actions, ['callhub.connect', 'callhub.dnc', 'callhub.map', 'callhub.push', 'callhub.result', 'callhub.resume']);
  assert.ok(rows.filter((r) => r.action === 'callhub.result' || r.action === 'callhub.dnc').every((r) => r.actor_id === null), 'results and newly marked numbers are the system’s');
  assert.ok(rows.filter((r) => r.action === 'callhub.push').every((r) => r.actor_id), 'a push is the sender’s');
  assert.equal((await verifyChain(db, ws)).ok, true);
  // Every write this file made at CallHub carried a key to know a repeat by, and the API key.
  const writes = fake.calls.filter((c) => c.method === 'POST');
  assert.ok(writes.length > 50 && writes.every((c) => c.idem), 'an idempotency key on every write');
  assert.equal(new Set(writes.filter((c) => /upsert_contact/.test(c.path) && c.status < 300).map((c) => c.idem)).size, writes.filter((c) => /upsert_contact/.test(c.path) && c.status < 300).length, 'one key per contact');
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
  assert.equal(json({ contact: '8', disposition: 'Busy', data: { custom: 'x' } }).fields.contact, '8', 'a data that is something else');
  assert.equal(readDelivery(Buffer.from('contact=4&agent%5Bemail%5D=b%40example.org&surveys=%5B%5D'), 'application/x-www-form-urlencoded').fields.agent.email, 'b@example.org', 'bracket keys');
  // A form with everything under data[…], nested as deep as it likes.
  const form = new URLSearchParams({ event: 'cc.notes', 'data[contact]': '6', 'data[disposition]': 'Busy', 'data[agent][email]': 'C@Example.org',
    'data[surveys][0][question]': 'H?', 'data[surveys][0][answer]': 'u', 'data[surveys][1][question]': 'I?', 'data[surveys][1][answer]': 't' }).toString();
  const deep = readDelivery(Buffer.from(form), 'application/x-www-form-urlencoded').fields;
  assert.deepEqual([deep.contact, deep.disposition, deep.agent.email, surveyPairs(deep.surveys)], ['6', 'Busy', 'c@example.org', [['H?', 'u'], ['I?', 't']]]);
  // A key that reaches for an object's own workings is left out, and touches nothing.
  const sly = json({ contact: '7', '__proto__.polluted': 'yes', 'agent[constructor][prototype][polluted]': 'yes', 'a.__proto__.polluted': 'yes' });
  assert.equal(sly.fields.contact, '7');
  assert.equal({}.polluted, undefined);
  assert.equal(readDelivery(Buffer.from('{"contact":"5"}'), '').fields.contact, '5', 'JSON with no type said');
  assert.equal(readDelivery(Buffer.from('not json'), 'application/json'), null);
  assert.equal(readDelivery(Buffer.from('[1,2]'), 'application/json'), null);
  assert.deepEqual(surveyPairs([{ question: 'A?', answer: 'x' }, { 'B?': 'y' }, ['C?', 'z'], { key: 'D?', value: ['p', 'q'] }]), [['A?', 'x'], ['B?', 'y'], ['C?', 'z'], ['D?', 'p, q']]);
  assert.deepEqual(surveyPairs({ 'E?': 'w', 'F?': '' }), [['E?', 'w']]);
  assert.deepEqual(surveyPairs('[{"question":"G?","response":"v"}]'), [['G?', 'v']]);
  assert.deepEqual(surveyPairs(null), []);

  const keep = { k: process.env.CALLHUB_API_KEY, b: process.env.CALLHUB_API_BASE };
  // A list's next page is followed on the API's own host, at the address set here — never anywhere else.
  const { listAll } = await import('../ext/callhub/callhub.js');
  const realFetch = globalThis.fetch;
  const asked = [];
  const pages = (next) => { globalThis.fetch = async (url, init) => { asked.push([String(url), init.headers.Authorization]); return new Response(JSON.stringify(asked.length === 1 ? { results: [1], next } : { results: [2], next: null }), { status: 200 }); }; };
  try {
    process.env.CALLHUB_API_KEY = 'page-key';
    delete process.env.CALLHUB_API_BASE;
    pages('http://api.callhub.io/v1/webhooks/?page=2');
    assert.deepEqual(await listAll('/webhooks/'), [1, 2]);
    assert.deepEqual(asked, [['https://api.callhub.io/v1/webhooks/', 'Token page-key'], ['https://api.callhub.io/v1/webhooks/?page=2', 'Token page-key']], 'an http:// next still goes out as https');
    asked.length = 0;
    pages('https://elsewhere.example.org/v1/webhooks/?page=2');
    await assert.rejects(listAll('/webhooks/'), /another address/);
    assert.equal(asked.length, 1, 'the key never goes to another host');
  } finally {
    globalThis.fetch = realFetch;
  }
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
