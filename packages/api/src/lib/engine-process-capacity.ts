import { ORPCError } from "@orpc/server";
import prisma, { Prisma } from "@ws-model-proxy/db";
import {
  AUTO_CAPACITY_RUNTIME_KEY_PREFIXES,
  acquireFences,
  fences,
  runCapacityOrderedTransaction,
} from "@ws-model-proxy/db/capacity-lock-order";
import {
  assertDirectCapacityPolicy,
  assertEffectiveConcurrencyPolicy,
  assertEffectiveContextPolicy,
} from "./capacity-policy-safety";
import {
  discoveredHardConcurrencyLimit,
  engineProcessRuntimeIdentityKey,
  ensureDiscoveredInferenceCapacity,
  isInferenceCapacityWriteRetryable,
} from "./discovered-inference-capacity";
import type { WireEngineFacts } from "./engine-facts";

export { engineProcessRuntimeIdentityKey } from "./discovered-inference-capacity";

export function isAutoManagedCapacity(
  capacity: { runtimeIdentityKey: string; hardConcurrencyLimitSource: string } | null,
): boolean {
  return (
    capacity === null ||
    (capacity.hardConcurrencyLimitSource === "AUTO" &&
      AUTO_CAPACITY_RUNTIME_KEY_PREFIXES.some((prefix) =>
        capacity.runtimeIdentityKey.startsWith(prefix),
      ))
  );
}

export type EngineProcessTarget = {
  id: string;
  upstreamModelId: string;
  capacityAssignmentSource: string;
  capacity: { runtimeIdentityKey: string; hardConcurrencyLimitSource: string } | null;
};

/** Exact endpoint-level proof only. Model facts cannot prove a process boundary. */
export function planEngineProcessCapacity(input: {
  endpointId: string;
  engineFacts: WireEngineFacts | undefined;
  inventoryModelIds: readonly string[];
  targets: readonly EngineProcessTarget[];
}): { sharedTargetIds: string[]; splitTargetIds: string[] } {
  const kind = input.engineFacts?.engine?.value;
  const aliases = input.engineFacts?.servedModelAliases?.value;
  const inventory = new Set(input.inventoryModelIds);
  const proof = new Set(
    aliases && aliases.length <= 64 && ["llama.cpp", "vllm", "sglang"].includes(kind ?? "")
      ? aliases.filter((id) => inventory.has(id))
      : [],
  );
  const members = input.targets.filter(
    (target) =>
      target.capacityAssignmentSource === "AUTO" &&
      proof.has(target.upstreamModelId) &&
      isAutoManagedCapacity(target.capacity),
  );
  // Duplicated/adversarial target rows cannot establish two distinct model ids.
  const sharedTargetIds =
    new Set(members.map((target) => target.upstreamModelId)).size >= 2 &&
    new Set(members.map((target) => target.id)).size >= 2
      ? [...new Set(members.map((target) => target.id))]
      : [];
  const shared = new Set(sharedTargetIds);
  const key = engineProcessRuntimeIdentityKey(input.endpointId);
  return {
    sharedTargetIds,
    splitTargetIds: [
      ...new Set(
        input.targets
          .filter(
            (target) =>
              target.capacityAssignmentSource === "AUTO" &&
              !shared.has(target.id) &&
              target.capacity?.runtimeIdentityKey === key &&
              isAutoManagedCapacity(target.capacity),
          )
          .map((target) => target.id),
      ),
    ],
  };
}

/** Caller fences every existing candidate row before its first write. */
export async function ensureEngineProcessCapacity(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    endpointId: string;
    endpointSlug: string;
    /** Engine-reported (or configured) parallel slots; shared by every model on the process. */
    slots?: number | null;
    reportedConcurrency: readonly (number | null | undefined)[];
  },
): Promise<string> {
  const runtimeIdentityKey = engineProcessRuntimeIdentityKey(input.endpointId);
  // One process with known slots has exactly that many. Without slots (vLLM)
  // the members' separate limits add up, so merging never lowers the total
  // concurrency the models had.
  const limit = sharedAutomaticLimit(input.slots, input.reportedConcurrency);
  const row = await tx.inferenceCapacity.upsert({
    where: { userId_runtimeIdentityKey: { userId: input.userId, runtimeIdentityKey } },
    update: {},
    create: {
      userId: input.userId,
      // The DB's auto-label trigger disambiguates every automatic creator
      // under the owner fence, before the unique-label constraint is checked.
      label: `Engine process ${input.endpointSlug}`.slice(0, 120),
      runtimeIdentityKey,
      runtimeModel: input.endpointId,
      hardConcurrencyLimit: limit,
      hardConcurrencyLimitSource: "AUTO",
      countStrategy: "CONSERVATIVE_ESTIMATE",
    },
    select: { id: true },
  });
  return row.id;
}

