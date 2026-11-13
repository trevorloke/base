// Letters' checks and notices (server/ext/letters, LTE stage 2): the
// campaign's share of an agreed letter, the overlap checks (the campaign's
// own words, shown to the writer; other writers' letters, the desk's alone)
// and the one email that tells a writer the campaign replied — never the
// letter's words.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb, Client } from './helpers.js';
import { startFakeMail } from './fake-mail.js';

const tag = Math.random().toString(36).slice(2, 8);
const KEYS = ['MAIL_PROVIDER', 'MAIL_FROM', 'RESEND_API_KEY', 'RESEND_API_BASE', 'SENDGRID_API_KEY', 'STARBASE_PUBLIC_URL', 'BASE_PATH'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const mail = (who) => `${who}.lc.${tag}@example.org`;
const ok = (r, msg = '') => { assert.equal(r.status, 200, `${msg} ${JSON.stringify(r.json)}`); return r.json; };
const cid = () => randomUUID();
const BODY = 'Surrey needs more buses on the King George corridor, and it needs them before the next school year starts in the fall.';
const REWRITE = 'Our city deserves frequent transit service along every major road, and council should fund it in this budget without delay or excuses.';
const POINTS = 'Council cut the transit budget by four million dollars last spring. Ask for it back.';
const RELEASE = '<p>Today the campaign said <strong>every neighbourhood deserves a bus within a short walk of home</strong>.</p>';
let db, fake, mgr, ws, vic, vicId, wen;

before(async () => {
  db = await freshDb();
  for (const k of KEYS) delete process.env[k];
  fake = await startFakeMail({ provider: 'resend' });
  mgr = new Client();
  const r = await mgr.signup({ workspaceName: `Letter checks ${tag}`, email: mail('mgr'), jurisdiction: 'bc-municipal' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  ws = r.json.workspace.id;
  const join = async (name) => {
    const inv = ok(await mgr.action('member.invite', { email: mail(name), role: 'volunteer' }));
    const c = new Client();
    const j = ok(await c.post('/api/auth/join', { token: inv.joinUrl.split('/join/')[1], name: `${name[0].toUpperCase()}${name.slice(1)} Example`, password: 'letters-pass-1234' }));
    return { c, id: j.user.id };
  };
  ({ c: vic, id: vicId } = await join('vic'));
  ({ c: wen } = await join('wen'));
});
after(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  fake?.close?.();
});

let n = 0;
const outlet = async (extra = {}) => {
  n += 1;
  return ok(await mgr.action('media.outlet.save', { name: `Check Paper ${n}`, kind: 'paper', letters_email: `checks${n}@example.org`, letters_limit: 250, ...extra })).outlet;
};
const submit = (c, extra = {}) => c.action('myletter.submit', { client_id: cid(), kind: 'letter', body: BODY, outlet_ids: [], ...extra });
const mine = async (c, id) => ok(await c.get(`/api/letters/mine/${id}`)).letter;
const desk = async (id) => ok(await mgr.get(`/api/media/letters/${id}`)).letter;
const newest = (l) => l.drafts[l.drafts.length - 1];
const row = async (id) => (await db.query('select * from letters where id = $1', [id])).rows[0];
const sentTo = (who) => fake.sent.filter((m) => m.to === who || (Array.isArray(m.to) && m.to.includes(who)) || String(m.to).includes(who));

test('the campaign’s share: a rewrite taken in full is ≥ 0.9 and flagged on the queue; Keep mine is 0; never on the log', async () => {
  const a = ok(await submit(vic)).letter;
  ok(await mgr.action('letter.suggest', { id: a.id, body: REWRITE }));
  let w = await mine(vic, a.id);
  // Taken in full: the writer's draft is the campaign's words.
  ok(await vic.action('myletter.revise', { id: a.id, body: REWRITE, client_id: cid(), from_version: newest(w).id }));
  assert.ok((await desk(a.id)).campaign_share >= 0.9, 'the live share on the desk read');
  w = await mine(vic, a.id);
  ok(await vic.action('myletter.agree', { id: a.id, version_id: newest(w).id }));
  assert.ok((await row(a.id)).agreed_campaign_share >= 0.9);
  const q = ok(await mgr.get('/api/media/letters')).letters.find((x) => x.id === a.id);
  assert.equal(q.mostly_campaign, true);
  assert.equal(q.size, REWRITE.split(/\s+/).length);
  assert.ok(!('campaign_share' in w), 'the writer’s read has no share');

  // Keep mine: the writer's own text again.
  const b = ok(await submit(vic)).letter;
  ok(await mgr.action('letter.suggest', { id: b.id, body: REWRITE }));
  ok(await vic.action('myletter.revise', { id: b.id, body: BODY, client_id: cid() }));
  ok(await vic.action('myletter.agree', { id: b.id, version_id: newest(await mine(vic, b.id)).id }));
  assert.equal((await row(b.id)).agreed_campaign_share, 0);
  assert.equal((await desk(b.id)).campaign_share, 0);
  assert.equal(ok(await mgr.get('/api/media/letters')).letters.find((x) => x.id === b.id).mostly_campaign, false);

  const logged = (await db.query(`select payload::text as p from events where workspace_id = $1 and entity_type like 'letter%'`, [ws])).rows;
  assert.ok(logged.length > 0);
  for (const e of logged) {
    assert.ok(!/share/i.test(e.p), e.p);
    assert.ok(!e.p.includes('deserves frequent transit'), e.p);
  }
});

test('overlap: the talking points and a release of 10 days ago show to the writer; 70 days ago doesn’t; other writers’ letters warn the desk only, same newsroom first', async () => {
  ok(await mgr.action('letter.points', { text: POINTS }));
  const quotesPoints = `I was shocked to read that council cut the transit budget by four million dollars last spring. ${BODY}`;
  const p = ok(await submit(vic, { body: quotesPoints })).letter;
  let w = await mine(vic, p.id);
  assert.deepEqual(w.campaign_words.map((x) => x.source), ['points']);
  assert.equal(w.campaign_words[0].run, 'council cut the transit budget by four million dollars last spring');
  assert.equal(quotesPoints.slice(w.campaign_words[0].start, w.campaign_words[0].end).toLowerCase(), w.campaign_words[0].run.toLowerCase());
  assert.equal((await desk(p.id)).campaign_words.length, 1, 'the desk sees it too');
  // Seven words of the points: nothing.
  const seven = ok(await submit(vic, { body: `Council cut the transit budget by four. ${BODY}` })).letter;
  assert.deepEqual((await mine(vic, seven.id)).campaign_words, []);

  // Releases: one sent 10 days ago, one 70 days ago, one never sent.
  const blast = (days, status = 'sent', body = RELEASE) => db.query(
    `insert into blasts (id, workspace_id, kind, subject, body, status, sent_at) values ($1, $2, 'press', 'Buses for every neighbourhood', $3, $4, now() - make_interval(days => $5))`,
    [randomUUID(), ws, body, status, days],
  );
  await blast(10);
  await blast(70, 'sent', '<p>An old release: we will plant ten thousand trees along the new greenway this year.</p>');
  await blast(1, 'queued', '<p>Not sent: the library should stay open late on every weekday evening for students.</p>');
  const r = ok(await submit(vic, { body: `I agree that every neighbourhood deserves a bus within a short walk of home. ${BODY}` })).letter;
  w = await mine(vic, r.id);
  assert.equal(w.campaign_words.length, 1);
  assert.equal(w.campaign_words[0].source, 'release');
  assert.equal(w.campaign_words[0].release.subject, 'Buses for every neighbourhood');
  const old = ok(await submit(vic, { body: `We will plant ten thousand trees along the new greenway this year, they say. ${BODY}` })).letter;
  assert.deepEqual((await mine(vic, old.id)).campaign_words, []);
  const queued = ok(await submit(vic, { body: `The library should stay open late on every weekday evening for students. ${BODY}` })).letter;
  assert.deepEqual((await mine(vic, queued.id)).campaign_words, []);

  // Other writers: two papers in one newsroom, and one elsewhere.
  const daily = await outlet({ newsroom: 'Example Media Group' });
  const weekly = await outlet({ newsroom: 'example media group ' });
  const far = await outlet({ newsroom: 'Another Example Group' });
  const shared = 'the bridge to nowhere has cost this city far too much already';
  const mineL = ok(await submit(vic, { body: `In my view ${shared}. Fix the buses.`, outlet_ids: [daily.id] })).letter;
  const farL = ok(await submit(wen, { body: `Honestly, ${shared}, and more besides, if you ask me.`, outlet_ids: [far.id] })).letter;
  const sister = ok(await submit(wen, { body: `Friends: ${shared}.`, outlet_ids: [weekly.id] })).letter;
  const d = await desk(mineL.id);
  assert.deepEqual(d.overlaps.map((o) => [o.letter_id, o.same_newsroom, o.outlet_name]), [
    [sister.id, true, weekly.name],
    [farL.id, false, far.name],
  ]);
  assert.equal(d.overlaps[0].writer_name, 'Wen Example');
  assert.equal(d.overlaps[0].run, shared);
  // The writer sees no other writer.
  const own = await mine(vic, mineL.id);
  assert.ok(!('overlaps' in own));
  assert.deepEqual(own.campaign_words, []);
  // Vic's own other letters never count against Vic.
  assert.ok(!(await desk(p.id)).overlaps.some((o) => o.writer_name === 'Vic Example'));
});

test('the reply email: once after a suggestion, with the link and none of the letter; not again within the hour; not when turned off or bounced; a do-not-email tag doesn’t stop it', async () => {
  // No email connected: nothing sent, nothing claimed.
  const quiet = ok(await submit(vic)).letter;
  const r0 = ok(await mgr.action('letter.suggest', { id: quiet.id, body: REWRITE }));
  assert.equal(r0.email, undefined);
  assert.equal((await row(quiet.id)).emailed_at, null);

  Object.assign(process.env, { RESEND_API_KEY: 're_test_key', RESEND_API_BASE: fake.url, MAIL_FROM: 'Letters Example <team@example.org>', STARBASE_PUBLIC_URL: 'https://app.example.org' });
  const to = mail('vic');
  const before = sentTo(to).length;
  const l = ok(await submit(vic)).letter;
  const r1 = ok(await mgr.action('letter.suggest', { id: l.id, body: REWRITE, note: 'Try this secret wording' }));
  assert.equal(r1.email, 'sent');
  let got = sentTo(to).slice(before);
  assert.equal(got.length, 1);
  assert.equal(got[0].subject, 'The campaign replied about your letter');
  const text = JSON.stringify(got[0]);
  assert.ok(text.includes(`https://app.example.org/letters/${l.id}`), text);
  for (const words of ['King George', 'deserves frequent', 'secret wording', 'Check Paper']) assert.ok(!text.includes(words), words);
  assert.ok((await row(l.id)).emailed_at);

  // Within the hour: a note and a decline send nothing more.
  ok(await mgr.action('letter.note', { id: l.id, body: 'Any thoughts?' }));
  assert.equal(sentTo(to).length - before, 1);
  // An hour on: the next reply sends again.
  await db.query(`update letters set emailed_at = now() - interval '61 minutes' where id = $1`, [l.id]);
  ok(await mgr.action('letter.decline', { id: l.id, note: 'Not this one' }));
  assert.equal(sentTo(to).length - before, 2);

  // Turned off for this letter: nothing.
  const off = ok(await submit(vic, { email_me: false })).letter;
  ok(await mgr.action('letter.suggest', { id: off.id, body: REWRITE }));
  assert.equal(sentTo(to).length - before, 2);
  assert.equal((await row(off.id)).emailed_at, null);

  // Tagged do-not-email: their own letter, answered — it still goes.
  const pid = (await row(off.id)).person_id;
  await db.query(`update persons set tags = '["do-not-email"]'::jsonb where id = $1`, [pid]);
  const tagged = ok(await submit(vic)).letter;
  ok(await mgr.action('letter.note', { id: tagged.id, body: 'Thanks!' }));
  assert.equal(sentTo(to).length - before, 3);

  // Bounced for good: nothing, and nothing claimed.
  await db.query(`insert into email_suppressions (id, workspace_id, email, reason, source) values ($1, $2, $3, 'bounce', 'test')`, [randomUUID(), ws, to]);
  const bounced = ok(await submit(vic)).letter;
  ok(await mgr.action('letter.suggest', { id: bounced.id, body: REWRITE }));
  assert.equal(sentTo(to).length - before, 3);
  assert.equal((await row(bounced.id)).emailed_at, null);
  await db.query('delete from email_suppressions where workspace_id = $1', [ws]);

  // The writer's own actions never email them.
  const self = ok(await submit(vic)).letter;
  ok(await vic.action('myletter.note', { id: self.id, body: 'Hello', client_id: cid() }));
  assert.equal(sentTo(to).length - before, 3);
  assert.equal(vicId.length, 36);
});
