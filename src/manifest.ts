import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createRequire } from "node:module";

import {
  isCreekdDeployManifest,
  type CreekdDeployManifest,
  type CreekdRuntime,
} from "@solcreek/adapter-core";

const require = createRequire(import.meta.url);
const adapterPackage = require("../package.json") as {
  name?: string;
  version?: string;
};

export type NextStandaloneRuntime = Extract<CreekdRuntime, "bun" | "node">;

export type CreekdEnv =
  | string[]
  | Record<string, string | number | boolean>;

/**
 * Manifest written to `.creek-creekd/manifest.json` after a successful
 * Next.js build. The creekctl `--from <manifest>` flow reads this to
 * know how to spawn the supervised process.
 *
 * The process-level contract comes from @solcreek/adapter-core so the
 * adapter and creekctl stay aligned. The extra metadata fields are
 * informational; creekd should only need the process fields.
 */
export type CreekdManifest = CreekdDeployManifest & {
  framework: "nextjs";
  adapter: {
    name: string;
    version: string;
  };
  /**
   * Which JS runtime creekd should invoke when spawning the standalone
   * server. Bun is the default — faster cold start, faster HTTP, and
   * `bun:sqlite` works out-of-the-box for ISR cache implementations
   * that need persistence. Node is the safe fallback for codebases
   * that depend on a Bun-incompatible native module.
   */
  runtime: NextStandaloneRuntime;
  /**
   * Directories the supervised process needs at runtime, relative to
   * the project root. The standalone tree (.next/standalone/) is the
   * only required entry; Next.js's self-host contract expects the
   * user to arrange .next/static and public/ inside that tree via a
   * postbuild script.
   */
  serveDirs: string[];
};

export interface WriteManifestOptions {
  outputDir: string;
  buildId: string;
  nextVersion: string;
  runtime: NextStandaloneRuntime;
  entrypoint: string;
  port: number;
  env: string[];
  healthCheckPath?: string;
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
    adapter: {
      name: adapterPackage.name ?? "@solcreek/adapter-creekd",
      version: adapterPackage.version ?? "0.0.0",
    },
    hasMiddleware: opts.hasMiddleware,
    hasPrerender: opts.hasPrerender,
    runtime: opts.runtime,
    entrypoint: opts.entrypoint,
    port: opts.port,
    env: opts.env.length > 0 ? opts.env : undefined,
    health_check_path: opts.healthCheckPath,
    serveDirs: opts.serveDirs,
  };

  if (!isCreekdDeployManifest(manifest)) {
    throw new Error("adapter-creekd: generated invalid creekd manifest");
  }

  await fs.mkdir(opts.outputDir, { recursive: true });
  await fs.writeFile(
    path.join(opts.outputDir, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
}

export function normalizeEnv(env: CreekdEnv | undefined): string[] {
  const entries = new Map<string, string>();
  entries.set("NODE_ENV", "production");

  if (Array.isArray(env)) {
    for (const item of env) {
      const separator = item.indexOf("=");
      if (separator <= 0) {
        throw new Error(
          `adapter-creekd: env entries must be KEY=VALUE strings, got ${JSON.stringify(item)}`,
        );
      }
      entries.set(item.slice(0, separator), item.slice(separator + 1));
    }
  } else if (env) {
    for (const [key, value] of Object.entries(env)) {
      if (!key) {
        throw new Error("adapter-creekd: env object keys must be non-empty");
      }
      entries.set(key, String(value));
    }
  }

  return [...entries].map(([key, value]) => `${key}=${value}`);
}
