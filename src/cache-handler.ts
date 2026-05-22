type NodeFs = typeof import("node:fs/promises");
type NodePath = typeof import("node:path");
type NodeModules = { fs: NodeFs; path: NodePath };

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

interface TagState {
  stale?: number;
  expired?: number;
}

const DEFAULT_L1_ENTRIES = 2048;
let lastClock = 0;

function hashKey(key: string): string {
  let h1 = 0xdeadbeef ^ key.length;
  let h2 = 0x41c6ce57 ^ key.length;
  for (let i = 0; i < key.length; i++) {
    const ch = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${(h2 >>> 0).toString(16).padStart(8, "0")}${(h1 >>> 0).toString(16).padStart(8, "0")}`;
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

function env(name: string): string | undefined {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.[name];
}

function cwd(): string {
  return (
    globalThis as { process?: { cwd?: () => string } }
  ).process?.cwd?.() ?? ".";
}

function pid(): number {
  return (globalThis as { process?: { pid?: number } }).process?.pid ?? 0;
}

function randomId(): string {
  const cryptoLike = (globalThis as {
    crypto?: { randomUUID?: () => string };
  }).crypto;
  return cryptoLike?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function isEdgeRuntime(): boolean {
  return env("NEXT_RUNTIME") === "edge";
}

async function loadNodeModules(): Promise<NodeModules | null> {
  if (isEdgeRuntime()) return null;

  try {
    const fsSpecifier = "node:" + "fs/promises";
    const pathSpecifier = "node:" + "path";
    const [fsModule, pathModule] = await Promise.all([
      import(fsSpecifier) as Promise<NodeFs>,
      import(pathSpecifier) as Promise<NodePath>,
    ]);
    return { fs: fsModule, path: pathModule };
  } catch {
    return null;
  }
}

function cacheRootFrom(node: NodeModules, ctx?: CacheHandlerContext): string {
  const configuredCacheDir = env("CREEK_NEXT_CACHE_DIR");
  if (configuredCacheDir) {
    return node.path.resolve(configuredCacheDir);
  }
  if (ctx?.serverDistDir) {
    return node.path.resolve(ctx.serverDistDir, "..", "cache", "creekd");
  }
  return node.path.resolve(cwd(), ".creek-cache", "next");
}

function maxL1Entries(ctx?: CacheHandlerContext): number {
  const fromEnv = Number.parseInt(env("CREEK_NEXT_CACHE_L1_ENTRIES") ?? "", 10);
  if (Number.isInteger(fromEnv) && fromEnv >= 0) return fromEnv;
  const fromNext = ctx?.maxMemoryCacheSize;
  if (typeof fromNext === "number" && fromNext === 0) return 0;
  return DEFAULT_L1_ENTRIES;
}

async function loadNextTagsManifest(): Promise<Map<string, TagState> | undefined> {
  if (isEdgeRuntime()) return undefined;

  try {
    const moduleSpecifier = "node:" + "module";
    const { createRequire } = await import(moduleSpecifier) as typeof import("node:module");
    const require = createRequire(import.meta.url);
    const mod = require(
      "next/dist/server/lib/incremental-cache/tags-manifest.external.js",
    ) as { tagsManifest?: Map<string, TagState> };
    return mod.tagsManifest;
  } catch {
    return undefined;
  }
}

function coerceTagState(value: unknown): TagState | null {
  if (typeof value === "number") return { stale: value };
  if (!value || typeof value !== "object") return null;

  const state: TagState = {};
  const stale = (value as { stale?: unknown }).stale;
  const expired = (value as { expired?: unknown }).expired;
  if (typeof stale === "number") state.stale = stale;
  if (typeof expired === "number") state.expired = expired;
  return state.stale === undefined && state.expired === undefined ? null : state;
}

function rememberTagStateClock(state: TagState): void {
  const now = Date.now();
  for (const value of [state.stale, state.expired]) {
    if (typeof value === "number") rememberClock(Math.min(value, now));
  }
}

async function writeJsonAtomic(
  fs: NodeFs,
  filePath: string,
  value: unknown,
): Promise<void> {
  const tmpPath = `${filePath}.${pid()}.${randomId()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(value, replace), "utf8");
  await fs.rename(tmpPath, filePath);
}

function revive(_key: string, value: unknown): unknown {
  const BufferCtor = (globalThis as {
    Buffer?: { from(data: number[]): unknown };
  }).Buffer;
  if (
    value &&
    typeof value === "object" &&
    (value as { $type?: unknown }).$type === "Map" &&
    Array.isArray((value as { entries?: unknown }).entries)
  ) {
    return new Map((value as { entries: [unknown, unknown][] }).entries);
  }
  if (
    BufferCtor &&
    value &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "Buffer" &&
    Array.isArray((value as { data?: unknown }).data)
  ) {
    return BufferCtor.from((value as { data: number[] }).data);
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
  if (value instanceof Map) {
    return { $type: "Map", entries: Array.from(value.entries()) };
  }
  if (typeof value === "bigint") {
    return { $type: "BigInt", value: value.toString() };
  }
  return value;
}

export default class CreekdCacheHandler {
  private readonly l1MaxEntries: number;
  private readonly l1 = new Map<string, CacheEntry>();
  private readonly tagStates = new Map<string, TagState>();
  private readonly ready: Promise<void>;
  private node: NodeModules | null = null;
  private rootDir = "";
  private entriesDir = "";
  private tagsPath = "";
  private nextTagsManifest: Map<string, TagState> | undefined;

  constructor(ctx?: CacheHandlerContext) {
    this.l1MaxEntries = maxL1Entries(ctx);
    this.ready = this.init(ctx);
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
      if (this.node) {
        await this.node.fs.rm(this.entryPath(key), { force: true });
      }
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
    if (!this.node) return;

    const stored: StoredEntry = { schema: 1, ...entry };
    await writeJsonAtomic(this.node.fs, this.entryPath(key), stored);
  }

  async revalidateTag(
    tag: string | string[],
    durations?: { expire?: number },
  ): Promise<void> {
    await this.ready;
    const now = nextClock();
    for (const item of Array.isArray(tag) ? tag : [tag]) {
      const state = { ...this.tagStates.get(item) };
      if (durations) {
        state.stale = now;
        if (durations.expire !== undefined) {
          state.expired = now + durations.expire * 1000;
        }
      } else {
        state.expired = now;
      }
      this.setTagState(item, state);
    }
    await this.persistTags();
  }

  resetRequestCache(): void {
    // No per-request cache to reset. L1 is intentionally process-wide.
  }

  private async init(ctx?: CacheHandlerContext): Promise<void> {
    this.nextTagsManifest = await loadNextTagsManifest();
    this.node = await loadNodeModules();
    if (!this.node) return;

    this.rootDir = cacheRootFrom(this.node, ctx);
    this.entriesDir = this.node.path.join(this.rootDir, "entries");
    this.tagsPath = this.node.path.join(this.rootDir, "tags.json");

    await this.node.fs.mkdir(this.entriesDir, { recursive: true });
    await this.loadTags();
  }

  private entryPath(key: string): string {
    if (!this.node) {
      throw new Error("adapter-creekd cache filesystem is unavailable");
    }
    return this.node.path.join(this.entriesDir, `${hashKey(key)}.json`);
  }

  private async readEntry(key: string): Promise<CacheEntry | null> {
    const cached = this.l1.get(key);
    if (cached) {
      this.setL1(key, cached);
      return cached;
    }
    if (!this.node) return null;

    try {
      const raw = await this.node.fs.readFile(this.entryPath(key), "utf8");
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
      const state = this.tagStates.get(tag);
      if (
        (state?.stale !== undefined && state.stale > entry.clock) ||
        (state?.expired !== undefined && state.expired > entry.clock)
      ) {
        return true;
      }
    }
    return false;
  }

  private setTagState(tag: string, state: TagState): void {
    this.tagStates.set(tag, state);
    this.nextTagsManifest?.set(tag, state);
  }

  private async loadTags(): Promise<void> {
    if (!this.node) return;

    try {
      const raw = await this.node.fs.readFile(this.tagsPath, "utf8");
      const data = JSON.parse(raw) as Record<string, unknown>;
      for (const [tag, value] of Object.entries(data)) {
        const state = coerceTagState(value);
        if (state) {
          rememberTagStateClock(state);
          this.setTagState(tag, state);
        }
      }
    } catch {
      // Missing/corrupt tag index means "no tags invalidated yet".
    }
  }

  private async persistTags(): Promise<void> {
    if (!this.node) return;

    await writeJsonAtomic(
      this.node.fs,
      this.tagsPath,
      Object.fromEntries(this.tagStates),
    );
  }
}
