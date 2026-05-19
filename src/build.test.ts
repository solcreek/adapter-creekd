import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { handleBuild, type HandleBuildOptions } from "./build.js";
import type { CreekdManifest } from "./manifest.js";

/**
 * Build a minimum simulated Next.js build tree in a tempdir:
 *
 *   project/
 *     .next/
 *       standalone/
 *         server.js          (the marker handleBuild looks for)
 *       static/
 *         hashed-asset.js
 *     public/
 *       logo.png
 *
 * Returns { projectDir, distDir }. handleBuild copies static/ and
 * public/ into the standalone subtree, then writes the manifest.
 */
function makeProject(): { projectDir: string; distDir: string } {
  const projectDir = mkdtempSync(path.join(tmpdir(), "adapter-creekd-build-"));
  const distDir = path.join(projectDir, ".next");

  mkdirSync(path.join(distDir, "standalone"), { recursive: true });
  writeFileSync(
    path.join(distDir, "standalone", "server.js"),
    "// pretend Next.js wrote this",
  );

  mkdirSync(path.join(distDir, "static"), { recursive: true });
  writeFileSync(path.join(distDir, "static", "hashed-asset.js"), "/* asset */");

  mkdirSync(path.join(projectDir, "public"), { recursive: true });
  writeFileSync(path.join(projectDir, "public", "logo.png"), "binary");

  return { projectDir, distDir };
}

// Minimum shape of the BuildContext the adapter uses. handleBuild
// only touches a small subset of the real Next.js NextAdapter
// BuildContext; we mock just those fields here.
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
      // BuildContext.outputs.middleware is undefined when no middleware.
      middleware: undefined,
    },
  } as unknown as Parameters<typeof handleBuild>[0];
}

const baseOpts: HandleBuildOptions = {
  runtime: "bun",
  port: 3000,
  adapterName: "@solcreek/adapter-creekd",
  adapterVersion: "0.1.0",
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
      version: "0.1.0",
    });
  });

  it("copies .next/static into standalone tree", async () => {
    await handleBuild(makeCtx(projectDir, distDir), baseOpts);
    const copied = path.join(
      projectDir,
      ".next",
      "standalone",
      ".next",
      "static",
      "hashed-asset.js",
    );
    expect(readFileSync(copied, "utf-8")).toContain("asset");
  });

  it("copies public/ into standalone tree", async () => {
    await handleBuild(makeCtx(projectDir, distDir), baseOpts);
    const copied = path.join(
      projectDir,
      ".next",
      "standalone",
      "public",
      "logo.png",
    );
    expect(readFileSync(copied, "utf-8")).toBe("binary");
  });

  it("lists every copied dir in serveDirs", async () => {
    await handleBuild(makeCtx(projectDir, distDir), baseOpts);
    const { serveDirs } = readManifest();
    expect(serveDirs).toContain(".next/standalone");
    expect(serveDirs).toContain(path.join(".next", "standalone", ".next", "static"));
    expect(serveDirs).toContain(path.join(".next", "standalone", "public"));
  });

  it("omits public/ from serveDirs when project has none", async () => {
    rmSync(path.join(projectDir, "public"), { recursive: true });
    await handleBuild(makeCtx(projectDir, distDir), baseOpts);
    const { serveDirs } = readManifest();
    expect(
      serveDirs.some((d) => d.endsWith(path.join("standalone", "public"))),
    ).toBe(false);
  });

  it("throws clearly when .next/standalone/server.js is missing", async () => {
    rmSync(path.join(distDir, "standalone"), { recursive: true });
    await expect(
      handleBuild(makeCtx(projectDir, distDir), baseOpts),
    ).rejects.toThrow(/server\.js not found/);
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
