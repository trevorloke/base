// Membership and donor tiers are Imagine Surrey's own (its paper form, its
// dues and terms, its Star and Superstar clubs: server/presets/, read only
// through lib/preset.js). Another campaign has none of it: the form's
// action and its reads are not there, nor a membership checkout, the
// Members report, download or column, the Membership rule, a ladder that
// starts or ends on a membership, or a named donor tier — and the website
// tag "Member (joined online)" makes no membership.
// Then the same server as Imagine Surrey's, with the brand set after the
// server was loaded (as the test helper does): everything as it was.
// Unique emails and campaign names (test:pg runs every file on one database).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';
import { runAction } from '../lib/events.js';
import { forgetBrand } from '../lib/brand.js';
import { presetFor } from '../lib/preset.js';
import { tierFor } from '../lib/tiers.js';
import { prepareCheckout } from '../ext/payments/index.js';
import { sourceOf } from '../ext/drive/export.js';
import { donorTier } from '@starbase/shared/canvass';
import { commandsFor } from '../../web/src/components/commands.js';
import { todayOf } from '../ext/audience/index.js';

const tag = Math.random().toString(36).slice(2, 8);
const ok = (r, msg = '') => { assert.ok(r.status === 200 || r.status === 201, `${msg} ${r.status} ${JSON.stringify(r.json)}`); return r.json; };
const raw = (c, path) => app.request(path, { headers: { cookie: c.cookie } });
// The campaign's own day (as "a membership running today" counts it), not UTC's:
// from 00:00 UTC until midnight in the campaign's time zone the two differ.
const today = todayOf({});
const year = Number(today.slice(0, 4));
const IS = presetFor('imagine-surrey');

const savedBrand = process.env.BASE_BRAND;
const wear = (brand) => { process.env.BASE_BRAND = brand; forgetBrand(); };
after(() => { if (savedBrand === undefined) delete process.env.BASE_BRAND; else process.env.BASE_BRAND = savedBrand; forgetBrand(); });

let db, mgr, ws, user;
const gift = (personId, cents, extra = {}) => mgr.action('gift.log', { person_id: personId, amount_cents: cents, date: `${year}-01-02`, method: 'cheque', ...extra });
const fieldId = async (name) => ok(await mgr.get('/api/fields')).fields.find((f) => f.name === name)?.id;

before(async () => {
  db = await freshDb();
  wear('base');
  mgr = new Client();
  const r = ok(await mgr.signup({ workspaceName: `Kamloops Forward ${tag}`, email: `neutral.members.${tag}@example.org`, jurisdiction: 'bc-municipal' }));
  ws = r.workspace.id;
  user = r.user.id;
});

test('another campaign: the sign-in says it has no membership, and the form’s action and its three reads are not there', async () => {
  wear('base');
  const me = ok(await mgr.get('/api/auth/me'));
  assert.ok(!me.org.features.includes('membership'), JSON.stringify(me.org.features));
  const p = await mgr.createPerson(`Mo Member ${tag}`, { email: `mo.${tag}@example.org` });
  const entered = await mgr.action('membership.enter', { first_name: 'Ana', last_name: `Example ${tag}`, term: 1, once: { kind: 'amount', amount_cents: 1000 }, method: 'cash', signed: true });
  assert.equal(entered.status, 404, JSON.stringify(entered.json));
  assert.equal((await mgr.action('membership.enter', { first_name: 'Nobody', last_name: `Atall ${tag}` })).status, 404, 'not even a form with no membership on it');
  for (const path of ['/api/membership/form', `/api/membership/form?date=${today}`, `/api/membership/match?email=mo.${tag}@example.org`, `/api/persons/${p.id}/membership`]) {
    assert.equal((await mgr.get(path)).status, 404, path);
  }
  assert.equal((await db.query('select count(*)::int as n from member_terms where workspace_id = $1', [ws])).rows[0].n, 0);
  assert.equal((await db.query('select count(*)::int as n from gift_pledges where workspace_id = $1', [ws])).rows[0].n, 0);
  assert.equal((await db.query("select count(*)::int as n from persons where workspace_id = $1 and name like 'Ana Example%'", [ws])).rows[0].n, 0, 'nobody was made on the way to the refusal');
});

