// Sharing E2E — share kits on one fresh in-memory campaign. A manager at a
// desk (1440) sets the authorization line, makes a post on Outreach →
// Sharing for the open petition (with a picture), and sees it listed. A
// volunteer on a 390×844 phone sees "Share · 1 post" on Today, opens /share:
// their link (/r/…), the post's link (/r/…?k=…), Copy words copies the words
// and the link, Share opens WhatsApp · Text · Facebook · X · Email · Copy in
// place (no share sheet in this browser), and — with navigator.share stubbed —
// the phone's sheet gets the words and the link. A friend in a fresh browser
// opens the link, lands on the petition, goes to the home page, comes back to
// the petition with no tag in the address and signs. The manager then sees
// "1 sign-up · 1 sharer" and the volunteer in Top sharers; the volunteer's
// "1 person brought in". With no signal the kept copy still shows the post and
// copying works. Closing the petition: "Page not live" on the desk and the
// post leaves /share and Today. Granted Outreach, the volunteer gets
// Outreach → Sharing and "New post to share". Both screens are measured at
// 390 and 1440.
//
//   STARBASE_OPEN_SIGNUP=1 STARBASE_DATA=memory PORT=5110 node server/index.js &
//   BASE=http://127.0.0.1:5110 SHOTS=/tmp/sharing node e2e-sharing.mjs
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:5110';
const ADMIN = `${BASE}/admin`;
const SHOTS = process.env.SHOTS || '/tmp/starbase-sharing';
mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 240) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Date.now().toString(36);
const LINE = 'Authorized by Pat Example, official agent, 604-555-0100';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const errors = [];
const helpers = (page, who, root) => {
  page.on('pageerror', (e) => errors.push(`[${who}] ${e.message}`));
  return {
    shot: (n) => page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: false }),
    full: (n) => page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true }),
    api: (path, body) => page.evaluate(async ([p, b]) => {
      const r = await fetch('/api' + p, b === undefined ? {} : {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b),
      });
      const raw = await r.text();
      let json = null;
      try { json = JSON.parse(raw); } catch { /* not json */ }
      return { status: r.status, json, raw };
    }, [path, body]),
    go: async (path) => { await page.goto(`${root}${path}`, { waitUntil: 'domcontentloaded' }); await sleep(900); },
  };
};
const measure = (page) => page.evaluate(() => {
  const main = document.querySelector('main.page') || document.body;
  const words = (main.innerText || '').split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const yellow = [...document.querySelectorAll('.btn-primary')].filter(visible).length;
  const overflow = document.documentElement.scrollWidth - window.innerWidth;
  let minTap = null;
  let minWho = '';
  for (const el of main.querySelectorAll('input:not([type=checkbox]):not([type=file]), select, textarea, button, a.btn, .sk-row, label.btn')) {
    if (!visible(el)) continue;
    const h = el.getBoundingClientRect().height;
    if (minTap == null || h < minTap) { minTap = h; minWho = el.outerHTML.slice(0, 80); }
  }
  return { words, yellow, overflow, minTap, minWho };
});
const tapFloor = (page) => page.evaluate(() => (matchMedia('(min-width: 900px) and (pointer: fine)').matches ? 40 : 48));
const measured = [];
const simple = async (page, name) => {
  const m = await measure(page);
  const floor = await tapFloor(page);
  measured.push(`${name}: words=${m.words} yellow=${m.yellow}`);
  check(`${name}: ≤1 yellow, no sideways scroll, targets ≥${floor}px`, m.yellow <= 1 && m.overflow <= 0 && (m.minTap == null || m.minTap >= floor - 0.5),
    `words=${m.words} yellow=${m.yellow} overflow=${m.overflow} minTap=${m.minTap} ${m.minTap < floor - 0.5 ? m.minWho : ''}`);
  return m;
};
const until = async (fn, ms = 15000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(400);
  }
};
const tc = (p, sel) => p.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');

// ── 1. The manager: the line, then a post on Outreach → Sharing ──
const dctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'America/Vancouver' });
const page = await dctx.newPage();
const D = helpers(page, 'desk', ADMIN);
await D.go('/signup');
await page.fill('#su-name', 'Riley Manager');
if (await page.locator('#su-org').count()) await page.fill('#su-org', 'Imagine Surrey');
await page.fill('#su-email', `riley+${tag}@sharing.example`);
await page.fill('#su-password', 'surrey-forward-2026');
await page.click('button[type="submit"]');
await page.waitForURL(/\/admin\/?$/, { timeout: 15000 });
const petition = (await D.api('/site/campaigns')).json.campaigns.find((c) => c.kind === 'petition' && c.status === 'open');
check('the website has an open petition', !!petition, petition?.slug);
const org = (await D.api('/site')).json.settings.org;
check('authorization line saved', (await D.api('/actions/site.settings.save', { org: { ...org, authorizationLine: LINE } })).status === 200);

