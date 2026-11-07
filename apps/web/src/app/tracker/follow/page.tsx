import type { Metadata } from "next";
import { PageHead } from "@/components/PageHead";
import { FollowResult } from "@/components/tracker/FollowResult";
import "../tracker.css";

export const metadata: Metadata = { title: "Following a promise", robots: { index: false } };

/** Where a confirmation link lands: /tracker/follow#confirmed-10 or #expired. */
export default function FollowPage() {
  return (
    <>
      <PageHead title="Following a promise" eyebrow="Promise tracker" />
      <section className="section">
        <div className="container stack" style={{ gap: 16, maxWidth: 760 }}>
          <FollowResult />
        </div>
      </section>
    </>
  );
}
