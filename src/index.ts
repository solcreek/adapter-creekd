import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { copyFileSync, existsSync } from "node:fs";
import type { NextAdapter } from "next";

import { applyBaseModifyConfig } from "@solcreek/adapter-core";

import { handleBuild, type HandleBuildOptions } from "./build.js";
import {
  normalizeEnv,
  type CreekdEnv,
  type NextStandaloneRuntime,
} from "./manifest.js";

/**
 * User-facing options for the adapter. All are optional; defaults are
 * the most common case (Bun runtime, port 3000).
 */
export interface CreekdAdapterOptions {
  /**
   * JS runtime creekd should spawn the standalone server under.
   * Default: "bun" (faster cold start + HTTP throughput; tested
   * against the same Next.js fixtures adapter-creek runs).
   */
  runtime?: NextStandaloneRuntime;
  /**
   * TCP port the standalone server binds to. creekd's dispatch
   * listener proxies external traffic to this port.
   * Default: 3000.
   */
  port?: number;
  /**
   * Environment variables written into the creekd manifest. The adapter
   * always defaults NODE_ENV to production; user-provided values with
   * the same key override the default.
   */
  env?: CreekdEnv;
  /**
   * Optional per-app creekd health probe path. Leave unset to use
   * creekd's lenient default `/` probe.
   */
  healthCheckPath?: string;
}

// Dev/prod path to the cache handler shipped by this adapter. The dist
// path is the production case; the extra fallback keeps source-level
// tests and local development usable before a build has populated dist.
const ownCacheHandlerPath = [
  new URL("./cache-handler.js", import.meta.url),
  new URL("../dist/cache-handler.js", import.meta.url),
]
  .map((url) => fileURLToPath(url))
  .find((candidate) => existsSync(candidate)) ??
  path.join(
    process.cwd(),
    "node_modules",
    "@solcreek",
    "adapter-creekd",
    "dist",
    "cache-handler.js",
  );

function mirrorCacheHandlerIntoProject(cacheHandlerPath: string): string {
  if (!existsSync(cacheHandlerPath)) return cacheHandlerPath;

  const localPath = path.join(process.cwd(), ".solcreek-creekd-cache-handler.mjs");
  if (path.resolve(cacheHandlerPath) === path.resolve(localPath)) return localPath;

  try {
    copyFileSync(cacheHandlerPath, localPath);
    return localPath;
  } catch (err) {
    console.warn(
      `  [Creekd Adapter] Failed to mirror cache-handler into project (${
        err instanceof Error ? err.message : String(err)
      }); falling back to ${cacheHandlerPath}`,
    );
    return cacheHandlerPath;
  }
}

/**
 * Construct a NextAdapter targeting creekd self-host. Call from a
 * thin wrapper module when you want explicit options:
 *
 *   // adapter.config.ts
 *   import { createCreekdAdapter } from "@solcreek/adapter-creekd";
 *   export default createCreekdAdapter({ runtime: "node", port: 4000 });
 *
 * For the all-defaults case, you can use the package's default
 * export directly:
 *
 *   // next.config.ts
 *   const config = {
 *     adapterPath: require.resolve("@solcreek/adapter-creekd"),
 *   };
 */
export function createCreekdAdapter(
  options: CreekdAdapterOptions = {},
): NextAdapter {
  const runtime: NextStandaloneRuntime = options.runtime ?? "bun";
  const port = options.port ?? 3000;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(
      `adapter-creekd: port must be an integer in 1..65535, got ${port}`,
    );
  }
  const env = normalizeEnv(options.env);

  return {
    name: "adapter-creekd",

    modifyConfig(config, ctx) {
      // Apply the shared base — auto-transpile JSX-in-JS deps,
      // monorepo tracing root, TS error suppression, cache handler.
      const baseConfig = applyBaseModifyConfig(config, ctx, {
        logLabel: "Creekd Adapter",
        cacheHandlerPath: ownCacheHandlerPath,
      });

      // Production builds only; dev/lint phases pass through.
      if (ctx.phase !== "phase-production-build") return baseConfig;

      // The whole self-host story rests on Next.js emitting the
      // standalone bundle. Force it here so users don't need to
      // remember the next.config.output knob.
      return {
        ...baseConfig,
        // Override adapter-core's portable in-memory default with the
        // creekd-specific L1 + filesystem-L2 handler. The mirrored local
        // path avoids Turbopack path-safety issues with pnpm realpaths.
        cacheHandler: mirrorCacheHandlerIntoProject(ownCacheHandlerPath),
        output: "standalone",
      };
    },

    async onBuildComplete(ctx) {
      const opts: HandleBuildOptions = {
        runtime,
        port,
        env,
        healthCheckPath: options.healthCheckPath,
      };
      await handleBuild(ctx, opts);
    },
  };
}

// Default export is the all-defaults adapter. Users with options
// wrap createCreekdAdapter in their own module — see the docstring
// above for the pattern.
const adapter = createCreekdAdapter();
export default adapter;

// Public surface for users / downstream tooling that wants to read
// the manifest format directly.
export type {
  CreekdEnv,
  CreekdManifest,
  NextStandaloneRuntime,
  WriteManifestOptions,
} from "./manifest.js";
export { writeManifest } from "./manifest.js";
