import {
  type GuardedPoolCreateFailureReason,
  isGuardedPoolCreateFailureReason,
} from "@ws-model-proxy/api/lib/guarded-pool-create-reasons";

/**
 * Extracts the machine-readable failure reason (`data.reason`) from a pool
 * mutation error. Never trusts the envelope shape and never reads
 * `error.message`.
 */
export function poolMutationFailureReason(error: unknown): GuardedPoolCreateFailureReason | null {
  if (!error || typeof error !== "object") return null;
  const { data } = error as { data?: unknown };
  if (!data || typeof data !== "object") return null;
  const { reason } = data as { reason?: unknown };
  return isGuardedPoolCreateFailureReason(reason) ? reason : null;
}
