import type { Session } from "@ws-model-proxy/auth";
import type { Context, MiddlewareHandler } from "hono";
import { resolveClientIp } from "../../client-ip.js";
import { createRateLimiterMiddleware, realtimeUpgradeLimiter } from "../../rate-limit.js";
import { sessionMiddleware } from "../../session-middleware.js";
import { openAiErrorBody } from "../openai-errors.js";
import { checkDashboardSession } from "./dashboard-session.js";
import { dashboardRequester } from "./requester.js";
import {
  productionRealtimeDeps,
  type RealtimeEndpointDeps,
  type RealtimeVariables,
  readRealtimeQuery,
  realtimeUpgradeHandler,
} from "./websocket.js";

/**
 * `GET /api/internal/chat-test/realtime?intent=transcription[&model=…]`: the
 * Chat Test microphone panel's live transcription socket, signed in with the
 * dashboard session cookie instead of an API key (chunk 10).
 *
 * Everything after the upgrade is the `/v1/realtime` session: the same
 * events, caps, admission, locked send claim, routing, registry rechecks and
 * metering. Only the login and the requester differ, and the requester is the
 * HTTP Chat Test's: the session user, every model they can see, no token,
 * source `TEST`, and `chat-test:<userId>` as the per-credential cap key.
 *
 * Mounted behind the `/api/internal/chat-test/*` session middleware and RPC
 * limiter. Upgrade checks, in order: an upgrade request (426), not draining
 * (503), the per-IP upgrade limiter (429), an Origin among the dashboard's
 * own origins (403; a cross-site page cannot ride the cookie, CSWSH), the
 * query (400, a credential in the URL is refused), a Better Auth session
 * (401), its database row (exists, same user, unexpired; 401) for a user with
 * no active ban or pending deletion (403), the force-2FA policy (403), then
 * the session caps (429). No subprotocol is offered or selected.
 */

export const DASHBOARD_REALTIME_PATH = "/api/internal/chat-test/realtime";

export type DashboardRealtimeOptions = {
  /** The dashboard's own origins: the app URL and, split-origin, the web origin. */
  allowedOrigins: readonly string[];
  /** Tests replace the session read (the default is the cookie session). */
  readSession?: (c: Context) => Promise<Session | null>;
  /** Tests replace the session row check. */
  checkSession?: typeof checkDashboardSession;
};

function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/** The session the chat-test session middleware resolved, or a fresh read. */
async function cookieSession(c: Context): Promise<Session | null> {
  const existing = c.get("session") as Session | null | undefined;
  if (existing !== undefined) return existing;
  await sessionMiddleware(c, async () => undefined);
  return (c.get("session") as Session | null | undefined) ?? null;
}

function errorResponse(
  c: Context,
  status: 400 | 401 | 403 | 426 | 429 | 503,
  type: string,
  code: string,
  message: string,
) {
  return c.json(openAiErrorBody({ message, type, code }), status);
}

export function createDashboardRealtimeMiddleware(
  deps: RealtimeEndpointDeps,
  options: DashboardRealtimeOptions,
): MiddlewareHandler<{ Variables: RealtimeVariables }> {
  const allowed = new Set(
    options.allowedOrigins.map(originOf).filter((origin): origin is string => origin !== null),
  );
  const readSession = options.readSession ?? cookieSession;
  const checkSession = options.checkSession ?? checkDashboardSession;
  const rateLimit = createRateLimiterMiddleware(realtimeUpgradeLimiter, {
    resolveKey: (c) => `ip:${resolveClientIp(c)}`,
  });
  return async (c, next) => {
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
      return errorResponse(
        c,
        426,
        "invalid_request_error",
        "upgrade_required",
        "WebSocket upgrade required.",
      );
    }
    if (deps.relay.isDraining() || deps.registry.closing) {
      return errorResponse(
        c,
        503,
        "server_error",
        "server_shutting_down",
        "The server is shutting down.",
      );
    }
    const limited = await rateLimit(c, async () => undefined);
    if (limited instanceof Response) return limited;
    // Cross-site WebSocket hijacking: browsers always send Origin on a
    // WebSocket handshake, and only the dashboard's own pages may open this
    // one with the person's cookie.
    const origin = originOf(c.req.header("origin"));
    if (!origin || !allowed.has(origin)) {
      return errorResponse(
        c,
        403,
        "invalid_request_error",
        "origin_not_allowed",
        "Cross-site request blocked.",
      );
    }
    const query = readRealtimeQuery(c.req.url);
    if (!query.ok) return errorResponse(c, 400, "invalid_request_error", query.code, query.message);
    const session = await readSession(c);
    const userId = session?.user?.id;
    const sessionId = session?.session?.id;
    if (!userId || !sessionId) {
      return errorResponse(
        c,
        401,
        "invalid_request_error",
        "dashboard_session_required",
        "Sign in to the dashboard first.",
      );
    }
    let verdict: Awaited<ReturnType<typeof checkDashboardSession>>;
    try {
      verdict = await checkSession({ sessionId, userId });
    } catch (error) {
      console.error(
        "[realtime] dashboard session check failed",
        error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error,
      );
      return errorResponse(
        c,
        503,
        "server_error",
        "server_error",
        "The session could not be checked. Try again.",
      );
    }
    if (verdict === "ended") {
      return errorResponse(
        c,
        401,
        "invalid_request_error",
        "dashboard_session_ended",
        "Your dashboard session ended. Sign in again.",
      );
    }
    if (verdict === "blocked") {
      return errorResponse(
        c,
        403,
        "invalid_request_error",
        "access_denied",
        "This account cannot use models.",
      );
    }
    if (verdict === "two_factor_required") {
      return errorResponse(
        c,
        403,
        "invalid_request_error",
        "two_factor_required",
        "Two-factor authentication setup is required.",
      );
    }
    const requester = dashboardRequester(userId, sessionId);
    const admitted = deps.counters.acquire({
      tokenId: requester.limitKey,
      userId: requester.userId,
    });
    if (!admitted.ok) {
      return errorResponse(
        c,
        429,
        "invalid_request_error",
        "rate_limited",
        "Too many live transcription sessions.",
      );
    }
    c.set("realtimeAuth", { requester, admission: admitted.admission, model: query.model });
    try {
      await next();
    } finally {
      // As on /v1/realtime: a handler throw is recorded in `c.error`; no
      // socket will own the admission then. Release is idempotent.
      if (c.error) admitted.admission.release();
    }
  };
}

/** The production middleware and upgrade handler, sharing `/v1/realtime`'s deps. */
export function dashboardRealtimeRoutes(
  options: DashboardRealtimeOptions,
  deps: RealtimeEndpointDeps = productionRealtimeDeps(),
) {
  return {
    middleware: createDashboardRealtimeMiddleware(deps, options),
    handler: realtimeUpgradeHandler(deps),
  };
}
