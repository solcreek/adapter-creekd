import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { DeployManifestBase } from "@solcreek/adapter-core";

/**
 * Manifest written to `.creek-creekd/manifest.json` after a successful
 * Next.js build. The creekctl `--from <manifest>` flow reads this to
 * know how to spawn the supervised process.
 *
 * Extends @solcreek/adapter-core's DeployManifestBase with the fields
 * specific to the creekd / Linux process target.
 */
export interface CreekdManifest extends DeployManifestBase {
  /** Target identifier. Always "creekd" for this adapter. */
  target: "creekd";
  /**
   * Which JS runtime creekd should invoke when spawning the standalone
   * server. Bun is the default — faster cold start, faster HTTP, and
   * `bun:sqlite` works out-of-the-box for ISR cache implementations
   * that need persistence. Node is the safe fallback for codebases
   * that depend on a Bun-incompatible native module.
   */
  runtime: "bun" | "node";
  /**
   * Entry script path relative to the project root (where this
   * manifest is written under .creek-creekd/). The standalone server
   * Next.js produces at .next/standalone/server.js is the canonical
   * value; adapters that wrap or rewrite the entry can swap this.
   */
  entrypoint: string;
  /**
   * TCP port the standalone server binds to inside the supervised
   * process. creekd's dispatch listener proxies external traffic to
   * this port.
   */
  port: number;
  /**
   * Directories the supervised process needs at runtime, relative to
   * the project root. The full standalone tree (.next/standalone/),
   * the static assets (.next/static/, copied into standalone by the
   * adapter), and the user's public/ folder.
   */
  serveDirs: string[];
}

export interface WriteManifestOptions {
  outputDir: string;
  buildId: string;
  nextVersion: string;
  adapterName: string;
  adapterVersion: string;
  runtime: "bun" | "node";
  entrypoint: string;
  port: number;
  serveDirs: string[];
  hasMiddleware: boolean;
  hasPrerender: boolean;
}

export async function writeManifest(opts: WriteManifestOptions): Promise<void> {
  const manifest: CreekdManifest = {
    version: 1,
    framework: "nextjs",
    target: "creekd",
    buildId: opts.buildId,
    nextVersion: opts.nextVersion,
    adapter: { name: opts.adapterName, version: opts.adapterVersion },
    hasMiddleware: opts.hasMiddleware,
    hasPrerender: opts.hasPrerender,
    runtime: opts.runtime,
    entrypoint: opts.entrypoint,
    port: opts.port,
    serveDirs: opts.serveDirs,
  };

  await fs.mkdir(opts.outputDir, { recursive: true });
  await fs.writeFile(
    path.join(opts.outputDir, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
}
