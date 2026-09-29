import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", () => ({
  default: {},
  Prisma: { join: (values: readonly unknown[]) => values },
}));

import {
  armDbShutdownFence,
  disarmDbShutdownFence,
  withDbShutdownFence,
} from "@ws-model-proxy/db/shutdown-fence";
import {
  allocateReservationSlots,
  candidateDeadlineAt,
  isRetryableCapacityTransactionError,
  PostgresCapacityAdmissionStore,
  runCapacitySerializable,
  waitWithCapacityPolling,
} from "./postgres-store.js";

describe("candidate wait budgets on the database clock", () => {
  const now = new Date("2026-09-26T12:00:00.000Z");
  const upper = new Date("2026-09-26T12:15:00.000Z");

  it("derives the deadline from the database clock, capped by the absolute bound", () => {
    expect(candidateDeadlineAt({ waitBudgetMs: 2_000 }, upper, now)).toEqual(
      new Date("2026-09-26T12:00:02.000Z"),
    );
    expect(candidateDeadlineAt({ waitBudgetMs: 60 * 60_000 }, upper, now)).toEqual(upper);
    expect(
      candidateDeadlineAt(
        { deadlineAt: new Date("2026-09-26T12:00:01.000Z"), waitBudgetMs: 5_000 },
        upper,
        now,
      ),
    ).toEqual(new Date("2026-09-26T12:00:01.000Z"));
  });

  it("treats a zero budget as 'now' and a missing budget as the absolute bound only", () => {
    expect(candidateDeadlineAt({ waitBudgetMs: 0 }, upper, now)).toEqual(now);
    expect(candidateDeadlineAt({ waitBudgetMs: null }, upper, now)).toEqual(upper);
    expect(candidateDeadlineAt({}, upper, now)).toEqual(upper);
  });
});

describe("capacity reservation allocation", () => {
  it("caps overcommitted owners proportionally with deterministic remainder order", () => {
    expect(
      Object.fromEntries(
        allocateReservationSlots(
          [
            { ownerKey: "member:b", capacityReservedSlots: 9 },
            { ownerKey: "member:a", capacityReservedSlots: 9 },
          ],
          2,
        ),
      ),
    ).toEqual({ "member:a": 1, "member:b": 1 });
  });
});

