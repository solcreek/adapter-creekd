import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { handleBuild, type HandleBuildOptions } from "./build.js";
import type { CreekdManifest } from "./manifest.js";

// onBuildComplete fires BEFORE Next.js's standalone codegen, so the
// tempdir intentionally does NOT pre-create .next/standalone/ —
// handleBuild must work without it existing yet.
function makeProject(): { projectDir: string; distDir: string } {
  const projectDir = mkdtempSync(path.join(tmpdir(), "adapter-creekd-build-"));
  const distDir = path.join(projectDir, ".next");
  return { projectDir, distDir };
}

function makeCtx(projectDir: string, distDir: string) {
  return {
    projectDir,
    distDir,
    buildId: "test-build-id",
    nextVersion: "16.2.3",
    outputs: {
      appPages: [],
      appRoutes: [],
      pages: [],
      pagesApi: [],
      middleware: undefined,
    },
  } as unknown as Parameters<typeof handleBuild>[0];
}

const baseOpts: HandleBuildOptions = {
  runtime: "bun",
  port: 3000,
  adapterName: "@solcreek/adapter-creekd",
  adapterVersion: "0.1.1",
};

describe("handleBuild", () => {
  let projectDir: string;
  let distDir: string;
  beforeEach(() => {
    const p = makeProject();
    projectDir = p.projectDir;
    distDir = p.distDir;
  });
  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  function readManifest(): CreekdManifest {
    const raw = readFileSync(
      path.join(projectDir, ".creek-creekd", "manifest.json"),
      "utf-8",
    );
    return JSON.parse(raw) as CreekdManifest;
  }

  it("writes a complete manifest", async () => {
    await handleBuild(makeCtx(projectDir, distDir), baseOpts);
    const manifest = readManifest();
    expect(manifest.target).toBe("creekd");
    expect(manifest.runtime).toBe("bun");
    expect(manifest.port).toBe(3000);
    expect(manifest.buildId).toBe("test-build-id");
    expect(manifest.entrypoint).toBe(".next/standalone/server.js");
    expect(manifest.adapter).toEqual({
      name: "@solcreek/adapter-creekd",
      version: "0.1.1",
    });
  });

  it("declares the standalone dir in serveDirs", async () => {
    await handleBuild(makeCtx(projectDir, distDir), baseOpts);
    const { serveDirs } = readManifest();
    expect(serveDirs).toEqual([".next/standalone"]);
  });

  it("does not require .next/standalone to exist at write time", async () => {
    // The directory is absent; handleBuild must not throw.
    await expect(
      handleBuild(makeCtx(projectDir, distDir), baseOpts),
    ).resolves.toBeUndefined();
  });

  it("preserves runtime: node when chosen", async () => {
    await handleBuild(makeCtx(projectDir, distDir), {
      ...baseOpts,
      runtime: "node",
    });
    expect(readManifest().runtime).toBe("node");
  });

  it("flags hasMiddleware when ctx.outputs.middleware is present", async () => {
    const ctx = makeCtx(projectDir, distDir);
    (ctx as unknown as { outputs: { middleware: unknown } }).outputs.middleware = {};
    await handleBuild(ctx, baseOpts);
    expect(readManifest().hasMiddleware).toBe(true);
  });

  it("flags hasPrerender when any output carries prerender", async () => {
    const ctx = makeCtx(projectDir, distDir);
    (ctx as unknown as { outputs: { appPages: unknown[] } }).outputs.appPages = [
      { prerender: { kind: "static" } },
    ];
    await handleBuild(ctx, baseOpts);
    expect(readManifest().hasPrerender).toBe(true);
  });
});
