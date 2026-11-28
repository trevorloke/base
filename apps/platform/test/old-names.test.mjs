// The control centre and the older setting names (shared/old-names.js).
// Every client running today has its settings in Render under the older
// names. The control centre asks Render about both names of each setting,
// counts it as set when either is, never writes a new name onto a service
// that has the older one, writes only new names, refuses both spellings of
// what it must never touch, and lists (names only) the older names still
// set, each with the new name to use. A job row or log line saved under an
// older name is read through newNameOf().
//
// This file may name the older settings: its name has old-names in it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { OLD_SETTINGS, OLD_WORD, SECRET, newNameOf, settingNames } from '../../../shared/old-names.js';
import { IDS, fakeWorld } from './fake-render.mjs';
import { rig } from './render-rig.mjs';
import { makeRender } from '../render-api.mjs';
import { READABLE, WRITABLE_MADE, CANARY, neededFor, valueFor, settingsFor, mayGenerate } from '../render-guard.mjs';
import { DENY, envLines, envText, renderSnippet, serviceSettings } from '../snippets.mjs';
import { wordsFor } from '../words.mjs';

const flat = (s) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const OLD = new Set(Object.values(OLD_SETTINGS));
// A service's settings as a client set up before the rename has them: every
// name in the table under its older spelling, and the rest as they are.
const asOld = (settings) => {
  for (const k of Object.keys(settings)) {
    const now = newNameOf(k);
    if (!OLD_SETTINGS[now] || k === OLD_SETTINGS[now]) continue;
    settings[OLD_SETTINGS[now]] = settings[k];
    delete settings[k];
  }
  return settings;
};
// The same settings under the new names only.
const asNew = (settings) => {
  for (const k of Object.keys(settings)) {
    const now = newNameOf(k);
    if (now === k) continue;
    settings[now] = settings[k];
    delete settings[k];
  }
  return settings;
};
const forgetBoth = (settings, name) => { for (const n of settingNames(name)) delete settings[n]; };
const openGate = async (r) => {
  if (!(await r.env('sample'))?.render_service) await r.connect('sample');
  const res = await r.b.post('/render/check', {});
  assert.equal(res.status, 200);
  return flat(await res.text());
};
const NEW_CLIENT = { name: 'riverton', display: 'Riverton Forward', values: { city: 'Riverton', province: 'ON', rules: 'bc-municipal', tz: 'America/Toronto', races: ['council'], bounds: '43.6,-79.5|43.8,-79.2' } };
const madeHereCamp = { name: 'x', display: 'Example X', kind: 'client', archived_at: null, values: NEW_CLIENT.values };

test('the lists are keyed by the new names; reading asks about both; nothing secret either way', () => {
  for (const k of [...READABLE, ...WRITABLE_MADE]) assert.equal(newNameOf(k), k, `${k} is a new name`);
  assert.equal(CANARY, 'BASE_ENV');
  for (const k of READABLE) for (const n of settingNames(k)) assert.ok(!SECRET.includes(newNameOf(n)), `${n} is never read`);
  assert.ok(!READABLE.some((k) => OLD.has(k)));
});

