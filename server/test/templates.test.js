// Email templates (server/ext/templates) and what campaign email does with
// them: the campaign's own templates (save, copy, remove, restore, the
// stale-edit check), the ready-made ones (shared/email/starters.js), who
// may do what by role and area, "[first name]" and "[campaign]" filled per
// person (a name is only ever words), the placeholders that stop a send
// (shared/email/check.js), the lines at the bottom of every email (the
// website's mailing address, contact and "Authorized by"), "Use again" and
// the send list in words. The email service is a stand-in (fake-mail.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { runDueJobs } from '../lib/jobs.js';
import { startFakeMail } from './fake-mail.js';
import {
  EMAIL_FILLS, toCodes, toWords, unfilled, placeholders, firstOf, fillHtml, fillText,
} from '@starbase/shared/email/words';
import { STARTERS, STARTER_PLACEHOLDERS } from '@starbase/shared/email/starters';
import { emailProblem } from '@starbase/shared/email/check';
import { blastHtml, blastText, composeBlast } from '../ext/abtests/send.js';

const L = await import('../../web/src/components/LaddersWords.js');

const tag = Math.random().toString(36).slice(2, 8);
const mail = (who) => `${who}.tp.${tag}@example.org`;
const KEYS = ['MAIL_PROVIDER', 'MAIL_FROM', 'RESEND_API_KEY', 'RESEND_API_BASE', 'SENDGRID_API_KEY', 'STARBASE_PUBLIC_URL', 'MAILCHIMP_API_KEY', 'MAILCHIMP_API_BASE'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let db, resend;

const ok = (r, msg = '') => { assert.equal(r.status, 200, `${msg} ${JSON.stringify(r.json)}`); return r.json; };
const no = (r, status, words, msg = '') => {
  assert.equal(r.status, status, `${msg} ${JSON.stringify(r.json)}`);
  if (words) assert.equal(r.json.error, words, msg);
};

before(async () => {
  db = await freshDb();
  resend = await startFakeMail({ provider: 'resend' });
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, { RESEND_API_KEY: 're_test_key', RESEND_API_BASE: resend.url, MAIL_FROM: 'Campaign <team@example.org>', STARBASE_PUBLIC_URL: 'https://base.example' });
});
after(async () => {
  await resend.close();
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

// A campaign of its own: a manager and, as asked for (sign-ins are limited
// to 30 tries per address in 15 minutes), staff, staff denied Outreach
// (Media kept), a volunteer granted Media, one granted Outreach, a plain one.
let n = 0;
const ALL = ['staff', 'press', 'volMedia', 'volOut', 'plain'];
const campaign = async (who = []) => {
  n += 1;
  const mgr = new Client();
  const r = await mgr.signup({ name: 'Avery Example', workspaceName: `Templates ${n} ${tag}`, email: mail(`mgr${n}`), jurisdiction: 'bc-municipal' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const join = async (role, name) => {
    const inv = ok(await mgr.action('member.invite', { email: mail(`${name}${n}`), role }));
    const c = new Client();
    const j = ok(await c.post('/api/auth/join', { token: inv.joinUrl.split('/join/')[1], name: `${name} Example`, password: 'templates-pass-1234' }));
    return { c, id: j.user.id };
  };
  const out = { mgr, ws: r.json.workspace.id, name: r.json.workspace.name };
  const make = {
    staff: async () => (await join('staff', 'pat')).c,
    press: async () => { const p = await join('staff', 'sid'); ok(await mgr.action('permission.member.set', { user_id: p.id, grant: [], deny: ['outreach'] })); return p.c; },
    volMedia: async () => { const v = await join('volunteer', 'vic'); ok(await mgr.action('permission.member.set', { user_id: v.id, grant: ['media'], deny: [] })); return v.c; },
    volOut: async () => { const v = await join('volunteer', 'ola'); ok(await mgr.action('permission.member.set', { user_id: v.id, grant: ['outreach'], deny: [] })); return v.c; },
    plain: async () => (await join('volunteer', 'uma')).c,
  };
  for (const k of who) out[k] = await make[k]();
  return out;
};

const save = (c, input) => c.action('template.save', { use: 'email', subject: 'A subject', body: 'Hello [first name]', ...input });
const htmlOf = (m) => m.body.html;
const textOf = (m) => m.body.text;
const sentTo = (addr) => resend.sent.filter((m) => [].concat(m.to).includes(addr));
const setOrg = (c, org) => c.action('site.settings.save', { org });

// ── The words ──

test('email words: no [… name] test; ladders keep theirs; placeholders, links, names, escaping', () => {
  assert.equal(unfilled('Thanks, [Signer’s name]'), null);
  assert.equal(unfilled('[Join our campaign](https://x)'), null);
  assert.equal(unfilled('[Add your name](https://x)'), null);
  assert.equal(unfilled('Hi {first}'), '{first} won’t fill in — use + First name');
  assert.match(L.unfilled('Hi [name]'), /^\[name\] won’t fill in — use \+ First name$/, 'ladders flag "[name]" as before');
  assert.equal(toCodes('Hi [First Name] from [campaign]'), 'Hi {{first_name}} from {{campaign}}');
  assert.equal(toWords('Hi {{first_name}}'), 'Hi [first name]');
  assert.deepEqual(EMAIL_FILLS.map((f) => f.button), ['+ First name', '+ Campaign']);

  assert.deepEqual(placeholders('[Two lines.] [link: Read more]'), ['[Two lines.]', '[link: Read more]']);
  assert.deepEqual(placeholders('[Read more](https://example.org) ![a](/media/x) Hi [first name]'), []);
  assert.deepEqual(placeholders('[Read more](https://)'), ['a link with no address: Read more']);
  assert.deepEqual(placeholders('[Read more]()'), ['a link with no address: Read more']);
  assert.deepEqual(placeholders('Thank you for [volunteering on [day]]'), ['[volunteering on [day]]', '[day]'], 'the outer words and the one inside');

  assert.equal(firstOf({ first_name: 'JOHN' }), 'John');
  assert.equal(firstOf({ first_name: 'MARY-ANNE' }), 'Mary-anne');
  for (const keep of ['Lee', 'McKay', 'J']) assert.equal(firstOf({ first_name: keep }), keep);
  assert.equal(firstOf({ name: 'Lee Example' }), 'Lee');
  assert.equal(firstOf({ name: '' }), 'friend');
  assert.equal(firstOf({}), 'friend');
  assert.equal(firstOf({ name: 'x'.repeat(60) }).length, 40);

  assert.equal(fillHtml('<p>Hi {{first_name}}</p>', { first: '<b>&' }), '<p>Hi &lt;b&gt;&amp;</p>');
  assert.equal(fillText('Hi {{first_name}} of {{campaign}}', { first: '{{campaign}}', campaign: 'C' }), 'Hi {{campaign}} of C', 'a name is put in once, never filled again');
});

test('the ready-made templates: four newsletters first, voting days last, no facts, and each refused until filled', () => {
  const email = STARTERS.filter((s) => s.use === 'email');
  assert.equal(email.length, 12);
  assert.deepEqual(email.slice(0, 4).map((s) => s.key), ['monthly', 'short-update', 'spotlight', 'season']);
  assert.deepEqual(email.slice(-2).map((s) => s.key), ['advance', 'election-day']);
  assert.deepEqual(STARTERS.filter((s) => s.use === 'press').map((s) => s.key), ['press-release']);
  assert.ok(STARTER_PLACEHOLDERS.has('[Headline one]'));
  for (const s of STARTERS) {
    const both = `${s.subject}\n${s.body}`;
    const outside = both.replace(/\[[^\]\n]*\]?/g, ' ');
    assert.ok(s.subject.replace(/\[[^\]]*\]|\{\{\w+\}\}/g, '').length <= 50, `${s.key}: a short subject`);
    assert.doesNotMatch(outside, /\b[A-Z]{4,}\b/, `${s.key}: no shouting`);
    assert.doesNotMatch(both, /!!|Imagine Surrey|Surrey|\$\s?\d|https?:\/\/|www\.|@\w|\d{3}[-. ]\d{4}/, `${s.key}: no facts, links, addresses or numbers`);
    const first = placeholders(both)[0];
    assert.equal(emailProblem(s.subject, s.body, { from: placeholders(both) }), `Fill in the [ ] parts first: ${first}`, s.key);
    assert.equal(emailProblem(s.subject, s.body), `Fill in the [ ] parts first: ${first}`, `${s.key}: refused without the list too`);
    // Every placeholder filled with plain words: nothing stops it.
    let subject = s.subject;
    let body = s.body;
    for (const p of placeholders(both)) { subject = subject.split(p).join('words'); body = body.split(p).join('words'); }
    assert.equal(emailProblem(subject, body), null, `${s.key}: filled in, it goes`);
  }
});

// ── The campaign's own templates ──

test('save, update, copy, remove and restore; refusals in words; the stale check on a real round trip', async () => {
  const { mgr, staff } = await campaign(['staff']);
  const a = ok(await save(staff, { name: '  Monthly newsletter ', subject: 'Hi [first name]', body: 'Dear [First Name], [Headline]' })).template;
  assert.equal(a.name, 'Monthly newsletter');
  assert.equal(a.subject, 'Hi {{first_name}}', 'stored with codes');
  assert.equal(a.body, 'Dear {{first_name}}, [Headline]');
  assert.equal(a.version, 1);

  no(await save(mgr, { name: 'MONTHLY newsletter' }), 409, 'There’s already a template called “MONTHLY newsletter”');
  no(await save(mgr, { name: 'Two\nlines' }), 400);
  no(await save(mgr, { name: 'Long', body: 'x'.repeat(50001) }), 400);

  // The stale check: read, save with the version it answered, save again with the old one.
  const read = ok(await staff.get(`/api/templates/${a.id}`));
  assert.equal(read.version, 1);
  assert.deepEqual(read.placeholders, ['[Headline]']);
  const b = ok(await save(mgr, { id: a.id, name: 'Monthly newsletter', body: 'Changed', seen: read.version })).template;
  assert.equal(b.version, 2);
  const stale = await save(staff, { id: a.id, name: 'Monthly newsletter', body: 'Mine', seen: read.version });
  assert.equal(stale.status, 409);
  assert.match(stale.json.error, /^Avery Example changed this template at \d{1,2}:\d\d [ap]m — reload to see it$/);
  assert.equal((await db.query('select body from email_templates where id = $1', [a.id])).rows[0].body, 'Changed', 'nothing written');
  no(await save(staff, { id: a.id, name: 'Monthly newsletter', body: 'Blind' }), 409, null, 'no seen: refused, never blind');
  const twice = ok(await save(staff, { id: a.id, name: 'Monthly newsletter', body: 'Again', seen: 2 })).template;
  assert.equal(ok(await save(staff, { id: a.id, name: 'Monthly newsletter', body: 'Again 2', seen: twice.version })).template.version, 4, 'twice in a row');

  // Copies.
  const c1 = ok(await staff.action('template.copy', { from: 'starter:monthly' })).template;
  const c2 = ok(await staff.action('template.copy', { from: 'starter:monthly' })).template;
  assert.deepEqual([c1.name, c2.name], ['Monthly newsletter (copy)', 'Monthly newsletter (copy 2)']);
  assert.equal(c1.body, STARTERS[0].body);
  const c3 = ok(await staff.action('template.copy', { from: c1.id })).template;
  assert.equal(c3.name, 'Monthly newsletter (copy 3)', 'a copy of a copy counts on');
  assert.equal((await db.query('select made_from from email_templates where id = $1', [c3.id])).rows[0].made_from, c1.id);
  no(await staff.action('template.copy', { from: 'starter:nope' }), 404, 'That template was removed');

  // Remove, restore; restore once the name is taken.
  assert.equal(ok(await staff.action('template.remove', { id: c1.id })).id, c1.id);
  no(await staff.get(`/api/templates/${c1.id}`), 404, 'That template was removed');
  no(await save(staff, { id: c1.id, name: 'x', seen: 1 }), 404, 'That template was removed');
  const back = ok(await staff.action('template.restore', { id: c1.id })).template;
  assert.equal(back.version, c1.version + 1);
  ok(await staff.action('template.remove', { id: c1.id }));
  ok(await save(staff, { name: 'Monthly newsletter (copy)' }));
  no(await staff.action('template.restore', { id: c1.id }), 409, 'There’s already a template called “Monthly newsletter (copy)” — rename that one first');

  // The list: A–Z, no bodies.
  const list = ok(await staff.get('/api/templates?use=email'));
  assert.deepEqual(list.mine.map((t) => t.name), ['Monthly newsletter', 'Monthly newsletter (copy 2)', 'Monthly newsletter (copy 3)', 'Monthly newsletter (copy)']);
  assert.ok(list.mine.every((t) => !('body' in t)));
  assert.equal(list.mine[0].updated_by_name, 'pat Example');
  assert.equal(list.starters.length, 12);
  assert.ok(list.starters.every((s) => !('body' in s)));
});

test('200 templates is the most', async () => {
  const { mgr, ws } = await campaign();
  const owner = (await db.query('select created_by from email_templates limit 1')).rows[0]?.created_by || null;
  for (let i = 0; i < 199; i += 1) {
    await db.query(`insert into email_templates (id, workspace_id, use, name, body, created_by) values (gen_random_uuid(), $1, 'email', $2, 'b', $3)`, [ws, `T${i}`, owner]);
  }
  ok(await save(mgr, { name: 'The 200th' }));
  no(await save(mgr, { name: 'The 201st' }), 409, '200 templates is the most — remove one first');
  no(await mgr.action('template.copy', { from: 'starter:monthly' }), 409, '200 templates is the most — remove one first');
  ok(await save(mgr, { name: 'A release', use: 'press' }), 'press counts on its own');
});

test('a template’s use is fixed and checked on the stored row; roles and areas', async () => {
  const { mgr, staff, press, volMedia, volOut, plain } = await campaign(ALL);
  const email = ok(await save(staff, { name: 'For email' })).template;
  const other = await campaign();
  const theirs = ok(await save(other.mgr, { name: 'Theirs' })).template;

  // Staff denied Outreach, holding Media.
  no(await save(press, { id: email.id, use: 'press', name: 'Moved', seen: 1 }), 400, 'A template can’t move between Email and Media — make a new one');
  no(await save(press, { id: email.id, use: 'email', name: 'Mine', seen: 1 }), 403, 'You don’t have Outreach');
  no(await press.action('template.remove', { id: email.id }), 403, 'You don’t have Outreach');
  no(await press.action('template.restore', { id: email.id }), 403, 'You don’t have Outreach');
  no(await press.action('template.copy', { from: email.id }), 403, 'You don’t have Outreach');
  no(await press.action('template.copy', { from: 'starter:monthly' }), 403, 'You don’t have Outreach');
  no(await save(press, { name: 'New email' }), 403, 'You don’t have Outreach');
  const release = ok(await save(press, { name: 'Release', use: 'press' })).template;
  assert.equal((await db.query('select name, use from email_templates where id = $1', [email.id])).rows[0].name, 'For email', 'nothing changed');
  // Another campaign's id: not found.
  no(await staff.action('template.remove', { id: theirs.id }), 404, 'That template was removed');
  no(await staff.get(`/api/templates/${theirs.id}`), 404);

  // Volunteers granted Outreach or Media write nothing.
  for (const v of [volMedia, volOut, plain]) {
    assert.equal((await save(v, { name: 'No' })).status, 403);
    assert.equal((await save(v, { name: 'No', use: 'press' })).status, 403);
    assert.equal((await v.action('template.copy', { from: 'starter:press-release' })).status, 403);
    assert.equal((await v.action('template.remove', { id: release.id })).status, 403);
    assert.equal((await v.action('template.restore', { id: release.id })).status, 403);
  }
  // A manager does both.
  ok(await save(mgr, { name: 'Manager email' }));
  ok(await save(mgr, { name: 'Manager release', use: 'press' }));

  // Hiding a ready-made one: managers only; an unknown key is refused.
  assert.equal((await staff.action('template.starters', { key: 'monthly', hidden: true })).status, 403);
  no(await mgr.action('template.starters', { key: 'nope', hidden: true }), 400);
  assert.deepEqual(ok(await mgr.action('template.starters', { key: 'monthly', hidden: true })).hidden, ['monthly']);
  assert.ok(!ok(await staff.get('/api/templates?use=email')).starters.some((s) => s.key === 'monthly'), 'hidden from staff');
  const m = ok(await mgr.get('/api/templates?use=email'));
  assert.equal(m.starters.find((s) => s.key === 'monthly').hidden, true, 'flagged for a manager');
  ok(await mgr.action('template.starters', { key: 'monthly', hidden: false }));
  assert.ok(ok(await staff.get('/api/templates?use=email')).starters.some((s) => s.key === 'monthly'));

  // Reads, role × use.
  const read = async (c, use) => {
    const r = await c.get(`/api/templates?use=${use}`);
    return r.status === 200 ? [r.json.canSave, r.json.canHide] : r.status;
  };
  assert.deepEqual(await read(mgr, 'email'), [true, true]);
  assert.deepEqual(await read(mgr, 'press'), [true, true]);
  assert.deepEqual(await read(staff, 'email'), [true, false]);
  assert.deepEqual(await read(staff, 'press'), [true, false]);
  assert.equal(await read(press, 'email'), 403);
  assert.deepEqual(await read(press, 'press'), [true, false]);
  assert.equal(await read(volMedia, 'email'), 403);
  assert.deepEqual(await read(volMedia, 'press'), [false, false], 'a volunteer granted Media starts a release from one');
  assert.equal(await read(volOut, 'email'), 403, 'the Email tab is the desk’s');
  assert.equal(await read(volOut, 'press'), 403);
  assert.equal(await read(plain, 'email'), 403);
  assert.equal(await read(plain, 'press'), 403);
  assert.equal((await volMedia.get('/api/templates/starter:press-release')).status, 200);
  assert.equal((await volMedia.get(`/api/templates/${release.id}`)).status, 200);
  assert.equal((await volMedia.get('/api/templates/starter:monthly')).status, 403);
  assert.equal((await volMedia.get(`/api/templates/${email.id}`)).status, 403);
  const s = ok(await staff.get('/api/templates/starter:monthly'));
  assert.equal(s.name, 'Monthly newsletter');
  assert.equal(s.placeholders[0], '[Month]');
  assert.equal(s.version, undefined);
});

test('the event log: every write on the chain, never the body; the table is in the export', async () => {
  const { mgr } = await campaign();
  const SENTINEL = 'body-sentinel-7d1f';
  const t = ok(await save(mgr, { name: 'Logged', body: `Words ${SENTINEL}` })).template;
  ok(await save(mgr, { id: t.id, name: 'Logged', body: `More ${SENTINEL}`, seen: t.version }));
  const c = ok(await mgr.action('template.copy', { from: t.id })).template;
  ok(await mgr.action('template.remove', { id: c.id }));
  ok(await mgr.action('template.restore', { id: c.id }));
  ok(await mgr.action('template.starters', { key: 'welcome', hidden: true }));
  const events = ok(await mgr.get('/api/events?since=0&limit=5000')).events.filter((e) => e.entity_type === 'email_template');
  assert.deepEqual(events.map((e) => e.op), ['create', 'update', 'create', 'void', 'restore']);
  assert.ok(events.every((e) => !JSON.stringify(e.payload).includes(SENTINEL)), 'no body on the log');
  assert.deepEqual(Object.keys(events[0].payload).sort(), ['name', 'subject', 'use']);
  assert.equal(ok(await mgr.get('/api/audit/verify')).ok, true);
  const exp = ok(await mgr.get('/api/export'));
  assert.ok(exp.email_templates.some((x) => x.id === t.id && x.body.includes(SENTINEL)));
});

// ── Sends ──

test('fill-ins: per subscriber and per person, names in capitals, and a name is only ever words', async () => {
  const { mgr, ws, name } = await campaign();
  for (const [nm, em] of [['Lee Example', 'lee'], ['', 'nameless'], ['[x](https://evil.example)', 'evil'], ['**URGENT**', 'urgent']]) {
    ok(await mgr.action('subscription.add', { email: mail(em), ...(nm ? { name: nm } : {}) }));
  }
  resend.sent.length = 0;
  // An older screen types the words; the send stores the codes.
  const r = ok(await mgr.action('blast.send', { kind: 'newsletter', subject: 'News for [first name]', body: 'Hi [first name],\n\nFrom [campaign].' }));
  const stored = (await db.query('select subject, body from blasts where id = $1', [r.blast.id])).rows[0];
  assert.deepEqual(stored, { subject: 'News for {{first_name}}', body: 'Hi {{first_name}},\n\nFrom {{campaign}}.' });
  const lee = sentTo(mail('lee'))[0];
  assert.equal(lee.subject, 'News for Lee');
  assert.match(textOf(lee), /^Hi Lee,\n\nFrom /);
  assert.match(htmlOf(lee), /<p[^>]*>Hi Lee,<\/p>/);
  assert.match(textOf(sentTo(mail('nameless'))[0]), /^Hi friend,/);
  const evil = sentTo(mail('evil'))[0];
  assert.ok(!/<a[^>]*evil\.example/.test(htmlOf(evil)), 'no link to the name’s address');
  assert.ok(htmlOf(evil).includes('Hi [x](https://evil.example),'), 'the brackets show as text');
  assert.match(textOf(evil), /^Hi \[x\]\(https:\/\/evil\.example\),/);
  const urgent = sentTo(mail('urgent'))[0];
  assert.ok(!/<strong>/.test(htmlOf(urgent)), 'no bold from a name');
  assert.match(textOf(lee), new RegExp(`From ${name}\\.`), '[campaign] is the campaign’s name');

  // The send list answers in words.
  const list = ok(await mgr.get('/api/blasts')).blasts;
  assert.equal(list.find((b) => b.id === r.blast.id).subject, 'News for [first name]');

  // An email to a list: persons.first_name, the subject per person.
  await mgr.createPerson('JOHN EXAMPLE', { email: mail('john'), tags: [`t${tag}`] });
  await mgr.createPerson('Sam Example', { email: mail('sam'), tags: [`t${tag}`] });
  resend.sent.length = 0;
  const e = ok(await mgr.action('blast.send', { kind: 'eblast', subject: 'Thank you, [first name]', body: 'Hi [first name]', audience: { filter: { tag: `t${tag}` } } }));
  assert.equal(sentTo(mail('john'))[0].subject, 'Thank you, John');
  assert.match(textOf(sentTo(mail('john'))[0]), /^Hi John/);
  assert.equal(sentTo(mail('sam'))[0].subject, 'Thank you, Sam');
  assert.equal(ok(await mgr.get('/api/blasts')).blasts.find((b) => b.id === e.blast.id).subject, 'Thank you, [first name]');

  // History shows the subject as it went to them.
  const sam = (await db.query('select id from persons where workspace_id = $1 and email = $2', [ws, mail('sam')])).rows[0];
  const tl = ok(await mgr.get(`/api/persons/${sam.id}/timeline`));
  const row = tl.entries.find((x) => x.kind === 'email');
  assert.ok(row, JSON.stringify(tl).slice(0, 400));
  assert.match(row.detail, /^Thank you, Sam/);
});

test('a test send fills the writer’s name, goes with placeholders and says how many', async () => {
  const { mgr } = await campaign();
  resend.sent.length = 0;
  const t = ok(await mgr.action('blast.test', { kind: 'newsletter', subject: 'Hi [first name]', body: 'Hi [first name], [Headline one]' }));
  assert.equal(t.placeholders, 1);
  assert.equal(resend.sent.at(-1).subject, '[Test] Hi Avery');
  assert.match(textOf(resend.sent.at(-1)), /^Hi Avery, \[Headline one\]/);
  no(await mgr.action('blast.test', { kind: 'newsletter', subject: 's', body: '[Read more](https://)' }), 400, 'Add the address for the link “Read more”');
  no(await mgr.action('blast.test', { kind: 'newsletter', subject: 's', body: 'Hi {first}' }), 400, '{first} won’t fill in — use + First name');
});

test('what stops a send: a ready-made placeholder, the template’s own, an empty link, a stray fill-in — never the writer’s own brackets', async () => {
  const { mgr, press, name } = await campaign(['press']);
  ok(await mgr.action('subscription.add', { email: mail('reader'), name: 'Reader Example' }));
  await mgr.createPerson('Dana Example', { email: mail('dana'), tags: ['media'] });
  const send = (input) => mgr.action('blast.send', { kind: 'newsletter', subject: 'Plain', ...input });
  no(await send({ body: 'Hi {first}' }), 400, '{first} won’t fill in — use + First name');
  no(await send({ body: '**[Headline one]**' }), 400, 'Fill in the [ ] parts first: [Headline one]');
  no(await send({ body: '**[Headline one]**', placeholders_from: ['[Other]'] }), 400, 'Fill in the [ ] parts first: [Headline one]');
  no(await send({ body: 'See [Our own words]', placeholders_from: ['[Our own words]'] }), 400, 'Fill in the [ ] parts first: [Our own words]');
  ok(await send({ body: 'See [Our own words]' }), 'not the template’s: it goes');
  no(await send({ body: 'More: [Read more](https://)' }), 400, 'Add the address for the link “Read more”');
  ok(await send({ body: 'He said it [sic] twice. [1]' }));
  ok(await send({ subject: '[Updated] Town hall moved', body: 'Same day.' }));
  ok(await send({ body: '[Join our campaign](https://example.org) [Add your name](https://example.org) ![a](/media/x)' }));
  no(await send({ subject: 'Hi', body: 'Hi', ab: { subject_b: '[Month] news', pct: 10, wait_hours: 1, metric: 'opens' } }), 400, 'Fill in the [ ] parts first: [Month]', 'subject B is checked too');
  // Media's releases, through media.send — and by staff holding Media only.
  no(await press.action('media.send', { subject: 'Release', body: '“[Quote],” said someone.' }), 400, 'Fill in the [ ] parts first: [Quote]');
  ok(await press.action('media.send', { subject: '[Updated] Release', body: 'A quote [sic] as said.' }));
  // Media's list answers a release's subject in words, as GET /blasts does.
  ok(await press.action('media.send', { subject: 'For you, [first name]', body: 'Words.' }));
  const rel = ok(await press.get('/api/media/releases')).releases.find((b) => b.subject.startsWith('For you'));
  assert.equal(rel.subject, 'For you, [first name]');
  assert.equal(ok(await press.get(`/api/media/releases/${rel.id}`)).release.subject, 'For you, [first name]');
  // A text is unchanged: its {{…}} rule stands.
  await mgr.createPerson('Tex Example', { phone: '604-555-0142', tags: [`x${tag}`] });
  const txt = await mgr.action('blast.send', { kind: 'text', body: `Hi {{first_name}}, from ${name}`, audience: { filter: { tag: `x${tag}` } } });
  no(txt, 400, 'Fill in the {{…}} parts first');
});

test('an A/B winner send fills both subjects and the body', async () => {
  const { mgr, ws } = await campaign();
  for (let i = 0; i < 50; i += 1) ok(await mgr.action('subscription.add', { email: mail(`ab${i}`), name: `Reader${i} Example` }));
  resend.sent.length = 0;
  const r = ok(await mgr.action('blast.send', {
    kind: 'newsletter', subject: 'A for [first name]', body: 'Hi [first name]',
    ab: { subject_b: 'B for [first name]', pct: 10, wait_hours: 1, metric: 'opens' },
  }));
  assert.equal(resend.sent.length, 10);
  assert.ok(resend.sent.every((m) => /^[AB] for Reader\d+$/.test(m.subject)), resend.sent.map((m) => m.subject).join());
  await db.query(`update jobs set run_at = now() where workspace_id = $1 and kind = 'abtests.winner' and status = 'pending'`, [ws]);
  await runDueJobs(db, { workspaceId: ws });
  assert.equal(resend.sent.length, 50);
  for (const m of resend.sent.slice(10)) {
    const who = m.to.toString().match(/ab(\d+)\./)[1];
    assert.equal(m.subject, `A for Reader${who}`, 'the winner (a tie sends A), filled');
    assert.match(textOf(m), new RegExp(`^Hi Reader${who}\\b`));
  }
  assert.ok(r.blast.id);
});

// ── The lines at the bottom ──

test('the footer: as before with nothing set; the address, contact and agent in both parts, escaped, one full stop', async () => {
  const { mgr, ws } = await campaign();
  const staff = mgr;
  const ctx = { workspace: { name: 'Example Campaign', settings: {} }, publicUrl: 'https://base.example' };
  const empty = { address: '', contact: '', auth: '' };
  for (const kind of ['newsletter', 'eblast', 'press']) {
    assert.equal(blastText(ctx, kind, 'Hi', 'https://u', empty), blastText(ctx, kind, 'Hi', 'https://u'));
    assert.equal(blastHtml(ctx, kind, 'Hi', 'https://u', 'tok', [], empty), blastHtml(ctx, kind, 'Hi', 'https://u', 'tok', []));
    assert.deepEqual(composeBlast(ctx, { kind, body: 'Hi', unsubscribeUrl: null, token: null, links: [] }),
      composeBlast(ctx, { kind, body: 'Hi', unsubscribeUrl: null, token: null, links: [], foot: empty }));
  }
  // No row at all: the same.
  ok(await mgr.action('subscription.add', { email: mail('foot'), name: 'Foot Example' }));
  await db.query('delete from site_settings where workspace_id = $1', [ws]);
  resend.sent.length = 0;
  ok(await mgr.action('blast.send', { kind: 'newsletter', subject: 'S', body: 'Hi' }));
  assert.match(textOf(resend.sent[0]), /\n\n—\nSent by Templates \d+ \w+\.\nUnsubscribe: https:\/\/base\.example\/u\/[0-9a-f-]{36}$/);
  assert.match(htmlOf(resend.sent[0]), /Sent by Templates \d+ \w+\. We count opens and clicks\.<br><a /);

  const org = { name: 'Example Campaign', address: '1 Example St <b>rear</b>.', email: 'hello@example.org', agentName: 'Robin Example', agentContact: '604-555-0100' };
  ok(await setOrg(mgr, org));
  await mgr.createPerson('Dana Example', { email: mail('dana'), tags: ['media', `f${tag}`] });
  const check = (m, what) => {
    const html = htmlOf(m);
    assert.ok(html.includes('. 1 Example St &lt;b&gt;rear&lt;/b&gt;. hello@example.org.<br>Authorized by Robin Example, 604-555-0100.'), `${what}: the HTML lines, escaped, in order`);
    assert.ok(!html.includes('rear</b>..'), `${what}: one full stop`);
    assert.match(textOf(m), /\nSent by [^\n]+\.\n1 Example St <b>rear<\/b>\.\nhello@example\.org\.\nAuthorized by Robin Example, 604-555-0100\.\n(Don’t want press releases\? )?Unsubscribe/, `${what}: the text lines`);
  };
  resend.sent.length = 0;
  ok(await mgr.action('blast.send', { kind: 'newsletter', subject: 'S', body: 'Hi' }));
  check(resend.sent[0], 'newsletter');
  resend.sent.length = 0;
  ok(await mgr.action('blast.send', { kind: 'eblast', subject: 'S', body: 'Hi', audience: { filter: { tag: `f${tag}` } } }));
  check(resend.sent[0], 'eblast');
  resend.sent.length = 0;
  ok(await mgr.action('media.send', { subject: 'S', body: 'Hi' }));
  check(resend.sent[0], 'press');
  assert.match(textOf(resend.sent[0]), /Don’t want press releases\? Unsubscribe: /);
  resend.sent.length = 0;
  ok(await mgr.action('blast.test', { kind: 'newsletter', subject: 'S', body: 'Hi' }));
  check(resend.sent[0], 'test');

  // The compose's lines.
  const t = ok(await staff.get('/api/templates?use=email'));
  assert.deepEqual(t.foot.missing, []);
  assert.equal(t.foot.auth, 'Authorized by Robin Example, 604-555-0100');
  // "Link to…": the website's pages, as full addresses an email can carry.
  assert.ok(t.links.length >= 1 && t.links.every((l) => /^https?:\/\/[^/]+\/.*site\//.test(l.url) && l.label), JSON.stringify(t.links));
  assert.equal(t.links[0].label, 'Home');
  ok(await setOrg(mgr, { ...org, address: '' }));
  assert.deepEqual(ok(await staff.get('/api/templates?use=email')).foot.missing, ['address']);
});

test('Use again: a past email’s words for the desk; not a text, a release or another campaign’s', async () => {
  const { mgr, staff, plain } = await campaign(['staff', 'plain']);
  ok(await mgr.action('subscription.add', { email: mail('again'), name: 'Again Example' }));
  await mgr.createPerson('Dana Example', { email: mail('dana2'), tags: ['media'] });
  const b = ok(await mgr.action('blast.send', { kind: 'newsletter', subject: 'Hi [first name]', body: 'Body words' })).blast;
  const m = ok(await staff.get(`/api/blasts/${b.id}/message`));
  assert.deepEqual(m, { kind: 'newsletter', subject: 'Hi {{first_name}}', body: 'Body words' });
  assert.equal((await plain.get(`/api/blasts/${b.id}/message`)).status, 403);
  const p = ok(await mgr.action('media.send', { subject: 'Release', body: 'Words' })).blast;
  assert.equal((await staff.get(`/api/blasts/${p.id}/message`)).status, 404);
  const other = await campaign();
  assert.equal((await other.mgr.get(`/api/blasts/${b.id}/message`)).status, 404);
  assert.equal((await staff.get('/api/blasts/not-an-id/message')).status, 404);
});