await D.go('/outreach/sharing');
await page.waitForSelector('text=Nothing to share yet.', { timeout: 8000 }).catch(() => {});
check('Sharing: empty says "Nothing to share yet."', await page.locator('text=Nothing to share yet.').count() === 1);
const tabs = await page.$$eval('.ot-tab-label', (els) => els.map((e) => e.textContent.trim()));
check('Outreach tabs: Email · Texting · Sharing', tabs.join(' · ') === 'Email · Texting · Sharing', tabs.join(' · '));
await simple(page, 'Sharing empty (desk 1440)');
await D.shot('01-sharing-empty-1440');
await page.setViewportSize({ width: 390, height: 844 });
await sleep(300);
await simple(page, 'Sharing empty (390)');
await D.shot('02-sharing-empty-390');
await page.setViewportSize({ width: 1440, height: 900 });

await page.click('button.btn-primary:has-text("New post to share")');
await page.fill('.sk-edit input.input', 'Sign for SkyTrain');
await page.fill('.sk-edit textarea', 'I signed for SkyTrain to South Surrey. Will you?');
await page.selectOption('.sk-edit select', `/act/${petition.slug}`);
check('the editor shows the line and its reminder', /Pictures should carry this line/.test(await page.innerText('.sk-edit')) && (await page.innerText('.sk-edit')).includes(LINE));
check('the checkbox "Add “Authorized by …” to the words" is on', await page.isChecked('.sk-check input'));
check('the counter counts the line and says it fits X', /of 500 with the Authorized by line · Under 280 fits X/.test(await tc(page, '.sk-count')), await tc(page, '.sk-count'));
// A picture, under More details.
await page.click('.sk-more');
const png = await page.evaluate(() => {
  const c = document.createElement('canvas');
  c.width = 400; c.height = 240;
  const g = c.getContext('2d');
  g.fillStyle = '#0b5'; g.fillRect(0, 0, 400, 240);
  g.fillStyle = '#fff'; g.font = '40px sans-serif'; g.fillText('SkyTrain', 100, 130);
  return c.toDataURL('image/png').split(',')[1];
});
await page.setInputFiles('.sk-edit input[type=file]', { name: 'skytrain.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
await page.waitForSelector('.sk-pic', { timeout: 8000 }).catch(() => {});
check('the picture is uploaded', await page.locator('.sk-pic').count() === 1);
await page.click('.sk-edit button[type=submit]');
await until(async () => (await D.api('/share/kits')).json?.kits?.length === 1);
const kit = (await D.api('/share/kits')).json.kits[0];
check('saved: one post, its page live, a picture', kit?.live === true && !!kit.media_id && kit.path === `/act/${petition.slug}`, JSON.stringify(kit).slice(0, 200));
await sleep(600);
await simple(page, 'Sharing post open (desk 1440)');
await D.full('03-sharing-kit-open-1440');
await page.setViewportSize({ width: 390, height: 844 });
await sleep(300);
await simple(page, 'Sharing post open (390)');
await D.full('04-sharing-kit-open-390');
await page.setViewportSize({ width: 1440, height: 900 });

// ── 2. A volunteer on a phone: Today, then /share ──
const invite = (await D.api('/actions/member.invite', { email: `vic+${tag}@example.org`, role: 'volunteer' })).json;
const vctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/Vancouver' });
await vctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
const vpage = await vctx.newPage();
const V = helpers(vpage, 'vol', BASE);
await V.go('/login');
const joined = await V.api('/auth/join', { token: invite.joinUrl.split('/').pop(), name: 'Vic Example', password: 'knock-knock-2026' });
check('Vic joined as a volunteer', joined.status === 200 && joined.json.role === 'volunteer', joined.status);
await V.go('/');
await vpage.waitForSelector('a[href="/share"]', { timeout: 8000 }).catch(() => {});
const row = await tc(vpage, 'a[href="/share"]');
check('Today: "Share · 1 post"', /^Share · 1 post/.test(row), row);
await V.shot('05-today-share-row-390');
await vpage.click('a[href="/share"]');
await vpage.waitForSelector('.sh-kit', { timeout: 10000 }).catch(() => {});
const mine = await tc(vpage, '.sh-url');
check('their link: /site/r/<code>', /\/site\/r\/[a-z0-9]{8}$/.test(mine), mine);
const share = (await V.api('/share')).json;
const link = share.kits[0]?.link || '';
check('the post’s link has /r/ and k=', link.includes('/r/') && link.includes(`k=${kit.code}`), link);
check('the words carry the authorization line', (await tc(vpage, '.sh-text')).includes(LINE));
check('"0 people brought in"', /0 people brought in/.test(await tc(vpage, '.sh-big')), await tc(vpage, '.sh-big'));
await vpage.click('.sh-under button:has-text("Copy words")');
await sleep(300);
const clip = await vpage.evaluate(() => navigator.clipboard.readText()).catch((e) => `ERR ${e.message}`);
check('Copy words copies the words and the link', clip.includes('Will you?') && clip.endsWith(link), clip);
check('…and says so', /copied/i.test(await tc(vpage, '.sh-page > .ops-sr')), await tc(vpage, '.sh-page > .ops-sr'));
const hasShare = await vpage.evaluate(() => typeof navigator.share === 'function');
if (!hasShare) {
  await vpage.click('.sh-share');
  const targets = await vpage.$$eval('.sh-targets li', (els) => els.map((e) => e.textContent.trim()));
  check('Share without a share sheet: WhatsApp · Text · Facebook · X · Email · Copy in place', targets.join(' · ') === 'WhatsApp · Text · Facebook · X · Email · Copy', targets.join(' · '));
  const wa = await vpage.getAttribute('.sh-targets a:has-text("WhatsApp")', 'href');
  check('WhatsApp carries the kit’s own link', decodeURIComponent(wa).includes(link), wa);
}
await simple(vpage, '/share with a post (390)');
await V.full('06-share-volunteer-390');

// With the phone's share sheet (stubbed).
await vpage.addInitScript(() => {
  window.__shared = [];
  navigator.share = async (d) => { window.__shared.push({ text: d.text, url: d.url, files: (d.files || []).length }); };
  navigator.canShare = () => true;
});
await vpage.reload({ waitUntil: 'domcontentloaded' });
await vpage.waitForSelector('.sh-kit', { timeout: 10000 }).catch(() => {});
await sleep(800);
await vpage.click('.sh-share');
await sleep(400);
const got = await vpage.evaluate(() => window.__shared);
check('the share sheet gets the words and the link (and the picture)', got.length === 1 && got[0].text.includes('Will you?') && got[0].url === link && got[0].files === 1, JSON.stringify(got));

// ── 3. A friend opens the link, looks around, signs ──
const fctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const fpage = await fctx.newPage();
fpage.on('pageerror', (e) => errors.push(`[friend] ${e.message}`));
await fpage.goto(link, { waitUntil: 'domcontentloaded' });
check('the link lands on the petition, tagged', fpage.url().includes(`/site/act/${petition.slug}?source=kit-${kit.code}`), fpage.url());
await fpage.goto(`${BASE}/site/`, { waitUntil: 'domcontentloaded' });
const back = fpage.locator(`a[href$="/act/${petition.slug}"]`).first();
if (await back.count()) await back.click(); else await fpage.goto(`${BASE}/site/act/${petition.slug}`, { waitUntil: 'domcontentloaded' });
await fpage.waitForLoadState('domcontentloaded');
check('back on the petition with no tag in the address', fpage.url().endsWith(`/act/${petition.slug}`), fpage.url());
const form = fpage.locator('form[action$="/api/forms/petition"]').first();
await form.waitFor({ timeout: 10000 }).catch(() => {});
await sleep(800); // the island takes the form over
await form.getByLabel('First name').fill('Fay');
await form.getByLabel('Last name').fill('Example');
await form.getByLabel('Email', { exact: true }).fill(`fay+${tag}@example.org`);
await form.getByLabel('Postal code').fill('V3S 0A1');
await form.locator('button[type=submit]').click();
await fpage.locator('.success-card').first().waitFor({ timeout: 10000 }).catch(() => {});
await fpage.screenshot({ path: `${SHOTS}/friend-signed.png`, fullPage: false });
check('the friend signed', await fpage.locator('.success-card').count() > 0, await fpage.locator('.form-alert, [role=alert]').allInnerTexts().then((t) => t.join(' | ')).catch(() => ''));

// ── 4. What the desk and the volunteer see ──
await until(async () => (await D.api('/share/kits')).json.kits[0]?.signups === 1);
await D.go('/outreach/sharing');
await page.waitForSelector('.sk-row', { timeout: 8000 }).catch(() => {});
const nums = await tc(page, '.sk-row .sk-nums');
check('the desk: "1 sign-up · 1 sharer"', nums === '1 sign-up · 1 sharer', nums);
await until(async () => (await page.locator('.sk-top li').count()) > 0, 5000);
const top = await page.$$eval('.sk-section .sk-top li', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
check('Top sharers: Vic Example', top.some((t) => /^Vic Example\s*1 brought in/.test(t)), top.join(' | '));
await simple(page, 'Sharing list (desk 1440)');
await D.shot('07-sharing-list-1440');
await page.click('.sk-row');
await page.waitForSelector('.sk-edit .sk-top li', { timeout: 8000 }).catch(() => {});
check('the post’s own top sharers: Vic Example 1', /Vic Example\s*1/.test(await tc(page, '.sk-edit .sk-top li')), await tc(page, '.sk-edit .sk-top li'));
await D.full('08-sharing-kit-sharers-1440');

await V.go('/share');
await vpage.waitForSelector('.sh-big', { timeout: 8000 }).catch(() => {});
await until(async () => /1 person brought in/.test(await tc(vpage, '.sh-big')), 5000);
check('the volunteer: "1 person brought in"', /1 person brought in/.test(await tc(vpage, '.sh-big')), await tc(vpage, '.sh-big'));
await vpage.setViewportSize({ width: 1440, height: 900 });
await sleep(300);
await simple(vpage, '/share with a post (1440)');
await V.shot('09-share-volunteer-1440');
await vpage.setViewportSize({ width: 390, height: 844 });

// ── 5. No signal: the kept copy ──
await V.go('/');
await sleep(1500); // the copy is kept a moment after it settles
await vctx.setOffline(true);
await vpage.click('a[href="/share"]').catch(() => {});
await vpage.waitForSelector('.sh-kit', { timeout: 8000 }).catch(() => {});
check('no signal: the post and the link still show', await vpage.locator('.sh-kit').count() === 1 && /\/r\//.test(await tc(vpage, '.sh-url')));
check('no signal: "Pictures need signal"', /Pictures need signal/.test(await tc(vpage, '.sh-under')), await tc(vpage, '.sh-under'));
await vpage.click('.sh-under button:has-text("Copy words")');
await sleep(300);
const clip2 = await vpage.evaluate(() => navigator.clipboard.readText()).catch(() => '');
check('no signal: copying still works', clip2.endsWith(link), clip2);
await V.shot('10-share-offline-390');
await vctx.setOffline(false);

// ── 6. The petition closes: Page not live; the post leaves /share and Today ──
check('petition closed', (await D.api('/actions/site.campaign.close', { id: petition.id })).status === 200);
await D.go('/outreach/sharing');
await page.waitForSelector('.sk-warn', { timeout: 8000 }).catch(() => {});
check('the desk: a "Page not live" chip', (await tc(page, '.sk-warn')) === 'Page not live');
await D.shot('11-sharing-not-live-1440');
await page.click('.sk-row');
await sleep(500);
check('…and in the post: "The page this opens isn’t live. Pick another page."', /The page this opens isn’t live\. Pick another page\./.test(await page.innerText('.sk-edit')));
await V.go('/share');
await vpage.waitForSelector('.sh-empty', { timeout: 8000 }).catch(() => {});
check('/share: "Nothing to share yet."', (await tc(vpage, '.sh-empty')) === 'Nothing to share yet.');
await simple(vpage, '/share empty (390)');
await V.shot('12-share-empty-390');
await V.go('/');
check('Today: no Share row', await vpage.locator('a[href="/share"]').count() === 0);

// ── 7. A volunteer granted Outreach writes posts too, from the app ──
const vicId = joined.json.user?.id;
check('Vic granted Outreach', (await D.api('/actions/permission.member.set', { user_id: vicId, grant: ['outreach'], deny: [] })).status === 200);
await vpage.goto(`${ADMIN}/outreach`, { waitUntil: 'domcontentloaded' });
await vpage.waitForSelector('.ot-tab-label', { timeout: 8000 }).catch(() => {});
await sleep(600);
const vtabs = await vpage.$$eval('.ot-tab-label', (els) => els.map((e) => e.textContent.trim()));
check('granted: Outreach opens on Sharing (email and texting stay the desk’s)', vtabs.join(' · ') === 'Sharing' && /\/outreach\/sharing$/.test(new URL(vpage.url()).pathname), `${vtabs.join(' · ')} ${vpage.url()}`);
check('granted: "New post to share"', await vpage.locator('button.btn-primary:has-text("New post to share")').count() === 1);
await simple(vpage, 'Sharing, a volunteer granted Outreach (390)');
await vpage.screenshot({ path: `${SHOTS}/13-sharing-granted-volunteer-390.png` });
check('Outreach taken back', (await D.api('/actions/permission.member.set', { user_id: vicId, grant: [], deny: [] })).status === 200);

check('hash chain still verifies', (await D.api('/audit/verify')).json.ok === true);
check('no page errors', errors.length === 0, errors.join(' | '));
console.log(`\n${measured.join('\n')}`);

await browser.close();
const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
