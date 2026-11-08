// Brand (ext/brand, lib/brand.js, shared/brand.js, shared/contrast.js): the
// contrast maths, the presets and their tokens, who may read and save the
// brand, what a save checks (hex colours, presets, fonts, corners, logos,
// low contrast), the event log, pre-configuration from the settings, the
// <style> index.html carries, and the public pages in the brand.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';
import { getDb } from '../db/client.js';
import { contrast, luminance, mix, ensure, parseHex, normHex, ratioText, readableOn, AA, AAA } from '@base-ground/shared/contrast';
import {
  PRESETS, PRESET_KEYS, FONTS, CORNERS, COLOR_KEYS, brandOf, tokens, brandCss, checks, failing, validBrandInput, presetBrand,
} from '@base-ground/shared/brand';
import { brandHead, publicBrand, settingsBrand, effectiveBrand, forgetBrandCache } from '../lib/brand.js';
import { page as publicPage } from '../lib/publicpage.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const tokenOf = (url) => url.split('/join/')[1];
const ENV = ['BASE_BRAND_PRESET', 'BASE_BRAND_NAME', 'BASE_BRAND_LOGO', 'BASE_BRAND_PRIMARY', 'BASE_BRAND_ACCENT', 'BASE_BRAND_SURFACE',
  'BASE_BRAND_INK', 'BASE_BRAND_ON_PRIMARY', 'BASE_BRAND_ON_ACCENT', 'BASE_BRAND_FONT', 'BASE_BRAND_CORNERS'];
const clearEnv = () => { for (const k of ENV) delete process.env[k]; };

