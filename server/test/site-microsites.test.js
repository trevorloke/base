// The campaign's other websites (ext/site microsites.js, SITE.md "Other
// websites"): a site on a domain of its own, with its own name, look and
// pages, whose forms land in the same people database. Its domain answers
// with it; a draft or offline one says "Coming soon"; a domain it stopped
// using (or a deleted site's) says "This website has closed" on every route
// and never reaches the app, until a manager releases it. Every page names
// the main organization (© and "Authorized by …") and links back; every
// form carries the privacy line. Managers alone create, take live, set
// domains, delete, restore and release; someone granted Website edits pages
// and looks. A form there records the site and the source (utm_source
// too), and the People filter and History know the site.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.SITE_HOSTS;
const helpers = await import('./site-helpers.js');
const { send, ok, campaign, member, personBy } = helpers;
// React's text joins (<!-- -->) out, so a line reads as people see it.
const hit = async (...a) => { const r = await helpers.hit(...a); return { ...r, text: r.text.replace(/<!-- -->/g, '') }; };
const { Client } = await import('./helpers.js');
const { forgetDomains } = await import('../ext/site/store.js');

const MAIN = 'main.example.org';
const DOUG = 'dougdidnt.example';
const ORG = 'Harbour City Together';
const AUTH = 'Authorized by Ada Example, 604-555-0100';
let db, mgr, ws, site, home, staff, settings;

const fresh = () => forgetDomains();
const act = async (who, name, input) => who.action(name, input);
const saveOrg = async (patch) => {
  settings = ok(await mgr.get('/api/site')).settings;
  return ok(await act(mgr, 'site.settings.save', { org: { ...settings.org, ...patch } }));
};
const count = (s, re) => (s.match(re) || []).length;

before(async () => {
  ({ db, mgr, ws } = await campaign(ORG));
  settings = ok(await mgr.get('/api/site')).settings;
  ok(await act(mgr, 'site.settings.save', { domains: [MAIN], org: { ...settings.org, name: ORG, shortName: '' } }));
  staff = await member(mgr, 'staff', 'Sam Example');
  ok(await mgr.action('permission.member.set', { user_id: staff.id, grant: ['site'], deny: [] }));
});

test('a manager makes a website: a draft with its own key, a copy of the look, and a home page', async () => {
  const r = ok(await act(mgr, 'site.microsite.create', { name: 'Doug Didn’t Example', domain: `https://${DOUG}/` }));
  site = r.microsite;
  assert.equal(site.key, 'doug-didnt-example');
  assert.equal(site.status, 'draft');
  assert.deepEqual(site.domains, [DOUG]);
  assert.equal(site.theme.follow, false);
  home = (await db.query('select * from site_pages where site_id = $1', [site.id])).rows;
  assert.equal(home.length, 1);
  assert.equal(home[0].slug, 'home');
  // A hero with its name, then the newest open petition (else the newsletter).
  const newest = (await db.query("select id from site_campaigns where workspace_id = $1 and deleted_at is null and status = 'open' and kind = 'petition' order by created_at desc, id limit 1", [ws])).rows[0];
  const mods = home[0].draft.modules;
  assert.deepEqual(mods.map((m) => m.kind), ['hero', newest ? 'petition' : 'newsletter']);
  assert.equal(mods[0].props.titlePrefix, 'Doug Didn’t Example');
  if (newest) assert.equal(mods[1].props.campaign, newest.id);
  home = home[0];
  // The main site's list of pages is the main site's only.
  assert.ok(!ok(await mgr.get('/api/site')).pages.some((p) => p.id === home.id));
});

