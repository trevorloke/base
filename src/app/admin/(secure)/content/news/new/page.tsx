import { AdminPage } from "@/components/admin/content/AdminPage";
import { NewsForm } from "@/components/admin/content/NewsForm";
import { requireAdmin } from "@/lib/server/admin-auth";

export default async function NewNews() {
  await requireAdmin("content");
  return (
    <AdminPage title="Write a post" crumbs={[{ href: "/admin/content", label: "Content" }, { href: "/admin/content/news", label: "News" }]}>
      <NewsForm />
    </AdminPage>
  );
}
