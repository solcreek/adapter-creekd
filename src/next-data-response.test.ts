import { describe, expect, it } from "vitest";

import {
  extractNextDataPageData,
  isNextDataRequestPath,
  matchedPathFromRewriteHeaders,
  transformNextDataHtmlResponse,
} from "./next-data-response.js";

describe("next data response helpers", () => {
  it("detects basePath-aware Next data request paths", () => {
    expect(isNextDataRequestPath("/_next/data/build-id/index.json")).toBe(true);
    expect(isNextDataRequestPath("/docs/_next/data/build-id/blog/post.json?x=1")).toBe(true);
    expect(isNextDataRequestPath("/_next/static/build-id/_buildManifest.js")).toBe(false);
    expect(isNextDataRequestPath("/blog/post")).toBe(false);
  });

  it("extracts pageData from the __NEXT_DATA__ script", () => {
    const pageData = extractNextDataPageData(`
      <!DOCTYPE html>
      <script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"message":"ok"},"__N_SSP":true},"page":"/ssr-page"}</script>
    `);

    expect(JSON.parse(pageData ?? "")).toEqual({
      pageProps: { message: "ok" },
      __N_SSP: true,
    });
  });

  it("normalizes rewrite headers into matched-path", () => {
    expect(matchedPathFromRewriteHeaders({
      "x-nextjs-rewrite": "/ssr-page-2/",
    })).toBe("/ssr-page-2");
    expect(matchedPathFromRewriteHeaders({
      "x-middleware-rewrite": "http://localhost:3000/blog/from-middleware/?some=middleware",
    })).toBe("/blog/from-middleware");
  });

  it("converts rewritten data-request HTML into Next pageData JSON", () => {
    const result = transformNextDataHtmlResponse(
      "/_next/data/build-id/ssr-page.json",
      {
        "content-type": "text/html; charset=utf-8",
        "content-length": "999",
        "x-nextjs-rewrite": "/ssr-page-2/",
      },
      Buffer.from(`
        <html>
          <body>
            <script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"message":"Bye Cruel World"},"__N_SSP":true},"page":"/ssr-page-2"}</script>
          </body>
        </html>
      `),
    );

    expect(result).toBeDefined();
    expect(JSON.parse(result?.body.toString("utf8") ?? "")).toEqual({
      pageProps: { message: "Bye Cruel World" },
      __N_SSP: true,
    });
    expect(result?.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(result?.headers["content-length"]).toBe(String(result?.body.byteLength));
    expect(result?.headers["x-nextjs-matched-path"]).toBe("/ssr-page-2");
    expect(result?.headers["transfer-encoding"]).toBeUndefined();
  });

  it("leaves non-data HTML responses alone", () => {
    expect(transformNextDataHtmlResponse(
      "/ssr-page/",
      { "content-type": "text/html; charset=utf-8" },
      Buffer.from("<html></html>"),
    )).toBeUndefined();
  });
});
