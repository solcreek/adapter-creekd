// Package entry. The NextAdapter implementation arrives in the next
// commit; for now the manifest schema is the only public surface.

export type { CreekdManifest, WriteManifestOptions } from "./manifest.js";
export { writeManifest } from "./manifest.js";
