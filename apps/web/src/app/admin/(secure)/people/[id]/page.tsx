import Link from "next/link";
import { notFound } from "next/navigation";
import { AnonymizeForm } from "@/components/admin/people/AnonymizeForm";
import { NoteForm } from "@/components/admin/people/NoteForm";
import { PersonForm } from "@/components/admin/people/PersonForm";
import { TagsEditor } from "@/components/admin/people/TagsEditor";
import { LOCALES } from "@/components/admin/people/query";
import { getDb } from "@/lib/db";
import { formatCents } from "@/lib/money";
import { can, requireAdmin } from "@/lib/server/admin-auth";
import { outboxForPerson } from "@/lib/server/base-ground-outbox";
import { displayName, filterFacets, loadPerson, type TimelineEntry } from "@/lib/server/supporters";
import { addNoteAction, addTagAction, anonymizeAction, removeTagAction, savePerson } from "./actions";
import "../people.css";

const WHEN = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver", year: "numeric", month: "long", day: "numeric" });

const STATUS_TONE: Record<string, string> = {
  active: "badge--ok",
  succeeded: "badge--ok",
  sent: "badge--ok",
  paid: "badge--ok",
  fulfilled: "badge--ok",
  attended: "badge--ok",
  confirmed: "badge--ok",
  "checked in": "badge--ok",
  pending: "badge--warn",
  pending_payment: "badge--warn",
  queued: "badge--warn",
  scheduled: "badge--primary",
  expired: "badge--bad",
  failed: "badge--bad",
  cancelled: "badge--bad",
  refunded: "badge--bad",
  refunded_over_limit: "badge--bad",
  no_show: "badge--bad",
  skipped: "badge",
};

function Status({ value }: { value: string | null }) {
  if (!value) return null;
  return <span className={`badge ${STATUS_TONE[value] ?? ""}`}>{value.replace(/_/g, " ")}</span>;
}

function entryAmount(e: TimelineEntry): string | null {
  if (e.amount_cents === null) return null;
  const refund = e.refunded_cents ? ` (refunded ${formatCents(e.refunded_cents)})` : "";
  return `${formatCents(e.amount_cents)}${refund}`;
}

