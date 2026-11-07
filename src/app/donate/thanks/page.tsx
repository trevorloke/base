import type { Metadata } from "next";
import { PageHead } from "@/components/PageHead";
import { NextStep } from "@/components/engage/NextStep";
import { formatCents } from "@/lib/money";
import { completedSession } from "@/lib/server/checkout-session";

export const metadata: Metadata = { title: "Thank you", robots: { index: false } };

export default async function DonateThanks({ searchParams }: PageProps<"/donate/thanks">) {
  const session = await completedSession((await searchParams).session_id);
  const monthly = session?.mode === "subscription";
  return (
    <>
      <PageHead title="Thank you">
        {session?.amount_total
          ? `Your ${monthly ? "monthly " : ""}contribution of ${formatCents(session.amount_total)}${monthly ? " a month" : ""} is in. Stripe will email your receipt.`
          : "Your contribution is on its way. Stripe will email your receipt."}
      </PageHead>
      <section className="section">
        <div className="container stack" style={{ gap: 20, maxWidth: 760 }}>
          <p className="body">
            Contributions like yours pay for the work that wins: organizers, printing, and outreach in every town centre.
            {monthly && " Your monthly gift supports the Imagine Victory Fund, our war chest for the next election."}
          </p>
          {/* The payer's own completed Checkout session identifies them; nothing comes from the URL but the session id. */}
          <NextStep completed="donation" email={session?.customer_details?.email ?? session?.customer_email ?? null} as="h2" />
        </div>
      </section>
    </>
  );
}
