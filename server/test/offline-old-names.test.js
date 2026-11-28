// What a phone kept under the app's older storage names (web/src/offline.js,
// web/src/oldStorage.js, components/OfflineCache.js, components/letterDrafts.js):
// unsent knocks in the outbox, walk lists, letter drafts, the saved sign-in and
// the rest. A volunteer who updates the app must lose none of it, and sign-out
// must still forget all of it. Each case runs the app's own modules in a fresh
// node process (they read storage when they load), with stand-in storage, a
// navigator whose locks are recorded and no signal. This file may write the
// older names out: it proves they still work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { OLD_STORAGE } from '@base-win/shared/old-names';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SRC = (p) => pathToFileURL(join(ROOT, 'web/src', p)).href;
const OLD = OLD_STORAGE.prefix; // the older prefix at a site's root
const NEW = 'base-win:';

// Runs `body` (an async function's text; it gets { m, local, session, asked,
// fire, out }) in a fresh process: window.__BASE__ = base, storage holding
// `local` / `session`, setItem throwing while `full` is set. Returns what
// `out` collected, and the storage afterwards. quota: the most the whole of
// localStorage may hold (keys and values, in characters), as a phone's does;
// a save that would go over it throws.
const run = (body, { base = '', local = {}, session = {}, full = false, quota = 0 } = {}) => {
  const script = `
    class Store {
      constructor(init) { this.m = new Map(Object.entries(init)); this.full = false; }
      get length() { return this.m.size; }
      key(i) { return [...this.m.keys()][i] ?? null; }
      getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
      size(but) { let n = 0; for (const [k, v] of this.m) if (k !== but) n += k.length + v.length; return n; }
      setItem(k, v) {
        v = String(v);
        if (this.full || (this.quota && this.size(k) + k.length + v.length > this.quota)) { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; }
        this.m.set(k, v);
      }
      removeItem(k) { this.m.delete(k); }
      clear() { this.m.clear(); }
    }
    const init = JSON.parse(process.env.T_INIT);
    const local = new Store(init.local); const session = new Store(init.session);
    local.full = init.full; local.quota = init.quota;
    const on = {};
    globalThis.window = { __BASE__: init.base, addEventListener(t, fn) { (on[t] ||= []).push(fn); }, removeEventListener() {}, dispatchEvent() { return true; }, location: { reload() {} } };
    globalThis.localStorage = local; globalThis.sessionStorage = session;
    const asked = [];
    Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { onLine: true, locks: { request: (name, fn) => { asked.push(name); return Promise.resolve().then(fn); } } } });
    globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
    const fire = (type, e) => { for (const fn of on[type] || []) fn(e); };
    const out = {};
    const m = (p) => import(${JSON.stringify(SRC('x').slice(0, -1))} + p);
    try {
      await (${body})({ m, local, session, asked, fire, out });
    } catch (err) { out.error = String(err && err.stack || err); }
    process.stdout.write(JSON.stringify({ out, local: Object.fromEntries(local.m), session: Object.fromEntries(session.m) }));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, T_INIT: JSON.stringify({ base, local, session, full, quota }) },
  });
  assert.equal(r.status, 0, r.stderr);
  const res = JSON.parse(r.stdout);
  assert.equal(res.out.error, undefined, res.out.error);
  return res;
};

const item = (cid, extra = {}) => ({ cid, name: 'contact.log', input: { person_id: `p-${cid}`, channel: 'door', outcome: 'no_answer', client_id: cid }, meta: {}, at: '2026-10-01T18:00:00.000Z', tries: 0, state: 'pending', ...extra });
const knock = (cid) => ({ person_id: `p-${cid}`, channel: 'door', outcome: 'no_answer', client_id: cid, queued_at: '2026-09-01T18:00:00.000Z' });
const cids = (raw) => JSON.parse(raw || '[]').map((i) => i.cid).sort();
const J = JSON.stringify;

test('at the root: knocks under the older outbox names (v2 and v1) are all waiting under the new one, once each, and the older keys are gone', () => {
  const r = run(`async ({ m, out }) => {
    const ob = await m('offline.js');
    out.pending = ob.pendingCount();
  }`, { local: {
    [`${OLD}outbox:v2`]: J([item('a1', { note: 'older' }), item('b2')]),
    [`${OLD}outbox:v1`]: J([knock('c3'), knock('b2')]),
    [`${NEW}outbox:v2`]: J([item('a1', { note: 'newer' })]),
    [`${NEW}outbox:v1`]: J([knock('d4')]),
  } });
  assert.deepEqual(cids(r.local[`${NEW}outbox:v2`]), ['a1', 'b2', 'c3', 'd4'], 'every item, each once by cid');
  assert.equal(JSON.parse(r.local[`${NEW}outbox:v2`]).find((i) => i.cid === 'a1').note, 'newer', 'an item already under the new name wins');
  assert.equal(r.out.pending, 4);
  for (const k of [`${OLD}outbox:v2`, `${OLD}outbox:v1`, `${NEW}outbox:v1`]) assert.equal(r.local[k], undefined, `${k} is gone`);
});

test('under a client’s path: the client’s older outbox moves to its new one, and the root’s is not touched', () => {
  const r = run(`async ({ m, out }) => { const ob = await m('offline.js'); out.pending = ob.pendingCount(); }`, { base: '/acme', local: {
    [`${OLD}acme:outbox:v2`]: J([item('a1')]),
    [`${OLD}acme:outbox:v1`]: J([knock('b2')]),
    [`${OLD}outbox:v2`]: J([item('root1')]),
  } });
  assert.deepEqual(cids(r.local[`${NEW}acme:outbox:v2`]), ['a1', 'b2']);
  assert.equal(r.out.pending, 2);
  assert.equal(r.local[`${OLD}acme:outbox:v2`], undefined);
  assert.equal(r.local[`${OLD}acme:outbox:v1`], undefined);
  assert.deepEqual(cids(r.local[`${OLD}outbox:v2`]), ['root1'], 'the root’s outbox is the root’s');
  assert.equal(r.local[`${NEW}outbox:v2`], undefined);
});

test('at the root, a path client’s older outbox on the same domain is never taken', () => {
  const r = run(`async ({ m, out }) => { const ob = await m('offline.js'); out.pending = ob.pendingCount(); }`, { local: {
    [`${OLD}acme:outbox:v2`]: J([item('acme1')]),
    [`${OLD}outbox:v2`]: J([item('root1')]),
  } });
  assert.deepEqual(cids(r.local[`${NEW}outbox:v2`]), ['root1']);
  assert.deepEqual(cids(r.local[`${OLD}acme:outbox:v2`]), ['acme1'], 'still there, for that client');
  assert.equal(r.out.pending, 1);
});

test('a tab still on the older app writes the older outbox after the move: the next read takes it in, and a storage event shows it', () => {
  const r = run(`async ({ m, local, fire, out }) => {
    const ob = await m('offline.js');
    out.before = ob.pendingCount();
    // The older tab saves a knock (it starts from what it finds: nothing).
    local.setItem(${J(`${OLD}outbox:v2`)}, JSON.stringify([${J(item('late1'))}]));
    fire('storage', { key: ${J(`${OLD}outbox:v2`)}, storageArea: local });
    out.afterEvent = ob.pendingCount();
    // And again with no event at all (another window): the next change reads it.
    local.setItem(${J(`${OLD}outbox:v2`)}, JSON.stringify([${J(item('late2'))}]));
    ob.dismissItem('nothing-by-this-id');
    out.afterChange = ob.pendingCount();
  }`, { local: { [`${OLD}outbox:v2`]: J([item('a1')]) } });
  assert.equal(r.out.before, 1);
  assert.equal(r.out.afterEvent, 2, 'the older tab’s knock shows here');
  assert.equal(r.out.afterChange, 3);
  assert.deepEqual(cids(r.local[`${NEW}outbox:v2`]), ['a1', 'late1', 'late2']);
  assert.equal(r.local[`${OLD}outbox:v2`], undefined);
});

test('with storage full (saving throws), the older keys are kept and the knocks still show', () => {
  const r = run(`async ({ m, out }) => { const ob = await m('offline.js'); out.pending = ob.pendingCount(); }`, { full: true, local: {
    [`${OLD}outbox:v2`]: J([item('a1'), item('b2')]),
    [`${OLD}outbox:v1`]: J([knock('c3')]),
  } });
  assert.equal(r.out.pending, 3, 'shown and sent from memory');
  assert.deepEqual(cids(r.local[`${OLD}outbox:v2`]), ['a1', 'b2'], 'nothing removed that could not be saved again');
  assert.ok(r.local[`${OLD}outbox:v1`]);
  assert.equal(r.local[`${NEW}outbox:v2`], undefined);
});

// A phone with less room left than its older outbox needs once merged, but
// more than a shorter list needs: what is sent is sent once, and stays sent
// after a reload; what a sign-out cleared stays cleared after a reload.
const details = (cid) => ({ cid, name: 'person.details', input: { id: `p-${cid}`, phone: '555-0100' }, meta: {}, at: '2026-10-01T18:00:00.000Z', tries: 0, state: 'pending' });
const SIGNED_IN = (id) => J({ user: { id }, workspace: { id: 'w1' } });
const ANSWERS_OK = `globalThis.fetch = async (url) => {
  out.sent = out.sent || [];
  out.sent.push(String(url).split('/').pop());
  if (out.sent.length > 30) throw new Error('sent over and over: ' + out.sent.join(','));
  return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
};`;
test('room for less than the merged outbox: a flush sends each older item once and ends, and a reload sends nothing again', () => {
  const older = { [`${OLD}outbox:v2`]: J([item('a1'), item('b2'), details('d4')]) };
  for (const quota of [700, 800, 900, 950, 1000, 1100]) {
    const r = run(`async ({ m, out }) => {
      ${ANSWERS_OK}
      const ob = await m('offline.js');
      ob.setOutboxOwner(${SIGNED_IN('u1')});
      await ob.flushOutbox();
      out.pending = ob.pendingCount();
    }`, { quota, local: older });
    assert.deepEqual([...r.out.sent].sort(), ['contact.log', 'contact.log', 'person.details'], `room ${quota}: each sent once`);
    assert.equal(r.out.pending, 0, `room ${quota}`);
    const again = run(`async ({ m, out }) => {
      ${ANSWERS_OK}
      const ob = await m('offline.js');
      ob.setOutboxOwner(${SIGNED_IN('u1')});
      out.pending = ob.pendingCount();
      await ob.flushOutbox();
    }`, { quota, local: r.local });
    assert.equal(again.out.pending, 0, `room ${quota}: nothing waiting after a reload`);
    assert.equal(again.out.sent, undefined, `room ${quota}: nothing sent again after a reload`);
  }
});

test('room for less than the merged outbox: what sign-out cleared does not come back after a reload for the next person', () => {
  const owned = item('a1', { owner: 'w1:A' });
  const ownerless = item('b2');
  for (const quota of [300, 400, 500, 0]) {
    const r = run(`async ({ m, out }) => {
      const ob = await m('offline.js');
      ob.setOutboxOwner(${SIGNED_IN('A')});
      out.before = ob.unsentCount();
      ob.clearOutbox();
      out.after = ob.unsentCount();
    }`, { quota, local: { [`${OLD}outbox:v2`]: J([owned, ownerless]), [`${OLD}outbox:v1`]: J([knock('c3')]) } });
    assert.equal(r.out.before, 3, `room ${quota}`);
    assert.equal(r.out.after, 0, `room ${quota}`);
    const next = run(`async ({ m, out }) => {
      const ob = await m('offline.js');
      ob.setOutboxOwner(${SIGNED_IN('B')});
      out.unsent = ob.unsentCount();
    }`, { quota, local: r.local });
    assert.equal(next.out.unsent, 0, `room ${quota}: nothing of A's is waiting for B`);
  }
});

