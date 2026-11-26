// Training is at /training for every campaign, and is called "Training"
// unless the campaign calls it something else. "ImagineU" and its old
// address /imagineu are Imagine Surrey's own (server/presets/, read only
// through lib/preset.js): on its server the old address still opens, sent on
// to /training with what follows it; on another campaign's server the name
// is nowhere and the old address is just an address the app does not have.
// The brand is set after the server was loaded (as the test helper does).
// Unique emails and campaign names (test:pg can run a file twice on one database).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';
import { forgetBrand } from '../lib/brand.js';
import { presetFor } from '../lib/preset.js';
import { AREAS } from '../lib/perms.js';
import { mountAt } from '../lib/mount.js';
import { oldTrainingPath } from '../ext/learn/public.js';

const tag = Math.random().toString(36).slice(2, 8);
const ok = (r, msg = '') => { assert.ok(r.status === 200 || r.status === 201, `${msg} ${r.status} ${JSON.stringify(r.json)}`); return r.json; };
const IS = presetFor('imagine-surrey');

const savedBrand = process.env.STARBASE_BRAND;
const wear = (brand) => { process.env.STARBASE_BRAND = brand; forgetBrand(); };
after(() => { if (savedBrand === undefined) delete process.env.STARBASE_BRAND; else process.env.STARBASE_BRAND = savedBrand; forgetBrand(); });

let mgr;
const open = async (path, method = 'GET') => {
  const res = await app.request(`http://localhost${path}`, { method });
  return { status: res.status, location: res.headers.get('location'), text: method === 'GET' ? await res.text() : '' };
};

before(async () => {
  await freshDb();
  wear('base');
  mgr = new Client();
  ok(await mgr.signup({ workspaceName: `Kamloops Forward ${tag}`, email: `neutral.training.${tag}@example.org`, jurisdiction: 'bc-municipal' }));
});

test('another campaign: /training is the app, and /imagineu is sent nowhere', async () => {
  wear('base');
  const home = await open('/');
  for (const path of ['/training', '/training/progress', '/admin/training', '/imagineu', '/imagineu/x?y=1', '/admin/imagineu/progress']) {
    const r = await open(path);
    assert.equal(r.location, null, `${path}: no redirect`);
    assert.equal(r.status, home.status, `${path}: answered as any address of the app is`);
    assert.equal(r.text, home.text, `${path}: the app’s page (which shows its own not-found screen for an address it does not have)`);
  }
  assert.equal(oldTrainingPath('/imagineu'), null);
  assert.equal(oldTrainingPath('/admin/imagineu/progress'), null);
  // Its page names no old address for the app to open.
  assert.doesNotMatch(home.text, /imagineu|ImagineU/i);
});

test('another campaign: the permissions list, the menu word and the public lessons say Training', async () => {
  wear('base');
  assert.equal(AREAS.find((a) => a.key === 'learn').label, 'Training', 'the product’s own word');
  const view = ok(await mgr.get('/api/admin/permissions'));
  assert.deepEqual(view.areas.find((a) => a.key === 'learn'), { key: 'learn', label: 'Training', what: 'training: the lessons, their files, who has done what' });
  assert.doesNotMatch(JSON.stringify(view), /ImagineU/i);
  assert.doesNotMatch(JSON.stringify(ok(await mgr.get('/api/auth/me'))), /ImagineU|imagineu/i);
});

test('Imagine Surrey: /imagineu and everything under it is sent on to /training, in either app, with the rest of the address kept', async () => {
  wear('imagine-surrey');
  try {
    assert.deepEqual([...IS.training.oldPaths], ['/imagineu']);
    for (const [from, to] of [
      ['/imagineu', '/training'],
      ['/imagineu/x?y=1', '/training/x?y=1'],
      ['/imagineu/progress', '/training/progress'],
      ['/imagineu/3f2c8a40-0000-4000-8000-000000000001', '/training/3f2c8a40-0000-4000-8000-000000000001'],
      ['/admin/imagineu', '/admin/training'],
      ['/admin/imagineu/progress?from=menu', '/admin/training/progress?from=menu'],
    ]) {
      const r = await open(from);
      assert.equal(r.status, 302, from);
      assert.equal(r.location, to, from);
      const head = await open(from, 'HEAD');
      assert.equal(head.status, 302, `HEAD ${from}`);
    }
    // Only those addresses: a longer word, another method and /training itself are left alone.
    const home = await open('/');
    for (const path of ['/training', '/training/progress', '/imagineuniversity', '/imagineu-old', '/people/imagineu']) {
      const r = await open(path);
      assert.equal(r.location, null, path);
      assert.equal(r.status, home.status, path);
    }
    assert.notEqual((await open('/imagineu', 'POST')).status, 302, 'a form sent there is not sent on');
    // Under a client's path (base.win/<client>/field/…) the way out keeps the path.
    const under = await mountAt(app, '/imaginesurrey')(new Request('http://base.test/imaginesurrey/field/imagineu/progress?x=1'));
    assert.equal(under.status, 302);
    assert.equal(under.headers.get('location'), '/imaginesurrey/field/training/progress?x=1');
    const desk = await mountAt(app, '/imaginesurrey')(new Request('http://base.test/imaginesurrey/desk/imagineu'));
    assert.equal(desk.headers.get('location'), '/imaginesurrey/desk/training');
  } finally { wear('base'); }
});

test('Imagine Surrey: training is still called ImagineU, and its page tells the app the old address', async () => {
  wear('imagine-surrey');
  try {
    assert.equal(IS.training.label, 'ImagineU');
    const view = ok(await mgr.get('/api/admin/permissions'));
    assert.equal(view.areas.find((a) => a.key === 'learn').label, 'ImagineU');
    // The page as served (when the app has been built): what App.jsx reads
    // to open the old address on a phone that answers from its kept page.
    const page = (await open('/')).text;
    if (/id="root"/.test(page)) {
      const data = JSON.parse(/<script id="brand-data">window\.__BRAND__=(.*?)<\/script>/.exec(page)[1]);
      assert.deepEqual(data.learnAliases, ['/imagineu']);
      assert.equal(data.learn, 'ImagineU');
    }
  } finally { wear('base'); }
});
