// ScriptLine — what to say, filled in for the person in front of you.
//   <ScriptLine context="door"|"phone" person />
// The campaign's script for the door or the phone (GET /api/scripts —
// ext/scripts; kept on the phone, so it shows with no signal), with
// {{first_name}}, {{my_name}} and {{campaign}} filled in. A quiet "Script"
// line that opens to the words; open or shut stays as the canvasser left it
// on this device. Nothing when the desk hasn't written one.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { apiGet } from '../api.js';
import { fillTemplate } from './TextingWords.js';
import './script-line.css';

const KEY = 'sb:script-open';
const readOpen = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } };

export const useScripts = () => useQuery({ queryKey: ['scripts'], queryFn: () => apiGet('/scripts'), staleTime: 5 * 60_000, meta: { side: true } });

export default function ScriptLine({ context, person }) {
  const { me } = useOutletContext() ?? {};
  const q = useScripts();
  const [open, setOpen] = useState(() => Boolean(readOpen()[context]));
  const script = q.data?.[context];
  if (!script?.body) return null;
  const toggle = () => {
    const next = !open;
    setOpen(next);
    try { localStorage.setItem(KEY, JSON.stringify({ ...readOpen(), [context]: next })); } catch { /* a per-device nicety */ }
  };
  return (
    <div className="sl">
      <button type="button" className="btn btn-quiet disclose disclose--inline sl-btn" aria-expanded={open} onClick={toggle}>Script</button>
      {open && <p className="sl-words">{fillTemplate(script.body, { person, me })}</p>}
    </div>
  );
}
