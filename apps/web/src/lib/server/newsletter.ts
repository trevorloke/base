import "server-only";
import { randomBytes } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { newsletterSubscribers, promiseFollows } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { newsletterConfirmEmail } from "@/lib/email/messages";
import { emailContext, sendEmail } from "./email";
import { recordConsent } from "./consent";
import { findOrCreatePerson, findPersonByEmail } from "./people";
import { forwardConsentWithdrawal } from "./starbase-forward";
import { consumeToken, createToken, tokenUrl } from "./tokens";

export type SubscribeStatus = "pending" | "subscribed" | "unsubscribed";

/** Request details kept with consent events as proof (see consentMeta). */
export type RequestProof = { ip?: string | null; userAgent?: string | null };

const CONFIRM_TTL_MINUTES = 72 * 60;

const newToken = () => randomBytes(24).toString("base64url");

const SIGNUP_WORDING = "Entered their email in the newsletter sign-up form and pressed Subscribe.";
const CONFIRM_WORDING = "Clicked “Confirm my subscription” in the newsletter confirmation email.";

/**
 * Subscribe an address.
 *
 * With email configured this is double opt-in: a new or pending address
 * waits as "pending" and gets the confirmation email. An address that
 * unsubscribed stays "unsubscribed" (so it keeps dropping out of every
 * audience) and is only sent a fresh confirmation link: nothing changes
 * unless the person clicks it. Returns "pending" in both cases.
 *
 * Without email the address is subscribed at once, except that an
 * unsubscribed address is left unchanged ("unsubscribed"): there is no way
 * to send the confirmation click it would need.
 *
 * A "subscribed" row is never downgraded.
 *
 * Pass `consent` (the request proof) when the newsletter sign-up itself is
 * the person's consent, as on the newsletter form: a new single opt-in
 * subscription is then written to the consent ledger. Forms that record
 * their own consent tick (petitions, membership, RSVPs) leave it out.
 */
export async function subscribe(db: Db, email: string, source: string, personId?: string, consent?: RequestProof): Promise<SubscribeStatus> {
  const normalized = email.trim().toLowerCase();
  const person = personId ? { id: personId } : await findOrCreatePerson(db, normalized, {}, { source: "newsletter" });
  const existing = await db.query.newsletterSubscribers.findFirst({ where: eq(newsletterSubscribers.email, normalized) });
  if (existing?.status === "subscribed") return "subscribed";

  if (env.emailEnabled) {
    if (!existing) {
      await db
        .insert(newsletterSubscribers)
        .values({ email: normalized, personId: person.id, status: "pending", source, unsubscribeToken: newToken() })
        .onConflictDoNothing({ target: newsletterSubscribers.email });
    } else if (!existing.personId) {
      await db.update(newsletterSubscribers).set({ personId: person.id }).where(eq(newsletterSubscribers.id, existing.id));
    }
    // issuedAt lets the confirmation tell a fresh link from one sent before an unsubscribe.
    const raw = await createToken(db, "newsletter-confirm", normalized, { ttlMinutes: CONFIRM_TTL_MINUTES, data: { personId: person.id, source, issuedAt: new Date().toISOString() } });
    const ctx = await emailContext();
    const message = newsletterConfirmEmail(ctx, tokenUrl("/api/newsletter/confirm", raw));
    await sendEmail(db, { to: normalized, ...message, kind: "newsletter-confirm", personId: person.id, unsubscribeUrl: null });
    return "pending";
  }

  if (existing?.status === "unsubscribed") return "unsubscribed";

  // Single opt-in. The setWhere keeps an address that unsubscribed between
  // the read above and this write from being flipped back.
  const [row] = await db
    .insert(newsletterSubscribers)
    .values({ email: normalized, personId: person.id, status: "subscribed", source, unsubscribeToken: newToken(), confirmedAt: new Date() })
    .onConflictDoUpdate({
      target: newsletterSubscribers.email,
      set: { status: "subscribed", subscribedAt: sql`now()`, confirmedAt: sql`coalesce(${newsletterSubscribers.confirmedAt}, now())`, unsubscribedAt: null, source, personId: sql`coalesce(${newsletterSubscribers.personId}, excluded.person_id)` },
      setWhere: sql`${newsletterSubscribers.status} = 'pending'`,
    })
    .returning({ status: newsletterSubscribers.status });
  if (!row) {
    const current = await db.query.newsletterSubscribers.findFirst({ where: eq(newsletterSubscribers.email, normalized), columns: { status: true } });
    return current?.status === "subscribed" ? "subscribed" : "unsubscribed";
  }
  if (consent) {
    // Signing up is the person's own request to hear from us.
    await recordConsent(db, { personId: person.id, email: normalized, channel: "email", purpose: "newsletter", action: "grant", wording: SIGNUP_WORDING, source: `newsletter:${source}`.slice(0, 100), ...consent });
  }
  return "subscribed";
}

