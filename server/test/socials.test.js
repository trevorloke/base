// Social media handles: one reader for what people paste (shared/socials.js),
// the profile's two actions and typed-in followers (ext/socials), the People
// filters (has=social, has=<network>, followers=), the import's columns, and
// a count that goes when its handle goes — whatever wrote the handle.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { getDb } from '../db/client.js';
import { personsWhere } from '../lib/audience.js';
import {
  parseSocial, sameHandle, profileUrl, shownHandle, parseCount, countWord, countFull, SAY, PLATFORMS,
} from '@starbase/shared/socials';

// ── The reader ──
const ok = (text, platform, handle, hint) => test(`parse ${JSON.stringify(text)}${hint ? ` (${hint})` : ''} → ${platform} ${handle}`, () => {
  assert.deepEqual(parseSocial(text, hint), { platform, handle });
});
const no = (text, error, hint) => test(`parse ${JSON.stringify(text)}${hint ? ` (${hint})` : ''} refused`, () => {
  const r = parseSocial(text, hint);
  assert.equal(r.error, error, JSON.stringify(r));
  assert.equal(r.handle, undefined);
});

// A profile link of every network, with and without scheme, www., m. and a query.
ok('https://www.instagram.com/lin.example/?hl=en', 'instagram', 'lin.example');
ok('instagram.com/lin.example', 'instagram', 'lin.example');
ok('http://m.instagram.com/Lin_Example#top', 'instagram', 'Lin_Example');
ok('https://x.com/linreports', 'x', 'linreports');
ok('https://twitter.com/LinReports?s=20', 'x', 'LinReports');
ok('mobile.twitter.com/linreports', 'x', 'linreports');
ok('https://www.tiktok.com/@lin.example?lang=en', 'tiktok', 'lin.example');
ok('m.tiktok.com/@lin_ex', 'tiktok', 'lin_ex');
ok('https://www.threads.net/@lin.example', 'threads', 'lin.example');
ok('threads.com/@lin.example', 'threads', 'lin.example');
ok('https://bsky.app/profile/lin.bsky.social', 'bluesky', 'lin.bsky.social');
ok('bsky.app/profile/Lin.Example.org', 'bluesky', 'lin.example.org');
ok('https://www.youtube.com/@LinExample', 'youtube', 'LinExample');
ok('m.youtube.com/@lin-example?si=x', 'youtube', 'lin-example');
ok('https://www.linkedin.com/in/lin-example-123/', 'linkedin', 'lin-example-123');
ok('ca.linkedin.com/in/lin-example', 'linkedin', 'lin-example');
ok('https://www.reddit.com/user/lin_example/', 'reddit', 'lin_example');
ok('old.reddit.com/u/lin_example', 'reddit', 'lin_example');
ok('https://www.facebook.com/lin.example', 'facebook', 'lin.example');
ok('m.facebook.com/lin.example?ref=bookmarks', 'facebook', 'lin.example');
ok('fb.com/lin.example', 'facebook', 'lin.example');
ok('https://x.com/linreports', 'x', 'linreports', 'instagram');

// Kept whole: a profile with no plain handle.
ok('https://www.facebook.com/profile.php?id=100012345678&ref=x', 'facebook', 'https://www.facebook.com/profile.php?id=100012345678');
ok('facebook.com/people/Lin-Example/100012345678/', 'facebook', 'https://www.facebook.com/people/Lin-Example/100012345678');
ok('https://facebook.com/pages/Lin-Example-Bakery/123456789', 'facebook', 'https://www.facebook.com/pages/Lin-Example-Bakery/123456789');
ok('https://www.youtube.com/channel/UCabcdEFGH1234567890ab', 'youtube', 'https://www.youtube.com/channel/UCabcdEFGH1234567890ab');
ok('youtube.com/c/LinExample', 'youtube', 'https://www.youtube.com/c/LinExample');
ok('youtube.com/user/linexample', 'youtube', 'https://www.youtube.com/user/linexample');
ok('https://www.linkedin.com/company/example-bakery/', 'linkedin', 'https://www.linkedin.com/company/example-bakery');
ok('linkedin.com/pub/lin-example/1/2a/3b', 'linkedin', 'https://www.linkedin.com/pub/lin-example/1/2a/3b');
ok('https://bsky.app/profile/did:plc:abc123xyz', 'bluesky', 'https://bsky.app/profile/did:plc:abc123xyz');

