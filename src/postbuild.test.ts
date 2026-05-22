import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runPostbuild } from "./postbuild.js";

describe("runPostbuild", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(path.join(tmpdir(), "adapter-creekd-postbuild-"));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  async function writeStandalone(): Promise<void> {
    await mkdir(path.join(projectDir, ".next", "standalone"), { recursive: true });
    await writeFile(path.join(projectDir, ".next", "standalone", "server.js"), "");
  }

  async function writeNestedStandalone(): Promise<string> {
    const serverDir = path.join(
      projectDir,
      ".next",
      "standalone",
      "apps",
      "web",
    );
    await mkdir(serverDir, { recursive: true });
    await writeFile(path.join(serverDir, "server.js"), "");
    return serverDir;
  }

  async function writeProjectNextModule(contents = "next-runtime"): Promise<void> {
    const nextDir = path.join(projectDir, "node_modules", "next", "dist", "server");
    const nextEnvDir = path.join(projectDir, "node_modules", "@next", "env");
    await mkdir(nextDir, { recursive: true });
    await mkdir(nextEnvDir, { recursive: true });
    await writeFile(path.join(nextDir, "next.js"), contents);
    await writeFile(path.join(nextEnvDir, "package.json"), "{}");
  }

  async function writeProjectSharpPnpmModule(): Promise<void> {
    const storeNodeModules = path.join(
      projectDir,
      "node_modules",
      ".pnpm",
      "sharp@1.0.0",
      "node_modules",
    );
    const nextStoreNodeModules = path.join(
      projectDir,
      "node_modules",
      ".pnpm",
      "next@1.0.0",
      "node_modules",
    );
    const standaloneNodeModules = path.join(
      projectDir,
      ".next",
      "standalone",
      "node_modules",
    );
    const standaloneNextStoreNodeModules = path.join(
      standaloneNodeModules,
      ".pnpm",
      "next@1.0.0",
      "node_modules",
    );
    const sourceSharpDir = path.join(storeNodeModules, "sharp");
    const sourceColourDir = path.join(storeNodeModules, "@img", "colour");
    const sourcePlatformDir = path.join(storeNodeModules, "@img", "sharp-linux-x64");
    const sourceLibcDir = path.join(storeNodeModules, "detect-libc");
    await mkdir(sourceSharpDir, { recursive: true });
    await mkdir(sourceColourDir, { recursive: true });
    await mkdir(sourcePlatformDir, { recursive: true });
    await mkdir(sourceLibcDir, { recursive: true });
    await mkdir(path.join(nextStoreNodeModules, "next"), { recursive: true });
    await mkdir(path.join(standaloneNextStoreNodeModules, "next"), {
      recursive: true,
    });
    await mkdir(
      path.join(standaloneNextStoreNodeModules, "next", "dist", "server"),
      { recursive: true },
    );
    await mkdir(path.join(standaloneNextStoreNodeModules, "@next", "env"), {
      recursive: true,
    });
    await writeFile(path.join(sourceSharpDir, "index.js"), "sharp-runtime");
    await writeFile(
      path.join(sourceSharpDir, "package.json"),
      JSON.stringify({
        dependencies: {
          "@img/colour": "1.0.0",
          "detect-libc": "2.1.2",
          semver: "7.7.3",
        },
        optionalDependencies: {
          "@img/sharp-linux-x64": "1.0.0",
          "@img/sharp-darwin-arm64": "1.0.0",
        },
      }),
    );
    await writeFile(path.join(sourceColourDir, "index.js"), "colour-runtime");
    await writeFile(path.join(sourcePlatformDir, "index.js"), "platform-runtime");
    await writeFile(path.join(sourceLibcDir, "index.js"), "libc-runtime");
    await writeFile(
      path.join(standaloneNextStoreNodeModules, "next", "dist", "server", "next.js"),
      "standalone-next-runtime",
    );
    await writeFile(
      path.join(standaloneNextStoreNodeModules, "@next", "env", "package.json"),
      "{}",
    );
    await symlink(
      path.relative(path.join(projectDir, "node_modules"), path.join(nextStoreNodeModules, "next")),
      path.join(projectDir, "node_modules", "next"),
    );
    await symlink(
      "../../sharp@1.0.0/node_modules/sharp",
      path.join(nextStoreNodeModules, "sharp"),
    );
    await symlink(
      path.relative(standaloneNodeModules, path.join(standaloneNextStoreNodeModules, "next")),
      path.join(standaloneNodeModules, "next"),
    );
    await mkdir(path.join(standaloneNextStoreNodeModules, "sharp"), {
      recursive: true,
    });
    await writeFile(
      path.join(standaloneNextStoreNodeModules, "sharp", "index.js"),
      "traced-sharp-runtime",
    );
    await mkdir(path.join(projectDir, "node_modules", "@img"), { recursive: true });
    await symlink(
      path.relative(path.join(projectDir, "node_modules", "@img"), sourceColourDir),
      path.join(projectDir, "node_modules", "@img", "colour"),
    );
    await symlink(
      path.relative(path.join(projectDir, "node_modules", "@img"), sourcePlatformDir),
      path.join(projectDir, "node_modules", "@img", "sharp-linux-x64"),
    );
    await symlink(
      path.relative(path.join(projectDir, "node_modules"), sourceLibcDir),
      path.join(projectDir, "node_modules", "detect-libc"),
    );
  }

  async function writeProjectCacheHandler(contents = "cache-handler"): Promise<void> {
    await writeFile(
      path.join(projectDir, ".solcreek-creekd-cache-handler.mjs"),
      contents,
    );
  }

  async function writeProjectUseCacheHandler(contents = "use-cache-handler"): Promise<void> {
    await writeFile(
      path.join(projectDir, ".solcreek-creekd-use-cache-handler.mjs"),
      contents,
    );
  }

  it("copies public and static assets into standalone output", async () => {
    await writeStandalone();
    await mkdir(path.join(projectDir, "public"), { recursive: true });
    await mkdir(path.join(projectDir, ".next", "static", "chunks"), { recursive: true });
    writeFileSync(path.join(projectDir, "public", "robots.txt"), "ok");
    writeFileSync(path.join(projectDir, ".next", "static", "chunks", "app.js"), "ok");

    const result = await runPostbuild({ projectDir });

    expect(result.copied).toEqual(["public", ".next/static"]);
    expect(result.skipped).toEqual([
      ".next/cache/creekd",
      "node_modules/next",
      "node_modules/sharp",
      "cache-handler",
      "use-cache-handler",
    ]);
    expect(result.serverFile).toBe(
      path.join(projectDir, ".next", "standalone", "server.js"),
    );
    expect(readFileSync(
      path.join(projectDir, ".next", "standalone", "public", "robots.txt"),
      "utf8",
    )).toBe("ok");
    expect(readFileSync(
      path.join(projectDir, ".next", "standalone", ".next", "static", "chunks", "app.js"),
      "utf8",
    )).toBe("ok");
  });

  it("skips missing optional asset directories", async () => {
    await writeStandalone();

    const result = await runPostbuild({ projectDir });

    expect(result.copied).toEqual([]);
    expect(result.skipped).toEqual([
      "public",
      ".next/static",
      ".next/cache/creekd",
      "node_modules/next",
      "node_modules/sharp",
      "cache-handler",
      "use-cache-handler",
    ]);
  });

  it("copies assets next to nested standalone server output", async () => {
    const serverDir = await writeNestedStandalone();
    await mkdir(path.join(projectDir, "public"), { recursive: true });
    await mkdir(path.join(projectDir, ".next", "static", "chunks"), { recursive: true });
    writeFileSync(path.join(projectDir, "public", "robots.txt"), "ok");
    writeFileSync(path.join(projectDir, ".next", "static", "chunks", "app.js"), "ok");

    const result = await runPostbuild({ projectDir });

    expect(result.serverDir).toBe(serverDir);
    expect(readFileSync(path.join(serverDir, "public", "robots.txt"), "utf8")).toBe("ok");
    expect(readFileSync(
      path.join(serverDir, ".next", "static", "chunks", "app.js"),
      "utf8",
    )).toBe("ok");
  });

  it("copies build-seeded creekd cache into standalone output", async () => {
    await writeStandalone();
    await mkdir(path.join(projectDir, ".next", "cache", "creekd", "entries"), {
      recursive: true,
    });
    await writeFile(
      path.join(projectDir, ".next", "cache", "creekd", "entries", "seed.json"),
      "{}",
    );

    const result = await runPostbuild({ projectDir });

    expect(result.copied).toEqual([".next/cache/creekd"]);
    expect(readFileSync(
      path.join(
        projectDir,
        ".next",
        "standalone",
        ".next",
        "cache",
        "creekd",
        "entries",
        "seed.json",
      ),
      "utf8",
    )).toBe("{}");
  });

  it("normalizes blocking PPR dynamic routes in prerender manifests", async () => {
    await writeStandalone();
    const manifest = {
      version: 4,
      routes: {},
      dynamicRoutes: {
        "/blocking/[slug]": {
          fallback: null,
          renderingMode: "PARTIALLY_STATIC",
          remainingPrerenderableParams: [{ paramName: "slug", paramType: "dynamic" }],
        },
        "/fallback/[slug]": {
          fallback: "/fallback/[slug]",
          renderingMode: "PARTIALLY_STATIC",
          remainingPrerenderableParams: [{ paramName: "slug", paramType: "dynamic" }],
        },
      },
    };
    const distManifestPath = path.join(projectDir, ".next", "prerender-manifest.json");
    const standaloneManifestPath = path.join(
      projectDir,
      ".next",
      "standalone",
      ".next",
      "prerender-manifest.json",
    );
    await mkdir(path.dirname(distManifestPath), { recursive: true });
    await mkdir(path.dirname(standaloneManifestPath), { recursive: true });
    await writeFile(distManifestPath, JSON.stringify(manifest));
    await writeFile(standaloneManifestPath, JSON.stringify(manifest));

    await runPostbuild({ projectDir });

    for (const filePath of [distManifestPath, standaloneManifestPath]) {
      const patched = JSON.parse(readFileSync(filePath, "utf8")) as typeof manifest;
      expect(
        patched.dynamicRoutes["/blocking/[slug]"].remainingPrerenderableParams,
      ).toEqual([]);
      expect(
        patched.dynamicRoutes["/fallback/[slug]"].remainingPrerenderableParams,
      ).toEqual([{ paramName: "slug", paramType: "dynamic" }]);
    }
  });

  it("copies the mirrored creekd cache handler into standalone output", async () => {
    await writeStandalone();
    await writeProjectCacheHandler("handler");

    const result = await runPostbuild({ projectDir });

    expect(result.copied).toEqual(["cache-handler"]);
    expect(result.skipped).toEqual([
      "public",
      ".next/static",
      ".next/cache/creekd",
      "node_modules/next",
      "node_modules/sharp",
      "use-cache-handler",
    ]);
    expect(readFileSync(
      path.join(projectDir, ".next", "standalone", ".solcreek-creekd-cache-handler.mjs"),
      "utf8",
    )).toBe("handler");
  });

  it("copies the mirrored creekd use-cache handler into standalone output", async () => {
    await writeStandalone();
    await writeProjectUseCacheHandler("handler");

    const result = await runPostbuild({ projectDir });

    expect(result.copied).toEqual(["use-cache-handler"]);
    expect(readFileSync(
      path.join(projectDir, ".next", "standalone", ".solcreek-creekd-use-cache-handler.mjs"),
      "utf8",
    )).toBe("handler");
  });

  it("copies next runtime into standalone output when missing", async () => {
    await writeStandalone();
    await writeProjectNextModule("runtime");

    const result = await runPostbuild({ projectDir });

    expect(result.copied).toEqual(["node_modules/next"]);
    expect(result.skipped).toEqual([
      "public",
      ".next/static",
      ".next/cache/creekd",
      "node_modules/sharp",
      "cache-handler",
      "use-cache-handler",
    ]);
    expect(readFileSync(
      path.join(projectDir, ".next", "standalone", "node_modules", "next", "dist", "server", "next.js"),
      "utf8",
    )).toBe("runtime");
    expect(readFileSync(
      path.join(projectDir, ".next", "standalone", "node_modules", "@next", "env", "package.json"),
      "utf8",
    )).toBe("{}");
  });

  it("fills missing next runtime files without overwriting traced files", async () => {
    await writeStandalone();
    await writeProjectNextModule("runtime");
    const tracedPackageFile = path.join(
      projectDir,
      ".next",
      "standalone",
      "node_modules",
      "next",
      "package.json",
    );
    await mkdir(path.dirname(tracedPackageFile), { recursive: true });
    await writeFile(tracedPackageFile, "traced-package");

    const result = await runPostbuild({ projectDir });

    expect(result.copied).toEqual(["node_modules/next"]);
    expect(result.skipped).toEqual([
      "public",
      ".next/static",
      ".next/cache/creekd",
      "node_modules/sharp",
      "cache-handler",
      "use-cache-handler",
    ]);
    expect(readFileSync(tracedPackageFile, "utf8")).toBe("traced-package");
    expect(readFileSync(
      path.join(projectDir, ".next", "standalone", "node_modules", "next", "dist", "server", "next.js"),
      "utf8",
    )).toBe("runtime");
    expect(readFileSync(
      path.join(projectDir, ".next", "standalone", "node_modules", "@next", "env", "package.json"),
      "utf8",
    )).toBe("{}");
  });

  it("does not overwrite a traced next runtime", async () => {
    await writeStandalone();
    await writeProjectNextModule("project-runtime");
    const tracedNextFile = path.join(
      projectDir,
      ".next",
      "standalone",
      "node_modules",
      "next",
      "dist",
      "server",
      "next.js",
    );
    await mkdir(path.dirname(tracedNextFile), { recursive: true });
    await writeFile(tracedNextFile, "traced-runtime");
    const tracedNextEnvFile = path.join(
      projectDir,
      ".next",
      "standalone",
      "node_modules",
      "@next",
      "env",
      "package.json",
    );
    await mkdir(path.dirname(tracedNextEnvFile), { recursive: true });
    await writeFile(tracedNextEnvFile, "traced-env");

    const result = await runPostbuild({ projectDir });

    expect(result.copied).toEqual([]);
    expect(result.skipped).toEqual([
      "public",
      ".next/static",
      ".next/cache/creekd",
      "node_modules/next",
      "node_modules/sharp",
      "cache-handler",
      "use-cache-handler",
    ]);
    expect(readFileSync(tracedNextFile, "utf8")).toBe("traced-runtime");
    expect(readFileSync(tracedNextEnvFile, "utf8")).toBe("traced-env");
  });

  it("copies sharp and its pnpm runtime dependencies into standalone output", async () => {
    await writeStandalone();
    await writeProjectSharpPnpmModule();

    const result = await runPostbuild({ projectDir });

    expect(result.copied).toEqual(["node_modules/sharp"]);
    expect(readFileSync(
      path.join(projectDir, ".next", "standalone", "node_modules", ".pnpm", "next@1.0.0", "node_modules", "sharp", "index.js"),
      "utf8",
    )).toBe("traced-sharp-runtime");
    expect(readFileSync(
      path.join(projectDir, ".next", "standalone", "node_modules", ".pnpm", "next@1.0.0", "node_modules", "@img", "colour", "index.js"),
      "utf8",
    )).toBe("colour-runtime");
    expect(readFileSync(
      path.join(projectDir, ".next", "standalone", "node_modules", ".pnpm", "next@1.0.0", "node_modules", "@img", "sharp-linux-x64", "index.js"),
      "utf8",
    )).toBe("platform-runtime");
    expect(readFileSync(
      path.join(projectDir, ".next", "standalone", "node_modules", ".pnpm", "next@1.0.0", "node_modules", "detect-libc", "index.js"),
      "utf8",
    )).toBe("libc-runtime");
  });

  it("fails clearly when standalone output has not been generated", async () => {
    await expect(runPostbuild({ projectDir })).rejects.toThrow(
      "run next build with adapter-creekd first",
    );
  });
});
