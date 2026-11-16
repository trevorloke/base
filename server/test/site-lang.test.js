// The website in Punjabi and Chinese (TR, SITE.md "Languages"): each
// language at its own prefix (/pa, /zh, /zh-hant), offered only once it is
// on, "Authorized by" is approved in it and its first translation is done;
// the switch on every page; forms that keep the words shown in the
// language shown; the visitor's language remembered; nothing ever
// translated while a visitor waits. Every call goes to the fake Google
// (fake-translate.js), never a real one.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeTranslate } from './fake-translate.js';

const fake = await startFakeTranslate();
const ENV = { GOOGLE_TRANSLATE_KEY: 'test-translate-key-123', GOOGLE_TRANSLATE_API_BASE: fake.url };
const saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
Object.assign(process.env, ENV);
delete process.env.SITE_HOSTS;

const helpers = await import('./site-helpers.js');
const { send, ok, campaign, member } = helpers;
const hit = async (...a) => { const r = await helpers.hit(...a); return { ...r, text: r.text.replace(/<!-- -->/g, '') }; };
const { sweep, segHash, liveStrings, translatorFor } = await import('../ext/site/translate.js');
const { LEGAL_ENGLISH, LEGAL_KEYS, slotsOf } = await import('../../shared/site/wording.js');
const { LEGAL_ENGLISH_HASH } = await import('../ext/site/legal.js');
const { cacheClear } = await import('../ext/site/cache.js');
const { runDueJobs } = await import('../lib/jobs.js');

const AGENT = 'Ada Example';
const CONTACT = '604-555-0100';
let db; let mgr; let ws; let about; let petition;

// Words a manager approves: made-up words in the language, the English's slots kept.
const approvedWords = (lang, extra = {}) => Object.fromEntries(LEGAL_KEYS.map((k) => [k, `${lang === 'pa' ? 'ਮਨਜ਼ੂਰ' : '批准'} ${k} ${slotsOf(LEGAL_ENGLISH[k]).map((x) => `{${x}}`).join(' ')}`.trim()]).concat(Object.entries(extra)));
const approve = async (lang, extra) => ok(await mgr.action('site.legal.approve', { lang, words: approvedWords(lang, extra) }), `approve ${lang}`);
const settingsNow = async () => ok(await mgr.get('/api/site')).settings;
const saveLanguages = async (patch) => {
  const s = await settingsNow();
  return mgr.action('site.settings.save', { languages: { ...s.languages, ...patch } });
};
const page = async (slug, title, modules) => {
  const r = ok(await mgr.action('site.page.create', { title, slug, modules }));
  ok(await mgr.action('site.page.publish', { id: r.page.id }));
  return r.page;
};
const textOf = (html) => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');

before(async () => {
  ({ db, mgr, ws } = await campaign('Harbour City Together'));
  const s = await settingsNow();
  ok(await mgr.action('site.settings.save', { org: { ...s.org, name: 'Harbour City Together', shortName: '', agentName: AGENT, agentContact: CONTACT } }));
  about = await page('about', 'About us', [
    { id: 'band01', kind: 'band', hidden: false, props: { title: 'When we organize,', highlight: 'we win', cta: { label: 'Join us', href: '/join' }, tone: 'accent' } },
    { id: 'text01', kind: 'text', hidden: false, props: { title: 'Our story', body: 'First paragraph about the work.\n\n- One list item\n- Another list item with Q&A <3\n\nSecond line\nkeeps its break.', tone: 'paper' } },
    { id: 'news01', kind: 'newsletter', hidden: false, props: { title: 'Get the newsletter', intro: 'News and events.', askPhone: true, buttonLabel: 'Sign up', tone: 'surface' } },
  ]);
  const c = ok(await mgr.action('site.campaign.save', { kind: 'petition', title: 'Fix the crossing', statement: 'We ask the city to fix the crossing at Main Street.', excerpt: 'A safer walk to school.' }));
  petition = c.campaign;
});

