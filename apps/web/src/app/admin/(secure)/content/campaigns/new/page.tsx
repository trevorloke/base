import { AdminPage } from "@/components/admin/content/AdminPage";
import { CampaignForm } from "@/components/admin/content/CampaignForm";
import { requireAdmin } from "@/lib/server/admin-auth";

export default async function NewCampaign() {
  await requireAdmin("content");
  return (
    <AdminPage title="Start a campaign" crumbs={[{ href: "/admin/content", label: "Content" }, { href: "/admin/content/campaigns", label: "Petitions and pledges" }]}>
      <CampaignForm />
    </AdminPage>
  );
}
