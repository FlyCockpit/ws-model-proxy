import prisma from "@ws-model-proxy/db";
import { MODEL_API_RELAY_TIMEOUT_MS } from "./limits.js";
import { recordRollupsForTransitionedRequests } from "./usage-rollup.js";

export const LOCAL_RELAY_PROCESS_EPOCH = crypto.randomUUID();
export const LOCAL_RELAY_ATTEMPT_TTL_MS = 2 * 60 * 1000;
/**
 * Upper bound on how long this process keeps an attempt it started alive.
 * Every relay attempt settles its terminal by its own timeout (at most
 * MODEL_API_RELAY_TIMEOUT_MS); the grace covers finalization retries.
 */
export const LOCAL_RELAY_ATTEMPT_MAX_IN_FLIGHT_MS = MODEL_API_RELAY_TIMEOUT_MS + 5 * 60 * 1000;

/*
 * Liveness of locally owned relay attempts.
 *
 * Predicate (the only thing that keeps an attempt row ACTIVE):
 *   an ACTIVE relay_execution_attempt row owned by this process epoch is
 *   heartbeated iff its attemptId is in `inFlightLocalAttempts` and was
 *   registered less than LOCAL_RELAY_ATTEMPT_MAX_IN_FLIGHT_MS ago.
 *
 * An entry is registered before its ATTEMPT_STARTED row is written and leaves
 * the set when the attempt's finalization transaction COMMITS (whether or not
 * it won the attempt claim). If finalization throws (DB error), the entry
 * stays with its finalization closure and the recovery loop re-runs it every
 * tick, so a transient failure still records the real terminal status. After
 * LOCAL_RELAY_ATTEMPT_MAX_IN_FLIGHT_MS the entry is dropped regardless.
 *
 * Consequence (bounded liveness while the owning process is alive): an
 * attempt whose finalization never commits stops being heartbeated at most
 * MAX_IN_FLIGHT after it started, expires LOCAL_RELAY_ATTEMPT_TTL_MS later,
 * and the next recovery tick (every 30 s) repairs it - including attempts of
 * THIS epoch that are no longer held - moving its PENDING RelayRequest to
 * FAILED through the status-guarded, rollup-accounted transition. Requests
 * that still have a held attempt in this process are never transitioned by
 * repair (their live attempt finalizes them). Other processes' attempts are
 * repaired as before once expired (their owner died or stopped heartbeating).
 */
type InFlightLocalAttempt = {
  relayRequestId: string;
  registeredAtMs: number;
  /** Set when a finalization attempt failed; re-run by the recovery loop. */
  retry: (() => Promise<unknown>) | null;
};

const inFlightLocalAttempts = new Map<string, InFlightLocalAttempt>();

function isHeld(entry: InFlightLocalAttempt, nowMs: number) {
  return nowMs - entry.registeredAtMs < LOCAL_RELAY_ATTEMPT_MAX_IN_FLIGHT_MS;
}

/** Registers an attempt this process is about to start. */
export function trackLocalRelayAttempt(
  attemptId: string,
  relayRequestId: string,
  nowMs: number = Date.now(),
) {
  inFlightLocalAttempts.set(attemptId, { relayRequestId, registeredAtMs: nowMs, retry: null });
}

/**
 * Runs an attempt's finalization transaction. On commit the attempt leaves
 * the in-flight set; on failure the closure is kept for retry and the error
 * is rethrown to the caller (which logs it).
 */
export async function runLocalAttemptFinalization(
  attemptId: string,
  finalize: () => Promise<unknown>,
): Promise<void> {
  try {
    await finalize();
  } catch (error) {
    const entry = inFlightLocalAttempts.get(attemptId);
    if (entry) entry.retry = finalize;
    throw error;
  }
  inFlightLocalAttempts.delete(attemptId);
}

/** Drops expired entries and re-runs deferred finalizations. */
export async function retryDeferredLocalAttemptFinalizations(nowMs: number = Date.now()) {
  let finalized = 0;
  for (const [attemptId, entry] of [...inFlightLocalAttempts]) {
    if (!isHeld(entry, nowMs)) {
      inFlightLocalAttempts.delete(attemptId);
      console.warn("[relay-telemetry] dropped an unfinalized local attempt after its deadline");
      continue;
    }
    if (!entry.retry) continue;
    try {
      await entry.retry();
      inFlightLocalAttempts.delete(attemptId);
      finalized += 1;
    } catch {
      // Kept for the next tick until the deadline above.
    }
  }
  return finalized;
}

function heldLocalAttempts(nowMs: number) {
  const attemptIds: string[] = [];
  const relayRequestIds = new Set<string>();
  for (const [attemptId, entry] of inFlightLocalAttempts) {
    if (!isHeld(entry, nowMs)) continue;
    attemptIds.push(attemptId);
    relayRequestIds.add(entry.relayRequestId);
  }
  return { attemptIds, relayRequestIds };
}

/** Test-only: resets the in-process registry. */
export function resetLocalRelayAttemptRegistryForTests() {
  inFlightLocalAttempts.clear();
}

async function databaseNow(client: Pick<typeof prisma, "$queryRaw">) {
  const [clock] = await client.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  if (!clock) throw new Error("Database clock query returned no row");
  return clock.now;
}