test('a client with only the older names: the canary passes, every setting counts as set, stage 2 offers nothing, and its older names are listed with the new name to use', async () => {
  const r = await rig({ campaigns: ['sample', 'a', 'b'] });
  for (const id of [IDS.staging, IDS.a, IDS.b]) asOld(r.world.settingsOf(id));
  await r.connect('a', 'b');
  const check = await openGate(r);
  assert.doesNotMatch(check, /Not as expected/, 'staging has only the older names, and Check Render’s answers still reads one setting alone');
  r.mark();
  const page = flat((await r.page('/c/b/render')).body);
  assert.match(page, /Settings Nothing missing/, 'every setting counts as present');
  assert.doesNotMatch(page, /render\/set|Add BASE_/, 'stage 2 offers nothing');
  const asked = r.calls().filter((c) => c.includes('/env-vars/')).map((c) => c.split('/env-vars/')[1]);
  assert.deepEqual(asked.slice().sort(), neededFor({ kind: 'client', values: NEW_CLIENT.values }).flatMap(settingNames).sort(), 'both names of each, nothing else');
  assert.deepEqual(r.writes(), [], 'nothing is written');
  // The older names still set, names only, each with its new name.
  const older = Object.keys(r.world.settingsOf(IDS.b)).filter((k) => OLD.has(k) && READABLE.includes(newNameOf(k)));
  assert.ok(older.length >= 10);
  assert.match(page, /Older setting names/);
  for (const k of older) assert.match(page, new RegExp(`${k} → ${newNameOf(k)}\\b`), k);
  for (const v of ['Example B', 'Exampleton', 'America/Vancouver', 'council:City council'].map((x) => `= ${x}`)) assert.ok(!page.includes(v), 'no value is shown');
  // The board: the same list on the campaign with older names, none on a campaign with new names.
  asNew(r.world.settingsOf(IDS.a));
  const board = (await r.page('/render')).body;
  const card = (display) => flat(board.split('<li class="card oc-card">').find((c) => c.includes(`>${display}</a>`)) || '');
  assert.match(card('Example B'), /Older setting names still set/);
  for (const k of older) assert.match(card('Example B'), new RegExp(`${k} → ${newNameOf(k)}\\b`), k);
  assert.doesNotMatch(card('Example A'), /Older setting names/);
  assert.deepEqual(r.world.forbidden, []);
});

test('a client with neither name: stage 2 offers Add BASE_TZ and writes only BASE_TZ', async () => {
  const r = await rig({ campaigns: ['sample', 'a'] });
  asOld(r.world.settingsOf(IDS.a));
  forgetBoth(r.world.settingsOf(IDS.a), 'BASE_TZ');
  await r.connect('a');
  await openGate(r);
  const page = (await r.page('/c/a/render')).body;
  assert.match(page, /Missing: BASE_TZ, BASE_PLATFORM_PUBKEY/);
  assert.match(page, /<input type="hidden" name="setting" value="BASE_TZ">\s*<button class="btn btn-quiet" type="submit">Add BASE_TZ<\/button>/);
  r.mark();
  const res = await r.b.post('/c/a/render/set', { setting: 'BASE_TZ' });
  const job = /name="job" value="([0-9a-f]{32})"/.exec(await res.text())[1];
  assert.equal((await r.b.post('/c/a/render/set', { job, code: await r.code() })).status, 303);
  assert.deepEqual(r.writes().map((c) => [c.method, c.path, c.body]), [
    ['PUT', `/services/${IDS.a}/env-vars/BASE_TZ`, { value: 'America/Vancouver' }],
    ['POST', `/services/${IDS.a}/deploys`, { clearCache: 'do_not_clear' }],
  ]);
  assert.equal(r.world.settingsOf(IDS.a).BASE_TZ, 'America/Vancouver');
  assert.ok(!(OLD_SETTINGS.BASE_TZ in r.world.settingsOf(IDS.a)), 'the older name is never written');
  assert.deepEqual(r.world.forbidden, []);
});

test('the older name alone is set: nothing is added, and a press anyway writes nothing', async () => {
  const r = await rig({ campaigns: ['sample', 'a'] });
  const mine = asOld(r.world.settingsOf(IDS.a));
  forgetBoth(mine, 'BASE_CITY');
  await r.connect('a');
  await openGate(r);
  const asked = await r.b.post('/c/a/render/set', { setting: 'BASE_CITY' });
  const job = /name="job" value="([0-9a-f]{32})"/.exec(await asked.text())[1];
  mine[OLD_SETTINGS.BASE_CITY] = 'Set by hand under the older name';
  r.mark();
  const done = await r.b.post('/c/a/render/set', { job, code: await r.code() });
  assert.equal(done.status, 409);
  assert.match(flat(await done.text()), /BASE_CITY is already set on base-win-a\. Nothing was changed\./);
  assert.deepEqual(r.writes(), [], 'no new name is written onto a service that has the older one');
  assert.ok(!('BASE_CITY' in mine));
  assert.equal(mine[OLD_SETTINGS.BASE_CITY], 'Set by hand under the older name');
  assert.deepEqual(r.world.forbidden, []);
});

