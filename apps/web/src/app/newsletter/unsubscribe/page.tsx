import type { Metadata } from "next";
import { PageHead } from "@/components/PageHead";
import { getSettings } from "@/lib/server/settings";

export const metadata: Metadata = { title: "Unsubscribe", robots: { index: false } };

// The button POSTs so that link scanners and prefetching can't unsubscribe
// anyone. Mail clients' one-click unsubscribe POSTs to the API route directly.
export default async function Unsubscribe({ searchParams }: PageProps<"/newsletter/unsubscribe">) {
  const sp = await searchParams;
  const token = typeof sp.token === "string" ? sp.token : "";
  const { org } = await getSettings();
  const name = org.shortName || org.name;
  return (
    <>
      <PageHead title={sp.done ? "You're unsubscribed" : "Unsubscribe"}>
        {sp.done
          ? `You won't get newsletters or other bulk email from ${name} any more. Emails about something you do yourself, like an RSVP receipt, still arrive. If this was a mistake, email ${org.email} and we'll put you back on the list.`
          : `Stop getting the ${name} newsletter and other bulk email?`}
      </PageHead>
      {!sp.done && (
        <section className="section">
          <div className="container">
            {token ? (
              <form method="post" action="/api/newsletter/unsubscribe">
                <input type="hidden" name="token" value={token} />
                <button type="submit" className="btn btn--navy btn--lg">
                  Unsubscribe me
                </button>
              </form>
            ) : (
              <p className="empty-state">This unsubscribe link is incomplete. Use the link from the bottom of one of our emails.</p>
            )}
          </div>
        </section>
      )}
    </>
  );
}
