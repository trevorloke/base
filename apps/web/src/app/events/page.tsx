import "../volunteer/volunteer.css";
import "./events.css";
import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/PageHead";
import { dayAndMonth, formatEventTime } from "@/lib/dates";
import { mapsUrl, upcomingEventsPublic } from "@/lib/server/neighbourhoods";
import { todayInSurrey } from "@/lib/shifts";

export const revalidate = 3600;

export const metadata: Metadata = { title: "Events", description: "Come and meet Imagine Surrey at an event near you." };

export default async function EventsIndex() {
  const events = await upcomingEventsPublic(todayInSurrey());
  return (
    <>
      <PageHead title="Come and meet us">Town halls, door-knocking, socials, and neighbourhood meetings across Surrey.</PageHead>
      <section className="section section--accent on-dark">
        <div className="container stack" style={{ gap: 16 }}>
          {events.length === 0 ? (
            <p className="lede" style={{ color: "#fff" }}>
              No events are booked right now. <Link href="/#newsletter" style={{ color: "#fff" }}>Get the newsletter</Link> and we&apos;ll tell you when the next one is.
            </p>
          ) : (
            events.map((ev) => {
              const starts = new Date(ev.startsAt);
              const { day, mon } = dayAndMonth(starts);
              const full = ev.spotsLeft === 0;
              return (
                <article key={ev.id} className="event-feature">
                  <div className="date-badge">
                    <span className="day">{day}</span>
                    <span className="mon">{mon}</span>
                  </div>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {ev.imageUrl && <img className="event-image" src={ev.imageUrl} alt="" />}
                  <div className="info">
                    <h2 style={{ margin: 0, fontWeight: 800, fontSize: 28, lineHeight: 1.15, color: "#fff" }}>{ev.title}</h2>
                    <p className="event-when">
                      {formatEventTime(starts)}, {ev.location}
                    </p>
                    <p className="event-meta">
                      {ev.neighbourhood && <span className="badge">{ev.neighbourhood}</span>}
                      {ev.address && (
                        <a href={mapsUrl(ev.address)} target="_blank" rel="noopener noreferrer">
                          {ev.address}
                          <span className="visually-hidden"> (map opens in a new tab)</span>
                        </a>
                      )}
                      {ev.spotsLeft != null && <span className={`spots ${full ? "spots--full" : ev.spotsLeft <= 5 ? "spots--low" : ""}`}>{full ? "Full" : `${ev.spotsLeft} spots left`}</span>}
                    </p>
                    <p className="summary">{ev.summary}</p>
                    {ev.going >= 3 && <p className="event-going">{ev.going} going</p>}
                  </div>
                  <Link href={`/events/${ev.slug}`} className="btn btn--highlight btn--lg">
                    {full ? "Details" : "RSVP"}
                    <span className="visually-hidden"> for {ev.title}</span>
                  </Link>
                </article>
              );
            })
          )}
        </div>
      </section>
    </>
  );
}
