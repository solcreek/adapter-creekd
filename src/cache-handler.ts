// Re-export the shared in-memory Next.js ISR cache handler from
// @solcreek/adapter-core. Mirror of adapter-creek's setup — both
// adapters route to the same tested implementation, and both
// preserve the subpath so users can wire either path in next.config:
//
//   cacheHandler: require.resolve("@solcreek/adapter-creekd/cache-handler")
//
// New deployments should point at @solcreek/adapter-core/cache-handler
// directly; this file exists for parity / discoverability.

export { default } from "@solcreek/adapter-core/cache-handler";
