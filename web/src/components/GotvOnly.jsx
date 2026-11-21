// The app for an election-day sign-in code (a session limited to Who voted,
// server/lib/auth.js scopeAllows): Who voted and Sign out, nothing else —
// every other read would be refused, so no other screen is drawn.
import { Suspense, useCallback, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { apiPost } from '../api.js';
import { setOutboxOwner, useOutboxAutoFlush, unsentCount, clearOutbox, closeOutbox } from '../offline.js';
import { gotvNoteCount, clearGotvNotes } from './gotvNotes.js';
import { useGotvLive } from './GotvLive.js';

export default function GotvOnly({ me, screen: Screen }) {
  setOutboxOwner(me);
  useOutboxAutoFlush(useCallback(() => {}, []));
  useGotvLive(null, me); // never live: a scrutineer has nothing to receive
  const { pathname } = useLocation();
  const [ask, setAsk] = useState(null);
  const [busy, setBusy] = useState(false);
  if (pathname !== '/gotv') return <Navigate to="/gotv" replace />;
  const signOut = async (force) => {
    const left = unsentCount() + gotvNoteCount(me);
    if (left && !force) { setAsk(`${left} not sent. They will be deleted from this phone. Sign out?`); return; }
    setBusy(true);
    try {
      await apiPost('/auth/logout');
      closeOutbox(); clearOutbox(); clearGotvNotes(me);
      window.location.replace(window.location.pathname.replace(/\/gotv$/, '/login'));
    } catch {
      setAsk('Sign out needs signal — try again when you’re back online');
    } finally { setBusy(false); }
  };
  return (
    <>
      <header className="nav"><div className="nav-inner">
        <span className="brand"><span className="brand-text"><span className="brand-org">{me.workspace?.name}</span><span className="brand-sub"><span className="brand-name">base.win</span></span></span></span>
        <span className="spacer" />
        <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => signOut(false)}>Sign out</button>
      </div></header>
      {ask && (
        <div className="gv-ask" role="alert">
          <span>{ask}</span>
          <button type="button" className="btn" onClick={() => signOut(true)} disabled={busy}>Yes</button>
          <button type="button" className="btn btn-quiet" onClick={() => setAsk(null)}>No</button>
        </div>
      )}
      <main className="page">
        <Suspense fallback={<p className="muted">Loading…</p>}><Screen me={me} /></Suspense>
      </main>
    </>
  );
}
