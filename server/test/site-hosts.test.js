// The hosts the site answers on, and the ones it must never take
// (ext/site/public.js, actions.js, store.js): the "one address per page"
// redirect stays on this site whatever the path looks like ('//other.host/'
// is a path here, never another site); the app's own address — the host a
// save comes in on, STARBASE_PUBLIC_URL's, the host's own name
// (RENDER_EXTERNAL_HOSTNAME), base.win — is never saved as a website domain,
// not by a manager and not by someone a manager granted Website; and one
// saved before this check is ignored, so the app can't be locked out of its
// own address (and the save that undoes it still answers there). The
// server's other addresses (APP_HOSTS) are the same; an address people used
// the app at (app_hosts, noted by the API) is refused too, unless the site
// has it already. On a website domain the webhooks and the unsubscribe
// links in emails still answer; a tab, a line break or a backslash in the
// address is the site's 404, never a redirect.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';

process.env.SITE_HOSTS = 'campaign.example.org,site.test';

const { hit, ok, campaign, member } = await import('./site-helpers.js');
const { app } = await import('../index.js');
const { mountAt } = await import('../lib/mount.js');
const { forgetDomains } = await import('../ext/site/store.js');
const { twilioSignature } = await import('../ext/texting/twilio.js');
const { serve } = await import('@hono/node-server');

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

// Back to no domains, whatever a test before left.
const noDomains = async () => {
  await db.query("update site_settings set domains = '[]' where workspace_id = $1", [ws]);
  forgetDomains();
};
const UPSTREAM = 'imagine-surrey-verify.onrender.com'; // the door's upstream (RENDER_EXTERNAL_HOSTNAME)
const OLD = 'starbase.imaginesurrey-verify.example'; // the app's address from before base.win

test('an address people use the app at is never a website domain: the old one, saved from base.win', async () => {
  process.env.STARBASE_PUBLIC_URL = 'https://base.win/imaginesurrey';
  process.env.RENDER_EXTERNAL_HOSTNAME = UPSTREAM;
  try {
    // Someone still opens the app at its old address (a bookmark, a phone's installed app).
    assert.equal((await mgr.get(at(OLD, '/api/auth/me'))).status, 200);
    // A manager at base.win (the door's upstream host) can't make it the website.
    const r = await mgr.post(at(UPSTREAM, '/api/actions/site.settings.save'), { domains: [OLD] });
    assert.equal(r.status, 400, JSON.stringify(r.json));
    assert.match(r.json.error, /^People used base\.win at starbase\.imaginesurrey-verify\.example \(last on [A-Z][a-z]+ \d{1,2}, \d{4}\), so the app still answers there\. If it should now be only the website, ask whoever runs the server to add it to SITE_HOSTS\.$/);
    forgetDomains();
    // The app still answers there: the API, sign-in, Twilio's replies.
    assert.equal((await mgr.get(at(OLD, '/api/auth/me'))).status, 200);
    assert.equal((await hit('/api/auth/login', { host: OLD, method: 'POST', body: { email: 'x@example.org', password: 'whatever-1234' } })).status, 401);
    assert.deepEqual((await hit('/api/public/twilio/sms', { host: OLD, method: 'POST', form: { From: '+16045550100', Body: 'STOP' } })).json, { error: 'bad signature' });
    assert.deepEqual(ok(await mgr.get(at(UPSTREAM, '/api/site'))).settings.domains, [], 'nothing saved');
  } finally {
    delete process.env.STARBASE_PUBLIC_URL;
    delete process.env.RENDER_EXTERNAL_HOSTNAME;
    await noDomains();
  }
});

