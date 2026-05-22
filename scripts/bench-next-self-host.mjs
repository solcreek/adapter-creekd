#!/usr/bin/env node
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import http from "node:http";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(ROOT, "fixtures", "next-self-host");
const ITERATIONS = Number.parseInt(process.env.NEXT_BENCH_ITERATIONS ?? "20", 10);
const PORT = Number.parseInt(process.env.NEXT_BENCH_PORT ?? "4317", 10);
const KEEP = process.env.NEXT_BENCH_KEEP === "1";
const VERBOSE = process.env.NEXT_BENCH_VERBOSE === "1";
const BASE_URL = `http://127.0.0.1:${PORT}`;

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

function summarize(name, samples) {
  const totals = samples.map((sample) => sample.totalMs);
  const ttfbs = samples.map((sample) => sample.ttfbMs);
  return {
    name,
    count: samples.length,
    status: [...new Set(samples.map((sample) => sample.status))].join(","),
    ttfbP50: percentile(ttfbs, 50),
    ttfbP95: percentile(ttfbs, 95),
    totalP50: percentile(totals, 50),
    totalP95: percentile(totals, 95),
    bytes: Math.round(samples.reduce((sum, sample) => sum + sample.bytes, 0) / samples.length),
    cache: [...new Set(samples.map((sample) => sample.headers["x-nextjs-cache"]).filter(Boolean))].join(",") || "-",
  };
}

function printSummaries(summaries) {
  const rows = summaries.map((summary) => ({
    name: summary.name,
    count: summary.count,
    status: summary.status,
    "ttfb p50": `${summary.ttfbP50.toFixed(2)}ms`,
    "ttfb p95": `${summary.ttfbP95.toFixed(2)}ms`,
    "total p50": `${summary.totalP50.toFixed(2)}ms`,
    "total p95": `${summary.totalP95.toFixed(2)}ms`,
    bytes: summary.bytes,
    cache: summary.cache,
  }));
  console.table(rows);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(command, args, {
      ...options,
      env: {
        ...process.env,
        NEXT_TELEMETRY_DISABLED: "1",
        ...options.env,
      },
      stdio: VERBOSE ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    if (!VERBOSE) {
      child.stdout?.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk;
      });
    }
    child.on("error", reject);
    child.on("close", (code) => {
      const ms = performance.now() - started;
      if (code === 0) {
        resolve({ ms, stdout, stderr });
      } else {
        const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
        reject(new Error(`${command} ${args.join(" ")} exited ${code}\n${output}`));
      }
    });
  });
}

