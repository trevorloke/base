// The command bar (web/src/components/commands.js and the people search it
// uses): what each person is offered follows their areas; what's typed finds
// the right screen or job first; a phone typed any way finds the person.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { commandsFor, rank, scoreItem, fold } from '../../web/src/components/commands.js';

const NAV = [
  { to: '/', label: 'Today' }, { to: '/map', label: 'Map' }, { to: '/people', label: 'People' }, { to: '/shifts', label: 'Shifts' },
  { to: '/money', label: 'Donations' }, { to: '/signs', label: 'Signs' }, { to: '/outreach', label: 'Outreach' },
];
const labels = (items) => items.map((i) => i.label);

test('a manager is offered every job and the settings', () => {
  const { actions, screens } = commandsFor({ role: 'manager', areas: [] }, NAV);
  assert.deepEqual(labels(actions), ['Add person', 'Log a gift', 'Enter a membership form', 'Draw a turf', 'New shift', 'Write an email', 'Write a text']);
  assert.equal(actions.find((a) => a.label === 'New shift').to, '/shifts?add=1', 'the week’s add sheet — by tap — not the long form');
  for (const s of ['Today', 'Donations', 'Members', 'Permissions', 'Services', 'Rating scale', 'Profile fields', 'Your profile']) {
    assert.ok(labels(screens).includes(s), s);
  }
  assert.equal(screens.filter((s) => s.to === '/people').length, 1, 'a tab is offered once');
});

test('staff without Donations: no gift, no form, no money screens; no settings', () => {
  const staff = { role: 'staff', areas: ['people', 'map', 'shifts', 'signs', 'outreach', 'data', 'learn'] };
  const { actions, screens } = commandsFor(staff, NAV.filter((n) => n.to !== '/money'));
  assert.ok(!labels(actions).includes('Log a gift') && !labels(actions).includes('Enter a membership form'));
  assert.ok(labels(actions).includes('Add person') && labels(actions).includes('Write a text'));
  for (const s of ['Donations', 'Receipts', 'Stewardship', 'Members', 'Settings', 'Rating scale']) assert.ok(!labels(screens).includes(s), s);
  assert.ok(labels(screens).includes('Your profile'));
});

test('a volunteer given Outreach: its jobs are the desk’s — no jobs, and only what the area opens', () => {
  const vol = { role: 'volunteer', areas: ['outreach'] };
  const { actions, screens } = commandsFor(vol, [{ to: '/outreach', label: 'Outreach' }]);
  assert.deepEqual(labels(actions), [], 'writing a send is the desk’s');
  assert.ok(labels(screens).includes('Ladders') && labels(screens).includes('Surveys'));
  assert.ok(!labels(screens).includes('Reports') && !labels(screens).includes('Phone banks') && !labels(screens).includes('Volunteers'));
});

test('what’s typed: the label’s start first, then a word in it, then its other words; every word must match', () => {
  const { actions, screens } = commandsFor({ role: 'manager', areas: [] }, NAV);
  const all = [...screens, ...actions];
  assert.equal(rank(all, 'don')[0].label, 'Donations');
  assert.equal(rank(all, 'gift')[0].label, 'Log a gift');
  assert.equal(rank(all, 'turf')[0].label, 'Turfs and walk lists');
  assert.ok(labels(rank(all, 'turf')).includes('Draw a turf'));
  assert.equal(rank(all, 'membership')[0].label, 'Enter a membership form');
  assert.equal(rank(all, 'sms')[0].label, 'Text inbox', 'its other words count');
  assert.deepEqual(labels(rank(all, 'write text')), ['Write a text']);
  assert.deepEqual(rank(all, 'zzz'), []);
  assert.equal(rank(all, '').length, all.length, 'nothing typed: everything, in order');
  assert.equal(fold('  Café   ÉXAMPLE '), 'cafe example');
  assert.ok(scoreItem({ label: 'Two-step' }, 'two') > scoreItem({ label: 'Not two' }, 'two'));
});

