// Ladders that react to everything: website actions by kind and by one
// petition (the site_action event), a shift booked, came to, missed, any
// gift, a membership, a survey answered — each puts the person on; a text
// step goes through the campaign's texting (Twilio stubbed here): it waits
// for texting hours and for texting to be connected, never texts who
// replied STOP or asked to stop in words (until START), is do-not-text,
// said no to texts on the website, or is in a teammate's conversation; it
// names the campaign (or can't be saved), ends
// "Reply STOP to opt out" and is filed in the Inbox. A goal (came to a
// shift, gave, became a member, voted) takes someone off as soon as they
// do it — paused or not — and someone who already voted is never put on a
// voting ladder. The books verify.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';
import { runDueJobs } from '../lib/jobs.js';
import { _setClockForTest } from '../ext/texting/rules.js';
import { twilioSignature } from '../ext/texting/twilio.js';
import { ensureSiteTables, siteAction, siteCampaign } from './siteactions.js';

const tag = Math.random().toString(36).slice(2, 8);
const mail = (who) => `${who}.lt.${tag}@example.org`;
let db, mgr, ws, wsName;

const ok = (r) => { assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.json)); return r.json; };
const runJobs = async () => {
  for (let i = 0; i < 40; i++) {
    const r = await runDueJobs(db, { workspaceId: ws });
    if (r.ran + r.failed === 0) break;
  }
};
const fastForward = () => db.query(
  "update jobs set run_at = now() - interval '1 second' where workspace_id = $1 and status = 'pending' and kind = 'ladder.step'", [ws],
);
const create = async (input) => ok(await mgr.action('ladder.create', input)).ladder;
const on = async (input) => {
  const l = await create(input);
  ok(await mgr.action('ladder.setActive', { id: l.id, active: true }));
  return l;
};
const off = (l) => mgr.action('ladder.setActive', { id: l.id, active: false });
const runsOf = async (ladderId) => (await db.query(
  'select * from ladder_runs where workspace_id = $1 and ladder_id = $2 order by started_at', [ws, ladderId],
)).rows;
const runOf = async (ladderId, personId) => (await db.query(
  'select * from ladder_runs where workspace_id = $1 and ladder_id = $2 and person_id = $3 order by started_at desc limit 1', [ws, ladderId, personId],
)).rows[0];
const logOf = (run) => (typeof run.log === 'string' ? JSON.parse(run.log) : run.log);
const tagStep = (t) => [{ kind: 'tag', tag: t }];

// ── Twilio, stubbed (as texting.test.js does) ──
const ENV = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM', 'STARBASE_PUBLIC_URL', 'TWILIO_API_BASE'];
const savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const realFetch = globalThis.fetch;
const sms = [];
const connect = () => {
  process.env.TWILIO_ACCOUNT_SID = `ACtest${tag}`;
  process.env.TWILIO_AUTH_TOKEN = `token-${tag}`;
  process.env.TWILIO_FROM = '+16045550100';
  process.env.STARBASE_PUBLIC_URL = 'https://base.example';
  delete process.env.TWILIO_API_BASE;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (!u.startsWith('https://api.twilio.com/')) return realFetch(url, init);
    sms.push(Object.fromEntries(new URLSearchParams(String(init.body || ''))));
    return new Response(JSON.stringify({ sid: `SM${tag}${sms.length}`, status: 'queued' }), { status: 201, headers: { 'content-type': 'application/json' } });
  };
};
const disconnect = () => {
  for (const k of ENV) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  globalThis.fetch = realFetch;
};
// Surrey, a Tuesday: 2 am (quiet) and noon (texts may go).
const NIGHT = '2026-11-10T10:00:00Z';
const NOON = '2026-11-10T20:00:00Z';
const clockAt = (iso) => _setClockForTest(() => new Date(iso));

before(async () => {
  db = await freshDb();
  delete process.env.RESEND_API_KEY;
  disconnect();
  mgr = new Client();
  wsName = `Reacts ${tag}`;
  ws = ok(await mgr.signup({ name: 'Lou Example', workspaceName: wsName, email: mail('lou'), jurisdiction: 'bc-municipal' })).workspace.id;
  await ensureSiteTables(db);
});
after(() => { disconnect(); _setClockForTest(null); });

