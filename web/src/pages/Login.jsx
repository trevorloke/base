// Sign in: email, password, one button. With two-step sign-in on, a second
// step: the code from the authenticator app (or a recovery code). The
// first-run setup link shows only until the campaign is set up (after
// that, people join by invite). Sign in with Google, under the one
// primary "Sign in", when the server and the campaign have it on: a plain
// link to the server's start route (components/google.js). Google's return
// lands here with ?google=<why> when it didn't sign anyone in, or with
// ?step=code when two-step sign-in asks for the code next.
// On the public demo (staging; /api/auth/setup says demo), the page sends
// the visitor straight in through the demo's own door, once a minute at
// most: ?stay=1 keeps the form, for someone with their own staging account.
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, ApiError, noAnswer } from '../api.js'; // no signal at all keeps its own words
import { at, NS } from '../base.js';
import { landing } from '../mode.js';
import { CodeField } from '../components/TwoStep.jsx';
import AuthPage from '../components/AuthPage.jsx';
import { useOnline } from '../components/NoSignal.jsx';
import { appName, awayWords, googleHere, googleStart, googleWords, markSignin, takeSignin } from '../components/google.js';
import gLogo from '../components/google-g.svg';
import '../components/google.css';
import './reset.css';

// Big, thumb-sized controls (auth pages load before any page stylesheet).
export const AUTH_INPUT = { minHeight: 48, fontSize: 16 };
export const AUTH_BUTTON = { width: '100%', minHeight: 48, fontSize: 15, marginTop: 'var(--s-2)' };

// What went wrong, in words that say what to do: a wrong password, a pause
// after too many tries, or a server that isn't answering (restarting, or its
// database is) — the last is never the person's fault.
export const signInTrouble = (err, { google = false } = {}) => {
  if (err instanceof ApiError && err.status === 401) {
    return google
      ? 'That email and password don’t match. Check both, or sign in with Google.'
      : 'That email and password don’t match. Check both, or ask your campaign manager.';
  }
  if (err instanceof ApiError && err.status === 429) return 'Too many tries — wait 15 minutes, then try again.';
  if (err instanceof ApiError && noAnswer(err)) return 'base.win isn’t answering right now — it may be restarting. Your password is fine; try again in a minute.';
  return err.message;
};

// The demo's jump: when this tab last made it, until it signs someone in. A
// browser that keeps no cookie comes straight back here; the second time
// inside a minute it sees the form and a line, not a loop. Storage it can't
// read: no jump.
const DEMO_JUMP = `${NS}demo-jump`;
const DEMO_AGAIN_MS = 60_000;
const jumpedLately = () => {
  try {
    const t = Number(window.sessionStorage.getItem(DEMO_JUMP));
    return { readable: true, lately: Number.isFinite(t) && t > 0 && Date.now() - t < DEMO_AGAIN_MS };
  } catch { return { readable: false, lately: false }; }
};
const noteJump = () => {
  try { window.sessionStorage.setItem(DEMO_JUMP, String(Date.now())); return true; } catch { return false; }
};
// The app calls this once someone is signed in (App.jsx).
export const forgetDemoJump = () => {
  try { window.sessionStorage.removeItem(DEMO_JUMP); } catch { /* nothing kept */ }
};
export const DEMO_FAILED = 'The demo could not sign you in.';

