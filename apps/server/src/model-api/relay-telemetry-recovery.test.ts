import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const { default: prisma } = await import("@ws-model-proxy/db");
const db = prisma as unknown as {
  relayExecutionAttempt: { findMany: MockInstance; updateMany: MockInstance };
  relayExecutionEvent: { createMany: MockInstance };
  relayRequest: { update: MockInstance; updateMany: MockInstance };
  $transaction: MockInstance;
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
    db.$transaction.mockImplementation(async (run: (tx: typeof db) => Promise<number>) => run(db));
    db.relayExecutionAttempt.updateMany.mockResolvedValue({ count: 1 });
    db.relayExecutionEvent.createMany.mockResolvedValue({ count: 1 });
    db.relayRequest.updateMany.mockResolvedValue({ count: 1 });
    db.relayRequest.update.mockResolvedValue({ id: "relay-id" });
  });

  it("heartbeats only active attempts owned by this process epoch", async () => {
    const now = new Date("2026-08-26T00:00:00.000Z");
    await recovery.heartbeatOwnedLocalRelayAttempts({ now });
    expect(db.relayExecutionAttempt.updateMany).toHaveBeenCalledWith({
      where: { ownerEpoch: recovery.LOCAL_RELAY_PROCESS_EPOCH, state: "ACTIVE" },
      data: {
        heartbeatAt: now,
        expiresAt: new Date(now.getTime() + recovery.LOCAL_RELAY_ATTEMPT_TTL_MS),
      },
    });
  });

  it("rechecks the expired foreign owner transactionally before crash recovery", async () => {
    db.relayExecutionAttempt.findMany.mockResolvedValue([attempt({ prompt: "must-not-copy" })]);
    await expect(
      recovery.reconcileStaleLocalRelayTelemetry({
        now: new Date("2026-08-26T00:00:00.000Z"),
      }),
    ).resolves.toBe(1);
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

  it("does nothing when a concurrent heartbeat wins the expiry race", async () => {
    db.relayExecutionAttempt.findMany.mockResolvedValue([attempt()]);
    db.relayExecutionAttempt.updateMany.mockResolvedValue({ count: 0 });
    await expect(recovery.reconcileStaleLocalRelayTelemetry()).resolves.toBe(0);
    expect(db.relayExecutionEvent.createMany).not.toHaveBeenCalled();
    expect(db.relayRequest.updateMany).not.toHaveBeenCalled();
  });

  it("does not select healthy or current-process attempts for recovery", async () => {
    db.relayExecutionAttempt.findMany.mockResolvedValue([]);
    const now = new Date("2026-08-26T00:00:00.000Z");
    await recovery.reconcileStaleLocalRelayTelemetry({ now });
    expect(db.relayExecutionAttempt.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          state: "ACTIVE",
          expiresAt: { lte: now },
          ownerEpoch: { not: recovery.LOCAL_RELAY_PROCESS_EPOCH },
        },
      }),
    );
  });
});
