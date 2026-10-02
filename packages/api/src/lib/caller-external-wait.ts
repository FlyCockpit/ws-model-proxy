import { z } from "zod";

/**
 * Per-request override for how long an `:external` caller waits on local
 * members before going external. Same bound as `ModelPool.externalAfterWaitMs`.
 */
export const EXTERNAL_AFTER_WAIT_HEADER = "x-wsmp-external-after-wait-ms";

/** Inclusive ceiling shared by the pool, token, and header. */
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
 * leaves the local queue. `poolExternalAfterWaitMs` is an owner floor:
 * callers (owners and grantees) may only lengthen via token or header, never
 * shorten below the floor. When `capacityWaitBudgetMs` is provided, the
 * result never exceeds that local wait budget (B). A missing token or
 * request override uses the pool floor.
 */
export function resolveCallerExternalAfterWaitMs(input: {
  poolExternalAfterWaitMs: number;
  tokenExternalAfterWaitMs?: number | null;
  requestExternalAfterWaitMs?: number | null;
  capacityWaitBudgetMs?: number | null;
}): number {
  const poolFloor = Math.max(0, input.poolExternalAfterWaitMs);
  const requested = input.requestExternalAfterWaitMs ?? input.tokenExternalAfterWaitMs ?? poolFloor;
  let result = Math.max(poolFloor, Math.max(0, requested));
  if (input.capacityWaitBudgetMs != null) {
    result = Math.min(result, Math.max(0, input.capacityWaitBudgetMs));
  }
  return result;
}