after(async () => {
  await fake.close();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

test('no language on: no switch, nothing queued, /pa goes to the English page', async () => {
  const home = await hit('/site/about');
  assert.equal(home.status, 200);
  assert.ok(!home.text.includes('lang-switch'));
  assert.match(home.text, /<html lang="en"/);
  const pa = await hit('/site/pa/about');
  assert.equal(pa.status, 302);
  assert.equal(pa.location, '/site/about');
  assert.equal(pa.headers.get('cache-control'), 'no-store');
  const jobs = (await db.query("select count(*)::int as n from jobs where workspace_id = $1 and kind = 'site.translate'", [ws])).rows[0].n;
  assert.equal(jobs, 0);
});

test('the language prefixes are kept for the site itself', async () => {
  for (const slug of ['en', 'pa', 'zh', 'zh-hant']) {
    const r = await mgr.action('site.page.create', { title: `A page ${slug}`, slug });
    assert.equal(r.status, 400, slug);
    assert.match(r.json.error, /kept for the site itself/);
  }
});

test('only a manager turns a language on', async () => {
  const staff = await member(mgr, 'staff', 'Sam Example');
  ok(await mgr.action('permission.member.set', { user_id: staff.id, grant: ['site'], deny: [] }));
  const s = await settingsNow();
  const r = await staff.client.action('site.settings.save', { languages: { ...s.languages, on: ['pa'] } });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'Only a manager can do this');
  const budget = await staff.client.action('site.settings.save', { languages: { ...s.languages, monthlyChars: 900000 } });
  assert.equal(budget.status, 403);
  const legal = await staff.client.action('site.legal.approve', { lang: 'pa', words: approvedWords('pa') });
  assert.equal(legal.status, 403);
});

test('turned on: a publish queues one sweep per 30 seconds, and the sweep fills each language', async () => {
  ok(await saveLanguages({ on: ['pa', 'zh-Hans', 'zh-Hant'] }));
  const jobs = (await db.query("select key from jobs where workspace_id = $1 and kind = 'site.translate'", [ws])).rows;
  assert.equal(jobs.length, 1, 'the settings save queued one sweep');
  // A draft save queues nothing more in the same window; a publish is the same window's job.
  ok(await mgr.action('site.page.save', { id: about.id, title: 'About us' }));
  assert.equal((await db.query("select count(*)::int as n from jobs where workspace_id = $1 and kind = 'site.translate'", [ws])).rows[0].n, 1);

  fake.reset();
  const out = await sweep(db, ws);
  assert.equal(out.done, true);
  assert.ok(fake.calls.length >= 2, 'Punjabi and Simplified were sent');
  for (const c of fake.calls) {
    assert.notEqual(c.target, 'zh-TW', 'Traditional is never sent');
    assert.ok(c.q.length <= 128);
    assert.ok(c.chars <= 25000);
    assert.equal(c.keyIn, 'header');
    assert.ok(!c.url.includes('key='), 'the key is never in the address');
    assert.equal(c.headers['x-goog-api-key'], ENV.GOOGLE_TRANSLATE_KEY);
  }
  const counts = Object.fromEntries((await db.query(
    'select lang, count(*)::int as n from site_translations where workspace_id = $1 group by lang', [ws],
  )).rows.map((r) => [r.lang, r.n]));
  assert.ok(counts.pa > 50 && counts['zh-Hans'] > 50);
  assert.equal(counts['zh-Hant'], counts['zh-Hans'], 'each Simplified row makes a Traditional one');
  const st = Object.fromEntries((await db.query('select lang, ready_at, rev from site_language_state where workspace_id = $1', [ws])).rows.map((r) => [r.lang, r]));
  for (const l of ['pa', 'zh-Hans', 'zh-Hant']) assert.ok(st[l]?.ready_at, `${l} ready`);
  const events = (await db.query("select payload from events where workspace_id = $1 and entity_type = 'site_translation_batch'", [ws])).rows;
  assert.ok(events.length >= 2);
});

test('ready but no Authorized by approved: still not offered; approved: the switch appears', async () => {
  cacheClear(ws);
  assert.equal((await hit('/site/pa/about')).status, 302);
  assert.ok(!(await hit('/site/about')).text.includes('lang-switch'));
  // Approval needs every key, with its slots.
  const words = approvedWords('pa');
  const bad = await mgr.action('site.legal.approve', { lang: 'pa', words: { ...words, authorizedBy: 'ਮਨਜ਼ੂਰ {agent}' } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /Keep \{agent\} and \{contact\}/);
  const missing = await mgr.action('site.legal.approve', { lang: 'pa', words: { ...words, donate: '' } });
  assert.equal(missing.status, 400);
  await approve('pa', { names: { [AGENT]: 'ਐਡਾ' } });
  await approve('zh-Hans');
  await approve('zh-Hant');
  const en = await hit('/site/about');
  assert.match(en.text, /class="lang-switch"/);
  assert.match(en.text, /<a href="\/site\/about\?lang=en" hrefLang="en" lang="en" aria-current="true">English<\/a>/i);
  assert.match(en.text, /href="\/site\/pa\/about"[^>]*>ਪੰਜਾਬੀ</);
  assert.match(en.text, /href="\/site\/zh\/about"[^>]*>简体</);
  assert.match(en.text, /href="\/site\/zh-hant\/about"[^>]*>繁體</);
  // The skip link stays first.
  assert.match(en.text, /<body><a class="skip-link"/);
  assert.equal(en.headers.get('speculation-rules'), '"/site-assets/lang-rules.json"');
});

test('a Punjabi page: lang, links under /pa, the footer twice, fallbacks in English', async () => {
  const r = await hit('/site/pa/about');
  assert.equal(r.status, 200);
  assert.match(r.text, /<html lang="pa"/);
  assert.match(r.text, /property="og:locale" content="pa_IN"/);
  assert.match(r.text, /<meta name="robots" content="noindex">/, 'not listed in search until a manager says so');
  // Every site link and form stays in Punjabi.
  for (const m of r.text.matchAll(/(?:href|action)="(\/site\/[^"]*)"/g)) {
    if (m[1].startsWith('/site/pa') || m[1].includes('lang=en') || /^\/site\/(about|zh|zh-hant)/.test(m[1]) || m[1] === '/site/') continue;
    if (/^\/site\/(?!site-assets)/.test(m[1])) assert.fail(`a link left Punjabi: ${m[1]}`);
  }
  assert.match(r.text, /action="\/site\/pa\/api\/forms\/newsletter"/);
  // The footer: the English line as always, then the approved Punjabi with the names as typed.
  assert.match(r.text, new RegExp(`<p class="footer-authorization" lang="en">Authorized by ${AGENT}, ${CONTACT}</p><p class="footer-authorization" lang="pa">ਮਨਜ਼ੂਰ authorizedBy ${AGENT} ${CONTACT}</p>`));
  // The translated note, with the official English a link away (no ?lang=en).
  assert.match(r.text, /<p class="lang-note"><span lang="pa">ਮਨਜ਼ੂਰ translatedNote<\/span> <a href="\/site\/about" hrefLang="en" lang="pa">/);
  // The band drawn whole, its underlined part kept.
  assert.match(r.text, /<h2 id="m-band01-title" class="display">[^<]+<span class="underline">[^<]+<\/span>/);
  assert.ok(!r.text.includes('When we organize'), 'the band is translated');
  // Markdown: a list item each, a line break kept, "Q&A <3" back as written.
  const pa = await translatorFor(db, ws, 'pa');
  const qa = pa.look('Another list item with Q&A <3');
  assert.equal(qa.lang, 'pa');
  assert.match(qa.text, /&/);
  assert.match(qa.text, /<3/);
  assert.ok(!/&#39;|&amp;|&quot;/.test(qa.text), 'entities decoded before storing');
  const two = pa.look('Second line\nkeeps its break.');
  assert.equal(two.lang, 'pa');
  assert.match(two.text, /\n/);
  // The island's props carry their words.
  const props = /data-island-props="i-news01-form"[^>]*>([^<]+)</.exec(r.text);
  assert.ok(props, 'the newsletter island');
  const p = JSON.parse(props[1]);
  assert.ok(p.w && p.w['form.sending'] && p.w['form.sending'] !== 'Sending…');
  assert.match(p.hidden.legal_v, new RegExp(`^[0-9a-f-]{36}\\.${LEGAL_ENGLISH_HASH}$`));
});

test('the site’s own addresses answer 404 under a prefix; routes answer on /zh and /zh-hant', async () => {
  for (const pth of ['/site/pa/robots.txt', '/site/pa/sitemap.xml', '/site/pa/preferences', '/site/pa/unsubscribe']) {
    assert.equal((await hit(pth)).status, 404, pth);
  }
  assert.equal((await hit('/site/zh/')).status, 200);
  const act = await hit(`/site/zh-hant/act/${petition.slug}`);
  assert.equal(act.status, 200);
  assert.match(act.text, /<html lang="zh-Hant"/);
  assert.equal((await hit('/site/zh/news')).status, 200);
});

test('remembered: a /pa page sets site_lang, a prefetch doesn’t; / redirects, ?lang=en forgets', async () => {
  const r = await hit('/site/pa/about');
  assert.match(r.headers.get('set-cookie') || '', /site_lang=pa; Max-Age=31536000; Path=\/site; SameSite=Lax/);
  const pre = await hit('/site/pa/about', { headers: { 'sec-purpose': 'prefetch;prerender' } });
  assert.equal(pre.headers.get('set-cookie'), null);
  const pre2 = await hit('/site/pa/about', { headers: { purpose: 'prefetch' } });
  assert.equal(pre2.headers.get('set-cookie'), null);
  const back = await hit('/site/', { headers: { cookie: 'site_lang=pa' } });
  assert.equal(back.status, 302);
  assert.equal(back.location, '/site/pa/');
  assert.equal(back.headers.get('cache-control'), 'no-store');
  assert.equal((await hit('/site/about', { headers: { cookie: 'site_lang=pa' } })).status, 200, 'only the home page redirects');
  assert.equal((await hit('/site/', { headers: { 'accept-language': 'pa-IN,pa;q=0.9' } })).status, 200, 'never by browser language');
  const en = await hit('/site/about?lang=en', { headers: { cookie: 'site_lang=pa' } });
  assert.equal(en.status, 200);
  assert.match(en.headers.get('set-cookie') || '', /site_lang=;/);
  assert.equal(en.headers.get('cache-control'), 'no-store');
  const rules = await hit('/site-assets/lang-rules.json');
  assert.equal(rules.headers.get('content-type'), 'application/speculationrules+json');
  assert.match(rules.text, /\?lang=/);
});

test('a newsletter on /pa keeps the approved Punjabi words, its language and the English', async () => {
  const r = await hit('/site/pa/about');
  const p = JSON.parse(/data-island-props="i-news01-form"[^>]*>([^<]+)</.exec(r.text)[1]);
  const email = `nl-${Math.random().toString(36).slice(2, 7)}@example.org`;
  ok(await send('newsletter', { first_name: 'Kiran', email, consent_email: true, ...p.hidden, lang: 'en' }, { root: '/site/pa' }));
  const ev = (await db.query("select * from consent_events where workspace_id = $1 and address = $2 and channel = 'email'", [ws, email])).rows[0];
  assert.equal(ev.lang, 'pa', 'the address’s language, never the body’s');
  assert.equal(ev.wording, 'ਮਨਜ਼ੂਰ newsletter Harbour City Together');
  assert.match(ev.wording_en, /^By signing up you agree to get email from Harbour City Together/);
  const e = (await db.query("select payload from events where workspace_id = $1 and entity_type = 'consent_event' and entity_id = $2", [ws, ev.id])).rows[0];
  assert.equal(e.payload.lang, 'pa');
  assert.equal(e.payload.wording_en, ev.wording_en);
  const act = (await db.query("select lang from site_actions where workspace_id = $1 and kind = 'newsletter' order by created_at desc limit 1", [ws])).rows[0];
  assert.equal(act.lang, 'pa');
  // Another language's approval, another release's English, none: refused, nothing kept.
  const zhId = (await db.query("select id from site_legal_words where workspace_id = $1 and lang = 'zh-Hans'", [ws])).rows[0].id;
  for (const legal_v of [`${zhId}.${LEGAL_ENGLISH_HASH}`, `${p.hidden.legal_v.split('.')[0]}.000000000000`, '']) {
    const e2 = `nl-${Math.random().toString(36).slice(2, 7)}@example.org`;
    const bad = await send('newsletter', { email: e2, consent_email: true, ...p.hidden, legal_v }, { root: '/site/pa' });
    assert.equal(bad.status, 400, legal_v);
    assert.equal((await db.query('select count(*)::int as n from consent_events where workspace_id = $1 and address = $2', [ws, e2])).rows[0].n, 0);
  }
  // After a newer approval, the older page's legal_v still keeps the older words.
  await approve('pa', { names: { [AGENT]: 'ਐਡਾ' }, newsletter: 'ਨਵਾਂ newsletter {org}' });
  const e3 = `nl-${Math.random().toString(36).slice(2, 7)}@example.org`;
  ok(await send('newsletter', { email: e3, consent_email: true, ...p.hidden }, { root: '/site/pa' }));
  assert.equal((await db.query("select wording from consent_events where workspace_id = $1 and address = $2", [ws, e3])).rows[0].wording, 'ਮਨਜ਼ੂਰ newsletter Harbour City Together');
});

test('a plain (no-JavaScript) post on /zh keeps the Simplified words', async () => {
  const r = await hit('/site/zh/about');
  const legalV = /name="legal_v" value="([^"]+)"/.exec(r.text)?.[1];
  assert.ok(legalV);
  const email = `plain-${Math.random().toString(36).slice(2, 7)}@example.org`;
  const res = await hit('/site/zh/api/forms/newsletter', { method: 'POST', form: { email, consent_email: 'true', legal_v: legalV, module_id: 'news01', page_id: about.id } });
  assert.equal(res.status, 303);
  assert.match(res.location, /^\/site\/zh\/about\?sent=newsletter/);
  const ev = (await db.query("select lang, wording from consent_events where workspace_id = $1 and address = $2", [ws, email])).rows[0];
  assert.equal(ev.lang, 'zh-Hans');
  assert.equal(ev.wording, '批准 newsletter Harbour City Together');
});

