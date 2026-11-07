import type { ReactNode } from "react";
import { SignatureForm } from "@/components/forms/SignatureForm";
import type { ShareLinks } from "@/lib/share";
import { SHARE_CHANNELS } from "../links";

export type CampaignSummary = {
  slug: string;
  title: string;
  kind: "petition" | "pledge";
  question: string | null;
};

/**
 * A campaign page's body and share row beside the signature form. It shows no
 * signature count: the public site publishes no supporter numbers (they stay
 * in the admin). `children` is the server-rendered body and statement.
 */
export function CampaignSign({ campaign, share, children }: { campaign: CampaignSummary; share: ShareLinks; children: ReactNode }) {
  return (
    <div className="split act-split">
      <div className="stack act-main" style={{ gap: 28 }}>
        {children}
        <div className="stack" style={{ gap: 10 }}>
          <h2 className="h3" style={{ fontSize: 22 }}>
            Share this {campaign.kind}
          </h2>
          <div className="share-links">
            {SHARE_CHANNELS.map((c) => (
              <a key={c.key} className="btn btn--outline" href={share[c.key]} target={c.key === "sms" || c.key === "email" ? undefined : "_blank"} rel="noopener noreferrer">
                {c.label}
              </a>
            ))}
          </div>
        </div>
      </div>
      <div className="act-form" style={{ flex: "1 1 400px" }}>
        <SignatureForm campaign={campaign.slug} kind={campaign.kind} question={campaign.question} idPrefix="act" />
      </div>
    </div>
  );
}
