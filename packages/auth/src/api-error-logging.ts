import { isAPIError } from "better-auth/api";

/**
 * Sanitized Better Auth API-error logging (invariant 10, L19).
 *
 * Better Auth 1.7.3 exposes a top-level `onAPIError: { onError? }` option
 * (consumed in better-auth dist/api/index.mjs: when `onError` is provided it
 * REPLACES the default error logging entirely — including the default path
 * that logs `e.message` wholesale for Prisma-shaped "column"/"table"/
 * "relation"/"does not exist" errors). This module is that replacement: it
 * decides, for one error handed to the handler, whether ONE sanitized line
 * is warranted and what it says — mirroring the sanitizedGrantStorage
 * pattern in mcp-grant.ts: error constructor name only, never the message,
 * meta, stack, query, or params.
 *
 * - Non-APIError exceptions (the unanticipated-fault class): one sanitized
 *   line. These are the errors whose raw form is the leakiest (Prisma
 *   rejections carry queries/params in messages).
 * - APIError with statusCode >= 500: one sanitized line. The error body
 *   can echo attacker-influenced input, so it stays untapped. The
 *   classifier uses the ALWAYS-NUMERIC `statusCode` field (the installed
 *   APIError computes it for both numeric and symbolic constructors) —
 *   the symbolic `status` field alone would miss every 5xx that better
 *   call expresses as a number or a non-INTERNAL_SERVER_ERROR symbol.
 * - Other APIErrors (4xx): no error-log at all — they are protocol answers
 *   (invalid scope/client/redirect …), not server faults. FOUND (302)
 *   redirects never even reach the handler: better-auth returns early for
 *   them before calling onError.
 *
 * Pure decision function: the caller in index.ts only logs the returned
 * line. No response or behavior change — APIError responses are produced by
 * better-auth's router exactly as before.
 */

/** The single sanitized console.error line for an auth API error, or null
 * when the error must NOT be error-logged (4xx protocol answers). */
export function sanitizedApiErrorLogLine(error: unknown): string | null {
  if (isAPIError(error)) {
    if (error.statusCode >= 500) {
      return `[auth] API error (${error.statusCode}): ${error.constructor.name}`;
    }
    return null;
  }
  const name = error instanceof Error ? error.constructor.name : typeof error;
  return `[auth] unhandled error: ${name}`;
}
