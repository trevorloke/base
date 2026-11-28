// "Authorized by …": one rule for every channel (shared/site/authorized.js).
// The rule itself (pure), then what each channel sends with the line set
// and with it empty, the "needed from" date, and the saved settings. Only
// made-up names here ("Ada Agent", 604-555-0100). Email goes to a stubbed
// Resend and texts to a stubbed Twilio (fetch, inside this file only).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANNELS, CHANNEL_IDS, authorizedLine, authorizedSet, authorizedText, authorizedHtml, authorizedSms, neededFrom, needsConfirm,
} from '../../shared/site/authorized.js';
import { authorizedBy, LEGAL_ENGLISH, LEGAL_KEYS, slotsOf } from '../../shared/site/wording.js';
import { digestOf } from '../../shared/site/legal-words.js';
import { renderSite } from '../ext/site/render/index.js';
import * as rules from '../ext/texting/rules.js';
import { runDueJobs } from '../lib/jobs.js';
import { cacheClear } from '../ext/site/cache.js';
import { campaign, hit, ok as okHit, member } from './site-helpers.js';

const AGENT = 'Ada Agent';
const CONTACT = '604-555-0100';
const LINE = `Authorized by ${AGENT}, ${CONTACT}`;
const STOP = 'Reply STOP to opt out';
const PA = 'ਮਨਜ਼ੂਰ {agent} {contact}';
const tag = Math.random().toString(36).slice(2, 8);
const { withFooter, _setClockForTest } = rules;
const withAuthorized = (...a) => rules.withAuthorized(...a);
// The desk's words after a publish (web/src/pages/publishWords.js).
const desk = await import('../../web/src/pages/publishWords.js').catch(() => ({}));
const publishedWords = (...a) => desk.publishedWords(...a);

// ── The rule (pure) ──

const legalPa = (words = PA, english = LEGAL_ENGLISH.authorizedBy) => ({
  pa: digestOf({ english: { ...LEGAL_ENGLISH, authorizedBy: english }, words: { authorizedBy: words } }),
});

test('T5. the one answer: set, partial, legacy, empty, a translation, a stale one, an unknown channel', () => {
  const set = authorizedLine({ agentName: AGENT, agentContact: CONTACT }, { channel: 'site' });
  assert.deepEqual([set.include, set.en, set.status, set.local, set.form], [true, LINE, 'set', null, 'html-footer']);
  const nameOnly = authorizedLine({ agentName: AGENT }, { channel: 'email-list' });
  assert.deepEqual([nameOnly.en, nameOnly.status], [`Authorized by ${AGENT}`, 'partial'], 'no trailing comma');
  const legacy = authorizedLine({ authorizationLine: 'Authorized by Old Example, official agent' }, { channel: 'site', lang: 'pa', legal: legalPa() });
  assert.deepEqual([legacy.en, legacy.status, legacy.local], ['Authorized by Old Example, official agent', 'partial', null], 'the old free line is English only');
  const empty = authorizedLine({}, { channel: 'sms-list' });
  assert.deepEqual([empty.include, empty.en, empty.status, empty.warn, empty.required], [false, '', 'empty', null, false]);
  const pa = authorizedLine({ agentName: AGENT, agentContact: CONTACT }, { channel: 'site', lang: 'pa', legal: legalPa() });
  assert.deepEqual(pa.local, { text: `ਮਨਜ਼ੂਰ ${AGENT} ${CONTACT}`, lang: 'pa' });
  const stale = authorizedLine({ agentName: AGENT, agentContact: CONTACT }, { channel: 'site', lang: 'pa', legal: legalPa(PA, 'Authorized by {agent}') });
  assert.equal(stale.local, null, 'an approval of other English is not drawn');
  assert.equal(authorizedLine({ agentName: AGENT }, { channel: 'site', lang: 'zh-Hans', legal: legalPa() }).local, null, 'only the page’s own language');
  assert.throws(() => authorizedLine({ agentName: AGENT }, { channel: 'sms-blast' }), /unknown channel 'sms-blast'/);
  // never: nothing, even when set; copy: the words for the Copy button.
  assert.deepEqual([authorizedLine({ agentName: AGENT, agentContact: CONTACT }, { channel: 'receipts' }).include, authorizedLine({ agentName: AGENT, agentContact: CONTACT }, { channel: 'receipts' }).en], [false, '']);
  assert.deepEqual([authorizedLine({ agentName: AGENT, agentContact: CONTACT }, { channel: 'print' }).include, authorizedLine({ agentName: AGENT, agentContact: CONTACT }, { channel: 'print' }).en], [false, LINE]);
  // The shapes.
  assert.equal(authorizedText(pa), `${LINE}\nਮਨਜ਼ੂਰ ${AGENT} ${CONTACT}`);
  assert.equal(authorizedSms(set), `\n${LINE}`);
  assert.equal(authorizedHtml(pa), `<p class="footer-authorization" lang="en">${LINE}</p><p class="footer-authorization" lang="pa">ਮਨਜ਼ੂਰ ${AGENT} ${CONTACT}</p>`);
  assert.equal(authorizedHtml(authorizedLine({ agentName: '<b>' }, { channel: 'embed' })), '<p class="footer-authorization">Authorized by &lt;b&gt;</p>');
  assert.equal(authorizedText(empty) + authorizedSms(empty) + authorizedHtml(empty), '');
  assert.deepEqual(['set', 'partial', 'partial', 'empty'], [{ agentName: 'A', agentContact: 'B' }, { agentName: 'A' }, { authorizationLine: 'X' }, { agentContact: 'B' }].map(authorizedSet));
});

