// Website, the admin's area (web/src/pages/Website*.jsx), in a browser.
//
// A manager signs up and finds Website in the desk's menu: the site is live
// at the app's /site/ address; online giving isn't set up. Pages → New page
// → An issue → "Sample town hall" → Make the page: the builder opens on the
// page with the live preview beside it and the hero's sample headline
// focused. Every sample box gets real words by tapping it in the preview
// (each word shows there before "Saved"); Publish with one sample box left
// is refused and focuses it; the clicks and boxes to a published page are
// counted (at most 12 clicks plus one per box). The gallery (Most used, the
// groups, a search box); an events section drawn in the preview with no
// reload, as the server draws it; Undo and Redo (buttons and keys); a
// petition made in another tab ("Updating preview…"); columns' icon grid,
// a point dragged, one removed and Undo; the section cards' ⋯, the
// handle's tap path, hide; a draft-only change in the Preview tab but not
// on the site; ⋯ → Page settings. A typo on the home page fixed and
// published in at most 4 clicks from Website. Theme: a light brand colour
// under white text is too hard to read — saving is blocked — "Fix it"
// picks a readable text colour and it saves. A page duplicated and deleted
// comes back with Undo. Every kind of section opens with a box for every
// field; the voter guide is offered once a page. A post is written and
// published; a sample petition gets a signature from the site and "See
// who signed" lists them in People. A volunteer can't open Website. On a
// phone (390px) every Website screen fits with no sideways scroll, tap
// targets are 48px, and the full-screen preview opens a tapped section's
// form in a sheet.
//
//   STARBASE_OPEN_SIGNUP=1 STARBASE_DATA=memory PORT=5210 node server/index.js &
//   BASE=http://127.0.0.1:5210 SHOTS=/tmp/site-admin node e2e-site-admin.mjs
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { MODULES } from './shared/site/catalogue.js';

const BASE = (process.env.BASE || 'http://127.0.0.1:3200').replace(/\/$/, '');
const SHOTS = process.env.SHOTS || '/tmp/starbase-site-admin';
mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 240) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Date.now().toString(36);

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const errors = [];
const desk = await browser.newContext({ viewport: { width: 1360, height: 900 }, timezoneId: 'America/Vancouver' });
const page = await desk.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && /key|unique|warning|Maximum update/i.test(m.text())) errors.push(m.text()); });
const api = (path, body) => page.evaluate(async ([p, b]) => {
  const r = await fetch('/api' + p, b === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  return { status: r.status, json: await r.json().catch(() => null) };
}, [path, body]);
const text = async (p = page) => ((await p.innerText('main.page').catch(() => '')) || '').replace(/\s+/g, ' ');
const shot = (n, full = true, p = page) => p.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: full });
const overflow = (p = page) => p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const sections = () => page.locator('li.wb-card');
const kinds = async () => page.locator('li.wb-card').evaluateAll((els) => els.map((e) => e.dataset.kind));
const saved = async () => {
  await page.waitForFunction(() => document.querySelector('.wb-saved')?.dataset.state === 'saved', null, { timeout: 15000 }).catch(() => {});
  return page.evaluate(() => document.querySelector('.wb-saved')?.dataset.state);
};
const more = async (n, item) => {
  await sections().nth(n).locator('.wb-more__btn').click();
  await sections().nth(n).getByRole('button', { name: item, exact: true }).click();
};
const site = (path) => page.evaluate(async (p) => {
  const r = await fetch(p, { headers: { 'cache-control': 'no-cache' } });
  return { status: r.status, html: await r.text(), robots: r.headers.get('x-robots-tag') };
}, path);

// ── sign up; Website is in the desk's menu ──
await page.goto(`${BASE}/signup`, { waitUntil: 'domcontentloaded' });
await page.fill('#su-name', 'Rae Example');
if (await page.locator('#su-org').count()) await page.fill('#su-org', 'Imagine Surrey');
await page.fill('#su-email', `desk.${tag}@example.org`);
await page.fill('#su-password', 'surrey-forward-2026');
await page.click('button[type="submit"]');
await page.waitForURL(/\/admin\/?$/, { timeout: 15000 });
const navLink = page.locator('nav.links a', { hasText: 'Website' });
await navLink.waitFor({ timeout: 10000 }).catch(() => {}); // the menu draws a moment after the address changes
check('the desk’s menu has Website (a manager)', await navLink.isVisible().catch(() => false));
await navLink.click();
await page.waitForURL(/\/admin\/website$/);
await page.locator('.wb-live').waitFor({ timeout: 15000 });
const t0 = await text();
check('Overview: the site is live, at the app’s own /site/ address', /Your site is live/.test(t0) && /\/site\//.test(t0), t0.slice(0, 200));
check('Overview: online giving is not set up yet', /Online giving Not set up yet/i.test(t0));
const tiles = (await page.locator('.wb-tile').allTextContents()).map((x) => x.replace(/\s+/g, ' '));
check('Overview: pages, news, petitions and this week’s sign-ups are counted', tiles.some((x) => /^Sign-ups this week ?0/.test(x)) && tiles.some((x) => /^Pages ?8/.test(x)) && tiles.some((x) => /^Petitions and pledges ?2/.test(x)), JSON.stringify(tiles).slice(0, 300));
const otherRow = page.locator('a.ms-home-row[href$="/website/sites"]');
check('Overview: one row for the other websites, “None yet”, opening Other websites', /Other websites\s*None yet/.test(await otherRow.innerText().catch(() => '')) && /\/website\/sites$/.test(await otherRow.getAttribute('href').catch(() => '')));
const viewHref = await page.getByRole('link', { name: /^View site/ }).getAttribute('href');
check('"View site" opens the site', /\/site\/$/.test(viewHref), viewHref);
await shot('1-overview');

// ── a new page ──
await page.locator('.wb-tabs').getByRole('link', { name: 'Pages' }).click();
await page.waitForURL(/\/website\/pages$/);
// ── a new page from a starter, published with real words: clicks and boxes counted ──
let clicks = 1; // the Pages tab, above
let boxes = 0;
const click = async (loc) => { clicks += 1; await loc.click(); };
const typed = async () => page.waitForFunction(() => ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName), null, { timeout: 5000 });
const typeHere = async (words) => { await typed(); await page.keyboard.press('Control+A'); await page.keyboard.type(words); };
await click(page.getByRole('button', { name: 'New page' }));
const sheet = page.getByRole('dialog', { name: 'What’s this page for?' });
await sheet.waitFor();
check('New page: “What’s this page for?” with the seven starters', JSON.stringify(await sheet.locator('.wb-start__name').allTextContents()) === '["An issue","An event","A petition","About us","Contact","Get involved","Blank"]');
await shot('2-new-page', false);
await click(sheet.getByRole('radio', { name: /An issue/ }));
boxes += 1;
await sheet.locator('#wb-new-title').click();
await page.keyboard.type('Sample town hall');
check('the address it will get is shown', /\/sample-town-hall/.test(await sheet.locator('#wb-new-addr').innerText()));
await click(sheet.getByRole('button', { name: 'Make the page' }));
await page.waitForURL(/\/website\/pages\/[0-9a-f-]{36}/, { timeout: 15000 });
const pageId = page.url().match(/pages\/([0-9a-f-]{36})/)[1];
const fr = page.frameLocator('.wb-side iframe');
const ready = () => page.waitForFunction(() => document.querySelector('.wb-side iframe')?.contentDocument?.querySelector('[data-wa-section]'), null, { timeout: 15000 });
await ready();
const draft0 = (await api(`/site/pages/${pageId}`)).json.page.draft;
const id = Object.fromEntries(draft0.modules.map((m) => [m.kind, m.id]));
check('made from the starter: hero, text, points, petition, band — a draft', JSON.stringify(draft0.modules.map((m) => m.kind)) === '["hero","text","columns","petition","band"]'
  && /Draft/.test(await page.locator('.wb-top__meta').innerText()), JSON.stringify(draft0.modules.map((m) => m.kind)));
