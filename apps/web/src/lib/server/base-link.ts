import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { adminUsers, baseLinks } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { baseLinkEmail } from "@/lib/email/messages";
import { afterFirstFactor, isLocked, recordAttempt, verifyPassword, type AdminUser, type LoginResult, type RequestMeta, type UserRow } from "./admin-auth";
import { audit } from "./audit";
import { sendEmail } from "./email";
import { getSettings } from "./settings";
import { consumeToken, createToken, peekToken, tokenHash, tokenUrl } from "./tokens";

// Linking a Base Ground login to a staff account here (SUITE.md, "The
// hand-off", step 6). A Base Ground manager can make a ground login for any
// address, so the email Base Ground sends is never enough to open someone's
// admin: the first time, the person proves the staff account is theirs with
// its own password or a one-time link emailed to its address. Until then the
// verified hand-off waits on the server as a one-time token (the
// "admin-base-link" purpose), named by a signed, HttpOnly cookie on this
// browser; the identity never goes in a URL.

/** The cookie naming the waiting hand-off: `<raw token>.<hmac>`. */
export const LINK_COOKIE = "is_admin_base_link";
/** Minutes the person has to prove the account is theirs. */
export const LINK_MINUTES = 15;
/** Path of the page where they do it. */
export const LINK_PAGE = "/admin/login/link";

export type GroundLogin = { client: string; sub: string; email: string };

type PendingData = { userId: string; client: string; sub: string; groundEmail: string; next: string };

export type PendingLink = {
  raw: string;
  data: PendingData;
  account: { id: string; email: string; name: string; passwordSet: boolean };
  expiresAt: Date;
};

function mac(raw: string): string {
  return createHmac("sha256", env.adminSessionSecret).update(`base-link:${raw}`).digest("base64url");
}

function sealCookie(raw: string): string {
  return `${raw}.${mac(raw)}`;
}

/** The raw token a cookie this server signed carries, or null. */
export function openLinkCookie(value: string | undefined): string | null {
  if (!value || value.length > 400) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const raw = value.slice(0, dot);
  const a = Buffer.from(value.slice(dot + 1));
  const b = Buffer.from(mac(raw));
  return a.length === b.length && timingSafeEqual(a, b) ? raw : null;
}

export const linkCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
};

function summary(user: UserRow): AdminUser {
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

/**
 * No link for this Base Ground login: the active staff account with the same
 * email (case-insensitive), and whether it is already linked (to another
 * Base Ground login, since this one has no link). Null when there is none.
 */
export async function findAccountForLinking(db: Db, email: string): Promise<{ user: AdminUser; linked: boolean } | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  const [row] = await db
    .select({ user: adminUsers, linkId: baseLinks.id })
    .from(adminUsers)
    .leftJoin(baseLinks, eq(baseLinks.userId, adminUsers.id))
    .where(and(sql`lower(${adminUsers.email}) = ${normalized}`, eq(adminUsers.active, true)))
    .limit(1);
  return row ? { user: summary(row.user), linked: Boolean(row.linkId) } : null;
}

/** Keep the verified hand-off on the server; the cookie value names it. */
export async function startLinking(db: Db, login: GroundLogin, user: AdminUser, next: string): Promise<{ value: string; maxAge: number }> {
  const data: PendingData = { userId: user.id, client: login.client, sub: login.sub, groundEmail: login.email.slice(0, 320), next };
  const raw = await createToken(db, "admin-base-link", user.email, { ttlMinutes: LINK_MINUTES, data });
  return { value: sealCookie(raw), maxAge: LINK_MINUTES * 60 };
}

function pendingData(data: Record<string, unknown> | null): PendingData | null {
  if (!data) return null;
  const { userId, client, sub, groundEmail, next } = data as Partial<PendingData>;
  if (typeof userId !== "string" || typeof client !== "string" || typeof sub !== "string" || !sub) return null;
  return { userId, client, sub, groundEmail: typeof groundEmail === "string" ? groundEmail : "", next: typeof next === "string" ? next : "/admin" };
}

