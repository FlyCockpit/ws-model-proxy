import { createPrismaClient } from "@ws-model-proxy/db/client-factory";
import { PostgresNotificationListener } from "@ws-model-proxy/db/postgres-notifications";
import { describe, expect, it } from "vitest";
import { PRIORITY_CLASS_COUNT, scheduleWeightedDeficitRoundRobin } from "./scheduler.js";

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

if (!databaseUrl)
  console.warn("[capacity-postgres] skipped: SCHEMA_VALIDATION_DATABASE_URL is not configured");

integration("PostgreSQL capacity admission primitives", () => {
  it("rolls back pool creation when its capacity-policy audit write fails", async () => {
    if (!databaseUrl) return;
    const db = createPrismaClient(databaseUrl);
    const suffix = crypto.randomUUID();
    const user = await db.user.create({
      data: { name: "Pool rollback proof", email: `pool-rollback-${suffix}@example.test` },
    });
    const slug = `rollback-${suffix}`;
    const auditId = `audit-${suffix}`;
    try {
      await db.capacityAuditEvent.create({
        data: {
          id: auditId,
          userId: user.id,
          actorUserId: user.id,
          action: "SEED",
          resourceType: "MODEL_POOL",
          resourceId: "seed",
        },
      });
      await expect(
        db.$transaction(async (tx) => {
          const pool = await tx.modelPool.create({
            data: { userId: user.id, slug, name: "Must roll back", capacityConcurrencyLimit: 1 },
          });
          await tx.capacityAuditEvent.create({
            data: {
              id: auditId,
              userId: user.id,
              actorUserId: user.id,
              action: "CREATE",
              resourceType: "MODEL_POOL",
              resourceId: pool.id,
              after: { capacityConcurrencyLimit: 1 },
            },
          });
        }),
      ).rejects.toBeDefined();
      expect(await db.modelPool.findFirst({ where: { userId: user.id, slug } })).toBeNull();
      expect(await db.capacityAuditEvent.count({ where: { userId: user.id } })).toBe(1);
    } finally {
      await db.user.delete({ where: { id: user.id } }).catch(() => undefined);
      await db.$disconnect();
    }
  });

  it("installs fresh-schema admission hardening and a database-owned enqueue sequence", async () => {
    if (!databaseUrl) return;
    const first = createPrismaClient(databaseUrl);
    const second = createPrismaClient(databaseUrl);
    try {
      const triggers = await first.$queryRaw<Array<{ name: string }>>`
        SELECT tgname AS name FROM pg_trigger
         WHERE NOT tgisinternal AND tgname IN (
           'capacity_waiter_reference_consistency',
           'capacity_lease_reference_consistency',
           'admission_request_reference_consistency'
         ) ORDER BY tgname`;
      expect(triggers.map(({ name }) => name)).toEqual([
        "admission_request_reference_consistency",
        "capacity_lease_reference_consistency",
        "capacity_waiter_reference_consistency",
      ]);
      const batches = await Promise.all(
        Array.from(
          { length: 32 },
          (_, index) =>
            (index % 2 ? first : second).$queryRaw<Array<{ value: bigint }>>`
            SELECT nextval('admission_enqueue_sequence') AS value`,
        ),
      );
      const values = batches.map(([row]) => row?.value).filter((value) => value !== undefined);
      expect(new Set(values).size).toBe(32);
      expect([...values].sort((a, b) => Number(a - b))).toHaveLength(32);
    } finally {
      await Promise.all([first.$disconnect(), second.$disconnect()]);
    }
  });

  it("serializes the same stable capacity lock across independent clients", async () => {
    if (!databaseUrl) return;
    const first = createPrismaClient(databaseUrl);
    const second = createPrismaClient(databaseUrl);
    const order: string[] = [];
    let firstLocked!: () => void;
    const firstHasLock = new Promise<void>((resolve) => {
      firstLocked = resolve;
    });
    try {
      const a = first.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"capacity-proof"}, 0))`;
        order.push("first-lock");
        firstLocked();
        await new Promise((resolve) => setTimeout(resolve, 30));
        order.push("first-release");
      });
      await firstHasLock;
      const b = second.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"capacity-proof"}, 0))`;
        order.push("second-lock");
      });
      await Promise.all([a, b]);
      expect(order).toEqual(["first-lock", "first-release", "second-lock"]);
    } finally {
      await Promise.all([first.$disconnect(), second.$disconnect()]);
    }
  });

  it("persists FIFO and weighted WDRR state across independent-client restart", async () => {
    if (!databaseUrl) return;
    let client = createPrismaClient(databaseUrl);
    const cleanup = createPrismaClient(databaseUrl);
    const suffix = crypto.randomUUID();
    const user = await cleanup.user.create({
      data: { name: "Scheduler Proof", email: `scheduler-${suffix}@example.test`, slug: suffix },
    });
    const capacity = await cleanup.inferenceCapacity.create({
      data: {
        userId: user.id,
        label: `scheduler-${suffix}`,
        runtimeIdentityKey: `scheduler-${suffix}`,
        runtimeModel: "scheduler-proof",
      },
    });
    try {
      const fifo = scheduleWeightedDeficitRoundRobin({
        state: {
          cursor: 7,
          deficits: Array(PRIORITY_CLASS_COUNT).fill(0),
          version: 1,
        },
        candidates: [
          {
            admissionRequestId: "later",
            waiterId: "later",
            candidateOrder: 0,
            priority: 7,
            enqueueSequence: 2n,
            eligible: true,
          },
          {
            admissionRequestId: "earlier-b",
            waiterId: "earlier-b",
            candidateOrder: 0,
            priority: 7,
            enqueueSequence: 1n,
            eligible: true,
          },
          {
            admissionRequestId: "earlier-a",
            waiterId: "earlier-a",
            candidateOrder: 9,
            priority: 7,
            enqueueSequence: 1n,
            eligible: true,
          },
        ],
      });
      expect(fifo.winner?.admissionRequestId).toBe("earlier-a");

      const winners: number[] = [];
      let firstLowRound = -1;
      const bound = 33;
      for (let round = 0; round < 96; round++) {
        const winner = await client.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${capacity.id}, 0))`;
          const row = await tx.inferenceCapacity.findUniqueOrThrow({ where: { id: capacity.id } });
          const deficits =
            Array.isArray(row.schedulerDeficits) && row.schedulerDeficits.length === 32
              ? row.schedulerDeficits.map((value) => (typeof value === "number" ? value : 0))
              : Array(PRIORITY_CLASS_COUNT).fill(0);
          const decision = scheduleWeightedDeficitRoundRobin({
            state: { cursor: row.schedulerCursor, deficits, version: row.schedulerVersion },
            candidates: [
              {
                admissionRequestId: `p31-${round}`,
                waiterId: `p31-${round}`,
                candidateOrder: 0,
                priority: 31,
                enqueueSequence: 0n,
                eligible: true,
              },
              {
                admissionRequestId: "p0-head",
                waiterId: "p0-head",
                candidateOrder: 0,
                priority: 0,
                enqueueSequence: 0n,
                eligible: true,
              },
            ],
          });
          await tx.inferenceCapacity.update({
            where: { id: capacity.id },
            data: {
              schedulerCursor: decision.state.cursor,
              schedulerDeficits: decision.state.deficits,
              schedulerVersion: decision.state.version,
            },
          });
          return decision.winner?.priority;
        });
        if (winner !== undefined) winners.push(winner);
        if (winner === 0 && firstLowRound === -1) firstLowRound = round;
        if (round === 15) {
          await client.$disconnect();
          client = createPrismaClient(databaseUrl);
        }
      }
      expect(firstLowRound).toBeGreaterThanOrEqual(0);
      expect(firstLowRound).toBeLessThan(bound);
      expect(winners.filter((priority) => priority === 31).length).toBeGreaterThan(
        winners.filter((priority) => priority === 0).length,
      );
      const persisted = await cleanup.inferenceCapacity.findUniqueOrThrow({
        where: { id: capacity.id },
      });
      expect(persisted.schedulerVersion).toBe(1);
      expect(persisted.schedulerDeficits).not.toEqual({});
    } finally {
      await client.$disconnect();
      await cleanup.user.delete({ where: { id: user.id } }).catch(() => undefined);
      await cleanup.$disconnect();
    }
  });

  it("recovers from a notification missed while disconnected by bounded polling", async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    const db = createPrismaClient(databaseUrl);
    const suffix = crypto.randomUUID();
    const user = await db.user.create({
      data: {
        name: "Notify Proof",
        email: `notify-${suffix}@example.test`,
        slug: `notify-${suffix}`,
      },
    });
    const capacity = await db.inferenceCapacity.create({
      data: {
        userId: user.id,
        label: `notify-${suffix}`,
        runtimeIdentityKey: `notify-${suffix}`,
        runtimeModel: "notify-proof",
      },
    });
    try {
      await db.$executeRaw`SELECT pg_notify('wsmp_capacity', ${capacity.id})`;
      await db.inferenceCapacity.update({
        where: { id: capacity.id },
        data: { schedulerVersion: 2 },
      });
      const listener = new PostgresNotificationListener(databaseUrl);
      await listener.connect();
      const { waitWithCapacityPolling } = await import("./postgres-store.js");
      let polls = 0;
      const result = await waitWithCapacityPolling({
        capacityIds: [capacity.id],
        deadlineAt: new Date(Date.now() + 500),
        minimumPollMs: 20,
        maximumPollMs: 20,
        wakeSource: { wait: async (_ids, timeout) => void (await listener.wait(timeout)) },
        poll: async () => {
          polls++;
          if (polls === 1) return { state: "WAITING" as const, requestId: "notify-proof" };
          const row = await db.inferenceCapacity.findUniqueOrThrow({ where: { id: capacity.id } });
          return row.schedulerVersion === 2
            ? { state: "CANCELLED" as const }
            : { state: "WAITING" as const, requestId: "notify-proof" };
        },
      });
      expect(result).toEqual({ state: "CANCELLED" });
      expect(polls).toBeGreaterThan(0);
      await listener.close();
    } finally {
      await db.user.delete({ where: { id: user.id } }).catch(() => undefined);
      await db.$disconnect();
    }
  });

  it("atomically chooses one pool candidate, cancels siblings, fences, and enforces the shared cap", async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    const db = createPrismaClient(databaseUrl);
    const suffix = crypto.randomUUID();
    const user = await db.user.create({
      data: {
        name: "Capacity Proof",
        email: `capacity-${suffix}@example.test`,
        slug: `capacity-${suffix}`,
      },
    });
    try {
      const capacity = await db.inferenceCapacity.create({
        data: {
          userId: user.id,
          label: `runtime-${suffix}`,
          runtimeIdentityKey: `runtime-${suffix}`,
          runtimeModel: "proof-model",
          hardConcurrencyLimit: 1,
        },
      });
      const account = await db.providerAccount.create({
        data: {
          userId: user.id,
          providerType: "proof",
          label: `provider-${suffix}`,
          baseUrl: "https://example.test",
          authType: "BEARER",
        },
      });
      const targets: Array<{ id: string }> = [];
      for (const upstreamModelId of ["proof-a", "proof-b"]) {
        const model = await db.providerModel.create({
          data: { userId: user.id, providerAccountId: account.id, upstreamModelId },
        });
        targets.push(
          await db.executionTarget.create({
            data: {
              userId: user.id,
              kind: "PROVIDER_MODEL",
              providerModelId: model.id,
              inferenceCapacityId: capacity.id,
            },
          }),
        );
      }
      const pool = await db.modelPool.create({
        data: {
          userId: user.id,
          slug: `pool-${suffix}`,
          name: "Proof pool",
          capacityPriority: 23,
          capacityConcurrencyLimit: 3,
          capacityReservedSlots: 7,
          capacityBorrowPolicy: "NEVER",
        },
      });
      const members: Array<{ id: string }> = [];
      for (const [index, target] of targets.entries())
        members.push(
          await db.poolMember.create({
            data: {
              poolId: pool.id,
              executionTargetId: target.id,
              ...(index === 0
                ? {
                    capacityPriority: 16,
                    capacityConcurrencyMode: "LIMITED" as const,
                    capacityConcurrencyLimit: 2,
                    capacityReservedSlots: 0,
                    capacityBorrowPolicy: "WHEN_IDLE" as const,
                  }
                : {}),
            },
          }),
        );
      const { PostgresCapacityAdmissionStore } = await import("./postgres-store.js");
      const notifications: string[][] = [];
      const firstManager = new PostgresCapacityAdmissionStore(db, "proof-server-a", {
        notify: async (capacityIds) => void notifications.push([...capacityIds]),
      });
      const secondClient = createPrismaClient(databaseUrl);
      const secondManager = new PostgresCapacityAdmissionStore(secondClient, "proof-server-b");
      const deadlineAt = new Date(Date.now() + 60_000);
      const spoofedCallerPolicy = {
        priority: 31,
        memberConcurrencyCeiling: 99,
        reservedSlots: 99,
        allowBorrowReserved: false,
      };
      const first = await firstManager.acquire({
        requestId: `request-1-${suffix}`,
        attemptId: `attempt-1-${suffix}`,
        ownerId: user.id,
        sourceKind: "POOL",
        poolId: pool.id,
        basePriority: 16,
        connectionOwner: "proof-server-a",
        deadlineAt,
        candidates: members.map((member, candidateOrder) => ({
          capacityId: capacity.id,
          executionTargetId: targets[candidateOrder]!.id,
          poolMemberId: member.id,
          candidateOrder,
          deadlineAt: new Date(deadlineAt.getTime() - (candidateOrder === 0 ? 30_000 : 0)),
          ...spoofedCallerPolicy,
        })),
      });
      expect(first.state).toBe("ADMITTED");
      const waiters = await db.capacityWaiter.findMany({
        where: { AdmissionRequest: { attemptId: `attempt-1-${suffix}` } },
        orderBy: { candidateOrder: "asc" },
      });
      expect(waiters.map((waiter) => waiter.candidateOrder)).toEqual([0, 1]);
      expect(waiters.map((waiter) => waiter.deadlineAt?.getTime())).toEqual([
        deadlineAt.getTime() - 30_000,
        deadlineAt.getTime(),
      ]);
      expect(waiters[0]).toMatchObject({
        effectivePriority: 16,
        effectiveConcurrencyLimit: 2,
        effectiveReservedSlots: 0,
        effectiveBorrowPolicy: "WHEN_IDLE",
      });
      expect(waiters[1]).toMatchObject({
        effectivePriority: 23,
        effectiveConcurrencyLimit: 3,
        effectiveReservedSlots: 7,
        effectiveBorrowPolicy: "NEVER",
      });
      expect(waiters.filter((waiter) => waiter.state === "ADMITTED")).toHaveLength(1);
      expect(waiters.filter((waiter) => waiter.state === "CANCELLED")).toHaveLength(1);
      expect(
        await db.capacityLease.findUnique({ where: { attemptId: `attempt-1-${suffix}` } }),
      ).toMatchObject({ poolMemberId: members[1]!.id });

      const second = await secondManager.acquire({
        requestId: `request-2-${suffix}`,
        attemptId: `attempt-2-${suffix}`,
        ownerId: user.id,
        sourceKind: "POOL",
        poolId: pool.id,
        basePriority: 16,
        connectionOwner: "proof-server-b",
        deadlineAt,
        candidates: [
          {
            capacityId: capacity.id,
            executionTargetId: targets[0]!.id,
            poolMemberId: members[0]!.id,
            candidateOrder: 0,
          },
        ],
      });
      expect(second.state).toBe("WAITING");
      if (first.state !== "ADMITTED") throw new Error("Expected first lease.");
      await expect(firstManager.release(first.lease)).resolves.toBe(true);
      await expect(firstManager.release(first.lease)).resolves.toBe(false);
      const admittedSecond = await secondManager.acquire({
        requestId: `request-2-${suffix}`,
        attemptId: `attempt-2-${suffix}`,
        ownerId: user.id,
        sourceKind: "POOL",
        poolId: pool.id,
        basePriority: 16,
        connectionOwner: "proof-server-b",
        deadlineAt,
        candidates: [],
      });
      expect(admittedSecond.state).toBe("ADMITTED");
      if (admittedSecond.state === "ADMITTED") {
        expect(admittedSecond.lease.fencingToken).toBeGreaterThan(first.lease.fencingToken);
        await expect(
          firstManager.heartbeat(first.lease, new Date(Date.now() + 60_000)),
        ).resolves.toBe(false);
        await db.inferenceCapacity.update({
          where: { id: capacity.id },
          data: { hardConcurrencyLimit: 2 },
        });
        await db.poolMember.update({
          where: { id: members[0]!.id },
          data: {
            capacityPriority: 0,
            capacityConcurrencyLimit: 1,
            capacityBorrowPolicy: "WHEN_IDLE",
          },
        });
        await db.poolMember.update({
          where: { id: members[1]!.id },
          data: { capacityPriority: 31, capacityReservedSlots: 1 },
        });
        const lowAttempt = {
          requestId: `request-low-${suffix}`,
          attemptId: `attempt-low-${suffix}`,
          ownerId: user.id,
          sourceKind: "POOL" as const,
          poolId: pool.id,
          basePriority: 0,
          connectionOwner: "proof-server-a",
          deadlineAt,
          candidates: [
            {
              capacityId: capacity.id,
              executionTargetId: targets[0]!.id,
              poolMemberId: members[0]!.id,
              candidateOrder: 0,
            },
          ],
        };
        await expect(firstManager.acquire(lowAttempt)).resolves.toMatchObject({ state: "WAITING" });
        await db.poolMember.update({
          where: { id: members[0]!.id },
          data: { capacityConcurrencyLimit: null },
        });
        // Waiter policy is an immutable enqueue-time snapshot. A policy edit
        // must not mutate an already queued attempt; retry with a new attempt.
        await firstManager.cancelAttempt(lowAttempt.attemptId);
        const retryLowAttempt = {
          ...lowAttempt,
          requestId: `request-low-retry-${suffix}`,
          attemptId: `attempt-low-retry-${suffix}`,
        };
        let borrowed = await firstManager.acquire(retryLowAttempt);
        for (let visit = 1; borrowed.state === "WAITING" && visit < 33; visit++)
          borrowed = await firstManager.acquire({ ...retryLowAttempt, candidates: [] });
        expect(borrowed).toMatchObject({ state: "ADMITTED", lease: { capacityId: capacity.id } });
        const borrowedRow = await db.capacityLease.findUniqueOrThrow({
          where: { attemptId: retryLowAttempt.attemptId },
        });
        expect(borrowedRow.borrowed).toBe(true);

        const highAttempt = {
          requestId: `request-high-${suffix}`,
          attemptId: `attempt-high-${suffix}`,
          ownerId: user.id,
          sourceKind: "POOL" as const,
          poolId: pool.id,
          basePriority: 31,
          connectionOwner: "proof-server-b",
          deadlineAt,
          candidates: [
            {
              capacityId: capacity.id,
              executionTargetId: targets[1]!.id,
              poolMemberId: members[1]!.id,
              candidateOrder: 0,
            },
          ],
        };
        await expect(secondManager.acquire(highAttempt)).resolves.toMatchObject({
          state: "WAITING",
        });
        expect(
          await db.capacityLease.count({ where: { capacityId: capacity.id, state: "ACTIVE" } }),
        ).toBe(2);
        await secondManager.release(admittedSecond.lease);
        const high = await secondManager.acquire({ ...highAttempt, candidates: [] });
        expect(high).toMatchObject({ state: "ADMITTED" });
        expect(
          await db.capacityLease.findUnique({ where: { attemptId: retryLowAttempt.attemptId } }),
        ).toMatchObject({ state: "ACTIVE" });
        if (borrowed.state !== "ADMITTED") throw new Error("Expected borrowed lease.");
        await db.capacityLease.update({
          where: { id: borrowed.lease.leaseId },
          data: {
            acquiredAt: new Date(Date.now() - 2_000),
            expiresAt: new Date(Date.now() - 1_000),
            heartbeatAt: new Date(Date.now() - 60_000),
          },
        });
        const [reclaimed, heartbeatWon] = await Promise.all([
          firstManager.reclaimExpired(new Date(), 10),
          secondManager.heartbeat(borrowed.lease, new Date(Date.now() + 60_000)),
        ]);
        expect(heartbeatWon).toBe(reclaimed === 0);
        if (reclaimed > 0) expect(notifications.flat()).toContain(capacity.id);
        const releasedAfterRace = await firstManager.release(borrowed.lease);
        if (heartbeatWon) expect(releasedAfterRace).toBe(true);
        await expect(
          firstManager.heartbeat(borrowed.lease, new Date(Date.now() + 60_000)),
        ).resolves.toBe(false);

        await db.inferenceCapacity.update({
          where: { id: capacity.id },
          data: { hardConcurrencyLimit: 1 },
        });
        const healthyAttempt = {
          ...lowAttempt,
          requestId: `request-healthy-${suffix}`,
          attemptId: `attempt-healthy-${suffix}`,
        };
        await expect(firstManager.acquire(healthyAttempt)).resolves.toMatchObject({
          state: "WAITING",
        });
        await expect(
          firstManager.acquire({ ...healthyAttempt, candidates: [] }),
        ).resolves.toMatchObject({
          state: "WAITING",
        });
        await firstManager.sweepAbandoned({
          now: new Date(),
          heartbeatBefore: new Date(Date.now() - 1_000),
          limit: 10,
        });
        expect(
          await db.admissionRequest.findUnique({ where: { attemptId: healthyAttempt.attemptId } }),
        ).toMatchObject({ state: "WAITING" });
        await firstManager.cancelAttempt(healthyAttempt.attemptId);
        const abandonedAttempt = {
          ...lowAttempt,
          requestId: `request-abandoned-${suffix}`,
          attemptId: `attempt-abandoned-${suffix}`,
        };
        await expect(firstManager.acquire(abandonedAttempt)).resolves.toMatchObject({
          state: "WAITING",
        });
        await db.admissionRequest.update({
          where: { attemptId: abandonedAttempt.attemptId },
          data: { heartbeatAt: new Date(Date.now() - 120_000) },
        });
        const notificationsBeforeSweep = notifications.length;
        await expect(
          firstManager.sweepAbandoned({
            now: new Date(),
            heartbeatBefore: new Date(Date.now() - 60_000),
            limit: 10,
          }),
        ).resolves.toMatchObject({ requests: 1 });
        expect(notifications.length).toBeGreaterThan(notificationsBeforeSweep);
        expect(notifications.at(-1)).toContain(capacity.id);
        expect(
          await db.admissionRequest.findUnique({
            where: { attemptId: abandonedAttempt.attemptId },
          }),
        ).toMatchObject({ state: "CANCELLED", terminalReason: "connection_abandoned" });
        const releaseRaceAttempt = {
          ...lowAttempt,
          requestId: `request-release-race-${suffix}`,
          attemptId: `attempt-release-race-${suffix}`,
        };
        await expect(firstManager.acquire(releaseRaceAttempt)).resolves.toMatchObject({
          state: "WAITING",
        });
        const { waitWithCapacityPolling } = await import("./postgres-store.js");
        const [, releaseRaceResult] = await Promise.all([
          high.state === "ADMITTED" ? secondManager.release(high.lease) : Promise.resolve(false),
          waitWithCapacityPolling({
            capacityIds: [capacity.id],
            deadlineAt: new Date(Date.now() + 1_000),
            minimumPollMs: 5,
            maximumPollMs: 10,
            poll: () => firstManager.acquire({ ...releaseRaceAttempt, candidates: [] }),
          }),
        ]);
        expect(releaseRaceResult).toMatchObject({ state: "ADMITTED" });
        expect(
          await db.capacityLease.count({ where: { capacityId: capacity.id, state: "ACTIVE" } }),
        ).toBe(1);
        const raceAttempt = {
          ...lowAttempt,
          requestId: `request-race-${suffix}`,
          attemptId: `attempt-race-${suffix}`,
        };
        await expect(firstManager.acquire(raceAttempt)).resolves.toMatchObject({
          state: "WAITING",
        });
        const [terminalized] = await Promise.all([
          firstManager.terminalizeAttempt(raceAttempt.attemptId, "CANCELLED"),
          secondManager.acquire({ ...raceAttempt, candidates: [] }),
          releaseRaceResult.state === "ADMITTED"
            ? firstManager.release(releaseRaceResult.lease)
            : Promise.resolve(false),
        ]);
        // Whichever operation obtained the capacity lock first, terminalize
        // must return the authoritative result so callers can release a lease
        // that won the cancellation race.
        if (terminalized.state === "ADMITTED") await firstManager.release(terminalized.lease);
        const raceRequest = await db.admissionRequest.findUnique({
          where: { attemptId: raceAttempt.attemptId },
        });
        expect(["CANCELLED", "TERMINAL"]).toContain(raceRequest?.state);
        expect(
          await db.capacityLease.count({
            where: { attemptId: raceAttempt.attemptId, state: "ACTIVE" },
          }),
        ).toBe(0);

        await db.inferenceCapacity.update({
          where: { id: capacity.id },
          data: { hardConcurrencyLimit: 1 },
        });
        const deadlineBlockerAttempt = {
          ...lowAttempt,
          requestId: `request-deadline-blocker-${suffix}`,
          attemptId: `attempt-deadline-blocker-${suffix}`,
        };
        const deadlineBlocker = await firstManager.acquire(deadlineBlockerAttempt);
        expect(deadlineBlocker).toMatchObject({ state: "ADMITTED" });

        const deadlineAttempt = {
          ...lowAttempt,
          requestId: `request-deadline-${suffix}`,
          attemptId: `attempt-deadline-${suffix}`,
          deadlineAt: new Date(Date.now() + 30),
        };
        await expect(firstManager.acquire(deadlineAttempt)).resolves.toMatchObject({
          state: "WAITING",
        });
        await new Promise((resolve) => setTimeout(resolve, 40));
        await expect(firstManager.acquire({ ...deadlineAttempt, candidates: [] })).resolves.toEqual(
          {
            state: "EXPIRED",
          },
        );
        expect(
          await db.capacityLease.count({ where: { attemptId: deadlineAttempt.attemptId } }),
        ).toBe(0);
        if (deadlineBlocker.state === "ADMITTED") await firstManager.release(deadlineBlocker.lease);

        await db.inferenceCapacity.update({
          where: { id: capacity.id },
          data: { hardConcurrencyLimit: 1 },
        });
        const fillAttempts = Array.from({ length: 4 }, (_, index) => ({
          ...lowAttempt,
          requestId: `request-fill-${index}-${suffix}`,
          attemptId: `attempt-fill-${index}-${suffix}`,
          candidates: [
            {
              capacityId: capacity.id,
              executionTargetId: targets[0]!.id,
              poolMemberId: members[0]!.id,
              candidateOrder: 0,
            },
          ],
        }));
        const blocker = await firstManager.acquire(fillAttempts[0]!);
        expect(blocker.state).toBe("ADMITTED");
        for (const attempt of fillAttempts.slice(1))
          await expect(firstManager.acquire(attempt)).resolves.toMatchObject({ state: "WAITING" });
        await db.inferenceCapacity.update({
          where: { id: capacity.id },
          data: { hardConcurrencyLimit: 3 },
        });
        if (blocker.state !== "ADMITTED") throw new Error("Expected fill blocker lease.");
        await expect(firstManager.release(blocker.lease)).resolves.toBe(true);
        expect(
          await db.capacityLease.count({
            where: {
              attemptId: { in: fillAttempts.slice(1).map(({ attemptId }) => attemptId) },
              state: "ACTIVE",
            },
          }),
        ).toBe(3);
      }
      await secondClient.$disconnect();
    } finally {
      await db.user.delete({ where: { id: user.id } }).catch(() => undefined);
      await db.$disconnect();
    }
  });

  it("caps overcommitted shared-target reservations and distinguishes NEVER from WHEN_IDLE borrowing", async () => {
    if (!databaseUrl) return;
    const db = createPrismaClient(databaseUrl);
    const suffix = crypto.randomUUID();
    const user = await db.user.create({
      data: { name: "Reservation Proof", email: `reserve-${suffix}@example.test`, slug: suffix },
    });
    try {
      const capacity = await db.inferenceCapacity.create({
        data: {
          userId: user.id,
          label: suffix,
          runtimeIdentityKey: suffix,
          runtimeModel: "reservation-proof",
          hardConcurrencyLimit: 2,
        },
      });
      const account = await db.providerAccount.create({
        data: {
          userId: user.id,
          providerType: "proof",
          label: suffix,
          baseUrl: "https://example.test",
          authType: "BEARER",
        },
      });
      const targets: Array<{ id: string }> = [];
      for (const name of ["shared", "direct"]) {
        const model = await db.providerModel.create({
          data: {
            userId: user.id,
            providerAccountId: account.id,
            upstreamModelId: `${name}-${suffix}`,
          },
        });
        targets.push(
          await db.executionTarget.create({
            data: {
              userId: user.id,
              kind: "PROVIDER_MODEL",
              providerModelId: model.id,
              inferenceCapacityId: capacity.id,
              directBorrowPolicy: "NEVER",
            },
          }),
        );
      }
      const members: Array<{ pool: { id: string }; member: { id: string } }> = [];
      for (const index of [0, 1]) {
        const pool = await db.modelPool.create({
          data: {
            userId: user.id,
            slug: `reserve-${index}-${suffix}`,
            name: `Reserve ${index}`,
            capacityReservedSlots: 9,
            capacityConcurrencyLimit: 1,
          },
        });
        members.push({
          pool,
          member: await db.poolMember.create({
            data: { poolId: pool.id, executionTargetId: targets[0]!.id },
          }),
        });
      }
      const { PostgresCapacityAdmissionStore } = await import("./postgres-store.js");
      const manager = new PostgresCapacityAdmissionStore(db, "reservation-proof");
      const deadlineAt = new Date(Date.now() + 60_000);
      for (const [index, entry] of members.entries()) {
        const result = await manager.acquire({
          requestId: `reserved-${index}-${suffix}`,
          attemptId: `reserved-${index}-${suffix}`,
          ownerId: user.id,
          sourceKind: "POOL",
          poolId: entry.pool.id,
          basePriority: 16,
          connectionOwner: "reservation-proof",
          deadlineAt,
          candidates: [
            {
              capacityId: capacity.id,
              executionTargetId: targets[0]!.id,
              poolMemberId: entry.member.id,
              candidateOrder: 0,
            },
          ],
        });
        expect(result.state).toBe("ADMITTED");
        expect(
          await db.capacityLease.findUnique({
            where: { attemptId: `reserved-${index}-${suffix}` },
          }),
        ).toMatchObject({ borrowed: false, poolMemberId: entry.member.id });
      }
      const secondCapacity = await db.inferenceCapacity.create({
        data: {
          userId: user.id,
          label: `second-${suffix}`,
          runtimeIdentityKey: `second-${suffix}`,
          runtimeModel: "pool-scope-proof",
          hardConcurrencyLimit: 2,
        },
      });
      const secondModel = await db.providerModel.create({
        data: {
          userId: user.id,
          providerAccountId: account.id,
          upstreamModelId: `second-${suffix}`,
        },
      });
      const secondTarget = await db.executionTarget.create({
        data: {
          userId: user.id,
          kind: "PROVIDER_MODEL",
          providerModelId: secondModel.id,
          inferenceCapacityId: secondCapacity.id,
        },
      });
      const inheritedMember = await db.poolMember.create({
        data: { poolId: members[0]!.pool.id, executionTargetId: secondTarget.id },
      });
      const scopedAttempt = (attemptId: string) => ({
        requestId: attemptId,
        attemptId,
        ownerId: user.id,
        sourceKind: "POOL" as const,
        poolId: members[0]!.pool.id,
        basePriority: 16,
        connectionOwner: "reservation-proof",
        deadlineAt,
        candidates: [
          {
            capacityId: secondCapacity.id,
            executionTargetId: secondTarget.id,
            poolMemberId: inheritedMember.id,
            candidateOrder: 0,
          },
        ],
      });
      await expect(manager.acquire(scopedAttempt(`pool-wide-${suffix}`))).resolves.toMatchObject({
        state: "WAITING",
      });
      await manager.cancelAttempt(`pool-wide-${suffix}`);
      await db.poolMember.update({
        where: { id: inheritedMember.id },
        data: { capacityConcurrencyMode: "LIMITED", capacityConcurrencyLimit: 1 },
      });
      const memberScoped = await manager.acquire(scopedAttempt(`member-scope-${suffix}`));
      expect(memberScoped).toMatchObject({ state: "ADMITTED" });
      if (memberScoped.state !== "ADMITTED") throw new Error("Expected member-scoped lease.");
      await manager.release(memberScoped.lease);
      await db.modelPool.update({
        where: { id: members[0]!.pool.id },
        data: { capacityReservedSlots: 0 },
      });
      const raceClient = createPrismaClient(databaseUrl);
      const raceManager = new PostgresCapacityAdmissionStore(raceClient, "expiry-race-proof");
      try {
        for (let index = 0; index < 20; index++) {
          const raceAttemptId = `expiry-race-${index}-${suffix}`;
          const admitted = await manager.acquire({
            requestId: raceAttemptId,
            attemptId: raceAttemptId,
            ownerId: user.id,
            sourceKind: "DIRECT",
            basePriority: 16,
            connectionOwner: "reservation-proof",
            deadlineAt,
            candidates: [
              {
                capacityId: secondCapacity.id,
                executionTargetId: secondTarget.id,
                candidateOrder: 0,
              },
            ],
          });
          if (admitted.state !== "ADMITTED") throw new Error("Expected expiry-race lease.");
          await db.capacityLease.update({
            where: { id: admitted.lease.leaseId },
            data: { expiresAt: new Date(Date.now() - 1) },
          });
          const [reclaimed, heartbeated] = await Promise.all([
            manager.reclaimExpired(new Date(), 1),
            raceManager.heartbeat(admitted.lease, new Date(Date.now() + 60_000)),
          ]);
          expect([reclaimed, heartbeated]).toEqual(reclaimed === 1 ? [1, false] : [0, true]);
          if (heartbeated) await raceManager.release(admitted.lease);
          await expect(
            manager.heartbeat(admitted.lease, new Date(Date.now() + 60_000)),
          ).resolves.toBe(false);
        }
      } finally {
        await raceClient.$disconnect();
      }
      const directAttempt = (attemptId: string) => ({
        requestId: attemptId,
        attemptId,
        ownerId: user.id,
        sourceKind: "DIRECT" as const,
        basePriority: 16,
        connectionOwner: "reservation-proof",
        deadlineAt,
        candidates: [
          { capacityId: capacity.id, executionTargetId: targets[0]!.id, candidateOrder: 0 },
        ],
      });
      await expect(manager.acquire(directAttempt(`never-${suffix}`))).resolves.toMatchObject({
        state: "WAITING",
      });
      await db.executionTarget.update({
        where: { id: targets[0]!.id },
        data: { directBorrowPolicy: "WHEN_IDLE", directConcurrencyLimit: null },
      });
      await manager.cancelAttempt(`never-${suffix}`);
      const staleWaiters = await db.capacityWaiter.findMany({
        where: { capacityId: capacity.id, state: "WAITING" },
        select: { attemptId: true },
      });
      for (const waiter of staleWaiters) await manager.cancelAttempt(waiter.attemptId);
      const active = await db.capacityLease.findMany({
        where: { capacityId: capacity.id, state: "ACTIVE" },
      });
      const toRelease = [
        ...active.filter((lease) => lease.poolMemberId === null),
        ...active.filter((lease) => lease.poolMemberId !== null).slice(1),
      ];
      for (const released of toRelease)
        await expect(
          manager.release({
            leaseId: released.id,
            attemptId: released.attemptId,
            capacityId: released.capacityId,
            executionTargetId: released.executionTargetId,
            ...(released.poolMemberId ? { poolMemberId: released.poolMemberId } : {}),
            fencingToken: released.fencingToken,
            expiresAt: released.expiresAt,
          }),
        ).resolves.toBe(true);
      const idleAttempt = directAttempt(`idle-${suffix}`);
      let idleBorrower = await manager.acquire(idleAttempt);
      for (let visit = 1; idleBorrower.state === "WAITING" && visit < 33; visit++)
        idleBorrower = await manager.acquire({ ...idleAttempt, candidates: [] });
      expect(idleBorrower.state).toBe("ADMITTED");
      expect(
        await db.capacityLease.findUnique({ where: { attemptId: `idle-${suffix}` } }),
      ).toMatchObject({ borrowed: true });
      const onePoolLease = await db.capacityLease.findFirstOrThrow({
        where: { capacityId: capacity.id, state: "ACTIVE", poolMemberId: { not: null } },
      });
      await manager.release({
        leaseId: onePoolLease.id,
        attemptId: onePoolLease.attemptId,
        capacityId: onePoolLease.capacityId,
        executionTargetId: onePoolLease.executionTargetId,
        ...(onePoolLease.poolMemberId ? { poolMemberId: onePoolLease.poolMemberId } : {}),
        fencingToken: onePoolLease.fencingToken,
        expiresAt: onePoolLease.expiresAt,
      });
      await db.executionTarget.update({
        where: { id: targets[0]!.id },
        data: { directConcurrencyLimit: 1 },
      });
      await expect(
        manager.acquire(directAttempt(`direct-ceiling-${suffix}`)),
      ).resolves.toMatchObject({
        state: "WAITING",
      });
      const ownerAttempt = (entry: (typeof members)[number], label: string) => ({
        requestId: `${label}-${suffix}`,
        attemptId: `${label}-${suffix}`,
        ownerId: user.id,
        sourceKind: "POOL" as const,
        poolId: entry.pool.id,
        basePriority: 16,
        connectionOwner: "reservation-proof",
        deadlineAt,
        candidates: [
          {
            capacityId: capacity.id,
            executionTargetId: targets[0]!.id,
            poolMemberId: entry.member.id,
            candidateOrder: 0,
          },
        ],
      });
      const occupyingOwner = await manager.acquire(ownerAttempt(members[0]!, "owner-occupies"));
      expect(occupyingOwner.state).toBe("ADMITTED");
      await manager.cancelAttempt(`direct-ceiling-${suffix}`);
      await db.poolMember.update({
        where: { id: members[1]!.member.id },
        data: {
          capacityPriority: 0,
          capacityConcurrencyMode: "LIMITED",
          capacityConcurrencyLimit: 1,
        },
      });
      await expect(
        manager.acquire(ownerAttempt(members[1]!, "lower-owner-queued")),
      ).resolves.toMatchObject({
        state: "WAITING",
      });
      await db.executionTarget.update({
        where: { id: targets[0]!.id },
        data: { directConcurrencyLimit: null, directPriority: 31 },
      });
      await expect(
        manager.acquire(directAttempt(`priority31-borrower-${suffix}`)),
      ).resolves.toMatchObject({
        state: "WAITING",
      });
      await db.inferenceCapacity.update({
        where: { id: capacity.id },
        data: { schedulerCursor: 31, schedulerDeficits: Array(32).fill(0) },
      });
      if (occupyingOwner.state !== "ADMITTED") throw new Error("Expected reservation owner lease.");
      await manager.release(occupyingOwner.lease);
      expect(
        await db.capacityLease.findUnique({
          where: { attemptId: `priority31-borrower-${suffix}` },
        }),
      ).toMatchObject({ state: "ACTIVE", borrowed: true });
      expect(
        await db.admissionRequest.findUnique({
          where: { attemptId: `lower-owner-queued-${suffix}` },
        }),
      ).toMatchObject({ state: "WAITING" });
      const priority31Borrower = await manager.acquire({
        ...directAttempt(`priority31-borrower-${suffix}`),
        candidates: [],
      });
      if (priority31Borrower.state !== "ADMITTED")
        throw new Error("Expected high-priority borrower.");
      await manager.release(priority31Borrower.lease);

      const lowerOwner = await manager.acquire({
        ...ownerAttempt(members[1]!, "lower-owner-queued"),
        candidates: [],
      });
      if (lowerOwner.state !== "ADMITTED") throw new Error("Expected reserved owner lease.");
      await db.poolMember.update({
        where: { id: members[1]!.member.id },
        data: {
          capacityPriority: 31,
          capacityConcurrencyMode: "LIMITED",
          capacityConcurrencyLimit: 1,
        },
      });
      await expect(
        manager.acquire(ownerAttempt(members[1]!, "higher-owner-at-ceiling")),
      ).resolves.toMatchObject({ state: "WAITING" });
      await db.executionTarget.update({
        where: { id: targets[0]!.id },
        data: { directPriority: 0 },
      });
      await expect(
        manager.acquire(directAttempt(`ceiling-borrower-${suffix}`)),
      ).resolves.toMatchObject({
        state: "WAITING",
      });
      if (idleBorrower.state !== "ADMITTED") throw new Error("Expected original borrower lease.");
      await manager.release(idleBorrower.lease);
      expect(
        await db.capacityLease.findUnique({ where: { attemptId: `ceiling-borrower-${suffix}` } }),
      ).toMatchObject({ state: "ACTIVE", borrowed: true });
      expect(
        await db.admissionRequest.findUnique({
          where: { attemptId: `higher-owner-at-ceiling-${suffix}` },
        }),
      ).toMatchObject({ state: "WAITING" });

      await expect(
        manager.acquire(directAttempt(`blocked-outsider-${suffix}`)),
      ).resolves.toMatchObject({
        state: "WAITING",
      });
      await manager.release(lowerOwner.lease);
      expect(
        await db.capacityLease.findUnique({
          where: { attemptId: `higher-owner-at-ceiling-${suffix}` },
        }),
      ).toMatchObject({ state: "ACTIVE", borrowed: false });
      expect(
        await db.admissionRequest.findUnique({
          where: { attemptId: `blocked-outsider-${suffix}` },
        }),
      ).toMatchObject({ state: "WAITING" });
      expect(
        await db.capacityLease.findUnique({ where: { attemptId: `ceiling-borrower-${suffix}` } }),
      ).toMatchObject({ state: "ACTIVE" });
    } finally {
      await db.user.delete({ where: { id: user.id } }).catch(() => undefined);
      await db.$disconnect();
    }
  });
});

type RelayHandlers = {
  onHeaders(message: {
    type: "relay.response.headers";
    requestId: string;
    status: number;
    headers: Record<string, string>;
  }): void;
  onBody(
    chunk: Uint8Array,
    message: {
      type: "relay.response.body";
      requestId: string;
      chunkId: string;
    },
  ): void;
  onComplete(message: {
    type: "relay.complete";
    requestId: string;
    usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  }): void;
  onError(message: { type: "relay.error"; requestId: string; failure: "transport" }): void;
};

class PostgresRouteFakeRelayManager {
  readonly sent: Array<{ requestId: string; cliDeviceId: string }> = [];
  readonly cancelled: string[] = [];
  readonly handlers = new Map<string, RelayHandlers>();
  activeCliDeviceIds: string[] = [];

  getActiveCliDeviceIds() {
    return this.activeCliDeviceIds;
  }

  registerRelayResponseHandlers(input: { requestId: string; handlers: RelayHandlers }) {
    this.handlers.set(input.requestId, input.handlers);
  }

  sendRelayRequest(input: { requestId: string; cliDeviceId: string }) {
    this.sent.push(input);
  }

  cancelRelayRequest(input: { requestId: string }) {
    this.cancelled.push(input.requestId);
    this.handlers.delete(input.requestId);
  }

  completeRelayRequest() {}

  headers(requestId: string, status: number, contentType: string) {
    this.handlers.get(requestId)?.onHeaders({
      type: "relay.response.headers",
      requestId,
      status,
      headers: { "content-type": contentType },
    });
  }

  body(requestId: string, body: string) {
    this.handlers.get(requestId)?.onBody(new TextEncoder().encode(body), {
      type: "relay.response.body",
      requestId,
      chunkId: crypto.randomUUID(),
    });
  }

  complete(requestId: string) {
    const handlers = this.handlers.get(requestId);
    this.handlers.delete(requestId);
    handlers?.onComplete({
      type: "relay.complete",
      requestId,
      usage: { promptTokens: 3, completionTokens: 5, totalTokens: 8 },
    });
  }
}

async function waitFor<T>(
  read: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 2_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for PostgreSQL route test state.");
}

integration("model API routes with real PostgreSQL capacity", () => {
  it("releases and fences direct, streaming, cancelled, and retried pool attempts", async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    process.env.BETTER_AUTH_SECRET = "w7Qp9Lm2Nx4Rv6Tk8Yc3Hu5Jd1Fs0ZaB";
    process.env.BETTER_AUTH_URL = "http://localhost:3000";
    process.env.MODEL_API_GLOBAL_CAPACITY_ENABLED = "true";

    const [{ default: prisma }, security, routes, storeModule, runtimeModule, apiRouters, orpc] =
      await Promise.all([
        import("@ws-model-proxy/db"),
        import("@ws-model-proxy/db/forwarder-security"),
        import("../routes.js"),
        import("./postgres-store.js"),
        import("./runtime.js"),
        import("@ws-model-proxy/api/routers/index"),
        import("@orpc/server"),
      ]);
    const suffix = crypto.randomUUID();
    const secret = `wsmp_model_${crypto.randomUUID().replaceAll("-", "")}`;
    const user = await prisma.user.create({
      data: {
        name: "Capacity route proof",
        email: `capacity-route-${suffix}@example.test`,
        slug: `capacity-route-${suffix}`,
      },
    });
    const manager = new PostgresRouteFakeRelayManager();
    const capacities = await Promise.all(
      ["a", "b"].map((label) =>
        prisma.inferenceCapacity.create({
          data: {
            userId: user.id,
            label: `route-${label}-${suffix}`,
            runtimeIdentityKey: `route-${label}-${suffix}`,
            runtimeModel: `route-model-${label}`,
            hardConcurrencyLimit: 1,
            physicalMaxContext: 32_768,
            countStrategy: "CONSERVATIVE_ESTIMATE",
          },
        }),
      ),
    );
    const cli = await prisma.cliDevice.create({
      data: {
        userId: user.id,
        slug: `cli-${suffix}`,
        label: "Capacity route CLI",
        status: "CONNECTED",
        inventoryConfirmed: true,
        endpointTargeting: true,
      },
    });
    manager.activeCliDeviceIds = [cli.id];
    const endpoint = await prisma.endpoint.create({
      data: {
        userId: user.id,
        cliDeviceId: cli.id,
        slug: `endpoint-${suffix}`,
        label: "Capacity route endpoint",
        status: "ONLINE",
        published: true,
        capabilityMetadata: {
          version: 1,
          protocol: "openai-compatible",
          chatCompletions: { supported: true, streaming: true },
        },
      },
    });
    const models = await Promise.all(
      ["a", "b"].map(async (label, index) => {
        const model = await prisma.discoveredModel.create({
          data: {
            userId: user.id,
            endpointId: endpoint.id,
            upstreamModelId: `route-model-${label}`,
            encodedModelId: `route-model-${label}`,
            published: true,
          },
        });
        const target = await prisma.executionTarget.upsert({
          where: { discoveredModelId: model.id },
          update: {
            inferenceCapacityId: capacities[index]?.id,
            directConcurrencyLimit: 1,
            directWaitBudgetMs: 1_000,
          },
          create: {
            userId: user.id,
            kind: "DISCOVERED_MODEL",
            discoveredModelId: model.id,
            inferenceCapacityId: capacities[index]?.id,
            directConcurrencyLimit: 1,
            directWaitBudgetMs: 1_000,
          },
        });
        return { model, target };
      }),
    );
    const pool = await prisma.modelPool.create({
      data: {
        userId: user.id,
        slug: `pool-${suffix}`,
        name: "Capacity route pool",
        capacityConcurrencyLimit: 1,
        capacityWaitBudgetMs: 1_000,
      },
    });
    await Promise.all(
      models.map(({ model, target }, index) =>
        prisma.poolMember.create({
          data: {
            poolId: pool.id,
            discoveredModelId: model.id,
            executionTargetId: target.id,
            weight: index === 0 ? 2 : 1,
          },
        }),
      ),
    );
    await prisma.modelApiToken.create({
      data: {
        userId: user.id,
        name: "Capacity route token",
        lookupPrefix: security.credentialLookupPrefix(secret),
        secretDigest: security.hmacDigestForForwarderPurpose({
          purpose: "modelApiToken",
          value: secret,
        }),
      },
    });

    const store = new storeModule.PostgresCapacityAdmissionStore(prisma, `route-proof-${suffix}`);
    const runtime = new runtimeModule.StoreCapacityAdmissionRuntime(store, 5, 60_000);
    const app = routes.createModelApiRoutes({
      manager: manager as never,
      capacityEnabled: true,
      capacityRuntime: runtime,
    });
    const authorization = { authorization: `Bearer ${secret}`, "content-type": "application/json" };
    const directModelId = `${user.slug}/${cli.slug}/${endpoint.slug}/${models[0]?.model.upstreamModelId}`;
    const request = (model: string, stream = false, signal?: AbortSignal) =>
      app.request("/chat/completions", {
        method: "POST",
        headers: authorization,
        body: JSON.stringify({ model, stream, messages: [{ role: "user", content: "proof" }] }),
        signal,
      });

    try {
      // Gate the actual procedure, not only Prisma's transaction primitive:
      // force its audit insert to fail after modelPool.create and prove the
      // procedure's transaction rolls the pool mutation back.
      await prisma.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION fail_route_pool_audit() RETURNS trigger
        LANGUAGE plpgsql AS $fn$
        BEGIN
          IF NEW."resourceType" = 'MODEL_POOL' AND NEW.action = 'CREATE'
             AND EXISTS (
               SELECT 1 FROM model_pool
                WHERE id = NEW."resourceId" AND slug LIKE 'rollback-router-%'
             ) THEN
            RAISE EXCEPTION 'forced route audit failure' USING ERRCODE = '23514';
          END IF;
          RETURN NEW;
        END
        $fn$
      `);
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS fail_route_pool_audit_trigger ON capacity_audit_event`,
      );
      await prisma.$executeRawUnsafe(`
        CREATE TRIGGER fail_route_pool_audit_trigger
        BEFORE INSERT ON capacity_audit_event
        FOR EACH ROW EXECUTE FUNCTION fail_route_pool_audit()
      `);
      try {
        const management = orpc.createRouterClient(apiRouters.appRouter, {
          context: {
            session: { user: { id: user.id }, session: {} },
          } as never,
        });
        const rollbackSlug = `rollback-router-${suffix}`;
        await expect(
          management.forwarderManagement.createModelPool({
            slug: rollbackSlug,
            name: "Must roll back",
          }),
        ).rejects.toBeDefined();
        expect(
          await prisma.modelPool.findFirst({ where: { userId: user.id, slug: rollbackSlug } }),
        ).toBeNull();
      } finally {
        await prisma.$executeRawUnsafe(
          `DROP TRIGGER IF EXISTS fail_route_pool_audit_trigger ON capacity_audit_event`,
        );
        await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS fail_route_pool_audit()`);
      }

      const directPromise = request(directModelId);
      const directSent = await waitFor(() => manager.sent[0]);
      manager.headers(directSent.requestId, 200, "application/json");
      manager.body(directSent.requestId, JSON.stringify({ id: "direct-ok" }));
      manager.complete(directSent.requestId);
      expect(await (await directPromise).json()).toMatchObject({ id: "direct-ok" });

      const streamPromise = request(directModelId, true);
      const streamSent = await waitFor(() => manager.sent[1]);
      manager.headers(streamSent.requestId, 200, "text/event-stream");
      manager.body(streamSent.requestId, ": heartbeat\n\ndata: [DONE]\n\n");
      manager.complete(streamSent.requestId);
      expect(await (await streamPromise).text()).toContain(": heartbeat");

      const cancelledPromise = request(directModelId, true);
      const cancelledSent = await waitFor(() => manager.sent[2]);
      manager.headers(cancelledSent.requestId, 200, "text/event-stream");
      const cancelledResponse = await cancelledPromise;
      await cancelledResponse.body?.cancel();
      await waitFor(() =>
        manager.cancelled.includes(cancelledSent.requestId) ? cancelledSent.requestId : undefined,
      );

      const poolPromise = request(`${user.slug}/${pool.slug}`);
      const firstPoolSent = await waitFor(() => manager.sent[3]);
      manager.headers(firstPoolSent.requestId, 503, "application/json");
      manager.body(firstPoolSent.requestId, JSON.stringify({ error: "retry" }));
      manager.complete(firstPoolSent.requestId);
      const secondPoolSent = await waitFor(() => manager.sent[4]);
      expect(secondPoolSent.cliDeviceId).toBe(cli.id);
      const [releasedRetryLease, activeRetryLease] = await Promise.all([
        prisma.capacityLease.findFirstOrThrow({
          where: { userId: user.id, poolId: pool.id, state: "RELEASED" },
          orderBy: { createdAt: "desc" },
        }),
        prisma.capacityLease.findFirstOrThrow({
          where: { userId: user.id, poolId: pool.id, state: "ACTIVE" },
          orderBy: { createdAt: "desc" },
        }),
      ]);
      expect(
        await store.release({
          leaseId: activeRetryLease.id,
          attemptId: activeRetryLease.attemptId,
          capacityId: activeRetryLease.capacityId,
          executionTargetId: activeRetryLease.executionTargetId,
          ...(activeRetryLease.poolMemberId ? { poolMemberId: activeRetryLease.poolMemberId } : {}),
          fencingToken: releasedRetryLease.fencingToken,
          expiresAt: activeRetryLease.expiresAt,
        }),
      ).toBe(false);
      expect(
        await prisma.capacityLease.findUnique({ where: { id: activeRetryLease.id } }),
      ).toMatchObject({ state: "ACTIVE", fencingToken: activeRetryLease.fencingToken });
      manager.headers(secondPoolSent.requestId, 200, "application/json");
      manager.body(secondPoolSent.requestId, JSON.stringify({ id: "pool-ok" }));
      manager.complete(secondPoolSent.requestId);
      expect(await (await poolPromise).json()).toMatchObject({ id: "pool-ok" });

      await waitFor(async () => {
        const active = await prisma.capacityLease.count({
          where: { userId: user.id, state: "ACTIVE" },
        });
        return active === 0 ? 0 : undefined;
      });
      const [leases, admissions, relays] = await Promise.all([
        prisma.capacityLease.findMany({
          where: { userId: user.id },
          orderBy: { createdAt: "asc" },
        }),
        prisma.admissionRequest.findMany({
          where: { userId: user.id },
          orderBy: { createdAt: "asc" },
        }),
        prisma.relayRequest.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" } }),
      ]);
      expect(leases).toHaveLength(5);
      expect(leases.every((lease) => lease.state === "RELEASED")).toBe(true);
      expect(new Set(leases.map((lease) => lease.fencingToken.toString())).size).toBeGreaterThan(1);
      expect(new Set(admissions.map((admission) => admission.attemptId)).size).toBe(5);
      expect(admissions.every((admission) => admission.state !== "WAITING")).toBe(true);
      expect(relays).toHaveLength(4);
      expect(relays.every((relay) => relay.admissionWaitDurationMs !== null)).toBe(true);
      expect(relays.every((relay) => relay.admissionFencingToken !== null)).toBe(true);
      expect(relays.some((relay) => relay.status === "CANCELED")).toBe(true);
      expect(relays.find((relay) => relay.attemptCount === 2)).toMatchObject({
        status: "SUCCEEDED",
        admissionBorrowed: expect.any(Boolean),
        admissionReservationClass: expect.any(Number),
      });
    } finally {
      await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
      await prisma.$disconnect();
    }
  }, 20_000);
});
