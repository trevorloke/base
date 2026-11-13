// Back from Google, connecting a purpose (Gmail, Drive, Calendar…): checked
// again now (a role may have changed in ten minutes), then the person's one
// grant takes the new refresh token, sealed, and the purpose. Every refusal
// after the exchange revokes what Google just handed over (unless another
// row holds that Google account), so no unwanted grant stays at Google.
import { newId, runAction } from '../../lib/events.js';
import { sealToken, tokenKeyReady } from '../../lib/google/seal.js';
import { domainFor, mayUse, purposeOf } from '../../lib/google/purposes.js';
import { grantPayload, grantRowOf, revokeIfUnshared, forgetAccess } from '../../lib/google/tokens.js';
import { withCode } from './routes.js';

class OtherAccount extends Error {}

export const connectBack = async (c, db, flow, who, tokens) => {
  // The key went between start and back: nothing can be kept (or sealed
  // for a revoke).
  if (!tokenKeyReady()) return { code: 'not-set-up' };
  const purpose = purposeOf(flow.purpose);
  const scopes = String(tokens?.scope || '').split(/\s+/).filter(Boolean);
  const refresh = tokens?.refresh_token ? String(tokens.refresh_token) : null;
  const handed = refresh || (tokens?.access_token ? String(tokens.access_token) : null);
  const refuse = async (code) => {
    if (handed) await revokeIfUnshared(db, { workspaceId: flow.workspace_id, sub: who.sub, sealed: sealToken(handed) });
    return { code };
  };
  if (!purpose || !(await mayUse(db, { userId: flow.user_id, workspaceId: flow.workspace_id }, purpose))) return refuse('not-allowed');
  if (purpose.scopes.some((s) => !scopes.includes(s))) return refuse('missing-scope');
  const settings = (await db.query('select settings from workspaces where id = $1', [flow.workspace_id])).rows[0]?.settings;
  const domain = domainFor(purpose, settings);
  if (domain && who.hd !== domain) return refuse('domain');
  if (!refresh) return refuse('unavailable');
  const sealed = sealToken(refresh);
  try {
    await runAction(db, { workspaceId: flow.workspace_id, actorId: flow.user_id, action: 'google.connect' }, async (tx, emit) => {
      const row = await grantRowOf(tx, flow.user_id, { lock: true });
      if (row && row.sub !== who.sub) throw new OtherAccount();
      const purposes = [...new Set([...(row?.purposes || []), purpose.key])];
      if (row) {
        await tx.query(
          `update google_grants set refresh_sealed = $2, scopes = $3, purposes = $4, email = $5, hd = $6,
             state = 'ok', said = null, paused_until = null, updated_at = now() where id = $1`,
          [row.id, sealed, scopes, purposes, who.email, who.hd],
        );
        forgetAccess(row.id);
        emit('google_grant', row.id, 'update', grantPayload(flow.user_id, purposes, 'ok'));
      } else {
        const id = newId();
        await tx.query(
          `insert into google_grants (id, user_id, sub, email, hd, scopes, purposes, refresh_sealed)
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [id, flow.user_id, who.sub, who.email, who.hd, scopes, purposes, sealed],
        );
        emit('google_grant', id, 'create', grantPayload(flow.user_id, purposes, 'ok'));
      }
    });
  } catch (e) {
    if (e instanceof OtherAccount) return refuse('other-account');
    throw e;
  }
  return { to: withCode(flow.back, 'connected') };
};
