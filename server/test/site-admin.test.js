// The Website area's admin side (ext/site): the first look makes the
// campaign's site from its brand's seed; pages are drafts until published
// (a draft may be unfinished, a published page may not); a preview link
// shows a draft for half an hour and nobody else; publishing clears the
// cached pages; settings refuse an unreadable theme and another campaign's
// domain; posts and petitions; pictures in Outreach's picture store; a
// shift shown on the site. Managers by default — a volunteer gets 403 on
// every read and every write, and a manager can grant the area to staff.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { hit, ok, campaign, member } from './site-helpers.js';
import { sign } from '../ext/site/tokens.js';
import { cacheSize } from '../ext/site/cache.js';
import { checkModules } from '@starbase/shared/site/catalogue';

let db, mgr, ws, vol, staff;
const page = async (slug) => (await mgr.get('/api/site')).json.pages.find((p) => p.slug === slug);

before(async () => {
  ({ db, mgr, ws } = await campaign());
  vol = await member(mgr, 'volunteer', 'Vic Example');
  staff = await member(mgr, 'staff', 'Sam Example');
});

test('the first look makes the site: settings, pages, petitions, counts and where it is', async () => {
  const site = ok(await mgr.get('/api/site'));
  assert.equal(site.settings.org.name, 'Imagine Surrey');
  assert.deepEqual(site.pages.map((p) => p.slug), ['home', 'tracker', 'volunteer', 'events', 'news', 'donate', 'privacy', 'accessibility']);
  assert.ok(site.pages.every((p) => p.status === 'published' && p.version === 1 && !p.changed));
  assert.deepEqual([site.counts.pages, site.counts.published, site.counts.campaigns, site.counts.posts], [8, 8, 2, 0]);
  assert.equal(site.urls.site, '/site/');
  assert.ok(!('draft' in site.pages[0]), 'the list carries no page content');
  const again = ok(await mgr.get('/api/site'));
  assert.equal(again.pages.length, 8, 'made once');
  const one = ok(await mgr.get(`/api/site/pages/${site.pages[0].id}`)).page;
  assert.deepEqual(Object.keys(one.draft).sort(), ['description', 'modules', 'title']);
  assert.deepEqual(one.draft, one.published);
  const seeded = (await db.query("select count(*)::int as n from events where workspace_id = $1 and action = 'site.seed'", [ws])).rows[0].n;
  assert.ok(seeded >= 11, 'the seed is on the event log');
});

test('a volunteer gets 403 on every Website read and write; staff too, until a manager grants the area', async () => {
  const { id: pageId } = await page('home');
  const camp = ok(await mgr.get('/api/site/campaigns')).campaigns[0];
  const reads = ['/api/site', `/api/site/pages/${pageId}`, '/api/site/posts', `/api/site/posts/${pageId}`, '/api/site/campaigns', `/api/site/campaigns/${camp.id}`, '/api/site/pictures'];
  const writes = [
    ['site.settings.save', { org: { name: 'x' } }], ['site.page.create', { title: 'x' }], ['site.page.save', { id: pageId, title: 'x' }],
    ['site.page.publish', { id: pageId }], ['site.page.unpublish', { id: pageId }], ['site.page.duplicate', { id: pageId }],
    ['site.page.delete', { id: pageId }], ['site.page.reorder', { ids: [pageId] }], ['site.post.save', { title: 'x' }],
    ['site.post.publish', { id: pageId }], ['site.post.delete', { id: pageId }], ['site.campaign.save', { kind: 'petition', title: 'x' }],
    ['site.campaign.close', { id: camp.id }], ['site.campaign.delete', { id: camp.id }], ['site.picture', { data: 'aGk=' }],
    ['site.page.restore', { id: pageId }], ['site.post.restore', { id: pageId }], ['site.campaign.restore', { id: camp.id }],
    ['shift.public', { id: pageId, public: true }],
  ];
  for (const who of [vol.client, staff.client]) {
    for (const path of reads) assert.equal((await who.get(path)).status, 403, `${path} refused`);
    assert.equal((await who.post('/api/site/preview-token', { pageId })).status, 403, 'preview-token refused');
    for (const [name, input] of writes) {
      if (who === staff.client && name === 'shift.public') continue; // the desk's: staff may
      assert.equal((await who.action(name, input)).status, 403, `${name} refused`);
    }
  }
  assert.equal((await vol.client.action('shift.public', { id: pageId, public: true })).status, 403);
  // Every site action is accounted for above.
  const { ACTIONS } = await import('../actions/index.js');
  const siteActions = Object.keys(ACTIONS).filter((k) => k.startsWith('site.'));
  assert.deepEqual(siteActions.sort(), writes.map(([n]) => n).filter((n) => n.startsWith('site.')).sort());

  ok(await mgr.action('permission.role.set', { role: 'staff', grant: ['site'], deny: [] }));
  assert.equal((await staff.client.get('/api/site')).status, 200, 'granted: staff can open Website');
  const made = ok(await staff.client.action('site.page.create', { title: 'Granted page' }));
  assert.equal(made.page.slug, 'granted-page');
  ok(await mgr.action('permission.role.set', { role: 'staff', grant: [], deny: [] }));
  assert.equal((await staff.client.get('/api/site')).status, 403, 'taken back');
  assert.ok((await mgr.get('/api/admin/permissions')).json.areas.some((a) => a.key === 'site' && a.label === 'Website'));
});

