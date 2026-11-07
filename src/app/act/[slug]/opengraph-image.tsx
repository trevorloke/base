import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { getCampaign } from "@/lib/server/campaigns";
import { CAMPAIGN_SLUG_RE } from "@/lib/validation";

export const alt = "Imagine Surrey campaign";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const NAVY = "#003979";
const YELLOW = "#FFF100";

// A static 800-weight instance of Montserrat: the share-image renderer reads
// TTF, OTF and WOFF, and src/fonts holds only the variable WOFF2.
const font = () => readFile(join(process.cwd(), "src/app/act/fonts/montserrat-bold.ttf"));

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const campaign = CAMPAIGN_SLUG_RE.test(slug) ? await getCampaign(slug) : null;
  const title = campaign?.title ?? "Take action with Imagine Surrey";
  const kind = campaign ? (campaign.kind === "pledge" ? "Pledge" : "Petition") : "";
  const ask = campaign?.kind === "pledge" ? "Take the pledge" : "Add your name";
  const titleSize = title.length > 60 ? 54 : title.length > 36 ? 64 : 76;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "64px 72px",
          background: NAVY,
          color: "#FFFFFF",
          fontFamily: "Montserrat",
        }}
      >
        <div style={{ display: "flex", fontSize: 28, letterSpacing: 6, textTransform: "uppercase", color: YELLOW }}>{kind}</div>
        <div style={{ display: "flex", fontSize: titleSize, lineHeight: 1.08, color: YELLOW, maxWidth: 1056 }}>{title}</div>
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
          <div style={{ display: "flex", fontSize: 36 }}>{campaign ? ask : ""}</div>
          <div style={{ display: "flex", alignItems: "center" }}>
            <div style={{ display: "flex", width: 18, height: 54, background: YELLOW, marginRight: 18 }} />
            <span style={{ fontSize: 36 }}>Imagine Surrey</span>
          </div>
        </div>
      </div>
    ),
    { ...size, fonts: [{ name: "Montserrat", data: await font(), weight: 800, style: "normal" }] },
  );
}
