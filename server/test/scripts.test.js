// Scripts (ext/scripts): one for the door, one for the phone, saved at the
// desk, read by everyone; an empty one takes it away; on the books.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';

const tag = Math.random().toString(36).slice(2, 8);
let mgr, vol, volId;
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };

before(async () => {
  await freshDb();
  mgr = new Client();
  await mgr.signup({ workspaceName: `Scripts ${tag}`, email: `sc-mgr+${tag}@example.org`, jurisdiction: 'bc-municipal' });
  const inv = await mgr.action('member.invite', { email: `sc-vol+${tag}@example.org`, role: 'volunteer' });
  vol = new Client();
  volId = (await vol.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: 'Ana Example', password: 'script-pass-1' })).json.user.id;
});

test('the desk saves a door script and a phone script; everyone reads them', async () => {
  assert.deepEqual(ok(await vol.get('/api/scripts')), { door: null, phone: null });
  ok(await mgr.action('script.save', { context: 'door', body: 'Hi {{first_name}}, I’m {{my_name}} with {{campaign}}.\r\nDo you have a minute?  ' }));
  ok(await mgr.action('script.save', { context: 'phone', body: 'Hi {{first_name}}, calling for {{campaign}}.' }));
  const s = ok(await vol.get('/api/scripts'));
  assert.equal(s.door.body, 'Hi {{first_name}}, I’m {{my_name}} with {{campaign}}.\nDo you have a minute?');
  assert.equal(s.phone.body, 'Hi {{first_name}}, calling for {{campaign}}.');
  assert.equal((await vol.action('script.save', { context: 'door', body: 'mine' })).status, 403, 'volunteers read, never write');
  assert.equal((await mgr.action('script.save', { context: 'mail', body: 'x' })).status, 400);
});

test('saving again keeps one script; an empty one takes it away; the export and the books', async () => {
  ok(await mgr.action('script.save', { context: 'door', body: 'Version two' }));
  assert.equal(ok(await vol.get('/api/scripts')).door.body, 'Version two');
  ok(await mgr.action('script.save', { context: 'door', body: '   ' }));
  assert.equal(ok(await vol.get('/api/scripts')).door, null);
  assert.equal(ok(await mgr.get('/api/export')).door_scripts.length, 1, 'the phone script');
  assert.equal(ok(await mgr.get('/api/audit/verify')).ok, true);
});

test('a volunteer denied Outreach still reads the scripts (what to say is field work)', async () => {
  ok(await mgr.action('script.save', { context: 'door', body: 'Hello there' }));
  ok(await mgr.action('permission.member.set', { user_id: volId, grant: [], deny: ['outreach'] }));
  assert.equal(ok(await vol.get('/api/scripts')).door.body, 'Hello there');
});
