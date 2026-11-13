// Google on the web side (the server's half is ext/google and lib/google):
// every Google button is a plain link to the one start route, which sends
// the browser to Google and back.
//
//   googleHere()        false in the installed home-screen app: Google's
//                       page opens in a separate browser there, whose
//                       cookies aren't the app's — until a check on real
//                       phones proves otherwise, those screens say
//                       INSTALLED instead of showing a Google button
//   googleStart(kind, { app, back, purpose })   the start link (at() puts
//                       the client's path in front)
//   appName(mode)       'field' | 'desk' for the start route
//   herePath()          this screen's path without the client's path, for
//                       back= (a desk link comes back to the desk)
//   googleWords(code, { domain, address, email, where, what })   what
//                       ?google=<code> says; where 'profile' (signed in)
//                       never says “use your password”
//   markSignin() / takeSignin()   a Google sign-in started in this tab: the
//                       app places the person (mode.js landing) when it opens
import { BASE, NS, at } from '../base.js';

export const INSTALLED = 'Open base.win in your browser to use Google.';

export const googleHere = () => {
  if (typeof window === 'undefined') return true;
  try {
    if (window.matchMedia?.('(display-mode: standalone)').matches) return false;
  } catch { /* old browsers: not installed */ }
  return window.navigator?.standalone !== true;
};

export const appName = (mode) => (mode === 'admin' ? 'desk' : 'field');

export const herePath = () => {
  const p = typeof window === 'undefined' ? '/' : window.location.pathname;
  return BASE && (p === BASE || p.startsWith(`${BASE}/`)) ? (p.slice(BASE.length) || '/') : p;
};

export const googleStart = (kind, { app = 'field', back, purpose } = {}) => {
  const q = new URLSearchParams({ do: kind, app });
  if (purpose) q.set('for', purpose);
  if (back) q.set('back', back);
  return at(`/api/auth/google/start?${q}`);
};

const SIGNIN_KEY = `${NS}google-signin`;
export const markSignin = () => { try { sessionStorage.setItem(SIGNIN_KEY, '1'); } catch { /* private mode */ } };
export const takeSignin = () => {
  try {
    const had = sessionStorage.getItem(SIGNIN_KEY) === '1';
    sessionStorage.removeItem(SIGNIN_KEY);
    return had;
  } catch { return false; }
};

// Sign in (decision 15) and Your profile (decision 17) share most words.
const WORDS = {
  'no-account': 'That Google account isn’t linked to base.win. Sign in with your password, then link Google on Your profile.',
  removed: 'Your account isn’t on this campaign’s team any more. Ask your campaign manager.',
  off: 'Google sign-in is turned off for this campaign. Use your password.',
  cancelled: 'Google sign-in was cancelled.',
  blocked: 'Your Google Workspace admin hasn’t allowed base.win — ask them to mark it Trusted, or use your password.',
  expired: 'That took too long — try again.',
  'too-many': 'Too many tries — wait 15 minutes, then try again.',
  unavailable: 'Google isn’t answering right now. Try again in a minute, or use your password.',
  'not-set-up': 'Google sign-in isn’t working on this server — use your password, and tell your campaign manager.',
  linked: 'Linked — next time, Sign in with Google',
  connected: 'Connected',
  taken: 'That Google account is already linked to someone else here.',
  'missing-scope': 'Google didn’t give base.win what it needs. Try again and tick every box.',
  'not-allowed': 'You can’t connect this.',
  'two-step-first': 'Set up two-step sign-in first, then try again.',
};
export const GOOD = ['linked', 'connected'];

// Your profile and a feature's Connect: the person is already signed in, so
// none of these tells them to use their password or calls it sign-in.
// what names the thing being connected ('Gmail' on a person's page).
const SIGNED_IN = (what) => ({
  cancelled: `Connecting ${what} was cancelled.`,
  blocked: 'Your Google Workspace admin hasn’t allowed base.win — ask them to mark it Trusted.',
  unavailable: 'Google isn’t answering right now. Try again in a minute.',
  off: 'Google is turned off for this campaign. Ask your campaign manager.',
  'not-set-up': 'Google isn’t working on this server — tell your campaign manager.',
  'two-step-first': 'Set up two-step on Your profile first, then try again.',
});

export const googleWords = (code, { domain, address, email, where = 'signin', what = 'Google' } = {}) => {
  const said = baseWords(code, { domain, address, email, where });
  if (where === 'signin' || GOOD.includes(code)) return said;
  const own = SIGNED_IN(what)[code];
  if (own) return own;
  return /password|sign[ -]?in/i.test(said) ? `Connecting ${what} didn’t work. Try again.` : said;
};

const baseWords = (code, { domain, address, email, where }) => {
  if (code === 'domain') {
    return where === 'signin'
      ? `Only Google accounts at ${domain || 'your campaign’s domain'} can sign in here. Use your password instead.`
      : `That Google account isn’t at ${domain || 'your campaign’s domain'}.`;
  }
  if (code === 'other-account') return `You’re connected as ${email || 'another Google account'}. Disconnect it first to use another Google account.`;
  if (code === 'wrong-address') return address ? `Open base.win at ${address} to use Google here.` : 'Open base.win at its usual address to use Google here.';
  return WORDS[code] || 'Google sign-in didn’t work. Use your password.';
};

// "2:30 pm", in the browser's own clock.
export const clockTime = (iso) => new Date(iso).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' })
  .replace(/\./g, '').replace(/\s+/g, ' ');
