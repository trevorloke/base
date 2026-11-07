import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/PageHead";
import { getSettings } from "@/lib/server/settings";

export const metadata: Metadata = { title: "Subscription confirmed", robots: { index: false } };

// Where the double opt-in link lands.
export default async function Confirmed({ searchParams }: PageProps<"/newsletter/confirmed">) {
  const sp = await searchParams;
  const invalid = typeof sp.invalid === "string";
  const unsubscribed = typeof sp.unsubscribed === "string";
  const { org } = await getSettings();

  if (unsubscribed) {
    return (
      <>
        <PageHead title="You're still unsubscribed">
          This address unsubscribed after that link was sent, so we haven&apos;t added it back. If you want the newsletter again, email us and we&apos;ll put you back on the list.
        </PageHead>
        <section className="section">
          <div className="container">
            <a href={`mailto:${org.email}?subject=${encodeURIComponent("Please add me back to the newsletter")}`} className="btn btn--navy btn--lg">
              Email {org.email}
            </a>
          </div>
        </section>
      </>
    );
  }

  return (
    <>
      <PageHead title={invalid ? "That link has expired" : "You're subscribed"}>
        {invalid
          ? "Confirmation links work once and last three days. Sign up again and we'll send a fresh one."
          : "Thanks for confirming. You'll get news and events from around Surrey, and you can unsubscribe from the bottom of any email."}
      </PageHead>
      <section className="section">
        <div className="container">
          <Link href={invalid ? "/#newsletter" : "/"} className="btn btn--navy btn--lg">
            {invalid ? "Sign up again" : "Back to the home page"}
          </Link>
        </div>
      </section>
    </>
  );
}