function sharedAutomaticLimit(
  slots: number | null | undefined,
  limits: readonly (number | null | undefined)[],
): number {
  return slots && Number.isInteger(slots) && slots >= 1 && slots <= 10_000
    ? slots
    : Math.min(
        10_000,
        limits.reduce<number>((sum, value) => sum + discoveredHardConcurrencyLimit(value), 0) || 1,
      );
}

const moveTargetSelect = {
  id: true,
  userId: true,
  inferenceCapacityId: true,
  capacityAssignmentSource: true,
  capacityAutoConcurrencyLimit: true,
  discoveredModelId: true,
  DiscoveredModel: { select: { upstreamModelId: true } },
  InferenceCapacity: { select: { runtimeIdentityKey: true, hardConcurrencyLimitSource: true } },
  directConcurrencyLimit: true,
  directReservedSlots: true,
  directContextCeiling: true,
  directContextMargin: true,
  PoolMembers: {
    select: {
      capacityConcurrencyMode: true,
      capacityConcurrencyLimit: true,
      capacityReservedSlots: true,
      capacityContextCeilingMode: true,
      capacityContextCeiling: true,
      capacityContextMargin: true,
      ModelPool: {
        select: {
          capacityConcurrencyLimit: true,
          capacityReservedSlots: true,
          capacityContextCeiling: true,
          capacityContextMargin: true,
        },
      },
    },
  },
} satisfies Prisma.ExecutionTargetSelect;
type MoveTarget = Prisma.ExecutionTargetGetPayload<{ select: typeof moveTargetSelect }>;
const moveCapacitySelect = {
  id: true,
  userId: true,
  runtimeIdentityKey: true,
  hardConcurrencyLimitSource: true,
  hardConcurrencyLimit: true,
  physicalMaxContext: true,
  engineSlots: true,
} satisfies Prisma.InferenceCapacitySelect;
type MoveCapacity = Prisma.InferenceCapacityGetPayload<{ select: typeof moveCapacitySelect }>;

/** Reuse the owner-assignment invariants, including null/unknown context semantics. */
function policiesFit(target: MoveTarget, capacity: MoveCapacity): boolean {
  try {
    assertDirectCapacityPolicy({
      hardLimit: capacity.hardConcurrencyLimit,
      concurrencyLimit: target.directConcurrencyLimit,
      reservedSlots: target.directReservedSlots,
      physicalMaxContext: capacity.physicalMaxContext,
      contextCeiling: target.directContextCeiling,
      contextMargin: target.directContextMargin,
    });
    for (const member of target.PoolMembers) {
      assertEffectiveConcurrencyPolicy({
        hardLimit: capacity.hardConcurrencyLimit,
        poolLimit: member.ModelPool.capacityConcurrencyLimit,
        poolReserved: member.ModelPool.capacityReservedSlots,
        memberMode: member.capacityConcurrencyMode,
        memberLimit: member.capacityConcurrencyLimit,
        memberReserved: member.capacityReservedSlots,
      });
      assertEffectiveContextPolicy({
        physicalMaxContext: capacity.physicalMaxContext,
        poolCeiling: member.ModelPool.capacityContextCeiling,
        poolMargin: member.ModelPool.capacityContextMargin,
        memberMode: member.capacityContextCeilingMode,
        memberCeiling: member.capacityContextCeiling,
        memberMargin: member.capacityContextMargin,
      });
    }
    return true;
  } catch (error) {
    if (error instanceof ORPCError && error.code === "BAD_REQUEST") return false;
    throw error;
  }
}

async function capacitiesIdle(
  tx: Prisma.TransactionClient,
  capacityIds: readonly string[],
): Promise<boolean> {
  if (capacityIds.length === 0) return true;
  const lease = await tx.capacityLease.findFirst({
    where: { capacityId: { in: [...capacityIds] }, state: "ACTIVE" },
    select: { id: true },
  });
  const waiter = await tx.capacityWaiter.findFirst({
    where: { capacityId: { in: [...capacityIds] }, state: "WAITING" },
    select: { id: true },
  });
  return lease === null && waiter === null;
}

