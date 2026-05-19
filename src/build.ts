import * as path from "node:path";
import type { NextAdapter } from "next";

import { writeManifest } from "./manifest.js";

type BuildContext = Parameters<NonNullable<NextAdapter["onBuildComplete"]>>[0];

const OUTPUT_DIR = ".creek-creekd";

export interface HandleBuildOptions {
  /** Runtime the supervised process should use. */
  runtime: "bun" | "node";
  /** TCP port the standalone server binds to. */
  port: number;
  /** Adapter package name + version, embedded into the manifest. */
  adapterName: string;
  adapterVersion: string;
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
  const serverFile = path.join(standaloneDir, "server.js");

  await writeManifest({
    outputDir: path.join(projectDir, OUTPUT_DIR),
    buildId: ctx.buildId,
    nextVersion: ctx.nextVersion,
    adapterName: opts.adapterName,
    adapterVersion: opts.adapterVersion,
    runtime: opts.runtime,
    entrypoint: path.relative(projectDir, serverFile),
    port: opts.port,
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
