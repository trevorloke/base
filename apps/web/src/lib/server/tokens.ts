import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { authTokens } from "@/lib/db/schema";
import { env } from "@/lib/env";

export type TokenPurpose = "admin-login" | "admin-mfa" | "admin-base-link" | "admin-base-link-email" | "member-login" | "newsletter-confirm" | "membership-confirm" | "email-change" | "promise-follow" | "volunteer-cancel" | "preferences";

const hash = (raw: string) => createHash("sha256").update(raw).digest("hex");

/** Create a one-time token and return the raw value to put in a link. */
export async function createToken(db: Db, purpose: TokenPurpose, email: string, options: { ttlMinutes?: number; data?: Record<string, unknown> } = {}): Promise<string> {
  const raw = randomBytes(32).toString("base64url");
  await db.insert(authTokens).values({
    purpose,
    email: email.toLowerCase(),
    tokenHash: hash(raw),
    data: options.data ?? null,
    expiresAt: new Date(Date.now() + (options.ttlMinutes ?? 60) * 60_000),
  });
  return raw;
}

/** Redeem a token exactly once. Returns null if unknown, used or expired. */
export async function consumeToken(db: Db, purpose: TokenPurpose, raw: string): Promise<{ email: string; data: Record<string, unknown> | null } | null> {
  if (!raw || raw.length > 200) return null;
  const [row] = await db
    .update(authTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(authTokens.tokenHash, hash(raw)), eq(authTokens.purpose, purpose), isNull(authTokens.usedAt), gt(authTokens.expiresAt, new Date())))
    .returning({ email: authTokens.email, data: authTokens.data });
  return row ? { email: row.email, data: (row.data as Record<string, unknown> | null) ?? null } : null;
}

/**
 * Read a token without spending it: null if unknown, used or expired. For a
 * step that may be retried (a wrong password) before the token is redeemed
 * with consumeToken.
 */
export async function peekToken(db: Db, purpose: TokenPurpose, raw: string): Promise<{ email: string; data: Record<string, unknown> | null; expiresAt: Date } | null> {
  if (!raw || raw.length > 200) return null;
  const [row] = await db
    .select({ email: authTokens.email, data: authTokens.data, expiresAt: authTokens.expiresAt })
    .from(authTokens)
    .where(and(eq(authTokens.tokenHash, hash(raw)), eq(authTokens.purpose, purpose), isNull(authTokens.usedAt), gt(authTokens.expiresAt, new Date())))
    .limit(1);
  return row ? { email: row.email, data: (row.data as Record<string, unknown> | null) ?? null, expiresAt: row.expiresAt } : null;
}

/** The SHA-256 of a raw token, as stored: lets one token name another without carrying it. */
export function tokenHash(raw: string): string {
  return hash(raw);
}

export function tokenUrl(path: string, raw: string): string {
  const url = new URL(path, env.siteUrl);
  url.searchParams.set("token", raw);
  return url.toString();
}