test('the server’s other addresses (APP_HOSTS) are refused too, and one saved before is ignored', async () => {
  process.env.APP_HOSTS = ' https://Starbase.Old-Campaign.example/ ,second.example.net:443';
  try {
    for (const d of ['starbase.old-campaign.example', 'https://SECOND.example.net/']) {
      const r = await mgr.action('site.settings.save', { domains: ['vote.example.net', d] });
      assert.equal(r.status, 400, d);
      assert.match(r.json.error, /base\.win itself answers/, d);
    }
    const site = ok(await mgr.get('/api/site'));
    assert.deepEqual(site.settings.domains, [], 'nothing saved');
    for (const h of ['starbase.old-campaign.example', 'second.example.net']) assert.ok(site.urls.app_hosts.includes(h), `the screen refuses ${h} as it’s typed`);
    // As a save before this release could have left it: the app answers there, and the undo goes through.
    await db.query('update site_settings set domains = $2 where workspace_id = $1', [ws, JSON.stringify(['starbase.old-campaign.example', 'vote.example.net'])]);
    forgetDomains();
    assert.equal((await mgr.get(at('starbase.old-campaign.example', '/api/auth/me'))).status, 200, 'the app, not the site');
    assert.equal((await hit('/', { host: 'vote.example.net' })).status, 200, 'the campaign’s domain still has the site');
    ok(await mgr.action('site.settings.save', { domains: ['vote.example.net'] }));
  } finally {
    delete process.env.APP_HOSTS;
    await noDomains();
  }
});

