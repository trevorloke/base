import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { clientIp, rateLimited } from "@/lib/server/api";
import { recordPageView } from "@/lib/server/visits";
import { bareHost, isBotUserAgent } from "@/lib/visits";

// The visit counter's beacon (src/components/VisitBeacon.tsx) posts here on
// every page view. It always answers 204 with no body and sets no cookie:
// a beacon can't do anything with an answer, and an error must never show.
// The IP address and user agent are used for the visitor hash and the bot
// check only, and never stored (see src/lib/server/visits.ts).

const MAX_BODY_BYTES = 2048;
/** Page views per IP address per minute; a person clicking around never gets near it. */
const PER_MINUTE = 120;

const done = () => new Response(null, { status: 204, headers: { "cache-control": "no-store" } });

function hostOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return bareHost(new URL(value.includes("://") ? value : `http://${value}`).hostname);
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  const userAgent = req.headers.get("user-agent") ?? "";
  if (isBotUserAgent(userAgent)) return done();
  if (rateLimited(req, "visits", PER_MINUTE)) return done();
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return done();

  const ownHosts = [hostOf(env.siteUrl), hostOf(req.headers.get("x-forwarded-host")?.split(",")[0]?.trim()), hostOf(req.headers.get("host"))].filter(
    (h): h is string => !!h,
  );
  // Browsers send Origin with a beacon; one from another site isn't a visit to this one.
  const origin = hostOf(req.headers.get("origin"));
  if (origin && !ownHosts.includes(origin)) return done();

  let body: Record<string, unknown>;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return done();
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return done();
    body = parsed as Record<string, unknown>;
  } catch {
    return done();
  }

  try {
    await recordPageView(getDb(), {
      path: body.path,
      referrer: body.referrer,
      source: body.source,
      ref: body.ref,
      ip: clientIp(req) ?? "",
      userAgent,
      ownHosts,
    });
  } catch (err) {
    console.error("A page view could not be recorded", err);
  }
  return done();
}
