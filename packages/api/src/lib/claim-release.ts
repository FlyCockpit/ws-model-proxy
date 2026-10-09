/**
 * Releasing a rank's claim: the one write every release goes through, whether a node proved the
 * stop (a stop, a status probe, the inventory) or a person released it without proof after
 * checking the node themselves ("I've checked, release it"). Callers hold the instance's owner
 * and capacity fences (`graphWrite` / the lifecycle's `write`).
 *
 * A release is idempotent: only a claim still held (or marked stopped) changes, so a late proof
 * after a person released the claim changes nothing, and neither does a second release.
 */
import type { Prisma } from "@ws-model-proxy/db";

type Tx = Prisma.TransactionClient;

/** How long an agent's release request waits for a person. */
export const RELEASE_REQUEST_TTL_MS = 24 * 3_600_000;

/** A person's release without proof: who, and why the node could not prove the stop then. */
export type UnprovenRelease = { by: string; reason: string };

/**
 * Releases the claim (RELEASED: placement may reuse its resources and ports). With `unproven`,
 * only a claim marked stopped (HELD_UNKNOWN) is released, and the rank records who released it
 * without proof, when, and the last reason. Pending release requests for the claim are cleared.
 * True when this call released it.
 */
export async function releaseClaim(
  tx: Tx,
  rankId: string,
  now: Date,
  unproven?: UnprovenRelease,
): Promise<boolean> {
  const released = await tx.instanceRank.updateMany({
    where: {
      id: rankId,
      claim: unproven ? "HELD_UNKNOWN" : { in: ["HELD", "HELD_UNKNOWN"] },
    },
    data: {
      claim: "RELEASED",
      claimChangedAt: now,
      stoppedAt: now,
      ...(unproven
        ? {
            releasedUnprovenAt: now,
            releasedUnprovenBy: unproven.by,
            releasedUnprovenReason: unproven.reason,
          }
        : {}),
    },
  });
  if (released.count === 0) return false;
  await clearReleaseRequests(tx, [rankId], now);
  return true;
}

/** Pending release requests of these claims end (CLEARED): their hold ended without them. */
export async function clearReleaseRequests(
  tx: Tx,
  rankIds: readonly string[],
  now: Date,
): Promise<void> {
  if (rankIds.length === 0) return;
  await tx.claimReleaseRequest.updateMany({
    where: { pendingRankId: { in: [...rankIds] }, state: "PENDING" },
    data: { state: "CLEARED", pendingRankId: null, decidedAt: now },
  });
}

/** A restart retakes every claim of the instance: its pending release requests end (CLEARED). */
export async function clearInstanceReleaseRequests(
  tx: Tx,
  instanceId: string,
  now: Date,
): Promise<void> {
  await tx.claimReleaseRequest.updateMany({
    where: { state: "PENDING", Rank: { instanceId } },
    data: { state: "CLEARED", pendingRankId: null, decidedAt: now },
  });
}

type ReleaseRequestDb = {
  claimReleaseRequest: Pick<Prisma.ClaimReleaseRequestDelegate, "updateMany">;
};

/**
 * The release-request sweep: requests past their expiry become EXPIRED, and requests whose claim
 * is no longer marked stopped (a proof released it, a restart retook it) become CLEARED. Returns
 * how many it settled.
 */
export async function sweepReleaseRequests(db: ReleaseRequestDb, now: Date): Promise<number> {
  const expired = await db.claimReleaseRequest.updateMany({
    where: { state: "PENDING", expiresAt: { lte: now } },
    data: { state: "EXPIRED", pendingRankId: null, decidedAt: now },
  });
  const cleared = await db.claimReleaseRequest.updateMany({
    where: { state: "PENDING", Rank: { claim: { not: "HELD_UNKNOWN" } } },
    data: { state: "CLEARED", pendingRankId: null, decidedAt: now },
  });
  return expired.count + cleared.count;
}
