export const CAPABILITY_TOKEN_HEADER = "x-pr-artifact-explorer-token";

const REQUEST_BASE = new URL("http://127.0.0.1");

// Only origin-form targets ("/path?query") are served. Scheme-relative ("//x",
// "/\\x") and absolute-form targets either throw in the URL parser or replace
// the base authority, so they are refused rather than parsed. Returns null for
// any target that is not a plain path on the loopback base.
export function parseRequestTarget(target) {
  if (typeof target !== "string" || !/^\/(?![/\\])/.test(target)) return null;
  let url;
  try {
    url = new URL(target, REQUEST_BASE);
  } catch {
    return null;
  }
  if (url.origin !== REQUEST_BASE.origin || url.username || url.password) return null;
  return url;
}

// Last-resort handler for a rejected request promise. It must never throw:
// an escaping rejection terminates the process hosting the canvas.
export function abortRequest(res, error, log) {
  try {
    log?.(`Request failed: ${error instanceof Error ? error.message : String(error)}`);
  } catch {
    // Logging must not turn a failed request into a process crash.
  }
  try {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const body = JSON.stringify({ error: "Internal server error.", status: 500 });
    res.writeHead(500, {
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(body),
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(body);
  } catch {
    res.destroy();
  }
}

export function isCanonicalHost(req, canonicalHost) {
  return (
    String(req.headers.host ?? "").toLowerCase() ===
    String(canonicalHost ?? "").toLowerCase()
  );
}

export function isCrossSiteRequest(req, canonicalOrigin) {
  const origin = req.headers.origin;
  if (origin) {
    if (origin === canonicalOrigin) return false;
    if (origin === "null") return true;
    if (/^https?:\/\//i.test(origin)) return true;
    return false;
  }
  const site = req.headers["sec-fetch-site"];
  return site === "cross-site" || site === "same-site";
}

export function requiresCapabilityToken(pathname) {
  return (
    pathname.startsWith("/api/") ||
    pathname.startsWith("/content/") ||
    pathname === "/events"
  );
}

export function hasCapabilityToken(req, url, expectedToken) {
  if (!expectedToken) return false;
  const header = req.headers[CAPABILITY_TOKEN_HEADER];
  const headerToken = Array.isArray(header) ? header[0] : header;
  if (headerToken === expectedToken) return true;
  const allowsQueryToken =
    url.pathname.startsWith("/content/") || url.pathname === "/events";
  return allowsQueryToken && url.searchParams.get("token") === expectedToken;
}