test('a petition: the statement in English until checked, then translated; the words signed are kept', async () => {
  const page1 = await hit(`/site/pa/act/${petition.slug}`);
  const h = segHash(petition.statement);
  assert.match(page1.text, /<blockquote class="act-statement" lang="en">/);
  assert.ok(page1.text.includes(`statement_v&quot;:&quot;en:${h}`) || page1.text.includes(`"statement_v":"en:${h}"`) || page1.text.includes(`en:${h}`));
  // A person checks it.
  await db.query("update site_translations set checked_at = now(), checked_by = $3 where workspace_id = $1 and lang = 'pa' and src_hash = $2", [ws, h, null]);
  await db.query("update site_language_state set rev = rev + 1 where workspace_id = $1 and lang = 'pa'", [ws]);
  cacheClear(ws);
  const page2 = await hit(`/site/pa/act/${petition.slug}`);
  assert.ok(!/<blockquote class="act-statement" lang="en">/.test(page2.text));
  const v = (await db.query("select version_id, text from site_translations where workspace_id = $1 and lang = 'pa' and src_hash = $2", [ws, h])).rows[0];
  assert.ok(page2.text.includes(v.version_id));
  const legalV = /legal_v&quot;:&quot;([^&]+)&quot;|"legal_v":"([^"]+)"/.exec(page2.text);
  const lv = legalV[1] || legalV[2];
  // A reviewer corrects the statement after the page was drawn: the old page's signature keeps the old words.
  await db.query("update site_translations set text = 'ਨਵੇਂ ਸ਼ਬਦ' where workspace_id = $1 and lang = 'pa' and src_hash = $2", [ws, h]);
  const email = `sig-${Math.random().toString(36).slice(2, 7)}@example.org`;
  ok(await send('petition', { first_name: 'Jas', last_name: 'Example', email, postal_code: 'V3T 1A1', campaign: petition.id, legal_v: lv, statement_v: v.version_id }, { root: '/site/pa' }));
  const a = (await db.query("select payload, lang from site_actions where workspace_id = $1 and kind = 'petition' order by created_at desc limit 1", [ws])).rows[0];
  assert.equal(a.lang, 'pa');
  assert.equal(a.payload.statement_shown, v.text);
  assert.equal(a.payload.statement_lang, 'pa');
  // Another petition's or language's version: refused.
  const zhv = (await db.query("select version_id from site_translations where workspace_id = $1 and lang = 'zh-Hans' and src_hash = $2", [ws, h])).rows[0].version_id;
  const bad = await send('petition', { first_name: 'Jas', email: `x${email}`, postal_code: 'V3T 1A1', campaign: petition.id, legal_v: lv, statement_v: zhv }, { root: '/site/pa' });
  assert.equal(bad.status, 400);
});

