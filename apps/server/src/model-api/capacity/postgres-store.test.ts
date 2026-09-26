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
      inferenceCapacity: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "capacity",
          hardConcurrencyLimit: 2,
          schedulerCursor: 16,
          schedulerDeficits: [],
          schedulerVersion: 1,
        }),
        update: vi.fn().mockResolvedValue({ nextFencingToken: 2n }),
      },
      poolMember: { findMany: vi.fn().mockResolvedValue([]) },
      executionTarget: { findMany: vi.fn().mockResolvedValue([]) },
      admissionRequest: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn().mockResolvedValue({}),
        findUnique: vi.fn(async (args: { where: { id?: string } }) =>
          args.where.id === "request-1"
            ? { state: admitted ? "ADMITTED" : "WAITING", Lease: null }
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
    const client = withDbShutdownFence({ $transaction: transaction });
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
    return { tx, transaction, store, lease };
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
    expect(tx.inferenceCapacity.update).not.toHaveBeenCalled();
  });

  it("fills the queued waiter on a retried release when the fence is not armed", async () => {
    // Control for the case above: the same fixture admits the waiter, so the
    // armed-fence assertion is not vacuous.
    const { tx, transaction, store, lease } = releaseFixture();
    await expect(store.release(lease)).resolves.toBe(true);
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(tx.capacityLease.create).toHaveBeenCalled();
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
