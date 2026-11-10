// A ladder's "Send to a web address" step: when someone reaches it, one
// small JSON message goes to the address the desk typed (a stand-in here:
// fake-receiver.js at LADDER_WEBHOOK_API_BASE), signed `t=…,v1=…` with the
// campaign's own secret over the exact bytes sent. It carries who they are
// and what started the ladder — their email or mobile only when a ladder
// email or text could reach them, never a money tag, a rating or a note —
// and nothing at all for someone marked do-not-contact. The address must be
// https and must not point inside a private network: refused when the step
// is saved and again, after looking the name up, each time it sends. A try
// that fails is tried again after a minute, then after five more, then
// logged as failed and the run moves on; a failure after the send never
// sends it twice. Only the desk can make the step or see the secret.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { runDueJobs, enqueueJob } from '../lib/jobs.js';
import { onHook } from '../lib/hooks.js';
import { verifySignature, signPayload } from '../lib/signature.js';
import { startFakeReceiver } from './fake-receiver.js';
import {
  addressProblem, cleanAddress, isPublicAddress, lookupProblem, postHook, signingSecret, hookBody, _setResolverForTest,
  notAnswering, _setTimeoutForTest, _silentForTest,
} from '../ext/ladders/webhook.js';

const tag = Math.random().toString(36).slice(2, 8);
const mail = (who) => `${who}.hook.${tag}@example.org`;
let db, mgr, ws, wsName, hooks;

const ok = (r) => { assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.json)); return r.json; };
const runJobs = async () => {
  let total = 0;
  for (let i = 0; i < 30; i += 1) {
    const r = await runDueJobs(db, { workspaceId: ws });
    total += r.ran + r.failed;
    if (r.ran + r.failed === 0) break;
  }
  return total;
};
const fastForward = () => db.query(
  "update jobs set run_at = now() - interval '1 second' where workspace_id = $1 and status = 'pending' and kind = 'ladder.step'", [ws],
);
const create = async (input) => ok(await mgr.action('ladder.create', input)).ladder;
const turnOn = async (id) => ok(await mgr.action('ladder.setActive', { id, active: true }));
// A ladder that starts on a tag, sends to the address, then tags (so a test
// can see the run went on past the step).
const hookLadder = async (ref, { url = `https://hooks.example.org/catch/${ref}`, label = 'Zapier', name = `Tell ${ref}` } = {}) => {
  const l = await create({
    name, trigger: { kind: 'tag', ref },
    steps: [{ kind: 'webhook', url, label }, { kind: 'tag', tag: `after-${ref}` }],
  });
  await turnOn(l.id);
  return l;
};
const off = (l) => mgr.action('ladder.setActive', { id: l.id, active: false });
const runOf = async (ladderId, personId) => ok(await mgr.get(`/api/ladders/${ladderId}`)).people.find((p) => p.person.id === personId);
const rowOf = async (ladderId, personId) => (await db.query(
  'select * from ladder_runs where workspace_id = $1 and ladder_id = $2 and person_id = $3', [ws, ladderId, personId],
)).rows[0];
const hookLog = (run) => run.log.filter((e) => e.kind === 'webhook');
const tagsOf = async (id) => (await db.query('select tags from persons where id = $1', [id])).rows[0].tags;
const got = (ref) => hooks.received.filter((r) => r.path.startsWith(`/catch/${ref}`));
const verified = async () => {
  const v = await mgr.get('/api/audit/verify');
  assert.equal(v.json.ok, true, JSON.stringify(v.json));
};
const waitFor = async (fn, ms = 4000) => {
  for (const t0 = Date.now(); ;) {
    const v = await fn();
    if (v) return v;
    assert.ok(Date.now() - t0 < ms, 'waited too long');
    await new Promise((r) => { setTimeout(r, 10); });
  }
};

// No name is ever looked up for real: what each resolves to is said here.
const names = new Map();
const PUBLIC = [{ address: '93.184.215.14', family: 4 }];
const notFound = (host) => Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
const resolver = async (host) => {
  const a = names.get(host);
  if (!a) throw notFound(host);
  if (a instanceof Error) throw a;
  return a;
};
// Without the stand-in, as on a real server: names are looked up (above).
const forReal = async (fn) => {
  const base = process.env.LADDER_WEBHOOK_API_BASE;
  delete process.env.LADDER_WEBHOOK_API_BASE;
  try { return await fn(); } finally { process.env.LADDER_WEBHOOK_API_BASE = base; }
};

before(async () => {
  db = await freshDb();
  delete process.env.RESEND_API_KEY;
  hooks = await startFakeReceiver();
  process.env.LADDER_WEBHOOK_API_BASE = hooks.url;
  _setResolverForTest(resolver);
  mgr = new Client();
  wsName = `Hooks ${tag}`;
  ws = ok(await mgr.signup({ name: 'Lou Example', workspaceName: wsName, email: mail('lou'), jurisdiction: 'bc-municipal' })).workspace.id;
});
after(async () => {
  delete process.env.LADDER_WEBHOOK_API_BASE;
  _setResolverForTest(null);
  await hooks.close();
});

test('the signature is the one base.win checks for Stripe, now shared (lib/signature.js)', () => {
  const body = '{"event":"newsletter"}';
  const t = Math.floor(Date.now() / 1000);
  const header = signPayload(body, 'sbw_test', t);
  assert.match(header, new RegExp(`^t=${t},v1=[0-9a-f]{64}$`));
  assert.equal(verifySignature(body, header, ['sbw_test']).ok, true);
  assert.equal(verifySignature(Buffer.from(body), header, ['sbw_test']).ok, true, 'the raw bytes');
  assert.equal(verifySignature(`${body} `, header, ['sbw_test']).ok, false, 'one byte more');
  assert.equal(verifySignature(body, header, ['sbw_other']).why, 'signature doesn’t match');
  assert.equal(verifySignature(body, signPayload(body, 'sbw_test', t - 301), ['sbw_test']).ok, false, 'older than five minutes');
  assert.equal(verifySignature(body, header, []).ok, false, 'no secret, no pass');
});