export default async function PersonPage({ params }: PageProps<"/admin/people/[id]">) {
  const user = await requireAdmin("people");
  const money = can(user, "money");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const db = getDb();
  const [profile, facets, desk] = await Promise.all([loadPerson(db, id, { money }), filterFacets(db), outboxForPerson(db, id)]);
  if (!profile) notFound();
  const { person, membership, newsletter } = profile;
  const name = displayName(person);
  const anonymized = person.email.endsWith("@invalid");
  const locale = LOCALES.find((l) => l.id === (person.locale ?? ""))?.label ?? person.locale;

  return (
    <>
      <div className="crm-head">
        <div>
          <p className="small">
            <Link href="/admin/people">Supporters</Link> / profile
          </p>
          <h1 className="h3">{name}</h1>
        </div>
        <div className="crm-sub" aria-label="Status">
          {membership.status === "active" && <span className="badge badge--ok">Member until {membership.expiresAt ? DAY.format(membership.expiresAt) : ""}</span>}
          {membership.status === "expired" && <span className="badge badge--bad">Membership expired</span>}
          {membership.status === "pending" && <span className="badge badge--warn">Membership pending payment</span>}
          {money && profile.donatedThisYearCents > 0 && <span className="badge badge--primary">Gave {formatCents(profile.donatedThisYearCents)} this year</span>}
          {anonymized && <span className="badge badge--bad">Anonymized</span>}
        </div>
      </div>

      <div className="profile-grid">
        <div className="stack" style={{ gap: 24 }}>
          <section className="profile-card" aria-labelledby="details-title">
            <h2 id="details-title">Details</h2>
            <dl className="facts">
              <dt>Email</dt>
              <dd>{person.email}</dd>
              <dt>Phone</dt>
              <dd>{person.phone ?? "—"}</dd>
              <dt>Address</dt>
              <dd>{[person.address, person.city, person.province, person.postalCode].filter(Boolean).join(", ") || "—"}</dd>
              <dt>Neighbourhood</dt>
              <dd>{person.neighbourhood ?? "—"}</dd>
              <dt>Languages</dt>
              <dd>
                {(person.languages ?? []).join(", ") || "—"}
                {locale ? ` · prefers ${locale}` : ""}
              </dd>
              <dt>Interests</dt>
              <dd>{[person.interestVolunteer && "volunteering", person.interestLawnSign && "a lawn sign", person.student && `student${person.campus ? ` at ${person.campus}` : ""}`].filter(Boolean).join(", ") || "—"}</dd>
              <dt>Issue</dt>
              <dd>{person.issue ?? "—"}</dd>
              <dt>Source</dt>
              <dd>{person.source ?? "—"}</dd>
              <dt>Base Ground id</dt>
              <dd>{person.baseGroundPersonId ? <span className="secret">{person.baseGroundPersonId}</span> : "—"}</dd>
              <dt>Added</dt>
              <dd>{WHEN.format(person.createdAt)}</dd>
            </dl>
            <details>
              <summary className="link-button">Edit details</summary>
              <div style={{ marginTop: 14 }}>
                <PersonForm
                  action={savePerson}
                  person={{
                    id: person.id,
                    firstName: person.firstName,
                    lastName: person.lastName,
                    phone: person.phone,
                    address: person.address,
                    city: person.city,
                    province: person.province,
                    postalCode: person.postalCode,
                    neighbourhood: person.neighbourhood,
                    birthdate: person.birthdate,
                    citizenshipStatus: person.citizenshipStatus,
                    gender: person.gender,
                    languages: person.languages,
                    student: person.student,
                    campus: person.campus,
                    issue: person.issue,
                    interestVolunteer: person.interestVolunteer,
                    interestLawnSign: person.interestLawnSign,
                    locale: person.locale,
                    source: person.source,
                  }}
                />
              </div>
            </details>
          </section>

          <section className="profile-card" aria-labelledby="timeline-title">
            <h2 id="timeline-title">Timeline</h2>
            {profile.timeline.length === 0 ? (
              <p className="small">Nothing recorded yet.</p>
            ) : (
              <ol className="timeline">
                {profile.timeline.map((e, i) => (
                  <li key={`${e.kind}-${i}`} data-kind={e.kind}>
                    <div className="timeline__when">{WHEN.format(e.at)}</div>
                    <div className="timeline__title">
                      {e.title}
                      {entryAmount(e) && <> · {entryAmount(e)}</>} <Status value={e.status} />
                    </div>
                    {e.detail && <div className="timeline__detail">{e.detail}</div>}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>

        <div className="stack" style={{ gap: 24 }}>
          <section className="profile-card" aria-labelledby="tags-title">
            <h2 id="tags-title">Tags</h2>
            <TagsEditor id={person.id} tags={person.tags} suggestions={facets.tags} addAction={addTagAction} removeAction={removeTagAction} />
          </section>

          <section className="profile-card" aria-labelledby="notes-title">
            <h2 id="notes-title">Notes</h2>
            <NoteForm id={person.id} action={addNoteAction} />
            {profile.notes.length > 0 && (
              <ul className="notes">
                {profile.notes.map((n) => (
                  <li key={n.id} className="note">
                    <span className="note__meta">
                      {n.authorName ?? "Staff"} · {WHEN.format(n.createdAt)}
                    </span>
                    {n.body}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="profile-card profile-card--surface" aria-labelledby="consent-title">
            <h2 id="consent-title">Consent</h2>
            <dl className="facts">
              <dt>Email</dt>
              <dd>{person.contactConsentAt ? `Consented ${WHEN.format(person.contactConsentAt)}` : "No consent recorded"}</dd>
              <dt>Texts</dt>
              <dd>{person.smsConsentAt ? `Consented ${WHEN.format(person.smsConsentAt)}` : "No consent recorded"}</dd>
              <dt>Newsletter</dt>
              <dd>
                {!newsletter && "Not on the list"}
                {newsletter?.status === "subscribed" && `Subscribed${newsletter.confirmedAt ? ` (confirmed ${WHEN.format(newsletter.confirmedAt)})` : ""}`}
                {newsletter?.status === "pending" && `Waiting for confirmation since ${WHEN.format(newsletter.subscribedAt)}`}
                {newsletter?.status === "unsubscribed" && `Unsubscribed${newsletter.unsubscribedAt ? ` ${WHEN.format(newsletter.unsubscribedAt)}` : ""}`}
              </dd>
            </dl>
            <p className="small">Consent is read-only: under CASL only the person can give it, through their own tick or confirmation click.</p>
          </section>

          <section className="profile-card" aria-labelledby="desk-title">
            <h2 id="desk-title">Sent to Base Ground</h2>
            {desk.length === 0 ? (
              <p className="small">Nothing from this supporter has been forwarded to the desk.</p>
            ) : (
              <ul className="notes" data-base-ground-rows>
                {desk.map((r) => (
                  <li key={r.id} className="note">
                    <span className="note__meta">
                      {WHEN.format(r.createdAt)} · {r.kind} <Status value={r.status} />
                      {r.attempts > 1 ? ` · ${r.attempts} attempts` : ""}
                    </span>
                    {r.lastError && r.status !== "sent" ? r.lastError : r.sentAt ? `Sent ${WHEN.format(r.sentAt)}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="profile-card" aria-labelledby="referral-title">
            <h2 id="referral-title">Referrals</h2>
            <dl className="facts">
              <dt>Share code</dt>
              <dd>
                <span className="secret">{profile.referralCode || "—"}</span>
              </dd>
              <dt>Referred by</dt>
              <dd>{profile.referredBy ? <Link href={`/admin/people/${profile.referredBy.id}`}>{profile.referredBy.name}</Link> : "—"}</dd>
              <dt>Brought in</dt>
              <dd>
                {profile.referrals.length === 0 ? (
                  "No one yet"
                ) : (
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {profile.referrals.map((r) => (
                      <li key={r.id}>
                        <Link href={`/admin/people/${r.id}`}>{r.name}</Link> <span className="small">({DAY.format(r.createdAt)})</span>
                      </li>
                    ))}
                  </ul>
                )}
              </dd>
            </dl>
          </section>

          <section className="profile-card profile-card--danger" aria-labelledby="danger-title">
            <h2 id="danger-title">Deletion request</h2>
            {anonymized ? (
              <div role="status" className="alert alert--note">
                <span aria-hidden="true" className="alert-icon">
                  ✓
                </span>
                <span>Personal details were removed after a deletion request. Contribution records are kept as the law requires.</span>
              </div>
            ) : (
              <AnonymizeForm id={person.id} name={name} action={anonymizeAction} />
            )}
          </section>
        </div>
      </div>
    </>
  );
}
