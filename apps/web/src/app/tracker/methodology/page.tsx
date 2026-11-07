import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/PageHead";
import { StatusBadge } from "@/components/tracker/PromiseList";
import { methodology } from "@/content/tracker";
import { getSettings } from "@/lib/server/settings";
import { PROMISE_STATUSES } from "@/lib/tracker";
import "../tracker.css";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: methodology.title,
  description: methodology.lede,
  alternates: { canonical: "/tracker/methodology" },
};

export default async function MethodologyPage() {
  const settings = await getSettings();
  const email = settings.org.email;
  const mailto = `mailto:${email}?subject=${encodeURIComponent(methodology.dispute.subject)}`;
  return (
    <>
      <PageHead title={methodology.title} eyebrow="Promise tracker · methodology">
        {methodology.lede}
      </PageHead>

      <section className="section">
        <div className="container stack" style={{ gap: 40 }}>
          <div className="method-section" id="statuses">
            <h2>What each status means</h2>
            <dl className="method-statuses">
              {PROMISE_STATUSES.map((s) => (
                <div key={s.id}>
                  <dt>
                    <StatusBadge status={s.id} />
                  </dt>
                  <dd>{methodology.statuses[s.id]}</dd>
                </div>
              ))}
            </dl>
          </div>

          {methodology.sections.map((section) => (
            <div key={section.title} className="method-section">
              <h2>{section.title}</h2>
              {section.paragraphs.map((text, i) => (
                <p key={i}>{text}</p>
              ))}
            </div>
          ))}

          <div className="method-section" id="dispute">
            <h2>{methodology.dispute.title}</h2>
            {methodology.dispute.paragraphs.map((text, i) => (
              <p key={i}>{text}</p>
            ))}
            <p>
              <a href={mailto} className="btn btn--navy">
                Email {email}
              </a>
            </p>
          </div>

          <div className="method-section" id="cadence">
            <h2>{methodology.cadence.title}</h2>
            {methodology.cadence.paragraphs.map((text, i) => (
              <p key={i}>{text}</p>
            ))}
            <ul className="tracker-toolbar" aria-label="Ways to follow the tracker">
              <li>
                <Link href="/tracker">All promises</Link>
              </li>
              <li>
                <a href="/tracker/feed.xml" type="application/rss+xml">
                  RSS feed
                </a>
              </li>
              <li>
                <a href="/api/promises">JSON API</a>
              </li>
              <li>
                <Link href="/tracker/embed">Embed the scoreboard</Link>
              </li>
            </ul>
          </div>
        </div>
      </section>
    </>
  );
}
