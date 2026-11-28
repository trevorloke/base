// The unsubscribe link to a campaign's own website (server/ext/intake/website.js)
// under the older setting names: a server whose website settings still have
// their older names sends exactly what it sends today — the same address and
// path, the Bearer key, the headers, the bytes, the same Idempotency-Key on a
// retry. With both names set, the new ones win. On staging, or once the
// website has moved onto base.win, nothing is sent under either name.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { runDueJobs } from '../lib/jobs.js';
import { _resetPaceForTest } from '../ext/intake/outbound.js';
import { websiteState } from '../ext/intake/website.js';
import { startFakeWebsite } from './fake-website.js';
import { OLD_SETTINGS, settingNames } from '../../shared/old-names.js';

const tag = Math.random().toString(36).slice(2, 8);
const mail = (who) => `${who}.on.${tag}@example.org`;
const OLD_KEY = `riverbend-website-key-old-${tag}-${'x'.repeat(12)}`;
const NEW_KEY = `riverbend-website-key-new-${tag}-${'y'.repeat(12)}`;
const old = (k) => OLD_SETTINGS[k];
const NAMES = ['BASE_WEBSITE_URL', 'BASE_WEBSITE_KEY', 'BASE_PUBLIC_URL', 'BASE_OWN_URL', 'BASE_ENV', 'BASE_SITE_DOMAIN'].flatMap(settingNames);
const KEYS = [...NAMES, 'RENDER_EXTERNAL_URL', 'SITE_HOSTS'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const only = (values) => { for (const k of KEYS) delete process.env[k]; Object.assign(process.env, values); };

let db, site, other, mgr, ws;
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
const subOf = async (email) => (await db.query('select id from subscriptions where workspace_id = $1 and email = $2', [ws, email])).rows[0];
const jobs = async () => (await db.query(
  "select status, payload from jobs where workspace_id = $1 and kind = 'website.consent' order by created_at, id", [ws],
)).rows.map((r) => ({ ...r, payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload }));
const clearQueue = () => db.query("delete from jobs where workspace_id = $1 and kind in ('website.consent', 'website.backfill')", [ws]);
const runOnce = async () => { await db.query("update jobs set run_at = now() where workspace_id = $1 and status = 'pending'", [ws]); _resetPaceForTest(); return runDueJobs(db, { workspaceId: ws }); };
// Someone comes off the list in the desk: one no for the website.
const unsubscribe = async (who) => {
  await mgr.createPerson(`${who} Example`, { email: mail(who) });
  ok(await mgr.action('subscription.add', { email: mail(who), name: `${who} Example` }));
  ok(await mgr.action('subscription.remove', { id: (await subOf(mail(who))).id }));
};

before(async () => {
  db = await freshDb();
  site = await startFakeWebsite({ key: OLD_KEY });
  other = await startFakeWebsite({ key: NEW_KEY });
  only({});
  mgr = new Client();
  const r = await mgr.signup({ workspaceName: `Riverbend ${tag}`, email: mail('mgr'), jurisdiction: 'bc-municipal' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  ws = r.json.workspace.id;
  ok(await mgr.action('intake.key.create', { name: 'Website' }));
});
after(async () => {
  await site.close();
  await other.close();
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

test('only the older names: an unsubscribe reaches the website with the older key, the same path, headers and bytes; a retry is the same Idempotency-Key', async () => {
  only({ [old('BASE_WEBSITE_URL')]: site.url, [old('BASE_WEBSITE_KEY')]: OLD_KEY, [old('BASE_PUBLIC_URL')]: 'https://riverbend.example.org' });
  site.reset();
  await clearQueue();
  assert.equal(websiteState().on, true, 'on, from the older names');
  await unsubscribe('older');
  const [job] = await jobs();
  const item = job.payload.items[0];
  site.fail(503);
  assert.deepEqual(await runOnce(), { ran: 0, failed: 0 }, 'the website is down: it waits');
  site.fail(false);
  assert.deepEqual(await runOnce(), { ran: 1, failed: 0 });
  assert.equal(site.calls.length, 2);
  const [first, second] = site.calls;
  assert.deepEqual([first.method, first.path, first.auth, first.type, first.key], ['POST', '/api/in/consent', `Bearer ${OLD_KEY}`, 'application/json', item.id]);
  assert.equal(first.raw, `{"action":"withdraw","at":"${item.at}","channel":"email","email":"${mail('older')}","reason":"unsubscribe"}`);
  assert.deepEqual([second.key, second.raw, second.auth], [first.key, first.raw, first.auth], 'the retry: the same key, bytes and Bearer');
  assert.deepEqual(site.ledger.map((x) => x.email), [mail('older')], 'taken once');
});

test('both names: the new address and key win', async () => {
  only({
    [old('BASE_WEBSITE_URL')]: site.url, [old('BASE_WEBSITE_KEY')]: OLD_KEY,
    BASE_WEBSITE_URL: other.url, BASE_WEBSITE_KEY: NEW_KEY, BASE_PUBLIC_URL: 'https://riverbend.example.org',
  });
  site.reset();
  other.reset();
  await clearQueue();
  await unsubscribe('newer');
  assert.deepEqual(await runOnce(), { ran: 1, failed: 0 });
  assert.equal(site.calls.length, 0, 'nothing to the address under the older name');
  assert.deepEqual(other.calls.map((c) => [c.path, c.auth]), [['/api/in/consent', `Bearer ${NEW_KEY}`]]);
  assert.deepEqual(other.ledger.map((x) => x.email), [mail('newer')]);
});

test('a blank new name is not set: the older value is used', async () => {
  only({ BASE_WEBSITE_URL: ' ', BASE_WEBSITE_KEY: '', [old('BASE_WEBSITE_URL')]: site.url, [old('BASE_WEBSITE_KEY')]: OLD_KEY });
  const s = websiteState();
  assert.equal(s.on, true);
  assert.equal(s.target, `${site.url}/api/in/consent`);
});

test('on staging, or with the website moved onto base.win, nothing is sent under either name', async () => {
  const quiet = async (why, values, problem) => {
    only({ [old('BASE_WEBSITE_URL')]: site.url, [old('BASE_WEBSITE_KEY')]: OLD_KEY, ...values });
    site.reset();
    await clearQueue();
    assert.equal(websiteState().problem, problem, why);
    await unsubscribe(`quiet-${problem}-${Object.keys(values).join('-').toLowerCase()}`);
    assert.deepEqual(await jobs(), [], `${why}: nothing queued`);
    await runOnce();
    assert.equal(site.calls.length, 0, `${why}: no call`);
  };
  await quiet('staging, older name', { [old('BASE_ENV')]: 'staging' }, 'staging');
  await quiet('staging, new name', { BASE_ENV: 'staging' }, 'staging');
  // The website's own domain now served here: its address is one of this server's website hosts.
  const theWebsite = { [old('BASE_WEBSITE_URL')]: 'https://www.riverbend.example' };
  await quiet('moved, older name', { ...theWebsite, [old('BASE_SITE_DOMAIN')]: 'riverbend.example' }, 'moved');
  await quiet('moved, new name', { ...theWebsite, BASE_SITE_DOMAIN: 'riverbend.example' }, 'moved');
});
