import { createHash } from "node:crypto";
import type { Session } from "@ws-model-proxy/auth";
import { env } from "@ws-model-proxy/env/server";
import type { Context, Next } from "hono";
import { RateLimiterMemory, RateLimiterRes } from "rate-limiter-flexible";
import { resolveClientIp } from "./client-ip.js";

export type RateLimiter = Pick<RateLimiterMemory, "consume" | "points">;

// ---------------------------------------------------------------------------
// Rate limiters
// ---------------------------------------------------------------------------
// Algorithm: "enhanced fixed window" (rate-limiter-flexible's default).
// This is NOT a true sliding window — it counts hits per fixed-duration bucket
// with partial-overlap weighting. Good enough for abuse prevention; don't
// replace it thinking the name is wrong.
//
// The supported v1 topology is exactly one web-service container and Postgres,
// so these process-local buckets protect that one server process. Multiple app
// replicas are unsupported while the limiters remain in memory: no limiter,
// including the per-account sign-in bucket, claims a cross-replica budget.
// Introduce a shared durable store before supporting horizontal scaling.
// ---------------------------------------------------------------------------

/**
 * Auth limiter — strict, applied to /api/auth/* to defend against
 * credential-stuffing and account-enumeration attacks.
 *
 * 10 requests / 60 s per key. Offenders are blocked for 15 minutes.
 */
export const authLimiter = new RateLimiterMemory({
  keyPrefix: "rl:auth",
  points: env.RATE_LIMIT_AUTH_POINTS,
  duration: env.RATE_LIMIT_AUTH_DURATION,
  blockDuration: env.RATE_LIMIT_AUTH_BLOCK_DURATION,
});

/**
 * Per-account failed password sign-ins for the supported single-server
 * deployment. The general auth limiter is keyed by IP, so it cannot bound a
 * password-stuffing campaign that rotates source addresses. This counter is
 * reserved before the credential check and kept only for Better Auth's
 * `INVALID_EMAIL_OR_PASSWORD` response; successes, session-creation failures,
 * and pre-credential failures refund it to avoid a lockout lever.
 */
export const signinFailureLimiter = new RateLimiterMemory({
  keyPrefix: "rl:signin-fail",
  // `env` validates these defaults in real processes. Keep the same concrete
  // defaults here as a defensive construction boundary for focused test
  // module mocks that predate this limiter and omit the new optional fields.
  points: env.RATE_LIMIT_SIGNIN_FAILURE_POINTS ?? 10,
  duration: env.RATE_LIMIT_SIGNIN_FAILURE_DURATION ?? 15 * 60,
  blockDuration: env.RATE_LIMIT_SIGNIN_FAILURE_BLOCK_DURATION ?? 10 * 60,
});

/**
 * Whole-service budget for unauthenticated RFC 7591 registrations. Unlike an
 * IP bucket, this still bounds durable client-row creation when callers rotate
 * addresses. The supported deployment is one web-service process; introduce
 * a shared store before operating multiple replicas.
 */
export const mcpClientRegistrationLimiter = new RateLimiterMemory({
  keyPrefix: "rl:mcp-registration",
  points: env.RATE_LIMIT_MCP_REGISTRATION_POINTS ?? 60,
  duration: env.RATE_LIMIT_MCP_REGISTRATION_DURATION ?? 60 * 60,
});

/**
 * Signup limiter — very strict, applied to /api/auth/sign-up/* to prevent
 * account-creation spam. 3 requests / 3600 s per key with a 1-hour block.
 *
 * Must be mounted BEFORE the general authLimiter so signup traffic hits this
 * tighter limit first; the authLimiter still applies as a second layer.
 */
export const signupLimiter = new RateLimiterMemory({
  keyPrefix: "rl:signup",
  points: env.RATE_LIMIT_SIGNUP_POINTS,
  duration: env.RATE_LIMIT_SIGNUP_DURATION,
  blockDuration: env.RATE_LIMIT_SIGNUP_BLOCK_DURATION,
});

/**
 * RPC limiter — general, applied to /rpc/* for normal API traffic.
 *
 * 100 requests / 60 s per key.
 */
export const rpcLimiter = new RateLimiterMemory({
  keyPrefix: "rl:rpc",
  points: env.RATE_LIMIT_RPC_POINTS,
  duration: env.RATE_LIMIT_RPC_DURATION,
});

/**
 * Email-recipient limiter — caps how much mail a single ADDRESS can be sent
 * from anonymous endpoints that accept a recipient in the body
 * (`/api/auth/send-verification-email`, `/api/auth/request-password-reset`).
 * Signup mails one too and gets its own bucket — see `signupRecipientLimiter`.
 *
 * Other limiters key on client IP (or user id). That bounds one caller, not
 * one mailbox. Rotating IPs multiply the IP ceiling into a victim's inbox.
 * Keyed on normalized recipient (lowercased + trimmed). POINTS=0 disables.
 *
 * `blockDuration` defaults to 0: keying on an attacker-supplied identifier
 * must not become an unauthenticated lockout lever on password reset.
 */
