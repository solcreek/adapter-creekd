# Changelog

All notable changes to `@solcreek/adapter-creekd` are documented here.

The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-05-19

### Fixed

- `onBuildComplete` no longer assumes `.next/standalone/` exists. Next.js
  fires the adapter hook **before** standalone codegen runs, so the
  previous existence check rejected every real build and the in-hook
  asset copy targeted a non-existent directory. The hook now writes the
  manifest declaratively; users (or their tooling) arrange
  `.next/static` and `public/` inside the standalone tree via a
  `postbuild` script — same contract Next.js's self-host docs use.

### Changed

- Bumped `@solcreek/adapter-core` dependency to `^0.1.1` to pick up the
  pnpm-safe cache-handler resolution (uses `createRequire(projectDir)`
  instead of a hardcoded `node_modules/...` path).
- README now documents the required `postbuild` step.

## [0.1.0] - 2026-05-18

### Added

- Initial release. Next.js `NextAdapter` targeting `creekd` self-host
  via the Bun (default) or Node runtime. Wires `output: 'standalone'`,
  the in-memory ISR cache handler from `@solcreek/adapter-core`, and
  writes `.creek-creekd/manifest.json` for `creekctl up --from`.

[0.1.1]: https://github.com/solcreek/adapter-creekd/releases/tag/v0.1.1
[0.1.0]: https://github.com/solcreek/adapter-creekd/releases/tag/v0.1.0
