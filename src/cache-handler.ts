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

interface RouteMetadata {
  headers?: Record<string, string | string[] | undefined>;
  status?: number;
  postponed?: string;
  segmentPaths?: string[];
}

interface GetCacheContext {
  kind?: string;
  isFallback?: boolean;
  isRoutePPREnabled?: boolean;
}

const DEFAULT_L1_ENTRIES = 2048;
const NEXT_CACHE_TAGS_HEADER = "x-next-cache-tags";
const NEXT_DATA_SUFFIX = ".json";
const NEXT_META_SUFFIX = ".meta";
const RSC_SUFFIX = ".rsc";
const RSC_SEGMENT_SUFFIX = ".segment.rsc";
const RSC_SEGMENTS_DIR_SUFFIX = ".segments";
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

function nowMs(): number {
  const perf = (globalThis as {
    performance?: { now?: () => number; timeOrigin?: number };
  }).performance;
  if (perf?.now && typeof perf.timeOrigin === "number") {
    return perf.timeOrigin + perf.now();
  }
  return Date.now();
}

function nextClock(): number {
  const now = nowMs();
  const clock = now > lastClock ? now : lastClock + 1;
  lastClock = clock;
  return clock;
}

function env(name: string): string | undefined {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.[name];
}

function debug(...args: unknown[]): void {
  if (!env("NEXT_PRIVATE_DEBUG_CACHE") && !env("CREEK_DEBUG_CACHE")) return;
  console.debug("[adapter-creekd cache]", ...args);
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
  const now = nowMs();
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

function tagsFromMeta(meta: RouteMetadata | undefined): string[] {
  const headers = meta?.headers;
  if (!headers) return [];

  const tagsHeader = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === NEXT_CACHE_TAGS_HEADER,
  )?.[1];
  if (typeof tagsHeader === "string") {
    return tagsHeader.split(",").filter(Boolean);
  }
  if (Array.isArray(tagsHeader)) {
    return tagsHeader.flatMap((item) => item.split(",")).filter(Boolean);
  }
  return [];
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
  private serverDistDir = "";
  private nextTagsManifest: Map<string, TagState> | undefined;

  constructor(ctx?: CacheHandlerContext) {
    this.l1MaxEntries = maxL1Entries(ctx);
    this.ready = this.init(ctx);
  }

  async get(key: string, ctx?: GetCacheContext) {
    await this.ready;
    const entry = await this.readEntry(key, ctx);
    if (!entry) {
      debug("get", key, "miss", ctx);
      return null;
    }

    const age = (nowMs() - entry.lastModified) / 1000;
    const staleByTag = this.isStaleByTags(entry);
    const staleByTime =
      entry.revalidate !== undefined &&
      entry.revalidate !== false &&
      (entry.revalidate === 0 || age > entry.revalidate);

    const result = {
      value: entry.value,
      lastModified: entry.lastModified,
      age: Math.floor(age),
      cacheState: staleByTag || staleByTime ? "stale" as const : "fresh" as const,
    };
    debug("get", key, result.cacheState, {
      kind: ctx?.kind,
      isFallback: ctx?.isFallback,
      isRoutePPREnabled: ctx?.isRoutePPREnabled,
      valueKind: (entry.value as { kind?: unknown } | undefined)?.kind,
      hasPostponed: Boolean((entry.value as { postponed?: unknown } | undefined)?.postponed),
      segmentCount: (entry.value as { segmentData?: Map<unknown, unknown> } | undefined)
        ?.segmentData?.size,
      tags: entry.tags,
      revalidate: entry.revalidate,
    });
    return result;
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
      lastModified: nowMs(),
      clock: nextClock(),
      tags: ctx?.tags ?? [],
      revalidate: typeof ctx?.revalidate === "number" ? ctx.revalidate : undefined,
    };

    this.setL1(key, entry);
    debug("set", key, {
      valueKind: (data as { kind?: unknown } | undefined)?.kind,
      hasPostponed: Boolean((data as { postponed?: unknown } | undefined)?.postponed),
      segmentCount: (data as { segmentData?: Map<unknown, unknown> } | undefined)
        ?.segmentData?.size,
      tags: entry.tags,
      revalidate: entry.revalidate,
    });
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
    this.serverDistDir = ctx?.serverDistDir
      ? this.node.path.resolve(ctx.serverDistDir)
      : "";

    await this.node.fs.mkdir(this.entriesDir, { recursive: true });
    await this.loadTags();
  }

  private entryPath(key: string): string {
    if (!this.node) {
      throw new Error("adapter-creekd cache filesystem is unavailable");
    }
    return this.node.path.join(this.entriesDir, `${hashKey(key)}.json`);
  }

  private async readEntry(
    key: string,
    ctx?: GetCacheContext,
  ): Promise<CacheEntry | null> {
    const cached = this.l1.get(key);
    if (cached) {
      this.setL1(key, cached);
      debug("read", key, "memory-hit");
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
      debug("read", key, "disk-hit");
      return entry;
    } catch {
      return await this.readBuildSeedEntry(key, ctx);
    }
  }

  private async readBuildSeedEntry(
    key: string,
    ctx?: GetCacheContext,
  ): Promise<CacheEntry | null> {
    if (!this.node || !this.serverDistDir || !ctx?.kind) return null;

    let entry: CacheEntry | null = null;
    if (ctx.kind === "APP_PAGE") {
      entry = await this.readAppPageSeed(key, ctx);
    } else if (ctx.kind === "APP_ROUTE") {
      entry = await this.readAppRouteSeed(key);
    } else if (ctx.kind === "PAGES") {
      entry = await this.readPagesSeed(key, ctx);
    }

    if (entry) {
      this.setL1(key, entry);
      debug("read", key, "seed-hit", {
        kind: ctx.kind,
        valueKind: (entry.value as { kind?: unknown } | undefined)?.kind,
        hasPostponed: Boolean((entry.value as { postponed?: unknown } | undefined)?.postponed),
        segmentCount: (entry.value as { segmentData?: Map<unknown, unknown> } | undefined)
          ?.segmentData?.size,
        tags: entry.tags,
      });
    } else {
      debug("read", key, "seed-miss", ctx);
    }
    return entry;
  }

  private async readAppRouteSeed(key: string): Promise<CacheEntry | null> {
    if (!this.node) return null;

    try {
      const bodyPath = this.appPath(`${key}.body`);
      const [body, stat, meta] = await Promise.all([
        this.node.fs.readFile(bodyPath),
        this.node.fs.stat(bodyPath),
        this.readRouteMeta(bodyPath.replace(/\.body$/, NEXT_META_SUFFIX)),
      ]);
      const lastModified = stat.mtime.getTime();
      const entry = {
        value: {
          kind: "APP_ROUTE",
          body,
          headers: meta?.headers,
          status: meta?.status,
        },
        lastModified,
        clock: lastModified,
        tags: tagsFromMeta(meta),
      };
      rememberClock(entry.clock);
      return entry;
    } catch {
      return null;
    }
  }

  private async readAppPageSeed(
    key: string,
    ctx: GetCacheContext,
  ): Promise<CacheEntry | null> {
    if (!this.node) return null;

    try {
      const htmlPath = this.appPath(`${key}.html`);
      const [html, stat, meta] = await Promise.all([
        this.node.fs.readFile(htmlPath, "utf8"),
        this.node.fs.stat(htmlPath),
        this.readRouteMeta(htmlPath.replace(/\.html$/, NEXT_META_SUFFIX)),
      ]);
      const lastModified = stat.mtime.getTime();
      const segmentData = await this.readSegmentData(key, meta);
      let rscData: unknown;
      if (!ctx.isFallback) {
        try {
          rscData = await this.node.fs.readFile(this.appPath(`${key}${RSC_SUFFIX}`));
        } catch {
          rscData = undefined;
        }

        if (!rscData && ctx.isRoutePPREnabled && meta?.postponed != null) {
          try {
            rscData = await this.node.fs.readFile(
              this.appPath(
                `${key}${RSC_SEGMENTS_DIR_SUFFIX}/_full${RSC_SEGMENT_SUFFIX}`,
              ),
            );
          } catch {
            rscData = undefined;
          }
        }
      }

      const entry = {
        value: {
          kind: "APP_PAGE",
          html,
          rscData,
          postponed: meta?.postponed,
          headers: meta?.headers,
          status: meta?.status,
          segmentData,
        },
        lastModified,
        clock: lastModified,
        tags: tagsFromMeta(meta),
      };
      rememberClock(entry.clock);
      return entry;
    } catch {
      return null;
    }
  }

  private async readPagesSeed(
    key: string,
    ctx: GetCacheContext,
  ): Promise<CacheEntry | null> {
    if (!this.node) return null;

    try {
      const htmlPath = this.pagesPath(`${key}.html`);
      const [html, stat, meta] = await Promise.all([
        this.node.fs.readFile(htmlPath, "utf8"),
        this.node.fs.stat(htmlPath),
        this.readRouteMeta(htmlPath.replace(/\.html$/, NEXT_META_SUFFIX)),
      ]);
      let pageData: unknown = {};
      if (!ctx.isFallback) {
        pageData = JSON.parse(
          await this.node.fs.readFile(
            this.pagesPath(`${key}${NEXT_DATA_SUFFIX}`),
            "utf8",
          ),
        );
      }

      const entry = {
        value: {
          kind: "PAGES",
          html,
          pageData,
          headers: meta?.headers,
          status: meta?.status,
        },
        lastModified: stat.mtime.getTime(),
        clock: stat.mtime.getTime(),
        tags: tagsFromMeta(meta),
      };
      rememberClock(entry.clock);
      return entry;
    } catch {
      return null;
    }
  }

  private async readSegmentData(
    key: string,
    meta: RouteMetadata | undefined,
  ): Promise<Map<string, Buffer> | undefined> {
    if (!this.node || !meta?.segmentPaths) return undefined;

    const segmentData = new Map<string, Buffer>();
    const segmentsDir = key + RSC_SEGMENTS_DIR_SUFFIX;
    await Promise.all(
      meta.segmentPaths.map(async (segmentPath) => {
        try {
          segmentData.set(
            segmentPath,
            await this.node!.fs.readFile(
              this.appPath(`${segmentsDir}${segmentPath}${RSC_SEGMENT_SUFFIX}`),
            ),
          );
        } catch {
          // Missing segments are treated the same way Next does: dynamic.
        }
      }),
    );
    return segmentData;
  }

  private async readRouteMeta(metaPath: string): Promise<RouteMetadata | undefined> {
    if (!this.node) return undefined;

    try {
      return JSON.parse(
        await this.node.fs.readFile(metaPath, "utf8"),
      ) as RouteMetadata;
    } catch {
      return undefined;
    }
  }

  private appPath(pathname: string): string {
    if (!this.node) {
      throw new Error("adapter-creekd cache filesystem is unavailable");
    }
    return this.node.path.join(this.serverDistDir, "app", pathname);
  }

  private pagesPath(pathname: string): string {
    if (!this.node) {
      throw new Error("adapter-creekd cache filesystem is unavailable");
    }
    return this.node.path.join(this.serverDistDir, "pages", pathname);
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