test('T6. the English is the same everywhere: wording.js authorizedBy and the rule agree', () => {
  const fixtures = [
    {}, { agentName: AGENT }, { agentName: AGENT, agentContact: CONTACT }, { agentName: `  ${AGENT} `, agentContact: ` ${CONTACT}  ` },
    { agentContact: CONTACT }, { authorizationLine: 'Authorized by Old Example' }, { agent_name: 'Bo Example', agent_contact: 'bo@example.org' },
    { authorization: 'Authorized by Cy Example, 555-0199' }, { agentName: 'Dee Example', authorizationLine: 'ignored while an agent is named' },
    { agentName: 'Eve   Example', agentContact: 'PO Box 12,  Surrey BC' },
  ];
  for (const org of fixtures) assert.equal(authorizedLine(org, { channel: 'site' }).en, authorizedBy(org), JSON.stringify(org));
});

test('T13. empty means nothing: every channel, with every field empty', () => {
  for (const id of CHANNEL_IDS) {
    const a = authorizedLine({}, { channel: id, lang: 'pa', legal: legalPa() });
    assert.deepEqual([a.include, a.en, a.local, a.warn, needsConfirm(a)], [false, '', null, null, false], id);
  }
  // Even with a date typed: nothing is refused while it isn't due.
  assert.equal(needsConfirm(authorizedLine({ authorizedFrom: '2099-01-01' }, { channel: 'email-list' })), false);
});

test('T15. the "needed from" date: empty, 15 days before, 14 days before, on the day — in campaign time', () => {
  const at = new Date('2026-10-01T19:00:00Z'); // noon in Vancouver
  assert.deepEqual(neededFrom({}, at), { from: null, required: false, daysLeft: null, level: null });
  assert.deepEqual(neededFrom({ authorizedFrom: 'soon' }, at).level, null, 'not a date: as if empty');
  assert.equal(neededFrom({ authorizedFrom: '2026-10-16' }, at).level, null, '15 days before: quiet');
  assert.equal(neededFrom({ authorizedFrom: '2026-10-15' }, at).level, 'soon', '14 days before: amber');
  assert.deepEqual(neededFrom({ authorizedFrom: '2026-10-01' }, at), { from: '2026-10-01', required: true, daysLeft: 0, level: 'due' });
  // 11 pm in Vancouver on Sept 30 is already Oct 1 in UTC: still the 30th here.
  assert.equal(neededFrom({ authorizedFrom: '2026-10-01' }, new Date('2026-10-01T06:00:00Z'), 'America/Vancouver').level, 'soon');
  const missing = authorizedLine({ authorizedFrom: '2026-10-01' }, { channel: 'email-list', now: at });
  assert.deepEqual(missing.warn, { level: 'due', gap: 'missing', from: '2026-10-01' });
  assert.equal(needsConfirm(missing), true);
  const partial = authorizedLine({ agentName: AGENT, authorizedFrom: '2026-10-01' }, { channel: 'email-list', now: at });
  assert.deepEqual([partial.include, partial.warn, needsConfirm(partial)], [true, { level: 'due', gap: 'partial', from: '2026-10-01' }, false], 'a partial line warns and never asks');
  const full = authorizedLine({ agentName: AGENT, agentContact: CONTACT, authorizedFrom: '2026-10-01' }, { channel: 'email-list', now: at });
  assert.deepEqual([full.warn, full.required], [null, true]);
});

test('T10. the vote guide embed in Punjabi shows the English line and the approved Punjabi one', () => {
  const site = { org: { name: 'Example Campaign', agentName: AGENT, agentContact: CONTACT } };
  const page = { id: null, slug: 'voter-guide', title: '', description: '', modules: [{ id: 'voter-guide', kind: 'voterguide', hidden: false, props: {} }] };
  const tr = { look: (t) => ({ text: t, lang: 'en' }) };
  const html = renderSite({ kind: 'page', site, page, data: {}, ctx: { embed: true, lang: 'pa', tr, legal: { ...legalPa().pa, slots: {} } } }).html.replace(/<!-- -->/g, '');
  assert.match(html, new RegExp(`<p class="footer-authorization" lang="en">${LINE}</p><p class="footer-authorization" lang="pa">ਮਨਜ਼ੂਰ ${AGENT} ${CONTACT}</p>`));
  const en = renderSite({ kind: 'page', site, page, data: {}, ctx: { embed: true } }).html.replace(/<!-- -->/g, '');
  assert.match(en, new RegExp(`<p class="footer-authorization">${LINE}</p>`));
  const none = renderSite({ kind: 'page', site: { org: { name: 'Example Campaign' } }, page, data: {}, ctx: { embed: true } }).html;
  assert.doesNotMatch(none, /Authorized by/);
});

test('texts: the line before the STOP line, never two STOP lines, never the line twice', () => {
  const a = authorizedLine({ agentName: AGENT, agentContact: CONTACT }, { channel: 'sms-list' });
  assert.equal(withFooter(withAuthorized('Hi from Example Campaign', a)), `Hi from Example Campaign\n${LINE}\n${STOP}`);
  assert.equal(withFooter(withAuthorized(`Example Campaign here. ${STOP}`, a)), `Example Campaign here.\n${LINE}\n${STOP}`);
  assert.equal(withFooter(withAuthorized(`Example Campaign here.\n${LINE}`, a)), `Example Campaign here.\n${LINE}\n${STOP}`);
  assert.equal(withFooter(withAuthorized('Hi from Example Campaign', authorizedLine({}, { channel: 'sms-list' }))), `Hi from Example Campaign\n${STOP}`);
});

