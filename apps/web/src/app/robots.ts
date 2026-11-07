import type { MetadataRoute } from "next";
import { connection } from "next/server";
import { env } from "@/lib/env";

// Built when asked for, so it names the address the running site is set to
// (NEXT_PUBLIC_SITE_URL), and a build without it still succeeds.
export default async function robots(): Promise<MetadataRoute.Robots> {
  await connection();
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/admin", "/api", "/me", "/preferences"] },
    sitemap: `${env.siteUrl}/sitemap.xml`,
  };
}
