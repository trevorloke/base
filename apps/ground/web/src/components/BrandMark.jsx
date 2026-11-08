// The mark in the top bar and on the sign-in page: the campaign's logo
// (Settings → Brand), or base ground's own — a map pin on the ground, in
// the brand's accent — when there is none. Decorative: the name beside it
// says who it is.
import { assetUrl, bootBrand } from '../brand.js';

export function OwnMark({ className = 'brand-mark' }) {
  return (
    <svg className={`${className} brand-mark--own`} viewBox="0 0 32 32" width="32" height="32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="8" style={{ fill: 'var(--accent)' }} />
      <path d="M16 5.5c-4.1 0-7.2 3.1-7.2 7 0 4.8 7.2 11.6 7.2 11.6s7.2-6.8 7.2-11.6c0-3.9-3.1-7-7.2-7z" style={{ fill: 'var(--accent-ink)' }} />
      <circle cx="16" cy="12.6" r="2.7" style={{ fill: 'var(--accent)' }} />
      <rect x="6.5" y="25.6" width="19" height="2.4" rx="1.2" style={{ fill: 'var(--accent-ink)' }} />
    </svg>
  );
}

export default function BrandMark({ logo, className = 'brand-mark' }) {
  if (!logo) return <OwnMark className={className} />;
  return <img className={className} src={assetUrl(logo)} alt="" height="32" />;
}

// The sign-in, set-up and join pages: the mark and the campaign's name
// (from the page the server sent — nobody is signed in yet), with
// "base ground" under it. org: the campaign's name from /api/auth/setup.
export function AuthBrand({ org = null }) {
  const b = bootBrand();
  const name = b.name || org;
  return (
    <span className="brand">
      <BrandMark logo={b.logo} />
      <span className="brand-text">
        <span>{name || 'base ground'}</span>
        {name && <span className="brand-sub">base ground</span>}
      </span>
    </span>
  );
}
