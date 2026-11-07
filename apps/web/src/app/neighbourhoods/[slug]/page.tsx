import "../../volunteer/volunteer.css";
import "../neighbourhoods.css";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EventCards } from "@/components/neighbourhoods/EventCards";
import { PageHead } from "@/components/PageHead";
import { ShareButtons } from "@/components/ShareButtons";
import { env } from "@/lib/env";
import { NEIGHBOURHOOD_SLUGS, neighbourhoodFromSlug, neighbourhoodSlug } from "@/lib/neighbourhoods";
import { neighbourhoodPage } from "@/lib/server/neighbourhoods";
import { getSettings } from "@/lib/server/settings";
import { shareLinks } from "@/lib/share";
import { formatLongDate, SLOT_BY_ID, todayInSurrey } from "@/lib/shifts";
import { clientProfile } from "@/seeds/client";
import { STATUS_BY_ID } from "@/lib/tracker";

export const revalidate = 3600;

export function generateStaticParams() {
  return NEIGHBOURHOOD_SLUGS.map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: PageProps<"/neighbourhoods/[slug]">): Promise<Metadata> {
  const name = neighbourhoodFromSlug((await params).slug);
  return name ? { title: `${name}`, description: `${clientProfile.orgName} in ${name}: events near you, volunteer shifts, and the promises that affect your neighbourhood.` } : {};
}

// The seeded campaigns live on the home page; any other campaign has its own page.
function campaignHref(slug: string): string {
  if (slug === "stop-mccallum-pledge") return "/#pledge";
  if (slug === "skytrain-south-surrey") return "/#skytrain";
  return `/act/${slug}`;
}

export default async function NeighbourhoodPage({ params }: PageProps<"/neighbourhoods/[slug]">) {
  const name = neighbourhoodFromSlug((await params).slug);
  if (!name) notFound();
  const slug = neighbourhoodSlug(name)!;
  const [{ committees }, data] = await Promise.all([getSettings(), neighbourhoodPage(name, todayInSurrey())]);
  const joinHref = `/?neighbourhood=${encodeURIComponent(name)}#join`;
  const url = `${env.siteUrl}/neighbourhoods/${slug}`;
  const links = shareLinks({
    url,
    text: `${clientProfile.orgName} in ${name}: what's happening near us, how to help, and the promises City Hall made to our neighbourhood.`,
    subject: `${clientProfile.orgName} in ${name}`,
  });

  return (
    <>
      <PageHead title={name} eyebrow={committees.neighbourhoodsTitle}>
        {committees.neighbourhoodsIntro}
      </PageHead>

      <section className="section">
        <div className="container stack" style={{ gap: 28 }}>
          <div className="hood-ctas">
            <Link href={joinHref} className="btn btn--accent btn--lg">
              Join the {name} committee
            </Link>
            <Link href="/volunteer" className="btn btn--outline btn--lg">
              Volunteer near you
            </Link>
          </div>
          <ul className="hood-asks" aria-label={`Ways to help in ${name}`}>
            <li className="hood-ask">
              <span className="hood-ask-title">Become a member in {name}</span>
              <span className="hood-ask-label">Join your neighbours in {clientProfile.orgName}.</span>
              <Link href={joinHref}>Become a member</Link>
            </li>
            {data.campaigns.map((c) => (
              <li key={c.slug} className="hood-ask">
                <span className="hood-ask-title">{c.title}</span>
                <span className="hood-ask-label">Add your name to the {c.kind}.</span>
                <Link href={campaignHref(c.slug)}>
                  Add your name<span className="visually-hidden">: {c.title}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="section section--surface" aria-labelledby="hood-events">
        <div className="container stack" style={{ gap: 28 }}>
          <div className="hood-section-head">
            <h2 id="hood-events">Coming up in {name}</h2>
            <Link href="/events" className="text-link">
              All events
            </Link>
          </div>
          {data.events.length > 0 ? (
            <EventCards events={data.events} />
          ) : (
            <p className="empty-state">
              Nothing booked in {name} just yet. {data.cityWide.length > 0 ? "The city-wide events below are open to everyone." : ""}{" "}
              <Link href="/#newsletter">Get the newsletter</Link> and you&apos;ll hear first.
            </p>
          )}
          {data.cityWide.length > 0 && (
            <>
              <h3 className="h3" style={{ margin: "8px 0 0" }}>
                City-wide events
              </h3>
              <EventCards events={data.cityWide} />
            </>
          )}
        </div>
      </section>

      <section className="section" aria-labelledby="hood-volunteer">
        <div className="container stack" style={{ gap: 20 }}>
          <div className="hood-section-head">
            <h2 id="hood-volunteer">Volunteer in {name}</h2>
            <Link href="/volunteer" className="text-link">
              All shifts
            </Link>
          </div>
          {data.openings.length === 0 ? (
            <p className="empty-state">
              No shifts posted in {name} right now. <Link href="/volunteer">See every open shift</Link>, or <Link href={joinHref}>join</Link> and tick “Volunteering”.
            </p>
          ) : (
            <ul className="opening-list">
              {data.openings.map((o) => {
                const slot = SLOT_BY_ID[o.slot];
                return (
                  <li key={o.id} className={`opening-card ${o.spotsLeft === 0 ? "is-full" : ""}`}>
                    <div className="opening-body">
                      <p className="opening-when">
                        {formatLongDate(o.date)} · {slot.label} {slot.hours}
                      </p>
                      <h3 className="opening-title">{o.title}</h3>
                      <p className="opening-meta">
                        {o.taskName && <span className="badge">{o.taskName}</span>}
                        {o.location && <span>{o.location}</span>}
                      </p>
                      <p className={`spots ${o.spotsLeft === 0 ? "spots--full" : o.spotsLeft <= 2 ? "spots--low" : ""}`}>{o.spotsLeft === 0 ? "Full" : `${o.spotsLeft} of ${o.capacity} spots left`}</p>
                      <Link href={`/volunteer#opening-${o.id}`} className="btn btn--accent" style={{ alignSelf: "flex-start" }}>
                        {o.spotsLeft === 0 ? "See details" : "Sign up"}
                        <span className="visually-hidden"> for {o.title}</span>
                      </Link>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      <section className="section section--surface" aria-labelledby="hood-promises">
        <div className="container stack" style={{ gap: 20 }}>
          <div className="hood-section-head">
            <h2 id="hood-promises">Promises that affect {name}</h2>
            <Link href="/tracker" className="text-link">
              The full tracker
            </Link>
          </div>
          {data.promises.length === 0 ? (
            <p className="empty-state">
              No promise on the tracker is tagged for {name} yet. <Link href="/tracker">See every promise</Link>.
            </p>
          ) : (
            <ol className="promise-mini-list">
              {data.promises.map((p) => {
                const status = STATUS_BY_ID[p.status];
                return (
                  <li key={p.id} className="promise-mini">
                    <span className="promise-mini-number">#{p.number}</span>
                    <Link href={`/tracker#promise-${p.number}`}>{p.title}</Link>
                    <span className="status-badge" style={{ background: status.color, color: status.text }}>
                      {status.label}
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </section>

      <section className="section">
        <div className="container stack" style={{ gap: 16 }}>
          <ShareButtons heading={`Tell your neighbours about ${clientProfile.orgName} in ${name}`} label={`Share the ${name} page`} links={links} />
        </div>
      </section>
    </>
  );
}
