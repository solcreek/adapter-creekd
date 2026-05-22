import { afterEach, describe, expect, it } from "vitest";

import {
  createProxyRequestHeaders,
  createProxyResponseHeaders,
  shouldTranslateDevtools431,
} from "./server-wrapper.js";

const originalNextTestMode = process.env.NEXT_TEST_MODE;
const originalVercel = process.env.VERCEL;

afterEach(() => {
  if (originalNextTestMode === undefined) {
    delete process.env.NEXT_TEST_MODE;
  } else {
    process.env.NEXT_TEST_MODE = originalNextTestMode;
  }

  if (originalVercel === undefined) {
    delete process.env.VERCEL;
  } else {
    process.env.VERCEL = originalVercel;
  }
});

describe("server wrapper proxy headers", () => {
  it("preserves the public host for server action origin checks", () => {
    const headers = createProxyRequestHeaders(
      {
        host: "127.0.0.1:12157",
        origin: "http://127.0.0.1:12157",
      },
      "/server",
      "127.0.0.1",
      56215,
    );

    expect(headers.host).toBe("127.0.0.1:12157");
    expect(headers["x-forwarded-host"]).toBe("127.0.0.1:12157");
    expect(headers["x-forwarded-proto"]).toBe("http");
  });

  it("removes compression only for data requests that may need HTML conversion", () => {
    expect(createProxyRequestHeaders(
      {
        host: "example.test",
        "accept-encoding": "gzip, br",
      },
      "/_next/data/build-id/ssr-page.json",
      "127.0.0.1",
      3001,
    )["accept-encoding"]).toBeUndefined();

    expect(createProxyRequestHeaders(
      {
        host: "example.test",
        "accept-encoding": "gzip, br",
      },
      "/server",
      "127.0.0.1",
      3001,
    )["accept-encoding"]).toBe("gzip, br");
  });

  it("normalizes deploy cache headers for prerendered html", () => {
    process.env.NEXT_TEST_MODE = "deploy";

    const headers = createProxyResponseHeaders(
      "/revalidate",
      200,
      {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "s-maxage=2, stale-while-revalidate=31535998",
        "x-nextjs-cache": "HIT",
        "x-next-cache-tags": "_N_T_/revalidate",
      },
    );

    expect(headers["cache-control"]).toBe("public, max-age=0, must-revalidate");
    expect(headers["x-next-cache-tags"]).toBeUndefined();
  });

  it("normalizes deploy cache headers for prerendered data responses", () => {
    process.env.NEXT_TEST_MODE = "deploy";

    const headers = createProxyResponseHeaders(
      "/_next/data/build-id/revalidate.json",
      200,
      {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "s-maxage=2, stale-while-revalidate=31535998",
        "x-nextjs-cache": "MISS",
        "x-next-cache-tags": "_N_T_/revalidate",
      },
    );

    expect(headers["cache-control"]).toBe("public, max-age=0, must-revalidate");
    expect(headers["x-next-cache-tags"]).toBe("_N_T_/revalidate");
  });

  it("leaves private dynamic responses unchanged in deploy mode", () => {
    process.env.NEXT_TEST_MODE = "deploy";

    const headers = createProxyResponseHeaders(
      "/gssp",
      200,
      {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "private, no-cache, no-store, max-age=0, must-revalidate",
      },
    );

    expect(headers["cache-control"]).toBe(
      "private, no-cache, no-store, max-age=0, must-revalidate",
    );
  });

  it("only converts Chrome DevTools workspace 431 responses to 404", () => {
    expect(shouldTranslateDevtools431(
      "/.well-known/appspecific/com.chrome.devtools.json",
      431,
    )).toBe(true);
    expect(shouldTranslateDevtools431(
      "/en-EN/.well-known/appspecific/com.chrome.devtools.json",
      431,
    )).toBe(false);
    expect(shouldTranslateDevtools431(
      "/.well-known/appspecific/com.chrome.devtools.json",
      404,
    )).toBe(false);
  });
});
