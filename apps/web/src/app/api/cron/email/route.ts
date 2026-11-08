import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { cronAllowed } from "@/lib/server/cron";
import { error, json } from "@/lib/server/api";
import { drainQueue, pruneEmailBodies } from "@/lib/server/email";
import { deliverOutbox } from "@/lib/server/base-ground-outbox";
import { pruneVisits } from "@/lib/server/visits";

// Sends anything still queued (campaigns normally drain right after "Send"),
// then anything still waiting for base ground (sign-ups normally go right after
// the form; this catches retries and outages). A Render cron job calls it
// daily with "Authorization: Bearer $CRON_SECRET" (SETUP.md, "Scheduled
// jobs"); it can run more often. Without CRON_SECRET it refuses every call
// on Render; elsewhere (a local copy) it answers anyone who can reach it.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (!cronAllowed(req.headers.get("authorization"))) return error("Not allowed.", 401);
  const db = getDb();
  const started = Date.now();
  const result = await drainQueue(db, 35_000);
  if (Math.random() < 0.02) await pruneEmailBodies(db);
  // The time the email left, within the 60 seconds; deliverOutbox never throws.
  const baseGround = await deliverOutbox(db, Math.max(5_000, 45_000 - (Date.now() - started)));
  // Page views are kept for 13 months; old visitor salts go after a day.
  const visits = await pruneVisits(db).catch((err) => {
    console.error("Old page views could not be deleted", err);
    return { deleted: 0, error: true };
  });
  return json({ ok: true, ...result, baseGround, visits });
}
