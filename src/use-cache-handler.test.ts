import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import handler from "./use-cache-handler.js";

function streamFromText(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from(text));
      controller.close();
    },
  });
}

async function streamToText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

describe("Creekd use-cache handler", () => {
  let cacheDir: string;
  let oldCacheDir: string | undefined;
  let oldL1Entries: string | undefined;

  beforeAll(() => {
    cacheDir = mkdtempSync(path.join(tmpdir(), "adapter-creekd-use-cache-"));
    oldCacheDir = process.env.CREEK_NEXT_CACHE_DIR;
    oldL1Entries = process.env.CREEK_NEXT_CACHE_L1_ENTRIES;
    process.env.CREEK_NEXT_CACHE_DIR = cacheDir;
    process.env.CREEK_NEXT_CACHE_L1_ENTRIES = "0";
  });

  afterAll(() => {
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

  it("persists stream entries and returns fresh reads", async () => {
    const timestamp = Date.now() - 1000;
    const entry = {
      value: streamFromText("payload"),
      tags: ["component-tag"],
      stale: 300,
      timestamp,
      expire: 3600,
      revalidate: 60,
    };
    await handler.set("component:one", Promise.resolve(entry));

    const hit = await handler.get("component:one", []);

    expect(hit?.tags).toEqual(["component-tag"]);
    expect(hit?.timestamp).toBe(timestamp);
    expect(hit?.revalidate).toBe(60);
    expect(hit?.value ? await streamToText(hit.value) : "").toBe("payload");
    expect(await streamToText(entry.value)).toBe("payload");
  });

  it("marks entries stale or expired from persisted tags", async () => {
    const timestamp = Date.now() - 1000;
    await handler.set("component:tagged", Promise.resolve({
      value: streamFromText("payload"),
      tags: ["tagged"],
      stale: 300,
      timestamp,
      expire: 3600,
      revalidate: 60,
    }));

    await handler.updateTags(["tagged"], { expire: 3600 });
    await handler.refreshTags();
    expect((await handler.get("component:tagged", []))?.revalidate).toBe(-1);

    await handler.updateTags(["tagged"]);
    await handler.refreshTags();
    expect(await handler.get("component:tagged", [])).toBeUndefined();
  });

  it("returns request soft tags without persisting them", async () => {
    const timestamp = Date.now() - 1000;
    await handler.set("component:soft-tags", Promise.resolve({
      value: streamFromText("payload"),
      tags: ["component-soft"],
      stale: 300,
      timestamp,
      expire: 3600,
      revalidate: 60,
    }));

    expect((await handler.get("component:soft-tags", [
      "route-soft",
      "component-soft",
    ]))?.tags).toEqual(["component-soft", "route-soft"]);

    await handler.updateTags(["route-soft"], { expire: 3600 });
    await handler.refreshTags();

    expect((await handler.get("component:soft-tags", ["route-soft"]))?.revalidate)
      .toBe(-1);
    expect((await handler.get("component:soft-tags", []))?.revalidate).toBe(60);
  });

  it("blocks instead of serving stale entries when stale time is zero", async () => {
    await handler.set("component:zero-stale", Promise.resolve({
      value: streamFromText("payload"),
      tags: ["zero-stale"],
      stale: 0,
      timestamp: Date.now() - 2_000,
      expire: 3600,
      revalidate: 1,
    }));

    await handler.set("component:positive-stale", Promise.resolve({
      value: streamFromText("payload"),
      tags: ["positive-stale"],
      stale: 300,
      timestamp: Date.now() - 2_000,
      expire: 3600,
      revalidate: 1,
    }));

    expect(await handler.get("component:zero-stale", [])).toBeUndefined();
    expect(await handler.get("component:positive-stale", [])).toBeDefined();
  });

  it("does not use Date.now for internal cache bookkeeping", async () => {
    const timestamp = performance.timeOrigin + performance.now() - 1000;
    const originalDateNow = Date.now;

    Date.now = () => {
      throw new Error("Date.now must not be used by the cache handler");
    };

    try {
      await handler.set("component:no-date-now", Promise.resolve({
        value: streamFromText("payload"),
        tags: ["no-date-now"],
        stale: 300,
        timestamp,
        expire: 3600,
        revalidate: 60,
      }));

      expect(await handler.get("component:no-date-now", [])).toBeDefined();
      await handler.updateTags(["no-date-now"], { expire: 3600 });
      await handler.refreshTags();
      expect((await handler.get("component:no-date-now", []))?.revalidate).toBe(-1);
    } finally {
      Date.now = originalDateNow;
    }
  });
});
