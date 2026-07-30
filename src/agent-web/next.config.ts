import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  basePath: "/agent",
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
