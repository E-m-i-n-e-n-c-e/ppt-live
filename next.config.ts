import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow large PPTX uploads (up to 100 MB)
  experimental: {
    serverActions: {
      bodySizeLimit: "100mb",
    },
  },
  // Disable x-powered-by header
  poweredByHeader: false,
};

export default nextConfig;
