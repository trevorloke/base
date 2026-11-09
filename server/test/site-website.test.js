// What the Website screens (web/src/pages/Website*.jsx) need from the site
// server, beyond SITE.md's first Admin API: Undo for a deleted page, post or
// petition (site.*.restore — at its old address, or a free one like it when
// that's been taken since); a page's own share picture (in the draft, then
// in what went live); the Overview's facts (online giving set up or not,
// this week's sign-ups by kind, the SITE_HOSTS the site answers on); and
// each petition's signers_tag — the tag a signature puts on the person, so
// People lists who signed.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { hit, ok, send, campaign, member, personBy } from './site-helpers.js';

let db, mgr, ws, vol;
before(async () => {
  ({ db, mgr, ws } = await campaign());
  vol = await member(mgr, 'volunteer', 'Vic Example');
  ok(await mgr.get('/api/site'));
});
const events = async (type, id) => (await db.query(
  'select action, op, payload from events where workspace_id = $1 and entity_type = $2 and entity_id = $3 order by seq', [ws, type, id],
)).rows;

test('Undo: a deleted page comes back as it was, live if it was live; its address taken since — a free one like it', async () => {
  const made = ok(await mgr.action('site.page.create', { title: 'Town hall 2030', modules: [{ id: 'txt1', kind: 'text', props: { title: 'Ask us' } }] })).page;
  ok(await mgr.action('site.page.publish', { id: made.id }));
  assert.equal((await hit('/site/town-hall-2030')).status, 200);
  ok(await mgr.action('site.page.delete', { id: made.id }));
  assert.equal((await hit('/site/town-hall-2030')).status, 404, 'deleted: off the site');
  const back = ok(await mgr.action('site.page.restore', { id: made.id })).page;
  assert.deepEqual([back.slug, back.status], ['town-hall-2030', 'published']);
  assert.match((await hit('/site/town-hall-2030')).text, /id="m-txt1"/, 'back on the site');
  assert.deepEqual((await events('site_page', made.id)).map((e) => [e.action, e.op]).slice(-2), [['site.page.delete', 'void'], ['site.page.restore', 'restore']]);

  ok(await mgr.action('site.page.delete', { id: made.id }));
  const other = ok(await mgr.action('site.page.create', { title: 'Another', slug: 'town-hall-2030' })).page;
  const moved = ok(await mgr.action('site.page.restore', { id: made.id })).page;
  assert.equal(moved.slug, 'town-hall-2030-2', 'its address went to another page meanwhile');
  assert.deepEqual((await events('site_page', made.id)).at(-1).payload, { slug: 'town-hall-2030-2', was: 'town-hall-2030' });
  assert.equal((await mgr.action('site.page.restore', { id: made.id })).status, 404, 'not deleted: nothing to bring back');
  assert.equal((await mgr.action('site.page.restore', { id: other.id })).status, 404);
  assert.equal((await vol.client.action('site.page.restore', { id: made.id })).status, 403, 'a volunteer: refused');
});

test('Undo for a post and a petition, the same way', async () => {
  const post = ok(await mgr.action('site.post.save', { title: 'Sample post', body: 'Words.' })).post;
  ok(await mgr.action('site.post.publish', { id: post.id }));
  ok(await mgr.action('site.post.delete', { id: post.id }));
  assert.equal((await hit(`/site/news/${post.slug}`)).status, 404);
  const p2 = ok(await mgr.action('site.post.restore', { id: post.id })).post;
  assert.deepEqual([p2.slug, p2.status], [post.slug, 'published']);
  assert.equal((await hit(`/site/news/${post.slug}`)).status, 200);
  const camp = ok(await mgr.action('site.campaign.save', { kind: 'petition', title: 'Sample petition', goal: 10 })).campaign;
  ok(await mgr.action('site.campaign.delete', { id: camp.id }));
  ok(await mgr.action('site.campaign.save', { kind: 'pledge', title: 'Sample pledge', slug: camp.slug }));
  const c2 = ok(await mgr.action('site.campaign.restore', { id: camp.id })).campaign;
  assert.deepEqual([c2.slug, c2.kind, c2.goal], [`${camp.slug}-2`, 'petition', 10]);
  assert.equal((await vol.client.action('site.post.restore', { id: post.id })).status, 403);
  assert.equal((await vol.client.action('site.campaign.restore', { id: camp.id })).status, 403);
});