test('a job row saved under an older name runs as the new name; an older name typed in the form is read as the new one', async () => {
  const r = await rig({ campaigns: ['sample', 'a'] });
  forgetBoth(r.world.settingsOf(IDS.a), 'BASE_TZ');
  await r.connect('a');
  await openGate(r);
  const res = await r.b.post('/c/a/render/set', { setting: 'BASE_TZ' });
  const job = /name="job" value="([0-9a-f]{32})"/.exec(await res.text())[1];
  // As an older release would have saved it.
  await r.db.query("update render_jobs set detail = jsonb_set(detail, '{setting}', to_jsonb($2::text)) where id = $1", [job, OLD_SETTINGS.BASE_TZ]);
  r.mark();
  assert.equal((await r.b.post('/c/a/render/set', { job, code: await r.code() })).status, 303);
  assert.deepEqual(r.writes().map((c) => `${c.method} ${c.path}`), [`PUT /services/${IDS.a}/env-vars/BASE_TZ`, `POST /services/${IDS.a}/deploys`]);
  const start = (await r.log('render.start')).at(-1);
  assert.equal(start.payload.setting, 'BASE_TZ', 'the log line names the new name');
  assert.equal(wordsFor('render.start', start.payload), 'Asked Render to add BASE_TZ');
  // The form, from a page an older release drew.
  forgetBoth(r.world.settingsOf(IDS.a), 'BASE_CITY');
  const asked = flat(await (await r.b.post('/c/a/render/set', { setting: OLD_SETTINGS.BASE_CITY })).text());
  assert.match(asked, /Adds BASE_CITY = Exampleton to base-win-a/);
  assert.ok(!asked.includes(OLD_SETTINGS.BASE_CITY));
  assert.deepEqual(r.world.forbidden, []);
});

test('log lines sealed under an older name read with the new name', () => {
  assert.equal(wordsFor('render.start', { what: 'set', setting: OLD_SETTINGS.BASE_TZ }), 'Asked Render to add BASE_TZ');
  assert.equal(wordsFor('render.start', { what: 'set', setting: 'BASE_TZ' }), 'Asked Render to add BASE_TZ');
});

test('DENY refuses both spellings, and neither is in anything made for a new client', () => {
  for (const name of ['BASE_DEMO_EMAIL', OLD_SETTINGS.BASE_DEMO_EMAIL, 'BASE_SAMPLE', OLD_SETTINGS.BASE_SAMPLE, 'BASE_SAMPLE_RESET', OLD_SETTINGS.BASE_SAMPLE_RESET,
    'BASE_FRAME_HOSTS', OLD_SETTINGS.BASE_FRAME_HOSTS]) {
    assert.ok(DENY.includes(name), name);
    assert.equal(valueFor(madeHereCamp, name, { stage2: true }), null, name);
  }
  const all = [envText(NEW_CLIENT), renderSnippet(NEW_CLIENT), JSON.stringify(serviceSettings(NEW_CLIENT)), JSON.stringify(settingsFor(madeHereCamp))].join('\n');
  for (const name of DENY) assert.ok(!new RegExp(`\\b${name}\\b`).test(all), name);
});

test('a new client’s settings hold no older name', () => {
  const keys = [
    ...envLines(NEW_CLIENT).map((l) => l.key),
    ...serviceSettings(NEW_CLIENT).map((l) => l.key),
    ...settingsFor(madeHereCamp).map((l) => l.key),
    ...[...renderSnippet(NEW_CLIENT).matchAll(/- key: ([A-Z0-9_]+)/g)].map((m) => m[1]),
  ];
  assert.ok(keys.length > 40);
  for (const k of keys) {
    assert.ok(!OLD.has(k), `${k} is an older name`);
    assert.equal(newNameOf(k), k);
  }
  const text = [envText(NEW_CLIENT), renderSnippet(NEW_CLIENT)].join('\n').toLowerCase();
  assert.ok(!text.includes(OLD_WORD));
  for (const k of ['BASE_ENV', 'BASE_PUBLIC_URL', 'BASE_TZ', 'BASE_TWO_STEP_KEY']) assert.ok(keys.includes(k), k);
});

