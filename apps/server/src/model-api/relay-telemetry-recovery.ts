import prisma from "@ws-model-proxy/db";

export const LOCAL_RELAY_PROCESS_EPOCH = crypto.randomUUID();
export const LOCAL_RELAY_ATTEMPT_TTL_MS = 2 * 60 * 1000;

export async function heartbeatOwnedLocalRelayAttempts({ now = new Date() } = {}) {
  return prisma.relayExecutionAttempt.updateMany({
    where: { ownerEpoch: LOCAL_RELAY_PROCESS_EPOCH, state: "ACTIVE" },
    data: {
      heartbeatAt: now,
      expiresAt: new Date(now.getTime() + LOCAL_RELAY_ATTEMPT_TTL_MS),
    },
  });
}

export async function reconcileStaleLocalRelayTelemetry({ now = new Date(), limit = 500 } = {}) {
  const candidates = await prisma.relayExecutionAttempt.findMany({
    where: {
      state: "ACTIVE",
      expiresAt: { lte: now },
      ownerEpoch: { not: LOCAL_RELAY_PROCESS_EPOCH },
    },
    orderBy: { expiresAt: "asc" },
    take: limit,
  });
  let recovered = 0;
  for (const attempt of candidates) {
    recovered += await prisma.$transaction(async (tx) => {
      const claimed = await tx.relayExecutionAttempt.updateMany({
        where: {
          attemptId: attempt.attemptId,
          ownerEpoch: attempt.ownerEpoch,
          state: "ACTIVE",
          expiresAt: { lte: now },
        },
        data: {
          state: "FAILED",
          terminalAt: now,
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
      } else {
        await tx.relayRequest.updateMany({
          where: { id: attempt.relayRequestId, status: "PENDING" },
          data: {
            status: "FAILED",
            completedAt: now,
            errorClass: "crash_recovered",
            admissionTerminalState: "CRASH_RECOVERED",
          },
        });
      }
      return 1;
    });
  }
  return recovered;
}

export function startRelayTelemetryRecovery({
  intervalMs = 30_000,
  heartbeat = heartbeatOwnedLocalRelayAttempts,
  reconcile = reconcileStaleLocalRelayTelemetry,
} = {}) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
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
