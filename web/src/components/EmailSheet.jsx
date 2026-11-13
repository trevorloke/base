// Email from your own Gmail, on a person's page (desk; ext/gmail):
//
//   useGmail(enabled)    GET /api/gmail (a 403 — a volunteer, or staff
//                        denied Outreach — is an answer, never retried)
//   gmailReady(d)        Gmail on here and this person's connection fine
//   gmailNotReadyLine(d) the one muted line under the tiles when Gmail is
//                        on but not ready for me, else null
//   EmailSheet           "Email Jane Doe": Subject, Message, Send
//   takeDraft(id)        a draft kept for the connect round trip
//
// A Gmail send is never put in the outbox: it would go later on a stale
// decision about whether they may be emailed. The draft lives in the open
// sheet and, only while Google's connect page is open, in this tab's
// sessionStorage.
import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { action, apiGet } from '../api.js';
import { newClientId } from '../offline.js';
import { NeedsSignal, useOnline } from './NoSignal.jsx';
import GoogleConnect from './GoogleConnect.jsx';
import { clockTime, herePath } from './google.js';
import './gmail.css';

export const useGmail = (enabled = true) => useQuery({
  queryKey: ['gmail'], queryFn: () => apiGet('/gmail'), enabled,
  retry: (n, err) => err?.status !== 403 && n < 2,
});

// One short line at the foot of the screen ("Sent from your Gmail"), then gone.
export function useToast() {
  const [msg, setMsg] = useState(null);
  const timer = useRef(null);
  const show = (text, ms = 3500) => { clearTimeout(timer.current); setMsg(text); timer.current = setTimeout(() => setMsg(null), ms); };
  useEffect(() => () => clearTimeout(timer.current), []);
  return { msg, show };
}

export const gmailReady = (d) => Boolean(d?.setup && d.on && d.me?.ok && !d.apiOff);

export function gmailNotReadyLine(d) {
  if (!d?.setup || !d.on || gmailReady(d) || d.apiOff) return null;
  if (d.me?.trouble === 'paused' && d.me.pausedUntil) return <>Gmail asked us to wait until {clockTime(d.me.pausedUntil)}</>;
  return <>Gmail needs connecting — <Link to="/profile">Your profile</Link></>;
}

// mailto: with what was written, for "Open in my mail app instead".
export const mailtoHref = (to, subject = '', body = '') => {
  const q = [subject && `subject=${encodeURIComponent(subject)}`, body && `body=${encodeURIComponent(body)}`].filter(Boolean).join('&');
  return `mailto:${to}${q ? `?${q}` : ''}`;
};

const draftKey = (id) => `gmail-draft:${id}`;
const saveDraft = (id, d) => { try { sessionStorage.setItem(draftKey(id), JSON.stringify(d)); } catch { /* private mode: lost on return */ } };
export const clearDraft = (id) => { try { sessionStorage.removeItem(draftKey(id)); } catch { /* nothing kept */ } };
export const takeDraft = (id) => {
  try {
    const d = JSON.parse(sessionStorage.getItem(draftKey(id)) || 'null');
    return d && typeof d.subject === 'string' && typeof d.body === 'string' ? d : null;
  } catch { return null; }
};

// A refusal before anything was asked of Gmail that a connect fixes.
const needsConnect = (e) => e?.status === 409 && /^(Connect your Gmail|Gmail needs connecting)/.test(e.message || '');

