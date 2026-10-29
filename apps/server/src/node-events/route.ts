import type { Session } from "@ws-model-proxy/auth";
import type { Context, Handler } from "hono";
import { resolveClientIp } from "../client-ip.js";
import { checkDashboardSession } from "../model-api/realtime/dashboard-session.js";
import {
  createRateLimiterMiddleware,
  nodeEventsIpLimiter,
  nodeEventsUserLimiter,
  type RateLimiter,
} from "../rate-limit.js";
import { sessionMiddleware } from "../session-middleware.js";
import { type NodeEventHub, nodeEventHub } from "./hub.js";

/**
 * `GET /api/dashboard/events`: the signed-in tab's node event stream (./hub.ts), as
 * `text/event-stream`. Checks, in order: not draining (503), the per-IP limiter (429), the
 * request's origin (403), a Better Auth cookie session (401), the per-user limiter (429), the
 * stream caps (429), then the session row: it exists, belongs to the user and has not expired
 * (401), the user has no active ban or pending deletion (403), and the force-2FA policy (403).
 *
 * The browser's own client treats 401 and 403 as final and backs off on everything else.
 *
 * Origin: a browser sends `Origin` on a cross-origin request, and usually leaves it out of a
 * same-origin GET, so a missing one is allowed and a present one must be the dashboard's.
 * `Sec-Fetch-Site`, when sent, must not be `cross-site`. CORS already keeps another site from
 * reading the response; these refuse it before any work.
 */

export const NODE_EVENTS_PATH = "/api/dashboard/events";

export type NodeEventsRouteOptions = {
  /** The dashboard's own origins: the app URL and, split-origin, the web origin. */
  allowedOrigins: readonly string[];
  isDraining: () => boolean;
  hub?: NodeEventHub;
  /** Tests replace the session read (the default is the cookie session). */
  readSession?: (c: Context) => Promise<Session | null>;
  /** Tests replace the session row check. */
  checkSession?: typeof checkDashboardSession;
  ipLimiter?: RateLimiter;
  userLimiter?: RateLimiter;
};

function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

async function cookieSession(c: Context): Promise<Session | null> {
  const existing = c.get("session") as Session | null | undefined;
  if (existing !== undefined) return existing;
  await sessionMiddleware(c, async () => undefined);
  return (c.get("session") as Session | null | undefined) ?? null;
}

function refuse(c: Context, status: 401 | 403 | 429 | 503, error: string) {
  c.header("Cache-Control", "no-store");
  return c.json({ error }, status);
}

export function createNodeEventsHandler(options: NodeEventsRouteOptions): Handler {
  const hub = options.hub ?? nodeEventHub;
  const readSession = options.readSession ?? cookieSession;
  const checkSession = options.checkSession ?? checkDashboardSession;
  const allowed = new Set(
    options.allowedOrigins.map(originOf).filter((origin): origin is string => origin !== null),
  );
  const ipLimit = createRateLimiterMiddleware(options.ipLimiter ?? nodeEventsIpLimiter, {
    resolveKey: (c) => `ip:${resolveClientIp(c)}`,
  });
  const userLimit = createRateLimiterMiddleware(options.userLimiter ?? nodeEventsUserLimiter, {
    resolveKey: (c) => `user:${(c.get("session") as Session | null)?.user?.id ?? "anonymous"}`,
  });

  return async (c) => {
    if (options.isDraining()) return refuse(c, 503, "server_shutting_down");
    const ipLimited = await ipLimit(c, async () => undefined);
    if (ipLimited instanceof Response) return ipLimited;

    const originHeader = c.req.header("origin");
    if (originHeader !== undefined) {
      const origin = originOf(originHeader);
      if (!origin || !allowed.has(origin)) return refuse(c, 403, "origin_not_allowed");
    }
    if (c.req.header("sec-fetch-site")?.toLowerCase() === "cross-site")
      return refuse(c, 403, "origin_not_allowed");

    const session = await readSession(c);
    const userId = session?.user?.id;
    const sessionId = session?.session?.id;
    if (!session || !userId || !sessionId) return refuse(c, 401, "session_required");
    c.set("session", session);
    const userLimited = await userLimit(c, async () => undefined);
    if (userLimited instanceof Response) return userLimited;

    const reserved = hub.reserve({
      userId,
      sessionId,
      impersonatedBy: session.session.impersonatedBy ?? null,
    });
    if (!reserved.ok)
      return reserved.reason === "closing"
        ? refuse(c, 503, "server_shutting_down")
        : refuse(c, 429, "too_many_streams");

    let verdict: Awaited<ReturnType<typeof checkDashboardSession>>;
    try {
      verdict = await checkSession({ sessionId, userId });
    } catch (error) {
      hub.release(reserved.subscriber);
      console.error(
        "[node-events] session check failed",
        error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error,
      );
      return refuse(c, 503, "session_check_failed");
    }
    if (verdict !== "ok") {
      hub.release(reserved.subscriber);
      if (verdict === "ended") return refuse(c, 401, "session_ended");
      return refuse(c, 403, verdict === "blocked" ? "access_blocked" : "two_factor_required");
    }

    const stream = hub.activate(reserved.subscriber);
    // Ended while the row was read: a sign-out (401) or the shutdown (503).
    if (!stream) return refuse(c, options.isDraining() ? 503 : 401, "session_ended");
    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  };
}
