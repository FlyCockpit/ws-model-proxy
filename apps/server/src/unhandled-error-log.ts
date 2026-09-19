import { authRouteLogPath } from "./request-log-redaction.js";

/**
 * app.onError log-argument decision (invariant 10 / L19, pass 10).
 *
 * EVERY path logs ONE sanitized line carrying the error's constructor
 * name only — no message, no stack. Prisma rejection messages embed SQL
 * + parameters, better-auth request-phase failures that escape
 * better-call's router catch bubble here with raw stacks, and the
 * pre-dispatch createContext failure path can reject with credential-
 * bearing errors on non-auth paths too. The pass-5 raw-stack branch for
 * non-auth paths is REMOVED (coordinator ruling, pass 10): no path
 * through app.onError can leak message or stack content. The raw-stack
 * diagnostics are traded away deliberately.
 *
 * Pass 13 (R42): the interpolated path is truncated for `/api/auth*`
 * requests via `authRouteLogPath` — auth route paths can carry live
 * credentials in deeper segments (`/api/auth/reset-password/<token>`).
 * The caller passes Hono's `c.req.path`, which never contains a query;
 * `authRouteLogPath` also strips a query defensively for auth paths.
 * Non-auth paths keep the full pathname unchanged.
 */

/** Console arguments for app.onError's `console.error` for one failure. */
export function unhandledErrorLogArgs(
  error: unknown,
  method: string,
  path: string,
  requestId: string,
): unknown[] {
  const name = error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error;
  const logPath = authRouteLogPath(path);
  return [`[server] [${requestId}] Unhandled error on ${method} ${logPath}: ${name}`];
}
