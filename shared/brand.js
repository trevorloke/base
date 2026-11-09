// The product's name, in one place. Base — a broad application for social
// engagement — is two apps in one:
//   Ground  the campaign itself: people, doors, calls, shifts, money (this
//           app — server/ and web/ — and where Base opens)
//   Web     the campaign's website and its back office (apps/web)
// Web runs on its own; Ground links to it (BASE_WEB_URL — server/lib/org.js).
// Internal names (STARBASE_* settings, package names, the database) are
// unchanged, so nothing deployed moves.
export const APP_NAME = 'Base';
export const APPS = [
  { key: 'ground', name: 'Ground', full: 'Base Ground', what: 'The campaign — people, doors, calls, shifts, money' },
  { key: 'web', name: 'Web', full: 'Base Web', what: 'The website and its back office' },
];
export const DEFAULT_APP = 'ground';
