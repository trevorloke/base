import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CONSENT_WORDING } from "@/lib/consent-wording";
import { env } from "@/lib/env";
import { getCampaign } from "@/lib/server/campaigns";
import { CAMPAIGN_SLUG_RE } from "@/lib/validation";
import { PrintButton } from "./PrintButton";
import "./print.css";

export const revalidate = 3600;

const ROWS = 12;

export async function generateMetadata({ params }: PageProps<"/act/[slug]/print">): Promise<Metadata> {
  const { slug } = await params;
  const campaign = CAMPAIGN_SLUG_RE.test(slug) ? await getCampaign(slug) : null;
  return campaign ? { title: `${campaign.title}: paper signature sheet`, robots: { index: false } } : { robots: { index: false } };
}

/** A paper petition sheet, Letter size, for canvassing and events. */
export default async function PrintSheet({ params }: PageProps<"/act/[slug]/print">) {
  const { slug } = await params;
  if (!CAMPAIGN_SLUG_RE.test(slug)) notFound();
  const campaign = await getCampaign(slug);
  if (!campaign) notFound();
  const url = `${env.siteUrl}/act/${slug}`;
  const kind = campaign.kind === "pledge" ? "pledge" : "petition";

  return (
    <div className="sheet-page">
      <div className="sheet-tools">
        <PrintButton />
        <Link href={`/act/${slug}`} className="text-link">
          ← Back to the {kind}
        </Link>
      </div>
      <article className="sheet" aria-labelledby="sheet-title">
        <header className="sheet-head">
          <p className="sheet-org">Imagine Surrey · {kind === "pledge" ? "Pledge" : "Petition"}</p>
          <h1 id="sheet-title">{campaign.title}</h1>
          {campaign.statement && <p className="sheet-statement">{campaign.statement}</p>}
          <p className="sheet-url">
            Sign online: <strong>{url}</strong>
          </p>
        </header>
        <table className="sheet-table">
          <caption className="visually-hidden">Signatures, {ROWS} rows</caption>
          <thead>
            <tr>
              <th scope="col" className="sheet-num">
                #
              </th>
              <th scope="col">Name</th>
              <th scope="col">Postal code</th>
              <th scope="col">Email (optional) and ☐ email me</th>
              <th scope="col">Signature</th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: ROWS }, (_, i) => (
              <tr key={i} className="sheet-row">
                <td className="sheet-num">{i + 1}</td>
                <td />
                <td />
                <td>
                  <span className="sheet-box" aria-hidden="true" />
                </td>
                <td />
              </tr>
            ))}
          </tbody>
        </table>
        <footer className="sheet-foot">
          <p className="sheet-consent">
            Signing adds your name to this {kind}. Email is optional. Tick the box beside your email only if you agree: “{CONSENT_WORDING.updates}” Your details
            stay with Imagine Surrey (privacy policy at {env.siteUrl}/privacy).
          </p>
          <p className="sheet-return">Return completed sheets to Imagine Surrey, Surrey, BC · hello@imaginesurrey.ca</p>
        </footer>
      </article>
    </div>
  );
}
