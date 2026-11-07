import type { Metadata } from "next";
import Link from "next/link";
import { NewsletterForm } from "@/components/forms/NewsletterForm";
import { KeyDates } from "@/components/tracker/KeyDates";
import { PromiseList, SourceLinks, type PublicPromise } from "@/components/tracker/PromiseList";
import { scoringNote, sourceGroups, sourcesNote, trackerHighlights, trackerIntro } from "@/content/tracker";
import { todayInSurrey } from "@/lib/shifts";
import { countByStatus, PROMISE_STATUSES } from "@/lib/tracker";
import { loadTracker } from "@/lib/server/tracker";
import "./tracker.css";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: "Safe Surrey promise tracker",
  description: "Every promise Doug McCallum and the Safe Surrey Coalition made in the 2026 campaign, tracked against delivery.",
  alternates: { canonical: "/tracker", types: { "application/rss+xml": "/tracker/feed.xml" } },
};

const formatDate = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-CA", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

export default async function TrackerPage() {
  const { promises, announcements, lastUpdated } = await loadTracker();
  const today = todayInSurrey();
  const counts = countByStatus(promises.map((p) => p.status));
  const total = promises.length;
  const publicPromises: PublicPromise[] = promises.map((p) => ({
    id: p.id,
    number: p.number,
    title: p.title,
    specifics: p.specifics,
    area: p.area,
    status: p.status,
    sources: p.sources,
    testKept: p.testKept,
    testPartly: p.testPartly,
    testBroken: p.testBroken,
    testRecord: p.testRecord,
    promisedOn: p.promisedOn,
    targetDate: p.targetDate,
    neighbourhoods: p.neighbourhoods,
    updates: p.updates.map((u) => ({ id: u.id, date: u.date, status: u.status, note: u.note, url: u.url })),
  }));

  return (
    <>
      <section className="section--primary on-dark page-head">
        <div className="container stack" style={{ gap: 18 }}>
          <p className="eyebrow eyebrow--highlight">Accountability</p>
          <h1 className="display pop">{trackerIntro.title}</h1>
          <p className="lede" style={{ maxWidth: 760 }}>
            {trackerIntro.lede}
          </p>
          <div className="scoreboard" aria-label="Promises by status">
            <div className="score-bar" role="img" aria-label={PROMISE_STATUSES.map((s) => `${counts[s.id]} ${s.label.toLowerCase()}`).join(", ")}>
              {PROMISE_STATUSES.filter((s) => counts[s.id] > 0).map((s) => (
                <span key={s.id} style={{ flexGrow: counts[s.id], background: s.color }} />
              ))}
            </div>
            <ul className="score-legend">
              {PROMISE_STATUSES.map((s) => (
                <li key={s.id}>
                  <span className="score-count">{counts[s.id]}</span>
                  <span className="score-label">
                    <span className="swatch-dot" style={{ background: s.color }} /> {s.label}
                  </span>
                </li>
              ))}
              <li>
                <span className="score-count">{total}</span>
                <span className="score-label">Promises tracked</span>
              </li>
            </ul>
            <p className="small" style={{ color: "var(--primary-pale)" }}>
              {lastUpdated ? `Last updated ${formatDate(lastUpdated)}.` : "Tracking began October 18, 2026."} Scored against the public record, with sources for every line.
            </p>
          </div>
          <ul className="tracker-toolbar" aria-label="Tracker tools">
            <li>
              <Link href="/tracker/methodology">How the promises are scored</Link>
            </li>
            <li>
              <a href="/tracker/feed.xml" type="application/rss+xml">
                RSS feed of every update
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
      </section>

      <section className="section">
        <div className="container stack" style={{ gap: 32 }}>
          <p className="lede" style={{ maxWidth: 860, color: "var(--ink)", fontWeight: 600 }}>
            {trackerIntro.summary}
          </p>
          <div className="features">
            {trackerHighlights.map((h) => (
              <article key={h.title} className="feature">
                <div className="bar" />
                <h3>{h.title}</h3>
                <p>{h.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section id="dates" className="section section--surface">
        <div className="container stack" style={{ gap: 24 }}>
          <div className="intro">
            <h2 className="display pop" style={{ fontSize: "clamp(34px, 5vw, 60px)" }}>
              Four budgets and one 90-day deadline
            </h2>
            <p className="lede">
              The helicopter window runs 90 days from the inaugural meeting, Elections BC filings fall due 90 days after voting day, each financial plan
              must be adopted by May 15, and the next election is Saturday, October 19, 2030.
            </p>
          </div>
          <KeyDates today={today} />
        </div>
      </section>

      <section id="promises" className="section">
        <div className="container stack" style={{ gap: 24 }}>
          <div className="intro" style={{ maxWidth: 860 }}>
            <h2 className="display pop" style={{ fontSize: "clamp(34px, 5vw, 60px)" }}>
              The {total} promises
            </h2>
            <p className="lede">
              {scoringNote} <Link href="/tracker/methodology">Read how each status is decided.</Link>
            </p>
          </div>
          <PromiseList promises={publicPromises} today={today} />
        </div>
      </section>

      <section id="announcements" className="section section--surface">
        <div className="container stack" style={{ gap: 24 }}>
          <div className="intro">
            <h2 className="display pop" style={{ fontSize: "clamp(34px, 5vw, 60px)" }}>
              Announcements
            </h2>
            <p className="lede">Every dated release and event behind the promises above, newest first. New commitments are added as the council makes them.</p>
          </div>
          <ol className="announcements">
            {announcements.map((a) => (
              <li key={a.id}>
                <p className="eyebrow">{a.dateLabel}</p>
                <h3 className="h3">{a.title}</h3>
                <p>{a.commitments}</p>
                {a.sources.length > 0 && (
                  <p className="small">
                    <SourceLinks sources={a.sources} />
                  </p>
                )}
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section id="subscribe" className="section section--primary on-dark">
        <div className="container split">
          <div className="stack" style={{ flex: "1 1 420px", gap: 14 }}>
            <h2 className="display pop" style={{ fontSize: "clamp(32px, 4.4vw, 52px)" }}>
              Subscribe to all updates
            </h2>
            <p className="lede">
              One email when a promise is scored, a deadline passes, or the council makes a new commitment. Want just one promise? Open it and follow it
              there.
            </p>
            <div className="btn-row">
              <Link href="/#join" className="btn btn--highlight btn--lg">
                Become a member
              </Link>
              <Link href="/donate" className="btn btn--ghost btn--lg">
                Chip in
              </Link>
            </div>
            <ul className="tracker-toolbar" aria-label="Other ways to follow">
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
          <div className="newsletter-bar" style={{ flex: "1 1 420px", alignSelf: "center" }}>
            <div className="copy">
              <label htmlFor="nl-email">Promise tracker updates</label>
              <p className="small">By subscribing you agree to receive email from Imagine Surrey. Unsubscribe anytime.</p>
            </div>
            <NewsletterForm source="tracker" />
          </div>
        </div>
      </section>

      <section id="sources" className="section">
        <div className="container stack" style={{ gap: 20 }}>
          <h2 className="h3" style={{ fontSize: 28 }}>
            Sources
          </h2>
          <p className="body" style={{ maxWidth: 860 }}>
            {sourcesNote}
          </p>
          <div className="source-groups">
            {sourceGroups.map((g) => (
              <div key={g.label}>
                <h3 className="eyebrow">{g.label}</h3>
                <ul>
                  {g.links.map((l) => (
                    <li key={l.url + l.label}>
                      <a href={l.url} target="_blank" rel="noopener noreferrer">
                        {l.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <p className="small">
            See something we&apos;ve missed or scored wrong? <Link href="/tracker/methodology#dispute">Dispute a score</Link>: email{" "}
            <a href="mailto:hello@imaginesurrey.ca">hello@imaginesurrey.ca</a> with a link to the record.
          </p>
        </div>
      </section>
    </>
  );
}