/** The waiting hand-off this browser's cookie names, without spending it. Null if gone, used, expired or forged. */
export async function readPendingLink(db: Db, cookie: string | undefined): Promise<PendingLink | null> {
  const raw = openLinkCookie(cookie);
  if (!raw) return null;
  const token = await peekToken(db, "admin-base-link", raw);
  const data = pendingData(token?.data ?? null);
  if (!token || !data) return null;
  const user = await db.query.adminUsers.findFirst({ where: and(eq(adminUsers.id, data.userId), eq(adminUsers.active, true)) });
  if (!user) return null;
  return { raw, data, account: { id: user.id, email: user.email, name: user.name, passwordSet: Boolean(user.passwordHash) }, expiresAt: token.expiresAt };
}

export type LinkOutcome =
  | { ok: true; result: Exclude<LoginResult, { ok: false }>; next: string }
  | { ok: false; reason: "expired" | "locked" | "invalid" | "taken" | "no-password" | "other-browser" | "link" };

/**
 * The proof is in: spend the waiting hand-off, store the link, audit it, and
 * carry on to the usual second step. "taken" if this Base Ground login or
 * this account got linked in the meantime.
 */
async function completeLink(db: Db, pending: PendingLink, via: "password" | "email-link", meta: RequestMeta): Promise<LinkOutcome> {
  const spent = await consumeToken(db, "admin-base-link", pending.raw);
  if (!spent) return { ok: false, reason: "expired" };
  const user = await db.query.adminUsers.findFirst({ where: and(eq(adminUsers.id, pending.data.userId), eq(adminUsers.active, true)) });
  if (!user) return { ok: false, reason: "expired" };
  const [link] = await db
    .insert(baseLinks)
    .values({ client: pending.data.client, sub: pending.data.sub, userId: user.id, groundEmail: pending.data.groundEmail || null, linkedVia: via })
    .onConflictDoNothing()
    .returning({ id: baseLinks.id });
  if (!link) {
    await audit(summary(user), "signin.base-link-refused", { reason: "taken", client: pending.data.client, sub: pending.data.sub }, "admin_user", user.id, db);
    return { ok: false, reason: "taken" };
  }
  await audit(summary(user), "staff.base-link", { client: pending.data.client, sub: pending.data.sub, groundEmail: pending.data.groundEmail, via }, "admin_user", user.id, db);
  const result = await afterFirstFactor(db, user, meta, "base", pending.data.next);
  if (result.ok === false) return { ok: false, reason: "invalid" };
  return { ok: true, result, next: pending.data.next };
}

/**
 * Proof by the account's own password. Wrong passwords count toward the same
 * lockout as the sign-in form (by address and by account) and leave the
 * waiting hand-off in place for another try.
 */
export async function linkWithPassword(db: Db, cookie: string | undefined, password: string, meta: RequestMeta): Promise<LinkOutcome> {
  const pending = await readPendingLink(db, cookie);
  if (!pending) return { ok: false, reason: "expired" };
  const keys = [`ip:${meta.ip ?? "unknown"}`, `email:${pending.account.email.toLowerCase()}`];
  for (const key of keys) if (await isLocked(db, key)) return { ok: false, reason: "locked" };
  const user = await db.query.adminUsers.findFirst({ where: eq(adminUsers.id, pending.account.id), columns: { passwordHash: true } });
  if (!user?.passwordHash) return { ok: false, reason: "no-password" };
  const valid = password.length > 0 && password.length <= 200 && (await verifyPassword(password, user.passwordHash));
  for (const key of keys) await recordAttempt(db, key, valid);
  if (!valid) {
    await audit(null, "signin.base-link-refused", { reason: "password", accountId: pending.account.id, client: pending.data.client, sub: pending.data.sub }, "admin_user", pending.account.id, db);
    return { ok: false, reason: "invalid" };
  }
  return completeLink(db, pending, "password", meta);
}

