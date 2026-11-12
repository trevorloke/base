// Share kits (ext/socials/share.js, share-api.js): the desk writes a post
// once; everyone signed in gets their own tracked link (/r/<code>?k=<kit>),
// the friend's sign-up on any page of the site credits the sharer and the
// post, and the desk sees sign-ups per post and the top sharers.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { hit, send, ok, campaign, member, personBy } from './site-helpers.js';
import { kitTitleOf } from '../ext/socials/index.js';
import { goodPath } from '../ext/socials/share.js';

let db, mgr, ws, vol, staff, petition, pledge;
const okA = (r, msg = '') => {
  if (r.status !== 200) throw new Error(`${msg} ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
};
const actionsOf = async (personId) => (await db.query(
  'select * from site_actions where workspace_id = $1 and person_id = $2 order by created_at', [ws, personId],
)).rows;
const setLine = async (line) => {
  const org = okA(await mgr.get('/api/site')).settings.org;
  okA(await mgr.action('site.settings.save', { org: { ...org, authorizationLine: line } }));
};
const cookieOf = (r, name) => {
  const all = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [r.headers.get('set-cookie')].filter(Boolean);
  return all.find((c) => c.startsWith(`${name}=`)) || null;
};

before(async () => {
  ({ db, mgr, ws } = await campaign());
  vol = await member(mgr, 'volunteer', 'Vic Example');
  staff = await member(mgr, 'staff', 'Sia Example');
  const cs = okA(await mgr.get('/api/site/campaigns')).campaigns;
  petition = cs.find((c) => c.kind === 'petition');
  pledge = cs.find((c) => c.kind === 'pledge');
});

test('a kit: a page of the website only, the words fit with the Authorized by line', async () => {
  for (const path of ['//evil.example', 'https://evil.example/', '\\x', '/a\\b', '/ok\nno', 'act/x', '/https://evil.example', '']) {
    const r = await mgr.action('share.kit.save', { title: 'Bad', body: 'Words', path });
    assert.equal(r.status, 400, path);
    assert.equal(r.json.error, 'Pick a page of your website', path);
  }
  assert.equal(goodPath('/'), true);
  assert.equal(goodPath(`/act/${petition.slug}`), true);
  await setLine('Authorized by Pat Example, official agent, 604-555-0100');
  const long = await mgr.action('share.kit.save', { title: 'Long', body: 'x'.repeat(480), path: '/' });
  assert.deepEqual([long.status, long.json.error], [400, 'Too long with the Authorized by line — shorten the words']);
  // Without the line added, the same words fit.
  const fits = okA(await mgr.action('share.kit.save', { title: 'Long', body: 'x'.repeat(480), path: '/', authorized: false }));
  assert.match(fits.kit.code, /^[a-z0-9]{6}$/);
  okA(await mgr.action('share.kit.open', { id: fits.kit.id, open: false }));
  // A volunteer can't write kits; a picture is a desk write too.
  assert.equal((await vol.client.action('share.kit.save', { title: 'V', body: 'v', path: '/' })).status, 403);
  assert.equal((await vol.client.action('share.picture', { data: 'x' })).status, 403);
});

let kit;
test('share.me: one link per person, made once — even for a role denied Outreach', async () => {
  okA(await mgr.action('permission.role.set', { role: 'volunteer', grant: [], deny: ['outreach'] }));
  const a = okA(await vol.client.action('share.me', {}));
  const b = okA(await vol.client.action('share.me', {}));
  assert.match(a.code, /^[a-z0-9]{8}$/);
  assert.equal(b.code, a.code, 'a second call gives the same code');
  const [me] = await personBy(db, ws, 'lower(email) = $2', [vol.email.toLowerCase()]);
  assert.equal(me.attrs.ref_code, a.code);
  assert.equal((await personBy(db, ws, 'lower(email) = $2', [vol.email.toLowerCase()])).length, 1);
  // Still their own link on /share with Outreach denied.
  const s = okA(await vol.client.get('/api/share'));
  assert.equal(s.code, a.code);
  okA(await mgr.action('permission.role.set', { role: 'volunteer', grant: [], deny: [] }));
});

test('/share: the words carry the authorization line only when the kit says so', async () => {
  kit = okA(await mgr.action('share.kit.save', { title: 'Sign for SkyTrain', body: 'I signed. Will you?', path: `/act/${petition.slug}` })).kit;
  const plain = okA(await mgr.action('share.kit.save', { title: 'Home', body: 'Have a look', path: '/', authorized: false })).kit;
  const s = okA(await vol.client.get('/api/share'));
  assert.equal(s.base, 'http://localhost/site');
  const k = s.kits.find((x) => x.id === kit.id);
  assert.equal(k.text, 'I signed. Will you?\nAuthorized by Pat Example, official agent, 604-555-0100');
  assert.equal(k.page_title, petition.title);
  assert.equal(k.link, `http://localhost/site/r/${s.code}?k=${kit.code}`);
  assert.equal(s.kits.find((x) => x.id === plain.id).text, 'Have a look');
  assert.equal(s.kits.some((x) => x.title === 'Long'), false, 'a stopped kit is not offered');
  assert.deepEqual(s.kits.map((x) => x.id).slice(0, 2), [plain.id, kit.id], 'newest first');
  // No line set: nothing added.
  await setLine('');
  assert.equal(okA(await vol.client.get('/api/share')).kits.find((x) => x.id === kit.id).text, 'I signed. Will you?');
  await setLine('Authorized by Pat Example, official agent, 604-555-0100');
  // The brief says how many are waiting.
  assert.equal(okA(await vol.client.get('/api/brief')).share.kits, 2);
});