let mgr;
before(async () => {
  await freshDb();
  mgr = new Client();
  await mgr.signup({ workspaceName: 'Imagine Surrey', email: 'cmd.manager@example.org' });
  await mgr.createPerson('Lena Example', { phone: '604-555-0142', email: 'lena@example.org' });
  await mgr.createPerson('Omar Example', { phone: '(778) 555-0199' });
  await mgr.createPerson('Pat Example', { phone: '+1 604 555 0177 ext. 22' });
});

test('the quick search: the start of a name or a last name, a phone typed any way, a whole email', async () => {
  const find = async (q, who = mgr) => (await who.get(`/api/search/people?q=${encodeURIComponent(q)}`)).json.persons.map((p) => p.name);
  assert.deepEqual(await find('lena'), ['Lena Example']);
  assert.deepEqual(await find('LENA EX'), ['Lena Example']);
  assert.deepEqual(await find('exam'), ['Lena Example', 'Omar Example', 'Pat Example'], 'the last name’s start, in name order');
  assert.deepEqual(await find('604 555 0142'), ['Lena Example']);
  assert.deepEqual(await find('(778) 555'), ['Omar Example']);
  assert.deepEqual(await find('+1 778 555 0199'), ['Omar Example']);
  assert.deepEqual(await find('604 555 0177'), ['Pat Example'], 'saved with a country code and an extension');
  assert.deepEqual(await find('1-604-555-0177'), ['Pat Example']);
  assert.deepEqual(await find('+1604555'), ['Lena Example', 'Pat Example'], 'the start of an E.164 number');
  assert.deepEqual(await find('604 555 01'), ['Lena Example', 'Pat Example'], 'the start of a number');
  assert.deepEqual(await find('lena@example.org'), ['Lena Example']);
  assert.deepEqual(await find('ena'), [], 'the middle of a name is People’s own search (the command bar asks it next)');
  assert.deepEqual(await find('l'), [], 'two letters at least');
  assert.deepEqual(await find('50%_\\'), [], 'its own wildcards are just characters');
});

test('the quick search keeps People’s rules: a volunteer never matches on an email nor sees one; denied People, refused', async () => {
  const inv = await mgr.action('member.invite', { email: 'vic.cmd@example.org', role: 'volunteer' });
  const vol = new Client();
  await vol.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: 'Vic Example', password: 'command-bar-2026' });
  assert.deepEqual((await vol.get('/api/search/people?q=lena%40example.org')).json.persons, []);
  const seen = (await vol.get('/api/search/people?q=lena')).json.persons;
  assert.deepEqual([seen.length, seen[0].name, seen[0].email], [1, 'Lena Example', null]);
  const inv2 = await mgr.action('member.invite', { email: 'sam.cmd@example.org', role: 'staff' });
  const staff = new Client();
  const j = await staff.post('/api/auth/join', { token: inv2.json.joinUrl.split('/join/')[1], name: 'Sam Example', password: 'command-bar-2026' });
  assert.equal((await staff.get('/api/search/people?q=lena')).json.persons.length, 1);
  await mgr.action('permission.member.set', { user_id: j.json.user.id, grant: [], deny: ['people'] });
  assert.equal((await staff.get('/api/search/people?q=lena')).status, 403);
  assert.equal((await new Client().get('/api/search/people?q=lena')).status, 401);
});

test('people: a phone typed any way finds them, digits against digits', async () => {
  const find = async (q) => (await mgr.get(`/api/persons?q=${encodeURIComponent(q)}&limit=6`)).json.persons.map((p) => p.name);
  assert.deepEqual(await find('6045550142'), ['Lena Example']);
  assert.deepEqual(await find('604 555 0142'), ['Lena Example']);
  assert.deepEqual(await find('+1 604 555 0142'), ['Lena Example']);
  assert.deepEqual(await find('778-555-0199'), ['Omar Example']);
  assert.deepEqual(await find('7785550199'), ['Omar Example']);
  assert.deepEqual(await find('555-01'), ['Lena Example', 'Omar Example', 'Pat Example'], 'part of a number, however it was saved');
  assert.deepEqual(await find('1604'), ['Pat Example'], 'four digits starting with 1: searched as typed');
  assert.deepEqual(await find('6045550199'), [], 'no one has that number');
  assert.deepEqual(await find('lena@'), ['Lena Example'], 'email');
  assert.deepEqual(await find('omar'), ['Omar Example'], 'name');
});
