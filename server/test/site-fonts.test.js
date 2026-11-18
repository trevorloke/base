// Google fonts for the website (WA stage 1; ext/site fonts.js, shared/site
// fonts.js, SITE.md "Fonts"): a font fetched from Google once, outside any
// write, and served from the site's own address; the readability rules and
// the speed budget; where a font is in use; the pairings' files.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startFakeGoogleFonts } from './fake-google-fonts.js';

const fake = await startFakeGoogleFonts();
const ENV = { GOOGLE_FONTS_CSS_BASE: fake.url, GOOGLE_FONTS_FILE_HOSTS: fake.host };
const saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
Object.assign(process.env, ENV);
delete process.env.SITE_HOSTS;

const helpers = await import('./site-helpers.js');
const { ok, campaign } = helpers;
const hit = async (...a) => { const r = await helpers.hit(...a); return { ...r, text: r.text.replace(/<!-- -->/g, '') }; };
const { Client } = await import('./helpers.js');
const { app } = await import('../index.js');
const { runAction } = await import('../lib/events.js');
const { outsideFetch, OUTSIDE_IN_WRITE } = await import('../lib/outside.js');
const { runDueJobs } = await import('../lib/jobs.js');
const { forgetDomains } = await import('../ext/site/store.js');
const { WORDS } = await import('../ext/site/fonts.js');
const F = await import('../../shared/site/fonts.js');
const { checkTheme } = await import('../../shared/site/theme.js');
const { brandHtml, brandFor } = await import('../lib/brand.js');

const SHARED = fileURLToPath(new URL('../../shared/site/', import.meta.url));
let db; let mgr; let ws;

const fonts = async () => ok(await mgr.get('/api/site/fonts')).fonts;
const add = (family) => mgr.action('site.font.add', { family });
const theme = async (fontsPatch, extra = {}) => {
  const s = ok(await mgr.get('/api/site')).settings;
  return mgr.action('site.settings.save', { theme: { ...s.theme, fonts: { ...s.theme.fonts, ...fontsPatch }, ...extra } });
};
const count = async (table) => Number((await db.query(`select count(*)::int as n from ${table} where workspace_id = $1`, [ws])).rows[0].n);
const rows = async () => (await db.query('select slug from site_fonts where workspace_id = $1 and deleted_at is null order by slug', [ws])).rows.map((r) => r.slug);
const clear = async () => {
  await db.query('update site_fonts set deleted_at = now() where workspace_id = $1 and deleted_at is null', [ws]);
  await db.query("update site_settings set theme = jsonb_set(theme::jsonb, '{fonts}', '{\"heading\":\"montserrat\",\"body\":\"montserrat\"}')::jsonb where workspace_id = $1", [ws]);
};
// A heavy font, written as a restored export would leave it (no Google call).
const heavyRow = async (slug, bytes, { bodySafe = true } = {}) => {
  await db.query(
    `insert into site_fonts (id, workspace_id, slug, family, category, body_safe, licence, faces)
     values (gen_random_uuid(), $1, $2, $3, 'sans-serif', $4, 'OFL', $5)`,
    [ws, slug, slug.replace(/-/g, ' '), bodySafe, JSON.stringify([{ subset: 'latin', weight: '100 900', style: 'normal', unicode_range: F.LATIN, sha256: 'c'.repeat(64), bytes }])],
  );
};