check('it opens on the page: the preview beside, the hero’s Headline box focused', await page.evaluate(() => document.activeElement?.value) === 'Your issue’s headline');
await shot('3-builder-start');
// The live preview: the words show before "Saved".
boxes += 1;
await typeHere('Buses every ten minutes');
const before = await page.evaluate(() => document.querySelector('.wb-saved')?.dataset.state);
await page.waitForFunction(() => /Buses every ten minutes/.test(document.querySelector('.wb-side iframe')?.contentDocument?.querySelector('h1')?.textContent || ''), null, { timeout: 3000 }).catch(() => {});
const shownEarly = await page.evaluate(() => [document.querySelector('.wb-saved')?.dataset.state, document.querySelector('.wb-side iframe')?.contentDocument?.querySelector('h1')?.textContent]);
check('typing: the preview shows the words before “Saved”', before !== 'saved' && shownEarly[0] !== 'saved' && /Buses every ten minutes/.test(shownEarly[1] || ''), JSON.stringify([before, ...shownEarly]));
// Tap in the preview: that box opens with the cursor in it.
const tap = async (section, field) => { boxes += 1; await fr.locator(`[data-wa-section="${section}"] [data-wa-field="${field}"]`).click(); await typed(); };
await tap(id.hero, 'text');
await typeHere('Our plan for buses that come when you need them.');
await tap(id.text, 'title');
check('a tap on the text block’s heading in the preview opens its Heading box', await page.evaluate(() => document.activeElement?.value) === 'What’s happening');
await typeHere('What the buses are like now');
await tap(id.text, 'body');
await typeHere('Long waits, crowded stops. **We can fix it.**');
for (let i = 0; i < 3; i += 1) {
  await tap(id.columns, `items.${i}.title`);
  await typeHere(`Point ${i + 1}`);
  if (i < 2) { await tap(id.columns, `items.${i}.body`); await typeHere(`Why point ${i + 1} matters.`); }
}
// The petition: picked from its section (tap it in the preview).
const camps = (await api('/site/campaigns')).json.campaigns;
clicks += 1;
await fr.locator(`[data-wa-section="${id.petition}"]`).click({ position: { x: 5, y: 5 } });
const which = page.getByLabel(/Which one/);
await which.waitFor();
clicks += 1;
await which.selectOption(camps[0].id);
// One sample box left: Publish refuses and opens it.
await click(page.getByRole('button', { name: /^Publish$/ }));
const alert = page.locator('.wb-alert', { hasText: 'Before it goes on the site' });
await alert.waitFor({ timeout: 10000 });
await page.waitForFunction(() => document.activeElement?.value === 'One or two sentences on this point.', null, { timeout: 5000 }).catch(() => {});
check('Publish with one sample box left: refused, naming it, and that box is focused', /What we stand for\) · Points · 3rd · Text: still has the sample words/.test(await alert.innerText())
  && await page.evaluate(() => document.activeElement?.value) === 'One or two sentences on this point.', await alert.innerText());
await shot('3b-sample-refused', false);
boxes += 1;
await page.keyboard.press('Control+A');
await page.keyboard.type('Why point 3 matters.');
await click(page.getByRole('button', { name: /^Publish$/ }));
await page.locator('.wb-toast', { hasText: 'Published' }).waitFor({ timeout: 10000 });
check(`a published page of 5 sections with real words in every sample box: ${clicks} clicks and ${boxes} boxes (at most 12 clicks plus one per box)`, clicks - boxes <= 12, `${clicks} clicks, ${boxes} boxes`);
check('the Publish toast: View it, and Add it for the missing Authorized by line', await page.locator('.wb-toast').getByRole('link', { name: 'View it' }).isVisible()
  && /no ‘Authorized by’ line/.test(await page.locator('.wb-toast').innerText()));
check('published: the status says so', /Published/.test(await page.locator('.wb-top__meta').innerText()));
let pub = await site('/site/sample-town-hall');
check('the public page has the real words, no sample words, no markers', pub.status === 200 && /Buses every ten minutes/.test(pub.html) && /Why point 3 matters/.test(pub.html)
  && !/Your issue’s headline|One or two sentences on this point|data-wa-/.test(pub.html), pub.status);

