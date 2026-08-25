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
        terminalizeAttempt: vi.fn().mockResolvedValue({ state: "CANCELLED" }),
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
      terminalizeAttempt: vi.fn().mockResolvedValue({ state: "CANCELLED" }),
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

  it("durably cancels an aborted waiter before returning", async () => {
    const controller = new AbortController();
    const terminalizeAttempt = vi.fn().mockResolvedValue({ state: "CANCELLED" });
    const acquire = vi.fn().mockImplementation(async () => {
      controller.abort();
      return { state: "WAITING", requestId: "request" };
    });
    const runtime = new StoreCapacityAdmissionRuntime(
      {
        acquire,
        release: vi.fn(),
        heartbeat: vi.fn(),
        terminalizeAttempt,
        reclaimExpired: vi.fn(),
      },
      1,
    );
    await expect(
      runtime.acquire(
        {
          requestId: "request",
          attemptId: "attempt",
          ownerId: "owner",
          sourceKind: "DIRECT",
          basePriority: 16,
          connectionOwner: "server",
          deadlineAt: new Date(Date.now() + 100),
          candidates: [{ capacityId: "capacity", executionTargetId: "target", candidateOrder: 0 }],
        },
        controller.signal,
      ),
    ).resolves.toEqual({ state: "CANCELLED" });
    expect(terminalizeAttempt).toHaveBeenCalledWith("attempt", "CANCELLED");
  });

  it("releases admission when abort wins immediately after acquire", async () => {
    const controller = new AbortController();
    const lease = {
      leaseId: "lease",
      attemptId: "attempt",
      capacityId: "capacity",
      executionTargetId: "target",
      fencingToken: 1n,
      expiresAt: new Date(Date.now() + 30_000),
    };
    const release = vi.fn().mockResolvedValue(true);
    const runtime = new StoreCapacityAdmissionRuntime(
      {
        acquire: vi.fn().mockImplementation(async () => {
          controller.abort();
          return { state: "ADMITTED", lease };
        }),
        release,
        heartbeat: vi.fn(),
        terminalizeAttempt: vi.fn().mockResolvedValue({ state: "ADMITTED", lease }),
        reclaimExpired: vi.fn(),
      },
      1,
    );
    await expect(
      runtime.acquire(
        {
          requestId: "request",
          attemptId: "attempt",
          ownerId: "owner",
          sourceKind: "DIRECT",
          basePriority: 16,
          connectionOwner: "server",
          deadlineAt: new Date(Date.now() + 100),
          candidates: [{ capacityId: "capacity", executionTargetId: "target", candidateOrder: 0 }],
        },
        controller.signal,
      ),
    ).resolves.toEqual({ state: "CANCELLED" });
    expect(release).toHaveBeenCalledWith(lease);
  });

  it("releases a lease that atomically wins against waiter cancellation", async () => {
    const controller = new AbortController();
    const lease = {
      leaseId: "race-lease",
      attemptId: "attempt",
      capacityId: "capacity",
      executionTargetId: "target",
      fencingToken: 2n,
      expiresAt: new Date(Date.now() + 30_000),
    };
    const release = vi.fn().mockResolvedValue(true);
    const runtime = new StoreCapacityAdmissionRuntime(
      {
        acquire: vi.fn().mockImplementation(async () => {
          controller.abort();
          return { state: "WAITING", requestId: "request" };
        }),
        release,
        heartbeat: vi.fn(),
        terminalizeAttempt: vi.fn().mockResolvedValue({ state: "ADMITTED", lease }),
        reclaimExpired: vi.fn(),
      },
      1,
    );
    await expect(
      runtime.acquire(
        {
          requestId: "request",
          attemptId: "attempt",
          ownerId: "owner",
          sourceKind: "DIRECT",
          basePriority: 16,
          connectionOwner: "server",
          deadlineAt: new Date(Date.now() + 100),
          candidates: [{ capacityId: "capacity", executionTargetId: "target", candidateOrder: 0 }],
        },
        controller.signal,
      ),
    ).resolves.toEqual({ state: "CANCELLED" });
    expect(release).toHaveBeenCalledWith(lease);
  });

  it("durably expires a waiter at its deadline", async () => {
    const terminalizeAttempt = vi.fn().mockResolvedValue({ state: "EXPIRED" });
    const runtime = new StoreCapacityAdmissionRuntime(
      {
        acquire: vi.fn().mockResolvedValue({ state: "WAITING", requestId: "request" }),
        release: vi.fn(),
        heartbeat: vi.fn(),
        terminalizeAttempt,
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
        deadlineAt: new Date(Date.now() + 5),
        candidates: [{ capacityId: "capacity", executionTargetId: "target", candidateOrder: 0 }],
      }),
    ).resolves.toEqual({ state: "EXPIRED" });
    expect(terminalizeAttempt).toHaveBeenCalledWith("attempt", "EXPIRED");
  });
});
