import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", () => ({ default: {}, Prisma: {} }));

import { StoreCapacityAdmissionRuntime } from "./runtime.js";

describe("capacity admission runtime", () => {
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
});
