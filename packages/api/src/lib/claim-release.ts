/**
 * Releasing a rank's claim: the one write every release goes through, whether a node proved the
 * stop (a stop, a status probe, the inventory), the instance's own steps show the rank never
 * ran, or a person released it without proof after checking the node themselves ("I've checked,
 * release it"). Callers hold the instance's owner and capacity fences (`graphWrite` / the
 * lifecycle's `write`).
 *
 * A release is idempotent: only a claim still held (or marked stopped) changes, so a late proof
 * after a person released the claim changes nothing, and neither does a second release.
 *
 * A node's proof is about the instance's current run (`instance-run.ts`): the step that proves
 * the stop must be this rank's (same instance, rank and node), of the run that owns the claim now
 * (`owned`), and nothing of that run may have been launched after it (`fresh`). A late stop,
 * status probe or inventory record of an earlier run, or one observed before this run's launch,
 * therefore never releases the claim a restart took for the next run. Callers hand in a step id
 * (or ask for the never-ran evaluation), never an ordinal or a verdict: every check runs here,
 * under the caller's fences. A person's release without proof is of whatever is marked stopped
 * now (they checked the node).
 */
import type { Prisma } from "@ws-model-proxy/db";
import { DbNull } from "@ws-model-proxy/db/json-null";
import { fresh, isLeadingStop, launchedAfterWhere, owned, resolveRun } from "./instance-run";

type Tx = Prisma.TransactionClient;

/** How long an agent's release request waits for a person. */
export const RELEASE_REQUEST_TTL_MS = 24 * 3_600_000;

/** A person's release without proof: who, and why the node could not prove the stop then. */
export type UnprovenRelease = { by: string; reason: string };

/**
 * How a release is justified:
 * - `result`: a STOP or STATUS step of this rank whose stopped answer was recorded (SUCCEEDED) in
 *   this transaction;
 * - `observation`: an inventory record naming the last step the node ran for this rank's unit,
 *   which the node reports stopped, with its `rankIdle` as the node observed it;
 * - `neverRan`: the instance's own steps show this rank never ran since the last proven stop
 *   (evaluated here: a refusal before admission proves only the attempt it answers never ran,
 *   `refusedBeforeAdmission` in `instance-run.ts`);
 * - `unproven`: a person's release without proof of a claim marked stopped.
 */
export type ClaimRelease =
  | { result: { stepId: string } }
  | { observation: { stepId: string; rankIdle: boolean } }
  | { neverRan: true }
  | { unproven: UnprovenRelease };

type RankRow = {
  id: string;
  instanceId: string;
  nodeId: string | null;
  rank: number;
  claim: string;
  stoppedThroughRun: number;
};

/** The node's proof (a result or an observation) proves this run's rank stopped. */
async function proofHolds(
  tx: Tx,
  rank: RankRow,
  stepId: string,
  modality: "result" | "observation",
  /** An observation's `rankIdle`, as the node reported it. */
  observedIdle: boolean | null,
): Promise<boolean> {
  const step = await tx.instanceStep.findUnique({
    where: { id: stepId },
    select: {
      instanceId: true,
      rank: true,
      nodeId: true,
      phase: true,
      state: true,
      sequence: true,
      generation: true,
      rankIdle: true,
    },
  });
  // Bound to the claim: the same instance, rank and node.
  if (
    !step ||
    step.instanceId !== rank.instanceId ||
    step.rank !== rank.rank ||
    step.nodeId !== rank.nodeId
  )
    return false;
  if (modality === "result") {
    if ((step.phase !== "STOP" && step.phase !== "STATUS") || step.state !== "SUCCEEDED")
      return false;
    // The leading stop of a run proves the previous run ended: the claim stays (this run uses
    // it), unless it was marked stopped.
    if (isLeadingStop(step) && rank.claim !== "HELD_UNKNOWN") return false;
    // A status probe proves a claim marked stopped, or a stopping run's claim.
    if (step.phase === "STATUS" && rank.claim !== "HELD_UNKNOWN") {
      const instance = await tx.runtimeInstance.findUnique({
        where: { id: rank.instanceId },
        select: { phase: true },
      });
      if (instance?.phase !== "STOPPING") return false;
    }
  }
  // The node's stopped answer proves the stop only when the node also said that no other step
  // that may launch was in flight for the rank in its runner (`rankIdle`: a stop cancels them
  // first, a probe or an inventory record cancels nothing). The node knows what it admitted; the
  // server's own step states cannot (one sent under a lost connection may still wait there).
  if ((modality === "observation" ? observedIdle : step.rankIdle) !== true) return false;
  const run = await resolveRun(tx, rank.instanceId);
  return owned(step, run) && (await fresh(tx, step, run));
}

/**
 * The rank never ran since the last proven stop: no start-phase step after the run through which
 * its launches are proven stopped (`stoppedThroughRun`: recorded when a run's leading stop
 * succeeded, or a restart retook a claim released with proof) could have started a process
 * (`launchedAfterWhere`, the rule `physicalLaunch` reads: dispatched, and not refused before
 * admission with no earlier dispatch that may have run, `refusedBeforeAdmission`). Runs begun
 * since without launching anything (a restart stopped before its steps were prepared, or before
 * they were sent) launched nothing.
 */
async function neverRan(tx: Tx, rank: RankRow): Promise<boolean> {
  const launched = await tx.instanceStep.count({
    where: launchedAfterWhere(rank.instanceId, rank.rank, rank.stoppedThroughRun),
  });
  return launched === 0;
}

/**
 * Releases the claim (RELEASED: placement may reuse its resources and ports). A node's proof
 * (`result`, `observation`) or `neverRan` releases a held or marked-stopped claim only when the
 * checks above hold for the claim's current run; an `unproven` release takes only a claim marked
 * stopped (HELD_UNKNOWN), and the rank records who released it without proof, when, and the last
 * reason. Pending release requests for the claim are cleared. True when this call released it.
 */
export async function releaseClaim(
  tx: Tx,
  rankId: string,
  now: Date,
  release: ClaimRelease,
): Promise<boolean> {
  const unproven = "unproven" in release ? release.unproven : null;
  if (!unproven) {
    const rank = await tx.instanceRank.findUnique({
      where: { id: rankId },
      select: {
        id: true,
        instanceId: true,
        nodeId: true,
        rank: true,
        claim: true,
        stoppedThroughRun: true,
      },
    });
    if (!rank || (rank.claim !== "HELD" && rank.claim !== "HELD_UNKNOWN")) return false;
    const proven =
      "result" in release
        ? await proofHolds(tx, rank, release.result.stepId, "result", null)
        : "observation" in release
          ? await proofHolds(
              tx,
              rank,
              release.observation.stepId,
              "observation",
              release.observation.rankIdle,
            )
          : "neverRan" in release
            ? await neverRan(tx, rank)
            : false;
    if (!proven) return false;
  }
  const released = await tx.instanceRank.updateMany({
    where: unproven
      ? { id: rankId, claim: "HELD_UNKNOWN" }
      : { id: rankId, claim: { in: ["HELD", "HELD_UNKNOWN"] } },
    data: {
      claim: "RELEASED",
      claimChangedAt: now,
      stoppedAt: now,
      // A released claim holds nothing, a replaced run's claim (`retakeInstanceClaims`) included.
      prevResources: DbNull,
      prevPort: null,
      prevDistPort: null,
      prevGeneration: null,
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
