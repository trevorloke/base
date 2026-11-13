// The Media area (server/ext/media): reporters and influencers are people
// tagged media or influencer (any capitals) with an outlet, beat and note;
// only the desk adds or changes them, and only the desk sees their email
// and phone. A release (a blast of kind press) goes to media, influencers or
// both, honours do-not-email and do-not-contact (not the newsletter), and
// carries its own unsubscribe link, which takes the reporter off the media
// list only. Someone holding Media but not Outreach does the whole job
// through media.*. The email service is a stand-in (fake-mail.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';
import { runDueJobs } from '../lib/jobs.js';
import { startFakeMail } from './fake-mail.js';

const tag = Math.random().toString(36).slice(2, 8);
const mail = (who) => `${who}.md.${tag}@example.org`;
const KEYS = ['MAIL_PROVIDER', 'MAIL_FROM', 'RESEND_API_KEY', 'RESEND_API_BASE', 'SENDGRID_API_KEY', 'STARBASE_PUBLIC_URL', 'MAILCHIMP_API_KEY', 'MAILCHIMP_API_BASE'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const BROWSER = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
// A 1×1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
let db, resend;

const emailOn = () => {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, { RESEND_API_KEY: 're_test_key', RESEND_API_BASE: resend.url, MAIL_FROM: 'Imagine Surrey <team@example.org>', STARBASE_PUBLIC_URL: 'https://base.example' });
};
const ok = (r, msg = '') => { assert.equal(r.status, 200, `${msg} ${JSON.stringify(r.json)}`); return r.json; };
const pub = (path, init = {}) => app.request(path, { redirect: 'manual', ...init, headers: { 'user-agent': BROWSER, ...(init.headers || {}) } });
const tokenOf = (m) => (m.body.html.match(/\/o\/([A-Za-z0-9_-]{24})\.gif/) || [])[1];
const unsubOf = (m) => (m.body.text.match(/\/bu\/([0-9a-f-]{36})$/) || [])[1];
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

test('contacts: add, an existing email, save, swap the kind, remove and add back; only the desk', async () => {
  const { mgr, ws, vol } = await campaign();
  const dana = ok(await mgr.action('media.contact.add', { name: 'Dana Example', kind: 'media', email: mail('dana'), outlet: 'Example Daily', beat: 'City hall' }));
  assert.ok(dana.person_id && !dana.existing);
  const lee = await person(mgr, 'Lee Example', mail('lee'), ['volunteer']);
  const again = ok(await mgr.action('media.contact.add', { name: 'Lee E.', kind: 'influencer', email: mail('LEE').toUpperCase(), outlet: 'Example Radio' }));
  assert.deepEqual([again.person_id, again.existing], [lee.id, true], 'the person already in People, by email whatever its capitals');
  const tagsOf = async (id) => (await db.query('select tags from persons where id = $1', [id])).rows[0].tags;
  assert.deepEqual(await tagsOf(lee.id), ['volunteer', 'influencer']);
  const row = async (id) => (await db.query('select outlet, beat, note, left_at, left_how from media_contacts where workspace_id = $1 and person_id = $2', [ws, id])).rows[0];
  assert.equal((await row(lee.id)).outlet, 'Example Radio');
  // What the desk typed fills what Lee's record lacks, never what it has.
  ok(await mgr.action('person.update', { id: lee.id, socials: { x: 'leeonx' } }));
  ok(await mgr.action('media.contact.add', { name: 'Lee E.', kind: 'influencer', email: mail('lee'), phone: '604-555-0177', socials: { x: 'other', instagram: 'lee.example' } }));
  const leeNow = (await db.query('select phone, socials from persons where id = $1', [lee.id])).rows[0];
  assert.deepEqual([leeNow.phone, leeNow.socials.x, leeNow.socials.instagram], ['604-555-0177', 'leeonx', 'lee.example']);

  ok(await mgr.action('media.contact.save', { person_id: lee.id, kind: 'media', beat: 'Transit', note: 'Prefers email' }));
  assert.deepEqual(await tagsOf(lee.id), ['volunteer', 'media'], 'the kind swaps the tag');
  ok(await mgr.action('media.contact.save', { person_id: lee.id, outlet: '' }));
  assert.deepEqual(await row(lee.id), { outlet: null, beat: 'Transit', note: 'Prefers email', left_at: null, left_how: null }, '"" clears; unsent fields stay');
  const stranger = await person(mgr, 'Not Media', mail('nm'), []);
  assert.equal((await mgr.action('media.contact.save', { person_id: stranger.id, outlet: 'X' })).status, 404);

  ok(await mgr.action('media.contact.remove', { person_id: dana.person_id }));
  assert.deepEqual(await tagsOf(dana.person_id), [], 'both tags off');
  assert.equal((await row(dana.person_id)).left_how, 'desk');
  assert.ok((await mgr.get(`/api/persons/${dana.person_id}`)).json.person, 'still in People');
  ok(await mgr.action('media.contact.add', { name: 'Dana Example', kind: 'media', email: mail('dana') }));
  assert.deepEqual(await row(dana.person_id), { outlet: 'Example Daily', beat: 'City hall', note: null, left_at: null, left_how: null }, 'added back with her outlet');

  // A volunteer granted Media sends releases, never edits who is on file.
  assert.equal((await vol.action('media.contact.add', { name: 'Vee', kind: 'media', email: mail('vee') })).status, 403);
  assert.equal((await vol.action('media.contact.save', { person_id: lee.id, outlet: 'X' })).status, 403);
  assert.equal((await vol.action('media.contact.remove', { person_id: lee.id })).status, 403);
  const evs = ok(await mgr.get('/api/events?since=0&limit=1000')).events.filter((e) => e.entity_type === 'media_contact');
  assert.ok(evs.length >= 5);
});