test('sending takes the new lock first, then the older one (a tab on the older app only ever takes the older one)', () => {
  const root = run(`async ({ m, asked, out }) => { const ob = await m('offline.js'); await ob.flushOutbox(); out.asked = asked; }`, { local: { [`${NEW}outbox:v2`]: J([item('a1')]) } });
  assert.deepEqual(root.out.asked, ['base-win-outbox', OLD_STORAGE.rootLock]);
  const path = run(`async ({ m, asked, out }) => { const ob = await m('offline.js'); await ob.flushOutbox(); out.asked = asked; }`, { base: '/acme', local: { [`${NEW}acme:outbox:v2`]: J([item('a1')]) } });
  assert.deepEqual(path.out.asked, [`${NEW}acme:outbox`, `${OLD}acme:outbox`]);
});

const fresh = () => J({ at: Date.now(), data: { ok: true } });
test('sign-out forgets the phone’s copies under both names, and keepOnlyMine treats both alike', () => {
  const r = run(`async ({ m, local, out }) => {
    const OC = await m('components/OfflineCache.js');
    OC.keepOnlyMine({ user: { id: 'u1' }, workspace: { id: 'w1' }, role: 'volunteer' });
    out.kept = Object.keys(Object.fromEntries(local.m)).sort();
    OC.forgetPhoneCopies();
    out.left = Object.keys(Object.fromEntries(local.m)).sort();
  }`, { local: {
    [`${OLD}copy:v1:w1:u1:doors`]: fresh(),
    [`${OLD}copy:v1:w1:u2:doors`]: fresh(),
    [`${OLD}copy:v1:w1:u1:q:staff:signs`]: fresh(),
    [`${OLD}field:v1:w1:u1:walk:t1`]: fresh(),
    [`${OLD}field:v1:w1:u2:walk:t1`]: fresh(),
    [`${OLD}copy-role:v1`]: 'w1:u1:volunteer',
    [`${NEW}copy:v1:w1:u1:turfs`]: fresh(),
    [`${NEW}copy:v1:w1:u2:turfs`]: fresh(),
    [`${OLD}acme:copy:v1:w1:u2:doors`]: fresh(),
    [`${OLD}outbox:v2`]: '[]',
  } });
  assert.deepEqual(r.out.kept, [
    `${NEW}copy-role:v1`, `${NEW}copy:v1:w1:u1:turfs`,
    `${OLD}acme:copy:v1:w1:u2:doors`, `${OLD}copy:v1:w1:u1:doors`, `${OLD}field:v1:w1:u1:walk:t1`, `${OLD}outbox:v2`,
  ].sort(), 'another sign-in’s and another role’s copies go under either name; a path client’s are not this app’s');
  assert.deepEqual(r.out.left, [`${OLD}acme:copy:v1:w1:u2:doors`, `${OLD}outbox:v2`].sort(), 'every copy and both role marks go at sign-out');
});