test('T18. the desk: a publish with the agent set and no old free line says nothing is missing', () => {
  assert.doesNotMatch(publishedWords({ org: { agentName: AGENT, agentContact: CONTACT, authorizationLine: '' } }).text, /Authorized by/);
  assert.match(publishedWords({ org: {} }).text, /Your site has no ‘Authorized by’ line yet/);
  assert.doesNotMatch(publishedWords({ org: { authorizationLine: 'Authorized by Old Example' } }).text, /Authorized by/);
  assert.equal(publishedWords({ org: {} }).noAuth, true);
});

// ── What each channel sends ──

const ENV = ['RESEND_API_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM', 'BASE_PUBLIC_URL', 'TWILIO_API_BASE', 'RESEND_API_BASE'];
const savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const realFetch = globalThis.fetch;
const mails = [];
const texts = [];
// Addresses and numbers the stubbed providers refuse, and how many times.
const refuse = new Map();
const refused = (who) => {
  const n = refuse.get(who) || 0;
  if (n > 0) refuse.set(who, n - 1);
  return n > 0;
};
let db, mgr, ws, vol;
const P = {};
const okA = (r, msg = '') => { assert.equal(r.status, 200, `${msg} ${JSON.stringify(r.json)}`); return r.json; };
const mail = (who) => `${who}.auth.${tag}@example.org`;

const orgNow = async () => okA(await mgr.get('/api/site')).settings.org;
const setOrg = async (patch) => { okA(await mgr.action('site.settings.save', { org: { ...(await orgNow()), ...patch } }), 'org save'); cacheClear(); };
const EMPTY = { agentName: '', agentContact: '', authorizationLine: '', authorizedFrom: '', address: '', email: '' };
const SET = { agentName: AGENT, agentContact: CONTACT, address: 'PO Box 12, Surrey BC', email: 'hello@example.org' };
const clearOut = () => { mails.length = 0; texts.length = 0; };
const lastMailTo = (to) => [...mails].reverse().find((m) => m.to.includes(to));

