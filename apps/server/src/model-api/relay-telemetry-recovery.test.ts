import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  const actual = await vi.importActual<typeof import("@ws-model-proxy/db")>("@ws-model-proxy/db");
  return { default: mockDeep(), Prisma: actual.Prisma };
});
vi.mock("@ws-model-proxy/env/shared", () => ({
  env: { DATABASE_URL: "postgresql://relay-telemetry-recovery-test", NODE_ENV: "test" },
}));

const { default: prisma } = await import("@ws-model-proxy/db");
const db = prisma as unknown as {
  relayExecutionAttempt: { findMany: MockInstance; updateMany: MockInstance };
  relayExecutionEvent: { createMany: MockInstance };
  relayRequest: { update: MockInstance; updateMany: MockInstance; findMany: MockInstance };
  $transaction: MockInstance;
  $queryRaw: MockInstance;
  $executeRaw: MockInstance;
};
const recovery = await import("./relay-telemetry-recovery.js");

function attempt(overrides: Record<string, unknown> = {}) {
  return {
    attemptId: "attempt-id",
    userId: "owner-id",
    relayRequestId: "relay-id",
    ownerEpoch: "dead-process",
    attemptKind: "EXECUTION",
    requestedSurface: "ANTHROPIC_MESSAGES",
    nativeSurface: "OPENAI_RESPONSES",
    adapterMode: "ADAPTED",
    adapterVersion: "1.0.0",
    poolId: "pool-id",
    poolMemberId: "member-id",
    executionTargetId: "target-id",
    memberTier: "PRIMARY",
    requestBytes: null,
    responseBytes: null,
    ...overrides,
  };
}

