import { z } from "zod";

/**
 * Per-request override for how long an `:external` caller waits on local
 * members before going external. Same bound as `ModelPool.externalAfterWaitMs`.
 */
export const EXTERNAL_AFTER_WAIT_HEADER = "x-wsmp-external-after-wait-ms";

/** Inclusive ceiling shared by the pool, token, header, and MCP argument. */
export const EXTERNAL_AFTER_WAIT_MS_MAX = 600_000;

export const externalAfterWaitMsSchema = z.number().int().min(0).max(EXTERNAL_AFTER_WAIT_MS_MAX);

/**
 * Parse a header string or MCP number. Invalid or empty values are omitted
 * (the caller then uses the token setting, or the pool default).
 */
export function parseExternalAfterWaitMs(
  value: string | number | null | undefined,
): number | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) return undefined;
    return Math.min(value, EXTERNAL_AFTER_WAIT_MS_MAX);
  }
  const trimmed = value.trim();
  if (!/^(0|[1-9]\d*)$/.test(trimmed)) return undefined;
  return Math.min(Number(trimmed), EXTERNAL_AFTER_WAIT_MS_MAX);
}

/**
 * Effective local wait before an `:external` caller with an external plan
 * leaves the local queue. Never exceeds the pool cap. A missing token or
 * request override uses the next wider cap (token, then pool). Grantees may
 * only lengthen relative to the pool value, so a shorter token/header is
 * ignored on a shared pool.
 */
export function resolveCallerExternalAfterWaitMs(input: {
  poolExternalAfterWaitMs: number;
  tokenExternalAfterWaitMs?: number | null;
  requestExternalAfterWaitMs?: number | null;
  isPoolOwner: boolean;
}): number {
  const poolCap = Math.max(0, input.poolExternalAfterWaitMs);
  const tokenCap =
    input.tokenExternalAfterWaitMs == null
      ? poolCap
      : Math.min(Math.max(0, input.tokenExternalAfterWaitMs), poolCap);
  const requested =
    input.requestExternalAfterWaitMs == null
      ? tokenCap
      : Math.min(Math.max(0, input.requestExternalAfterWaitMs), tokenCap);
  return input.isPoolOwner ? requested : Math.max(requested, poolCap);
}