test('website triggers: what they did, or the one petition they signed', async () => {
  const transit = await siteCampaign(db, ws, { title: 'SkyTrain to Langley' });
  const parks = await siteCampaign(db, ws, { title: 'Save Green Timbers', kind: 'pledge' });
  const anyPetition = await on({ name: 'Any petition', trigger: { kind: 'web', ref: 'petition' }, steps: tagStep('signed-any') });
  const oneCampaign = await on({ name: 'SkyTrain signers', trigger: { kind: 'web', ref: `campaign:${transit.id}` }, steps: tagStep('skytrain') });
  const volunteers = await on({ name: 'Website volunteers', trigger: { kind: 'web', ref: 'volunteer' }, steps: tagStep('web-vol') });
  assert.equal((await mgr.action('ladder.create', { name: 'x', trigger: { kind: 'web' } })).status, 400, 'pick what they did');
  assert.equal((await mgr.action('ladder.create', { name: 'x', trigger: { kind: 'web', ref: 'bake-sale' } })).status, 400);
  assert.equal((await mgr.action('ladder.create', { name: 'x', trigger: { kind: 'web', ref: `campaign:${randomUUID()}` } })).status, 404, 'a petition of this campaign');

  const ana = await siteAction(db, ws, { kind: 'petition', campaignId: transit.id, person: { name: 'Ana Example', email: mail('ana') } });
  const ben = await siteAction(db, ws, { kind: 'pledge', campaignId: parks.id, person: { name: 'Ben Example', email: mail('ben') } });
  const cy = await siteAction(db, ws, { kind: 'volunteer', person: { name: 'Cy Example', email: mail('cy') } });
  assert.ok(await runOf(anyPetition.id, ana.personId));
  assert.ok(await runOf(oneCampaign.id, ana.personId));
  assert.equal(await runOf(anyPetition.id, ben.personId), undefined, 'a pledge is not a petition');
  assert.equal(await runOf(oneCampaign.id, ben.personId), undefined);
  assert.ok(await runOf(volunteers.id, cy.personId));
  await runJobs();
  const tags = (await db.query('select tags from persons where id = $1', [ana.personId])).rows[0].tags;
  assert.ok(tags.includes('signed-any') && tags.includes('skytrain'));
  // The list says what each starts on, in words.
  const list = ok(await mgr.get('/api/ladders'));
  assert.equal(list.ladders.find((l) => l.id === oneCampaign.id).trigger.what, 'Signed: SkyTrain to Langley');
  assert.equal(list.ladders.find((l) => l.id === anyPetition.id).trigger.what, 'Signed a petition');
  assert.ok(list.options.web.some((o) => o.value === `campaign:${parks.id}` && o.label === 'Pledged: Save Green Timbers'));
  for (const l of [anyPetition, oneCampaign, volunteers]) await off(l);
});

test('shift triggers: booked (and booked again), came, didn’t show up', async () => {
  const shift = ok(await mgr.action('shift.create', { title: 'Fleetwood canvass', starts_at: new Date(Date.now() + 86400000).toISOString() })).shift;
  const dee = await mgr.createPerson('Dee Example', { email: mail('dee') });
  const eli = await mgr.createPerson('Eli Example', { email: mail('eli') });
  // Booked before the ladder was on: confirming it later is not a booking.
  const early = ok(await mgr.action('shift.assign', { shift_id: shift.id, person_id: eli.id })).assignment;
  const booked = await on({ name: 'Booked', trigger: { kind: 'shift_booked' }, steps: tagStep('booked'), reentry: true });
  const came = await on({ name: 'Came', trigger: { kind: 'shift_attended' }, steps: tagStep('came') });
  const missed = await on({ name: 'Missed', trigger: { kind: 'shift_no_show' }, steps: tagStep('missed') });
  ok(await mgr.action('shift.setStatus', { id: early.id, status: 'confirmed' }));
  assert.equal(await runOf(booked.id, eli.id), undefined, 'booked → confirmed is the same booking');
  const a = ok(await mgr.action('shift.assign', { shift_id: shift.id, person_id: dee.id })).assignment;
  assert.ok(await runOf(booked.id, dee.id), 'booked');
  ok(await mgr.action('shift.setStatus', { id: a.id, status: 'completed' }));
  assert.ok(await runOf(came.id, dee.id), 'came: checked in');
  ok(await mgr.action('shift.setStatus', { id: early.id, status: 'no_show' }));
  assert.ok(await runOf(missed.id, eli.id), 'didn’t show up');
  await runJobs();
  // Booked again after the no-show: again (the ladder lets people through again).
  ok(await mgr.action('shift.setStatus', { id: early.id, status: 'assigned' }));
  const eliRuns = (await runsOf(booked.id)).filter((r) => r.person_id === eli.id);
  assert.equal(eliRuns.length, 1, 'booked again after a no-show starts it');
  for (const l of [booked, came, missed]) await off(l);
});

