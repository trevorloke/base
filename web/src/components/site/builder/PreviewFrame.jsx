// The live preview beside the builder (WA decisions 20–21): the draft's
// preview page (?edit=1) in a frame. Every change is posted to it at most
// every 100 ms and drawn there at once (web/src/site-preview.js), before the
// autosave. A section pointing at a petition the frame's data doesn't hold
// (needsReload) shows "Updating preview…" and the frame is drawn again by
// the server once the autosave lands. A tap on a box in the frame comes
// back as onPick(sectionId, field).
import { useEffect, useRef, useState } from 'react';
import { needsReload } from '@starbase/shared/site/components/context';

const EVERY_MS = 100;

export function PreviewFrame({ url, modules, size, focusId, savedN, onPick, title, full = false, onClose }) {
  const frame = useRef(null);
  const ready = useRef(false);
  const known = useRef(null); // the campaigns the frame's data holds
  const [key, setKey] = useState(0);
  const [updating, setUpdating] = useState(false);
  const latest = useRef(modules);
  latest.current = modules;
  const last = useRef(0);
  const timer = useRef(null);
  const src = url ? `${url}${url.includes('?') ? '&' : '?'}edit=1` : null;

  const post = (msg) => {
    const w = frame.current?.contentWindow;
    if (w && ready.current) w.postMessage(msg, window.location.origin);
  };
  const stale = (list) => Boolean(known.current) && needsReload(list, { campaigns: known.current.map((id) => ({ id })) });
  const send = () => {
    last.current = Date.now();
    if (stale(latest.current)) { setUpdating(true); return; }
    post({ type: 'wa:modules', modules: latest.current });
  };

  // Messages from the frame: only from it, only from this origin.
  useEffect(() => {
    const on = (e) => {
      if (e.source !== frame.current?.contentWindow || e.origin !== window.location.origin) return;
      const d = e.data || {};
      if (d.type === 'wa:ready') {
        ready.current = true;
        known.current = Array.isArray(d.campaigns) ? d.campaigns : [];
        send();
      } else if (d.type === 'wa:pick' && typeof d.section === 'string') {
        onPick?.(d.section, typeof d.field === 'string' ? d.field : null);
      }
    };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  // Typing: at most every 100 ms.
  useEffect(() => {
    clearTimeout(timer.current);
    const wait = Math.max(0, EVERY_MS - (Date.now() - last.current));
    timer.current = setTimeout(send, wait);
    return () => clearTimeout(timer.current);
  }, [modules]); // eslint-disable-line react-hooks/exhaustive-deps

  // The autosave landed: a frame waiting on the server is drawn again.
  useEffect(() => {
    if (!updating || !savedN) return;
    ready.current = false;
    setKey((k) => k + 1);
    setUpdating(false);
  }, [savedN]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (focusId) post({ type: 'wa:focus', section: focusId }); }, [focusId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={`wb-pv${full ? ' wb-pv--full' : ''}`} data-size={size}>
      {full && (
        <div className="wb-pv__bar">
          <p className="wb-help">Tap a headline, words or a picture to change it.</p>
          <button type="button" className="btn ops-tap" onClick={onClose}>Done</button>
        </div>
      )}
      <div className="wb-pv__box" aria-busy={updating ? 'true' : undefined}>
        {src ? (
          <iframe ref={frame} key={`${key}-${src}`} title={title} src={src} />
        ) : <p className="muted wb-pv__wait">Loading…</p>}
        {updating && <p className="wb-pv__updating" role="status">Updating preview…</p>}
      </div>
    </div>
  );
}
