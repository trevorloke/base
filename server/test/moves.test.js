// Moved (ext/moves): after a Moved tap, a new address or Address unknown.
// The person comes off the old door (the door's own fields with them, kept
// for Undo); a new address lands on the map the way any saved address does;
// who lives at the new and old address comes back with the move (a
// volunteer sees the new one only where they walk); the profile reads it
// (a volunteer never sees where from, where to, or who); Undo puts it all
// back; "Needs an address" is the team's own Moved taps with no move since;
// Today's count and the Map check follow. The BC geocoder is a stand-in.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb, Client } from './helpers.js';
import { verifyChain } from '../lib/events.js';
import { movedCounts, movedOpenIds } from '../ext/moves/index.js';

const tag = Math.random().toString(36).slice(2, 8);
const realFetch = globalThis.fetch;
const env = { ...process.env };
const lat = 49.1327; const lng = -122.855;
let db, ws, mgr, vol, volUser, granted, grantedUser, denied, deniedUser, F;

const ok = (r, msg = '') => { assert.equal(r.status, 200, `${msg} ${JSON.stringify(r.json)}`); return r.json; };
const row = async (id) => (await db.query('select * from persons where id = $1', [id])).rows[0];
const until = async (fn, ms = 3000) => {
  for (const end = Date.now() + ms; Date.now() < end;) { const v = await fn(); if (v) return v; await new Promise((r) => { setTimeout(r, 40); }); }
  return fn();
};
const join = async (email, name) => {
  const inv = await mgr.action('member.invite', { email, role: 'volunteer' });
  const c = new Client();
  await c.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name, password: 'moving-pass-1' });
  return [c, (await c.get('/api/auth/me')).json.user];
};
const knock = (c, p, extra = {}) => c.action('contact.log', { person_id: p.id, channel: 'door', outcome: 'moved', ...extra });
const openIds = async (c = mgr, v = 'open') => (ok(await c.get(`/api/persons?moved=${v}&limit=500`))).persons.map((p) => p.id).sort();

before(async () => {
  db = await freshDb();
  // The stand-in BC geocoder: one address it knows.
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.hostname !== 'geocoder.api.gov.bc.ca') throw new Error(`no stand-in for ${u.hostname}`);
    const q = u.searchParams.get('addressString') || '';
    const hit = q.toLowerCase().startsWith('9800 king george blvd');
    return new Response(JSON.stringify({ features: hit ? [{
      geometry: { coordinates: [-122.8456, 49.1789] },
      properties: { civicNumber: 9800, civicNumberSuffix: '', streetName: 'King George', streetType: 'Blvd', streetDirection: '',
        localityName: 'Surrey', fullAddress: '9800 King George Blvd, Surrey, BC', matchPrecision: 'CIVIC_NUMBER', score: 95 },
    }] : [] }));
  };
  delete process.env.GEOCODER;
  mgr = new Client();
  ws = (await mgr.signup({ workspaceName: `Moves ${tag}`, jurisdiction: 'bc-municipal', email: `moves.desk+${tag}@example.org` })).json.workspace.id;
  ok(await mgr.action('turf.create', {
    name: 'Newton block', polygon: [[lat + 0.002, lng - 0.002], [lat + 0.002, lng + 0.002], [lat - 0.002, lng + 0.002], [lat - 0.002, lng - 0.002]],
  }));
  const turf = (await db.query('select id from turfs where workspace_id = $1', [ws])).rows[0];
  [vol, volUser] = await join(`moves.vol+${tag}@example.org`, 'Jas Example');
  [granted, grantedUser] = await join(`moves.ppl+${tag}@example.org`, 'Pat Example');
  [denied, deniedUser] = await join(`moves.no+${tag}@example.org`, 'Noa Example');
  for (const u of [volUser, deniedUser]) ok(await mgr.action('turf.assign', { turf_id: turf.id, user_id: u.id }));
  ok(await mgr.action('permission.member.set', { user_id: grantedUser.id, grant: ['people'] }));
  ok(await mgr.action('permission.member.set', { user_id: deniedUser.id, deny: ['people'] }));
  F = Object.fromEntries(ok(await mgr.get('/api/fields')).fields.map((f) => [f.name, f]));
});
after(() => {
  globalThis.fetch = realFetch;
  for (const k of ['GEOCODER', 'GEOCODE_ON_SAVE']) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
});

