import type { MetadataRoute } from "next";
import { shellBrand } from "@/lib/server/brand";
import { shellSettings } from "@/lib/server/home";
import { renderAtRequestTimeWithoutDatabase } from "@/lib/server/render-time";

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  await renderAtRequestTimeWithoutDatabase();
  const [{ org, seo }, brand] = await Promise.all([shellSettings(), shellBrand()]);
  return {
    name: org.name,
    short_name: org.shortName || org.name,
    description: seo.description,
    start_url: "/",
    scope: "/",
    display: "standalone",
    theme_color: brand.colors.primary,
    background_color: brand.colors.background,
    icons: [
      { src: "/icons/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icons/icon-maskable.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
    ],
  };
}
