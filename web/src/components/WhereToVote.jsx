// "Where to vote" from a door (VG decision 29): the door card's and the
// walk-list door's More, and — while GOTV mode is on — a quiet link under
// the Voted row. It opens /vote-info with the door in router state only
// ({ near, at, lang }): no person id, nothing in the address bar. lang is
// the guide language from the person's Language field, read when tapped
// (a copy on the phone, or a short read; English when neither answers).
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { guideState } from '@starbase/shared/voteguide';
import { apiGet } from '../api.js';
import { doorState, guideNow, languageOf, useGuide } from './guide.js';
import '../pages/vote-guide.css';

const within = (p, ms) => Promise.race([p, new Promise((resolve) => { setTimeout(() => resolve(null), ms); })]);

export default function WhereToVote({ door, person, at, className = 'btn door-act' }) {
  const g = useGuide({ side: true }).data;
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  if (!g || g.status === 'not_out' || !g.times) return null;
  const st = guideState(g.times, guideNow(g), g.places);
  if (st.state === 'not_out' || st.state === 'over') return null;
  const open = async () => {
    setBusy(true);
    let lang = 'en';
    const id = person && !person.pending ? person.id : null;
    if (id) {
      const key = ['person', id, 'fields'];
      const have = qc.getQueryData(key)
        || await within(qc.fetchQuery({ queryKey: key, queryFn: () => apiGet(`/persons/${id}/fields`), staleTime: 30_000 }).catch(() => null), 1500);
      lang = languageOf(have);
    }
    setBusy(false);
    navigate('/vote-info', { state: doorState(door, at, lang) });
  };
  return (
    <button type="button" className={className} disabled={busy} onClick={open}>Where to vote</button>
  );
}