test('reaching the step sends one signed message; the run’s log says "sent" with the answer', async () => {
  const lad = await hookLadder('signed', { url: 'https://hooks.example.org/catch/signed?source=base', name: 'Tell Zapier' });
  ok(await mgr.action('subscription.add', { email: mail('asha') }));
  const asha = await mgr.createPerson('Asha Example', {
    email: mail('asha'), phone: '604-555-0142', postal: 'V3T 1V8', tags: ['signed', 'union', 'donor-prospect'],
  });
  await runJobs();

  const sent = got('signed');
  assert.equal(sent.length, 1, 'one message');
  const m = sent[0];
  assert.equal(m.method, 'POST');
  assert.equal(m.path, '/catch/signed?source=base', 'the address as typed, its path and query kept');
  assert.equal(m.headers['content-type'], 'application/json');
  assert.equal(m.headers['user-agent'], 'base.win');
  const row = await rowOf(lad.id, asha.id);
  assert.equal(m.headers['idempotency-key'], `ladder-${row.id}-0`, 'keyed by the run and the step');

  // Signed with the campaign's secret over the exact bytes received.
  const secret = ok(await mgr.action('ladder.signingSecret', {})).secret;
  assert.match(secret, /^sbw_[0-9a-f]{64}$/);
  assert.equal(secret, await signingSecret(ws), 'the same secret every time: derived, not stored');
  assert.match(m.headers['base-signature'], /^t=\d{10},v1=[0-9a-f]{64}$/);
  assert.equal(verifySignature(m.raw, m.headers['base-signature'], [secret]).ok, true, 'the signature verifies');
  assert.equal(verifySignature(m.raw.replace('Asha', 'Asha2'), m.headers['base-signature'], [secret]).ok, false, 'a changed body does not');
  assert.equal(verifySignature(m.raw, m.headers['base-signature'], [await signingSecret('99999999-9999-4999-8999-999999999999')]).ok, false,
    'another campaign’s secret does not');

  // What is sent, and nothing else.
  assert.deepEqual(Object.keys(m.body), ['id', 'event', 'ladder', 'step', 'at', 'campaign', 'text', 'person']);
  assert.deepEqual(Object.keys(m.body.person), ['id', 'first_name', 'last_name', 'email', 'phone', 'postal', 'tags']);
  assert.ok(Math.abs(new Date(m.body.at) - Date.now()) < 60_000 && m.body.at.endsWith('Z'), m.body.at);
  assert.deepEqual({ ...m.body, at: null }, {
    id: `ladder-${row.id}-0`,
    event: 'tag',
    ladder: 'Tell Zapier',
    step: 'Zapier',
    at: null,
    campaign: wsName,
    text: 'Tell Zapier: Asha Example — Got a tag · signed',
    person: {
      id: asha.id, first_name: 'Asha', last_name: 'Example',
      email: mail('asha'), phone: '+16045550142', postal: 'V3T 1V8',
      tags: ['signed', 'union'], // never a tag that gives money away
    },
  });

  // The run: "Sent · 200", then on to the next step.
  const run = await runOf(lad.id, asha.id);
  assert.equal(run.status, 'done');
  assert.deepEqual(hookLog(run).map((e) => [e.result, e.status, e.label]), [['sent', 200, 'Zapier']]);
  assert.ok((await tagsOf(asha.id)).includes('after-signed'), 'the next step ran');

  // On the chain as the system; the log never holds the address, the secret or what was sent.
  const evs = ok(await mgr.get('/api/events?since=0&limit=1000')).events.filter((e) => e.action === 'ladder.step' && e.entity_id === row.id);
  assert.ok(evs.length >= 2 && evs.every((e) => e.actor_id === null));
  assert.ok(evs.some((e) => e.payload.kind === 'webhook' && e.payload.result === 'sent' && e.payload.status === 200));
  const kept = JSON.stringify([evs, (await rowOf(lad.id, asha.id)).log]);
  for (const never of ['hooks.example.org', '/catch/signed', secret, mail('asha'), '+16045550142']) {
    assert.ok(!kept.includes(never), `${never} is not kept on the run`);
  }
  // The ladder's own writes are on the log too (the step made, then its
  // label changed): there the address is only where it goes. The rest of it
  // can be a key, and the log is kept, and exported, for good.
  const saved = ok(await mgr.action('ladder.update', { id: lad.id, steps: [{ ...lad.steps[0], label: 'Zapier 2' }, lad.steps[1]] })).ladder;
  assert.equal(saved.steps[0].url, 'https://hooks.example.org/catch/signed?source=base', 'the desk is answered the whole address');
  const writes = ok(await mgr.get('/api/events?since=0&limit=1000')).events.filter((e) => e.entity_type === 'ladder' && e.entity_id === lad.id && e.payload.steps);
  assert.deepEqual(writes.map((e) => [e.op, e.payload.steps[0]]), [
    ['create', { kind: 'webhook', url: 'https://hooks.example.org/…', label: 'Zapier' }],
    ['update', { kind: 'webhook', url: 'https://hooks.example.org/…', label: 'Zapier 2' }],
  ]);
  const everything = JSON.stringify([ok(await mgr.get('/api/events?since=0&limit=1000')).events, ok(await mgr.get('/api/export')).events]);
  assert.ok(!everything.includes('/catch/signed') && !everything.includes('source=base'), 'nowhere on the log, nor in its export');
  await off(lad);
  await verified();
});

test('consent: an email or a mobile only where a ladder email or text could go; nothing for do-not-contact', async () => {
  const lad = await hookLadder('consent');
  // Bo left the newsletter; Cam never asked for email; Di is do-not-email.
  const bo = await mgr.createPerson('Bo Example', { email: mail('bo'), phone: '604-555-0143' });
  const sub = ok(await mgr.action('subscription.add', { email: mail('bo') }));
  ok(await mgr.action('subscription.remove', { id: sub.id }));
  const cam = await mgr.createPerson('Cam Example', { email: mail('cam') });
  ok(await mgr.action('subscription.add', { email: mail('di') }));
  const di = await mgr.createPerson('Di Example', { email: mail('di'), tags: ['do-not-email'] });
  // Eve replied STOP; Flo is do-not-text; Gus's number can't be texted.
  ok(await mgr.action('subscription.add', { email: mail('eve') }));
  const eve = await mgr.createPerson('Eve Example', { email: mail('eve'), phone: '604-555-0144' });
  await db.query("insert into texting_optouts (id, workspace_id, phone, opted_out, keyword) values (gen_random_uuid(), $1, '+16045550144', true, 'STOP')", [ws]);
  const flo = await mgr.createPerson('Flo Example', { phone: '604-555-0145', tags: ['do-not-text'] });
  const gus = await mgr.createPerson('Gus Example', { phone: '555-0146' });
  // Hal is being texted by a teammate right now: a matter of timing, not of consent.
  const hal = await mgr.createPerson('Hal Example', { phone: '604-555-0147' });
  const me = ok(await mgr.get('/api/auth/me')).user.id;
  await db.query(
    "insert into texting_conversations (id, workspace_id, person_id, phone, started_by, last_at) values (gen_random_uuid(), $1, $2, '+16045550147', $3, now())",
    [ws, hal.id, me],
  );
  // Ida asked not to be contacted at all.
  ok(await mgr.action('subscription.add', { email: mail('ida') }));
  const ida = await mgr.createPerson('Ida Example', { email: mail('ida'), phone: '604-555-0148', tags: ['do-not-contact'] });

  for (const p of [bo, cam, di, eve, flo, gus, hal, ida]) {
    ok(await mgr.action('person.update', { id: p.id, tags: [...(await tagsOf(p.id)), 'consent'] }));
  }
  await runJobs();
  const by = Object.fromEntries(got('consent').map((r) => [r.body.person.id, r]));
  const reach = (p) => [by[p.id].body.person.email, by[p.id].body.person.phone];
  assert.deepEqual(reach(bo), [null, '+16045550143'], 'unsubscribed: no email');
  assert.ok(!by[bo.id].raw.includes(mail('bo')), 'his address is nowhere in what was sent');
  assert.deepEqual(reach(cam), [null, null], 'never said yes to email, no phone');
  assert.deepEqual(reach(di), [null, null], 'do-not-email');
  assert.deepEqual(reach(eve), [mail('eve'), null], 'replied STOP: no mobile');
  assert.ok(!by[eve.id].raw.includes('5550144'));
  assert.deepEqual(reach(flo), [null, null], 'do-not-text');
  assert.deepEqual(reach(gus), [null, null], 'a number that can’t be texted');
  assert.deepEqual(reach(hal), [null, '+16045550147'], 'a teammate texting them is not a no');
  assert.equal(by[ida.id], undefined, 'do-not-contact: nothing is sent about them');
  assert.equal(got('consent').length, 7);
  const idaRun = await runOf(lad.id, ida.id);
  assert.deepEqual(hookLog(idaRun).map((e) => [e.result, e.reason]), [['skipped', 'do_not_contact']]);
  assert.equal(idaRun.status, 'done');
  assert.ok((await tagsOf(ida.id)).includes('after-consent'), 'the rest of the ladder still ran');
  await off(lad);
  await verified();
});

