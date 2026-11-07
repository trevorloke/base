import { AdminPage } from "@/components/admin/content/AdminPage";
import { PageForm } from "@/components/admin/content/PageForm";
import { requireAdmin } from "@/lib/server/admin-auth";

export default async function NewPage() {
  await requireAdmin("content");
  return (
    <AdminPage title="Create a page" crumbs={[{ href: "/admin/content", label: "Content" }, { href: "/admin/pages", label: "Pages" }]}>
      <PageForm />
    </AdminPage>
  );
}