test('pages: a draft until published; an unfinished draft saves, publishing asks for every required box', async () => {
  const made = ok(await mgr.action('site.page.create', { title: 'Town hall 2026', description: 'Come and ask' })).page;
  assert.equal(made.slug, 'town-hall-2026');
  assert.equal(made.status, 'draft');
  assert.equal((await hit('/site/town-hall-2026')).status, 404, 'a draft is not on the site');
  for (const slug of ['news', 'act', 'r', 'preferences', 'unsubscribe', 'api', 'site-assets', 'media', 'stripe', 'site', 'sitemap.xml', 'robots.txt', '__preview']) {
    const r = await mgr.action('site.page.create', { title: 'Reserved', slug });
    assert.equal(r.status, 400, `${slug} is kept`);
  }
  assert.equal((await mgr.action('site.page.create', { title: 'x', slug: 'Bad Slug!' })).status, 400);
  assert.equal((await mgr.action('site.page.create', { title: 'x', slug: 'town-hall-2026' })).status, 409, 'taken');
  assert.equal((await mgr.action('site.page.create', { title: 'Another', slug: 'home' })).status, 409, "home is the home page's");
  assert.equal(ok(await mgr.action('site.page.create', { title: 'Town hall 2026' })).page.slug, 'town-hall-2026-2', 'a title already used gets -2');

  const unfinished = [{ id: 'pet1', kind: 'petition', props: { campaign: '' } }, { id: 'txt1', kind: 'text', props: { title: 'Ask us anything', body: 'Bring your questions.' } }];
  const saved = ok(await mgr.action('site.page.save', { id: made.id, modules: unfinished, show_in_nav: true }));
  assert.equal(saved.page.changed, true);
  assert.equal((await mgr.action('site.page.save', { id: made.id, modules: [{ id: 'x1y2', kind: 'nope', props: {} }] })).status, 400, 'an unknown module');
  assert.equal((await mgr.action('site.page.save', { id: made.id, modules: [{ id: 'dup1', kind: 'text' }, { id: 'dup1', kind: 'text' }] })).status, 400, 'the same id twice');
  const tooLong = await mgr.action('site.page.save', { id: made.id, modules: [{ id: 'txt1', kind: 'text', props: { title: 'x'.repeat(200) } }] });
  assert.equal(tooLong.status, 400);
  assert.match(tooLong.json.error, /^The 1st module \(Text block\): title: at most 120 characters$/);

  const refused = await mgr.action('site.page.publish', { id: made.id });
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /^The 1st module \(Petition or pledge\): campaign: pick one$/);
  // A hidden module needn't be finished.
  ok(await mgr.action('site.page.save', { id: made.id, modules: [{ ...unfinished[0], hidden: true }, unfinished[1]] }));
  const live = ok(await mgr.action('site.page.publish', { id: made.id })).page;
  assert.deepEqual([live.status, live.version, live.changed], ['published', 1, false]);
  const r = await hit('/site/town-hall-2026');
  assert.equal(r.status, 200);
  assert.match(r.text, /data-module="text" id="m-txt1"/);
  assert.doesNotMatch(r.text, /id="m-pet1"/, 'a hidden module is not drawn');

  // Editing a published page: the site keeps the published words until the next publish.
  const editing = (await mgr.get(`/api/site/pages/${made.id}`)).json.page;
  ok(await mgr.action('site.page.save', { id: made.id, modules: [{ id: 'txt2', kind: 'text', props: { title: 'New words' } }], updated_at: editing.updated_at }));
  assert.doesNotMatch((await hit('/site/town-hall-2026')).text, /New words/);
  const stale = await mgr.action('site.page.save', { id: made.id, title: 'Overwrite', updated_at: editing.updated_at });
  assert.equal(stale.status, 409, "someone else's save since is not overwritten");
  ok(await mgr.action('site.page.publish', { id: made.id }));
  assert.match((await hit('/site/town-hall-2026')).text, /New words/);

  // The address moves; the home page's never does.
  ok(await mgr.action('site.page.save', { id: made.id, slug: 'town-hall' }));
  assert.equal((await hit('/site/town-hall')).status, 200);
  assert.equal((await hit('/site/town-hall-2026')).status, 404);
  const home = await page('home');
  assert.equal((await mgr.action('site.page.save', { id: home.id, slug: 'start' })).status, 400);
  assert.equal((await mgr.action('site.page.unpublish', { id: home.id })).status, 400);
  assert.equal((await mgr.action('site.page.delete', { id: home.id })).status, 400);

  const copy = ok(await mgr.action('site.page.duplicate', { id: made.id })).page;
  assert.deepEqual([copy.slug, copy.status, copy.title], ['town-hall-copy', 'draft', 'Town hall 2026 (copy)']);
  ok(await mgr.action('site.page.unpublish', { id: made.id }));
  assert.equal((await hit('/site/town-hall')).status, 404, 'unpublished: off the site');
  ok(await mgr.action('site.page.delete', { id: copy.id }));
  assert.equal((await mgr.get(`/api/site/pages/${copy.id}`)).status, 404);

  // The menu: published pages marked "show in menu", in their order.
  ok(await mgr.action('site.page.publish', { id: made.id }));
  const before = (await mgr.get('/api/site')).json.pages.map((p) => p.id);
  const reversed = [...before].reverse();
  ok(await mgr.action('site.page.reorder', { ids: reversed }));
  assert.deepEqual((await mgr.get('/api/site')).json.pages.map((p) => p.id), reversed);
  ok(await mgr.action('site.page.reorder', { ids: before }));
});

