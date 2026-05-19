import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import type { NextAdapter } from "next";

import { applyBaseModifyConfig } from "@solcreek/adapter-core";

import { handleBuild, type HandleBuildOptions } from "./build.js";

// Adapter package identity, embedded into every emitted manifest.
// Bumped manually alongside package.json on each release.
const ADAPTER_NAME = "@solcreek/adapter-creekd";
const ADAPTER_VERSION = "0.1.1";

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
  runtime?: "bun" | "node";
  /**
   * TCP port the standalone server binds to. creekd's dispatch
   * listener proxies external traffic to this port.
   * Default: 3000.
   */
  port?: number;
}

// Dev-fallback path to the cache handler shipped by adapter-core.
// applyBaseModifyConfig prefers the node_modules-installed copy when
// one exists.
const coreEntryUrl = new URL(
  "../node_modules/@solcreek/adapter-core/dist/cache-handler.js",
  import.meta.url,
);
const fallbackCacheHandlerPath = existsSync(fileURLToPath(coreEntryUrl))
  ? fileURLToPath(coreEntryUrl)
  : path.join(
      process.cwd(),
      "node_modules",
      "@solcreek",
      "adapter-core",
      "dist",
      "cache-handler.js",
    );

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
  const runtime: "bun" | "node" = options.runtime ?? "bun";
  const port = options.port ?? 3000;

  return {
    name: "adapter-creekd",

    modifyConfig(config, ctx) {
      // Apply the shared base — auto-transpile JSX-in-JS deps,
      // monorepo tracing root, TS error suppression, cache handler.
      const baseConfig = applyBaseModifyConfig(config, ctx, {
        logLabel: "Creekd Adapter",
        cacheHandlerPath: fallbackCacheHandlerPath,
      });

      // Production builds only; dev/lint phases pass through.
      if (ctx.phase !== "phase-production-build") return baseConfig;

      // The whole self-host story rests on Next.js emitting the
      // standalone bundle. Force it here so users don't need to
      // remember the next.config.output knob.
      return {
        ...baseConfig,
        output: "standalone",
      };
    },

    async onBuildComplete(ctx) {
      const opts: HandleBuildOptions = {
        runtime,
        port,
        adapterName: ADAPTER_NAME,
        adapterVersion: ADAPTER_VERSION,
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
export type { CreekdManifest, WriteManifestOptions } from "./manifest.js";
export { writeManifest } from "./manifest.js";
