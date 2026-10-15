import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // sigma/graphology ship ESM that needs transpiling for the app router bundle
  transpilePackages: ["sigma"],
  devIndicators: false,
  // don't write AGENTS.md / CLAUDE.md into the project on `next dev`
  agentRules: false,
};

export default nextConfig;
