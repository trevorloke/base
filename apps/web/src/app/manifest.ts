import type { MetadataRoute } from "next";
import { shellSettings } from "@/lib/server/home";
import { renderAtRequestTimeWithoutDatabase } from "@/lib/server/render-time";

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  await renderAtRequestTimeWithoutDatabase();
  const { org, seo } = await shellSettings();
  return {
    name: org.name,
    short_name: org.shortName || org.name,
    description: seo.description,
    start_url: "/",
    scope: "/",
    display: "standalone",
    theme_color: "#003979",
    background_color: "#ffffff",
    icons: [
      { src: "/icons/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icons/icon-maskable.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
    ],
  };
}
