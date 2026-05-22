import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

interface CacheHandlerContext {
  serverDistDir?: string;
  maxMemoryCacheSize?: number;
}

interface CacheEntry {
  value: unknown;
  lastModified: number;
  clock: number;
  tags: string[];
  revalidate?: number | false;
}

interface StoredEntry extends CacheEntry {
  schema: 1;
}

const DEFAULT_L1_ENTRIES = 2048;
let lastClock = 0;

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function rememberClock(clock: number): void {
  if (clock > lastClock) lastClock = clock;
}

function nextClock(): number {
  const now = Date.now();
  const clock = now > lastClock ? now : lastClock + 1;
  lastClock = clock;
  return clock;
}

function cacheRootFrom(ctx?: CacheHandlerContext): string {
  if (process.env.CREEK_NEXT_CACHE_DIR) {
    return path.resolve(process.env.CREEK_NEXT_CACHE_DIR);
  }
  if (ctx?.serverDistDir) {
    return path.resolve(ctx.serverDistDir, "..", "cache", "creekd");
  }
  return path.resolve(process.cwd(), ".creek-cache", "next");
}

function maxL1Entries(ctx?: CacheHandlerContext): number {
  const fromEnv = Number.parseInt(process.env.CREEK_NEXT_CACHE_L1_ENTRIES ?? "", 10);
  if (Number.isInteger(fromEnv) && fromEnv >= 0) return fromEnv;
  const fromNext = ctx?.maxMemoryCacheSize;
  if (typeof fromNext === "number" && fromNext === 0) return 0;
  return DEFAULT_L1_ENTRIES;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(value, replace), "utf8");
  await fs.rename(tmpPath, filePath);
}

function revive(_key: string, value: unknown): unknown {
  if (
    value &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "Buffer" &&
    Array.isArray((value as { data?: unknown }).data)
  ) {
    return Buffer.from((value as { data: number[] }).data);
  }
  if (
    value &&
    typeof value === "object" &&
    (value as { $type?: unknown }).$type === "BigInt" &&
    typeof (value as { value?: unknown }).value === "string"
  ) {
    return BigInt((value as { value: string }).value);
  }
  return value;
}

function replace(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    return { $type: "BigInt", value: value.toString() };
  }
  return value;
}

export default class CreekdCacheHandler {
  private readonly rootDir: string;
  private readonly entriesDir: string;
  private readonly tagsPath: string;
  private readonly l1MaxEntries: number;
  private readonly l1 = new Map<string, CacheEntry>();
  private readonly tagInvalidatedAt = new Map<string, number>();
  private readonly ready: Promise<void>;

  constructor(ctx?: CacheHandlerContext) {
    this.rootDir = cacheRootFrom(ctx);
    this.entriesDir = path.join(this.rootDir, "entries");
    this.tagsPath = path.join(this.rootDir, "tags.json");
    this.l1MaxEntries = maxL1Entries(ctx);
    this.ready = this.init();
  }

  async get(key: string, _ctx?: { kind?: string }) {
    await this.ready;
    const entry = await this.readEntry(key);
    if (!entry) return null;

    const age = (Date.now() - entry.lastModified) / 1000;
    const staleByTag = this.isStaleByTags(entry);
    const staleByTime =
      entry.revalidate !== undefined &&
      entry.revalidate !== false &&
      (entry.revalidate === 0 || age > entry.revalidate);

    return {
      value: entry.value,
      lastModified: entry.lastModified,
      age: Math.floor(age),
      cacheState: staleByTag || staleByTime ? "stale" as const : "fresh" as const,
    };
  }

  async set(
    key: string,
    data: unknown | null,
    ctx?: { tags?: string[]; revalidate?: number | false },
  ): Promise<void> {
    await this.ready;

    if (data === null) {
      this.l1.delete(key);
      await fs.rm(this.entryPath(key), { force: true });
      return;
    }

    const entry: CacheEntry = {
      value: data,
      lastModified: Date.now(),
      clock: nextClock(),
      tags: ctx?.tags ?? [],
      revalidate: typeof ctx?.revalidate === "number" ? ctx.revalidate : undefined,
    };

    this.setL1(key, entry);
    const stored: StoredEntry = { schema: 1, ...entry };
    await writeJsonAtomic(this.entryPath(key), stored);
  }

  async revalidateTag(tag: string | string[]): Promise<void> {
    await this.ready;
    const now = nextClock();
    for (const item of Array.isArray(tag) ? tag : [tag]) {
      this.tagInvalidatedAt.set(item, now);
    }
    await this.persistTags();
  }

  resetRequestCache(): void {
    // No per-request cache to reset. L1 is intentionally process-wide.
  }

  private async init(): Promise<void> {
    await fs.mkdir(this.entriesDir, { recursive: true });
    await this.loadTags();
  }

  private entryPath(key: string): string {
    return path.join(this.entriesDir, `${hashKey(key)}.json`);
  }

  private async readEntry(key: string): Promise<CacheEntry | null> {
    const cached = this.l1.get(key);
    if (cached) {
      this.setL1(key, cached);
      return cached;
    }

    try {
      const raw = await fs.readFile(this.entryPath(key), "utf8");
      const stored = JSON.parse(raw, revive) as Partial<StoredEntry>;
      if (stored.schema !== 1 || !stored.lastModified) return null;
      const clock = typeof stored.clock === "number" ? stored.clock : stored.lastModified;
      rememberClock(clock);
      const entry: CacheEntry = {
        value: stored.value,
        lastModified: stored.lastModified,
        clock,
        tags: Array.isArray(stored.tags) ? stored.tags : [],
        revalidate: typeof stored.revalidate === "number" ? stored.revalidate : undefined,
      };
      this.setL1(key, entry);
      return entry;
    } catch {
      return null;
    }
  }

  private setL1(key: string, entry: CacheEntry): void {
    if (this.l1MaxEntries <= 0) return;
    this.l1.delete(key);
    this.l1.set(key, entry);
    while (this.l1.size > this.l1MaxEntries) {
      const oldest = this.l1.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.l1.delete(oldest);
    }
  }

  private isStaleByTags(entry: CacheEntry): boolean {
    for (const tag of entry.tags) {
      const invalidatedAt = this.tagInvalidatedAt.get(tag);
      if (invalidatedAt !== undefined && invalidatedAt > entry.clock) {
        return true;
      }
    }
    return false;
  }

  private async loadTags(): Promise<void> {
    try {
      const raw = await fs.readFile(this.tagsPath, "utf8");
      const data = JSON.parse(raw) as Record<string, unknown>;
      for (const [tag, timestamp] of Object.entries(data)) {
        if (typeof timestamp === "number") {
          rememberClock(timestamp);
          this.tagInvalidatedAt.set(tag, timestamp);
        }
      }
    } catch {
      // Missing/corrupt tag index means "no tags invalidated yet".
    }
  }

  private async persistTags(): Promise<void> {
    await writeJsonAtomic(
      this.tagsPath,
      Object.fromEntries(this.tagInvalidatedAt),
    );
  }
}
