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

/**
 * Fences target discovery/creation before a row exists. Call this before
 * touching the execution target, then lock the target row, and only then lock
 * or create its physical capacity. Provider-model identities use the same key
 * in every management path.
 */
export async function lockExecutionTargetIdentities(
  tx: Prisma.TransactionClient,
  identities: readonly string[],
): Promise<void> {
  for (const identity of [...new Set(identities)].sort())
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"execution-target:" + identity}, 0))`;
}

export function assertDirectCapacityPolicy(input: {
  hardLimit: number | null | undefined;
  concurrencyLimit: number | null | undefined;
  reservedSlots: number | null | undefined;
  physicalMaxContext: number | null | undefined;
  contextCeiling: number | null | undefined;
  contextMargin: number | null | undefined;
}): void {
  const reserved = input.reservedSlots ?? 0;
  const margin = input.contextMargin ?? 0;
  if (input.concurrencyLimit != null && reserved > input.concurrencyLimit)
    throw new ORPCError("BAD_REQUEST", {
      message: "Reserved slots exceed the direct concurrency limit.",
    });
  if (input.hardLimit != null) {
    if (input.concurrencyLimit != null && input.concurrencyLimit > input.hardLimit)
      throw new ORPCError("BAD_REQUEST", {
        message: "Direct concurrency limit exceeds physical capacity.",
      });
    if (reserved > input.hardLimit)
      throw new ORPCError("BAD_REQUEST", {
        message: "Direct reserved slots exceed physical concurrency capacity.",
      });
  }
  if (input.contextCeiling != null && margin >= input.contextCeiling)
    throw new ORPCError("BAD_REQUEST", {
      message: "Direct context margin must be smaller than the context ceiling.",
    });
  if (
    input.physicalMaxContext != null &&
    input.contextCeiling != null &&
    input.contextCeiling + margin > input.physicalMaxContext
  )
    throw new ORPCError("BAD_REQUEST", {
      message: "Direct context policy exceeds physical capacity.",
    });
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
