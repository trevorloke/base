import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/PageHead";

export const metadata: Metadata = { title: "Unfollowed", robots: { index: false } };

// Where the "stop following this promise" link lands.
export default async function Unfollowed({ searchParams }: PageProps<"/newsletter/unfollowed">) {
  const sp = await searchParams;
  const missing = typeof sp.missing === "string";
  return (
    <>
      <PageHead title={missing ? "Already done" : "You've stopped following that promise"}>
        {missing
          ? "That link has already been used, so you won't get updates about that promise."
          : "You won't get emails when its status changes. You can follow it again from the tracker any time."}
      </PageHead>
      <section className="section">
        <div className="container">
          <Link href="/tracker" className="btn btn--primary btn--lg">
            Back to the promise tracker
          </Link>
        </div>
      </section>
    </>
  );
}
