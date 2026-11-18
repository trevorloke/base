// In as base.win support (ext/operator; me.operator): one line across the
// top of every screen, in both apps, until the visit ends — so nobody
// mistakes it for the campaign's own sign-in. Never under "More".
import { clockText, zoneOf } from './shiftTime.js';
import './operator.css';

export default function OperatorBanner({ me, onSignOut, signingOut = false }) {
  if (!me?.operator) return null;
  const until = me.operator.until ? clockText(me.operator.until, zoneOf(me)) : null;
  return (
    <div className="op-banner" role="status">
      <span className="op-banner__text">You’re in as base.win support{until ? ` · until ${until}` : ''}</span>
      <button type="button" className="btn btn-quiet op-banner__out" disabled={signingOut} onClick={() => onSignOut()}>
        {signingOut ? 'Signing out…' : 'Sign out'}
      </button>
    </div>
  );
}
