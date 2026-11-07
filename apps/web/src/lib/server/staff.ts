import "server-only";
import { randomInt } from "node:crypto";
import { and, desc, eq, gt, isNull, ne, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { adminSessions, adminUsers, auditLog } from "@/lib/db/schema";
import { adminMagicLinkEmail } from "@/lib/email/messages";
import { env } from "@/lib/env";
import { ActionError } from "./actions";
import { hashPassword, PASSWORD_MIN_LENGTH, revokeAllSessions, verifyPassword, type AdminUser, type Role } from "./admin-auth";
import { sendEmail } from "./email";
import { resetTwoFactor } from "./mfa";
import { getSettings } from "./settings";
import { createToken, tokenUrl } from "./tokens";

export const ROLES: Role[] = ["owner", "admin", "organizer", "editor"];
export const INVITE_LINK_MINUTES = 60;

// ── Staff accounts ────────────────────────────────────────────────────────

export type StaffRow = {
  id: string;
  email: string;
  name: string;
  role: Role;
  active: boolean;
  passwordSet: boolean;
  /** Two-factor sign-in is on. */
  twoFactor: boolean;
  invitedBy: string | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  activeSessions: number;
};

export async function listStaff(db: Db): Promise<StaffRow[]> {
  const rows = (await db.execute(sql`
    select u.id, u.email, u.name, u.role, u.active, u.password_hash is not null as password_set, u.totp_enabled_at is not null as two_factor, i.name as invited_by,
           to_char(u.last_login_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as last_login_at,
           to_char(u.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at,
           (select count(*) from admin_sessions s where s.user_id = u.id and s.revoked_at is null and s.expires_at > now())::int as active_sessions
    from admin_users u left join admin_users i on i.id = u.invited_by_id
    order by u.active desc, array_position(array['owner','admin','organizer','editor'], u.role::text), lower(u.name)`)) as unknown as Record<string, unknown>[];
  return rows.map((r) => ({
    id: String(r.id),
    email: String(r.email),
    name: String(r.name),
    role: r.role as Role,
    active: Boolean(r.active),
    passwordSet: Boolean(r.password_set),
    twoFactor: Boolean(r.two_factor),
    invitedBy: (r.invited_by as string | null) ?? null,
    // Raw query results carry timestamps as text.
    lastLoginAt: r.last_login_at ? new Date(String(r.last_login_at)) : null,
    createdAt: new Date(String(r.created_at)),
    activeSessions: Number(r.active_sessions),
  }));
}

// No 0/O/1/l/I, so a password read over the phone survives the trip.
const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";

/** A random one-time password, at least PASSWORD_MIN_LENGTH characters. */
export function generatePassword(length = 16): string {
  const n = Math.max(length, PASSWORD_MIN_LENGTH);
  return Array.from({ length: n }, () => PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)]).join("");
}

async function findStaff(db: Db, id: string) {
  const user = await db.query.adminUsers.findFirst({ where: eq(adminUsers.id, id) });
  if (!user) throw new ActionError("That account no longer exists.");
  return user;
}

/** Owners keep the keys: the last active owner can be neither demoted nor deactivated. */
async function assertAnotherActiveOwner(db: Db, exceptId: string): Promise<void> {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(adminUsers)
    .where(and(eq(adminUsers.role, "owner"), eq(adminUsers.active, true), ne(adminUsers.id, exceptId)));
  if (n === 0) throw new ActionError("This is the only active owner. Make someone else an owner first.");
}

/** Email a one-time sign-in link (the invite, or a re-send). False when email is not configured. */
export async function sendSignInLink(db: Db, email: string): Promise<boolean> {
  if (!env.emailEnabled) return false;
  const raw = await createToken(db, "admin-login", email, { ttlMinutes: INVITE_LINK_MINUTES, data: { next: "/admin/account" } });
  const { org } = await getSettings();
  const message = adminMagicLinkEmail({ siteUrl: env.siteUrl, orgName: org.name, orgEmail: org.email }, tokenUrl("/api/admin/magic-link", raw), INVITE_LINK_MINUTES);
  const result = await sendEmail(db, { to: email, kind: "admin-invite", ...message });
  return result.status === "sent";
}

export type Invite = { id: string; emailed: boolean; oneTimePassword: string | null };

/**
 * Create a staff account. With email configured the person gets a sign-in
 * link and sets their own password; otherwise a one-time password is
 * returned, to be shown exactly once and never stored in clear.
 */
