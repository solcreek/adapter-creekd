#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  isNextDataRequestPath,
  transformNextDataHtmlResponse,
} from "./next-data-response.js";

function usage(): string {
  return "Usage: node server-wrapper.js <standalone-server.js>";
}

function parsePort(value: string | undefined, name: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`${name} must be an integer in 1..65535`);
  }
  return port;
}

async function allocatePort(host: string): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });

  const address = server.address() as AddressInfo | null;
  const port = address?.port;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });

  if (!port) throw new Error("failed to allocate internal server port");
  return port;
}

function writeProxyError(res: http.ServerResponse, err: unknown): void {
  if (res.headersSent) {
    res.destroy(err instanceof Error ? err : undefined);
    return;
  }

  res.statusCode = 502;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(`adapter-creekd proxy error: ${err instanceof Error ? err.message : String(err)}`);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function createProxyRequestHeaders(
  reqHeaders: http.IncomingHttpHeaders,
  requestUrl: string | undefined,
  innerHost: string,
  innerPort: number,
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = { ...reqHeaders };
  const originalHost = headerValue(reqHeaders.host);

  if (originalHost) {
    headers.host = originalHost;
    headers["x-forwarded-host"] = originalHost;
  } else {
    headers.host = `${innerHost}:${innerPort}`;
  }

  if (headers["x-forwarded-proto"] === undefined) {
    headers["x-forwarded-proto"] = "http";
  }

  if (isNextDataRequestPath(requestUrl)) {
    delete headers["accept-encoding"];
  }

  return headers;
}

function proxyRequest(
  innerHost: string,
  innerPort: number,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const headers = createProxyRequestHeaders(
    req.headers,
    req.url,
    innerHost,
    innerPort,
  );

  const upstream = http.request(
    {
      hostname: innerHost,
      port: innerPort,
      method: req.method,
      path: req.url,
      headers,
    },
    (upstreamRes) => {
      const statusCode = upstreamRes.statusCode ?? 500;

      if (!isNextDataRequestPath(req.url)) {
        res.writeHead(statusCode, upstreamRes.headers);
        upstreamRes.pipe(res);
        return;
      }

      const chunks: Buffer[] = [];
      upstreamRes.on("data", (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      upstreamRes.on("end", () => {
        const body = Buffer.concat(chunks);
        const transformed = transformNextDataHtmlResponse(
          req.url,
          upstreamRes.headers,
          body,
        );

        if (!transformed) {
          res.writeHead(statusCode, upstreamRes.headers);
          res.end(body);
          return;
        }

        res.writeHead(statusCode, transformed.headers);
        res.end(transformed.body);
      });
      upstreamRes.on("error", (err) => writeProxyError(res, err));
    },
  );

  upstream.on("error", (err) => writeProxyError(res, err));
  req.pipe(upstream);
}

async function main(argv: string[]): Promise<void> {
  const serverFile = argv[0] ?? process.env.CREEK_NEXT_SERVER_FILE;
  if (!serverFile) throw new Error(usage());

  const publicPort = parsePort(process.env.PORT, "PORT");
  const publicHost = process.env.HOSTNAME || "127.0.0.1";
  const innerHost = process.env.CREEK_NEXT_INNER_HOST || "127.0.0.1";
  const innerPort = process.env.CREEK_NEXT_INNER_PORT
    ? parsePort(process.env.CREEK_NEXT_INNER_PORT, "CREEK_NEXT_INNER_PORT")
    : await allocatePort(innerHost);

  const absoluteServerFile = path.resolve(serverFile);
  const child = spawn(process.execPath, [absoluteServerFile], {
    cwd: path.dirname(absoluteServerFile),
    env: {
      ...process.env,
      HOSTNAME: innerHost,
      PORT: String(innerPort),
    },
    stdio: "inherit",
  });

  const proxy = http.createServer((req, res) => {
    proxyRequest(innerHost, innerPort, req, res);
  });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    proxy.close();
    stopChild(child, signal);
  };

  child.once("exit", (code, signal) => {
    if (shuttingDown) return;
    proxy.close();
    process.exitCode = code ?? (signal ? 1 : 0);
  });

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(publicPort, publicHost, resolve);
  });

  console.error(
    `[adapter-creekd] proxy listening on ${publicHost}:${publicPort}; standalone server on ${innerHost}:${innerPort}`,
  );
}

function stopChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }, 5000).unref();
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) return false;
  return path.resolve(entrypoint) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
