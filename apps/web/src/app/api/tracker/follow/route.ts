import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { trackerPromises } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { error, json, parseBody } from "@/lib/server/api";
import { handle } from "@/lib/server/handle";
import { getSettings } from "@/lib/server/settings";
import { followPromise, followSchema } from "@/lib/server/tracker";

/** Follow one promise: { promiseId, email, consent: true }. Double opt-in when email is configured. */
export async function POST(req: NextRequest) {
  return handle(async () => {
    const parsed = await parseBody(req, followSchema, "promise-follow", { human: true });
    if (!parsed.ok) return parsed.response;
    const db = getDb();
    const promise = await db.query.trackerPromises.findFirst({ where: eq(trackerPromises.id, parsed.data.promiseId), columns: { id: true, number: true, title: true } });
    if (!promise) return error("That promise doesn't exist.", 404, { promiseId: "Unknown promise" });
    const settings = await getSettings();
    const result = await followPromise(db, { promise, email: parsed.data.email }, { siteUrl: env.siteUrl, orgName: settings.org.name, orgEmail: settings.org.email });
    return json({ ok: true, status: result.status });
  });
}
