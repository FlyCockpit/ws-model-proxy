import { ORPCError } from "@orpc/server";
import type { Prisma } from "@ws-model-proxy/db";
import { acquireFences, fences } from "@ws-model-proxy/db/capacity-lock-order";
import { z } from "zod";
import type { GuardedPoolCreateFailureReason } from "./guarded-pool-create-reasons";

export type CapacityLimitMode = "INHERIT" | "LIMITED" | "UNLIMITED";

/** Input-key names reported in `data.fields` for pool policy rejections. */
export type PoolPolicyFieldNames = {
  reservedSlots: string;
  concurrencyLimit: string;
  contextMargin: string;
  contextCeiling: string;
};

export const DEFAULT_POOL_POLICY_FIELDS: PoolPolicyFieldNames = {
  reservedSlots: "capacityReservedSlots",
  concurrencyLimit: "capacityConcurrencyLimit",
  contextMargin: "capacityContextMargin",
  contextCeiling: "capacityContextCeiling",
};

/** Guarded pool create input keys (#200). */
export const GUARDED_CREATE_POLICY_FIELDS: PoolPolicyFieldNames = {
  reservedSlots: "reservedSlots",
  concurrencyLimit: "memberConcurrencyLimit",
  contextMargin: "advanced.contextMargin",
  contextCeiling: "memberContextCeiling",
};

function namedPolicyFields(
  fields: readonly string[],
  names: PoolPolicyFieldNames = DEFAULT_POOL_POLICY_FIELDS,
): string[] {
  const map: Record<string, string> = {
    capacityReservedSlots: names.reservedSlots,
    capacityConcurrencyLimit: names.concurrencyLimit,
    capacityContextMargin: names.contextMargin,
    capacityContextCeiling: names.contextCeiling,
  };
  return fields.map((field) => map[field] ?? field);
}

/**
 * Optional, caller-supplied machine-readable failure reasons. Shared helpers
 * stay generic for their other callers; procedures that surface curated
 * failure copy (guarded pool create) pass their reason codes in so the thrown
 * ORPCError carries `data.reason`. Omitting a reason omits `data.reason`.
 * Every rejection still carries `data.fields` naming the input keys (#200).
 */
export type CapacityPolicyFailureReasons = {
  reservedExceeds?: GuardedPoolCreateFailureReason;
  reservedExceedsPhysical?: GuardedPoolCreateFailureReason;
  concurrencyExceedsPhysical?: GuardedPoolCreateFailureReason;
};

export type EffectiveContextPolicyFailureReasons = {
  marginExceedsCeiling?: GuardedPoolCreateFailureReason;
  exceedsPhysical?: GuardedPoolCreateFailureReason;
};

/**
 * Argument-shaped policy rejection. `fields` are the input keys a caller can
 * change; MCP keeps only the names that tool advertises (#200). `reason`
 * stays the optional guarded-create code.
 */
function rejectPolicy(
  message: string,
  fields: readonly string[],
  reason?: GuardedPoolCreateFailureReason,
): never {
  throw new ORPCError("BAD_REQUEST", {
    message,
    data: {
      ...(reason === undefined ? {} : { reason }),
      fields: [...fields],
    },
  });
}

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

/**
 * Saturation S-A cache-holder wait on a pool: null = automatic (re-prefill time
 * of the matched prefix, 2 s until the holder's prefill speed is measured),
 * 0 = off, otherwise fixed milliseconds. Capped at 30 s (owner decision S4).
 * A routing preference, not a capacity limit: it takes no capacity locks.
 */
export const cacheHolderWaitMsSchema = z.number().int().min(0).max(30_000).nullable().optional();

export function assertModelPoolCapacityPolicy(
  input: {
    concurrencyLimit: number | null | undefined;
    reservedSlots: number | undefined;
    contextCeiling: number | null | undefined;
    contextMargin: number | undefined;
  },
  reason?: GuardedPoolCreateFailureReason,
  fields?: PoolPolicyFieldNames,
): void {
  const reserved = input.reservedSlots ?? 0;
  const margin = input.contextMargin ?? 0;
  if (input.concurrencyLimit != null && reserved > input.concurrencyLimit)
    rejectPolicy(
      "Reserved slots exceed the pool concurrency limit.",
      namedPolicyFields(["capacityReservedSlots", "capacityConcurrencyLimit"], fields),
      reason,
    );
  if (input.contextCeiling != null && margin >= input.contextCeiling)
    rejectPolicy(
      "Pool context margin must be smaller than the context ceiling.",
      namedPolicyFields(["capacityContextMargin", "capacityContextCeiling"], fields),
      reason,
    );
}

/**
 * Capacity-policy fences (level 06) of `executionTargetIds`: a policy writer
 * (writer class M) takes them after its owner fence and before its first row
 * lock or write; admission takes the same fences for its candidates. The
 * order and the writer classes are documented and enforced in
 * `@ws-model-proxy/db/capacity-lock-order`; the graph-write fence triggers
 * refuse a policy write without them (WMPF4).
 */
export async function fenceExecutionTargetPolicies(
  tx: Prisma.TransactionClient,
  executionTargetIds: readonly string[],
): Promise<void> {
  await acquireFences(
    tx,
    executionTargetIds.map((targetId) => fences.capacityPolicy(targetId)),
  );
}

