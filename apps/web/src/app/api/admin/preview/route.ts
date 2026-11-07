import { asc, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { adminUsers } from "@/lib/db/schema";
import { adminPreviewAllowed, PREVIEW_OWNER_EMAIL } from "@/lib/preview-mode";
import { redirectTo } from "@/lib/redirect";
import { createSession, requestMeta, SESSION_COOKIE, sessionCookieOptions } from "@/lib/server/admin-auth";
import { safeNext } from "@/lib/server/admin-redirect";
import { audit } from "@/lib/server/audit";

// Preview mode only (see src/lib/preview-mode.ts): sign the visitor in as an
// owner without a password. Anywhere else this route doesn't exist.
export async function GET(req: NextRequest) {
  if (!adminPreviewAllowed()) return new Response("Not found", { status: 404 });
  const db = getDb();
  let [owner] = await db.select().from(adminUsers).where(eq(adminUsers.role, "owner")).orderBy(asc(adminUsers.createdAt)).limit(1);
  if (!owner || !owner.active) {
    [owner] = await db
      .insert(adminUsers)
      .values({ email: PREVIEW_OWNER_EMAIL, name: "Preview owner", role: "owner" })
      .onConflictDoUpdate({ target: adminUsers.email, set: { active: true, role: "owner" } })
      .returning();
  }
  const session = await createSession(db, owner.id, requestMeta(req));
  const res = redirectTo(safeNext(req.nextUrl.searchParams.get("next")), 303);
  res.cookies.set(SESSION_COOKIE, session.value, { ...sessionCookieOptions, maxAge: session.maxAge });
  await audit(owner, "signin", { method: "preview-mode" });
  return res;
}
