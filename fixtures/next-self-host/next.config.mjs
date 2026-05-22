import * as path from "node:path";

const adapterRoot = path.resolve(
  process.env.ADAPTER_CREEKD_ROOT ?? path.join(import.meta.dirname, "..", ".."),
);

/** @type {import('next').NextConfig} */
const nextConfig = {
  adapterPath: path.join(adapterRoot, "dist", "index.js"),
  deploymentId: process.env.BENCH_DEPLOYMENT_ID ?? "adapter-creekd-bench",
  turbopack: {
    root: adapterRoot,
  },
};

export default nextConfig;
