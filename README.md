# @solcreek/adapter-creekd

[![checks](https://github.com/solcreek/adapter-creekd/actions/workflows/checks.yml/badge.svg)](https://github.com/solcreek/adapter-creekd/actions/workflows/checks.yml)
[![npm](https://img.shields.io/npm/v/@solcreek/adapter-creekd)](https://www.npmjs.com/package/@solcreek/adapter-creekd)

Next.js deployment adapter for self-hosted [creekd](https://github.com/solcreek/creekd) — runs your Next.js app as a `creekd`-supervised Linux process with Bun (default) or Node runtime. Sibling to [`@solcreek/adapter-creek`](https://github.com/solcreek/adapter-creek), which targets Cloudflare Workers; both share core utilities via [`@solcreek/adapter-core`](https://github.com/solcreek/adapter-core).

```
Next.js app
  │ next build (with this adapter)
  │
  ▼
.next/standalone/  ←─ Vercel's standard self-host output, augmented
.creek-creekd/manifest.json ←─ creekctl reads this to spawn the process
  │
  │ creekctl up myapp --from .creek-creekd/manifest.json
  ▼
creekd-supervised Bun / Node process, listening on the chosen port,
routed through creekd's dispatch listener.
```

## Status

**Pre-release.** Requires Next.js 16.2+ (uses Next.js's official `NextAdapter` extension point).

## Quickstart

```bash
# In your Next.js app
pnpm add -D @solcreek/adapter-creekd
```

Set the adapter path in `next.config.ts`:

```ts
import type { NextConfig } from "next";

const config: NextConfig = {
  adapterPath: require.resolve("@solcreek/adapter-creekd"),
};

export default config;
```

Add a `postbuild` script so Next.js's standalone tree gets its static and public assets (this matches Next.js's own self-host guidance — the standalone output deliberately omits them):

```json
{
  "scripts": {
    "build": "next build",
    "postbuild": "adapter-creekd postbuild"
  }
}
```

Then build:

```bash
pnpm build
```

This emits a standard Next.js standalone output at `.next/standalone/` plus a `.creek-creekd/manifest.json` describing how to spawn it. Deploy via creekctl:

```bash
creekctl up my-app --from .creek-creekd/manifest.json
```

## Configuration

The adapter accepts an options object via `createCreekdAdapter`:

```ts
import { createCreekdAdapter } from "@solcreek/adapter-creekd";

const config: NextConfig = {
  adapterPath: require.resolve("@solcreek/adapter-creekd"),
  // Or for explicit options, write a thin wrapper module exporting this:
  // export default createCreekdAdapter({ runtime: "node", port: 3000 });
};
```

| Option | Type | Default | Purpose |
|---|---|---|---|
| `runtime` | `"bun" \| "node"` | `"bun"` | Which runtime `creekd` should spawn the standalone server under |
| `port` | `number` | `3000` | Port the standalone server binds to inside creekd's dispatch namespace |
| `env` | `string[] \| Record<string, string \| number \| boolean>` | `{ NODE_ENV: "production" }` | Environment variables written to `.creek-creekd/manifest.json`; user values override defaults |
| `healthCheckPath` | `string` | creekd default `/` | Optional per-app health probe path for strict readiness |

`creekd` itself supports Bun, Node, and Deno as generic process runtimes. This Next.js adapter currently exposes Bun and Node because Next.js standalone output is a Node-compatible server bundle.

## Cache

Production builds use adapter-creekd's Next.js cache handler:

- L1: process-local memory for hot entries.
- L2: filesystem persistence for ISR, fetch cache, App Router page cache, and
  optimized image cache.
- Tag invalidation state is persisted and mirrored into Next.js's runtime tag
  manifest, so `revalidateTag()` works for App Router fetch/page cache and
  survives process restart.
- Next's built-in memory cache is disabled (`cacheMaxMemorySize: 0`) so invalidation and persistence are owned by the creekd handler.
- Optimized `next/image` entries opt into the same handler via `images.customCacheHandler`.

By default, the cache lives under Next's server dist tree at `.next/cache/creekd`.
Set `CREEK_NEXT_CACHE_DIR=/path/to/cache` to place it on a creekd volume or another
durable local disk path. Set `CREEK_NEXT_CACHE_L1_ENTRIES=0` to disable the L1
memory layer, or set it to a positive integer to cap hot entries.

## Benchmarks

Run the low-level handler benchmark:

```bash
pnpm bench:cache
```

This compares three cache paths: adapter-core's in-memory baseline,
adapter-creekd's production L1+filesystem-L2 handler, and adapter-creekd's
filesystem-L2-only mode (`CREEK_NEXT_CACHE_L1_ENTRIES=0`).

Run the self-host Next.js fixture benchmark:

```bash
pnpm bench:next
```

`bench:next` builds a real Next.js app with this adapter, runs the postbuild
asset copy, starts the standalone server, and measures home route hits, ISR,
tagged fetch cache with `revalidateTag()`, optimized image cache, streaming
TTFB/total latency, and cache warmth after a server restart. Useful knobs:

```bash
NEXT_BENCH_ITERATIONS=50 pnpm bench:next
NEXT_BENCH_KEEP=1 NEXT_BENCH_VERBOSE=1 pnpm bench:next
```

## How it compares

- **vs Vercel Functions**: zero cold start (process always warm), Bun runtime is faster than the Node.js Functions runtime, you own the hardware and the pricing curve.
- **vs `@solcreek/adapter-creek`** (CF Workers, sibling): no global edge POPs, but no Worker CPU limits, no Worker bundle size limits, native `fs`, long-running tasks fine.
- **vs `docker run` self-host (Coolify / Dokploy / etc.)**: ~5-10× per-app density (process-per-app vs container-per-app), no Docker daemon, blue-green deploy built in.

See the comparison docs in [creekd's `examples/`](https://github.com/solcreek/creekd/tree/main/examples) for measured numbers.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the adapter/creekd
boundary and the roadmap for persistent Next.js cache support.

## License

Apache 2.0. See [LICENSE](LICENSE).
