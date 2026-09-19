import { SUPPORTED_LOCALES } from "@ws-model-proxy/config/locales";
import type { Context, MiddlewareHandler } from "hono";

/**
 * MCP web login/consent page gate (MCP plan Phase 6; invariant 13: while
 * `WMP_MCP_ENABLED` is off, MCP login/consent routes return REAL 404s).
 *
 * Gate scope — EXACT valid-locale forms ONLY:
 *   /<supported-locale>/mcp-login
 *   /<supported-locale>/mcp-consent
 *
 * Near-miss locale forms (`/fr-FR/mcp-login`, `/en-US/mcp-login/`, case
 * variants, percent-encoded spellings) are NOT matched and keep the normal
 * SPA/SSR handling (the locale layout redirects them to the default locale —
 * the same treatment as every other near-miss route spelling). This mirrors
 * the raw-path exact-equality convention of mcp-oauth-route-match.ts: the
 * decision uses the RAW, still-encoded `new URL(request.url).pathname`, never
 * Hono's decoded `c.req.path` pattern matching.
 *
 * While ENABLED the middleware is a pass-through: the pages themselves are
 * rendered by the TanStack Start SSR handler, and their `beforeLoad` also
 * throws `notFound()` from the SERVER RUNTIME flag
 * (apps/web/src/server/mcp-availability.ts) — this gate is the pre-SSR
 * boundary so a flag-off request can never fall through to the SPA shell.
 */
export const MCP_WEB_PAGE_PATHS: readonly string[] = SUPPORTED_LOCALES.flatMap((locale) => [
  `/${locale}/mcp-login`,
  `/${locale}/mcp-consent`,
]);

const MCP_WEB_PAGE_PATH_SET = new Set(MCP_WEB_PAGE_PATHS);

/** Exact raw-pathname membership test (no decoding, no prefix logic). */
export function isMcpWebPageRawPath(rawPathname: string): boolean {
  return MCP_WEB_PAGE_PATH_SET.has(rawPathname);
}

/** RAW (still percent-encoded) request pathname of a Hono context. */
export function mcpWebPageRawPath(c: Context): string {
  return new URL(c.req.raw.url).pathname;
}

export function createMcpWebPageGate({ enabled }: { enabled: () => boolean }): MiddlewareHandler {
  return async (c, next) => {
    if (!enabled() && isMcpWebPageRawPath(mcpWebPageRawPath(c))) {
      return c.notFound();
    }
    return next();
  };
}
