// Which optional integrations are on (server/ext/integrations): one small
// answer the desk's screens read to know whether to offer "Send to …" —
// Settings → Services says far more, and is managers only. A feature adds
// itself to it; volunteers never read it; it carries yes or no, nothing else.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { registerIntegration } from '../ext/integrations/index.js';

const tag = Math.random().toString(36).slice(2, 8);
let mgr, staff, vol;
const join = async (role) => {
  const inv = await mgr.action('member.invite', { email: `int-${role}+${tag}@example.org`, role });
  const c = new Client();
  await c.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: 'Sam Example', password: 'integrations-1' });
  return c;
};

before(async () => {
  await freshDb();
  mgr = new Client();
  await mgr.signup({ workspaceName: `Integrations ${tag}`, email: `int-mgr+${tag}@example.org` });
  staff = await join('staff');
  vol = await join('volunteer');
});

test('GET /api/integrations: what any feature added, yes or no — for the desk, never a volunteer', async () => {
  let dialer = false;
  registerIntegration('test-dialer', () => dialer);
  const read = async (c) => { const r = await c.get('/api/integrations'); assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
  let on = await read(staff);
  assert.equal(on['test-dialer'], false);
  dialer = 'a-key-that-is-set';
  on = await read(staff);
  assert.equal(on['test-dialer'], true, 'yes or no — never the setting itself');
  assert.deepEqual(await read(mgr), on);
  assert.ok(Object.values(on).every((v) => typeof v === 'boolean'));
  assert.equal((await vol.get('/api/integrations')).status, 403);
  assert.equal((await new Client().get('/api/integrations')).status, 401);
  // The same name again replaces it (a module loaded twice in a test).
  registerIntegration('test-dialer', () => false);
  assert.equal((await read(mgr))['test-dialer'], false);
});
