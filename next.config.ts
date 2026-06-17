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
  // Allow HMR from 0.0.0.0 (for Docker/containers in dev mode)
  allowedDevOrigins: ["0.0.0.0"],
};

export default nextConfig;