export async function inviteStaff(db: Db, actor: AdminUser, input: { name: string; email: string; role: Role }): Promise<Invite> {
  const email = input.email.trim().toLowerCase();
  const existing = await db.query.adminUsers.findFirst({ where: eq(adminUsers.email, email), columns: { id: true } });
  if (existing) throw new ActionError("Please check the highlighted fields.", { email: "There is already an account with this email." });
  const oneTimePassword = env.emailEnabled ? null : generatePassword();
  const [row] = await db
    .insert(adminUsers)
    .values({ email, name: input.name, role: input.role, invitedById: actor.id, passwordHash: oneTimePassword ? await hashPassword(oneTimePassword) : null })
    .returning({ id: adminUsers.id });
  const emailed = oneTimePassword ? false : await sendSignInLink(db, email);
  return { id: row.id, emailed, oneTimePassword };
}

export async function changeRole(db: Db, actor: AdminUser, id: string, role: Role): Promise<{ previous: Role }> {
  const user = await findStaff(db, id);
  if (user.role === role) return { previous: role };
  if (user.role === "owner" && user.active) await assertAnotherActiveOwner(db, id);
  await db.update(adminUsers).set({ role }).where(eq(adminUsers.id, id));
  return { previous: user.role };
}

export async function setActive(db: Db, actor: AdminUser, id: string, active: boolean): Promise<void> {
  const user = await findStaff(db, id);
  if (!active && id === actor.id) throw new ActionError("You can't deactivate your own account. Ask another owner to do it.");
  if (!active && user.role === "owner" && user.active) await assertAnotherActiveOwner(db, id);
  await db.update(adminUsers).set({ active }).where(eq(adminUsers.id, id));
  if (!active) await revokeAllSessions(db, id);
}

/** Owners only: replace the password and sign the person out everywhere. Returns the new password, to show once. */
export async function resetPassword(db: Db, actor: AdminUser, id: string): Promise<string> {
  if (actor.role !== "owner") throw new ActionError("Only an owner can reset passwords.");
  await findStaff(db, id);
  const password = generatePassword();
  await db.update(adminUsers).set({ passwordHash: await hashPassword(password) }).where(eq(adminUsers.id, id));
  await revokeAllSessions(db, id);
  return password;
}

/**
 * Owners only: clear someone else's two-factor sign-in (a lost phone and no
 * recovery codes) and sign them out everywhere. Owners and administrators
 * set it up again at their next sign-in.
 */
export async function resetStaffTwoFactor(db: Db, actor: AdminUser, id: string): Promise<void> {
  if (actor.role !== "owner") throw new ActionError("Only an owner can reset two-factor sign-in.");
  if (id === actor.id) throw new ActionError("Turn your own two-factor sign-in off under My account.");
  await findStaff(db, id);
  await resetTwoFactor(db, id);
  await revokeAllSessions(db, id);
}

/**
 * For the dashboard's "Needs attention": a nudge when only one active owner
 * holds the keys (if that account is lost, so is the admin), or when an
 * owner is still called "Owner", the bootstrap account's placeholder name.
 */
export async function ownersAttention(db: Db): Promise<{ text: string; href: string } | null> {
  const owners = await db.select({ name: adminUsers.name }).from(adminUsers).where(and(eq(adminUsers.role, "owner"), eq(adminUsers.active, true)));
  const placeholder = owners.some((o) => o.name.trim().toLowerCase() === "owner");
  if (owners.length === 0) return { text: "There is no active owner. Make someone an owner under Staff.", href: "/admin/users" };
  if (owners.length === 1 && placeholder) {
    return { text: "There is only one owner, and the account is still named “Owner”. Put a real name on it under My account, then make a second owner so nobody is locked out if that account is lost.", href: "/admin/users" };
  }
  if (owners.length === 1) return { text: "There is only one owner. Make a second owner under Staff, so nobody is locked out if that account is lost.", href: "/admin/users" };
  if (placeholder) return { text: "An owner account is still named “Owner”. Whoever uses it can put their real name on it under My account.", href: "/admin/users" };
  return null;
}

// ── Own account ───────────────────────────────────────────────────────────

export async function renameSelf(db: Db, userId: string, name: string): Promise<void> {
  await db.update(adminUsers).set({ name }).where(eq(adminUsers.id, userId));
}

/**
 * Change the signed-in admin's password. The current one is required when
 * one is set (an invited account signed in by email link has none yet).
 * Other sessions are signed out; `keepSessionId` is the one in use now.
 */
