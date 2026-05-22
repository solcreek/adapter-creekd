import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
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

  async function writeProjectCacheHandler(contents = "cache-handler"): Promise<void> {
    await writeFile(
      path.join(projectDir, ".solcreek-creekd-cache-handler.mjs"),
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
    expect(result.skipped).toEqual(["node_modules/next", "cache-handler"]);
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
      "node_modules/next",
      "cache-handler",
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

  it("copies the mirrored creekd cache handler into standalone output", async () => {
    await writeStandalone();
    await writeProjectCacheHandler("handler");

    const result = await runPostbuild({ projectDir });

    expect(result.copied).toEqual(["cache-handler"]);
    expect(result.skipped).toEqual(["public", ".next/static", "node_modules/next"]);
    expect(readFileSync(
      path.join(projectDir, ".next", "standalone", ".solcreek-creekd-cache-handler.mjs"),
      "utf8",
    )).toBe("handler");
  });

  it("copies next runtime into standalone output when missing", async () => {
    await writeStandalone();
    await writeProjectNextModule("runtime");

    const result = await runPostbuild({ projectDir });

    expect(result.copied).toEqual(["node_modules/next"]);
    expect(result.skipped).toEqual(["public", ".next/static", "cache-handler"]);
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
    expect(result.skipped).toEqual(["public", ".next/static", "cache-handler"]);
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
      "node_modules/next",
      "cache-handler",
    ]);
    expect(readFileSync(tracedNextFile, "utf8")).toBe("traced-runtime");
    expect(readFileSync(tracedNextEnvFile, "utf8")).toBe("traced-env");
  });

  it("fails clearly when standalone output has not been generated", async () => {
    await expect(runPostbuild({ projectDir })).rejects.toThrow(
      "run next build with adapter-creekd first",
    );
  });
});