test('any gift, a membership, a survey answered', async () => {
  const gave = await on({ name: 'Gave', trigger: { kind: 'gift' }, steps: tagStep('gave'), reentry: true });
  const first = await on({ name: 'First gift', trigger: { kind: 'donation' }, steps: tagStep('first-gift') });
  const joined = await on({ name: 'Joined', trigger: { kind: 'member' }, steps: tagStep('joined') });
  const fay = await mgr.createPerson('Fay Example', { email: mail('fay') });
  const today = new Date().toISOString().slice(0, 10);
  ok(await mgr.action('gift.log', { person_id: fay.id, amount_cents: 2500, date: today }));
  await runJobs();
  ok(await mgr.action('gift.log', { person_id: fay.id, amount_cents: 2500, date: today }));
  assert.equal((await runsOf(gave.id)).filter((r) => r.person_id === fay.id).length, 2, 'every gift (again once the last run is over)');
  assert.equal((await runsOf(first.id)).filter((r) => r.person_id === fay.id).length, 1, 'only the first is a first gift');

  const form = ok(await mgr.action('membership.enter', {
    first_name: 'Gus', last_name: 'Example', email: mail('gus'), birth_date: '1980-02-02', citizenship: 'citizen',
    term: 1, once: { kind: 'amount', amount_cents: 1000 }, method: 'cash', signed: true,
  }));
  const gus = (await db.query("select id from persons where workspace_id = $1 and name = 'Gus Example'", [ws])).rows[0];
  assert.ok(gus, JSON.stringify(form).slice(0, 200));
  assert.ok(await runOf(joined.id, gus.id), 'became a member');

  const s1 = ok(await mgr.action('survey.create', { name: 'Doorstep issues' })).survey;
  const s2 = ok(await mgr.action('survey.create', { name: 'Transit' })).survey;
  const q1 = ok(await mgr.action('survey.question.add', { survey_id: s1.id, kind: 'yesno', text: 'Lawn sign?' })).question;
  const q2 = ok(await mgr.action('survey.question.add', { survey_id: s2.id, kind: 'yesno', text: 'Ride the bus?' })).question;
  const anySurvey = await on({ name: 'Any survey', trigger: { kind: 'survey' }, steps: tagStep('answered') });
  const transitOnly = await on({ name: 'Transit answers', trigger: { kind: 'survey', ref: s2.id }, steps: tagStep('transit') });
  assert.equal((await mgr.action('ladder.create', { name: 'x', trigger: { kind: 'survey', ref: randomUUID() } })).status, 404);
  const hal = await mgr.createPerson('Hal Example', { phone: '604-555-0191' });
  const ida = await mgr.createPerson('Ida Example', { phone: '604-555-0192' });
  ok(await mgr.action('contact.log', { person_id: hal.id, channel: 'door', outcome: 'contacted', answers: [{ question_id: q1.id, value: true }] }));
  ok(await mgr.action('contact.log', { person_id: ida.id, channel: 'door', outcome: 'contacted', answers: [{ question_id: q2.id, value: false }] }));
  assert.ok(await runOf(anySurvey.id, hal.id) && await runOf(anySurvey.id, ida.id));
  assert.equal(await runOf(transitOnly.id, hal.id), undefined);
  assert.ok(await runOf(transitOnly.id, ida.id));
  assert.equal(ok(await mgr.get(`/api/ladders/${transitOnly.id}`)).ladder.trigger.what, 'Transit');
  await runJobs();
  for (const l of [gave, first, joined, anySurvey, transitOnly]) await off(l);
});

