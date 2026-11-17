// Website → Languages (TR stage 2): the screen's reads and the people who
// correct the words. A volunteer granted only "Website translations"
// suggests; someone else puts it live; nobody checks their own words; a
// petition's statement needs a manager; Undo; the names; the estimate; the
// legal draft; Settings → Services' Check translation. Every call goes to
// the fake Google (fake-translate.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeTranslate } from './fake-translate.js';

const fake = await startFakeTranslate();
const ENV = { GOOGLE_TRANSLATE_KEY: 'test-translate-key-123', GOOGLE_TRANSLATE_API_BASE: fake.url };
const saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
Object.assign(process.env, ENV);
delete process.env.SITE_HOSTS;

const helpers = await import('./site-helpers.js');
const { ok, campaign, member } = helpers;
const hit = async (...a) => { const r = await helpers.hit(...a); return { ...r, text: r.text.replace(/<!-- -->/g, '') }; };
const { sweep, segHash } = await import('../ext/site/translate.js');
const { LEGAL_ENGLISH, LEGAL_KEYS, slotsOf } = await import('../../shared/site/wording.js');
const { cacheClear } = await import('../ext/site/cache.js');

let db; let mgr; let ws; let about; let petition; let vol; let staff; let outsider;
const STORY = 'We meet every week at the library.';
const approvedWords = (lang) => Object.fromEntries(LEGAL_KEYS.map((k) => [k, `${lang === 'pa' ? 'ਮਨਜ਼ੂਰ' : '批准的文字'} ${k} ${slotsOf(LEGAL_ENGLISH[k]).map((x) => `{${x}}`).join(' ')}`.trim()]));
const settingsNow = async () => ok(await mgr.get('/api/site')).settings;
const saveLanguages = async (patch) => { const s = await settingsNow(); return mgr.action('site.settings.save', { languages: { ...s.languages, ...patch } }); };
const row = async (lang, text) => (await db.query('select * from site_translations where workspace_id = $1 and lang = $2 and src_hash = $3', [ws, lang, segHash(text)])).rows[0];

before(async () => {
  ({ db, mgr, ws } = await campaign('Riverside Example League'));
  const s = await settingsNow();
  ok(await mgr.action('site.settings.save', { org: { ...s.org, name: 'Riverside Example League', shortName: '', agentName: 'Ada Example', agentContact: '604-555-0100' } }));
  const r = ok(await mgr.action('site.page.create', { title: 'About us', slug: 'about', modules: [
    { id: 'band01', kind: 'band', hidden: false, props: { title: 'When we organize,', highlight: 'we win', tone: 'accent' } },
    { id: 'text01', kind: 'text', hidden: false, props: { title: 'Our story', body: `${STORY}\n\nRead [the plan](https://example.org/plan) with Pat Example.`, tone: 'paper' } },
  ] }));
  ok(await mgr.action('site.page.publish', { id: r.page.id }));
  about = r.page;
  petition = ok(await mgr.action('site.campaign.save', { kind: 'petition', title: 'Fix the crossing', statement: 'We ask the city to fix the crossing.', excerpt: 'A safer walk.' })).campaign;
  vol = await member(mgr, 'volunteer', 'Vic Example');
  ok(await mgr.action('permission.member.set', { user_id: vol.id, grant: ['site_words'], deny: [] }));
  staff = await member(mgr, 'staff', 'Sam Example');
  ok(await mgr.action('permission.member.set', { user_id: staff.id, grant: ['site'], deny: [] }));
  outsider = await member(mgr, 'volunteer', 'Oli Example');
});

