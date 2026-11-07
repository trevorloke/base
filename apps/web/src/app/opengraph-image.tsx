import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { env } from "@/lib/env";
import { shellSettings } from "@/lib/server/home";

// The default share card for every page that doesn't set its own.
export const alt = "Imagine Surrey";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Static Montserrat instances (black and medium) cut from src/fonts: the
// image renderer reads TTF, not WOFF2.
const fontDir = join(process.cwd(), "src/components/shell/fonts");

export default async function OpengraphImage() {
  const [{ org, seo }, black, medium] = await Promise.all([
    shellSettings(),
    readFile(join(fontDir, "montserrat-black.ttf")),
    readFile(join(fontDir, "montserrat-medium.ttf")),
  ]);
  const name = org.name || "Imagine Surrey";
  const host = new URL(env.siteUrl).host;
  const description = seo.description.length > 190 ? `${seo.description.slice(0, 187).replace(/\s\S*$/, "")}…` : seo.description;

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "72px 80px", background: "#003979", color: "#fff", fontFamily: "Montserrat" }}>
        <div style={{ display: "flex", width: 120, height: 14, background: "#EF2023" }} />
        <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
          <div style={{ display: "flex", fontSize: 112, fontWeight: 900, lineHeight: 1, letterSpacing: "0.01em", color: "#FFF100", textShadow: "6px 6px 0 #EF2023" }}>{name}</div>
          <div style={{ display: "flex", fontSize: 36, fontWeight: 500, lineHeight: 1.35, color: "#D3DEEF", maxWidth: 1000 }}>{description}</div>
        </div>
        <div style={{ display: "flex", fontSize: 26, fontWeight: 900, letterSpacing: "0.04em", color: "#fff" }}>{host}</div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "Montserrat", data: black, weight: 900, style: "normal" },
        { name: "Montserrat", data: medium, weight: 500, style: "normal" },
      ],
    },
  );
}
