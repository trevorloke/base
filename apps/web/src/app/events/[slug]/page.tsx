import "../../volunteer/volunteer.css";
import "../events.css";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AddToCalendar } from "@/components/AddToCalendar";
import { RsvpForm } from "@/components/forms/RsvpForm";
import { PageHead } from "@/components/PageHead";
import { ShareButtons } from "@/components/ShareButtons";
import { formatEventTime, timeOnly } from "@/lib/dates";
import { env } from "@/lib/env";
import { renderMarkdown } from "@/lib/markdown";
import { eventGoogleUrl, eventPublic, mapsUrl } from "@/lib/server/neighbourhoods";
import { shareLinks } from "@/lib/share";

export const revalidate = 3600;

export async function generateMetadata({ params }: PageProps<"/events/[slug]">): Promise<Metadata> {
  const event = await eventPublic((await params).slug);
  return event ? { title: event.title, description: event.summary, openGraph: event.imageUrl ? { images: [{ url: event.imageUrl }] } : undefined } : {};
}

export default async function EventPage({ params }: PageProps<"/events/[slug]">) {
  const event = await eventPublic((await params).slug);
  if (!event) notFound();
  const starts = new Date(event.startsAt);
  const ends = event.endsAt ? new Date(event.endsAt) : null;
  const past = starts < new Date();
  const full = event.spotsLeft === 0;
  const siteUrl = env.siteUrl;
  const url = `${siteUrl}/events/${event.slug}`;
  const links = shareLinks({ url, text: `${event.title}: ${formatEventTime(starts)} at ${event.location}. Come with me!`, subject: event.title });

  return (
    <>
      <PageHead title={event.title} eyebrow={`${formatEventTime(starts)} · ${event.location}`}>
        {event.summary}
      </PageHead>
      <section className="section">
        <div className="container split">
          <div className="stack" style={{ flex: "1 1 420px", gap: 24 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {event.imageUrl && <img className="event-page-image" src={event.imageUrl} alt="" />}
            <dl className="event-details">
              <dt>When</dt>
              <dd>
                {formatEventTime(starts)}
                {ends ? ` to ${timeOnly(ends)}` : ""}
              </dd>
              <dt>Where</dt>
              <dd>
                {event.location}
                {event.address && (
                  <>
                    <br />
                    <a href={mapsUrl(event.address)} target="_blank" rel="noopener noreferrer">
                      {event.address}
                      <span className="visually-hidden"> (map opens in a new tab)</span>
                    </a>
                  </>
                )}
              </dd>
              <dt>Area</dt>
              <dd>{event.neighbourhood ? <span className="badge">{event.neighbourhood}</span> : <span className="badge badge--citywide">City-wide</span>}</dd>
              {(event.going >= 3 || event.spotsLeft != null) && (
                <>
                  <dt>Who</dt>
                  <dd>
                    {event.going >= 3 && <span>{event.going} going. </span>}
                    {event.spotsLeft != null && <span className={`spots ${full ? "spots--full" : event.spotsLeft <= 5 ? "spots--low" : ""}`}>{full ? "Full" : `${event.spotsLeft} of ${event.capacity} spots left`}</span>}
                  </dd>
                </>
              )}
            </dl>
            {event.description ? <div className="prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(event.description) }} /> : null}
            {!past && <AddToCalendar googleUrl={eventGoogleUrl(event, siteUrl)} icsUrl={`/events/${event.slug}/calendar.ics`} title={event.title} />}
            <ShareButtons heading="Bring a neighbour" label={`Share ${event.title}`} links={links} />
            <Link href="/events" className="text-link">
              ← All events
            </Link>
          </div>
          <div style={{ flex: "1 1 380px" }}>
            {past ? (
              <p className="empty-state">This event has already happened.</p>
            ) : full ? (
              <p className="empty-state">
                This event is full. <Link href="/#newsletter">Get the newsletter</Link> and we&apos;ll tell you about the next one.
              </p>
            ) : (
              <RsvpForm slug={event.slug} />
            )}
          </div>
        </div>
      </section>
    </>
  );
}
