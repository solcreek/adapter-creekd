import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { NextAdapter } from "next";

import { writeManifest } from "./manifest.js";

type BuildContext = Parameters<NonNullable<NextAdapter["onBuildComplete"]>>[0];

/** Output directory under the project root where the manifest lands. */
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

/**
 * Runs after Next.js produces the standalone build. Three things:
 *
 *   1. Verify .next/standalone/server.js exists. Next.js writes this
 *      when `output: 'standalone'` is set (the adapter does that in
 *      modifyConfig). If the file is missing, the user disabled
 *      standalone output explicitly — fail loud rather than emit a
 *      manifest that points at a non-existent server.
 *
 *   2. Copy .next/static into .next/standalone/.next/static and
 *      public/ into .next/standalone/public. Next.js's standalone
 *      output deliberately omits these (it ships only what the
 *      server.js needs at runtime). Per the Next.js docs, the
 *      deploying tooling is expected to copy them in. We do that so
 *      the artifact at .next/standalone/ is fully self-contained.
 *
 *   3. Write .creek-creekd/manifest.json describing how to spawn.
 */
export async function handleBuild(
  ctx: BuildContext,
  opts: HandleBuildOptions,
): Promise<void> {
  const projectDir = ctx.projectDir;
  const distDir = ctx.distDir;

  const standaloneDir = path.join(distDir, "standalone");
  const serverFile = path.join(standaloneDir, "server.js");

  try {
    await fs.access(serverFile);
  } catch {
    throw new Error(
      `adapter-creekd: ${path.relative(projectDir, serverFile)} not found. ` +
        `The adapter sets next.config.output = 'standalone' in modifyConfig, ` +
        `so this normally exists by the time onBuildComplete runs. If you ` +
        `overrode output: in your next.config after the adapter ran, drop ` +
        `that override.`,
    );
  }

  // Copy .next/static into the standalone tree so the runtime can
  // serve hashed assets without reaching outside the standalone dir.
  const staticSrc = path.join(distDir, "static");
  const staticDst = path.join(standaloneDir, path.basename(distDir), "static");
  await copyDirIfExists(staticSrc, staticDst);

  // Copy public/ if the user has one.
  const publicSrc = path.join(projectDir, "public");
  const publicDst = path.join(standaloneDir, "public");
  await copyDirIfExists(publicSrc, publicDst);

  // Compute serveDirs relative to projectDir so the manifest is
  // portable across machines.
  const serveDirs: string[] = [path.relative(projectDir, standaloneDir)];
  if (await dirExists(staticDst)) serveDirs.push(path.relative(projectDir, staticDst));
  if (await dirExists(publicDst)) serveDirs.push(path.relative(projectDir, publicDst));

  await writeManifest({
    outputDir: path.join(projectDir, OUTPUT_DIR),
    buildId: ctx.buildId,
    nextVersion: ctx.nextVersion,
    adapterName: opts.adapterName,
    adapterVersion: opts.adapterVersion,
    runtime: opts.runtime,
    entrypoint: path.relative(projectDir, serverFile),
    port: opts.port,
    serveDirs,
    hasMiddleware: ctx.outputs.middleware !== undefined,
    // hasPrerender mirrors adapter-creek's signal: any pre-rendered
    // page in the outputs graph counts. The consumer (creekctl, or
    // any cache backend wiring) uses this to decide whether to pre-
    // warm the ISR cache.
    hasPrerender: hasAnyPrerender(ctx),
  });
}

async function copyDirIfExists(src: string, dst: string): Promise<void> {
  try {
    await fs.access(src);
  } catch {
    return; // source missing — nothing to copy, not an error
  }
  await fs.mkdir(dst, { recursive: true });
  await fs.cp(src, dst, { recursive: true, dereference: true });
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

function hasAnyPrerender(ctx: BuildContext): boolean {
  for (const group of [
    ctx.outputs.appPages,
    ctx.outputs.appRoutes,
    ctx.outputs.pages,
  ] as const) {
    for (const output of group) {
      // The output graph carries a `prerender` field on entries that
      // were statically rendered at build time. Any presence counts.
      if ((output as { prerender?: unknown }).prerender) return true;
    }
  }
  return false;
}