/**
 * Fences target discovery/creation before a row exists (level 02, after the
 * owner fence). Provider-model identities use the same key in every
 * management path.
 */
export async function fenceExecutionTargetIdentities(
  tx: Prisma.TransactionClient,
  identities: readonly string[],
): Promise<void> {
  await acquireFences(
    tx,
    identities.map((identity) => fences.targetIdentity(identity)),
  );
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
    rejectPolicy("Reserved slots exceed the direct concurrency limit.", [
      "directReservedSlots",
      "directConcurrencyLimit",
      "hardConcurrencyLimit",
    ]);
  if (input.hardLimit != null) {
    if (input.concurrencyLimit != null && input.concurrencyLimit > input.hardLimit)
      rejectPolicy("Direct concurrency limit exceeds physical capacity.", [
        "directConcurrencyLimit",
        "hardConcurrencyLimit",
      ]);
    if (reserved > input.hardLimit)
      rejectPolicy("Direct reserved slots exceed physical concurrency capacity.", [
        "directReservedSlots",
        "hardConcurrencyLimit",
      ]);
  }
  if (input.contextCeiling != null && margin >= input.contextCeiling)
    rejectPolicy("Direct context margin must be smaller than the context ceiling.", [
      "directContextMargin",
      "directContextCeiling",
    ]);
  if (
    input.physicalMaxContext != null &&
    input.contextCeiling != null &&
    input.contextCeiling + margin > input.physicalMaxContext
  )
    rejectPolicy("Direct context policy exceeds physical capacity.", [
      "directContextCeiling",
      "directContextMargin",
      "physicalMaxContext",
    ]);
}

export function assertEffectiveConcurrencyPolicy(
  input: {
    hardLimit: number | null | undefined;
    poolLimit: number | null;
    poolReserved: number;
    memberMode?: CapacityLimitMode;
    memberLimit?: number | null;
    memberReserved?: number | null;
  },
  reasons?: CapacityPolicyFailureReasons,
  fields?: PoolPolicyFieldNames,
): void {
  const effectiveLimit =
    input.memberMode === "LIMITED"
      ? input.memberLimit
      : input.memberMode === "UNLIMITED"
        ? null
        : input.poolLimit;
  const effectiveReserved = input.memberReserved ?? input.poolReserved;
  if (effectiveLimit != null && effectiveReserved > effectiveLimit)
    rejectPolicy(
      "Reserved slots exceed the effective concurrency limit.",
      namedPolicyFields(["capacityReservedSlots", "capacityConcurrencyLimit"], fields),
      reasons?.reservedExceeds,
    );
  if (input.hardLimit == null) return;
  if (effectiveLimit != null && effectiveLimit > input.hardLimit)
    rejectPolicy(
      "Effective concurrency limit exceeds physical capacity.",
      namedPolicyFields(
        ["capacityConcurrencyLimit", "hardConcurrencyLimit", "directConcurrencyLimit"],
        fields,
      ),
      reasons?.concurrencyExceedsPhysical,
    );
  if (effectiveReserved > input.hardLimit)
    rejectPolicy(
      "Reserved slots exceed physical concurrency capacity.",
      namedPolicyFields(
        ["capacityReservedSlots", "hardConcurrencyLimit", "directReservedSlots"],
        fields,
      ),
      reasons?.reservedExceedsPhysical,
    );
}

export function assertEffectiveContextPolicy(
  input: {
    physicalMaxContext: number | null | undefined;
    poolCeiling: number | null;
    poolMargin: number;
    memberMode?: CapacityLimitMode;
    memberCeiling?: number | null;
    memberMargin?: number | null;
  },
  reasons?: EffectiveContextPolicyFailureReasons,
  fields?: PoolPolicyFieldNames,
): void {
  const ceiling =
    input.memberMode === "LIMITED"
      ? input.memberCeiling
      : input.memberMode === "UNLIMITED"
        ? null
        : input.poolCeiling;
  const margin = input.memberMargin ?? input.poolMargin;
  if (ceiling != null && margin >= ceiling)
    rejectPolicy(
      "Context margin must be smaller than the effective context ceiling.",
      namedPolicyFields(
        [
          "capacityContextMargin",
          "capacityContextCeiling",
          "directContextMargin",
          "directContextCeiling",
        ],
        fields,
      ),
      reasons?.marginExceedsCeiling,
    );
  if (
    input.physicalMaxContext != null &&
    ceiling != null &&
    ceiling + margin > input.physicalMaxContext
  )
    rejectPolicy(
      "Effective context policy exceeds physical capacity.",
      namedPolicyFields(
        [
          "capacityContextCeiling",
          "capacityContextMargin",
          "directContextCeiling",
          "directContextMargin",
          "physicalMaxContext",
        ],
        fields,
      ),
      reasons?.exceedsPhysical,
    );
}

/**
 * Takes the capacity-policy fences of every member target of a pool and
 * validates every member's effective policy against the proposed pool
 * policy. The shared path for writes to an existing ModelPool: the caller
 * holds the pool owner's fence (so the member set read here cannot change
 * before its write) and has locked or written no row yet; it performs its
 * write in this transaction after this function returns.
 */
export async function fenceAndValidateModelPoolCapacityPolicy(
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
  await fenceExecutionTargetPolicies(
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
