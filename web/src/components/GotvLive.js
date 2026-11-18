// The live list on voting days (ext/voted live.js): one connection per
// browser, held in the Shell by useGotvLive().
//
//   - EventSource('/api/voted/live') only while GOTV is active for this
//     person (status.active), they aren't scrutineer-only, and the tab is
//     visible. One tab holds it (navigator.locks); the others hear it over
//     BroadcastChannel('gotv-live').
//   - A real change ({ p, v, x: 0 }) is written into the screens' copies in
//     place (LIVE_KEYS), never a list refetch.
//   - A practice change (x: 1) never touches voted_at anywhere: it goes into
//     one overlay in memory (practiceOverlay), read at render like the
//     outbox's own marks, and cleared the moment practice ends.
//   - Catch-up: /voted/changes?since= on open, on coming back to the tab and
//     on signal; { reload } refetches the lists. After 2 failed connects in
//     a minute it polls every 20 s and tries the stream again every 2 min.
//   - `mode` replaces ['voted','status']; `guide` refetches the voter guide.
//
//   useLiveChip()       "Live" | "Updated 3 min ago" | null, for the walk
//                       list and Calls
//   usePracticeOverlay() the practice marks: Map(personId → time | null)
import { useEffect, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiGet } from '../api.js';
import { at } from '../base.js';

// The screens' copies a change is written into (MAP's ['doors', 'mine']
// is under ['doors']).
export const LIVE_KEYS = [['turf'], ['doors'], ['persons'], ['person'], ['voted', 'persons']];
const POLL_MS = 20_000;
const RETRY_STREAM_MS = 120_000;
const COUNTS_MS = 30_000;

// ── A tiny store for the chip and the practice overlay ──
const state = { conn: 'off', at: 0, practice: new Map(), left: 0 };
const subs = new Set();
const changed = () => { for (const fn of subs) fn(); };
const sub = (fn) => { subs.add(fn); return () => subs.delete(fn); };
let snapChip = { conn: 'off', at: 0 };
const chipSnap = () => {
  if (snapChip.conn !== state.conn || snapChip.at !== state.at) snapChip = { conn: state.conn, at: state.at };
  return snapChip;
};
let practiceSnap = state.practice;
const setConn = (conn) => { state.conn = conn; if (conn === 'live') state.at = Date.now(); changed(); };

export function usePracticeOverlay() {
  return useSyncExternalStore(sub, () => practiceSnap, () => practiceSnap);
}
export const clearPractice = () => {
  if (!state.practice.size) return false;
  state.practice = new Map();
  practiceSnap = state.practice;
  changed();
  return true;
};
const putPractice = (list) => {
  const next = new Map(state.practice);
  for (const c of list) next.set(c.p, c.v || null);
  state.practice = next;
  practiceSnap = next;
  changed();
};

const ago = (ms) => {
  const m = Math.max(1, Math.round((Date.now() - ms) / 60_000));
  return m >= 60 ? `Updated ${Math.round(m / 60)} h ago` : `Updated ${m} min ago`;
};
// The chip's words: "Live", "Updated 3 min ago", or null while GOTV is off.
export function useLiveChip() {
  const c = useSyncExternalStore(sub, chipSnap, chipSnap);
  if (c.conn === 'off') return null;
  if (c.conn === 'live') return { text: 'Live', live: true };
  return { text: c.at ? ago(c.at) : 'Updated —', live: false };
}

// ── Writing a change into the copies ──
const patchPerson = (p, byId) => (p && byId.has(p.id) ? { ...p, voted_at: byId.get(p.id) } : p);
const patchList = (list, byId) => {
  if (!Array.isArray(list)) return list;
  let hit = false;
  const out = list.map((p) => { const q = patchPerson(p, byId); if (q !== p) hit = true; return q; });
  return hit ? out : list;
};
export function applyChanges(queryClient, changes) {
  const real = changes.filter((c) => !c.x);
  if (!real.length) return 0;
  const byId = new Map(real.map((c) => [c.p, c.v || null]));
  queryClient.setQueriesData({ queryKey: ['turf'] }, (d) => {
    if (!d?.doors) return d;
    let hit = false;
    const doors = d.doors.map((door) => { const ps = patchList(door.persons, byId); if (ps !== door.persons) { hit = true; return { ...door, persons: ps }; } return door; });
    return hit ? { ...d, doors } : d;
  });
  queryClient.setQueriesData({ queryKey: ['doors'] }, (d) => {
    if (!d?.persons) return d;
    const persons = patchList(d.persons, byId);
    return persons === d.persons ? d : { ...d, persons };
  });
  queryClient.setQueriesData({ queryKey: ['persons'] }, (d) => {
    if (!d?.persons) return d;
    const persons = patchList(d.persons, byId);
    return persons === d.persons ? d : { ...d, persons };
  });
  queryClient.setQueriesData({ queryKey: ['person'] }, (d) => {
    const p = d?.person;
    if (!p || !byId.has(p.id) || p.voted_hidden) return d;
    return { ...d, person: { ...p, voted_at: byId.get(p.id) } };
  });
  for (const [k, v] of byId) {
    queryClient.setQueryData(['voted', 'persons', k], (d) => (d ? { ...d, voted_at: v } : d));
  }
  return real.length;
}

const invalidateLists = (queryClient) => {
  for (const queryKey of LIVE_KEYS) queryClient.invalidateQueries({ queryKey });
  queryClient.invalidateQueries({ queryKey: ['brief'] });
};

