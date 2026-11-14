// Letters to the editor and op-eds (server/ext/letters, LTE stage 1): a
// writer's own letter through New → Working → Ready → Sent → Published, the
// desk's queue beside it, and what each side may do and see. Ready is the
// writer's word alone; no desk action sets it, changes the writer's text or
// sends anything. The log never holds a letter's words, the export never
// its sign-off, and the address and phone typed for it go 30 days after it
// closes.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { freshDb, Client } from './helpers.js';
import { runDueJobs } from '../lib/jobs.js';

const tag = Math.random().toString(36).slice(2, 8);
const mail = (who) => `${who}.lt.${tag}@example.org`;
const sha = (t) => createHash('sha256').update(t, 'utf8').digest('hex');
const ok = (r, msg = '') => { assert.equal(r.status, 200, `${msg} ${JSON.stringify(r.json)}`); return r.json; };
const no = (r, status, msg = '') => { assert.equal(r.status, status, `${msg} ${JSON.stringify(r.json)}`); return r.json; };
const cid = () => randomUUID();
const BODY = 'Surrey needs more buses on the King George corridor, and it needs them before the next school year starts in the fall.';
let db, mgr, ws, vic, vicId, vim, staff;

// One campaign for the file (sign-ins per address are limited): a manager;
// Vic, a volunteer; Vim, a volunteer granted Media; Sid, staff denied Media.
before(async () => {
  db = await freshDb();
  mgr = new Client();
  const r = await mgr.signup({ workspaceName: `Letters ${tag}`, email: mail('mgr'), jurisdiction: 'bc-municipal' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  ws = r.json.workspace.id;
  const join = async (role, name) => {
    const inv = ok(await mgr.action('member.invite', { email: mail(name), role }));
    const c = new Client();
    const j = ok(await c.post('/api/auth/join', { token: inv.joinUrl.split('/join/')[1], name: `${name[0].toUpperCase()}${name.slice(1)} Example`, password: 'letters-pass-1234' }));
    return { c, id: j.user.id };
  };
  const v = await join('volunteer', 'vic');
  vic = v.c; vicId = v.id;
  const m = await join('volunteer', 'vim');
  vim = m.c;
  ok(await mgr.action('permission.member.set', { user_id: m.id, grant: ['media'], deny: [] }));
  const s = await join('staff', 'sid');
  staff = s.c;
  ok(await mgr.action('permission.member.set', { user_id: s.id, grant: [], deny: ['media'] }));
});

let n = 0;
const outlet = async (extra = {}) => {
  n += 1;
  return ok(await mgr.action('media.outlet.save', { name: `Example Paper ${n}`, kind: 'paper', letters_email: `letters${n}@example.org`, letters_limit: 250, ...extra })).outlet;
};
const submit = (c, extra = {}) => c.action('myletter.submit', { client_id: cid(), kind: 'letter', body: BODY, outlet_ids: [], ...extra });
const mine = async (c, id) => ok(await c.get(`/api/letters/mine/${id}`)).letter;
const desk = async (id) => ok(await mgr.get(`/api/media/letters/${id}`)).letter;
const newest = (l) => l.drafts[l.drafts.length - 1];
const row = async (id) => (await db.query('select * from letters where id = $1', [id])).rows[0];
// To Ready: the writer agrees to their newest draft.
const ready = async (c, id) => {
  const l = await mine(c, id);
  return c.action('myletter.agree', { id, version_id: newest(l).id });
};

test('submit: New, the first draft is the writer’s, the sign-off is read from their record; a replay is the same letter', async () => {
  const paper = await outlet();
  const key = cid();
  const first = ok(await vic.action('myletter.submit', {
    client_id: key, kind: 'letter', title: 'Buses now', body: BODY, outlet_ids: [paper.id], sign: { phone: '604-555-0142' },
  }));
  assert.equal(first.letter.status, 'new');
  assert.deepEqual(first.dropped_outlets, []);
  const again = ok(await vic.action('myletter.submit', { client_id: key, kind: 'letter', body: 'something else', outlet_ids: [] }));
  assert.deepEqual([again.letter.id, again.duplicate], [first.letter.id, true]);
  assert.equal((await db.query('select count(*)::int as n from letters where client_id = $1', [key])).rows[0].n, 1);
  // Someone else's key is no way in.
  no(await vim.action('myletter.submit', { client_id: key, kind: 'letter', body: BODY, outlet_ids: [] }), 409);

  const r = await row(first.letter.id);
  assert.deepEqual([r.sign_name, r.sign_city, r.sign_address, r.sign_phone], [null, null, null, '604-555-0142'], 'only what they changed');
  // selfPerson made Vic's record (none had her login email).
  const p = (await db.query('select id, name, email, tags from persons where id = $1', [r.person_id])).rows[0];
  assert.deepEqual([p.email, p.tags], [mail('vic'), ['volunteer']]);
  ok(await mgr.action('person.update', { id: p.id, city: 'Surrey', address: '100 Example St' }));
  const l = await mine(vic, first.letter.id);
  assert.deepEqual(l.sign, { name: 'Vic Example', city: 'Surrey', address: '100 Example St', phone: '604-555-0142' }, 'the record, then the changed phone');
  assert.deepEqual(l.drafts.map((d) => [d.n, d.side, d.body]), [[1, 'writer', BODY]]);
  assert.deepEqual(l.outlets.map((o) => [o.name, o.email, o.limit, o.asks_phone]), [[paper.name, paper.letters_email, 250, true]]);
  assert.equal(l.outlets[0].confirmed_by, undefined, 'a writer never sees who checked the rules');

  const list = ok(await vic.get('/api/letters/mine'));
  assert.equal(list.letters[0].id, first.letter.id);
  assert.deepEqual(list.letters[0].outlets, [{ id: paper.id, name: paper.name }]);
});

test('submit drops an outlet that is gone or doesn’t take letters, never refuses; a body over 20,000 is 400', async () => {
  const gone = await outlet();
  const opedOnly = await outlet({ letters_email: '', oped_email: 'oped@example.org' });
  const good = await outlet();
  ok(await mgr.action('media.outlet.remove', { id: gone.id }));
  const r = ok(await submit(vic, { outlet_ids: [gone.id, good.id, opedOnly.id] }));
  assert.deepEqual((await row(r.letter.id)).outlet_ids, [good.id]);
  assert.deepEqual(r.dropped_outlets.map((d) => d.name), [gone.name, opedOnly.name]);
  const unknown = randomUUID();
  assert.deepEqual(ok(await submit(vic, { outlet_ids: [unknown] })).dropped_outlets, [{ id: unknown }], 'not this campaign’s');
  no(await submit(vic, { outlet_ids: [good.id, good.id, good.id, good.id] }), 400, 'three at most');
  // As an op-ed, the op-ed-only paper is taken.
  const op = ok(await submit(vic, { kind: 'op_ed', outlet_ids: [opedOnly.id, good.id] }));
  assert.deepEqual((await row(op.letter.id)).outlet_ids, [opedOnly.id]);
  // The writer's outlets read: only those that take the kind, with the published address.
  const read = ok(await vic.get('/api/letters/outlets?kind=op_ed'));
  assert.deepEqual(read.outlets.map((o) => [o.name, o.email]), [[opedOnly.name, 'oped@example.org']]);
  assert.equal(read.you.candidate, false);
  assert.equal(read.you.sign.name, 'Vic Example');
  no(await submit(vic, { body: 'x'.repeat(20001) }), 400);
  no(await submit(vic, { body: '   ' }), 400);
  ok(await submit(vic, { body: 'x'.repeat(20000) }));
});

test('who may: another writer’s letter is 404; a volunteer granted Media gets 403 on the queue; staff denied Media write their own', async () => {
  const mineL = ok(await submit(vic)).letter;
  no(await vim.get(`/api/letters/mine/${mineL.id}`), 404);
  no(await vim.action('myletter.note', { id: mineL.id, body: 'hi', client_id: cid() }), 404);
  no(await mgr.get(`/api/letters/mine/${mineL.id}`), 404, 'not even the manager, on the writer’s read');
  for (const path of ['/api/media/letters', '/api/media/letters/count', `/api/media/letters/${mineL.id}`]) {
    no(await vim.get(path), 403, path);
    no(await vic.get(path), 403, path);
    no(await staff.get(path), 403, path);
  }
  const deskActions = [
    ['letter.status', { id: mineL.id, status: 'working' }], ['letter.assign', { id: mineL.id, user_id: null }],
    ['letter.suggest', { id: mineL.id, body: 'x' }], ['letter.note', { id: mineL.id, body: 'x' }],
    ['letter.told_sent', { id: mineL.id, outlet_id: randomUUID() }], ['letter.published', { id: mineL.id, send_id: randomUUID(), url: 'https://example.org/a' }],
    ['letter.not_published', { id: mineL.id, send_id: randomUUID() }], ['letter.decline', { id: mineL.id, note: 'no' }],
    ['letter.reopen', { id: mineL.id }], ['letter.points', { text: 'x' }], ['letter.settings', { wait_days: 5 }],
  ];
  for (const [name, input] of deskActions) {
    no(await vim.action(name, input), 403, name);
    no(await staff.action(name, input), 403, name);
  }
  // Staff denied Media still write, agree and send their own.
  const own = ok(await submit(staff)).letter;
  ok(await ready(staff, own.id));
  assert.equal(ok(await staff.get('/api/letters/mine')).letters.length, 1);
});

test('suggest → Working, the writer’s text untouched; take changes; agree only on the newest writer draft; any new draft clears it', async () => {
  const l = ok(await submit(vic)).letter;
  const sugg = BODY.replace('more buses', 'more frequent buses').replace('fall', 'autumn');
  ok(await mgr.action('letter.suggest', { id: l.id, body: sugg, note: 'Two small changes' }));
  let w = await mine(vic, l.id);
  assert.equal(w.status, 'working');
  assert.deepEqual(w.drafts.map((d) => [d.side, d.body]), [['writer', BODY], ['campaign', sugg]]);
  assert.equal(w.drafts[1].by, 'Avery');
  assert.deepEqual(w.notes.map((x) => [x.side, x.body, x.by]), [['campaign', 'Two small changes', 'Avery']]);
  // Agreeing to the campaign's draft, or to a stale one: 409.
  no(await vic.action('myletter.agree', { id: l.id, version_id: w.drafts[1].id }), 409);
  no(await vic.action('myletter.agree', { id: l.id, version_id: w.drafts[0].id }), 409);
  // The writer takes one change.
  const took = BODY.replace('more buses', 'more frequent buses');
  ok(await vic.action('myletter.revise', { id: l.id, body: took, client_id: cid(), from_version: w.drafts[1].id }));
  no(await vic.action('myletter.revise', { id: l.id, body: took, client_id: cid(), from_version: w.drafts[0].id }), 400, 'from_version must be a suggestion');
  w = await mine(vic, l.id);
  assert.deepEqual([newest(w).side, newest(w).body, newest(w).from_version], ['writer', took, w.drafts[1].id]);
  const agreed = ok(await vic.action('myletter.agree', { id: l.id, version_id: newest(w).id })).letter;
  assert.deepEqual([agreed.status, agreed.agreed_hash], ['ready', sha(took)]);
  assert.deepEqual([(await row(l.id)).agreed_hash, (await row(l.id)).agreed_version], [sha(took), newest(w).id]);
  // A later suggestion clears the agreement and moves Ready back to Working.
  ok(await mgr.action('letter.suggest', { id: l.id, body: `${took} Thank you.` }));
  let r = await row(l.id);
  assert.deepEqual([r.status, r.agreed_version, r.agreed_hash], ['working', null, null]);
  // So does the writer's own new draft.
  ok(await vic.action('myletter.revise', { id: l.id, body: took, client_id: cid() }));
  ok(await ready(vic, l.id));
  ok(await vic.action('myletter.revise', { id: l.id, body: `${took}!`, client_id: cid() }));
  r = await row(l.id);
  assert.deepEqual([r.status, r.agreed_version], ['working', null]);

  // No desk action sets Ready or changes the writer's text.
  const before = (await mine(vic, l.id)).drafts.filter((d) => d.side === 'writer').map((d) => d.body);
  no(await mgr.action('letter.status', { id: l.id, status: 'ready' }), 400);
  no(await mgr.action('myletter.agree', { id: l.id, version_id: newest(await mine(vic, l.id)).id }), 404, 'not the manager’s letter');
  no(await mgr.action('myletter.revise', { id: l.id, body: 'mine now', client_id: cid() }), 404);
  ok(await mgr.action('letter.suggest', { id: l.id, body: 'All new words from the office.' }));
  ok(await mgr.action('letter.note', { id: l.id, body: 'Have a look' }));
  ok(await mgr.action('letter.status', { id: l.id, status: 'working' }));
  const after = (await mine(vic, l.id)).drafts.filter((d) => d.side === 'writer').map((d) => d.body);
  assert.deepEqual(after, before);
  assert.equal((await row(l.id)).status, 'working');
});

test('suggest → Keep mine (the same text again) → This is my final text works', async () => {
  const l = ok(await submit(vic)).letter;
  ok(await mgr.action('letter.suggest', { id: l.id, body: 'Something else entirely, written by the office.' }));
  no(await vic.action('myletter.agree', { id: l.id, version_id: newest(await mine(vic, l.id)).id }), 409, 'the newest is the campaign’s');
  ok(await vic.action('myletter.revise', { id: l.id, body: BODY, client_id: cid() }));
  const r = ok(await ready(vic, l.id)).letter;
  assert.deepEqual([r.status, r.agreed_hash], ['ready', sha(BODY)]);
});

test('sends: agreement first; an exclusive paper still out flags a send elsewhere but never refuses it; same newsroom isn’t flagged; Not published → Ready', async () => {
  const a = await outlet({ newsroom: 'Example Media Group' });
  const sister = await outlet({ newsroom: 'example media group' });
  const b = await outlet();
  const l = ok(await submit(vic, { outlet_ids: [a.id, sister.id, b.id] })).letter;
  no(await vic.action('myletter.sent', { id: l.id, outlet_id: a.id, how: 'email', client_id: cid() }), 409);
  ok(await ready(vic, l.id));
  const key = cid();
  const s1 = ok(await vic.action('myletter.sent', { id: l.id, outlet_id: a.id, how: 'email', client_id: key })).send;
  assert.equal((await vic.action('myletter.sent', { id: l.id, outlet_id: a.id, how: 'email', client_id: key })).json.duplicate, true);
  assert.equal((await row(l.id)).status, 'sent');
  let w = await mine(vic, l.id);
  const ours = (bl) => bl.filter((x) => [a.id, sister.id, b.id].includes(x.outlet_id));
  assert.deepEqual(ours(w.blocked).map((x) => [x.outlet_id, x.by]), [[b.id, a.name]], 'the sister paper is the same newsroom; the other is blocked');
  // The writer sends to the sister paper: same newsroom, no flag.
  const s2 = ok(await vic.action('myletter.sent', { id: l.id, outlet_id: sister.id, how: 'form', client_id: cid() })).send;
  assert.equal(s2.while_out_at, null);
  // …and to the other paper anyway: recorded, flagged.
  const s3 = ok(await vic.action('myletter.sent', { id: l.id, outlet_id: b.id, how: 'email', client_id: cid() })).send;
  assert.ok([s1.id, s2.id].includes(s3.while_out_at), 'flagged: sent while that newsroom still had it');
  const q = ok(await mgr.get('/api/media/letters')).letters.find((x) => x.id === l.id);
  assert.equal(q.sent_while_out, true);
  assert.ok([a.name, sister.name].includes(q.while_out_name), 'the desk’s chip names the paper that still had it');
  assert.ok([a.name, sister.name].includes((await desk(l.id)).sends.find((s) => s.id === s3.id).while_out_at.outlet_name));
  // Not published at each: back to Ready once none is still out, with the chip.
  for (const s of [s1, s2, s3]) ok(await vic.action('myletter.not_published', { id: l.id, send_id: s.id, client_id: cid() }));
  assert.equal((await row(l.id)).status, 'ready');
  const listed = ok(await vic.get('/api/letters/mine')).letters.find((x) => x.id === l.id);
  assert.equal(listed.status, 'ready');
  assert.ok([a.name, sister.name, b.name].includes(listed.not_printed_at));
  assert.ok(ok(await mgr.get('/api/media/letters?status=ready')).letters.find((x) => x.id === l.id).not_printed_at);
  w = await mine(vic, l.id);
  assert.deepEqual(w.blocked, [], 'nothing out now');
  const s4 = ok(await vic.action('myletter.sent', { id: l.id, outlet_id: b.id, how: 'email', client_id: cid() })).send;
  assert.equal(s4.while_out_at, null, 'nothing still out: no flag');

  // After the wait (10 days by default), an old exclusive send no longer blocks or flags.
  await db.query(`update letter_sends set sent_at = now() - interval '11 days' where id = $1`, [s4.id]);
  w = await mine(vic, l.id);
  assert.deepEqual(w.blocked, []);
  const s5 = ok(await vic.action('myletter.sent', { id: l.id, outlet_id: a.id, how: 'email', client_id: cid() })).send;
  assert.equal(s5.while_out_at, null);
  // A shorter wait set by a manager reaches it too.
  ok(await mgr.action('letter.settings', { wait_days: 3 }));
  no(await mgr.action('letter.settings', { wait_days: 2 }), 400);
  await db.query(`update letter_sends set sent_at = now() - interval '4 days' where id = $1`, [s5.id]);
  assert.deepEqual((await mine(vic, l.id)).blocked, []);
  ok(await mgr.action('letter.settings', { wait_days: 10 }));

  // The desk records "They told us they sent it": a record, nothing sent.
  const l2 = ok(await submit(vic, { outlet_ids: [b.id] })).letter;
  no(await mgr.action('letter.told_sent', { id: l2.id, outlet_id: b.id }), 409, 'agreement first');
  ok(await ready(vic, l2.id));
  const told = ok(await mgr.action('letter.told_sent', { id: l2.id, outlet_id: b.id })).send;
  assert.equal(told.how, 'told_desk');
  assert.equal((await row(l2.id)).status, 'sent');
});

test('a one-paper letter can go to any of the campaign’s papers: the read blocks the others while an exclusive send is out', async () => {
  const only = await outlet();
  const other = await outlet();
  const l = ok(await submit(vic, { outlet_ids: [only.id] })).letter;
  ok(await ready(vic, l.id));
  const s = ok(await vic.action('myletter.sent', { id: l.id, outlet_id: only.id, how: 'email', client_id: cid() })).send;
  const w = await mine(vic, l.id);
  assert.deepEqual(w.blocked.filter((x) => x.outlet_id === other.id).map((x) => x.by), [only.name], 'another of the campaign’s papers, not one the writer picked');
  assert.equal(w.blocked.some((x) => x.outlet_id === only.id), false, 'not blocked by its own send');
  // Not printed: back to Ready, and any other paper may have it.
  ok(await vic.action('myletter.not_published', { id: l.id, send_id: s.id, client_id: cid() }));
  assert.deepEqual((await mine(vic, l.id)).blocked, []);
  const s2 = ok(await vic.action('myletter.sent', { id: l.id, outlet_id: other.id, how: 'email', client_id: cid() })).send;
  assert.equal(s2.while_out_at, null);
  assert.equal((await row(l.id)).status, 'sent');
});

test('a paper dropped when the letter landed is still named on every read until the writer picks again', async () => {
  const gone = await outlet();
  const good = await outlet();
  ok(await mgr.action('media.outlet.remove', { id: gone.id }));
  const l = ok(await submit(vic, { outlet_ids: [good.id, gone.id] })).letter;
  assert.deepEqual((await mine(vic, l.id)).dropped_outlets.map((d) => d.name), [gone.name], 'the writer’s read, after a reload');
  assert.deepEqual((await desk(l.id)).dropped_outlets.map((d) => d.name), [gone.name], 'the desk’s read');
  ok(await vic.action('myletter.details', { id: l.id, outlet_ids: [good.id] }));
  assert.deepEqual((await mine(vic, l.id)).dropped_outlets, [], 'picked again: no longer said');
});

test('published, declined, withdrawn, deleted; the purge 30 days after a letter closes, unless reopened', async () => {
  const paper = await outlet();
  const sign = { address: '200 Example Ave', phone: '604-555-0150' };
  const l = ok(await submit(vic, { outlet_ids: [paper.id], sign })).letter;
  ok(await ready(vic, l.id));
  const s = ok(await vic.action('myletter.sent', { id: l.id, outlet_id: paper.id, how: 'email', client_id: cid() })).send;
  no(await mgr.action('letter.published', { id: l.id, send_id: s.id, url: 'ftp://example.org/x' }), 400);
  ok(await mgr.action('letter.published', { id: l.id, send_id: s.id, url: 'https://example.org/letters/buses', on: '2026-11-12' }));
  const w = await mine(vic, l.id);
  assert.equal(w.status, 'published');
  assert.deepEqual([w.sends[0].outcome, w.sends[0].url, w.sends[0].published_on], ['published', 'https://example.org/letters/buses', '2026-11-12']);
  no(await vic.action('myletter.revise', { id: l.id, body: 'more', client_id: cid() }), 409);
  no(await vic.action('myletter.delete', { id: l.id }), 409, 'sent: withdraw, never delete');

  // Declined: the desk's word, with a note the writer sees; reopen takes it back.
  const d = ok(await submit(vic, { sign })).letter;
  no(await vic.action('letter.decline', { id: d.id, note: 'x' }), 403);
  ok(await mgr.action('letter.decline', { id: d.id, note: 'We can’t help with this one' }));
  const dw = await mine(vic, d.id);
  assert.deepEqual([dw.status, dw.declined_note], ['declined', 'We can’t help with this one']);
  ok(await mgr.action('letter.reopen', { id: d.id }));
  assert.deepEqual([(await row(d.id)).status, (await row(d.id)).closed_at], ['working', null]);

  // The purge: due 30 days on, through the job runner.
  const due = async () => {
    await db.query(`update letters set closed_at = closed_at - interval '31 days' where workspace_id = $1 and closed_at is not null`, [ws]);
    await db.query(`update jobs set run_at = now() - interval '1 minute' where workspace_id = $1 and kind = 'letters.purge' and status = 'pending'`, [ws]);
    await runDueJobs(db, { workspaceId: ws });
  };
  ok(await mgr.action('letter.decline', { id: d.id, note: 'Not this time' }));
  ok(await mgr.action('letter.reopen', { id: d.id })); // reopened before the job: kept
  await due();
  let r = await row(l.id);
  assert.deepEqual([r.sign_address, r.sign_phone], [null, null], 'published 30 days ago: gone');
  r = await row(d.id);
  assert.deepEqual([r.sign_address, r.sign_phone], [sign.address, sign.phone], 'reopened: kept');
  const purged = (await db.query(`select actor_id, payload from events where workspace_id = $1 and action = 'letter.purge'`, [ws])).rows;
  assert.equal(purged.length, 1);
  assert.equal(purged[0].actor_id, null);

  // Withdraw takes the address and phone at once; delete only one never sent.
  const x = ok(await submit(vic, { sign })).letter;
  ok(await vic.action('myletter.withdraw', { id: x.id }));
  r = await row(x.id);
  assert.deepEqual([r.status, r.sign_address, r.sign_phone, Boolean(r.closed_at)], ['withdrawn', null, null, true]);
  ok(await vic.action('myletter.delete', { id: x.id }));
  assert.equal(await row(x.id), undefined);
  assert.equal((await db.query('select count(*)::int as n from letter_versions where letter_id = $1', [x.id])).rows[0].n, 0);
});

test('the log holds no letter’s words; the export no sign-off; a merge moves the writer’s record', async () => {
  const words = 'A very particular sentence nobody else would write about sidewalks.';
  const l = ok(await submit(vic, { title: 'Sidewalks title', body: words, sign: { name: 'Vic E.', city: 'Cloverdale', address: '300 Example Rd', phone: '604-555-0177' } })).letter;
  ok(await vic.action('myletter.note', { id: l.id, body: 'A note only the desk should read', client_id: cid() }));
  ok(await mgr.action('letter.suggest', { id: l.id, body: `${words} Suggested.`, note: 'Office note text' }));
  ok(await vic.action('myletter.revise', { id: l.id, body: words, client_id: cid() }));
  ok(await ready(vic, l.id));
  const events = (await db.query(`select entity_type, payload::text as p from events where workspace_id = $1 and entity_type like 'letter%'`, [ws])).rows;
  assert.ok(events.length >= 6);
  for (const e of events) {
    for (const secret of ['Sidewalks', 'particular sentence', 'only the desk', 'Office note', 'Cloverdale', '300 Example', '555-0177', 'Vic E.', 'campaign_share']) {
      assert.ok(!e.p.includes(secret), `${e.entity_type} holds ${secret}`);
    }
  }
  const v = events.filter((e) => e.entity_type === 'letter_version').map((e) => JSON.parse(e.p));
  assert.ok(v.some((x) => x.hash === sha(words)));
  const agreement = events.filter((e) => e.entity_type === 'letter_agreement').map((e) => JSON.parse(e.p)).at(-1);
  assert.equal(agreement.hash, sha(words));

  const out = ok(await mgr.get('/api/export'));
  assert.ok(out.letters.length > 0 && out.letter_versions.length > 0 && 'letter_notes' in out && 'letter_sends' in out);
  for (const r of out.letters) for (const k of ['sign_name', 'sign_city', 'sign_address', 'sign_phone']) assert.ok(!(k in r), k);

  const keep = await mgr.createPerson('Vic Example', { email: `other.${mail('vic')}` });
  const drop = (await row(l.id)).person_id;
  ok(await mgr.action('person.merge', { keep: keep.id, drop }));
  assert.equal((await row(l.id)).person_id, keep.id);
});

test('Today: the desk’s count and the writer’s unseen replies move as each side acts and reads', async () => {
  const count = async () => ok(await mgr.get('/api/media/letters/count'));
  const brief = async () => ok(await vic.get('/api/brief')).letters;
  ok(await mgr.get('/api/media/letters')); // nothing seen yet; read the count fresh below
  const before = await count();
  const l = ok(await submit(vic)).letter;
  assert.equal((await count()).new, before.new + 1);
  const b0 = await brief();
  assert.equal(b0.has, true);
  ok(await mgr.action('letter.note', { id: l.id, body: 'Thanks — we’ll have a look' }));
  assert.equal((await count()).new, before.new, 'a desk note moves it to Working');
  const b1 = await brief();
  assert.equal(b1.unseen, b0.unseen + 1);
  assert.equal(ok(await vic.get('/api/letters/mine')).letters.find((x) => x.id === l.id).unseen, true);
  await mine(vic, l.id); // reading it is seen
  assert.equal((await brief()).unseen, b0.unseen);
  const w0 = (await count()).waiting;
  ok(await vic.action('myletter.note', { id: l.id, body: 'Thank you', client_id: cid() }));
  assert.equal((await count()).waiting, w0 + 1);
  assert.equal(ok(await mgr.get('/api/media/letters')).letters.find((x) => x.id === l.id).waiting, true);
  const d = await desk(l.id);
  assert.equal((await count()).waiting, w0);
  assert.equal(d.writer.name, 'Vic Example');
  assert.ok('phone' in d.sign && 'address' in d.sign, 'the desk sees the full sign-off');
  // A volunteer's brief has it too (no area needed).
  assert.ok(ok(await vim.get('/api/brief')).letters);
});

test('Editors here: live contacts on the matching list at a wanted outlet; talking points and the campaign name reach the writer', async () => {
  const paper = await outlet({ oped_email: 'oped@example.org' });
  const add = (who, lists) => mgr.action('media.contact.add', { name: `${who[0].toUpperCase()}${who.slice(1)} Example`, kind: 'media', email: mail(who), outlet: paper.name.toUpperCase(), lists }).then(ok);
  await add('ed', ['letters']);
  await add('opal', ['op_ed']);
  const gone = await add('gil', ['letters']);
  ok(await mgr.action('media.contact.remove', { person_id: gone.person_id }));
  const l = ok(await submit(vic, { outlet_ids: [paper.id] })).letter;
  assert.deepEqual((await desk(l.id)).editors.map((e) => e.name), ['Ed Example']);
  const op = ok(await submit(vic, { kind: 'op_ed', outlet_ids: [paper.id] })).letter;
  assert.deepEqual((await desk(op.id)).editors.map((e) => e.name), ['Opal Example']);
  assert.equal((await desk(op.id)).outlets[0].confirmed_on, null);

  ok(await mgr.action('letter.points', { text: 'Buses every 10 minutes on King George by 2028.' }));
  const read = ok(await vic.get('/api/letters/outlets'));
  assert.equal(read.points, 'Buses every 10 minutes on King George by 2028.');
  assert.equal(read.campaign_name, `Letters ${tag}`);
  // The desk's assign takes only a staff member of this campaign.
  no(await mgr.action('letter.assign', { id: l.id, user_id: vicId }), 400);
  const me = ok(await mgr.get('/api/auth/me')).user.id;
  ok(await mgr.action('letter.assign', { id: l.id, user_id: me }));
  assert.equal(ok(await mgr.get('/api/media/letters')).letters.find((x) => x.id === l.id).assigned_to_name, 'Avery Chen');
});
