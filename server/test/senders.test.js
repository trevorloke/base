// From addresses (server/ext/senders): managers keep a short list of
// addresses at MAIL_FROM's own domain and pick the defaults for email and
// for press; the desk picks one on a send (anyone else always gets the
// default); the send keeps its From for life (Try again, the A/B winner);
// system mail (invites, ladders) stays on MAIL_FROM. The email service is a
// stand-in (fake-mail.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { runDueJobs } from '../lib/jobs.js';
import { parseFrom } from '../lib/mail/common.js';
import { startFakeMail } from './fake-mail.js';

const tag = Math.random().toString(36).slice(2, 8);
const mail = (who) => `${who}.snd.${tag}@example.org`;
const KEYS = ['MAIL_PROVIDER', 'MAIL_FROM', 'RESEND_API_KEY', 'RESEND_API_BASE', 'SENDGRID_API_KEY', 'SENDGRID_API_BASE', 'STARBASE_PUBLIC_URL'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const SYSTEM = 'Imagine Surrey <team@example.org>';
let db, resend, grid, mgr, ws, sam, samId, val, valId;

const useResend = () => {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, { RESEND_API_KEY: 're_test_key', RESEND_API_BASE: resend.url, MAIL_FROM: SYSTEM, STARBASE_PUBLIC_URL: 'https://base.example' });
};
const useSendgrid = () => {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, { MAIL_PROVIDER: 'sendgrid', SENDGRID_API_KEY: 'SG.test_key', SENDGRID_API_BASE: grid.url, MAIL_FROM: SYSTEM, STARBASE_PUBLIC_URL: 'https://base.example' });
};
const ok = (r, msg = '') => { assert.equal(r.status, 200, `${msg} ${JSON.stringify(r.json)}`); return r.json; };
const join = async (role, name) => {
  const inv = ok(await mgr.action('member.invite', { email: mail(name.toLowerCase()), role }));
  const c = new Client();
  const j = ok(await c.post('/api/auth/join', { token: inv.joinUrl.split('/join/')[1], name: `${name} Example`, password: 'senders-pass-123' }));
  return { c, id: j.user.id };
};
const senders = async (c = mgr) => ok(await c.get('/api/senders'));
const fromOf = (blastId) => db.query('select from_addr from blasts where id = $1', [blastId]).then((r) => r.rows[0].from_addr);