test('only a manager decides: staff with Website get 403 on create, name, domains, live, delete, restore and release — and edit pages and the look', async () => {
  const c = staff.client;
  for (const [name, input] of [
    ['site.microsite.create', { name: 'Other' }],
    ['site.microsite.save', { id: site.id, name: 'Renamed' }],
    ['site.microsite.domains', { id: site.id, domains: [] }],
    ['site.microsite.live', { id: site.id, live: true }],
    ['site.microsite.delete', { id: site.id }],
    ['site.microsite.restore', { id: site.id }],
    ['site.microsite.release', { id: site.id }],
  ]) {
    const r = await act(c, name, input);
    assert.equal(r.status, 403, name);
    assert.equal(r.json.error, 'Only a manager can do this', name);
  }
  const look = ok(await act(c, 'site.microsite.save', { id: site.id, theme: { ...site.theme, radius: 'round' } }));
  assert.equal(look.microsite.name, 'Doug Didn’t Example');
  const page = ok(await act(c, 'site.page.create', { title: 'About Doug', site_id: site.id }));
  assert.equal(page.page.slug, 'about-doug');
  ok(await act(c, 'site.page.delete', { id: page.page.id }));
  // A volunteer without the area: nothing.
  const vol = await member(mgr, 'volunteer');
  assert.equal((await act(vol.client, 'site.microsite.save', { id: site.id, theme: site.theme })).status, 403);
});

test('a draft says "Coming soon" on its domain, with the authorization line and noindex; the preview still works there', async () => {
  await saveOrg({ agentName: 'Ada Example', agentContact: '604-555-0100' });
  fresh();
  for (const [path, method] of [['/', 'GET'], ['/anything', 'GET'], ['/api/forms/newsletter', 'POST']]) {
    const r = await hit(path, { host: DOUG, method, body: method === 'POST' ? { email: 'x@example.org', consent_email: true } : undefined });
    assert.equal(r.status, 200, path);
    assert.match(r.text, /Coming soon/);
    assert.match(r.text, /Doug Didn’t Example/);
    assert.ok(r.text.includes(AUTH), 'Authorized by');
    assert.match(r.headers.get('x-robots-tag'), /noindex/);
    assert.equal(r.headers.get('cache-control'), 'no-store');
  }
  assert.equal((await personBy(db, ws, 'email = $2', ['x@example.org'])).length, 0, 'nothing kept from a draft');
  // The preview of its draft home, at its address on the app.
  const t = ok(await mgr.post('/api/site/preview-token', { pageId: home.id }));
  assert.match(t.url, new RegExp(`/site/sites/${site.key}/__preview/${home.id}`));
  const u = new URL(t.url, 'http://localhost');
  const pv = await hit(u.pathname + u.search);
  assert.equal(pv.status, 200);
  assert.match(pv.text, /Doug Didn’t Example/);
  // A main-site page's token at this site's preview: refused.
  const mainHome = ok(await mgr.get('/api/site')).pages.find((p) => p.slug === 'home');
  const mt = ok(await mgr.post('/api/site/preview-token', { pageId: mainHome.id }));
  const q = new URL(mt.url, 'http://localhost').search;
  assert.equal((await hit(`/site/sites/${site.key}/__preview/${mainHome.id}${q}`)).status, 403);
});

test('going live is refused with the first thing missing, in the checklist’s order', async () => {
  await saveOrg({ agentName: '', agentContact: '', privacyUrl: '' });
  const live = () => act(mgr, 'site.microsite.live', { id: site.id, live: true });
  let r = await live();
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'Publish the home page first');
  ok(await act(mgr, 'site.page.publish', { id: home.id }));
  r = await live();
  assert.equal(r.json.error, 'Add who authorized it: Website → Settings → Organization → Authorized by');
  await saveOrg({ agentName: 'Ada Example', agentContact: '604-555-0100' });
  r = await live();
  assert.equal(r.json.error, 'Add your privacy policy link: Website → Settings → Organization');
  await saveOrg({ privacyUrl: '/privacy' });
  assert.equal(ok(await live()).microsite.status, 'live');
});

