import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", () => ({ default: {}, Prisma: {} }));

import { StoreCapacityAdmissionRuntime } from "./runtime.js";

describe("capacity admission runtime", () => {
  it("rejects polling intervals that cannot safely refresh waiting heartbeats", () => {
    expect(() => new StoreCapacityAdmissionRuntime({} as never, 10_001)).toThrow(/poll interval/i);
  });
  it("polls one durable attempt with candidates only on initial enqueue", async () => {
    const acquire = vi
      .fn()
      .mockResolvedValueOnce({ state: "WAITING", requestId: "request" })
      .mockResolvedValueOnce({ state: "CANCELLED" });
    const runtime = new StoreCapacityAdmissionRuntime(
      {
        acquire,
        release: vi.fn(),
        heartbeat: vi.fn(),
        cancelAttempt: vi.fn(),
        reclaimExpired: vi.fn(),
      },
      1,
    );
    await expect(
      runtime.acquire({
        requestId: "request",
        attemptId: "attempt",
        ownerId: "owner",
        sourceKind: "DIRECT",
        basePriority: 16,
        connectionOwner: "server",
        deadlineAt: new Date(Date.now() + 100),
        candidates: [{ capacityId: "capacity", executionTargetId: "target", candidateOrder: 0 }],
      }),
    ).resolves.toEqual({ state: "CANCELLED" });
    expect(acquire.mock.calls[1]?.[0].candidates).toEqual([]);
  });

  it("runs bounded request-scoped maintenance once per interval", async () => {
    const sweepAbandoned = vi.fn().mockResolvedValue({ requests: 0, leases: 0 });
    const store = {
      acquire: vi.fn().mockResolvedValue({ state: "CANCELLED" }),
      release: vi.fn(),
      heartbeat: vi.fn(),
      cancelAttempt: vi.fn(),
      reclaimExpired: vi.fn(),
      sweepAbandoned,
    };
    const runtime = new StoreCapacityAdmissionRuntime(store, 1, 60_000);
    const attempt = {
      requestId: "request",
      attemptId: "attempt",
      ownerId: "owner",
      sourceKind: "DIRECT" as const,
      basePriority: 16,
      connectionOwner: "server",
      deadlineAt: new Date(Date.now() + 100),
      candidates: [{ capacityId: "capacity", executionTargetId: "target", candidateOrder: 0 }],
    };
    await runtime.acquire(attempt);
    await runtime.acquire({ ...attempt, attemptId: "attempt-2" });
    expect(sweepAbandoned).toHaveBeenCalledTimes(1);
  });
});