test('an address that isn’t https, carries a password or points inside a private network is refused when saved', async () => {
  const lad = await create({ name: 'Refusals', trigger: { kind: 'tag', ref: 'refuse' }, steps: [{ kind: 'tag', tag: 'x' }] });
  const save = (url, label = 'Tool') => mgr.action('ladder.update', { id: lad.id, steps: [{ kind: 'webhook', url, label }] });
  const refused = async (url, words) => {
    const r = await save(url);
    assert.equal(r.status, 400, `${url} → ${JSON.stringify(r.json)}`);
    assert.equal(r.json.error, words, url);
  };
  const PRIVATE = 'That address points inside a private network — it can’t be used';
  await refused('http://hooks.example.org/catch/1', 'The address must start with https://');
  await refused('hooks.example.org/catch/1', 'The address must start with https://');
  await refused('https://', 'That isn’t a web address');
  await refused('https://exa mple.org/x', 'That isn’t a web address');
  await refused('https://intranet/hook', 'That isn’t a web address');
  await refused('https://sam:pw@hooks.example.org/x', 'Leave the name and password out of the address');
  for (const url of [
    'https://localhost/x', 'https://app.localhost/x', 'https://127.0.0.1/x', 'https://127.1/x', 'https://0x7f000001/x',
    'https://10.1.2.3/x', 'https://172.16.0.9/x', 'https://192.168.1.10/x', 'https://169.254.169.254/latest/meta-data/',
    'https://100.64.0.1/x', 'https://0.0.0.0/x', 'https://[::1]/x', 'https://[fe80::1]/x', 'https://[fd00::1]/x',
    'https://[::ffff:10.0.0.1]/x',
  ]) await refused(url, PRIVATE);
  assert.equal((await save('https://hooks.example.org/x', '')).status, 400, 'a label is needed');

  // After looking the name up (no stand-in: as on a real server).
  names.set('inside.example.org', [{ address: '10.1.2.3', family: 4 }]);
  names.set('mixed.example.org', [...PUBLIC, { address: '192.168.0.4', family: 4 }]);
  names.set('six.example.org', [{ address: 'fd12:3456::1', family: 6 }]);
  names.set('busy.example.org', Object.assign(new Error('getaddrinfo EAI_AGAIN'), { code: 'EAI_AGAIN' }));
  names.set('fine.example.org', PUBLIC);
  await forReal(async () => {
    await refused('https://inside.example.org/hook', PRIVATE);
    await refused('https://mixed.example.org/hook', PRIVATE);
    await refused('https://six.example.org/hook', PRIVATE);
    await refused('https://nowhere.example.org/hook', 'We couldn’t find nowhere.example.org — check the address');
    assert.equal((await mgr.get(`/api/ladders/${lad.id}`)).json.ladder.steps[0].kind, 'tag', 'nothing was saved');
    // A lookup that can't be made just now isn't a no: each send looks again.
    assert.equal((await save('https://busy.example.org/hook')).status, 200);
    const fine = ok(await save('HTTPS://Fine.Example.org:443/hook?a=1#top'));
    assert.equal(fine.ladder.steps[0].url, 'https://fine.example.org/hook?a=1', 'kept tidy');
    // An address already on the ladder isn't looked up again: another step can be saved while a lookup fails.
    names.delete('fine.example.org');
    const again = ok(await mgr.action('ladder.update', { id: lad.id, steps: [...fine.ladder.steps, { kind: 'tag', tag: 'y' }] }));
    assert.equal(again.ladder.steps.length, 2);
  });
  assert.equal(addressProblem('https://hooks.zapier.com/hooks/catch/1/abc/'), null);
  assert.equal(cleanAddress(' https://Hooks.Zapier.com:443/hooks/catch/1/abc/ '), 'https://hooks.zapier.com/hooks/catch/1/abc/');
  assert.equal(await lookupProblem('https://hooks.example.org/x'), null, 'the stand-in is on: nothing is looked up');
});

