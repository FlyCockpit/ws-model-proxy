import { ORPCError } from "@orpc/server";
import type { Prisma } from "@ws-model-proxy/db";
import { z } from "zod";

export type CapacityLimitMode = "INHERIT" | "LIMITED" | "UNLIMITED";

export type ModelPoolCapacityPolicyInput = {
  capacityPriority?: number;
  capacityConcurrencyLimit?: number | null;
  capacityReservedSlots?: number;
  capacityBorrowPolicy?: "NEVER" | "WHEN_IDLE";
  capacityWaitBudgetMs?: number | null;
  capacityContextCeiling?: number | null;
  capacityContextMargin?: number;
};

/** Input shape shared by every public ModelPool capacity-policy writer. */
export const modelPoolCapacityPolicyFields = {
  capacityPriority: z.number().int().min(0).max(31).optional(),
  capacityConcurrencyLimit: z.number().int().positive().max(10_000).nullable().optional(),
  capacityReservedSlots: z.number().int().min(0).max(10_000).optional(),
  capacityBorrowPolicy: z.enum(["NEVER", "WHEN_IDLE"]).optional(),
  capacityWaitBudgetMs: z.number().int().min(0).max(600_000).nullable().optional(),
  capacityContextCeiling: z.number().int().positive().max(100_000_000).nullable().optional(),
  capacityContextMargin: z.number().int().min(0).max(10_000_000).optional(),
};

export function assertCapacityManagementEnabled(capacityEnabled: boolean): void {
  if (!capacityEnabled)
    throw new ORPCError("NOT_FOUND", {
      message: "Capacity management is disabled for this deployment.",
    });
}

export function assertModelPoolCapacityPolicy(input: {
  concurrencyLimit: number | null | undefined;
  reservedSlots: number | undefined;
  contextCeiling: number | null | undefined;
  contextMargin: number | undefined;
}): void {
  const reserved = input.reservedSlots ?? 0;
  const margin = input.contextMargin ?? 0;
  if (input.concurrencyLimit != null && reserved > input.concurrencyLimit)
    throw new ORPCError("BAD_REQUEST", {
      message: "Reserved slots exceed the pool concurrency limit.",
    });
  if (input.contextCeiling != null && margin >= input.contextCeiling)
    throw new ORPCError("BAD_REQUEST", {
      message: "Pool context margin must be smaller than the context ceiling.",
    });
}

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
    // pg_advisory_xact_lock returns PostgreSQL void, which Prisma's pg adapter
    // cannot deserialize through $queryRaw. Execute it for its side effect.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"capacity-policy:" + targetId}, 0))`;
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
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"execution-target:" + identity}, 0))`;
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

/**
 * Acquires model-pool then execution-target policy locks and validates every
 * member's effective policy against the proposed pool policy. This is the
 * shared path for writes to an existing ModelPool; callers perform their
 * write in this transaction after this function returns.
 */
export async function lockAndValidateModelPoolCapacityPolicy(
  tx: Prisma.TransactionClient,
  input: {
    modelPoolId: string;
    userId: string;
    policy: ModelPoolCapacityPolicyInput;
    notFound: () => never;
  },
): Promise<void> {
  const candidate = await tx.modelPool.findUnique({
    where: { id: input.modelPoolId },
    select: {
      userId: true,
      PoolMembers: { select: { executionTargetId: true } },
    },
  });
  if (!candidate || candidate.userId !== input.userId) return input.notFound();

  // Lock order is model pool, then sorted execution targets. Keep this before
  // re-reading the policy and members so concurrent attachments cannot bypass
  // the effective-policy checks below.
  await tx.$queryRaw`SELECT id FROM model_pool WHERE id = ${input.modelPoolId} AND "userId" = ${input.userId} FOR UPDATE`;
  await lockExecutionTargetPolicies(
    tx,
    candidate.PoolMembers.flatMap((member) =>
      member.executionTargetId ? [member.executionTargetId] : [],
    ),
  );
  const pool = await tx.modelPool.findUnique({
    where: { id: input.modelPoolId },
    select: {
      userId: true,
      capacityConcurrencyLimit: true,
      capacityReservedSlots: true,
      capacityContextCeiling: true,
      capacityContextMargin: true,
      PoolMembers: {
        select: {
          capacityConcurrencyMode: true,
          capacityConcurrencyLimit: true,
          capacityReservedSlots: true,
          capacityContextCeilingMode: true,
          capacityContextCeiling: true,
          capacityContextMargin: true,
          ExecutionTarget: {
            select: {
              InferenceCapacity: {
                select: { hardConcurrencyLimit: true, physicalMaxContext: true },
              },
            },
          },
        },
      },
    },
  });
  if (!pool || pool.userId !== input.userId) return input.notFound();

  assertModelPoolCapacityPolicy({
    concurrencyLimit:
      input.policy.capacityConcurrencyLimit !== undefined
        ? input.policy.capacityConcurrencyLimit
        : pool.capacityConcurrencyLimit,
    reservedSlots: input.policy.capacityReservedSlots ?? pool.capacityReservedSlots,
    contextCeiling:
      input.policy.capacityContextCeiling !== undefined
        ? input.policy.capacityContextCeiling
        : pool.capacityContextCeiling,
    contextMargin: input.policy.capacityContextMargin ?? pool.capacityContextMargin,
  });

  for (const member of pool.PoolMembers) {
    assertEffectiveConcurrencyPolicy({
      hardLimit: member.ExecutionTarget?.InferenceCapacity?.hardConcurrencyLimit,
      poolLimit:
        input.policy.capacityConcurrencyLimit !== undefined
          ? input.policy.capacityConcurrencyLimit
          : pool.capacityConcurrencyLimit,
      poolReserved: input.policy.capacityReservedSlots ?? pool.capacityReservedSlots,
      memberMode: member.capacityConcurrencyMode,
      memberLimit: member.capacityConcurrencyLimit,
      memberReserved: member.capacityReservedSlots,
    });
    assertEffectiveContextPolicy({
      physicalMaxContext: member.ExecutionTarget?.InferenceCapacity?.physicalMaxContext,
      poolCeiling:
        input.policy.capacityContextCeiling !== undefined
          ? input.policy.capacityContextCeiling
          : pool.capacityContextCeiling,
      poolMargin: input.policy.capacityContextMargin ?? pool.capacityContextMargin,
      memberMode: member.capacityContextCeilingMode,
      memberCeiling: member.capacityContextCeiling,
      memberMargin: member.capacityContextMargin,
    });
  }
}
