import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A verification build must never write into the .next folder the dev server is using.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // next dev otherwise writes its own AGENTS.md and CLAUDE.md into this folder on every start.
  agentRules: false,
  reactStrictMode: true,
  poweredByHeader: false,
  images: {
    formats: ["image/avif", "image/webp"],
    qualities: [75, 85],
  },
};

export default nextConfig;