test('which addresses are public', () => {
  for (const a of ['8.8.8.8', '93.184.215.14', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111']) assert.equal(isPublicAddress(a), true, a);
  for (const a of [
    '0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.0.0.8', '192.0.2.1',
    '192.168.1.1', '198.18.0.1', '198.51.100.7', '203.0.113.9', '224.0.0.1', '240.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:10.0.0.1', '::ffff:8.8.8.8', '64:ff9b::a00:1', '100::1', '2001:db8::1', '2001::1', '2002:a00:1::1',
    '3fff::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fec0::1', 'ff02::1', 'not an address', '',
  ]) assert.equal(isPublicAddress(a), false, a);
});

test('at send time the name is looked up again: one that now points inside is refused, nothing is sent, the run goes on', async () => {
  names.set('turncoat.example.org', PUBLIC);
  await forReal(async () => {
    const lad = await hookLadder('turn', { url: 'https://turncoat.example.org/catch/turn' });
    // Public when it was saved; inside the server's own network by the time someone reaches the step.
    names.set('turncoat.example.org', [{ address: '169.254.169.254', family: 4 }]);
    const p = await mgr.createPerson('Jo Example', { tags: ['turn'] });
    const before = hooks.received.length;
    await runJobs();
    const run = await runOf(lad.id, p.id);
    assert.deepEqual(hookLog(run).map((e) => [e.result, e.reason, e.why, e.tries]), [['failed', 'refused', 'private', 1]], 'refused once, not tried again');
    assert.equal(run.status, 'done');
    assert.ok((await tagsOf(p.id)).includes('after-turn'), 'the rest of the ladder ran');
    assert.equal(hooks.received.length, before);
    await off(lad);
  });
  // The sender itself: the same wall, whoever calls it.
  const base = { body: '{}', secret: 'sbw_test', key: 'k' };
  await forReal(async () => {
    assert.deepEqual(await postHook({ ...base, url: 'https://turncoat.example.org/x' }), { ok: false, final: true, why: 'private' });
    assert.deepEqual(await postHook({ ...base, url: 'https://169.254.169.254/latest/meta-data/' }), { ok: false, final: true, why: 'bad_address' });
    assert.deepEqual(await postHook({ ...base, url: 'http://hooks.example.org/x' }), { ok: false, final: true, why: 'bad_address' });
    assert.deepEqual(await postHook({ ...base, url: 'https://nowhere.example.org/x' }), { ok: false, why: 'not_found' });
  });
  await verified();
});

test('a try that fails is tried again after a minute, then after five; three in all, then "failed" and the run moves on', async () => {
  const lad = await hookLadder('retry');
  hooks.answer(500, 3);
  const p = await mgr.createPerson('Kit Example', { tags: ['retry'] });
  const pending = async () => (await db.query(
    "select run_at, payload from jobs where workspace_id = $1 and kind = 'ladder.step' and status = 'pending' and payload->>'run_id' = $2",
    [ws, (await rowOf(lad.id, p.id)).id],
  )).rows;
  const inSeconds = (job) => (new Date(job.run_at) - Date.now()) / 1000;

  await runJobs();
  assert.equal(got('retry').length, 1);
  let run = await runOf(lad.id, p.id);
  assert.deepEqual([run.status, run.step, run.wait], ['active', 0, 'retry']);
  let jobs = await pending();
  assert.equal(jobs.length, 1);
  assert.ok(inSeconds(jobs[0]) > 45 && inSeconds(jobs[0]) < 75, `again in about a minute: ${inSeconds(jobs[0])}`);
  assert.equal(await runJobs(), 0, 'not before then');

  await fastForward(); await runJobs();
  assert.equal(got('retry').length, 2);
  jobs = await pending();
  assert.ok(inSeconds(jobs[0]) > 280 && inSeconds(jobs[0]) < 320, `then in about five: ${inSeconds(jobs[0])}`);

  await fastForward(); await runJobs();
  assert.equal(got('retry').length, 3, 'three tries, no more');
  run = await runOf(lad.id, p.id);
  assert.equal(run.status, 'done');
  assert.deepEqual(hookLog(run).map((e) => [e.result, e.reason, e.status, e.tries]), [
    ['failed', 'will_retry', 500, 1], ['failed', 'will_retry', 500, 2], ['failed', 'gave_up', 500, 3],
  ]);
  assert.ok((await tagsOf(p.id)).includes('after-retry'), 'a failing address never holds the ladder');
  // Each try is the same message to the receiver: one key, one id.
  const tries = got('retry');
  assert.equal(new Set(tries.map((r) => r.headers['idempotency-key'])).size, 1);
  assert.equal(new Set(tries.map((r) => r.body.id)).size, 1);
  assert.equal(new Set(tries.map((r) => r.body.at)).size, 1, 'and the same time: when they reached the step');
  const claims = ok(await mgr.get('/api/events?since=0&limit=1000')).events
    .filter((e) => e.entity_type === 'ladder_run' && e.payload.kind === 'webhook' && e.payload.person_id === p.id && e.payload.result === 'sending');
  assert.equal(claims.length, 3, 'each try is claimed before the address is called');

  // Down twice, then back: the third try lands.
  hooks.answer(503, 2);
  const q = await mgr.createPerson('Lin Example', { tags: ['retry'] });
  await runJobs(); await fastForward(); await runJobs(); await fastForward(); await runJobs();
  run = await runOf(lad.id, q.id);
  assert.deepEqual(hookLog(run).map((e) => [e.result, e.status]), [['failed', 503], ['failed', 503], ['sent', 200]]);
  assert.equal(run.status, 'done');
  await off(lad);
  await verified();
});

test('the sender: five seconds at most, a redirect is not followed, the answer’s words are never read', async () => {
  const send = (over = {}) => postHook({ url: 'https://hooks.example.org/catch/sender', body: '{"a":1}', secret: 'sbw_test', key: 'k-1', ...over });
  assert.deepEqual(await send(), { ok: true, status: 200 });
  hooks.answer(204);
  assert.deepEqual(await send(), { ok: true, status: 204 });
  hooks.answer(410);
  assert.deepEqual(await send(), { ok: false, status: 410 });
  // A redirect could lead anywhere (inside the network, too): it is not followed — and final, the same one would come back.
  hooks.answer(302, 1, { location: `${hooks.url}/catch/elsewhere` });
  assert.deepEqual(await send(), { ok: false, final: true, status: 302 });
  hooks.answer(308, 1, { location: `${hooks.url}/catch/elsewhere` });
  assert.deepEqual(await send(), { ok: false, final: true, status: 308 });
  assert.equal(got('elsewhere').length, 0);
  // No answer: given up on (150 ms here; 5 s when a ladder sends).
  hooks.hang(1);
  const t0 = Date.now();
  assert.deepEqual(await send({ timeoutMs: 150 }), { ok: false, why: 'timeout' });
  assert.ok(Date.now() - t0 < 2000);
  hooks.asUsual();
  // Nothing listening there at all.
  const base = process.env.LADDER_WEBHOOK_API_BASE;
  process.env.LADDER_WEBHOOK_API_BASE = 'http://127.0.0.1:9';
  try { assert.deepEqual(await send(), { ok: false, why: 'unreachable' }); } finally { process.env.LADDER_WEBHOOK_API_BASE = base; }
  const last = got('sender').pop();
  assert.equal(verifySignature(last.raw, last.headers['base-signature'], ['sbw_test']).ok, true);
});

test('a failure after the send never sends it twice: the retry finds "sending", says "not sure it went", moves on', async () => {
  const lad = await hookLadder('once');
  const boom = { on: true };
  let target = null;
  onHook('events', async (_tx, meta, events) => {
    if (boom.on && meta.action === 'ladder.step'
      && events.some((e) => e.entityType === 'ladder_run' && e.payload?.kind === 'webhook' && e.payload?.result === 'sent' && e.payload?.person_id === target)) {
      throw new Error('the database went away after the send');
    }
  });
  const p = await mgr.createPerson('Mo Example', { tags: ['once'] });
  target = p.id;
  await runJobs();
  assert.equal(got('once').length, 1, 'the address got it');
  let run = await runOf(lad.id, p.id);
  assert.deepEqual([run.status, run.step, run.wait], ['active', 0, 'sending'], 'committed before the call, so the retry knows');
  for (let i = 0; i < 3; i += 1) { await fastForward(); await runJobs(); }
  assert.equal(got('once').length, 1, 'never a second copy');
  run = await runOf(lad.id, p.id);
  assert.equal(run.status, 'done');
  assert.deepEqual(hookLog(run).map((e) => e.result), ['unsure']);
  assert.ok((await tagsOf(p.id)).includes('after-once'));
  boom.on = false;

  // The same step scheduled twice (a duplicate job) sends once.
  const q = await mgr.createPerson('Nan Example', { tags: ['once'] });
  const job = (await db.query(
    "select payload from jobs where workspace_id = $1 and kind = 'ladder.step' and status = 'pending' and payload->>'run_id' = $2",
    [ws, (await rowOf(lad.id, q.id)).id],
  )).rows[0];
  await db.transaction((tx) => enqueueJob(tx, { workspaceId: ws, kind: 'ladder.step', payload: job.payload }));
  await runJobs();
  assert.equal(got('once').length, 2, 'one for Nan');
  assert.deepEqual(hookLog(await runOf(lad.id, q.id)).map((e) => e.result), ['sent']);
  await off(lad);
  await verified();
});

test('turned off mid-try: the run holds its place and tries again when the ladder is back on', async () => {
  const lad = await hookLadder('pause');
  hooks.answer(500, 1);
  const p = await mgr.createPerson('Oz Example', { tags: ['pause'] });
  await runJobs();
  assert.equal((await runOf(lad.id, p.id)).wait, 'retry');
  ok(await off(lad));
  await fastForward(); await runJobs();
  assert.equal(got('pause').length, 1, 'nothing goes while it is off');
  assert.deepEqual([(await runOf(lad.id, p.id)).status, (await runOf(lad.id, p.id)).step], ['paused', 0]);
  await turnOn(lad.id);
  await runJobs();
  assert.equal(got('pause').length, 2);
  const run = await runOf(lad.id, p.id);
  assert.equal(run.status, 'done');
  assert.deepEqual(hookLog(run).map((e) => e.result), ['failed', 'sent']);
  await off(lad);
});

test('taken off, or their goal reached, while the address is being called: the row says how it ended and the late answer promises no other try', async () => {
  const lad = await hookLadder('late');
  hooks.hold(1);
  const lee = await mgr.createPerson('Lee Example', { tags: ['late'] });
  let running = runJobs();
  await waitFor(() => got('late').length === 1); // the address has it and hasn't answered
  ok(await mgr.action('ladder.stopRun', { id: (await rowOf(lad.id, lee.id)).id }));
  hooks.release(500);
  await running;
  let run = await runOf(lad.id, lee.id);
  assert.equal(run.status, 'done');
  assert.deepEqual([run.last.kind, run.last.result], ['end', 'taken_off'], 'the row’s last word is how it ended');
  assert.deepEqual(hookLog(run).map((e) => [e.result, e.reason, e.status, e.tries]), [['failed', 'gave_up', 500, 1]], 'no "trying again": nothing will');
  await fastForward(); await runJobs();
  assert.equal(got('late').length, 1, 'and nothing does');
  assert.ok(!(await tagsOf(lee.id)).includes('after-late'), 'the rest of the ladder didn’t run');
  await off(lad);

  // The same with their goal reached mid-call: still counted as reached.
  const ask = await create({
    name: 'Ask late', trigger: { kind: 'tag', ref: 'late-goal' }, goal: 'gift',
    steps: [{ kind: 'webhook', url: 'https://hooks.example.org/catch/late-goal', label: 'Zapier' }, { kind: 'tag', tag: 'after-late-goal' }],
  });
  await turnOn(ask.id);
  hooks.hold(1);
  const max = await mgr.createPerson('Max Example', { tags: ['late-goal'] });
  running = runJobs();
  await waitFor(() => got('late-goal').length === 1);
  ok(await mgr.action('gift.log', { person_id: max.id, amount_cents: 2500, date: new Date().toISOString().slice(0, 10) }));
  hooks.release(200);
  await running;
  const view = ok(await mgr.get(`/api/ladders/${ask.id}`));
  run = view.people.find((p) => p.person.id === max.id);
  assert.deepEqual([run.status, run.last.kind, run.last.result], ['done', 'end', 'goal']);
  assert.deepEqual(hookLog(run).map((e) => [e.result, e.status]), [['sent', 200]], 'what the address answered is still on the log');
  assert.equal(view.ladder.reached, 1, 'reached the goal, whatever came in after');
  assert.equal(ok(await mgr.get('/api/ladders')).ladders.find((l) => l.id === ask.id).reached, 1);
  await off(ask);
  await verified();
});

test('an address that answers with a redirect is handed the message once: never followed, never tried again', async () => {
  const lad = await hookLadder('moved');
  hooks.answer(302, 3, { location: `${hooks.url}/catch/elsewhere` }); // it would say so every time
  const pat = await mgr.createPerson('Pat Example', { tags: ['moved'] });
  await runJobs();
  const run = await runOf(lad.id, pat.id);
  assert.deepEqual(hookLog(run).map((e) => [e.result, e.reason, e.status, e.tries]), [['failed', 'redirect', 302, 1]]);
  assert.equal(run.status, 'done', 'no six minutes of waiting: the ladder carries on at once');
  assert.ok((await tagsOf(pat.id)).includes('after-moved'));
  await fastForward(); await runJobs();
  assert.equal(got('moved').length, 1, 'one copy, not three');
  assert.equal(got('elsewhere').length, 0, 'and it is not followed');
  hooks.asUsual();
  await off(lad);
  await verified();
});

test('a ladder that starts on a money tag never names it, in the one line either', async () => {
  const lad = await hookLadder('Donor 2026', { url: 'https://hooks.example.org/catch/money', name: 'Tell the treasurer' });
  const zoe = await mgr.createPerson('Zoë Example', { tags: ['Donor 2026', 'lapsed', 'host'] });
  await runJobs();
  const [m] = got('money');
  assert.equal(m.body.person.id, zoe.id);
  assert.equal(m.body.text, 'Tell the treasurer: Zoë Example — Got a tag');
  assert.deepEqual(m.body.person.tags, ['host']);
  assert.ok(!/donor|lapsed/i.test(m.raw), 'nowhere in what was sent');
  // Any other tag is still named.
  const said = (ref) => JSON.parse(hookBody({ event: 'tag', ref, ladder: 'L', step: 'S', person: { name: 'Sam Example' } })).text;
  assert.deepEqual([said('host'), said('lapsed'), said('Major donors')], ['L: Sam Example — Got a tag · host', 'L: Sam Example — Got a tag', 'L: Sam Example — Got a tag']);
  await off(lad);
});

test('an address that stops answering is left alone for five minutes: whoever reaches the step meanwhile is told at once and tried again on the usual clock', async () => {
  const url = 'https://hooks.example.org/catch/quiet';
  const lad = await hookLadder('quiet', { url });
  const early = [];
  for (const n of ['Ada', 'Ben', 'Cy']) early.push(await mgr.createPerson(`${n} Example`, { tags: ['quiet'] }));
  // Three in a row with no answer (a third of a second each here; five when a ladder sends).
  hooks.hang(3);
  _setTimeoutForTest(300);
  try { await runJobs(); } finally { _setTimeoutForTest(null); hooks.asUsual(); }
  for (const p of early) {
    assert.deepEqual(hookLog(await runOf(lad.id, p.id)).map((e) => [e.result, e.reason, e.why, e.tries]), [['failed', 'will_retry', 'timeout', 1]], p.name);
  }
  assert.equal(notAnswering(url), true);
  const called = got('quiet').length;
  // The fourth isn't made to wait out the same silence — nor is any other job queued behind them.
  const dot = await mgr.createPerson('Dot Example', { tags: ['quiet'] });
  await runJobs();
  assert.equal(got('quiet').length, called, 'the address isn’t called');
  let run = await runOf(lad.id, dot.id);
  assert.deepEqual(hookLog(run).map((e) => [e.result, e.reason, e.why, e.tries]), [['failed', 'will_retry', 'not_answering', 1]]);
  assert.deepEqual([run.status, run.wait], ['active', 'retry'], 'tried again on the usual clock');
  // A minute on it is still being left alone …
  await fastForward(); await runJobs();
  assert.equal(got('quiet').length, called);
  // … after five it is called again — and it is back: everyone's third try lands.
  _silentForTest.get(url).until = Date.now() - 1;
  await fastForward(); await runJobs();
  assert.equal(got('quiet').length, called + 4, 'one each');
  for (const p of [...early, dot]) {
    run = await runOf(lad.id, p.id);
    assert.equal(run.status, 'done');
    assert.deepEqual(hookLog(run).map((e) => e.result), ['failed', 'failed', 'sent'], p.name);
  }
  assert.deepEqual(hookLog(await runOf(lad.id, early[0].id)).map((e) => e.why || e.status), ['timeout', 'not_answering', 200]);
  assert.equal(notAnswering(url), false, 'an answer clears it');

  // Only silence counts, and only in a row: any answer at all — a 500 too — starts the count again.
  const slow = 'https://hooks.example.org/catch/slow';
  const send = (timeoutMs) => postHook({ url: slow, body: '{}', secret: 'sbw_test', key: 'k', timeoutMs });
  const silence = async (times) => {
    hooks.hang(times);
    for (let i = 0; i < times; i += 1) assert.deepEqual(await send(100), { ok: false, why: 'timeout' });
    hooks.asUsual();
  };
  await silence(2);
  hooks.answer(500);
  assert.deepEqual(await send(), { ok: false, status: 500 });
  await silence(2);
  assert.equal(notAnswering(slow), false, 'two, an answer, two more: never three in a row');
  await silence(1);
  assert.equal(notAnswering(slow), true);
  _silentForTest.clear();
  await off(lad);
  await verified();
});

test('only the desk makes the step or sees the secret; each campaign has its own; looking is on the log', async () => {
  const inv = ok(await mgr.action('member.invite', { email: mail('vol'), role: 'volunteer' }));
  const v = new Client();
  await v.post('/api/auth/join', { token: inv.joinUrl.split('/join/')[1], name: 'Val Example', password: 'knock-knock-2026' });
  assert.equal((await v.action('ladder.signingSecret', {})).status, 403);
  const step = { kind: 'webhook', url: 'https://hooks.example.org/catch/vol', label: 'Mine' };
  assert.equal((await v.action('ladder.create', { name: 'x', trigger: { kind: 'rating' }, steps: [step] })).status, 403);
  // Even a volunteer given Outreach: the step would hand them emails they may never see.
  ok(await mgr.action('permission.role.set', { role: 'volunteer', grant: ['outreach'], deny: [] }));
  const plain = await v.action('ladder.create', { name: 'Vol ladder', trigger: { kind: 'rating' }, steps: [{ kind: 'tag', tag: 'v' }] });
  assert.equal(plain.status, 200, 'the grant lets them make a ladder');
  const sly = await v.action('ladder.update', { id: plain.json.ladder.id, steps: [step] });
  assert.equal(sly.status, 403);
  assert.equal(sly.json.error, 'Only the desk can send to a web address');
  const peek = await v.action('ladder.signingSecret', {});
  assert.equal(peek.status, 403);
  assert.ok(!JSON.stringify(peek.json).includes('sbw_'));
  // Nor do they change or turn on a ladder the desk gave one to: the answer
  // would hand them its steps, and the address in them can be a key.
  const deskMade = await create({ name: 'Desk made', trigger: { kind: 'tag', ref: 'deskmade' }, steps: [step, { kind: 'tag', tag: 'z' }] });
  for (const [name, input] of [
    ['ladder.update', { id: deskMade.id, name: 'Renamed' }],
    ['ladder.update', { id: deskMade.id, steps: [{ kind: 'tag', tag: 'z' }] }],
    ['ladder.setActive', { id: deskMade.id, active: true }],
  ]) {
    const r = await v.action(name, input);
    assert.equal(r.status, 403, `${name} ${JSON.stringify(input)} → ${JSON.stringify(r.json)}`);
    assert.ok(!JSON.stringify(r.json).includes('hooks.example.org'), name);
  }
  const still = ok(await mgr.get(`/api/ladders/${deskMade.id}`)).ladder;
  assert.deepEqual([still.name, still.active, still.steps.length], ['Desk made', false, 2], 'nothing changed');
  ok(await mgr.action('permission.role.set', { role: 'volunteer', grant: [], deny: [] }));

  const mine = ok(await mgr.action('ladder.signingSecret', {})).secret;
  const other = new Client();
  ok(await other.signup({ workspaceName: `Other hooks ${tag}`, email: mail('other') }));
  const theirs = ok(await other.action('ladder.signingSecret', {})).secret;
  assert.match(theirs, /^sbw_[0-9a-f]{64}$/);
  assert.notEqual(theirs, mine);

  // No read hands it out; each look is on the log, by name — the secret itself never is.
  const reads = JSON.stringify([ok(await mgr.get('/api/ladders')), ok(await mgr.get('/api/auth/me'))]);
  assert.ok(!reads.includes(mine));
  const looks = ok(await mgr.get('/api/events?since=0&limit=1000')).events.filter((e) => e.action === 'ladder.signingSecret');
  assert.ok(looks.length >= 2 && looks.every((e) => e.actor_id && e.payload.ladder_signing_secret === 'shown'));
  assert.ok(!JSON.stringify(looks).includes(mine));
  await verified();
});

test('"Make a new secret": the old one stops signing at once — this campaign’s only, the desk only, on the log by name', async () => {
  const lad = await hookLadder('rotate');
  const other = new Client();
  ok(await other.signup({ workspaceName: `Rotating elsewhere ${tag}`, email: mail('elsewhere') }));
  const theirs = ok(await other.action('ladder.signingSecret', {})).secret;
  const old = ok(await mgr.action('ladder.signingSecret', {})).secret;
  const made = ok(await mgr.action('ladder.newSigningSecret', {})).secret;
  assert.match(made, /^sbw_[0-9a-f]{64}$/);
  assert.notEqual(made, old);
  assert.equal(ok(await mgr.action('ladder.signingSecret', {})).secret, made, 'the one shown from now on');
  assert.equal(ok(await other.action('ladder.signingSecret', {})).secret, theirs, 'another campaign’s is as it was');

  // The next message is signed with the new one — and a later try with the one after that.
  hooks.answer(500, 1);
  const quinn = await mgr.createPerson('Quinn Example', { tags: ['rotate'] });
  await runJobs();
  let m = got('rotate').pop();
  assert.equal(verifySignature(m.raw, m.headers['base-signature'], [made]).ok, true);
  assert.equal(verifySignature(m.raw, m.headers['base-signature'], [old]).ok, false, 'the old one no longer signs');
  const third = ok(await mgr.action('ladder.newSigningSecret', {})).secret;
  assert.equal(new Set([old, made, third]).size, 3, 'never one from before');
  await fastForward(); await runJobs();
  assert.equal(got('rotate').length, 2);
  m = got('rotate').pop();
  assert.equal(verifySignature(m.raw, m.headers['base-signature'], [third]).ok, true, 'each try is signed with the secret as it is then');
  assert.equal(verifySignature(m.raw, m.headers['base-signature'], [made]).ok, false);
  assert.equal((await runOf(lad.id, quinn.id)).status, 'done');

  // Never a volunteer's, even one given Outreach.
  const inv = ok(await mgr.action('member.invite', { email: mail('vol2'), role: 'volunteer' }));
  const v = new Client();
  await v.post('/api/auth/join', { token: inv.joinUrl.split('/join/')[1], name: 'Vic Example', password: 'knock-knock-2026' });
  ok(await mgr.action('permission.role.set', { role: 'volunteer', grant: ['outreach'], deny: [] }));
  const sly = await v.action('ladder.newSigningSecret', {});
  assert.equal(sly.status, 403);
  assert.ok(!JSON.stringify(sly.json).includes('sbw_'));
  ok(await mgr.action('permission.role.set', { role: 'volunteer', grant: [], deny: [] }));
  assert.equal(ok(await mgr.action('ladder.signingSecret', {})).secret, third, 'nothing changed');

  // On the log by who and when; the secrets themselves never are, there or in any read.
  const events = ok(await mgr.get('/api/events?since=0&limit=1000')).events;
  const changes = events.filter((e) => e.action === 'ladder.newSigningSecret');
  assert.deepEqual(changes.map((e) => e.payload), [{ ladder_signing_secret: 'changed' }, { ladder_signing_secret: 'changed' }]);
  assert.ok(changes.every((e) => e.actor_id));
  const kept = JSON.stringify([events, ok(await mgr.get('/api/auth/me')), ok(await mgr.get('/api/ladders'))]);
  for (const s of [old, made, third]) assert.ok(!kept.includes(s));
  await off(lad);
  await verified();
});

test('"Send a test": one signed message about a made-up person to the address as typed; its answer in place; nothing on anyone’s log', async () => {
  const lad = await create({ name: 'Welcome new signers', trigger: { kind: 'tag', ref: 'signed-up' }, steps: [{ kind: 'tag', tag: 'welcomed' }] });
  const people = async () => (await db.query('select count(*)::int as n from persons where workspace_id = $1', [ws])).rows[0].n;
  const runs = async () => (await db.query('select count(*)::int as n from ladder_runs where workspace_id = $1', [ws])).rows[0].n;
  const before = [await people(), await runs()];
  // The step needn't be saved yet: the address and label are the ones in the fields.
  const test1 = ok(await mgr.action('ladder.testHook', { id: lad.id, url: ' https://Hooks.example.org/catch/trial?x=1 ', label: 'Zapier' }));
  assert.deepEqual({ result: test1.result, status: test1.status }, { result: 'sent', status: 200 });
  const [m] = got('trial');
  assert.equal(got('trial').length, 1);
  assert.equal(m.path, '/catch/trial?x=1');
  const secret = ok(await mgr.action('ladder.signingSecret', {})).secret;
  assert.equal(verifySignature(m.raw, m.headers['base-signature'], [secret]).ok, true, 'signed like the real thing, with the campaign’s secret');
  assert.match(m.headers['idempotency-key'], /^test-[0-9a-f-]{36}$/);
  assert.ok(Math.abs(new Date(m.body.at) - Date.now()) < 60_000);
  assert.deepEqual({ ...m.body, at: null }, {
    id: m.headers['idempotency-key'],
    test: true,
    event: 'tag',
    ladder: 'Welcome new signers',
    step: 'Zapier',
    at: null,
    campaign: wsName,
    text: 'Test · Welcome new signers: Sam Example — Got a tag · signed-up',
    person: {
      id: '00000000-0000-4000-8000-000000000000', first_name: 'Sam', last_name: 'Example',
      email: 'sam@example.org', phone: '+16045550100', postal: 'V3T 1V8', tags: ['test'],
    },
  }, 'the same shape as a real message, marked a test, about nobody');
  assert.deepEqual([await people(), await runs()], before, 'no person made, nobody put on the ladder');
  assert.equal(ok(await mgr.get(`/api/ladders/${lad.id}`)).ladder.steps.length, 1, 'and the ladder is as it was');

  // What the address answers is what the desk is told.
  const test = (url = 'https://hooks.example.org/catch/trial') => mgr.action('ladder.testHook', { id: lad.id, url, label: 'Zapier' });
  hooks.answer(500);
  let r = ok(await test());
  assert.deepEqual([r.result, r.reason, r.status], ['failed', 'gave_up', 500]);
  hooks.answer(301, 1, { location: 'https://elsewhere.example.org/' });
  r = ok(await test());
  assert.deepEqual([r.result, r.reason, r.status], ['failed', 'redirect', 301]);
  hooks.hang(1);
  _setTimeoutForTest(200);
  try { r = ok(await test()); } finally { _setTimeoutForTest(null); hooks.asUsual(); }
  assert.deepEqual([r.result, r.reason, r.why], ['failed', 'gave_up', 'timeout']);
  // An address it may not be pointed at is refused in the same words as when saved; nothing is sent.
  const sentSoFar = hooks.received.length;
  for (const [url, words] of [
    ['http://hooks.example.org/catch/trial', 'The address must start with https://'],
    ['https://192.168.1.20/hook', 'That address points inside a private network — it can’t be used'],
    ['https://sam:pw@hooks.example.org/x', 'Leave the name and password out of the address'],
  ]) {
    r = await test(url);
    assert.equal(r.status, 400, url);
    assert.equal(r.json.error, words);
  }
  names.set('inside.example.org', [{ address: '10.1.2.3', family: 4 }]);
  await forReal(async () => {
    r = await test('https://inside.example.org/hook');
    assert.deepEqual([r.status, r.json.error], [400, 'That address points inside a private network — it can’t be used']);
    r = await test('https://nowhere.example.org/hook');
    assert.deepEqual([r.status, r.json.error], [400, 'We couldn’t find nowhere.example.org — check the address']);
  });
  assert.equal((await mgr.action('ladder.testHook', { id: '99999999-9999-4999-8999-999999999999', url: 'https://hooks.example.org/catch/trial', label: 'Zapier' })).status, 404);
  assert.equal(hooks.received.length, sentSoFar, 'none of those sent anything');

  // Never a volunteer's, even one given Outreach.
  const inv = ok(await mgr.action('member.invite', { email: mail('vol3'), role: 'volunteer' }));
  const v = new Client();
  await v.post('/api/auth/join', { token: inv.joinUrl.split('/join/')[1], name: 'Vee Example', password: 'knock-knock-2026' });
  ok(await mgr.action('permission.role.set', { role: 'volunteer', grant: ['outreach'], deny: [] }));
  r = await v.action('ladder.testHook', { id: lad.id, url: 'https://hooks.example.org/catch/trial', label: 'Mine' });
  assert.deepEqual([r.status, r.json.error], [403, 'Only the desk can send to a web address']);
  ok(await mgr.action('permission.role.set', { role: 'volunteer', grant: [], deny: [] }));
  assert.equal(hooks.received.length, sentSoFar);

  // On the event log: that a test went and to which site — never the rest of the address, what was sent, or the secret.
  const events = ok(await mgr.get('/api/events?since=0&limit=1000')).events;
  const tests = events.filter((e) => e.action === 'ladder.testHook');
  assert.equal(tests.length, 4, 'one for each that was sent');
  assert.ok(tests.every((e) => e.actor_id && e.payload.ladder_hook_test === 'https://hooks.example.org/…'));
  const kept = JSON.stringify(events);
  for (const never of ['/catch/trial', 'sam@example.org', secret]) assert.ok(!kept.includes(never), never);
  await verified();
});

test('a page from before the step existed shows it as a Stop: its Save step and Remove step on that card are refused and told to reload; everything else it saves as before', async () => {
  const hook = { kind: 'webhook', url: 'https://hooks.example.org/catch/oldtab', label: 'Zapier' };
  const lad = await create({ name: 'Old tab', trigger: { kind: 'tag', ref: 'oldtab' }, steps: [{ kind: 'tag', tag: 'a' }, hook, { kind: 'tag', tag: 'b' }] });
  const steps = async () => ok(await mgr.get(`/api/ladders/${lad.id}`)).ladder.steps;
  // What that page sends (main at 405d716): each step as it was read, but
  // for the card that was saved — and a kind it has no words for it saves
  // as `{ kind: 'stop' }`. It names no step kinds it knows.
  const old = (next) => mgr.action('ladder.update', { id: lad.id, steps: next });
  const RELOAD = 'Reload this page — it’s out of date and shows this step wrongly';
  const [a, h, b] = await steps();
  let r = await old([a, { kind: 'stop' }, b]); // Save step on the card it calls "Stop"
  assert.deepEqual([r.status, r.json.error], [409, RELOAD], 'a Stop is never written over the address');
  r = await old([a, b]); // Remove step on that card
  assert.deepEqual([r.status, r.json.error], [409, RELOAD], 'nor is the step taken away');
  assert.deepEqual(await steps(), [a, h, b], 'the ladder is as it was');
  // Whatever else that page does hands the step back as it is: moved, another step changed, one added, a real Stop removed.
  ok(await old([h, a, b]));
  ok(await old([h, { kind: 'tag', tag: 'a2' }, b]));
  ok(await old([h, { kind: 'tag', tag: 'a2' }, b, { kind: 'stop' }]));
  ok(await old([h, { kind: 'tag', tag: 'a2' }, { kind: 'stop' }, { kind: 'stop' }])); // a step it does know, saved as a Stop: its own business
  ok(await old([h, { kind: 'tag', tag: 'a2' }, { kind: 'stop' }]));
  assert.deepEqual(await steps(), [h, { kind: 'tag', tag: 'a2' }, { kind: 'stop' }]);
  // The same when the step is the only one, or the ladder is on.
  const only = await hookLadder('oldtab-on');
  r = await mgr.action('ladder.update', { id: only.id, steps: [{ kind: 'stop' }, only.steps[1]] });
  assert.deepEqual([r.status, r.json.error], [409, RELOAD]);
  r = await mgr.action('ladder.update', { id: only.id, steps: [only.steps[1]] });
  assert.deepEqual([r.status, r.json.error], [409, RELOAD]);
  await off(only);
  // A page that has words for the step says so with each save (`knows`): it may take the step away.
  const gone = ok(await mgr.action('ladder.update', { id: lad.id, steps: [{ kind: 'tag', tag: 'a2' }, { kind: 'stop' }], knows: ['wait', 'stop', 'webhook'] })).ladder;
  assert.deepEqual(gone.steps.map((s) => s.kind), ['tag', 'stop']);
  // On a ladder with no such step the older page saves as it always did — a Stop in a step's place too.
  ok(await old([{ kind: 'stop' }, { kind: 'stop' }]));
  ok(await old([{ kind: 'stop' }]));
  await verified();
});

test('what is sent, built by hand: an organization has no first or last name; nothing unlisted rides along', () => {
  const body = JSON.parse(hookBody({
    id: 'ladder-r-2', event: 'gift', ref: null, ladder: 'Thank donors', step: 'Slack', at: '2026-11-10T20:00:00.000Z', campaign: 'Imagine Surrey',
    person: {
      id: 'p1', name: 'Example Hall Society', first_name: null, last_name: null, email: 'hall@example.org', phone: '604-555-0150',
      postal: null, tags: '["venue","Donor 2026","lapsed"]', rating: '1', attrs: { note: 'private' }, address: '1 Example St',
    },
    emailOk: true, textOk: false,
  }));
  assert.deepEqual(body, {
    id: 'ladder-r-2', event: 'gift', ladder: 'Thank donors', step: 'Slack', at: '2026-11-10T20:00:00.000Z', campaign: 'Imagine Surrey',
    text: 'Thank donors: Example Hall Society — Gave (any gift)',
    person: { id: 'p1', first_name: null, last_name: null, email: 'hall@example.org', phone: null, postal: null, tags: ['venue'] },
  });
  // A name typed into a website form can't speak a chat tool's own marks in
  // the one line it shows (Slack reads <!channel> and <https://…|words>).
  const sly = JSON.parse(hookBody({
    id: 'ladder-r-0', event: 'newsletter', ladder: 'Welcome', step: 'Slack', at: '2026-11-10T20:00:00.000Z', campaign: 'Imagine Surrey',
    person: { id: 'p2', name: '<!channel> Sam <https://bad.example.org|Example>', first_name: '<!channel> Sam', last_name: 'Example', tags: [] },
    emailOk: false, textOk: false,
  }));
  assert.equal(sly.text, 'Welcome: !channel Sam https://bad.example.org|Example — Joined the newsletter');
  assert.equal(sly.person.first_name, '<!channel> Sam', 'the fields are as they are on file');
});
