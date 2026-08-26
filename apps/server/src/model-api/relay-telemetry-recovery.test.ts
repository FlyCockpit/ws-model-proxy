import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const { default: prisma } = await import("@ws-model-proxy/db");
const db = prisma as unknown as {
  relayExecutionEvent: { findMany: MockInstance; createMany: MockInstance };
  relayRequest: { updateMany: MockInstance };
  $transaction: MockInstance;
};
const { reconcileStaleLocalRelayTelemetry } = await import("./relay-telemetry-recovery.js");

describe("local relay telemetry crash recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.$transaction.mockImplementation(async (run: (tx: typeof db) => Promise<void>) => run(db));
    db.relayExecutionEvent.createMany.mockResolvedValue({ count: 1 });
    db.relayRequest.updateMany.mockResolvedValue({ count: 1 });
  });

  it("append-only terminalizes stale attempts without copying request content", async () => {
    db.relayExecutionEvent.findMany
      .mockResolvedValueOnce([
        {
          userId: "owner-id",
          relayRequestId: "relay-id",
          attemptId: "attempt-id",
          requestedSurface: "ANTHROPIC_MESSAGES",
          nativeSurface: "OPENAI_RESPONSES",
          adapterMode: "ADAPTED",
          adapterVersion: "1.0.0",
          poolId: "pool-id",
          poolMemberId: "member-id",
          executionTargetId: "target-id",
          memberTier: "PRIMARY",
          prompt: "must-not-copy",
        },
      ])
      .mockResolvedValueOnce([]);

    await expect(
      reconcileStaleLocalRelayTelemetry({
        now: new Date("2026-08-26T00:00:00.000Z"),
        staleMs: 60_000,
      }),
    ).resolves.toBe(1);

    expect(db.relayExecutionEvent.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          relayRequestId: "relay-id",
          attemptId: "attempt-id",
          eventType: "CRASH_RECOVERED",
          terminalState: "FAILED",
          errorClass: "crash_recovered",
        }),
      ],
      skipDuplicates: true,
    });
    expect(JSON.stringify(db.relayExecutionEvent.createMany.mock.calls)).not.toContain(
      "must-not-copy",
    );
    expect(db.relayRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: ["relay-id"] }, status: "PENDING" }),
        data: expect.objectContaining({ status: "FAILED", errorClass: "crash_recovered" }),
      }),
    );
  });
});
