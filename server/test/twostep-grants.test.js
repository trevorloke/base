// Two-step sign-in required "for desk roles" (lib/twostep.js requiredFor)
// covers everyone the desk opens for: managers, treasurers and staff, and a
// volunteer given an area under Admin → Permissions — their own grant or
// their role's. Until they set it up the server answers nothing else (not
// just the screen): no export with a Data grant, no reset, requirement
// switch or role change with an Admin grant. A volunteer with no area signs
// in as before; taking the area away lifts it.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { app } from '../index.js';
import { base32Decode, hotp, totp, totpStep } from '../lib/twostep.js';
import { getDb } from '../db/client.js';

let ipSeq = 0;
// A browser: its cookies, and an address of its own for sign-in's limit.
class Browser {
  constructor() { this.jar = new Map(); this.ip = `198.51.100.${(ipSeq += 1) % 250}`; }
  get cookie() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '); }
  async req(method, path, body) {
    const res = await app.request(path, {
      method,
      headers: { 'content-type': 'application/json', 'x-forwarded-for': this.ip, ...(this.jar.size ? { cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(';');
      const i = pair.indexOf('=');
      const [k, v] = [pair.slice(0, i), pair.slice(i + 1)];
      if (!v || /max-age=0/i.test(sc)) this.jar.delete(k); else this.jar.set(k, v);
    }
    let json = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, json };
  }
  get(p) { return this.req('GET', p); }
  post(p, b) { return this.req('POST', p, b); }
  action(name, input = {}) { return this.post(`/api/actions/${name}`, input); }
}

const ok = (r) => { assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.json)); return r.json; };
// Turn it on for someone signed in: the key, then its first code.
const turnOn = async (b) => {
  const s = ok(await b.action('twostep.start'));
  ok(await b.action('twostep.confirm', { code: totp(base32Decode(s.setup.key), Date.now()) }));
  return s.setup.key;
};
const setUpFirst = (r, what) => {
  assert.equal(r.status, 401, `${what}: ${JSON.stringify(r.json)}`);
  assert.equal(r.json.two_step, 'set_up', what);
};

let mgr, mgrId;
const people = {};

before(async () => {
  await freshDb();
  delete process.env.STARBASE_TWO_STEP_KEY;
  mgr = new Browser();
  const r = ok(await mgr.post('/api/auth/signup', {
    name: 'Rae Example', email: 'rae.grants@example.org', password: 'two-step-2026', workspaceName: 'Imagine Surrey', jurisdiction: 'bc-municipal',
  }));
  mgrId = r.user.id;
  for (const who of ['dee', 'ada', 'val']) {
    const inv = ok(await mgr.action('member.invite', { email: `${who}.grants@example.org`, role: 'volunteer' }));
    const b = new Browser();
    const j = ok(await b.post('/api/auth/join', { token: inv.joinUrl.split('/join/')[1], name: `${who[0].toUpperCase()}${who.slice(1)} Example`, password: 'two-step-2026' }));
    people[who] = { b, id: j.user.id };
  }
  // Dee may export the data; Ada runs Admin; Val is a volunteer, no more.
  ok(await mgr.action('permission.member.set', { user_id: people.dee.id, grant: ['data'], deny: [] }));
  ok(await mgr.action('permission.member.set', { user_id: people.ada.id, grant: ['admin'], deny: [] }));
  await turnOn(mgr);
  ok(await mgr.action('twostep.require', { on: true }));
});

test('required: a volunteer given an area sets it up before anything else — the server refuses the rest', async () => {
  const { dee, ada, val } = people;
  const me = ok(await dee.b.get('/api/auth/me'));
  assert.deepEqual(me.areas, ['data']);
  assert.deepEqual(me.two_step, { on: false, required: true, must_set_up: true });
  setUpFirst(await dee.b.get('/api/export'), 'the whole file');
  setUpFirst(await dee.b.get('/api/persons'), 'people');
  setUpFirst(await dee.b.action('person.create', { name: 'Nobody Example' }), 'a write');
  // Admin, on a password alone: nothing.
  setUpFirst(await ada.b.action('twostep.reset', { user_id: mgrId }), 'a manager’s two-step reset');
  setUpFirst(await ada.b.action('twostep.require', { on: false }), 'the requirement off');
  setUpFirst(await ada.b.action('member.setRole', { user_id: ada.id, role: 'manager' }), 'made a manager');
  setUpFirst(await ada.b.get('/api/members'), 'the members');
  // The requirement and Rae's own two-step sign-in are as they were.
  const team = ok(await mgr.get('/api/two-step/team'));
  assert.equal(team.required, true);
  assert.ok(team.members.some((m) => m.id === mgrId));
  assert.equal(ok(await mgr.get('/api/members')).members.find((m) => m.id === ada.id).role, 'volunteer');
  // The set-up itself answers.
  const status = ok(await dee.b.get('/api/two-step'));
  assert.deepEqual([status.required, status.must_set_up], [true, true]);
  // A volunteer with no area: the password alone, as before.
  assert.deepEqual(ok(await val.b.get('/api/auth/me')).two_step, { on: false, required: false, must_set_up: false });
  assert.equal((await val.b.get('/api/persons')).status, 200);
  // Set up: the desk opens; turned off, it's asked for again at once.
  dee.key = await turnOn(dee.b);
  assert.equal((await dee.b.get('/api/export')).status, 200);
  const db = await getDb();
  const last = Number((await db.query('select last_step from two_step where user_id = $1', [dee.id])).rows[0].last_step);
  await db.query('update two_step set last_step = $2 where user_id = $1', [dee.id, Math.min(last, totpStep(Date.now()) - 1)]);
  const off = ok(await dee.b.action('twostep.off', { code: hotp(base32Decode(dee.key), totpStep(Date.now())) }));
  assert.deepEqual([off.on, off.must_set_up], [false, true]);
  setUpFirst(await dee.b.get('/api/export'), 'off again');
});

test('a role’s grant counts too; with the area denied or taken away, a volunteer signs in as before', async () => {
  const { val } = people;
  // Every volunteer given the Website.
  ok(await mgr.action('permission.role.set', { role: 'volunteer', grant: ['site'], deny: [] }));
  assert.deepEqual(ok(await val.b.get('/api/auth/me')).two_step, { on: false, required: true, must_set_up: true });
  setUpFirst(await val.b.get('/api/persons'), 'a role’s grant');
  // Val's own deny of that area: no area, nothing asked.
  ok(await mgr.action('permission.member.set', { user_id: val.id, grant: [], deny: ['site'] }));
  assert.deepEqual(ok(await val.b.get('/api/auth/me')).areas, []);
  assert.equal(ok(await val.b.get('/api/auth/me')).two_step.must_set_up, false);
  assert.equal((await val.b.get('/api/persons')).status, 200);
  ok(await mgr.action('permission.member.set', { user_id: val.id, grant: [], deny: [] }));
  setUpFirst(await val.b.get('/api/persons'), 'the role’s grant again');
  // The role's grant taken away: as before.
  ok(await mgr.action('permission.role.set', { role: 'volunteer', grant: [], deny: [] }));
  assert.equal((await val.b.get('/api/persons')).status, 200);
  // Ada's Admin taken away: the same.
  ok(await mgr.action('permission.member.set', { user_id: people.ada.id, grant: [], deny: [] }));
  assert.equal(ok(await people.ada.b.get('/api/auth/me')).two_step.must_set_up, false);
});

test('a candidate (a volunteer with a seat) is asked for it like the desk: /me, GET /two-step and twostep.off all say so', async () => {
  const seat = ok(await mgr.action('candidate.save', { name: 'Cara Example', office: 'Mayor', email: 'cara.grants@example.org' })).candidate;
  const inv = ok(await mgr.action('candidate.invite', { id: seat.id }));
  const b = new Browser();
  const j = ok(await b.post('/api/auth/join', { token: inv.joinUrl.split('/join/')[1], name: 'Cara Example', password: 'two-step-2026' }));
  assert.equal(j.role, 'volunteer');
  assert.equal(j.candidate.name, 'Cara Example');
  assert.deepEqual(j.areas, [], 'no area given: only the seat asks for it');
  assert.deepEqual(j.two_step, { on: false, required: true, must_set_up: true });
  setUpFirst(await b.get('/api/persons'), 'a candidate before set-up');
  const status = ok(await b.get('/api/two-step'));
  assert.deepEqual([status.required, status.must_set_up], [true, true]);
  const key = await turnOn(b);
  assert.equal((await b.get('/api/persons')).status, 200);
  const db = await getDb();
  const last = Number((await db.query('select last_step from two_step where user_id = $1', [j.user.id])).rows[0].last_step);
  await db.query('update two_step set last_step = $2 where user_id = $1', [j.user.id, Math.min(last, totpStep(Date.now()) - 1)]);
  const off = ok(await b.action('twostep.off', { code: hotp(base32Decode(key), totpStep(Date.now())) }));
  assert.deepEqual([off.on, off.must_set_up], [false, true]);
  // Out of the seat: a volunteer with no area, as before.
  ok(await mgr.action('candidate.unlink', { id: seat.id }));
  assert.deepEqual(ok(await b.get('/api/auth/me')).two_step, { on: false, required: false, must_set_up: false });
});