/**
 * The one automatic FK writer. M holds owner, policy and both capacity fences.
 * Preflight is repeated here so a future caller cannot omit lifecycle guards.
 * H state is only read; handles and resource charges never change ownership.
 */
export async function repointTargetCapacity(
  tx: Prisma.TransactionClient,
  input: { userId: string; targetId: string; fromCapacityId: string | null; toCapacityId: string },
): Promise<number> {
  if (input.fromCapacityId === input.toCapacityId) return 0;
  const target = await tx.executionTarget.findUnique({
    where: { id: input.targetId },
    select: moveTargetSelect,
  });
  const destination = await tx.inferenceCapacity.findUnique({
    where: { id: input.toCapacityId },
    select: moveCapacitySelect,
  });
  if (
    !target ||
    target.userId !== input.userId ||
    target.inferenceCapacityId !== input.fromCapacityId ||
    target.capacityAssignmentSource !== "AUTO" ||
    !isAutoManagedCapacity(target.InferenceCapacity) ||
    !destination ||
    destination.userId !== input.userId ||
    !isAutoManagedCapacity(destination) ||
    destination.hardConcurrencyLimit === null ||
    !policiesFit(target, destination) ||
    !(await capacitiesIdle(
      tx,
      [input.fromCapacityId, input.toCapacityId].filter((id): id is string => id !== null),
    ))
  )
    return 0;
  const result = await tx.executionTarget.updateMany({
    where: {
      id: input.targetId,
      userId: input.userId,
      inferenceCapacityId: input.fromCapacityId,
      capacityAssignmentSource: "AUTO",
    },
    data: { inferenceCapacityId: input.toCapacityId },
  });
  return result.count;
}

/**
 * One automatic transition coordinator. Caller fenced ALL existing attached
 * targets/capacities before its first graph write. Preflight the entire batch:
 * an idle sibling must not open a second process budget while another is live.
 */
