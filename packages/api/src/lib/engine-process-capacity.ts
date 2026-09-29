import prisma, { Prisma } from "@ws-model-proxy/db";
import {
  AUTO_CAPACITY_RUNTIME_KEY_PREFIXES,
  acquireFences,
  fenceOwners,
  fences,
} from "@ws-model-proxy/db/capacity-lock-order";
import {
  discoveredHardConcurrencyLimit,
  engineProcessRuntimeIdentityKey,
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
    (target) => proof.has(target.upstreamModelId) && isAutoManagedCapacity(target.capacity),
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
  const limit =
    input.slots && Number.isInteger(input.slots) && input.slots >= 1 && input.slots <= 10_000
      ? input.slots
      : Math.min(
          10_000,
          input.reportedConcurrency.reduce<number>(
            (sum, value) => sum + discoveredHardConcurrencyLimit(value),
            0,
          ) || 1,
        );
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
  await tx.inferenceCapacity.updateMany({
    where: {
      id: row.id,
      userId: input.userId,
      hardConcurrencyLimit: null,
      hardConcurrencyLimitSource: "AUTO",
    },
    data: { hardConcurrencyLimit: limit },
  });
  return row.id;
}

/**
 * The one discovery re-point write. M caller holds owner, target policy and
 * BOTH capacity fences (new rows are transaction-private), and validates the
 * destination against the target's policies. Runtime ids remain unchanged.
 */
export async function repointTargetCapacity(
  tx: Prisma.TransactionClient,
  input: { userId: string; targetId: string; fromCapacityId: string | null; toCapacityId: string },
): Promise<number> {
  if (input.fromCapacityId === input.toCapacityId) return 0;
  const result = await tx.executionTarget.updateMany({
    where: { id: input.targetId, userId: input.userId, inferenceCapacityId: input.fromCapacityId },
    data: { inferenceCapacityId: input.toCapacityId },
  });
  return result.count;
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
          deleted += await prisma.$transaction(
            async (tx) => {
              await fenceOwners(tx, [userId]);
              // Re-read after the owner wait; the guarded delete also rechecks topology.
              const candidates = await tx.inferenceCapacity.findMany({
                where: { userId, id: { in: ids } },
                select: { id: true },
              });
              const fencedIds = candidates.map((row) => row.id);
              await acquireFences(
                tx,
                fencedIds.map((id) => fences.capacity(id)),
              );
              return deleteOrphanAutoCapacities(tx, userId, fencedIds);
            },
            { isolationLevel: "ReadCommitted" },
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
