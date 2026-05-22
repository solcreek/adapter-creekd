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

  it("copies public and static assets into standalone output", async () => {
    await writeStandalone();
    await mkdir(path.join(projectDir, "public"), { recursive: true });
    await mkdir(path.join(projectDir, ".next", "static", "chunks"), { recursive: true });
    writeFileSync(path.join(projectDir, "public", "robots.txt"), "ok");
    writeFileSync(path.join(projectDir, ".next", "static", "chunks", "app.js"), "ok");

    const result = await runPostbuild({ projectDir });

    expect(result.copied).toEqual(["public", ".next/static"]);
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
    expect(result.skipped).toEqual(["public", ".next/static"]);
  });

  it("fails clearly when standalone output has not been generated", async () => {
    await expect(runPostbuild({ projectDir })).rejects.toThrow(
      "run next build with adapter-creekd first",
    );
  });
});