function request(method, urlPath, options = {}) {
  const body = options.body === undefined ? undefined : Buffer.from(options.body);
  const url = new URL(urlPath, BASE_URL);
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const req = http.request(
      url,
      {
        method,
        headers: {
          ...(body ? { "content-length": String(body.length) } : {}),
          ...options.headers,
        },
      },
      (res) => {
        const ttfbMs = performance.now() - started;
        const chunks = [];
        let bytes = 0;
        res.on("data", (chunk) => {
          bytes += chunk.length;
          chunks.push(chunk);
        });
        res.on("end", () => {
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            bytes,
            headers: res.headers,
            status: res.statusCode ?? 0,
            totalMs: performance.now() - started,
            ttfbMs,
          });
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitForServer() {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await request("GET", "/");
      if (response.status === 200) return;
      lastError = new Error(`unexpected status ${response.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError ?? new Error("server did not start");
}

async function benchRoute(name, urlPath, iterations = ITERATIONS) {
  const samples = [];
  for (let i = 0; i < iterations; i++) {
    const response = await request("GET", urlPath);
    if (response.status < 200 || response.status >= 400) {
      throw new Error(`${name}: expected 2xx/3xx, got ${response.status}`);
    }
    samples.push(response);
  }
  return summarize(name, samples);
}

function extractBenchOrigin(html) {
  const match = html.match(/data-bench-origin="([^"]+)"/);
  return match?.[1] ?? "";
}

async function postRevalidate(payload) {
  const response = await request("POST", "/api/revalidate", {
    body: JSON.stringify(payload),
    headers: {
      "content-type": "application/json",
    },
  });
  if (response.status !== 200) {
    throw new Error(`revalidate failed: ${response.status} ${response.body}`);
  }
  return response;
}

async function waitForChangedTaggedOrigin(previousOrigin) {
  const deadline = Date.now() + 2_000;
  let latest = await request("GET", "/tagged");
  let latestOrigin = extractBenchOrigin(latest.body);

  while (latestOrigin === previousOrigin && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    latest = await request("GET", "/tagged");
    latestOrigin = extractBenchOrigin(latest.body);
  }

  if (latestOrigin === previousOrigin) {
    throw new Error(
      `revalidateTag did not refresh tagged fetch cache within 2s; origin stayed ${previousOrigin}`,
    );
  }

  return { response: latest, origin: latestOrigin };
}

async function findStandaloneServerFile(projectDir) {
  const standaloneDir = path.join(projectDir, ".next", "standalone");
  const standard = path.join(standaloneDir, "server.js");
  try {
    await fs.access(standard);
    return standard;
  } catch {
    // Continue with recursive lookup for monorepo outputFileTracingRoot.
  }

  const matches = [];
  async function visit(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules") continue;
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile() && entry.name === "server.js") {
        matches.push(entryPath);
      }
    }
  }

  await visit(standaloneDir);
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one standalone server.js, found ${matches.length}`,
    );
  }
  return matches[0];
}

function startStandaloneServer(serverFile, cacheDir, appendOutput) {
  const child = spawn(process.execPath, [serverFile], {
    cwd: path.dirname(serverFile),
    env: {
      ...process.env,
      BENCH_BASE_URL: BASE_URL,
      CREEK_NEXT_CACHE_DIR: cacheDir,
      CREEK_NEXT_CACHE_L1_ENTRIES: process.env.CREEK_NEXT_CACHE_L1_ENTRIES ?? "2048",
      HOSTNAME: "127.0.0.1",
      NODE_ENV: "production",
      PORT: String(PORT),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    appendOutput(chunk);
    if (VERBOSE) process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    appendOutput(chunk);
    if (VERBOSE) process.stderr.write(chunk);
  });
  child.on("exit", (code, signal) => {
    if (code !== null && code !== 0) {
      appendOutput(`\nserver exited with code ${code}`);
    } else if (signal && signal !== "SIGTERM") {
      appendOutput(`\nserver exited with signal ${signal}`);
    }
  });
  return child;
}

function stopServer(server) {
  if (!server || server.killed) return Promise.resolve();

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      server.kill("SIGKILL");
      resolve();
    }, 3_000);
    server.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    server.kill("SIGTERM");
  });
}

async function prepareProject() {
  const benchRoot = path.join(ROOT, ".bench");
  await fs.mkdir(benchRoot, { recursive: true });
  const projectDir = await fs.mkdtemp(path.join(benchRoot, "next-self-host-"));
  await fs.cp(FIXTURE, projectDir, { recursive: true });
  return projectDir;
}

