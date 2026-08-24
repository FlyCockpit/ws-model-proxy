import { createPrismaClient } from "@ws-model-proxy/db/client-factory";
import { describe, expect, it } from "vitest";

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
          priority: 16,
          reservedSlots: 0,
          allowBorrowReserved: true,
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
            priority: 16,
            reservedSlots: 0,
            allowBorrowReserved: true,
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
              priority: 0,
              reservedSlots: 0,
              allowBorrowReserved: true,
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
              priority: 31,
              reservedSlots: 1,
              allowBorrowReserved: false,
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
      }
      await secondClient.$disconnect();
    } finally {
      await db.user.delete({ where: { id: user.id } }).catch(() => undefined);
      await db.$disconnect();
    }
  });
});
