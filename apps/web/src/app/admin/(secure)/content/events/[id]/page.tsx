import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/admin/content/ActionForm";
import { AdminPage, SavedNotice } from "@/components/admin/content/AdminPage";
import { EventForm, WalkInForm } from "@/components/admin/content/EventForm";
import { ADMIN_PATHS } from "@/components/admin/content/fields";
import { Badge } from "@/components/admin/content/Inputs";
import { getDb } from "@/lib/db";
import { formatEventTime } from "@/lib/dates";
import { requireAdmin } from "@/lib/server/admin-auth";
import { loadEvent } from "@/lib/server/content-admin";
import { deleteEvent, setEventPublished, setRsvpCheckedIn } from "../actions";

const UUID = /^[0-9a-f-]{36}$/i;

export default async function EditEvent({ params, searchParams }: PageProps<"/admin/content/events/[id]">) {
  await requireAdmin("content");
  const { id } = await params;
  const sp = await searchParams;
  const data = UUID.test(id) ? await loadEvent(getDb(), id) : undefined;
  if (!data) notFound();
  const { event, rsvps, counts } = data;
  return (
    <AdminPage
      title={event.title}
      eyebrow="Edit event"
      intro={formatEventTime(event.startsAt)}
      crumbs={[{ href: "/admin/content", label: "Content" }, { href: ADMIN_PATHS.events, label: "Events" }]}
      actions={
        event.published ? (
          <Link href={`/events/${event.slug}`} className="btn btn--outline" target="_blank" rel="noreferrer">
            View on the site ↗
          </Link>
        ) : (
          <Badge tone="off">Unpublished</Badge>
        )
      }
    >
      <SavedNotice saved={sp.saved} />

      <section className="stack" style={{ gap: 14 }} aria-labelledby="rsvps-title">
        <h2 id="rsvps-title" className="h3" style={{ fontSize: 22 }}>
          RSVPs
        </h2>
        <div className="rsvp-counts" role="list">
          <div className="cms-stat" role="listitem">
            <strong>{counts.rsvps}</strong> RSVPs
          </div>
          <div className="cms-stat" role="listitem">
            <strong>{counts.guests}</strong> extra guests
          </div>
          <div className="cms-stat" role="listitem">
            <strong>{counts.checkedIn}</strong> checked in
          </div>
          {event.capacity ? (
            <div className="cms-stat" role="listitem">
              <strong>{event.capacity}</strong> capacity
            </div>
          ) : null}
        </div>
        {rsvps.length === 0 ? (
          <p className="empty-state">Nobody has RSVP&apos;d yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="table cms-table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Email</th>
                  <th scope="col">Guests</th>
                  <th scope="col">Source</th>
                  <th scope="col">Checked in</th>
                </tr>
              </thead>
              <tbody>
                {rsvps.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <strong>{r.name}</strong>
                    </td>
                    <td>{r.email}</td>
                    <td>{r.guests}</td>
                    <td>{r.source ?? "website"}</td>
                    <td>
                      <ActionForm
                        action={setRsvpCheckedIn}
                        fields={{ rsvpId: r.id, checkedIn: r.checkedInAt ? "0" : "1" }}
                        buttonClassName={r.checkedInAt ? "btn btn--primary btn--sm" : "btn btn--outline btn--sm"}
                        buttonProps={{ "aria-pressed": Boolean(r.checkedInAt), "aria-label": `${r.checkedInAt ? "Undo check-in for" : "Check in"} ${r.name}` }}
                        pendingText="Saving…"
                      >
                        {r.checkedInAt ? "Checked in ✓" : "Check in"}
                      </ActionForm>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <h3 className="h3" style={{ fontSize: 18 }}>
          Walk-in
        </h3>
        <p className="small">Someone at the door without an RSVP? Add them here; they are checked in right away and get a supporter record.</p>
        <WalkInForm eventId={event.id} />
      </section>

      <h2 className="h3" style={{ fontSize: 22 }}>
        Details
      </h2>
      <EventForm
        event={{
          id: event.id,
          title: event.title,
          slug: event.slug,
          startsAt: event.startsAt.toISOString(),
          endsAt: event.endsAt?.toISOString() ?? null,
          location: event.location,
          address: event.address,
          neighbourhood: event.neighbourhood,
          capacity: event.capacity,
          summary: event.summary,
          description: event.description,
          imageUrl: event.imageUrl,
          published: event.published,
        }}
      />
      <div className="cms-danger">
        {counts.rsvps > 0 ? (
          <>
            <p>This event has RSVPs, so it can&apos;t be deleted. Unpublishing hides it and closes RSVPs; the list above stays.</p>
            <ActionForm action={setEventPublished} fields={{ id: event.id, publish: event.published ? "0" : "1" }} buttonClassName={event.published ? "btn btn--outline" : "btn btn--primary"} confirm={event.published ? "Unpublish this event? It disappears from the site and RSVPs close." : undefined}>
              {event.published ? "Unpublish" : "Publish"}
            </ActionForm>
          </>
        ) : (
          <>
            <p>Nobody has RSVP&apos;d, so the event can be deleted for good.</p>
            <ActionForm action={deleteEvent} fields={{ id: event.id }} buttonClassName="btn btn--danger" confirm="Delete this event for good? This can't be undone." pendingText="Deleting…">
              Delete event
            </ActionForm>
          </>
        )}
      </div>
    </AdminPage>
  );
}
