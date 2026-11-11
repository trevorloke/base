// Settings → Brand, underneath (ext/brand): a manager uploads the campaign's
// pictures and saves its brand; nobody else can. A picture's type and size
// are read from its own bytes — never what the browser says — and each kind
// has its limits (a logo, a square mark, app icons of exact sizes); an SVG
// or a GIF is refused. The brand is stored whole in the campaign's settings
// and its event carries picture ids, never bytes. Any colour a manager
// could pick is saved: its shades are worked out readable, not refused.
// The pictures are served at /brand/<id> as /media/<id> serves them.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';
import { png, jpeg, webp, dataUrl } from './brand-images.js';
import { imageSize, pictureProblem } from '../ext/brand/pictures.js';
import { deriveLook, SIDEBARS } from '@starbase/shared/brand-look';

let db, mgr, staff, vol, other;
before(async () => {
  db = await freshDb();
  mgr = new Client();
  await mgr.signup({ workspaceName: 'Riverside Forward', jurisdiction: 'bc-municipal' });
  const join = async (role, email) => {
    const inv = await mgr.action('member.invite', { email, role });
    const c = new Client();
    await c.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: `${role} Example`, password: 'brand-pass-123' });
    return c;
  };
  staff = await join('staff', 'brand.staff@example.org');
  vol = await join('volunteer', 'brand.vol@example.org');
  other = new Client();
  await other.signup({ workspaceName: 'Another Campaign', jurisdiction: 'bc-municipal' });
});

const upload = (c, kind, buf, type) => c.action('brand.picture', { kind, data: dataUrl(buf, type), name: `${kind}.png` });
const lastEvent = async (entity) => {
  const ev = (await db.query('select payload, action from events where entity_type = $1 order by seq desc limit 1', [entity])).rows[0];
  return { ...ev, payload: typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload };
};