async function main() {
  if (!Number.isInteger(ITERATIONS) || ITERATIONS <= 0) {
    throw new Error(`NEXT_BENCH_ITERATIONS must be a positive integer, got ${ITERATIONS}`);
  }

  const projectDir = await prepareProject();
  let server;
  let serverOutput = "";
  try {
    console.log(`next self-host benchmark: iterations=${ITERATIONS} port=${PORT}`);
    console.log(`fixture: ${path.relative(ROOT, FIXTURE)}`);
    console.log(`workspace: ${projectDir}`);

    const build = await run(
      process.execPath,
      [path.join(ROOT, "node_modules", "next", "dist", "bin", "next"), "build"],
      {
        cwd: projectDir,
        env: {
          ADAPTER_CREEKD_ROOT: ROOT,
          BENCH_DEPLOYMENT_ID: `bench-${Date.now()}`,
        },
      },
    );
    console.log(`next build: ${build.ms.toFixed(0)}ms`);

    const postbuild = await run(process.execPath, [path.join(ROOT, "dist", "cli.js"), "postbuild", "--project-dir", projectDir]);
    console.log(`postbuild: ${postbuild.ms.toFixed(0)}ms`);

    const cacheDir = path.join(projectDir, ".cache", "creekd-next");
    const serverFile = await findStandaloneServerFile(projectDir);
    server = startStandaloneServer(serverFile, cacheDir, (chunk) => {
      serverOutput += chunk;
    });

    await waitForServer();

    const summaries = [];
    summaries.push(await benchRoute("home-hot", "/"));
    summaries.push(await benchRoute("isr-hot", "/isr"));
    await new Promise((resolve) => setTimeout(resolve, 1200));
    summaries.push(summarize("isr-after-ttl", [await request("GET", "/isr")]));
    await new Promise((resolve) => setTimeout(resolve, 250));
    summaries.push(summarize("isr-refreshed", [await request("GET", "/isr")]));

    const taggedBefore = await request("GET", "/tagged");
    const taggedBeforeOrigin = extractBenchOrigin(taggedBefore.body);
    summaries.push(await benchRoute("tagged-fetch-hot", "/tagged"));
    await postRevalidate({ tag: "bench-products" });
    const taggedAfter = await request("GET", "/tagged");
    const taggedAfterOrigin = extractBenchOrigin(taggedAfter.body);
    summaries.push(summarize("tagged-after-revalidate", [taggedAfter]));
    const taggedRefreshed = await waitForChangedTaggedOrigin(taggedBeforeOrigin);
    summaries.push(summarize("tagged-refreshed", [taggedRefreshed.response]));

    const imageUrl = "/_next/image?url=%2Fapi%2Fraw-image&w=64&q=75";
    summaries.push(summarize("image-first", [await request("GET", imageUrl)]));
    summaries.push(await benchRoute("image-hot", imageUrl));
    summaries.push(await benchRoute("streaming", "/streaming", Math.max(3, Math.min(ITERATIONS, 10))));

    await stopServer(server);
    server = undefined;
    server = startStandaloneServer(serverFile, cacheDir, (chunk) => {
      serverOutput += chunk;
    });
    await waitForServer();

    summaries.push(summarize("home-after-restart", [await request("GET", "/")]));
    summaries.push(summarize("isr-after-restart", [await request("GET", "/isr")]));
    const taggedRestart = await request("GET", "/tagged");
    const taggedRestartOrigin = extractBenchOrigin(taggedRestart.body);
    if (taggedRestartOrigin !== taggedRefreshed.origin) {
      throw new Error(
        `tagged fetch cache did not survive restart; got ${taggedRestartOrigin || "-"}, expected ${taggedRefreshed.origin || "-"}`,
      );
    }
    summaries.push(summarize("tagged-after-restart", [taggedRestart]));
    summaries.push(summarize("image-after-restart", [await request("GET", imageUrl)]));

    printSummaries(summaries);
    console.log(
      `tag revalidate origin: ${taggedBeforeOrigin || "-"} -> ${taggedAfterOrigin || "-"} -> ${taggedRefreshed.origin || "-"} (refreshed)`,
    );
  } catch (err) {
    if (serverOutput.trim()) {
      console.error("\nserver output:");
      console.error(serverOutput.trim());
    }
    throw err;
  } finally {
    await stopServer(server);
    if (!KEEP) {
      await fs.rm(projectDir, { recursive: true, force: true });
    } else {
      console.log(`kept workspace: ${projectDir}`);
    }
  }
}

await main();