test('/r/:code?k=: every row of the table — cookies and where it goes', async () => {
  const code = okA(await vol.client.get('/api/share')).code;
  const page = `/site/act/${petition.slug}?source=kit-${kit.code}`;
  // Known person, valid kit.
  const a = await hit(`/site/r/${code}?k=${kit.code}`);
  assert.deepEqual([a.status, a.location], [302, page]);
  assert.equal(a.headers.get('cache-control'), 'no-store');
  assert.match(cookieOf(a, 'site_ref'), new RegExp(`^site_ref=${code};`));
  const src = cookieOf(a, 'site_src');
  assert.match(src, new RegExp(`^site_src=kit-${kit.code};`));
  assert.match(src, /Max-Age=2592000/);
  assert.match(src, /Path=\/site(;|$)/, 'the cookie is the site root’s');
  assert.match(src, /HttpOnly/);
  // Unknown person, valid kit.
  const b = await hit(`/site/r/zzzzzzzz?k=${kit.code}`);
  assert.deepEqual([b.location, cookieOf(b, 'site_ref'), Boolean(cookieOf(b, 'site_src'))], [page, null, true]);
  // Known person, no kit or not a kit.
  for (const q of ['', '?k=nokit1', '?k=../../x']) {
    const c = await hit(`/site/r/${code}${q}`);
    assert.deepEqual([c.location, Boolean(cookieOf(c, 'site_ref')), cookieOf(c, 'site_src')], ['/site/', true, null], q);
  }
  // Unknown person, no kit.
  const d = await hit('/site/r/zzzzzzzz?k=nokit1');
  assert.deepEqual([d.location, d.headers.get('set-cookie')], ['/site/', null]);
  // A stopped kit's link still opens its page.
  const stopped = okA(await mgr.action('share.kit.save', { title: 'Stopped', body: 'Old post', path: `/act/${pledge.slug}` })).kit;
  okA(await mgr.action('share.kit.open', { id: stopped.id, open: false }));
  const e = await hit(`/site/r/${code}?k=${stopped.code}`);
  assert.equal(e.location, `/site/act/${pledge.slug}?source=kit-${stopped.code}`);
});

test('a friend who came by a kit and signs on another page: the sharer and the post are credited', async () => {
  const code = okA(await vol.client.get('/api/share')).code;
  const cookies = `site_ref=${code}; site_src=kit-${kit.code}`;
  // They looked around, came back by the menu (no ?source= now) and signed.
  ok(await send('petition', { first_name: 'Fay', last_name: 'Example', email: 'fay@example.org', campaign: petition.id }, { headers: { cookie: cookies } }));
  const [fay] = await personBy(db, ws, "lower(email) = 'fay@example.org'");
  const [vp] = await personBy(db, ws, 'lower(email) = $2', [vol.email.toLowerCase()]);
  const [a] = await actionsOf(fay.id);
  assert.deepEqual([a.source, a.referrer_id], [`kit-${kit.code}`, vp.id]);
  // A form that sends its own source keeps it.
  ok(await send('newsletter', { email: 'gus@example.org', consent_email: true, source: 'share-whatsapp' }, { headers: { cookie: cookies } }));
  const [gus] = await personBy(db, ws, "lower(email) = 'gus@example.org'");
  assert.deepEqual([(await actionsOf(gus.id))[0].source, (await actionsOf(gus.id))[0].referrer_id], ['share-whatsapp', vp.id]);
  // Something that isn't a kit in the cookie is ignored.
  ok(await send('newsletter', { email: 'hal@example.org', consent_email: true }, { headers: { cookie: 'site_src=evil<script>' } }));
  const [hal] = await personBy(db, ws, "lower(email) = 'hal@example.org'");
  assert.equal((await actionsOf(hal.id))[0].source, null);

  // The volunteer's number, and the desk's counts.
  assert.equal(okA(await vol.client.get('/api/share')).brought, 2);
  const kits = okA(await mgr.get('/api/share/kits'));
  const k = kits.kits.find((x) => x.id === kit.id);
  assert.deepEqual([k.signups, k.sharers, k.live], [1, 1, true]);
  assert.equal(kits.line, 'Authorized by Pat Example, official agent, 604-555-0100');
  assert.ok(kits.pages.some((p) => p.path === `/act/${petition.slug}`));
  assert.deepEqual(kits.pages[0], { path: '/', title: 'Home' });
  const one = okA(await mgr.get(`/api/share/kits/${kit.id}`));
  assert.deepEqual(one.top, [{ id: vp.id, name: vp.name, signups: 1 }]);
});

