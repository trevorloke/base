import Link from "next/link";
import { NextStepCard } from "@/components/engage/NextStepCard";
import { ShareSheet } from "@/components/engage/ShareSheet";
import { getDb } from "@/lib/db";
import { formatDate, formatEventTime } from "@/lib/dates";
import { nextStep, SHARE_TEXT } from "@/lib/engagement";
import { formatCents } from "@/lib/money";
import { engagementStateFor } from "@/lib/server/engagement";
import { requireMember } from "@/lib/server/member-auth";
import { loadPortal } from "@/lib/server/portal";
import { getSettings } from "@/lib/server/settings";
import { formatDay, SLOTS } from "@/lib/shifts";
import type { Slate } from "@/lib/contributions";

const SLATE_LABEL: Record<Slate, string> = { council: "City council slate", school_board: "School board slate" };
const slotLabel = (id: string) => SLOTS.find((s) => s.id === id);

export default async function MeHome({ searchParams }: PageProps<"/me">) {
  const person = await requireMember("/me");
  const sp = await searchParams;
  const db = getDb();
  const [data, state, { org }] = await Promise.all([loadPortal(db, person), engagementStateFor(db, person), getSettings()]);
  const step = nextStep(state);
  const { membership, giving, monthly, shifts, rsvps, signed, referral } = data;
  const hasCalendar = shifts.length > 0 || rsvps.length > 0;
  const billing = typeof sp.billing === "string" ? sp.billing : null;

  return (
    <>
      <h1>{person.firstName ? `Hi ${person.firstName}` : "Your supporter home"}</h1>
      <p className="portal-intro">Everything you do with {org.name} in one place: your membership, your giving, your shifts and events, and your personal link for bringing a neighbour in.</p>

      {billing === "unavailable" && (
        <div role="alert" className="alert">
          <span aria-hidden="true" className="alert-icon">
            !
          </span>
          <span>
            We couldn&apos;t open the billing portal just now. Email <a href={`mailto:${org.email}`}>{org.email}</a> and we&apos;ll change or pause your monthly gift for you.
          </span>
        </div>
      )}
      {billing === "none" && (
        <div role="status" className="alert alert--note">
          <span aria-hidden="true" className="alert-icon">
            !
          </span>
          <span>There&apos;s no monthly gift on this account to manage.</span>
        </div>
      )}

      <div className="portal-grid">
        <section className="portal-card" aria-labelledby="membership-h">
          <h2 id="membership-h">Membership</h2>
          {membership.status === "active" && (
            <>
              <span className="status-pill status-pill--active">Active member</span>
              <p>
                {membership.expiresAt ? `Renews by ${formatDate(membership.expiresAt)}.` : "No expiry date on file."}{" "}
                {membership.votingEligible ? "You can vote at member meetings." : "Members outside Surrey can take part but don't vote at member meetings."}
              </p>
              <div className="portal-actions">
                <Link href="/join" className="btn btn--outline btn--sm">
                  Renew early
                </Link>
              </div>
            </>
          )}
          {membership.status === "expired" && (
            <>
              <span className="status-pill status-pill--expired">Expired</span>
              <p>{membership.expiresAt ? `Your membership ended ${formatDate(membership.expiresAt)}.` : "Your membership has ended."} Renew to keep your vote and your say.</p>
              <div className="portal-actions">
                <Link href="/join" className="btn btn--red btn--sm">
                  Renew
                </Link>
              </div>
            </>
          )}
          {membership.status === "none" && (
            <>
              <span className="status-pill status-pill--none">Not a member yet</span>
              <p>{membership.pending ? "A membership payment was started but hasn't completed. Try again when you're ready." : "Members set the priorities and vote on who runs for council. It's $10 a year."}</p>
              <div className="portal-actions">
                <Link href="/join" className="btn btn--red btn--sm">
                  Become a member
                </Link>
              </div>
            </>
          )}
        </section>

        {(giving.rows.length > 0 || monthly.monthlyCents > 0) && (
          <section className="portal-card" aria-labelledby="giving-h">
            <h2 id="giving-h">Giving in {giving.year}</h2>
            {giving.slates.map((s) => {
              const text = `${formatCents(s.roomLeftCents)} of ${formatCents(giving.limitCents)} room left for ${giving.year}`;
              return (
                <div className="meter" key={s.slate}>
                  <p className="meter__text">
                    <strong>{SLATE_LABEL[s.slate]}:</strong> {formatCents(s.givenCents)} given
                  </p>
                  <div
                    className="meter__track"
                    role="meter"
                    aria-label={`${SLATE_LABEL[s.slate]} giving this year`}
                    aria-valuemin={0}
                    aria-valuemax={giving.limitCents}
                    aria-valuenow={Math.min(giving.limitCents, giving.limitCents - s.roomLeftCents)}
                    aria-valuetext={text}
                  >
                    <div className="meter__fill" style={{ width: `${Math.max(0, Math.min(100, ((giving.limitCents - s.roomLeftCents) / giving.limitCents) * 100))}%` }} />
                  </div>
                  <p className="meter__text">{text}</p>
                </div>
              );
            })}
            {giving.rows.length > 0 && (
              <ul className="portal-list">
                {giving.rows.map((r) => (
                  <li className="portal-item" key={r.id}>
                    <span className="portal-item__main">
                      <span className="portal-item__title">
                        {formatCents(r.netCents)} {r.kind === "membership_fee" ? "membership fee" : r.frequency === "monthly" ? "monthly gift" : "donation"}
                      </span>
                      <span className="portal-item__meta">
                        {r.paidAt ? formatDate(r.paidAt) : "Date pending"} · {SLATE_LABEL[r.slate]}
                        {r.status !== "succeeded" && " · partly or fully refunded"}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="small">BC law caps what one person can give to each slate in a calendar year. Refunds are taken off your total.</p>
          </section>
        )}

        {(monthly.monthlyCents > 0 || monthly.canManageBilling) && (
          <section className="portal-card" aria-labelledby="monthly-h">
            <h2 id="monthly-h">Monthly gift</h2>
            <p>{monthly.monthlyCents > 0 ? `You give ${formatCents(monthly.monthlyCents)} a month. Thank you: that pays for organizers all year.` : "Manage your payment details and past receipts."}</p>
            {monthly.canManageBilling ? (
              <form method="post" action="/api/me/billing-portal" className="portal-actions">
                <button type="submit" className="btn btn--navy btn--sm">
                  Manage monthly gift
                </button>
              </form>
            ) : (
              <p className="small">
                To change your monthly gift, email <a href={`mailto:${org.email}`}>{org.email}</a>.
              </p>
            )}
          </section>
        )}

        {shifts.length > 0 && (
          <section className="portal-card" aria-labelledby="shifts-h">
            <h2 id="shifts-h">My shifts</h2>
            <ul className="portal-list">
              {shifts.map((s) => {
                const day = formatDay(s.date);
                const slot = slotLabel(s.slot);
                return (
                  <li className="portal-item" key={s.id}>
                    <span className="portal-item__main">
                      <span className="portal-item__title">{s.title}</span>
                      <span className="portal-item__meta">
                        {day.weekday} {day.date} · {slot?.label} ({slot?.hours})
                        {s.location && ` · ${s.location}`}
                        {s.task && s.task !== s.title && ` · ${s.task}`}
                      </span>
                    </span>
                    <a href={s.calendarUrl} className="btn btn--outline btn--sm" target="_blank" rel="noopener">
                      Add to Google Calendar
                    </a>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {rsvps.length > 0 && (
          <section className="portal-card" aria-labelledby="rsvps-h">
            <h2 id="rsvps-h">My events</h2>
            <ul className="portal-list">
              {rsvps.map((r) => (
                <li className="portal-item" key={r.id}>
                  <span className="portal-item__main">
                    <Link href={`/events/${r.slug}`} className="portal-item__title">
                      {r.title}
                    </Link>
                    <span className="portal-item__meta">
                      {formatEventTime(r.startsAt)} · {r.location}
                      {r.guests > 0 && ` · you and ${r.guests} guest${r.guests === 1 ? "" : "s"}`}
                    </span>
                  </span>
                  <a href={r.calendarUrl} className="btn btn--outline btn--sm" target="_blank" rel="noopener">
                    Add to Google Calendar
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}

        {hasCalendar && (
          <section className="portal-card" aria-labelledby="calendar-h">
            <h2 id="calendar-h">Calendar</h2>
            <p>Put your shifts and events in Apple Calendar, Outlook or any calendar app.</p>
            <div className="portal-actions">
              <a href="/api/me/calendar.ics" className="btn btn--outline btn--sm" download="imagine-surrey.ics">
                Download calendar file
              </a>
            </div>
          </section>
        )}

        {signed.length > 0 && (
          <section className="portal-card" aria-labelledby="signed-h">
            <h2 id="signed-h">Signed</h2>
            <ul className="portal-list">
              {signed.map((s) => (
                <li className="portal-item" key={s.campaign}>
                  <span className="portal-item__main">
                    <span className="portal-item__title">{s.title}</span>
                    <span className="portal-item__meta">
                      {s.kind === "pledge" ? "Pledge" : s.kind === "petition" ? "Petition" : "Campaign"} · {formatDate(s.createdAt)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="portal-card portal-card--wide portal-card--white" aria-labelledby="bring-h" id="bring-a-neighbour">
          <h2 id="bring-h">Bring a neighbour</h2>
          <p>
            This is your personal link. Anyone who joins, signs or shows up through it is credited to you. <strong>People you&apos;ve brought in: {referral.referredCount}</strong>
          </p>
          <ShareSheet url={referral.url} text={SHARE_TEXT} label="Share your link" />
        </section>

        <div className="portal-card--wide">
          <NextStepCard step={step} heading="Your next step" />
        </div>
      </div>
    </>
  );
}
