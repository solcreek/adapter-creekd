type NodeFs = typeof import("node:fs/promises");
type NodePath = typeof import("node:path");
type NodeModules = { fs: NodeFs; path: NodePath };

interface UseCacheEntry {
  value: ReadableStream<Uint8Array>;
  tags: string[];
  stale: number;
  timestamp: number;
  expire: number;
  revalidate: number;
}

interface StoredUseCacheEntry {
  schema: 1;
  tags: string[];
  stale: number;
  timestamp: number;
  expire: number;
  revalidate: number;
  body: string;
}

interface MemoryUseCacheEntry extends Omit<StoredUseCacheEntry, "body"> {
  body: Uint8Array;
}

interface TagState {
  stale?: number;
  expired?: number;
}

const DEFAULT_L1_ENTRIES = 2048;
const pendingSets = new Map<string, Promise<void>>();
const l1 = new Map<string, MemoryUseCacheEntry>();
const tagStates = new Map<string, TagState>();
let initPromise: Promise<void> | undefined;
let node: NodeModules | null = null;
let rootDir = "";
let entriesDir = "";
let tagsPath = "";

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

function debug(...args: unknown[]): void {
  if (!env("NEXT_PRIVATE_DEBUG_CACHE") && !env("CREEK_DEBUG_CACHE")) return;
  console.debug("[adapter-creekd use-cache]", ...args);
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

function nowMs(): number {
  const perf = (globalThis as {
    performance?: { now?: () => number; timeOrigin?: number };
  }).performance;
  if (perf?.now && typeof perf.timeOrigin === "number") {
    return perf.timeOrigin + perf.now();
  }
  return Date.now();
}

function randomId(): string {
  const cryptoLike = (globalThis as {
    crypto?: { randomUUID?: () => string };
  }).crypto;
  return cryptoLike?.randomUUID?.() ??
    `${Math.round(nowMs()).toString(36)}-${Math.random().toString(36).slice(2)}`;
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

function cacheRootFrom(loaded: NodeModules): string {
  const configuredCacheDir = env("CREEK_NEXT_CACHE_DIR");
  if (configuredCacheDir) {
    return loaded.path.resolve(configuredCacheDir);
  }
  return loaded.path.resolve(cwd(), ".next", "cache", "creekd");
}

function maxL1Entries(): number {
  const fromEnv = Number.parseInt(env("CREEK_NEXT_CACHE_L1_ENTRIES") ?? "", 10);
  if (Number.isInteger(fromEnv) && fromEnv >= 0) return fromEnv;
  return DEFAULT_L1_ENTRIES;
}

function bytesToBase64(bytes: Uint8Array): string {
  const BufferCtor = (globalThis as {
    Buffer?: { from(data: Uint8Array): { toString(encoding: "base64"): string } };
  }).Buffer;
  if (BufferCtor) return BufferCtor.from(bytes).toString("base64");

  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const BufferCtor = (globalThis as {
    Buffer?: { from(data: string, encoding: "base64"): Uint8Array };
  }).Buffer;
  if (BufferCtor) return BufferCtor.from(value, "base64");

  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    chunks.push(chunk.value);
    total += chunk.value.byteLength;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice());
      controller.close();
    },
  });
}

function mergeTags(...tagGroups: string[][]): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const group of tagGroups) {
    for (const tag of group) {
      if (seen.has(tag)) continue;
      seen.add(tag);
      tags.push(tag);
    }
  }
  return tags;
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

