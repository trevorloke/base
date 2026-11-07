import type { Metadata } from "next";
import { PageHead } from "@/components/PageHead";
import { NextStep } from "@/components/engage/NextStep";
import { formatCents } from "@/lib/money";
import { completedSession } from "@/lib/server/checkout-session";

export const metadata: Metadata = { title: "Order received", robots: { index: false } };

export default async function ShopThanks({ searchParams }: PageProps<"/shop/thanks">) {
  const session = await completedSession((await searchParams).session_id);
  return (
    <>
      <PageHead title="Order received">
        {session?.amount_total ? `Thanks! We've received your order of ${formatCents(session.amount_total)}.` : "Thanks! We've received your order."} Stripe will
        email your receipt, and we&apos;ll be in touch when it ships.
      </PageHead>
      <section className="section">
        <div className="container stack" style={{ gap: 20, maxWidth: 760 }}>
          <NextStep completed="order" email={session?.customer_details?.email ?? session?.customer_email ?? null} as="h2" />
        </div>
      </section>
    </>
  );
}
