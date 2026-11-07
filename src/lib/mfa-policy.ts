// Who must use two-factor sign-in. Pure (no database, no Node APIs), so the
// server and tests share it, like src/lib/preview-mode.ts.
import { adminPreviewAllowed } from "@/lib/preview-mode";

type Env = Record<string, string | undefined>;
type Role = "owner" | "admin" | "organizer" | "editor";

/** Roles that must set up two-factor sign-in before the admin opens for them. */
export const MFA_REQUIRED_ROLES: readonly Role[] = ["owner", "admin"];

/**
 * Whether owners and administrators must enrol. Always, except:
 * - the local preview mode (src/lib/preview-mode.ts), which is local only;
 * - ADMIN_MFA_REQUIRED=0, honoured only off production (NODE_ENV is not
 *   "production") or under the e2e runner (E2E=1), and ignored on Render
 *   (RENDER=true) and on Vercel, so the live site can't lose the requirement
 *   by a stray setting.
 */
export function mfaEnforced(env: Env = process.env): boolean {
  if (adminPreviewAllowed(env)) return false;
  if (env.ADMIN_MFA_REQUIRED !== "0") return true;
  if (env.RENDER === "true" || env.VERCEL === "1" || env.VERCEL_ENV === "production") return true;
  const switchHonoured = env.NODE_ENV !== "production" || env.E2E === "1";
  return !switchHonoured;
}

/** True when this account has to set up two-factor sign-in before using the admin. */
export function mustEnrol(role: Role, totpEnabled: boolean, env: Env = process.env): boolean {
  return !totpEnabled && MFA_REQUIRED_ROLES.includes(role) && mfaEnforced(env);
}
