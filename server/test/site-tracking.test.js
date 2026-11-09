// A form's tracking — the referral code and the share tag (?ref=, ?source=)
// — is optional: a long or odd one in the address (a campaign link such as
// …?source=newsletter-2026-11-skytrain-petition-call-to-action-button) must
// never stop anyone signing, volunteering, joining or giving. What a page
// carries in its forms (context.js rc.hidden) and what the island adds from
// the address (form.js, util.js trackFrom) is only ever what the server
// takes (forms.js: a code of 6–16 letters and digits; a tag of at most 60
// of a–z, 0–9 and : _ . -); anything else stays out.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { renderSite } from '../ext/site/render/index.js';
import { newModule } from '../../shared/site/catalogue.js';
import { trackFrom } from '../../shared/site/components/util.js';

const { send, ok, campaign } = await import('./site-helpers.js');

before(async () => {
  const { mgr } = await campaign();
  ok(await mgr.get('/api/site'));
});

const LONG = 'newsletter-2026-11-skytrain-petition-call-to-action-button-row-2'; // 64 characters
const hiddenOf = (html) => Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"\/>/g)].map((m) => [m[1], m[2]]));

test('what a page carries: a long tag cut to what the server takes, a code that isn’t one left out — and the form goes through', async () => {
  const { html } = renderSite({
    kind: 'page', site: { org: { name: 'Example' } },
    page: { id: '', slug: 'home', title: 'Home', modules: [newModule('newsletter', 'nl0001')] },
    ctx: { root: '/site/', path: '/', source: LONG, referral: 'a-referral-code-that-is-far-too-long-to-be-one-of-ours' },
  });
  const h = hiddenOf(html);
  assert.ok(h.source && h.source.length <= 60 && LONG.startsWith(h.source), h.source);
  assert.ok(!('ref' in h) || h.ref === '', `ref: ${h.ref}`);
  const r = await send('newsletter', { email: 'tracking1@example.org', consent_email: true, ...h });
  assert.equal(r.status, 200, r.text);
});

test('what the island takes from the address: the same rule, so a long link never ends in "The source is too long"', async () => {
  const t = trackFrom(`?source=${encodeURIComponent(LONG)}&ref=${'r'.repeat(70)}`);
  assert.ok(t.source.length <= 60 && LONG.startsWith(t.source), t.source);
  assert.equal(t.ref, '', 'not a referral code: left out (the cookie still credits a real one)');
  // Every form takes what trackFrom keeps.
  const rr = await send('newsletter', { email: 'tracking2@example.org', consent_email: true, ...t });
  assert.equal(rr.status, 200, rr.text);
  // A good code and a good tag pass as they are; odd characters are left out.
  assert.deepEqual(trackFrom('?ref=Abc12345&source=share-whatsapp'), { ref: 'Abc12345', source: 'share-whatsapp' });
  assert.deepEqual(trackFrom('?ref=abc&source=%3Cscript%3E'), { ref: '', source: '' });
  assert.deepEqual(trackFrom(''), { ref: '', source: '' });
  // What the server says about the raw ones (why they must never be sent).
  const raw = await send('newsletter', { email: 'tracking3@example.org', consent_email: true, source: LONG });
  assert.equal(raw.status, 400);
  assert.equal(raw.json.field, 'source');
});
