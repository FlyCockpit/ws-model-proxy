import { ORPCError } from "@orpc/server";
import type { Prisma } from "@ws-model-proxy/db";

export type CapacityLimitMode = "INHERIT" | "LIMITED" | "UNLIMITED";

/**
 * Serializes physical-capacity changes with every policy mutation for a target.
 * Callers must acquire pool row locks first (when applicable), then these locks
 * in sorted target-id order. This gives multi-target pool updates a stable order.
 */
export async function lockExecutionTargetPolicies(
  tx: Prisma.TransactionClient,
  executionTargetIds: readonly string[],
): Promise<void> {
  for (const targetId of [...new Set(executionTargetIds)].sort()) {
    await tx.$queryRaw`SELECT id FROM execution_target WHERE id = ${targetId} FOR UPDATE`;
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"capacity-policy:" + targetId}, 0))`;
  }
}

export function assertEffectiveConcurrencyPolicy(input: {
  hardLimit: number | null | undefined;
  poolLimit: number | null;
  poolReserved: number;
  memberMode?: CapacityLimitMode;
  memberLimit?: number | null;
  memberReserved?: number | null;
}): void {
  const effectiveLimit =
    input.memberMode === "LIMITED"
      ? input.memberLimit
      : input.memberMode === "UNLIMITED"
        ? null
        : input.poolLimit;
  const effectiveReserved = input.memberReserved ?? input.poolReserved;
  if (effectiveLimit != null && effectiveReserved > effectiveLimit)
    throw new ORPCError("BAD_REQUEST", {
      message: "Reserved slots exceed the effective concurrency limit.",
    });
  if (input.hardLimit == null) return;
  if (effectiveLimit != null && effectiveLimit > input.hardLimit)
    throw new ORPCError("BAD_REQUEST", {
      message: "Effective concurrency limit exceeds physical capacity.",
    });
  if (effectiveReserved > input.hardLimit)
    throw new ORPCError("BAD_REQUEST", {
      message: "Reserved slots exceed physical concurrency capacity.",
    });
}

export function assertEffectiveContextPolicy(input: {
  physicalMaxContext: number | null | undefined;
  poolCeiling: number | null;
  poolMargin: number;
  memberMode?: CapacityLimitMode;
  memberCeiling?: number | null;
  memberMargin?: number | null;
}): void {
  const ceiling =
    input.memberMode === "LIMITED"
      ? input.memberCeiling
      : input.memberMode === "UNLIMITED"
        ? null
        : input.poolCeiling;
  const margin = input.memberMargin ?? input.poolMargin;
  if (ceiling != null && margin >= ceiling)
    throw new ORPCError("BAD_REQUEST", {
      message: "Context margin must be smaller than the effective context ceiling.",
    });
  if (
    input.physicalMaxContext != null &&
    ceiling != null &&
    ceiling + margin > input.physicalMaxContext
  )
    throw new ORPCError("BAD_REQUEST", {
      message: "Effective context policy exceeds physical capacity.",
    });
}
