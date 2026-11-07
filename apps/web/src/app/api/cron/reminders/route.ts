import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { error, json } from "@/lib/server/api";
import { sendReminders } from "@/lib/server/comms";

// Day-before reminders for event RSVPs and volunteer shifts (whatever is on
// tomorrow's date in Surrey). Vercel Cron calls this once a day (see vercel.json) with "Authorization: Bearer
// $CRON_SECRET" (on Render, a Cron Job does; see SETUP.md). Without
// CRON_SECRET it refuses every call on Vercel and Render, like /api/cron/email.
// Long enough to work through a backlog; Vercel allows 60 seconds on every plan.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (env.cronSecret ? auth !== `Bearer ${env.cronSecret}` : process.env.VERCEL || process.env.RENDER) return error("Not allowed.", 401);
  const result = await sendReminders(getDb());
  return json({ ok: true, ...result });
}