// Refused as posts.
for (const t of [
  'https://www.instagram.com/p/C1abcDEF/', 'instagram.com/reels/C1abc', 'instagram.com/tv/C1abc', 'instagram.com/stories/lin/123',
  'https://x.com/linreports/status/1790000000000', 'x.com/hashtag/surrey', 'twitter.com/intent/tweet?text=hi', 'x.com/i/lists/1',
  'https://www.tiktok.com/@lin.example/video/7300000000000', 'tiktok.com/@lin/photo/7300',
  'facebook.com/reel/123456', 'https://www.facebook.com/story.php?story_fbid=1&id=2', 'facebook.com/permalink.php?story_fbid=1',
  'facebook.com/photo.php?fbid=1', 'facebook.com/marketplace/item/1', 'facebook.com/login', 'facebook.com/home.php',
  'facebook.com/groups/surreyneighbours', 'facebook.com/share/abc123', 'facebook.com/pages/create',
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ', 'youtube.com/shorts/abc', 'youtube.com/playlist?list=1',
  'https://www.reddit.com/r/surrey/', 'linkedin.com/posts/lin_activity-1', 'linkedin.com/feed/', 'linkedin.com/pulse/a-story',
  'threads.net/@lin/post/abc', 'bsky.app/profile/lin.bsky.social/post/3k',
]) no(t, SAY.post);
// Short links.
for (const t of ['https://vm.tiktok.com/ZMabc123/', 'vt.tiktok.com/ZSabc/', 'https://www.tiktok.com/t/ZTabc/', 'https://lnkd.in/gAbc', 't.co/abc123']) no(t, SAY.short);
// Reserved words in the handle place, on any network.
for (const w of ['people', 'pages', 'groups', 'watch', 'events', 'login', 'home', 'share', 'hashtag', 'intent', 'explore', 'search',
  'settings', 'profile', 'reel', 'reels', 'stories', 'marketplace', 'help', 'about', 'privacy', 'policies']) {
  no(`https://www.facebook.com/${w}`, SAY.post);
}
no('instagram.com/explore', SAY.post);
no('x.com/home', SAY.post);
no('instagram.com/about', SAY.post);
no('x.com/settings', SAY.post);
no('@settings', SAY.post, 'instagram');

// A bare name: the network the screen picked, or a question.
no('@lin', SAY.which('lin'));
no('lin', SAY.which('lin'));
test('a bare @name without a network asks (ask: true)', () => assert.equal(parseSocial('@lin').ask, true));
ok('@lin', 'x', 'lin', 'x');
ok('@Lin.Example', 'instagram', 'Lin.Example', 'instagram');
ok('u/lin_example', 'reddit', 'lin_example', 'reddit');
ok('@lin', 'bluesky', 'lin.bsky.social', 'bluesky');
ok('Lin.Example.org', 'bluesky', 'lin.example.org', 'bluesky');
ok('lin.bsky.social', 'bluesky', 'lin.bsky.social');
ok('@lin.bsky.social', 'bluesky', 'lin.bsky.social');
ok('https://example.org/lin', 'other', 'https://example.org/lin');
ok('https://example.org/lin', 'other', 'https://example.org/lin', 'other');
no('@lin', SAY.other, 'other');
no('', SAY.empty);
no('two words', SAY.empty);

