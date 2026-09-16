import type { Context, MiddlewareHandler } from "hono";

/**
 * Shared RAW method+path boundary for EVERY MCP OAuth control (L18).
 *
 * Two routers disagree on path spelling: Hono's `c.req.path` (and its route
 * matching) percent-DECODES unreserved triples, while better-call — the
 * router inside the installed Better Auth handler — routes on the RAW,
 * still-encoded `new URL(request.url).pathname` and 404s anything else. A
 * request for `/api/%61uth/oauth2/token` therefore MATCHES Hono's
 * `/api/auth/*` mounts but is NOT the token route downstream. Every
 * MCP OAuth control (limiter selection, the general-limiter exemption,
 * the sessionMiddleware mounts, the body-cap mounts) must consequently
 * decide on the SAME raw method + raw pathname pair — never on
 * `c.req.method`/`c.req.path` and never on Hono's pattern matching alone.
 *
 * This module is that single decision: all four call sites in index.ts and
 * mcp-oauth-rate-limit.ts consume these predicates, so the exemption set,
 * the session mounts, and the caps can never be wider or narrower than the
 * routes the installed provider actually serves.
 */

/** Exact method+path pairs handled by the MCP OAuth limiters (Phase 3). */
export const MCP_OAUTH_RATE_LIMITED_ROUTES = [
  ["GET", "/api/auth/oauth2/authorize"],
  ["POST", "/api/auth/oauth2/authorize"],
  ["POST", "/api/auth/oauth2/consent"],
  ["POST", "/api/auth/oauth2/continue"],
  ["POST", "/api/auth/oauth2/token"],
  ["POST", "/api/auth/oauth2/revoke"],
  ["GET", "/api/auth/oauth2/public-client"],
  ["POST", "/api/auth/oauth2/public-client-prelogin"],
  ["GET", "/api/auth/jwks"],
] as const;

export const MCP_OAUTH_AUTHORIZE_PATH = "/api/auth/oauth2/authorize";
export const MCP_OAUTH_TOKEN_PATH = "/api/auth/oauth2/token";
export const MCP_OAUTH_CONSENT_PATH = "/api/auth/oauth2/consent";
export const MCP_OAUTH_CONTINUE_PATH = "/api/auth/oauth2/continue";

const MCP_OAUTH_RATE_LIMITED_ROUTE_KEYS = new Set<string>(
  MCP_OAUTH_RATE_LIMITED_ROUTES.map(([method, path]) => `${method} ${path}`),
);

/** Exact-match test on plain strings: only the listed METHOD+path pairs. */
export function isMcpOauthRateLimited(method: string, path: string): boolean {
  return MCP_OAUTH_RATE_LIMITED_ROUTE_KEYS.has(`${method.toUpperCase()} ${path}`);
}

/** RAW (still percent-encoded) request pathname — better-call's spelling. */
export function mcpOauthRawPath(c: Context): string {
  return new URL(c.req.raw.url).pathname;
}

/** true iff the request's RAW method + RAW pathname equal the pair exactly. */
export function isMcpOauthRoute(c: Context, method: string, path: string): boolean {
  return c.req.raw.method.toUpperCase() === method.toUpperCase() && mcpOauthRawPath(c) === path;
}

/**
 * Limiter-selection predicate: the request's raw method+pathname is one of
 * the nine allowlisted pairs. Percent-encoded spellings of allowlisted
 * paths (`/api/%61uth/...`) and wrong methods on listed paths are NOT
 * MCP-handled — they keep the general auth limiter, mirroring the 404 the
 * installed provider itself would answer them with.
 */
export function isMcpOauthRateLimitedRequest(c: Context): boolean {
  return isMcpOauthRateLimited(c.req.raw.method, mcpOauthRawPath(c));
}

/**
 * Mount guard for the index.ts prerequisite mounts (sessionMiddleware,
 * body caps): Hono's `app.use(path, ...)` matches path-only on the DECODED
 * path, which would run the middleware for every method and every
 * percent-encoded spelling of the path. This wrapper narrows it to the
 * exact raw method+path pair, so e.g. the session resolver runs ONLY on
 * POST consent/continue and the authorize cap ONLY on POST authorize.
 */
export function onMcpOauthRoute(
  method: string,
  path: string,
  handler: MiddlewareHandler,
): MiddlewareHandler {
  return (c, next) => {
    if (!isMcpOauthRoute(c, method, path)) return next();
    return handler(c, next);
  };
}
