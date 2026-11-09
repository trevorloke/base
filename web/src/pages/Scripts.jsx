// /scripts (desk, the outreach area): what to say at the door and on the
// phone. Each is a box with "+ First name", "+ Your name", "+ Campaign"
// (they fill in for whoever's in front of the canvasser) and a preview for a
// made-up voter; Save. Empty takes the script away. Canvassers see it as
// "Script" above the rating buttons (components/ScriptLine.jsx).
import { useEffect, useRef, useState } from 'react';
import { useCaret } from '../components/useCaret.js';
import { Link, useOutletContext } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { action } from '../api.js';
import { NoSignal, noSignal, useOnline } from '../components/NoSignal.jsx';
import { useScripts } from '../components/ScriptLine.jsx';
import { fillTemplate } from '../components/TextingWords.js';
import './shifts.css';
import '../components/script-line.css';

const INSERTS = [['{{first_name}}', '+ First name'], ['{{my_name}}', '+ Your name'], ['{{campaign}}', '+ Campaign']];
const SAMPLE = { name: 'Sam Sample' };

function ScriptBox({ context, title, help, current, me }) {
  const queryClient = useQueryClient();
  const online = useOnline();
  const [body, setBody] = useState(current || '');
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState(null);
  const ref = useRef(null);
  useEffect(() => { setBody(current || ''); }, [current]);
  const putCaret = useCaret();
  const insert = (t) => {
    const el = ref.current;
    const at = el ? el.selectionStart : body.length;
    const end = el ? el.selectionEnd : body.length;
    const next = `${body.slice(0, at)}${t}${body.slice(end)}`;
    setBody(next);
    putCaret(el, at + t.length);
  };
  const save = async (e) => {
    e.preventDefault();
    setBusy(true); setSaid(null);
    try {
      const r = await action('script.save', { context, body });
      setSaid(r.script ? '✓ Saved' : '✓ Taken away');
      queryClient.invalidateQueries({ queryKey: ['scripts'] });
    } catch (err) { setSaid(err.message); }
    setBusy(false);
  };
  const id = `sc-${context}`;
  return (
    <form className="ops-card sc-box" onSubmit={save} aria-label={title}>
      <h2 className="sc-h">{title}</h2>
      <p className="ops-meta">{help}</p>
      <div className="field">
        <label htmlFor={id}>What to say</label>
        <textarea id={id} ref={ref} className="input sc-text" rows={6} maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)} />
      </div>
      <div className="sc-inserts">
        {INSERTS.map(([t, l]) => <button key={t} type="button" className="btn btn-quiet ops-tap" onClick={() => insert(t)}>{l}</button>)}
      </div>
      {body.trim() && (
        <div className="sc-preview">
          <span className="eyebrow">How it reads at {SAMPLE.name}’s</span>
          <p className="sl-words">{fillTemplate(body, { person: SAMPLE, me })}</p>
        </div>
      )}
      <div className="sc-acts">
        <button type="submit" className="btn ops-solid ops-tap" disabled={busy || !online || body.trim() === (current || '').trim()}>Save</button>
        {said && <span className="ops-meta" role="status">{said}</span>}
      </div>
    </form>
  );
}

export default function Scripts() {
  const { me } = useOutletContext();
  const q = useScripts();
  if (q.isError) return noSignal(q.error) ? <NoSignal /> : <p className="error">{q.error.message}</p>;
  return (
    <div className="ops-page sc-page">
      <Link className="ops-back" to="/">← Today</Link>
      <div className="ops-head"><h1>Scripts</h1></div>
      <p className="ops-meta">Canvassers and callers see the script as <strong>Script</strong> above the rating buttons, with the person’s name filled in. It works with no signal.</p>
      {q.isLoading ? <p className="muted">Loading…</p> : (
        <>
          <ScriptBox context="door" title="At the door" help="On the walk list and the map’s door card." current={q.data?.door?.body} me={me} />
          <ScriptBox context="phone" title="On the phone" help="On the Calls card (a phone bank’s own script takes its place there)." current={q.data?.phone?.body} me={me} />
          <h2 className="sc-group">Get out the vote</h2>
          <p className="ops-meta">Said instead while GOTV mode is on (advance-voting days and election day — Today → More → GOTV). Leave one empty and the usual script stays.</p>
          <ScriptBox context="gotv_door" title="At the door — GOTV" help="Who has voted, where and when to vote, a ride if they need one." current={q.data?.gotv_door?.body} me={me} />
          <ScriptBox context="gotv_phone" title="On the phone — GOTV" help="On the Calls card while GOTV mode is on." current={q.data?.gotv_phone?.body} me={me} />
        </>
      )}
    </div>
  );
}
