// The email senders (server/lib/mail): which one is in use, what each sends
// and answers, and how each one's delivery events are checked and read.
// The two signature checks run against the senders' own published vectors
// (Svix's for Resend; the one in SendGrid's event-webhook helper), with
// node:crypto alone. The senders themselves are stand-ins (fake-mail.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeMail } from './fake-mail.js';
import { activeProvider, chosenProvider, mailFrom } from '../lib/mail/index.js';
import { emailConfigured, sendEmail } from '../lib/notify.js';
import resend, { signPayload } from '../lib/mail/resend.js';
import sendgrid from '../lib/mail/sendgrid.js';

const KEYS = ['MAIL_PROVIDER', 'MAIL_FROM', 'RESEND_API_KEY', 'RESEND_API_BASE', 'RESEND_WEBHOOK_SECRET', 'RESEND_REGION',
  'SENDGRID_API_KEY', 'SENDGRID_API_BASE', 'SENDGRID_WEBHOOK_PUBLIC_KEY', 'STARBASE_EMAIL_TIMEOUT_MS'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const clear = () => { for (const k of KEYS) delete process.env[k]; };
const env = (set) => { clear(); Object.assign(process.env, set); };
const hdr = (h) => (name) => h[name.toLowerCase()] ?? null;
let fakeResend, fakeGrid;

before(async () => {
  clear();
  fakeResend = await startFakeMail({ provider: 'resend' });
  fakeGrid = await startFakeMail({ provider: 'sendgrid' });
});
after(async () => {
  await fakeResend.close();
  await fakeGrid.close();
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

// ── Which sender ──
test('no setting: whichever sender has its key, Resend first — so a deployment with only RESEND_API_KEY is as before', () => {
  env({});
  assert.equal(activeProvider(), null);
  assert.equal(emailConfigured(), false);
  assert.equal(chosenProvider().key, 'resend', 'Settings → Services names Resend until a key says otherwise');
  env({ RESEND_API_KEY: 're_x' });
  assert.equal(activeProvider().key, 'resend');
  assert.equal(emailConfigured(), true, 'MAIL_FROM is optional with Resend (its test sender), as it always was');
  env({ RESEND_API_KEY: 're_x', SENDGRID_API_KEY: 'SG.x', MAIL_FROM: 'team@example.org' });
  assert.equal(activeProvider().key, 'resend', 'both keys: Resend first');
  env({ SENDGRID_API_KEY: 'SG.x', MAIL_FROM: 'Team <team@example.org>' });
  assert.equal(activeProvider().key, 'sendgrid');
});

test('MAIL_PROVIDER names the sender: never a quiet fall back to the other one, never a name base.win doesn’t know', () => {
  env({ MAIL_PROVIDER: 'sendgrid', RESEND_API_KEY: 're_x' });
  assert.equal(activeProvider(), null, 'SendGrid is asked for and has no key: nothing sends');
  assert.equal(chosenProvider().key, 'sendgrid');
  env({ MAIL_PROVIDER: 'SendGrid', SENDGRID_API_KEY: 'SG.x', MAIL_FROM: 'team@example.org', RESEND_API_KEY: 're_x' });
  assert.equal(activeProvider().key, 'sendgrid', 'any case');
  env({ MAIL_PROVIDER: 'sendgird', RESEND_API_KEY: 're_x' });
  assert.equal(activeProvider(), null);
  assert.equal(chosenProvider(), null, 'a name base.win doesn’t know is no sender');
  // SendGrid has no test sender: without MAIL_FROM nothing can go, so nothing is tried.
  env({ SENDGRID_API_KEY: 'SG.x' });
  assert.equal(activeProvider(), null);
  assert.equal(chosenProvider().key, 'sendgrid', 'its key is there: Services names it, and says MAIL_FROM is missing');
});

test('no sender: the email is kept, in the words the Email screen reads', async () => {
  env({});
  assert.deepEqual(await sendEmail({ to: 'ana@example.org', subject: 'S', text: 'T' }),
    { sent: false, status: 'queued', detail: 'no email provider configured (set RESEND_API_KEY)' });
});

test('MAIL_FROM read as a name, an address and its domain', () => {
  env({ MAIL_FROM: 'Imagine Surrey <Team@ImagineSurrey.example>' });
  assert.deepEqual(mailFrom(), { raw: 'Imagine Surrey <Team@ImagineSurrey.example>', name: 'Imagine Surrey', email: 'Team@ImagineSurrey.example', domain: 'imaginesurrey.example' });
  env({ MAIL_FROM: 'team@mail.example.org' });
  assert.deepEqual(mailFrom(), { raw: 'team@mail.example.org', name: '', email: 'team@mail.example.org', domain: 'mail.example.org' });
  env({});
  assert.deepEqual(mailFrom(), { raw: '', name: '', email: '', domain: '' });
});

// ── Resend ──
test('Resend: one email — the key, the idempotency key, our ref as a tag — and the sender’s id comes back', async () => {
  env({ RESEND_API_KEY: 're_secret_1', RESEND_API_BASE: fakeResend.url, MAIL_FROM: 'Team <team@example.org>' });
  fakeResend.reset();
  const ref = '0b8c9a52-1f6e-4a55-9d0e-3c2f6a7b8c9d';
  const r = await sendEmail({
    to: 'ana@example.org', subject: 'Hello', text: 'Words', html: '<p>Words</p>', idempotencyKey: 'blast-1-2-0', ref,
    headers: { 'List-Unsubscribe': '<https://x.example/u/1>' }, attachments: [{ filename: 'a.txt', content: 'aGk=', content_type: 'text/plain' }],
  });
  assert.equal(r.sent, true);
  assert.equal(r.status, 'sent');
  assert.equal(r.provider, 'resend');
  const m = fakeResend.sent[0];
  assert.equal(r.id, m.id, 'the id Resend answered');
  assert.equal(fakeResend.calls[0].auth, 'Bearer re_secret_1');
  assert.equal(m.key, 'blast-1-2-0');
  assert.deepEqual(m.body.tags, [{ name: 'ref', value: ref }]);
  assert.deepEqual([m.body.from, m.body.to, m.body.subject, m.body.text, m.body.html], ['Team <team@example.org>', ['ana@example.org'], 'Hello', 'Words', '<p>Words</p>']);
  assert.deepEqual(m.body.headers, { 'List-Unsubscribe': '<https://x.example/u/1>' });
  assert.deepEqual(m.body.attachments, [{ filename: 'a.txt', content: 'aGk=', content_type: 'text/plain' }]);
  // The same key again: Resend answers, and sends nothing more.
  const again = await sendEmail({ to: 'ana@example.org', subject: 'Hello', text: 'Words', html: '<p>Words</p>', idempotencyKey: 'blast-1-2-0', ref,
    headers: { 'List-Unsubscribe': '<https://x.example/u/1>' }, attachments: [{ filename: 'a.txt', content: 'aGk=', content_type: 'text/plain' }] });
  assert.equal(again.id, r.id);
  assert.equal(fakeResend.sent.length, 1);
  // No ref, or one a tag can't carry: no tag — never a refused email over it.
  await sendEmail({ to: 'ben@example.org', subject: 'S', text: 'T' });
  await sendEmail({ to: 'cal@example.org', subject: 'S', text: 'T', ref: 'not a tag value!' });
  assert.equal(fakeResend.sent[1].body.tags, undefined);
  assert.equal(fakeResend.sent[2].body.tags, undefined);
  // Without MAIL_FROM: Resend's test sender, as before.
  delete process.env.MAIL_FROM;
  await sendEmail({ to: 'dee@example.org', subject: 'S', text: 'T' });
  assert.equal(fakeResend.sent[3].body.from, 'onboarding@resend.dev');
});

test('Resend: a refusal is failed; no answer is "not sure"; the same key with other words (409) is "not sure", never a new key', async () => {
  env({ RESEND_API_KEY: 're_secret_1', RESEND_API_BASE: fakeResend.url, STARBASE_EMAIL_TIMEOUT_MS: '250' });
  fakeResend.reset();
  fakeResend.fail(500);
  const refused = await sendEmail({ to: 'ana@example.org', subject: 'S', text: 'T' });
  assert.deepEqual([refused.sent, refused.status, refused.unknown], [false, 'failed', undefined]);
  assert.match(refused.detail, /^email provider 500: /);
  fakeResend.fail(false);
  fakeResend.hang();
  const lost = await sendEmail({ to: 'ana@example.org', subject: 'S', text: 'T' });
  assert.deepEqual([lost.sent, lost.status, lost.unknown], [false, 'failed', true]);
  assert.match(lost.detail, /didn't answer in/);
  fakeResend.hang(false);
  assert.equal((await sendEmail({ to: 'ana@example.org', subject: 'S', text: 'First words', idempotencyKey: 'k-409' })).sent, true);
  const clash = await sendEmail({ to: 'ana@example.org', subject: 'S', text: 'Other words', idempotencyKey: 'k-409' });
  assert.deepEqual([clash.sent, clash.status, clash.unknown], [false, 'failed', true], 'Resend has seen this key: the first try reached it');
  assert.ok(!JSON.stringify([refused, lost, clash]).includes('re_secret_1'), 'never the key in an answer');
});

test('Resend: an answer with no id (the older stubs) is still sent', async () => {
  env({ RESEND_API_KEY: 'test-key' });
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => { seen.push({ url: String(url), key: init.headers['Idempotency-Key'], body: JSON.parse(init.body) }); return new Response('{}', { status: 200 }); };
  try {
    const r = await sendEmail({ to: 'ana@example.org', subject: 'S', text: 'T', idempotencyKey: 'k1' });
    assert.deepEqual([r.sent, r.status, r.id], [true, 'sent', undefined]);
    assert.equal(seen[0].url, 'https://api.resend.com/emails');
    assert.equal(seen[0].key, 'k1');
    assert.deepEqual(seen[0].body.to, ['ana@example.org']);
    globalThis.fetch = async () => new Response('not json', { status: 200 });
    assert.equal((await sendEmail({ to: 'ana@example.org', subject: 'S', text: 'T' })).sent, true, 'the sender took it, whatever it said');
  } finally { globalThis.fetch = realFetch; }
});

test('Resend: the webhook signature — Svix’s published vector, with node:crypto alone', () => {
  // https://docs.svix.com/receiving/verifying-payloads/how-manual
  const secret = 'whsec_plJ3nmyCDGBKInavdOK15jsl';
  const raw = Buffer.from('{"event_type":"ping","data":{"success":true}}');
  const h = { 'svix-id': 'msg_loFOjxBNrRLzqYUf', 'svix-timestamp': '1731705121', 'svix-signature': 'v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=' };
  const at = { nowS: 1731705121 + 60 };
  env({ RESEND_WEBHOOK_SECRET: secret });
  assert.equal(resend.verify(raw, hdr(h), at), true);
  assert.deepEqual(signPayload(raw, secret, { id: h['svix-id'], t: 1731705121 }), h, 'and base.win signs the same way (tests, the stand-in)');
  assert.equal(resend.verify(Buffer.from('{"event_type":"ping","data":{"success":false}}'), hdr(h), at), false, 'other bytes');
  assert.equal(resend.verify(raw, hdr({ ...h, 'svix-timestamp': '1731705122' }), at), false, 'another time');
  assert.equal(resend.verify(raw, hdr({ ...h, 'svix-id': 'msg_other' }), at), false, 'another id');
  assert.equal(resend.verify(raw, hdr({ ...h, 'svix-signature': 'v1,AAAAW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=' }), at), false);
  assert.equal(resend.verify(raw, hdr({ ...h, 'svix-signature': '' }), at), false);
  assert.equal(resend.verify(raw, hdr(h)), false, 'two years old: a captured delivery can’t be replayed');
  assert.equal(resend.verify(raw, hdr(h), { nowS: 1731705121 - 400 }), false, 'nor one from the future');
  // Several signatures in the header (Svix while a secret rolls), and several secrets here.
  assert.equal(resend.verify(raw, hdr({ ...h, 'svix-signature': `v1,AAAA v2,zzz ${h['svix-signature']}` }), at), true);
  env({ RESEND_WEBHOOK_SECRET: `whsec_b3RoZXItc2VjcmV0, ${secret}` });
  assert.equal(resend.verify(raw, hdr(h), at), true, 'a comma list while it is rolled');
  env({ RESEND_WEBHOOK_SECRET: 'whsec_b3RoZXItc2VjcmV0' });
  assert.equal(resend.verify(raw, hdr(h), at), false, 'another secret');
  env({});
  assert.equal(resend.verify(raw, hdr(h), at), false, 'no secret set');
  // The same scheme under its standard names (webhook-id …), as Resend's own library reads it.
  env({ RESEND_WEBHOOK_SECRET: secret });
  assert.equal(resend.verify(raw, hdr({ 'webhook-id': h['svix-id'], 'webhook-timestamp': h['svix-timestamp'], 'webhook-signature': h['svix-signature'] }), at), true);
});

test('Resend: events read into base.win’s kinds — our ref from the tags (either shape), bounces by their type, the rest left alone', () => {
  const ev = (type, data = {}, id = 'msg_1') => resend.parse(
    Buffer.from(JSON.stringify({ type, created_at: '2026-11-02T18:00:00.000Z', data: { email_id: 'em_1', to: ['Ana@Example.org'], tags: { ref: 'row-1' }, ...data } })),
    hdr({ 'svix-id': id }),
  );
  assert.deepEqual(ev('email.delivered'), [{ id: 'msg_1', kind: 'delivered', ref: 'row-1', messageId: 'em_1', email: 'ana@example.org', at: '2026-11-02T18:00:00.000Z' }]);
  const hard = ev('email.bounced', { bounce: { type: 'Permanent', subType: 'Suppressed', message: 'No such mailbox' } })[0];
  assert.deepEqual([hard.kind, hard.permanent, hard.detail], ['bounced', true, 'Permanent / Suppressed: No such mailbox']);
  assert.equal(ev('email.bounced', { bounce: { type: 'permanent', message: 'x' } })[0].kind, 'bounced', 'any case');
  const soft = ev('email.bounced', { bounce: { type: 'Transient', subType: 'MailboxFull', message: 'Mailbox full' } })[0];
  assert.deepEqual([soft.kind, soft.permanent], ['deferred', undefined], 'only a permanent bounce stops an address');
  assert.equal(ev('email.bounced', {})[0].kind, 'deferred', 'a bounce that doesn’t say: not a reason to stop an address');
  assert.equal(ev('email.delivery_delayed')[0].kind, 'deferred');
  assert.equal(ev('email.complained')[0].kind, 'complained');
  const sup = ev('email.suppressed', { suppressed: { type: 'complaint', message: 'On the suppression list' } })[0];
  assert.deepEqual([sup.kind, sup.reason, sup.detail], ['suppressed', 'complaint', 'complaint: On the suppression list']);
  assert.equal(ev('email.suppressed', { suppressed: { type: 'bounce', message: 'x' } })[0].reason, 'bounce');
  const failed = ev('email.failed', { failed: { reason: 'quota' } })[0];
  assert.deepEqual([failed.kind, failed.detail], ['failed', 'quota']);
  // The tags as a list (as they are sent), no tags, no recipient.
  assert.equal(ev('email.delivered', { tags: [{ name: 'other', value: 'x' }, { name: 'ref', value: 'row-9' }] })[0].ref, 'row-9');
  assert.equal(ev('email.delivered', { tags: undefined })[0].ref, null);
  assert.equal(ev('email.delivered', { to: 'solo@example.org' })[0].email, 'solo@example.org');
  // What base.win doesn't use (its own opens and clicks; contacts; domains): nothing.
  for (const type of ['email.sent', 'email.opened', 'email.clicked', 'email.scheduled', 'contact.created', 'domain.updated', 'suppression.added']) {
    assert.deepEqual(ev(type), [], type);
  }
  assert.throws(() => resend.parse(Buffer.from('not json'), hdr({})), 'not JSON is the caller’s to refuse');
});

// ── SendGrid ──
test('SendGrid: one email — its own shape, our ref as a custom argument, its own tracking off — and the id from X-Message-Id', async () => {
  env({ SENDGRID_API_KEY: 'SG.secret_2', SENDGRID_API_BASE: fakeGrid.url, MAIL_FROM: 'Imagine Surrey <team@example.org>' });
  fakeGrid.reset();
  const ref = '5f0d5c1e-7b1a-4c5e-8a55-0c1d2e3f4a5b';
  const r = await sendEmail({
    to: 'ana@example.org', subject: 'Hello', text: 'Words', html: '<p>Words</p>', idempotencyKey: 'ignored-here', ref,
    headers: { 'List-Unsubscribe': '<https://x.example/u/1>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    attachments: [{ filename: 'a.txt', content: 'aGk=', content_type: 'text/plain' }],
  });
  assert.deepEqual([r.sent, r.status, r.provider], [true, 'sent', 'sendgrid']);
  const m = fakeGrid.sent[0];
  assert.equal(r.id, m.id, 'the id SendGrid answered in X-Message-Id');
  assert.equal(fakeGrid.calls[0].auth, 'Bearer SG.secret_2');
  assert.deepEqual(m.body.personalizations, [{ to: [{ email: 'ana@example.org' }], custom_args: { ref } }]);
  assert.deepEqual(m.body.from, { email: 'team@example.org', name: 'Imagine Surrey' });
  assert.equal(m.body.subject, 'Hello');
  assert.deepEqual(m.body.content, [{ type: 'text/plain', value: 'Words' }, { type: 'text/html', value: '<p>Words</p>' }], 'the plain part first, as SendGrid wants');
  assert.deepEqual(m.body.headers, { 'List-Unsubscribe': '<https://x.example/u/1>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });
  assert.deepEqual(m.body.attachments, [{ content: 'aGk=', filename: 'a.txt', type: 'text/plain' }]);
  // base.win counts its own opens and clicks and has its own unsubscribe pages.
  assert.deepEqual(m.body.tracking_settings, { click_tracking: { enable: false, enable_text: false }, open_tracking: { enable: false }, subscription_tracking: { enable: false } });
  assert.equal(sendgrid.idempotent, false, 'SendGrid has no idempotency key: a repeat can be a second copy');
  assert.equal(resend.idempotent, true);
  // Plain text only, no ref, an address with no name.
  process.env.MAIL_FROM = 'team@example.org';
  await sendEmail({ to: 'ben@example.org', subject: 'S', text: 'T' });
  const plain = fakeGrid.sent[1].body;
  assert.deepEqual(plain.personalizations, [{ to: [{ email: 'ben@example.org' }] }]);
  assert.deepEqual(plain.from, { email: 'team@example.org' });
  assert.deepEqual(plain.content, [{ type: 'text/plain', value: 'T' }]);
  assert.equal(plain.headers, undefined);
  assert.equal(plain.attachments, undefined);
  fakeGrid.fail(401);
  const refused = await sendEmail({ to: 'ana@example.org', subject: 'S', text: 'T' });
  assert.deepEqual([refused.sent, refused.status], [false, 'failed']);
  assert.match(refused.detail, /^email provider 401: /);
  assert.ok(!JSON.stringify(refused).includes('SG.secret_2'));
  fakeGrid.fail(false);
});

test('SendGrid: the webhook signature — the vectors in SendGrid’s own helper, with node:crypto alone', () => {
  // @sendgrid/eventwebhook 8.0.0, src/eventwebhook.spec.js
  const PUBLIC_KEY = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE83T4O/n84iotIvIW4mdBgQ/7dAfSmpqIM8kF9mN1flpVKS3GRqe62gw+2fNNRaINXvVpiglSI8eNEc6wEA3F+g==';
  const SIGNATURE = 'MEUCIGHQVtGj+Y3LkG9fLcxf3qfI10QysgDWmMOVmxG0u6ZUAiEAyBiXDWzM+uOe5W0JuG+luQAbPIqHh89M15TluLtEZtM=';
  const TIMESTAMP = '1600112502';
  const PAYLOAD = `${JSON.stringify([{
    email: 'hello@world.com', event: 'dropped', reason: 'Bounced Address',
    sg_event_id: 'ZHJvcC0xMDk5NDkxOS1MUnpYbF9OSFN0T0doUTRrb2ZTbV9BLTA',
    sg_message_id: 'LRzXl_NHStOGhQ4kofSm_A.filterdrecv-p3mdw1-756b745b58-kmzbl-18-5F5FC76C-9.0',
    'smtp-id': '<LRzXl_NHStOGhQ4kofSm_A@ismtpd0039p1iad1.sendgrid.net>', timestamp: 1600112492,
  }])}\r\n`;
  const h = (sig, t) => hdr({ 'x-twilio-email-event-webhook-signature': sig, 'x-twilio-email-event-webhook-timestamp': String(t) });
  env({ SENDGRID_WEBHOOK_PUBLIC_KEY: PUBLIC_KEY });
  assert.equal(sendgrid.verify(Buffer.from(PAYLOAD), h(SIGNATURE, TIMESTAMP)), true);
  assert.equal(sendgrid.verify(Buffer.from('payload'), h(SIGNATURE, TIMESTAMP)), false, 'other bytes');
  assert.equal(sendgrid.verify(Buffer.from(PAYLOAD.trimEnd()), h(SIGNATURE, TIMESTAMP)), false, 'the exact bytes: the line break at the end is signed too');
  assert.equal(sendgrid.verify(Buffer.from(PAYLOAD), h('MEUCIQCtIHJeH93Y+qpYeWrySphQgpNGNr/U+UyUlBkU6n7RAwIgJTz2C+8a8xonZGi6BpSzoQsbVRamr2nlxFDWYNH3j/0=', TIMESTAMP)), false, 'another signature');
  assert.equal(sendgrid.verify(Buffer.from(PAYLOAD), h(SIGNATURE, 'timestamp')), false, 'another time');
  assert.equal(sendgrid.verify(Buffer.from(PAYLOAD), h('not base64 DER', TIMESTAMP)), false);
  assert.equal(sendgrid.verify(Buffer.from(PAYLOAD), hdr({})), false, 'no signature');
  // Several events in one delivery (each on its own line, as SendGrid posts them).
  const multi = [
    { email: 'invalid@gmail.com', event: 'processed', send_at: 0, sg_event_id: 'cHJvY2Vzc2VkLTE5OTQyMTEyLXFOd0JMZ1BRUWpXNkRKdktRd1NBYnctMA', sg_message_id: 'qNwBLgPQQjW6DJvKQwSAbw.filterdrecv-canary-547b64655b-cw6zx-1-6089EA4A-56.0', 'smtp-id': '<qNwBLgPQQjW6DJvKQwSAbw@ismtpd0178p1mdw1.sendgrid.net>', timestamp: 1619651146 },
    { email: 'invalid@gmail.com', event: 'bounce', ip: '167.89.101.76', reason: '552 5.2.2 The email account that you tried to reach is over quota and inactive. Please direct the recipient to https://support.google.com/mail/?p=OverQuotaPerm c17si1130468pgv.34 - gsmtp', sg_event_id: 'Ym91bmNlLTAtMTk5NDIxMTItcU53QkxnUFFRalc2REp2S1F3U0Fidy0w', sg_message_id: 'qNwBLgPQQjW6DJvKQwSAbw.filterdrecv-canary-547b64655b-cw6zx-1-6089EA4A-56.0', 'smtp-id': '<qNwBLgPQQjW6DJvKQwSAbw@ismtpd0178p1mdw1.sendgrid.net>', status: '5.2.2', timestamp: 1619651147, tls: 1, type: 'blocked' },
  ];
  const PAYLOAD_MULTI = `${JSON.stringify(multi).split('},{').join('},\r\n{')}\r\n`;
  const KEY_MULTI = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEQ4LIFtWztlsF7skFqOncjD1lun4H5w8XOhyOArHW9RcIx/FfEzx6cikC/yPfUvwaX/JScE7Fc9CJD2afQ9Ok3Q==';
  const SIG_MULTI = 'MEYCIQC/I4o6vCgqRYrTljjoVWB/GRWNtxeePlLMHr3x9ETeRQIhAIpV+03nREPTTHWSW0wIOA0EoMPdcNgXa70yCaqDJlu5';
  assert.equal(sendgrid.verify(Buffer.from(PAYLOAD_MULTI), h(SIG_MULTI, 1619651159)), false, 'another webhook’s key');
  env({ SENDGRID_WEBHOOK_PUBLIC_KEY: `${PUBLIC_KEY},${KEY_MULTI}` });
  assert.equal(sendgrid.verify(Buffer.from(PAYLOAD_MULTI), h(SIG_MULTI, 1619651159)), true, 'a comma list while the key is changed');
  assert.equal(sendgrid.verify(Buffer.from(PAYLOAD), h(SIGNATURE, TIMESTAMP)), true);
  // The key pasted as a PEM block works too; a key that isn't one refuses, never throws.
  env({ SENDGRID_WEBHOOK_PUBLIC_KEY: `-----BEGIN PUBLIC KEY-----\n${PUBLIC_KEY}\n-----END PUBLIC KEY-----` });
  assert.equal(sendgrid.verify(Buffer.from(PAYLOAD), h(SIGNATURE, TIMESTAMP)), true);
  env({ SENDGRID_WEBHOOK_PUBLIC_KEY: 'not-a-key' });
  assert.equal(sendgrid.verify(Buffer.from(PAYLOAD), h(SIGNATURE, TIMESTAMP)), false);
  env({});
  assert.equal(sendgrid.verify(Buffer.from(PAYLOAD), h(SIGNATURE, TIMESTAMP)), false, 'no key set');
  // And the vectors read as events: a drop for a bounced address; a "blocked" bounce is not permanent.
  const one = sendgrid.parse(Buffer.from(PAYLOAD), hdr({}));
  assert.deepEqual(one, [{ id: 'ZHJvcC0xMDk5NDkxOS1MUnpYbF9OSFN0T0doUTRrb2ZTbV9BLTA', kind: 'suppressed', ref: null, messageId: 'LRzXl_NHStOGhQ4kofSm_A', email: 'hello@world.com', at: '2020-09-14T19:41:32.000Z', reason: 'bounce', detail: 'Bounced Address' }]);
  const two = sendgrid.parse(Buffer.from(PAYLOAD_MULTI), hdr({}));
  assert.deepEqual(two.map((e) => [e.kind, e.permanent, e.messageId]), [['deferred', undefined, 'qNwBLgPQQjW6DJvKQwSAbw']], 'processed is not ours; blocked is not a dead address');
});

test('SendGrid: events read into base.win’s kinds — both spellings of a spam report, our ref wherever it rides, drops by their reason', () => {
  const parse = (...events) => sendgrid.parse(Buffer.from(JSON.stringify(events)), hdr({}));
  const e = (event, more = {}) => ({ email: 'Ana@Example.org', timestamp: 1793728800, event, sg_event_id: `ev-${event}`, sg_message_id: 'abc123.filter-1', ref: 'row-1', ...more });
  assert.deepEqual(parse(e('delivered')), [{ id: 'ev-delivered', kind: 'delivered', ref: 'row-1', messageId: 'abc123', email: 'ana@example.org', at: '2026-11-03T18:00:00.000Z' }]);
  const hard = parse(e('bounce', { type: 'bounce', status: '5.1.1', reason: '550 no such user' }))[0];
  assert.deepEqual([hard.kind, hard.permanent, hard.detail], ['bounced', true, '5.1.1 550 no such user']);
  assert.equal(parse(e('bounce', { type: 'blocked', reason: 'spam block' }))[0].kind, 'deferred');
  assert.equal(parse(e('bounce', { reason: 'x' }))[0].kind, 'deferred', 'a bounce that doesn’t say its type: not a reason to stop an address');
  assert.equal(parse(e('deferred', { response: '451 later' }))[0].kind, 'deferred');
  for (const name of ['spamreport', 'spam report', 'spam_report', 'SpamReport']) assert.equal(parse(e(name))[0].kind, 'complained', name);
  // A drop: SendGrid refused to send. About the address → suppressed (why, in its words); about anything else → failed.
  const d = (reason) => parse(e('dropped', { reason }))[0];
  assert.deepEqual([d('Bounced Address').kind, d('Bounced Address').reason], ['suppressed', 'bounce']);
  assert.deepEqual([d('Spam Reporting Address').kind, d('Spam Reporting Address').reason], ['suppressed', 'complaint']);
  assert.deepEqual([d('Unsubscribed Address').kind, d('Unsubscribed Address').reason, d('Unsubscribed Address').detail], ['suppressed', 'bounce', 'Unsubscribed Address']);
  assert.deepEqual([d('Spam Content').kind, d('Spam Content').reason], ['failed', undefined], 'the message, not the address');
  assert.equal(d('Invalid SMTPAPI header').kind, 'failed');
  // Our ref: a top-level key, or inside custom_args / unique_args.
  assert.equal(parse(e('delivered', { ref: undefined, custom_args: { ref: 'row-2' } }))[0].ref, 'row-2');
  assert.equal(parse(e('delivered', { ref: undefined, unique_args: { ref: 'row-3' } }))[0].ref, 'row-3');
  assert.equal(parse(e('delivered', { ref: undefined }))[0].ref, null);
  // What base.win doesn't use, several at once, and an event with no id of its own (the same bytes → the same id).
  assert.deepEqual(parse(e('processed'), e('open'), e('click'), e('unsubscribe'), e('group_unsubscribe')), []);
  assert.deepEqual(parse(e('delivered'), e('processed'), e('bounce', { type: 'bounce' })).map((x) => x.kind), ['delivered', 'bounced']);
  const noId = () => parse(e('delivered', { sg_event_id: undefined }))[0].id;
  assert.match(noId(), /^[0-9a-f]{40}$/);
  assert.equal(noId(), noId());
  assert.deepEqual(sendgrid.parse(Buffer.from('{"not":"a list"}'), hdr({})), [], 'not a list of events: nothing');
  assert.throws(() => sendgrid.parse(Buffer.from('not json'), hdr({})));
});
