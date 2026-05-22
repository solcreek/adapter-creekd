import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import type { CreekdManifest } from "./manifest.js";
import { normalizeEnv, writeManifest } from "./manifest.js";

describe("writeManifest", () => {
  let outputDir: string;
  beforeEach(() => {
    outputDir = mkdtempSync(path.join(tmpdir(), "adapter-creekd-manifest-"));
  });
  afterEach(() => {
    rmSync(outputDir, { recursive: true, force: true });
  });

  function readJson(): CreekdManifest {
    const raw = readFileSync(path.join(outputDir, "manifest.json"), "utf-8");
    return JSON.parse(raw) as CreekdManifest;
  }

  it("writes a v1 manifest with all required fields", async () => {
    await writeManifest({
      outputDir,
      buildId: "abc123",
      nextVersion: "16.2.3",
      runtime: "bun",
      entrypoint: ".next/standalone/server.js",
      port: 3000,
      env: ["NODE_ENV=production"],
      healthCheckPath: "/healthz",
      serveDirs: [".next/standalone", ".next/static", "public"],
      hasMiddleware: false,
      hasPrerender: true,
    });

    const manifest = readJson();
    expect(manifest.version).toBe(1);
    expect(manifest.framework).toBe("nextjs");
    expect(manifest.target).toBe("creekd");
    expect(manifest.buildId).toBe("abc123");
    expect(manifest.nextVersion).toBe("16.2.3");
    expect(manifest.adapter).toEqual({
      name: "@solcreek/adapter-creekd",
      version: "0.1.1",
    });
    expect(manifest.runtime).toBe("bun");
    expect(manifest.entrypoint).toBe(".next/standalone/server.js");
    expect(manifest.port).toBe(3000);
    expect(manifest.env).toEqual(["NODE_ENV=production"]);
    expect(manifest.health_check_path).toBe("/healthz");
    expect(manifest.serveDirs).toEqual([
      ".next/standalone",
      ".next/static",
      "public",
    ]);
    expect(manifest.hasMiddleware).toBe(false);
    expect(manifest.hasPrerender).toBe(true);
  });

  it("preserves runtime: node when chosen", async () => {
    await writeManifest({
      outputDir,
      buildId: "id",
      nextVersion: "16.2.3",
      runtime: "node",
      entrypoint: ".next/standalone/server.js",
      port: 3000,
      env: ["NODE_ENV=production"],
      serveDirs: [".next/standalone"],
      hasMiddleware: false,
      hasPrerender: false,
    });
    expect(readJson().runtime).toBe("node");
  });

  it("creates outputDir if missing", async () => {
    const nested = path.join(outputDir, "deeper", "still-deeper");
    await writeManifest({
      outputDir: nested,
      buildId: "id",
      nextVersion: "16.2.3",
      runtime: "bun",
      entrypoint: ".next/standalone/server.js",
      port: 3000,
      env: ["NODE_ENV=production"],
      serveDirs: [],
      hasMiddleware: false,
      hasPrerender: false,
    });
    // No throw — manifest landed at the deeper path.
    const raw = readFileSync(path.join(nested, "manifest.json"), "utf-8");
    expect(JSON.parse(raw).version).toBe(1);
  });

  it("emits trailing newline (POSIX text file convention)", async () => {
    await writeManifest({
      outputDir,
      buildId: "id",
      nextVersion: "16.2.3",
      runtime: "bun",
      entrypoint: "x",
      port: 3000,
      env: ["NODE_ENV=production"],
      serveDirs: [],
      hasMiddleware: false,
      hasPrerender: false,
    });
    const raw = readFileSync(path.join(outputDir, "manifest.json"), "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("rejects invalid creekd process fields before writing", async () => {
    await expect(
      writeManifest({
        outputDir,
        buildId: "id",
        nextVersion: "16.2.3",
        runtime: "bun",
        entrypoint: "",
        port: 3000,
        env: ["NODE_ENV=production"],
        serveDirs: [],
        hasMiddleware: false,
        hasPrerender: false,
      }),
    ).rejects.toThrow("invalid creekd manifest");
  });
});

describe("normalizeEnv", () => {
  it("defaults NODE_ENV to production", () => {
    expect(normalizeEnv(undefined)).toEqual(["NODE_ENV=production"]);
  });

  it("allows user env to override defaults", () => {
    expect(normalizeEnv(["NODE_ENV=test", "FEATURE=1"])).toEqual([
      "NODE_ENV=test",
      "FEATURE=1",
    ]);
  });

  it("accepts object env values", () => {
    expect(normalizeEnv({ FEATURE: true, COUNT: 3 })).toEqual([
      "NODE_ENV=production",
      "FEATURE=true",
      "COUNT=3",
    ]);
  });

  it("rejects malformed KEY=VALUE entries", () => {
    expect(() => normalizeEnv(["MISSING_EQUALS"])).toThrow("KEY=VALUE");
  });
});
