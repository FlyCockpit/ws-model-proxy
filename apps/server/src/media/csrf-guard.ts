import type { Context, MiddlewareHandler } from "hono";

// ---------------------------------------------------------------------------
// Same-origin guard for the cookie-authenticated media mutation routes.
// ---------------------------------------------------------------------------
// POST /api/internal/media (multipart), POST /api/internal/media/sign, and the
// admin POST routes are authenticated by the session cookie alone. Unlike the
// oRPC surface — which is CSRF-protected because its client sets a custom
// `x-csrf-token` header that a cross-site HTML form can't reproduce (and the
// SimpleCsrfProtectionHandlerPlugin validates it on split-origin deploys) —
// these plain Hono routes have no such guard. A cross-site multipart form POST
// (a "simple" request that skips CORS preflight) could otherwise ride the
// victim's cookies.
//
// The pragmatic strong fix: require the request to prove it is same-origin (or
// from a configured app origin) for mutating methods, rejecting cross-site with
// 403. Reads (GET/HEAD) — the capability-discovery config route and signed
// GET /media/:id — are unaffected.
//
// Precedence:
//   1. Origin header present  -> must match a configured app origin.
//   2. No Origin, Sec-Fetch-Site same-origin/none -> allow (browser attests it).
//   3. Otherwise -> fail closed (403).
// Ordering Origin first keeps a legitimate SPLIT-origin frontend working: its
// requests are Sec-Fetch-Site: cross-site but carry an allowed Origin.

export interface SameOriginGuardOptions {
  /** Exact app origins that may issue mutating requests (e.g. app + SPA origin). */
  allowedOrigins: string[];
}

function normalizeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function createSameOriginGuard({
  allowedOrigins,
}: SameOriginGuardOptions): MiddlewareHandler {
  const allowed = new Set(
    allowedOrigins.map(normalizeOrigin).filter((o): o is string => o !== null),
  );

  const reject = (c: Context) => c.json({ error: "Cross-site request blocked." }, 403);

  return async (c, next) => {
    const method = c.req.method.toUpperCase();
    // Safe methods carry no state-changing side effect; leave reads untouched.
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
      return next();
    }

    const origin = c.req.header("origin");
    if (origin) {
      const normalized = normalizeOrigin(origin);
      if (normalized && allowed.has(normalized)) return next();
      return reject(c);
    }

    // No Origin header: trust the browser-set Sec-Fetch-Site metadata, which a
    // cross-site HTML form cannot forge.
    const secFetchSite = c.req.header("sec-fetch-site");
    if (secFetchSite === "same-origin" || secFetchSite === "none") return next();

    // Neither an allowed Origin nor a same-origin attestation — fail closed.
    return reject(c);
  };
}
