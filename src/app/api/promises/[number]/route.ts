import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { promiseRecordToJson } from "@/lib/tracker";
import { loadTracker } from "@/lib/server/tracker";

export const dynamic = "force-dynamic";

const headers = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
  "cache-control": "public, max-age=60",
};

/** One promise in full: the record, the delivery test and every update. */
export async function GET(_req: Request, ctx: RouteContext<"/api/promises/[number]">) {
  const raw = (await ctx.params).number;
  const n = /^\d{1,4}$/.test(raw) ? Number(raw) : 0;
  const { promises } = await loadTracker();
  const promise = promises.find((p) => p.number === n);
  if (!promise) return NextResponse.json({ error: "No such promise." }, { status: 404, headers });
  return NextResponse.json(promiseRecordToJson(promise, env.siteUrl, promises.length), { headers });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers });
}