test('a key whose English changed shows in English and keeps English; Authorized-by changed withdraws the language', async () => {
  // As if a release changed the newsletter's English since the approval.
  await db.query("update site_legal_words set english = jsonb_set(english, '{newsletter}', '\"old words\"') where workspace_id = $1 and lang = 'zh-Hans'", [ws]);
  await db.query("update site_language_state set rev = rev + 1 where workspace_id = $1", [ws]);
  cacheClear(ws);
  const r = await hit('/site/zh/about');
  assert.equal(r.status, 200);
  const p = JSON.parse(/data-island-props="i-news01-form"[^>]*>([^<]+)</.exec(r.text)[1]);
  assert.equal(p.smallLang, 'en');
  assert.match(p.small, /^By signing up you agree/);
  const email = `st-${Math.random().toString(36).slice(2, 7)}@example.org`;
  ok(await send('newsletter', { email, consent_email: true, ...p.hidden }, { root: '/site/zh' }));
  const ev = (await db.query('select lang, wording from consent_events where workspace_id = $1 and address = $2', [ws, email])).rows[0];
  assert.equal(ev.lang, 'en');
  assert.match(ev.wording, /^By signing up/);
  await db.query("update site_legal_words set english = jsonb_set(english, '{authorizedBy}', '\"Paid for by {agent}, {contact}\"') where workspace_id = $1 and lang = 'zh-Hans'", [ws]);
  cacheClear(ws);
  assert.equal((await hit('/site/zh/about')).status, 302);
  assert.ok(!(await hit('/site/about')).text.includes('>简体<'));
  // Put back for the tests after.
  await approve('zh-Hans');
});