export async function changeOwnPassword(db: Db, userId: string, current: string, next: string, keepSessionId: string | null): Promise<void> {
  const user = await findStaff(db, userId);
  if (user.passwordHash && !(await verifyPassword(current, user.passwordHash))) {
    throw new ActionError("Please check the highlighted fields.", { currentPassword: "That isn't your current password." });
  }
  if (next.length < PASSWORD_MIN_LENGTH) throw new ActionError("Please check the highlighted fields.", { password: `Use at least ${PASSWORD_MIN_LENGTH} characters.` });
  await db.update(adminUsers).set({ passwordHash: await hashPassword(next) }).where(eq(adminUsers.id, userId));
  await db
    .update(adminSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(adminSessions.userId, userId), isNull(adminSessions.revokedAt), keepSessionId ? ne(adminSessions.id, keepSessionId) : sql`true`));
}

export type SessionRow = { id: string; ip: string | null; userAgent: string | null; createdAt: Date; lastSeenAt: Date; expiresAt: Date };

export async function listSessions(db: Db, userId: string): Promise<SessionRow[]> {
  return db
    .select({ id: adminSessions.id, ip: adminSessions.ip, userAgent: adminSessions.userAgent, createdAt: adminSessions.createdAt, lastSeenAt: adminSessions.lastSeenAt, expiresAt: adminSessions.expiresAt })
    .from(adminSessions)
    .where(and(eq(adminSessions.userId, userId), isNull(adminSessions.revokedAt), gt(adminSessions.expiresAt, new Date())))
    .orderBy(desc(adminSessions.lastSeenAt));
}

export async function signOutEverywhere(db: Db, userId: string): Promise<void> {
  await revokeAllSessions(db, userId);
}

/** "Chrome on Windows", from a user-agent string, for the sessions table. */
export function describeUserAgent(ua: string | null): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "unknown system";
  return `${browser} on ${os}`;
}

// ── Audit log ─────────────────────────────────────────────────────────────

export const AUDIT_PAGE_SIZE = 50;

export type AuditFilters = { user: string; action: string; entity: string; page: number };
export type AuditRow = { id: string; at: Date; userEmail: string | null; userName: string | null; action: string; entity: string | null; entityId: string | null; details: unknown };

export function parseAuditFilters(sp: Record<string, string | string[] | undefined>): AuditFilters {
  const read = (k: string) => {
    const v = sp[k];
    return (Array.isArray(v) ? v[0] : v)?.trim().slice(0, 120) ?? "";
  };
  const page = Number.parseInt(read("page"), 10);
  return { user: read("user"), action: read("action"), entity: read("entity"), page: Number.isFinite(page) && page > 0 ? page : 1 };
}

export async function listAudit(db: Db, f: AuditFilters): Promise<{ rows: AuditRow[]; total: number }> {
  const conditions: SQL[] = [];
  if (f.user === "system") conditions.push(isNull(auditLog.userId));
  else if (f.user) conditions.push(sql`(${auditLog.userId}::text = ${f.user} or ${auditLog.userEmail} = ${f.user})`);
  if (f.action) conditions.push(eq(auditLog.action, f.action));
  if (f.entity) conditions.push(sql`(${auditLog.entity} ilike ${`%${f.entity.replace(/[\\%_]/g, (c) => `\\${c}`)}%`} or ${auditLog.entityId} = ${f.entity})`);
  const where = conditions.length ? and(...conditions) : undefined;
  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: auditLog.id,
        at: auditLog.at,
        userEmail: auditLog.userEmail,
        userName: adminUsers.name,
        action: auditLog.action,
        entity: auditLog.entity,
        entityId: auditLog.entityId,
        details: auditLog.details,
      })
      .from(auditLog)
      .leftJoin(adminUsers, eq(adminUsers.id, auditLog.userId))
      .where(where)
      .orderBy(desc(auditLog.at), desc(auditLog.id))
      .limit(AUDIT_PAGE_SIZE)
      .offset((f.page - 1) * AUDIT_PAGE_SIZE),
    db.select({ total: sql<number>`count(*)::int` }).from(auditLog).where(where),
  ]);
  return { rows, total: Number(total) };
}

export async function auditFacets(db: Db): Promise<{ users: { id: string; name: string; email: string }[]; actions: string[] }> {
  const [users, actions] = await Promise.all([
    db.select({ id: adminUsers.id, name: adminUsers.name, email: adminUsers.email }).from(adminUsers).orderBy(adminUsers.name),
    db.selectDistinct({ action: auditLog.action }).from(auditLog).orderBy(auditLog.action).limit(300),
  ]);
  return { users, actions: actions.map((a) => a.action) };
}
