// The hosts the site answers on, and the ones it must never take
// (ext/site/public.js, actions.js, store.js): the "one address per page"
// redirect stays on this site whatever the path looks like ('//other.host/'
// is a path here, never another site); the app's own address — the host a
// save comes in on, STARBASE_PUBLIC_URL's, the host's own name
// (RENDER_EXTERNAL_HOSTNAME), base.win — is never saved as a website domain,
// not by a manager and not by someone a manager granted Website; and one
// saved before this check is ignored, so the app can't be locked out of its
// own address (and the save that undoes it still answers there).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.SITE_HOSTS = 'campaign.example.org';

const { hit, ok, campaign, member } = await import('./site-helpers.js');
const { app } = await import('../index.js');
const { mountAt } = await import('../lib/mount.js');
const { forgetDomains } = await import('../ext/site/store.js');

const SITE = 'campaign.example.org';
let db, mgr, ws;
before(async () => {
  ({ db, mgr, ws } = await campaign());
  ok(await mgr.get('/api/site'));
});

test('the trailing-slash redirect never leaves the site: //host/ and /\\host/ are paths here', async () => {
  for (const [path, want] of [
    ['//evil.example/', '/evil.example'],
    ['/\\evil.example/', '/evil.example'],
    ['///evil.example/x/', '/evil.example/x'],
    ['/\\/evil.example/', '/evil.example'],
    ['//', '/'],
    ['/donate/?ref=abc123', '/donate?ref=abc123'],
  ]) {
    const r = await hit(path, { host: SITE });
    assert.equal(r.status, 301, path);
    assert.equal(r.location, want, `${path} → ${r.location}`);
    assert.ok(!/^[/\\]{2}/.test(r.location), `${path}: never protocol-relative`);
  }
  // On the app's own address, and under a client's path, the same.
  assert.equal((await hit('/site//evil.example/')).location, '/site//evil.example');
  const mounted = mountAt(app, '/imaginesurrey');
  const r = await mounted(new Request('http://localhost/imaginesurrey/site//evil.example/', { redirect: 'manual', headers: { 'x-forwarded-for': '192.0.2.77' } }));
  assert.equal(r.headers.get('location'), '/imaginesurrey/site//evil.example');
});

const APP = 'app-review.example.com';
const at = (host, path) => `http://${host}${path}`;

test('the host a save comes in on is refused as a website domain — the app keeps answering there', async () => {
  assert.equal((await mgr.get(at(APP, '/api/auth/me'))).status, 200);
  const r = await mgr.post(at(APP, '/api/actions/site.settings.save'), { domains: [APP] });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /base\.win itself answers/);
  assert.deepEqual(ok(await mgr.get(at(APP, '/api/site'))).settings.domains, [], 'nothing saved');
  assert.equal((await mgr.get(at(APP, '/api/auth/me'))).status, 200, 'still the app there');
  assert.equal((await hit('/api/auth/login', { host: APP, method: 'POST', body: { email: 'x@example.org', password: 'whatever-1234' } })).status, 401, 'sign-in still answers');
});

test('someone granted Website can’t take the app’s address either', async () => {
  const vol = await member(mgr, 'volunteer');
  ok(await mgr.action('permission.member.set', { user_id: vol.id, grant: ['site'], deny: [] }));
  const r = await vol.client.post(at(APP, '/api/actions/site.settings.save'), { domains: [APP] });
  assert.equal(r.status, 400, JSON.stringify(r.json));
  assert.equal((await mgr.get(at(APP, '/api/auth/me'))).status, 200);
  // …while the campaign's own domain saves as before.
  ok(await vol.client.post(at(APP, '/api/actions/site.settings.save'), { domains: ['vote.example.net'] }));
  assert.equal((await hit('/', { host: 'vote.example.net' })).status, 200);
  ok(await mgr.post(at(APP, '/api/actions/site.settings.save'), { domains: [] }));
});

test('the app’s own addresses are refused whichever host the save comes from: STARBASE_PUBLIC_URL, the host’s name, base.win', async () => {
  process.env.STARBASE_PUBLIC_URL = 'https://starbase.imaginesurrey.example/';
  process.env.RENDER_EXTERNAL_HOSTNAME = 'starbase-test.onrender.com';
  try {
    for (const d of ['starbase.imaginesurrey.example', 'https://STARBASE-TEST.onrender.com/', 'base.win', 'imaginesurrey.base.win']) {
      const r = await mgr.action('site.settings.save', { domains: ['vote.example.net', d] });
      assert.equal(r.status, 400, d);
      assert.match(r.json.error, /base\.win itself answers/, d);
    }
    assert.deepEqual(ok(await mgr.get('/api/site')).settings.domains, []);
  } finally {
    delete process.env.STARBASE_PUBLIC_URL;
    delete process.env.RENDER_EXTERNAL_HOSTNAME;
  }
});

test('a domain saved before that is the app’s own is ignored: the app still answers there, and the undo goes through', async () => {
  process.env.RENDER_EXTERNAL_HOSTNAME = 'starbase-test.onrender.com';
  try {
    // As a save before this release could have left it.
    await db.query('update site_settings set domains = $2 where workspace_id = $1', [ws, JSON.stringify(['starbase-test.onrender.com', 'vote.example.net'])]);
    forgetDomains();
    const host = 'starbase-test.onrender.com';
    assert.equal((await mgr.get(at(host, '/api/auth/me'))).status, 200, 'the app, not the site');
    assert.equal((await hit('/', { host: 'vote.example.net' })).status, 200, 'the campaign’s domain still has the site');
    const site = ok(await mgr.get(at(host, '/api/site')));
    assert.deepEqual(site.settings.domains, ['starbase-test.onrender.com', 'vote.example.net'], 'the screen shows it, to be taken off');
    assert.deepEqual(site.urls.app_hosts.includes('starbase-test.onrender.com'), true, 'and says it is the app’s');
    ok(await mgr.post(at(host, '/api/actions/site.settings.save'), { domains: ['vote.example.net'] }));
    assert.deepEqual(ok(await mgr.get('/api/site')).settings.domains, ['vote.example.net']);
    ok(await mgr.action('site.settings.save', { domains: [] }));
  } finally {
    delete process.env.RENDER_EXTERNAL_HOSTNAME;
    forgetDomains();
  }
});