test('a preview link shows the draft, for half an hour, framed only by the app; a forged or old one shows nothing', async () => {
  const p = await page('donate');
  ok(await mgr.action('site.page.save', { id: p.id, modules: [{ id: 'draft-only', kind: 'text', props: { title: 'Draft words only' } }] }));
  assert.doesNotMatch((await hit('/site/donate')).text, /Draft words only/);
  const { url, expires_at: expires } = ok(await mgr.post('/api/site/preview-token', { pageId: p.id }));
  assert.match(url, new RegExp(`^/site/__preview/${p.id}\\?t=`));
  assert.ok(new Date(expires) - Date.now() > 25 * 60_000 && new Date(expires) - Date.now() <= 30 * 60_000);
  const r = await hit(url);
  assert.equal(r.status, 200);
  assert.match(r.text, /Draft words only/);
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.match(r.headers.get('x-robots-tag'), /noindex/);
  assert.match(r.headers.get('cache-control'), /no-store/);

  const other = await page('events');
  assert.equal((await hit(url.replace(p.id, other.id))).status, 403, "one page's link doesn't open another");
  const t = new URL(url, 'http://x').searchParams.get('t');
  assert.equal((await hit(`/site/__preview/${p.id}?t=${t.slice(0, -2)}xx`)).status, 403, 'forged');
  const old = await sign('preview', { w: ws, p: p.id }, -5);
  assert.equal((await hit(`/site/__preview/${p.id}?t=${encodeURIComponent(old)}`)).status, 403, 'expired');
  const person = await sign('person', { w: ws, p: p.id }, 600);
  assert.equal((await hit(`/site/__preview/${p.id}?t=${encodeURIComponent(person)}`)).status, 403, 'another kind of link');
  assert.equal((await mgr.post('/api/site/preview-token', { pageId: 'nope' })).status, 400);
  ok(await mgr.action('site.page.publish', { id: p.id }));
});

