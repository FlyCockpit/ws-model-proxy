import type { Context, Next } from "hono";
import { RateLimiterRes } from "rate-limiter-flexible";
import { emailRateLimitKey, emailRecipientLimiter } from "./rate-limit.js";

/**
 * Anonymous Better-Auth endpoints that mail a caller-supplied address.
 *
 * Both take `{ email }` in the POST body and are reachable with no
 * session, which is what makes them usable as a mail cannon aimed at someone
 * else's inbox. `/change-email` also sends mail but requires a session and
 * mails the address the *authenticated user* nominated, so it is covered by
 * the per-user auth limiter instead and is deliberately absent here.
 *
 * Matched as exact paths rather than a prefix so a future endpoint doesn't get
 * silently swept in with an `email` field that means something else.
 */
export const EMAIL_RECIPIENT_PATHS = [
  "/api/auth/send-verification-email",
  "/api/auth/request-password-reset",
] as const;

/**
 * Enabling a Better-Auth plugin that mails a caller-supplied address means
 * adding its path above. The list is exact-match, so a plugin route is
 * unprotected until it is named here — and the plugin's own rate limiting is
 * IP-keyed, which is the control rotating IPs defeat.
 *
 * The one to know about is `emailOTP` (not enabled here — see
 * `packages/auth/src/index.ts` for the plugins that are). It adds FOUR
 * anonymous recipient-controlled mailers, none of which match anything above:
 *
 *   /api/auth/sign-in/email-otp
 *   /api/auth/forget-password/email-otp
 *   /api/auth/email-otp/send-verification-otp
 *   /api/auth/email-otp/request-password-reset
 *
 * Its `/email-otp/request-email-change` is NOT one of them: like `/change-email`
 * it requires a session, so the per-user auth limiter covers it.
 */

/**
 * Signup is the third recipient-controlled mail path, held separately because
 * it gets its own (higher) budget — see `signupRecipientLimiter`. It is NOT in
 * the list above: sharing one bucket would let a signup flood consume the
 * budget a legitimate user needs to reset their own password.
 */
export const SIGNUP_RECIPIENT_PATH = "/api/auth/sign-up/email";

/**
 * Rate limit the anonymous send-mail endpoints by RECIPIENT, not by caller.
 *
 * Mount this *after* the IP-keyed `authLimiter` — that one is the primary
 * security control; this is the anti-abuse layer on top.
 *
 * Why a 429 here does NOT leak account existence: the counter is driven purely
 * by how many times *someone asked* for this address, never by whether an
 * account exists or is already verified.
 */
/**
 * The middleware needs only these two members, so it asks for only these two —
 * both `emailRecipientLimiter` and `signupRecipientLimiter` satisfy it, and a
 * test can supply a plain object without casting through `unknown`.
 */
type RecipientLimiter = {
  readonly points: number;
  consume(key: string): Promise<unknown>;
};

/**
 * Media types Better-Auth accepts on a given path, which this middleware must
 * match EXACTLY — see `readEmail` for why both directions of a mismatch hurt.
 *
 * better-call resolves `handler.options.metadata?.allowedMediaTypes ||
 * config?.allowedMediaTypes`. Better-Auth sets a global
 * `allowedMediaTypes: ["application/json"]`, so JSON-only is the default for
 * every route; `/sign-up/email` is the exception that widens it.
 * Note multipart is accepted by NO route here, which is why we never parse it.
 */
const JSON_ONLY = ["application/json"] as const;
export const SIGNUP_MEDIA_TYPES = [
  "application/x-www-form-urlencoded",
  "application/json",
] as const;