export async function applyEngineProcessCapacityPlan(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    endpointId: string;
    endpointSlug: string;
    engineFacts: WireEngineFacts | undefined;
    inventoryModelIds: readonly string[];
  },
): Promise<{ assignments: Map<string, string>; capacityIds: string[] }> {
  const targets = await tx.executionTarget.findMany({
    where: { userId: input.userId, DiscoveredModel: { is: { endpointId: input.endpointId } } },
    select: moveTargetSelect,
  });
  const plan = planEngineProcessCapacity({
    ...input,
    targets: targets.map((target) => ({
      id: target.id,
      upstreamModelId: target.DiscoveredModel?.upstreamModelId ?? "",
      capacityAssignmentSource: target.capacityAssignmentSource,
      capacity: target.InferenceCapacity,
    })),
  });
  const group = new Set(plan.sharedTargetIds);
  const split = new Set(plan.splitTargetIds);
  const sharedKey = engineProcessRuntimeIdentityKey(input.endpointId);
  let sharedId = (
    await tx.inferenceCapacity.findUnique({
      where: { userId_runtimeIdentityKey: { userId: input.userId, runtimeIdentityKey: sharedKey } },
      select: { id: true },
    })
  )?.id;
  if (group.size > 0)
    sharedId = await ensureEngineProcessCapacity(tx, {
      ...input,
      slots: input.engineFacts?.slots?.value,
      reportedConcurrency: targets
        .filter((target) => group.has(target.id))
        .map((target) => target.capacityAutoConcurrencyLimit),
    });
  const assignments = new Map<string, string>();
  const destinations = new Map<string, string>();
  const capacityIds = new Set(
    targets.flatMap((target) => (target.inferenceCapacityId ? [target.inferenceCapacityId] : [])),
  );
  if (sharedId) capacityIds.add(sharedId);
  for (const target of targets) {
    if (!target.discoveredModelId || (!group.has(target.id) && !split.has(target.id))) continue;
    const destinationId =
      group.has(target.id) && sharedId
        ? sharedId
        : await ensureDiscoveredInferenceCapacity(tx, {
            userId: input.userId,
            discoveredModelId: target.discoveredModelId,
            executionTargetId: target.id,
            upstreamModelId: target.DiscoveredModel?.upstreamModelId ?? target.discoveredModelId,
            reportedConcurrency: target.capacityAutoConcurrencyLimit,
            fillExistingLimit: false,
          });
    capacityIds.add(destinationId);
    destinations.set(target.id, destinationId);
  }
  const capacities = await tx.inferenceCapacity.findMany({
    where: { userId: input.userId, id: { in: [...capacityIds] } },
    select: moveCapacitySelect,
  });
  const byId = new Map(capacities.map((capacity) => [capacity.id, capacity]));
  const shared = sharedId ? byId.get(sharedId) : undefined;
  // Include attached owner targets when validating a proposed shared limit,
  // but exclude their automatic seeds from the sum.
  const attached = sharedId
    ? await tx.executionTarget.findMany({
        where: { userId: input.userId, inferenceCapacityId: sharedId },
        select: moveTargetSelect,
      })
    : [];
  const finalShared = [
    ...new Map(
      [
        ...attached.filter((target) => !split.has(target.id)),
        ...targets.filter((target) => group.has(target.id)),
      ].map((target) => [target.id, target]),
    ).values(),
  ];
  const proposed = sharedAutomaticLimit(
    input.engineFacts?.slots?.value,
    finalShared
      .filter((target) => target.capacityAssignmentSource === "AUTO")
      .map((target) => target.capacityAutoConcurrencyLimit),
  );
  if (
    shared &&
    isAutoManagedCapacity(shared) &&
    finalShared.every((target) =>
      policiesFit(target, { ...shared, hardConcurrencyLimit: proposed }),
    )
  ) {
    // In-memory only until the whole move preflight succeeds.
    byId.set(shared.id, { ...shared, hardConcurrencyLimit: proposed });
  }
  const moves = targets.filter(
    (target) =>
      destinations.has(target.id) && destinations.get(target.id) !== target.inferenceCapacityId,
  );
  const safe =
    moves.every((target) => {
      const destination = byId.get(destinations.get(target.id)!);
      return (
        target.capacityAssignmentSource === "AUTO" &&
        isAutoManagedCapacity(target.InferenceCapacity) &&
        destination !== undefined &&
        isAutoManagedCapacity(destination) &&
        destination.hardConcurrencyLimit !== null &&
        policiesFit(target, destination)
      );
    }) &&
    (moves.length === 0 || (await capacitiesIdle(tx, [...capacityIds])));
  if (safe) {
    // Growth must precede the guarded repoint so its independent validation
    // sees the same admissible limit; all checks ran before any graph change.
    const effectiveShared = sharedId ? byId.get(sharedId) : undefined;
    if (
      shared &&
      effectiveShared &&
      effectiveShared.hardConcurrencyLimit !== shared.hardConcurrencyLimit
    ) {
      await tx.inferenceCapacity.updateMany({
        where: { id: shared.id, userId: input.userId, hardConcurrencyLimitSource: "AUTO" },
        data: { hardConcurrencyLimit: effectiveShared.hardConcurrencyLimit },
      });
    }
    for (const target of moves) {
      const toCapacityId = destinations.get(target.id)!;
      const moved = await repointTargetCapacity(tx, {
        userId: input.userId,
        targetId: target.id,
        fromCapacityId: target.inferenceCapacityId,
        toCapacityId,
      });
      // Owner and H fences exclude all state changes since preflight. A guard
      // failure is an invariant violation: rollback the ENTIRE registration.
      if (moved !== 1) throw new Error("Automatic capacity preflight changed under fences.");
      assignments.set(target.id, toCapacityId);
    }
  }
  // Repair identical retries and skipped moves from actual membership.
  if (shared)
    await refreshSharedAutoCapacities(
      tx,
      input.userId,
      [shared.id],
      input.engineFacts?.slots?.value ?? null,
    );
  return { assignments, capacityIds: [...capacityIds] };
}

/**
 * Recompute after every membership writer (inventory, owner assignment or
 * parent cascade). Caller already fenced all attached target policies and
 * capacity rows. USER limits and inadmissible lowerings remain untouched.
 */
