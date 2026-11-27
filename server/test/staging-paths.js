// Every read the demo walk makes, with the answer's status (not a test;
// used by staging-walk.test.js and scripts/staging-check.mjs). The same
// reads as the preset dump (scripts/preset-dump.sh: 110 API reads and 47
// pages signed in, 8 pages signed out), with the people read whole
// (persons?limit=500, not only the first page). The walk test checks the
// two lists name the same reads, so they can't drift.
//
// APP: the app's own built page (web/dist). Without a build (npm test runs
// before npm run build in CI) the server answers 404 there instead.
export const APP = 'app';

// Signed in as the demo account.
export const API_PATHS = [
  ['/api/auth/me', 200], ['/api/auth/setup', 200], ['/api/health', 200], ['/api/scale', 200], ['/api/fields', 200], ['/api/audience/choices', 200],
  ['/api/lists', 200], ['/api/lists/tags', 200], ['/api/scripts', 200], ['/api/templates', 200], ['/api/learn', 200], ['/api/learn/progress', 200],
  ['/api/media/contacts', 200], ['/api/media/outlets', 200], ['/api/media/releases', 200], ['/api/media/stats', 200], ['/api/letters/outlets', 200],
  ['/api/media/letters', 200], ['/api/letters/mine', 200], ['/api/site', 200], ['/api/site/campaigns', 200], ['/api/site/pictures', 200],
  ['/api/site/posts', 200], ['/api/site/fonts', 200], ['/api/site/fonts/catalogue', 200], ['/api/site/languages', 200],
  ['/api/site/microsites', 200], ['/api/guide', 200], ['/api/site/guide', 200], ['/api/membership/form', 404], ['/api/payments', 200],
  ['/api/receipts', 200], ['/api/receipts/needs', 200], ['/api/money/filing-dates', 200], ['/api/brief', 200], ['/api/dashboard', 200],
  ['/api/map/config', 200], ['/api/map/credit', 200], ['/api/map/check', 200], ['/api/map/check/services', 200], ['/api/pathtowin', 200],
  ['/api/ladders', 200], ['/api/surveys', 200], ['/api/surveys/active', 400], ['/api/texting/settings', 200], ['/api/texting/status', 200],
  ['/api/senders', 200], ['/api/mail/domain', 200], ['/api/integrations', 200], ['/api/admin/permissions', 200], ['/api/teams', 200],
  ['/api/team', 200], ['/api/members', 200], ['/api/candidates', 200], ['/api/candidate/home', 404], ['/api/banks', 200], ['/api/passes', 200],
  ['/api/reports', 200], ['/api/quick-reports-menu', 200], ['/api/schedule/week', 200], ['/api/places', 200], ['/api/gotv/setup', 200],
  ['/api/gotv/places', 200], ['/api/voted/status', 200], ['/api/voted/summary', 200], ['/api/stewardship', 200], ['/api/share', 200],
  ['/api/share/kits', 200], ['/api/share/top', 200], ['/api/connections', 200], ['/api/google', 200], ['/api/gmail', 200], ['/api/gcal', 200],
  ['/api/drive', 200], ['/api/mailchimp', 200], ['/api/callhub/pushes', 400], ['/api/requests', 200], ['/api/volunteers', 200], ['/api/shifts', 200],
  ['/api/shifts/board', 400], ['/api/signs', 200], ['/api/turfs', 200], ['/api/persons?limit=500', 200], ['/api/persons/count', 200],
  ['/api/contacts', 200], ['/api/events', 200], ['/api/blasts', 200], ['/api/blasts/stats', 200], ['/api/subscriptions', 200], ['/api/actions', 200],
  ['/api/export', 200], ['/api/operator', 200], ['/api/two-step', 200], ['/api/intake/keys', 200], ['/api/geocode/status', 200],
  ['/api/duplicates', 200], ['/api/followups/mine', 200], ['/api/field-report', 200], ['/api/webdid', 200], ['/api/shiftturfs', 200],
  ['/api/moves/counts', 200], ['/api/calltime/seats', 200], ['/api/calltime/pledges', 200], ['/api/relationships/mine', 200],
  ['/api/relationships/key', 200], ['/api/data', 200, APP], ['/api/data/sample', 200, APP], ['/api/data/status', 200, APP], ['/api/brand', 200, APP],
  ['/api/brand/settings', 200, APP],
];

export const PAGES = [
  ['/', 200, APP], ['/admin', 200, APP], ['/join', 200, APP], ['/donate', 200, APP], ['/site/', 200], ['/site', 200],
  ['/manifest.webmanifest', 200, APP], ['/sw.js', 200, APP], ['/signup', 200, APP], ['/login', 200, APP], ['/volunteer', 200, APP],
  ['/membership', 200, APP], ['/member', 200, APP], ['/learn', 200, APP], ['/u', 200, APP], ['/robots.txt', 200, APP], ['/sitemap.xml', 200, APP],
  ['/site/sitemap.xml', 200], ['/site/robots.txt', 200], ['/site/feed.xml', 404], ['/site/about', 404], ['/site/platform', 404], ['/site/news', 200],
  ['/site/events', 404], ['/site/donate', 200], ['/site/volunteer', 200], ['/site/join', 404], ['/site/contact', 404], ['/site/team', 404],
  ['/site/candidates', 404], ['/site/privacy', 200], ['/site/guide', 404], ['/guide', 200, APP], ['/vote', 200, APP], ['/favicon.ico', 200, APP],
  ['/star.png', 404], ['/base-mark.svg', 200, APP], ['/apple-touch-icon.png', 404], ['/icon-192.png', 404], ['/site-assets/site.css', 200],
  ['/site-assets/imagine-surrey/logo.webp', 404], ['/site-assets/imagine-surrey/logo-light.png', 404], ['/calendar', 200, APP],
  ['/events', 200, APP], ['/sign', 200, APP], ['/petition', 200, APP], ['/share', 200, APP],
];

// Signed out.
export const ANON = [
  ['/', 200, APP], ['/join', 200, APP], ['/donate', 200, APP], ['/site/', 200], ['/manifest.webmanifest', 200, APP], ['/signup', 200, APP],
  ['/login', 200, APP], ['/api/auth/setup', 200],
];

// The pictures and icons that were Imagine Surrey's: none is served on
// staging (or to any campaign but Imagine Surrey).
export const GONE = [
  '/site-assets/imagine-surrey/logo.webp', '/site-assets/imagine-surrey/logo-light.png',
  '/site-assets/imagine-surrey/hero-park.jpg', '/site-assets/imagine-surrey/members-rally.jpg',
  '/star.png', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png',
];
