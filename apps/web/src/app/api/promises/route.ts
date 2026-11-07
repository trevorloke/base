import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { promiseToJson } from "@/lib/tracker";
import { loadTracker } from "@/lib/server/tracker";

// The public JSON API. Open to any site (CORS *), read per request from the
// cached loader so it is never more than one admin write behind.
export const dynamic = "force-dynamic";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
  "cache-control": "public, max-age=60",
};

export async function GET() {
  const { promises } = await loadTracker();
  return NextResponse.json(
    promises.map((p) => promiseToJson(p, env.siteUrl, promises.length)),
    { headers: CORS_HEADERS },
  );
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
