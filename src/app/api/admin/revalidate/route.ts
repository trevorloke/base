import { NextResponse } from "next/server";
import { adminOnly } from "@/lib/server/admin-api";
import { audit } from "@/lib/server/audit";
import { invalidate, TAGS } from "@/lib/server/cache";

/**
 * Refresh every public page: throws away all cached data (settings, pages,
 * news, events, products, tracker, counters). Useful after editing the
 * database directly, e.g. a bulk import. Pages rebuild on their next visit.
 */
export async function POST() {
  const auth = await adminOnly("settings");
  if (!auth.ok) return auth.response;
  invalidate(...Object.values(TAGS));
  await audit(auth.user, "cache.refresh");
  return NextResponse.json({ ok: true });
}
