// Website, the admin's area (web/src/pages/Website*.jsx), in a browser.
//
// A manager signs up and finds Website in the desk's menu: the site is live
// at the app's /site/ address; online giving isn't set up. Pages → New page
// "Sample town hall"; in its builder they add a Hero, a Text block and a
// Newsletter sign-up from the catalogue, drag the newsletter above the text
// (and use Move up / Move down and the tap path), hide the text block, add
// a Petition or pledge without picking one — Publish refuses and points at
// that section's "Which one" box — pick one, delete it, Undo, delete it
// again, and publish. The draft saves by itself ("Saved"). A draft-only
// change shows in the preview (a new tab, and the frame beside) while the
// public page at /site/sample-town-hall keeps what was published; publishing
// again puts it there. Theme: a light brand colour under white text is too
// hard to read — saving is blocked — "Fix it" picks a readable text colour
// and it saves; the public page has the new colours. A page duplicated and
// deleted comes back with Undo. A post is written and published; a sample
// petition gets a signature from the site and "See who signed" lists them
// in People. A volunteer can't open Website (the admin says it's not for
// their role; the server refuses its data). On a phone (390px) every
// Website screen fits with no sideways scroll, the tab bar shows all nine
// labels whole, and tap targets are 48px.
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
const sections = () => page.locator('li.wb-sec');
const kinds = async () => page.locator('li.wb-sec').evaluateAll((els) => els.map((e) => e.dataset.kind));
const saved = async () => {
  await page.waitForFunction(() => document.querySelector('.wb-saved')?.dataset.state === 'saved', null, { timeout: 15000 }).catch(() => {});
  return page.evaluate(() => document.querySelector('.wb-saved')?.dataset.state);
};
const more = async (n, item) => {
  await sections().nth(n).locator('.wb-more__btn').click();
  await sections().nth(n).getByRole('button', { name: item, exact: true }).click();
};
const addSection = async (label) => {
  await page.getByRole('button', { name: '+ Add a section' }).click();
  const dlg = page.getByRole('dialog', { name: 'Add a section' });
  await dlg.waitFor();
  await dlg.locator('.wb-cat__item', { has: page.locator('.wb-cat__name', { hasText: new RegExp(`^${label}$`) }) }).click();
  await dlg.waitFor({ state: 'hidden' });
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
const viewHref = await page.getByRole('link', { name: /^View site/ }).getAttribute('href');
check('"View site" opens the site', /\/site\/$/.test(viewHref), viewHref);
await shot('1-overview');

// ── a new page ──
await page.locator('.wb-tabs').getByRole('link', { name: 'Pages' }).click();
await page.waitForURL(/\/website\/pages$/);
await page.getByRole('button', { name: 'New page' }).click();
await page.fill('#wb-new-title', 'Sample town hall');
check('the address is made from the title', /\/sample-town-hall/.test(await page.locator('#wb-new-slug-hint').innerText()));
await page.getByRole('button', { name: 'Make the page' }).click();
await page.waitForURL(/\/website\/pages\/[0-9a-f-]{36}/, { timeout: 15000 });
const pageId = page.url().match(/pages\/([0-9a-f-]{36})/)[1];
await page.locator('h2', { hasText: 'Sections' }).waitFor();
check('the builder opens on the new page, empty, a draft', /Nothing on this page yet/.test(await text()) && /Draft/.test(await page.locator('.wb-build__meta').innerText()));

// The catalogue, grouped, with what each one does.
await page.getByRole('button', { name: '+ Add a section' }).click();
const cat = page.getByRole('dialog', { name: 'Add a section' });
await cat.waitFor();
const heads = await cat.locator('.wb-cat__h').allTextContents();
check('"Add a section": grouped as the catalogue’s categories', heads.join(' | ') === 'Text and pictures | Actions (people land in base.win) | Live from base.win | About the organization', heads.join(' | '));
check('each with what it does', /The big headline at the top/.test(await cat.innerText()));
check('Donate and Become a member say online giving isn’t set up yet', (await cat.locator('.wb-cat__note').count()) === 2);
await shot('2-catalogue', false);
await cat.locator('.wb-cat__item', { has: page.locator('.wb-cat__name', { hasText: /^Hero$/ }) }).click();
await cat.waitFor({ state: 'hidden' });
const heroHead = sections().nth(0).getByRole('textbox', { name: 'Headline', exact: true });
await heroHead.fill('A sample headline');
check('the draft saves by itself: "Saved"', (await saved()) === 'saved');

await addSection('Text block');
await sections().nth(1).getByRole('textbox', { name: 'Heading', exact: true }).fill('Bring your questions');
const md = sections().nth(1).locator('textarea.ws-md__text');
await md.fill('We meet at the library. ');
await md.press('End');
await sections().nth(1).getByRole('button', { name: 'Bold' }).click();
check('the text box’s toolbar: Bold adds **…**', /\*\*bold words\*\*/.test(await md.inputValue()));
await addSection('Newsletter sign-up');
await saved();
check('three sections, in the order added', JSON.stringify(await kinds()) === '["hero","text","newsletter"]', JSON.stringify(await kinds()));

// Drag the newsletter by its handle onto the text block: it takes its place.
const from = await sections().nth(2).locator('.wb-handle').boundingBox();
const to = await sections().nth(1).boundingBox();
await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
await page.mouse.down();
await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 - 20, { steps: 4 });
await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
await page.mouse.up();
await sleep(300);
check('dragged: the newsletter is above the text block', JSON.stringify(await kinds()) === '["hero","newsletter","text"]', JSON.stringify(await kinds()));
// Keyboard: ⋯ → Move up / Move down.
await more(2, 'Move up');
check('⋯ → Move up', JSON.stringify(await kinds()) === '["hero","text","newsletter"]', JSON.stringify(await kinds()));
await more(1, 'Move down');
check('⋯ → Move down', JSON.stringify(await kinds()) === '["hero","newsletter","text"]', JSON.stringify(await kinds()));
// Tap: the handle, then "Move here".
await sections().nth(0).locator('.wb-handle').click();
check('tapped: the hero is picked up; the others offer "Move here"', (await page.getByRole('button', { name: 'Move here' }).count()) === 2);
await sections().nth(1).getByRole('button', { name: 'Move here' }).click();
check('"Move here": the hero takes the newsletter’s place', JSON.stringify(await kinds()) === '["newsletter","hero","text"]', JSON.stringify(await kinds()));
await more(1, 'Move up');
check('and back', JSON.stringify(await kinds()) === '["hero","newsletter","text"]');