test('/share/top orders by people brought in; a closed petition’s kit is not live and leaves /share', async () => {
  // Someone else brings in three.
  const [other] = await personBy(db, ws, "lower(email) = 'fay@example.org'");
  const code = (await personBy(db, ws, 'id = $2', [other.id]))[0].attrs.ref_code;
  for (const e of ['i1@example.org', 'i2@example.org', 'i3@example.org']) {
    ok(await send('newsletter', { email: e, consent_email: true, ref: code }));
  }
  const top = okA(await mgr.get('/api/share/top')).top;
  assert.deepEqual(top.map((t) => t.n), [3, 2]);
  assert.equal(top[0].id, other.id);

  okA(await mgr.action('site.campaign.close', { id: petition.id }));
  const k = okA(await mgr.get('/api/share/kits')).kits.find((x) => x.id === kit.id);
  assert.equal(k.live, false);
  assert.equal(okA(await vol.client.get('/api/share')).kits.some((x) => x.id === kit.id), false);
  okA(await mgr.action('site.campaign.close', { id: petition.id, open: true }));
});

test('who may read: a volunteer gets 403 on the desk reads; staff denied Outreach too, but still their own /share', async () => {
  for (const p of ['/api/share/kits', `/api/share/kits/${kit.id}`, '/api/share/top']) {
    assert.equal((await vol.client.get(p)).status, 403, p);
  }
  // Granted Outreach, a volunteer reads them.
  okA(await mgr.action('permission.member.set', { user_id: vol.id, grant: ['outreach'], deny: [] }));
  assert.equal((await vol.client.get('/api/share/kits')).status, 200);
  okA(await mgr.action('permission.member.set', { user_id: vol.id, grant: [], deny: [] }));

  okA(await mgr.action('permission.member.set', { user_id: staff.id, grant: [], deny: ['outreach'] }));
  assert.equal((await staff.client.get('/api/share/kits')).status, 403);
  assert.equal((await staff.client.get('/api/share/top')).status, 403);
  assert.equal((await staff.client.get('/api/share')).status, 200);
  assert.equal((await staff.client.action('share.kit.save', { title: 'S', body: 's', path: '/' })).status, 403);
  assert.equal((await staff.client.action('share.me', {})).status, 200);
  okA(await mgr.action('permission.member.set', { user_id: staff.id, grant: [], deny: [] }));
});

test('the form answer carries ref_code for a new person, never a matched one’s', async () => {
  const fresh = ok(await send('petition', { first_name: 'Ida', last_name: 'Example', email: 'ida@example.org', campaign: petition.id }));
  const [ida] = await personBy(db, ws, "lower(email) = 'ida@example.org'");
  assert.equal(fresh.ref_code, ida.attrs.ref_code);
  assert.match(fresh.ref_code, /^[a-z0-9]{6,16}$/);
  // The same email again (anyone could type it): never her code — one of the
  // same shape that is nobody's, so the answer doesn't say she's on file.
  const again = ok(await send('newsletter', { email: 'ida@example.org', consent_email: true }));
  assert.deepEqual(Object.keys(again).sort(), ['ok', 'ref_code']);
  assert.notEqual(again.ref_code, ida.attrs.ref_code);
  assert.match(again.ref_code, /^[a-z0-9]{8}$/);
  assert.equal((await personBy(db, ws, "attrs->>'ref_code' = $2", [again.ref_code])).length, 0, 'nobody’s');
  // Sent through it, a friend's sign-up credits nobody.
  ok(await send('newsletter', { email: 'jo@example.org', consent_email: true, ref: again.ref_code }));
  const [jo] = await personBy(db, ws, "lower(email) = 'jo@example.org'");
  assert.equal((await actionsOf(jo.id))[0].referrer_id, null);
});

test('a kit pointing at /home is not live: the website has no page there', async () => {
  const k = okA(await mgr.action('share.kit.save', { title: 'Home by name', body: 'Look', path: '/home' })).kit;
  const row = okA(await mgr.get('/api/share/kits')).kits.find((x) => x.id === k.id);
  assert.equal(row.live, false);
  assert.equal((await hit('/site/home')).status, 404);
  assert.equal(okA(await vol.client.get('/api/share')).kits.some((x) => x.id === k.id), false);
  okA(await mgr.action('share.kit.open', { id: k.id, open: false }));
});

test('kitTitleOf: the title for kit-<code>, else null', async () => {
  assert.equal(await kitTitleOf(db, ws, `kit-${kit.code}`), 'Sign for SkyTrain');
  assert.equal(await kitTitleOf(db, ws, 'kit-zzzzzz'), null);
  assert.equal(await kitTitleOf(db, ws, 'share-whatsapp'), null);
  assert.equal(await kitTitleOf(db, ws, null), null);
});

test('the website never set up: /share says so', async () => {
  const other = await campaign('Another Example');
  // A fresh campaign's site isn't made until someone opens it.
  await other.db.query('delete from site_settings where workspace_id = $1', [other.ws]);
  assert.deepEqual(okA(await other.mgr.get('/api/share')), { ready: false });
});