export async function refreshSharedAutoCapacities(
  tx: Prisma.TransactionClient,
  userId: string,
  capacityIds: readonly string[],
  reportedSlots?: number | null,
): Promise<void> {
  if (capacityIds.length === 0) return;
  const capacities = await tx.inferenceCapacity.findMany({
    where: {
      userId,
      id: { in: [...capacityIds] },
      hardConcurrencyLimitSource: "AUTO",
      runtimeIdentityKey: { startsWith: "engine-process:" },
    },
    select: moveCapacitySelect,
  });
  for (const capacity of capacities) {
    if (
      !isAutoManagedCapacity(capacity) ||
      !capacity.runtimeIdentityKey.startsWith("engine-process:")
    )
      continue;
    const members = await tx.executionTarget.findMany({
      where: { userId, inferenceCapacityId: capacity.id },
      select: moveTargetSelect,
    });
    const limit = sharedAutomaticLimit(
      reportedSlots !== undefined ? reportedSlots : capacity.engineSlots,
      members
        .filter((target) => target.capacityAssignmentSource === "AUTO")
        .map((target) => target.capacityAutoConcurrencyLimit),
    );
    if (
      members.length > 0 &&
      members.every((target) => policiesFit(target, { ...capacity, hardConcurrencyLimit: limit }))
    )
      await tx.inferenceCapacity.updateMany({
        where: { id: capacity.id, userId, hardConcurrencyLimitSource: "AUTO" },
        data: { hardConcurrencyLimit: limit },
      });
  }
}

/**
 * The one automatic deleter. Caller holds owner + every named capacity fence
 * before any write. H reads are plain reads under capacity fences; M never
 * writes H tables. Parent deletes explicitly opt out of the idle guard.
 */
export async function deleteOrphanAutoCapacities(
  tx: Prisma.TransactionClient,
  userId: string,
  capacityIds: readonly string[],
  { idleOnly = true }: { idleOnly?: boolean } = {},
): Promise<number> {
  if (capacityIds.length === 0) return 0;
  return tx.$executeRaw(Prisma.sql`
    DELETE FROM inference_capacity c
     WHERE c."userId" = ${userId} AND c.id IN (${Prisma.join(capacityIds)})
       AND c."hardConcurrencyLimitSource" = 'AUTO'
       AND (${Prisma.join(
         AUTO_CAPACITY_RUNTIME_KEY_PREFIXES.map(
           (prefix) => Prisma.sql`c."runtimeIdentityKey" LIKE ${`${prefix}%`}`,
         ),
         " OR ",
       )})
       AND NOT EXISTS (SELECT 1 FROM execution_target t WHERE t."inferenceCapacityId" = c.id)
       ${
         idleOnly
           ? Prisma.sql`
       AND NOT EXISTS (SELECT 1 FROM capacity_lease l WHERE l."capacityId" = c.id AND l.state = 'ACTIVE')
       AND NOT EXISTS (SELECT 1 FROM capacity_waiter w WHERE w."capacityId" = c.id AND w.state = 'WAITING')`
           : Prisma.empty
}
  `);
}

/** Additive startup repair: bounded keyset batches, never revisit retained live rows. */
export async function sweepOrphanAutoCapacities({
  batchSize = 200,
}: {
  batchSize?: number;
} = {}): Promise<number> {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 200)
    throw new Error("Invalid capacity sweep batch size.");
  let cursor: string | undefined;
  let deleted = 0;
  for (;;) {
    const batch = await prisma.inferenceCapacity.findMany({
      where: {
        ...(cursor ? { id: { gt: cursor } } : {}),
        hardConcurrencyLimitSource: "AUTO",
        OR: AUTO_CAPACITY_RUNTIME_KEY_PREFIXES.map((prefix) => ({
          runtimeIdentityKey: { startsWith: prefix },
        })),
        ExecutionTargets: { none: {} },
      },
      orderBy: { id: "asc" },
      take: batchSize,
      select: { id: true, userId: true },
    });
    if (batch.length === 0) return deleted;
    const owners = new Set(batch.map((row) => row.userId));
    for (const userId of owners) {
      const ids = batch.filter((row) => row.userId === userId).map((row) => row.id);
      for (let attempt = 1; ; attempt++) {
        try {
          deleted += await runCapacityOrderedTransaction(
            prisma,
            async (tx) => {
              if (!(await acquireFences(tx, [fences.owner(userId)], { wait: false }))) return 0;
              // Re-read under the owner fence; the guarded delete also rechecks topology.
              const candidates = await tx.inferenceCapacity.findMany({
                where: { userId, id: { in: ids } },
                select: { id: true },
              });
              const fencedIds = candidates.map((row) => row.id);
              if (
                !(await acquireFences(
                  tx,
                  fencedIds.map((id) => fences.capacity(id)),
                  { wait: false },
                ))
              )
                return 0;
              return deleteOrphanAutoCapacities(tx, userId, fencedIds);
            },
            { maxAttempts: 3 },
          );
          break;
        } catch (error) {
          if (attempt >= 3 || !isInferenceCapacityWriteRetryable(error)) throw error;
        }
      }
    }
    cursor = batch[batch.length - 1]?.id;
  }
}
