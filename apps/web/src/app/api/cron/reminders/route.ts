import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { cronAllowed } from "@/lib/server/cron";
import { error, json } from "@/lib/server/api";
import { sendReminders } from "@/lib/server/comms";

// Day-before reminders for event RSVPs and volunteer shifts (whatever is on
// tomorrow's date in Pacific time). A Render cron job calls this once a day
// with "Authorization: Bearer $CRON_SECRET" (SETUP.md, "Scheduled jobs").
// Without CRON_SECRET it refuses every call on Render, like /api/cron/email.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (!cronAllowed(req.headers.get("authorization"))) return error("Not allowed.", 401);
  const result = await sendReminders(getDb());
  return json({ ok: true, ...result });
}
