import { createPrismaClient } from "@ws-model-proxy/db/client-factory";
import { PostgresNotificationListener } from "@ws-model-proxy/db/postgres-notifications";
import { describe, expect, it } from "vitest";
import { PRIORITY_CLASS_COUNT, scheduleWeightedDeficitRoundRobin } from "./scheduler.js";

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

if (!databaseUrl)
  console.warn("[capacity-postgres] skipped: SCHEMA_VALIDATION_DATABASE_URL is not configured");

integration("PostgreSQL capacity admission primitives", () => {
  it("serializes the same stable capacity lock across independent clients", async () => {
    if (!databaseUrl) return;
    const first = createPrismaClient(databaseUrl);
    const second = createPrismaClient(databaseUrl);
    const order: string[] = [];
    try {
      const a = first.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"capacity-proof"}, 0))`;
        order.push("first-lock");
        await new Promise((resolve) => setTimeout(resolve, 30));
        order.push("first-release");
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
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
          { admissionRequestId: "later", priority: 7, enqueueSequence: 2n, eligible: true },
          { admissionRequestId: "earlier-b", priority: 7, enqueueSequence: 1n, eligible: true },
          { admissionRequestId: "earlier-a", priority: 7, enqueueSequence: 1n, eligible: true },
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
                priority: 31,
                enqueueSequence: 0n,
                eligible: true,
              },
              { admissionRequestId: "p0-head", priority: 0, enqueueSequence: 0n, eligible: true },
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
        data: { userId: user.id, slug: `pool-${suffix}`, name: "Proof pool" },
      });
      const members = [];
      for (const target of targets)
        members.push(
          await db.poolMember.create({
            data: { poolId: pool.id, executionTargetId: target.id, capacityPriority: 16 },
          }),
        );
      const { PostgresCapacityAdmissionStore } = await import("./postgres-store.js");
      const firstManager = new PostgresCapacityAdmissionStore(db, "proof-server-a");
      const secondClient = createPrismaClient(databaseUrl);
      const secondManager = new PostgresCapacityAdmissionStore(secondClient, "proof-server-b");
      const deadlineAt = new Date(Date.now() + 60_000);
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
        })),
      });
      expect(first.state).toBe("ADMITTED");
      const waiters = await db.capacityWaiter.findMany({
        where: { AdmissionRequest: { attemptId: `attempt-1-${suffix}` } },
      });
      expect(waiters.filter((waiter) => waiter.state === "ADMITTED")).toHaveLength(1);
      expect(waiters.filter((waiter) => waiter.state === "CANCELLED")).toHaveLength(1);

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
        const borrowed = await firstManager.acquire({ ...lowAttempt, candidates: [] });
        expect(borrowed).toMatchObject({ state: "ADMITTED", lease: { capacityId: capacity.id } });
        const borrowedRow = await db.capacityLease.findUniqueOrThrow({
          where: { attemptId: lowAttempt.attemptId },
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
          await db.capacityLease.findUnique({ where: { attemptId: lowAttempt.attemptId } }),
        ).toMatchObject({ state: "ACTIVE" });
        if (borrowed.state !== "ADMITTED") throw new Error("Expected borrowed lease.");
        await db.capacityLease.update({
          where: { id: borrowed.lease.leaseId },
          data: {
            expiresAt: new Date(Date.now() - 1_000),
            heartbeatAt: new Date(Date.now() - 60_000),
          },
        });
        await expect(firstManager.reclaimExpired(new Date(), 10)).resolves.toBe(1);
        await expect(firstManager.release(borrowed.lease)).resolves.toBe(false);
        await expect(
          firstManager.heartbeat(borrowed.lease, new Date(Date.now() + 60_000)),
        ).resolves.toBe(false);

        await db.inferenceCapacity.update({
          where: { id: capacity.id },
          data: { hardConcurrencyLimit: 1 },
        });
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
        await expect(
          firstManager.sweepAbandoned({
            now: new Date(),
            heartbeatBefore: new Date(Date.now() - 60_000),
            limit: 10,
          }),
        ).resolves.toMatchObject({ requests: 1 });
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
        await Promise.all([
          firstManager.cancelAttempt(raceAttempt.attemptId),
          secondManager.acquire({ ...raceAttempt, candidates: [] }),
        ]);
        expect(
          await db.admissionRequest.findUnique({ where: { attemptId: raceAttempt.attemptId } }),
        ).toMatchObject({ state: "CANCELLED" });
        expect(await db.capacityLease.count({ where: { attemptId: raceAttempt.attemptId } })).toBe(
          0,
        );

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
        if (releaseRaceResult.state === "ADMITTED")
          await firstManager.release(releaseRaceResult.lease);
        await expect(firstManager.acquire({ ...deadlineAttempt, candidates: [] })).resolves.toEqual(
          {
            state: "EXPIRED",
          },
        );
        expect(
          await db.capacityLease.count({ where: { attemptId: deadlineAttempt.attemptId } }),
        ).toBe(0);
      }
      await secondClient.$disconnect();
    } finally {
      await db.user.delete({ where: { id: user.id } }).catch(() => undefined);
      await db.$disconnect();
    }
  });
});
