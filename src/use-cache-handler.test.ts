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
    await handler.set("component:one", Promise.resolve({
      value: streamFromText("payload"),
      tags: ["component-tag"],
      stale: 300,
      timestamp,
      expire: 3600,
      revalidate: 60,
    }));

    const hit = await handler.get("component:one", []);

    expect(hit?.tags).toEqual(["component-tag"]);
    expect(hit?.timestamp).toBe(timestamp);
    expect(hit?.revalidate).toBe(60);
    expect(hit?.value ? await streamToText(hit.value) : "").toBe("payload");
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
});
