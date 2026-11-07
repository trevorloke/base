import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A self-contained server (.next/standalone) for the Docker image.
  output: "standalone",
  // Which client this build is for, fixed into server and browser code alike
  // (src/seeds/client.ts, src/lib/jurisdiction.ts, src/lib/settings.ts).
  env: {
    BASE_WEB_CLIENT: process.env.BASE_WEB_CLIENT ?? "",
    BASE_WEB_ORG_NAME: process.env.BASE_WEB_ORG_NAME ?? "",
    BASE_WEB_ORG_EMAIL: process.env.BASE_WEB_ORG_EMAIL ?? "",
    BASE_WEB_JURISDICTION: process.env.BASE_WEB_JURISDICTION ?? "",
  },
  // Stripe and postgres are server-only Node packages.
  serverExternalPackages: ["postgres"],
  poweredByHeader: false,
  async redirects() {
    return [
      // The public numbers page was retired; old links and bookmarks land on the home page.
      { source: "/stats", destination: "/", permanent: true },
    ];
  },
};

export default nextConfig;