// Shapes, per network.
no('@this_is_far_too_long_for_x', SAY.shape('x'), 'x');
no('@has-dash', SAY.shape('x'), 'x');
no('@a', SAY.shape('tiktok'), 'tiktok');
no(`@${'a'.repeat(31)}`, SAY.shape('instagram'), 'instagram');
no('@has space', SAY.shape('instagram'), 'instagram');
no('@ab', SAY.shape('youtube'), 'youtube');
no('@ab', SAY.shape('reddit'), 'reddit');
no('@lin', SAY.shape('facebook'), 'facebook');
no('@lin_example', SAY.shape('facebook'), 'facebook');
no('@ab', SAY.shape('linkedin'), 'linkedin');
no('bad_name.example', SAY.shape('bluesky'), 'bluesky');
no('https://x.com/this_is_far_too_long_for_x', SAY.shape('x'));
test('the words are typographic and say the network', () => {
  assert.equal(SAY.shape('instagram'), 'That doesn’t look like an Instagram handle');
  assert.equal(SAY.shape('x'), 'That doesn’t look like an X handle');
  assert.equal(SAY.shape('tiktok'), 'That doesn’t look like a TikTok handle');
  assert.ok(PLATFORMS.includes('threads'));
});

test('sameHandle, profileUrl, shownHandle: one account, one address, old values shown as typed', () => {
  assert.equal(sameHandle('@Lin', 'lin'), true);
  assert.equal(sameHandle('lin', 'lin2'), false);
  assert.equal(sameHandle('https://www.facebook.com/profile.php?id=1/', 'https://WWW.facebook.com/profile.php?id=1'), true);
  assert.equal(sameHandle('', ''), false);
  assert.equal(profileUrl('instagram', 'lin.example'), 'https://www.instagram.com/lin.example');
  assert.equal(profileUrl('x', '@linreports'), 'https://x.com/linreports');
  assert.equal(profileUrl('tiktok', 'lin'), 'https://www.tiktok.com/@lin');
  assert.equal(profileUrl('threads', 'lin'), 'https://www.threads.com/@lin');
  assert.equal(profileUrl('bluesky', 'lin.bsky.social'), 'https://bsky.app/profile/lin.bsky.social');
  assert.equal(profileUrl('youtube', 'lin'), 'https://www.youtube.com/@lin');
  assert.equal(profileUrl('linkedin', 'lin-example'), 'https://www.linkedin.com/in/lin-example');
  assert.equal(profileUrl('reddit', 'u/lin_example'), 'https://www.reddit.com/user/lin_example');
  assert.equal(profileUrl('facebook', 'lin.example'), 'https://www.facebook.com/lin.example');
  assert.equal(profileUrl('facebook', 'https://www.facebook.com/profile.php?id=1'), 'https://www.facebook.com/profile.php?id=1');
  assert.equal(profileUrl('instagram', 'instagram.com/lin.example'), 'https://www.instagram.com/lin.example', 'an old pasted link without https');
  assert.equal(profileUrl('other', 'not a link'), null);
  assert.equal(shownHandle('x', 'linreports'), '@linreports');
  assert.equal(shownHandle('facebook', 'https://www.facebook.com/profile.php?id=1'), 'Profile link');
  assert.equal(shownHandle('instagram', 'https://www.instagram.com/p/abc'), 'https://www.instagram.com/p/abc', 'an old value that is not a profile: as typed');
  assert.equal(shownHandle('instagram', 'Lin Example!!'), 'Lin Example!!');
});

test('parseCount and countWord', () => {
  assert.equal(parseCount('12k'), 12000);
  assert.equal(parseCount('12.4K'), 12400);
  assert.equal(parseCount('12,400'), 12400);
  assert.equal(parseCount('1.2m'), 1200000);
  assert.equal(parseCount('900'), 900);
  assert.equal(parseCount('12 400 followers'), 12400);
  assert.equal(parseCount('abc'), null);
  assert.equal(parseCount(''), null);
  assert.equal(parseCount('-5'), null);
  assert.equal(parseCount('1,2'), null);
  assert.equal(countWord(900), '900');
  assert.equal(countWord(12000), '12k');
  assert.equal(countWord(12400), '12.4k');
  assert.equal(countWord(999950), '999.9k');
  assert.equal(countWord(1200000), '1.2m');
  assert.equal(countFull(12400), '12,400');
});