test('an address already the site’s stays the site’s: saved before anyone was noted there, or in SITE_HOSTS', async () => {
  try {
    ok(await mgr.action('site.settings.save', { domains: ['vote2.example.net'] }));
    // Someone signed in there in the half minute before the site took it.
    await db.query("insert into app_hosts (host) values ('vote2.example.net'), ('campaign.example.org') on conflict (host) do nothing");
    ok(await mgr.action('site.settings.save', { domains: ['vote2.example.net', 'www.vote2.example.net'] }), 'still the site’s');
    ok(await mgr.action('site.settings.save', { domains: [] }));
    const r = await mgr.action('site.settings.save', { domains: ['vote2.example.net'] });
    assert.equal(r.status, 400, 'taken off, the app answers there again');
    assert.match(r.json.error, /^People used base\.win at vote2\.example\.net \(last on /);
    // SITE_HOSTS is the operator's word that the site has it now.
    ok(await mgr.action('site.settings.save', { domains: ['campaign.example.org'] }));
  } finally {
    await db.query("delete from app_hosts where host in ('vote2.example.net', 'campaign.example.org')");
    await noDomains();
  }
});

test('where the app answers is noted before the answer, once an hour; a note that fails never fails the request', async () => {
  const seen = async (h) => (await db.query('select last_seen from app_hosts where host = $1', [h])).rows[0]?.last_seen || null;
  ok(await mgr.get(at('desk.example.org', '/api/site')));
  assert.ok(await seen('desk.example.org'), 'noted by the API');
  assert.equal(await seen('desk2.example.org'), null);
  ok(await mgr.get(at('desk2.example.org', '/api/auth/me')));
  assert.ok(await seen('desk2.example.org'), 'and by the app’s first call, opening');
  await db.query("update app_hosts set last_seen = now() - interval '2 days' where host = 'desk.example.org'");
  ok(await mgr.get(at('desk.example.org', '/api/site')));
  assert.ok(Date.now() - new Date(await seen('desk.example.org')).getTime() > 86400_000, 'not again within the hour');
  // Never without a sign-in.
  assert.equal((await hit('/api/site', { host: 'nobody.example.org' })).status, 401);
  assert.equal(await seen('nobody.example.org'), null);
  // A note that fails: the request answers all the same, and it is logged once.
  const logged = [];
  const real = console.error;
  await db.query('alter table app_hosts rename to app_hosts_away');
  console.error = (...a) => { logged.push(a.join(' ')); };
  try {
    ok(await mgr.get(at('one.example.org', '/api/site')));
    ok(await mgr.get(at('two.example.org', '/api/site')));
  } finally {
    console.error = real;
    await db.query('alter table app_hosts_away rename to app_hosts');
  }
  assert.equal(logged.filter((l) => /where the app answers/.test(l)).length, 1, logged.join('\n'));
});

test('a note that fails is written by the next request there, not an hour on: the site can’t take the address meanwhile', async () => {
  const OLD2 = 'starbase.old-verify.example';
  const noted = async () => (await db.query('select 1 from app_hosts where host = $1', [OLD2])).rows.length > 0;
  const was = { STARBASE_PUBLIC_URL: process.env.STARBASE_PUBLIC_URL, RENDER_EXTERNAL_HOSTNAME: process.env.RENDER_EXTERNAL_HOSTNAME };
  process.env.STARBASE_PUBLIC_URL = 'https://base.win/imaginesurrey';
  process.env.RENDER_EXTERNAL_HOSTNAME = UPSTREAM;
  const real = console.error;
  try {
    // The one write fails (the database, for a moment)…
    console.error = () => {};
    await db.query('alter table app_hosts rename to app_hosts_away');
    try {
      ok(await mgr.get(at(OLD2, '/api/site')));
    } finally {
      console.error = real;
      await db.query('alter table app_hosts_away rename to app_hosts');
    }
    assert.equal(await noted(), false);
    // …the database is back, and people keep using the app there.
    ok(await mgr.get(at(OLD2, '/api/site')));
    assert.equal(await noted(), true, 'noted by the next request');
    const r = await mgr.post(at(UPSTREAM, '/api/actions/site.settings.save'), { domains: [OLD2] });
    assert.equal(r.status, 400, JSON.stringify(r.json));
    assert.match(r.json.error, /^People used base\.win at starbase\.old-verify\.example \(last on /);
    forgetDomains();
    assert.equal((await mgr.get(at(OLD2, '/api/auth/me'))).status, 200, 'the app still answers there');
  } finally {
    console.error = real;
    for (const [k, v] of Object.entries(was)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await noDomains();
  }
});

test('on a website domain Twilio still reaches base.win: a STOP is never lost', async () => {
  const before = process.env.TWILIO_AUTH_TOKEN;
  process.env.TWILIO_AUTH_TOKEN = 'site-hosts-twilio-token';
  try {
    const fields = { From: '+16045550142', To: '+16045550199', Body: 'STOP', MessageSid: 'SMsitehosts1' };
    const sig = twilioSignature(process.env.TWILIO_AUTH_TOKEN, `http://${SITE}/api/public/twilio/sms`, new URLSearchParams(fields));
    const r = await hit('/api/public/twilio/sms', { host: SITE, method: 'POST', form: fields, headers: { 'x-twilio-signature': sig } });
    assert.equal(r.status, 200, r.text.slice(0, 200));
    assert.match(r.headers.get('content-type'), /text\/xml/);
    const optout = (await db.query('select opted_out from texting_optouts where workspace_id = $1 and phone = $2', [ws, '+16045550142'])).rows[0];
    assert.equal(optout?.opted_out, true, 'the number opted out');
    // Every other address Twilio calls back answers there too: the texting handler's answer, not the site's 404.
    for (const p of ['/sms-status/x', '/voice/tok', '/voice/tok/connect', '/voice-dial/x', '/voice-status/x']) {
      const res = await hit(`/api/public/twilio${p}`, { host: SITE, method: 'POST', form: { CallSid: 'CA1' } });
      assert.deepEqual([res.status, res.json], [403, { error: 'bad signature' }], p);
    }
    // Only those, and only as Twilio and Stripe send them: anything else there is the site's.
    for (const [method, p] of [['GET', '/api/public/twilio/sms'], ['POST', '/api/public/twilio/other'], ['POST', '/api/public/twilio/voice/tok/x'], ['GET', '/stripe/webhook']]) {
      const res = await hit(p, { host: SITE, method });
      assert.equal(res.status, 404, `${method} ${p}`);
      assert.match(res.headers.get('content-type'), /text\/html/, `${method} ${p}: the site’s 404 page`);
    }
  } finally {
    if (before === undefined) delete process.env.TWILIO_AUTH_TOKEN; else process.env.TWILIO_AUTH_TOKEN = before;
  }
});

test('on a website domain the unsubscribe links in emails still work; /r/… there is the site’s referral link', async () => {
  const { id } = ok(await mgr.action('subscription.add', { name: 'Ada Example', email: 'ada@example.org' }));
  const ask = await hit(`/u/${id}`, { host: SITE });
  assert.equal(ask.status, 200);
  assert.match(ask.text, /Unsubscribe from Imagine Surrey\?/);
  const done = await hit(`/u/${id}`, { host: SITE, method: 'POST' });
  assert.equal(done.status, 200);
  assert.match(done.text, /Unsubscribed/);
  assert.equal((await db.query('select status from subscriptions where id = $1', [id])).rows[0].status, 'unsubscribed');
  for (const p of ['/bu/', '/lu/']) {
    const r = await hit(`${p}00000000-0000-4000-8000-000000000000`, { host: SITE });
    assert.equal(r.status, 404, p);
    assert.match(r.text, /This unsubscribe link isn't valid/, `${p}: base.win’s own page, not the site’s 404`);
  }
  // Only a link's own shape: anything else there is the site's.
  const other = await hit('/u/not-a-link', { host: SITE });
  assert.equal(other.status, 404);
  assert.match(other.text, /data-skin=/, 'the site’s 404 page');
  const ref = await hit('/r/abc123', { host: SITE });
  assert.deepEqual([ref.status, ref.location], [302, '/'], 'the site’s referral link, never a receipt');
});

const TRICKY = ['/%09/evil.example/', '/%09%09/evil.example/', '/%09%5Cevil.example/', '/%5C%09/evil.example/',
  '/%0A/evil.example/', '/%0D/evil.example/', '/%0D%0A/evil.example/', '/%0A%09/evil.example/', '/%5C/evil.example/', '/%5C%5Cevil.example/'];

test('the redirect never leaves the site: a tab, a line break or a backslash, encoded, is the site’s 404', async () => {
  const HOST = 'site.test';
  for (const path of [...TRICKY, '//evil.example/', '/\\evil.example/', '///evil.example/', '//evil.example/x/', '/%2F%2Fevil.example/', '/%E2%98%83/']) {
    for (const method of ['GET', 'HEAD']) {
      const r = await hit(path, { host: HOST, method });
      assert.ok([301, 404].includes(r.status), `${method} ${path} → ${r.status}`);
      if (r.location !== null) assert.equal(new URL(r.location, 'http://site.test/').host, HOST, `${method} ${path} → ${JSON.stringify(r.location)}`);
    }
  }
  for (const path of TRICKY) {
    const r = await hit(path, { host: HOST });
    assert.deepEqual([r.status, r.location], [404, null], path);
    assert.match(r.headers.get('content-type'), /text\/html/, `${path}: the site’s 404 page`);
  }
  for (const [path, want] of [['//evil.example/', '/evil.example'], ['/\\evil.example/', '/evil.example'], ['///evil.example/', '/evil.example'], ['//evil.example/x/', '/evil.example/x']]) {
    assert.equal((await hit(path, { host: HOST })).location, want, path);
  }
  // A form sent without JavaScript goes back to its page: on this site too, whatever the page's path.
  for (const referer of ['http://site.test//evil.example', 'http://site.test/\\evil.example/x']) {
    const r = await hit('/api/forms/newsletter', { host: HOST, method: 'POST', form: { email: 'not-an-email' }, headers: { referer } });
    assert.equal(r.status, 303, referer);
    assert.equal(new URL(r.location, 'http://site.test/').host, HOST, `${referer} → ${JSON.stringify(r.location)}`);
  }
  // An ordinary address still loses its slash: here, on the app's /site/, under a client's path.
  assert.equal((await hit('/donate/?a=1', { host: HOST })).location, '/donate?a=1');
  assert.equal((await hit('/site/donate/?a=1')).location, '/site/donate?a=1');
  const tab = await hit('/site/%09/evil.example/');
  assert.deepEqual([tab.status, tab.location], [404, null]);
  const mounted = mountAt(app, '/imaginesurrey');
  const m = await mounted(new Request('http://localhost/imaginesurrey/site/donate/?a=1', { redirect: 'manual', headers: { 'x-forwarded-for': '192.0.2.78' } }));
  assert.equal(m.headers.get('location'), '/imaginesurrey/site/donate?a=1');
});

test('the same through Node’s own server, as the host runs it', async () => {
  const server = await new Promise((resolve) => { const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s)); });
  const ask = (target) => new Promise((resolve, reject) => {
    const s = connect(server.address().port, '127.0.0.1', () => s.write(`GET ${target} HTTP/1.1\r\nHost: site.test\r\nX-Forwarded-For: 192.0.2.79\r\nConnection: close\r\n\r\n`));
    let out = '';
    s.on('data', (d) => { out += d; });
    s.on('end', () => resolve([Number(out.split(' ')[1]), /\r\nlocation: ([^\r]*)/i.exec(out)?.[1] ?? null]));
    s.on('error', reject);
  });
  try {
    assert.deepEqual(await ask('/%09/evil.example/'), [404, null]);
    assert.deepEqual(await ask('/%09%5Cevil.example/'), [404, null]);
    assert.deepEqual(await ask('//evil.example/'), [301, '/evil.example']);
    assert.deepEqual(await ask('/donate/?a=1'), [301, '/donate?a=1']);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});
