import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/PageHead";
import { NextStep } from "@/components/engage/NextStep";
import { formatDate } from "@/lib/dates";
import { getDb } from "@/lib/db";
import { formatCents } from "@/lib/money";
import { completedSession, membershipForCheckoutSession } from "@/lib/server/checkout-session";

export const metadata: Metadata = { title: "Welcome", robots: { index: false } };

export default async function Welcome({ searchParams }: PageProps<"/join/welcome">) {
  const session = await completedSession((await searchParams).session_id);
  const membership = session ? await membershipForCheckoutSession(getDb(), session.id) : null;
  const runsUntil = membership?.status === "active" && membership.expiresAt ? formatDate(membership.expiresAt) : null;
  // A fee that turned out to be over the contribution limit goes back and the
  // membership is cancelled (the payer is emailed why), so the page only calls
  // a fee paid while the webhook has yet to say otherwise, and only says they
  // have joined when there is a membership that isn't cancelled.
  const returned = membership?.status === "cancelled";
  // Membership is by donation: thank them for what they chose to give.
  const gave = membership && membership.feeCents > 0 ? `your ${formatCents(membership.feeCents)} membership` : "joining";
  const lede = runsUntil
    ? `Thank you for ${gave}. It runs until ${runsUntil}; renew then at whatever amount you can. Stripe will email your receipt.`
    : membership?.status === "pending_payment"
      ? `Thank you for ${gave}. Your payment is in, and Stripe will email your receipt.`
      : "Thanks for joining. Watch your inbox for a note from us.";
  return (
    <>
      <PageHead title={returned ? "Thanks for joining Imagine Surrey" : "Welcome to Imagine Surrey"}>{lede}</PageHead>
      <section className="section">
        <div className="container stack" style={{ gap: 20, maxWidth: 760 }}>
          {returned ? (
            <p className="body">While you wait for our note, come and meet your neighbours at an event near you.</p>
          ) : (
            <p className="body">
              You&apos;re now part of your neighbourhood committee, so you&apos;ll hear about meetings close to home. Two things make the biggest difference
              right now: chip in if you can, and tell one neighbour about us.
            </p>
          )}
          {returned ? (
            <div className="btn-row">
              <Link href="/events" className="btn btn--red btn--lg">
                See upcoming events
              </Link>
            </div>
          ) : (
            <NextStep completed="member" personId={membership?.personId ?? null} email={membership ? null : (session?.customer_details?.email ?? null)} as="h2" />
          )}
        </div>
      </section>
    </>
  );
}
