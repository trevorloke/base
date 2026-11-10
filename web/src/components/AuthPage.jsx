// The card every signed-out screen sits on (sign in, set up, join, the
// two-step gate, "not for your role"): the campaign leads — its logo, or its
// initials and its name — and base.win is the quiet line at the foot.
//   org      the campaign's name, when the screen knows it
//   staging  say "Staging" beside it, so nobody mistakes it for production
import BrandMark, { HAS_LOGO } from './BrandMark.jsx';

export default function AuthPage({ org, staging = false, className = '', children }) {
  return (
    <div className={`auth-page${className ? ` ${className}` : ''}`}>
      {(org || HAS_LOGO || staging) && (
        <div className={`auth-head${HAS_LOGO ? ' has-logo' : ''}`}>
          <BrandMark name={org} />
          {org && <span className="brand-org">{org}</span>}
          {staging && <span className="env-badge">Staging</span>}
        </div>
      )}
      {children}
      <p className="auth-foot"><span className="brand">base.win</span></p>
    </div>
  );
}