test('a text must say who it’s from, and only [first name] and [campaign] fill in', async () => {
  const l = await create({ name: 'Text check', trigger: { kind: 'tag', ref: 'text-check' } });
  const bad = await mgr.action('ladder.update', { id: l.id, steps: [{ kind: 'text', body: 'Hi {{first_name}}, thanks!' }] });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /Say it's Reacts/);
  const blank = await mgr.action('ladder.update', { id: l.id, steps: [{ kind: 'text', body: 'Hi {{name}} — {{campaign}}' }] });
  assert.equal(blank.status, 400);
  ok(await mgr.action('ladder.update', { id: l.id, steps: [{ kind: 'text', body: 'Hi {{first_name}}, thanks — {{campaign}}' }] }));
  ok(await mgr.action('ladder.update', { id: l.id, steps: [{ kind: 'text', body: `Hi, it's ${wsName} — thanks!` }] }));
  assert.equal((await mgr.action('ladder.create', { name: 'y', trigger: { kind: 'rating' }, steps: [{ kind: 'text', body: 'No name' }] })).status, 400);
});

test('a text step: waits for texting hours, then goes with the STOP line, filed in the Inbox', async () => {
  connect();
  clockAt(NIGHT);
  const l = await on({ name: 'Text new signers', trigger: { kind: 'tag', ref: 'texted' }, steps: [{ kind: 'text', body: 'Hi {{first_name}}, thanks for signing! — {{campaign}}' }, { kind: 'tag', tag: 'got-text' }] });
  const jo = await mgr.createPerson('Jo Example', { phone: '604-555-0193', tags: ['texted'] });
  await runJobs();
  let run = await runOf(l.id, jo.id);
  assert.equal(run.wait, 'quiet', 'held for the hours texts may go');
  assert.ok(run.next_at);
  assert.equal(sms.length, 0, 'nothing at 2 am');
  const waiting = logOf(run).filter((e) => e.kind === 'text');
  assert.deepEqual(waiting.map((e) => `${e.result}:${e.reason}`), ['waiting:quiet_hours']);
  // Still night: looking again says nothing new.
  await fastForward();
  await runJobs();
  assert.equal(logOf(await runOf(l.id, jo.id)).filter((e) => e.kind === 'text').length, 1);
  // Noon: it goes.
  clockAt(NOON);
  await fastForward();
  await runJobs();
  assert.equal(sms.length, 1);
  assert.equal(sms[0].To, '+16045550193');
  assert.equal(sms[0].Body, `Hi Jo, thanks for signing! — ${wsName}\nReply STOP to opt out`);
  run = await runOf(l.id, jo.id);
  assert.equal(run.status, 'done');
  assert.deepEqual(logOf(run).filter((e) => e.kind === 'text').map((e) => e.result), ['waiting', 'sending', 'sent']);
  assert.ok((await db.query('select tags from persons where id = $1', [jo.id])).rows[0].tags.includes('got-text'));
  const filed = (await db.query(
    `select c.started_by, m.body, m.status, m.direction from texting_messages m join texting_conversations c on c.id = m.conversation_id
     where c.workspace_id = $1 and c.person_id = $2`, [ws, jo.id],
  )).rows;
  assert.equal(filed.length, 1);
  assert.equal(filed[0].started_by, null, 'the campaign’s own conversation: the desk reads the replies');
  assert.equal(filed[0].status, 'sent');
  // What the desk's screen says (no words of the text itself).
  const people = ok(await mgr.get(`/api/ladders/${l.id}`)).people;
  assert.deepEqual(people.find((p) => p.person.id === jo.id).log.filter((e) => e.kind === 'text').map((e) => e.result), ['waiting', 'sent']);
  await off(l);
  disconnect();
});

