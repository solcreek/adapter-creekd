import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { NextAdapter } from "next";

import { writeManifest } from "./manifest.js";
import type { NextStandaloneRuntime } from "./manifest.js";

type BuildContext = Parameters<NonNullable<NextAdapter["onBuildComplete"]>>[0];

const OUTPUT_DIR = ".creek-creekd";
const EMPTY_TRACE_MANIFEST = JSON.stringify({ version: 1, files: [] }) + "\n";

export interface HandleBuildOptions {
  /** Runtime the supervised process should use. */
  runtime: NextStandaloneRuntime;
  /** TCP port the standalone server binds to. */
  port: number;
  /** Environment variables creekd should pass to the supervised process. */
  env: string[];
  /** Optional strict liveness/readiness path for creekd health probes. */
  healthCheckPath?: string;
}

function resolveStandaloneServerFile(ctx: BuildContext): string {
  const standaloneDir = path.join(ctx.distDir, "standalone");
  const tracingRoot = ctx.config.outputFileTracingRoot;

  if (tracingRoot) {
    const relativeProjectDir = path.relative(
      path.resolve(tracingRoot),
      ctx.projectDir,
    );
    if (
      relativeProjectDir &&
      !relativeProjectDir.startsWith("..") &&
      !path.isAbsolute(relativeProjectDir)
    ) {
      return path.join(standaloneDir, relativeProjectDir, "server.js");
    }
  }

  return path.join(standaloneDir, "server.js");
}

async function ensureTraceManifest(filePath: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, EMPTY_TRACE_MANIFEST, "utf8");
  }
}

async function ensureStandaloneTraceManifests(distDir: string): Promise<void> {
  await Promise.all([
    ensureTraceManifest(path.join(distDir, "next-server.js.nft.json")),
    ensureTraceManifest(path.join(distDir, "next-minimal-server.js.nft.json")),
  ]);
}

// Sequencing: Next.js's official NextAdapter calls `onBuildComplete`
// BEFORE running `output: 'standalone'` codegen (the source comment is
// explicit: "This should come after output: export handling but before
// output: standalone"). That means .next/standalone/ does NOT exist
// yet at this point and we cannot verify or copy into it.
//
// What we do instead: just emit a declarative manifest describing the
// paths Next.js *will* create. The user (or their tooling) is then
// responsible for arranging .next/static and public/ inside the
// standalone tree — same contract Next.js's own self-host docs ask
// for. A typical postbuild script:
//
//   "postbuild": "cp -r public .next/standalone/ 2>/dev/null; cp -r .next/static .next/standalone/.next/"
//
// creekctl reads this manifest via `--from` and spawns the standalone
// server; the server itself expects assets at the standard locations
// relative to its __dirname.
export async function handleBuild(
  ctx: BuildContext,
  opts: HandleBuildOptions,
): Promise<void> {
  const projectDir = ctx.projectDir;
  const distDir = ctx.distDir;

  const standaloneDir = path.join(distDir, "standalone");
  const serverFile = resolveStandaloneServerFile(ctx);

  // Turbopack adapter builds can skip Next's legacy node-file-trace phase,
  // but Next's standalone writer still expects these root trace manifests
  // immediately after onBuildComplete. Write empty placeholders when absent
  // so codegen can finish; per-route trace files remain handled by Next.
  await ensureStandaloneTraceManifests(distDir);

  await writeManifest({
    outputDir: path.join(projectDir, OUTPUT_DIR),
    buildId: ctx.buildId,
    nextVersion: ctx.nextVersion,
    runtime: opts.runtime,
    entrypoint: path.relative(projectDir, serverFile),
    port: opts.port,
    env: opts.env,
    healthCheckPath: opts.healthCheckPath,
    serveDirs: [path.relative(projectDir, standaloneDir)],
    hasMiddleware: ctx.outputs.middleware !== undefined,
    hasPrerender: hasAnyPrerender(ctx),
  });
}

function hasAnyPrerender(ctx: BuildContext): boolean {
  for (const group of [
    ctx.outputs.appPages,
    ctx.outputs.appRoutes,
    ctx.outputs.pages,
  ] as const) {
    for (const output of group) {
      if ((output as { prerender?: unknown }).prerender) return true;
    }
  }
  return false;
}