test('a picture’s size is read from its own header: PNG, JPEG and WebP', () => {
  assert.deepEqual(imageSize(png(600, 120)), { w: 600, h: 120 });
  assert.deepEqual(imageSize(jpeg(800, 200)), { w: 800, h: 200 });
  assert.deepEqual(imageSize(webp(1024, 300)), { w: 1024, h: 300 });
  assert.equal(imageSize(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>')), null);
  assert.equal(imageSize(png(10, 10).subarray(0, 14)), null, 'a header cut short');
});

test('the limits, kind by kind, in the manager’s words', () => {
  assert.equal(pictureProblem('logo', png(600, 120)), null);
  assert.match(pictureProblem('logo', png(2000, 200)), /2,000 × 200 px — 1,024 px at most/);
  assert.match(pictureProblem('logo', png(300, 40)), /40 px tall — it needs at least 64 px/);
  assert.match(pictureProblem('logo', png(400, 400, { noise: true })), /too big — 512 KB at most/);
  assert.equal(pictureProblem('logoDark', webp(800, 160)), null);
  assert.equal(pictureProblem('mark', png(512, 512)), null);
  assert.match(pictureProblem('mark', png(600, 400)), /must be square — this one is 600 × 400/);
  assert.match(pictureProblem('mark', png(100, 100)), /at least 180 × 180/);
  assert.equal(pictureProblem('icon192', png(192, 192)), null);
  assert.equal(pictureProblem('touch', png(180, 180)), null);
  assert.match(pictureProblem('icon512', png(500, 500)), /must be a PNG of 512 × 512 px — this one is 500 × 500/);
  assert.match(pictureProblem('icon192', jpeg(192, 192)), /must be a PNG of 192 × 192 px — this one is a JPG of 192 × 192/);
  assert.match(pictureProblem('logo', Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00')), /JPG, PNG or WebP/);
});

test('brand.picture: a manager’s upload is kept and served at /brand/<id>; its type comes from the bytes', async () => {
  const r = await upload(mgr, 'logo', png(600, 120), 'image/jpeg');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const p = r.json.picture;
  assert.deepEqual([p.kind, p.type, p.content_type, p.width, p.height, p.url], ['logo', 'png', 'image/png', 600, 120, `/brand/${p.id}.png`], 'a PNG whatever the browser called it');
  const res = await app.request(p.url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('content-security-policy'), "default-src 'none'");
  assert.match(res.headers.get('cache-control'), /immutable/);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), png(600, 120));
  assert.equal((await app.request(`/media/${p.id}.png`)).status, 200, 'the same bytes for the public pages');
  assert.equal((await app.request('/brand/not-an-id.png')).status, 404);
  const ev = await lastEvent('media');
  assert.equal(ev.payload.for, 'brand');
  assert.equal(ev.payload.kind, 'logo');
  assert.ok(!JSON.stringify(ev.payload).includes(png(600, 120).toString('base64').slice(0, 40)), 'the event has no bytes');
  assert.deepEqual(Object.keys(ev.payload).sort(), ['bytes', 'content_type', 'for', 'height', 'id', 'kind', 'name', 'width']);
});

test('brand.picture refuses an SVG, a GIF, a picture past its limits, and anyone but a manager', async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100"><script>alert(1)</script></svg>');
  const refused = async (c, kind, buf, re, status = 400) => {
    const r = await upload(c, kind, buf);
    assert.equal(r.status, status, `${kind}: ${JSON.stringify(r.json)}`);
    if (re) assert.match(r.json.error, re);
  };
  await refused(mgr, 'logo', svg, /JPG, PNG or WebP/);
  await refused(mgr, 'logo', Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00\x00\x00\x00'), /JPG, PNG or WebP/);
  await refused(mgr, 'logo', png(2000, 300), /1,024 px at most/);
  await refused(mgr, 'logo', png(400, 400, { noise: true }), /512 KB at most/);
  await refused(mgr, 'mark', png(600, 400), /square/);
  await refused(mgr, 'icon192', png(256, 256), /192 × 192/);
  await refused(mgr, 'banner', png(100, 100), /kind/);
  await refused(staff, 'logo', png(600, 120), /may not/, 403);
  await refused(vol, 'logo', png(600, 120), /may not/, 403);
  const n = (await db.query("select count(*)::int as n from media where name = 'logo.png'")).rows[0].n;
  assert.equal(n, 1, 'only the manager’s one good upload was kept');
});

// What a manager uploads before saving: a logo, its dark-ground version, a
// square mark and the four icons the browser makes from it.
const uploadSet = async (c) => {
  const id = async (kind, buf, type) => { const r = await upload(c, kind, buf, type); assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json.picture.id; };
  return {
    logo: await id('logo', png(640, 128)),
    logoDark: await id('logoDark', webp(640, 128), 'image/webp'),
    mark: await id('mark', png(512, 512)),
    icons: { i192: await id('icon192', png(192, 192)), i512: await id('icon512', png(512, 512)), maskable: await id('maskable', png(512, 512)), touch: await id('touch', png(180, 180)) },
  };
};

let set;
test('brand.save: a manager saves the whole brand; it is the campaign’s, and the record has ids, never bytes', async () => {
  set = await uploadSet(mgr);
  const r = await mgr.action('brand.save', {
    color: '#FFF100', second: '#D81B1E', sidebar: 'brand', corners: 'round', heading: 'montserrat',
    learn: '  Volunteer   school ', short_name: 'Riverside', email_header: true,
    logo: { id: set.logo }, logo_dark: { id: set.logoDark }, mark: { id: set.mark }, icons: set.icons,
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const want = {
    v: 1, color: '#fff100', second: '#d81b1e', sidebar: 'brand', corners: 'round', heading: 'montserrat',
    learn: 'Volunteer school', shortName: 'Riverside', emailHeader: true,
    logo: { id: set.logo, type: 'png', w: 640, h: 128 }, logoDark: { id: set.logoDark, type: 'webp', w: 640, h: 128 },
    mark: { id: set.mark, type: 'png', w: 512, h: 512 }, icons: set.icons,
  };
  assert.deepEqual(r.json.brand, want);
  assert.deepEqual((await mgr.get('/api/auth/me')).json.workspace.settings.brand, want, 'in the campaign’s settings, for every screen');
  assert.deepEqual((await vol.get('/api/auth/me')).json.workspace.settings.brand, want, 'everyone’s app gets it');
  const ev = await lastEvent('workspace');
  assert.equal(ev.action, 'brand.save');
  assert.deepEqual(ev.payload, { brand: want }, 'ids and sizes; no bytes');
  assert.equal((await mgr.get('/api/audit/verify')).json.ok, true);
  // Another campaign's brand is its own.
  assert.equal((await other.get('/api/auth/me')).json.workspace.settings.brand, undefined);
});

test('brand.save: managers only', async () => {
  for (const c of [staff, vol]) {
    const r = await c.action('brand.save', { color: '#003979' });
    assert.equal(r.status, 403, JSON.stringify(r.json));
  }
  assert.equal((await mgr.get('/api/auth/me')).json.workspace.settings.brand.color, '#fff100', 'unchanged');
});

test('brand.save refuses what isn’t a choice, and a picture that isn’t this campaign’s or doesn’t fit', async () => {
  const bad = async (input, re, why = '') => {
    const r = await mgr.action('brand.save', { color: '#003979', ...input });
    assert.equal(r.status, 400, `${why} ${JSON.stringify(input)} → ${JSON.stringify(r.json)}`);
    assert.match(r.json.error, re);
  };
  await bad({ color: 'red' }, /colour like #003979/);
  await bad({ color: '#00397' }, /colour/);
  await bad({ second: 'javascript:alert(1)' }, /colour/);
  await bad({ sidebar: 'purple' }, /sidebar/);
  await bad({ corners: 'spiky' }, /corners/);
  await bad({ heading: '</style><script>' }, /heading/);
  await bad({ short_name: '   ' }, /not blanks/);
  await bad({ learn: '\u0000\u0007' }, /not blanks/);
  await bad({ logo: { id: 'not-an-id' } }, /logo/);
  await bad({ logo: { id: '00000000-0000-4000-8000-000000000000' } }, /isn’t here any more/);
  const theirs = (await upload(other, 'logo', png(600, 120))).json.picture.id;
  await bad({ logo: { id: theirs } }, /isn’t here any more/, 'another campaign’s picture');
  // A picture from the website's uploads (bigger files allowed there) is
  // checked against the brand's limits, from its bytes.
  const site = await mgr.action('site.picture', { data: dataUrl(png(1800, 300)), width: 600, height: 100 });
  assert.equal(site.status, 200, JSON.stringify(site.json));
  await bad({ logo: { id: site.json.media.id } }, /1,800 × 300 px — 1,024 px at most/);
  await bad({ mark: { id: set.logo } }, /must be square/, 'a logo is not a mark');
  await bad({ icons: { ...set.icons, i192: set.mark } }, /192 × 192/, 'a 512 mark is not a 192 icon');
  assert.equal((await mgr.get('/api/auth/me')).json.workspace.settings.brand.color, '#fff100', 'nothing refused was kept');
});

test('brand.save: unsaid, training keeps its name and the home-screen name is base.win; no pictures, no email header', async () => {
  const r = await mgr.action('brand.save', { color: '#0f766e' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.brand, {
    v: 1, color: '#0f766e', second: null, sidebar: 'light', corners: 'soft', heading: 'inter',
    learn: 'ImagineU', shortName: 'base.win', emailHeader: false, logo: null, logoDark: null, mark: null, icons: null,
  }, 'tests run as Imagine Surrey’s deployment would (STARBASE_BRAND unset): its training name');
});

test('any colour a manager could pick is saved, each sidebar: its shades are worked out readable', async () => {
  for (const color of ['#fff100', '#d81b1e', '#f9a8d4', '#111111', '#ffffff', '#000000', '#003979']) {
    for (const sidebar of SIDEBARS) {
      const r = await mgr.action('brand.save', { color, sidebar, second: '#ffc72c' });
      assert.equal(r.status, 200, `${color} ${sidebar}: ${JSON.stringify(r.json)}`);
      for (const scheme of ['light', 'dark']) assert.deepEqual(deriveLook(r.json.brand, scheme).checks.filter((c) => !c.ok), [], `${color} ${sidebar} ${scheme}`);
    }
  }
});

test('brand.reset: back to the look the campaign started in; a second reset changes nothing', async () => {
  const r = await mgr.action('brand.reset', {});
  assert.deepEqual([r.status, r.json.reset], [200, true]);
  assert.equal((await mgr.get('/api/auth/me')).json.workspace.settings.brand, undefined);
  assert.deepEqual((await lastEvent('workspace')).payload, { brand: null });
  const seq = (await db.query('select max(seq)::int as n from events')).rows[0].n;
  assert.deepEqual((await mgr.action('brand.reset', {})).json.reset, false);
  assert.equal((await db.query('select max(seq)::int as n from events')).rows[0].n, seq, 'nothing written');
  assert.equal((await vol.action('brand.reset', {})).status, 403);
  assert.equal((await mgr.get('/api/audit/verify')).json.ok, true);
});
