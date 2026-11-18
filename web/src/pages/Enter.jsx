// base.win support's way in from the control centre (ops.base.win): the
// desk's /enter#t=<token>. The token is read from the fragment and dropped
// from the address before anything is asked (it stays out of history and
// never reaches a server log); it goes to the server by POST only, from this
// same origin (server/routes/auth.js /operator). Then — for a first manager's
// invite — the invite, as support, and a full load of the desk, so nothing
// an earlier sign-in kept on this browser is read as this one's (main.jsx).
import { useEffect, useRef, useState } from 'react';
import { apiPost, action, ApiError, noAnswer } from '../api.js';
import { adminHref, fieldHref, mayAdmin } from '../mode.js';
import AuthPage from '../components/AuthPage.jsx';
import '../components/operator.css';

export const OPS_INVITE = 'opsInvite';
const WORDS = {
  entry: 'That link has run out. Open the desk again from the control centre.',
  off: 'This campaign has turned off base.win sign-in. A manager can turn it on in Settings → Members.',
  'email-taken': 'An account with your email is here but isn’t on the team. A manager can invite it again.',
  'not-ready': 'base.win sign-in isn’t set up on this server yet.',
};
const NOTHING = 'Nothing to open here.';
const VOLUNTEER = 'You’re in as a volunteer here. A manager can change your role in Settings → Members.';

// Once, before anything is asked: the token, and the address without it.
const takeToken = () => {
  if (typeof window === 'undefined') return '';
  const m = /(?:^#|&)t=(bw-entry\.v1\.[A-Za-z0-9_.-]+)(?:&|$)/.exec(window.location.hash || '');
  window.history.replaceState(null, '', window.location.pathname);
  return m ? m[1] : '';
};

export default function Enter() {
  const tokenRef = useRef(null);
  if (tokenRef.current === null) tokenRef.current = takeToken();
  const [state, setState] = useState(tokenRef.current ? { busy: true } : { error: NOTHING });
  const asked = useRef(false);

  useEffect(() => {
    const token = tokenRef.current;
    if (!token || asked.current) return;
    asked.current = true;
    (async () => {
      let me;
      try {
        me = await apiPost('/auth/operator', { token });
      } catch (err) {
        const code = err instanceof ApiError ? err.body?.code : null;
        setState({ error: WORDS[code] || (err instanceof ApiError && !noAnswer(err) ? err.message : 'base.win isn’t answering right now. Open the desk again in a minute.') });
        return;
      }
      if (!mayAdmin(me)) { setState({ volunteer: true }); return; }
      if (me.invite?.email) {
        let said;
        try {
          const r = await action('member.invite', { email: me.invite.email, role: 'manager' });
          said = { email: r.invite.email, role: r.invite.role, joinUrl: r.joinUrl, emailStatus: r.email };
        } catch (err) {
          // Already on the team counts as done; anything else is said on Members.
          said = err instanceof ApiError && err.status === 409 ? { email: me.invite.email, done: true } : { email: me.invite.email, error: err.message };
        }
        try { sessionStorage.setItem(OPS_INVITE, JSON.stringify(said)); } catch { /* private mode: Members lists the invite anyway */ }
      }
      window.location.replace(adminHref(me.go === '/desk/settings/members' ? '/settings/members' : '/'));
    })();
  }, []);

  let body;
  if (state.busy) body = <p className="op-enter-line" role="status">Opening the desk…</p>;
  else if (state.volunteer) {
    body = (
      <>
        <p className="op-enter-line" role="status">{VOLUNTEER}</p>
        <p><a className="op-quiet" href={fieldHref('/')}>Open the field app</a></p>
      </>
    );
  } else {
    body = (
      <>
        <p className="op-enter-line" role="alert">{state.error}</p>
        <p><a className="op-quiet" href={adminHref('/login')}>Sign in another way</a></p>
      </>
    );
  }
  return (
    <AuthPage>
      <h1>base.win support</h1>
      <div aria-live="polite">{body}</div>
    </AuthPage>
  );
}
