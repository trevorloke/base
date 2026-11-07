import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { error, json, rateLimited } from "@/lib/server/api";
import { applyInboundConsent, bearerMatches, inboundConsentSchema, schemaError } from "@/lib/server/starbase-inbound";

// POST /api/in/consent: a withdrawal made in Starbase, applied here. Called by
// Starbase's server with Authorization: Bearer $STARBASE_INBOUND_KEY and an
// Idempotency-Key; see src/lib/server/starbase-inbound.ts and SETUP.md.
// Answers in Starbase's own style: { ok: true, … } or { error }.

const MAX_BODY = 10_000;

export async function POST(req: NextRequest) {
  // Before the key check, so guessing keys is slow too.
  if (rateLimited(req, "in-consent", 120)) return error("more than 120 requests a minute", 429);
  const key = env.starbaseInboundKey;
  if (!key) return error("Inbound consent is off: STARBASE_INBOUND_KEY isn't set on the website.", 503);
  if (!bearerMatches(req.headers.get("authorization"), key)) return error("a valid key goes in the Authorization header: Bearer …", 401);
  if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) return error("send JSON (Content-Type: application/json)", 415);
  const idempotencyKey = (req.headers.get("idempotency-key") ?? "").trim();
  if (!idempotencyKey || idempotencyKey.length > 200) return error("send an Idempotency-Key header (1 to 200 characters)", 400);

  const raw = await req.text();
  if (raw.length > MAX_BODY) return error("the body is too large", 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return error("the body isn’t JSON", 400);
  }
  const parsed = inboundConsentSchema.safeParse(body);
  if (!parsed.success) return error(schemaError(parsed.error), 400);

  try {
    const answer = await applyInboundConsent(getDb(), parsed.data, idempotencyKey, raw);
    return json(answer.body, answer.status);
  } catch (err) {
    console.error("Could not apply a consent change from Starbase", err);
    return error("Something went wrong applying it; try again.", 500);
  }
}