// A door in the volunteer's turf with one person on it.
let n = 0;
const atDoor = async (name, extra = {}) => {
  n += 1;
  return mgr.createPerson(name, { address: `${13400 + n} 72 Ave`, city: 'Surrey', postal: 'V3W 2N5', lat, lng: lng + n * 0.00001, phone: '604-555-0101', ...extra });
};

test('a new address: the move is kept, the pin drops and the address is placed after the save; the city defaults; the same address is refused', async () => {
  const ana = await atDoor('Ana Example');
  const cid = randomUUID();
  ok(await knock(mgr, ana, { client_id: cid }));
  assert.equal((await mgr.action('person.move', { person_id: ana.id })).json.error, 'Pick a new address or Address unknown');
  assert.equal((await mgr.action('person.move', { person_id: ana.id, unknown: true, to: { address: '1 A St' } })).status, 400);
  assert.equal((await mgr.action('person.move', { person_id: ana.id, to: { address: '1 A St', lat: 49 } })).json.error, 'pin needs both lat and lng');
  const same = await mgr.action('person.move', { person_id: ana.id, to: { address: ` ${ana.address.toUpperCase().replace(' ', '  ')} ` } });
  assert.equal(same.status, 409, 'spaces and capitals are the same address');
  assert.equal(same.json.error, 'That’s the address on file already');

  process.env.GEOCODE_ON_SAVE = 'on';
  const r = ok(await mgr.action('person.move', { person_id: ana.id, to: { address: '9800 King George Blvd' }, contact_client_id: cid }));
  assert.equal(r.move.result, 'new');
  assert.equal(r.move.reason, 'moved');
  assert.equal(r.person.address, '9800 King George Blvd');
  assert.equal(r.person.city, 'Surrey', 'the old city when none is given');
  assert.equal(r.person.postal, null);
  assert.equal(r.person.lat, null, 'the old pin is gone');
  assert.ok(await until(async () => (await row(ana.id)).lat != null), 'placed after the save');
  assert.equal(Number((await row(ana.id)).lat), 49.1789);
  process.env.GEOCODE_ON_SAVE = 'off';

  const m = (await db.query('select * from person_moves where person_id = $1', [ana.id])).rows;
  assert.equal(m.length, 1);
  assert.equal(m[0].from_address, ana.address);
  assert.equal(Number(m[0].from_lat), lat);
  assert.equal(m[0].to_city, 'Surrey');
  assert.equal(m[0].contact_id, (await db.query('select id from contacts where client_id = $1', [cid])).rows[0].id, 'the Moved tap it follows');
  assert.equal(m[0].from_key, 'anaexample|' + ana.address.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const ev = (await db.query(
    `select entity_type, op, payload from events where workspace_id = $1 and action = 'person.move' order by seq`, [ws],
  )).rows;
  assert.deepEqual(ev.map((e) => `${e.entity_type} ${e.op}`), ['person_move create', 'person update']);
  assert.equal(ev[0].payload.from_key, undefined);
  assert.equal(ev[1].payload.source, 'move');
  assert.ok(!('lat' in ev[1].payload), 'no pin sent: placed after the write');
});

test('a desk pick with a pin keeps it (and says so); a housemate’s pin is copied for a typed address', async () => {
  const bo = await atDoor('Bo Example');
  const r = ok(await mgr.action('person.move', { person_id: bo.id, to: { address: '5 Example Rd', city: 'Delta', lat: 49.09, lng: -122.9 } }));
  assert.deepEqual([r.person.lat, r.person.lng, r.person.city], [49.09, -122.9, 'Delta']);
  const ev = (await db.query(`select payload from events where workspace_id = $1 and entity_id = $2 and entity_type = 'person' order by seq desc limit 1`, [ws, bo.id])).rows[0];
  assert.equal(ev.payload.lat, 49.09);
  // Someone already at 7 Example Rd, Surrey, on the map: a typed move there takes their pin.
  await mgr.createPerson('Cy Example', { address: '7 Example Rd', city: 'Surrey', lat: 49.2, lng: -122.8 });
  const di = await atDoor('Di Example');
  process.env.GEOCODE_ON_SAVE = 'on';
  ok(await mgr.action('person.move', { person_id: di.id, to: { address: '7 example rd' } }));
  assert.ok(await until(async () => (await row(di.id)).lat != null), 'the housemate’s pin');
  assert.deepEqual([Number((await row(di.id)).lat), Number((await row(di.id)).lng)], [49.2, -122.8]);
  process.env.GEOCODE_ON_SAVE = 'off';
});

test('stored as settled: no city and a double space is stored as written, and Undo works', async () => {
  const ed = await atDoor('Ed Example');
  const r = ok(await mgr.action('person.move', { person_id: ed.id, to: { address: '13450  104 ave' } }));
  const m = (await db.query('select * from person_moves where id = $1', [r.move.id])).rows[0];
  assert.equal(m.to_address, '13450 104 ave');
  assert.equal(m.to_house_number, '13450');
  assert.equal(m.to_city, 'Surrey');
  const u = ok(await mgr.action('person.unmove', { move_id: r.move.id }));
  assert.equal(u.person.address, ed.address);
  assert.equal(u.person.lat, lat);
});

test('Address unknown: off the door, the map and the walk list; the old address kept on the move; the map’s counts don’t rise', async () => {
  const fay = await atDoor('Fay Example');
  const turf = (await db.query('select id from turfs where workspace_id = $1', [ws])).rows[0];
  const walkHas = async () => (ok(await vol.get(`/api/turfs/${turf.id}/walk`))).doors.some((d) => d.persons.some((p) => p.id === fay.id));
  assert.ok(await walkHas());
  const before = ok(await mgr.get('/api/map/doors'));
  const check = ok(await mgr.get('/api/map/check'));
  const r = ok(await vol.action('person.move', { person_id: fay.id, unknown: true }));
  assert.equal(r.move.result, 'unknown');
  assert.equal(r.there, null);
  const p = await row(fay.id);
  assert.deepEqual([p.address, p.house_number, p.unit, p.city, p.postal, p.lat, p.lng, p.address_status],
    [null, null, null, null, null, null, null, 'unknown']);
  assert.ok(!(await walkHas()), 'gone from the walk list');
  const now = ok(await mgr.get('/api/map/doors'));
  assert.ok(!now.persons.some((x) => x.id === fay.id), 'off the map');
  assert.equal(now.unlocated, before.unlocated, 'not “waiting for a pin”');
  assert.equal(ok(await mgr.get('/api/map/check')).people.noAddress, check.people.noAddress, 'the Map check counts it as settled, not work');
  const m = (await db.query('select from_address, from_city from person_moves where id = $1', [r.move.id])).rows[0];
  assert.deepEqual([m.from_address, m.from_city], [fay.address, 'Surrey']);
  assert.equal((await mgr.action('person.move', { person_id: fay.id, unknown: true })).status, 409, 'already unknown');
});

test('Address unknown, then a new address with no city: the old city is used, so who lives there is found', async () => {
  const ida = await mgr.createPerson('Ida Example', { address: '9810 King George Blvd', city: 'Surrey', lat: 49.18, lng: -122.84 });
  const kim = await atDoor('Kim Example');
  ok(await mgr.action('person.move', { person_id: kim.id, unknown: true }));
  const r = ok(await mgr.action('person.move', { person_id: kim.id, to: { address: '9810 King George Blvd' } }));
  assert.equal((await row(kim.id)).city, 'Surrey', 'the city from before Address unknown');
  assert.deepEqual(r.there.map((p) => p.id), [ida.id], 'the household at the new address');
  assert.equal(r.person.city, 'Surrey', 'the answer says the city it kept');
});

test('the walk list and the door card carry each person’s city (the panel starts with it)', async () => {
  const lia = await atDoor('Lia Example');
  const turf = (await db.query('select id from turfs where workspace_id = $1', [ws])).rows[0];
  const walk = ok(await vol.get(`/api/turfs/${turf.id}/walk`));
  const there = walk.doors.flatMap((d) => d.persons).find((p) => p.id === lia.id);
  assert.equal(there.city, 'Surrey', 'walk list');
  const door = ok(await vol.get(`/api/map/doors?person=${lia.id}`));
  assert.equal(door.persons.find((p) => p.id === lia.id).city, 'Surrey', 'door card');
});

test('the door’s fields go with the old door, and come back with Undo; Home phone stays', async () => {
  const gus = await atDoor('Gus Example');
  ok(await mgr.action('field.values.set', { person_id: gus.id, values: [
    { field_id: F['House notes'].id, value: 'Dog in yard' }, { field_id: F['Building notes'].id, value: 'Buzz 12' },
    { field_id: F['Access type'].id, value: 'Gated' }, { field_id: F['Dwelling type'].id, value: 'bsmt suite' },
    { field_id: F['Home phone'].id, value: '604-555-0109' },
  ] }));
  const r = ok(await mgr.action('person.move', { person_id: gus.id, to: { address: '20 Example Way' } }));
  const left = (await db.query(
    `select f.name from person_field_values v join person_fields f on f.id = v.field_id where v.person_id = $1`, [gus.id],
  )).rows.map((x) => x.name);
  assert.deepEqual(left, ['Home phone']);
  const m = (await db.query('select from_door from person_moves where id = $1', [r.move.id])).rows[0];
  assert.equal(m.from_door.length, 4);
  const voids = (await db.query(`select count(*)::int as n from events where workspace_id = $1 and action = 'person.move' and entity_type = 'person_field_value' and op = 'void'`, [ws])).rows[0].n;
  assert.ok(voids >= 4);
  const u = ok(await mgr.action('person.unmove', { move_id: r.move.id }));
  assert.equal(u.restored.length, 4);
  const back = (await db.query(
    `select f.name, v.value from person_field_values v join person_fields f on f.id = v.field_id where v.person_id = $1 order by f.name`, [gus.id],
  )).rows;
  assert.deepEqual(back.map((x) => x.name), ['Access type', 'Building notes', 'Dwelling type', 'Home phone', 'House notes']);
  assert.equal(back.find((x) => x.name === 'Dwelling type').value, 'bsmt suite');
});

test('a replay of the phone’s id is the same move, never a second', async () => {
  const hal = await atDoor('Hal Example');
  const id = randomUUID();
  const a = ok(await vol.action('person.move', { person_id: hal.id, unknown: true, client_id: id }));
  const b = ok(await vol.action('person.move', { person_id: hal.id, unknown: true, client_id: id }));
  assert.equal(b.duplicate, true);
  assert.equal(b.move.id, a.move.id);
  assert.equal((await db.query('select count(*)::int as n from person_moves where person_id = $1', [hal.id])).rows[0].n, 1);
});

test('who may: a volunteer at a door in their turf; not outside it, not with no pin, not when denied People; granted People, anyone', async () => {
  const ivy = await atDoor('Ivy Example');
  ok(await vol.action('person.move', { person_id: ivy.id, to: { address: '30 Example Way' } }), 'in turf, new');
  const far = await mgr.createPerson('Far Example', { address: '1 Other Rd', city: 'Surrey', lat: 49.3, lng: -122.5 });
  const nopin = await mgr.createPerson('Nopin Example', { address: '2 Other Rd', city: 'Surrey' });
  for (const p of [far, nopin]) {
    const r = await vol.action('person.move', { person_id: p.id, unknown: true });
    assert.equal(r.status, 403);
    assert.equal(r.json.error, 'Only the office can change this address');
  }
  assert.equal((await denied.action('person.move', { person_id: (await atDoor('Jo Example')).id, unknown: true })).status, 403, 'denied People');
  ok(await granted.action('person.move', { person_id: far.id, unknown: true }), 'granted People: anyone');
  assert.equal((await vol.action('person.unmove', { move_id: randomUUID() })).status, 403, 'Undo is the office’s');
});

test('a volunteer’s pin: dropped for an address that is no door on file (and the new door’s people hidden); kept at a door on file nearby', async () => {
  const kit = await atDoor('Kit Example');
  const r = ok(await vol.action('person.move', { person_id: kit.id, to: { address: '99 Faraway Rd', city: 'Surrey', lat, lng } }));
  assert.equal(r.person.lat, null, 'a made-up pin gets nothing');
  assert.equal(r.there, null);
  assert.equal(r.there_hidden, true);
  // A door on file inside the turf, its pin 20 m off what the phone sent.
  const home = await mgr.createPerson('Lou Example', { address: '13500 72 Ave', city: 'Surrey', lat: lat + 0.0001, lng: lng + 0.0001 });
  const mo = await atDoor('Mo Example');
  const k = ok(await vol.action('person.move', { person_id: mo.id, to: { address: '13500 72 ave', city: 'surrey', lat: lat + 0.0002, lng: lng + 0.0002 } }));
  assert.equal(k.person.lat, lat + 0.0002, 'kept');
  assert.equal(k.there_hidden, false);
  assert.deepEqual(k.there.map((p) => p.id), [home.id]);
  assert.deepEqual(Object.keys(k.there[0]), ['id', 'name', 'rating', 'has_pin'], 'no phone, no email for a volunteer');
});

test('who lives there: A–Z by last name, the mover’s city only, the old door’s too; GET /api/moves/door the same', async () => {
  const addr = '400 Example Ave';
  const zed = await mgr.createPerson('Zed Adams', { address: addr, city: 'Surrey', lat: 49.15, lng: -122.8, phone: '604-555-0111' });
  const amy = await mgr.createPerson('Amy Young', { address: addr, city: 'Surrey' });
  await mgr.createPerson('Other City', { address: addr, city: 'Delta', lat: 49.05, lng: -123 });
  const nan = await atDoor('Nan Example');
  const mate = await mgr.createPerson('Ola Example', { address: nan.address, city: 'Surrey', lat, lng });
  const r = ok(await mgr.action('person.move', { person_id: nan.id, to: { address: addr } }));
  assert.deepEqual(r.there.map((p) => p.name), ['Zed Adams', 'Amy Young'], 'by last name, Surrey only');
  assert.deepEqual(r.there[0], { id: zed.id, name: 'Zed Adams', rating: null, phone_on_file: true, has_pin: true });
  assert.equal(r.there[1].has_pin, false);
  assert.deepEqual(r.left.map((p) => p.id), [mate.id]);
  const d = ok(await mgr.get(`/api/moves/door?person=${nan.id}`));
  assert.deepEqual([d.there.map((p) => p.id), d.left.map((p) => p.id), d.there_hidden], [[zed.id, amy.id], [mate.id], false]);
  assert.equal((await mgr.get(`/api/moves/door?person=${mate.id}`)).status, 404, 'no move');
  assert.equal((await vol.get(`/api/moves/door?person=${nan.id}`)).status, 404, 'not the volunteer’s move');
  // The volunteer's own move: left always, there hidden (nobody there is in their turf).
  const pip = await atDoor('Pip Example');
  const pm = await mgr.createPerson('Quin Example', { address: pip.address, city: 'Surrey', lat, lng });
  ok(await vol.action('person.move', { person_id: pip.id, to: { address: addr } }));
  const vd = ok(await vol.get(`/api/moves/door?person=${pip.id}`));
  assert.deepEqual([vd.there, vd.there_hidden, vd.left.map((p) => p.id)], [null, true, [pm.id]]);
  assert.deepEqual(Object.keys(vd.left[0]), ['id', 'name', 'rating', 'has_pin']);
});

test('the profile: the desk reads the move; a volunteer reads only what happened, and whether they may move', async () => {
  const rae = await atDoor('Rae Example');
  ok(await knock(vol, rae));
  let d = ok(await mgr.get(`/api/persons/${rae.id}`));
  assert.equal(d.move_open, true, 'Moved, no address yet');
  assert.equal(d.latest_move, null);
  const v0 = ok(await vol.get(`/api/persons/${rae.id}`));
  assert.equal(v0.may_move, true);
  ok(await vol.action('person.move', { person_id: rae.id, unknown: true }));
  d = ok(await mgr.get(`/api/persons/${rae.id}`));
  assert.equal(d.move_open, false);
  assert.equal(d.person.address_status, 'unknown');
  assert.equal(d.latest_move.from_address, rae.address);
  assert.equal(d.latest_move.by_name, 'Jas Example');
  assert.equal(d.latest_move.result, 'unknown');
  const res = await vol.req('GET', `/api/persons/${rae.id}`);
  const raw = JSON.stringify(res.json);
  for (const k of ['from_address', 'to_address', d.latest_move.id]) assert.ok(!raw.includes(k), `no ${k} for a volunteer`);
  assert.deepEqual(res.json.latest_move, { reason: 'moved', result: 'unknown' }, 'no by_name, no id');
  assert.equal(res.json.person.address_status, 'unknown');
  assert.equal(res.json.may_move, false, 'no pin now');
  const far = await mgr.createPerson('Sal Example', { address: '3 Other Rd', lat: 49.3, lng: -122.5 });
  assert.equal(ok(await vol.get(`/api/persons/${far.id}`)).may_move, false, 'outside their turf');
  assert.equal(ok(await granted.get(`/api/persons/${far.id}`)).may_move, true, 'granted People');
});

test('Undo: back to the old address, pin and status; only the newest; not once the address has changed; back in Needs an address', async () => {
  const tam = await atDoor('Tam Example');
  ok(await knock(mgr, tam));
  const a = ok(await mgr.action('person.move', { person_id: tam.id, to: { address: '50 Example Way' } }));
  const b = ok(await mgr.action('person.move', { person_id: tam.id, unknown: true }));
  const old = await mgr.action('person.unmove', { move_id: a.move.id });
  assert.equal(old.status, 409);
  assert.equal(old.json.error, 'Undo the newest change first');
  ok(await mgr.action('person.unmove', { move_id: b.move.id }));
  assert.equal((await row(tam.id)).address, '50 Example Way');
  assert.equal((await mgr.action('person.unmove', { move_id: b.move.id })).status, 409, 'undone already');
  ok(await mgr.action('person.update', { id: tam.id, address: '51 Example Way' }));
  const changed = await mgr.action('person.unmove', { move_id: a.move.id });
  assert.equal(changed.status, 409);
  assert.equal(changed.json.error, 'The address has changed since — edit it in Details instead');
  ok(await mgr.action('person.update', { id: tam.id, address: '50 Example Way' }));
  const u = ok(await mgr.action('person.unmove', { move_id: a.move.id }));
  assert.deepEqual([u.person.address, u.person.lat, u.person.address_status], [tam.address, lat, null]);
  const ev = (await db.query(`select payload from events where workspace_id = $1 and action = 'person.unmove' and entity_type = 'person' order by seq desc limit 1`, [ws])).rows[0];
  assert.equal(ev.payload.lat, lat, 'the old pin is sent: not looked up again');
  assert.ok((await openIds()).includes(tam.id), 'back in Needs an address');
});

test('a real new address clears Address unknown: the desk’s edit, the website’s forms; an import does not', async () => {
  const uma = await atDoor('Uma Example');
  ok(await mgr.action('person.move', { person_id: uma.id, unknown: true }));
  ok(await mgr.action('person.update', { id: uma.id, address: '60 Example Way' }));
  assert.equal((await row(uma.id)).address_status, null);
  // The website's and intake's writes say source 'website': run as an event.
  const vic = await atDoor('Vic Example');
  ok(await mgr.action('person.move', { person_id: vic.id, unknown: true }));
  const { runAction } = await import('../lib/events.js');
  await runAction(db, { workspaceId: ws, actorId: null, action: 'site.form' }, async (tx, emit) => {
    await tx.query(`update persons set address = '61 Example Way' where id = $1`, [vic.id]);
    emit('person', vic.id, 'update', { address: '61 Example Way', source: 'website' });
  });
  assert.equal((await row(vic.id)).address_status, null);
  const wyn = await atDoor('Wyn Example');
  ok(await mgr.action('person.move', { person_id: wyn.id, unknown: true }));
  await runAction(db, { workspaceId: ws, actorId: null, action: 'import.persons' }, async (tx, emit) => {
    await tx.query(`update persons set address = '62 Example Way' where id = $1`, [wyn.id]);
    emit('person', wyn.id, 'update', { address: '62 Example Way', source: 'import' });
  });
  assert.equal((await row(wyn.id)).address_status, 'unknown');
  await db.query('update persons set address = null where id = $1', [wyn.id]);
});

test('Needs an address and Address unknown: People, the counts and the ids agree; Today’s count is the desk’s', async () => {
  const xan = await atDoor('Xan Example');
  ok(await knock(vol, xan));
  // An imported list's "Moved" history is not the team's.
  await db.query(`insert into contacts (id, workspace_id, person_id, channel, outcome, source) values ($1, $2, $3, 'door', 'moved', 'import')`,
    [randomUUID(), ws, (await atDoor('Yan Example')).id]);
  const ids = await openIds();
  assert.ok(ids.includes(xan.id));
  const c = await movedCounts(db, ws);
  assert.equal(c.open, ids.length);
  assert.deepEqual((await movedOpenIds(db, ws)).sort(), ids);
  const first = await movedOpenIds(db, ws, { limit: 1 });
  assert.equal(first.length, 1);
  assert.deepEqual(await movedOpenIds(db, ws, { after: first[0], limit: 500 }), (await movedOpenIds(db, ws)).slice(1));
  assert.equal(c.unknown, (await openIds(mgr, 'unknown')).length);
  assert.equal((await openIds(mgr, 'bogus')).length, 0, 'a value it doesn’t know matches nobody');
  // A later team contact that isn't Moved takes them out.
  ok(await mgr.action('contact.log', { person_id: xan.id, channel: 'phone', outcome: 'no_answer' }));
  assert.ok(!(await openIds()).includes(xan.id));

  assert.equal(ok(await mgr.get('/api/brief')).moved.open, (await movedCounts(db, ws)).open);
  // People's chips: the same counts, the desk's only.
  assert.deepEqual(ok(await mgr.get('/api/moves/counts')), await movedCounts(db, ws));
  assert.equal((await vol.get('/api/moves/counts')).status, 403);
  ok(await mgr.action('permission.role.set', { role: 'staff', deny: ['people'] }));
  const [staff] = await (async () => {
    const inv = await mgr.action('member.invite', { email: `moves.staff+${tag}@example.org`, role: 'staff' });
    const s = new Client();
    await s.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: 'Stu Example', password: 'moving-pass-1' });
    return [s];
  })();
  assert.equal(ok(await staff.get('/api/brief')).moved, undefined, 'staff denied People');
  ok(await mgr.action('permission.role.set', { role: 'staff', deny: [] }));
  assert.equal(typeof ok(await staff.get('/api/brief')).moved?.open, 'number', 'staff with People');
  assert.equal(ok(await vol.get('/api/brief')).moved, undefined, 'a volunteer');
  // A saved list on moved=unknown keeps working.
  assert.equal(ok(await mgr.get('/api/persons?moved=unknown&limit=500')).persons.every((p) => p.address_status === undefined || p.address_status === 'unknown'), true);
});

test('every write is on the hash chain', async () => {
  assert.equal((await verifyChain(db, ws)).ok, true);
});
