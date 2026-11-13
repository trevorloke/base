// Settings → Services: "Gmail (send as yourself)". No settings of its own
// (the client and the key are on the Google row) and no Check: Google's
// row proves the client, and each person's Send me a test proves sending
// (gmail.send alone can't read anything, so there is no harmless call).
import { googleSetup } from '../../lib/google/config.js';
import { apiOffNow, gmailTestBaseInUse } from './send.js';
import { gmailSettings } from './actions.js';

const API_OFF = 'Gmail API is off in Google Cloud — turn it on (step 1 of the Gmail steps in GOING-LIVE), then Check on the Google row';

// The row for one campaign (its switch, and how many here have connected).
export const gmailService = async (db, workspaceId) => {
  const setup = googleSetup().connect;
  let on = false;
  let n = 0;
  if (setup && db) {
    on = gmailSettings((await db.query('select settings from workspaces where id = $1', [workspaceId])).rows[0]?.settings).on;
    n = (await db.query(
      `select count(*)::int as n from google_grants g join memberships m on m.user_id = g.user_id and m.workspace_id = $1
       where 'gmail.send' = any(g.purposes)`,
      [workspaceId],
    )).rows[0].n;
  }
  const lines = [
    !setup ? 'Set up the Google row first' : on ? `On · ${n.toLocaleString('en-CA')} connected` : 'Off',
    apiOffNow() && API_OFF,
    gmailTestBaseInUse() && 'test address in use (GMAIL_API_BASE)',
  ].filter(Boolean);
  return {
    key: 'gmail', name: 'Gmail (send as yourself)',
    for: 'One email to one person, from a staff member’s own Gmail',
    launch: false, missing: [], set: [],
    state: !setup ? 'missing' : on ? 'ready' : 'default',
    detail: lines.join(' · '), lines,
    checkable: false, panel: 'gmail',
  };
};