test('routing: its domain is its home; the main domain the main home; an unknown host the app; /site/sites/<key>/ on the app address', async () => {
  fresh();
  const d = await hit('/', { host: DOUG });
  assert.equal(d.status, 200);
  assert.match(d.text, /<span class="wordmark">Doug Didn’t Example<\/span>/);
  assert.match(d.text, /<title>Doug Didn’t Example<\/title>/);
  const m = await hit('/', { host: MAIN });
  assert.equal(m.status, 200);
  assert.ok(!m.text.includes('Doug Didn’t'), 'the main home');
  // Asked again, each host still gets its own (never the other's kept page).
  assert.ok((await hit('/', { host: DOUG })).text.includes('wordmark">Doug Didn’t'));
  assert.ok(!(await hit('/', { host: MAIN })).text.includes('Doug Didn’t'));
  const app = await hit('/api/auth/me', { host: 'nobody.example.net' });
  assert.equal(app.status, 401, 'the app answers an unknown host');
  const k = await hit(`/site/sites/${site.key}/`);
  assert.equal(k.status, 200);
  assert.match(k.text, /wordmark">Doug Didn’t Example/);
  assert.match(k.headers.get('x-robots-tag') || '', /noindex/, 'the app’s copy of a site with a domain');
  // Its own pages only; the main site's news, list and choices are its 404.
  for (const p of ['/news', '/act', '/preferences', '/unsubscribe', '/privacy']) assert.equal((await hit(p, { host: DOUG })).status, 404, p);
  assert.equal((await hit(`/site/sites/no-such-site/`)).status, 404);
});

test('every page of it names the main organization, links back, and draws the authorization line; every form one privacy line', async () => {
  const petition = ok(await act(mgr, 'site.campaign.save', { kind: 'petition', title: 'Fix the Example Bridge', statement: 'Fix it.' })).campaign;
  for (const path of ['/', '/no-such-page', `/act/${petition.slug}`]) {
    const r = await hit(path, { host: DOUG });
    assert.ok(r.text.includes(AUTH), `${path}: Authorized by`);
    assert.match(r.text, new RegExp(`© \\d{4} ${ORG}`), `${path}: © the organization`);
    assert.match(r.text, new RegExp(`A website by <a href="https://${MAIN}">${ORG}</a>`), `${path}: the link back`);
    const forms = count(r.text, /<form /g);
    assert.equal(count(r.text, /class="form-small"/g), forms, `${path}: one small print per form`);
    assert.equal(count(r.text, />Privacy policy</g), forms, `${path}: one privacy link per form`);
    if (forms) {
      assert.ok(r.text.includes(`${ORG} keeps what you send to stay in touch about our work and elections. <a href="https://${MAIN}/privacy">Privacy policy</a>`), path);
    }
  }
  const act2 = await hit(`/act/${petition.slug}`, { host: DOUG });
  assert.ok(act2.text.includes(`<link rel="canonical" href="https://${MAIN}/act/${petition.slug}">`));
  // The main site: the same lines, its own privacy link.
  const main = await hit('/', { host: MAIN });
  assert.ok(main.text.includes(AUTH));
  if (count(main.text, /<form /g)) assert.ok(main.text.includes(`${ORG} keeps what you send`));
});

test('a form on it: one site_actions row with its site, the same person as on the main site, the main organization’s consent words, the source from utm_source, and a referral credited', async () => {
  const email = 'pat.example@example.org';
  ok(await send('newsletter', { email, first_name: 'Pat', consent_email: true }, { host: MAIN, root: '' }));
  const pat = (await personBy(db, ws, 'email = $2', [email]))[0];
  // The island's post (JSON) from a link with ?utm_source=flyer, no source of its own.
  ok(await hit('/api/forms/newsletter?utm_source=flyer', { host: DOUG, method: 'POST', body: { email, consent_email: true } }));
  assert.equal((await personBy(db, ws, 'email = $2', [email])).length, 1, 'one person');
  const rows = (await db.query('select * from site_actions where person_id = $1 order by created_at', [pat.id])).rows;
  assert.deepEqual(rows.map((r) => r.site_id), [null, site.id]);
  assert.equal(rows[1].source, 'flyer');
  const ev = (await db.query("select payload from events where entity_type = 'site_action' and entity_id = $1", [rows[1].id])).rows[0];
  assert.equal(ev.payload.site_id, site.id);
  const words = (await db.query('select wording from consent_events where person_id = $1 order by created_at desc limit 1', [pat.id])).rows[0];
  assert.match(words.wording, new RegExp(ORG));
  // A plain post (no JavaScript) from a page opened with ?utm_source=door-hanger.
  const r = await hit('/api/forms/newsletter', {
    host: DOUG, method: 'POST', form: { email: 'lee.example@example.org', consent_email: 'on' },
    headers: { referer: `http://${DOUG}/?utm_source=door-hanger` },
  });
  assert.equal(r.status, 303);
  const lee = (await db.query("select a.source, a.site_id from site_actions a join persons p on p.id = a.person_id where p.email = 'lee.example@example.org'")).rows[0];
  assert.deepEqual([lee.source, lee.site_id], ['door-hanger', site.id]);
  // A source beats utm_source.
  ok(await hit('/api/forms/newsletter?utm_source=flyer', { host: DOUG, method: 'POST', body: { email: 'kim.example@example.org', consent_email: true, source: 'share-x' } }));
  assert.equal((await db.query("select a.source from site_actions a join persons p on p.id = a.person_id where p.email = 'kim.example@example.org'")).rows[0].source, 'share-x');
  // /r/:code on it: remembered, then credited.
  const code = (await db.query("select attrs->>'ref_code' as c from persons where id = $1", [pat.id])).rows[0].c;
  assert.ok(code);
  const rr = await hit(`/r/${code}`, { host: DOUG });
  assert.equal(rr.status, 302);
  const cookie = rr.headers.get('set-cookie').split(';')[0];
  ok(await hit('/api/forms/newsletter', { host: DOUG, method: 'POST', body: { email: 'new.example@example.org', consent_email: true }, headers: { cookie } }));
  const n = (await db.query("select a.referrer_id from site_actions a join persons p on p.id = a.person_id where p.email = 'new.example@example.org'")).rows[0];
  assert.equal(n.referrer_id, pat.id);
});

test('the People filter web=site:<id> and History know the site; a volunteer never finds people by the money forms there', async () => {
  const names = async (who, qs) => ok(await who.get(`/api/persons?limit=200&${qs}`)).persons.map((p) => p.email).sort();
  assert.ok((await names(mgr, `web=site:${site.id}`)).includes('pat.example@example.org'));
  const offered = ok(await mgr.get('/api/webdid')).sites;
  assert.deepEqual(offered.map((s) => [s.id, s.label]), [[site.id, `Did something on ${DOUG}`]]);
  // Someone who only filled in the donation form there.
  const gift = await mgr.createPerson('Gift Example', { email: 'gift.example@example.org' });
  await db.query(`insert into site_actions (id, workspace_id, person_id, kind, site_id) values (gen_random_uuid(), $1, $2, 'donate', $3)`, [ws, gift.id, site.id]);
  const vol = await member(mgr, 'volunteer', 'Val Example');
  assert.ok(!(await names(vol.client, `web=site:${site.id}`)).includes('gift.example@example.org'));
  assert.ok(!(await names(mgr, `web=site:${site.id}`)).includes('gift.example@example.org'));
  const pat = (await personBy(db, ws, "email = 'pat.example@example.org'"))[0];
  const titles = ok(await mgr.get(`/api/persons/${pat.id}/timeline?limit=100`)).entries.map((e) => e.title);
  assert.ok(titles.includes(`Signed up for the newsletter on ${DOUG}`), titles.join(' | '));
  assert.ok(titles.includes('Signed up for the newsletter'), 'the main site’s says no site');
});

test('the desk reads: counts and sources, never people; money forms only for those with Donations; a volunteer gets 403', async () => {
  const list = ok(await mgr.get('/api/site/microsites'));
  const row = list.microsites.find((m) => m.id === site.id);
  // pat (flyer), lee (door-hanger), kim (share-x), new (no source), gift (donate).
  assert.deepEqual([row.signups_7, row.signups_30, row.status], [5, 5, 'live']);
  assert.equal(row.home.status, 'published');
  const one = ok(await mgr.get(`/api/site/microsites/${site.id}`));
  assert.deepEqual([one.signups_7, one.signups_30], [5, 5]);
  assert.deepEqual(one.sources.map((s) => [s.source, s.n]), [['direct', 2], ['door-hanger', 1], ['flyer', 1], ['share-x', 1]]);
  assert.deepEqual(one.checklist.map((x) => [x.key, x.done]), [['home', true], ['authorized', true], ['privacy', true]]);
  assert.equal(one.urls.site.endsWith(`/site/sites/${site.key}/`), true);
  assert.equal(one.pages[0].site_id, site.id);
  // Staff with Website but not Donations: the donation isn't counted.
  const noMoney = await member(mgr, 'staff', 'Noa Example');
  ok(await mgr.action('permission.member.set', { user_id: noMoney.id, grant: ['site'], deny: ['money'] }));
  const theirs = ok(await noMoney.client.get(`/api/site/microsites/${site.id}`));
  assert.deepEqual([theirs.signups_7, theirs.signups_30], [4, 4]);
  assert.deepEqual(theirs.sources.find((s) => s.source === 'direct').n, 1);
  assert.equal(ok(await noMoney.client.get('/api/site/microsites')).microsites.find((m) => m.id === site.id).signups_7, 4);
  // Counts, never people: no email, name or person id anywhere in either answer.
  const all = JSON.stringify([list, one]);
  for (const bad of ['pat.example', 'person_id', 'email', 'first_name']) assert.ok(!all.includes(bad), bad);
  // The address check speaks the save's own words.
  assert.equal(ok(await mgr.get(`/api/site/microsites/host?host=${MAIN}`)).why, `${MAIN} is your main website’s address`);
  assert.equal(ok(await mgr.get(`/api/site/microsites/host?host=${DOUG}&id=${site.id}`)).why, null);
  assert.match(ok(await mgr.get(`/api/site/microsites/host?host=${DOUG}`)).why, /is the address of/);
  // The Overview's row.
  assert.deepEqual([ok(await mgr.get('/api/site')).counts.microsites_live >= 1], [true]);
  const vol = await member(mgr, 'volunteer', 'Vic Example');
  assert.equal((await vol.client.get('/api/site/microsites')).status, 403);
  assert.equal((await vol.client.get(`/api/site/microsites/${site.id}`)).status, 403);
});

test('slugs live within their own website; reorder refuses two websites; restore frees within its own', async () => {
  const mainAbout = ok(await act(mgr, 'site.page.create', { title: 'Shared Name', slug: 'shared-name' })).page;
  const microAbout = ok(await act(mgr, 'site.page.create', { title: 'Shared Name', slug: 'shared-name', site_id: site.id })).page;
  assert.equal(microAbout.slug, 'shared-name');
  assert.equal((await act(mgr, 'site.page.create', { title: 'Again', slug: 'shared-name', site_id: site.id })).status, 409);
  const r = await act(mgr, 'site.page.reorder', { ids: [mainAbout.id, microAbout.id] });
  assert.equal(r.status, 400);
  ok(await act(mgr, 'site.page.delete', { id: microAbout.id }));
  const again = ok(await act(mgr, 'site.page.create', { title: 'Shared Name', slug: 'shared-name', site_id: site.id })).page;
  const back = ok(await act(mgr, 'site.page.restore', { id: microAbout.id })).page;
  assert.equal(back.slug, 'shared-name-2', 'its own site’s address was taken');
  assert.equal(again.slug, 'shared-name');
  const dup = ok(await act(mgr, 'site.page.duplicate', { id: again.id })).page;
  assert.equal((await db.query('select site_id from site_pages where id = $1', [dup.id])).rows[0].site_id, site.id);
  // A page of a website that is gone: 404.
  assert.equal((await act(mgr, 'site.page.create', { title: 'X', site_id: '00000000-0000-4000-8000-000000000000' })).status, 404);
});

test('domains: the app’s, one people used the app at, SITE_HOSTS, the main site’s, another site’s and a non-www second are refused — and the main save refuses a site’s', async () => {
  const other = ok(await act(mgr, 'site.microsite.create', { name: 'Second Example' })).microsite;
  const dom = (domains) => act(mgr, 'site.microsite.domains', { id: other.id, domains });
  await db.query("insert into app_hosts (host) values ('used.example.net') on conflict do nothing");
  const cases = [
    [['app.base.win'], /base\.win itself answers/],
    [['used.example.net'], /People used base\.win at used\.example\.net/],
    [[MAIN], /your main website’s address/],
    [[DOUG], /is the address of Doug Didn’t Example/],
    [['a.example.org', 'b.example.org'], /The second address must be the www\. of the first/],
  ];
  for (const [d, re] of cases) {
    const r = await dom(d);
    assert.equal(r.status, 400, d.join());
    assert.match(r.json.error, re);
  }
  process.env.SITE_HOSTS = 'env.example.org';
  try {
    assert.match((await dom(['env.example.org'])).json.error, /main website’s address/);
  } finally { delete process.env.SITE_HOSTS; }
  assert.deepEqual(ok(await dom(['second.example', 'www.second.example'])).microsite.domains, ['second.example', 'www.second.example']);
  const main = await act(mgr, 'site.settings.save', { domains: [MAIN, 'second.example'] });
  assert.equal(main.status, 400);
  assert.match(main.json.error, /is the address of Second Example/);
  ok(await act(mgr, 'site.microsite.delete', { id: other.id }));
});

test('a closed address never reaches the app: a deleted site’s, and one a live site dropped — until it is released', async () => {
  fresh();
  const notedBefore = (await db.query('select count(*)::int as n from app_hosts')).rows[0].n;
  for (const host of ['second.example', 'www.second.example']) {
    for (const [path, method] of [['/', 'GET'], ['/login', 'GET'], ['/api/forms/newsletter', 'POST'], ['/api/me', 'GET'], ['/api/auth/me', 'GET']]) {
      const r = await hit(path, { host, method, body: method === 'POST' ? { email: 'z@example.org', consent_email: true } : undefined });
      assert.equal(r.status, 410, `${host}${path}`);
      assert.match(r.text, /This website has closed/);
      assert.ok(r.text.includes(AUTH));
      assert.ok(r.text.includes(`A website by <a href="https://${MAIN}">${ORG}</a>`));
      assert.match(r.headers.get('x-robots-tag'), /noindex/);
      assert.equal(r.headers.get('cache-control'), 'no-store');
    }
  }
  assert.equal((await db.query('select count(*)::int as n from app_hosts')).rows[0].n, notedBefore, 'never noted as the app’s');
  assert.equal((await personBy(db, ws, "email = 'z@example.org'")).length, 0);
  // What the services call back still answers there.
  assert.notEqual((await hit('/media/00000000-0000-4000-8000-000000000000', { host: 'second.example' })).status, 410);
  // A live site that moves: its old address is closed.
  ok(await act(mgr, 'site.microsite.domains', { id: site.id, domains: ['dougdidnt2.example'] }));
  fresh();
  assert.equal((await hit('/', { host: DOUG })).status, 410);
  assert.equal((await hit('/', { host: 'dougdidnt2.example' })).status, 200);
  let row = (await db.query('select held_domains from microsites where id = $1', [site.id])).rows[0];
  assert.deepEqual(row.held_domains, [DOUG]);
  // Taken back onto the same site: no longer held.
  ok(await act(mgr, 'site.microsite.domains', { id: site.id, domains: [DOUG] }));
  row = (await db.query('select domains, held_domains from microsites where id = $1', [site.id])).rows[0];
  assert.deepEqual([row.domains, row.held_domains], [[DOUG], ['dougdidnt2.example']]);
  // Released: unknown to base.win, so the app answers there.
  const rel = ok(await act(mgr, 'site.microsite.release', { id: site.id }));
  assert.deepEqual(rel.released, ['dougdidnt2.example']);
  fresh();
  assert.equal((await hit('/api/auth/me', { host: 'dougdidnt2.example' })).status, 401);
});

test('a held address of this campaign can go to another of its sites; another campaign’s held address is refused', async () => {
  const third = ok(await act(mgr, 'site.microsite.create', { name: 'Third Example' })).microsite;
  const deleted = (await db.query("select id from microsites where key = 'second-example'")).rows[0];
  ok(await act(mgr, 'site.microsite.domains', { id: third.id, domains: ['second.example'] }));
  const d = (await db.query('select domains from microsites where id = $1', [deleted.id])).rows[0];
  assert.deepEqual(d.domains, ['www.second.example'], 'it left the closed site');
  // Another campaign on this server, with a closed website.
  const them = new Client();
  const okc = (r) => { assert.ok([200, 201].includes(r.status), JSON.stringify(r.json)); return r.json; };
  okc(await them.signup({ workspaceName: 'Other Example Campaign' }));
  okc(await them.get('/api/site'));
  const theirs = okc(await them.action('site.microsite.create', { name: 'Theirs', domain: 'theirs.example' })).microsite;
  okc(await them.action('site.microsite.delete', { id: theirs.id }));
  const r = await act(mgr, 'site.microsite.domains', { id: third.id, domains: ['theirs.example'] });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'That address belongs to a closed website of another campaign on this server');
  ok(await act(mgr, 'site.microsite.delete', { id: third.id }));
});