let mgr, staff, vol, other;
const joinAs = async (role, name) => {
  const inv = await mgr.action('member.invite', { email: `${name}.brand@example.org`, role });
  const cl = new Client();
  const r = await cl.post('/api/auth/join', { token: tokenOf(inv.json.joinUrl), name, password: 'brand-pass-2026' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return cl;
};
const save = (cl, over = {}) => cl.action('brand.save', { ...presetBrand('ground'), name: null, logo: null, ...over });
const events = async (action) => {
  const db = await getDb();
  return (await db.query('select * from events where action = $1 order by seq', [action])).rows
    .map((e) => ({ ...e, payload: typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload }));
};

before(async () => {
  clearEnv();
  await freshDb();
  mgr = new Client();
  await mgr.signup({ workspaceName: 'Imagine Surrey', email: 'mgr.brand@example.org', jurisdiction: 'bc-municipal' });
  staff = await joinAs('staff', 'Sam');
  vol = await joinAs('volunteer', 'Vic');
  other = new Client();
  await other.signup({ workspaceName: 'Another Campaign', email: 'other.brand@example.org' });
});

// ── The maths ──

test('contrast: the WCAG ratios — black on white is 21, a colour on itself 1, order does not matter', () => {
  assert.equal(contrast('#000000', '#ffffff'), 21);
  assert.equal(contrast('#ffffff', '#000000'), 21);
  assert.equal(contrast('#336699', '#336699'), 1);
  assert.equal(luminance('#ffffff'), 1);
  assert.equal(luminance('#000000'), 0);
  // The textbook pairs: #767676 is the lightest grey that passes 4.5 on white; #777 just fails.
  assert.ok(contrast('#767676', '#ffffff') >= 4.5);
  assert.ok(contrast('#777777', '#ffffff') < 4.5);
  assert.equal(ratioText(contrast('#777777', '#ffffff')), '4.47:1', 'rounded down, never up to a pass');
  assert.equal(Math.round(contrast('#595959', '#ffffff') * 100) / 100, 7, '#595959 is 7:1 on white');
  assert.ok(Number.isNaN(contrast('red', '#ffffff')), 'not a hex colour: no ratio');
});

test('contrast: hex parsing, mixing, pushing a colour until it reads', () => {
  assert.deepEqual(parseHex('#abc'), { r: 0xaa, g: 0xbb, b: 0xcc });
  assert.equal(normHex('ABCDEF'), '#abcdef');
  assert.equal(parseHex('#12345'), null);
  assert.equal(parseHex('javascript:alert(1)'), null);
  assert.equal(mix('#000000', '#ffffff', 0.5), '#808080');
  assert.equal(mix('#102030', '#ffffff', 0), '#102030');
  assert.equal(mix('#102030', '#ffffff', 1), '#ffffff');
  const pushed = ensure('#bbbbbb', ['#ffffff', '#f6f3ea'], AA, '#111111');
  assert.ok(contrast(pushed, '#ffffff') >= AA && contrast(pushed, '#f6f3ea') >= AA, 'pushed until it reads on both');
  assert.equal(ensure('#111111', '#ffffff', AA, '#000000'), '#111111', 'already reads: left alone');
  assert.equal(readableOn('#ffb000'), '#111111');
  assert.equal(readableOn('#17462b'), '#ffffff');
});

// ── Presets and tokens ──

test('presets: Ground is the default; every preset passes every contrast line, field body text at 7:1', () => {
  assert.equal(brandOf({}).preset, 'ground');
  assert.ok(PRESET_KEYS.length >= 4);
  assert.deepEqual(PRESET_KEYS.slice(0, 1), ['ground']);
  for (const key of PRESET_KEYS) {
    const bad = failing({ preset: key });
    assert.deepEqual(bad.map((c) => `${c.key} ${ratioText(c.ratio)}`), [], `${key} passes`);
    const field = checks({ preset: key }).filter((c) => c.field);
    assert.ok(field.length >= 2 && field.every((c) => c.min === AAA && c.ratio >= AAA), `${key}: body text 7:1`);
    assert.ok(FONTS[PRESETS[key].font] && CORNERS[PRESETS[key].corners]);
  }
  // Distinct by design: Ground is green and amber on warm off-white, light.
  const g = PRESETS.ground;
  const { r, g: gr, b } = parseHex(g.primary);
  assert.ok(gr > r && gr > b, 'a green primary');
  assert.ok(luminance(g.surface) > 0.85, 'a light surface');
  assert.equal(tokens({ preset: 'night' })['color-scheme'], 'dark', 'Night is the dark one');
});

test('tokens: every token the app reads, from the brand; quiet text and links pushed to read', () => {
  const t = tokens({ preset: 'ground' });
  for (const k of ['--paper', '--paper-0', '--paper-1', '--paper-2', '--ink', '--text-2', '--text-3', '--rule', '--rule-2', '--mark', '--mark-ink',
    '--mark-deep', '--mark-soft', '--accent', '--accent-ink', '--link', '--focus', '--nav-bg', '--nav-ink', '--nav-quiet', '--nav-active',
    '--nav-spark', '--ok', '--warn', '--danger', '--font-sans', '--font-display', '--r-ctrl', '--r-card', '--r-btn', '--shadow-1', '--shadow-2']) {
    assert.ok(t[k], `${k} is set`);
  }
  // A pale primary still gives readable links and a visible focus ring.
  const pale = tokens({ preset: 'ground', primary: '#a8e6c0' });
  assert.ok(contrast(pale['--link'], pale['--paper-0']) >= AA);
  assert.ok(contrast(pale['--focus'], pale['--paper']) >= 3);
  assert.equal(tokens({ corners: 'round' })['--r-btn'], '999px');
  assert.match(tokens({ font: 'source-serif' })['--font-display'], /Source Serif 4/);
  const css = brandCss({ preset: 'harvest' }, 'html:root');
  assert.match(css, /^html:root\{--font-sans:/);
  assert.ok(!/[<>]/.test(css), 'nothing that could close the <style>');
});

test('the app\'s stylesheet starts in the Ground preset: its :root defaults are tokens(ground)', () => {
  const css = readFileSync(new URL('../../web/src/app.css', import.meta.url), 'utf8');
  const root = css.match(/:root\s*\{([\s\S]*?)\n\}/)[1];
  const t = tokens({ preset: 'ground' });
  for (const [k, v] of Object.entries(t)) {
    if (k === 'color-scheme') continue;
    const m = root.match(new RegExp(`\\n\\s*${k.replace(/-/g, '\\-')}:\\s*([^;]+);`));
    assert.ok(m, `${k} is in app.css :root`);
    assert.equal(m[1].trim(), v, `${k} matches the Ground preset`);
  }
});

test('brandOf and validBrandInput: a whole brand from a partial one; bad values named', () => {
  const b = brandOf({ preset: 'civic', primary: '#ABCDEF', accent: 'red', font: 'comic-sans', name: '  Imagine Surrey  ', logo: 'javascript:alert(1)' });
  assert.equal(b.primary, '#abcdef');
  assert.equal(b.accent, PRESETS.civic.accent, 'not a hex colour: the preset’s');
  assert.equal(b.font, PRESETS.civic.font);
  assert.equal(b.name, 'Imagine Surrey');
  assert.equal(b.logo, null);
  assert.equal(validBrandInput({ primary: '#12345g' }), 'Primary: a colour like #1f4d2e');
  assert.match(validBrandInput({ preset: 'neon' }), /^preset: one of ground/);
  assert.match(validBrandInput({ corners: 'blobby' }), /^corners:/);
  assert.match(validBrandInput({ logo: 'http://example.org/x.png' }), /^logo:/, 'https only');
  assert.match(validBrandInput({ logo: 'https://example.org/x.png" onerror="alert(1)' }), /^logo:/);
  assert.equal(validBrandInput({ logo: 'https://cdn.example.org/logo.png' }), null);
  assert.equal(validBrandInput({ logo: '/media/0b6f1f3e-6a59-4c5a-9a1b-2f8f0c1d2e3f' }), null);
  assert.equal(validBrandInput(presetBrand('night')), null);
});

// ── The API ──

test('GET /api/brand: anyone signed in reads the brand in force (Ground until anything is set); managers see more', async () => {
  for (const cl of [mgr, staff, vol]) {
    const r = await cl.get('/api/brand');
    assert.equal(r.status, 200);
    assert.equal(r.json.source, 'default');
    assert.equal(r.json.brand.preset, 'ground');
    assert.equal(r.json.name, 'Imagine Surrey', 'the campaign’s own name until one is set');
    assert.ok(Array.isArray(r.json.checks) && r.json.checks.every((c) => c.ok));
  }
  assert.ok('preconfigured' in (await mgr.get('/api/brand')).json);
  assert.ok(!('updatedBy' in (await vol.get('/api/brand')).json), 'who changed it: managers only');
  assert.equal((await new Client().get('/api/brand')).status, 401);
});

test('brand.save: managers only — not staff, not a volunteer, not someone given the Admin area', async () => {
  assert.equal((await save(staff)).status, 403);
  assert.equal((await save(vol)).status, 403);
  // A volunteer given the Admin area still may not change the brand.
  const vic = (await mgr.get('/api/admin/permissions')).json.members.find((m) => m.name === 'Vic');
  assert.equal((await mgr.action('permission.member.set', { user_id: vic.id, grant: ['admin'], deny: [] })).status, 200);
  assert.equal((await save(vol)).status, 403);
  assert.equal((await mgr.action('permission.member.set', { user_id: vic.id, grant: [], deny: [] })).status, 200);
  assert.equal((await save(staff, { preset: 'night' })).status, 403);
  assert.equal((await mgr.get('/api/brand')).json.source, 'default', 'nothing saved');
  assert.equal((await staff.action('brand.clear', {})).status, 403);
});

test('brand.save: hex colours, presets, fonts, corners and names are checked', async () => {
  const bad = [
    [{ primary: 'green' }, /primary/],
    [{ primary: '#12345' }, /primary/],
    [{ onAccent: '#zzzzzz' }, /onAccent/],
    [{ preset: 'neon' }, /preset/],
    [{ font: 'papyrus' }, /font/],
    [{ corners: 'wavy' }, /corners/],
    [{ name: 'x'.repeat(61) }, /name/],
    [{ logo: 'http://example.org/logo.png' }, /logo/],
    [{ logo: '/media/../../etc/passwd' }, /logo/],
  ];
  for (const [over, re] of bad) {
    const r = await save(mgr, over);
    assert.equal(r.status, 400, JSON.stringify(over));
    assert.match(r.json.error, re);
  }
});

test('brand.save: a pair under its line is refused until the manager confirms; then saved and on the log', async () => {
  // Pale amber text on white buttons: 1.6:1.
  const low = { primary: '#ffd866', onPrimary: '#ffffff' };
  const refused = await save(mgr, low);
  assert.equal(refused.status, 409);
  assert.match(refused.json.error, /Text on primary: buttons 1\.\d\d:1 \(needs 4\.5:1\)/);
  assert.equal((await mgr.get('/api/brand')).json.source, 'default', 'nothing saved');
  // Field body text needs 7:1, not 4.5: a mid-grey ink that passes AA alone is still refused.
  const grey = await save(mgr, { ink: '#5f6360' });
  assert.equal(grey.status, 409);
  assert.match(grey.json.error, /Body text on the page \(field screens\) .* \(needs 7:1\)/);

  const ok = await save(mgr, { ...low, confirmLowContrast: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.brand.primary, '#ffd866');
  assert.ok(ok.json.checks.some((c) => c.key === 'primary' && !c.ok));
  const ev = (await events('brand.save')).at(-1);
  assert.equal(ev.entity_type, 'workspace');
  assert.equal(ev.op, 'update');
  assert.equal(ev.payload.brand.primary, '#ffd866');
  assert.ok(ev.payload.lowContrast.includes('primary') && ev.payload.lowContrast.includes('nav'), 'the pairs saved under their line: buttons and the top bar');
  assert.ok(ev.actor_id, 'who saved it');
});

test('brand.save: a manager saves a brand; everyone reads it; the log has it; the other campaign is untouched', async () => {
  const r = await save(mgr, { preset: 'harvest', ...presetBrand('harvest'), name: 'Imagine Surrey 2026', logo: 'https://cdn.example.org/is.png' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  for (const cl of [mgr, staff, vol]) {
    const g = (await cl.get('/api/brand')).json;
    assert.equal(g.source, 'saved');
    assert.equal(g.brand.preset, 'harvest');
    assert.equal(g.brand.primary, PRESETS.harvest.primary);
    assert.equal(g.name, 'Imagine Surrey 2026');
    assert.equal(g.brand.logo, 'https://cdn.example.org/is.png');
  }
  const m = (await mgr.get('/api/brand')).json;
  assert.equal(m.updatedBy, 'Avery Chen');
  assert.ok(m.updatedAt);
  const ev = (await events('brand.save')).at(-1);
  assert.equal(ev.payload.brand.preset, 'harvest');
  assert.equal(ev.payload.brand.name, 'Imagine Surrey 2026');
  assert.equal(ev.payload.lowContrast, undefined);
  assert.equal((await other.get('/api/brand')).json.source, 'default', 'another workspace keeps its own');
  // The chain still verifies with the brand on it.
  const audit = await mgr.get('/api/audit/verify');
  assert.equal(audit.status, 200);
  assert.equal(audit.json.ok, true);
});

test('brand.save: a logo is an upload of this campaign’s, never another’s', async () => {
  const up = await mgr.action('blast.picture', { data: PNG, name: 'logo.png', width: 1, height: 1 });
  assert.equal(up.status, 200);
  const mine = await save(mgr, { logo: up.json.media.url });
  assert.equal(mine.status, 200, JSON.stringify(mine.json));
  assert.equal(mine.json.brand.logo, up.json.media.url);
  const theirs = await other.action('blast.picture', { data: PNG, name: 'theirs.png', width: 1, height: 1 });
  const r = await save(mgr, { logo: theirs.json.media.url });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /this campaign’s uploads/);
});

test('index.html\'s <style>: the saved brand, at once after a save; escaped name and logo', async () => {
  forgetBrandCache();
  const db = await getDb();
  await save(mgr, { ...presetBrand('civic'), name: 'Imagine <Surrey> & "Co"' });
  const head = await brandHead(db);
  assert.match(head, /^<style id="base-brand" data-name="Imagine &lt;Surrey&gt; &amp; &quot;Co&quot;" data-logo="" data-theme="#003979">html:root\{/);
  assert.ok(head.includes(`--mark:${PRESETS.civic.primary}`));
  assert.ok(head.endsWith('</style>'));
  await save(mgr, presetBrand('night'));
  assert.ok((await brandHead(db)).includes(`--mark:${PRESETS.night.primary}`), 'the save forgot the kept copy');
  assert.match(await brandHead(db), /color-scheme:dark/);
});

test('brand.clear: back to the pre-configured brand, on the log', async () => {
  const r = await mgr.action('brand.clear', {});
  assert.equal(r.status, 200);
  assert.equal(r.json.source, 'default');
  assert.equal((await mgr.get('/api/brand')).json.brand.preset, 'ground');
  assert.equal((await events('brand.clear')).at(-1).payload.brand, null);
});

test('pre-configuration: BASE_BRAND_* seed the brand until a manager saves; invalid settings are ignored', async () => {
  try {
    process.env.BASE_BRAND_PRESET = 'Night';
    process.env.BASE_BRAND_PRIMARY = '2f9e6a'; // '#' optional
    process.env.BASE_BRAND_ACCENT = 'orange'; // ignored
    process.env.BASE_BRAND_NAME = 'Surrey Forward';
    process.env.BASE_BRAND_CORNERS = 'sharp';
    process.env.BASE_BRAND_FONT = 'papyrus'; // ignored
    assert.deepEqual(settingsBrand(), { preset: 'night', name: 'Surrey Forward', primary: '#2f9e6a', accent: 'orange', font: 'papyrus', corners: 'sharp' });
    const g = (await mgr.get('/api/brand')).json;
    assert.equal(g.source, 'settings');
    assert.equal(g.brand.preset, 'night');
    assert.equal(g.brand.primary, '#2f9e6a');
    assert.equal(g.brand.accent, PRESETS.night.accent, 'an invalid colour: the preset’s');
    assert.equal(g.brand.font, PRESETS.night.font);
    assert.equal(g.brand.corners, 'sharp');
    assert.equal(g.name, 'Surrey Forward');
    assert.equal(g.preconfigured.primary, '#2f9e6a', 'managers see what the settings make');
    forgetBrandCache();
    assert.ok((await brandHead(await getDb())).includes('--mark:#2f9e6a'), 'index.html carries the seeded brand');
    assert.equal(effectiveBrand(null).preset, 'night');

    // A manager saves: the saved brand wins over the settings.
    assert.equal((await save(mgr, presetBrand('harvest'))).status, 200);
    const after = (await mgr.get('/api/brand')).json;
    assert.equal(after.source, 'saved');
    assert.equal(after.brand.preset, 'harvest');
    assert.ok((await brandHead(await getDb())).includes(`--mark:${PRESETS.harvest.primary}`));
    // Cleared: the settings again.
    await mgr.action('brand.clear', {});
    assert.equal((await mgr.get('/api/brand')).json.source, 'settings');
  } finally {
    clearEnv();
    forgetBrandCache();
  }
});

test('public pages: the unsubscribe page and the shared look carry the brand’s colours, name and logo', async () => {
  await save(mgr, { ...presetBrand('civic'), name: 'Imagine Surrey', logo: 'https://cdn.example.org/is.png' });
  const s = await mgr.action('subscription.add', { email: 'brand.reader@example.org', name: 'Reader' });
  assert.equal(s.status, 200, JSON.stringify(s.json));
  const subs = (await mgr.get('/api/subscriptions')).json.subscriptions;
  const sub = subs.find((x) => x.email === 'brand.reader@example.org');
  const res = await app.request(`/u/${sub.id}`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes(`--mark:${PRESETS.civic.primary}`), 'the brand’s primary on the button');
  assert.ok(html.includes(`--mark-ink:${PRESETS.civic.onPrimary}`));
  assert.match(html, /<img class="camp-logo" src="https:\/\/cdn\.example\.org\/is\.png"/);
  assert.match(html, /Unsubscribe from Imagine Surrey\?/);

  // A workspace with no saved brand: Ground's colours, its own name.
  const pb = publicBrand({ name: 'Somewhere Else', brand: null });
  assert.equal(pb.name, 'Somewhere Else');
  assert.ok(pb.css.includes(`--mark:${PRESETS.ground.primary}`));
  const plain = publicPage({ name: 'Somewhere Else', settings: {} }, 'Hello', '<p>hi</p>');
  assert.ok(plain.includes(`--paper:${PRESETS.ground.surface}`));
  assert.match(plain, /<div class="camp"><span>Somewhere Else<\/span><\/div>/);
});

test('every colour key is checked by the action', () => {
  assert.deepEqual(COLOR_KEYS, ['primary', 'accent', 'surface', 'ink', 'onPrimary', 'onAccent']);
});
