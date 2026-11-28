import type { NextConfig } from "next";
import { OLD_ADMIN_PATH } from "./src/lib/old-names";

const nextConfig: NextConfig = {
  // Stripe and postgres are server-only Node packages.
  serverExternalPackages: ["postgres"],
  poweredByHeader: false,
  async redirects() {
    return [
      // The public numbers page was retired; old links and bookmarks land on the home page.
      { source: "/stats", destination: "/", permanent: true },
      // The desk's admin pages moved with the rename; old links and bookmarks still land there.
      { source: OLD_ADMIN_PATH, destination: "/admin/integrations/desk", permanent: true },
      { source: `${OLD_ADMIN_PATH}/:path*`, destination: "/admin/integrations/desk/:path*", permanent: true },
    ];
  },
};

export default nextConfig;
