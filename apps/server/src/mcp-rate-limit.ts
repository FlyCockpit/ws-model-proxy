import { env } from "@ws-model-proxy/env/server";
import type { Context, MiddlewareHandler, Next } from "hono";
import { bodyLimit } from "hono/body-limit";
import { RateLimiterMemory } from "rate-limiter-flexible";
import { resolveClientIp } from "./client-ip.js";

/**
 * /mcp chain PIECES (Phase 3, item 3) — prepared here, NOT MOUNTED
 * anywhere in this part. Phase 4 mounts them, in this order, ahead of the
 * MCP handler:
 *
 *   1. feature gate (createMcpFeatureGate — WMP_MCP_ENABLED);
 *   2. method gate (mcpMethodGate — 405 `Allow: POST` for non-POST,
 *      BEFORE auth so unauthenticated probes cannot distinguish the method
 *      policy from the auth policy);
 *   3. unconditional IP-keyed limiter (mcpIpLimiter via mcpIpKey —
 *      runs BEFORE authentication: it must not depend on token validity);
 *   4. request-body cap (MCP_MAX_REQUEST_BODY_BYTES);
 *   5. requireMcpAuth (Phase 4) and live user/ban/2FA checks;
 *   6. identity-keyed quota (mcpIdentityQuotaLimiter via mcpIdentityKey —
 *      keyed by VERIFIED `sub` + `client_id` claims only);
 *   7. the MCP handler.
 *
 * KEY-DOMAIN SECURITY CONSTRAINT (load-bearing): the PRE-auth bucket
 * (mcp:ip:) is keyed by the connection IP only — NEVER by the Bearer/DPoP
 * token bytes or any digest of them. A caller who can choose the token can
 * choose the bucket, which would make the pre-auth limiter useless (fresh
 * bucket per random token) and would let an attacker pre-fill buckets to
 * lock out a victim's future tokens. The identity bucket (mcp:identity:)
 * may only be keyed by claims that were VERIFIED first (`sub`, `client_id`
 * from the validated JWT — Phase 4's requireMcpAuth output), never from
 * request-supplied strings.
 *
 * All limiters here are in-process (RateLimiterMemory): every in-memory
 * ceiling MULTIPLIES with replicas — N replicas give N× the nominal points
 * per window. Acceptable for the single-process default deployment (see
 * rate-limit.ts); a multi-replica deployment must move these to a shared
 * store.
 */

// ---------------------------------------------------------------------------
// Key prefixes (Phase 3 spec: `mcp:ip:` and `mcp:identity:`)
// ---------------------------------------------------------------------------

export const MCP_IP_KEY_PREFIX = "mcp:ip:";
export const MCP_IDENTITY_KEY_PREFIX = "mcp:identity:";

// ---------------------------------------------------------------------------
// Limiter instances
// ---------------------------------------------------------------------------

/**
 * Unconditional IP-keyed /mcp quota (RATE_LIMIT_MCP_POINTS /
 * RATE_LIMIT_MCP_DURATION, defaults 120/60s). PRE-auth: keyed by connection
 * IP only — see the key-domain constraint above.
 */
export const mcpIpLimiter = new RateLimiterMemory({
  keyPrefix: MCP_IP_KEY_PREFIX,
  points: env.RATE_LIMIT_MCP_POINTS,
  duration: env.RATE_LIMIT_MCP_DURATION,
});

/**
 * Post-auth identity-keyed /mcp quota, one bucket per verified
 * `sub + client_id` pair. Same numeric ceiling as the IP bucket
 * (RATE_LIMIT_MCP_POINTS/DURATION) so a single human on a single client
 * cannot exceed the anonymous ceiling; per-identity keying additionally
 * bounds one account rotating IPs and separates concurrent clients of the
 * same user. Consume ONLY with mcpIdentityKey(sub, clientId) built from
 * verified claims.
 */
export const mcpIdentityQuotaLimiter = new RateLimiterMemory({
  keyPrefix: MCP_IDENTITY_KEY_PREFIX,
  points: env.RATE_LIMIT_MCP_POINTS,
  duration: env.RATE_LIMIT_MCP_DURATION,
});

// ---------------------------------------------------------------------------
// Key builders (pure)
// ---------------------------------------------------------------------------

/** PRE-auth IP key. Never token-derived (see module doc). */
export function mcpIpKey(c: Context): string {
  return `${MCP_IP_KEY_PREFIX}${resolveClientIp(c)}`;
}

/**
 * POST-auth identity key from VERIFIED claims only. `sub` is the user id
 * claim, `client_id` the OAuth client the token was minted for; the pair
 * identifies one (user, client) quota domain.
 */
export function mcpIdentityKey(sub: string, clientId: string): string {
  return `${MCP_IDENTITY_KEY_PREFIX}${sub}:${clientId}`;
}

// ---------------------------------------------------------------------------
// Gates and body cap (Phase 4 mounts these on /mcp)
// ---------------------------------------------------------------------------

/** Canonical /mcp resource path (must equal mcp-config's canonical resource). */
export const MCP_ENDPOINT_PATH = "/mcp";

/**
 * Feature gate: while WMP_MCP_ENABLED is off, /mcp is a reserved-but-absent
 * path — 404 for every method (same convention as the discovery aliases).
 */
export function createMcpFeatureGate({ enabled }: { enabled: boolean }): MiddlewareHandler {
  return async (c, next) => {
    if (!enabled) {
      return c.notFound();
    }
    return next();
  };
}

/**
 * Method gate: POST-only JSON-RPC transport. Non-POST → 405 with
 * `Allow: POST`, BEFORE authentication, so the method policy is visible
 * without valid credentials.
 */
export async function mcpMethodGate(c: Context, next: Next) {
  if (c.req.method !== "POST") {
    return c.newResponse(null, 405, { Allow: "POST" });
  }
  return next();
}

/**
 * /mcp request-body cap. JSON-RPC tool arguments can be sizeable but must
 * stay far below the app's 10 MB global limit; 1 MB bounds
 * memory-amplification from unauthenticated (pre-auth limiter only) bodies
 * while leaving generous room for legitimate tool inputs. Phase 4 may
 * revisit the constant with the real tool manifest.
 */
export const MCP_MAX_REQUEST_BODY_BYTES = 1024 * 1024;

export const mcpBodyCap: MiddlewareHandler = bodyLimit({
  maxSize: MCP_MAX_REQUEST_BODY_BYTES,
  onError: (c) => c.json({ error: "Request is too large. Try uploading a smaller file." }, 413),
});
