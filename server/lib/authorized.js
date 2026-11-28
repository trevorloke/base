// The "Authorized by" rule's server side (shared/site/authorized.js has the
// rule itself): one read per send run of what it needs, and the one check
// every send screen's action makes after the "needed from" date.
//
//   authorizedFor(q, workspaceId)          → { org, legal, tz }
//   authorizedOf(q, workspaceId, opts)     → authorizedLine(org, { tz, legal, ...opts })
//   askBeforeSending(a, input)             throws 409 { needsAuthorized, from }
//       when the line is missing after its date and the desk hasn't said
//       "Send without it" (input.withoutAuthorized); else → { authMissing }
import { authorizedLine, needsConfirm } from '../../shared/site/authorized.js';
import { digestOf } from '../../shared/site/legal-words.js';
import { latestLegal } from '../ext/site/legal.js';

const parseJ = (v, d) => {
  if (typeof v !== 'string') return v ?? d;
  try { return JSON.parse(v); } catch { return d; }
};

// The website's org and the newest approval in each language (an older
// approval is never used). No website set up: nothing, so nothing shows.
export const authorizedFor = async (q, workspaceId) => {
  let org = {};
  let legal = {};
  let tz;
  try {
    const row = (await q.query('select org from site_settings where workspace_id = $1', [workspaceId])).rows[0];
    org = parseJ(row?.org, {}) || {};
    const ws = (await q.query('select settings from workspaces where id = $1', [workspaceId])).rows[0];
    tz = parseJ(ws?.settings, {})?.tz || undefined;
    if (String(org.agentName || '').trim()) {
      const rows = await latestLegal(q, workspaceId);
      legal = Object.fromEntries(Object.entries(rows).map(([lang, r]) => [lang, digestOf(r)]));
    }
  } catch { org = {}; legal = {}; }
  return { org, legal, tz };
};

export const authorizedOf = async (q, workspaceId, opts) => {
  const { org, legal, tz } = await authorizedFor(q, workspaceId);
  return authorizedLine(org, { tz, legal, ...opts });
};

// The error the desk turns into "Send without it · Add it first".
export const NEEDS_AUTHORIZED = 'This goes out without the Authorized by line';
export const askBeforeSending = (a, input = {}) => {
  if (!needsConfirm(a)) return { authMissing: false };
  if (input?.withoutAuthorized === true) return { authMissing: true };
  const e = new Error(`${NEEDS_AUTHORIZED}, which you said is needed from ${a.warn.from}`);
  e.status = 409;
  e.extra = { needsAuthorized: true, from: a.warn.from };
  throw e;
};
// An automatic send can't ask: it goes, and says so on its record.
export const autoMissing = (a) => needsConfirm(a);
