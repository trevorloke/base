// The only way Drive code gets a Google connection: driveGrant. A second
// guard beside GSI's own checks (grantFor re-checks the purpose's roles and
// domain each time): anyone outside the desk roles gets nothing, even with
// an old grant still stored, so a volunteer granted Outreach or Media —
// whom mayRun lets run a blast.* action — never reaches Google.
//
//   deskOnly(ctx)                throws 403 "Google Drive is for the desk"
//   driveGrant(db, ctx)          → GSI's grant | null
//   usableGrant(db, ctx)         → a grant in state 'ok', or throws the words
//   gate(ctx)                    setup and the campaign's switch, or throws
import { httpError } from '../../actions/util.js';
import { grantFor } from '../../lib/google/tokens.js';
import { purposeOf } from '../../lib/google/purposes.js';
import { clockAt } from '../../lib/org.js';
import { DESK, driveRules, driveSetup } from './config.js';

export const FOR_THE_DESK = 'Google Drive is for the desk';
const rolesOf = () => purposeOf('drive')?.roles || DESK;
export const isDesk = (ctx) => rolesOf().includes(ctx?.role) && !ctx?.candidate;
export const deskOnly = (ctx) => { if (!isDesk(ctx)) throw httpError(403, FOR_THE_DESK); };

export const driveGrant = async (db, ctx) => {
  if (!isDesk(ctx) || !ctx.user?.id) return null;
  return grantFor(db, { userId: ctx.user.id, workspaceId: ctx.workspaceId }, 'drive');
};

// What stops someone before any Google call (decision 11's table).
export const grantWords = (g) => {
  if (!g) return [409, 'Connect Google Drive first'];
  if (g.state === 'ok') return null;
  if (g.state === 'reconnect') return [409, 'Connect Google Drive again'];
  if (g.state === 'not-allowed') return [403, FOR_THE_DESK];
  return [409, g.said || 'Connect Google Drive again'];
};
export const usableGrant = async (db, ctx) => {
  const g = await driveGrant(db, ctx);
  const no = grantWords(g);
  if (no) throw httpError(...no);
  return g;
};

export const gate = (ctx) => {
  deskOnly(ctx);
  if (!driveSetup().ok) throw httpError(409, 'Google Drive isn’t set up — see Settings → Services');
  const rules = driveRules(ctx.workspace?.settings);
  if (!rules.on) throw httpError(409, 'Google Drive is off for this campaign');
  return rules;
};
// A Google refusal before a write, in plain words (429: when to try again).
export const NOT_PICKED = 'base.win can only open files you pick — pick it again.';
const PICK_AGAIN = ['notFound', 'appNotAuthorizedToFile'];
// picked: the file is one the person picked — Google's "not found" means
// base.win may not open it (drive.file), so they pick it again.
export const refused = (r, { picked = false } = {}) => {
  if (picked && (r.status === 404 || PICK_AGAIN.includes(r.reason))) return httpError(404, NOT_PICKED);
  if (r.trouble?.code === 'paused') {
    const at = r.trouble.until ? clockAt(r.trouble.until) : 'a minute';
    return httpError(429, `Google asked us to wait — try after ${at}`);
  }
  if (r.trouble?.code === 'reconnect') return httpError(409, 'Connect Google Drive again');
  if (r.trouble?.code === 'unavailable' || r.trouble?.code === 'client') return httpError(503, r.trouble.plain);
  return httpError(409, r.plain);
};
