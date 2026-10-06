/**
 * Management writes to the access graph (api_key, api_key_pool, share, share_invite,
 * spend_cap) need the owner fence of every owner they touch, taken before the first row lock or
 * write (`enforce_graph_write_fence`, WMPF4 otherwise). A change to a share's policy columns
 * (canUse, canContribute, priorityClass) also needs the `06:capacity-policy` fence of every
 * execution target of the pool, since it changes their admission view.
 *
 * READ COMMITTED (capacity-ordered): reads after the fences see what the previous holder
 * committed, so a count-then-insert under the owner fence is exact.
 */
import { ORPCError } from "@orpc/server";
import prisma, { type Prisma } from "@ws-model-proxy/db";
import {
  acquireFences,
  CapacityOrderedTransactionTimeoutError,
  FenceSetChangedError,
  fenceOwners,
  fences,
  isRetryableCapacityTransactionError,
  runCapacityOrderedTransaction,
} from "@ws-model-proxy/db/capacity-lock-order";

type Tx = Prisma.TransactionClient;

/** `WMPF4`: a write needed a fence this transaction does not hold (see the file comment). */
function isMissingFence(error: unknown): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) continue;
    seen.add(candidate);
    for (const key of ["code", "originalCode"]) {
      if (Reflect.get(candidate, key) === "WMPF4") return true;
    }
    for (const key of ["meta", "driverAdapterError", "cause"])
      pending.push(Reflect.get(candidate, key));
  }
  return false;
}

/** Every execution target a pool's policy feeds (`wsmp_pool_target_ids`). */
async function poolTargetIds(tx: Tx, poolId: string): Promise<string[]> {
  const members = await tx.poolMember.findMany({
    where: { poolId },
    select: { runtimeModelId: true, providerModelId: true },
  });
  const runtimeModelIds = members.flatMap((member) =>
    member.runtimeModelId ? [member.runtimeModelId] : [],
  );
  const providerModelIds = members.flatMap((member) =>
    member.providerModelId ? [member.providerModelId] : [],
  );
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
  return targets.map((target) => target.id);
}

/**
 * Runs `work` after taking the owner fences of `owners` and, for `policyPoolId`, the
 * capacity-policy fences of that pool's targets. Contention past the bounds is a CONFLICT.
 */
export async function runAccessTransaction<T>(
  args: { owners: readonly string[]; policyPoolId?: string },
  work: (tx: Tx) => Promise<T>,
): Promise<T> {
  try {
    return await runCapacityOrderedTransaction(prisma, async (tx) => {
      await fenceOwners(tx, args.owners);
      // Under the pool owner's fence the member set is stable (pool_member writes need it);
      // a plain read takes no row lock, so the higher-level fences may still follow.
      const targetIds = args.policyPoolId ? await poolTargetIds(tx, args.policyPoolId) : [];
      if (targetIds.length > 0) {
        await acquireFences(
          tx,
          targetIds.map((targetId) => fences.capacityPolicy(targetId)),
        );
      }
      try {
        return await work(tx);
      } catch (error) {
        // A target appeared after the fence set was read (a contributor's new instance):
        // roll back and retry with the larger set.
        if (isMissingFence(error)) throw new FenceSetChangedError();
        throw error;
      }
    });
  } catch (error) {
    if (
      error instanceof CapacityOrderedTransactionTimeoutError ||
      isRetryableCapacityTransactionError(error)
    ) {
      throw new ORPCError("CONFLICT", {
        message: "Configuration changed concurrently. Retry the request.",
      });
    }
    throw error;
  }
}
