import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import CoreCacheHandler from "@solcreek/adapter-core/cache-handler";

const ENTRY_COUNT = Number.parseInt(process.env.CACHE_BENCH_ENTRIES ?? "5000", 10);
const PAYLOAD_BYTES = Number.parseInt(process.env.CACHE_BENCH_PAYLOAD_BYTES ?? "2048", 10);
const TAG_COUNT = Number.parseInt(process.env.CACHE_BENCH_TAGS ?? "64", 10);

function makePayload(i) {
  return {
    kind: "FETCH",
    data: "x".repeat(PAYLOAD_BYTES),
    headers: { "x-cache-bench": String(i) },
  };
}

function tagsFor(i) {
  return [`tag:${i % TAG_COUNT}`, "all"];
}

function hashKey(key) {
  return createHash("sha256").update(key).digest("hex");
}

class JsonFileCacheHandler {
  constructor({ dir }) {
    this.dir = dir;
    this.memory = new Map();
    this.tagInvalidatedAt = new Map();
  }

  async init() {
    await mkdir(this.dir, { recursive: true });
  }

  fileFor(key) {
    return path.join(this.dir, `${hashKey(key)}.json`);
  }

  async get(key) {
    let entry = this.memory.get(key);
    if (!entry) {
      try {
        entry = JSON.parse(await readFile(this.fileFor(key), "utf8"));
        this.memory.set(key, entry);
      } catch {
        return null;
      }
    }

    const age = (Date.now() - entry.lastModified) / 1000;
    const staleByTag = entry.tags.some((tag) => {
      const invalidatedAt = this.tagInvalidatedAt.get(tag);
      return invalidatedAt !== undefined && invalidatedAt > entry.lastModified;
    });
    const staleByTime =
      entry.revalidate !== undefined &&
      entry.revalidate !== false &&
      (entry.revalidate === 0 || age > entry.revalidate);

    return {
      value: entry.value,
      lastModified: entry.lastModified,
      age: Math.floor(age),
      cacheState: staleByTag || staleByTime ? "stale" : "fresh",
    };
  }

  async set(key, data, ctx = {}) {
    if (data === null) {
      this.memory.delete(key);
      return;
    }
    const entry = {
      value: data,
      lastModified: Date.now(),
      tags: ctx.tags ?? [],
      revalidate: typeof ctx.revalidate === "number" ? ctx.revalidate : undefined,
    };
    this.memory.set(key, entry);
    await writeFile(this.fileFor(key), JSON.stringify(entry), "utf8");
  }

  async revalidateTag(tag) {
    const now = Date.now();
    for (const item of Array.isArray(tag) ? tag : [tag]) {
      this.tagInvalidatedAt.set(item, now);
    }
  }

  resetRequestCache() {}
}

async function time(name, fn) {
  const start = performance.now();
  await fn();
  const ms = performance.now() - start;
  return { name, ms };
}

async function runCandidate(name, makeHandler) {
  const handler = await makeHandler();
  const keys = Array.from({ length: ENTRY_COUNT }, (_, i) => `key:${i}`);
  const timings = [];

  timings.push(await time("set", async () => {
    for (let i = 0; i < keys.length; i++) {
      await handler.set(keys[i], makePayload(i), {
        tags: tagsFor(i),
        revalidate: 60,
      });
    }
  }));

  timings.push(await time("get-hot", async () => {
    for (const key of keys) {
      const got = await handler.get(key);
      if (!got || got.cacheState !== "fresh") {
        throw new Error(`${name}: expected fresh cache hit for ${key}`);
      }
    }
  }));

  timings.push(await time("revalidateTag", async () => {
    await handler.revalidateTag("tag:0");
  }));

  timings.push(await time("get-stale-tag", async () => {
    for (let i = 0; i < keys.length; i += TAG_COUNT) {
      const got = await handler.get(keys[i]);
      if (!got || got.cacheState !== "stale") {
        throw new Error(`${name}: expected stale cache hit for ${keys[i]}`);
      }
    }
  }));

  return { name, timings };
}

function printResult(result) {
  console.log(`\n${result.name}`);
  for (const timing of result.timings) {
    const perOp =
      timing.name === "revalidateTag"
        ? timing.ms
        : timing.ms / (timing.name === "get-stale-tag"
            ? Math.ceil(ENTRY_COUNT / TAG_COUNT)
            : ENTRY_COUNT);
    console.log(
      `${timing.name.padEnd(15)} ${timing.ms.toFixed(2).padStart(10)} ms  ${perOp.toFixed(4).padStart(10)} ms/op`,
    );
  }
}

const tmp = await mkdtemp(path.join(tmpdir(), "adapter-creekd-cache-bench-"));
try {
  console.log(
    `cache benchmark: entries=${ENTRY_COUNT} payloadBytes=${PAYLOAD_BYTES} tags=${TAG_COUNT}`,
  );
  const results = [
    await runCandidate("adapter-core in-memory", async () => new CoreCacheHandler()),
    await runCandidate("json-file prototype (L1 memory + L2 disk)", async () => {
      const handler = new JsonFileCacheHandler({ dir: path.join(tmp, "json") });
      await handler.init();
      return handler;
    }),
  ];
  for (const result of results) printResult(result);
  console.log(
    "\nNote: json-file prototype is a benchmark foil, not the production adapter-creekd cache design.",
  );
} finally {
  await rm(tmp, { recursive: true, force: true });
}
