// "Saved on this phone" ("this device" off a phone) — opened from the
// strip's chip (Shell.jsx). One row per thing the outbox (src/offline.js)
// still holds, in the order it will send: "Knock · Maya Chen · 2:14 pm",
// "New person · Ana Souza · 2:16 pm". Refused ones (the server said no on a
// replay) stay listed with the reason in plain words (refusedText) and Try
// again / Dismiss — never dropped without a word.
// Send now (quiet, never yellow) when there's signal; offline, one line says
// when it goes. Bottom sheet on phones, a panel under the strip on desks.
import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { itemText, refusedText } from '../offline.js';
import { LETTER_ITEMS, backToDraft, copyText, dropQueued, letterTextOf } from './letterDrafts.js';
import { useThisDevice } from './queued.js';
import './OfflineSheet.css';

export default function OfflineSheet({ outbox, online, nameOf, onSend, onRetry, onDismiss, onClose }) {
  const titleId = useId();
  const device = useThisDevice();
  const closeRef = useRef(null);
  useEffect(() => { closeRef.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const waiting = outbox.items.filter((i) => i.state === 'pending');
  const refused = outbox.items.filter((i) => i.state === 'refused');

  return (
    <>
      <button type="button" className="obx-scrim" aria-label="Close" tabIndex={-1} onClick={onClose} />
      <div className="obx-sheet" role="dialog" aria-labelledby={titleId}>
        <header className="obx-head">
          <h2 className="obx-title" id={titleId}>Saved on {device}</h2>
          <button type="button" ref={closeRef} className="btn btn-quiet obx-x" aria-label="Close" onClick={onClose}>✕</button>
        </header>

        {waiting.length > 0 && (
          <ul className="obx-list" aria-label="Not sent yet">
            {waiting.map((i) => <li key={i.cid} className="obx-row"><span className="obx-what">{itemText(i, nameOf)}</span></li>)}
          </ul>
        )}

        {refused.length > 0 && (
          <>
            <h3 className="eyebrow obx-sub">Refused</h3>
            <ul className="obx-list" aria-label="Refused">
              {refused.map((i) => (
                <li key={i.cid} className="obx-row is-refused">
                  <span className="obx-what">{itemText(i, nameOf)}</span>
                  <span className="obx-why">{refusedText(i)}</span>
                  {LETTER_ITEMS.includes(i.name) ? <LetterButtons item={i} onDismiss={onDismiss} onClose={onClose} /> : (
                    <span className="obx-btns">
                      <button type="button" className="btn obx-btn" disabled={!online || outbox.flushing} onClick={() => onRetry(i.cid)}>Try again</button>
                      <button type="button" className="btn btn-quiet obx-btn" onClick={() => onDismiss(i.cid)}>Dismiss</button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}

        {waiting.length > 0 && (
          <footer className="obx-foot">
            {online ? (
              <button type="button" className="btn obx-btn obx-send" onClick={onSend} disabled={outbox.flushing}>
                {outbox.flushing ? 'Sending…' : 'Send now'}
              </button>
            ) : (
              <p className="obx-hint">Sends when you’re back online</p>
            )}
          </footer>
        )}
      </div>
    </>
  );
}

// A refused letter (pages/Letters.jsx): its text is never lost. Copy it, or
// put it back where it was typed; Dismiss drops it only after a confirm.
function LetterButtons({ item, onDismiss, onClose }) {
  const navigate = useNavigate();
  const [said, setSaid] = useState(null);
  const [dropping, setDropping] = useState(false);
  const copy = async () => setSaid(await copyText(letterTextOf(item)) ? 'Copied' : 'Couldn’t copy — use Back to draft');
  const back = () => {
    const to = backToDraft(item);
    onDismiss(item.cid);
    onClose();
    if (to) navigate(to);
  };
  if (dropping) {
    return (
      <span className="obx-btns" role="group" aria-label="Drop this letter’s text">
        <span className="obx-why">Drop this letter’s text?</span>
        <button type="button" className="btn obx-btn" onClick={() => { dropQueued(item); onDismiss(item.cid); }}>Yes</button>
        <button type="button" className="btn btn-quiet obx-btn" onClick={() => setDropping(false)}>No</button>
      </span>
    );
  }
  return (
    <span className="obx-btns">
      <button type="button" className="btn obx-btn" onClick={copy}>Copy text</button>
      <button type="button" className="btn obx-btn" onClick={back}>Back to draft</button>
      <button type="button" className="btn btn-quiet obx-btn" onClick={() => setDropping(true)}>Dismiss</button>
      <span className="obx-why" role="status" aria-live="polite">{said || ''}</span>
    </span>
  );
}
