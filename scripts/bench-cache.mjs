import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import CoreCacheHandler from "@solcreek/adapter-core/cache-handler";
import CreekdCacheHandler from "../dist/cache-handler.js";

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

async function time(name, fn) {
  const start = performance.now();
  await fn();
  const ms = performance.now() - start;
  return { name, ms };
}

async function runCandidate(name, makeHandler, makeColdHandler) {
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

  if (makeColdHandler) {
    const coldHandler = await makeColdHandler();
    timings.push(await time("get-cold", async () => {
      for (const key of keys) {
        const got = await coldHandler.get(key);
        if (!got || got.cacheState !== "fresh") {
          throw new Error(`${name}: expected fresh cold cache hit for ${key}`);
        }
      }
    }));
  }

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
const oldCacheDir = process.env.CREEK_NEXT_CACHE_DIR;
const oldL1Entries = process.env.CREEK_NEXT_CACHE_L1_ENTRIES;
try {
  console.log(
    `cache benchmark: entries=${ENTRY_COUNT} payloadBytes=${PAYLOAD_BYTES} tags=${TAG_COUNT}`,
  );
  const results = [
    await runCandidate("adapter-core in-memory", async () => new CoreCacheHandler()),
    await runCandidate("adapter-creekd filesystem L1+L2", async () => {
      process.env.CREEK_NEXT_CACHE_DIR = path.join(tmp, "creekd");
      process.env.CREEK_NEXT_CACHE_L1_ENTRIES = String(ENTRY_COUNT);
      return new CreekdCacheHandler();
    }, async () => {
      process.env.CREEK_NEXT_CACHE_DIR = path.join(tmp, "creekd");
      process.env.CREEK_NEXT_CACHE_L1_ENTRIES = String(ENTRY_COUNT);
      return new CreekdCacheHandler();
    }),
  ];
  for (const result of results) printResult(result);
} finally {
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
  await rm(tmp, { recursive: true, force: true });
}
