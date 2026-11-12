// "Did on the website" (ext/webdid): a People filter — web=<kind>,
// web=campaign:<id>, web=any — read from the site server's site_actions, so
// People, Calls, a saved list, a send and a phone bank all have it. A value
// it doesn't know matches nobody; so does every value before the website's
// tables exist. Volunteers can't sort people by the money forms (join,
// donate), and the picker never offers them those. The browser's words for
// each kind are the server's.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { ensureSiteTables, siteAction, siteCampaign } from './siteactions.js';
import { WEB_KINDS, WEB_WORDS } from '../ext/webdid/words.js';

const W = await import('../../web/src/components/WebDid.js');

const tag = Math.random().toString(36).slice(2, 8);
const mail = (who) => `${who}.wd.${tag}@example.org`;
let db, mgr, vol, ws;
const P = {};
let transit;

const ok = (r) => { assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.json)); return r.json; };
const names = async (client, qs) => ok(await client.get(`/api/persons?limit=200&${qs}`)).persons.map((p) => p.name).sort();

before(async () => {
  db = await freshDb();
  mgr = new Client();
  ws = ok(await mgr.signup({ workspaceName: `Did ${tag}`, email: mail('desk'), jurisdiction: 'bc-municipal' })).workspace.id;
  const inv = ok(await mgr.action('member.invite', { email: mail('vol'), role: 'volunteer' }));
  vol = new Client();
  ok(await vol.post('/api/auth/join', { token: inv.joinUrl.split('/join/')[1], name: 'Gil Example', password: 'did-online-2026' }));
});

test('before the website: the filter matches nobody and offers nothing', async () => {
  await mgr.createPerson('Hana Example', { phone: '604-555-0120' });
  assert.deepEqual(await names(mgr, 'web=petition'), []);
  assert.deepEqual(ok(await mgr.get('/api/webdid')), { kinds: [], campaigns: [], sites: [] });
});

test('by kind, by one petition, or anything; nothing for a value it doesn’t know', async () => {
  await ensureSiteTables(db);
  transit = await siteCampaign(db, ws, { title: 'SkyTrain to Langley' });
  const other = await siteCampaign(db, ws, { title: 'Save Green Timbers' });
  P.ana = (await siteAction(db, ws, { kind: 'petition', campaignId: transit.id, person: { name: 'Ana Example', email: mail('ana'), phone: '604-555-0121' } })).personId;
  P.ben = (await siteAction(db, ws, { kind: 'petition', campaignId: other.id, person: { name: 'Ben Example', email: mail('ben'), phone: '604-555-0122' } })).personId;
  P.cy = (await siteAction(db, ws, { kind: 'donate', person: { name: 'Cy Example', email: mail('cy'), phone: '604-555-0123' } })).personId;
  P.dee = (await siteAction(db, ws, { kind: 'volunteer', person: { name: 'Dee Example', email: mail('dee') } })).personId;
  assert.deepEqual(await names(mgr, 'web=petition'), ['Ana Example', 'Ben Example']);
  assert.deepEqual(await names(mgr, `web=campaign:${transit.id}`), ['Ana Example']);
  assert.deepEqual(await names(mgr, 'web=any'), ['Ana Example', 'Ben Example', 'Cy Example', 'Dee Example']);
  assert.deepEqual(await names(mgr, 'web=donate'), ['Cy Example']);
  assert.deepEqual(await names(mgr, 'web=bake-sale'), [], 'unknown: nobody, never everybody');
  assert.deepEqual(await names(mgr, 'web=campaign:not-an-id'), []);
  // With the other filters, as one query.
  assert.deepEqual(await names(mgr, 'web=petition&has=phone&q=ben'), ['Ben Example']);
  const picker = ok(await mgr.get('/api/webdid'));
  assert.deepEqual(picker.kinds.map((k) => [k.kind, k.n]), [['petition', 2], ['volunteer', 1], ['donate', 1]]);
  assert.equal(picker.kinds[0].label, 'Signed a petition');
  assert.deepEqual(picker.campaigns.map((c) => [c.label, c.n]).sort(), [['Signed: Save Green Timbers', 1], ['Signed: SkyTrain to Langley', 1]]);
});

test('volunteers: Calls has it, never by the money forms', async () => {
  assert.deepEqual(await names(vol, 'web=petition&has=phone'), ['Ana Example', 'Ben Example']);
  assert.deepEqual(await names(vol, 'web=donate'), [], 'money: nobody');
  assert.deepEqual(await names(vol, 'web=any'), ['Ana Example', 'Ben Example', 'Dee Example'], 'anything but the money forms');
  const picker = ok(await vol.get('/api/webdid'));
  assert.ok(!picker.kinds.some((k) => k.kind === 'donate' || k.kind === 'join'));
});

test('a saved list keeps it; a text to the list and a phone bank reach the same people', async () => {
  const list = ok(await mgr.action('list.create', { name: 'SkyTrain signers', kind: 'filter', filter: { web: `campaign:${transit.id}`, junk: 'x' } })).list;
  const saved = (await db.query('select filter from lists where id = $1', [list.id])).rows[0].filter;
  assert.deepEqual(typeof saved === 'string' ? JSON.parse(saved) : saved, { web: `campaign:${transit.id}` });
  const one = ok(await mgr.get(`/api/lists/${list.id}`));
  assert.deepEqual(one.people.map((p) => p.name), ['Ana Example']);
  assert.equal(one.counts.with_phone, 1);
  // The preview a send is built from, straight from a filter.
  assert.equal(ok(await mgr.get('/api/lists/preview?web=petition')).counts.total, 2);
  // A text blast to the list: only Ana's number (texting isn't connected,
  // so it's saved, not sent).
  const blast = await mgr.action('blast.send', { kind: 'text', body: `Thanks for signing — Did ${tag}`, audience: { list_id: list.id } });
  assert.equal(blast.status, 200, JSON.stringify(blast.json));
  const to = (await db.query('select phone from blast_recipients where workspace_id = $1 and blast_id = $2', [ws, blast.json.id || blast.json.blast?.id])).rows;
  assert.deepEqual(to.map((r) => r.phone), ['+16045550121']);
});

test('the browser says each kind as the server does', () => {
  assert.deepEqual(W.WEB_KINDS, WEB_KINDS);
  for (const k of WEB_KINDS) assert.equal(W.WEB_WORDS[k], WEB_WORDS[k]);
  assert.equal(W.webLabel('petition'), 'Signed a petition');
  assert.equal(W.webLabel(`campaign:${transit.id}`, { campaigns: [{ id: transit.id, label: 'Signed: SkyTrain to Langley' }] }), 'Signed: SkyTrain to Langley');
  assert.equal(W.webLabel('any'), 'Anything');
});
