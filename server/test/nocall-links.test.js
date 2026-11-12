// Every Call a screen offers checks do-not-call first (shared/canvass.js
// noCalls). Rows that carry no tags — the crew board, the volunteers'
// roster, a shift's page, Stewardship — carry the server's no_call instead
// (lib/reach.js noCallSql): true for do-not-call or do-not-contact, whatever
// the capitals; never told to a volunteer about someone else.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { noCalls, noCallsWord } from '@starbase/shared/canvass';

let mgr, vol;
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
const yr = new Date().getFullYear();
const P = {};
let shift;

before(async () => {
  await freshDb();
  mgr = new Client();
  await mgr.signup({ workspaceName: 'No call', jurisdiction: 'bc-municipal' });
  const inv = await mgr.action('member.invite', { email: 'nocall-vol@example.org', role: 'volunteer' });
  vol = new Client();
  ok(await vol.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: 'Vic Example', password: 'nocall-pass-1' }));
  P.ana = await mgr.createPerson('Ana Example', { phone: '604-555-0101', tags: ['volunteer'] });
  P.ben = await mgr.createPerson('Ben Example', { phone: '604-555-0102', tags: ['volunteer', 'Do-Not-Call'] });
  P.cy = await mgr.createPerson('Cy Example', { phone: '604-555-0103', tags: ['volunteer', 'do-not-contact'] });
  shift = ok(await mgr.action('shift.create', { title: 'Saturday canvass', location: 'Newton', starts_at: new Date(Date.now() + 3 * 864e5).toISOString(), capacity: 5 })).shift;
  for (const k of ['ana', 'ben', 'cy']) {
    ok(await mgr.action('shift.assign', { shift_id: shift.id, person_id: P[k].id }));
    ok(await mgr.action('gift.log', { person_id: P[k].id, amount_cents: 5000, date: `${yr}-03-01`, method: 'cheque' }));
  }
});

const flags = (rows, id = 'person_id') => Object.fromEntries(rows.map((r) => [r.name.split(' ')[0], r.no_call]));

test('the crew board, the roster, a shift’s page and Stewardship say who may not be called', async () => {
  const want = { Ana: false, Ben: true, Cy: true };
  assert.deepEqual(flags(ok(await mgr.get(`/api/crew/${shift.id}`)).crew), want, 'crew board');
  const roster = flags(ok(await mgr.get('/api/volunteers')).volunteers);
  assert.deepEqual({ Ana: roster.Ana, Ben: roster.Ben, Cy: roster.Cy }, want, 'roster');
  assert.deepEqual(flags(ok(await mgr.get(`/api/shifts/${shift.id}`)).assignees), want, 'a shift’s page');
  assert.deepEqual(flags(ok(await mgr.get('/api/stewardship')).to_thank), want, 'Stewardship');
});

test('noCalls reads a tag whatever its capitals, or the row’s no_call', () => {
  assert.equal(noCalls({ tags: ['Do-Not-Call'] }), true);
  assert.equal(noCalls({ no_call: true }), true);
  assert.equal(noCalls({ no_call: false, tags: [] }), false);
  assert.equal(noCallsWord({ tags: ['DO-NOT-CONTACT'] }), 'Do not contact');
});

test('a volunteer is never told who else asked not to be called', async () => {
  const s = ok(await vol.get(`/api/shifts/${shift.id}`));
  assert.ok(s.assignees.every((a) => a.no_call == null), 'no flag about anyone else');
});