test('a volunteer form on /pa keeps English role values; a contact on /zh files the English topic', async () => {
  const vol = await page('helpers', 'Help out', [
    { id: 'vol001', kind: 'volunteer', hidden: false, props: { title: 'Volunteer', intro: '', roles: ['Knock on doors'], askAvailability: false, tone: 'paper' } },
    { id: 'con001', kind: 'contact', hidden: false, props: { title: 'Write to us', intro: '', topics: ['Housing'] } },
  ]);
  ok(await sweep(db, ws).then((x) => ({ status: 200, json: x })));
  cacheClear(ws);
  const r = await hit('/site/pa/helpers');
  assert.equal(r.status, 200);
  const props = JSON.parse(/data-island-props="i-vol001-form"[^>]*>([^<]+)</.exec(r.text)[1]);
  const roles = props.fields.find((f) => f.name === 'roles');
  assert.equal(roles.options[0].value, 'Knock on doors');
  assert.notEqual(roles.options[0].label, 'Knock on doors');
  ok(await send('volunteer', { first_name: 'Raj', last_name: 'Example', email: `v${Date.now()}@example.org`, roles: ['Knock on doors'], ...props.hidden }, { root: '/site/pa' }));
  const a = (await db.query("select payload from site_actions where workspace_id = $1 and kind = 'volunteer' order by created_at desc limit 1", [ws])).rows[0];
  assert.deepEqual(a.payload.roles, ['Knock on doors']);
  assert.ok(vol);
});

test('preferences in the visitor’s language: approved words, kept with the language', async () => {
  const { personToken } = await import('../ext/site/public.js');
  const email = `pref-${Math.random().toString(36).slice(2, 7)}@example.org`;
  ok(await send('newsletter', { email, consent_email: true }));
  const person = (await db.query('select id from persons where workspace_id = $1 and email = $2', [ws, email])).rows[0];
  const t = await personToken(ws, person.id);
  const g = await hit(`/site/preferences?t=${encodeURIComponent(t)}&lang=pa`);
  assert.equal(g.status, 200);
  assert.match(g.text, /<html lang="pa"/);
  assert.match(g.text, /ਮਨਜ਼ੂਰ email Harbour City Together/);
  const legalV = /name="legal_v" value="([^"]+)"/.exec(g.text)[1];
  // Off, then on again from the Punjabi page.
  await hit(`/site/preferences?t=${encodeURIComponent(t)}&lang=pa`, { method: 'POST', form: { t, legal_v: legalV } });
  const on = await hit(`/site/preferences?t=${encodeURIComponent(t)}&lang=pa`, { method: 'POST', form: { t, legal_v: legalV, email: 'on' } });
  assert.equal(on.status, 200);
  const ev = (await db.query("select lang, wording, wording_en from consent_events where workspace_id = $1 and person_id = $2 and source = 'preferences' and granted order by created_at desc limit 1", [ws, person.id])).rows[0];
  assert.equal(ev.lang, 'pa');
  assert.equal(ev.wording, 'ਮਨਜ਼ੂਰ email Harbour City Together');
  assert.match(ev.wording_en, /^Yes, Harbour City Together can email me/);
  // The cookie does the same when there is no ?lang.
  const viaCookie = await hit(`/site/unsubscribe?t=${encodeURIComponent(t)}`, { headers: { cookie: 'site_lang=pa' } });
  assert.match(viaCookie.text, /<html lang="pa"/);
});

