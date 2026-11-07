import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { getDb, type Db } from "@/lib/db";
import { adminUsers, authTokens } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { ActionError } from "./actions";
import { createSession, isLocked, recordAttempt, type AdminUser, type FirstFactor, type RequestMeta } from "./admin-auth";
import { consumeToken, createToken } from "./tokens";
import {
  base32Decode,
  decryptSecret,
  encryptSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  looksLikeRecoveryCode,
  otpauthUri,
  verifyTotp,
} from "./totp";

// Two-factor sign-in for staff: an authenticator-app code (TOTP) after the
// password or email link. Owners and administrators must set it up before
// the admin opens for them; organizers and editors may. The secret is kept
// encrypted (see totp.ts); recovery codes are kept as hashes only.

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// ── Status and enrolment ───────────────────────────────────────────────────

export type TwoFactorStatus = { enabled: boolean; enabledAt: Date | null; pendingSecret: string | null; recoveryCodesLeft: number; secretUnreadable: boolean };

export async function twoFactorStatus(db: Db, userId: string): Promise<TwoFactorStatus> {
  const row = await db.query.adminUsers.findFirst({ where: eq(adminUsers.id, userId), columns: { totpSecret: true, totpEnabledAt: true, recoveryCodes: true } });
  const enabled = Boolean(row?.totpEnabledAt);
  const secret = row?.totpSecret ? decryptSecret(row.totpSecret, env.adminSessionSecret) : null;
  return {
    enabled,
    enabledAt: row?.totpEnabledAt ?? null,
    // A secret waiting for its first code; shown as the QR code until confirmed.
    pendingSecret: !enabled ? secret : null,
    recoveryCodesLeft: row?.recoveryCodes.length ?? 0,
    secretUnreadable: Boolean(row?.totpSecret) && !secret,
  };
}

export function enrolmentUri(secret: string, email: string, issuer: string): string {
  return otpauthUri({ secret, account: email, issuer });
}

/** Start (or start over) setting up an app: a new secret, not yet switched on. */
export async function startEnrolment(db: Db, userId: string): Promise<void> {
  const user = await db.query.adminUsers.findFirst({ where: eq(adminUsers.id, userId), columns: { totpEnabledAt: true } });
  if (!user) throw new ActionError("That account no longer exists.");
  if (user.totpEnabledAt) throw new ActionError("Two-factor sign-in is already on. Turn it off first to move to a new app.");
  await db
    .update(adminUsers)
    .set({ totpSecret: encryptSecret(generateTotpSecret(), env.adminSessionSecret), recoveryCodes: [] })
    .where(and(eq(adminUsers.id, userId), isNull(adminUsers.totpEnabledAt)));
}

/** Switch it on with a code from the app. Returns the recovery codes, to show once. */
export async function confirmEnrolment(db: Db, userId: string, code: string): Promise<string[]> {
  return db.transaction(async (tx) => {
    await lockUser(tx, userId);
    const user = await tx.query.adminUsers.findFirst({ where: eq(adminUsers.id, userId) });
    if (!user) throw new ActionError("That account no longer exists.");
    if (user.totpEnabledAt) throw new ActionError("Two-factor sign-in is already on.");
    const secret = user.totpSecret ? decryptSecret(user.totpSecret, env.adminSessionSecret) : null;
    if (!secret) throw new ActionError("Start the set-up again: the key on this page has expired.");
    const step = verifyTotp(base32Decode(secret), code, { afterStep: await lastUsedStep(tx, user.id, user.email) });
    if (step === null) throw codeError("That code doesn't match. Check the app is set up with the key above and try the newest code.");
    await recordUsedStep(tx, user.id, user.email, step);
    const codes = generateRecoveryCodes();
    await tx
      .update(adminUsers)
      .set({ totpEnabledAt: new Date(), recoveryCodes: codes.map(hashRecoveryCode) })
      .where(eq(adminUsers.id, userId));
    return codes;
  });
}

/** Turn it off, with a code from the app or a recovery code. */
export async function disableTwoFactor(db: Db, userId: string, code: string): Promise<"totp" | "recovery"> {
  return db.transaction(async (tx) => {
    const used = await checkCode(tx, userId, code);
    if (!used) throw codeError("That code doesn't match. Use the newest code from your app, or one of your recovery codes.");
    await tx.update(adminUsers).set({ totpSecret: null, totpEnabledAt: null, recoveryCodes: [] }).where(eq(adminUsers.id, userId));
    return used;
  });
}

/** New recovery codes (the old ones stop working), with a code from the app. */
export async function regenerateRecoveryCodes(db: Db, userId: string, code: string): Promise<string[]> {
  return db.transaction(async (tx) => {
    const used = await checkCode(tx, userId, code, { allowRecovery: false });
    if (!used) throw codeError("That code doesn't match. Use the newest code from your authenticator app.");
    const codes = generateRecoveryCodes();
    await tx.update(adminUsers).set({ recoveryCodes: codes.map(hashRecoveryCode) }).where(eq(adminUsers.id, userId));
    return codes;
  });
}

/** Owners only, from Staff: clear someone else's two-factor set-up. The caller signs them out. */
export async function resetTwoFactor(db: Db, userId: string): Promise<void> {
  await db.update(adminUsers).set({ totpSecret: null, totpEnabledAt: null, recoveryCodes: [] }).where(eq(adminUsers.id, userId));
}

function codeError(message: string): ActionError {
  return new ActionError("Please check the highlighted fields.", { code: message });
}