test('delete then restore: a key or an address taken meanwhile; a live site comes back a draft; five at most', async () => {
  ok(await act(mgr, 'site.microsite.delete', { id: site.id }));
  fresh();
  assert.equal((await hit('/', { host: DOUG })).status, 410);
  assert.equal((await hit(`/site/sites/${site.key}/`)).status, 404, 'the main site’s page not found on the app address');
  const twin = ok(await act(mgr, 'site.microsite.create', { name: 'Doug Didn’t Example', domain: DOUG })).microsite;
  assert.equal(twin.key, 'doug-didnt-example');
  const back = ok(await act(mgr, 'site.microsite.restore', { id: site.id })).microsite;
  assert.equal(back.key, 'doug-didnt-example-2');
  assert.deepEqual(back.domains, [], 'its address went to the new site');
  assert.equal(back.status, 'draft');
  const ev = (await db.query("select payload from events where entity_type = 'microsite' and entity_id = $1 and op = 'restore'", [site.id])).rows[0];
  assert.deepEqual(ev.payload.was, { key: 'doug-didnt-example', status: 'live' });
  assert.equal((await db.query("select count(*)::int as n from site_pages where site_id = $1 and deleted_at is null and slug = 'home'", [site.id])).rows[0].n, 1, 'its pages back');
  // Five at most.
  const live = Number((await db.query('select count(*)::int as n from microsites where workspace_id = $1 and deleted_at is null', [ws])).rows[0].n);
  for (let i = live; i < 5; i += 1) ok(await act(mgr, 'site.microsite.create', { name: `Extra ${i}` }));
  const r = await act(mgr, 'site.microsite.create', { name: 'One too many' });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'Five other websites is the most — delete one first');
  // The export carries them.
  const exp = ok(await mgr.get('/api/export'));
  assert.ok(Array.isArray(exp.microsites) && exp.microsites.some((m) => m.id === site.id));
});