export async function heartbeatOwnedLocalRelayAttempts(nowMs: number = Date.now()) {
  const { attemptIds } = heldLocalAttempts(nowMs);
  if (attemptIds.length === 0) return { count: 0 };
  return prisma.$transaction(async (tx) => {
    const now = await databaseNow(tx);
    return tx.relayExecutionAttempt.updateMany({
      where: {
        attemptId: { in: attemptIds },
        ownerEpoch: LOCAL_RELAY_PROCESS_EPOCH,
        state: "ACTIVE",
      },
      data: {
        heartbeatAt: now,
        expiresAt: new Date(now.getTime() + LOCAL_RELAY_ATTEMPT_TTL_MS),
      },
    });
  });
}

export async function reconcileStaleLocalRelayTelemetry({
  limit = 500,
  nowMs = Date.now(),
}: {
  limit?: number;
  nowMs?: number;
} = {}) {
  const now = await databaseNow(prisma);
  const held = heldLocalAttempts(nowMs);
  const candidates = await prisma.relayExecutionAttempt.findMany({
    where: {
      state: "ACTIVE",
      expiresAt: { lte: now },
      OR: [
        { ownerEpoch: { not: LOCAL_RELAY_PROCESS_EPOCH } },
        // Own attempts this process no longer holds (finalization never
        // committed before the in-flight deadline): repaired like a crash.
        { ownerEpoch: LOCAL_RELAY_PROCESS_EPOCH, attemptId: { notIn: held.attemptIds } },
      ],
    },
    orderBy: { expiresAt: "asc" },
    take: limit,
  });
  let recovered = 0;
  for (const attempt of candidates) {
    if (
      attempt.ownerEpoch === LOCAL_RELAY_PROCESS_EPOCH &&
      held.attemptIds.includes(attempt.attemptId)
    )
      continue;
    recovered += await prisma.$transaction(async (tx) => {
      const claimTime = await databaseNow(tx);
      const claimed = await tx.relayExecutionAttempt.updateMany({
        where: {
          attemptId: attempt.attemptId,
          ownerEpoch: attempt.ownerEpoch,
          state: "ACTIVE",
          expiresAt: { lte: claimTime },
        },
        data: {
          ownerEpoch: LOCAL_RELAY_PROCESS_EPOCH,
          state: "FAILED",
          terminalAt: claimTime,
          terminalState: "FAILED",
          requestBytes: attempt.requestBytes ?? 0n,
          responseBytes: attempt.responseBytes ?? 0n,
        },
      });
      if (claimed.count === 0) return 0;
      await tx.relayExecutionEvent.createMany({
        data: [
          {
            userId: attempt.userId,
            relayRequestId: attempt.relayRequestId,
            attemptId: attempt.attemptId,
            eventType: "CRASH_RECOVERED",
            attemptKind: attempt.attemptKind,
            requestedSurface: attempt.requestedSurface,
            nativeSurface: attempt.nativeSurface,
            adapterMode: attempt.adapterMode,
            adapterVersion: attempt.adapterVersion,
            poolId: attempt.poolId,
            poolMemberId: attempt.poolMemberId,
            executionTargetId: attempt.executionTargetId,
            memberTier: attempt.memberTier,
            terminalState: "FAILED",
            errorClass: "crash_recovered",
          },
        ],
        skipDuplicates: true,
      });
      if (attempt.attemptKind === "CONTEXT_COUNT") {
        await tx.relayRequest.update({
          where: { id: attempt.relayRequestId },
          data: { auxiliaryAttemptCount: { increment: 1 } },
        });
      } else if (!held.relayRequestIds.has(attempt.relayRequestId)) {
        // A request that still has a held attempt in this process is being
        // finalized by that attempt; repair only closes the leaked attempt.
        // Status-guarded terminal transition; the rollup increment is written
        // in this same transaction only when this repair performed it, so a
        // normal completion that already won is never counted twice.
        const transitioned = await tx.relayRequest.updateMany({
          where: { id: attempt.relayRequestId, status: "PENDING" },
          data: {
            status: "FAILED",
            completedAt: claimTime,
            errorClass: "crash_recovered",
            admissionTerminalState: "CRASH_RECOVERED",
          },
        });
        if (transitioned.count === 1)
          await recordRollupsForTransitionedRequests(tx, [attempt.relayRequestId], claimTime);
      }
      return 1;
    });
  }
  return recovered;
}

export function startRelayTelemetryRecovery({
  intervalMs = 30_000,
  heartbeat = heartbeatOwnedLocalRelayAttempts,
  retryFinalizations = retryDeferredLocalAttemptFinalizations,
  reconcile = reconcileStaleLocalRelayTelemetry,
}: {
  intervalMs?: number;
  heartbeat?: () => Promise<unknown>;
  retryFinalizations?: () => Promise<unknown>;
  reconcile?: () => Promise<unknown>;
} = {}) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      // Retry first so a recovered finalization records the real status
      // before its attempt could be considered for repair.
      await retryFinalizations();
      await heartbeat();
      await reconcile();
    } catch {
      console.warn("[relay-telemetry] lifecycle maintenance failed");
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
