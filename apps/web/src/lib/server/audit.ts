import "server-only";
import { getDb, type Db } from "@/lib/db";
import { auditLog } from "@/lib/db/schema";
import type { AdminUser } from "./admin-auth";

/** Record who did what in the admin. Never throws: an audit failure must not undo the action. */
export async function audit(user: AdminUser | null, action: string, details?: Record<string, unknown>, entity?: string, entityId?: string, db?: Db): Promise<void> {
  try {
    await (db ?? getDb())
      .insert(auditLog)
      .values({ userId: user?.id ?? null, userEmail: user?.email ?? null, action, entity: entity ?? null, entityId: entityId ?? null, details: details ? trim(details) : null });
  } catch (err) {
    console.error("audit log write failed", err);
  }
}

// Keep entries readable: long text (page bodies, emails) is cut, secrets are not logged.
function trim(details: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details)) {
    if (/password|secret|token/i.test(k)) continue;
    out[k] = typeof v === "string" && v.length > 300 ? v.slice(0, 300) + "…" : v;
  }
  return out;
}