test('<head> and the sitemap: alternates only for languages search may list', async () => {
  let en = await hit('/site/about', { host: 'localhost' });
  assert.ok(!/hreflang="pa"/.test(en.text));
  ok(await saveLanguages({ index: { pa: true, 'zh-Hans': false, 'zh-Hant': false } }));
  en = await hit('/site/about');
  assert.match(en.text, /<link rel="alternate" hreflang="en" href="http:\/\/localhost\/site\/about">/);
  assert.match(en.text, /<link rel="alternate" hreflang="pa" href="http:\/\/localhost\/site\/pa\/about">/);
  assert.match(en.text, /<link rel="alternate" hreflang="x-default" href="http:\/\/localhost\/site\/about">/);
  assert.ok(!/hreflang="zh-Hans"/.test(en.text));
  const pa = await hit('/site/pa/about');
  assert.ok(!/name="robots" content="noindex"/.test(pa.text));
  assert.match(pa.text, /<link rel="canonical" href="http:\/\/localhost\/site\/pa\/about">/);
  const sm = await hit('/site/sitemap.xml');
  assert.match(sm.text, /xmlns:xhtml/);
  const urls = [...sm.text.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => m[1]);
  const aboutUrls = urls.filter((u) => /<loc>[^<]*\/about<\/loc>/.test(u));
  assert.equal(aboutUrls.length, 2, 'English and Punjabi');
  for (const u of aboutUrls) {
    assert.match(u, /hreflang="en"/);
    assert.match(u, /hreflang="pa"/);
    assert.match(u, /hreflang="x-default"/);
  }
  const robots = await hit('/site/robots.txt');
  assert.match(robots.text, /Disallow: \/site\/pa\/api\//);
});

test('the referral cookie set on /pa/r/<code> belongs to the whole site', async () => {
  const r = await hit('/site/pa/r/abcdef12');
  assert.equal(r.status, 302);
  assert.equal(r.location, '/site/pa/');
  assert.match(r.headers.get('set-cookie') || '', /site_ref=abcdef12;[^,]*Path=\/site;/);
});

test('the export carries the language tables', async () => {
  const r = ok(await mgr.get('/api/export'));
  for (const t of ['site_translations', 'site_translation_versions', 'site_translation_failures', 'site_legal_words', 'site_language_state', 'site_translate_usage']) {
    assert.ok(Array.isArray(r[t] || r.tables?.[t]), t);
  }
});

test('a language turned off answers 302 to English and its form post 400 with nothing kept', async () => {
  ok(await saveLanguages({ on: ['pa', 'zh-Hans'] }));
  cacheClear(ws);
  const r = await hit('/site/zh-hant/about');
  assert.equal(r.status, 302);
  assert.equal(r.location, '/site/about');
  const en = await hit('/site/about');
  assert.match(en.text, />中文</, 'one Chinese left: 中文');
  const email = `off-${Math.random().toString(36).slice(2, 7)}@example.org`;
  const post = await send('newsletter', { email, consent_email: true }, { root: '/site/zh-hant' });
  assert.equal(post.status, 400);
  assert.equal(post.json.error, 'This page changed — please reload it and send again');
  assert.equal((await db.query('select count(*)::int as n from persons where workspace_id = $1 and email = $2', [ws, email])).rows[0].n, 0);
  ok(await saveLanguages({ on: ['pa', 'zh-Hans', 'zh-Hant'] }));
});

test('the job runner runs a queued sweep, and a draft save queues none', async () => {
  await db.query("delete from jobs where workspace_id = $1 and kind = 'site.translate'", [ws]);
  ok(await mgr.action('site.translate.now', {}));
  await db.query("update jobs set run_at = now() where workspace_id = $1 and kind = 'site.translate'", [ws]);
  const out = await runDueJobs(db, { workspaceId: ws });
  assert.equal(out.ran, 1);
  const segs = await liveStrings(db, { id: ws });
  assert.ok(segs.length > 50);
});

test('ladders: a web trigger in Punjabi starts for a sign-up on /pa, not on English; one with no language for both', async () => {
  const mk = async (name, trigger) => {
    const l = ok(await mgr.action('ladder.create', { name, trigger, steps: [{ kind: 'tag', tag: name.toLowerCase().replace(/\W+/g, '-') }] })).ladder;
    ok(await mgr.action('ladder.setActive', { id: l.id, active: true }));
    return l;
  };
  assert.equal((await mgr.action('ladder.create', { name: 'x', trigger: { kind: 'tag', ref: 'a', lang: 'pa' } })).status, 400);
  const pa = await mk('Punjabi welcome', { kind: 'web', ref: 'newsletter', lang: 'pa' });
  assert.equal(pa.trigger.lang, 'pa');
  const any = await mk('Any welcome', { kind: 'web', ref: 'newsletter' });
  const runs = async (l) => (await db.query('select person_id from ladder_runs where workspace_id = $1 and ladder_id = $2', [ws, l.id])).rows.map((r) => r.person_id);
  const r = await hit('/site/pa/about');
  const p = JSON.parse(/data-island-props="i-news01-form"[^>]*>([^<]+)</.exec(r.text)[1]);
  const e1 = `lad-pa-${Date.now()}@example.org`;
  ok(await send('newsletter', { email: e1, consent_email: true, ...p.hidden }, { root: '/site/pa' }));
  const e2 = `lad-en-${Date.now()}@example.org`;
  ok(await send('newsletter', { email: e2, consent_email: true }));
  const id = async (e) => (await db.query('select id from persons where workspace_id = $1 and email = $2', [ws, e])).rows[0].id;
  const [p1, p2] = [await id(e1), await id(e2)];
  assert.deepEqual(await runs(pa), [p1]);
  assert.deepEqual((await runs(any)).sort(), [p1, p2].sort());
});

test('sweeps: one at a time; a claim taken or 7 minutes gone stops new calls; 429 hands back; the header refused, the body works', async () => {
  // Something new to send: a post.
  const post = ok(await mgr.action('site.post.save', { title: 'A new post about buses', excerpt: 'Short words about the buses.', body: 'One.\n\nTwo.\n\nThree.' })).post;
  ok(await mgr.action('site.post.publish', { id: post.id }));
  fake.reset();
  fake.set({ stall: 300 });
  const [a, b] = await Promise.all([sweep(db, ws), sweep(db, ws)]);
  fake.set({ stall: 0 });
  assert.ok((a.again && b.done) || (a.done && b.again), 'one sweep ran, the other was handed back');
  const first = fake.calls.length;
  assert.ok(first >= 1);
  // Nothing left: a second sweep sends nothing.
  fake.reset();
  await sweep(db, ws);
  assert.equal(fake.calls.length, 0, 'only new English is ever sent');
  // A clock past 7 minutes starts no call.
  ok(await mgr.action('site.post.save', { id: post.id, title: 'A newer post about buses', excerpt: 'Short words about the buses.', body: 'One.\n\nTwo.\n\nThree.' }));
  let t = Date.now();
  const late = await sweep(db, ws, { clock: () => { t += 8 * 60_000; return t; } });
  assert.equal(late.stopped, 'time');
  assert.equal(fake.calls.length, 0);
  // Google busy: handed back, nothing written, no try counted.
  fake.set({ fail: 429 });
  const busy = await sweep(db, ws);
  assert.equal(busy.again, 60_000);
  fake.set({ fail: 0 });
  // Google refuses the header key: sent once more with the key in a form body, and kept so.
  fake.reset();
  fake.set({ headerKey: false });
  await sweep(db, ws);
  assert.deepEqual(fake.calls.map((c) => c.keyIn).slice(0, 2), ['header', 'body']);
  const probe = (await db.query('select probe from site_translate_runtime where workspace_id = $1', [ws])).rows[0].probe;
  assert.equal(probe.keyIn, 'body');
  for (const c of fake.calls) assert.ok(!c.url.includes('key='));
  fake.set({ headerKey: true });
  // A one-paragraph change of a three-paragraph post sends only that paragraph.
  ok(await mgr.action('site.post.save', { id: post.id, title: 'A newer post about buses', excerpt: 'Short words about the buses.', body: 'One.\n\nTwo changed.\n\nThree.' }));
  fake.reset();
  await sweep(db, ws);
  const sent = fake.calls.flatMap((c) => c.q);
  assert.ok(sent.some((q) => q.includes('Two changed')));
  assert.ok(!sent.some((q) => q === 'One.' || q === 'Three.'));
});

test('a segment that won\u2019t translate: retried after 1 h and 6 h, then never; shown in English; typing it clears it', async () => {
  // The fake loses the kept name's placeholder in this one sentence, every time.
  fake.set({ drop: { contains: 'safer walk with', what: 'x' } });
  const text = 'A safer walk with Harbour City Together.';
  ok(await mgr.action('site.campaign.save', { id: petition.id, kind: 'petition', title: 'Fix the crossing', statement: petition.statement, excerpt: text }));
  const h = segHash(text);
  const tries = async () => (await db.query("select tries, next_try_at, last_reason from site_translation_failures where workspace_id = $1 and lang = 'pa' and src_hash = $2", [ws, h])).rows[0];
  const sentAgain = async () => { fake.calls.length = 0; await sweep(db, ws); return fake.calls.some((c) => c.target === 'pa' && c.q.some((q) => q.includes('safer walk with'))); };
  assert.equal(await sentAgain(), true);
  let f = await tries();
  assert.equal(f.tries, 1);
  assert.equal(f.last_reason, 'A kept name came back changed');
  assert.equal(await sentAgain(), false, 'not before an hour');
  await db.query("update site_translation_failures set next_try_at = now() - interval '1 second' where workspace_id = $1 and src_hash = $2", [ws, h]);
  assert.equal(await sentAgain(), true);
  assert.equal((await tries()).tries, 2);
  await db.query("update site_translation_failures set next_try_at = now() - interval '1 second' where workspace_id = $1 and src_hash = $2", [ws, h]);
  assert.equal(await sentAgain(), true);
  f = await tries();
  assert.equal(f.tries, 3);
  assert.equal(f.next_try_at, null);
  assert.equal(await sentAgain(), false, 'never after the third try');
  fake.set({ drop: null });
  // Shown in English, with lang="en" on its paragraph.
  cacheClear(ws);
  const page2 = await hit(`/site/pa/act/${petition.slug}`);
  assert.match(page2.text, /<p class="lede" lang="en">A safer walk with Harbour City Together\.<\/p>/);
  // Still ready: a used-up segment counts as done.
  assert.ok((await db.query("select ready_at from site_language_state where workspace_id = $1 and lang = 'pa'", [ws])).rows[0].ready_at);
});

test('Traditional: never sent; a person’s edit in Traditional is not replaced when the Simplified changes', async () => {
  const { convertRow } = await import('../ext/site/translate.js');
  const row = (await db.query("select src_hash, src from site_translations where workspace_id = $1 and lang = 'zh-Hant' limit 1", [ws])).rows[0];
  await db.query("update site_translations set origin = 'edited', text = '人工改的' where workspace_id = $1 and lang = 'zh-Hant' and src_hash = $2", [ws, row.src_hash]);
  await db.transaction((tx) => convertRow(tx, ws, row.src_hash, row.src, '新的简体', null));
  const after = (await db.query("select text, origin, checked_at from site_translations where workspace_id = $1 and lang = 'zh-Hant' and src_hash = $2", [ws, row.src_hash])).rows[0];
  assert.equal(after.text, '人工改的');
  assert.equal(after.checked_at, null, 'back under To check');
  const legal = (await db.query("select words from site_legal_words where workspace_id = $1 and lang = 'zh-Hant' limit 1", [ws])).rows[0];
  assert.ok(legal);
});

test('a page miss with an unchanged rev reads no translations; a cold /pa page draws quickly, a warm one at once', async () => {
  const seen = [];
  const q = { query: (sql, p) => { seen.push(sql); return db.query(sql, p); } };
  await translatorFor(q, ws, 'pa');
  seen.length = 0;
  await translatorFor(q, ws, 'pa');
  assert.ok(seen.every((s) => !/from site_translations/.test(s)), seen.join('\n'));
  const time = async (fn) => { const t = process.hrtime.bigint(); await fn(); return Number(process.hrtime.bigint() - t) / 1e6; };
  const median = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const cold = [];
  const warm = [];
  for (let i = 0; i < 20; i += 1) {
    cacheClear(ws);
    cold.push(await time(() => hit('/site/pa/about')));
    warm.push(await time(() => hit('/site/pa/about')));
  }
  console.log(`# /pa/about cold median ${median(cold).toFixed(1)} ms, warm median ${median(warm).toFixed(1)} ms`);
  assert.ok(median(cold) < 150, `cold ${median(cold)}`);
  assert.ok(median(warm) < 10 || process.env.STARBASE_TEST_PG, `warm ${median(warm)}`);
});

test('another website: the switch, and /pa/ on its own domain and under /site/sites/<key>/pa', async () => {
  const s = await settingsNow();
  ok(await mgr.action('site.settings.save', { org: { ...s.org, privacyUrl: '/privacy' } }));
  const m = ok(await mgr.action('site.microsite.create', { name: 'Doug Didn’t Example', domain: 'https://dougdidnt.example/' })).microsite;
  const homeRow = (await db.query('select id from site_pages where site_id = $1', [m.id])).rows[0];
  ok(await mgr.action('site.page.publish', { id: homeRow.id }));
  const live = await mgr.action('site.microsite.live', { id: m.id, live: true });
  assert.equal(live.status, 200, JSON.stringify(live.json));
  await sweep(db, ws);
  cacheClear(ws);
  const { forgetDomains } = await import('../ext/site/store.js');
  forgetDomains();
  const en = await hit('/', { host: 'dougdidnt.example' });
  assert.equal(en.status, 200);
  assert.match(en.text, /href="\/pa\/"[^>]*>ਪੰਜਾਬੀ</);
  const pa = await hit('/pa/', { host: 'dougdidnt.example' });
  assert.equal(pa.status, 200);
  assert.match(pa.text, /<html lang="pa"/);
  assert.match(pa.text, /Doug Didn’t Example|Doug Didn&#x27;t Example|Doug Didn't Example/, 'its name kept as written');
  const app = await hit(`/site/sites/${m.key}/pa/`);
  assert.equal(app.status, 200);
  assert.match(app.text, new RegExp(`action="/site/sites/${m.key}/pa/api/forms/`));
});

test('cost guard: the month’s limit stops the sweep before the call; reservations never pass it together; a refusal gives back', async () => {
  const { reserveChars, usageMonth } = await import('../ext/site/translate.js');
  // A second campaign on a database of its own (the last test: the site at /site/ moves to it).
  const other = await campaign('Second Example Campaign');
  const w2 = other.ws;
  const db = other.db;
  const month = usageMonth({});
  const both = await Promise.all([reserveChars(db, w2, month, 6000, 10000), reserveChars(db, w2, month, 6000, 10000)]);
  assert.deepEqual(both.sort(), [false, true]);
  await db.query('delete from site_translate_usage where workspace_id = $1', [w2]);
  // The smallest limit, a fresh campaign: some of Punjabi's essentials go, then it stops.
  const s2 = ok(await other.mgr.get('/api/site')).settings;
  ok(await other.mgr.action('site.settings.save', { languages: { ...s2.languages, on: ['pa', 'zh-Hans'], monthlyChars: 10000 } }));
  fake.reset();
  const out = await sweep(db, w2);
  assert.equal(out.stopped, 'limit');
  const sent = fake.calls.reduce((n, c) => n + c.chars, 0);
  assert.ok(sent > 0 && sent <= 10000, `sent ${sent}`);
  assert.ok(fake.calls.every((c) => c.target === 'pa'), 'Punjabi first; Simplified waits');
  const st = (await db.query("select last_error from site_language_state where workspace_id = $1 and lang = 'pa'", [w2])).rows[0];
  assert.equal(st.last_error, 'monthly-limit');
  const used = Number((await db.query('select chars from site_translate_usage where workspace_id = $1', [w2])).rows[0].chars);
  assert.ok(used <= 10000);
  // A refusal Google answered gives its reservation back.
  ok(await other.mgr.action('site.settings.save', { languages: { ...s2.languages, on: ['pa', 'zh-Hans'], monthlyChars: 5000000 } }));
  fake.set({ fail: 403 });
  await assert.rejects(sweep(db, w2));
  fake.set({ fail: 0 });
  const after = Number((await db.query('select chars from site_translate_usage where workspace_id = $1', [w2])).rows[0].chars);
  assert.equal(after, used);
  // A timeout's stands (Google may have billed it), and the job parks after five tries with plain words.
  const { _setCallMsForTest } = await import('../lib/translate.js');
  _setCallMsForTest(100);
  fake.set({ stall: 400 });
  await db.query("delete from jobs where workspace_id = $1 and kind = 'site.translate'", [w2]);
  ok(await other.mgr.action('site.translate.now', {}));
  for (let i = 0; i < 5; i += 1) {
    await db.query("update jobs set run_at = now() where workspace_id = $1 and kind = 'site.translate' and status = 'pending'", [w2]);
    await runDueJobs(db, { workspaceId: w2 }).catch(() => {});
  }
  fake.set({ stall: 0 });
  _setCallMsForTest(0);
  const job = (await db.query("select status, attempts, last_error from jobs where workspace_id = $1 and kind = 'site.translate' order by created_at desc limit 1", [w2])).rows[0];
  assert.equal(job.status, 'failed');
  assert.equal(job.last_error, 'Google Translation didn’t answer in time.');
  const timedOut = Number((await db.query('select chars from site_translate_usage where workspace_id = $1', [w2])).rows[0].chars);
  assert.ok(timedOut > after, 'a timed-out call keeps its reservation');
  await new Promise((r) => { setTimeout(r, 500); });
});
