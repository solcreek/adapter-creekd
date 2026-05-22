import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCreekdAdapter } from "./index.js";

describe("createCreekdAdapter.modifyConfig", () => {
  let projectDir: string;
  let oldCwd: string;
  let oldCacheDir: string | undefined;
  let oldL1Entries: string | undefined;

  beforeEach(() => {
    oldCwd = process.cwd();
    oldCacheDir = process.env.CREEK_NEXT_CACHE_DIR;
    oldL1Entries = process.env.CREEK_NEXT_CACHE_L1_ENTRIES;
    projectDir = mkdtempSync(path.join(tmpdir(), "adapter-creekd-config-"));
    process.chdir(projectDir);
  });

  afterEach(() => {
    if (oldCacheDir === undefined) {
      delete process.env.CREEK_NEXT_CACHE_DIR;
    } else {
      process.env.CREEK_NEXT_CACHE_DIR = oldCacheDir;
    }
    if (oldL1Entries === undefined) {
      delete process.env.CREEK_NEXT_CACHE_L1_ENTRIES;
    } else {
      process.env.CREEK_NEXT_CACHE_L1_ENTRIES = oldL1Entries;
    }
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
    expect(config?.cacheHandlers).toMatchObject({
      default: expect.stringContaining("use-cache-handler"),
      remote: expect.stringContaining("use-cache-handler"),
    });
  });

  it("applies cache env options during build so seeded entries use runtime storage", () => {
    const adapter = createCreekdAdapter({
      env: {
        CREEK_NEXT_CACHE_DIR: "/var/cache/next",
        CREEK_NEXT_CACHE_L1_ENTRIES: 512,
      },
    });

    adapter.modifyConfig?.(
      {},
      {
        phase: "phase-production-build",
      } as Parameters<NonNullable<typeof adapter.modifyConfig>>[1],
    );

    expect(process.env.CREEK_NEXT_CACHE_DIR).toBe("/var/cache/next");
    expect(process.env.CREEK_NEXT_CACHE_L1_ENTRIES).toBe("512");
  });
});
