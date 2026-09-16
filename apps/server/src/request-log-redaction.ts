import {
  MCP_CONSENT_PAGE_PATH_DEFAULT,
  MCP_LOGIN_PAGE_PATH_DEFAULT,
} from "@ws-model-proxy/auth/mcp-config";
import { MCP_WELL_KNOWN_PATHS } from "./mcp-discovery.js";

/**
 * OAuth request-log redaction (MCP plan invariant 10).
 *
 * The stock hono `logger()` prints the full request URL INCLUDING the query
 * string; OAuth authorization URLs carry `state`, `code_challenge`,
 * `resource`, and similar protocol values that must not land in request
 * logs. For paths under `/api/auth/oauth2/` — and for the two MCP
 * login/consent PAGES, whose redirect URLs carry the SIGNED authorization
 * query (`state`, `code_challenge`, the `sig` over the signed query) — the
 * server bypasses the stock logger line entirely and emits a query-stripped
 * line built from the PATHNAME only. Request correlation is unaffected: it
 * uses the per-request `requestId` (see the request-ID middleware), never
 * the URL.
 *
 * The page paths are matched with EXACT equality (not prefix): only the
 * exact localized page routes carry signed OAuth queries; near-miss paths
 * like `/en-US/mcp-loginish` keep the stock logger behavior.
 *
 * Pass 13 (R42) extends this to EVERY `/api/auth` path: those lines are
 * built from `authRouteLogPath` — first three path segments only, query
 * dropped — because auth route paths can carry live credentials in deeper
 * path segments (reset-password tokens) and queries (oauth2 state/PKCE).
 */

export const OAUTH_LOG_PATH_PREFIX = "/api/auth/oauth2/";

/**
 * Root MCP discovery aliases (L20 reopen, Part E pass 2): the three
 * `/.well-known/*` well-known paths served outside `/api/auth`. Their
 * queries can carry OAuth protocol values (`state`, `code`, …) via redirect
 * or probe URLs, so their log lines strip the query like the oauth2 family.
 * Matched by EXACT pathname equality (plus the exact-with-trailing-slash
 * spelling); near-misses like `/.well-known/oauth-protected-resourceish`
 * keep the stock logger. The FOURTH alias lives under `/api/auth/…` and is
 * already covered by the `isAuthRoutePath` truncation branch, which runs
 * first in the production logger wrapper.
 */
const ROOT_DISCOVERY_LOG_PATHS = new Set(
  MCP_WELL_KNOWN_PATHS.flatMap((path) => (path.startsWith("/api/auth") ? [] : [path, `${path}/`])),
);

/**
 * The /mcp endpoint (L20 reopen, Part F pass 2): probes can carry
 * `access_token`/`state` sentinels in the query of the JSON-RPC endpoint
 * itself, and the request-log wrapper runs BEFORE the /mcp feature gate —
 * so the query reaches the logs with the flag BOTH on and off. Matched by
 * EXACT pathname equality (plus the exact-with-trailing-slash spelling,
 * matching the root-alias pattern); near-misses like `/mcpish` keep the
 * stock logger. Deliberately a local literal (this module must not pull the
 * limiter module graph); pinned equal to MCP_ENDPOINT_PATH by tests.
 */
const MCP_ENDPOINT_LOG_PATH = "/mcp";
const MCP_ENDPOINT_LOG_PATHS = new Set([MCP_ENDPOINT_LOG_PATH, `${MCP_ENDPOINT_LOG_PATH}/`]);

/** true when the request-log line for this pathname must strip the query. */
export function stripsOAuthQuery(pathname: string): boolean {
  return (
    pathname.startsWith(OAUTH_LOG_PATH_PREFIX) ||
    ROOT_DISCOVERY_LOG_PATHS.has(pathname) ||
    MCP_ENDPOINT_LOG_PATHS.has(pathname) ||
    pathname === MCP_LOGIN_PAGE_PATH_DEFAULT ||
    pathname === MCP_CONSENT_PAGE_PATH_DEFAULT
  );
}

/**
 * Query-stripped request-log line for OAuth paths: request ID, method,
 * pathname (never the query), status, elapsed time.
 */
export function oauthRequestLogLine({
  requestId,
  method,
  path,
  status,
  elapsedMs,
}: {
  requestId: string;
  method: string;
  path: string;
  status: number;
  elapsedMs: number;
}): string {
  return `[${requestId}] --> ${method} ${path} ${status} ${elapsedMs}ms`;
}

// ---------------------------------------------------------------------------
// Auth-route path truncation (L19/L20 pass 13, R42)
// ---------------------------------------------------------------------------

export const AUTH_ROUTE_LOG_PATH_ROOT = "/api/auth";

/**
 * true when the pathname is a Better Auth API route (`/api/auth` itself or
 * anything under `/api/auth/`).
 */
export function isAuthRoutePath(pathname: string): boolean {
  return (
    pathname === AUTH_ROUTE_LOG_PATH_ROOT || pathname.startsWith(`${AUTH_ROUTE_LOG_PATH_ROOT}/`)
  );
}

/**
 * Truncated request-log path for Better Auth routes (R42 / pass 13).
 *
 * Better Auth route paths can carry LIVE credentials beyond the route
 * segments — the installed reset-password handler treats
 * `/api/auth/reset-password/<token>` as a live verification token, and
 * OAuth paths carry `state`/PKCE values in queries — so request logs for
 * `/api/auth*` paths keep ONLY the first three path segments and drop the
 * query string entirely. Non-auth pathnames are returned unchanged (the
 * caller passes Hono's `c.req.path`, which never contains a query).
 */
export function authRouteLogPath(pathname: string): string {
  if (!isAuthRoutePath(pathname)) return pathname;
  const queryStart = pathname.indexOf("?");
  const withoutQuery = queryStart === -1 ? pathname : pathname.slice(0, queryStart);
  return withoutQuery.split("/").slice(0, 4).join("/");
}
