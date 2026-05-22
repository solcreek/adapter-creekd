import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import CacheHandler from "./cache-handler.js";

const require = createRequire(import.meta.url);
const testDir = path.dirname(fileURLToPath(import.meta.url));

describe("CreekdCacheHandler", () => {
  let cacheDir: string;
  let oldCacheDir: string | undefined;
  let oldL1Entries: string | undefined;

  beforeEach(() => {
    cacheDir = mkdtempSync(path.join(tmpdir(), "adapter-creekd-cache-"));
    oldCacheDir = process.env.CREEK_NEXT_CACHE_DIR;
    oldL1Entries = process.env.CREEK_NEXT_CACHE_L1_ENTRIES;
    process.env.CREEK_NEXT_CACHE_DIR = cacheDir;
    delete process.env.CREEK_NEXT_CACHE_L1_ENTRIES;
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
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("returns fresh entries after set", async () => {
    const cache = new CacheHandler();
    await cache.set("page:/", { kind: "APP_PAGE", html: "<p>ok</p>" }, {
      tags: ["home"],
      revalidate: 60,
    });

    const hit = await cache.get("page:/");
    expect(hit?.cacheState).toBe("fresh");
    expect(hit?.value).toEqual({ kind: "APP_PAGE", html: "<p>ok</p>" });
  });

  it("persists entries across handler instances", async () => {
    const first = new CacheHandler();
    await first.set("fetch:1", { kind: "FETCH", data: { body: "ok" } }, {
      tags: ["api"],
      revalidate: 60,
    });

    const second = new CacheHandler();
    const hit = await second.get("fetch:1");
    expect(hit?.cacheState).toBe("fresh");
    expect(hit?.value).toEqual({ kind: "FETCH", data: { body: "ok" } });
  });

  it("persists tag invalidation across handler instances", async () => {
    const first = new CacheHandler();
    await first.set("fetch:tagged", { kind: "FETCH", data: { body: "old" } }, {
      tags: ["tagged"],
      revalidate: 60,
    });
    await first.revalidateTag("tagged");

    const second = new CacheHandler();
    const hit = await second.get("fetch:tagged");
    expect(hit?.cacheState).toBe("stale");
  });

  it("mirrors tag invalidation into Next.js runtime tag manifest", async () => {
    const { tagsManifest } = require(
      "next/dist/server/lib/incremental-cache/tags-manifest.external.js",
    ) as { tagsManifest: Map<string, { stale?: number; expired?: number }> };
    tagsManifest.delete("runtime-tag");

    const cache = new CacheHandler();
    await cache.revalidateTag("runtime-tag", { expire: 60 });

    const mirrored = tagsManifest.get("runtime-tag");
    expect(typeof mirrored?.stale).toBe("number");
    expect(typeof mirrored?.expired).toBe("number");
  });

  it("removes persisted entries when set to null", async () => {
    const cache = new CacheHandler();
    await cache.set("delete-me", { ok: true }, { tags: ["x"] });
    expect(await cache.get("delete-me")).not.toBeNull();

    await cache.set("delete-me", null);
    expect(await cache.get("delete-me")).toBeNull();
  });

  it("can read from filesystem when L1 is disabled", async () => {
    process.env.CREEK_NEXT_CACHE_L1_ENTRIES = "0";
    const first = new CacheHandler();
    await first.set("l2-only", { ok: true }, { revalidate: 60 });

    const second = new CacheHandler();
    const hit = await second.get("l2-only");
    expect(hit?.cacheState).toBe("fresh");
    expect(hit?.value).toEqual({ ok: true });
  });

  it("persists binary and bigint payloads", async () => {
    const first = new CacheHandler();
    await first.set("typed", {
      body: Buffer.from("hello"),
      count: 10n,
    });

    const second = new CacheHandler();
    const hit = await second.get("typed");
    expect(hit?.value).toEqual({
      body: Buffer.from("hello"),
      count: 10n,
    });
  });

  it("derives the default cache root from serverDistDir", async () => {
    delete process.env.CREEK_NEXT_CACHE_DIR;
    const serverDistDir = path.join(cacheDir, ".next", "server");
    const cache = new CacheHandler({ serverDistDir });
    await cache.set("derived", { ok: true });

    const tagsFile = path.join(cacheDir, ".next", "cache", "creekd", "tags.json");
    await cache.revalidateTag("anything");
    await expect(readFile(tagsFile, "utf8")).resolves.toContain("anything");
  });

  it("keeps the handler source free of static node imports for edge builds", () => {
    const source = readFileSync(
      path.join(testDir, "cache-handler.ts"),
      "utf8",
    );

    expect(source).not.toMatch(/^import .*node:/m);
    expect(source).not.toMatch(/from ["']node:/);
  });
});
