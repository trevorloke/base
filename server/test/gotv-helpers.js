// Shared set-up for the live GOTV tests (gotv-*.test.js): one campaign with
// a manager, staff, a staff member given the Admin area, canvassers on two
// turfs, a scrutineer and a runner; the voter guide's days and two voting
// places through VG's own actions; and the one clock tests move
// (lib/clock.js, STARBASE_CLOCK_SHIFT_MS). Made-up people only.
import assert from 'node:assert/strict';
import { Client } from './helpers.js';
import { atLocal, localDay } from '../lib/tzrule.js';

export const TZ = 'America/Vancouver';
const DAY_MS = 86_400_000;
export const ok = (r, msg) => { assert.equal(r.status, 200, `${msg || ''} ${JSON.stringify(r.json)}`); return r.json; };
export const no = (r, status, words) => {
  assert.equal(r.status, status, JSON.stringify(r.json));
  if (words) assert.equal(r.json.error, words);
  return r.json;
};
export const square = (lat, lng, d = 0.001) => [[lat + d, lng - d], [lat + d, lng + d], [lat - d, lng + d], [lat - d, lng - d]];

// Days from the real today, in the campaign's day.
const realToday = () => localDay(Date.now(), TZ);
export const plus = (n) => localDay(atLocal(realToday(), '12:00', TZ) + n * DAY_MS, TZ);
// Move the clock to a campaign day and wall time.
export const at = (day, hm) => { process.env.STARBASE_CLOCK_SHIFT_MS = String(atLocal(day, hm, TZ) - Date.now()); };
export const clockBack = () => { delete process.env.STARBASE_CLOCK_SHIFT_MS; };

export const join = async (mgr, tag, role, name) => {
  const inv = await mgr.action('member.invite', { email: `gv-${name.split(' ')[0].toLowerCase()}+${tag}@example.org`, role });
  assert.equal(inv.status, 200, JSON.stringify(inv.json));
  const c = new Client();
  const j = await c.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name, password: 'gotv-day-2026' });
  assert.equal(j.status, 200, JSON.stringify(j.json));
  return { client: c, id: j.json.user.id, email: `gv-${name.split(' ')[0].toLowerCase()}+${tag}@example.org` };
};

// A1, A2: advance days; G: general voting day. Both places vote every day;
// Place One closes at 16:00 on G (its own hours), the guide's days at 20:00.
export const campaign = async (label) => {
  const tag = Math.random().toString(36).slice(2, 8);
  const mgr = new Client();
  const r = await mgr.signup({ workspaceName: `GOTV ${label} ${tag}`, email: `gv-mgr+${tag}@example.org`, jurisdiction: 'bc-municipal' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const ws = r.json.workspace.id;
  const staff = await join(mgr, tag, 'staff', 'Sam Example');
  const admin = await join(mgr, tag, 'staff', 'Ada Example');
  ok(await mgr.action('permission.member.set', { user_id: admin.id, grant: ['admin'], deny: [] }));
  const volA = await join(mgr, tag, 'volunteer', 'Ana Example');
  const volB = await join(mgr, tag, 'volunteer', 'Ben Example');
  const scrut = await join(mgr, tag, 'volunteer', 'Sid Example');
  const runner = await join(mgr, tag, 'volunteer', 'Rae Example');
  const A1 = plus(10); const A2 = plus(13); const G = plus(20);
  ok(await mgr.action('site.guide.days', { days: [
    { day: A1, kind: 'advance', opens: '08:00', closes: '20:00' },
    { day: A2, kind: 'advance', opens: '08:00', closes: '20:00' },
    { day: G, kind: 'general', opens: '08:00', closes: '20:00' },
  ] }));
  const p1 = ok(await mgr.action('site.guide.place.save', {
    name: `Place One ${tag}`, address: '100 Example Ave', lat: 49.15, lng: -122.8,
    days: [{ day: A1 }, { day: A2 }, { day: G, opens: '08:00', closes: '16:00' }],
  })).place.id;
  const p2 = ok(await mgr.action('site.guide.place.save', {
    name: `Place Two ${tag}`, address: '200 Example Ave', lat: 49.16, lng: -122.81,
    days: [{ day: A1 }, { day: A2 }, { day: G }],
  })).place.id;
  ok(await mgr.action('vote.settings', { advance_days: [A1, A2], election_day: G, auto: true }));
  // Turf A and turf B, each with a canvasser.
  const turfA = ok(await mgr.action('turf.create', { name: `Turf A ${tag}`, polygon: square(49.14, -122.84) })).turf.id;
  const turfB = ok(await mgr.action('turf.create', { name: `Turf B ${tag}`, polygon: square(49.24, -122.74) })).turf.id;
  ok(await mgr.action('turf.assign', { turf_id: turfA, user_id: volA.id }));
  ok(await mgr.action('turf.assign', { turf_id: turfB, user_id: volB.id }));
  const person = (name, extra) => mgr.createPerson(name, extra);
  const inA = await person('Harjit Singh', { address: '14012 72 Ave', house_number: '14012', lat: 49.14, lng: -122.84 });
  const inA2 = await person('Gurpreet Singh', { address: '14020 72 Ave', house_number: '14020', lat: 49.1401, lng: -122.8401 });
  const inB = await person('Bea Example', { address: '9000 152 St', house_number: '9000', lat: 49.24, lng: -122.74 });
  return { tag, ws, mgr, staff, admin, volA, volB, scrut, runner, A1, A2, G, p1, p2, turfA, turfB, inA, inA2, inB };
};

// Reads an SSE response until `until(events)` is true or ms pass.
export const readSSE = async (res, until, ms = 5000) => {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const events = [];
  const end = Date.now() + ms;
  try {
    while (Date.now() < end && !until(events, buf)) {
      const r = await Promise.race([reader.read(), new Promise((res2) => setTimeout(() => res2({ timeout: true }), Math.max(1, end - Date.now())))]);
      if (r.timeout) break;
      if (r.done) { events.push({ event: 'closed' }); break; }
      buf += dec.decode(r.value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        if (block.startsWith(':')) { events.push({ comment: block }); continue; }
        const ev = {};
        for (const line of block.split('\n')) {
          const k = line.slice(0, line.indexOf(':')); const v = line.slice(line.indexOf(':') + 1).trim();
          if (k === 'data') ev.data = JSON.parse(v); else ev[k] = v;
        }
        events.push(ev);
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return events;
};