before(async () => {
  ({ db, mgr, ws } = await campaign('Example Campaign'));
  process.env.RESEND_API_KEY = 'test-key';
  delete process.env.RESEND_API_BASE;
  process.env.TWILIO_ACCOUNT_SID = `ACtest${tag}`;
  process.env.TWILIO_AUTH_TOKEN = `tok-${tag}`;
  process.env.TWILIO_FROM = '+16045550199';
  process.env.BASE_PUBLIC_URL = 'https://example-campaign.example';
  delete process.env.TWILIO_API_BASE;
  let sid = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://api.resend.com')) {
      const m = JSON.parse(init.body);
      if ([m.to].flat().some(refused)) return new Response(JSON.stringify({ message: 'refused' }), { status: 422 });
      mails.push(m);
      return new Response(JSON.stringify({ id: `msg-${mails.length}` }), { status: 200 });
    }
    if (u.startsWith('https://api.twilio.com/')) {
      const t = Object.fromEntries(new URLSearchParams(String(init.body || '')));
      if (refused(t.To)) return new Response(JSON.stringify({ code: 21211, message: 'refused' }), { status: 400, headers: { 'content-type': 'application/json' } });
      texts.push(t);
      return new Response(JSON.stringify({ sid: `SM${tag}${++sid}`, status: 'queued' }), { status: 201, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(url, init);
  };
  _setClockForTest(() => new Date('2026-10-22T19:00:00Z')); // noon in Surrey: texting hours
  vol = await member(mgr, 'volunteer', 'Vic Example');
  const mk = async (key, extra) => { P[key] = await mgr.createPerson(`${key[0].toUpperCase()}${key.slice(1)} Example`, { tags: [`auth${tag}`], ...extra }); };
  await mk('ana', { email: mail('ana'), phone: '604-555-0101' });
  await mk('ben', { email: mail('ben'), phone: '604-555-0102' });
  await mk('cy', { email: mail('cy'), phone: '604-555-0103', tags: [`auth${tag}`, 'media'] });
  // Dee is on no list: her texts are one person's, from the Inbox.
  P.dee = await mgr.createPerson('Dee Example', { phone: '604-555-0104' });
  // Eve and Fay are on ladders only (a text blast's conversation would hold a ladder's text).
  P.eve = await mgr.createPerson('Eve Example', { email: mail('eve'), phone: '604-555-0105' });
  P.fay = await mgr.createPerson('Fay Example', { email: mail('fay'), phone: '604-555-0106' });
  okA(await mgr.action('subscription.add', { email: mail('eve'), name: 'Eve Example' }));
  okA(await mgr.action('subscription.add', { email: mail('fay'), name: 'Fay Example' }));
  okA(await mgr.action('subscription.add', { email: mail('ana'), name: 'Ana Example' }));
  okA(await mgr.action('subscription.add', { email: mail('cy'), name: 'Cy Example' }));
});
after(() => {
  globalThis.fetch = realFetch;
  _setClockForTest(null);
  for (const k of ENV) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
});

const audience = { filter: { tag: `auth${tag}` } };

test('T13. with every field empty no channel carries the line, and nothing is refused or held', async () => {
  await setOrg(EMPTY);
  clearOut();
  okA(await mgr.action('blast.send', { kind: 'eblast', subject: 'Hello', body: 'Hi there', audience }));
  okA(await mgr.action('blast.send', { kind: 'newsletter', subject: 'News', body: 'Hi there' }));
  okA(await mgr.action('blast.send', { kind: 'text', body: 'Hi from Example Campaign', audience }));
  okA(await mgr.action('blast.test', { kind: 'eblast', subject: 'Hello', body: 'Hi there' }));
  assert.ok(mails.length >= 4 && texts.length >= 3);
  for (const m of mails) assert.doesNotMatch(`${m.text}\n${m.html}`, /Authorized by/);
  for (const t of texts) assert.doesNotMatch(t.Body, /Authorized by/);
  const home = await hit('/site/');
  assert.doesNotMatch(home.text, /Authorized by/);
  const k = okA(await mgr.action('share.kit.save', { title: 'Empty', body: 'Have a look', path: '/' })).kit;
  assert.equal(okA(await vol.client.get('/api/share')).kits.find((x) => x.id === k.id).text, 'Have a look');
});

test('T7. a text blast: …\\nAuthorized by Ada Agent, 604-555-0100\\nReply STOP to opt out — once, whatever was typed', async () => {
  await setOrg(SET);
  clearOut();
  okA(await mgr.action('blast.send', { kind: 'text', body: 'Hi from Example Campaign', audience }));
  assert.ok(texts.length >= 3);
  for (const t of texts) assert.equal(t.Body, `Hi from Example Campaign\n${LINE}\n${STOP}`);
  clearOut();
  okA(await mgr.action('blast.send', { kind: 'text', body: `Example Campaign here. ${STOP}`, audience }));
  for (const t of texts) assert.equal(t.Body, `Example Campaign here.\n${LINE}\n${STOP}`, 'one STOP line');
  clearOut();
  okA(await mgr.action('blast.send', { kind: 'text', body: `Example Campaign here.\n${LINE}`, audience }));
  for (const t of texts) assert.equal(t.Body, `Example Campaign here.\n${LINE}\n${STOP}`, 'the line once');
});

test('T11. the first Inbox text carries the line; the second does not', async () => {
  await setOrg(SET);
  clearOut();
  const first = okA(await mgr.action('text.send', { person_id: P.dee.id, body: `Hi Dee, it's Example Campaign. ${STOP}` }));
  assert.equal(first.message.body, `Hi Dee, it's Example Campaign.\n${LINE}\n${STOP}`);
  const second = okA(await mgr.action('text.reply', { conversation_id: first.conversation_id, body: 'Thanks again!' }));
  assert.equal(second.message.body, 'Thanks again!');
  assert.deepEqual(texts.map((t) => t.Body), [first.message.body, 'Thanks again!']);
});

test('T12. newsletter, email blast, press release and the test copy all carry the line in both parts', async () => {
  await setOrg(SET);
  clearOut();
  okA(await mgr.action('blast.send', { kind: 'newsletter', subject: 'News', body: 'Hi there' }));
  okA(await mgr.action('blast.send', { kind: 'eblast', subject: 'Hello', body: 'Hi there', audience }));
  okA(await mgr.action('media.send', { subject: 'Release', body: 'For release' }));
  okA(await mgr.action('blast.test', { kind: 'newsletter', subject: 'News', body: 'Hi there' }));
  assert.ok(mails.length >= 6);
  for (const m of mails) {
    assert.match(m.text, new RegExp(`\\n${LINE}\\.\\n`), m.subject);
    assert.match(m.html, new RegExp(`<br>${LINE}\\.`), m.subject);
    assert.match(m.text, /PO Box 12, Surrey BC\.\nhello@example\.org\./, 'the address and contact');
  }
});

test('T12. the A/B test’s rest gets the line from the winner job', async () => {
  await setOrg(SET);
  for (let i = 0; i < 50; i += 1) await mgr.action('subscription.add', { email: mail(`ab${i}`), name: `Reader ${i}` });
  clearOut();
  const s = okA(await mgr.action('blast.send', { kind: 'newsletter', subject: 'Subject A', body: 'Hi', ab: { subject_b: 'Subject B', pct: 10, wait_hours: 1, metric: 'opens' } }));
  assert.ok(s.blast.ab);
  const sentFirst = mails.length;
  await db.query(`update jobs set run_at = now() - interval '1 second' where workspace_id = $1 and kind = 'abtests.winner' and status = 'pending'`, [ws]);
  await runDueJobs(db, { workspaceId: ws });
  const rest = mails.slice(sentFirst);
  assert.ok(rest.length > 30, `the rest went (${rest.length})`);
  for (const m of rest) assert.match(m.text, new RegExp(`\\n${LINE}\\.\\n`));
});

// A ladder with an email step and a text step, started by a tag.
const ladderFor = async (name, steps, { lang = null } = {}) => {
  const l = okA(await mgr.action('ladder.create', { name, trigger: { kind: 'tag', ref: `lad${name}${tag}` }, steps })).ladder;
  if (lang) await db.query('update ladders set trigger_lang = $3 where id = $1 and workspace_id = $2', [l.id, ws, lang]);
  return l;
};
const runLadders = async () => {
  for (let i = 0; i < 20; i += 1) {
    await db.query("update jobs set run_at = now() - interval '1 second' where workspace_id = $1 and status = 'pending' and kind = 'ladder.step'", [ws]);
    const r = await runDueJobs(db, { workspaceId: ws });
    if (r.ran + r.failed === 0) break;
  }
};
const STEPS = [
  { kind: 'email', subject: 'Welcome', body: 'Hi {{first_name}}, *thanks* for joining.' },
  { kind: 'text', body: 'Hi {{first_name}}, it’s {{campaign}}.' },
];

test('T8. a ladder email: the line, the mailing address and the contact, text only; a ladder text: the line before STOP', async () => {
  await setOrg(SET);
  const l = await ladderFor('en', STEPS);
  okA(await mgr.action('ladder.setActive', { id: l.id, active: true }));
  clearOut();
  okA(await mgr.action('person.update', { id: P.eve.id, tags: [`laden${tag}`] }));
  await runLadders();
  const m = lastMailTo(mail('eve'));
  assert.ok(m, 'the ladder email went');
  assert.equal(m.html, undefined, 'no HTML part');
  assert.match(m.text, /^Hi Eve, \*thanks\* for joining\.\n\n—\nSent by Example Campaign\.\nPO Box 12, Surrey BC\.\nhello@example\.org\.\nAuthorized by Ada Agent, 604-555-0100\.\nUnsubscribe: https:\/\/example-campaign\.example\/lu\/[0-9a-f-]{36}$/);
  const t = texts.find((x) => x.To === '+16045550105');
  assert.equal(t?.Body, `Hi Eve, it’s Example Campaign.\n${LINE}\n${STOP}`);
});

test('T8. a ladder in Punjabi also carries the approved Punjabi line', async () => {
  await setOrg(SET);
  okA(await mgr.action('site.legal.approve', { lang: 'pa', words: Object.fromEntries(LEGAL_KEYS.map((k) => [k, `ਮਨਜ਼ੂਰ ${slotsOf(LEGAL_ENGLISH[k]).map((x) => `{${x}}`).join(' ')}`.trim()])) }));
  const l = await ladderFor('pa', STEPS, { lang: 'pa' });
  okA(await mgr.action('ladder.setActive', { id: l.id, active: true }));
  clearOut();
  okA(await mgr.action('person.update', { id: P.fay.id, tags: [`ladpa${tag}`] }));
  await runLadders();
  const m = lastMailTo(mail('fay'));
  assert.match(m.text, new RegExp(`\\n${LINE}\\.\\nਮਨਜ਼ੂਰ ${AGENT} ${CONTACT}\\.\\nUnsubscribe: `));
  assert.equal(texts.find((x) => x.To === '+16045550106')?.Body, `Hi Fay, it’s Example Campaign.\n${LINE}\nਮਨਜ਼ੂਰ ${AGENT} ${CONTACT}\n${STOP}`);
});

test('T8. a ladder email whose words already end with the line typed in: the line once, at the foot only if it isn’t there', async () => {
  await setOrg(SET);
  const gil = await mgr.createPerson('Gil Example', { email: mail('gil') });
  okA(await mgr.action('subscription.add', { email: mail('gil'), name: 'Gil Example' }));
  const l = await ladderFor('typed', [{ kind: 'email', subject: 'Welcome', body: `Hi {{first_name}}, thanks for joining.\n\n${LINE}` }]);
  okA(await mgr.action('ladder.setActive', { id: l.id, active: true }));
  clearOut();
  okA(await mgr.action('person.update', { id: gil.id, tags: [`ladtyped${tag}`] }));
  await runLadders();
  const m = lastMailTo(mail('gil'));
  assert.ok(m, 'the ladder email went');
  assert.equal(m.text.split(LINE).length - 1, 1, `the line once:\n${m.text}`);
  assert.match(m.text, new RegExp(`^Hi Gil, thanks for joining\\.\\n\\n${LINE}\\n\\n—\\nSent by Example Campaign\\.\\nPO Box 12, Surrey BC\\.\\nhello@example\\.org\\.\\nUnsubscribe: `));
});

test('T9. a share kit saved without the line still shows it; the 500 check counts it; the saved choice is kept', async () => {
  await setOrg(SET);
  const k = okA(await mgr.action('share.kit.save', { title: 'Old choice', body: 'Have a look', path: '/', authorized: false })).kit;
  const shared = okA(await vol.client.get('/api/share')).kits.find((x) => x.id === k.id);
  assert.equal(shared.text, `Have a look\n${LINE}`);
  const long = await mgr.action('share.kit.save', { title: 'Long', body: 'x'.repeat(480), path: '/', authorized: false });
  assert.deepEqual([long.status, long.json.error], [400, 'Too long with the Authorized by line — shorten the words']);
  // The column is never overwritten: a save without the box keeps what was stored.
  okA(await mgr.action('share.kit.save', { id: k.id, title: 'Old choice', body: 'Have a look again', path: '/' }));
  assert.equal((await db.query('select authorized from share_kits where id = $1', [k.id])).rows[0].authorized, false);
  // A kit saved near 500 before the line was set: the desk is told, its words are not changed.
  await setOrg(EMPTY);
  const near = okA(await mgr.action('share.kit.save', { title: 'Near', body: 'y'.repeat(490), path: '/' })).kit;
  await setOrg(SET);
  const desk = okA(await mgr.get('/api/share/kits'));
  assert.equal(desk.line, LINE);
  assert.equal(desk.kits.find((x) => x.id === near.id).body, 'y'.repeat(490));
  assert.equal(desk.kits.find((x) => x.id === near.id).over, true);
  assert.equal(desk.over, 1);
});

test('T9. a share kit whose words already carry the line typed in: shared with it once, counted once, never refused for it', async () => {
  await setOrg(SET);
  const typed = okA(await mgr.action('share.kit.save', { title: 'Typed', body: `Vote!\n${LINE}`, path: '/', authorized: false })).kit;
  assert.equal(okA(await vol.client.get('/api/share')).kits.find((x) => x.id === typed.id).text, `Vote!\n${LINE}`);
  // Near 500 with the line in its words: it fits, and the desk doesn't call it over.
  const body = `${'z'.repeat(500 - LINE.length - 1)}\n${LINE}`;
  assert.equal(body.length, 500);
  const near = okA(await mgr.action('share.kit.save', { title: 'Typed near', body, path: '/' }), 'a 500-character kit with the line typed in').kit;
  const desk = okA(await mgr.get('/api/share/kits'));
  assert.equal(desk.kits.find((x) => x.id === near.id).over, false);
  assert.equal(okA(await vol.client.get('/api/share')).kits.find((x) => x.id === near.id).text, body);
  assert.equal((await db.query('select authorized from share_kits where id = $1', [typed.id])).rows[0].authorized, false, 'the saved choice is kept');
});

test('the unsubscribe pages every email links to (/u, /bu, /lu) carry it; with it empty they don’t', async () => {
  const one = async (sql) => (await db.query(sql, [ws])).rows[0]?.id;
  const sub = await one('select id from subscriptions where workspace_id = $1 limit 1');
  const rcpt = await one("select r.id from blast_recipients r join blasts b on b.id = r.blast_id where r.workspace_id = $1 and b.kind = 'eblast' and r.email is not null limit 1");
  const run = await one('select r.id from ladder_runs r join persons p on p.id = r.person_id where r.workspace_id = $1 and p.email is not null limit 1');
  assert.ok(sub && rcpt && run, 'a subscription, an email blast recipient and a ladder run to unsubscribe');
  const paths = [`/u/${sub}`, `/bu/${rcpt}`, `/lu/${run}`];
  await setOrg(SET);
  for (const p of paths) {
    const r = await hit(p);
    assert.equal(r.status, 200, p);
    assert.match(r.text, /Unsubscribe/, p);
    assert.ok(r.text.includes(`<p class="auth">${LINE}</p>`), `${p}: the line`);
  }
  await setOrg(EMPTY);
  for (const p of paths) assert.doesNotMatch((await hit(p)).text, /Authorized by/, p);
  await setOrg(SET);
});

test('a public lesson page (/learn) carries it; with it empty it doesn’t', async () => {
  const slug = (await db.query('select slug from workspaces where id = $1', [ws])).rows[0].slug;
  await setOrg(SET);
  const r = await hit(`/learn/${slug}`);
  assert.equal(r.status, 200);
  assert.ok(r.text.includes(`<p class="auth">${LINE}</p>`), 'the line');
  await setOrg(EMPTY);
  assert.doesNotMatch((await hit(`/learn/${slug}`)).text, /Authorized by/);
  await setOrg(SET);
});

test('the website, plain pages, the calendar file, the link preview and the share sheet carry it', async () => {
  await setOrg(SET);
  const home = await hit('/site/');
  assert.match(home.text.replace(/<!-- -->/g, ''), new RegExp(`<span class="footer-authorization">${LINE}</span>`));
  assert.match(home.text, new RegExp(`<meta property="og:description" content="[^"]* · ${LINE}">|<meta property="og:description" content="${LINE}">`));
  const bad = await hit('/site/preferences?t=nope');
  assert.match(bad.text, new RegExp(`<p class="auth">${LINE}</p>`));
});

test('the calendar file carries it: each public event’s description ends with the line', async () => {
  await setOrg(SET);
  okA(await mgr.get('/api/site'));
  okA(await mgr.action('shift.createMany', { kind: 'event', location: 'Example Hall', days: ['2030-06-01'], start: '11:00', end: '14:00', name: 'Example picnic', public: true }));
  cacheClear();
  const r = await hit('/site/events.ics');
  assert.equal(r.status, 200);
  const body = r.text.replace(/\r\n[ \t]/g, '');
  assert.ok(body.includes(LINE.replace(/,/g, '\\,')), 'the line, as the calendar writes a comma');
  await setOrg(EMPTY);
  assert.doesNotMatch((await hit('/site/events.ics')).text.replace(/\r\n[ \t]/g, ''), /Authorized by/);
  await setOrg(SET);
});

test('a supporter’s share words carry it: the "I signed …" words a petition offers', () => {
  const camp = { id: 'c1', slug: 'fix-it', kind: 'petition', title: 'Fix it', status: 'open' };
  const draw = (org) => renderSite({ kind: 'campaign', site: { org: { name: 'Example Campaign', ...org } }, campaign: camp, data: { campaigns: { c1: camp } }, ctx: { root: '/', path: '/act/fix-it', origin: 'https://example-campaign.example' } }).html;
  const shares = (h) => [...h.matchAll(/"share":\{[^}]*"text":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`));
  const set = shares(draw({ agentName: AGENT, agentContact: CONTACT }));
  assert.ok(set.length >= 1, 'the petition offers its share words');
  for (const t of set) assert.equal(t, `I signed “Fix it”. Add your name:\n${LINE}`);
  for (const t of shares(draw({}))) assert.equal(t, 'I signed “Fix it”. Add your name:');
});

test('Gmail: a staffer’s own email gets the line as a signature', async () => {
  const { gmailSignature } = await import('../ext/gmail/actions.js');
  assert.equal(gmailSignature('Hi Ana', authorizedLine({ agentName: AGENT, agentContact: CONTACT }, { channel: 'email-one' })), `Hi Ana\n\n${LINE}`);
  assert.equal(gmailSignature(`Hi Ana\n\n${LINE}`, authorizedLine({ agentName: AGENT, agentContact: CONTACT }, { channel: 'email-one' })), `Hi Ana\n\n${LINE}`);
  assert.equal(gmailSignature('Hi Ana', authorizedLine({}, { channel: 'email-one' })), 'Hi Ana');
});

test('T14. transactional stays clean: a shift notice and a password reset never carry the line, even when set', async () => {
  await setOrg(SET);
  clearOut();
  const at = new Date(Date.now() + 3 * 86400e3).toISOString();
  const shift = okA(await mgr.action('shift.create', { title: 'Saturday canvass', starts_at: at, ends_at: new Date(Date.parse(at) + 7200e3).toISOString() })).shift;
  okA(await mgr.action('shift.assign', { shift_id: shift.id, person_id: P.ana.id }));
  okA(await mgr.action('shift.notify', { shift_id: shift.id }));
  assert.ok(mails.length + texts.length >= 1, 'the notice went');
  for (const m of mails) assert.doesNotMatch(`${m.text}${m.html || ''}`, /Authorized by/);
  for (const t of texts) assert.doesNotMatch(t.Body, /Authorized by/);
  // A password reset (an account email).
  const { _lastResetWork } = await import('../ext/passwords/reset.js');
  clearOut();
  const who = (await db.query('select u.email from users u join memberships m on m.user_id = u.id where m.workspace_id = $1 and m.role = $2 limit 1', [ws, 'manager'])).rows[0].email;
  await hit('/api/auth/forgot', { method: 'POST', body: { email: who } });
  await _lastResetWork();
  assert.ok(mails.some((m) => m.to.includes(who)), 'the reset email went');
  for (const m of mails) assert.doesNotMatch(`${m.text}${m.html || ''}`, /Authorized by/);
  for (const id of ['shift', 'receipts', 'account', 'office']) assert.equal(CHANNELS[id].include, 'never');
});

// ── The date, the desk's answer, and saved settings ──

const isoDay = (offset = 0) => new Date(Date.now() + offset * 86400e3).toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' });

test('T15. on the day with the line missing: a send asks first (409), "Send without it" sends and is recorded', async () => {
  await setOrg({ ...EMPTY, authorizedFrom: isoDay(0) });
  const r = await mgr.action('blast.send', { kind: 'eblast', subject: 'Hello', body: 'Hi there', audience });
  assert.equal(r.status, 409);
  assert.deepEqual([r.json.needsAuthorized, r.json.from], [true, isoDay(0)]);
  assert.match(r.json.error, /without the Authorized by line/);
  for (const [name, input] of [
    ['blast.test', { kind: 'eblast', subject: 'Hello', body: 'Hi there' }],
    ['media.send', { subject: 'Release', body: 'For release' }],
    ['media.test', { subject: 'Release', body: 'For release' }],
    ['blast.send', { kind: 'text', body: 'Hi from Example Campaign', audience }],
    ['share.kit.save', { title: 'Due', body: 'Words', path: '/' }],
  ]) {
    const no = await mgr.action(name, input);
    assert.deepEqual([no.status, no.json.needsAuthorized], [409, true], name);
    okA(await mgr.action(name, { ...input, withoutAuthorized: true }), `${name} with "Send without it"`);
  }
  const sent = okA(await mgr.action('blast.send', { kind: 'eblast', subject: 'Without', body: 'Hi there', audience, withoutAuthorized: true }));
  const ev = (await db.query("select payload from events where workspace_id = $1 and entity_type = 'blast' and entity_id = $2 and op = 'create'", [ws, sent.blast.id])).rows[0];
  assert.equal(ev.payload.auth_missing, true);
  // A ladder turned on asks too; one already on keeps sending and says so.
  const l = await ladderFor('due', STEPS);
  const on = await mgr.action('ladder.setActive', { id: l.id, active: true });
  assert.deepEqual([on.status, on.json.needsAuthorized], [409, true]);
  okA(await mgr.action('ladder.setActive', { id: l.id, active: true, withoutAuthorized: true }));
  clearOut();
  okA(await mgr.action('person.update', { id: P.ana.id, tags: [...P.ana.tags, `laddue${tag}`] }));
  await runLadders();
  assert.ok(lastMailTo(mail('ana')), 'the automatic email went');
  const missing = (await db.query(
    "select count(*)::int as n from events where workspace_id = $1 and actor_id is null and payload @> '{\"auth_missing\": true}'::jsonb", [ws],
  )).rows[0].n;
  assert.ok(missing >= 1, 'recorded');
  const a = okA(await mgr.get('/api/site/authorized'));
  assert.deepEqual([a.status, a.required, a.warn?.level, a.warn?.gap], ['empty', true, 'due', 'missing']);
  assert.ok(a.automaticMissing >= 1);
  // A partial line after the date: warned, never asked.
  await setOrg({ ...EMPTY, agentName: AGENT, authorizedFrom: isoDay(0) });
  okA(await mgr.action('blast.send', { kind: 'eblast', subject: 'Partial', body: 'Hi there', audience }));
  // 14 days before: amber on the desk, nothing asked.
  await setOrg({ ...EMPTY, authorizedFrom: isoDay(10) });
  assert.equal(okA(await mgr.get('/api/site/authorized')).warn?.level, 'soon');
  okA(await mgr.action('blast.send', { kind: 'eblast', subject: 'Soon', body: 'Hi there', audience }));
  await setOrg({ ...SET, authorizedFrom: '' });
});

test('T15. Today counts each automatic email or text that went without the line once: never a retry, never a refused send', async () => {
  await setOrg({ ...EMPTY, authorizedFrom: isoDay(0) });
  const count = async () => okA(await mgr.get('/api/site/authorized')).automaticMissing;
  // A ladder email the provider refuses twice and then takes, and its text.
  const hal = await mgr.createPerson('Hal Example', { email: mail('hal'), phone: '604-555-0107' });
  okA(await mgr.action('subscription.add', { email: mail('hal'), name: 'Hal Example' }));
  const l = await ladderFor('retry', STEPS);
  okA(await mgr.action('ladder.setActive', { id: l.id, active: true, withoutAuthorized: true }));
  const n0 = await count();
  refuse.set(mail('hal'), 2);
  clearOut();
  okA(await mgr.action('person.update', { id: hal.id, tags: [`ladretry${tag}`] }));
  await runLadders();
  assert.equal(mails.filter((m) => [m.to].flat().includes(mail('hal'))).length, 1, 'the email went on its third try');
  assert.ok(texts.some((t) => t.To === '+16045550107'), 'the text went');
  assert.equal(await count(), n0 + 2, 'one email and one text, not three tries');
  // A ladder text Twilio refuses: nothing went, nothing counted.
  const ivy = await mgr.createPerson('Ivy Example', { phone: '604-555-0108' });
  const lt = await ladderFor('refused', [STEPS[1]]);
  okA(await mgr.action('ladder.setActive', { id: lt.id, active: true, withoutAuthorized: true }));
  refuse.set('+16045550108', 1);
  okA(await mgr.action('person.update', { id: ivy.id, tags: [`ladrefused${tag}`] }));
  await runLadders();
  assert.equal(await count(), n0 + 2, 'a refused text is not counted');
  // The A/B test's rest: only the emails the provider took.
  const n1 = await count();
  const s = okA(await mgr.action('blast.send', { kind: 'newsletter', subject: 'Subject A', body: 'Hi', ab: { subject_b: 'Subject B', pct: 10, wait_hours: 1, metric: 'opens' }, withoutAuthorized: true }));
  for (let i = 0; i < 5; i += 1) refuse.set(mail(`ab${i}`), 9);
  const before = mails.length;
  await db.query(`update jobs set run_at = now() - interval '1 second' where workspace_id = $1 and kind = 'abtests.winner' and status = 'pending'`, [ws]);
  await runDueJobs(db, { workspaceId: ws });
  const went = mails.length - before;
  const failed = (await db.query("select count(*)::int as n from blast_recipients where blast_id = $1 and status = 'failed'", [s.blast.id])).rows[0].n;
  assert.ok(went > 30 && failed >= 1, `the rest went (${went}), some refused (${failed})`);
  assert.equal(await count(), n1 + went, 'each email that went, and no refused one');
  refuse.clear();
  await setOrg({ ...SET, authorizedFrom: '' });
});

test('T16. release safety: an older desk build’s save keeps the date; a bad date is a 400 naming the field', async () => {
  await setOrg({ ...SET, authorizedFrom: '2026-12-01' });
  const org = await orgNow();
  const { authorizedFrom, ...older } = org;
  assert.equal(authorizedFrom, '2026-12-01');
  okA(await mgr.action('site.settings.save', { org: older }));
  assert.equal((await orgNow()).authorizedFrom, '2026-12-01', 'kept');
  const bad = await mgr.action('site.settings.save', { org: { ...org, authorizedFrom: '2026-13-40' } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /^org\.authorizedFrom: /);
  okA(await mgr.action('site.settings.save', { org: { ...org, authorizedFrom: '' } }));
  assert.equal((await orgNow()).authorizedFrom, '');
});

test('T17. the receipts name another agent: said, copied on a tap, and receipts are never changed', async () => {
  await setOrg({ ...EMPTY });
  await db.query(
    `insert into receipt_settings (workspace_id, agent_name, agent_contact) values ($1, 'Rae Receipts', '604-555-0177')
     on conflict (workspace_id) do update set agent_name = excluded.agent_name, agent_contact = excluded.agent_contact`, [ws],
  );
  const before = (await db.query('select * from receipt_settings where workspace_id = $1', [ws])).rows[0];
  const a = okA(await mgr.get('/api/site/authorized'));
  assert.deepEqual([a.receiptsDiffer, a.receipts], [true, { name: 'Rae Receipts', contact: '604-555-0177', tooLong: false }]);
  assert.equal(a.en, '', 'never a fallback: nothing shows until it is filled in under Website');
  okA(await mgr.action('site.authorized.fromReceipts', {}));
  const org = await orgNow();
  assert.deepEqual([org.agentName, org.agentContact], ['Rae Receipts', '604-555-0177']);
  assert.equal(okA(await mgr.get('/api/site/authorized')).receiptsDiffer, false);
  assert.deepEqual((await db.query('select * from receipt_settings where workspace_id = $1', [ws])).rows[0], before, 'receipt_settings unchanged');
  // Too long for the website's boxes: said, never copied.
  await db.query("update receipt_settings set agent_name = $2 where workspace_id = $1", [ws, 'R'.repeat(150)]);
  const long = okA(await mgr.get('/api/site/authorized'));
  assert.equal(long.receipts.tooLong, true);
  assert.equal((await mgr.action('site.authorized.fromReceipts', {})).status, 400);
  // A volunteer sees the line (their first text counts it) but not the receipts.
  const v = okA(await vol.client.get('/api/site/authorized'));
  assert.equal(v.en, 'Authorized by Rae Receipts, 604-555-0177');
  assert.equal(v.receiptsDiffer, undefined);
  assert.equal(v.receipts, undefined);
  await db.query("update receipt_settings set agent_name = 'Rae Receipts' where workspace_id = $1", [ws]);
  await setOrg(SET);
});

test('the desk’s answer: the line, each approved translation, the channels', async () => {
  await setOrg(SET);
  const a = okA(await mgr.get('/api/site/authorized'));
  assert.equal(a.en, LINE);
  assert.equal(a.byLang.pa, `ਮਨਜ਼ੂਰ ${AGENT} ${CONTACT}`);
  assert.deepEqual([a.status, a.from, a.required, a.warn], ['set', null, false, null]);
  assert.equal(a.channels.length, CHANNEL_IDS.length);
  assert.deepEqual(a.channels.find((c) => c.id === 'sms-one'), { id: 'sms-one', kind: 'unclear', include: 'first-text', owner: true, what: CHANNELS['sms-one'].what });
  void okHit;
});
