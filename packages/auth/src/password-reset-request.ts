import { z } from "zod";

/**
 * Uniform `/request-password-reset` (account-enumeration defense).
 *
 * Better Auth's own endpoint answers alike in body but not in behaviour: an unknown address does
 * a lookup plus a dummy read, a known one inserts a reset token, so timing and any database
 * failure (500 only for real accounts) can reveal whether an account exists.
 *
 * This handler sits in front of Better Auth's HTTP handler, after the app's limiters. It does
 * the account-independent checks itself (body shape, Origin/Referer against the trusted
 * origins, `redirectTo`), then forwards the ORIGINAL request to Better Auth's real HTTP handler,
 * so Better Auth's built-in rate limiter (3/min per IP on this route) still applies. Whatever
 * Better Auth answers after that, the caller gets the same 200 and body, padded to a fixed floor
 * (`PASSWORD_RESET_RESPONSE_FLOOR_MS`) from the start of the request, so lookup, token insert
 * and failure cannot be told apart by timing. Failures are logged by status only.
 *
 * Passed through unchanged: Better Auth's own 429 (its limiter runs before the endpoint and is
 * keyed on the client IP, so it is the same for every address) and the refusals Better Auth
 * makes before any account work (reset disabled without SMTP, no body, non-JSON: `null`, the
 * caller forwards).
 *
 * Accepted residual: if the account work ever takes longer than the floor (a very slow
 * database), the answer comes as soon as it is done, so that rare case is not padded.
 *
 * The reset mail is sent without being awaited (`sendResetPassword` in ./password-reset.ts),
 * so SMTP latency never reaches the response; mail volume is bounded by the per-IP and
 * per-recipient limits in front.
 */

export const PASSWORD_RESET_REQUEST_PATH = "/api/auth/request-password-reset";

/** Better Auth's own reply, verbatim. */
export const PASSWORD_RESET_REQUESTED_MESSAGE =
  "If this email exists in our system, check your email for the reset link";

const bodySchema = z.object({
  email: z.email(),
  redirectTo: z.string().optional(),
});

/** better-call's JSON media-type test. */
const JSON_CONTENT_TYPE_RE = /^application\/([a-z0-9.+-]*\+)?json/i;

export interface PasswordResetRequestAuth {
  options: { emailAndPassword?: { sendResetPassword?: unknown } };
  $context: Promise<{
    isTrustedOrigin(url: string, settings?: { allowRelativePaths: boolean }): boolean;
  }>;
}

function refusal(status: 400 | 403, code: string, message: string): Response {
  return Response.json({ code, message }, { status });
}

type CheckResult =
  | { kind: "fallthrough" }
  | { kind: "refuse"; response: Response }
  | { kind: "ok" };

/**
 * The account-independent checks: body shape, Origin/Referer, `redirectTo`. "fallthrough" is
 * what Better Auth refuses itself before any account work (not this route, reset disabled
 * without SMTP, no body, non-JSON).
 */
async function checkPasswordResetRequest(
  auth: PasswordResetRequestAuth,
  request: Request,
): Promise<CheckResult> {
  const fallthrough = { kind: "fallthrough" } as const;
  const refuse = (status: 400 | 403, code: string, message: string) =>
    ({ kind: "refuse", response: refusal(status, code, message) }) as const;
  if (request.method !== "POST") return fallthrough;
  // Better Auth serves this endpoint at the exact path only (no trailing-slash or case variants).
  if (new URL(request.url).pathname !== PASSWORD_RESET_REQUEST_PATH) return fallthrough;
  // Without `sendResetPassword` Better Auth answers RESET_PASSWORD_DISABLED for everyone.
  if (!auth.options?.emailAndPassword?.sendResetPassword) return fallthrough;
  if (!request.body) return fallthrough;
  const mediaType = (request.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
  if (!JSON_CONTENT_TYPE_RE.test(mediaType)) return fallthrough;

  let raw: unknown;
  try {
    raw = await request.clone().json();
  } catch {
    return refuse(400, "VALIDATION_ERROR", "Invalid JSON body");
  }
  const body = bodySchema.safeParse(raw);
  if (!body.success) return refuse(400, "VALIDATION_ERROR", "Invalid email");

  const context = await auth.$context;
  // CSRF: a browser-sent Origin (or Referer) must be trusted; with cookies one is required.
  const origin = request.headers.get("origin") || request.headers.get("referer") || "";
  if (origin === "null" || (!origin && request.headers.has("cookie"))) {
    return refuse(403, "MISSING_OR_NULL_ORIGIN", "Missing or null Origin");
  }
  if (origin && !context.isTrustedOrigin(origin)) {
    return refuse(403, "INVALID_ORIGIN", "Invalid origin");
  }
  const { redirectTo } = body.data;
  if (redirectTo && !context.isTrustedOrigin(redirectTo, { allowRelativePaths: true })) {
    return refuse(403, "INVALID_REDIRECT_URL", "Invalid redirectURL");
  }
  return { kind: "ok" };
}

/**
 * The same checks as a stand-alone step, for apps/server to mount BEFORE the per-recipient cap:
 * a request refused here (400/403) never spends an address's hourly budget. Returns the refusal,
 * or null to continue. The handler repeats the checks (cheap), so it is safe on its own.
 */
export function createPasswordResetRequestValidator(auth: PasswordResetRequestAuth) {
  return async (request: Request): Promise<Response | null> => {
    const checked = await checkPasswordResetRequest(auth, request);
    return checked.kind === "refuse" ? checked.response : null;
  };
}

/** Every response that reached account work is answered no sooner than this after the request started. */
export const PASSWORD_RESET_RESPONSE_FLOOR_MS = 750;

export interface PasswordResetRequestHandlerOptions {
  floorMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The handler returns null to fall through (the caller forwards to Better Auth as usual), or the
 * response to send. `forward` is how the caller reaches Better Auth's HTTP handler (apps/server
 * adds the resolved client IP, which Better Auth's limiter keys on).
 */
export function createPasswordResetRequestHandler(
  auth: PasswordResetRequestAuth,
  {
    floorMs = PASSWORD_RESET_RESPONSE_FLOOR_MS,
    now = Date.now,
    sleep = defaultSleep,
  }: PasswordResetRequestHandlerOptions = {},
) {
  return async (
    request: Request,
    forward: (request: Request) => Promise<Response>,
  ): Promise<Response | null> => {
    const startedAt = now();
    const checked = await checkPasswordResetRequest(auth, request);
    if (checked.kind === "fallthrough") return null;
    if (checked.kind === "refuse") return checked.response;

    let upstream: Response | null = null;
    try {
      upstream = await forward(request);
    } catch (error) {
      console.error(
        "[auth] password reset request failed:",
        error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error,
      );
    }
    // Better Auth's own limiter: IP-keyed and decided before the endpoint runs.
    if (upstream?.status === 429) return upstream;
    if (upstream && !upstream.ok) {
      console.error("[auth] password reset request failed:", `status ${upstream.status}`);
    }
    const remaining = floorMs - (now() - startedAt);
    if (remaining > 0) await sleep(remaining);
    return Response.json({ status: true, message: PASSWORD_RESET_REQUESTED_MESSAGE });
  };
}
