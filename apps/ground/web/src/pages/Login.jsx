// Sign in: email, password, one button. The first-run setup link shows only
// until the campaign is set up (after that, people join by invite).
// ?next=: where to go after, when another Base app sent the person here to
// sign in (/api/sso/authorize, SUITE.md). Only this app's own addresses under
// its prefix are followed (paths.js safeNext); anything else is ignored.
// Someone already signed in goes straight on: the app that sent them may be
// on another site, and the sign-in cookie (SameSite=Strict) only rides along
// once the hop starts here.
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../api.js';
import { landing } from '../mode.js';
import { safeNext } from '../paths.js';

// Straight on once per address in a short while — never round and round if
// the hop comes back here anyway.
const ONWARD_KEY = 'base:login-onward';
const wentOnJustNow = (next) => {
  try {
    const last = JSON.parse(sessionStorage.getItem(ONWARD_KEY) || 'null');
    if (last?.next === next && Date.now() - last.at < 15_000) return true;
    sessionStorage.setItem(ONWARD_KEY, JSON.stringify({ next, at: Date.now() }));
  } catch { /* storage blocked: go on anyway */ }
  return false;
};
import { AuthBrand } from '../components/BrandMark.jsx';

// Big, thumb-sized controls (auth pages load before any page stylesheet).
const AUTH_INPUT = { minHeight: 48, fontSize: 16 };
const AUTH_BUTTON = { width: '100%', minHeight: 52, fontSize: 13, marginTop: 'var(--s-2)' };

export default function Login({ mode = 'field' }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  // Its own key, not ['me']: a "not signed in" here must not count as a
  // sign-out (main.jsx forgets this phone's copies on one).
  const signedIn = useQuery({ queryKey: ['login-next-me'], queryFn: () => apiGet('/auth/me'), retry: false, enabled: Boolean(next) });
  useEffect(() => {
    if (next && signedIn.data?.user && !wentOnJustNow(next)) window.location.assign(next);
  }, [next, signedIn.data]);
  const setup = useQuery({ queryKey: ['auth-setup'], queryFn: () => apiGet('/auth/setup'), retry: false });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await apiPost('/auth/login', { email, password });
      queryClient.setQueryData(['me'], me);
      if (next) { window.location.assign(next); return; }
      const go = landing(me, mode);
      if (go.href) window.location.assign(go.href); else navigate(go.to);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <AuthBrand org={setup.data?.organization} />
      {setup.data?.org?.env === 'staging' && <span className="env-badge">Staging</span>}
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
        {error && <p className="error">{error}</p>}
        <button type="submit" className="btn btn-primary" style={AUTH_BUTTON} disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      {setup.data?.open && (
        <>
          <hr className="hairline" />
          <p className="muted"><Link to="/signup">Set up Base Ground{setup.data.organization ? ` for ${setup.data.organization}` : ''}</Link></p>
        </>
      )}
    </div>
  );
}