test('Authorized by: the agent and how to reach them; the old line only while no agent is named — and a save keeps it', async () => {
  await saveOrg({ agentName: '', agentContact: '', authorizationLine: 'Authorized by Old Example, financial agent' });
  let r = await hit('/', { host: MAIN });
  assert.ok(r.text.includes('Authorized by Old Example, financial agent'));
  await saveOrg({ agentName: 'Ada Example', agentContact: '604-555-0100' });
  assert.equal(ok(await mgr.get('/api/site')).settings.org.authorizationLine, 'Authorized by Old Example, financial agent');
  r = await hit('/', { host: MAIN });
  assert.ok(r.text.includes(AUTH));
  assert.ok(!r.text.includes('Old Example'));
  // A save from a desk build that knows nothing of the agent keeps them.
  const { agentName: _a, agentContact: _b, authorizationLine: _c, ...older } = ok(await mgr.get('/api/site')).settings.org;
  ok(await act(mgr, 'site.settings.save', { org: { ...older, phone: '604-555-0199' } }));
  const now = ok(await mgr.get('/api/site')).settings.org;
  assert.deepEqual([now.agentName, now.agentContact, now.authorizationLine, now.phone], ['Ada Example', '604-555-0100', 'Authorized by Old Example, financial agent', '604-555-0199']);
});
