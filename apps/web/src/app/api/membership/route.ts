import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { json, parseBody } from "@/lib/server/api";
import { handle } from "@/lib/server/handle";
import { createMembership, publicFormContext } from "@/lib/server/payments";
import { membershipSchema } from "@/lib/validation";

/**
 * Responds with {status:"checkout",url} or {status:"received"} and nothing
 * else: it never says whether the email already belongs to a member.
 */
export async function POST(req: NextRequest) {
  return handle(async () => {
    const parsed = await parseBody(req, membershipSchema, "membership", { human: true });
    if (!parsed.ok) return parsed.response;
    return json(await createMembership(getDb(), parsed.data, publicFormContext(req, parsed.data)));
  });
}
