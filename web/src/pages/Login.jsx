// Sign in: email, password, one button. With two-step sign-in on, a second
// step: the code from the authenticator app (or a recovery code). The
// first-run setup link shows only until the campaign is set up (after
// that, people join by invite).
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, ApiError, noAnswer } from '../api.js'; // no signal at all keeps its own words
import { landing } from '../mode.js';
import { CodeField } from '../components/TwoStep.jsx';
import AuthPage from '../components/AuthPage.jsx';

// Big, thumb-sized controls (auth pages load before any page stylesheet).
const AUTH_INPUT = { minHeight: 48, fontSize: 16 };
const AUTH_BUTTON = { width: '100%', minHeight: 48, fontSize: 15, marginTop: 'var(--s-2)' };

// What went wrong, in words that say what to do: a wrong password, a pause
// after too many tries, or a server that isn't answering (restarting, or its
// database is) — the last is never the person's fault.
export const signInTrouble = (err) => {
  if (err instanceof ApiError && err.status === 401) return 'That email and password don’t match. Check both, or ask your campaign manager to reset your password.';
  if (err instanceof ApiError && err.status === 429) return 'Too many tries — wait 15 minutes, then try again.';
  if (err instanceof ApiError && noAnswer(err)) return 'base.win isn’t answering right now — it may be restarting. Your password is fine; try again in a minute.';
  return err.message;
};

export default function Login({ mode = 'field' }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const setup = useQuery({ queryKey: ['auth-setup'], queryFn: () => apiGet('/auth/setup'), retry: false });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  // 'password' → 'code' (two-step sign-in on for this account).
  const [step, setStep] = useState('password');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const signedIn = (me) => {
    queryClient.setQueryData(['me'], me);
    const go = landing(me, mode);
    if (go.href) window.location.assign(go.href); else navigate(go.to);
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await apiPost('/auth/login', { email, password });
      if (me.two_step === 'code') { setStep('code'); setCode(''); return; }
      signedIn(me);
    } catch (err) {
      setError(signInTrouble(err));
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      signedIn(await apiPost('/auth/login/code', { code }));
    } catch (err) {
      // Too long, or too many wrong codes: the password again.
      if (err instanceof ApiError && err.body?.two_step === 'again') { setStep('password'); setPassword(''); }
      setError(err instanceof ApiError && err.status !== 429 && !noAnswer(err) ? err.message : signInTrouble(err));
    } finally {
      setBusy(false);
    }
  };

  // Whose sign-in this is (the campaign's name once it is set up).
  const whose = { org: setup.data?.organization || null, staging: setup.data?.org?.env === 'staging' };

  if (step === 'code') {
    return (
      <AuthPage {...whose}>
        <h1>Enter your code</h1>
        <form onSubmit={submitCode}>
          <p className="ts-hint" id="code-hint">The 6-digit code from your authenticator app.</p>
          <CodeField id="login-code" label="Code" value={code} onChange={setCode} recovery autoFocus
            describedBy="code-hint" invalid={Boolean(error)} />
          {error && <p className="error" role="alert">{error}</p>}
          <button type="submit" className="btn btn-primary" style={AUTH_BUTTON} disabled={busy || !code.trim()}>
            {busy ? 'Checking…' : 'Sign in'}
          </button>
        </form>
        <p className="ts-hint ts-again">Lost your phone? Type one of your recovery codes instead.</p>
        <p className="ts-again">
          <button type="button" className="btn-link" onClick={() => { setStep('password'); setError(null); setPassword(''); }}>Start again</button>
        </p>
      </AuthPage>
    );
  }

  return (
    <AuthPage {...whose}>
      <h1>Sign in</h1>
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="login-email">Email</label>
          <input id="login-email" className="input" type="email" required autoFocus autoComplete="email" style={AUTH_INPUT}
            value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="login-password">Password</label>
          <input id="login-password" className="input" type="password" required autoComplete="current-password" style={AUTH_INPUT}
            value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" className="btn btn-primary" style={AUTH_BUTTON} disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      {setup.data?.open && (
        <>
          <hr className="hairline" />
          <p className="muted"><Link to="/signup">Set up base.win{setup.data.organization ? ` for ${setup.data.organization}` : ''}</Link></p>
        </>
      )}
    </AuthPage>
  );
}
