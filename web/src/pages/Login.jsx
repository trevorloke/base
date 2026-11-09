// Sign in: email, password, one button. The first-run setup link shows only
// until the campaign is set up (after that, people join by invite).
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, ApiError, noAnswer } from '../api.js'; // no signal at all keeps its own words
import { landing } from '../mode.js';

// Big, thumb-sized controls (auth pages load before any page stylesheet).
const AUTH_INPUT = { minHeight: 48, fontSize: 16 };
const AUTH_BUTTON = { width: '100%', minHeight: 52, fontSize: 13, marginTop: 'var(--s-2)' };

// What went wrong, in words that say what to do: a wrong password, a pause
// after too many tries, or a server that isn't answering (restarting, or its
// database is) — the last is never the person's fault.
export const signInTrouble = (err) => {
  if (err instanceof ApiError && err.status === 401) return 'That email and password don’t match. Check both, or ask your campaign manager to reset your password.';
  if (err instanceof ApiError && err.status === 429) return 'Too many tries — wait 15 minutes, then try again.';
  if (err instanceof ApiError && noAnswer(err)) return 'Base isn’t answering right now — it may be restarting. Your password is fine; try again in a minute.';
  return err.message;
};

export default function Login({ mode = 'field' }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
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
      const go = landing(me, mode);
      if (go.href) window.location.assign(go.href); else navigate(go.to);
    } catch (err) {
      setError(signInTrouble(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <span className="brand">Base</span>
      {setup.data?.organization && <span className="brand-org">{setup.data.organization}</span>}
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
          <p className="muted"><Link to="/signup">Set up Base{setup.data.organization ? ` for ${setup.data.organization}` : ''}</Link></p>
        </>
      )}
    </div>
  );
}
