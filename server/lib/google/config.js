// Google's settings for this server: the one OAuth client every Google
// feature uses (sign-in, and the connections Gmail, Drive and Calendar make),
// and the key that seals stored refresh tokens. All of it from the
// environment (Render); never the database, never an answer.
//
//   GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET   the client
//   GOOGLE_TOKEN_KEY     32+ characters, comma-separated while rotating
//                        (the first seals) — connections only (seal.js)
//   GOOGLE_ACCOUNTS_BASE, GOOGLE_OAUTH_BASE   test addresses (the fake in
//                        server/test/fake-google.js); ignored in production,
//                        so a stray value can never send the secret elsewhere
//
// The redirect address is never a setting: always
// <STARBASE_PUBLIC_URL>/api/auth/google/back, from the setting alone and
// never from a request's host.
import { configuredUrl } from '../calendar.js';
import { tokenKeyReady } from './seal.js';

const env = (k) => String(process.env[k] || '').trim();
const production = () => process.env.NODE_ENV === 'production';

export const GOOGLE_ACCOUNTS = 'https://accounts.google.com';
export const GOOGLE_OAUTH = 'https://oauth2.googleapis.com';
// Google's fixed addresses (the Services Check reads its discovery document
// and says so if Google has moved them).
export const AUTH_PATH = '/o/oauth2/v2/auth';
export const TOKEN_PATH = '/token';
export const REVOKE_PATH = '/revoke';
export const DISCOVERY_PATH = '/.well-known/openid-configuration';

const testBase = (k) => (production() ? '' : env(k).replace(/\/+$/, ''));
export const accountsBase = () => testBase('GOOGLE_ACCOUNTS_BASE') || GOOGLE_ACCOUNTS;
export const oauthBase = () => testBase('GOOGLE_OAUTH_BASE') || GOOGLE_OAUTH;
// Whether a test address is being honoured (Services says so).
export const testBaseInUse = () => Boolean(testBase('GOOGLE_ACCOUNTS_BASE') || testBase('GOOGLE_OAUTH_BASE'));

export const clientId = () => env('GOOGLE_OAUTH_CLIENT_ID');
export const clientSecret = () => env('GOOGLE_OAUTH_CLIENT_SECRET');

// An address Google will send people back to: https, or this machine while
// not in production.
const usableUrl = (url) => Boolean(url) && (/^https:\/\/[^/]/.test(url)
  || (!production() && /^http:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(url)));

export const redirectUri = () => {
  const pub = configuredUrl();
  return pub ? `${pub}/api/auth/google/back` : null;
};

// → { signin, connect, why, redirectUri }. why: the first missing piece, in
// Settings → Services' words (null when both work).
export const googleSetup = () => {
  const client = Boolean(clientId() && clientSecret());
  const pub = configuredUrl();
  const signin = client && usableUrl(pub);
  const connect = signin && tokenKeyReady();
  let why = null;
  if (!client) why = 'Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET';
  else if (!usableUrl(pub)) why = 'Set STARBASE_PUBLIC_URL (https://…) first';
  else if (!connect) why = 'Connections need GOOGLE_TOKEN_KEY (32+ random characters)';
  return { signin, connect, why, redirectUri: signin ? redirectUri() : null };
};

// The campaign's own rules for Google sign-in (workspace settings.google):
// on unless a manager turned it off; at most one Google Workspace domain.
export const signinRules = (settings) => {
  const g = settings?.google || {};
  return { signin: g.signin !== false, domain: g.domain ? String(g.domain) : null };
};