before(async () => {
  ({ db, mgr, ws } = await campaign('Harbour City Together'));
  ok(await mgr.get('/api/site'));
});
after(async () => {
  await fake.close();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

// ── The shared rules ──
test('pairings: every body face is checked for reading; each first visit is what its files weigh, at most 100 KB', () => {
  assert.equal(F.PAIRINGS.length, 12);
  const safe = new Set(readFileSync(fileURLToPath(new URL('../../scripts/google-fonts-body-safe.txt', import.meta.url)), 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#')));
  assert.equal(safe.size, 65);
  for (const p of F.PAIRINGS) {
    const body = F.FONT_BY_VALUE[p.body];
    assert.ok(body.body && safe.has(body.family), `${p.key}: ${body.family} is body-safe`);
    const bytes = F.pairFiles(p).reduce((n, f) => n + statSync(`${SHARED}${f}`).size, 0);
    assert.equal(p.kb, Math.ceil(bytes / 1024), `${p.key}'s kb is its files'`);
    assert.ok(p.kb <= 100, `${p.key} ${p.kb} KB`);
    assert.equal(F.firstVisitKb({ fonts: { heading: p.heading, body: p.body } }, [], 'en'), p.kb);
  }
  for (const [file, n] of Object.entries(F.FILE_BYTES)) assert.equal(statSync(`${SHARED}${file}`).size, n, file);
});

test('stacks: every face carries Gurmukhi and the reader’s Chinese faces; the built-in files are drawn by site.css', () => {
  for (const f of F.FONTS) {
    assert.ok(f.stack.includes("'Noto Sans Gurmukhi'"), f.value);
    assert.ok(f.stack.includes('var(--cjk'), f.value);
  }
  const css = readFileSync(`${SHARED}site.css`, 'utf8');
  for (const b of F.BUILT_FILES) {
    assert.ok(statSync(`${SHARED}${b.file}`).size > 1000, b.file);
    assert.ok(css.includes(`url("${b.file}")`), `site.css declares ${b.file}`);
  }
  assert.ok(!/html\[data-heading="(inter|montserrat|barlow-condensed|serif|system)"\] \./.test(css), 'no per-face heading rules');
});

test('heading profiles: the built-ins keep exactly the values they had; another face gets one from its weights', () => {
  const p = (v) => F.profileFor(F.FONT_BY_VALUE[v]);
  assert.deepEqual([p('montserrat').weight, p('montserrat').tracking, p('montserrat').leading, p('montserrat').case], [900, '0.025em', 1.05, 'none']);
  assert.deepEqual([p('inter').weight, p('inter').tracking, p('inter').leading], [800, '-0.025em', 1.04]);
  assert.deepEqual([p('system').weight, p('system').tracking, p('system').leading], [800, '-0.025em', 1.04]);
  assert.deepEqual([p('barlow-condensed').weight, p('barlow-condensed').tracking, p('barlow-condensed').leading, p('barlow-condensed').case], [800, '0.005em', 0.98, 'uppercase']);
  assert.deepEqual([p('serif').weight, p('serif').tracking, p('serif').leading], [700, '-0.01em', 1.05]);
  assert.deepEqual(p('montserrat').wordmark, { weight: 900, tracking: '0.02em', case: 'none', size: '24px' });
  assert.deepEqual(p('barlow-condensed').wordmark, { weight: 800, tracking: '-0.01em', case: 'uppercase', size: '28px' });
  assert.deepEqual(p('inter').title, { weight: 800, tracking: '-0.02em' });
  assert.deepEqual(p('system').rail, { weight: 900, tracking: '0.025em' });
  assert.deepEqual([p('fraunces').weight, p('fraunces').tracking, p('fraunces').leading], [800, '0', 1.15]);
  assert.deepEqual([p('oswald').weight, p('oswald').tracking, p('oswald').leading], [700, '-0.01em', 1.1]);
  assert.deepEqual([p('archivo-black').weight, p('archivo-black').synthesis], [400, 'none']);
  assert.equal(F.emailFontStack({ fonts: { heading: 'fraunces' } }), "'Fraunces', Georgia, 'Times New Roman', serif");
});

test('checkTheme: a heading-only font for body is refused; an added font not the campaign’s falls back; the budget', () => {
  const added = [{ slug: 'fake-serif', family: 'Fake Serif', category: 'serif', bodySafe: false, faces: [{ subset: 'latin', weight: '400', style: 'normal', sha256: 'a'.repeat(64), bytes: 30000 }] }];
  const bad = checkTheme({ fonts: { heading: 'inter', body: 'fraunces' } }, 'base', { added: [] });
  assert.deepEqual(bad.problems.map((x) => x.words), [F.FONT_WORDS.body]);
  assert.deepEqual(checkTheme({ fonts: { heading: 'inter', body: 'g:fake-serif' } }, 'base', { added }).problems.map((x) => x.words), [F.FONT_WORDS.body], 'a serif not on the reviewed list');
  const gone = checkTheme({ fonts: { heading: 'g:nope', body: 'inter' } }, 'base', { added });
  assert.equal(gone.theme.fonts.heading, 'inter', 'falls back to the skin’s');
  assert.equal(checkTheme({ fonts: { heading: 'g:fake-serif', body: 'inter' } }, 'base', { added }).theme.fonts.heading, 'g:fake-serif');
});

// ── Adding a font ──
test('no call to another service from inside a write', async () => {
  await assert.rejects(
    runAction(db, { workspaceId: ws, actorId: null, action: 'test.outside' }, async () => outsideFetch(`${fake.url}/css2?family=Fake+Sans`)),
    new RegExp(OUTSIDE_IN_WRITE),
  );
});

test('adding a font: latin and latin-ext only, hashes in the event, never bytes; twice is the same row', async () => {
  fake.requests.length = 0;
  const r = ok(await add('Fake Sans'));
  assert.equal(r.font.slug, 'fake-sans');
  assert.deepEqual([...new Set(r.font.faces.map((f) => f.subset))].sort(), ['latin', 'latin-ext']);
  assert.ok(fake.requests.filter((q) => q.path.startsWith('/css2')).every((q) => /Chrome\//.test(q.ua)), 'asked as a browser');
  assert.ok(fake.requests[0].path.includes('wght@100..900'), fake.requests[0].path);
  assert.ok(fake.requests.every((q) => !/cyrillic|vietnamese/.test(q.path)), 'other subsets never fetched');
  const ev = (await db.query("select payload from events where workspace_id = $1 and action = 'site.font.add' order by seq desc limit 1", [ws])).rows[0].payload;
  const pay = typeof ev === 'string' ? JSON.parse(ev) : ev;
  assert.ok(pay.faces.every((f) => /^[a-f0-9]{64}$/.test(f.sha256) && f.bytes > 1000 && !('data' in f)));
  assert.ok(JSON.stringify(pay).length < 3000, 'no bytes in the log');
  const files = await count('site_font_files');
  fake.requests.length = 0;
  const again = ok(await add('Fake Sans'));
  assert.equal(again.font.slug, 'fake-sans');
  assert.equal(fake.requests.length, 0, 'not fetched again');
  assert.deepEqual(await rows(), ['fake-sans']);
  assert.equal(await count('site_font_files'), files);
  assert.equal((await add('No Such Font Example')).status, 404);
});

test('what Google sends is checked: another host is never asked, every cap has its words, nothing is written', async () => {
  const before = [await count('site_fonts'), await count('site_font_files')];
  const tryMode = async (mode, words) => {
    fake.mode = mode;
    fake.requests.length = 0;
    const r = await add('Fake Display');
    fake.mode = 'ok';
    assert.equal(r.status, 502, `${mode}: ${JSON.stringify(r.json)}`);
    assert.equal(r.json.error, words, String(mode));
    return fake.requests;
  };
  const other = await tryMode('otherhost', WORDS.odd);
  assert.deepEqual(other.map((q) => q.path.split('?')[0]), ['/css2'], 'no file asked for anywhere');
  await tryMode('notwoff2', WORDS.odd);
  await tryMode('big', WORDS.fileBig);
  await tryMode('nine', WORDS.odd);
  await tryMode(500, WORDS.down);
  await tryMode(403, WORDS.odd);
  const t = Date.now();
  await tryMode('stall', WORDS.down);
  assert.ok(Date.now() - t < 10_000, 'a stall fails within 10 s');
  assert.deepEqual([await count('site_fonts'), await count('site_font_files')], before, 'nothing written');
});

test('six added fonts at most, counted again inside the write: two racing for the sixth make one', async () => {
  await clear();
  for (const f of ['Fake Sans', 'Fake Display', 'Fake Serif', 'Lato']) ok(await add(f), f);
  const second = new Client();
  second.cookie = mgr.cookie;
  const [a, b] = await Promise.all([add('Roboto Slab'), second.action('site.font.add', { family: 'Lora' })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 200], 'room for both: five and six');
  const full = await add('Bitter');
  assert.equal(full.status, 400);
  assert.equal(full.json.error, WORDS.full);
  // Two racing for the sixth place: both pass the early count, one is refused inside.
  await db.query("update site_fonts set deleted_at = now() where workspace_id = $1 and slug = 'lora'", [ws]);
  const [c, d] = await Promise.all([add('Bitter'), second.action('site.font.add', { family: 'Arvo' })]);
  assert.deepEqual([c.status, d.status].sort(), [200, 400]);
  assert.equal((await rows()).length, 6);
  await clear();
});

// ── Using it ──
test('a theme with an added font: saved, drawn from the site’s own address, CSP unchanged; the file is this campaign’s', async () => {
  const font = ok(await add('Fake Display')).font;
  ok(await add('Fake Sans'));
  ok(await theme({ heading: 'g:fake-display', body: 'g:fake-sans' }));
  const page = await hit('/site/');
  assert.equal(page.status, 200);
  const sha = font.faces.find((f) => f.subset === 'latin').sha256;
  assert.ok(page.text.includes(`@font-face{font-family:'Fake Display'`), 'the face in the head');
  assert.ok(page.text.includes(`url(/site/site-assets/fonts/g/${sha}.woff2)`), 'from the site’s root, no language');
  assert.ok(page.text.includes("--font-heading:'Fake Display', system-ui"), 'the stack');
  assert.ok(page.text.includes('--heading-weight:400'), 'its heading profile: its one weight');
  const preloads = page.text.match(/rel="preload"[^>]*as="font"/g) || [];
  assert.ok(preloads.length <= 2 && preloads.length >= 1, `${preloads.length} preloads`);
  assert.match(page.headers.get('content-security-policy'), /font-src 'self';/);
  assert.ok(!page.text.includes('fonts.googleapis') && !page.text.includes('fonts.gstatic'));
  assert.ok(!page.text.includes('data-wa-'), 'no editing markers on a public page');
  const file = await hit(`/site/site-assets/fonts/g/${sha}.woff2`);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'font/woff2');
  assert.match(file.headers.get('cache-control'), /immutable/);
  assert.equal((await hit(`/site/site-assets/fonts/g/${'f'.repeat(64)}.woff2`)).status, 404, 'an unknown file');
  // The desk's own route, signed in.
  const desk = await app.request(`/api/site/fonts/file/${sha}.woff2`, { headers: { cookie: mgr.cookie } });
  assert.equal(desk.status, 200);
  assert.match(desk.headers.get('cache-control'), /^private/);
  // Another campaign never gets this campaign's file, on its own domain.
  ok(await mgr.action('site.settings.save', { domains: ['harbour.example'] }));
  const other = new Client();
  const o = await other.signup({ workspaceName: 'Valley Example', jurisdiction: 'bc-municipal' });
  ok(await other.get('/api/site'));
  ok(await other.action('site.settings.save', { domains: ['valley.example'] }));
  forgetDomains();
  assert.equal((await hit(`/site-assets/fonts/g/${sha}.woff2`, { host: 'harbour.example' })).status, 200);
  assert.equal((await hit(`/site-assets/fonts/g/${sha}.woff2`, { host: 'valley.example' })).status, 404, 'campaign A’s hash on B’s host');
  assert.ok(o.json.workspace.id !== ws);
  // The licences page names it.
  const lic = await hit('/site/site-assets/fonts/licences');
  assert.equal(lic.status, 200);
  assert.match(lic.text, /Fake Display — SIL Open Font License 1\.1/);
});

test('readability and speed: a display font for body refused; a heavy pair refused or warned; Punjabi counted too', async () => {
  const r = await theme({ heading: 'inter', body: 'g:fake-display' });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, F.FONT_WORDS.body);
  ok(await add('Fake Serif'));
  const serif = await theme({ heading: 'inter', body: 'g:fake-serif' });
  assert.equal(serif.status, 400, 'a serif not on the reviewed list');
  assert.equal(serif.json.error, F.FONT_WORDS.body);
  const forced = await theme({ heading: 'inter', body: 'oswald' });
  assert.equal(forced.json.error, F.FONT_WORDS.body, 'a heading-only built-in too');
  await heavyRow('heavy-one', 160 * 1024);
  const heavy = await theme({ heading: 'g:heavy-one', body: 'g:heavy-one' });
  assert.equal(heavy.status, 400);
  assert.equal(heavy.json.error, F.FONT_WORDS.budget(160));
  await heavyRow('mid-one', 145 * 1024);
  const mid = ok(await theme({ heading: 'g:mid-one', body: 'g:mid-one' }));
  assert.deepEqual(mid.notes, [F.FONT_WORDS.slower(145)]);
  // With Punjabi on, the /pa first visit (the body and Gurmukhi) is counted.
  await db.query(`update site_settings set languages = jsonb_set(coalesce(languages::jsonb, '{}'::jsonb), '{on}', '["pa"]')::jsonb where workspace_id = $1`, [ws]);
  const pa = await theme({ heading: 'g:mid-one', body: 'g:mid-one' });
  assert.equal(pa.status, 400);
  assert.equal(pa.json.error, F.FONT_WORDS.budget(Math.ceil((145 * 1024 + F.FILE_BYTES[F.GURMUKHI_FILE]) / 1024)));
  await db.query(`update site_settings set languages = jsonb_set(languages::jsonb, '{on}', '[]')::jsonb where workspace_id = $1`, [ws]);
  ok(await theme({ heading: 'g:fake-display', body: 'g:fake-sans' }));
});

test('in use: refused naming where (main site, another website, the brand); Not used; remove then restore', async () => {
  let list = await fonts();
  assert.equal(list.find((f) => f.slug === 'fake-serif').notUsed, true);
  assert.equal(list.find((f) => f.slug === 'fake-display').notUsed, false);
  let r = await mgr.action('site.font.remove', { slug: 'fake-display' });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /^Fake Display is used for headings on the main site/);
  ok(await theme({ heading: 'inter', body: 'inter' }));
  // Another website.
  const m = ok(await mgr.action('site.microsite.create', { name: 'Doug Example' })).microsite;
  ok(await mgr.action('site.microsite.save', { id: m.id, theme: { fonts: { heading: 'g:fake-display', body: 'inter' } } }));
  r = await mgr.action('site.font.remove', { slug: 'fake-display' });
  assert.match(r.json.error, /^Fake Display is used for headings on Doug Example \(another website\)/);
  const heavyMicro = await mgr.action('site.microsite.save', { id: m.id, theme: { fonts: { heading: 'g:heavy-one', body: 'inter' } } });
  assert.equal(heavyMicro.status, 400, 'the same budget');
  ok(await mgr.action('site.microsite.save', { id: m.id, theme: { fonts: { heading: 'inter', body: 'inter' } } }));
  // The brand.
  const b = ok(await mgr.action('brand.save', { color: '#2f6f4f', heading: 'g:fake-display' })).brand;
  assert.equal(b.heading, 'g:fake-display');
  assert.equal(b.headingFace.family, 'Fake Display');
  r = await mgr.action('site.font.remove', { slug: 'fake-display' });
  assert.match(r.json.error, /^Fake Display is used by the campaign’s brand/);
  assert.equal((await mgr.action('brand.save', { color: '#2f6f4f', heading: 'g:no-such' })).status, 400);
  ok(await mgr.action('brand.save', { color: '#2f6f4f', heading: 'inter' }));
  // Not used now: removed, then back (Undo).
  ok(await mgr.action('site.font.remove', { slug: 'fake-display' }));
  list = await fonts();
  assert.ok(!list.some((f) => f.slug === 'fake-display'));
  ok(await mgr.action('site.font.restore', { slug: 'fake-display' }));
  assert.ok((await fonts()).some((f) => f.slug === 'fake-display'));
});

test('the brand’s heading face drawn on the desk: every face base.win ships, and an added one', async () => {
  for (const f of F.FONTS) {
    const head = brandHtml('<html><head></head><body></body></html>', brandFor({ brand: { v: 1, color: '#2f6f4f', heading: f.value } }));
    if (['inter', 'barlow-condensed', 'system', 'serif'].includes(f.value)) continue; // the desk's own fonts.css
    if (f.value === 'montserrat') { assert.ok(head.includes('montserrat-latin.woff2')); continue; }
    assert.ok(head.includes(`<style data-brand>@font-face{font-family:'${f.family}'`), f.value);
    assert.ok(head.includes(`rel="preload" as="font" type="font/woff2" href="/site-assets/${f.files.heading}"`), f.value);
  }
  const b = ok(await mgr.action('brand.save', { color: '#2f6f4f', heading: 'g:fake-display' })).brand;
  const sha = b.headingFace.files[0].sha;
  const head = brandHtml('<html><head></head><body></body></html>', brandFor({ brand: b }));
  assert.ok(head.includes(`url(/api/site/fonts/file/${sha}.woff2)`));
  assert.ok(head.includes(`href="/api/site/fonts/file/${sha}.woff2" crossorigin data-brand`));
  ok(await mgr.action('brand.save', { color: '#2f6f4f', heading: 'inter' }));
});

test('the font list: from the snapshot, never Google; body text lists only fonts checked for reading', async () => {
  fake.requests.length = 0;
  const all = ok(await mgr.get('/api/site/fonts/catalogue'));
  assert.ok(all.total > 1500, `${all.total}`);
  assert.equal(all.rows.length, 40);
  assert.ok(all.rows[0].recommended, 'recommended first');
  assert.ok(all.built);
  const body = ok(await mgr.get('/api/site/fonts/catalogue?for=body'));
  assert.equal(body.total, 66, 'the 65 and the stand-in’s Fake Sans');
  assert.ok(body.rows.every((r) => r.bodySafe));
  const q = ok(await mgr.get('/api/site/fonts/catalogue?q=fake%20disp'));
  assert.deepEqual(q.rows.map((r) => r.family), ['Fake Display']);
  assert.equal(q.rows[0].added, true);
  const serif = ok(await mgr.get('/api/site/fonts/catalogue?kind=serif&sort=az'));
  assert.ok(serif.rows.every((r) => r.kind === 'serif'));
  assert.equal(fake.requests.length, 0, 'the list never asks Google');
});

test('samples: a few letters drawn in the font, through base.win; caps', async () => {
  const get = (q) => app.request(`/api/site/fonts/sample?${q}`, { headers: { cookie: mgr.cookie } });
  const r = await get('family=Fake+Display&text=Harbour&w=400');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'font/woff2');
  assert.equal((await get(`family=Fake+Display&text=${'a'.repeat(121)}`)).status, 400);
  assert.equal((await get('family=No+Such+Font')).status, 404);
  let last = 200;
  for (let i = 0; i < 125 && last !== 429; i += 1) last = (await get(`family=Lato&text=x${i}`)).status;
  assert.equal(last, 429);
});

test('export: the rows, the files without their bytes; brought back, the files are fetched again', async () => {
  const ex = await app.request('/api/export', { headers: { cookie: mgr.cookie } });
  const data = await ex.json();
  const tables = data.tables || data;
  assert.ok(tables.site_fonts?.length >= 1, 'site_fonts exported');
  assert.ok(tables.site_font_files?.length >= 1, 'site_font_files exported');
  assert.ok(tables.site_font_files.every((f) => !('data' in f)), 'never the bytes');
  // An export brought back: the rows without their files.
  await db.query('delete from site_font_files where workspace_id = $1', [ws]);
  const list = await fonts();
  const fd = list.find((f) => f.slug === 'fake-display');
  assert.equal(fd.missing, true);
  assert.equal(fd.refetch, 'waiting');
  const queued = (await db.query("select count(*)::int as n from jobs where workspace_id = $1 and kind = 'site.font.refetch' and status = 'pending'", [ws])).rows[0].n;
  assert.ok(queued >= 1);
  await runDueJobs(db, { workspaceId: ws });
  assert.ok(!(await fonts()).find((f) => f.slug === 'fake-display').missing, 'fetched again');
  const ev = (await db.query("select payload from events where workspace_id = $1 and action = 'site.font.refetch' order by seq desc limit 1", [ws])).rows[0];
  assert.equal((typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload).by, 'import');
});