describe("capacity lease release", () => {
  /**
   * A fake transaction client with one WAITING direct waiter on the released
   * capacity, so the release's fill has real new work to admit (or skip).
   */
  function releaseFixture() {
    let admitted = false;
    const waiter = {
      id: "waiter-1",
      userId: "user",
      admissionRequestId: "request-1",
      capacityId: "capacity",
      executionTargetId: "target",
      poolId: null,
      poolMemberId: null,
      candidateOrder: 0,
      effectivePriority: 16,
      effectiveConcurrencyLimit: null,
      effectiveConcurrencyScope: "DIRECT_TARGET",
      effectiveConcurrencyScopeId: "target",
      effectiveBorrowPolicy: "WHEN_IDLE",
      AdmissionRequest: { requestId: "request", attemptId: "attempt-1", enqueueSequence: 1n },
      PoolMember: null,
    };
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(0),
      $queryRaw: vi.fn().mockResolvedValue([{ now: new Date() }]),
      capacityWaiter: {
        // The L3 scope query (distinct) sees no limited scopes; the fill's
        // waiter query sees the one WAITING waiter until it is admitted.
        findMany: vi.fn(async (args: { distinct?: unknown }) =>
          args.distinct || admitted ? [] : [waiter],
        ),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        update: vi.fn().mockResolvedValue({}),
      },
      capacityLease: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn(async () => {
          admitted = true;
          return {};
        }),
      },
      // The capacity's policy is a graph row read without a lock; its
      // scheduler state lives in capacity_runtime (writer class H).
      inferenceCapacity: {
        findUnique: vi.fn().mockResolvedValue({ userId: "user", hardConcurrencyLimit: 2 }),
      },
      capacityRuntime: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          capacityId: "capacity",
          schedulerCursor: 16,
          schedulerDeficits: [],
          schedulerVersion: 1,
          nextFencingToken: 1n,
        }),
        update: vi.fn().mockResolvedValue({ nextFencingToken: 2n }),
      },
      poolMember: { findMany: vi.fn().mockResolvedValue([]) },
      // The winner's graph is live: its target is still on this capacity.
      executionTarget: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ inferenceCapacityId: "capacity" }),
      },
      admissionRequest: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn().mockResolvedValue({}),
        findUnique: vi.fn(
          async (args: {
            where: { id?: string; attemptId?: string };
          }): Promise<Record<string, unknown> | null> =>
            args.where.id === "request-1"
              ? { state: admitted ? "ADMITTED" : "WAITING", Lease: null }
              : args.where.attemptId === "attempt"
                ? { relayRequestId: "relay-1" }
                : null,
        ),
      },
    };
    let attempts = 0;
    const transaction = vi.fn(async (work: (client: typeof tx) => Promise<boolean>) => {
      attempts++;
      const value = await work(tx);
      // PostgreSQL chose this release as a deadlock victim: the whole
      // transaction rolled back and must be replayed, not dropped.
      if (attempts === 1)
        throw Object.assign(new Error("deadlock"), {
          code: "P2010",
          meta: { code: "40P01" },
        });
      return value;
    });
    // The real shutdown-fence proxy: with the fence armed, every operation
    // outside the durable-cleanup permit (including a retried attempt that
    // lost the permit) is rejected.
    // Relay admission-state projections are written on the client after the
    // store transaction commits, never inside it (tx has no relayRequest).
    const relayRequest = { updateMany: vi.fn().mockResolvedValue({ count: 1 }) };
    const client = withDbShutdownFence({ $transaction: transaction, relayRequest });
    const store = new PostgresCapacityAdmissionStore(client as never, "release-retry-unit");
    const lease = {
      leaseId: "lease",
      attemptId: "attempt",
      capacityId: "capacity",
      executionTargetId: "target",
      fencingToken: 1n,
      expiresAt: new Date(Date.now() + 1000),
      reservationClass: 16,
      borrowed: false,
    };
    return { tx, transaction, relayRequest, store, lease, waiter };
  }

  it("retries a deadlocked release under the real permit proxy and skips the fill while the fence is armed", async () => {
    const { tx, transaction, store, lease } = releaseFixture();
    armDbShutdownFence();
    try {
      await expect(store.release(lease)).resolves.toBe(true);
    } finally {
      disarmDbShutdownFence();
    }
    // The durable-cleanup permit covered the retried attempt.
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "ReadCommitted",
      timeout: expect.any(Number),
    });
    expect(tx.capacityLease.updateMany).toHaveBeenCalledTimes(2);
    // New work stays fenced: the queued waiter was not admitted.
    expect(tx.capacityLease.create).not.toHaveBeenCalled();
    expect(tx.capacityRuntime.update).not.toHaveBeenCalled();
  });

  it("fills the queued waiter on a retried release when the fence is not armed", async () => {
    // Control for the case above: the same fixture admits the waiter, so the
    // armed-fence assertion is not vacuous.
    const { tx, transaction, relayRequest, store, lease } = releaseFixture();
    await expect(store.release(lease)).resolves.toBe(true);
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(tx.capacityLease.create).toHaveBeenCalled();
    const sqlOf = (call: unknown[]) => (call[0] as TemplateStringsArray).join("?");
    // The capacity fence (no inference_capacity row lock) opens each attempt.
    const fenceCalls = tx.$queryRaw.mock.calls.filter((call) =>
      sqlOf(call).includes("wsmp_acquire_fences"),
    );
    expect(fenceCalls.map((call) => call[1])).toEqual([
      ["08:capacity:capacity"],
      ["08:capacity:capacity"],
    ]);
    for (const call of tx.$queryRaw.mock.calls)
      expect(sqlOf(call)).not.toMatch(/FROM inference_capacity/);
    // Scheduler state and the fencing token come from capacity_runtime,
    // created lazily before it is read.
    expect(
      tx.$executeRaw.mock.calls.some((call) =>
        sqlOf(call).includes("INSERT INTO capacity_runtime"),
      ),
    ).toBe(true);
    expect(tx.capacityRuntime.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { capacityId: "capacity" },
    });
    expect(tx.capacityRuntime.update).toHaveBeenCalledWith({
      where: { capacityId: "capacity" },
      data: expect.objectContaining({ nextFencingToken: { increment: 1 } }),
    });
    expect(tx.capacityLease.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ fencingToken: 1n, admissionRequestId: "request-1" }),
    });
    // The winner's graph was checked before the lease.
    expect(tx.executionTarget.findUnique).toHaveBeenCalledWith({
      where: { id: "target" },
      select: { inferenceCapacityId: true },
    });
    // The released attempt's relay row is projected once, after the commit.
    expect(relayRequest.updateMany).toHaveBeenCalledTimes(1);
    expect(relayRequest.updateMany).toHaveBeenCalledWith({
      where: { id: "relay-1", admissionAttemptId: "attempt" },
      data: { admissionTerminalState: "TERMINAL" },
    });
    expect(relayRequest.updateMany.mock.invocationCallOrder[0]).toBeGreaterThan(
      Math.max(...tx.capacityLease.create.mock.invocationCallOrder),
    );
  });

  it("cancels an orphaned winner instead of leasing it", async () => {
    // No foreign key keeps a waiter's graph: a winner whose target is gone is
    // cancelled (parent_deleted) and its request projected as CANCELLED.
    const { tx, relayRequest, store, lease, waiter } = releaseFixture();
    tx.executionTarget.findUnique.mockResolvedValue(null);
    const count = vi.fn().mockResolvedValue(0);
    Object.assign(tx.capacityWaiter, { count });
    tx.admissionRequest.findUnique.mockImplementation(
      async (args: { where: { id?: string; attemptId?: string } }) =>
        args.where.id === "request-1"
          ? { state: "WAITING", Lease: null, relayRequestId: "relay-2", attemptId: "attempt-1" }
          : args.where.attemptId === "attempt"
            ? { relayRequestId: "relay-1" }
            : null,
    );
    // After the cancellation the waiter is no longer WAITING; the first
    // (deadlocked) attempt rolls back, so each attempt starts over.
    let cancelled = false;
    tx.capacityLease.updateMany.mockImplementation(async () => {
      cancelled = false;
      return { count: 1 };
    });
    tx.capacityWaiter.findMany.mockImplementation(async (args: { distinct?: unknown }) =>
      args.distinct || cancelled ? [] : [waiter],
    );
    tx.capacityWaiter.updateMany.mockImplementation(async (args: { data: { state: string } }) => {
      if (args.data.state === "CANCELLED") cancelled = true;
      return { count: 1 };
    });
    await expect(store.release(lease)).resolves.toBe(true);
    expect(tx.capacityLease.create).not.toHaveBeenCalled();
    expect(tx.capacityRuntime.update).not.toHaveBeenCalled();
    expect(tx.capacityWaiter.updateMany).toHaveBeenCalledWith({
      where: { id: "waiter-1", state: "WAITING" },
      data: expect.objectContaining({ state: "CANCELLED", terminalReason: "parent_deleted" }),
    });
    expect(tx.admissionRequest.update).toHaveBeenCalledWith({
      where: { id: "request-1" },
      data: expect.objectContaining({ state: "CANCELLED", terminalReason: "parent_deleted" }),
    });
    // Only the committed attempt's projections are written.
    expect(relayRequest.updateMany.mock.calls.map(([args]) => args)).toEqual([
      {
        where: { id: "relay-1", admissionAttemptId: "attempt" },
        data: { admissionTerminalState: "TERMINAL" },
      },
      {
        where: { id: "relay-2", admissionAttemptId: "attempt-1" },
        data: { admissionTerminalState: "CANCELLED" },
      },
    ]);
  });
});