test('media.send: to media, to influencers, to both; any capitals; do-not tags left out, the newsletter not asked', async () => {
  const { mgr } = await campaign();
  await person(mgr, 'Ann Example', mail('ann'), ['media']);
  const bo = await person(mgr, 'Bo Example', mail('bo'), ['Media']); // typed with a capital
  await person(mgr, 'Ivy Example', mail('ivy'), ['influencer']);
  await person(mgr, 'Dee Example', mail('dee'), ['media', 'do-not-email']);
  await person(mgr, 'Eli Example', mail('eli'), ['media', 'Do-Not-Contact']);
  await person(mgr, 'Cy Example', mail('cy'), ['media']);
  ok(await mgr.action('subscription.add', { email: mail('cy') }));
  const cy = (await db.query('select id from subscriptions where email = $1 and workspace_id = (select workspace_id from persons where id = $2)', [mail('cy'), bo.id])).rows[0];
  ok(await mgr.action('subscription.remove', { id: cy.id })); // left the newsletter, still a reporter

  const media = ok(await mgr.action('media.send', { subject: 'To media', body: 'News' }));
  assert.deepEqual(await sentTo(media.blast.id), [mail('ann'), mail('bo'), mail('cy')].sort());
  const infl = ok(await mgr.action('media.send', { subject: 'To influencers', body: 'News', to: { kinds: ['influencer'] } }));
  assert.deepEqual(await sentTo(infl.blast.id), [mail('ivy')]);
  const both = ok(await mgr.action('media.send', { subject: 'To both', body: 'News', to: { kinds: ['media', 'influencer'] } }));
  assert.deepEqual(await sentTo(both.blast.id), [mail('ann'), mail('bo'), mail('cy'), mail('ivy')].sort());
  assert.equal(both.blast.status, 'sent');

  // An old client's blast.send kind press: media only, as before.
  const old = ok(await mgr.action('blast.send', { kind: 'press', subject: 'Old', body: 'News' }));
  assert.deepEqual(await sentTo(old.blast.id), [mail('ann'), mail('bo'), mail('cy')].sort());

  const read = ok(await mgr.get('/api/media/contacts'));
  assert.deepEqual(read.counts, { media: 5, influencer: 1, emailable: { media: 3, influencer: 1, all: 4 }, lists: { op_ed: 0, letters: 0, show: 0 } });
  const why = Object.fromEntries(read.contacts.map((c) => [c.person.name, [c.reachable, c.why]]));
  assert.deepEqual(why['Dee Example'], [false, 'do_not_email']);
  assert.deepEqual(why['Eli Example'], [false, 'do_not_contact']);
  assert.deepEqual(why['Cy Example'], [true, null]);
  assert.deepEqual(read.contacts.find((c) => c.person.name === 'Ann Example').last, {
    release_id: old.blast.id, subject: 'Old', sent_at: read.contacts.find((c) => c.person.name === 'Ann Example').last.sent_at, opened: false, bounced: false,
  });
  assert.deepEqual(read.contacts.map((c) => c.kind), ['media', 'media', 'media', 'media', 'media', 'influencer'], 'media first');
});

