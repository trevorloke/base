import "server-only";
import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb, type Db } from "@/lib/db";
import { adminSessions, adminUsers, loginAttempts } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { mustEnrol } from "@/lib/mfa-policy";
import { createToken } from "./tokens";

export const SESSION_COOKIE = "is_admin_session";
export const SESSION_HOURS = 12;
export const LOCK_WINDOW_MINUTES = 15;
export const LOCK_ATTEMPTS = 5;

// ── Roles ─────────────────────────────────────────────────────────────────

export type Role = "owner" | "admin" | "organizer" | "editor";
export type Permission = "users" | "settings" | "integrations" | "content" | "tracker" | "people" | "shifts" | "comms" | "money";

export const PERMISSIONS: { id: Permission; label: string }[] = [
  { id: "users", label: "Manage staff accounts" },
  { id: "settings", label: "Edit site settings and copy" },
  { id: "integrations", label: "See integration status" },
  { id: "content", label: "News, events, pages and shop" },
  { id: "tracker", label: "Promise tracker" },
  { id: "people", label: "Supporters and members" },
  { id: "shifts", label: "Volunteer shifts" },
  { id: "comms", label: "Email and text messages" },
  { id: "money", label: "Contributions and orders" },
];

const ALL = PERMISSIONS.map((p) => p.id);

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  owner: ALL,
  admin: ALL.filter((p) => p !== "users"),
  organizer: ["people", "shifts", "comms"],
  editor: ["content", "tracker"],
};

export const ROLE_LABELS: Record<Role, string> = { owner: "Owner", admin: "Administrator", organizer: "Organizer", editor: "Editor" };

export type AdminUser = { id: string; email: string; name: string; role: Role };

export function can(user: AdminUser, permission: Permission): boolean {
  return ROLE_PERMISSIONS[user.role].includes(permission);
}

// ── Passwords (scrypt, built into Node) ───────────────────────────────────

const scrypt = promisify(scryptCallback) as (password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, hash: string | null | undefined): Promise<boolean> {
  if (!hash) return false;
  const [alg, saltText, keyText] = hash.split("$");
  if (alg !== "scrypt" || !saltText || !keyText) return false;
  const key = Buffer.from(keyText, "base64url");
  const candidate = await scrypt(password, Buffer.from(saltText, "base64url"), key.length, SCRYPT);
  return key.length === candidate.length && timingSafeEqual(key, candidate);
}

export const PASSWORD_MIN_LENGTH = 12;

// ── Sessions ──────────────────────────────────────────────────────────────
// The cookie is `<session id>.<expiry ms>.<hmac>`. src/proxy.ts checks the
// signature and expiry on every /admin request without touching the
// database; pages and actions then load the session row, which is how
// sign-out and account deactivation take effect immediately.

function sign(payload: string): string {
  return createHmac("sha256", env.adminSessionSecret).update(payload).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function parseSessionCookie(value: string | undefined): { id: string; expires: number } | null {
  if (!value) return null;
  const [id, expiresText, mac] = value.split(".");
  if (!id || !expiresText || !mac) return null;
  const expires = Number(expiresText);
  if (!Number.isFinite(expires) || expires < Date.now()) return null;
  if (!safeEqual(mac, sign(`${id}.${expiresText}`))) return null;
  return { id, expires };
}

export type RequestMeta = { ip?: string | null; userAgent?: string | null };

export async function createSession(db: Db, userId: string, meta: RequestMeta = {}): Promise<{ value: string; maxAge: number }> {
  const id = randomBytes(32).toString("base64url");
  const expires = Date.now() + SESSION_HOURS * 3600_000;
  await db.insert(adminSessions).values({ id, userId, ip: meta.ip ?? null, userAgent: meta.userAgent?.slice(0, 300) ?? null, expiresAt: new Date(expires) });
  await db.update(adminUsers).set({ lastLoginAt: new Date() }).where(eq(adminUsers.id, userId));
  return { value: `${id}.${expires}.${sign(`${id}.${expires}`)}`, maxAge: SESSION_HOURS * 3600 };
}

export const sessionCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
};