describe("capacity wakeup polling", () => {
  it("recognizes serialization and deadlock errors without depending on one driver class", () => {
    expect(isRetryableCapacityTransactionError({ code: "40001" })).toBe(true);
    expect(isRetryableCapacityTransactionError({ code: "40P01" })).toBe(true);
    expect(isRetryableCapacityTransactionError({ code: "P2034" })).toBe(true);
    expect(
      isRetryableCapacityTransactionError({
        code: "P2010",
        meta: { driverAdapterError: { cause: { originalCode: "40001" } } },
      }),
    ).toBe(true);
    expect(isRetryableCapacityTransactionError({ code: "23505" })).toBe(false);
  });
  it.each(["P2034", "40001", "40P01"])(
    "retries %s after rollback without leaking work",
    async (code) => {
      let attempts = 0;
      const committed: number[] = [];
      const transaction = vi.fn(async (work: (tx: object) => Promise<number>) => {
        attempts++;
        const pending: number[] = [];
        const value = await work({ pending });
        if (attempts < 3) throw Object.assign(new Error("retry"), { code });
        committed.push(...pending);
        return value;
      });
      const result = await runCapacitySerializable(
        { $transaction: transaction } as never,
        async (tx) => {
          (tx as unknown as { pending: number[] }).pending.push(attempts);
          return attempts;
        },
        async () => undefined,
      );
      expect(result).toBe(3);
      expect(committed).toEqual([3]);
      expect(transaction).toHaveBeenCalledTimes(3);
      expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: "ReadCommitted",
        timeout: expect.any(Number),
      });
    },
  );
  it("bounds jitter and surfaces a terminal nested Prisma conflict", async () => {
    const nestedConflict = {
      code: "P2010",
      meta: { driverAdapterError: { cause: { originalCode: "40001" } } },
    };
    const transaction = vi.fn().mockRejectedValue(nestedConflict);
    const pauses: number[] = [];
    await expect(
      runCapacitySerializable(
        { $transaction: transaction } as never,
        async () => undefined,
        async (milliseconds) => {
          pauses.push(milliseconds);
        },
      ),
    ).rejects.toBe(nestedConflict);
    expect(transaction).toHaveBeenCalledTimes(5);
    expect(pauses).toHaveLength(4);
    expect(pauses.every((pause, index) => pause >= 0 && pause <= 7 + index * 8)).toBe(true);
    expect(pauses.reduce((total, pause) => total + pause, 0)).toBeLessThanOrEqual(76);
  });
  it("treats notifications as hints and re-polls durable state", async () => {
    const admitted = {
      state: "ADMITTED" as const,
      lease: {
        leaseId: "lease",
        attemptId: "attempt",
        capacityId: "capacity",
        executionTargetId: "target",
        fencingToken: 1n,
        expiresAt: new Date(Date.now() + 1000),
      },
    };
    const poll = vi
      .fn()
      .mockResolvedValueOnce({ state: "WAITING", requestId: "request" })
      .mockResolvedValueOnce(admitted);
    const wake = vi.fn().mockResolvedValue(undefined);
    await expect(
      waitWithCapacityPolling({
        capacityIds: ["capacity"],
        deadlineAt: new Date(Date.now() + 1000),
        poll,
        wakeSource: { wait: wake },
        minimumPollMs: 1,
        maximumPollMs: 1,
      }),
    ).resolves.toEqual(admitted);
    expect(wake).toHaveBeenCalledOnce();
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("returns cancellation without relying on a notification", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      waitWithCapacityPolling({
        capacityIds: [],
        deadlineAt: new Date(Date.now() + 1000),
        poll: vi.fn(),
        signal: controller.signal,
      }),
    ).resolves.toEqual({ state: "CANCELLED" });
  });
});

