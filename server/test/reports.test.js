// Reports and exports: the desk reads the campaign in numbers and downloads
// any of them, or a whole table, as CSV; volunteers are refused.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';

const tag = Math.random().toString(36).slice(2, 8);
let mgr; let vol;

before(async () => {
  await freshDb();
  mgr = new Client();
  await mgr.signup({ workspaceName: 'Imagine Surrey', email: `rep.${tag}@example.org`, jurisdiction: 'bc-municipal' });
  const inv = await mgr.action('member.invite', { email: `vol.${tag}@example.org`, role: 'volunteer' });
  vol = new Client();
  await vol.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: 'Vic', password: 'reports-pass-2026' });
  const a = await mgr.createPerson('Anne Donor', { email: `anne.${tag}@example.org`, tags: ['member'], city: 'Surrey' });
  await mgr.createPerson('Bob Voter', { phone: '604-555-0102', tags: ['member', 'yard-sign'], city: 'Delta' });
  await mgr.action('gift.log', { person_id: a.id, amount_cents: 5000, date: new Date().toISOString().slice(0, 10), method: 'cash' });
  await mgr.action('contact.log', { person_id: a.id, channel: 'door', outcome: 'contacted', rating: '1' });
  await mgr.action('subscription.add', { email: `anne.${tag}@example.org`, name: 'Anne' });
});

test('the reports: totals and tables; CSV of any report and any dataset; volunteers refused', async () => {
  const r = await mgr.get('/api/reports');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.totals.people.total, 2);
  assert.equal(r.json.totals.donations.cents, 5000);
  assert.equal(r.json.totals.newsletter.subscribed, 1);
  assert.equal(r.json.totals.contacts.week, 1);
  const tags = r.json.reports.tags.rows;
  assert.deepEqual(tags[0], ['member', 2]);
  assert.ok(r.json.reports.rating.rows.some((x) => x[1] === '1' && x[2] === 1), JSON.stringify(r.json.reports.rating));
  assert.equal(r.json.reports.donations.rows.length, 1);
  assert.equal(r.json.reports.contacts.rows[0][1], 1, 'one door this week');
  const csv = await app.request('/api/reports/tags.csv', { headers: { cookie: mgr.cookie } });
  assert.equal(csv.status, 200);
  assert.match(await csv.text(), /Tag,People\r\nmember,2/);
  const people = await app.request('/api/export/people.csv', { headers: { cookie: mgr.cookie } });
  assert.equal(people.status, 200);
  const text = await people.text();
  assert.match(text, /^﻿?first_name,last_name,name,email,phone,unit,house_number,street,address/);
  assert.match(text, /Bob,Voter,Bob Voter,,604-555-0102/);
  assert.match(text, /member; yard-sign/);
  for (const d of ['gifts', 'subscribers', 'contacts', 'lists']) {
    const res = await app.request(`/api/export/${d}.csv`, { headers: { cookie: mgr.cookie } });
    assert.equal(res.status, 200, d);
  }
  assert.equal((await app.request('/api/export/nope.csv', { headers: { cookie: mgr.cookie } })).status, 404);
  assert.equal((await vol.get('/api/reports')).status, 403);
  assert.equal((await app.request('/api/export/people.csv', { headers: { cookie: vol.cookie } })).status, 403);
});

test('more as spreadsheets: volunteers with their roles, signs, shifts; People carries voted, and reads back in', async () => {
  const bob = (await mgr.get('/api/persons?q=Bob%20Voter')).json.persons[0];
  await mgr.action('volunteer.assign', { person_id: bob.id, role: 'driver' });
  await mgr.action('volunteer.assign', { person_id: bob.id, role: 'scrutineer', detail: 'Newton Rec' });
  await mgr.action('sign.place', { kind: 'lawn', person_id: bob.id, address: '1 Main St' });
  await mgr.action('shift.create', { title: 'Saturday canvass', starts_at: new Date(Date.now() + 864e5).toISOString(), capacity: 6 });
  await mgr.action('vote.mark', { person_id: bob.id, source: 'desk' });
  const csv = async (d) => (await app.request(`/api/export/${d}.csv`, { headers: { cookie: mgr.cookie } })).text();
  assert.match(await csv('volunteers'), /Bob Voter,,604-555-0102,driver; scrutineer \(Newton Rec\)/);
  assert.match(await csv('signs'), /1 Main St,lawn,requested,Bob Voter/);
  assert.match(await csv('shifts'), /Saturday canvass,.*,6,0/);
  const people = await csv('people');
  const head = people.replace(/^﻿/, '').split('\r\n')[0].split(',');
  assert.ok(head.includes('voted'), head.join());
  const bobRow = people.split('\r\n').find((l) => l.includes(',Bob Voter,')).split(',');
  assert.match(bobRow[head.indexOf('voted')], /^\d{4}-\d{2}-\d{2}$/, 'voted as a date');
  // The People spreadsheet imports straight back into another campaign.
  const other = new Client();
  await other.signup({ workspaceName: 'Round trip', email: `rt.${tag}@example.org`, jurisdiction: 'bc-municipal' });
  const rows = people.replace(/^﻿/, '').split('\r\n').slice(1).filter(Boolean).map((l) => {
    const cells = l.split(',');
    return { first: cells[head.indexOf('first_name')], last: cells[head.indexOf('last_name')], phone: cells[head.indexOf('phone')] || undefined, city: cells[head.indexOf('city')] || undefined, voted: cells[head.indexOf('voted')] || undefined };
  });
  const r = await other.post('/api/data/import', { rows });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const back = (await other.get('/api/persons?q=Bob%20Voter')).json.persons[0];
  assert.ok(back && back.voted_at, 'Bob comes back, voted');
  assert.deepEqual([back.first_name, back.last_name], ['Bob', 'Voter'], 'first and last apart, as they went out');
});