test('the page cache: a page is kept once drawn, and a publish or a save clears it', async () => {
  const p = await page('events');
  await hit('/site/events');
  await hit('/site/events');
  assert.ok(cacheSize(ws) >= 1, 'kept');
  ok(await mgr.action('site.page.save', { id: p.id, modules: [{ id: 'fresh1', kind: 'text', props: { title: 'Fresh from the editor' } }] }));
  assert.equal(cacheSize(ws), 0, 'a save clears it');
  await hit('/site/events');
  assert.ok(cacheSize(ws) >= 1);
  ok(await mgr.action('site.page.publish', { id: p.id }));
  assert.equal(cacheSize(ws), 0, 'a publish clears it');
  assert.match((await hit('/site/events')).text, /Fresh from the editor/, 'and the new version is what the site shows');
  // A thank-you page (?sent=) is drawn fresh, never kept.
  const n = cacheSize(ws);
  await hit('/site/events?sent=newsletter');
  assert.equal(cacheSize(ws), n);
});

test('settings: sections saved whole, an unreadable theme refused, domains checked', async () => {
  const saved = ok(await mgr.action('site.settings.save', {
    announcement: { enabled: true, text: 'Town hall Thursday', linkLabel: 'Details', linkHref: '/events' },
    nav: { menu: [{ label: 'Events', href: '/events' }], links: [], cta: { label: 'Donate', href: '/donate' } },
  }));
  assert.deepEqual(saved.saved.sort(), ['announcement', 'nav']);
  const s = ok(await mgr.get('/api/site')).settings;
  assert.equal(s.announcement.text, 'Town hall Thursday');
  assert.deepEqual(s.nav.menu, [{ label: 'Events', href: '/events' }]);
  assert.equal(s.org.name, 'Imagine Surrey', 'a section not sent stays');
  const bad = await mgr.action('site.settings.save', { theme: { colors: { brand: '#ffff00', brandInk: '#ffffff' } } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /Text on brand colour.*needs 4\.5:1/);
  ok(await mgr.action('site.settings.save', { theme: { skin: 'imagine-surrey', colors: { brand: '#002b5c' } } }));
  assert.equal(ok(await mgr.get('/api/site')).settings.theme.colors.brand, '#002b5c');
  assert.equal((await mgr.action('site.settings.save', { nav: { menu: [{ label: 'x', href: 'javascript:alert(1)' }] } })).status, 400, 'no script links');
  assert.equal((await mgr.action('site.settings.save', { domains: ['not a domain'] })).status, 400);
  const d = ok(await mgr.action('site.settings.save', { domains: ['https://WWW.Example.org/', 'example.org'] }));
  assert.deepEqual(d.saved, ['domains']);
  assert.deepEqual(ok(await mgr.get('/api/site')).settings.domains, ['www.example.org', 'example.org']);
  assert.equal((await mgr.action('site.settings.save', {})).status, 400, 'nothing to save');
  ok(await mgr.action('site.settings.save', { domains: [], nav: { menu: [], links: [], cta: { label: 'Donate', href: '/donate' } }, announcement: { enabled: false } }));
});

test('posts: drafts, published on /news/:slug, then gone when deleted', async () => {
  const post = ok(await mgr.action('site.post.save', { title: 'We launched the tracker', excerpt: 'Every promise, scored.', body: 'The **tracker** is live.' })).post;
  assert.equal(post.slug, 'we-launched-the-tracker');
  assert.equal((await hit('/site/news/we-launched-the-tracker')).status, 404, 'a draft');
  ok(await mgr.action('site.post.publish', { id: post.id }));
  const r = await hit('/site/news/we-launched-the-tracker');
  assert.equal(r.status, 200);
  assert.match(r.text, /We launched the tracker/);
  assert.equal(ok(await mgr.get('/api/site/posts')).posts[0].status, 'published');
  assert.equal(ok(await mgr.get(`/api/site/posts/${post.id}`)).post.body, 'The **tracker** is live.');
  assert.match((await hit('/site/sitemap.xml')).text, /\/site\/news\/we-launched-the-tracker/);
  ok(await mgr.action('site.post.publish', { id: post.id, published: false }));
  assert.equal((await hit('/site/news/we-launched-the-tracker')).status, 404);
  ok(await mgr.action('site.post.delete', { id: post.id }));
  assert.equal((await mgr.get(`/api/site/posts/${post.id}`)).status, 404);
  assert.equal((await mgr.action('site.post.save', { title: 'x', image: { url: 'javascript:x' } })).status, 400);
});

test('petitions: made, closed (the form refuses), opened again, deleted; a published page must point at one that exists', async () => {
  const c = ok(await mgr.action('site.campaign.save', { kind: 'petition', title: 'Fix the 72 Avenue crossing', statement: 'Make it safe.', goal: 500 })).campaign;
  assert.deepEqual([c.slug, c.status, c.signatures], ['fix-the-72-avenue-crossing', 'open', 0]);
  assert.equal((await hit('/site/act/fix-the-72-avenue-crossing')).status, 200);
  assert.match((await hit('/site/act')).text, new RegExp(`id="m-act-${c.id}"`), '/act lists every open one');
  ok(await mgr.action('site.campaign.close', { id: c.id }));
  const refused = await hit('/site/api/forms/petition', { method: 'POST', body: { email: 'ann@example.org', campaign: c.id } });
  assert.equal(refused.status, 400);
  assert.equal(refused.json.field, 'campaign');
  assert.doesNotMatch((await hit('/site/act')).text, new RegExp(`m-act-${c.id}`), 'closed: off /act');
  ok(await mgr.action('site.campaign.close', { id: c.id, open: true }));
  assert.equal(ok(await mgr.get(`/api/site/campaigns/${c.id}`)).campaign.status, 'open');

  const p = ok(await mgr.action('site.page.create', { title: 'Crossing', modules: [{ id: 'cross1', kind: 'petition', props: { campaign: c.id } }] })).page;
  ok(await mgr.action('site.campaign.delete', { id: c.id }));
  const publish = await mgr.action('site.page.publish', { id: p.id });
  assert.equal(publish.status, 400);
  assert.match(publish.json.error, /the petition or pledge it shows is gone/);
  assert.equal((await hit('/site/act/fix-the-72-avenue-crossing')).status, 404);
  assert.equal((await mgr.action('site.campaign.save', { title: 'No kind' })).status, 400);
});

test('pictures: uploaded to the same store as Outreach’s, served at /media/:id, listed', async () => {
  // A 1×1 PNG.
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const up = ok(await mgr.action('site.picture', { data: `data:image/png;base64,${png}`, name: 'dot.png', width: 1, height: 1 }));
  assert.match(up.media.url, /^\/media\/[0-9a-f-]{36}$/);
  const r = await hit(up.media.url);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.ok(ok(await mgr.get('/api/site/pictures')).pictures.some((p) => p.id === up.media.id && p.url === up.media.url));
  assert.equal((await mgr.action('site.picture', { data: Buffer.from('not a picture at all').toString('base64') })).status, 400);
});

test('a shift on the website: the desk switches it; a volunteer cannot', async () => {
  const s = (await mgr.action('shift.create', { title: 'Saturday canvass', starts_at: new Date(Date.now() + 864e5).toISOString(), capacity: 3 })).json.shift;
  const on = ok(await mgr.action('shift.public', { id: s.id, public: true }));
  assert.equal(on.public, true);
  assert.equal(ok(await mgr.get(`/api/shifts/${s.id}`)).shift.public, true);
  assert.equal((await vol.client.action('shift.public', { id: s.id, public: false })).status, 403);
  ok(await mgr.action('shift.public', { id: s.id, public: false }));
  assert.equal((await mgr.action('shift.public', { id: '00000000-0000-4000-8000-000000000000', public: true })).status, 404);
});

test('the menu: the settings’ links, then the published pages marked "show in menu" by their published title', async () => {
  const { menuPages, siteOf, readSettings } = await import('../ext/site/store.js');
  const made = ok(await mgr.action('site.page.create', { title: 'Meet the team', show_in_nav: true })).page;
  assert.ok(!(await menuPages(db, ws)).some((p) => p.slug === made.slug), 'a draft isn’t in the menu');
  ok(await mgr.action('site.page.publish', { id: made.id }));
  ok(await mgr.action('site.page.save', { id: made.id, title: 'Draft title, not live yet' }));
  const menu = siteOf(await readSettings(db, ws), await menuPages(db, ws)).nav.menu;
  assert.deepEqual(menu.at(-1), { label: 'Meet the team', href: '/meet-the-team' }, 'the published title');
  assert.ok(menu.filter((l) => l.href === '/tracker').length === 1, 'a page already in the settings’ menu isn’t doubled');
  ok(await mgr.action('site.page.delete', { id: made.id }));
});

test('every seeded page passes the publish check as it stands', async () => {
  const seeded = ['home', 'tracker', 'volunteer', 'events', 'news', 'donate', 'privacy', 'accessibility'];
  for (const p of (await mgr.get('/api/site')).json.pages.filter((x) => seeded.includes(x.slug))) {
    const full = (await mgr.get(`/api/site/pages/${p.id}`)).json.page;
    assert.doesNotThrow(() => checkModules(full.published?.modules || full.draft.modules, { strict: true }), p.slug);
  }
});
