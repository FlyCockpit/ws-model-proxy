/**
 * M-class graph writes for lane C (runtimes, pools, providers): every transaction first takes
 * the `owner` fence of every user whose graph rows it writes, then the policy (06) and capacity
 * (08) fences of the admission views it changes, and only then reads-for-write and writes
 * (`@ws-model-proxy/db/capacity-lock-order`, enforced by `enforce_graph_write_fence`).
 *
 * Plain reads may run before or between fence calls (they assign no transaction id); a row
 * lock or write may not. Fences are taken in ascending level order: owners first, then the
 * callback's policy/capacity fences, which may read under the owner fences.
 */
import { ORPCError } from "@orpc/server";
import prisma, { type Prisma } from "@ws-model-proxy/db";
import type { CapacityDeleteScope } from "@ws-model-proxy/db/capacity-lock-order";
import {
  acquireFences,
  CapacityOrderedTransactionTimeoutError,
  type Fence,
  fenceParentDelete,
  fences,
  isRetryableCapacityTransactionError,
  runCapacityOrderedTransaction,
} from "@ws-model-proxy/db/capacity-lock-order";
import { RETRY_CONFLICT_MESSAGE } from "./refuse";
import { runCapacityDeleteTransaction } from "./serializable-transaction";

type Tx = Prisma.TransactionClient;

function contended(error: unknown): never {
  if (
    error instanceof CapacityOrderedTransactionTimeoutError ||
    isRetryableCapacityTransactionError(error)
  )
    throw new ORPCError("CONFLICT", {
      message: RETRY_CONFLICT_MESSAGE,
    });
  throw error;
}

/**
 * Runs `work` under the owner fences of `owners`, then the fences `policyFences` names
 * (computed under the owner fences, before any write).
 */
export async function graphWrite<T>(
  owners: Iterable<string>,
  work: (tx: Tx) => Promise<T>,
  policyFences?: (tx: Tx) => Promise<Fence[]>,
): Promise<T> {
  try {
    return await runCapacityOrderedTransaction(prisma, async (tx) => {
      await acquireFences(
        tx,
        [...new Set(owners)].map((userId) => fences.owner(userId)),
      );
      if (policyFences) await acquireFences(tx, await policyFences(tx));
      return work(tx);
    });
  } catch (error) {
    contended(error);
  }
}

/** A parent delete (cascades included) under `fenceParentDelete`. */
export async function graphDelete<T>(
  scope: CapacityDeleteScope,
  work: (tx: Tx) => Promise<T>,
): Promise<T> {
  return runCapacityDeleteTransaction(async (tx) => {
    await fenceParentDelete(tx, scope);
    return work(tx);
  });
}

/** Policy fences of every execution target behind a pool's members. */
export async function poolTargetFences(tx: Tx, poolId: string): Promise<Fence[]> {
  const targets = await tx.executionTarget.findMany({
    where: {
      OR: [
        { RuntimeModel: { Members: { some: { poolId } } } },
        { ProviderModel: { Members: { some: { poolId } } } },
      ],
    },
    select: { id: true },
  });
  return targets.map((target) => fences.capacityPolicy(target.id));
}

/** Policy fences of the execution targets of these served / provider models. */
export async function modelTargetFences(
  tx: Tx,
  models: { runtimeModelIds?: readonly string[]; providerModelIds?: readonly string[] },
): Promise<Fence[]> {
  const runtimeModelIds = [...(models.runtimeModelIds ?? [])];
  const providerModelIds = [...(models.providerModelIds ?? [])];
  if (runtimeModelIds.length === 0 && providerModelIds.length === 0) return [];
  const targets = await tx.executionTarget.findMany({
    where: {
      OR: [
        ...(runtimeModelIds.length ? [{ runtimeModelId: { in: runtimeModelIds } }] : []),
        ...(providerModelIds.length ? [{ providerModelId: { in: providerModelIds } }] : []),
      ],
    },
    select: { id: true },
  });
  return targets.map((target) => fences.capacityPolicy(target.id));
}

/** Capacity fences of instances (an instance's admission version changes). */
export function instanceCapacityFences(instanceIds: readonly string[]): Fence[] {
  return instanceIds.map((id) => fences.capacity(id));
}

/** Capacity fences of every instance of a runtime (its current version changes). */
export async function runtimeCapacityFences(tx: Tx, runtimeId: string): Promise<Fence[]> {
  const instances = await tx.runtimeInstance.findMany({
    where: { runtimeId },
    select: { id: true },
  });
  return instanceCapacityFences(instances.map((instance) => instance.id));
}
