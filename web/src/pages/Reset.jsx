// Choose a new password, from a link (Forgot password, or a manager's):
// …/reset#t=<token>. The token is read from the fragment and dropped from
// the address before anything is asked, so it stays out of history and
// never reaches a server log; it goes to the server by POST only. Then:
// whose link it is, the new password, and — with two-step sign-in on — the
// code, as at sign in. Saving signs out every other device.
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, ApiError, noAnswer } from '../api.js';
import { landing } from '../mode.js';
import AuthPage from '../components/AuthPage.jsx';
import { CodeField } from '../components/TwoStep.jsx';
import { AUTH_BUTTON, AUTH_INPUT, signInTrouble } from './Login.jsx';
import './reset.css';

const RUN_OUT = 'That link has run out or was already used.';
const DONE = 'Password changed. You’re signed out everywhere else.';

// Once, before the first render asks anything: the token, and the address without it.
const takeToken = () => {
  if (typeof window === 'undefined') return '';
  const m = /(?:^#|&)t=([0-9a-f]{64})(?:&|$)/.exec(window.location.hash || '');
  if (window.location.hash) window.history.replaceState(null, '', window.location.pathname + window.location.search);
  return m ? m[1] : '';
};

export default function Reset({ mode = 'field' }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const tokenRef = useRef(null);
  if (tokenRef.current === null) tokenRef.current = takeToken();
  const token = tokenRef.current;
  const setup = useQuery({ queryKey: ['auth-setup'], queryFn: () => apiGet('/auth/setup'), retry: false });
  const check = useQuery({
    queryKey: ['reset-check', token],
    queryFn: () => apiPost('/auth/reset/check', { token }),
    enabled: Boolean(token), retry: false, staleTime: Infinity, gcTime: 0,
  });
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState('password'); // → 'code' (two-step on) → 'done'
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [me, setMe] = useState(null);
  const whose = { org: setup.data?.organization || null, staging: setup.data?.org?.env === 'staging' };

  const go = (who) => {
    queryClient.setQueryData(['me'], who);
    const to = landing(who, mode);
    if (to.href) window.location.assign(to.href); else navigate(to.to);
  };
  // Signed in: the line, then on to the app.
  useEffect(() => {
    if (step !== 'done' || !me) return undefined;
    const t = setTimeout(() => go(me), 2500);
    return () => clearTimeout(t);
  }, [step, me]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await apiPost('/auth/reset', { token, password });
      if (r.two_step === 'code') { setStep('code'); return; }
      setMe(r); setStep('done');
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setStep('gone');
      else setError(err instanceof ApiError && noAnswer(err) ? 'base.win isn’t answering right now. Your link still works: try again in a minute.' : err.message);
    } finally {
      setBusy(false);
    }
  };
  const submitCode = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      setMe(await apiPost('/auth/login/code', { code })); setStep('done');
    } catch (err) {
      // Too long, or too many wrong codes: the password is set; sign in again.
      if (err instanceof ApiError && err.body?.two_step === 'again') setStep('again');
      else setError(err instanceof ApiError && err.status !== 429 && !noAnswer(err) ? err.message : signInTrouble(err));
    } finally {
      setBusy(false);
    }
  };

  const askAgain = <p className="pw-back"><Link className="pw-quiet" to="/forgot">Ask for a new one</Link></p>;
  let body;
  if (!token || step === 'gone' || (check.isError && check.error instanceof ApiError && check.error.status === 404)) {
    body = <><p className="pw-line" role="alert">{RUN_OUT}</p>{askAgain}</>;
  } else if (step === 'done') {
    body = (
      <>
        <p className="pw-line pw-done" role="status">{DONE}</p>
        <button type="button" className="btn btn-primary" style={AUTH_BUTTON} onClick={() => go(me)}>Continue</button>
      </>
    );
  } else if (step === 'again') {
    body = (
      <>
        <p className="pw-line" role="status">Your new password is saved. That took too long: sign in with it.</p>
        <p className="pw-back"><Link className="pw-quiet" to="/login">Sign in</Link></p>
      </>
    );
  } else if (step === 'code') {
    body = (
      <form onSubmit={submitCode}>
        <p className="ts-hint" id="reset-code-hint">Saved. Now the 6-digit code from your authenticator app.</p>
        <CodeField id="reset-code" label="Code" value={code} onChange={setCode} recovery autoFocus
          describedBy="reset-code-hint" invalid={Boolean(error)} />
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" className="btn btn-primary" style={AUTH_BUTTON} disabled={busy || !code.trim()}>
          {busy ? 'Checking…' : 'Sign in'}
        </button>
      </form>
    );
  } else if (check.isPending) {
    body = <p className="muted" role="status">Loading…</p>;
  } else if (check.isError) {
    body = (
      <p className="error" role="alert">
        Unavailable — <button type="button" className="btn-link pw-quiet" onClick={() => check.refetch()}>Try again</button>
      </p>
    );
  } else {
    body = (
      <form onSubmit={save}>
        <p className="pw-for">For <strong>{check.data.email}</strong></p>
        <div className="field">
          <label htmlFor="reset-password">New password</label>
          <input id="reset-password" className="input" type="password" required minLength={8} maxLength={200} autoFocus
            autoComplete="new-password" aria-describedby="reset-password-hint" style={AUTH_INPUT}
            value={password} onChange={(e) => setPassword(e.target.value)} />
          <span className="ts-hint" id="reset-password-hint">8 or more characters.</span>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" className="btn btn-primary" style={AUTH_BUTTON} disabled={busy}>
          {busy ? 'Saving…' : 'Save password'}
        </button>
      </form>
    );
  }
  return (
    <AuthPage {...whose}>
      <h1>{step === 'code' ? 'Enter your code' : 'Choose a new password'}</h1>
      <div aria-live="polite">{body}</div>
    </AuthPage>
  );
}
