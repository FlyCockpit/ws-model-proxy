/**
 * Machine-readable failure reasons for `createGuardedModelPool`.
 *
 * These codes are a stable contract shared between the API server and the web
 * wizard: the server attaches them as `data.reason` on every ORPCError thrown
 * from a guarded-pool-create path, and the client maps them (defensively, via
 * {@link isGuardedPoolCreateFailureReason}) to curated locale copy. Never
 * rename or reuse an existing code; add new codes at the end instead.
 */
export const guardedPoolCreateFailureReasons = Object.freeze([
  "PROVIDER_EGRESS_DISABLED",
  "LOSSY_COLLAPSE_REQUIRES_ADAPTATION",
  "POOL_POLICY_INVALID",
  "SLUG_INVALID",
  "SLUG_TAKEN",
  "LOCAL_MODEL_UNAVAILABLE",
  "PROVIDER_NOT_READY",
  "SURFACE_NOT_SUPPORTED",
  "LOCAL_CAPACITY_REQUIRED",
  "MEMBER_OVERRIDE_MISMATCH",
  "RESERVED_EXCEEDS_CONCURRENCY",
  "CONCURRENCY_EXCEEDS_PHYSICAL",
  "CONTEXT_EXCEEDS_PHYSICAL",
  "PROVIDER_CONTEXT_EXCEEDED",
  "CONTEXT_MARGIN_EXCEEDS_CEILING",
  "RESERVED_EXCEEDS_PHYSICAL",
] as const);

export type GuardedPoolCreateFailureReason = (typeof guardedPoolCreateFailureReasons)[number];

const reasonValues: ReadonlySet<string> = new Set<string>(guardedPoolCreateFailureReasons);

export function isGuardedPoolCreateFailureReason(
  value: unknown,
): value is GuardedPoolCreateFailureReason {
  return typeof value === "string" && reasonValues.has(value);
}
