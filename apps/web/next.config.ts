import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
