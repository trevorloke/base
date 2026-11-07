import Link from "next/link";
import { AdminPage } from "@/components/admin/content/AdminPage";
import { ADMIN_PATHS } from "@/components/admin/content/fields";
import { Badge } from "@/components/admin/content/Inputs";
import { getDb } from "@/lib/db";
import { formatEventTime } from "@/lib/dates";
import { requireAdmin } from "@/lib/server/admin-auth";
import { listEvents } from "@/lib/server/content-admin";

export default async function EventsAdmin({ searchParams }: PageProps<"/admin/content/events">) {
  await requireAdmin("content");
  const sp = await searchParams;
  const rows = await listEvents(getDb());
  const now = Date.now();
  return (
    <AdminPage
      title="Events"
      crumbs={[{ href: "/admin/content", label: "Content" }]}
      intro="Published events are listed on /events with an RSVP form. Open an event to see who is coming and check people in at the door."
      actions={
        <Link href={`${ADMIN_PATHS.events}/new`} className="btn btn--red">
          Add an event
        </Link>
      }
    >
      {sp.deleted && (
        <div role="status" className="alert alert--note">
          <span aria-hidden="true" className="alert-icon">
            ✓
          </span>
          <span>The event was deleted.</span>
        </div>
      )}
      {rows.length === 0 ? (
        <p className="empty-state">No events yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="table cms-table">
            <thead>
              <tr>
                <th scope="col">Event</th>
                <th scope="col">When</th>
                <th scope="col">Where</th>
                <th scope="col">RSVPs</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id}>
                  <td>
                    <Link href={`${ADMIN_PATHS.events}/${e.id}`}>
                      <strong>{e.title}</strong>
                    </Link>
                  </td>
                  <td className="nowrap">{formatEventTime(e.startsAt)}</td>
                  <td>
                    {e.location}
                    {e.neighbourhood ? ` · ${e.neighbourhood}` : ""}
                  </td>
                  <td className="nowrap">
                    {e.rsvps}
                    {e.guests ? ` (+${e.guests} guests)` : ""}
                  </td>
                  <td className="nowrap">
                    {!e.published ? <Badge tone="off">Unpublished</Badge> : e.startsAt.getTime() < now - 6 * 3600_000 ? <Badge tone="draft">Past</Badge> : <Badge tone="live">Published</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AdminPage>
  );
}