const ME = { user: { id: 'u1', name: 'Pat Example' }, workspace: { id: 'w1', name: 'Example Campaign' }, role: 'volunteer' };
test('at start, everything else kept under the older prefix is carried to the new one: the saved sign-in, walk lists, letter drafts, the map’s choices', () => {
  const r = run(`async ({ m, local, out }) => {
    await m('oldStorage.js');
    const api = await m('api.js');
    out.me = api.savedSignIn();
    const L = await m('components/letterDrafts.js');
    L.setLetterScope(${J(ME)});
    out.draft = L.readDraft('draft');
    out.count = L.letterDraftCount();
  }`, { local: {
    [`${OLD}me:v1`]: J(ME),
    [`${OLD}field:v1:w1:u1:walk:t1`]: J({ at: Date.now(), data: { turf: { name: 'North' } } }),
    [`${OLD}field:v1:w1:u1:letters:draft`]: J({ at: Date.now(), data: { title: 'On the bus lanes', body: 'Half written' } }),
    [`${OLD}field:v1:w1:u1:letters:edit:L1`]: J({ at: Date.now(), data: { body: 'Queued edit', queued: 'cid-1' } }),
    [`${OLD}copy:v1:w1:u1:scale`]: J({ at: 1, data: { steps: [] } }),
    [`${OLD}map:view`]: 'Muted',
    [`${OLD}gotv-notes:w1:u1`]: '{"p1":"back at 5"}',
    [`${OLD}surveys:v1:w1:s1`]: '{}',
    [`${OLD}acme:me:v1`]: J({ user: { id: 'x' }, workspace: { id: 'y' } }),
    [`${OLD}outbox:v2`]: J([item('a1')]),
    [`${NEW}map:turfs`]: 'on',
    [`${OLD}map:turfs`]: 'off',
  }, session: {
    [`${OLD}brand-saved`]: 'saved',
    [`${OLD}copy:v1:w1:u1:q:manager:money`]: J({ at: Date.now(), data: 1 }),
  } });
  assert.deepEqual(r.out.me, ME, 'a volunteer who updates while offline is still signed in');
  assert.deepEqual(r.out.draft, { title: 'On the bus lanes', body: 'Half written' }, 'a half-written letter is still there');
  assert.equal(r.out.count, 1, 'sign-out still asks about it (a queued one is the outbox’s)');
  for (const k of ['me:v1', 'field:v1:w1:u1:walk:t1', 'field:v1:w1:u1:letters:draft', 'field:v1:w1:u1:letters:edit:L1', 'copy:v1:w1:u1:scale', 'map:view', 'gotv-notes:w1:u1', 'surveys:v1:w1:s1']) {
    assert.ok(r.local[`${NEW}${k}`], `${k} carried`);
    assert.equal(r.local[`${OLD}${k}`], undefined, `older ${k} gone`);
  }
  assert.equal(r.local[`${NEW}map:turfs`], 'on', 'a key already under the new name stays as it is');
  assert.equal(r.local[`${OLD}map:turfs`], undefined);
  assert.ok(r.local[`${OLD}acme:me:v1`], 'at the root, a path client’s keys are never taken');
  assert.equal(r.local[`${NEW}acme:me:v1`], undefined);
  assert.ok(r.local[`${OLD}outbox:v2`] === undefined && cids(r.local[`${NEW}outbox:v2`]).join() === 'a1', 'the outbox is carried by the outbox (merged, never copied over)');
  assert.equal(r.session[`${NEW}brand-saved`], 'saved', 'this tab’s keys too');
  assert.ok(r.session[`${NEW}copy:v1:w1:u1:q:manager:money`]);
  assert.equal(r.session[`${OLD}brand-saved`], undefined);
});

