// "Where to vote" from a door (VG decision 29): the door card's and the
// walk-list door's More, and — while GOTV mode is on — a quiet link under
// the Voted row. It opens /vote-info with the door in router state only
// ({ near, at, lang }): no person id, nothing in the address bar, and no
// request about the person. lang is the guide language from the person's
// Language field: the walk list's row carries it (guide_lang), or a copy
// of their fields already on the phone; English when neither has it.
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { guideState } from '@base-win/shared/voteguide';
import { doorState, guideNow, languageOf, useGuide } from './guide.js';
import '../pages/vote-guide.css';

export default function WhereToVote({ door, person, at, className = 'btn door-act' }) {
  const g = useGuide({ side: true }).data;
  const qc = useQueryClient();
  const navigate = useNavigate();
  if (!g || g.status === 'not_out' || !g.times) return null;
  const st = guideState(g.times, guideNow(g), g.places);
  if (st.state === 'not_out' || st.state === 'over') return null;
  const open = () => {
    const fields = person && !person.pending ? qc.getQueryData(['person', person.id, 'fields']) : null;
    const lang = person?.guide_lang || (fields ? languageOf(fields) : 'en');
    navigate('/vote-info', { state: doorState(door, at, lang) });
  };
  return (
    <button type="button" className={className} onClick={open}>Where to vote</button>
  );
}
