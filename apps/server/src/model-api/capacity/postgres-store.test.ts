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
  isRetryableCapacityTransactionError,
  PostgresCapacityAdmissionStore,
  runCapacitySerializable,
  waitWithCapacityPolling,
} from "./postgres-store.js";

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