/**
 * Proof by email: a one-time link sent to the staff account's own address.
 * It works only in the browser that holds the waiting hand-off, so someone
 * who clicks a link they didn't ask for links nothing.
 */
export async function requestLinkEmail(db: Db, cookie: string | undefined, meta: RequestMeta): Promise<"sent" | "expired" | "locked" | "email-not-configured" | "failed"> {
  if (!env.emailEnabled) return "email-not-configured";
  const pending = await readPendingLink(db, cookie);
  if (!pending) return "expired";
  const key = `link:${meta.ip ?? "unknown"}`;
  if (await isLocked(db, key)) return "locked";
  await recordAttempt(db, key, false);
  const minutes = Math.max(1, Math.min(LINK_MINUTES, Math.floor((pending.expiresAt.getTime() - Date.now()) / 60_000)));
  const raw = await createToken(db, "admin-base-link-email", pending.account.email, { ttlMinutes: minutes, data: { pending: tokenHash(pending.raw) } });
  const { org } = await getSettings();
  const message = baseLinkEmail({ siteUrl: env.siteUrl, orgName: org.name, orgEmail: org.email }, tokenUrl("/api/admin/base-link/email", raw), minutes, pending.data.groundEmail);
  const result = await sendEmail(db, { to: pending.account.email, kind: "admin-base-link", ...message });
  await audit(null, "signin.base-link-emailed", { accountId: pending.account.id, client: pending.data.client, sub: pending.data.sub, sent: result.status === "sent" }, "admin_user", pending.account.id, db);
  return result.status === "sent" ? "sent" : "failed";
}

/** The emailed link, opened: it must belong to the hand-off waiting in this browser. */
export async function linkWithEmailedToken(db: Db, cookie: string | undefined, raw: string, meta: RequestMeta): Promise<LinkOutcome> {
  const token = await consumeToken(db, "admin-base-link-email", raw);
  if (!token) return { ok: false, reason: "link" };
  const pendingRaw = openLinkCookie(cookie);
  if (!pendingRaw || tokenHash(pendingRaw) !== token.data?.pending) {
    await audit(null, "signin.base-link-refused", { reason: "other-browser", email: token.email }, undefined, undefined, db);
    return { ok: false, reason: "other-browser" };
  }
  const pending = await readPendingLink(db, cookie);
  if (!pending) return { ok: false, reason: "expired" };
  if (pending.account.email.toLowerCase() !== token.email.toLowerCase()) return { ok: false, reason: "invalid" };
  return completeLink(db, pending, "email-link", meta);
}

// ── Seeing and removing links (Admin → Staff, My account) ──────────────────

export type BaseLinkRow = { userId: string; client: string; groundEmail: string | null; linkedVia: string; linkedAt: Date };

export async function listBaseLinks(db: Db): Promise<Map<string, BaseLinkRow>> {
  const rows = await db
    .select({ userId: baseLinks.userId, client: baseLinks.client, groundEmail: baseLinks.groundEmail, linkedVia: baseLinks.linkedVia, linkedAt: baseLinks.linkedAt })
    .from(baseLinks);
  return new Map(rows.map((r) => [r.userId, r]));
}

export async function baseLinkFor(db: Db, userId: string): Promise<BaseLinkRow | null> {
  const [row] = await db
    .select({ userId: baseLinks.userId, client: baseLinks.client, groundEmail: baseLinks.groundEmail, linkedVia: baseLinks.linkedVia, linkedAt: baseLinks.linkedAt })
    .from(baseLinks)
    .where(eq(baseLinks.userId, userId))
    .limit(1);
  return row ?? null;
}

/** Remove a staff account's link; the next "Sign in with Base" asks for the proof again. Returns what was removed. */
export async function removeBaseLink(db: Db, userId: string): Promise<{ client: string; sub: string; groundEmail: string | null } | null> {
  const [row] = await db.delete(baseLinks).where(eq(baseLinks.userId, userId)).returning({ client: baseLinks.client, sub: baseLinks.sub, groundEmail: baseLinks.groundEmail });
  return row ?? null;
}