export default function Login({ mode = 'field' }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const setup = useQuery({ queryKey: ['auth-setup'], queryFn: () => apiGet('/auth/setup'), retry: false });
  const [search, setSearch] = useSearchParams();
  const online = useOnline();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  // 'password' → 'code' (two-step sign-in on for this account). Back from
  // Google with two-step on: the code step straight away (the server set
  // the ticket's cookie).
  const [step, setStep] = useState(() => (search.get('step') === 'code' ? 'code' : 'password'));
  const [error, setError] = useState(null);
  // Why Google didn't sign anyone in, said once: the address loses it, so
  // a reload doesn't say it again.
  const [googleCode] = useState(() => search.get('google'));
  const [busy, setBusy] = useState(false);
  // Asked for the form (?stay), or back from Google or its second step: no jump.
  const [noJump] = useState(() => search.has('stay') || search.has('step') || search.has('google'));
  const [demoFailed, setDemoFailed] = useState(false);
  const [jumping, setJumping] = useState(false);
  useEffect(() => {
    if (!setup.data?.demo || noJump) return;
    const seen = jumpedLately();
    if (!seen.readable) return;
    if (seen.lately) { setDemoFailed(true); return; }
    if (!noteJump()) return;
    setJumping(true);
    window.location.assign(at('/api/auth/demo'));
  }, [setup.data?.demo, noJump]);
  useEffect(() => {
    takeSignin(); // a Google sign-in that came back here didn't happen
    if (search.has('google')) setSearch((q) => { q.delete('google'); return q; }, { replace: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const googleOn = Boolean(setup.data?.google);
  // Said once /auth/setup has answered: the domain rule's words name the domain.
  const shownError = error || (demoFailed && step === 'password' ? DEMO_FAILED : null) || (googleCode && step === 'password' && !setup.isPending ? googleWords(googleCode, { domain: setup.data?.googleDomain }) : null);
  const startAgain = () => {
    setStep('password'); setError(null); setPassword('');
    if (search.has('step')) setSearch((q) => { q.delete('step'); return q; }, { replace: true });
  };

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
      setError(signInTrouble(err, { google: googleOn }));
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
      if (err instanceof ApiError && err.body?.two_step === 'again') startAgain();
      setError(err instanceof ApiError && err.status !== 429 && !noAnswer(err) ? err.message : signInTrouble(err, { google: googleOn }));
    } finally {
      setBusy(false);
    }
  };

  // Whose sign-in this is (the campaign's name once it is set up).
  const whose = { org: setup.data?.organization || null, staging: setup.data?.org?.env === 'staging' };

  if (jumping) {
    return (
      <AuthPage {...whose}>
        <h1>Sign in</h1>
        <p className="muted" role="status">Opening the demo…</p>
      </AuthPage>
    );
  }

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
          <button type="button" className="btn-link" onClick={startAgain}>Start again</button>
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
        {shownError && <p className="error" role="alert">{shownError}</p>}
        <button type="submit" className="btn btn-primary" style={AUTH_BUTTON} disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      {/* Forgot password (pages/Forgot.jsx): a link by email, or who to ask. */}
      <p className="pw-forgot"><Link className="pw-quiet" to="/forgot">Forgot your password?</Link></p>
      {googleOn && <GoogleSignIn mode={mode} online={online} />}
      {setup.data?.open && (
        <>
          <hr className="hairline" />
          <p className="muted"><Link to="/signup">Set up base.win{setup.data.organization ? ` for ${setup.data.organization}` : ''}</Link></p>
        </>
      )}
    </AuthPage>
  );
}

// "Sign in with Google": Google's own white button, as wide and as tall as
// "Sign in" — never the primary. In the installed app, one line instead.
function GoogleSignIn({ mode, online }) {
  if (!googleHere()) {
    return (
      <>
        <hr className="hairline gg-or" />
        <p className="gg-line">{awayWords()}</p>
      </>
    );
  }
  return (
    <>
      <hr className="hairline gg-or" />
      <a className="gg-btn" href={online ? googleStart('signin', { app: appName(mode) }) : undefined}
        aria-disabled={online ? undefined : 'true'} role={online ? undefined : 'link'}
        aria-describedby={online ? undefined : 'gg-offline'} onClick={online ? markSignin : undefined}>
        <img src={gLogo} alt="" />
        <span>Sign in with Google</span>
      </a>
      {!online && <p className="gg-line" id="gg-offline" role="status">No signal — Google sign-in needs the internet.</p>}
    </>
  );
}
