import Link from "next/link";
import { dayAndMonth, formatEventTime } from "@/lib/dates";
import type { PublicEvent } from "@/lib/server/neighbourhoods";

/** Compact event cards for light backgrounds: when, where, neighbourhood, spots and who's going. */
export function EventCards({ events }: { events: PublicEvent[] }) {
  return (
    <ul className="event-cards">
      {events.map((ev) => {
        const starts = new Date(ev.startsAt);
        const { day, mon } = dayAndMonth(starts);
        return (
          <li key={ev.id} className="event-card">
            <div className="date-badge date-badge--sm" aria-hidden="true">
              <span className="day">{day}</span>
              <span className="mon">{mon}</span>
            </div>
            <div className="event-card-body">
              <h3>
                <Link href={`/events/${ev.slug}`}>{ev.title}</Link>
              </h3>
              <p>
                {formatEventTime(starts)} · {ev.location}
              </p>
              <div className="event-card-meta">
                {ev.neighbourhood ? <span className="badge">{ev.neighbourhood}</span> : <span className="badge badge--citywide">City-wide</span>}
                {ev.going >= 3 && <span className="small">{ev.going} going</span>}
                {ev.spotsLeft != null && <span className={`spots ${ev.spotsLeft === 0 ? "spots--full" : ev.spotsLeft <= 5 ? "spots--low" : ""}`}>{ev.spotsLeft === 0 ? "Full" : `${ev.spotsLeft} spots left`}</span>}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
