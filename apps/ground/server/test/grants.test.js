// Area grants and the batch's actions (passes, voted, door requests, shift
// turfs): a grant lets someone work in an area, never change the campaign's
// switches, read the office's notes, or hand out walk lists they couldn't.
//   - a manager-only action (vote.settings, texting.settings) needs Admin,
//     whatever area its name falls under (lib/perms.js mayRun)
//   - request.done / request.reopen stay the desk's even for a volunteer
//     granted People (their replies carry what was said and who asked)
//   - shift.turfs.set needs Map & turfs as well as Shifts
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb, Client } from './helpers.js';

const tag = Math.random().toString(36).slice(2, 8);
let mgr, ann, bob, bobId, sam, samId;
const ok = (r, msg) => { assert.equal(r.status, 200, `${msg || ''} ${JSON.stringify(r.json)}`); return r.json; };
const join = async (role, name) => {
  const inv = ok(await mgr.action('member.invite', { email: `gr-${name}+${tag}@example.org`, role }));
  const c = new Client();
  const j = ok(await c.post('/api/auth/join', { token: inv.joinUrl.split('/join/')[1], name: `${name} Example`, password: 'grants-pass-123' }));
  return { client: c, id: j.user.id };
};
const grant = (user_id, g, deny = []) => mgr.action('permission.member.set', { user_id, grant: g, deny });

before(async () => {
  await freshDb();
  mgr = new Client();
  await mgr.signup({ workspaceName: `Grants ${tag}`, email: `gr-mgr+${tag}@example.org`, jurisdiction: 'bc-municipal' });
  ann = (await join('volunteer', 'Ann')).client;
  ({ client: bob, id: bobId } = await join('volunteer', 'Bob'));
  ({ client: sam, id: samId } = await join('staff', 'Sam'));
});

test('Election day and the texting hours stay the managers’, whatever a grant says', async () => {
  ok(await grant(bobId, ['people', 'outreach']));
  ok(await grant(samId, ['people', 'outreach']));
  for (const c of [bob, sam]) {
    assert.equal((await c.action('vote.settings', { on: true, election_day: '2026-10-17' })).status, 403);
    assert.equal((await c.action('texting.settings', { allow_until: 20 })).status, 403);
  }
  ok(await mgr.action('vote.settings', { on: true, election_day: '2026-10-17' }), 'a manager');
  assert.equal(ok(await bob.get('/api/voted/status')).on, true, 'still readable by everyone');
  // The grant still does what it is for: Bob marks a voter.
  const p = await mgr.createPerson('Rhea Example', { phone: '604-555-0101' });
  ok(await bob.action('vote.mark', { person_id: p.id, voted: true, source: 'door', client_id: randomUUID() }), 'vote.mark');
  // Admin is the one grant that opens a manager-only switch.
  ok(await grant(samId, ['admin']));
  ok(await sam.action('vote.settings', { on: false }), 'staff granted Admin');
  ok(await grant(samId, []));
});

test('a volunteer granted People can’t mark a door request done or reopen it (the reply would carry the note)', async () => {
  const p = await mgr.createPerson('Tess Example', { phone: '604-555-0102' });
  const ask = ok(await ann.action('request.ask', { person_id: p.id, kind: 'call_back', note: 'call after six', client_id: randomUUID() }));
  const id = ask.request.id;
  const listed = ok(await bob.get(`/api/persons/${p.id}/requests`)).requests;
  assert.deepEqual(Object.keys(listed[0]).sort(), ['created_at', 'done', 'id', 'kind'], 'the volunteer read carries no note');
  for (const name of ['request.reopen', 'request.done']) {
    const r = await bob.action(name, { id });
    assert.equal(r.status, 403, name);
    assert.ok(!JSON.stringify(r.json).includes('call after six'), `${name}: nothing said comes back`);
  }
  assert.equal((await bob.get('/api/requests')).status, 403);
  const done = ok(await sam.action('request.done', { id, note: 'called' }), 'staff');
  assert.equal(done.request.note, 'call after six');
  ok(await sam.action('request.reopen', { id }), 'staff reopens');
});

test('putting turfs on a shift needs Map & turfs as well as Shifts', async () => {
  const turf = ok(await mgr.action('turf.create', {
    name: 'Newton block', polygon: [[49.1337, -122.856], [49.1337, -122.853], [49.1317, -122.853], [49.1317, -122.856]],
  })).turf;
  const at = new Date(Date.now() + 2 * 86400_000).toISOString();
  const shift = ok(await mgr.action('shift.create', { title: 'Saturday canvass', starts_at: at })).shift;
  ok(await grant(bobId, ['shifts']));
  const r = await bob.action('shift.turfs.set', { shift_id: shift.id, turf_ids: [turf.id] });
  assert.equal(r.status, 403, 'Shifts alone');
  assert.equal(ok(await bob.get('/api/turfs')).turfs.length, 0, 'no walk list reached him');
  ok(await grant(samId, [], ['map']));
  assert.equal((await sam.action('shift.turfs.set', { shift_id: shift.id, turf_ids: [turf.id] })).status, 403, 'staff with Map taken away');
  ok(await grant(samId, []));
  ok(await sam.action('shift.turfs.set', { shift_id: shift.id, turf_ids: [turf.id] }), 'staff');
  ok(await grant(bobId, ['shifts', 'map']));
  ok(await bob.action('shift.turfs.set', { shift_id: shift.id, turf_ids: [] }), 'a volunteer granted both');
});