// Hide the text block.
await more(2, 'Hide from the page');
check('hidden: the text block says so', await sections().nth(2).locator('.chip', { hasText: 'Hidden' }).isVisible());

// A petition section with nothing picked: Publish says where.
await addSection('Petition or pledge');
await saved();
await page.getByRole('button', { name: /^Publish$/ }).click();
const alert = page.locator('.wb-alert', { hasText: 'Before it goes on the site' });
await alert.waitFor({ timeout: 10000 });
const said = await alert.innerText();
check('Publish refuses: Section 4 (Petition or pledge) · Which one: pick one', /Section 4 \(Petition or pledge\) · Which one: pick one/.test(said), said);
const which = sections().nth(3).getByLabel(/Which one/);
await page.waitForFunction(() => document.activeElement?.getAttribute('aria-invalid') === 'true', null, { timeout: 5000 }).catch(() => {});
check('…and opens that section with its box marked and focused', (await which.getAttribute('aria-invalid')) === 'true'
  && await which.evaluate((el) => el === document.activeElement), await page.evaluate(() => document.activeElement?.outerHTML?.slice(0, 120)));
await shot('3-publish-refused', false);
const camps = (await api('/site/campaigns')).json.campaigns;
await which.selectOption(camps[0].id);
await alert.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
check('picked: nothing left to fix', !(await alert.isVisible().catch(() => false)));
// Delete it — Undo — and delete it again.
await more(3, 'Delete');
const toast = page.locator('.wb-toast');
await toast.waitFor();
check('deleted: "Deleted section 4 (Petition or pledge)" with Undo', /Deleted section 4 \(Petition or pledge\)/.test(await toast.innerText()));
await toast.getByRole('button', { name: 'Undo' }).click();
check('Undo: it’s back where it was, its petition still picked', JSON.stringify(await kinds()) === '["hero","newsletter","text","petition"]'
  && (await sections().nth(3).locator('.wb-sec__sum').innerText()) === camps[0].title, JSON.stringify(await kinds()));
