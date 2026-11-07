// The product's name, in one place. Base — a broad application for social
// engagement — is three apps in one:
//   Ground  the campaign itself: people, doors, calls, shifts, money (this
//           app — server/ and web/ — and where Base opens)
//   Web     the Imagine Surrey website and its back office (apps/web)
//   Air     social listening and posting: radar, queue, feed, brief
//           (apps/air, from Starsign)
// Web and Air run on their own; Ground links to them (BASE_WEB_URL,
// BASE_AIR_URL — server/lib/org.js). Internal names (STARBASE_* settings,
// package names, the database) are unchanged, so nothing deployed moves.
export const APP_NAME = 'Base';
export const APPS = [
  { key: 'ground', name: 'Ground', full: 'Base Ground', what: 'The campaign — people, doors, calls, shifts, money' },
  { key: 'web', name: 'Web', full: 'Base Web', what: 'The website and its back office' },
  { key: 'air', name: 'Air', full: 'Base Air', what: 'Social media — radar, queue, feed, brief' },
];
export const DEFAULT_APP = 'ground';
