import type { Session } from "@ws-model-proxy/auth";
import { env } from "@ws-model-proxy/env/server";
import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { RateLimiterMemory } from "rate-limiter-flexible";
import { resolveClientIp } from "./client-ip.js";
import {
  isMcpOauthRateLimitedRequest,
  isMcpOauthRoute,
  MCP_OAUTH_CONSENT_PATH,
  MCP_OAUTH_CONTINUE_PATH,
} from "./mcp-oauth-route-match.js";
import { createRateLimiterMiddleware } from "./rate-limit.js";

// Shared raw method+path boundary (L18): re-exported for existing tests and
// any future consumer; the single source of truth is mcp-oauth-route-match.
export { isMcpOauthRateLimited, MCP_OAUTH_RATE_LIMITED_ROUTES } from "./mcp-oauth-route-match.js";

/**
 * MCP OAuth endpoint rate limits (Phase 3).
 *
 * Replaces the broad `/api/auth/*` strict-limiter coverage for an EXACT
 * method+path allowlist of the MCP OAuth endpoints (paths derived from the
 * installed provider's routes — see the probe notes in mcp-discovery.ts and
 * the oauth-provider dist endpoint table). Everything else under
 * `/api/auth/*` (sign-in, password reset, verification, admin, device paths,
 * OAuth client/resource/consent CRUD, introspection, userinfo, logout) keeps
 * its CURRENT general limits; Better Auth's own endpoint-specific limits
 * (token 20/60s, authorize 30/60s, introspect 100/60s, revoke 30/60s,
 * register 5/60s, userinfo 60/60s — plugin-level `rateLimit` entries) are
 * untouched and remain enabled underneath these application controls.
 *
 * Like every limiter in rate-limit.ts these are in-process
 * (RateLimiterMemory): all in-memory ceilings multiply with replicas.
 *
 * Flag gating: the middleware is only mounted (and the general-limiter
 * exemption only honored) while WMP_MCP_ENABLED is on; flag-off keeps the
 * pre-Phase-3 general `/api/auth/*` behavior exactly.
 */

/**
 * Anonymous/protocol endpoints (authorize GET+POST, token, revoke,
 * public-client read, public-client-prelogin, JWKS read) — IP-keyed bucket
 * from RATE_LIMIT_MCP_POINTS / RATE_LIMIT_MCP_DURATION (defaults 120/60s).
 * No blockDuration: a protocol endpoint must not lock an IP out of the
 * discovery/token flow entirely. Read-ish endpoints (public-client,
 * public-client-prelogin, JWKS) share this one generous read ceiling.
 */
const mcpOauthLimiter = new RateLimiterMemory({
  keyPrefix: "mcp:oauth:ip",
  points: env.RATE_LIMIT_MCP_POINTS,
  duration: env.RATE_LIMIT_MCP_DURATION,
});

/**
 * Human form submissions (consent, continue) — session/user-keyed bucket
 * from RATE_LIMIT_MCP_CONSENT_POINTS / RATE_LIMIT_MCP_CONSENT_DURATION
 * (defaults 30/60s), falling back to the client IP when no session is
 * resolved. Session keying bounds one account's consent-flooding across
 * IPs; IP fallback bounds anonymous flooders.
 */
const mcpConsentLimiter = new RateLimiterMemory({
  keyPrefix: "mcp:consent",
  points: env.RATE_LIMIT_MCP_CONSENT_POINTS,
  duration: env.RATE_LIMIT_MCP_CONSENT_DURATION,
});

/** IP key for the anonymous MCP OAuth bucket (prefixed key domain). */
export function mcpOauthIpKey(c: Context): string {
  return `mcp:oauth:ip:${resolveClientIp(c)}`;
}

/**
 * Session/user key with IP fallback for the consent/continue bucket. The
 * session is resolved once by `sessionMiddleware` (mounted on exactly these
 * two paths in index.ts) and read from the Hono context.
 */
export function mcpConsentKey(c: Context): string {
  const session = c.get("session") as Session | null | undefined;
  if (session?.user?.id) {
    return `mcp:consent:uid:${session.user.id}`;
  }
  return `mcp:consent:ip:${resolveClientIp(c)}`;
}

/**
 * Middleware mounted on `/api/auth/*` (flag-on only, BEFORE the general
 * authLimiter). Allowlisted raw method+path (see mcp-oauth-route-match.ts —
 * the SAME predicate the general-limiter exemption and the prerequisite
 * mounts consume) → the MCP OAuth limiter; everything else → next() so the
 * general limiter and downstream handlers apply.
 */
export const mcpOauthRateLimits: MiddlewareHandler = async (c, next) => {
  if (!isMcpOauthRateLimitedRequest(c)) {
    return next();
  }
  if (
    isMcpOauthRoute(c, "POST", MCP_OAUTH_CONSENT_PATH) ||
    isMcpOauthRoute(c, "POST", MCP_OAUTH_CONTINUE_PATH)
  ) {
    return createRateLimiterMiddleware(mcpConsentLimiter, { resolveKey: mcpConsentKey })(c, next);
  }
  return createRateLimiterMiddleware(mcpOauthLimiter, { resolveKey: mcpOauthIpKey })(c, next);
};

// ---------------------------------------------------------------------------
// Form-body caps (Phase 3 "small form-body caps")
// ---------------------------------------------------------------------------

/**
 * OAuth protocol bodies are tiny: authorize/token forms carry a handful of
 * parameters (~1-2 KB), and the consent JSON carries the signed
 * `oauth_query` blob (a few KB). Caps chosen with an order of magnitude of
 * headroom above the largest legitimate payload so no valid client is ever
 * rejected:
 *
 * - authorize: 16 KB (response_type/client_id/redirect_uri/PKCE/state…)
 * - token:     16 KB (grant_type/code/verifier/refresh token…)
 * - consent:   32 KB (signed oauth_query + accept flag; the signed query is
 *   the largest legitimate field, so it gets the largest cap)
 *
 * Oversize answers with the app's standard body-cap response shape (413
 * JSON, matching the global 10 MB limiter's convention/message).
 */
export const MCP_OAUTH_AUTHORIZE_MAX_BODY_BYTES = 16 * 1024;
export const MCP_OAUTH_TOKEN_MAX_BODY_BYTES = 16 * 1024;
export const MCP_OAUTH_CONSENT_MAX_BODY_BYTES = 32 * 1024;

export function mcpOauthBodyCap(maxBytes: number): MiddlewareHandler {
  return bodyLimit({
    maxSize: maxBytes,
    onError: (c) => c.json({ error: "Request is too large. Try uploading a smaller file." }, 413),
  });
}
