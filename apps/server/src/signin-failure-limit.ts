import type { Context, MiddlewareHandler, Next } from "hono";
import { RateLimiterRes } from "rate-limiter-flexible";
import { FORM_OR_JSON_MEDIA_TYPES, readEmail } from "./email-recipient-limit.js";
import {
  type RateLimiter,
  setRateLimitHeaders,
  signinFailureKey,
  signinFailureLimiter,
} from "./rate-limit.js";

/** Exact Better Auth email/password route; passwordless routes are excluded. */
export const SIGNIN_FAILURE_PATH = "/api/auth/sign-in/email";

type FailureLimiter = RateLimiter & {
  reward(key: string): Promise<unknown>;
};

/**
 * Better Auth uses 401 for both bad credentials and failures after a valid
 * password. In particular, its installed sign-in handler reports
 * `FAILED_TO_CREATE_SESSION` when session persistence fails. Reserve the
 * account bucket only for its enumeration-safe bad-credential code.
 */
async function failedCredentialCheck(c: Context): Promise<boolean> {
  if (c.res.status !== 401) return false;
  try {
    const body: unknown = await c.res.clone().json();
    return (
      typeof body === "object" &&
      body !== null &&
      "code" in body &&
      body.code === "INVALID_EMAIL_OR_PASSWORD"
    );
  } catch {
    // An unparseable error does not demonstrate a failed credential check.
    return false;
  }
}

/**
 * Bound failed email/password checks per normalized account, independently of
 * the caller IP. A reservation happens before the password check so concurrent
 * guesses cannot pass a post-response counter; it is refunded unless the
 * downstream response proves the credentials were invalid.
 *
 * 400/403/429 and successful/2FA responses are deliberately refunded. Those
 * statuses occur before password verification or prove the password was
 * correct, and retaining them would let somebody who merely knows an email
 * lock out its owner. The existing IP limiter remains the primary control if
 * this additive in-process limiter has an unexpected error.
 */
export function signinFailureLimit(
  limiter: FailureLimiter = signinFailureLimiter,
): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    if (limiter.points <= 0 || c.req.method !== "POST" || !c.req.raw.body) return next();

    const parsed = await readEmail(c, FORM_OR_JSON_MEDIA_TYPES);
    if (parsed.kind !== "parsed" || !parsed.email) return next();

    const key = signinFailureKey(parsed.email);
    let reserved = false;
    try {
      await limiter.consume(key);
      reserved = true;
    } catch (result: unknown) {
      if (result instanceof RateLimiterRes) {
        setRateLimitHeaders(c, limiter, result);
        c.header("Retry-After", String(Math.ceil(result.msBeforeNext / 1000)));
        return c.json({ error: "Too many attempts. Please wait a moment and try again." }, 429);
      }
      console.error(
        `[rate-limit] signin-failure limiter error, failing open: (${errorKind(result)})`,
      );
    }

    let failed = false;
    try {
      await next();
      failed = await failedCredentialCheck(c);
    } finally {
      if (reserved && !failed) {
        try {
          await limiter.reward(key);
        } catch (error: unknown) {
          // A failed refund expires with the ordinary window. Do not replace a
          // downstream exception or transform a valid auth response here.
          console.error(`[rate-limit] signin-failure limiter refund error: (${errorKind(error)})`);
        }
      }
    }
  };
}

/** Limiter/storage errors can contain request or database details; never log them verbatim. */
function errorKind(error: unknown): string {
  return error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error;
}
