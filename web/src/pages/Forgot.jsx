// Forgot your password? Where the campaign can email (GET /api/auth/setup
// resetByEmail): an email field and one button; the answer is the same
// whether or not the address has an account here. Where it can't (no
// sender, no public address, or the public demo): who to ask instead.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet, apiPost, ApiError, noAnswer } from '../api.js';
import AuthPage from '../components/AuthPage.jsx';
import { AUTH_BUTTON, AUTH_INPUT } from './Login.jsx';
import './reset.css';

export default function Forgot() {
  const setup = useQuery({ queryKey: ['auth-setup'], queryFn: () => apiGet('/auth/setup'), retry: false });
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(null);
  const whose = { org: setup.data?.organization || null, staging: setup.data?.org?.env === 'staging' };
  const back = <p className="pw-back"><Link className="pw-quiet" to="/login">Back to sign in</Link></p>;

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await apiPost('/auth/forgot', { email: email.trim() });
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError && noAnswer(err)
        ? 'base.win isn’t answering right now. Try again in a minute.'
        : err.message);
    } finally {
      setBusy(false);
    }
  };

  let body;
  if (setup.isPending) body = <p className="muted" role="status">Loading…</p>;
  else if (setup.isError) {
    body = (
      <p className="error" role="alert">
        Unavailable — <button type="button" className="btn-link pw-quiet" onClick={() => setup.refetch()}>Try again</button>
      </p>
    );
  } else if (!setup.data?.resetByEmail) {
    body = <p className="pw-line" role="status">This campaign can’t send email yet. Ask a manager for a password link.</p>;
  } else if (sent) {
    body = <p className="pw-line" role="status">If that address has an account here, a link is on its way. It works for 30 minutes.</p>;
  } else {
    body = (
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="forgot-email">Email</label>
          <input id="forgot-email" className="input" type="email" required autoFocus autoComplete="email" maxLength={320} style={AUTH_INPUT}
            value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" className="btn btn-primary" style={AUTH_BUTTON} disabled={busy}>
          {busy ? 'Sending…' : 'Email me a link'}
        </button>
      </form>
    );
  }
  return (
    <AuthPage {...whose}>
      <h1>Forgot your password?</h1>
      <div aria-live="polite">{body}</div>
      {back}
    </AuthPage>
  );
}
