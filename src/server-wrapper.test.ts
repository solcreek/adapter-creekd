import { describe, expect, it } from "vitest";

import { createProxyRequestHeaders } from "./server-wrapper.js";

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
});
