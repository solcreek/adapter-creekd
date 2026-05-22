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
    "postbuild": "cp -r public .next/standalone/ 2>/dev/null; cp -r .next/static .next/standalone/.next/"
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
