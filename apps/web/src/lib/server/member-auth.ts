import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { people } from "@/lib/db/schema";
import { env } from "@/lib/env";
import type { Person } from "@/lib/server/people";

// Supporters sign in with a one-time email link and get a signed, stateless
// cookie: `<personId>.<expiry ms>.<hmac>`. The key is derived from the admin
// session secret, so a member cookie can never be presented as an admin
// session (and the reverse), even though one secret is configured.

export const MEMBER_COOKIE = "is_member";
export const MEMBER_SESSION_DAYS = 30;

function key(): Buffer {
  return createHmac("sha256", env.adminSessionSecret).update("member-session").digest();
}

function sign(payload: string): string {
  return createHmac("sha256", key()).update(payload).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseMemberCookie(value: string | undefined): { personId: string; expires: number } | null {
  if (!value) return null;
  const [personId, expiresText, mac] = value.split(".");
  if (!personId || !expiresText || !mac || !UUID.test(personId) || !/^\d+$/.test(expiresText)) return null;
  const expires = Number(expiresText);
  if (!Number.isFinite(expires) || expires < Date.now()) return null;
  if (!safeEqual(mac, sign(`${personId}.${expiresText}`))) return null;
  return { personId, expires };
}

export function memberSessionValue(personId: string, now = Date.now()): { value: string; maxAge: number } {
  const expires = now + MEMBER_SESSION_DAYS * 86_400_000;
  return { value: `${personId}.${expires}.${sign(`${personId}.${expires}`)}`, maxAge: MEMBER_SESSION_DAYS * 86_400 };
}

export const memberCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
};

/** The signed-in supporter, or null. Safe to call anywhere on the server. */
export async function getMember(): Promise<Person | null> {
  const parsed = parseMemberCookie((await cookies()).get(MEMBER_COOKIE)?.value);
  if (!parsed) return null;
  const person = await getDb().query.people.findFirst({ where: eq(people.id, parsed.personId) });
  return person ?? null;
}

/**
 * For pages and server actions under /me: the signed-in supporter, or a
 * redirect to the sign-in page that comes back to `nextPath` afterwards.
 * Every page calls this itself; a layout check alone can be bypassed.
 */
export async function requireMember(nextPath = "/me"): Promise<Person> {
  const person = await getMember();
  if (!person) redirect(`/me/login?next=${encodeURIComponent(nextPath)}`);
  return person;
}

/** Start a 30-day session. Only from a route handler or server action. */
export async function setMemberSession(personId: string): Promise<void> {
  const session = memberSessionValue(personId);
  (await cookies()).set(MEMBER_COOKIE, session.value, { ...memberCookieOptions, maxAge: session.maxAge });
}

export async function clearMemberSession(): Promise<void> {
  (await cookies()).set(MEMBER_COOKIE, "", { ...memberCookieOptions, maxAge: 0 });
}