test('a text step never texts who replied STOP, is do-not-text, said no on the website, has no number, or is texting a teammate', async () => {
  connect();
  clockAt(NOON);
  const l = await on({ name: 'Text everyone', trigger: { kind: 'tag', ref: 'text-all' }, steps: [{ kind: 'text', body: 'Hello from {{campaign}}' }] });
  const stop = await mgr.createPerson('Kai Example', { phone: '604-555-0194' });
  await db.query("insert into texting_optouts (id, workspace_id, phone, opted_out, keyword) values ($1, $2, '+16045550194', true, 'STOP')", [randomUUID(), ws]);
  const dnt = await mgr.createPerson('Lee Example', { phone: '604-555-0195', tags: ['do-not-text'] });
  const said = await siteAction(db, ws, { kind: 'newsletter', person: { name: 'Mo Example', email: mail('mo'), phone: '604-555-0196' }, consentSms: false });
  const none = await mgr.createPerson('Ned Example', { email: mail('ned') });
  const busy = await mgr.createPerson('Ola Example', { phone: '604-555-0197' });
  const me = ok(await mgr.get('/api/auth/me')).user.id;
  await db.query(
    "insert into texting_conversations (id, workspace_id, person_id, phone, started_by, last_at) values ($1, $2, $3, '+16045550197', $4, now())",
    [randomUUID(), ws, busy.id, me],
  );
  const yes = await siteAction(db, ws, { kind: 'newsletter', person: { name: 'Pat Example', email: mail('pat'), phone: '604-555-0198' }, consentSms: true });
  const ids = [stop.id, dnt.id, said.personId, none.id, busy.id, yes.personId];
  for (const id of ids) {
    const p = (await db.query('select tags from persons where id = $1', [id])).rows[0];
    ok(await mgr.action('person.update', { id, tags: [...(p.tags || []), 'text-all'] }));
  }
  await runJobs();
  const why = {};
  for (const id of ids) {
    const t = logOf(await runOf(l.id, id)).filter((e) => e.kind === 'text').pop();
    why[id] = t.result === 'skipped' ? t.reason : t.result;
  }
  assert.deepEqual(why, {
    [stop.id]: 'opted_out', [dnt.id]: 'do_not_text', [said.personId]: 'no_text_consent',
    [none.id]: 'no_phone', [busy.id]: 'in_conversation', [yes.personId]: 'sent',
  });
  assert.deepEqual(sms.map((m) => m.To).filter((to) => to === '+16045550198'), ['+16045550198']);
  assert.ok(!sms.some((m) => ['+16045550194', '+16045550195', '+16045550196', '+16045550197'].includes(m.To)));
  await off(l);
  disconnect();
});

// A reply through Twilio's signed webhook (ext/texting public.js).
let replies = 0;
const reply = async (from, body) => {
  replies += 1;
  const params = new URLSearchParams({ From: from, To: '+16045550100', Body: body, MessageSid: `SMin${tag}${replies}`, AccountSid: `ACtest${tag}` });
  const res = await app.request('/api/public/twilio/sms', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': twilioSignature(`token-${tag}`, 'https://base.example/api/public/twilio/sms', params),
    },
    body: params.toString(),
  });
  assert.equal(res.status, 200);
};

test('a text step never texts who asked to stop in words — a reply since doesn’t undo it; START does', async () => {
  connect();
  clockAt(NOON);
  const l = await on({ name: 'Two texts', trigger: { kind: 'tag', ref: 'two-texts' }, steps: [
    { kind: 'text', body: 'Thanks for signing, {{first_name}} — {{campaign}}' },
    { kind: 'wait', n: 1, unit: 'days' },
    { kind: 'text', body: 'Can you help this weekend? — {{campaign}}' },
  ] });
  const nums = { jo: '+16045550120', bo: '+16045550121', cy: '+16045550122', di: '+16045550123' };
  const who = {};
  for (const [k, n] of Object.entries(nums)) {
    who[k] = await mgr.createPerson(`${k[0].toUpperCase()}${k.slice(1)} Example`, { phone: n.slice(2), tags: ['two-texts'] });
  }
  await runJobs();
  const texts = () => Object.fromEntries(Object.entries(nums).map(([k, n]) => [k, sms.filter((m) => m.To === n).length]));
  assert.deepEqual(texts(), { jo: 1, bo: 1, cy: 1, di: 1 });
  await reply(nums.jo, 'Please stop texting me, thanks');
  await reply(nums.bo, 'No thanks, stop.');
  await reply(nums.bo, 'I mean it');
  await reply(nums.cy, 'Remove me from your list');
  await reply(nums.cy, 'START');
  await reply(nums.di, 'Who is this?');
  // In the Inbox they're flagged for a person to decide; nothing opted out.
  const flagged = (await db.query(
    "select phone, keyword from texting_messages where workspace_id = $1 and direction = 'in' and keyword = 'asks_stop' order by phone",
    [ws],
  )).rows.map((r) => r.phone);
  assert.deepEqual(flagged, [nums.jo, nums.bo, nums.cy]);
  assert.equal((await db.query(
    'select count(*)::int as n from texting_optouts where workspace_id = $1 and opted_out and phone = any($2::text[])', [ws, Object.values(nums)],
  )).rows[0].n, 0);
  // A day later: the ladder's second text.
  await fastForward();
  await runJobs();
  assert.deepEqual(texts(), { jo: 1, bo: 1, cy: 2, di: 2 }, 'never again to Jo or Bo');
  const last = async (k) => {
    const t = logOf(await runOf(l.id, who[k].id)).filter((e) => e.kind === 'text').pop();
    return t.result === 'skipped' ? `skipped:${t.reason}` : t.result;
  };
  assert.deepEqual(
    { jo: await last('jo'), bo: await last('bo'), cy: await last('cy'), di: await last('di') },
    { jo: 'skipped:asked_to_stop', bo: 'skipped:asked_to_stop', cy: 'sent', di: 'sent' },
  );
  await off(l);
  disconnect();
});

