import "server-only";
import { createHash } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { authTokens } from "@/lib/db/schema";
import { findPersonByEmail } from "@/lib/server/people";

// The preference centre looks a token up without redeeming it, so the page
// can show the current state; only a save consumes it. The hash mirrors
// src/lib/server/tokens.ts (sha256 of the raw value).
const hash = (raw: string) => createHash("sha256").update(raw).digest("hex");

export async function peekPreferencesToken(db: Db, raw: string): Promise<{ email: string } | null> {
  if (!raw || raw.length > 200) return null;
  const [row] = await db
    .select({ email: authTokens.email })
    .from(authTokens)
    .where(and(eq(authTokens.tokenHash, hash(raw)), eq(authTokens.purpose, "preferences"), isNull(authTokens.usedAt), gt(authTokens.expiresAt, new Date())))
    .limit(1);
  return row ?? null;
}

export type PreferenceState = {
  email: string;
  firstName: string | null;
  updates: boolean;
  sms: boolean;
  locale: string | null;
  postalCode: string | null;
  phone: string | null;
};

/** What the person has chosen so far: the current-state columns on `people`. */
export async function preferenceState(db: Db, email: string): Promise<PreferenceState> {
  const person = await findPersonByEmail(db, email);
  return {
    email,
    firstName: person?.firstName ?? null,
    updates: Boolean(person?.contactConsentAt),
    sms: Boolean(person?.smsConsentAt),
    locale: person?.locale ?? null,
    postalCode: person?.postalCode ?? null,
    phone: person?.phone ?? null,
  };
}
