import "server-only";
import { timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

/**
 * May this request run a scheduled job? Render's cron jobs call
 * /api/cron/* with "Authorization: Bearer $CRON_SECRET" (scripts/cron.mjs).
 * Without CRON_SECRET, a hosted copy (Render) refuses every call; a local
 * copy answers anyone who can reach it.
 */
export function cronAllowed(authorization: string | null, secret = env.cronSecret, hosted = Boolean(process.env.RENDER || process.env.VERCEL)): boolean {
  if (!secret) return !hosted;
  const expected = Buffer.from(`Bearer ${secret}`);
  const given = Buffer.from(authorization ?? "");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