test('texting not connected: the run waits (said once), then sends once it is', async () => {
  disconnect();
  clockAt(NOON);
  const l = await on({ name: 'Text later', trigger: { kind: 'tag', ref: 'text-later' }, steps: [{ kind: 'text', body: 'Thanks — {{campaign}}' }] });
  const ray = await mgr.createPerson('Ray Example', { phone: '604-555-0199', tags: ['text-later'] });
  await runJobs();
  let run = await runOf(l.id, ray.id);
  assert.equal(run.wait, 'text');
  assert.equal(ok(await mgr.get(`/api/ladders/${l.id}`)).ladder.waitingText, 1);
  await fastForward();
  await runJobs();
  assert.equal(logOf(await runOf(l.id, ray.id)).filter((e) => e.reason === 'text_not_connected').length, 1, 'said once');
  const before = sms.length;
  connect();
  await fastForward();
  await runJobs();
  run = await runOf(l.id, ray.id);
  assert.equal(run.status, 'done');
  assert.equal(sms.length, before + 1);
  await off(l);
  disconnect();
});

test('goals: giving takes them off at once — paused too; voting is never asked of who voted', async () => {
  const ask = await on({
    name: 'Ask to give', trigger: { kind: 'tag', ref: 'ask-give' }, goal: 'gift',
    steps: [{ kind: 'wait', n: 3, unit: 'days' }, { kind: 'followup', text: 'Ask {{first_name}} to give' }],
  });
  const sue = await mgr.createPerson('Sue Example', { email: mail('sue'), tags: ['ask-give'] });
  const tom = await mgr.createPerson('Tom Example', { email: mail('tom'), tags: ['ask-give'] });
  await runJobs();
  assert.equal((await runOf(ask.id, sue.id)).wait, 'time');
  const today = new Date().toISOString().slice(0, 10);
  ok(await mgr.action('gift.log', { person_id: sue.id, amount_cents: 5000, date: today }));
  const sueRun = await runOf(ask.id, sue.id);
  assert.equal(sueRun.status, 'done');
  assert.deepEqual(logOf(sueRun).slice(-1).map((e) => `${e.kind}:${e.result}`), ['end:goal']);
  const pending = (await db.query(
    "select count(*)::int as n from jobs where workspace_id = $1 and kind = 'ladder.step' and status = 'pending' and payload->>'run_id' = $2", [ws, sueRun.id],
  )).rows[0].n;
  assert.equal(pending, 0, 'no step left to run');
  // Off: Tom holds his place — and still comes off when he gives.
  await off(ask);
  assert.equal((await runOf(ask.id, tom.id)).status, 'paused');
  ok(await mgr.action('gift.log', { person_id: tom.id, amount_cents: 1000, date: today }));
  assert.equal((await runOf(ask.id, tom.id)).status, 'done');
  const view = ok(await mgr.get(`/api/ladders/${ask.id}`));
  assert.equal(view.ladder.goal.label, 'Gave');
  assert.equal(view.ladder.reached, 2);
  assert.equal(view.people.find((p) => p.person.id === sue.id).last.result, 'goal');

  const gotv = await on({ name: 'Remind to vote', trigger: { kind: 'tag', ref: 'remind-vote' }, goal: 'voted', steps: [{ kind: 'wait', n: 1, unit: 'days' }, { kind: 'tag', tag: 'reminded' }] });
  const una = await mgr.createPerson('Una Example', { phone: '604-555-0110' });
  ok(await mgr.action('vote.mark', { person_id: una.id, source: 'desk' }));
  ok(await mgr.action('person.update', { id: una.id, tags: ['remind-vote'] }));
  assert.equal(await runOf(gotv.id, una.id), undefined, 'voted already: never on it');
  const vic = await mgr.createPerson('Vic Example', { phone: '604-555-0111', tags: ['remind-vote'] });
  assert.equal((await runOf(gotv.id, vic.id)).status, 'active');
  ok(await mgr.action('vote.mark', { person_id: vic.id, source: 'door' }));
  assert.equal((await runOf(gotv.id, vic.id)).status, 'done', 'voted: off');
  await off(gotv);
});

