import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/admin/content/ActionForm";
import { AdminPage, SavedNotice } from "@/components/admin/content/AdminPage";
import { CampaignForm } from "@/components/admin/content/CampaignForm";
import { ADMIN_PATHS } from "@/components/admin/content/fields";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/server/admin-auth";
import { FIXED_CAMPAIGN_SLUGS, loadCampaign } from "@/lib/server/content-admin";
import { deleteCampaign } from "../actions";

const UUID = /^[0-9a-f-]{36}$/i;

export default async function EditCampaign({ params, searchParams }: PageProps<"/admin/content/campaigns/[id]">) {
  await requireAdmin("content");
  const { id } = await params;
  const sp = await searchParams;
  const data = UUID.test(id) ? await loadCampaign(getDb(), id) : undefined;
  if (!data) notFound();
  const { campaign, signatures } = data;
  const fixed = FIXED_CAMPAIGN_SLUGS.includes(campaign.slug);
  return (
    <AdminPage
      title={campaign.title}
      eyebrow={campaign.kind === "pledge" ? "Edit pledge" : "Edit petition"}
      crumbs={[{ href: "/admin/content", label: "Content" }, { href: ADMIN_PATHS.campaigns, label: "Petitions and pledges" }]}
      actions={
        <Link href={fixed ? "/" : `/act/${campaign.slug}`} className="btn btn--outline" target="_blank" rel="noreferrer">
          View on the site ↗
        </Link>
      }
    >
      <SavedNotice saved={sp.saved} />
      <div className="rsvp-counts" role="list">
        <div className="cms-stat" role="listitem">
          <strong>{signatures}</strong> signature{signatures === 1 ? "" : "s"}
          {campaign.goal ? ` of ${campaign.goal.toLocaleString("en-CA")}` : ""}
        </div>
        <div className="cms-stat" role="listitem" style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: 4 }}>
          <a href="/api/admin/export/signatures">Download signatures (CSV)</a>
          <Link href="/admin/exports">All exports</Link>
        </div>
      </div>
      <CampaignForm campaign={{ ...campaign }} slugLock={fixed ? "fixed" : signatures > 0 ? "signed" : null} />
      <div className="cms-danger">
        {fixed ? (
          <p>This campaign is built into the home page, so it can&apos;t be deleted. Untick &ldquo;Active&rdquo; to stop collecting signatures.</p>
        ) : signatures > 0 ? (
          <p>This campaign has signatures, so it can&apos;t be deleted. Untick &ldquo;Active&rdquo; to close it.</p>
        ) : (
          <>
            <p>No signatures yet, so the campaign can be deleted for good.</p>
            <ActionForm action={deleteCampaign} fields={{ id: campaign.id }} buttonClassName="btn btn--danger" confirm="Delete this campaign for good? This can't be undone." pendingText="Deleting…">
              Delete campaign
            </ActionForm>
          </>
        )}
      </div>
    </AdminPage>
  );
}