before(async () => {
  db = await freshDb();
  resend = await startFakeMail({ provider: 'resend' });
  grid = await startFakeMail({ provider: 'sendgrid' });
  useResend();
  mgr = new Client();
  const r = await mgr.signup({ workspaceName: `Senders ${tag}`, email: mail('mgr'), jurisdiction: 'bc-municipal' });
  assert.equal(r.status, 201);
  ws = r.json.workspace.id;
  ({ c: sam, id: samId } = await join('staff', 'Sam'));
  ({ c: val, id: valId } = await join('volunteer', 'Val'));
  ok(await mgr.action('permission.member.set', { user_id: valId, grant: ['outreach'], deny: [] }));
  for (const who of ['ana', 'ben']) {
    await mgr.createPerson(`${who} Example`, { email: mail(who), tags: ['media'] });
    ok(await mgr.action('subscription.add', { email: mail(who) }));
  }
});
after(async () => {
  await resend.close();
  await grid.close();
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

test('parseFrom reads a quoted name with a comma as one name, and both senders get it intact', async () => {
  assert.deepEqual(parseFrom('"Surrey, BC Media" <media@example.org>'), { raw: '"Surrey, BC Media" <media@example.org>', name: 'Surrey, BC Media', email: 'media@example.org', domain: 'example.org' });
  assert.deepEqual(parseFrom('team@example.org'), { raw: 'team@example.org', name: '', email: 'team@example.org', domain: 'example.org' });
  const { sendEmail } = await import('../lib/notify.js');
  const from = '"Surrey, BC Media" <media@example.org>';
  await sendEmail({ from, to: mail('x'), subject: 'Hi', text: 'Hi' });
  assert.equal(resend.sent.at(-1).from, from, 'Resend takes the From as typed');
  useSendgrid();
  try {
    await sendEmail({ from, to: mail('x'), subject: 'Hi', text: 'Hi' });
    assert.deepEqual(grid.sent.at(-1).from, { email: 'media@example.org', name: 'Surrey, BC Media' }, 'SendGrid takes name and address apart');
    await sendEmail({ to: mail('x'), subject: 'Hi', text: 'Hi' });
    assert.deepEqual(grid.sent.at(-1).from, { email: 'team@example.org', name: 'Imagine Surrey' }, 'no From: MAIL_FROM');
  } finally { useResend(); }
});

test('managers add addresses at MAIL_FROM’s domain only; names are checked; ten at most', async () => {
  const media = ok(await mgr.action('sender.save', { name: 'Surrey, BC Media', email: ' Media@Example.org ' })).sender;
  assert.equal(media.email, 'media@example.org', 'lower-cased');
  const other = await mgr.action('sender.save', { name: 'Other', email: 'media@elsewhere.example' });
  assert.deepEqual([other.status, other.json.error], [409, 'Use an address at example.org']);
  for (const name of ['Bad <name>', 'Say "hi"', 'Two\nlines', '']) {
    assert.equal((await mgr.action('sender.save', { name, email: 'x@example.org' })).status, 400, JSON.stringify(name));
  }
  ok(await mgr.action('sender.save', { name: 'O’Brien, Coordinator', email: 'ob@example.org' }), 'commas and apostrophes are fine');
  assert.equal((await mgr.action('sender.save', { name: 'Again', email: 'media@example.org' })).status, 409, 'one entry per address');
  ok(await mgr.action('sender.save', { id: media.id, name: 'Surrey, BC Media', email: 'media@example.org' }), 'a rename');
  for (let i = 0; i < 8; i += 1) ok(await mgr.action('sender.save', { name: `Extra ${i}`, email: `extra${i}@example.org` }));
  const eleventh = await mgr.action('sender.save', { name: 'Eleventh', email: 'eleventh@example.org' });
  assert.deepEqual([eleventh.status, eleventh.json.error], [409, '10 From addresses at most']);
  for (const s of (await senders()).senders.filter((x) => x.name.startsWith('Extra'))) ok(await mgr.action('sender.remove', { id: s.id }));

  // No email connected: nothing to check against.
  delete process.env.RESEND_API_KEY;
  try {
    const off = await mgr.action('sender.save', { name: 'Later', email: 'later@example.org' });
    assert.deepEqual([off.status, off.json.error], [409, 'Connect email first']);
  } finally { useResend(); }

  // Only managers.
  for (const c of [sam, val]) {
    assert.equal((await c.action('sender.save', { name: 'Mine', email: 'mine@example.org' })).status, 403);
    assert.equal((await c.action('sender.remove', { id: media.id })).status, 403);
    assert.equal((await c.action('sender.default', { use: 'press', id: media.id })).status, 403);
  }
});

test('defaults: set, read per role, and a removed default goes back to MAIL_FROM', async () => {
  const list = (await senders()).senders;
  const media = list.find((s) => s.email === 'media@example.org');
  const ob = list.find((s) => s.email === 'ob@example.org');
  assert.equal(media.raw, '"Surrey, BC Media" <media@example.org>');
  ok(await mgr.action('sender.default', { use: 'press', id: media.id }));
  const s = ok(await mgr.action('sender.default', { use: 'email', id: ob.id }));
  assert.deepEqual(s.defaults, { email: ob.id, press: media.id });

  const m = await senders();
  assert.deepEqual([m.system, m.domain, m.canChoose], [{ name: 'Imagine Surrey', email: 'team@example.org' }, 'example.org', true]);
  assert.equal((await senders(sam)).canChoose, true, 'staff choose');
  assert.equal((await senders(val)).canChoose, false, 'a volunteer granted Outreach reads it, and never chooses');
  const { c: plain } = await join('volunteer', 'Pat');
  assert.equal((await plain.get('/api/senders')).status, 403, 'a volunteer without Outreach or Media');

  const temp = ok(await mgr.action('sender.save', { name: 'Temp', email: 'temp@example.org' })).sender;
  ok(await mgr.action('sender.default', { use: 'press', id: temp.id }));
  const gone = ok(await mgr.action('sender.remove', { id: temp.id }));
  assert.deepEqual(gone.defaults, { email: ob.id, press: null }, 'removing the press default clears it');
  ok(await mgr.action('sender.default', { use: 'press', id: media.id }));
});

test('sends: the desk’s pick, the kind’s default, a removed one refused; Try again keeps the From', async () => {
  const { senders: list } = await senders();
  const media = list.find((s) => s.email === 'media@example.org');
  const ob = list.find((s) => s.email === 'ob@example.org');

  // Staff picks the coordinator for a press release.
  resend.sent.length = 0;
  const picked = ok(await sam.action('blast.send', { kind: 'press', subject: 'Picked', body: 'News', sender_id: ob.id }));
  assert.equal(await fromOf(picked.blast.id), '"O’Brien, Coordinator" <ob@example.org>');
  assert.ok(resend.sent.length === 2 && resend.sent.every((m) => m.from === '"O’Brien, Coordinator" <ob@example.org>'));

  // A volunteer granted Outreach: their pick is ignored, the default used.
  resend.sent.length = 0;
  const vol = ok(await val.action('blast.send', { kind: 'press', subject: 'Vol', body: 'News', sender_id: ob.id }));
  assert.equal(await fromOf(vol.blast.id), media.raw, 'the press default, not their pick');
  assert.ok(resend.sent.every((m) => m.from === media.raw));

  // The campaign's own address over a default: sender_id null, the desk only.
  resend.sent.length = 0;
  const sys = ok(await mgr.action('blast.send', { kind: 'press', subject: 'System', body: 'News', sender_id: null }));
  assert.equal(await fromOf(sys.blast.id), null, 'null: MAIL_FROM, not the press default');
  assert.ok(resend.sent.length === 2 && resend.sent.every((m) => m.from === process.env.MAIL_FROM));
  const volSys = ok(await val.action('blast.send', { kind: 'press', subject: 'Vol system', body: 'News', sender_id: null }));
  assert.equal(await fromOf(volSys.blast.id), media.raw, 'a volunteer’s null is ignored too');

  // None named: the kind's default (email for a newsletter).
  const news = ok(await mgr.action('blast.send', { kind: 'newsletter', subject: 'News', body: 'Hi' }));
  assert.equal(await fromOf(news.blast.id), ob.raw);

  // A removed id.
  const temp = ok(await mgr.action('sender.save', { name: 'Temp', email: 'temp2@example.org' })).sender;
  ok(await mgr.action('sender.remove', { id: temp.id }));
  const old = await mgr.action('blast.send', { kind: 'press', subject: 'Old', body: 'News', sender_id: temp.id });
  assert.deepEqual([old.status, old.json.error], [400, 'That From address was removed — pick another']);

  // Send me a test goes from the chosen From too.
  resend.sent.length = 0;
  const t = ok(await mgr.action('blast.test', { kind: 'press', subject: 'Test', body: 'Hi', sender_id: ob.id }));
  assert.equal(t.sent, true);
  assert.equal(resend.sent.at(-1).from, ob.raw);

  // Saved while email was off, sent later: from the address it was saved with.
  delete process.env.RESEND_API_KEY;
  const later = ok(await mgr.action('blast.send', { kind: 'press', subject: 'Later', body: 'News', sender_id: ob.id }));
  useResend();
  ok(await mgr.action('sender.default', { use: 'press', id: null }));
  resend.sent.length = 0;
  ok(await mgr.action('blast.resend', { id: later.blast.id }));
  assert.ok(resend.sent.length === 2 && resend.sent.every((m) => m.from === ob.raw), 'Try again keeps the From');

  // No defaults: MAIL_FROM, as before.
  ok(await mgr.action('sender.default', { use: 'email', id: null }));
  resend.sent.length = 0;
  const plain = ok(await mgr.action('blast.send', { kind: 'press', subject: 'Plain', body: 'News' }));
  assert.equal(await fromOf(plain.blast.id), null);
  assert.ok(resend.sent.every((m) => m.from === SYSTEM));
  ok(await mgr.action('sender.default', { use: 'press', id: media.id }));
});

test('the A/B winner goes from the send’s From', async () => {
  const { senders: list } = await senders();
  const ob = list.find((s) => s.email === 'ob@example.org');
  for (let i = 0; i < 50; i += 1) ok(await mgr.action('subscription.add', { email: mail(`r${i}`) }));
  resend.sent.length = 0;
  const r = ok(await mgr.action('blast.send', {
    kind: 'newsletter', subject: 'A', body: 'Hi', sender_id: ob.id, ab: { subject_b: 'B', pct: 10, wait_hours: 1, metric: 'opens' },
  }));
  const first = resend.sent.length;
  assert.ok(first > 0 && first < 52);
  await db.query(`update jobs set run_at = now() where workspace_id = $1 and kind = 'abtests.winner' and status = 'pending'`, [ws]);
  await runDueJobs(db, { workspaceId: ws });
  assert.ok(resend.sent.length > first, 'the rest went');
  assert.ok(resend.sent.every((m) => m.from === ob.raw), 'every copy, the winner’s too');
  assert.equal(await fromOf(r.blast.id), ob.raw);
});

test('system mail stays on MAIL_FROM: an invite and a ladder email, with a press default set', async () => {
  assert.ok((await senders()).defaults.press, 'a press default is set');
  resend.sent.length = 0;
  ok(await mgr.action('member.invite', { email: mail('invitee'), role: 'volunteer' }));
  assert.equal(resend.sent.at(-1).from, SYSTEM);

  const lad = ok(await mgr.action('ladder.create', {
    name: 'Thanks', trigger: { kind: 'tag', ref: 'thanked-snd' },
    steps: [{ kind: 'email', subject: 'Thanks', body: 'Thank you. — {{ campaign }}' }],
  })).ladder;
  ok(await mgr.action('ladder.setActive', { id: lad.id, active: true }));
  const p = await mgr.createPerson('Lou Example', { email: mail('lou') });
  ok(await mgr.action('subscription.add', { email: mail('lou') }));
  ok(await mgr.action('person.update', { id: p.id, tags: ['thanked-snd'] }));
  resend.sent.length = 0;
  for (let i = 0; i < 5; i += 1) {
    await db.query("update jobs set run_at = now() - interval '1 second' where workspace_id = $1 and status = 'pending' and kind = 'ladder.step'", [ws]);
    if ((await runDueJobs(db, { workspaceId: ws })).ran === 0) break;
  }
  const ladderMail = resend.sent.find((m) => m.to === mail('lou'));
  assert.ok(ladderMail, 'the ladder emailed Lou');
  assert.equal(ladderMail.from, SYSTEM);
});

test('every From address change is on the hash chain', async () => {
  const evs = ok(await mgr.get('/api/events?since=0&limit=5000')).events.filter((e) => e.action.startsWith('sender.'));
  assert.ok(evs.length >= 5 && evs.every((e) => e.entity_type === 'sender'));
  assert.equal(ok(await mgr.get('/api/audit/verify')).ok, true);
});
