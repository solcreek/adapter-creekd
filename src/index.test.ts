import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCreekdAdapter } from "./index.js";

describe("createCreekdAdapter.modifyConfig", () => {
  let projectDir: string;
  let oldCwd: string;

  beforeEach(() => {
    oldCwd = process.cwd();
    projectDir = mkdtempSync(path.join(tmpdir(), "adapter-creekd-config-"));
    process.chdir(projectDir);
  });

  afterEach(() => {
    process.chdir(oldCwd);
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("routes all server cache policy through the creekd cache handler", () => {
    const adapter = createCreekdAdapter();
    const config = adapter.modifyConfig?.(
      {
        images: {
          unoptimized: false,
        },
      },
      {
        phase: "phase-production-build",
      } as Parameters<NonNullable<typeof adapter.modifyConfig>>[1],
    );

    expect(config?.cacheMaxMemorySize).toBe(0);
    expect(config?.images).toMatchObject({
      unoptimized: false,
      customCacheHandler: true,
    });
    expect(config?.output).toBe("standalone");
    expect(config?.cacheHandler).toContain("cache-handler");
  });
});
