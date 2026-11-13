// Join a campaign from an invite link. New people set a name and password;
// people who already use base.win confirm with their existing password (and
// the code from their authenticator app, when two-step sign-in is on).
// Everyone lands on Today, whose one big button is "Start canvassing" —
// unless they ticked "Also sign in with Google next time": then, once
// joined (and signed in with their password), Google asks which account,
// and they land on Your profile with it linked (or the reason it isn't).
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../api.js';
import { landing } from '../mode.js';
import { CodeField } from '../components/TwoStep.jsx';
import AuthPage from '../components/AuthPage.jsx';
import { appName, googleHere, googleStart } from '../components/google.js';
import '../components/google.css';

const ROLE_LABEL = { manager: 'a manager', treasurer: 'the treasurer', staff: 'staff', volunteer: 'a volunteer' };

// Big, thumb-sized controls (auth pages load before any page stylesheet).
const AUTH_INPUT = { minHeight: 48, fontSize: 16 };
const AUTH_BUTTON = { width: '100%', minHeight: 48, fontSize: 15, marginTop: 'var(--s-2)' };

export default function Join({ mode = 'field' }) {
  const { token } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  // Two-step sign-in on for this account: the server asks for its code too.
  const [code, setCode] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [withGoogle, setWithGoogle] = useState(false);
  const setup = useQuery({ queryKey: ['auth-setup'], queryFn: () => apiGet('/auth/setup'), retry: false });
  const googleOn = Boolean(setup.data?.google) && googleHere();
  // An invite works once: after joining it 404s, so never refetch it.
  const inv = useQuery({
    queryKey: ['invite', token], queryFn: () => apiGet(`/auth/invite/${token}`),
    retry: false, staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await apiPost('/auth/join', inv.data.hasAccount
        ? { token, password, ...(code !== null ? { code } : {}) }
        : { token, name, password });
      // Drop whatever an earlier login cached — except this (now used)
      // invite, which this screen still shows until Today takes over.
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'invite' });
      queryClient.setQueryData(['me'], me);
      if (googleOn && withGoogle) {
        // The app they'd land in; the server sends them back to its profile.
        const app = appName(landing(me, mode).href ? (mode === 'admin' ? 'field' : 'admin') : mode);
        window.location.assign(googleStart('link', { app }));
        return;
      }
      const go = landing(me, mode);
      if (go.href) window.location.assign(go.href); else navigate(go.to);
    } catch (err) {
      // The password was right; now the code (or it didn't match).
      if (err.body?.two_step === 'code' && code === null) { setCode(''); setError(null); return; }
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (inv.isPending) return <AuthPage />;
  if (inv.isError) {
    return (
      <AuthPage>
        <h1>{inv.error.status === 404 ? 'Invite not found' : 'Can’t open this invite'}</h1>
        <p className="muted">{inv.error.status === 404 ? 'Ask a manager for a new link.' : inv.error.message}</p>
      </AuthPage>
    );
  }

  const { email, role, workspaceName, hasAccount } = inv.data;
  return (
    <AuthPage org={workspaceName}>
      <h1>Join {workspaceName}</h1>
      <p className="muted">As {ROLE_LABEL[role] || role} · <strong>{email}</strong></p>
      <form onSubmit={submit}>
        {!hasAccount && (
          <div className="field">
            <label htmlFor="join-name">Your name</label>
            <input id="join-name" className="input" required autoFocus autoComplete="name" maxLength={200} style={AUTH_INPUT}
              value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        )}
        <div className="field">
          <label htmlFor="join-password">{hasAccount ? 'Your base.win password' : 'Choose a password'}</label>
          <input id="join-password" className="input" type="password" required minLength={8} maxLength={200} style={AUTH_INPUT}
            autoFocus={hasAccount} autoComplete={hasAccount ? 'current-password' : 'new-password'}
            placeholder={hasAccount ? undefined : '8 or more characters'}
            value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {code !== null && (
          <CodeField id="join-code" label="Code from your authenticator app (or a recovery code)" value={code} onChange={setCode} recovery autoFocus />
        )}
        {googleOn && (
          <>
            <label className="gg-tick">
              <input type="checkbox" checked={withGoogle} onChange={(e) => setWithGoogle(e.target.checked)} aria-describedby="join-google-hint" />
              <span>Also sign in with Google next time</span>
            </label>
            <p className="gg-tick-hint" id="join-google-hint">After joining, Google asks which account to use. If Google says this browser isn’t allowed, open the invite link in Safari or Chrome.</p>
          </>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" className="btn btn-primary" style={AUTH_BUTTON} disabled={busy || (code !== null && !code.trim())}>
          {busy ? 'Joining…' : 'Join'}
        </button>
      </form>
    </AuthPage>
  );
}
