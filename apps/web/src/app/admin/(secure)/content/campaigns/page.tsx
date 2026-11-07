import Link from "next/link";
import { AdminPage } from "@/components/admin/content/AdminPage";
import { ADMIN_PATHS } from "@/components/admin/content/fields";
import { Badge } from "@/components/admin/content/Inputs";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/server/admin-auth";
import { FIXED_CAMPAIGN_SLUGS, listCampaigns } from "@/lib/server/content-admin";

export default async function CampaignsAdmin({ searchParams }: PageProps<"/admin/content/campaigns">) {
  await requireAdmin("content");
  const sp = await searchParams;
  const rows = await listCampaigns(getDb());
  return (
    <AdminPage
      title="Petitions and pledges"
      crumbs={[{ href: "/admin/content", label: "Content" }]}
      intro="The pledge and the SkyTrain petition are built into the home page. Other campaigns get their own page at /act/<address>. Signatures are exported from the dashboard."
      actions={
        <>
          <a href="/api/admin/export/signatures" className="btn btn--outline">
            Download signatures (CSV)
          </a>
          <Link href={`${ADMIN_PATHS.campaigns}/new`} className="btn btn--accent">
            Start a campaign
          </Link>
        </>
      }
    >
      {sp.deleted && (
        <div role="status" className="alert alert--note">
          <span aria-hidden="true" className="alert-icon">
            ✓
          </span>
          <span>The campaign was deleted.</span>
        </div>
      )}
      <div className="table-wrap">
        <table className="table cms-table">
          <thead>
            <tr>
              <th scope="col">Campaign</th>
              <th scope="col">Kind</th>
              <th scope="col">Signatures</th>
              <th scope="col">Goal</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id}>
                <td>
                  <Link href={`${ADMIN_PATHS.campaigns}/${c.id}`}>
                    <strong>{c.title}</strong>
                  </Link>
                  <br />
                  <span className="small">
                    {c.slug}
                    {FIXED_CAMPAIGN_SLUGS.includes(c.slug) ? " · on the home page" : ""}
                  </span>
                </td>
                <td className="nowrap">{c.kind === "pledge" ? "Pledge" : "Petition"}</td>
                <td>{c.signatures}</td>
                <td>{c.goal ?? "—"}</td>
                <td className="nowrap">{c.active ? <Badge tone="live">Active</Badge> : <Badge tone="off">Closed</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AdminPage>
  );
}
