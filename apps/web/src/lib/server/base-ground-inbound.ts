import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/lib/db";
import { auditLog, people } from "@/lib/db/schema";
import { recordConsent } from "./consent";
import { CONSENT_CHANNELS, CONSENT_REASONS } from "./base-ground";

// Withdrawals made in base ground, applied here: POST /api/in/consent with
// Authorization: Bearer $BASE_GROUND_INBOUND_KEY. The body is the same shape the
// website sends to base ground's /in/v1/consent:
//
//   { email?, phone?, channel: "email" | "sms", action: "withdraw" | "grant",
//     reason: "unsubscribe" | "stop" | "preference" | "deletion", at }
//
// A withdrawal is recorded in the consent ledger with source "base-ground" (which
// clears the person's consent and unsubscribes the address from the
// newsletter). A grant is answered but never applied: only withdrawals flow
// between the apps on their own. Nothing here forwards to base ground, so a
// withdrawal that came from there is never echoed back.
//
// Each call carries an Idempotency-Key. The answer is kept in the audit log
// (entity "base-ground-consent", the key as its id): the same key with the same
// body gets the first answer again, with replayed: true; with another body, 409.

export const INBOUND_ENTITY = "base-ground-consent";

/** Whether an Authorization header carries the inbound key. Constant time; false when no key is configured. */
export function bearerMatches(header: string | null | undefined, key: string | null | undefined): boolean {
  if (!key) return false;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  if (!m) return false;
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(m[1]), digest(key));
}

const trimmed = (max: number) => z.string().trim().min(1).max(max);

export const inboundConsentSchema = z
  .object({
    email: trimmed(320).toLowerCase().pipe(z.email()).optional().nullable(),
    phone: trimmed(40).optional().nullable(),
    channel: z.enum(CONSENT_CHANNELS),
    action: z.enum(["withdraw", "grant"]),
    reason: z.enum(CONSENT_REASONS),
    at: z.iso.datetime({ offset: true }),
  })
  .strict()
  .refine((v) => v.email || v.phone, { message: "an email or a phone" });

export type InboundConsent = z.output<typeof inboundConsentSchema>;

export type InboundAnswer = { status: number; body: Record<string, unknown> };

/** Error text in base ground's style for a refused body: "channel: Invalid option…". */
export function schemaError(error: z.ZodError): string {
  const issue = error.issues[0];
  return `${issue.path.length ? `${issue.path.join(".")}: ` : ""}${issue.message}`;
}

/** The ten digits of a Canadian number, or null. */
export function phoneDigits(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  return digits.length === 10 ? digits : null;
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function matchingPeople(q: Tx, c: InboundConsent): Promise<{ id: string; email: string }[]> {
  const found = new Map<string, { id: string; email: string }>();
  if (c.email) {
    for (const p of await q.select({ id: people.id, email: people.email }).from(people).where(eq(people.email, c.email))) found.set(p.id, p);
  }
  const digits = phoneDigits(c.phone);
  if (digits) {
    const byPhone = await q
      .select({ id: people.id, email: people.email })
      .from(people)
      .where(sql`regexp_replace(coalesce(${people.phone}, ''), '\\D', '', 'g') in (${digits}, ${"1" + digits})`);
    for (const p of byPhone) found.set(p.id, p);
  }
  return [...found.values()];
}

/**
 * Apply one call from base ground, once per Idempotency-Key. `raw` is the body
 * exactly as received, to tell a replay from a reused key.
 */
export async function applyInboundConsent(db: Db, c: InboundConsent, idempotencyKey: string, raw: string): Promise<InboundAnswer> {
  const hash = createHash("sha256").update(raw).digest("hex");
  return db.transaction(async (tx) => {
    // Two deliveries of the same key at once: the second waits, then replays.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${INBOUND_ENTITY}:${idempotencyKey}`}))`);
    const [previous] = await tx
      .select({ details: auditLog.details })
      .from(auditLog)
      .where(and(eq(auditLog.entity, INBOUND_ENTITY), eq(auditLog.entityId, idempotencyKey)))
      .limit(1);
    if (previous) {
      const d = (previous.details ?? {}) as { hash?: string; answer?: Record<string, unknown> };
      if (d.hash !== hash) return { status: 409, body: { error: "that Idempotency-Key was used with a different body" } };
      return { status: 200, body: { ...(d.answer ?? { ok: true }), replayed: true } };
    }

    let answer: Record<string, unknown>;
    if (c.action === "grant") {
      // Someone saying yes again is for them to do on this site, where the ledger records the wording they saw.
      answer = { ok: true, applied: 0, note: "Grants are not applied from base ground; only withdrawals are." };
    } else {
      const matches = await matchingPeople(tx, c);
      const wording = `Withdrawn in base ground (${c.reason}) at ${c.at}`;
      const ledger = tx as unknown as Db;
      const purpose = c.channel === "sms" ? "sms" : "updates";
      for (const m of matches) await recordConsent(ledger, { personId: m.id, email: m.email, channel: c.channel, purpose, action: "withdraw", wording, source: "base-ground" });
      // An address nobody here has yet still goes in the ledger, so a later public form can't sign it up again
      // (and an email withdrawal unsubscribes it from the newsletter).
      if (c.email && !matches.some((m) => m.email === c.email)) await recordConsent(ledger, { personId: null, email: c.email, channel: c.channel, purpose, action: "withdraw", wording, source: "base-ground" });
      answer = { ok: true, applied: matches.length };
    }

    await tx.insert(auditLog).values({
      action: c.action === "grant" ? "consent.base-ground-grant-ignored" : "consent.base-ground-withdraw",
      entity: INBOUND_ENTITY,
      entityId: idempotencyKey,
      // What was decided, never the address or number (those are in the consent ledger).
      details: { hash, answer, channel: c.channel, reason: c.reason, at: c.at },
    });
    return { status: 200, body: answer };
  });
}
