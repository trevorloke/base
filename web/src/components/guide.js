// The voter guide in the field app (VG decisions 27–31): one read, kept on
// this phone, and the small pieces Today, the door card, the walk list,
// GOTV's screen and "Where to vote" (pages/VoteInfo.jsx) share.
//
//   useGuide({ poll, side, draft })  GET /api/guide?rev= — the published
//            guide (no person in it). Kept for every role (KeptCopies
//            planFor 'guide'), so it opens with no signal. A read with the
//            same rev and links' tag answers { same: true } and only the
//            clock moves.
//            poll: read again every 5 minutes while the guide is live
//            (the day before, open, between) and when the app comes back
//            to the foreground. side: the screen doesn't draw it (the
//            strip's time). draft: the desk's "See it as a canvasser".
//   guideNow(g)          the server's clock, from this phone's (its offset)
//   useGuideClock(g)     { now, st } — re-drawn at the guide's next boundary
//   langOf(values)       a person's Language field → the guide's language
//   doorState(door, lang) the router state a door opens "Where to vote" with
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet } from '../api.js';
import { guideLangOf, guideState, nearVotingPlace } from '@base-win/shared/voteguide';

const FIVE_MIN = 5 * 60 * 1000;
const DAY = 24 * 3600 * 1000;
export const guideNow = (g) => Date.now() + (Number(g?.offset) || 0);

// Is the guide worth asking about again every few minutes?
export const guideLive = (g, now = guideNow(g)) => {
  if (!g || g.status === 'not_out' || !g.times) return false;
  const st = guideState(g.times, now, g.places);
  if (st.state === 'open' || st.state === 'between') return true;
  return st.state === 'before' && st.opensAt - now < DAY;
};

const fetchGuide = (qc, key, draft) => async () => {
  const prev = qc.getQueryData(key);
  const t0 = Date.now();
  // rev and the links' tag: a page published or a language approved since
  // changes the links without moving rev.
  const r = await apiGet(`/guide${draft ? '?draft=1' : Number.isFinite(prev?.rev) && prev?.tag ? `?rev=${prev.rev}&tag=${encodeURIComponent(prev.tag)}` : ''}`);
  // The server's clock, against this phone's (half the round trip in between).
  const offset = Number(r.now) - Math.round((t0 + Date.now()) / 2);
  if (r.same && prev) return { ...prev, now: r.now, offset };
  return { ...r, offset };
};

export function useGuide({ poll = false, side = false, draft = false, enabled = true } = {}) {
  const qc = useQueryClient();
  const key = draft ? ['guide', 'draft'] : ['guide'];
  return useQuery({
    queryKey: key,
    queryFn: fetchGuide(qc, key, draft),
    enabled,
    staleTime: FIVE_MIN,
    refetchOnWindowFocus: poll ? 'always' : false,
    refetchInterval: poll ? (q) => (guideLive(q.state.data) ? FIVE_MIN : false) : false,
    ...(side ? { meta: { side: true } } : {}),
  });
}

// The guide's state now, drawn again at its next boundary (a close, an
// opening, midnight) with the server's clock.
export function useGuideClock(g) {
  const [, tick] = useState(0);
  const now = guideNow(g);
  const st = g?.times ? guideState(g.times, now, g.places) : { state: 'not_out', boundary: null };
  useEffect(() => {
    if (!st.boundary) return undefined;
    const t = setTimeout(() => tick((n) => n + 1), Math.min(DAY, Math.max(500, st.boundary - now + 250)));
    return () => clearTimeout(t);
  }, [st.boundary, now]);
  return { now, st };
}

// The first voting day is within 14 days, or it's on (Today's row).
export const guideSoon = (g, now = guideNow(g)) => {
  const first = g?.times?.days?.[0];
  return Boolean(first && first.opensAt - now <= 14 * DAY);
};

// A person's Language field (Pick several) → the guide's language.
export const langOf = guideLangOf;
export const languageOf = (fieldsData) => langOf((fieldsData?.fields || []).find((f) => String(f.name).toLowerCase() === 'language')?.value);

const pinned = (d) => Number.isFinite(Number(d?.lat)) && Number.isFinite(Number(d?.lng)) && d?.lat !== null && d?.lng !== null;
// Router state only — never the address bar — so a reload, the service
// worker or a shared phone's history never carries the door.
export const doorState = (door, at, lang = 'en') => ({
  near: pinned(door) ? { lat: Number(door.lat), lng: Number(door.lng) } : null,
  at: at || null,
  lang,
});

// A door within 150 m of a voting place open now (the walk list's chip).
export const nearOpenPlace = (g, door, now = guideNow(g)) => {
  if (!g?.places || !pinned(door)) return null;
  const st = guideState(g.times, now, g.places);
  if (st.state !== 'open') return null;
  return nearVotingPlace(g.places, { lat: Number(door.lat), lng: Number(door.lng) }, now, 150);
};
