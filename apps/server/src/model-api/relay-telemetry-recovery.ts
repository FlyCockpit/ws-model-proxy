import prisma from "@ws-model-proxy/db";

const DEFAULT_STALE_MS = 10 * 60 * 1000;

export async function reconcileStaleLocalRelayTelemetry({
  now = new Date(),
  staleMs = DEFAULT_STALE_MS,
  limit = 500,
} = {}) {
  const cutoff = new Date(now.getTime() - staleMs);
  const starts = await prisma.relayExecutionEvent.findMany({
    where: {
      eventType: "ATTEMPT_STARTED",
      RelayRequest: { status: "PENDING", startedAt: { lt: cutoff } },
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  if (starts.length === 0) return 0;
  const terminalEvents = await prisma.relayExecutionEvent.findMany({
    where: {
      attemptId: { in: starts.map((event) => event.attemptId) },
      eventType: { in: ["TERMINAL", "CRASH_RECOVERED"] },
    },
    select: { attemptId: true },
  });
  const terminalAttemptIds = new Set(terminalEvents.map((event) => event.attemptId));
  const abandoned = starts.filter((event) => !terminalAttemptIds.has(event.attemptId));
  if (abandoned.length === 0) return 0;
  const requestIds = [...new Set(abandoned.map((event) => event.relayRequestId))];
  await prisma.$transaction(async (tx) => {
    await tx.relayExecutionEvent.createMany({
      data: abandoned.map((event) => ({
        userId: event.userId,
        relayRequestId: event.relayRequestId,
        attemptId: event.attemptId,
        eventType: "CRASH_RECOVERED",
        requestedSurface: event.requestedSurface,
        nativeSurface: event.nativeSurface,
        adapterMode: event.adapterMode,
        adapterVersion: event.adapterVersion,
        poolId: event.poolId,
        poolMemberId: event.poolMemberId,
        executionTargetId: event.executionTargetId,
        memberTier: event.memberTier,
        terminalState: "FAILED",
        errorClass: "crash_recovered",
      })),
      skipDuplicates: true,
    });
    await tx.relayRequest.updateMany({
      where: { id: { in: requestIds }, status: "PENDING", startedAt: { lt: cutoff } },
      data: {
        status: "FAILED",
        completedAt: now,
        errorClass: "crash_recovered",
        admissionTerminalState: "CRASH_RECOVERED",
      },
    });
  });
  return requestIds.length;
}

export function startRelayTelemetryRecovery({
  intervalMs = 60_000,
  reconcile = reconcileStaleLocalRelayTelemetry,
} = {}) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await reconcile();
    } catch {
      console.warn("[relay-telemetry] crash recovery failed");
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
