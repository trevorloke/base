import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHead } from "@/components/PageHead";
import { env } from "@/lib/env";
import { excerpt, renderMarkdown } from "@/lib/markdown";
import { getCampaign } from "@/lib/server/campaigns";
import { CAMPAIGN_SLUG_RE } from "@/lib/validation";
import { campaignShareLinks } from "../links";
import { CampaignSign } from "./CampaignSign";
import "../act.css";

export const revalidate = 3600;

export async function generateMetadata({ params }: PageProps<"/act/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const campaign = CAMPAIGN_SLUG_RE.test(slug) ? await getCampaign(slug) : null;
  if (!campaign) return {};
  const description = excerpt(campaign.body || campaign.statement, 160);
  return {
    title: campaign.title,
    description,
    openGraph: { title: campaign.title, description, type: "website", url: `/act/${slug}` },
    twitter: { card: "summary_large_image", title: campaign.title, description },
  };
}

export default async function CampaignPage({ params }: PageProps<"/act/[slug]">) {
  const { slug } = await params;
  if (!CAMPAIGN_SLUG_RE.test(slug)) notFound();
  const campaign = await getCampaign(slug);
  if (!campaign) notFound();
  const url = `${env.siteUrl}/act/${slug}`;
  const share = campaignShareLinks({ url, text: campaign.shareText || `I signed "${campaign.title}". Add your name:`, subject: campaign.title });
  const kindLabel = campaign.kind === "pledge" ? "Pledge" : "Petition";

  return (
    <>
      <PageHead title={campaign.title} eyebrow={kindLabel}>
        {excerpt(campaign.body || campaign.statement, 220)}
      </PageHead>
      <section className="section">
        <div className="container">
          <CampaignSign
            campaign={{ slug: campaign.slug, title: campaign.title, kind: campaign.kind, question: campaign.question }}
            share={share}
          >
            {campaign.body && <div className="prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(campaign.body) }} />}
            {campaign.statement && (
              <blockquote className="act-statement">
                <p className="eyebrow">{campaign.kind === "pledge" ? "The pledge" : "The petition"}</p>
                <p>{campaign.statement}</p>
              </blockquote>
            )}
            <p className="small" style={{ margin: 0 }}>
              Collecting names on paper?{" "}
              <Link href={`/act/${slug}/print`} className="text-link" style={{ fontSize: 15 }}>
                Print a signature sheet
              </Link>
              .
            </p>
          </CampaignSign>
        </div>
      </section>
    </>
  );
}