await more(3, 'Delete');
check('deleted again', (await sections().count()) === 3);
await saved();
await page.getByRole('button', { name: /^Publish$/ }).click();
await page.locator('.wb-toast', { hasText: 'Published' }).waitFor({ timeout: 10000 });
check('published: on the site', /On the site/.test(await page.locator('.wb-build__meta').innerText()));
const live = (await api(`/site/pages/${pageId}`)).json.page;
check('server: what went live — hero, newsletter, text (hidden)', JSON.stringify(live.published.modules.map((m) => [m.kind, m.hidden])) === '[["hero",false],["newsletter",false],["text",true]]',
  JSON.stringify(live.published.modules.map((m) => [m.kind, m.hidden])));
let pub = await site('/site/sample-town-hall');
const order = [...pub.html.matchAll(/data-module="([a-z]+)"/g)].map((m) => m[1]);
check('the public page (/site/sample-town-hall): the hero, then the newsletter; the hidden text isn’t there',
  pub.status === 200 && JSON.stringify(order) === '["hero","newsletter"]' && /A sample headline/.test(pub.html), `${pub.status} ${JSON.stringify(order)}`);

// ── a draft-only change: the preview has it, the site doesn't (yet) ──
await sections().nth(0).locator('.wb-sec__toggle').click();
await sections().nth(0).getByRole('textbox', { name: 'Headline', exact: true }).fill('A sample headline, changed');
await saved();
check('a change since publishing: "Publish changes"', await page.getByRole('button', { name: 'Publish changes' }).isVisible());
const frame = page.locator('.wb-frame iframe');
check('a wide screen: the preview beside the editor', /\/site\/__preview\//.test(await frame.getAttribute('src').catch(() => '')));
await page.waitForFunction(() => /headline, changed/.test(document.querySelector('.wb-frame iframe')?.contentDocument?.body?.innerText || ''), null, { timeout: 10000 }).catch(() => {});
check('…showing the draft, fresh after the save', /headline, changed/.test(await frame.evaluate((f) => f.contentDocument?.body?.innerText || '').catch(() => '')));
const [tab] = await Promise.all([desk.waitForEvent('page'), page.getByRole('link', { name: /^Preview/ }).click()]);
await tab.waitForLoadState('domcontentloaded');
await tab.waitForURL(/\/site\/__preview\//, { timeout: 10000 }).catch(() => {});
const prevHtml = await tab.content();
check('Preview opens the draft in a new tab (not for search engines)', /\/site\/__preview\//.test(tab.url()) && /headline, changed/.test(prevHtml) && /noindex/.test(prevHtml), tab.url());
await tab.close();
pub = await site('/site/sample-town-hall');
check('the public page still has the published words', /A sample headline/.test(pub.html) && !/headline, changed/.test(pub.html));
await shot('4-builder');
await page.getByRole('button', { name: 'Publish changes' }).click();
await page.locator('.wb-toast', { hasText: 'Published' }).waitFor({ timeout: 10000 });
pub = await site('/site/sample-town-hall');
check('published again: the site has it', /headline, changed/.test(pub.html));

// The page details: show it in the menu.
const details = page.getByRole('button', { name: /Page details/ });
if ((await details.getAttribute('aria-expanded')) !== 'true') await details.click();
await page.getByLabel('Show this page in the site’s menu').check();
await saved();
check('In the menu (page details)', (await api('/site')).json.pages.find((p) => p.id === pageId)?.show_in_nav === true);

// ── Pages: duplicate, delete, Undo ──
await page.getByRole('link', { name: '← Pages' }).click();
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
await page.fill('#wb-new-title', 'Sample: every section');
await page.getByRole('button', { name: 'Make the page' }).click();
await page.waitForURL(/\/website\/pages\/[0-9a-f-]{36}/, { timeout: 15000 });
const allId = page.url().match(/pages\/([0-9a-f-]{36})/)[1];
await page.locator('h2', { hasText: 'Sections' }).waitFor();
const formless = [];
for (const m of MODULES) {
  await addSection(m.label);
  const sec = sections().last();
  await sec.locator('.wb-form').waitFor({ timeout: 5000 }).catch(() => {});
  const shown = await sec.locator('.wb-form > *').count();
  if (shown !== m.fields.length) formless.push(`${m.kind}: ${shown} of ${m.fields.length}`);
  await sec.getByRole('button', { name: 'Done' }).click();
}
check(`all ${MODULES.length} kinds of section: each opens with a box for every field`, formless.length === 0, formless.join(', '));
await saved();
const allDraft = (await api(`/site/pages/${allId}`)).json.page.draft;
check('…and the draft has them all, in order', JSON.stringify(allDraft.modules.map((m) => m.kind)) === JSON.stringify(MODULES.map((m) => m.kind)), allDraft.modules.length);
const open = async (kind) => {
  const sec = page.locator(`li.wb-sec[data-kind="${kind}"]`).first();
  if (!(await sec.getAttribute('data-open') !== null)) await sec.locator('.wb-sec__toggle').click();
  return sec;
};
// Words, as chips.
const hero = await open('hero');
await hero.getByRole('textbox', { name: /^Add to Rotating words/ }).fill('transit');
await hero.getByRole('textbox', { name: /^Add to Rotating words/ }).press('Enter');
check('words: typed and Enter makes a chip', await hero.locator('.wb-chip', { hasText: 'transit' }).isVisible());
await hero.getByRole('button', { name: 'Remove “transit”' }).click();
check('…and ✕ takes it off', !(await hero.locator('.wb-chip', { hasText: 'transit' }).count()));
await hero.getByRole('button', { name: 'Done' }).click();
// A list of groups: add, move, remove, Undo.
const cols = await open('columns');
await cols.getByRole('button', { name: 'Add a point' }).click();
await cols.getByRole('textbox', { name: 'Title', exact: true }).last().fill('First sample point');
await cols.getByRole('button', { name: 'Add a point' }).click();
await cols.getByRole('textbox', { name: 'Title', exact: true }).last().fill('Second sample point');
await cols.getByRole('button', { name: 'Move Second sample point up' }).click();
const sums = async () => cols.locator('.wb-list__sum').allTextContents();
check('a list: points added and moved', JSON.stringify(await sums()) === '["Second sample point","First sample point"]', JSON.stringify(await sums()));
await cols.getByRole('button', { name: 'Remove First sample point' }).click();
await page.locator('.wb-toast').getByRole('button', { name: 'Undo' }).click();
check('…removed, and Undo puts it back', JSON.stringify(await sums()) === '["Second sample point","First sample point"]', JSON.stringify(await sums()));
await cols.getByRole('button', { name: 'Done' }).click();
// A picture: uploaded, then described.
const pic = await open('image');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
await pic.locator('input[type="file"]').setInputFiles({ name: 'sample.png', mimeType: 'image/png', buffer: png });
await pic.locator('.wb-image__thumb img').waitFor({ timeout: 10000 }).catch(() => {});
const src = await pic.locator('.wb-image__thumb img').getAttribute('src').catch(() => '');
check('a picture: uploaded, shown, from the site’s own store (/media/…)', /\/media\/[0-9a-f-]{36}$/.test(src), src);
await pic.getByRole('textbox', { name: /What the picture shows/ }).fill('A sample picture');
await pic.getByRole('button', { name: 'Done' }).click();
// A switch, a number, a choice.
const nl = await open('newsletter');
await nl.getByLabel('Ask for a mobile number (texts)').check();
await nl.getByRole('button', { name: 'Done' }).click();
const ev = await open('events');
await ev.getByRole('spinbutton', { name: 'How many to show' }).fill('5');
await ev.getByRole('button', { name: 'Done' }).click();
const tx = await open('text');
await tx.getByRole('combobox', { name: 'Background' }).selectOption('ink');
await tx.getByRole('button', { name: 'Done' }).click();
await saved();
const got = Object.fromEntries((await api(`/site/pages/${allId}`)).json.page.draft.modules.map((m) => [m.kind, m.props]));
check('saved: the chips, the points, the picture, the switch, the number, the choice', got.hero.words.length === 0
  && JSON.stringify(got.columns.items.map((x) => x.title)) === '["Second sample point","First sample point"]'
  && /^\/media\//.test(got.image.image.url) && got.image.image.alt === 'A sample picture'
  && got.newsletter.askPhone === true && got.events.limit === 5 && got.text.tone === 'ink', JSON.stringify([got.columns.items, got.image.image, got.newsletter.askPhone, got.events.limit, got.text.tone]));
await shot('5b-every-section');
// Deleted from its builder: the Pages list says so, with Undo.
await page.locator('.wb-build__actions .wb-more__btn').click();
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
await sections().nth(0).locator('.wb-sec__toggle').click();
await slow('**/api/actions/site.page.publish');
await page.getByRole('button', { name: /^Publish$/ }).click();
await sleep(300);
await sections().nth(0).getByRole('textbox', { name: 'Heading', exact: true }).fill('Typed while it publishes');
await page.locator('.wb-toast', { hasText: 'Published' }).waitFor({ timeout: 15000 }).catch(() => {});
const afterPublish = await saved();
const raceDraft = (await api(`/site/pages/${raceId}`)).json.page.draft;
check('typing while Publish is out: no "someone else saved", and what was typed is saved', afterPublish === 'saved' && !(await page.locator('.wb-alert', { hasText: 'Someone else saved' }).count())
  && raceDraft.modules[0].props.title === 'Typed while it publishes', `${afterPublish} ${raceDraft.modules[0].props.title}`);
await page.unroute('**/api/actions/site.page.publish');
// A seat's photo uploading while its name and another seat are edited.
const team = sections().nth(1);
await team.locator('.wb-sec__toggle').click();
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
for (const [path, name] of [['/website', 'overview'], ['/website/pages', 'pages'], [`/website/pages/${pageId}`, 'builder'], ['/website/theme', 'theme'], ['/website/settings', 'settings'], ['/website/news', 'news'], ['/website/petitions', 'petitions']]) {
  await page.goto(`${BASE}/admin${path}`, { waitUntil: 'domcontentloaded' });
  await page.locator('h1').first().waitFor();
  await sleep(700);
  phone.push([name, await overflow()]);
}
check('on a phone: no sideways scroll on any Website screen', phone.every(([, o]) => o <= 0), JSON.stringify(phone));
await page.goto(`${BASE}/admin/website/pages/${pageId}`, { waitUntil: 'domcontentloaded' });
await sections().first().waitFor();
await sections().nth(1).locator('.wb-sec__toggle').click();
await sleep(300);
const small = await page.evaluate(() => [...document.querySelectorAll('.wb-handle, .wb-more__btn, .wb-sec__toggle, .wb-build__actions .btn, .wb-chip__x, .wb-list__toggle, .wb-add')]
  .filter((el) => el.offsetParent)
  .map((el) => [el.className, Math.round(el.getBoundingClientRect().height), Math.round(el.getBoundingClientRect().width)])
  .filter(([, h, w]) => h < 44 || w < 40));
check('on a phone: the builder’s buttons are big enough to tap', small.length === 0, JSON.stringify(small));
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

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