// ── The actions, the hook, the filters ──
const tag = Math.random().toString(36).slice(2, 8);
let mgr, staff, vol, ws, staffUser, volUser;
const P = {};
const okR = (r, msg) => { assert.equal(r.status, 200, `${msg || ''} ${JSON.stringify(r.json)}`); return r.json; };
const join = async (client, name, email, role) => {
  const v = await client.signup({ name, workspaceName: `Temp ${tag}`, email });
  const db = await getDb();
  await db.query('update memberships set workspace_id = $2, role = $3 where user_id = $1', [v.json.user.id, ws, role]);
  await db.query('update sessions set workspace_id = $2 where user_id = $1', [v.json.user.id, ws]);
  return v.json.user;
};
const row = async (id) => (await (await getDb()).query('select socials, social_reach, followers from persons where id = $1', [id])).rows[0];
const eventsAbout = async (id) => (await (await getDb()).query(
  "select action, payload from events where workspace_id = $1 and entity_type = 'person' and entity_id = $2 order by seq", [ws, id],
)).rows.map((e) => ({ action: e.action, payload: typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload }));

before(async () => {
  await freshDb();
  mgr = new Client();
  const r = await mgr.signup({ name: 'Riley Manager', workspaceName: `Socials WS ${tag}`, email: `soc-mgr+${tag}@example.org` });
  ws = r.json.workspace.id;
  staff = new Client(); staffUser = await join(staff, 'Sam Staff', `soc-staff+${tag}@example.org`, 'staff');
  vol = new Client(); volUser = await join(vol, 'Val Volunteer', `soc-vol+${tag}@example.org`, 'volunteer');
  P.lin = await mgr.createPerson('Lin Example', { phone: '604-555-0140' });
  P.kai = await mgr.createPerson('Kai Example', { phone: '604-555-0141' });
  P.ana = await mgr.createPerson('Ana Example', { phone: '604-555-0142' });
});

