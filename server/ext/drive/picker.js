// The Picker's token: one that can do nothing but Drive, or nothing at all.
// GSI's narrowToken refreshes the stored grant with scope=drive.file and
// keeps the token in memory; Google's own tokeninfo then says what the
// token holds, and a token holding anything besides drive.file and sign-in
// (a person who also connected Gmail, if Google ignored the narrowing) is
// thrown away, never handed out. narrowToken hands back no scope of its
// own, so this one check is the only way to know.
//
//   pickerToken(db, g) → { token, expiresAt } | { unsafe: true } | { trouble }
import { oauthBase } from '../../lib/google/config.js';
import { narrowToken } from '../../lib/google/tokens.js';
import { DRIVE_FILE } from './config.js';

const ALLOWED = new Set([DRIVE_FILE, 'openid', 'email', 'https://www.googleapis.com/auth/userinfo.email']);
const checked = new Map(); // token → true (narrowed) | false
const said = new Set();
const sayOnce = (line) => { if (!said.has(line)) { said.add(line); console.log(line); } };
export const _resetPickerForTest = () => { checked.clear(); said.clear(); };

// Google's own word on what a token holds (POST, so it never sits in a log).
const scopesOf = async (token) => {
  try {
    const res = await fetch(`${oauthBase()}/tokeninfo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ access_token: token }).toString(),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    return typeof body?.scope === 'string' ? body.scope.split(' ').filter(Boolean) : null;
  } catch {
    return null;
  }
};

export const pickerToken = async (db, g) => {
  const t = await narrowToken(db, g, [DRIVE_FILE]);
  // Google refused the narrower scope (invalid_scope): never a wider token.
  if (t.trouble?.code === 'denied') {
    sayOnce('drive: Google did not narrow the Picker token — the Picker is off');
    return { unsafe: true };
  }
  if (t.trouble) return { trouble: t.trouble };
  if (!checked.has(t.token)) {
    const scopes = await scopesOf(t.token);
    if (!scopes) return { trouble: { code: 'unavailable', plain: 'Google isn’t answering right now. Try again in a minute.' } };
    if (checked.size > 2000) checked.clear();
    checked.set(t.token, scopes.every((s) => ALLOWED.has(s)));
  }
  if (!checked.get(t.token)) {
    sayOnce('drive: Google did not narrow the Picker token — the Picker is off');
    return { unsafe: true };
  }
  sayOnce('drive: picker tokens are narrowed');
  return { token: t.token, expiresAt: t.expiresAt };
};
