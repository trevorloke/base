import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { summaryToJson } from "@/lib/tracker";
import { trackerSummary } from "@/lib/server/tracker";

export const dynamic = "force-dynamic";

const headers = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
  "cache-control": "public, max-age=60",
};

/** Counts by status and the last update date: what the embeddable widget shows. */
export async function GET() {
  const summary = await trackerSummary();
  return NextResponse.json({ ...summaryToJson(summary, env.siteUrl), generatedAt: new Date().toISOString() }, { headers });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers });
}