test('goals: came to a shift, became a member; a goal added later is checked before the next step', async () => {
  const shift = ok(await mgr.action('shift.create', { title: 'Phone bank', starts_at: new Date(Date.now() + 3600000).toISOString() })).shift;
  const toShift = await on({ name: 'Get to a shift', trigger: { kind: 'tag', ref: 'new-vol' }, goal: 'shift_attended', steps: [{ kind: 'wait', n: 2, unit: 'days' }, { kind: 'tag', tag: 'nudged' }] });
  const wes = await mgr.createPerson('Wes Example', { email: mail('wes'), tags: ['new-vol'] });
  await runJobs();
  const a = ok(await mgr.action('shift.assign', { shift_id: shift.id, person_id: wes.id })).assignment;
  assert.equal((await runOf(toShift.id, wes.id)).status, 'active', 'booked is not came');
  ok(await mgr.action('shift.setStatus', { id: a.id, status: 'completed' }));
  assert.equal((await runOf(toShift.id, wes.id)).status, 'done');
  await off(toShift);

  const toJoin = await on({ name: 'Join us', trigger: { kind: 'tag', ref: 'ask-join' }, goal: 'member', steps: [{ kind: 'wait', n: 2, unit: 'days' }, { kind: 'tag', tag: 'asked-join' }] });
  const xia = await mgr.createPerson('Xia Example', { email: mail('xia'), tags: ['ask-join'] });
  await runJobs();
  ok(await mgr.action('membership.enter', {
    person_id: xia.id, first_name: 'Xia', last_name: 'Example', birth_date: '1975-05-05', citizenship: 'pr',
    term: 1, once: { kind: 'amount', amount_cents: 1000 }, method: 'cash', signed: true,
  }));
  assert.equal((await runOf(toJoin.id, xia.id)).status, 'done');
  await off(toJoin);

  // No goal when Yan gave; the goal is added while they wait: the next step looks first.
  const later = await on({ name: 'Goal later', trigger: { kind: 'tag', ref: 'goal-later' }, steps: [{ kind: 'wait', n: 1, unit: 'days' }, { kind: 'tag', tag: 'should-not' }] });
  const yan = await mgr.createPerson('Yan Example', { email: mail('yan'), tags: ['goal-later'] });
  await runJobs();
  ok(await mgr.action('gift.log', { person_id: yan.id, amount_cents: 1500, date: new Date().toISOString().slice(0, 10) }));
  assert.equal((await runOf(later.id, yan.id)).status, 'active');
  ok(await mgr.action('ladder.update', { id: later.id, goal: 'gift' }));
  await fastForward();
  await runJobs();
  const yr = await runOf(later.id, yan.id);
  assert.equal(yr.status, 'done');
  assert.equal(logOf(yr).slice(-1)[0].result, 'goal');
  assert.ok(!(await db.query('select tags from persons where id = $1', [yan.id])).rows[0].tags.includes('should-not'));
  // A goal can be taken away again.
  assert.equal(ok(await mgr.action('ladder.update', { id: later.id, goal: null })).ladder.goal, null);
  await off(later);
});

test('the books still verify', async () => {
  const v = ok(await mgr.get('/api/audit/verify'));
  assert.equal(v.ok, true, JSON.stringify(v));
});