test('staff denied Outreach but holding Media does the whole job; the queued release is in their list', async () => {
  const { mgr, staff } = await campaign();
  await person(mgr, 'Ann Example', mail('ann'), ['media']);
  assert.equal((await staff.action('blast.picture', { data: PNG })).status, 403, 'Outreach’s own names are closed to them');
  assert.equal((await staff.get('/api/blasts')).status, 403);
  const pic = ok(await staff.action('media.picture', { data: PNG, name: 'p.png' }));
  assert.match(pic.media.url, /^\/media\//);
  const extra = ok(await staff.action('media.attach', { data: Buffer.from('later').toString('base64'), name: 'later.txt' }));
  ok(await staff.action('media.unattach', { id: extra.attachment.id }), 'and takes one back');
  const file = ok(await staff.action('media.attach', { data: Buffer.from('hello').toString('base64'), name: 'notes.txt' }));
  resend.sent.length = 0;
  const t = ok(await staff.action('media.test', { subject: 'Draft', body: `See ![p](${pic.media.url})`, attachment_ids: [file.attachment.id] }));
  assert.equal(t.sent, true);
  assert.match(resend.sent.at(-1).subject, /^\[Test\] Draft/);
  delete process.env.RESEND_API_KEY;
  try {
    const r = ok(await staff.action('media.send', { subject: 'Saved', body: 'News', attachment_ids: [file.attachment.id] }));
    assert.equal(r.blast.status, 'queued');
    const list = ok(await staff.get('/api/media/releases')).releases;
    assert.equal(list.length, 1);
    assert.deepEqual([list[0].id, list[0].status, list[0].queued_count, list[0].retry_count], [r.blast.id, 'queued', 1, 1]);
    assert.equal(list[0].attachments[0].filename, 'notes.txt');
    assert.equal(list[0].body, undefined, 'the list carries no bodies');
    assert.equal(ok(await staff.get('/api/media/releases')).emailConfigured, false, 'Send now waits for email');
  } finally { emailOn(); }
  assert.equal(ok(await staff.get('/api/media/releases')).emailConfigured, true);
  // Press releases' own stats: staff denied Outreach can't read /blasts/stats' every send.
  ok(await mgr.action('subscription.add', { email: mail('reader') }));
  ok(await mgr.action('blast.send', { kind: 'newsletter', subject: 'Not press', body: 'Hi' }));
  const stats = ok(await staff.get('/api/media/stats'));
  assert.deepEqual(stats.stats.map((x) => x.id), [(await staff.get('/api/media/releases')).json.releases[0].id], 'press only');
  assert.equal(stats.ab.min, 50);
  const go = ok(await staff.action('media.resend', { id: (await staff.get('/api/media/releases')).json.releases[0].id }));
  assert.equal(go.resent.sent, 1);
});

test('a volunteer granted Media reads names, outlets and socials — never an email or a phone; others get 403', async () => {
  const { mgr, vol, plain } = await campaign();
  ok(await mgr.action('media.contact.add', { name: 'Dana Example', kind: 'media', email: mail('dana'), phone: '604-555-0161', outlet: 'Example Daily' }));
  ok(await mgr.action('media.contact.add', { name: 'Sam Example', kind: 'influencer', email: mail('sam'), phone: '604-555-0163', socials: { instagram: '@samexample' } }));
  const desk = ok(await mgr.get('/api/media/contacts')).contacts;
  assert.equal(desk[0].person.phone, '604-555-0161');
  const seen = ok(await vol.get('/api/media/contacts')).contacts;
  assert.equal(seen.length, 2);
  for (const c of seen) { assert.equal(c.person.email, null); assert.equal(c.person.phone, null); }
  assert.equal(seen[0].outlet, 'Example Daily');
  // Stored as a person's page stores a handle (shared/socials.js).
  assert.deepEqual(seen[1].person.socials, { instagram: 'samexample' });
  assert.equal((await plain.get('/api/media/contacts')).status, 403);
  assert.equal((await plain.get('/api/media/releases')).status, 403);
  assert.equal((await plain.get('/api/media/stats')).status, 403);
  assert.equal((await plain.action('media.send', { subject: 'S', body: 'B' })).status, 403);
  // The volunteer sends one; the release page has no addresses or tokens.
  const r = ok(await vol.action('media.send', { subject: 'From a volunteer', body: 'News' }));
  const page = ok(await vol.get(`/api/media/releases/${r.blast.id}`));
  assert.equal(page.recipients.length, 1);
  assert.ok(!JSON.stringify(page).includes(mail('dana')), 'no address');
});

test('socials typed when adding a contact are read as a person’s page reads them; a short link is refused in its words', async () => {
  const { mgr } = await campaign();
  const r = ok(await mgr.action('media.contact.add', {
    name: 'Lee Example', kind: 'influencer', socials: { facebook: 'https://www.instagram.com/lee.example/', tiktok: '@leeexample' },
  }));
  const c = ok(await mgr.get('/api/media/contacts')).contacts.find((x) => x.person.id === r.person_id);
  assert.deepEqual(c.person.socials, { instagram: 'lee.example', tiktok: 'leeexample' });
  const bad = await mgr.action('media.contact.add', { name: 'Kim Example', kind: 'influencer', socials: { tiktok: 'https://vm.tiktok.com/abc' } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /^TikTok: That’s a short link/);
});

test('a release’s own unsubscribe: off the media list only — no do-not-email, the newsletter kept, nothing to Mailchimp', async () => {
  const { mgr, ws } = await campaign();
  const ann = await person(mgr, 'Ann Example', mail('ann'), ['media', 'influencer', 'host']);
  ok(await mgr.action('subscription.add', { email: mail('ann') }));
  resend.sent.length = 0;
  const r = ok(await mgr.action('media.send', { subject: 'Release', body: 'News https://example.org/video' }));
  const m = resend.sent.find((x) => x.to === mail('ann'));
  assert.match(m.body.text, /Don’t want press releases\? Unsubscribe: https:\/\/base\.example\/bu\/[0-9a-f-]{36}$/);
  assert.match(m.body.html, /Don’t want press releases\? <a href="https:\/\/base\.example\/bu\//);
  assert.match(m.body.headers['List-Unsubscribe'], /^<https:\/\/base\.example\/bu\/[0-9a-f-]{36}>$/);
  assert.equal(m.body.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  const rid = unsubOf(m);
  const ask = await pub(`/bu/${rid}`);
  assert.match(await ask.text(), /Unsubscribe from press releases from/);

  // Mailchimp connected: its hook would hear of a do-not-email or a newsletter unsubscribe.
  Object.assign(process.env, { MAILCHIMP_API_KEY: 'mc-test-us1', MAILCHIMP_API_BASE: 'http://127.0.0.1:9' });
  try {
    const done = await pub(`/bu/${rid}`, { method: 'POST' });
    assert.equal(done.status, 200);
    assert.match(await done.text(), /You won’t get press releases from Media \d+ \w+ again\./);
    const p = (await db.query('select tags from persons where id = $1', [ann.id])).rows[0];
    assert.deepEqual(p.tags, ['host'], 'both media tags off, nothing added');
    const row = (await db.query('select left_how, left_at from media_contacts where workspace_id = $1 and person_id = $2', [ws, ann.id])).rows[0];
    assert.equal(row.left_how, 'link');
    assert.equal((await db.query('select status from subscriptions where workspace_id = $1 and email = $2', [ws, mail('ann')])).rows[0].status, 'subscribed');
    assert.equal((await db.query(`select count(*)::int as n from jobs where workspace_id = $1 and kind = 'mailchimp.optout'`, [ws])).rows[0].n, 0, 'nothing for Mailchimp');
    // The control: a do-not-email tag does reach Mailchimp's hook.
    const ctl = await person(mgr, 'Ctl Example', mail('ctl'), []);
    ok(await mgr.action('person.update', { id: ctl.id, tags: ['do-not-email'] }));
    assert.equal((await db.query(`select count(*)::int as n from jobs where workspace_id = $1 and kind = 'mailchimp.optout'`, [ws])).rows[0].n, 1);
  } finally { emailOn(); }

  const history = ok(await mgr.get(`/api/persons/${ann.id}/timeline`));
  const left = history.entries.find((e) => e.kind === 'media');
  assert.deepEqual([left.title, left.detail], ['Left the media list', 'Used the link in a release']);
  const back = await mgr.action('media.contact.add', { name: 'Ann Example', kind: 'media', email: mail('ann') });
  assert.equal(back.status, 409);
  assert.match(back.json.error, /^They asked to stop getting releases on \w{3} \d+, \d{4}$/);
  assert.equal(ok(await mgr.get(`/api/media/releases/${r.blast.id}`)).recipients.length, 1, 'the send keeps its record');
  assert.equal(ok(await mgr.get('/api/audit/verify')).ok, true);
});

test('an A/B release: a contact who unsubscribes during the wait is skipped; the winner’s copies carry the link', async () => {
  const { mgr, ws } = await campaign();
  for (let i = 0; i < 50; i += 1) await person(mgr, `Rep ${i} Example`, mail(`rep${i}`), ['media']);
  resend.sent.length = 0;
  const r = ok(await mgr.action('media.send', {
    subject: 'Plain', body: 'News', ab: { subject_b: 'Better', pct: 10, wait_hours: 1, metric: 'opens' },
  }));
  assert.equal(resend.sent.length, 10);
  const first = resend.sent[0];
  const held = (await rowsOf(r.blast.id)).filter((x) => x.ab_group === 'rest');
  assert.equal(held.length, 40);
  // One of the held ones leaves by a link from an earlier release (the same address).
  const other = ok(await mgr.action('media.send', { subject: 'Earlier', body: 'News' }));
  const leaver = (await rowsOf(other.blast.id)).find((x) => x.email === held[0].email);
  assert.equal((await pub(`/bu/${leaver.id}`, { method: 'POST' })).status, 200);
  assert.ok(unsubOf(first), 'A and B carry it too');
  // During the wait the page says the rest wait for the winner: nothing to try again.
  const wait = ok(await mgr.get(`/api/media/releases/${r.blast.id}`));
  assert.equal(wait.release.ab_status, 'testing');
  assert.equal(wait.release.retry_count - wait.release.held_count, 0, 'Try again has nothing to send');
  assert.equal(wait.release.held_count, 39, 'the one who left is not waiting');
  assert.ok(wait.release.first_sent_at, 'A and B went');
  assert.equal(wait.recipients.filter((x) => x.held).length, 40);
  assert.equal(wait.recipients.filter((x) => x.status === 'sent' && !x.held).length, 10);
  resend.sent.length = 0;
  await db.query(`update jobs set run_at = now() where workspace_id = $1 and kind = 'abtests.winner' and status = 'pending'`, [ws]);
  await runDueJobs(db, { workspaceId: ws });
  assert.equal(resend.sent.length, 39, 'everyone held but the one who left');
  assert.ok(!resend.sent.some((m) => m.to === held[0].email), 'never emailed');
  for (const m of resend.sent) {
    assert.ok(unsubOf(m), 'the press link in the words');
    assert.match(m.body.headers['List-Unsubscribe'], /\/bu\/[0-9a-f-]{36}>$/);
  }
});

test('a release’s page: opened and bounced per person, no tokens or addresses; media.resend is for releases only', async () => {
  const { mgr } = await campaign();
  const ann = await person(mgr, 'Ann Example', mail('ann'), ['media']);
  await person(mgr, 'Bo Example', mail('bo'), ['media']);
  ok(await mgr.action('media.contact.save', { person_id: ann.id, outlet: 'Example Daily' }));
  resend.sent.length = 0;
  const r = ok(await mgr.action('media.send', { subject: 'Release', body: 'News' }));
  const toAnn = resend.sent.find((m) => m.to === mail('ann'));
  assert.equal((await pub(`/o/${tokenOf(toAnn)}.gif`)).status, 200);
  await db.query('update blast_recipients set bounced_at = now() where blast_id = $1 and email = $2', [r.blast.id, mail('bo')]);
  const page = ok(await mgr.get(`/api/media/releases/${r.blast.id}`));
  assert.equal(page.release.body, 'News');
  assert.deepEqual([page.release.opened, page.release.bounced, page.release.sent_count], [1, 1, 2]);
  const byName = Object.fromEntries(page.recipients.map((x) => [x.name, x]));
  assert.ok(byName['Ann Example'].opened_at);
  assert.equal(byName['Ann Example'].outlet, 'Example Daily');
  assert.equal(byName['Bo Example'].opened_at, null);
  assert.equal(byName['Bo Example'].bounced, true);
  const raw = JSON.stringify(page);
  assert.ok(!raw.includes(tokenOf(toAnn)) && !raw.includes(mail('ann')), 'no tokens, no addresses');
  assert.ok(page.recipients.every((x) => !('email' in x) && !('token' in x)));

  // Contacts' "Last release": a bounce says so, and a later release that
  // failed to send isn't one they ignored — Ann's stays "Opened".
  resend.fail(500);
  const failed = ok(await mgr.action('media.send', { subject: 'Failed one', body: 'News' }));
  resend.fail(false);
  assert.ok((await rowsOf(failed.blast.id)).every((x) => x.status === 'failed'));
  const last = Object.fromEntries(ok(await mgr.get('/api/media/contacts')).contacts.map((c) => [c.person.name, c.last]));
  assert.deepEqual([last['Ann Example'].release_id, last['Ann Example'].opened], [r.blast.id, true]);
  assert.deepEqual([last['Bo Example'].release_id, last['Bo Example'].bounced], [r.blast.id, true]);

  ok(await mgr.action('subscription.add', { email: mail('sub') }));
  const news = ok(await mgr.action('blast.send', { kind: 'newsletter', subject: 'N', body: 'B' }));
  assert.equal((await mgr.action('media.resend', { id: news.blast.id })).status, 404);
  assert.equal((await mgr.get(`/api/media/releases/${news.blast.id}`)).status, 404);
});

test('merging two records moves the media row (no merge code changed)', async () => {
  const { mgr, ws } = await campaign();
  const keep = await person(mgr, 'Kay Example', mail('kay'), []);
  const drop = ok(await mgr.action('media.contact.add', { name: 'Kay E.', kind: 'media', email: mail('kay2'), outlet: 'Example Weekly' }));
  ok(await mgr.action('person.merge', { keep: keep.id, drop: drop.person_id }));
  const rows = (await db.query('select person_id, outlet from media_contacts where workspace_id = $1', [ws])).rows;
  assert.deepEqual(rows, [{ person_id: keep.id, outlet: 'Example Weekly' }]);
});

test('someone who left by a release’s link stays off: a tag put back or a merge doesn’t send them another', async () => {
  const { mgr, ws } = await campaign();
  const ann = await person(mgr, 'Ann Example', mail('annl'), ['media']);
  const bo = await person(mgr, 'Bo Example', mail('bowork'), ['media']);
  await person(mgr, 'Cy Example', mail('cy'), ['media']);
  const deeOld = await person(mgr, 'Dee Example', mail('deeold'), ['media']);
  resend.sent.length = 0;
  ok(await mgr.action('media.send', { subject: 'First', body: 'News' }));
  for (const who of [mail('annl'), mail('bowork'), mail('deeold')]) {
    const rid = unsubOf(resend.sent.find((x) => x.to === who));
    assert.equal((await pub(`/bu/${rid}`, { method: 'POST' })).status, 200);
  }
  // The desk puts Ann's tag back; Bo has a second record, tagged media, merged into the one that left.
  ok(await mgr.action('person.update', { id: ann.id, tags: ['media'] }));
  const home = await person(mgr, 'Bo Example', mail('bohome'), ['media']);
  ok(await mgr.action('person.merge', { keep: bo.id, drop: home.id }));
  // Dee's new record, added at the desk with an outlet, keeps the old one that left.
  const dee = ok(await mgr.action('media.contact.add', { name: 'Dee Example', kind: 'media', email: mail('deenew'), outlet: 'Example Weekly' }));
  ok(await mgr.action('person.merge', { keep: dee.person_id, drop: deeOld.id }));
  // A record with the address that left, made fresh.
  await person(mgr, 'Ann E.', mail('annl'), ['influencer']);
  const r = ok(await mgr.action('media.send', { subject: 'Second', body: 'More news', audience: { media: ['media', 'influencer'] } }));
  assert.deepEqual(await sentTo(r.blast.id), [mail('cy')]);
  const contacts = ok(await mgr.get('/api/media/contacts')).contacts;
  const why = Object.fromEntries(contacts.map((c) => [c.person.email, c.why]));
  assert.equal(why[mail('annl')], 'left_media');
  assert.equal(why[mail('bowork')], 'left_media');
  assert.equal(why[mail('deenew')], 'left_media');
  assert.equal(why[mail('cy')], null);
  assert.equal((await db.query("select left_how from media_contacts where workspace_id = $1 and person_id = $2", [ws, bo.id])).rows[0].left_how, 'link');
});
