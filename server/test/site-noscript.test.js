// Without JavaScript (or a submit before the page's script has started), a
// refused form comes back as ?error=<field>&module=<id>#m-<id> (forms.js),
// and the page must say why — on the form that was sent, in plain words:
// too many from one address (busy), online payments not answering
// (payments), a petition no longer taking names (campaign), an opening gone
// (shift_id), as well as a box to fix. A bare ?error=<field> (no module, or
// one that isn't on this page) still shows: on every form it's about.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { renderSite } from '../ext/site/render/index.js';
import { baseSample } from './site-samples.js';

const { hit, ok, campaign } = await import('./site-helpers.js');

const { site, page, data } = baseSample;
const draw = (error) => renderSite({ kind: 'page', site, page, data, ctx: { root: '/', path: '/', error } }).html;
const sectionOf = (html, id) => new RegExp(`<section[^>]*id="m-${id}"[\\s\\S]*?</section>`).exec(html)?.[0] || '';
const alertsIn = (html, id) => [...sectionOf(html, id).matchAll(/<(?:div|p) class="form-alert" role="alert">([^<]*)</g)].map((m) => m[1]);
const FORMS = ['pledge', 'donate', 'volunteer', 'openings', 'events', 'join', 'newsletter', 'contact'];
const said = (html) => Object.fromEntries(FORMS.map((id) => [id, alertsIn(html, id)]).filter(([, a]) => a.length));

test('busy: every form on the page says to wait a minute (they would all be refused)', () => {
  const html = draw('busy');
  const s = said(html);
  assert.deepEqual(Object.keys(s).sort(), [...FORMS].sort(), JSON.stringify(s));
  for (const a of Object.values(s)) assert.match(a[0], /Too many tries from here — wait a minute and try again/);
});

test('payments: the join and donate forms say online payments didn’t answer; the others nothing', () => {
  const s = said(draw('payments'));
  assert.deepEqual(Object.keys(s).sort(), ['donate', 'join'], JSON.stringify(s));
  assert.match(s.donate[0], /Online payments aren’t working right now/);
});

test('campaign and shift_id: the petition or pledge, the openings and events, say so', () => {
  const c = said(draw('campaign'));
  assert.deepEqual(Object.keys(c), ['pledge'], JSON.stringify(c));
  assert.match(c.pledge[0], /isn’t taking names right now/);
  const sh = said(draw('shift_id'));
  assert.deepEqual(Object.keys(sh).sort(), ['events', 'openings'], JSON.stringify(sh));
  assert.match(sh.openings[0], /That opening isn’t available any more/);
});

test('with the module: only the form that was sent', () => {
  assert.deepEqual(Object.keys(said(draw({ field: 'busy', module_id: 'newsletter' }))), ['newsletter']);
  assert.deepEqual(Object.keys(said(draw({ field: 'campaign', module_id: 'pledge' }))), ['pledge']);
  assert.deepEqual(Object.keys(said(draw({ field: 'busy', module_id: 'openings' }))), ['openings']);
  const email = draw({ field: 'email', module_id: 'volunteer' });
  assert.match(sectionOf(email, 'volunteer'), /aria-invalid="true"/);
  assert.doesNotMatch(sectionOf(email, 'contact'), /aria-invalid="true"/, 'the other forms are left alone');
  // A module this page doesn't have: as if none was given.
  assert.deepEqual(Object.keys(said(draw({ field: 'payments', module_id: 'gone' }))).sort(), ['donate', 'join']);
});

test('the real round trip: the 21st plain post from one address comes back to its form, saying why', async () => {
  const { mgr } = await campaign();
  const home = ok(await mgr.get('/api/site')).pages.find((p) => p.slug === 'home');
  const ip = '203.0.113.21';
  for (let i = 0; i < 20; i += 1) await hit('/site/api/forms/newsletter', { ip, form: { email: `busy${i}@example.org`, consent_email: 'true', page_id: home.id, module_id: 'newsletter' } });
  const r = await hit('/site/api/forms/newsletter', { ip, form: { email: 'busy21@example.org', consent_email: 'true', page_id: home.id, module_id: 'newsletter' } });
  assert.equal(r.status, 303);
  assert.equal(r.location, '/site/?error=busy&module=newsletter#m-newsletter');
  const back = await hit(r.location.split('#')[0]);
  assert.equal(back.status, 200);
  assert.deepEqual(alertsIn(back.text, 'newsletter'), ['Too many tries from here — wait a minute and try again.']);
  assert.deepEqual(alertsIn(back.text, 'skytrain'), [], 'only the form that was sent');
  // A field the visitor can fix comes back to that form's box too.
  const bad = await hit('/site/api/forms/newsletter', { form: { email: 'not an email', consent_email: 'true', page_id: home.id, module_id: 'newsletter' } });
  assert.equal(bad.location, '/site/?error=email&module=newsletter#m-newsletter');
  const fix = await hit(bad.location.split('#')[0]);
  assert.match(sectionOf(fix.text, 'newsletter'), /aria-invalid="true"/);
  assert.doesNotMatch(sectionOf(fix.text, 'skytrain'), /aria-invalid="true"/);
});

test('a plain post from a page opened with ?utm_source= keeps it as the source (the island’s rule)', async () => {
  const { db } = await campaign();
  const r = await hit('/site/api/forms/newsletter', {
    form: { email: 'utm.example@example.org', consent_email: 'true' },
    headers: { referer: 'http://localhost/site/?utm_source=bus-shelter' },
  });
  assert.equal(r.status, 303);
  const row = (await db.query("select a.source, a.site_id from site_actions a join persons p on p.id = a.person_id where p.email = 'utm.example@example.org'")).rows[0];
  assert.deepEqual([row.source, row.site_id], ['bus-shelter', null]);
});
