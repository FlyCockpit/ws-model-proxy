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
import {
  fresh,
  isLeadingStop,
  isRunStartPhase,
  owned,
  RUN_START_PHASES,
  resolveRun,
} from "./instance-run";

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
 *   which the node reports stopped;
 * - `neverRan`: the instance's own steps show this rank never ran since the last proven stop
 *   (evaluated here; `preAdmissionErrors` are the node's codes that prove a step never ran);
 * - `unproven`: a person's release without proof of a claim marked stopped.
 */
export type ClaimRelease =
  | { result: { stepId: string } }
  | { observation: { stepId: string } }
  | { neverRan: { preAdmissionErrors: ReadonlySet<string> } }
  | { unproven: UnprovenRelease };

type RankRow = {
  id: string;
  instanceId: string;
  nodeId: string | null;
  rank: number;
  claim: string;
};

/** The node's proof (a result or an observation) proves this run's rank stopped. */
async function proofHolds(
  tx: Tx,
  rank: RankRow,
  stepId: string,
  modality: "result" | "observation",
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
  } else {
    // The node says stopped only once nothing of this rank can still start: no start step of
    // any run on its way or unanswered (a snapshot is taken between jobs, so one dispatched
    // earlier may still launch after it).
    const unresolved = await tx.instanceStep.count({
      where: {
        instanceId: rank.instanceId,
        rank: rank.rank,
        phase: { in: [...RUN_START_PHASES] },
        OR: [
          { state: { in: ["RUNNING", "AWAITING_OPERATOR"] } },
          { state: "PENDING", attempts: { gt: 0 } },
        ],
      },
    });
    if (unresolved > 0) return false;
  }
  const run = await resolveRun(tx, rank.instanceId);
  return owned(step, run) && (await fresh(tx, step, run));
}

/**
 * The rank never ran since the last proven stop: every start-phase step of the latest
 * generation that has any never ran (never sent, cancelled, or refused before admission), and
 * that generation is the first or its leading stop succeeded. (A run begun later without steps
 * launched nothing.)
 */
async function neverRan(
  tx: Tx,
  rank: RankRow,
  preAdmissionErrors: ReadonlySet<string>,
): Promise<boolean> {
  const latest =
    (
      await tx.instanceStep.aggregate({
        where: { instanceId: rank.instanceId, phase: { in: [...RUN_START_PHASES] } },
        _max: { generation: true },
      })
    )._max.generation ?? 0;
  const steps = await tx.instanceStep.findMany({
    where: { instanceId: rank.instanceId, rank: rank.rank, generation: latest },
    select: {
      phase: true,
      state: true,
      sequence: true,
      generation: true,
      attempts: true,
      errorCode: true,
    },
  });
  // Attempts count only dispatches that may have run something (a declined operator terminal,
  // or one ended before its screen came up, gives its attempt back), so a FAILED step without
  // one never ran.
  const allNever = steps
    .filter((step) => isRunStartPhase(step.phase))
    .every(
      (step) =>
        step.state === "CANCELLED" ||
        (step.state === "PENDING" && step.attempts === 0) ||
        (step.state === "FAILED" &&
          (step.attempts === 0 || preAdmissionErrors.has(step.errorCode ?? ""))),
    );
  const leading = steps.find((step) => isLeadingStop(step));
  return allNever && (latest <= 1 || leading?.state === "SUCCEEDED");
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
      select: { id: true, instanceId: true, nodeId: true, rank: true, claim: true },
    });
    if (!rank || (rank.claim !== "HELD" && rank.claim !== "HELD_UNKNOWN")) return false;
    const proven =
      "result" in release
        ? await proofHolds(tx, rank, release.result.stepId, "result")
        : "observation" in release
          ? await proofHolds(tx, rank, release.observation.stepId, "observation")
          : "neverRan" in release
            ? await neverRan(tx, rank, release.neverRan.preAdmissionErrors)
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
