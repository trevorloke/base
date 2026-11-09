// First-run setup: the deployment names the campaign (STARBASE_ORG_NAME);
// the first sign-up makes its workspace; after that sign-up is closed and
// people join by invite, and sign-in says the campaign's own name — a
// rename in Settings → Campaign included. (org.test.js: a deployment that
// names none.)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';

const tokenOf = (joinUrl) => joinUrl.split('/join/')[1];

before(async () => {
  await freshDb();
  delete process.env.RESEND_API_KEY;
  delete process.env.STARBASE_OPEN_SIGNUP; // the real, closed-after-setup behaviour
  process.env.STARBASE_ORG_NAME = 'Imagine Surrey';
  process.env.STARBASE_TZ = 'America/Vancouver';
});
after(() => { process.env.STARBASE_OPEN_SIGNUP = '1'; delete process.env.STARBASE_ORG_NAME; delete process.env.STARBASE_TZ; });

let mgr;

test('setup is open before anything exists, and names Imagine Surrey', async () => {
  const r = await new Client().get('/api/auth/setup');
  assert.equal(r.status, 200);
  assert.equal(r.json.open, true);
  assert.equal(r.json.organization, 'Imagine Surrey');
  assert.deepEqual([r.json.org.name, r.json.org.jurisdiction, r.json.org.tz, r.json.org.city, r.json.org.env], ['Imagine Surrey', 'bc-municipal', 'America/Vancouver', 'Surrey', 'local']);
  assert.deepEqual(r.json.org.slates.map((x) => x.code), ['council', 'school_board']);
});

test('the first sign-up needs no campaign name: it sets up Imagine Surrey, BC municipal', async () => {
  mgr = new Client();
  const r = await mgr.post('/api/auth/signup', {
    name: 'Trevor Loke', email: 'trevor@imaginesurrey.example', password: 'surrey-forward-2026',
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.role, 'manager');
  assert.equal(r.json.workspace.name, 'Imagine Surrey');
  assert.equal(r.json.workspace.jurisdiction, 'bc-municipal');
  assert.equal(r.json.workspace.slug, 'imagine-surrey');
  assert.equal(r.json.workspace.settings.tz, 'America/Vancouver', 'the deployment’s time zone is the campaign’s');
  assert.equal(r.json.org.name, 'Imagine Surrey', 'every signed-in answer carries the deployment');
});

test('after setup, sign-up is closed (403) and /setup says so', async () => {
  const setup = await new Client().get('/api/auth/setup');
  assert.equal(setup.json.open, false);
  assert.equal(setup.json.organization, 'Imagine Surrey');
  const r = await new Client().post('/api/auth/signup', {
    name: 'Someone Else', email: 'else@example.org', password: 'another-pass-1', workspaceName: 'Another Campaign',
  });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /already set up for Imagine Surrey/);
  assert.match(r.json.error, /invite/);
  // Nothing was made for them.
  const li = await new Client().post('/api/auth/login', { email: 'else@example.org', password: 'another-pass-1' });
  assert.equal(li.status, 401);
});

test('a second person still gets in by invite', async () => {
  const inv = await mgr.action('member.invite', { email: 'jas@example.org', role: 'volunteer' });
  assert.equal(inv.status, 200);
  const anon = new Client();
  const joined = await anon.post('/api/auth/join', { token: tokenOf(inv.json.joinUrl), name: 'Jas Volunteer', password: 'knock-knock-2026' });
  assert.equal(joined.status, 200);
  assert.equal(joined.json.role, 'volunteer');
  assert.equal(joined.json.workspace.name, 'Imagine Surrey');
  const me = await anon.get('/api/auth/me');
  assert.equal(me.status, 200);
});

test('renamed in Settings → Campaign: sign-in and sign-up say the new name, not STARBASE_ORG_NAME', async () => {
  const r = await mgr.action('workspace.update', { name: 'Surrey Forward' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(process.env.STARBASE_ORG_NAME, 'Imagine Surrey', 'the deployment still says the old name');
  const setup = await new Client().get('/api/auth/setup');
  assert.equal(setup.json.open, false);
  assert.equal(setup.json.organization, 'Surrey Forward', 'the sign-in page names the campaign as it is called now');
  const late = await new Client().post('/api/auth/signup', { name: 'Late Comer', email: 'late@example.org', password: 'late-pass-2026' });
  assert.equal(late.status, 403);
  assert.match(late.json.error, /already set up for Surrey Forward/);
  assert.doesNotMatch(late.json.error, /Imagine Surrey/);
});

test('STARBASE_OPEN_SIGNUP=1 opens sign-up again (tests, local dev)', async () => {
  process.env.STARBASE_OPEN_SIGNUP = '1';
  try {
    const setup = (await new Client().get('/api/auth/setup')).json;
    assert.equal(setup.open, true);
    assert.equal(setup.organization, 'Imagine Surrey', 'open, it names what a sign-up would set up: the deployment’s name');
    const r = await new Client().signup();
    assert.equal(r.status, 201);
  } finally {
    delete process.env.STARBASE_OPEN_SIGNUP;
  }
});
