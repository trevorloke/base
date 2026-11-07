import { AdminPage } from "@/components/admin/content/AdminPage";
import { EventForm } from "@/components/admin/content/EventForm";
import { requireAdmin } from "@/lib/server/admin-auth";

export default async function NewEvent() {
  await requireAdmin("content");
  return (
    <AdminPage title="Add an event" crumbs={[{ href: "/admin/content", label: "Content" }, { href: "/admin/content/events", label: "Events" }]}>
      <EventForm />
    </AdminPage>
  );
}