export type ConfirmResult = "subscribed" | "unsubscribed" | "invalid";

/**
 * The confirmation click from the double opt-in email. Marks the address
 * subscribed, records the grant in the consent ledger and sets contact
 * consent on the person if it was blank. An address that unsubscribed after
 * the link was sent stays unsubscribed. Returns "invalid" for an unknown,
 * used or expired token.
 */
export async function confirmSubscription(db: Db, rawToken: string, proof: RequestProof = {}): Promise<ConfirmResult> {
  return (await confirmSubscriptionDetails(db, rawToken, proof)).result;
}

/** confirmSubscription, with who was confirmed and where they signed up (for forwarding to the desk). */
export async function confirmSubscriptionDetails(
  db: Db,
  rawToken: string,
  proof: RequestProof = {},
): Promise<{ result: ConfirmResult; email?: string; personId?: string | null; source?: string; newlySubscribed?: boolean }> {
  const token = await consumeToken(db, "newsletter-confirm", rawToken);
  if (!token) return { result: "invalid" };
  const now = new Date();
  const issuedAt = typeof token.data?.issuedAt === "string" ? new Date(token.data.issuedAt) : null;
  const existing = await db.query.newsletterSubscribers.findFirst({ where: eq(newsletterSubscribers.email, token.email) });
  let personId = existing?.personId ?? (typeof token.data?.personId === "string" ? token.data.personId : null);
  const source = typeof token.data?.source === "string" ? token.data.source : (existing?.source ?? "confirm");

  if (existing) {
    if (existing.status === "unsubscribed") {
      // Only a link sent after the unsubscribe is the person's own request to come back.
      const fresh = issuedAt && !Number.isNaN(issuedAt.getTime()) && (!existing.unsubscribedAt || issuedAt > existing.unsubscribedAt);
      if (!fresh) return { result: "unsubscribed", email: token.email, personId, source };
    }
    await db
      .update(newsletterSubscribers)
      .set({ status: "subscribed", confirmedAt: now, unsubscribedAt: null, subscribedAt: existing.status === "subscribed" ? existing.subscribedAt : now })
      .where(eq(newsletterSubscribers.id, existing.id));
  } else {
    personId ??= (await findOrCreatePerson(db, token.email, {}, { source: "newsletter" })).id;
    await db
      .insert(newsletterSubscribers)
      .values({ email: token.email, personId, status: "subscribed", source, unsubscribeToken: newToken(), confirmedAt: now })
      .onConflictDoNothing({ target: newsletterSubscribers.email });
  }
  personId ??= (await findPersonByEmail(db, token.email))?.id ?? null;
  await recordConsent(db, { personId, email: token.email, channel: "email", purpose: "newsletter", action: "grant", wording: CONFIRM_WORDING, source: "newsletter-confirm", ...proof });
  return { result: "subscribed", email: token.email, personId, source, newlySubscribed: existing?.status !== "subscribed" };
}

/**
 * Stop bulk email for a token from an email link, record the withdrawal in
 * the consent ledger (which also clears the person's contact consent) and
 * pass it to Starbase. Returns whether a row changed.
 */
export async function unsubscribeByToken(db: Db, token: string, proof: RequestProof = {}): Promise<boolean> {
  if (!token || token.length > 200) return false;
  const rows = await db
    .update(newsletterSubscribers)
    .set({ status: "unsubscribed", unsubscribedAt: new Date() })
    .where(and(eq(newsletterSubscribers.unsubscribeToken, token), inArray(newsletterSubscribers.status, ["subscribed", "pending"])))
    .returning({ email: newsletterSubscribers.email, personId: newsletterSubscribers.personId });
  if (rows.length === 0) return false;
  const { email, personId } = rows[0];
  const id = personId ?? (await findPersonByEmail(db, email))?.id ?? null;
  await recordConsent(db, { personId: id, email, channel: "email", purpose: "updates", action: "withdraw", source: "unsubscribe", ...proof });
  // Starbase stops emailing them too.
  await forwardConsentWithdrawal(db, { personId: id, email, channel: "email", reason: "unsubscribe" });
  return true;
}

/** Stop promise-status emails for one follow link. Returns whether a follow was removed. */
export async function unfollowPromise(db: Db, token: string): Promise<boolean> {
  if (!token || token.length > 200) return false;
  const rows = await db.delete(promiseFollows).where(eq(promiseFollows.token, token)).returning({ id: promiseFollows.id });
  return rows.length > 0;
}