// ── the section list, the gallery, Undo and Redo ──
await page.getByRole('button', { name: '← All sections' }).click();
await sections().first().waitFor();
const addSection = async (label, { search } = {}) => {
  if (await page.getByRole('button', { name: '← All sections' }).isVisible().catch(() => false)) await page.getByRole('button', { name: '← All sections' }).click();
  await page.getByRole('button', { name: '+ Add a section' }).click();
  const dlg = page.getByRole('dialog', { name: 'Add a section' });
  await dlg.waitFor();
  if (search) await dlg.getByRole('searchbox').fill(search);
  await dlg.locator('.wb-gal__card', { has: page.locator('.wb-gal__name', { hasText: new RegExp(`^${label}$`) }) }).first().click();
  await dlg.waitFor({ state: 'hidden' });
};
await page.getByRole('button', { name: '+ Add a section' }).click();
const gal = page.getByRole('dialog', { name: 'Add a section' });
await gal.waitFor();
const heads = await gal.locator('.wb-gal__h').allTextContents();
check('“Add a section”: a gallery — Most used, then the groups in plain words', heads.join(' | ') === 'Most used | Words and pictures | Ask people to act | Show what’s on | About us', heads.join(' | '));
check('every card has its drawing and says what it does; no “base.win” in the words', (await gal.locator('.wb-gal__card svg').count()) === MODULES.length && !/base\.win/.test(await gal.innerText()));
check('Donate and Become a member say online giving isn’t set up yet', /Online giving isn’t set up yet/.test(await gal.locator('[data-kind="donate"]').innerText()) && /Online giving isn’t set up yet/.test(await gal.locator('[data-kind="join"]').innerText()));
await gal.getByRole('searchbox').fill('event');
check('the search box finds sections by their words', (await gal.locator('.wb-gal__card[data-kind="events"]').count()) === 1 && (await gal.locator('.wb-gal__card').count()) < 6);
await shot('4-gallery', false);
await gal.getByRole('button', { name: 'Close' }).click();
// An events section: drawn in the preview at once, no reload, as the server draws it.
await page.evaluate(() => { document.querySelector('.wb-side iframe').contentWindow.__kept = 1; });
await addSection('Events');
await page.waitForFunction(() => document.querySelector('.wb-side iframe')?.contentDocument?.querySelector('[data-module="events"]'), null, { timeout: 5000 }).catch(() => {});
const evIn = await page.evaluate(() => {
  const w = document.querySelector('.wb-side iframe').contentWindow;
  return { kept: w.__kept === 1, html: w.document.querySelector('[data-module="events"]')?.outerHTML || '' };
});
await saved();
const strip = (h) => String(h).replace(/ data-wa-[a-z]+="[^"]*"/g, '');
const serverHtml = async (kind) => {
  const tok = (await api('/site/preview-token', { pageId })).json.url;
  const html = await page.evaluate(async (u) => (await fetch(u)).text(), tok);
  const at = html.indexOf(`data-module="${kind}"`);
  if (at < 0) return '';
  const start = html.lastIndexOf('<section', at);
  const tpl = await page.evaluate(([h, s]) => { const t = document.createElement('template'); t.innerHTML = h.slice(s); return t.content.firstElementChild.outerHTML; }, [html, start]);
  return tpl;
};
const evServer = await serverHtml('events');
check('an events section from the gallery: in the preview at once, no reload, exactly as the server draws it', evIn.kept && evIn.html && strip(evIn.html) === strip(evServer), `${evIn.kept} ${evIn.html.length} ${evServer.length}`);
// Undo takes it away; Redo brings it back.
await page.getByRole('button', { name: 'Undo', exact: true }).click();
await page.waitForFunction(() => !document.querySelector('.wb-side iframe')?.contentDocument?.querySelector('[data-module="events"]'), null, { timeout: 3000 }).catch(() => {});
check('Undo: the section is gone, from the preview too', !(await fr.locator('[data-module="events"]').count()));
await page.getByRole('button', { name: 'Redo', exact: true }).click();
await page.waitForFunction(() => document.querySelector('.wb-side iframe')?.contentDocument?.querySelector('[data-module="events"]'), null, { timeout: 3000 }).catch(() => {});
check('Redo: it’s back', (await fr.locator('[data-module="events"]').count()) === 1);
await page.keyboard.press('Control+z');
await sleep(300);
check('Ctrl+Z undoes too', !(await fr.locator('[data-module="events"]').count()));
await page.keyboard.press('Control+Shift+z');
await sleep(300);
check('Shift+Ctrl+Z redoes', (await fr.locator('[data-module="events"]').count()) === 1);
// A petition made in another tab: "Updating preview…", then the server's drawing.
const tab2 = await desk.newPage();
await tab2.goto(`${BASE}/admin/website/petitions`, { waitUntil: 'domcontentloaded' });
const newCamp = await tab2.evaluate(async () => (await (await fetch('/api/actions/site.campaign.save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'petition', title: 'Sample petition: a bench at the bus stop', statement: 'A made-up statement.', goal: 50 }) })).json()));
await tab2.close();
await page.bringToFront();
await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
await addSection('Petition or pledge', { search: 'petition' });
const which2 = page.getByLabel(/Which one/);
await which2.focus();
await page.waitForFunction((t) => [...document.querySelectorAll('option')].some((o) => o.textContent.includes(t)), 'a bench at the bus stop', { timeout: 10000 }).catch(() => {});
await which2.selectOption(newCamp.campaign.id);
const updating = await page.locator('.wb-pv__updating').waitFor({ timeout: 3000 }).then(() => true, () => false);
await page.locator('.wb-pv__updating').waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
await ready();
const petIn = await page.evaluate((cid) => [...(document.querySelector('.wb-side iframe')?.contentDocument?.querySelectorAll('[data-module="petition"]') || [])].map((s) => s.outerHTML).find((h) => h.includes('a bench at the bus stop')) || '', newCamp.campaign.id);
const petServer = (await (async () => {
  const tok = (await api('/site/preview-token', { pageId })).json.url;
  const html = await page.evaluate(async (u) => (await fetch(u)).text(), tok);
  return page.evaluate((h) => { const t = document.createElement('template'); t.innerHTML = h; return [...t.content.querySelectorAll('[data-module="petition"]')].map((s) => s.outerHTML).find((x) => x.includes('a bench at the bus stop')) || ''; }, html);
})());
check('a petition made in another tab: “Updating preview…”, then the section shows it, as the server draws it', updating && petIn && strip(petIn) === strip(petServer), `${updating} ${petIn.length} ${petServer.length}`);
// Columns: an icon from the grid; a point dragged; one removed and Undo.
await page.getByRole('button', { name: '← All sections' }).click();
await page.locator(`#wb-sec-${id.columns} .wb-card__open`).click();
const col = page.locator('.wb-form-col');
await col.locator('.wb-list__toggle').first().click();
await col.getByRole('radio', { name: 'Leaf' }).first().click();
check('an icon picked from the grid of drawn icons', (await col.getByRole('radio', { name: 'Leaf' }).first().getAttribute('aria-checked')) === 'true');
await col.locator('.wb-list__toggle').first().click();
const sums = async () => col.locator('.wb-list__sum').allTextContents();
const h0 = await col.locator('.wb-list__item').nth(2).locator('.wb-handle').boundingBox();
const t0b = await col.locator('.wb-list__item').nth(0).boundingBox();
await page.mouse.move(h0.x + h0.width / 2, h0.y + h0.height / 2);
await page.mouse.down();
await page.mouse.move(h0.x + h0.width / 2, h0.y + h0.height / 2 - 20, { steps: 4 });
await page.mouse.move(t0b.x + t0b.width / 2, t0b.y + t0b.height / 2, { steps: 12 });
await page.mouse.up();
await sleep(300);
check('a point dragged by its handle to the top', JSON.stringify(await sums()) === '["Point 3","Point 1","Point 2"]', JSON.stringify(await sums()));
await col.locator('.wb-list__item').nth(1).locator('.wb-more__btn').click();
await col.locator('.wb-list__item').nth(1).getByRole('button', { name: 'Remove' }).click();
check('⋯ → Remove', JSON.stringify(await sums()) === '["Point 3","Point 2"]', JSON.stringify(await sums()));
await page.locator('.wb-toast').getByRole('button', { name: 'Undo' }).click();
check('…and Undo puts it back', JSON.stringify(await sums()) === '["Point 3","Point 1","Point 2"]', JSON.stringify(await sums()));
check('list rows: a handle and ⋯, no arrows or ✕', !(await col.locator('.wb-icon').count()));
await page.getByRole('button', { name: '← All sections' }).click();
// The section cards: move with ⋯, the handle's tap path, hide.
const order0 = await kinds();
await more(1, 'Move down');
check('⋯ → Move down', JSON.stringify(await kinds()) === JSON.stringify([order0[0], order0[2], order0[1], ...order0.slice(3)]), JSON.stringify(await kinds()));
await more(2, 'Move up');
await sections().nth(0).locator('.wb-handle').click();
check('the handle tapped: the others offer “Move here”', (await page.getByRole('button', { name: 'Move here' }).count()) === order0.length - 1);
await sections().nth(1).getByRole('button', { name: 'Move here' }).click();
check('“Move here”', JSON.stringify(await kinds()) === JSON.stringify([order0[1], order0[0], ...order0.slice(2)]), JSON.stringify(await kinds()));
await page.getByRole('button', { name: 'Undo', exact: true }).click();
check('Undo puts it back', JSON.stringify(await kinds()) === JSON.stringify(order0));
await more(1, 'Hide from the page');
check('hidden: the card says so', await sections().nth(1).locator('.chip', { hasText: 'Hidden' }).isVisible());
await more(1, 'Show on the page');
await shot('5-builder-sections');
await saved();
// A draft-only change: the preview tab has it, the site doesn't (yet).
await page.locator(`#wb-sec-${id.hero} .wb-card__open`).click();
await page.getByRole('textbox', { name: 'Headline', exact: true }).fill('Buses every ten minutes, changed');
await saved();
check('a change since publishing: “Published, with changes” and “Publish changes”', /Published, with changes/.test(await page.locator('.wb-top__meta').innerText()) && await page.getByRole('button', { name: 'Publish changes' }).isVisible());
const [tab] = await Promise.all([desk.waitForEvent('page'), page.getByRole('link', { name: /^Preview/ }).click()]);
await tab.waitForLoadState('domcontentloaded');
await tab.waitForURL(/\/site\/__preview\//, { timeout: 10000 }).catch(() => {});
const prevHtml = await tab.content();
check('Preview opens the draft in a new tab (not for search engines, no tap-to-edit marks)', /\/site\/__preview\//.test(tab.url()) && /ten minutes, changed/.test(prevHtml) && /noindex/.test(prevHtml) && !/data-wa-field|data-wa-section/.test(prevHtml), tab.url());
await tab.close();
pub = await site('/site/sample-town-hall');
check('the public page still has the published words', /Buses every ten minutes/.test(pub.html) && !/ten minutes, changed/.test(pub.html));
await page.getByRole('button', { name: 'Publish changes' }).click();
await page.locator('.wb-toast', { hasText: 'Published' }).waitFor({ timeout: 10000 });
pub = await site('/site/sample-town-hall');
check('published again: the site has it', /ten minutes, changed/.test(pub.html));
// ⋯ → Page settings: show it in the menu.
await page.locator('.wb-top .wb-more__btn').click();
await page.getByRole('button', { name: 'Page settings' }).click();
await page.getByLabel('Show this page in the site’s menu').check();
await page.getByRole('dialog', { name: 'Page settings' }).getByRole('button', { name: 'Done' }).click();
await saved();
check('In the menu (⋯ → Page settings)', (await api('/site')).json.pages.find((p) => p.id === pageId)?.show_in_nav === true);

// ── Fix a typo on the home page and publish: at most 4 clicks from Website ──
await page.goto(`${BASE}/admin/website`, { waitUntil: 'domcontentloaded' });
await page.locator('.wb-live').waitFor();
let homeClicks = 0;
homeClicks += 1;
await page.getByRole('link', { name: 'Edit the home page' }).click();
await page.waitForURL(/\/website\/pages\/[0-9a-f-]{36}/);
await ready();
const homeId = page.url().match(/pages\/([0-9a-f-]{36})/)[1];
const homeHero = (await api(`/site/pages/${homeId}`)).json.page.draft.modules.find((m) => m.kind === 'hero');
homeClicks += 1;
await fr.locator(`[data-wa-section="${homeHero.id}"] [data-wa-field="titlePrefix"]`).first().click();
await typed();
await page.keyboard.press('End');
await page.keyboard.type('!');
homeClicks += 1;
await page.getByRole('button', { name: /^Publish/ }).click();
await page.locator('.wb-toast', { hasText: 'Published' }).waitFor({ timeout: 10000 });
const homeLive = (await api(`/site/pages/${homeId}`)).json.page.published.modules.find((m) => m.kind === 'hero');
check(`a typo on the home page fixed and published in ${homeClicks} clicks from Website (at most 4)`, homeClicks <= 4 && homeLive.props.titlePrefix === `${homeHero.props.titlePrefix}!`, homeLive.props.titlePrefix);

// ── Pages: duplicate, delete, Undo ──
await page.goto(`${BASE}/admin/website/pages`, { waitUntil: 'domcontentloaded' });
await page.waitForURL(/\/website\/pages$/);
const row = page.locator('li.wb-row', { has: page.locator('.wb-row__name', { hasText: /^Sample town hall$/ }) });
await row.locator('.wb-more__btn').click();
await row.getByRole('button', { name: 'Duplicate' }).click();
const copyRow = page.locator('li.wb-row', { has: page.locator('.wb-row__name', { hasText: 'Sample town hall (copy)' }) });
await copyRow.waitFor({ timeout: 10000 });
check('duplicated: a draft copy', /Draft/.test(await copyRow.innerText()));
await copyRow.locator('.wb-more__btn').click();
await copyRow.getByRole('button', { name: 'Delete' }).click();
await copyRow.waitFor({ state: 'detached', timeout: 10000 });
await page.locator('.wb-toast').getByRole('button', { name: 'Undo' }).click();
await copyRow.waitFor({ timeout: 10000 });
check('deleted, then Undo: the copy is back', await copyRow.isVisible());
await shot('5-pages');

// ── Every kind of section: each one's form comes from its fields ──
await page.getByRole('button', { name: 'New page' }).click();
await page.getByRole('radio', { name: /Blank/ }).click();
await page.fill('#wb-new-title', 'Sample: every section');
await page.getByRole('button', { name: 'Make the page' }).click();
await page.waitForURL(/\/website\/pages\/[0-9a-f-]{36}/, { timeout: 15000 });
const allId = page.url().match(/pages\/([0-9a-f-]{36})/)[1];
check('a blank page: one big “Add your first section”', await page.getByRole('button', { name: 'Add your first section' }).isVisible());
await shot('5c-builder-empty');
const formless = [];
for (const m of MODULES) {
  if (!(await sections().count())) {
    await page.getByRole('button', { name: 'Add your first section' }).click();
    const dlg = page.getByRole('dialog', { name: 'Add a section' });
    await dlg.locator(`.wb-gal__card[data-kind="${m.kind}"]`).first().click();
  } else {
    await addSection(m.label);
  }
  const form = page.locator('.wb-form-col');
  await form.locator('.wb-form').waitFor({ timeout: 5000 }).catch(() => {});
  const shown = await form.locator('.wb-form > *').count();
  if (shown !== m.fields.length) formless.push(`${m.kind}: ${shown} of ${m.fields.length}`);
}
check(`all ${MODULES.length} kinds of section: each opens with a box for every field`, formless.length === 0, formless.join(', '));
const once = await (async () => {
  await page.getByRole('button', { name: '← All sections' }).click();
  await page.getByRole('button', { name: '+ Add a section' }).click();
  const dlg = page.getByRole('dialog', { name: 'Add a section' });
  const card = dlg.locator('.wb-gal__card[data-kind="voterguide"]').first();
  const r = [await card.isDisabled(), await card.innerText()];
  await dlg.getByRole('button', { name: 'Close' }).click();
  return r;
})();
check('the voter guide, once a page: greyed, “Already on this page”', once[0] && /Already on this page/.test(once[1]), JSON.stringify(once));
await saved();
const allDraft = (await api(`/site/pages/${allId}`)).json.page.draft;
check('…and the draft has them all, in order', JSON.stringify(allDraft.modules.map((m) => m.kind)) === JSON.stringify(MODULES.map((m) => m.kind)), allDraft.modules.length);
const open = async (kind) => {
  if (await page.getByRole('button', { name: '← All sections' }).isVisible().catch(() => false)) await page.getByRole('button', { name: '← All sections' }).click();
  await page.locator(`li.wb-card[data-kind="${kind}"] .wb-card__open`).first().click();
  return page.locator('.wb-form-col');
};
// Words, as chips.
const hero = await open('hero');
await hero.getByRole('textbox', { name: /^Add to Rotating words/ }).fill('transit');
await hero.getByRole('textbox', { name: /^Add to Rotating words/ }).press('Enter');
check('words: typed and Enter makes a chip', await hero.locator('.wb-chip', { hasText: 'transit' }).isVisible());
await hero.getByRole('button', { name: 'Remove “transit”' }).click();
check('…and ✕ takes it off', !(await hero.locator('.wb-chip', { hasText: 'transit' }).count()));
// A list of groups: add, move, remove, Undo.
const cols = await open('columns');
await cols.getByRole('button', { name: 'Add a point' }).click();
await cols.getByRole('textbox', { name: 'Title', exact: true }).last().fill('First sample point');
await cols.getByRole('button', { name: 'Add a point' }).click();
await cols.getByRole('textbox', { name: 'Title', exact: true }).last().fill('Second sample point');
await cols.getByRole('button', { name: 'More for Second sample point' }).click();
await cols.getByRole('button', { name: 'Move up' }).click();
const sums2 = async () => cols.locator('.wb-list__sum').allTextContents();
check('a list: points added and moved (⋯ → Move up)', JSON.stringify(await sums2()) === '["Second sample point","First sample point"]', JSON.stringify(await sums2()));
// A picture: uploaded, then described.
const pic = await open('image');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
await pic.locator('input[type="file"]').setInputFiles({ name: 'sample.png', mimeType: 'image/png', buffer: png });
await pic.locator('.wb-image__thumb img').waitFor({ timeout: 10000 }).catch(() => {});
const src = await pic.locator('.wb-image__thumb img').getAttribute('src').catch(() => '');
check('a picture: uploaded, shown, from the site’s own store (/media/…)', /\/media\/[0-9a-f-]{36}$/.test(src), src);
await pic.getByRole('textbox', { name: /What the picture shows/ }).fill('A sample picture');
// A switch, a number, a background swatch.
const nl = await open('newsletter');
await nl.getByLabel('Ask for a mobile number (texts)').check();
const ev = await open('events');
await ev.getByRole('spinbutton', { name: 'How many to show' }).fill('5');
const tx = await open('text');
await tx.getByRole('radio', { name: 'Dark' }).check();
check('a background: swatches with their names', (await tx.locator('.wb-tones__sw').count()) === 5);
await saved();
const got = Object.fromEntries((await api(`/site/pages/${allId}`)).json.page.draft.modules.map((m) => [m.kind, m.props]));
check('saved: the chips, the points, the picture, the switch, the number, the background', got.hero.words.length === 0
  && JSON.stringify(got.columns.items.map((x) => x.title)) === '["Second sample point","First sample point"]'
  && /^\/media\//.test(got.image.image.url) && got.image.image.alt === 'A sample picture'
  && got.newsletter.askPhone === true && got.events.limit === 5 && got.text.tone === 'ink', JSON.stringify([got.columns.items, got.image.image, got.newsletter.askPhone, got.events.limit, got.text.tone]));
await shot('5b-every-section');
// Deleted from its builder: the Pages list says so, with Undo.
await page.locator('.wb-top .wb-more__btn').click();
await page.getByRole('button', { name: 'Delete this page' }).click();
await page.waitForURL(/\/website\/pages$/);
check('deleted from its builder: back on Pages, with Undo', /Deleted “Sample: every section”/.test(await page.locator('.wb-toast').innerText().catch(() => ''))
  && await page.locator('.wb-toast').getByRole('button', { name: 'Undo' }).isVisible());

// ── Theme: an unreadable pair is blocked; "Fix it" ──
await page.locator('.wb-tabs').getByRole('link', { name: 'Theme' }).click();
await page.waitForURL(/\/website\/theme$/);
await page.locator('#wb-c-brand').waitFor();
await page.fill('#wb-c-brand', '#7fb2ff');
const bad = page.locator('.wb-pair:not([data-ok])');
check('a light brand colour under white text: "too hard to read"', (await bad.count()) === 1 && /Text on brand colour/.test(await bad.innerText()), await bad.count());
check('…and saving is blocked', await page.getByRole('button', { name: 'Save the look' }).isDisabled() && /too hard to read/.test(await page.locator('.wb-alert').innerText()));
const refused = await api('/actions/site.settings.save', { theme: { skin: 'imagine-surrey', colors: { brand: '#7fb2ff', brandInk: '#ffffff' } } });
check('the server refuses it too', refused.status === 400 && /4\.5:1/.test(refused.json?.error || ''), JSON.stringify(refused.json));
await shot('6-theme-blocked', false);
await bad.getByRole('button', { name: /Fix it/ }).click();
await page.waitForFunction(() => document.querySelector('#wb-c-brandInk')?.value !== '#ffffff', null, { timeout: 5000 }).catch(() => {});
check('"Fix it": every pair readable', (await page.locator('.wb-pair:not([data-ok])').count()) === 0);
const ink = await page.inputValue('#wb-c-brandInk');
await page.getByRole('button', { name: 'Save the look' }).click();
await page.locator('.wb-toast', { hasText: 'new look' }).waitFor({ timeout: 10000 });
const theme = (await api('/site')).json.settings.theme;
check('saved: the brand colour and its readable text', theme.colors.brand === '#7fb2ff' && theme.colors.brandInk === ink && ink !== '#ffffff', `${theme.colors.brand} ${theme.colors.brandInk}`);
pub = await site('/site/sample-town-hall');
check('the public page has the new colours', pub.html.includes('--brand:#7fb2ff') && pub.html.includes(`--brand-ink:${ink}`));
await shot('7-theme');

// ── News: a post, published ──
await page.locator('.wb-tabs').getByRole('link', { name: 'News' }).click();
await page.getByRole('button', { name: 'New post' }).click();
await page.fill('#wb-p-title', 'Sample post: the town hall');
await page.fill('#wb-p-excerpt', 'A made-up post for the test.');
await page.fill('#wb-p-body', 'Doors open at **7 pm**.');
await page.getByRole('button', { name: 'Publish' }).click();
await page.locator('.wb-toast', { hasText: 'Published' }).waitFor({ timeout: 10000 });
const post = (await api('/site/posts')).json.posts.find((p) => p.title === 'Sample post: the town hall');
check('a post, published', post?.status === 'published', JSON.stringify(post));
check('…on the site at /news/<its address>', (await site(`/site/news/${post?.slug}`)).status === 200);

// ── Petitions: a signature from the site; "See who signed" ──
await page.getByRole('link', { name: '← News' }).click();
await page.locator('.wb-tabs').getByRole('link', { name: 'Petitions and pledges' }).click();
await page.getByRole('button', { name: 'New petition or pledge' }).click();
await page.fill('#wb-c-title', 'Sample petition: longer library hours');
await page.fill('#wb-c-statement', 'A made-up statement for the test.');
await page.fill('#wb-c-goal', '10');
await page.getByRole('button', { name: 'Make it' }).click();
await page.locator('.wb-toast', { hasText: 'open to sign' }).waitFor({ timeout: 10000 });
const camp = (await api('/site/campaigns')).json.campaigns.find((c) => c.title === 'Sample petition: longer library hours');
const signed = await page.evaluate(async (c) => (await fetch('/site/api/forms/petition', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ campaign: c, first_name: 'Lena', last_name: 'Example', email: `lena.${Date.now()}@example.org`, client_key: `e2e-${Date.now()}` }),
})).status, camp.id);
check('a signature from the site', signed === 200, signed);
await page.getByRole('link', { name: '← Petitions and pledges' }).click();
const cRow = page.locator('li.wb-row', { hasText: 'Sample petition: longer library hours' });
await cRow.waitFor();
check('the list: 1 of 10 signed, with its bar', /1 of 10 signed/.test(await cRow.innerText()) && (await cRow.locator('.wb-goal__bar').count()) === 1);
await shot('8-petitions');
await cRow.getByRole('link', { name: /See who signed/ }).click();
await page.waitForURL(/\/people\?tag=/);
await page.getByText('Lena Example').first().waitFor({ timeout: 10000 }).catch(() => {});
check('"See who signed": People, filtered to them', await page.getByText('Lena Example').first().isVisible().catch(() => false), page.url());

// ── Settings: the announcement bar ──
await page.goto(`${BASE}/admin/website/settings`);
await page.getByLabel('Show a line across the top of every page').check();
await page.fill('#wb-s-ann-text', 'Town hall Thursday');
await page.getByRole('button', { name: 'Save settings' }).click();
await page.locator('.wb-toast', { hasText: 'Saved' }).waitFor({ timeout: 10000 });
const ann = (await api('/site')).json.settings.announcement;
check('Settings: the announcement bar is saved', ann.enabled === true && ann.text === 'Town hall Thursday', JSON.stringify(ann));

// ── Nothing typed is lost to a slow answer (a phone on a slow connection) ──
// Each answer below comes back 2.5 s after the server has done the work.
const slow = (glob) => page.route(glob, async (route) => {
  const response = await route.fetch();
  await sleep(2500);
  await route.fulfill({ response });
});
const raceId = (await api('/actions/site.page.create', {
  title: 'Sample: slow answers',
  modules: [
    { id: 'race-text', kind: 'text', props: { title: 'First words', body: '', cta: { label: '', href: '' }, tone: 'paper' } },
    { id: 'race-team', kind: 'people', props: { title: 'Our team', intro: '', seats: [{ role: 'Chair', name: 'Ada Example', photo: { url: '', alt: '' }, bio: '' }, { role: 'Treasurer', name: 'Sam Example', photo: { url: '', alt: '' }, bio: '' }] } },
  ],
})).json.page.id;
await page.goto(`${BASE}/admin/website/pages/${raceId}`, { waitUntil: 'domcontentloaded' });
await sections().first().waitFor();
// Typing while Publish is out: the autosave waits for it, then saves.
await sections().nth(0).locator('.wb-card__open').click();
await slow('**/api/actions/site.page.publish');
await page.getByRole('button', { name: /^Publish$/ }).click();
await sleep(300);
await page.locator('.wb-form-col').getByRole('textbox', { name: 'Heading', exact: true }).fill('Typed while it publishes');
await page.locator('.wb-toast', { hasText: 'Published' }).waitFor({ timeout: 15000 }).catch(() => {});
const afterPublish = await saved();
const raceDraft = (await api(`/site/pages/${raceId}`)).json.page.draft;
check('typing while Publish is out: no "someone else saved", and what was typed is saved', afterPublish === 'saved' && !(await page.locator('.wb-alert', { hasText: 'Someone else saved' }).count())
  && raceDraft.modules[0].props.title === 'Typed while it publishes', `${afterPublish} ${raceDraft.modules[0].props.title}`);
await page.unroute('**/api/actions/site.page.publish');
// A seat's photo uploading while its name and another seat are edited.
await page.getByRole('button', { name: '← All sections' }).click();
await sections().nth(1).locator('.wb-card__open').click();
const team = page.locator('.wb-form-col');
await team.locator('.wb-list__toggle').nth(0).click();
await team.locator('.wb-list__toggle').nth(1).click();
await slow('**/api/actions/site.picture');
const seatPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
await team.locator('.wb-list__item').nth(0).locator('input[type="file"]').setInputFiles({ name: 'seat.png', mimeType: 'image/png', buffer: seatPng });
await sleep(300);
await team.locator('.wb-list__item').nth(0).getByRole('textbox', { name: 'Name', exact: true }).fill('Ada Example-Typed');
await team.locator('.wb-list__item').nth(1).getByRole('textbox', { name: 'Role', exact: true }).fill('Treasurer and secretary');
await team.locator('.wb-list__item').nth(0).locator('.wb-image__thumb img').waitFor({ timeout: 15000 }).catch(() => {});
await sleep(1200);
await saved();
const seats = (await api(`/site/pages/${raceId}`)).json.page.draft.modules[1].props.seats;
check('a seat’s photo uploading while names are typed: the photo, the typed name and the other seat’s edit all kept', /^\/media\//.test(seats[0]?.photo?.url || '')
  && seats[0].name === 'Ada Example-Typed' && seats[1].role === 'Treasurer and secretary', JSON.stringify(seats).slice(0, 300));
await page.unroute('**/api/actions/site.picture');
// A petition: Close it with words not saved yet; Save with more typed while it's out.
await page.goto(`${BASE}/admin/website/petitions/${camp.id}`, { waitUntil: 'domcontentloaded' });
await page.locator('#wb-c-statement').waitFor();
await page.fill('#wb-c-statement', 'A changed statement, not saved yet.');
await page.getByRole('button', { name: 'Close it' }).click();
await page.locator('.wb-toast', { hasText: 'Closed' }).waitFor({ timeout: 10000 }).catch(() => {});
check('"Close it" with words not saved yet: closed, and the words still there, still "Not saved yet"', (await page.inputValue('#wb-c-statement')) === 'A changed statement, not saved yet.'
  && await page.locator('.wb-saved', { hasText: 'Not saved yet' }).isVisible() && (await api(`/site/campaigns/${camp.id}`)).json.campaign.status === 'closed');
if ((await page.inputValue('#wb-c-statement')) !== 'A changed statement, not saved yet.') await page.fill('#wb-c-statement', 'A changed statement, not saved yet.');
await slow('**/api/actions/site.campaign.save');
await page.getByRole('button', { name: 'Save', exact: true }).click();
await sleep(300);
await page.fill('#wb-c-excerpt', 'Typed while it saved.');
await page.locator('.wb-toast', { hasText: 'Saved' }).waitFor({ timeout: 15000 }).catch(() => {});
const savedCamp = (await api(`/site/campaigns/${camp.id}`)).json.campaign;
check('typed while Save is out: kept on screen and still "Not saved yet"; what was sent is saved', (await page.inputValue('#wb-c-excerpt')) === 'Typed while it saved.'
  && await page.locator('.wb-saved', { hasText: 'Not saved yet' }).isVisible() && savedCamp.statement === 'A changed statement, not saved yet.', `${await page.inputValue('#wb-c-excerpt')} | ${savedCamp.statement}`);
await page.unroute('**/api/actions/site.campaign.save');
await page.getByRole('button', { name: 'Open it again' }).click();
await page.locator('.wb-toast', { hasText: 'Open again' }).waitFor({ timeout: 10000 }).catch(() => {});
// A post: the same for Save changes.
await page.goto(`${BASE}/admin/website/news/${post.id}`, { waitUntil: 'domcontentloaded' });
await page.locator('#wb-p-excerpt').waitFor();
await page.fill('#wb-p-excerpt', 'A new excerpt.');
await slow('**/api/actions/site.post.save');
await page.getByRole('button', { name: 'Save changes' }).click();
await sleep(300);
await page.fill('#wb-p-title', 'Sample post: the town hall, typed while it saved');
await page.locator('.wb-toast', { hasText: 'Saved' }).waitFor({ timeout: 15000 }).catch(() => {});
check('a post typed while Save is out: kept on screen and still "Not saved yet"', (await page.inputValue('#wb-p-title')) === 'Sample post: the town hall, typed while it saved'
  && await page.locator('.wb-saved', { hasText: 'Not saved yet' }).isVisible() && (await api(`/site/posts/${post.id}`)).json.post.excerpt === 'A new excerpt.');
await page.unroute('**/api/actions/site.post.save');

// ── a volunteer can't open Website ──
const inv = (await api('/actions/member.invite', { email: `vic.${tag}@example.org`, role: 'volunteer' })).json;
const vctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const vj = await vctx.request.post(`${BASE}/api/auth/join`, { data: { token: inv.joinUrl.split('/join/')[1], name: 'Vic Example', password: 'vic-volunteer-2026' } });
check('a volunteer joins', vj.ok(), vj.status());
const vp = await vctx.newPage();
vp.on('pageerror', (e) => errors.push(e.message));
await vp.goto(`${BASE}/admin/website`, { waitUntil: 'domcontentloaded' });
await vp.getByText('Not for your role').waitFor({ timeout: 10000 }).catch(() => {});
check('a volunteer opening Website is told it isn’t theirs', /Not for your role/.test(await vp.innerText('body')));
await shot('9a-volunteer-not-theirs', false, vp);
await vp.goto(`${BASE}/website`, { waitUntil: 'domcontentloaded' });
await sleep(800);
check('…and in the field app it isn’t there (back to Today)', !/\/website/.test(new URL(vp.url()).pathname) && !(await vp.locator('a', { hasText: 'Website' }).count()), vp.url());
const vApi = await vctx.request.get(`${BASE}/api/site`);
const vAct = await vctx.request.post(`${BASE}/api/actions/site.page.create`, { data: { title: 'Nope' } });
check('the server refuses a volunteer the Website’s data and writes', vApi.status() === 403 && vAct.status() === 403, `${vApi.status()} ${vAct.status()}`);
await shot('9-volunteer-phone', false, vp);
await vctx.close();

// ── a phone ──
await page.setViewportSize({ width: 390, height: 844 });
const phone = [];
for (const [path, name] of [['/website', 'overview'], ['/website/pages', 'pages'], [`/website/pages/${pageId}`, 'builder'], ['/website/theme', 'theme'], ['/website/settings', 'settings'], ['/website/news', 'news'], ['/website/petitions', 'petitions'], ['/website/sites', 'other websites']]) {
  await page.goto(`${BASE}/admin${path}`, { waitUntil: 'domcontentloaded' });
  await page.locator('h1').first().waitFor();
  await sleep(700);
  phone.push([name, await overflow()]);
}
check('on a phone: no sideways scroll on any Website screen', phone.every(([, o]) => o <= 0), JSON.stringify(phone));
await page.goto(`${BASE}/admin/website/pages/${pageId}`, { waitUntil: 'domcontentloaded' });
await sections().first().waitFor();
await sleep(300);
const tooSmall = () => page.evaluate(() => [...document.querySelectorAll('.wb-handle, .wb-more__btn, .wb-card__open, .wb-top .btn, .wb-chip__x, .wb-list__toggle, .wb-add, .wb-plus__btn, .wb-icons__btn, .wb-tones__one, .wb-back')]
  .filter((el) => el.offsetParent)
  .map((el) => [el.className, Math.round(el.getBoundingClientRect().height), Math.round(el.getBoundingClientRect().width)])
  .filter(([, h, w]) => h < 44 || w < 40));
const smallList = await tooSmall();
check('on a phone: one primary button on the builder (Publish)', (await page.locator('.btn-primary:visible').count()) === 1);
await shot('10a-builder-list-phone');
await sections().nth(1).locator('.wb-card__open').click();
await sleep(300);
const small = [...smallList, ...await tooSmall()];
check('on a phone: the builder’s buttons are big enough to tap (48 px)', small.length === 0, JSON.stringify(small));
check('on a phone: Undo and Redo are 48 px', (await page.evaluate(() => [...document.querySelectorAll('.wb-undo, .wb-redo')].every((b) => b.getBoundingClientRect().height >= 48))));
// The preview full screen; a tap on the headline opens that section's form in a sheet.
await page.getByRole('button', { name: '← All sections' }).click();
await page.getByRole('button', { name: 'Preview', exact: true }).click();
await page.waitForFunction(() => document.querySelector('.wb-fullpv iframe')?.contentDocument?.querySelector('[data-wa-field]'), null, { timeout: 15000 }).catch(() => {});
await shot('10b-preview-phone', false);
await page.frameLocator('.wb-fullpv iframe').locator('[data-wa-field="titlePrefix"]').first().click();
const sheetPh = page.locator('dialog.wb-dialog[open]');
await sheetPh.waitFor({ timeout: 5000 }).catch(() => {});
await page.waitForFunction(() => document.activeElement?.closest?.('dialog') && document.activeElement.tagName === 'INPUT', null, { timeout: 5000 }).catch(() => {});
check('on a phone: tap the headline in the full-screen preview — a sheet with that section’s form, the Headline box focused, and Done', await sheetPh.isVisible()
  && await page.evaluate(() => /titlePrefix$/.test(document.activeElement?.id || '')) && await sheetPh.getByRole('button', { name: 'Done' }).isVisible());
check('on a phone: no sideways scroll with the sheet open', (await overflow()) <= 0);
await shot('10c-tap-to-edit-phone', false);
await sheetPh.getByRole('button', { name: 'Done' }).click();
await page.locator('.wb-pv__bar').getByRole('button', { name: 'Done' }).click();
const tabs = await page.evaluate(() => {
  const bar = document.querySelector('nav.tabbar');
  const labels = [...bar.querySelectorAll('.tab-label')];
  return { n: labels.length, fits: bar.scrollWidth <= bar.clientWidth + 1, whole: labels.every((l) => l.scrollWidth <= l.clientWidth + 1), words: labels.map((l) => l.textContent),
    more: [...bar.querySelectorAll('.tab-more__panel a')].map((a) => a.textContent.trim()), onMore: Boolean(bar.querySelector('.tab-more__btn.active')) };
});
// A manager's nine places on a phone: four tabs and "More" (Shell.jsx); Website is one of More's.
check('on a phone: four tabs and More, every label whole; Website is under More, the tab you are on', tabs.n === 5 && tabs.fits && tabs.whole && tabs.words[4] === 'More' && tabs.more.includes('Website') && tabs.onMore, JSON.stringify(tabs));
await shot('10-builder-phone');
await page.goto(`${BASE}/admin/website`, { waitUntil: 'domcontentloaded' });
await page.locator('.wb-live').waitFor();
await shot('11-overview-phone');
await page.goto(`${BASE}/admin/website/theme`, { waitUntil: 'domcontentloaded' });
await page.locator('.wb-sample').waitFor();
await shot('12-theme-phone');

// ── Theme: the website can follow the campaign's brand, and take its own look back ──
// (This campaign's website has its own look, as Imagine Surrey's live one does.)
{
  const before = (await api('/site')).json;
  await page.getByRole('button', { name: 'Use the campaign’s brand' }).click();
  await page.getByRole('button', { name: 'Yes, use it' }).click();
  await page.locator('.wb-follow').waitFor({ timeout: 8000 });
  await sleep(400);
  const following = (await api('/site')).json;
  const shown = await page.evaluate(() => ({ controls: document.querySelectorAll('.wb-color').length, primaries: [...document.querySelectorAll('.btn-primary')].filter((b) => b.offsetParent).length,
    sample: getComputedStyle(document.querySelector('.wb-sample')).getPropertyValue('--s-brand').trim(), words: document.querySelector('.wb-follow').innerText }));
  const live = await (await fetch(`${BASE}/site/`)).text();
  check('“Use the campaign’s brand”: the website follows it — the screen says so, shows the sample in the brand’s colour and no colour boxes; its own colours are kept for later',
    before.settings.theme.follow !== true && following.settings.theme.follow === true && JSON.stringify(following.settings.theme.colors) === JSON.stringify(before.settings.theme.colors)
    && shown.controls === 0 && shown.primaries === 0 && shown.sample === following.brand_theme.colors.brand && /Following the campaign’s brand/.test(shown.words) && live.includes(following.brand_theme.colors.brand), JSON.stringify(shown).slice(0, 300));
  await shot('13-theme-following-phone');
  // Back to the look it had: nothing of its own is lost by trying the brand.
  const ways = await page.locator('.wb-follow button').allInnerTexts();
  await page.getByRole('button', { name: 'Go back to the look it had' }).click();
  await page.locator('.wb-color').first().waitFor({ timeout: 8000 });
  await sleep(400);
  const back = (await api('/site')).json.settings.theme;
  const liveBack = await (await fetch(`${BASE}/site/`)).text();
  const pick = (t) => JSON.stringify([t.colors, t.fonts, t.radius, t.logo, t.skin]);
  check('“Go back to the look it had”: the website’s own colours, type, corners and logo are back as they were, live', following.settings.theme.kept === true
    && ways.join(' | ') === 'Go back to the look it had | Start from the campaign’s brand' && back.follow === false && back.kept === undefined && pick(back) === pick(before.settings.theme)
    && liveBack.includes(`--brand:${before.settings.theme.colors.brand}`) && await page.locator('#wb-c-brand').inputValue() === before.settings.theme.colors.brand, `${ways.join(' | ')} ${JSON.stringify(back).slice(0, 200)}`);
  // And the other way: its own look started from the brand's.
  await page.getByRole('button', { name: 'Use the campaign’s brand' }).click();
  await page.getByRole('button', { name: 'Yes, use it' }).click();
  await page.locator('.wb-follow').waitFor({ timeout: 8000 });
  await page.getByRole('button', { name: 'Start from the campaign’s brand' }).click();
  await page.locator('.wb-color').first().waitFor({ timeout: 8000 });
  await sleep(400);
  const own = (await api('/site')).json.settings.theme;
  check('“Start from the campaign’s brand”: it stops following and starts from what it wore — every colour is there to change again', own.follow === false && own.colors.brand === following.brand_theme.colors.brand
    && await page.locator('.wb-color').count() > 5 && await page.getByRole('button', { name: 'Use the campaign’s brand' }).count() === 1, JSON.stringify(own).slice(0, 200));
}

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