test('a page’s share picture: in the draft, live when published, gone when removed; only the site’s own pictures', async () => {
  const p = ok(await mgr.action('site.page.create', { title: 'Shared page' })).page;
  const img = { url: '/media/0b0e7a7e-0000-4000-8000-000000000001', alt: 'Volunteers at a bus loop' };
  const saved = ok(await mgr.action('site.page.save', { id: p.id, image: img })).page;
  assert.deepEqual(saved.draft.image, img);
  assert.equal(saved.changed, true);
  const live = ok(await mgr.action('site.page.publish', { id: p.id })).page;
  assert.deepEqual(live.published.image, img, 'what went live has it');
  assert.equal(live.changed, false);
  const ev = (await events('site_page', p.id)).find((e) => e.action === 'site.page.save');
  assert.equal(ev.payload.image, img.url, 'the event log says the picture changed');
  // A save without image keeps it; null removes it (and the key).
  assert.deepEqual(ok(await mgr.action('site.page.save', { id: p.id, title: 'Shared page!' })).page.draft.image, img);
  const off = ok(await mgr.action('site.page.save', { id: p.id, image: null })).page;
  assert.ok(!('image' in off.draft));
  assert.deepEqual(Object.keys(off.draft).sort(), ['description', 'modules', 'title']);
  const bad = await mgr.action('site.page.save', { id: p.id, image: { url: 'http://elsewhere.example/x.jpg', alt: '' } });
  assert.equal(bad.status, 400);
  // The duplicate keeps it.
  ok(await mgr.action('site.page.save', { id: p.id, image: img }));
  const copy = ok(await mgr.action('site.page.duplicate', { id: p.id })).page;
  assert.deepEqual(copy.draft.image, img);
  // The preview draws the draft as it is (the renderer gets page.image).
  const { url } = ok(await mgr.post('/api/site/preview-token', { pageId: p.id }));
  assert.equal((await hit(url)).status, 200);
});

test('the Overview: online giving, this week’s sign-ups by kind, and the SITE_HOSTS the site answers on', async () => {
  const before = ok(await mgr.get('/api/site'));
  assert.deepEqual(before.payments, { ready: false }, 'no online giving set up here');
  assert.deepEqual(before.counts.actions_week_by_kind, {});
  assert.deepEqual(before.urls.hosts, []);
  const camp = ok(await mgr.get('/api/site/campaigns')).campaigns.find((c) => c.kind === 'petition' && c.status === 'open');
  ok(await send('newsletter', { first_name: 'Ana', last_name: 'Example', email: 'ana.week@example.org', consent_email: true }));
  ok(await send('petition', { first_name: 'Ben', last_name: 'Example', email: 'ben.week@example.org', campaign: camp.id }));
  ok(await send('petition', { first_name: 'Cy', last_name: 'Example', email: 'cy.week@example.org', campaign: camp.id }));
  const after = ok(await mgr.get('/api/site'));
  assert.deepEqual(after.counts.actions_week_by_kind, { newsletter: 1, petition: 2 });
  assert.equal(after.counts.actions_week, 3);
  process.env.SITE_HOSTS = 'yourcampaign.example.org, www.yourcampaign.example.org';
  try {
    const withHosts = ok(await mgr.get('/api/site'));
    assert.deepEqual(withHosts.urls.hosts, ['https://yourcampaign.example.org/', 'https://www.yourcampaign.example.org/']);
    ok(await mgr.action('site.settings.save', { domains: ['yourcampaign.example.org'] }));
    const both = ok(await mgr.get('/api/site'));
    assert.deepEqual(both.urls.domains, ['https://yourcampaign.example.org/']);
    assert.deepEqual(both.urls.hosts, ['https://www.yourcampaign.example.org/'], 'a saved domain isn’t said twice');
  } finally {
    delete process.env.SITE_HOSTS;
    ok(await mgr.action('site.settings.save', { domains: [] }));
  }
});

test('signers_tag: the tag a signature puts on the person — People lists who signed by it', async () => {
  const list = ok(await mgr.get('/api/site/campaigns')).campaigns;
  const camp = list.find((c) => c.kind === 'petition' && c.status === 'open');
  assert.ok(list.every((c) => typeof c.signers_tag === 'string' && c.signers_tag.startsWith('Signed: ')));
  ok(await send('petition', { first_name: 'Dee', last_name: 'Example', email: 'dee.tag@example.org', campaign: camp.id }));
  const [dee] = await personBy(db, ws, "email = 'dee.tag@example.org'");
  assert.ok(dee.tags.includes(camp.signers_tag), `${JSON.stringify(dee.tags)} has ${camp.signers_tag}`);
  const one = ok(await mgr.get(`/api/site/campaigns/${camp.id}`)).campaign;
  assert.equal(one.signers_tag, camp.signers_tag);
  const people = ok(await mgr.get(`/api/persons?tag=${encodeURIComponent(camp.signers_tag)}&limit=200`)).persons;
  assert.ok(people.some((p) => p.id === dee.id), 'People ?tag= finds them');
  // A long title: the same cut as the tag the form gives.
  const long = ok(await mgr.action('site.campaign.save', { kind: 'pledge', title: 'A very long pledge title that runs well past forty characters' })).campaign;
  assert.ok(long.signers_tag.length <= 40 && long.signers_tag.endsWith('…'), long.signers_tag);
  ok(await send('pledge', { first_name: 'Eve', last_name: 'Example', email: 'eve.tag@example.org', campaign: long.id }));
  const [eve] = await personBy(db, ws, "email = 'eve.tag@example.org'");
  assert.ok(eve.tags.includes(long.signers_tag));
});
