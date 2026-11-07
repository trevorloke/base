import "server-only";
import { error } from "./api";
import { can, getAdminUser, type AdminUser, type Permission } from "./admin-auth";

/**
 * For admin API routes: the signed-in admin, or a 401/403 response.
 *   const auth = await adminOnly("shifts"); if (!auth.ok) return auth.response;
 */
export async function adminOnly(permission?: Permission): Promise<{ ok: true; user: AdminUser } | { ok: false; response: Response }> {
  const user = await getAdminUser();
  if (!user) return { ok: false, response: error("Not signed in.", 401) };
  if (permission && !can(user, permission)) return { ok: false, response: error("Your role can't do that.", 403) };
  return { ok: true, user };
}

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

/** Postgres unique-constraint violation, whether or not the ORM wrapped the error. */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}
