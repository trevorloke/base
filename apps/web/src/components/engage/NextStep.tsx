import { getDb } from "@/lib/db";
import { EMPTY_STATE, nextStep, SHARE_TEXT, THANKS, type Completed } from "@/lib/engagement";
import { env } from "@/lib/env";
import { engagementStateFor, resolvePerson } from "@/lib/server/engagement";
import { ensureReferralCode } from "@/lib/server/people";
import { NextStepCard } from "./NextStepCard";

/**
 * "You did X; here is the next rung." A server component for thank-you
 * pages: it looks up where the person is on the ladder (by id or email),
 * picks exactly one next ask, and offers their personal referral link to
 * share. It never throws: on any failure it renders the generic ask.
 *
 *   <NextStep completed="donation" email={session.customer_email} />   // /donate/thanks
 *   <NextStep completed="member" personId={membership.personId} />      // /join/welcome
 *   <NextStep completed="order" email={order.email} />                  // /shop/thanks
 */
export async function NextStep({
  personId,
  email,
  completed,
  heading,
  as,
}: {
  personId?: string | null;
  email?: string | null;
  completed?: Completed;
  heading?: string;
  as?: "h2" | "h3";
}) {
  const thanks = completed ? THANKS[completed] : undefined;
  try {
    const db = getDb();
    const person = personId || email ? await resolvePerson(db, { personId, email }) : null;
    const state = person ? await engagementStateFor(db, person) : EMPTY_STATE;
    const url = person ? `${env.siteUrl}/r/${await ensureReferralCode(db, person.id)}` : env.siteUrl;
    return <NextStepCard step={nextStep(state, completed)} thanks={thanks} heading={heading} shareUrl={url} shareText={SHARE_TEXT} as={as} />;
  } catch (err) {
    console.error("NextStep fell back to the generic ask", err);
    return <NextStepCard step={nextStep(EMPTY_STATE, completed)} thanks={thanks} heading={heading} shareUrl={siteUrlOrDefault()} shareText={SHARE_TEXT} as={as} />;
  }
}

function siteUrlOrDefault(): string {
  try {
    return env.siteUrl;
  } catch {
    return "";
  }
}
