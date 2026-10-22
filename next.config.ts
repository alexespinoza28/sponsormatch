import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // The Qloo harness is spawned as a child process from node_modules; keep it
  // and the MCP SDK out of the server bundle.
  serverExternalPackages: ["@qloo/qloo-harness", "@modelcontextprotocol/sdk"],
};

export default nextConfig;
