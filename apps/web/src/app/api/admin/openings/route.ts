import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { shiftOpenings } from "@/lib/db/schema";
import { error, json } from "@/lib/server/api";
import { adminOnly, readJson } from "@/lib/server/admin-api";
import { audit } from "@/lib/server/audit";
import { invalidate, TAGS } from "@/lib/server/cache";
import { loadOpening, loadOpenings } from "@/lib/server/shifts";
import { createOpeningSchema } from "@/lib/shift-validation";
import { todayInSurrey } from "@/lib/shifts";
import { fieldErrors } from "@/lib/validation";

// Openings are the shifts volunteers sign themselves up for on /volunteer.

/** Upcoming openings with sign-up counts; `?past=1` includes ones that have happened. */
export async function GET(req: NextRequest) {
  const auth = await adminOnly("shifts");
  if (!auth.ok) return auth.response;
  const includePast = req.nextUrl.searchParams.get("past") === "1";
  return json(await loadOpenings(getDb(), { today: todayInSurrey(), includePast }));
}

export async function POST(req: Request) {
  const auth = await adminOnly("shifts");
  if (!auth.ok) return auth.response;
  const parsed = createOpeningSchema.safeParse(await readJson(req));
  if (!parsed.success) return error("Please check the highlighted fields.", 422, fieldErrors(parsed.error));
  const db = getDb();
  const [created] = await db.insert(shiftOpenings).values(parsed.data).returning({ id: shiftOpenings.id });
  await audit(auth.user, "opening.create", parsed.data, "shift_openings", created.id);
  invalidate(TAGS.events, TAGS.counters);
  return json(await loadOpening(db, created.id));
}