export type AdminAccount = {
  user: AdminUser;
  /** Two-factor sign-in is on for this account. */
  twoFactor: boolean;
  /** An owner or administrator who hasn't set up two-factor sign-in yet: only My account is open to them. */
  mustEnrol: boolean;
};

/**
 * The signed-in admin and their two-factor state, or null. Unlike
 * getAdminUser this includes someone who still has to set up two-factor
 * sign-in; use it only where that person is allowed (My account, the layout).
 */
export async function getAdminAccount(): Promise<AdminAccount | null> {
  const parsed = parseSessionCookie((await cookies()).get(SESSION_COOKIE)?.value);
  if (!parsed) return null;
  const db = getDb();
  const [row] = await db
    .select({ id: adminUsers.id, email: adminUsers.email, name: adminUsers.name, role: adminUsers.role, totpEnabledAt: adminUsers.totpEnabledAt, lastSeenAt: adminSessions.lastSeenAt })
    .from(adminSessions)
    .innerJoin(adminUsers, eq(adminUsers.id, adminSessions.userId))
    .where(and(eq(adminSessions.id, parsed.id), isNull(adminSessions.revokedAt), gt(adminSessions.expiresAt, new Date()), eq(adminUsers.active, true)))
    .limit(1);
  if (!row) return null;
  if (Date.now() - row.lastSeenAt.getTime() > 5 * 60_000) {
    await db.update(adminSessions).set({ lastSeenAt: new Date() }).where(eq(adminSessions.id, parsed.id));
  }
  const twoFactor = Boolean(row.totpEnabledAt);
  return { user: { id: row.id, email: row.email, name: row.name, role: row.role }, twoFactor, mustEnrol: mustEnrol(row.role, twoFactor) };
}

/**
 * The signed-in admin, or null. Safe to call anywhere on the server. An
 * owner or administrator who still has to set up two-factor sign-in counts
 * as not signed in here, so admin API routes refuse them too.
 */
export async function getAdminUser(): Promise<AdminUser | null> {
  const account = await getAdminAccount();
  return account && !account.mustEnrol ? account.user : null;
}

/** Where an owner or administrator without two-factor sign-in is sent. */
export const ENROL_PATH = "/admin/account?enrol=required";

/**
 * For pages and server actions: the signed-in admin, or a redirect to the
 * sign-in page. With a permission, also a redirect when the role lacks it.
 * Every admin page must call this itself; a check in the layout alone can
 * be skipped by a direct request for the page segment.
 *
 * Owners and administrators who haven't set up two-factor sign-in are sent
 * to My account to do it; only the pages and actions that pass
 * `{ enrolling: true }` (My account and its two-factor actions) let them in.
 */
export async function requireAdmin(permission?: Permission, options: { enrolling?: boolean } = {}): Promise<AdminUser> {
  const account = await getAdminAccount();
  if (!account) redirect("/admin/login");
  if (account.mustEnrol && !options.enrolling) redirect(ENROL_PATH);
  const { user } = account;
  if (permission && !can(user, permission)) redirect(`/admin?denied=${permission}`);
  return user;
}

export async function revokeSession(id: string): Promise<void> {
  await getDb().update(adminSessions).set({ revokedAt: new Date() }).where(and(eq(adminSessions.id, id), isNull(adminSessions.revokedAt)));
}

export async function revokeAllSessions(db: Db, userId: string): Promise<void> {
  await db.update(adminSessions).set({ revokedAt: new Date() }).where(and(eq(adminSessions.userId, userId), isNull(adminSessions.revokedAt)));
}

// ── Sign-in throttling, shared across server instances ────────────────────

export async function isLocked(db: Db, key: string): Promise<boolean> {
  const since = new Date(Date.now() - LOCK_WINDOW_MINUTES * 60_000);
  const [{ failures }] = await db
    .select({ failures: sql<number>`count(*)::int` })
    .from(loginAttempts)
    .where(and(eq(loginAttempts.key, key), eq(loginAttempts.success, false), gt(loginAttempts.at, since)));
  return failures >= LOCK_ATTEMPTS;
}

