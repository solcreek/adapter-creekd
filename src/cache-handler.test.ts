import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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

  it("does not use Date.now for internal cache bookkeeping", async () => {
    const originalDateNow = Date.now;

    Date.now = () => {
      throw new Error("Date.now must not be used by the cache handler");
    };

    try {
      const cache = new CacheHandler();
      await cache.set("no-date-now", { ok: true }, {
        tags: ["no-date-now"],
        revalidate: 60,
      });

      expect((await cache.get("no-date-now"))?.cacheState).toBe("fresh");
      await cache.revalidateTag("no-date-now", { expire: 60 });
      expect((await cache.get("no-date-now"))?.cacheState).toBe("stale");
    } finally {
      Date.now = originalDateNow;
    }
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

  it("persists app page segment data maps", async () => {
    const first = new CacheHandler();
    await first.set("app-page:segments", {
      kind: "APP_PAGE",
      html: Buffer.from("<p>shell</p>"),
      rscData: Buffer.from("rsc"),
      segmentData: new Map([
        ["/dynamic", Buffer.from("segment")],
      ]),
    }, { revalidate: 60 });

    const second = new CacheHandler();
    const hit = await second.get("app-page:segments");
    const value = hit?.value as {
      html?: unknown;
      rscData?: unknown;
      segmentData?: unknown;
    };

    expect(value.html).toEqual(Buffer.from("<p>shell</p>"));
    expect(value.rscData).toEqual(Buffer.from("rsc"));
    expect(value.segmentData).toBeInstanceOf(Map);
    expect((value.segmentData as Map<string, Buffer>).get("/dynamic")).toEqual(
      Buffer.from("segment"),
    );
  });

  it("reads build-seeded app page artifacts from serverDistDir", async () => {
    const serverDistDir = path.join(cacheDir, ".next", "server");
    const appDir = path.join(serverDistDir, "app");
    await mkdir(path.join(appDir, "🎉.segments", "$d$slug"), {
      recursive: true,
    });
    await writeFile(path.join(appDir, "🎉.html"), "<main>party</main>");
    await writeFile(
      path.join(appDir, "🎉.meta"),
      JSON.stringify({
        headers: {
          "x-next-cache-tags": "_N_T_/%F0%9F%8E%89,%F0%9F%8E%82",
        },
        status: 200,
        postponed: "resume-data",
        segmentPaths: ["/$d$slug/__PAGE__"],
      }),
    );
    await writeFile(
      path.join(appDir, "🎉.segments", "$d$slug", "__PAGE__.segment.rsc"),
      Buffer.from("segment"),
    );
    await writeFile(
      path.join(appDir, "🎉.segments", "_full.segment.rsc"),
      Buffer.from("full-rsc"),
    );

    const cache = new CacheHandler({ serverDistDir });
    const hit = await cache.get("/🎉", {
      kind: "APP_PAGE",
      isFallback: false,
      isRoutePPREnabled: true,
    });
    const value = hit?.value as {
      kind?: string;
      html?: unknown;
      rscData?: unknown;
      postponed?: unknown;
      headers?: Record<string, string>;
      status?: unknown;
      segmentData?: unknown;
    };

    expect(hit?.cacheState).toBe("fresh");
    expect(value.kind).toBe("APP_PAGE");
    expect(value.html).toBe("<main>party</main>");
    expect(value.rscData).toEqual(Buffer.from("full-rsc"));
    expect(value.postponed).toBe("resume-data");
    expect(value.status).toBe(200);
    expect(value.headers?.["x-next-cache-tags"]).toContain("%F0%9F%8E%82");
    expect(value.segmentData).toBeInstanceOf(Map);
    expect(
      (value.segmentData as Map<string, Buffer>).get("/$d$slug/__PAGE__"),
    ).toEqual(Buffer.from("segment"));
  });

  it("reads build-seeded app route artifacts from serverDistDir", async () => {
    const serverDistDir = path.join(cacheDir, ".next", "server");
    const appDir = path.join(serverDistDir, "app", "api");
    await mkdir(appDir, { recursive: true });
    await writeFile(path.join(appDir, "hello.body"), Buffer.from("ok"));
    await writeFile(
      path.join(appDir, "hello.meta"),
      JSON.stringify({
        headers: { "content-type": "text/plain" },
        status: 201,
      }),
    );

    const cache = new CacheHandler({ serverDistDir });
    const hit = await cache.get("/api/hello", { kind: "APP_ROUTE" });
    const value = hit?.value as {
      kind?: string;
      body?: unknown;
      headers?: Record<string, string>;
      status?: unknown;
    };

    expect(hit?.cacheState).toBe("fresh");
    expect(value.kind).toBe("APP_ROUTE");
    expect(value.body).toEqual(Buffer.from("ok"));
    expect(value.headers?.["content-type"]).toBe("text/plain");
    expect(value.status).toBe(201);
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
