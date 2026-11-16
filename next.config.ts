import { withEve } from "eve/next";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ["postgres"],
};

// Mounts the agent in ./agent at /eve/v1/* and, under `next start`, runs the built agent service (spec §6).
export default withEve(nextConfig);