test('Render makes only the two random keys, by their new names, and only for a service being made', () => {
  assert.equal(mayGenerate('BASE_TWO_STEP_KEY'), true);
  assert.equal(mayGenerate('GOOGLE_TOKEN_KEY'), true);
  for (const k of [OLD_SETTINGS.BASE_TWO_STEP_KEY, 'BASE_PLATFORM_PUBKEY', 'BASE_TZ', 'DATABASE_URL', 'RENDER_API_KEY', '']) assert.equal(mayGenerate(k), false, k || 'nothing');
  const made = settingsFor(madeHereCamp).filter((e) => e.generateValue).map((e) => e.key);
  assert.deepEqual(made.sort(), ['BASE_TWO_STEP_KEY', 'GOOGLE_TOKEN_KEY']);
  assert.equal(settingsFor({ ...madeHereCamp, values: {} }), null, 'not on a campaign added as already running');
  assert.equal(settingsFor({ ...madeHereCamp, kind: 'sample' }), null, 'not on the sample');
});

test('isSet: either name counts, the older one is said, a failed read of either fails, and only new names are ever written', async () => {
  const w = fakeWorld();
  const mine = asOld(w.settingsOf(IDS.a));
  const c = makeRender({ send: w.send, cacheMs: 0 });
  assert.deepEqual(await c.isSet(IDS.a, 'BASE_TZ'), { ok: true, set: true, older: true });
  assert.deepEqual(w.calls.slice(-2).map((x) => x.path), [`/services/${IDS.a}/env-vars/BASE_TZ`, `/services/${IDS.a}/env-vars/${OLD_SETTINGS.BASE_TZ}`]);
  assert.deepEqual(await c.isSet(IDS.a, OLD_SETTINGS.BASE_TZ), { ok: true, set: true, older: true }, 'asked by the older name: the same question');
  asNew(mine);
  assert.deepEqual(await c.isSet(IDS.a, 'BASE_TZ'), { ok: true, set: true });
  forgetBoth(mine, 'BASE_TZ');
  assert.deepEqual(await c.isSet(IDS.a, 'BASE_TZ'), { ok: true, set: false });
  // Not on the table: asked once.
  const before = w.calls.length;
  assert.deepEqual(await c.isSet(IDS.a, 'BASE_PLATFORM_PUBKEY'), { ok: true, set: false });
  assert.equal(w.calls.length, before + 1);
  w.refuse(503, { on: new RegExp(`env-vars/${OLD_SETTINGS.BASE_CITY}$`) });
  assert.equal((await c.isSet(IDS.a, 'BASE_CITY')).ok, false, 'one name unread: not known');
  for (const k of [OLD_SETTINGS.BASE_TWO_STEP_KEY, 'BASE_TWO_STEP_KEY', OLD_SETTINGS.BASE_SAMPLE, 'DATABASE_URL']) assert.equal((await c.isSet(IDS.a, k)).problem, 'not-allowed', k);
  assert.deepEqual(w.forbidden, []);
});

test('nothing in the control centre says the old word, apart from this file', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  let out = '';
  try {
    out = execFileSync('git', ['grep', '-il', OLD_WORD, '--', 'apps/platform'], { cwd: root, encoding: 'utf8' });
  } catch (e) {
    if (e.status !== 1) throw e; // 1: nothing found
  }
  const files = out.split('\n').filter(Boolean).filter((f) => !/old-names/.test(f.split('/').pop()));
  assert.deepEqual(files, []);
});

// The setting names are not part of what Check Render’s answers compares
// for making (MAKE_SHAPES): this release leaves stage 2 as it was, open or
// shut, and the names are checked here instead.
test('stage 2’s gate is unchanged by the new names', () => {
  const c = makeRender({ key: `rnd_${'x'.repeat(30)}`, send: async () => ({ status: 500 }) });
  assert.equal(c.makeShapes, '79e3b9b59a5a4d03', 'the same as before the rename');
});