test('under a client’s path, only that client’s older keys are carried', () => {
  const r = run(`async ({ m }) => { await m('oldStorage.js'); }`, { base: '/acme', local: {
    [`${OLD}acme:me:v1`]: J(ME),
    [`${OLD}acme:field:v1:w1:u1:walk:t1`]: fresh(),
    [`${OLD}me:v1`]: J(ME),
  } });
  assert.ok(r.local[`${NEW}acme:me:v1`]);
  assert.ok(r.local[`${NEW}acme:field:v1:w1:u1:walk:t1`]);
  assert.equal(r.local[`${OLD}acme:me:v1`], undefined);
  assert.ok(r.local[`${OLD}me:v1`], 'the root’s own are left for the root');
  assert.equal(r.local[`${NEW}me:v1`], undefined);
});

test('with storage full, nothing older is removed, and sign-out still counts and forgets an older letter draft', () => {
  const r = run(`async ({ m, local, out }) => {
    await m('oldStorage.js');
    const L = await m('components/letterDrafts.js');
    L.setLetterScope(${J(ME)});
    out.count = L.letterDraftCount();
    local.full = false;
    const OC = await m('components/OfflineCache.js');
    OC.forgetPhoneCopies();
  }`, { full: true, local: {
    [`${OLD}field:v1:w1:u1:letters:draft`]: J({ at: Date.now(), data: { body: 'Half written' } }),
    [`${OLD}me:v1`]: J(ME),
  } });
  assert.equal(r.out.count, 1, 'the older draft is counted: sign-out asks before it goes');
  assert.equal(r.local[`${OLD}field:v1:w1:u1:letters:draft`], undefined, 'and sign-out forgets it');
  assert.ok(r.local[`${OLD}me:v1`], 'kept: it could not be saved under the new name');
});