export default function EmailSheet({ person, gmail, draft, onClose, onSent }) {
  const qc = useQueryClient();
  const online = useOnline();
  const id = useId();
  const [subject, setSubject] = useState(draft?.subject || '');
  const [body, setBody] = useState(draft?.body || '');
  // Made when the sheet opens: a double tap, or a retry of a lost answer, is one send.
  const [key, setKey] = useState(newClientId);
  const [busy, setBusy] = useState(false);
  // { kind: 'unsure' | 'reconnect' | 'said', said }
  const [res, setRes] = useState(null);
  const [again, setAgain] = useState(false);
  // The draft was only for the connect round trip: gone once the sheet has it.
  useEffect(() => { clearDraft(person.id); }, [person.id]);

  const from = gmail?.me?.email;
  const filled = subject.trim() && body.trim();
  const close = () => { clearDraft(person.id); onClose(); };

  const send = async (k = key) => {
    if (!filled || busy) return;
    setBusy(true); setRes(null); setAgain(false);
    try {
      const r = await action('gmail.send', { person_id: person.id, subject: subject.trim(), body, client_key: k });
      if (r.status === 'sent') {
        clearDraft(person.id);
        onSent();
      } else if (r.status === 'unsure' || r.status === 'sending') {
        setRes({ kind: 'unsure', said: r.said || 'Not sure it went — check your Gmail’s Sent folder before sending again.' });
      } else if (r.code === 'reconnect' || r.code === 'connect') {
        setRes({ kind: 'reconnect', said: r.said });
      } else {
        setRes({ kind: 'said', said: r.said || 'Gmail didn’t send it' });
      }
    } catch (e) {
      setRes({ kind: needsConnect(e) ? 'reconnect' : 'said', said: e.message });
    } finally {
      setBusy(false);
      qc.invalidateQueries({ queryKey: ['gmail'] });
      qc.invalidateQueries({ queryKey: ['person', person.id, 'timeline'] });
    }
  };
  const sendAgain = () => { const k = newClientId(); setKey(k); send(k); };

  return (
    <section className="card gm-sheet" aria-labelledby={`${id}-h`}>
      <div className="gm-sheet__head">
        <h2 className="gm-sheet__title" id={`${id}-h`}>Email {person.name}</h2>
        <button type="button" className="btn btn-quiet gm-close" onClick={close} aria-label="Close">✕</button>
      </div>
      <p className="gm-line">From: <strong>{from}</strong> · your Gmail</p>
      <p className="gm-line">To: <strong>{person.email}</strong></p>
      <form onSubmit={(e) => { e.preventDefault(); send(); }}>
        <div className="field">
          <label htmlFor={`${id}-s`}>Subject</label>
          <input id={`${id}-s`} className="input" required maxLength={200} value={subject} autoFocus
            onChange={(e) => setSubject(e.target.value.replace(/[\r\n]+/g, ' '))} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-b`}>Message</label>
          <textarea id={`${id}-b`} className="input gm-body" required rows={8} maxLength={10000} value={body}
            onChange={(e) => setBody(e.target.value)} />
        </div>
        <div aria-live="polite">
          {res?.kind === 'said' && <p className="error" role="alert">{res.said}</p>}
          {res?.kind === 'unsure' && (
            <div className="gm-said">
              <p role="alert">{res.said}</p>
              {again ? (
                <div className="gm-confirm" role="group" aria-label="Send again">
                  <span>Send again? It may arrive twice.</span>
                  <button type="button" className="btn btn-quiet" disabled={busy || !online} onClick={sendAgain}>Send</button>
                  <button type="button" className="btn btn-quiet" onClick={() => setAgain(false)}>Cancel</button>
                </div>
              ) : (
                <button type="button" className="btn btn-quiet" disabled={busy || !online} onClick={() => setAgain(true)}>Send again</button>
              )}
            </div>
          )}
          {res?.kind === 'reconnect' && (
            <div className="gm-said">
              <p role="alert">{res.said}</p>
              {/* Kept for the trip to Google and back: this page reopens the sheet with it. */}
              <div onClickCapture={() => saveDraft(person.id, { subject, body })}>
                <GoogleConnect purpose="gmail.send" label="Connect again" back={herePath()} />
              </div>
            </div>
          )}
        </div>
        <div className="gm-acts">
          <button type="submit" className="btn btn-primary gm-send" disabled={busy || !online || !filled || res?.kind === 'unsure'}>
            {busy ? 'Sending…' : 'Send'}
          </button>
          <button type="button" className="btn btn-quiet" onClick={close}>Cancel</button>
          {!online && <NeedsSignal />}
        </div>
        <details className="gm-more">
          <summary>More</summary>
          <a className="btn btn-quiet" href={mailtoHref(person.email, subject, body)} onClick={() => { clearDraft(person.id); onClose('mailto'); }}>
            Open in my mail app instead
          </a>
        </details>
      </form>
    </section>
  );
}
