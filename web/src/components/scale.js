// The campaign's rating scale on this phone: useScale() → the scale every
// rating word is made from (shared/scale.js: ratingByCode(scale, code),
// ratingText(scale, code), …). The words on the buttons and the "Voting for?"
// list are the campaign's own (a manager's Rating scale screen).
//
// The field needs it with no signal, so the last one read is kept on the
// phone with the signed-in user's other copies (OfflineCache.js's key
// space: sign-out forgets it, another sign-in drops it). It never goes
// stale on its own: an old list beats the default list. The signed-in
// user's own workspace (['me'], itself kept for an offline start, and read
// on every screen) carries the scale as last saved too: whichever of the
// two is newer (a save bumps the version) is the one the buttons show — so
// a phone that opened only Today or Shifts since a change still has it.
// With neither — a campaign that has saved no scale, on a phone that hasn't
// read it yet — the list its server starts with, which the sign-in names
// (me.org.candidates: nobody, for a campaign with no opponents).
// That list is also this phone's starting list (registerStart below): the
// app's own code holds the four steps and nobody, the same for every
// campaign, so each starting candidate's label is the one its server sent.
import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CANDIDATE_CODE_RE, cleanWord, defaultScale, normalizeScale, onServer, presetCandidates } from '@base-win/shared/scale';
import { apiGet } from '../api.js';
import { NS } from '../base.js';

// OfflineCache.js's prefix and scope, so forgetPhoneCopies() / keepOnlyMine()
// clear this one with the rest.
const PREFIX = `${NS}copy:v1:`;
const keyFor = (me) => (me?.user?.id && me?.workspace?.id ? `${PREFIX}${me.workspace.id}:${me.user.id}:scale` : null);
const ls = () => { try { return globalThis.localStorage || null; } catch { return null; } };

const readKept = (key) => {
  if (!key) return undefined;
  try {
    const v = JSON.parse(ls()?.getItem(key) || 'null');
    return v?.data?.scale ? v.data : undefined;
  } catch { return undefined; }
};
// Every RatingChip on a list reads the scale: write each answer once.
let kept = '';
const keep = (key, data, at) => {
  if (!key || kept === `${key}@${at}`) return;
  kept = `${key}@${at}`;
  try { ls()?.setItem(key, JSON.stringify({ at, data })); } catch { /* storage full or blocked */ }
};

// One normalized scale per answer, however many buttons read it.
let made = new WeakMap();
// The campaign's starting list, as its server named it at sign-in, told to
// shared/scale.js once per list (a sign-in kept from before the server sent
// labels has none: those read "Opposed — name" until it is read again).
let started = null;
let startedFrom = null;
export const registerStart = (me) => {
  // Under Node (the tests run this file beside the server) the starting list
  // is the server's own; only a browser is told it by the sign-in.
  if (onServer) return;
  const sent = me?.org?.candidates;
  // Every rating chip on screen asks: the same list again costs nothing.
  if (!Array.isArray(sent) || sent === startedFrom) return;
  startedFrom = sent;
  const as = JSON.stringify(sent);
  if (as === started) return;
  started = as;
  const list = Object.freeze(sent
    .filter((c) => c && CANDIDATE_CODE_RE.test(String(c.code || '')) && cleanWord(c.name))
    .map((c) => ({ code: String(c.code), name: cleanWord(c.name), ...(cleanWord(c.label) ? { label: cleanWord(c.label) } : {}) })));
  presetCandidates(() => list);
  made = new WeakMap(); // anything worked out from another list is stale
};
const scaleFrom = (data) => {
  if (!data?.scale) return defaultScale();
  let s = made.get(data);
  if (!s) { s = normalizeScale(data.scale); made.set(data, s); }
  return s;
};

export const SCALE_KEY = ['scale'];

// { scale } answers → the newer one (a higher version); a tie keeps the first.
const versionOf = (data) => (data?.scale ? scaleFrom(data).version : -1);
export const newerScale = (a, b) => (versionOf(b) > versionOf(a) ? b : a ?? b);
// The scale ['me'] carries, as an answer — one per sign-in copy: the scale
// as last saved, or for a campaign that has saved none, the candidates its
// server starts with (version 0: anything read from the server wins).
const fromMe = new WeakMap();
export const meScale = (me) => {
  registerStart(me);
  const saved = me?.workspace?.settings?.scale;
  const raw = saved && typeof saved === 'object' ? saved : Array.isArray(me?.org?.candidates) ? me.org.candidates : null;
  if (!raw) return undefined;
  let d = fromMe.get(raw);
  if (!d) { d = { scale: Array.isArray(raw) ? { candidates: raw } : raw }; fromMe.set(raw, d); }
  return d;
};

export function useScale() {
  const qc = useQueryClient();
  const me = qc.getQueryData(['me']);
  registerStart(me);
  const key = keyFor(me);
  const q = useQuery({
    queryKey: SCALE_KEY,
    queryFn: () => apiGet('/scale'),
    enabled: Boolean(me?.user?.id),
    // Asked again when a rating screen opens a minute or more later.
    staleTime: 60_000,
    initialData: () => newerScale(readKept(key), meScale(me)),
    // What's kept is checked with the server as soon as there's signal.
    initialDataUpdatedAt: 0,
  });
  const { data, dataUpdatedAt, status } = q;
  useEffect(() => {
    if (status === 'success' && dataUpdatedAt > 0 && data?.scale) keep(key, data, dataUpdatedAt);
  }, [key, status, data, dataUpdatedAt]);
  return scaleFrom(newerScale(data, meScale(me)));
}
