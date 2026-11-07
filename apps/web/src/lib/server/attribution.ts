import "server-only";
import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { people } from "@/lib/db/schema";
import { findPersonByReferralCode } from "@/lib/server/people";
import { TRACKING_COOKIE } from "@/lib/share";

// Source-coded links and referral credit. A visit with ?ref=<code> or
// ?source=<tag> stores both in a short-lived cookie (set by /r/[code] or the
// client-side TrackingCapture component); public routes read the cookie and
// the request body and persist "where did this come from" on what they create.

export type Tracking = { ref: string | null; source: string | null };

const MAX_SOURCE = 80;
const MAX_REF = 20;
const SAFE = /^[A-Za-z0-9_.:-]+$/;

export function cleanSource(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().slice(0, MAX_SOURCE);
  return v && SAFE.test(v) ? v : null;
}

export function cleanRef(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().slice(0, MAX_REF);
  return v && SAFE.test(v) ? v : null;
}

export function encodeTrackingCookie(t: Tracking): string {
  const p = new URLSearchParams();
  if (t.ref) p.set("ref", t.ref);
  if (t.source) p.set("source", t.source);
  return p.toString();
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function decodeTrackingCookie(value: string | undefined | null): Tracking {
  if (!value) return { ref: null, source: null };
  const p = new URLSearchParams(value);
  return { ref: cleanRef(p.get("ref")), source: cleanSource(p.get("source")) };
}

/** 30 days, readable by the browser so the share sheet can show "credited to <code>". */
export function trackingCookieOptions() {
  return { name: TRACKING_COOKIE, path: "/", maxAge: 30 * 24 * 3600, sameSite: "lax" as const, httpOnly: false, secure: process.env.NODE_ENV === "production" };
}

/**
 * Where a request came from: explicit body fields win, then the tracking
 * cookie. Pass the parsed body's optional `source` and `ref` fields.
 */
export function trackingFromRequest(req: Request, body: { source?: unknown; ref?: unknown } = {}): Tracking {
  const cookieHeader = req.headers.get("cookie") ?? "";
  const match = cookieHeader.split(/;\s*/).find((c) => c.startsWith(`${TRACKING_COOKIE}=`));
  const fromCookie = decodeTrackingCookie(match ? safeDecode(match.slice(TRACKING_COOKIE.length + 1)) : null);
  return { ref: cleanRef(body.ref) ?? fromCookie.ref, source: cleanSource(body.source) ?? fromCookie.source };
}

/** A source label for people.source / *.source columns: "<action>" or "<action>/<campaign tag>". */
export function sourceLabel(action: string, tracking: Tracking): string {
  return tracking.source ? `${action}/${tracking.source}` : action;
}

/**
 * Credit a referral once: if the person has no referrer yet and the code
 * belongs to someone else, set referredById. Returns the referrer's id or null.
 */
export async function creditReferral(db: Db, personId: string, ref: string | null): Promise<string | null> {
  if (!ref) return null;
  const referrer = await findPersonByReferralCode(db, ref);
  if (!referrer || referrer.id === personId) return null;
  const [person] = await db.select({ referredById: people.referredById }).from(people).where(eq(people.id, personId));
  if (!person || person.referredById) return person?.referredById ?? null;
  await db.update(people).set({ referredById: referrer.id, updatedAt: new Date() }).where(eq(people.id, personId));
  return referrer.id;
}