describe("capacity heartbeat lock footprint", () => {
  it("renews with one fenced UPDATE and no transaction or admission locks", async () => {
    const execute = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const transaction = vi.fn();
    const db = { $executeRaw: execute, $transaction: transaction };
    const store = new PostgresCapacityAdmissionStore(
      db as unknown as ConstructorParameters<typeof PostgresCapacityAdmissionStore>[0],
    );
    const lease = {
      leaseId: "lease",
      attemptId: "attempt",
      capacityId: "capacity",
      executionTargetId: "target",
      fencingToken: 3n,
      expiresAt: new Date(),
    };
    await expect(store.heartbeat(lease, 30_000)).resolves.toBe(true);
    await expect(store.heartbeat(lease, 30_000)).resolves.toBe(false);
    expect(transaction).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(2);
    const [sql, ...parameters] = execute.mock.calls[0]!;
    expect(sql.join("?")).toMatch(
      /UPDATE capacity_lease[\s\S]*state = 'ACTIVE' AND "expiresAt" > clock_timestamp\(\)/,
    );
    expect(parameters).toEqual([30_000, "lease", 3n]);
    await expect(store.heartbeat(lease, 0)).rejects.toThrow(RangeError);
    expect(execute).toHaveBeenCalledTimes(2);
  });
});

it("preserves a lease renewed between idempotent acquire's expiry read and UPDATE", async () => {
  const now = new Date();
  const expired = {
    id: "lease",
    attemptId: "attempt",
    capacityId: "capacity",
    executionTargetId: "target",
    fencingToken: 1n,
    state: "ACTIVE",
    expiresAt: new Date(now.getTime() - 1),
  };
  const renewed = { ...expired, expiresAt: new Date(now.getTime() + 30_000) };
  const existing = {
    id: "admission",
    state: "ADMITTED",
    Lease: expired,
    Waiters: [],
    deadlineAt: now,
  };
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(0),
    $queryRaw: vi.fn().mockResolvedValue([{ now }]),
    capacityWaiter: { findMany: vi.fn().mockResolvedValue([]) },
    admissionRequest: {
      findUnique: vi.fn().mockResolvedValue(existing),
      update: vi.fn(),
    },
    capacityLease: {
      findUniqueOrThrow: vi.fn().mockResolvedValueOnce(expired).mockResolvedValue(renewed),
      // PostgreSQL's conditional UPDATE loses to the concurrent renewal.
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };
  const db = {
    $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
  };
  const store = new PostgresCapacityAdmissionStore(
    db as unknown as ConstructorParameters<typeof PostgresCapacityAdmissionStore>[0],
  );
  await expect(
    store.acquire({
      requestId: "request",
      attemptId: "attempt",
      ownerId: "owner",
      sourceKind: "DIRECT",
      basePriority: 16,
      connectionOwner: "test",
      deadlineAt: now,
      candidates: [],
    }),
  ).resolves.toMatchObject({
    state: "ADMITTED",
    lease: { leaseId: "lease", expiresAt: renewed.expiresAt },
  });
  expect(tx.capacityLease.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({ expiresAt: { lte: now } }),
    }),
  );
  expect(tx.admissionRequest.update).not.toHaveBeenCalled();
});