test('person.social.set normalizes a pasted link, refuses in the parser’s words, and names someone else with it', async () => {
  const a = okR(await mgr.action('person.social.set', { id: P.lin.id, value: 'https://www.instagram.com/lin.example/?hl=en' }));
  assert.equal(a.person.socials.instagram, 'lin.example');
  assert.equal(a.also, null);
  const bad = await mgr.action('person.social.set', { id: P.lin.id, value: 'https://www.instagram.com/p/C1abc/' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, SAY.post);
  assert.equal(bad.json.field, 'value');
  const ask = await mgr.action('person.social.set', { id: P.lin.id, value: '@linreports' });
  assert.equal(ask.status, 400);
  assert.equal(ask.json.error, 'Which network is @linreports on?');
  okR(await mgr.action('person.social.set', { id: P.lin.id, platform: 'x', value: '@linreports' }));
  const k = okR(await mgr.action('person.social.set', { id: P.kai.id, platform: 'x', value: '@LinReports' }));
  assert.deepEqual(k.also, { id: P.lin.id, name: 'Lin Example' }, 'the same account on another profile');
  assert.deepEqual((await row(P.lin.id)).socials, { instagram: 'lin.example', x: 'linreports' });
  okR(await mgr.action('person.social.remove', { id: P.kai.id, platform: 'x' }));
  assert.deepEqual((await row(P.kai.id)).socials, {});
});

test('who may: People decides — a volunteer only with it, a staff member never when it is denied', async () => {
  assert.equal((await vol.action('person.social.set', { id: P.ana.id, platform: 'x', value: '@ana' })).status, 403);
  assert.equal((await vol.action('person.followers.set', { id: P.lin.id, platform: 'x', followers: 5 })).status, 403);
  okR(await mgr.action('permission.member.set', { user_id: volUser.id, grant: ['people'], deny: [] }));
  okR(await vol.action('person.social.set', { id: P.ana.id, platform: 'x', value: '@ana_ex' }));
  okR(await vol.action('person.social.remove', { id: P.ana.id, platform: 'x' }));
  okR(await mgr.action('permission.member.set', { user_id: volUser.id, grant: [], deny: [] }));
  okR(await mgr.action('permission.member.set', { user_id: staffUser.id, grant: [], deny: ['people'] }));
  assert.equal((await staff.action('person.social.set', { id: P.ana.id, platform: 'x', value: '@ana' })).status, 403);
  okR(await mgr.action('permission.member.set', { user_id: staffUser.id, grant: [], deny: [] }));
  okR(await staff.action('person.social.set', { id: P.ana.id, platform: 'x', value: '@ana_ex' }));
});

test('followers: typed for a handle on file, the largest kept, refused without a handle', async () => {
  const none = await mgr.action('person.followers.set', { id: P.ana.id, platform: 'instagram', followers: 10 });
  assert.equal(none.status, 400);
  assert.equal(none.json.error, 'Add the handle first');
  okR(await mgr.action('person.followers.set', { id: P.lin.id, platform: 'x', followers: 12400 }));
  okR(await mgr.action('person.followers.set', { id: P.lin.id, platform: 'instagram', followers: 900 }));
  let r = await row(P.lin.id);
  assert.equal(r.followers, 12400);
  assert.equal(r.social_reach.x.h, 'linreports');
  assert.equal(r.social_reach.x.by, 'typed');
  assert.match(r.social_reach.x.at, /^\d{4}-\d{2}-\d{2}$/);
  const one = okR(await mgr.get(`/api/persons/${P.lin.id}`));
  assert.equal(one.person.followers, 12400, 'the desk reads it on the profile');
  assert.equal(one.person.social_reach.instagram.n, 900);
  okR(await mgr.action('permission.member.set', { user_id: volUser.id, grant: ['people'], deny: [] }));
  const seen = okR(await vol.get(`/api/persons/${P.lin.id}`)).person;
  assert.ok(!('followers' in seen) && !('social_reach' in seen), 'a volunteer’s profile has no counts');
  okR(await mgr.action('permission.member.set', { user_id: volUser.id, grant: [], deny: [] }));
  okR(await mgr.action('person.followers.set', { id: P.lin.id, platform: 'instagram', followers: null }));
  r = await row(P.lin.id);
  assert.equal(r.followers, 12400);
  assert.deepEqual(Object.keys(r.social_reach), ['x']);

  // Removing the handle removes its count; the largest is worked out again.
  okR(await mgr.action('person.followers.set', { id: P.lin.id, platform: 'instagram', followers: 3000 }));
  okR(await mgr.action('person.social.remove', { id: P.lin.id, platform: 'x' }));
  r = await row(P.lin.id);
  assert.deepEqual(Object.keys(r.social_reach), ['instagram']);
  assert.equal(r.followers, 3000);
  okR(await mgr.action('person.social.set', { id: P.lin.id, platform: 'x', value: '@linreports' }));
  okR(await mgr.action('person.followers.set', { id: P.lin.id, platform: 'x', followers: 12400 }));
});

test('an old page’s person.update: a changed handle clears its count (one followers event), an unchanged one emits nothing more', async () => {
  const before = (await eventsAbout(P.lin.id)).length;
  okR(await mgr.action('person.update', { id: P.lin.id, socials: { instagram: 'lin.example', x: 'linreports' }, phone: '604-555-0150' }));
  let evs = (await eventsAbout(P.lin.id)).slice(before);
  assert.equal(evs.length, 1, JSON.stringify(evs));
  assert.equal((await row(P.lin.id)).followers, 12400);

  const mid = (await eventsAbout(P.lin.id)).length;
  okR(await mgr.action('person.update', { id: P.lin.id, socials: { instagram: 'lin.example', x: 'lin_new' } }));
  evs = (await eventsAbout(P.lin.id)).slice(mid);
  assert.equal(evs.length, 2, JSON.stringify(evs));
  assert.deepEqual(evs[1].payload, { followers: 3000 }, 'the log explains the column');
  const r = await row(P.lin.id);
  assert.equal(r.followers, 3000);
  assert.deepEqual(Object.keys(r.social_reach), ['instagram']);

  // An old value the reader refuses is kept as it was (never blocks the save).
  okR(await mgr.action('person.update', { id: P.ana.id, socials: { x: 'ana_ex', other: 'Lin Example!!' } }));
  assert.equal((await row(P.ana.id)).socials.other, 'Lin Example!!');
});

test('a merge keeps the count typed for the handle the kept record has', async () => {
  const keep = await mgr.createPerson('Mo Example', { phone: '604-555-0160' });
  const drop = await mgr.createPerson('Mo Example', { phone: '604-555-0161' });
  okR(await mgr.action('person.social.set', { id: keep.id, platform: 'instagram', value: '@mo_keep' }));
  okR(await mgr.action('person.social.set', { id: drop.id, platform: 'instagram', value: '@mo_drop' }));
  okR(await mgr.action('person.social.set', { id: drop.id, platform: 'tiktok', value: '@mo_tok' }));
  okR(await mgr.action('person.followers.set', { id: keep.id, platform: 'instagram', followers: 150 }));
  okR(await mgr.action('person.followers.set', { id: drop.id, platform: 'instagram', followers: 90000 }));
  okR(await mgr.action('person.followers.set', { id: drop.id, platform: 'tiktok', followers: 4000 }));
  okR(await mgr.action('person.merge', { keep: keep.id, drop: drop.id }));
  const r = await row(keep.id);
  assert.deepEqual(r.socials, { instagram: 'mo_keep', tiktok: 'mo_tok' });
  assert.equal(r.social_reach.instagram.n, 150, 'the kept handle’s count, not the other record’s');
  assert.equal(r.social_reach.tiktok.n, 4000, 'a network only the other had comes with its count');
  assert.equal(r.followers, 4000);
});

test('People filters: any social, threads, a following; a volunteer can’t sort by followers', async () => {
  okR(await mgr.action('person.social.set', { id: P.kai.id, value: 'threads.net/@kai.example' }));
  const names = async (client, qs) => okR(await client.get(`/api/persons?${qs}&limit=100`)).persons.map((p) => p.name).sort();
  assert.deepEqual(await names(mgr, 'has=threads'), ['Kai Example']);
  const social = await names(mgr, 'has=social');
  assert.ok(social.includes('Kai Example') && social.includes('Lin Example') && social.includes('Ana Example'));
  assert.ok(!social.includes('Riley Manager'));
  assert.deepEqual(await names(mgr, 'followers=1000'), ['Lin Example', 'Mo Example']);
  assert.deepEqual(await names(mgr, 'followers=10000'), []);
  const all = (await names(mgr, 'x=1')).length;
  assert.equal((await names(mgr, 'followers=junk')).length, all, 'a junk value is no filter');
  assert.equal((await names(mgr, 'followers=0')).length, all);
  const rows = okR(await mgr.get('/api/persons?followers=1000')).persons;
  assert.equal(rows.find((p) => p.name === 'Lin Example').followers, 3000, 'the desk’s rows carry the count when sorted by it');
  assert.ok(!('followers' in okR(await mgr.get('/api/persons?has=social')).persons[0]));
  assert.equal(okR(await mgr.get('/api/persons/count?followers=1000')).total, 2);

  const list = okR(await mgr.action('list.create', { name: 'Big followings', kind: 'filter', filter: { followers: '1000' } }));
  assert.deepEqual(list.list.filter, { followers: '1000' });
  assert.equal(okR(await mgr.get(`/api/lists/${list.list.id}`)).total, 2);

  okR(await mgr.action('permission.member.set', { user_id: volUser.id, grant: ['people'], deny: [] }));
  assert.deepEqual(await names(vol, 'followers=1000'), [], 'a volunteer learns nothing of who has a following');
  assert.ok((await names(vol, 'has=social')).includes('Kai Example'), 'any social works for a volunteer');
  assert.equal((await vol.action('list.create', { name: 'x', kind: 'filter', filter: { followers: '1000' } })).status, 403);
  okR(await mgr.action('permission.member.set', { user_id: volUser.id, grant: [], deny: [] }));
});

test('followers= is found through its index', async () => {
  const db = await getDb();
  // Enough people that the planner chooses as it would on a real list.
  await db.query(
    `insert into persons (id, workspace_id, name) select gen_random_uuid(), $1, 'Bulk ' || g from generate_series(1, 5000) g`, [ws],
  );
  await db.query('analyze persons');
  const ctx = { workspaceId: ws, role: 'manager', user: { id: null } };
  const { where, params } = await personsWhere(db, ctx, { followers: '1000' });
  params[3] = 1;
  const plan = await db.transaction(async (tx) => {
    await tx.query('set local enable_seqscan = off');
    return (await tx.query(`explain select count(*) from persons p where ${where}`, params)).rows.map((r) => Object.values(r)[0]).join('\n');
  });
  assert.match(plan, /persons_followers_idx/, plan);
});

test('import: every network, a social column of links, bad cells left out and counted, blanks filled only', async () => {
  const imp = (rows, extra = {}) => mgr.post('/api/data/import', { rows, ...extra });
  const rows = [
    { name: 'Bo Example', phone: '604-555-0170', bluesky: 'bo', facebook: 'facebook.com/bo.example', linkedin: 'https://www.linkedin.com/in/bo-example', youtube: '@BoExample', threads: '@bo.ex' },
    { name: 'Cy Example', phone: '604-555-0171', instagram: 'https://www.instagram.com/p/C1abc/', social: 'https://x.com/cy_ex, https://www.tiktok.com/@cy.ex @cy_loose' },
    { name: 'Di Example', phone: '604-555-0172', x: 'not a handle at all' },
  ];
  const dry = okR(await imp(rows, { dryRun: true }));
  assert.equal(dry.handles_left_out, 3);
  assert.deepEqual(dry.handles_left_out_rows, [
    { row: 2, column: 'instagram', value: 'https://www.instagram.com/p/C1abc/' },
    { row: 2, column: 'social', value: '@cy_loose' },
    { row: 3, column: 'x', value: 'not a handle at all' },
  ]);
  const done = okR(await imp(rows));
  assert.equal(done.created, 3);
  assert.equal(done.handles_left_out, 3);
  const db = await getDb();
  const by = async (name) => (await db.query('select socials from persons where workspace_id = $1 and name = $2 and deleted_at is null', [ws, name])).rows[0].socials;
  assert.deepEqual(await by('Bo Example'), { bluesky: 'bo.bsky.social', facebook: 'bo.example', linkedin: 'bo-example', youtube: 'BoExample', threads: 'bo.ex' });
  assert.deepEqual(await by('Cy Example'), { x: 'cy_ex', tiktok: 'cy.ex' });
  assert.deepEqual(await by('Di Example'), {});

  // Again, with other handles: only the empty ones fill.
  okR(await imp([{ name: 'Bo Example', phone: '604-555-0170', bluesky: 'bo2.example.org', instagram: '@bo.gram' }]));
  assert.deepEqual(await by('Bo Example'), { bluesky: 'bo.bsky.social', facebook: 'bo.example', linkedin: 'bo-example', youtube: 'BoExample', threads: 'bo.ex', instagram: 'bo.gram' });
});