after(async () => {
  await fake.close();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

test('the Languages screen before anything is on: the key, three languages off, the month', async () => {
  const r = ok(await mgr.get('/api/site/languages'));
  assert.equal(r.key, true);
  assert.equal(r.agent, true);
  assert.deepEqual(r.languages.map((l) => [l.code, l.on, l.offered, l.legal.state]), [['pa', false, false, 'missing'], ['zh-Hans', false, false, 'missing'], ['zh-Hant', false, false, 'missing']]);
  assert.equal(r.usage.chars, 0);
  assert.equal(r.usage.limit, 450000);
  assert.ok(r.names.kept.includes('Riverside Example League'));
  assert.ok(r.names.possible.length > 0 && r.names.possible.length <= 30);
  assert.ok(r.names.possible.every((n) => !r.names.kept.includes(n)));
  assert.ok(r.names.possible.every((n) => /^\p{Lu}\S*\p{Ll}( \p{Lu}\S*\p{Ll}){1,2}$/u.test(n)), JSON.stringify(r.names.possible));
});

test('who may read it: Website translations, or the Website; nobody else', async () => {
  assert.equal((await outsider.client.get('/api/site/languages')).status, 403);
  assert.equal((await outsider.client.action('site.translate.now', {})).status, 403);
  assert.equal((await vol.client.get('/api/site/languages')).status, 200);
  assert.equal((await vol.client.get('/api/site')).status, 403, 'translations alone do not open the rest of the Website');
  assert.equal((await staff.client.get('/api/site/languages')).status, 200, 'the Website brings translations with it');
  const me = ok(await vol.client.get('/api/auth/me'));
  assert.ok(me.areas.includes('site_words'));
  assert.ok(!me.areas.includes('site'));
  // Only a manager turns a language on, sets the budget or approves the legal words.
  const s = await settingsNow();
  assert.equal((await vol.client.action('site.settings.save', { languages: { ...s.languages, on: ['pa'] } })).status, 403);
  assert.equal((await vol.client.action('site.legal.approve', { lang: 'pa', words: approvedWords('pa') })).status, 403);
});

test('the estimate is what the first sweep then sends', async () => {
  const est = ok(await mgr.get('/api/site/languages/pa/estimate'));
  assert.ok(est.essential > 1000 && est.all >= est.essential);
  const hant = ok(await mgr.get('/api/site/languages/zh-Hant/estimate'));
  assert.equal(hant.converted, true);
  ok(await saveLanguages({ on: ['pa', 'zh-Hans', 'zh-Hant'] }));
  fake.reset();
  await sweep(db, ws);
  const sent = fake.calls.filter((c) => c.target === 'pa').reduce((a, c) => a + c.q.reduce((x, q) => x + q.length, 0), 0);
  assert.ok(Math.abs(sent - est.all) <= est.all * 0.05, `sent ${sent}, estimated ${est.all}`);
  for (const lang of ['pa', 'zh-Hans', 'zh-Hant']) ok(await mgr.action('site.legal.approve', { lang, words: approvedWords(lang) }));
  const r = ok(await mgr.get('/api/site/languages'));
  const pa = r.languages.find((l) => l.code === 'pa');
  assert.equal(pa.offered, true);
  assert.equal(pa.legal.state, 'approved');
  assert.equal(pa.legal.approved_by_name, (await db.query('select name from users u join memberships m on m.user_id = u.id where m.workspace_id = $1 and m.role = $2', [ws, 'manager'])).rows[0].name);
  assert.equal(pa.counts.waiting, 0);
  assert.ok(pa.counts.machine > 0);
  assert.equal(pa.counts.live, pa.counts.machine);
  const hantNow = r.languages.find((l) => l.code === 'zh-Hant');
  assert.ok(hantNow.counts.converted > 0);
  assert.ok(r.usage.chars >= sent);
});

test('the sentence list: to check, with where each is; a search', async () => {
  const r = ok(await vol.client.get('/api/site/languages/pa/sentences?filter=check'));
  assert.equal(r.sentences.length, 50);
  assert.ok(r.next === 50 && r.total > 50);
  // The site's own pages first; the fixed words every site shares last.
  assert.notEqual(r.sentences[0].place_label, 'Fixed words', 'a page comes before the fixed words');
  const firstFixed = r.sentences.findIndex((x) => x.place_label === 'Fixed words');
  if (firstFixed >= 0) assert.ok(r.sentences.slice(firstFixed).every((x) => x.place_label === 'Fixed words'), 'nothing of the site’s own after the fixed words begin');
  const story = ok(await vol.client.get(`/api/site/languages/pa/sentences?filter=all&q=${encodeURIComponent('library')}`));
  assert.equal(story.sentences.length, 1);
  assert.equal(story.sentences[0].src, STORY);
  assert.equal(story.sentences[0].place_label, 'About us · Text block');
  assert.equal(story.sentences[0].origin, 'machine');
  assert.ok(!(ok(await vol.client.get('/api/site/languages/pa/sentences?filter=all&q=Authorized')).sentences.length), 'the legal drafts are on their own screen');
});

test('a volunteer with only Website translations suggests; the page waits for someone else to approve it', async () => {
  cacheClear(ws);
  const before1 = await hit('/site/pa/about');
  assert.equal(before1.status, 200);
  const h = segHash(STORY);
  const s = ok(await vol.client.action('site.translation.save', { lang: 'pa', src_hash: h, text: 'ਅਸੀਂ ਹਰ ਹਫ਼ਤੇ ਮਿਲਦੇ ਹਾਂ।' }));
  assert.equal(s.state, 'suggested');
  cacheClear(ws);
  assert.ok(!(await hit('/site/pa/about')).text.includes('ਅਸੀਂ ਹਰ ਹਫ਼ਤੇ'), 'a suggestion changes nothing public');
  const list = ok(await vol.client.get('/api/site/languages/pa/sentences?filter=suggested'));
  assert.equal(list.sentences.length, 1);
  assert.equal(list.sentences[0].suggestion.by_name, 'Vic Example');
  assert.equal(list.sentences[0].suggestion.mine, true);
  const own = await vol.client.action('site.translation.approve', { lang: 'pa', version_id: s.version_id });
  assert.equal(own.status, 403);
  assert.equal(own.json.error, 'Someone else needs to check your own wording');
  ok(await mgr.action('site.translation.approve', { lang: 'pa', version_id: s.version_id }));
  const page = await hit('/site/pa/about');
  assert.ok(page.text.includes('ਅਸੀਂ ਹਰ ਹਫ਼ਤੇ ਮਿਲਦੇ ਹਾਂ।'), 'live within one request');
  const r = await row('pa', STORY);
  assert.equal(r.origin, 'edited');
  assert.ok(r.checked_at, 'checked by the one who approved it');
  // A republish with the same English keeps it.
  ok(await mgr.action('site.page.publish', { id: about.id }));
  await sweep(db, ws);
  assert.ok((await hit('/site/pa/about')).text.includes('ਅਸੀਂ ਹਰ ਹਫ਼ਤੇ ਮਿਲਦੇ ਹਾਂ।'));
  // A suggestion declined changes nothing.
  const s2 = ok(await vol.client.action('site.translation.save', { lang: 'pa', src_hash: h, text: 'ਕੁਝ ਹੋਰ ਸ਼ਬਦ' }));
  ok(await mgr.action('site.translation.decline', { lang: 'pa', version_id: s2.version_id }));
  assert.equal((await row('pa', STORY)).text, 'ਅਸੀਂ ਹਰ ਹਫ਼ਤੇ ਮਿਲਦੇ ਹਾਂ।');
  // Recent edits show it, with who.
  const edits = ok(await mgr.get('/api/site/languages/pa/edits'));
  assert.equal(edits.edits[0].state, 'declined');
  assert.equal(edits.edits[1].by_name, 'Vic Example');
  assert.equal(edits.edits[1].src, STORY);
  assert.equal(edits.edits[1].live, true);
});

test('someone with the Website: an edit is live at once, unchecked; nobody checks their own; Undo goes back', async () => {
  const h = segHash('Our story');
  const was = (await row('pa', 'Our story')).text;
  const s = ok(await staff.client.action('site.translation.save', { lang: 'pa', src_hash: h, text: 'ਸਾਡੀ ਕਹਾਣੀ' }));
  assert.equal(s.state, 'live');
  cacheClear(ws);
  assert.ok((await hit('/site/pa/about')).text.includes('ਸਾਡੀ ਕਹਾਣੀ'));
  assert.equal((await row('pa', 'Our story')).checked_at, null);
  const own = await staff.client.action('site.translation.check', { lang: 'pa', src_hashes: [h] });
  assert.equal(own.status, 403);
  ok(await vol.client.action('site.translation.check', { lang: 'pa', src_hashes: [h] }));
  assert.ok((await row('pa', 'Our story')).checked_at);
  // Undo: the Website's.
  assert.equal((await vol.client.action('site.translation.undo', { lang: 'pa', version_id: s.version_id })).status, 403);
  ok(await mgr.action('site.translation.undo', { lang: 'pa', version_id: s.version_id }));
  const back = await row('pa', 'Our story');
  assert.equal(back.text, was);
  assert.equal(back.origin, 'machine');
  assert.equal(back.checked_at, null);
  assert.ok(!(await hit('/site/pa/about')).text.includes('ਸਾਡੀ ਕਹਾਣੀ'));
});

test('Simplified corrected: Traditional follows, converted', async () => {
  const h = segHash('Our story');
  ok(await mgr.action('site.translation.save', { lang: 'zh-Hans', src_hash: h, text: '我们的故事' }));
  const t = await row('zh-Hant', 'Our story');
  assert.equal(t.text, '我們的故事');
  assert.equal(t.origin, 'converted');
});

test('what a correction may not do', async () => {
  const save = (src, text) => mgr.action('site.translation.save', { lang: 'pa', src_hash: segHash(src), text });
  const band = 'When we organize, <u>we win</u>';
  const cases = [
    [STORY, '', /Type the words/],
    [STORY, 'ਸ'.repeat(STORY.length * 3 + 201), /much longer/],
    ['Read [the plan](https://example.org/plan) with Pat Example.', 'ਪੜ੍ਹੋ [ਯੋਜਨਾ](https://elsewhere.example.org/) Pat Example', /Keep the links as they are/],
    ['Read [the plan](https://example.org/plan) with Pat Example.', 'ਪੜ੍ਹੋ [ਯੋਜਨਾ](https://example.org/plan) ਪੈਟ', null],
    [band, 'ਜਦੋਂ ਅਸੀਂ ਜਿੱਤਦੇ ਹਾਂ', /<u> and <\/u>/],
  ];
  for (const [src, text, want] of cases) {
    const r = await save(src, text);
    if (want) { assert.equal(r.status, 400, text.slice(0, 40)); assert.match(r.json.error, want); } else ok(r);
  }
  ok(await mgr.action('site.names.keep', { name: 'Pat Example', keep: true }));
  const kept = await save('Read [the plan](https://example.org/plan) with Pat Example.', 'ਪੜ੍ਹੋ [ਯੋਜਨਾ](https://example.org/plan) ਪੈਟ');
  assert.equal(kept.status, 400);
  assert.equal(kept.json.error, 'Keep ‘Pat Example’ as written');
  ok(await save(band, '<u>ਅਸੀਂ ਜਿੱਤਦੇ ਹਾਂ</u> ਜਦੋਂ ਅਸੀਂ ਇਕੱਠੇ ਹੁੰਦੇ ਹਾਂ'));
  // A fixed word's slot stays.
  const ui = (await db.query("select src from site_translations where workspace_id = $1 and lang = 'pa' and src like '%{amount}%' limit 1", [ws])).rows[0];
  if (ui) {
    const r = await save(ui.src, 'ਸ਼ਬਦ');
    assert.equal(r.status, 400);
    assert.match(r.json.error, /Keep \{amount\}/);
  }
});

test('names: kept as written from the screen; one taken off', async () => {
  const r = ok(await vol.client.get('/api/site/languages'));
  assert.ok(r.names.typed.includes('Pat Example'));
  assert.ok(!r.names.possible.includes('Pat Example'));
  ok(await vol.client.action('site.names.keep', { name: 'Pat Example', keep: false }));
  assert.ok(!ok(await mgr.get('/api/site/languages')).names.typed.includes('Pat Example'));
  // A manager's switch saves only what it changes: a name a translator kept
  // meanwhile stays kept.
  ok(await vol.client.action('site.names.keep', { name: 'Jas Example', keep: true }));
  ok(await mgr.action('site.settings.save', { languages: { oldPosts: true } }));
  const after = ok(await mgr.get('/api/site/languages'));
  assert.ok(after.names.typed.includes('Jas Example'), 'kept');
  assert.deepEqual(after.settings.on, ['pa', 'zh-Hans', 'zh-Hant'], 'the languages on stay on');
  assert.equal(after.settings.oldPosts, true);
  ok(await mgr.action('site.settings.save', { languages: { oldPosts: false } }));
  ok(await vol.client.action('site.names.keep', { name: 'Jas Example', keep: false }));
});

test('a petition’s statement: a manager checks the machine’s words; anyone else may not', async () => {
  const h = segHash(petition.statement);
  const r = await staff.client.action('site.translation.check', { lang: 'pa', src_hashes: [h] });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /A manager needs to check/);
  // A volunteer's suggestion: approved by a manager only.
  const s = ok(await vol.client.action('site.translation.save', { lang: 'pa', src_hash: h, text: 'ਅਸੀਂ ਸ਼ਹਿਰ ਨੂੰ ਕਹਿੰਦੇ ਹਾਂ।' }));
  assert.equal((await staff.client.action('site.translation.approve', { lang: 'pa', version_id: s.version_id })).status, 403);
  ok(await mgr.action('site.translation.approve', { lang: 'pa', version_id: s.version_id }));
  cacheClear(ws);
  assert.ok((await hit(`/site/pa/act/${petition.slug}`)).text.includes('ਅਸੀਂ ਸ਼ਹਿਰ ਨੂੰ ਕਹਿੰਦੇ ਹਾਂ।'));
});

test('a statement quoted word for word on a page still needs a manager', async () => {
  const statement = 'We ask the council to light the river path.';
  const quote = ok(await mgr.action('site.page.create', { title: 'Our ask', slug: 'our-ask', modules: [
    { id: 'text01', kind: 'text', hidden: false, props: { title: 'Sign our petition', body: statement, tone: 'paper' } },
  ] }));
  ok(await mgr.action('site.page.publish', { id: quote.page.id }));
  const p = ok(await mgr.action('site.campaign.save', { kind: 'petition', title: 'Light the path', statement, excerpt: 'Safer at night.' })).campaign;
  await sweep(db, ws);
  const h = segHash(statement);
  const machine = (await row('pa', statement)).text;
  for (const who of [vol, staff]) {
    const r = await who.client.action('site.translation.check', { lang: 'pa', src_hashes: [h] });
    assert.equal(r.status, 403, `${who.email} may not check a statement`);
    assert.match(r.json.error, /A manager needs to check/);
  }
  const s = ok(await vol.client.action('site.translation.save', { lang: 'pa', src_hash: h, text: 'ਅਸੀਂ ਕੌਂਸਲ ਨੂੰ ਰਾਹ ਰੌਸ਼ਨ ਕਰਨ ਲਈ ਕਹਿੰਦੇ ਹਾਂ।' }));
  assert.equal((await staff.client.action('site.translation.approve', { lang: 'pa', version_id: s.version_id })).status, 403);
  ok(await mgr.action('site.translation.decline', { lang: 'pa', version_id: s.version_id }));
  cacheClear(ws);
  assert.ok(!(await hit(`/site/pa/act/${p.slug}`)).text.includes(machine), 'unchecked, the statement stays in English');
  const list = ok(await mgr.get(`/api/site/languages/pa/sentences?filter=all&q=${encodeURIComponent('river path')}`)).sentences;
  assert.equal(list.length, 1);
  assert.equal(list[0].check_first, true);
});

test('couldn’t translate: listed with the reason; typing its words clears it', async () => {
  fake.set({ drop: { contains: 'meets on Tuesdays', what: 'x' } });
  const text = 'Riverside Example League meets on Tuesdays.';
  ok(await mgr.action('site.campaign.save', { id: petition.id, kind: 'petition', title: 'Fix the crossing', statement: petition.statement, excerpt: text }));
  await sweep(db, ws);
  fake.set({ drop: null });
  const r = ok(await mgr.get('/api/site/languages/pa/sentences?filter=failed'));
  assert.equal(r.sentences.length, 1);
  assert.equal(r.sentences[0].failure.reason, 'A kept name came back changed');
  assert.equal(r.counts.failed, 1);
  assert.equal(ok(await mgr.get('/api/site/languages')).languages.find((l) => l.code === 'pa').counts.failed, 1);
  ok(await mgr.action('site.translation.save', { lang: 'pa', src_hash: segHash(text), text: 'Riverside Example League ਮੰਗਲਵਾਰ ਨੂੰ ਮਿਲਦੀ ਹੈ।' }));
  assert.equal(ok(await mgr.get('/api/site/languages/pa/sentences?filter=failed')).sentences.length, 0);
});

test('the legal words: the machine’s draft, and Traditional from the approved Simplified', async () => {
  const pa = ok(await vol.client.get('/api/site/languages/pa/legal'));
  assert.equal(pa.keys[0].key, 'authorizedBy');
  assert.equal(pa.keys[0].english, 'Authorized by Ada Example, 604-555-0100');
  assert.equal(pa.draft_from, 'machine');
  assert.ok(pa.draft.authorizedBy.includes('{agent}'));
  assert.ok(pa.approved.words.authorizedBy.startsWith('ਮਨਜ਼ੂਰ'));
  assert.deepEqual(pa.stale_keys, []);
  const hant = ok(await mgr.get('/api/site/languages/zh-Hant/legal'));
  assert.equal(hant.draft_from, 'converted');
  const { convertToTraditional } = await import('../ext/site/translate.js');
  assert.equal(hant.draft.authorizedBy, await convertToTraditional(approvedWords('zh-Hans').authorizedBy));
});

test('Settings → Services: the Translation row, its Check, and Check translation', async () => {
  const list = ok(await mgr.get('/api/connections'));
  const t = list.services.find((s) => s.key === 'translate');
  assert.equal(t.state, 'ready');
  assert.equal(t.panel, 'translate');
  const c = ok(await mgr.post('/api/connections/check', { key: 'translate' }));
  assert.equal(c.ok, true);
  assert.equal((await staff.client.post('/api/connections/translate-probe', {})).status, 403);
  const p = ok(await mgr.post('/api/connections/translate-probe', {}));
  assert.equal(p.ok, true);
  assert.match(p.said, /^Names kept: (yes|no) · Header accepted: yes · Placeholders kept: yes$/);
  const probe = (await db.query('select probe from site_translate_runtime where workspace_id = $1', [ws])).rows[0].probe;
  assert.equal((typeof probe === 'string' ? JSON.parse(probe) : probe).headerAccepted, true);
});

test('History: a yes given in 简体 shows the words shown, their language and the English; a sign-up says its language', async () => {
  const p = ok(await mgr.action('person.create', { kind: 'person', first_name: 'Mei', last_name: 'Example', email: `mei-${Date.now()}@example.org` })).person;
  await db.query(
    `insert into consent_events (id, workspace_id, person_id, channel, granted, source, wording, lang, wording_en)
     values (gen_random_uuid(), $1, $2, 'email', true, 'website-newsletter', '是的，给我发电子邮件', 'zh-Hans', 'Yes, email me')`, [ws, p.id]);
  await db.query("insert into site_actions (id, workspace_id, person_id, kind, payload, lang) values (gen_random_uuid(), $1, $2, 'newsletter', '{}'::jsonb, 'zh-Hans')", [ws, p.id]);
  const t = ok(await mgr.get(`/api/persons/${p.id}/timeline`));
  const all = JSON.stringify(t);
  assert.match(all, /是的，给我发电子邮件 \(in 简体\) · English: Yes, email me/);
  assert.match(all, / in 简体"/);
});

test('a person’s Traditional checked, then the Simplified changes: it goes back under To check', async () => {
  const h = segHash(STORY);
  const checkList = async () => ok(await vol.client.get(`/api/site/languages/zh-Hant/sentences?filter=check&q=${encodeURIComponent('library')}`)).sentences;
  ok(await mgr.action('site.translation.save', { lang: 'zh-Hant', src_hash: h, text: '我們每週在圖書館見面。' }));
  assert.equal((await checkList()).length, 0, 'a person’s own words are not machine words to check');
  ok(await vol.client.action('site.translation.check', { lang: 'zh-Hant', src_hashes: [h] }));
  ok(await staff.client.action('site.translation.save', { lang: 'zh-Hans', src_hash: h, text: '我们每周都在图书馆聚会。' }));
  const t = await row('zh-Hant', STORY);
  assert.equal(t.text, '我們每週在圖書館見面。', 'the person’s Traditional stays');
  assert.equal(t.checked_at, null);
  const list = await checkList();
  assert.equal(list.length, 1, 'under To check');
  assert.equal(list[0].origin, 'edited');
  // Checked again: off the list.
  ok(await vol.client.action('site.translation.check', { lang: 'zh-Hant', src_hashes: [h] }));
  assert.equal((await checkList()).length, 0);
});

test('a name kept later: a person’s words that hold it go under To check', async () => {
  const src = 'Read [the plan](https://example.org/plan) with Pat Example.';
  const list = async () => ok(await mgr.get(`/api/site/languages/pa/sentences?filter=check&q=${encodeURIComponent('the plan')}`)).sentences;
  ok(await mgr.action('site.translation.save', { lang: 'pa', src_hash: segHash(src), text: 'ਪੜ੍ਹੋ [ਯੋਜਨਾ](https://example.org/plan) Pat Example ਨਾਲ।' }));
  assert.equal((await list()).length, 0);
  ok(await mgr.action('site.names.keep', { name: 'Pat Example', keep: true }));
  const l = await list();
  assert.equal(l.length, 1);
  assert.equal(l[0].origin, 'edited');
  ok(await mgr.action('site.names.keep', { name: 'Pat Example', keep: false }));
});

test('History: a gift declared in ਪੰਜਾਬੀ shows the words and the English; a signature shows the statement as signed', async () => {
  const p = ok(await mgr.action('person.create', { kind: 'person', first_name: 'Gurpreet', last_name: 'Example', email: `gp-${Date.now()}@example.org` })).person;
  const declaration = { text: 'ਮੈਂ ਕੈਨੇਡੀਅਨ ਨਾਗਰਿਕ ਹਾਂ', lang: 'pa', english: 'I am a Canadian citizen', source: 'website' };
  await db.query(
    `insert into gifts (id, workspace_id, person_id, amount_cents, date, method, cadence, attrs)
     values (gen_random_uuid(), $1, $2, 2500, current_date, 'card', 'one-time', $3)`, [ws, p.id, JSON.stringify({ source: 'online', declaration })]);
  await db.query(
    `insert into site_actions (id, workspace_id, person_id, kind, campaign_id, payload, lang)
     values (gen_random_uuid(), $1, $2, 'petition', $3, $4, 'pa')`,
    [ws, p.id, petition.id, JSON.stringify({ statement_shown: 'ਅਸੀਂ ਸ਼ਹਿਰ ਨੂੰ ਲਾਂਘਾ ਠੀਕ ਕਰਨ ਲਈ ਕਹਿੰਦੇ ਹਾਂ।', statement_lang: 'pa' })]);
  const t = ok(await mgr.get(`/api/persons/${p.id}/timeline`));
  const gift = t.entries.find((e) => e.kind === 'gift');
  assert.match(gift.detail, /Declared in ਪੰਜਾਬੀ: ਮੈਂ ਕੈਨੇਡੀਅਨ ਨਾਗਰਿਕ ਹਾਂ · English: I am a Canadian citizen/);
  const signed = t.entries.find((e) => e.kind === 'web');
  assert.match(signed.detail, /Signed in ਪੰਜਾਬੀ: ਅਸੀਂ ਸ਼ਹਿਰ ਨੂੰ ਲਾਂਘਾ ਠੀਕ ਕਰਨ ਲਈ ਕਹਿੰਦੇ ਹਾਂ।/);
});

test('Preview: the home page in a language that is on, before visitors see it', async () => {
  const r = ok(await vol.client.get('/api/site/languages/pa/preview'));
  const u = new URL(r.url, 'http://localhost');
  assert.match(u.pathname, /^\/site\/__preview\//);
  assert.equal(u.searchParams.get('lang'), 'pa');
  const page = await hit(`${u.pathname}${u.search}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /<html[^>]* lang="pa"/);
  assert.match(page.text, /noindex/);
  // A draft of the home page is the Website's: someone with only
  // translations previews the published page; the Website sees the draft.
  const home = (await db.query("select id, draft from site_pages where workspace_id = $1 and site_id is null and slug = 'home'", [ws])).rows[0];
  const d = typeof home.draft === 'string' ? JSON.parse(home.draft) : home.draft;
  ok(await mgr.action('site.page.save', { id: home.id, modules: [...(d.modules || []), { id: 'draft9', kind: 'text', hidden: false, props: { title: 'Not yet', body: 'UNPUBLISHED-DRAFT-WORDS', tone: 'paper' } }] }));
  const volView = await hit(new URL(ok(await vol.client.get('/api/site/languages/pa/preview')).url, 'http://localhost').href.replace('http://localhost', ''));
  assert.equal(volView.status, 200);
  assert.ok(!volView.text.includes('UNPUBLISHED-DRAFT-WORDS'), 'no unpublished draft for translations alone');
  const mgrView = await hit(new URL(ok(await mgr.get('/api/site/languages/pa/preview')).url, 'http://localhost').href.replace('http://localhost', ''));
  assert.ok(mgrView.text.includes('UNPUBLISHED-DRAFT-WORDS'), 'the Website previews its draft');
  ok(await saveLanguages({ on: ['pa', 'zh-Hans'] }));
  const off = await vol.client.get('/api/site/languages/zh-Hant/preview');
  assert.equal(off.status, 409);
  ok(await saveLanguages({ on: ['pa', 'zh-Hans', 'zh-Hant'] }));
});

test('Undo puts back exactly the words that were live before, whoever made them and in whatever order', async () => {
  const one = 'Doors open at noon on Saturday.';
  const two = 'Bring a friend along to the meeting.';
  const three = 'Coffee is on the house for everyone.';
  const r = ok(await mgr.action('site.page.create', { title: 'Open house', slug: 'open-house', modules: [
    { id: 'text01', kind: 'text', hidden: false, props: { title: 'Saturday', body: `${one}\n\n${two}\n\n${three}`, tone: 'paper' } },
  ] }));
  ok(await mgr.action('site.page.publish', { id: r.page.id }));
  await sweep(db, ws);
  const save = async (who, lang, src, text) => ok(await who.action('site.translation.save', { lang, src_hash: segHash(src), text }));
  const undo = async (who, lang, id) => ok(await who.action('site.translation.undo', { lang, version_id: id }));

  // An edit undone, then a later edit undone: the words live before that one.
  const b = await save(staff.client, 'pa', one, 'ਬੀ ਸ਼ਬਦ');
  const c = await save(mgr, 'pa', one, 'ਸੀ ਗਲਤ');
  await undo(mgr, 'pa', c.version_id);
  assert.equal((await row('pa', one)).text, 'ਬੀ ਸ਼ਬਦ');
  const d = await save(staff.client, 'pa', one, 'ਡੀ ਸ਼ਬਦ');
  await undo(mgr, 'pa', d.version_id);
  const back = await row('pa', one);
  assert.equal(back.text, 'ਬੀ ਸ਼ਬਦ', 'the words live before D, not the ones undone');
  assert.equal(back.version_id, b.version_id);
  assert.equal(back.checked_at, null, 'nobody approved B: still to check');

  // A suggestion approved after a later edit: Undo goes to that edit.
  const s = await save(vol.client, 'pa', two, 'ਸੁਝਾਅ ਸ਼ਬਦ');
  await save(staff.client, 'pa', two, 'ਬੀ ਸਿੱਧਾ');
  ok(await mgr.action('site.translation.approve', { lang: 'pa', version_id: s.version_id }));
  await undo(mgr, 'pa', s.version_id);
  assert.equal((await row('pa', two)).text, 'ਬੀ ਸਿੱਧਾ', 'the staff correction comes back');

  // Traditional edited, Simplified then changed, the edit undone: converted
  // from the Simplified as it is now.
  await save(mgr, 'zh-Hant', three, '人工的繁體字');
  await save(staff.client, 'zh-Hans', three, '咖啡对所有人免费');
  const e = await row('zh-Hant', three);
  assert.equal(e.text, '人工的繁體字');
  await undo(mgr, 'zh-Hant', e.version_id);
  const t = await row('zh-Hant', three);
  assert.equal(t.origin, 'converted');
  assert.equal(t.text, '咖啡對所有人免費', 'from the Simplified as it is now');
  assert.equal(t.needs_check, false);
});