test('a person’s Phone/Text choice on Calls is carried from its older key', () => {
  const r = run(`async ({ m, local, out }) => {
    const { carryKey } = await m('oldStorage.js');
    out.moved = carryKey(local, ${J(`${OLD_STORAGE.callsChannel}w1:u1`)}, ${J(`${NEW}calls.channel:w1:u1`)});
  }`, { local: { [`${OLD_STORAGE.callsChannel}w1:u1`]: 'text' } });
  assert.equal(r.out.moved, true);
  assert.equal(r.local[`${NEW}calls.channel:w1:u1`], 'text');
  assert.equal(r.local[`${OLD_STORAGE.callsChannel}w1:u1`], undefined);
});

// Every key family the app keeps under NS is either carried at start, carried
// by its own reader (the outbox; Calls' channel), or new with no older form.
test('the carry-over list names every key family the app keeps on the phone', async () => {
  const { FAMILIES, OWN_CARRY, NEW_ONLY } = await import(SRC('oldStorage.js'));
  const files = [];
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (/\.(jsx?|mjs)$/.test(n)) files.push(p); } };
  walk(join(ROOT, 'web/src'));
  const used = new Set();
  for (const f of files) for (const [, k] of readFileSync(f, 'utf8').matchAll(/`\$\{NS\}([a-z][^`$]*)/g)) used.add(k);
  assert.ok(used.size > 20, [...used].join(' '));
  const all = [...FAMILIES.exact, ...FAMILIES.prefix, ...OWN_CARRY, ...NEW_ONLY];
  // `${NS}today:${…}` names a family by its start: every name it can take is listed.
  const covered = (k) => all.includes(k) || FAMILIES.prefix.some((p) => k.startsWith(p)) || (k.endsWith(':') && all.some((e) => e.startsWith(k)));
  assert.deepEqual([...used].filter((k) => !covered(k)), [], 'a key family nobody carries over');
});
