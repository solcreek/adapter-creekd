import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";

export interface NextDataTransformResult {
  body: Buffer;
  headers: OutgoingHttpHeaders;
}

function pathnameFromRequestUrl(requestUrl: string | undefined): string {
  if (!requestUrl) return "/";
  try {
    return new URL(requestUrl, "http://localhost").pathname;
  } catch {
    return requestUrl.split("?")[0] || "/";
  }
}

export function isNextDataRequestPath(requestUrl: string | undefined): boolean {
  const pathname = pathnameFromRequestUrl(requestUrl);
  return /(?:^|\/)_next\/data\/[^/]+\/.+\.json$/.test(pathname);
}

function firstHeaderValue(value: string | string[] | number | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  if (value === undefined) return undefined;
  return String(value);
}

function normalizeMatchedPath(rewriteValue: string | undefined): string | undefined {
  if (!rewriteValue) return undefined;

  let pathname: string;
  try {
    pathname = new URL(rewriteValue, "http://localhost").pathname;
  } catch {
    pathname = rewriteValue.split("?")[0] || "";
  }

  if (!pathname || pathname === "/") return pathname || undefined;
  return pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

export function matchedPathFromRewriteHeaders(
  headers: IncomingHttpHeaders | OutgoingHttpHeaders,
): string | undefined {
  return normalizeMatchedPath(
    firstHeaderValue(headers["x-nextjs-rewrite"]) ??
      firstHeaderValue(headers["x-middleware-rewrite"]),
  );
}

export function extractNextDataPageData(html: string): string | undefined {
  const match = /<script\b(?=[^>]*\bid=(["'])__NEXT_DATA__\1)[^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!match) return undefined;

  const scriptText = match[2];
  if (!scriptText) return undefined;

  const nextData = JSON.parse(scriptText) as { props?: unknown };
  return JSON.stringify(nextData.props ?? {});
}

function cloneTransformHeaders(
  headers: IncomingHttpHeaders,
  body: Buffer,
): OutgoingHttpHeaders {
  const nextHeaders: OutgoingHttpHeaders = { ...headers };
  delete nextHeaders["content-encoding"];
  delete nextHeaders["content-length"];
  delete nextHeaders["transfer-encoding"];

  nextHeaders["content-type"] = "application/json; charset=utf-8";
  nextHeaders["content-length"] = String(body.byteLength);

  if (nextHeaders["x-nextjs-matched-path"] === undefined) {
    const matchedPath = matchedPathFromRewriteHeaders(nextHeaders);
    if (matchedPath) nextHeaders["x-nextjs-matched-path"] = matchedPath;
  }

  return nextHeaders;
}

export function transformNextDataHtmlResponse(
  requestUrl: string | undefined,
  headers: IncomingHttpHeaders,
  body: Buffer,
): NextDataTransformResult | undefined {
  if (!isNextDataRequestPath(requestUrl)) return undefined;

  const contentType = firstHeaderValue(headers["content-type"])?.toLowerCase() ?? "";
  if (!contentType.includes("text/html")) return undefined;

  let pageData: string | undefined;
  try {
    pageData = extractNextDataPageData(body.toString("utf8"));
  } catch {
    return undefined;
  }
  if (pageData === undefined) return undefined;

  const nextBody = Buffer.from(pageData);
  return {
    body: nextBody,
    headers: cloneTransformHeaders(headers, nextBody),
  };
}