export function emailRecipientLimit(
  limiter: RecipientLimiter = emailRecipientLimiter,
  allowedMediaTypes: readonly string[] = JSON_ONLY,
) {
  return async (c: Context, next: Next) => {
    // Disabled → no work at all.
    if (limiter.points <= 0) return next();

    // No body at all: better-call returns early before it ever looks at the
    // media type, so Better-Auth answers with its own 400 validation error.
    // Mirror that — a bodyless POST names no recipient and must not 415.
    if (!c.req.raw.body) return next();

    const parsed = await readEmail(c, allowedMediaTypes);
    // A media type Better-Auth would refuse. It answers 415 here itself,
    // so returning 415 changes nothing the caller sees — it just means we
    // never consume a point for a request that was never going to send mail.
    if (parsed.kind === "unsupported") {
      return c.json({ error: "Unsupported content type." }, 415);
    }
    // Parsed fine but carries no usable `email`: let Better-Auth return its own
    // validation error. Consuming a point for a well-formed request that names
    // no recipient would let a malformed-request flood burn a real address's
    // budget without ever mailing anyone.
    if (!parsed.email) return next();
    const email = parsed.email;

    try {
      await limiter.consume(emailRateLimitKey(email));
    } catch (result: unknown) {
      if (result instanceof RateLimiterRes) {
        const retryAfter = Math.ceil(result.msBeforeNext / 1000);
        c.header("Retry-After", String(retryAfter));
        return c.json(
          { error: "Too many emails requested for this address. Please try again later." },
          429,
        );
      }
      // Store error → fail OPEN. The IP limiter still guards this route.
      console.error("[rate-limit] email-recipient limiter error, failing open:", result);
    }

    return next();
  };
}

type ParsedRecipient =
  /** Body understood; `email` is the recipient if the body named a usable one. */
  | { kind: "parsed"; email: string | null }
  /** Body in a format we do not decode — cannot be rate limited, so refuse it. */
  | { kind: "unsupported" };

/** better-call's JSON test, verbatim. */
const JSON_CONTENT_TYPE_RE = /^application\/([a-z0-9.+-]*\+)?json/i;

/**
 * Pull `email` out of the request body without consuming the request stream.
 *
 * `.clone()` is load-bearing: the auth handler is invoked as
 * `auth.handler(c.req.raw)` further down the chain, and reading the original
 * body here would hand it a spent stream.
 *
 * This MUST classify a request exactly as better-call does, because BOTH
 * directions of a mismatch are bugs:
 *
 *   - Too permissive → we consume a point for a request Better-Auth then
 *     rejects. No mail is sent, but the victim's budget is spent anyway.
 *   - Too restrictive → we skip a request Better-Auth goes on to honour.
 *     That is a full bypass of this limiter.
 *
 * Match on the media type's BASE (`split(";")[0]`), not a substring of the
 * whole header — a loose `includes("application/json")` reopens a bypass via
 * charset parameters.
 */
async function readEmail(
  c: Context,
  allowedMediaTypes: readonly string[],
): Promise<ParsedRecipient> {
  const header = c.req.header("content-type")?.toLowerCase() ?? "";
  const base = header.split(";")[0]?.trim() ?? "";

  // Same acceptance test better-call applies before it parses anything.
  const allowed = allowedMediaTypes.some((type) => {
    const normalized = type.toLowerCase().trim();
    return base === normalized || base.includes(normalized);
  });
  if (!allowed) return { kind: "unsupported" };

  const pick = (value: unknown): ParsedRecipient => ({
    kind: "parsed",
    email: typeof value === "string" && value.trim() !== "" ? value : null,
  });

  try {
    if (JSON_CONTENT_TYPE_RE.test(base)) {
      const body = (await c.req.raw.clone().json()) as { email?: unknown };
      return pick(body?.email);
    }
    if (base === "application/x-www-form-urlencoded") {
      const form = await c.req.raw.clone().formData();
      return pick(form.get("email")?.toString());
    }
  } catch {
    // Allowed media type, unparseable payload. Better-Auth rejects this too,
    // so treat it as a request that named no recipient.
    return { kind: "parsed", email: null };
  }

  return { kind: "parsed", email: null };
}