async function writeJsonAtomic(
  fs: NodeFs,
  filePath: string,
  value: unknown,
): Promise<void> {
  const tmpPath = `${filePath}.${pid()}.${randomId()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(value), "utf8");
  await fs.rename(tmpPath, filePath);
}

async function init(): Promise<void> {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    node = await loadNodeModules();
    if (!node) return;

    rootDir = cacheRootFrom(node);
    entriesDir = node.path.join(rootDir, "use-cache");
    tagsPath = node.path.join(rootDir, "tags.json");

    await node.fs.mkdir(entriesDir, { recursive: true });
    await loadTags();
  })();

  return initPromise;
}

function entryPath(key: string): string {
  if (!node) {
    throw new Error("adapter-creekd use-cache filesystem is unavailable");
  }
  return node.path.join(entriesDir, `${hashKey(key)}.json`);
}

function setL1(key: string, entry: MemoryUseCacheEntry): void {
  const limit = maxL1Entries();
  if (limit <= 0) return;
  l1.delete(key);
  l1.set(key, entry);
  while (l1.size > limit) {
    const oldest = l1.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    l1.delete(oldest);
  }
}

function hasExpiredTag(tags: string[], timestamp: number): boolean {
  const now = nowMs();
  for (const tag of tags) {
    const state = tagStates.get(tag);
    if (
      state?.expired !== undefined &&
      state.expired > timestamp &&
      state.expired <= now
    ) {
      return true;
    }
  }
  return false;
}

function hasStaleTag(tags: string[], timestamp: number): boolean {
  for (const tag of tags) {
    const state = tagStates.get(tag);
    if (state?.stale !== undefined && state.stale > timestamp) {
      return true;
    }
  }
  return false;
}

function toCacheEntry(
  entry: MemoryUseCacheEntry,
  softTags: string[],
): UseCacheEntry | undefined {
  const now = nowMs();
  if (now > entry.timestamp + entry.expire * 1000) return undefined;
  if (
    entry.stale <= 0 &&
    now > entry.timestamp + entry.revalidate * 1000
  ) {
    return undefined;
  }

  const allTags = mergeTags(entry.tags, softTags);
  if (hasExpiredTag(allTags, entry.timestamp)) return undefined;

  return {
    value: streamFromBytes(entry.body),
    tags: allTags,
    stale: entry.stale,
    timestamp: entry.timestamp,
    expire: entry.expire,
    revalidate: hasStaleTag(allTags, entry.timestamp) ? -1 : entry.revalidate,
  };
}

async function readEntry(key: string): Promise<MemoryUseCacheEntry | undefined> {
  const cached = l1.get(key);
  if (cached) {
    setL1(key, cached);
    debug("get", hashKey(key), "memory-hit", { tags: cached.tags });
    return cached;
  }
  if (!node) return undefined;

  try {
    const raw = await node.fs.readFile(entryPath(key), "utf8");
    const stored = JSON.parse(raw) as Partial<StoredUseCacheEntry>;
    if (
      stored.schema !== 1 ||
      typeof stored.body !== "string" ||
      typeof stored.timestamp !== "number" ||
      typeof stored.expire !== "number" ||
      typeof stored.revalidate !== "number"
    ) {
      return undefined;
    }

    const entry: MemoryUseCacheEntry = {
      schema: 1,
      body: base64ToBytes(stored.body),
      tags: Array.isArray(stored.tags) ? stored.tags : [],
      stale: typeof stored.stale === "number" ? stored.stale : stored.revalidate,
      timestamp: stored.timestamp,
      expire: stored.expire,
      revalidate: stored.revalidate,
    };
    setL1(key, entry);
    debug("get", hashKey(key), "disk-hit", { tags: entry.tags });
    return entry;
  } catch {
    debug("get", hashKey(key), "miss");
    return undefined;
  }
}

async function loadTags(): Promise<void> {
  if (!node) return;

  try {
    const raw = await node.fs.readFile(tagsPath, "utf8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    tagStates.clear();
    for (const [tag, value] of Object.entries(data)) {
      const state = coerceTagState(value);
      if (state) tagStates.set(tag, state);
    }
  } catch {
    // Missing/corrupt tag index means "no tags invalidated yet".
  }
}

async function persistTags(): Promise<void> {
  if (!node) return;

  await writeJsonAtomic(node.fs, tagsPath, Object.fromEntries(tagStates));
}

const handler = {
  async get(cacheKey: string, softTags: string[] = []): Promise<UseCacheEntry | undefined> {
    await init();

    const pending = pendingSets.get(cacheKey);
    if (pending) await pending;

    const entry = await readEntry(cacheKey);
    const result = entry ? toCacheEntry(entry, softTags) : undefined;
    debug("get", hashKey(cacheKey), result ? "return-hit" : "return-miss", {
      tags: entry?.tags,
      softTags,
      revalidate: result?.revalidate,
    });
    return result;
  },

  async set(cacheKey: string, pendingEntry: Promise<UseCacheEntry>): Promise<void> {
    await init();

    const setPromise = (async () => {
      const entry = await pendingEntry;
      const [persistedStream, returnedStream] = entry.value.tee();
      entry.value = returnedStream;
      const body = await streamToBytes(persistedStream);
      const memoryEntry: MemoryUseCacheEntry = {
        schema: 1,
        body,
        tags: mergeTags(entry.tags),
        stale: entry.stale,
        timestamp: entry.timestamp,
        expire: entry.expire,
        revalidate: entry.revalidate,
      };

      setL1(cacheKey, memoryEntry);
      debug("set", hashKey(cacheKey), { tags: memoryEntry.tags });
      if (!node) return;

      const stored: StoredUseCacheEntry = {
        ...memoryEntry,
        body: bytesToBase64(body),
      };
      await writeJsonAtomic(node.fs, entryPath(cacheKey), stored);
    })();

    pendingSets.set(cacheKey, setPromise);
    try {
      await setPromise;
    } finally {
      pendingSets.delete(cacheKey);
    }
  },

  async refreshTags(): Promise<void> {
    await init();
    await loadTags();
  },

  async getExpiration(_tags: string[]): Promise<number> {
    await init();
    return Infinity;
  },

  async updateTags(tags: string[], durations?: { expire?: number }): Promise<void> {
    await init();
    const now = nowMs();
    for (const tag of tags) {
      const state = { ...tagStates.get(tag) };
      if (durations) {
        state.stale = now;
        if (durations.expire !== undefined) {
          state.expired = now + durations.expire * 1000;
        }
      } else {
        state.expired = now;
      }
      tagStates.set(tag, state);
    }
    await persistTags();
  },
};

export default handler;
