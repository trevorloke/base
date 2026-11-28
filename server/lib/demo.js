// The public demo: the base.win website frames a staging server and signs
// each visitor in as one demo account, with no password. Two settings, and
// neither is ever read on production — a client's server can't be framed by
// another site (voter data on screen) or opened without a sign-in, whatever
// its settings say.
//   BASE_FRAME_HOSTS   the sites that may frame the app, comma-separated
//                          origins (https://base.win,https://www.base.win)
//   BASE_DEMO_EMAIL    the account every demo visitor is signed in as,
//                          one already in the campaign. A visitor can do
//                          whatever it can, so the campaign must be the
//                          sample one (lib/samplecampaign.js)
import { setting } from '@starbase/shared/old-names';
import { envName } from './org.js';

const allowed = () => envName() !== 'production';

export const frameHosts = () => {
  if (!allowed()) return [];
  const out = [];
  for (const raw of String(setting('BASE_FRAME_HOSTS') || '').split(',')) {
    let u;
    try { u = new URL(raw.trim()); } catch { continue; }
    if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') continue;
    if (!out.includes(u.origin)) out.push(u.origin);
  }
  return out;
};

export const demoEmail = () => {
  if (!allowed()) return '';
  const e = String(setting('BASE_DEMO_EMAIL') || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+$/.test(e) ? e.slice(0, 320) : '';
};

// Whether an address is the demo account's (never on production).
export const isDemoAccount = (email) => Boolean(demoEmail()) && String(email ?? '').trim().toLowerCase() === demoEmail();
// The demo account's by its user id.
export const isDemoUser = async (db, userId) => {
  if (!demoEmail() || !userId) return false;
  const row = (await db.query('select email from users where id = $1', [userId])).rows[0];
  return isDemoAccount(row?.email);
};