export const emailRecipientLimiter = new RateLimiterMemory({
  keyPrefix: "rl:email-to",
  points: env.RATE_LIMIT_EMAIL_RECIPIENT_POINTS,
  duration: env.RATE_LIMIT_EMAIL_RECIPIENT_DURATION,
  blockDuration: env.RATE_LIMIT_EMAIL_RECIPIENT_BLOCK_DURATION,
});

/**
 * Same idea as `emailRecipientLimiter`, for `/api/auth/sign-up/email`.
 * Separate bucket so a signup flood cannot eat a legitimate reset budget.
 */
export const signupRecipientLimiter = new RateLimiterMemory({
  keyPrefix: "rl:signup-to",
  points: env.RATE_LIMIT_SIGNUP_RECIPIENT_POINTS,
  duration: env.RATE_LIMIT_EMAIL_RECIPIENT_DURATION,
  blockDuration: env.RATE_LIMIT_EMAIL_RECIPIENT_BLOCK_DURATION,
});

/**
 * Normalize a recipient into a rate-limit key.
 *
 * Lowercase + trim only. Deliberately NOT provider-specific canonicalization
 * (Gmail dots / `+tag`): those rules differ per provider, and collapsing
 * tags would let one abusive address consume a different user's budget.
 */
export function emailRateLimitKey(email: string): string {
  return email.trim().toLowerCase();
}

/** Hash the normalized address so limiter storage never contains raw email. */
export function signinFailureKey(email: string): string {
  return `em:${createHash("sha256").update(emailRateLimitKey(email)).digest("base64url")}`;
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Resolve the rate-limit key for a request.
 *
 * Priority:
 * 1. Authenticated user → session.user.id (so limits follow the account, not the IP)
 * 2. Anonymous → the real client IP (`resolveClientIp`, proxy-aware) → "unknown"
 *
 * The session is resolved once per request by `sessionMiddleware` and read
 * here from the Hono context. Routes that don't mount `sessionMiddleware`
 * (or the rate-limit unit test) leave `c.get("session")` undefined; we fall
 * through to IP keying in that case.
 */
function resolveKey(c: Context): string {
  const existing = c.get("session") as Session | null | undefined;
  if (existing?.user?.id) {
    return `uid:${existing.user.id}`;
  }

  return resolveClientIp(c);
}

export function setRateLimitHeaders(c: Context, limiter: RateLimiter, res: RateLimiterRes) {
  const limit = limiter.points;
  const remaining = Math.max(0, res.remainingPoints);
  // msBeforeNext is ms until the current window resets
  const resetEpochSeconds = Math.ceil((Date.now() + res.msBeforeNext) / 1000);

  c.header("X-RateLimit-Limit", String(limit));
  c.header("X-RateLimit-Remaining", String(remaining));
  c.header("X-RateLimit-Reset", String(resetEpochSeconds));
}

/**
 * Optional per-middleware overrides for `createRateLimiterMiddleware`.
 * All fields are optional; omitting the options object entirely keeps the
 * default key resolution (session user id → client IP) for every existing
 * caller, byte-identically.
 */
export interface RateLimiterMiddlewareOptions {
  /**
   * Custom rate-limit key resolver for this middleware instance.
   *
   * Use when a limiter needs a different key domain than the default
   * session/IP keying (e.g. the MCP OAuth limiters key on prefixed IP or
   * prefixed verified-identity keys). SECURITY: never build a PRE-AUTH
   * bucket key from request-supplied token bytes or any digest of them —
   * an attacker choosing the token chooses the bucket. Post-auth buckets
   * may key on verified claims only (e.g. `sub` + `client_id`).
   */
  resolveKey?: (c: Context) => string;
}

/**
 * Create a Hono middleware that enforces a `rate-limiter-flexible` limiter.
 *
 * On rejection → 429 JSON with rate-limit + Retry-After headers.
 */
export function createRateLimiterMiddleware(
  limiter: RateLimiter,
  options: RateLimiterMiddlewareOptions = {},
) {
  const resolveRequestKey = options.resolveKey ?? resolveKey;
  return async (c: Context, next: Next) => {
    const key = resolveRequestKey(c);

    try {
      const res = await limiter.consume(key);
      setRateLimitHeaders(c, limiter, res);
      await next();
    } catch (rlResult: unknown) {
      if (rlResult instanceof RateLimiterRes) {
        // Rate limit exceeded — reject with 429
        setRateLimitHeaders(c, limiter, rlResult);
        const retryAfter = Math.ceil(rlResult.msBeforeNext / 1000);
        c.header("Retry-After", String(retryAfter));
        return c.json({ error: "Too many attempts. Please wait a moment and try again." }, 429);
      }

      // Sanitized (L19): constructor name / typeof only — limiter rejections
      // can be arbitrary objects; the fail-open policy is unchanged.
      console.error(
        `[rate-limit] Unexpected limiter error, failing open: (${
          rlResult instanceof Error ? (rlResult.constructor?.name ?? "Error") : typeof rlResult
        })`,
      );
      await next();
    }
  };
}