// ── The hook (Shell) ──
const scrutineerOnlyOf = (s) => s?.stream === false;
export function useGotvLive(status, me) {
  const queryClient = useQueryClient();
  const active = Boolean(status?.active);
  const practice = Boolean(status?.practice) && active;
  // Leaving practice (any status saying so): the overlay goes, and every
  // list reads the record again (and so do the copies kept on the phone).
  useEffect(() => {
    if (!practice && clearPractice()) invalidateLists(queryClient);
  }, [practice, queryClient]);

  const userId = me?.user?.id;
  useEffect(() => {
    if (!active || !userId || scrutineerOnlyOf(status) || typeof window === 'undefined') { setConn('off'); return undefined; }
    let es = null;
    let stopped = false;
    let last = Number(status?.feed) || 0;
    let fails = [];
    let pollT = null;
    let retryT = null;
    let lastCounts = 0;
    let release = null;
    const bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('gotv-live') : null;

    const countsSoon = () => {
      if (Date.now() - lastCounts < COUNTS_MS) return;
      lastCounts = Date.now();
      queryClient.invalidateQueries({ queryKey: ['brief'] });
      queryClient.invalidateQueries({ queryKey: ['voted', 'summary'] });
    };
    const take = (changes, from) => {
      const practiceOnes = changes.filter((c) => c.x);
      if (practiceOnes.length) putPractice(practiceOnes);
      if (applyChanges(queryClient, changes)) countsSoon();
      if (from !== 'bc') bc?.postMessage({ t: 'voted', changes, last });
    };
    const onMode = (s, from) => {
      queryClient.setQueryData(['voted', 'status'], (d) => ({ ...(d || {}), ...s }));
      if (!s.practice || !s.active) { if (clearPractice()) invalidateLists(queryClient); }
      if (from !== 'bc') bc?.postMessage({ t: 'mode', s });
    };
    const onGuide = (from) => {
      queryClient.invalidateQueries({ queryKey: ['guide'] });
      if (from !== 'bc') bc?.postMessage({ t: 'guide' });
    };
    const catchUp = async () => {
      try {
        const r = await apiGet(`/voted/changes?since=${last}`);
        if (stopped) return;
        if (r.reload) invalidateLists(queryClient);
        else if (r.changes?.length) take(r.changes);
        last = Math.max(last, Number(r.last) || 0);
        if (state.conn !== 'live') { state.at = Date.now(); changed(); }
      } catch { /* the next try catches up */ }
    };
    const startPolling = () => {
      setConn('poll');
      clearInterval(pollT);
      pollT = setInterval(() => { if (document.visibilityState === 'visible') catchUp(); }, POLL_MS);
      clearTimeout(retryT);
      retryT = setTimeout(() => { fails = []; clearInterval(pollT); pollT = null; open(); }, RETRY_STREAM_MS);
    };
    const open = () => {
      if (stopped || es || document.visibilityState !== 'visible') return;
      es = new EventSource(at('/api/voted/live'), { withCredentials: true });
      es.onopen = () => { setConn('live'); catchUp(); };
      es.addEventListener('voted', (e) => {
        try { const list = JSON.parse(e.data); last = Math.max(last, Number(e.lastEventId) || 0); take(list); setConn('live'); } catch { /* a bad message */ }
      });
      es.addEventListener('reload', (e) => { last = Math.max(last, Number(e.lastEventId) || 0); invalidateLists(queryClient); });
      es.addEventListener('mode', (e) => { try { onMode(JSON.parse(e.data)); } catch { /* */ } });
      es.addEventListener('guide', () => onGuide());
      es.onerror = () => {
        // The stream ended (GOTV off, a deploy, no signal): the browser would
        // retry on its own; we count it and fall back to polling instead.
        es?.close();
        es = null;
        if (stopped) return;
        fails = [...fails.filter((t) => Date.now() - t < 60_000), Date.now()];
        if (state.conn === 'live') setConn('poll');
        if (fails.length >= 2) startPolling();
        else setTimeout(open, 3000);
      };
    };
    const close = () => { es?.close(); es = null; clearInterval(pollT); pollT = null; clearTimeout(retryT); };
    const onVisible = () => {
      if (document.visibilityState === 'visible') { catchUp(); if (!es && !pollT) open(); }
      else { es?.close(); es = null; }
    };
    const onOnline = () => { catchUp(); if (!es && !pollT) open(); };

    // One tab holds the stream; the others listen.
    if (bc) {
      bc.onmessage = (e) => {
        const m = e.data || {};
        if (m.t === 'voted') { last = Math.max(last, Number(m.last) || 0); take(m.changes || [], 'bc'); if (state.conn === 'off') setConn('live'); }
        else if (m.t === 'mode') onMode(m.s, 'bc');
        else if (m.t === 'guide') onGuide('bc');
      };
    }
    const start = () => {
      setConn('poll');
      catchUp();
      open();
      document.addEventListener('visibilitychange', onVisible);
      window.addEventListener('online', onOnline);
    };
    const locks = globalThis.navigator?.locks;
    if (locks?.request) {
      locks.request(`gotv-live:${userId}`, () => new Promise((res) => { release = res; if (!stopped) start(); else res(); }))
        .catch(() => { if (!stopped) start(); });
      // Waiting for another tab's lock: say it's live (that tab shares).
      setConn('poll');
    } else start();

    return () => {
      stopped = true;
      close();
      release?.();
      bc?.close();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      setConn('off');
    };
    // The connection is about who and whether: not each status read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, userId, queryClient, scrutineerOnlyOf(status)]);
}
