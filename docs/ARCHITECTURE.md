# adapter-creekd Architecture

`@solcreek/adapter-creekd` is the opinionated Next.js layer on top of
creekd's neutral process supervisor.

The boundary is intentional:

- `creekd` supervises processes, ports, logs, health checks, cgroups,
  namespaces, volumes, and dispatch. It should not know about Next.js.
- `adapter-creekd` knows about Next.js standalone output, manifests,
  cache handlers, static assets, ISR, and framework-specific defaults.
- `@solcreek/adapter-core` owns only target-agnostic shared contracts and
  helpers, such as the creekd process manifest type.

## Current Shape

During `next build`, the adapter:

1. Applies shared Next.js config mutations from `adapter-core`.
2. Forces `output: "standalone"` so Next.js emits a self-hostable server.
3. Writes `.creek-creekd/manifest.json` with creekd process fields:
   `target`, `runtime`, `entrypoint`, `port`, `env`, and optional
   `health_check_path`.

`creekctl up|ensure|deploy --from .creek-creekd/manifest.json` resolves
the relative entrypoint to the project root and spawns the process.

## Performance Direction

The long-term goal is not just "run Next.js on a VPS." The goal is the
highest-performance, lowest-cost, most complete single-node Next.js
self-host target.

That means adapter-creekd should grow target-specific opinions that
adapter-core and creekd should not carry:

1. Persistent Next cache handler
   - L1: Next.js in-process memory cache for hot entries.
   - L2: local persistent cache for ISR, fetch cache, and `'use cache'`
     data.
   - Tag invalidation must be indexed and durable.
   - Restart should not erase warm ISR/fetch cache state.

2. SQLite or filesystem-backed storage
   - Bun can use native `bun:sqlite`.
   - Node support should use the best available local primitive without
     forcing app authors to run Redis/Postgres just to self-host Next.js.
   - The storage location should be controlled by env, for example
     `CREEK_NEXT_CACHE_DIR`, with a sensible default inside the project
     or a creekd volume mount.

3. Build-time cache seeding
   - Static prerenders, PPR shells, and cache metadata should be seeded
     into the persistent cache when practical.
   - This mirrors the adapter-creek Cloudflare path, but maps to local
     disk/SQLite instead of KV/R2/Durable Objects.

4. Static asset offload
   - The manifest already declares `serveDirs`.
   - Today creekctl ignores this metadata and the Next standalone server
     serves assets.
   - Future creekd or Creek control-plane layers can use the same
     metadata to wire direct static serving without making creekd
     Next-aware.

5. Opinionated process defaults
   - Emit `NODE_ENV=production` by default.
   - Allow strict `healthCheckPath` when apps expose one.
   - Keep Bun as the default runtime while supporting Node for maximum
     compatibility.

## Non-Goals

- Do not put Next.js logic in creekd.
- Do not require Cloudflare primitives.
- Do not require external services for the default single-node path.
- Do not make adapter-core own target-specific cache/storage policy.

## Near-Term Implementation Order

1. Align manifest generation with `adapter-core`'s `CreekdDeployManifest`.
2. Add a creekd-specific persistent cache handler.
3. Add opt-in cache directory configuration and document volume usage.
4. Seed build-time prerender/cache entries into the persistent cache.
5. Add end-to-end tests against creekctl + creekd once the cache handler
   contract is stable.

## Benchmarking

Cache performance has to be measured at two levels:

1. Microbenchmarks for cache handler operations: `set`, hot `get`,
   tag invalidation, stale reads, cold reads after process restart.
2. Real Next.js workloads: ISR page hit/miss, App Router fetch cache,
   PPR shell response, `revalidateTag`, and process restart warm-up.

Run the current microbenchmark harness with:

```bash
pnpm bench:cache
```

The harness builds the package, then compares the adapter-core in-memory
baseline with adapter-creekd's production L1 memory + filesystem L2 cache
handler.