describe("local relay telemetry lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recovery.resetLocalRelayAttemptRegistryForTests();
    db.$transaction.mockImplementation(async (run: (tx: typeof db) => Promise<number>) => run(db));
    db.$queryRaw.mockResolvedValue([{ now: new Date("2026-08-26T00:00:00.000Z") }]);
    db.relayExecutionAttempt.updateMany.mockResolvedValue({ count: 1 });
    db.relayExecutionEvent.createMany.mockResolvedValue({ count: 1 });
    db.relayRequest.updateMany.mockResolvedValue({ count: 1 });
    db.relayRequest.update.mockResolvedValue({ id: "relay-id" });
  });

  it("heartbeats only attempts this process holds in flight", async () => {
    const now = new Date("2026-08-26T00:00:00.000Z");
    // Nothing held: no attempt row is kept alive (and no query is issued).
    await expect(recovery.heartbeatOwnedLocalRelayAttempts()).resolves.toEqual({ count: 0 });
    expect(db.relayExecutionAttempt.updateMany).not.toHaveBeenCalled();

    recovery.trackLocalRelayAttempt("held-attempt", "relay-id");
    await recovery.heartbeatOwnedLocalRelayAttempts();
    expect(db.relayExecutionAttempt.updateMany).toHaveBeenCalledWith({
      where: {
        attemptId: { in: ["held-attempt"] },
        ownerEpoch: recovery.LOCAL_RELAY_PROCESS_EPOCH,
        state: "ACTIVE",
      },
      data: {
        heartbeatAt: now,
        expiresAt: new Date(now.getTime() + recovery.LOCAL_RELAY_ATTEMPT_TTL_MS),
      },
    });

    // A committed finalization releases the attempt.
    await recovery.runLocalAttemptFinalization("held-attempt", async () => undefined);
    vi.clearAllMocks();
    await recovery.heartbeatOwnedLocalRelayAttempts();
    expect(db.relayExecutionAttempt.updateMany).not.toHaveBeenCalled();
  });

  it("retries a failed finalization and keeps its attempt alive until it commits", async () => {
    recovery.trackLocalRelayAttempt("attempt-1", "relay-id");
    const finalize = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce(undefined);
    await expect(recovery.runLocalAttemptFinalization("attempt-1", finalize)).rejects.toThrow(
      "db down",
    );
    await recovery.heartbeatOwnedLocalRelayAttempts();
    expect(db.relayExecutionAttempt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ attemptId: { in: ["attempt-1"] } }),
      }),
    );
    await expect(recovery.retryDeferredLocalAttemptFinalizations()).resolves.toBe(1);
    expect(finalize).toHaveBeenCalledTimes(2);
    vi.clearAllMocks();
    await recovery.heartbeatOwnedLocalRelayAttempts();
    expect(db.relayExecutionAttempt.updateMany).not.toHaveBeenCalled();
  });

  it("finalizes a PENDING request whose local finalization never commits within bounded time", async () => {
    const startMs = Date.parse("2026-08-26T00:00:00.000Z");
    recovery.trackLocalRelayAttempt("stuck-attempt", "relay-id", startMs);
    const finalize = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("db down"));
    await expect(recovery.runLocalAttemptFinalization("stuck-attempt", finalize)).rejects.toThrow();

    // Past the in-flight deadline the entry is dropped: no more heartbeats.
    const afterDeadline = startMs + recovery.LOCAL_RELAY_ATTEMPT_MAX_IN_FLIGHT_MS + 1;
    await recovery.retryDeferredLocalAttemptFinalizations(afterDeadline);
    vi.clearAllMocks();
    db.$transaction.mockImplementation(async (run: (tx: typeof db) => Promise<number>) => run(db));
    db.$queryRaw.mockResolvedValue([{ now: new Date("2026-08-26T00:30:00.000Z") }]);
    db.relayExecutionAttempt.updateMany.mockResolvedValue({ count: 1 });
    db.relayExecutionEvent.createMany.mockResolvedValue({ count: 1 });
    db.relayRequest.updateMany.mockResolvedValue({ count: 1 });
    db.relayRequest.findMany.mockResolvedValue([]);
    await recovery.heartbeatOwnedLocalRelayAttempts(afterDeadline);
    expect(db.relayExecutionAttempt.updateMany).not.toHaveBeenCalled();

    // Once its row expires, crash repair (own epoch included) finalizes it.
    db.relayExecutionAttempt.findMany.mockResolvedValue([
      attempt({ attemptId: "stuck-attempt", ownerEpoch: recovery.LOCAL_RELAY_PROCESS_EPOCH }),
    ]);
    await expect(
      recovery.reconcileStaleLocalRelayTelemetry({ nowMs: afterDeadline }),
    ).resolves.toBe(1);
    expect(db.relayExecutionAttempt.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { ownerEpoch: { not: recovery.LOCAL_RELAY_PROCESS_EPOCH } },
            { ownerEpoch: recovery.LOCAL_RELAY_PROCESS_EPOCH, attemptId: { notIn: [] } },
          ],
        }),
      }),
    );
    expect(db.relayRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "relay-id", status: "PENDING" },
        data: expect.objectContaining({ status: "FAILED", errorClass: "crash_recovered" }),
      }),
    );
  });

  it("never transitions a request that still has a held attempt in this process", async () => {
    recovery.trackLocalRelayAttempt("live-attempt", "relay-id");
    db.relayExecutionAttempt.findMany.mockResolvedValue([
      attempt({ attemptId: "leaked-attempt", ownerEpoch: recovery.LOCAL_RELAY_PROCESS_EPOCH }),
    ]);
    await expect(recovery.reconcileStaleLocalRelayTelemetry()).resolves.toBe(1);
    // The leaked attempt is closed, but the live attempt owns the request.
    expect(db.relayExecutionEvent.createMany).toHaveBeenCalledTimes(1);
    expect(db.relayRequest.updateMany).not.toHaveBeenCalled();
    expect(db.relayExecutionAttempt.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            {
              ownerEpoch: recovery.LOCAL_RELAY_PROCESS_EPOCH,
              attemptId: { notIn: ["live-attempt"] },
            },
          ]),
        }),
      }),
    );
  });

  it("runs deferred finalizations before heartbeats and repair", async () => {
    const order: string[] = [];
    const stop = recovery.startRelayTelemetryRecovery({
      intervalMs: 60_000,
      retryFinalizations: async () => void order.push("retry"),
      heartbeat: async () => void order.push("heartbeat"),
      reconcile: async () => void order.push("reconcile"),
    });
    await vi.waitFor(() => expect(order).toEqual(["retry", "heartbeat", "reconcile"]));
    stop();
  });

  it("rechecks the expired foreign owner transactionally before crash recovery", async () => {
    db.relayExecutionAttempt.findMany.mockResolvedValue([attempt({ prompt: "must-not-copy" })]);
    await expect(recovery.reconcileStaleLocalRelayTelemetry()).resolves.toBe(1);
    expect(db.relayExecutionAttempt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          attemptId: "attempt-id",
          ownerEpoch: "dead-process",
          state: "ACTIVE",
          expiresAt: { lte: new Date("2026-08-26T00:00:00.000Z") },
        }),
      }),
    );
    expect(JSON.stringify(db.relayExecutionEvent.createMany.mock.calls)).not.toContain(
      "must-not-copy",
    );
    expect(db.relayRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ errorClass: "crash_recovered" }) }),
    );
  });

  it("records the usage rollup exactly once, only when crash repair performs the transition", async () => {
    db.relayExecutionAttempt.findMany.mockResolvedValue([attempt()]);
    db.relayRequest.findMany.mockResolvedValue([
      {
        id: "relay-id",
        userId: "owner-id",
        status: "FAILED",
        source: "API_TOKEN",
        startedAt: new Date("2026-08-25T23:50:00.000Z"),
        completedAt: new Date("2026-08-26T00:00:00.000Z"),
        durationMs: null,
        firstClientByteAt: null,
        requestedModelPoolId: "pool-id",
        selectedPoolMemberId: "member-id",
        requestedExecutionTargetId: null,
        selectedExecutionTargetId: "target-id",
        attemptCount: 1,
        promptTokens: null,
        completionTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        usageKnown: false,
      },
    ]);
    db.$executeRaw.mockResolvedValue(1);
    await recovery.reconcileStaleLocalRelayTelemetry();
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);

    // A normal completion already won: the guarded transition matches nothing.
    vi.clearAllMocks();
    db.$transaction.mockImplementation(async (run: (tx: typeof db) => Promise<number>) => run(db));
    db.$queryRaw.mockResolvedValue([{ now: new Date("2026-08-26T00:00:00.000Z") }]);
    db.relayExecutionAttempt.findMany.mockResolvedValue([attempt()]);
    db.relayExecutionAttempt.updateMany.mockResolvedValue({ count: 1 });
    db.relayExecutionEvent.createMany.mockResolvedValue({ count: 1 });
    db.relayRequest.updateMany.mockResolvedValue({ count: 0 });
    await recovery.reconcileStaleLocalRelayTelemetry();
    expect(db.relayRequest.findMany).not.toHaveBeenCalled();
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  it("does nothing when a concurrent heartbeat wins the expiry race", async () => {
    db.relayExecutionAttempt.findMany.mockResolvedValue([attempt()]);
    db.relayExecutionAttempt.updateMany.mockResolvedValue({ count: 0 });
    await expect(recovery.reconcileStaleLocalRelayTelemetry()).resolves.toBe(0);
    expect(db.relayExecutionEvent.createMany).not.toHaveBeenCalled();
    expect(db.relayRequest.updateMany).not.toHaveBeenCalled();
  });

  it("selects only expired attempts: foreign epochs, or own attempts no longer held", async () => {
    db.relayExecutionAttempt.findMany.mockResolvedValue([]);
    const now = new Date("2026-08-26T00:00:00.000Z");
    await recovery.reconcileStaleLocalRelayTelemetry();
    expect(db.relayExecutionAttempt.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          state: "ACTIVE",
          expiresAt: { lte: now },
          OR: [
            { ownerEpoch: { not: recovery.LOCAL_RELAY_PROCESS_EPOCH } },
            { ownerEpoch: recovery.LOCAL_RELAY_PROCESS_EPOCH, attemptId: { notIn: [] } },
          ],
        },
      }),
    );
  });
});