export async function recordAttempt(db: Db, key: string, success: boolean): Promise<void> {
  await db.insert(loginAttempts).values({ key, success });
  // Keep the table small.
  await db.delete(loginAttempts).where(lt(loginAttempts.at, new Date(Date.now() - 24 * 3600_000)));
}

// ── Bootstrap and sign-in ─────────────────────────────────────────────────

/** Until a staff account exists, ADMIN_EMAIL + ADMIN_PASSWORD create the owner. */
export async function ensureBootstrapOwner(db: Db): Promise<void> {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(adminUsers);
  if (n > 0 || !env.adminEmail || !env.adminPassword) return;
  await db
    .insert(adminUsers)
    .values({ email: env.adminEmail.toLowerCase(), name: "Owner", role: "owner", passwordHash: await hashPassword(env.adminPassword) })
    .onConflictDoNothing();
}

export type LoginResult =
  | { ok: true; cookie: { value: string; maxAge: number }; user: AdminUser }
  /** Two-factor sign-in is on: a code is still needed. `pending` goes in PENDING_COOKIE. */
  | { ok: "second-step"; pending: { value: string; maxAge: number }; user: AdminUser }
  | { ok: false; reason: "locked" | "invalid" };

export type FirstFactor = "password" | "email-link";

/** The short-lived cookie that carries the pending second step (an `admin-mfa` token). */
export const PENDING_COOKIE = "is_admin_mfa";
/** Minutes the second step stays open after a correct password or link. */
export const PENDING_MINUTES = 10;

type UserRow = typeof adminUsers.$inferSelect;

/** After a correct password or link: a session, or the second step when two-factor sign-in is on. */
async function afterFirstFactor(db: Db, user: UserRow, meta: RequestMeta, method: FirstFactor, next: string): Promise<LoginResult> {
  const summary = { id: user.id, email: user.email, name: user.name, role: user.role };
  if (user.totpEnabledAt) {
    const until = Date.now() + PENDING_MINUTES * 60_000;
    const value = await createToken(db, "admin-mfa", user.email, { ttlMinutes: PENDING_MINUTES, data: { userId: user.id, method, next, until } });
    return { ok: "second-step", pending: { value, maxAge: PENDING_MINUTES * 60 }, user: summary };
  }
  const cookie = await createSession(db, user.id, meta);
  return { ok: true, cookie, user: summary };
}

export async function loginWithPassword(email: string, password: string, meta: RequestMeta, next = "/admin"): Promise<LoginResult> {
  const db = getDb();
  await ensureBootstrapOwner(db);
  const normalized = email.trim().toLowerCase();
  const keys = [`ip:${meta.ip ?? "unknown"}`, `email:${normalized}`];
  for (const key of keys) if (await isLocked(db, key)) return { ok: false, reason: "locked" };

  const user = await db.query.adminUsers.findFirst({ where: and(eq(adminUsers.email, normalized), eq(adminUsers.active, true)) });
  const valid = user ? await verifyPassword(password, user.passwordHash) : await verifyPassword(password, DUMMY_HASH).then(() => false);
  for (const key of keys) await recordAttempt(db, key, valid);
  if (!user || !valid) return { ok: false, reason: "invalid" };

  return afterFirstFactor(db, user, meta, "password", next);
}

// Verified against when the email is unknown, so timing does not reveal which emails exist.
const DUMMY_HASH = "scrypt$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/** Sign in from a one-time email link. */
export async function loginByEmail(email: string, meta: RequestMeta, next = "/admin"): Promise<LoginResult> {
  const db = getDb();
  const user = await db.query.adminUsers.findFirst({ where: and(eq(adminUsers.email, email.toLowerCase()), eq(adminUsers.active, true)) });
  if (!user) return { ok: false, reason: "invalid" };
  return afterFirstFactor(db, user, meta, "email-link", next);
}

export function requestMeta(req: Request): RequestMeta {
  return {
    ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || null,
    userAgent: req.headers.get("user-agent"),
  };
}