test('another campaign: a membership checkout is not found (before anything about payments is asked)', async () => {
  wear('base');
  const p = await mgr.createPerson(`Tara Dues ${tag}`, { email: `tara.${tag}@example.org` });
  const run = (kind) => runAction(db, { workspaceId: ws, actorId: null, action: 'site.form.join' }, (tx, emit) => prepareCheckout(tx, { workspaceId: ws }, {
    personId: p.id, kind, term: 1, amountCents: 2500, cadence: 'once', declaration: true,
    successUrl: 'https://site.example.org/join?sent=1', cancelUrl: 'https://site.example.org/join',
  }, emit));
  const e = await run('membership').then(() => null, (err) => err);
  assert.equal(e?.status, 404, String(e?.message));
  // A gift is still what it was: refused only because Stripe isn't set up here.
  const g = await run('donation').then(() => null, (err) => err);
  assert.notEqual(g?.status, 404, String(g?.message));
  assert.equal((await db.query('select count(*)::int as n from stripe_checkouts where workspace_id = $1', [ws])).rows[0].n, 0);
});

test('another campaign: the website’s “Member (joined online)” tag makes no membership', async () => {
  wear('base');
  const key = ok(await mgr.action('intake.key.create', { name: `Site ${tag}` })).key;
  const res = await app.request('/in/v1/people', {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ first_name: 'Eve', last_name: 'Example', email: `eve.${tag}@example.org`, tags: [IS.membership.websiteTag] }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  const eve = (await res.json()).person_id;
  assert.ok(eve, 'the person is still recorded');
  assert.equal((await db.query('select count(*)::int as n from member_terms where person_id = $1', [eve])).rows[0].n, 0);
});

test('another campaign: no Members report, download or Sheet, and no Member column on the candidates report', async () => {
  wear('base');
  const menu = ok(await mgr.get('/api/quick-reports-menu')).reports.map((r) => r.name);
  assert.deepEqual(menu, ['walk', 'donors', 'running', 'volunteers', 'signs', 'moved']);
  for (const path of ['/api/quick-reports/members', '/api/quick-reports/members/count', '/api/quick-reports/members?who=lapsed']) {
    assert.equal((await mgr.get(path)).status, 404, path);
  }
  assert.equal((await raw(mgr, '/api/quick-reports/members.csv')).status, 404);
  assert.equal((await raw(mgr, '/api/export/members.csv')).status, 404);
  assert.equal((await raw(mgr, '/api/export/people.csv')).status, 200, 'the other downloads are as they were');
  // "Send to Google Sheets": neither the table nor the quick report.
  const ctx = { workspaceId: ws, role: 'manager', workspace: { id: ws, settings: {} } };
  for (const [source, ref] of [['dataset', 'members'], ['quick', 'members'], ['quick', 'members?who=current']]) {
    const e = await sourceOf(db, ctx, source, ref).then(() => null, (err) => err);
    assert.equal(e?.status, 404, `${source} ${ref}: ${e?.message}`);
  }
  assert.ok(await sourceOf(db, ctx, 'dataset', 'people'));
  // The candidates report still counts, without the Member column.
  const field = await fieldId('Interested in being a candidate');
  const cy = await mgr.createPerson(`Cy Candidate ${tag}`);
  ok(await mgr.action('field.values.set', { person_id: cy.id, values: [{ field_id: field, value: true }] }));
  const r = ok(await mgr.get('/api/quick-reports/running'));
  assert.equal(r.total, 1);
  assert.deepEqual(r.head.map((h) => h.label), ['Last name', 'First name', 'Phone', 'Email', 'Address', 'City', 'Postal code', 'Volunteers as', 'Said so on', 'Do not contact']);
  assert.ok(!('member' in r.rows[0]), JSON.stringify(r.rows[0]));
  const csv = await (await raw(mgr, '/api/quick-reports/running.csv')).text();
  assert.doesNotMatch(csv.split(/\r?\n/)[0], /Member/);
});

test('another campaign: no Membership rule — People is not sorted by it, and the choices say so', async () => {
  wear('base');
  const choices = ok(await mgr.get('/api/audience/choices'));
  assert.equal(choices.membership, false);
  const a = await mgr.createPerson(`Rule One ${tag}`, { tags: [`rule-${tag}`] });
  await mgr.createPerson(`Rule Two ${tag}`, { tags: [`rule-${tag}`] });
  const who = async (q) => ok(await mgr.get(`/api/persons?limit=50&tag=rule-${tag}&${q}`)).persons.length;
  assert.equal(await who(''), 2);
  assert.equal(await who('member=now'), 2, 'the rule is not read: nobody is left out by it');
  assert.equal(await who('member=lapsed'), 2);
  assert.ok(a.id);
});

test('another campaign: a ladder can’t start on a membership or have one as its goal', async () => {
  wear('base');
  const starts = await mgr.action('ladder.create', { name: `Members ${tag}`, trigger: { kind: 'member' } });
  assert.equal(starts.status, 400, JSON.stringify(starts.json));
  const goal = await mgr.action('ladder.create', { name: `To members ${tag}`, trigger: { kind: 'newsletter' }, goal: 'member' });
  assert.equal(goal.status, 400, JSON.stringify(goal.json));
  const fine = ok(await mgr.action('ladder.create', { name: `Givers ${tag}`, trigger: { kind: 'gift' }, goal: 'gift' })).ladder;
  assert.equal((await mgr.action('ladder.update', { id: fine.id, trigger: { kind: 'member' } })).status, 400);
  assert.equal((await mgr.action('ladder.update', { id: fine.id, goal: 'member' })).status, 400);
});

test('another campaign: a $5,000 donor is a Donor — no named tier, no label, no Tier column', async () => {
  wear('base');
  const p = await mgr.createPerson(`Big Giver ${tag}`);
  ok(await gift(p.id, 500_000));
  const donor = ok(await mgr.get(`/api/persons/${p.id}`)).donor;
  assert.equal(donor.tier, 'one-time');
  assert.equal(donor.label ?? null, null);
  assert.equal(donor.rank ?? null, null);
  assert.equal(donor.yearCents, 500_000);
  const m = await mgr.createPerson(`Monthly Giver ${tag}`);
  ok(await gift(m.id, 30_000, { date: today, cadence: 'monthly' }));
  assert.equal((await tierFor(db, ws, m.id)).tier, 'monthly', '$300 a month is a monthly donor, nothing more');
  const r = ok(await mgr.get('/api/quick-reports/donors'));
  assert.ok(!r.head.some((h) => h.key === 'tier'), JSON.stringify(r.head.map((h) => h.label)));
  assert.ok(r.rows.length >= 2 && r.rows.every((x) => !('tier' in x)));
  assert.doesNotMatch(await (await raw(mgr, '/api/quick-reports/donors.csv')).text(), /\bTier\b|Superstar|\bStar\b/);
  // The shared rule holds no tier of its own.
  assert.equal(donorTier({ yearCents: 500_000, monthlyCents: 0 }), 'one-time');
  assert.equal(donorTier({ yearCents: 0, monthlyCents: 90_000 }), 'monthly');
  assert.equal(donorTier({ yearCents: 0, monthlyCents: 0 }), null);
  assert.equal(donorTier({ yearCents: 500_000 }, IS.donorTiers), 'superstar');
});

test('another campaign: the command bar offers no membership form', () => {
  const none = { role: 'manager', areas: [], org: { features: [] } };
  const has = { role: 'manager', areas: [], org: { features: ['membership'] } };
  const labels = (me) => commandsFor(me, []).actions.map((a) => a.label);
  assert.ok(!labels(none).includes('Enter a membership form'));
  assert.ok(labels(none).includes('Log a gift'), 'the other jobs stay');
  assert.ok(labels(has).includes('Enter a membership form'));
});

test('another campaign: nothing it is sent names a club, a tier or the dues', async () => {
  wear('base');
  const p = (await db.query("select id from persons where workspace_id = $1 and name like 'Big Giver%' limit 1", [ws])).rows[0];
  const texts = [];
  for (const path of ['/api/auth/me', '/api/audience/choices', '/api/quick-reports-menu', '/api/quick-reports/donors', `/api/persons/${p.id}`, '/api/membership/form', '/api/ladders']) {
    texts.push(JSON.stringify((await mgr.get(path)).json));
  }
  assert.doesNotMatch(texts.join('\n'), /superstar|star club|school board slate|youth_cents|aged 14/i);
});

// ── The same server as Imagine Surrey's ──
test('Imagine Surrey, set after the server was loaded: the form takes 1 and 4 years and refuses 2; its answers are what they were', async () => {
  wear('imagine-surrey');
  const c = new Client();
  const r = ok(await c.signup({ workspaceName: `Imagine Surrey ${tag}`, email: `is.members.${tag}@example.org`, jurisdiction: 'bc-municipal' }));
  const me = ok(await c.get('/api/auth/me'));
  assert.ok(me.org.features.includes('membership'));
  const enter = (input) => c.action('membership.enter', { method: 'cheque', signed: true, signed_on: today, ...input });
  const one = ok(await enter({ first_name: 'Una', last_name: `One ${tag}`, email: `una.${tag}@example.org`, term: 1, once: { kind: 'star' } }));
  assert.equal(one.membership.term_years, 1);
  const four = ok(await enter({ first_name: 'Fay', last_name: `Four ${tag}`, term: 4, once: { kind: 'amount', amount_cents: 4000 } }));
  assert.equal(four.membership.term_years, 4);
  for (const term of [2, 3, 0, 5]) {
    const no = await enter({ first_name: 'Tia', last_name: `Two ${tag}`, term, once: { kind: 'amount', amount_cents: 4000 } });
    assert.equal(no.status, 400, `${term}: ${JSON.stringify(no.json)}`);
  }
  assert.equal((await db.query("select count(*)::int as n from persons where workspace_id = $1 and name like 'Tia Two%'", [r.workspace.id])).rows[0].n, 0, 'a refused form makes nobody');
  // The club gift is noted under the club's own name.
  const notes = (await db.query('select note from gifts where person_id = $1', [one.person.id])).rows.map((g) => g.note);
  assert.deepEqual(notes, ['Star Club — membership form']);
  // The opt-in the form makes on joining, when the screen says nothing.
  const fields = Object.fromEntries(ok(await c.get(`/api/persons/${one.person.id}/fields`)).fields.map((f) => [f.name, f.value]));
  assert.equal(fields['Email opt-in'], true);
  // The form's own answer: what it always sent, and now the form itself.
  const f = ok(await c.get(`/api/membership/form?date=${today}`));
  assert.deepEqual(f.minimum, { adult_cents: 1000, youth_cents: 500, youth_ages: [14, 30] });
  assert.deepEqual(f.slates.map((s) => s.code), ['council', 'school_board']);
  assert.deepEqual(f.form.terms, [1, 4]);
  assert.deepEqual(f.form.once, [25000, 10000, 5000, 1000]);
  assert.deepEqual(f.form.monthly, [5000, 2500, 1000, 500]);
  assert.deepEqual(f.form.dues, { adult_cents: 1000, youth_cents: 500, youth_ages: [14, 30], min_age: 14 });
  assert.equal(f.form.city, 'Surrey');
  assert.equal(f.form.schoolBoardLine, 'Star Club to the school board slate (not council)');
  assert.deepEqual(f.form.clubs.map((x) => [x.key, x.label, Boolean(x.schoolBoard)]), [['superstar', 'Superstar Club', false], ['star', 'Star Club', true]]);
  if (f.clubs) {
    assert.deepEqual(f.form.clubs.map((x) => [x.once_cents, x.monthly_cents]), [[f.clubs.superstar_once, f.clubs.superstar_monthly], [f.clubs.star_once, f.clubs.star_monthly]]);
  }
  assert.deepEqual(f.form.fallback.languages, IS.membership.fallback.languages);
  assert.deepEqual(f.form.fallback.interests, IS.membership.fallback.interests);
  assert.deepEqual(f.form.fallback.campuses, IS.fields.campuses);
  // The reads, the report, the download, the rule and the ladder are there.
  assert.equal(ok(await c.get(`/api/persons/${one.person.id}/membership`)).member, true);
  assert.equal(ok(await c.get(`/api/membership/match?email=una.${tag}@example.org`)).people.length, 1);
  assert.deepEqual(ok(await c.get('/api/quick-reports-menu')).reports.map((x) => x.name), ['walk', 'donors', 'running', 'volunteers', 'members', 'signs', 'moved']);
  assert.equal(ok(await c.get('/api/quick-reports/members')).total, 2);
  assert.equal((await raw(c, '/api/export/members.csv')).status, 200);
  assert.ok(!('membership' in ok(await c.get('/api/audience/choices'))), 'the choices are as they were');
  assert.equal(ok(await c.get('/api/persons?limit=50&member=now')).persons.length, 2);
  ok(await c.action('ladder.create', { name: `New members ${tag}`, trigger: { kind: 'member' }, goal: 'member' }));
  assert.ok(ok(await c.get('/api/quick-reports/running')).head.some((h) => h.key === 'member'));
  // Tiers: named, with the words and the order the profile draws them by.
  const big = await c.createPerson(`Big Giver ${tag}`);
  ok(await c.action('gift.log', { person_id: big.id, amount_cents: 500_000, date: `${year}-01-02`, method: 'cheque' }));
  const donor = ok(await c.get(`/api/persons/${big.id}`)).donor;
  assert.deepEqual([donor.tier, donor.label, donor.rank, donor.yearCents], ['superstar', 'Superstar', 0, 500_000]);
  const starDonor = ok(await c.get(`/api/persons/${one.person.id}`)).donor;
  assert.deepEqual([starDonor.tier, starDonor.label, starDonor.rank], ['star', 'Star', 1]);
  const small = ok(await c.get(`/api/persons/${four.person.id}`)).donor;
  assert.deepEqual([small.tier, small.label ?? null], ['one-time', null]);
  const donors = ok(await c.get('/api/quick-reports/donors'));
  assert.ok(donors.head.some((h) => h.key === 'tier' && h.label === 'Tier'));
  assert.deepEqual(donors.rows.map((x) => x.tier).sort(), ['', 'Star', 'Superstar']);
  // And the brand read again as another campaign's: gone, on the same server.
  wear('base');
  assert.equal((await c.get('/api/membership/form')).status, 404);
  assert.equal(ok(await c.get(`/api/persons/${big.id}`)).donor.tier, 'one-time');
  assert.ok(user);
});
