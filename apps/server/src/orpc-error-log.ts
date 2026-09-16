import { ORPCError } from "@orpc/server";

/**
 * Shared oRPC error logger (invariant 10 / L19, pass 11 — R37/R38).
 * Installed as an `onError` interceptor on BOTH the OpenAPI and RPC
 * handlers, so everything it receives is a HANDLED error that never
 * reaches Hono's sanitized `app.onError` — this sink must sanitize
 * itself.
 *
 * Policy:
 * - Expected client errors (4xx ORPCErrors like UNAUTHORIZED /
 *   NOT_FOUND / METHOD_NOT_SUPPORTED) are skipped so logs only contain
 *   real problems.
 * - Transient 5xx codes (502/503/504 — usually upstream infra blipping)
 *   log at warn so they don't pollute error dashboards.
 * - ORPCError (app-authored safe message — routers throw these with
 *   operator-written user-facing text): log code + message + ctor name
 *   ONLY, never a stack.
 * - Unknown Errors (Prisma etc., whose messages embed SQL + params and
 *   whose stacks embed both): log the constructor name ONLY — no
 *   message, no stack.
 * - Non-Error rejections: typeof label only, never the value.
 */
export function logOrpcError(error: unknown) {
  if (error instanceof ORPCError && error.status < 500) {
    return;
  }
  const isTransient5xx = error instanceof ORPCError && error.status > 500;
  const log = isTransient5xx ? console.warn : console.error;
  if (error instanceof ORPCError) {
    // App-authored safe message: message + ctor name, NO stack (a
    // stack would embed the throwing site's internals).
    log(`[orpc] ${error.constructor?.name ?? "ORPCError"} ${error.code}: ${error.message}`);
    return;
  }
  if (error instanceof Error) {
    // Unknown Error (Prisma-shaped etc.) — ctor name only. Messages
    // embed SQL + credential material; stacks embed both.
    log(`[orpc] unhandled error (${error.constructor?.name ?? "Error"})`);
    return;
  }
  log(`[orpc] non-Error rejection (${typeof error})`);
}