// ── The second step at sign-in ─────────────────────────────────────────────

export type SecondStepResult =
  | { ok: true; cookie: { value: string; maxAge: number }; user: AdminUser; method: string; next: string }
  /** `pending` replaces the cookie after a wrong code, so the person can try again. */
  | { ok: false; reason: "expired" | "locked" | "invalid"; pending?: { value: string; maxAge: number } };

/**
 * The second step: a code from the app or a recovery code, against the
 * pending token from the first step. Each attempt redeems the token; a
 * wrong code issues a fresh one with the same deadline. Wrong codes count
 * toward the same lockout as wrong passwords.
 */
export async function verifySecondStep(raw: string, code: string, meta: RequestMeta): Promise<SecondStepResult> {
  const db = getDb();
  const token = await consumeToken(db, "admin-mfa", raw);
  const data = token?.data as { userId?: string; method?: FirstFactor; next?: string; until?: number } | null | undefined;
  if (!token || !data?.userId || typeof data.until !== "number" || data.until < Date.now()) return { ok: false, reason: "expired" };
  const user = await db.query.adminUsers.findFirst({ where: and(eq(adminUsers.id, data.userId), eq(adminUsers.active, true)) });
  if (!user || !user.totpEnabledAt || user.email !== token.email) return { ok: false, reason: "expired" };

  const keys = [`ip:${meta.ip ?? "unknown"}`, `email:${user.email}`];
  for (const key of keys) if (await isLocked(db, key)) return { ok: false, reason: "locked" };
  const used = code.trim() ? await db.transaction((tx) => checkCode(tx, user.id, code)) : null;
  for (const key of keys) await recordAttempt(db, key, Boolean(used));
  if (!used) {
    for (const key of keys) if (await isLocked(db, key)) return { ok: false, reason: "locked" };
    const minutes = (data.until - Date.now()) / 60_000;
    const value = await createToken(db, "admin-mfa", user.email, { ttlMinutes: minutes, data });
    return { ok: false, reason: "invalid", pending: { value, maxAge: Math.max(1, Math.ceil(minutes * 60)) } };
  }

  const cookie = await createSession(db, user.id, meta);
  return {
    ok: true,
    cookie,
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
    method: `${data.method ?? "password"}+${used === "totp" ? "totp" : "recovery-code"}`,
    next: data.next ?? "/admin",
  };
}

// ── Checking a code ────────────────────────────────────────────────────────

/**
 * Check a second-factor code for an account with two-factor sign-in on: an
 * app code (never one already used) or, unless refused, a recovery code,
 * which is then used up. Run inside a transaction; it serializes on the
 * account so two requests can't both spend the same code.
 */
export async function checkCode(tx: Tx, userId: string, code: string, options: { allowRecovery?: boolean } = {}): Promise<"totp" | "recovery" | null> {
  await lockUser(tx, userId);
  const user = await tx.query.adminUsers.findFirst({ where: eq(adminUsers.id, userId) });
  if (!user?.totpEnabledAt) return null;
  const typed = code.trim().slice(0, 40);
  if (/^\d{6}$/.test(typed.replace(/\s/g, ""))) {
    const secret = user.totpSecret ? decryptSecret(user.totpSecret, env.adminSessionSecret) : null;
    if (!secret) return null;
    const step = verifyTotp(base32Decode(secret), typed, { afterStep: await lastUsedStep(tx, user.id, user.email) });
    if (step === null) return null;
    await recordUsedStep(tx, user.id, user.email, step);
    return "totp";
  }
  if (options.allowRecovery === false || !looksLikeRecoveryCode(typed)) return null;
  const hash = hashRecoveryCode(typed);
  const [spent] = await tx
    .update(adminUsers)
    .set({ recoveryCodes: sql`array_remove(${adminUsers.recoveryCodes}, ${hash})` })
    .where(and(eq(adminUsers.id, userId), sql`${hash} = any(${adminUsers.recoveryCodes})`))
    .returning({ id: adminUsers.id });
  return spent ? "recovery" : null;
}

async function lockUser(tx: Tx, userId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`admin-mfa:${userId}`}))`);
}

// The last time step an account used is kept on an `admin-mfa` token row
// (already used, so it can never be redeemed), so a code that was seen once,
// over a shoulder or on a recording, can't be used again in its window.
async function lastUsedStep(tx: Tx, userId: string, email: string): Promise<number | null> {
  const [row] = await tx
    .select({ step: sql<string | null>`max((${authTokens.data}->>'step')::bigint)` })
    .from(authTokens)
    .where(and(eq(authTokens.email, email), eq(authTokens.purpose, "admin-mfa"), sql`${authTokens.data}->>'userId' = ${userId}`, gt(authTokens.createdAt, new Date(Date.now() - 10 * 60_000))));
  return row?.step == null ? null : Number(row.step);
}

async function recordUsedStep(tx: Tx, userId: string, email: string, step: number): Promise<void> {
  const now = new Date();
  await tx.insert(authTokens).values({
    purpose: "admin-mfa",
    email,
    tokenHash: createHash("sha256").update(randomBytes(32)).digest("hex"),
    data: { userId, step },
    expiresAt: now,
    usedAt: now,
  });
  // Keep the table small: these rows matter for a few minutes.
  await tx.delete(authTokens).where(and(eq(authTokens.purpose, "admin-mfa"), lt(authTokens.expiresAt, new Date(Date.now() - 24 * 3600_000))));
}
