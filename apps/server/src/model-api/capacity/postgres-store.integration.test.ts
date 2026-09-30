import {
  fenceAndValidateModelPoolCapacityPolicy,
  fenceExecutionTargetPolicies,
} from "@ws-model-proxy/api/lib/capacity-policy-safety";
import { acquireFences, fenceOwners, fences } from "@ws-model-proxy/db/capacity-lock-order";
import { PostgresNotificationListener } from "@ws-model-proxy/db/postgres-notifications";
// Fixture writes need no owner fences (the graph-write fence triggers accept
// this client); production code under test uses its own clients.
import { createFixturePrismaClient } from "@ws-model-proxy/db/test-fixture-client";
import { describe, expect, it, vi } from "vitest";
import { PRIORITY_CLASS_COUNT, scheduleWeightedDeficitRoundRobin } from "./scheduler.js";
import type { CapacityLeaseHandle } from "./types.js";

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error(
    "PostgreSQL integration was required but SCHEMA_VALIDATION_DATABASE_URL is unset.",
  );
const integration = databaseUrl ? describe : describe.skip;

if (!databaseUrl)
  console.warn("[capacity-postgres] skipped: SCHEMA_VALIDATION_DATABASE_URL is not configured");

async function cleanupCapacityFixture(
  db: ReturnType<typeof createFixturePrismaClient>,
  userId: string,
): Promise<void> {
  const terminalAt = new Date();
  await db.capacityLease.updateMany({
    where: { userId, state: "ACTIVE" },
    data: { state: "RELEASED", releasedAt: terminalAt, releaseReason: "test_cleanup" },
  });
  await db.capacityWaiter.updateMany({
    where: { userId, state: "WAITING" },
    data: { state: "CANCELLED", stateChangedAt: terminalAt, terminalReason: "test_cleanup" },
  });
  await db.admissionRequest.updateMany({
    where: { userId, state: { in: ["WAITING", "ADMITTED"] } },
    data: { state: "TERMINAL", terminalAt, terminalReason: "test_cleanup" },
  });
  expect(await db.capacityLease.count({ where: { userId, state: "ACTIVE" } })).toBe(0);
  // Lease rows intentionally retain immutable target history through RESTRICT
  // foreign keys. The disposable validation database owns their final removal;
  // this helper's strict contract is that no live scheduler state leaks.
}

integration("PostgreSQL capacity admission primitives", () => {
  it("rolls back pool creation when its capacity-policy audit write fails", async () => {
    if (!databaseUrl) return;
    const db = createFixturePrismaClient(databaseUrl);
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
      await cleanupCapacityFixture(db, user.id);
      await db.$disconnect();
    }
  });

  it("installs fresh-schema admission hardening and a database-owned enqueue sequence", async () => {
    if (!databaseUrl) return;
    const first = createFixturePrismaClient(databaseUrl);
    const second = createFixturePrismaClient(databaseUrl);
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
    const first = createFixturePrismaClient(databaseUrl);
    const second = createFixturePrismaClient(databaseUrl);
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

  it("observes a concurrent physical-limit reduction before admitting", async () => {
    if (!databaseUrl) return;
    const writer = createFixturePrismaClient(databaseUrl);
    const admission = createFixturePrismaClient(databaseUrl);
    const inspector = createFixturePrismaClient(databaseUrl);
    const suffix = crypto.randomUUID();
    const user = await writer.user.create({
      data: { name: "Capacity limit race", email: `capacity-limit-race-${suffix}@example.test` },
    });
    let releaseWriter!: () => void;
    const writerMayCommit = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    let policyWrite: Promise<void> | undefined;
    try {
      const capacity = await writer.inferenceCapacity.create({
        data: {
          userId: user.id,
          label: `capacity-limit-race-${suffix}`,
          runtimeIdentityKey: `capacity-limit-race-${suffix}`,
          runtimeModel: "capacity-limit-race",
          hardConcurrencyLimit: 2,
        },
      });
      const account = await writer.providerAccount.create({
        data: {
          userId: user.id,
          providerType: "proof",
          label: `capacity-limit-race-${suffix}`,
          baseUrl: "https://example.test",
          endpointIdentity: "https://example.test",
          authType: "BEARER",
        },
      });
      const model = await writer.providerModel.create({
        data: { userId: user.id, providerAccountId: account.id, upstreamModelId: suffix },
      });
      const target = await writer.executionTarget.create({
        data: {
          userId: user.id,
          kind: "PROVIDER_MODEL",
          providerModelId: model.id,
          inferenceCapacityId: capacity.id,
        },
      });
      const { PostgresCapacityAdmissionStore } = await import("./postgres-store.js");
      const store = new PostgresCapacityAdmissionStore(admission, "limit-race-admission");
      const attempt = (name: string) => ({
        requestId: `${name}-${suffix}`,
        attemptId: `${name}-${suffix}`,
        ownerId: user.id,
        sourceKind: "DIRECT" as const,
        basePriority: 16,
        connectionOwner: name,
        deadlineAt: new Date(Date.now() + 60_000),
        candidates: [{ capacityId: capacity.id, executionTargetId: target.id, candidateOrder: 0 }],
      });
      const blocker = await store.acquire(attempt("blocker"));
      if (blocker.state !== "ADMITTED") throw new Error("Expected the first capacity lease.");

      let writerLocked!: () => void;
      const writerHasLock = new Promise<void>((resolve) => {
        writerLocked = resolve;
      });
      // A limit writer (class M): owner fence, then the capacity fence the
      // admission path also takes, then the row.
      policyWrite = writer.$transaction(async (tx) => {
        await fenceOwners(tx, [user.id]);
        await acquireFences(tx, [fences.capacity(capacity.id)]);
        await tx.inferenceCapacity.update({
          where: { id: capacity.id },
          data: { hardConcurrencyLimit: 1 },
        });
        writerLocked();
        await writerMayCommit;
      });
      await writerHasLock;

      const contender = store.acquire(attempt("contender"));
      let blocked = false;
      for (let poll = 0; poll < 100 && !blocked; poll++) {
        const rows = await inspector.$queryRaw<Array<{ blocked: boolean }>>`
          SELECT EXISTS (
            SELECT 1
              FROM pg_stat_activity
             WHERE cardinality(pg_blocking_pids(pid)) > 0
               AND query LIKE '%wsmp_acquire_fences%'
          ) AS blocked`;
        blocked = rows[0]?.blocked ?? false;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      releaseWriter();
      await policyWrite;

      await expect(contender).resolves.toMatchObject({ state: "WAITING" });
      expect(
        await admission.capacityLease.count({
          where: { capacityId: capacity.id, state: "ACTIVE" },
        }),
      ).toBe(1);
      await store.release(blocker.lease);
    } finally {
      releaseWriter();
      await policyWrite?.catch(() => undefined);
      await cleanupCapacityFixture(writer, user.id);
      await Promise.all([writer.$disconnect(), admission.$disconnect(), inspector.$disconnect()]);
    }
  });

  it("observes a pool unlimited-to-limited update across distinct capacities before admission", async () => {
    if (!databaseUrl) return;
    const suffix = crypto.randomUUID();
    const namedUrl = (name: string) =>
      `${databaseUrl}${databaseUrl.includes("?") ? "&" : "?"}application_name=${encodeURIComponent(name)}`;
    const writerName = `capacity-policy-writer-${suffix}`;
    const admissionNames = [
      `capacity-policy-admission-a-${suffix}`,
      `capacity-policy-admission-b-${suffix}`,
    ];
    const writer = createFixturePrismaClient(namedUrl(writerName));
    const admissions = admissionNames.map((name) => createFixturePrismaClient(namedUrl(name)));
    const inspector = createFixturePrismaClient(databaseUrl);
    const user = await writer.user.create({
      data: { name: "Pool policy race", email: `pool-policy-race-${suffix}@example.test` },
    });
    let allowWriterCommit!: () => void;
    const writerMayCommit = new Promise<void>((resolve) => {
      allowWriterCommit = resolve;
    });
    let policyWrite: Promise<void> | undefined;
    let admissionAttempts: Promise<unknown>[] = [];
    let writerPid: number | undefined;
    try {
      const pool = await writer.modelPool.create({
        data: {
          userId: user.id,
          slug: `pool-policy-race-${suffix}`,
          name: "Pool policy race",
          capacityConcurrencyLimit: null,
        },
      });
      const account = await writer.providerAccount.create({
        data: {
          userId: user.id,
          providerType: "proof",
          label: `pool-policy-race-${suffix}`,
          baseUrl: "https://example.test",
          endpointIdentity: "https://example.test",
          authType: "BEARER",
        },
      });
      const candidates: Array<{
        capacityId: string;
        executionTargetId: string;
        poolMemberId: string;
      }> = [];
      for (const index of [0, 1]) {
        const capacity = await writer.inferenceCapacity.create({
          data: {
            userId: user.id,
            label: `pool-policy-race-${index}-${suffix}`,
            runtimeIdentityKey: `pool-policy-race-${index}-${suffix}`,
            runtimeModel: "pool-policy-race",
            hardConcurrencyLimit: 1,
          },
        });
        const model = await writer.providerModel.create({
          data: {
            userId: user.id,
            providerAccountId: account.id,
            upstreamModelId: `${index}-${suffix}`,
          },
        });
        const target = await writer.executionTarget.create({
          data: {
            userId: user.id,
            kind: "PROVIDER_MODEL",
            providerModelId: model.id,
            inferenceCapacityId: capacity.id,
          },
        });
        // Provider targets are external fallback members (PRIMARY is local-only).
        const member = await writer.poolMember.create({
          data: {
            poolId: pool.id,
            executionTargetId: target.id,
            tier: "PUBLIC_OVERFLOW",
            publicOrder: index,
            capacityConcurrencyMode: "INHERIT",
          },
        });
        candidates.push({
          capacityId: capacity.id,
          executionTargetId: target.id,
          poolMemberId: member.id,
        });
      }

      let writerLocked!: () => void;
      const writerHasLocks = new Promise<void>((resolve) => {
        writerLocked = resolve;
      });
      policyWrite = writer.$transaction(async (tx) => {
        const backend = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        writerPid = backend[0]?.pid;
        if (writerPid === undefined) throw new Error("Policy writer backend unavailable.");
        // The production writer sequence (writer class M): the owner fence,
        // the capacity-policy fences of the member targets, then the pool row.
        await fenceOwners(tx, [user.id]);
        await fenceExecutionTargetPolicies(
          tx,
          candidates.map(({ executionTargetId }) => executionTargetId),
        );
        await tx.$queryRaw`SELECT id FROM model_pool WHERE id = ${pool.id} FOR NO KEY UPDATE`;
        await tx.modelPool.update({
          where: { id: pool.id },
          data: { capacityConcurrencyLimit: 1 },
        });
        writerLocked();
        await writerMayCommit;
      });
      await writerHasLocks;

      const { PostgresCapacityAdmissionStore } = await import("./postgres-store.js");
      const attempts = candidates.map((candidate, index) =>
        new PostgresCapacityAdmissionStore(admissions[index]!, `pool-policy-${index}`).acquire({
          requestId: `pool-policy-${index}-${suffix}`,
          attemptId: `pool-policy-${index}-${suffix}`,
          ownerId: user.id,
          sourceKind: "POOL",
          poolId: pool.id,
          basePriority: 16,
          connectionOwner: `pool-policy-${index}`,
          deadlineAt: new Date(Date.now() + 60_000),
          candidates: [{ ...candidate, candidateOrder: 0 }],
        }),
      );
      admissionAttempts = attempts;
      let blockedAdmissions = 0;
      for (let poll = 0; poll < 200 && blockedAdmissions !== 2; poll++) {
        const rows = await inspector.$queryRaw<Array<{ count: bigint }>>`
          SELECT COUNT(*)::bigint AS count
            FROM pg_stat_activity
           WHERE ${writerPid} = ANY(pg_blocking_pids(pid))
             AND wait_event_type = 'Lock'`;
        blockedAdmissions = Number(rows[0]?.count ?? 0n);
        if (blockedAdmissions !== 2) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blockedAdmissions).toBe(2);
      allowWriterCommit();
      await policyWrite;

      const results = await Promise.all(attempts);
      expect(results.filter(({ state }) => state === "ADMITTED")).toHaveLength(1);
      expect(results.filter(({ state }) => state === "WAITING")).toHaveLength(1);
      expect(
        await inspector.capacityLease.count({ where: { poolId: pool.id, state: "ACTIVE" } }),
      ).toBe(1);
      const admitted = results.find((result) => result.state === "ADMITTED");
      if (admitted?.state === "ADMITTED")
        await new PostgresCapacityAdmissionStore(admissions[0]!, "pool-policy-release").release(
          admitted.lease,
        );
    } finally {
      allowWriterCommit();
      await policyWrite?.catch(() => undefined);
      await Promise.allSettled(admissionAttempts);
      await cleanupCapacityFixture(writer, user.id);
      await Promise.all([
        writer.$disconnect(),
        inspector.$disconnect(),
        ...admissions.map((client) => client.$disconnect()),
      ]);
    }
  }, 15_000);

  it("inserts an admitted lease while a policy writer holding pool/target locks waits on that capacity (no 40P01)", async () => {
    // DL-1 regression. Side A is a policy writer (or admission poll): it holds
    // the model_pool row and the execution_target row + capacity-policy fence
    // through the production helpers, then requests the capacity advisory lock.
    // Side B is the admitter (release/reclaim/acquire via #admitCapacity): it holds
    // the capacity advisory lock and inference_capacity row, then inserts a
    // capacity_lease whose FK checks take FOR KEY SHARE on the pool and target
    // rows. With FOR UPDATE parent locks this is a guaranteed deadlock that
    // PostgreSQL resolves by aborting one side with 40P01.
    if (!databaseUrl) return;
    const suffix = crypto.randomUUID();
    const namedUrl = (name: string) =>
      `${databaseUrl}${databaseUrl.includes("?") ? "&" : "?"}application_name=${encodeURIComponent(name)}`;
    const writer = createFixturePrismaClient(namedUrl(`dl1-policy-${suffix}`));
    const admitter = createFixturePrismaClient(namedUrl(`dl1-admitter-${suffix}`));
    const inspector = createFixturePrismaClient(databaseUrl);
    const user = await writer.user.create({
      data: { name: "Lock order proof", email: `dl1-lock-order-${suffix}@example.test` },
    });
    let allowPolicyCapacityLock!: () => void;
    const policyMayRequestCapacity = new Promise<void>((resolve) => {
      allowPolicyCapacityLock = resolve;
    });
    let policySide: Promise<void> | undefined;
    let admitterSide: Promise<void> | undefined;
    try {
      const pool = await writer.modelPool.create({
        data: {
          userId: user.id,
          slug: `dl1-lock-order-${suffix}`,
          name: "Lock order proof",
          capacityConcurrencyLimit: null,
        },
      });
      const capacity = await writer.inferenceCapacity.create({
        data: {
          userId: user.id,
          label: `dl1-lock-order-${suffix}`,
          runtimeIdentityKey: `dl1-lock-order-${suffix}`,
          runtimeModel: "dl1-lock-order",
          hardConcurrencyLimit: 1,
        },
      });
      const account = await writer.providerAccount.create({
        data: {
          userId: user.id,
          providerType: "proof",
          label: `dl1-lock-order-${suffix}`,
          baseUrl: "https://example.test",
          endpointIdentity: "https://example.test",
          authType: "BEARER",
        },
      });
      const model = await writer.providerModel.create({
        data: { userId: user.id, providerAccountId: account.id, upstreamModelId: suffix },
      });
      const target = await writer.executionTarget.create({
        data: {
          userId: user.id,
          kind: "PROVIDER_MODEL",
          providerModelId: model.id,
          inferenceCapacityId: capacity.id,
        },
      });
      // Provider targets are external fallback members (PRIMARY is local-only).
      const member = await writer.poolMember.create({
        data: {
          poolId: pool.id,
          executionTargetId: target.id,
          tier: "PUBLIC_OVERFLOW",
          publicOrder: 0,
          capacityConcurrencyMode: "INHERIT",
        },
      });
      const { PostgresCapacityAdmissionStore } = await import("./postgres-store.js");
      const store = new PostgresCapacityAdmissionStore(admitter, `dl1-${suffix}`);
      const attempt = (name: string) => ({
        requestId: `${name}-${suffix}`,
        attemptId: `${name}-${suffix}`,
        ownerId: user.id,
        sourceKind: "POOL" as const,
        poolId: pool.id,
        basePriority: 16,
        connectionOwner: name,
        deadlineAt: new Date(Date.now() + 60_000),
        candidates: [
          {
            capacityId: capacity.id,
            executionTargetId: target.id,
            poolMemberId: member.id,
            candidateOrder: 0,
          },
        ],
      });
      const holder = await store.acquire(attempt("dl1-holder"));
      if (holder.state !== "ADMITTED") throw new Error("Expected the first capacity lease.");
      await expect(store.acquire(attempt("dl1-waiter"))).resolves.toMatchObject({
        state: "WAITING",
      });
      const waiting = await inspector.admissionRequest.findUniqueOrThrow({
        where: { attemptId: `dl1-waiter-${suffix}` },
      });

      let policyPid: number | undefined;
      let policyLocked!: () => void;
      const policyHasLocks = new Promise<void>((resolve) => {
        policyLocked = resolve;
      });
      policySide = writer.$transaction(
        async (tx) => {
          const backend = await tx.$queryRaw<
            Array<{ pid: number }>
          >`SELECT pg_backend_pid() AS pid`;
          policyPid = backend[0]?.pid;
          await fenceOwners(tx, [user.id]);
          await fenceAndValidateModelPoolCapacityPolicy(tx, {
            modelPoolId: pool.id,
            userId: user.id,
            policy: {},
            notFound: () => {
              throw new Error("Pool not found.");
            },
          });
          policyLocked();
          await policyMayRequestCapacity;
          await acquireFences(tx, [fences.capacity(capacity.id)]);
        },
        { timeout: 20_000 },
      );
      await policyHasLocks;
      if (policyPid === undefined) throw new Error("Policy backend unavailable.");

      admitterSide = admitter.$transaction(
        async (tx) => {
          const backend = await tx.$queryRaw<
            Array<{ pid: number }>
          >`SELECT pg_backend_pid() AS pid`;
          const admitterPid = backend[0]?.pid;
          await acquireFences(tx, [fences.capacity(capacity.id)]);
          allowPolicyCapacityLock();
          // Wait until side A is provably queued behind this transaction's
          // capacity advisory lock, then take the FK FOR KEY SHARE locks.
          let queued = false;
          for (let poll = 0; poll < 200 && !queued; poll++) {
            const rows = await inspector.$queryRaw<Array<{ queued: boolean }>>`
              SELECT ${admitterPid}::int = ANY(pg_blocking_pids(${policyPid}::int)) AS queued`;
            queued = rows[0]?.queued ?? false;
            if (!queued) await new Promise((resolve) => setTimeout(resolve, 10));
          }
          expect(queued).toBe(true);
          await tx.capacityLease.create({
            data: {
              userId: user.id,
              requestId: waiting.requestId,
              attemptId: waiting.attemptId,
              admissionRequestId: waiting.id,
              capacityId: capacity.id,
              executionTargetId: target.id,
              poolId: pool.id,
              poolMemberId: member.id,
              priority: 16,
              reservationClass: 16,
              fencingToken: 1_000_000n,
              ownerServerInstance: `dl1-${suffix}`,
              heartbeatAt: new Date(),
              expiresAt: new Date(Date.now() + 30_000),
            },
          });
        },
        { timeout: 20_000 },
      );

      // Neither side may be chosen as a deadlock victim: both must commit.
      const outcomes = await Promise.allSettled([admitterSide, policySide]);
      expect(
        outcomes.map((outcome) =>
          outcome.status === "fulfilled" ? "committed" : String(outcome.reason),
        ),
      ).toEqual(["committed", "committed"]);
      expect(
        await inspector.capacityLease.count({
          where: { capacityId: capacity.id, state: "ACTIVE" },
        }),
      ).toBe(2);
      await store.release(holder.lease);
    } finally {
      allowPolicyCapacityLock();
      await Promise.allSettled([policySide, admitterSide]);
      await cleanupCapacityFixture(writer, user.id);
      await Promise.all([writer.$disconnect(), admitter.$disconnect(), inspector.$disconnect()]);
    }
  }, 30_000);

  const startupTimezones = ["UTC", "Asia/Tokyo", "America/New_York"];
  it.each(startupTimezones)("DB clock with startup zone %s", async (timezone) => {
    if (!databaseUrl) return;
    // Startup options override role/database defaults; pool initialization must
    // override these in turn, on every connection (including lock contenders).
    const url = new URL(databaseUrl);
    url.searchParams.set(
      "options",
      `${url.searchParams.get("options") ?? ""} -c TimeZone=${timezone}`.trim(),
    );
    const first = createFixturePrismaClient(url.toString());
    const second = createFixturePrismaClient(url.toString());
    const suffix = crypto.randomUUID();
    const user = await first.user.create({
      data: { name: "Database clock proof", email: `database-clock-${suffix}@example.test` },
    });
    try {
      const capacity = await first.inferenceCapacity.create({
        data: {
          userId: user.id,
          label: `database-clock-${suffix}`,
          runtimeIdentityKey: `database-clock-${suffix}`,
          runtimeModel: "database-clock-proof",
          hardConcurrencyLimit: 1,
        },
      });
      const account = await first.providerAccount.create({
        data: {
          userId: user.id,
          providerType: "proof",
          label: `database-clock-${suffix}`,
          baseUrl: "https://example.test",
          endpointIdentity: "https://example.test",
          authType: "BEARER",
        },
      });
      const model = await first.providerModel.create({
        data: { userId: user.id, providerAccountId: account.id, upstreamModelId: suffix },
      });
      const target = await first.executionTarget.create({
        data: {
          userId: user.id,
          kind: "PROVIDER_MODEL",
          providerModelId: model.id,
          inferenceCapacityId: capacity.id,
        },
      });
      const { PostgresCapacityAdmissionStore } = await import("./postgres-store.js");
      const { StoreCapacityAdmissionRuntime } = await import("./runtime.js");
      const firstManager = new PostgresCapacityAdmissionStore(first, "database-clock-a");
      const secondManager = new PostgresCapacityAdmissionStore(second, "database-clock-b");
      const databaseNow = async () => {
        const [row] = await first.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
        if (!row) throw new Error("Database clock unavailable in integration test.");
        return row.now;
      };
      const attempt = (name: string, deadlineAt: Date) => ({
        requestId: `${name}-${suffix}`,
        attemptId: `${name}-${suffix}`,
        ownerId: user.id,
        sourceKind: "DIRECT" as const,
        basePriority: 16,
        connectionOwner: name,
        deadlineAt,
        candidates: [{ capacityId: capacity.id, executionTargetId: target.id, candidateOrder: 0 }],
      });

      const blocker = await firstManager.acquire(
        attempt("clock-blocker", new Date((await databaseNow()).getTime() + 60_000)),
      );
      if (blocker.state !== "ADMITTED") throw new Error("Expected database-clock blocker.");
      const deadlineAttempt = attempt(
        "clock-deadline",
        new Date((await databaseNow()).getTime() + 60_000),
      );
      await expect(secondManager.acquire(deadlineAttempt)).resolves.toMatchObject({
        state: "WAITING",
      });

      const skewDeadline = new Date((await databaseNow()).getTime() + 60_000);
      const skewAttempt = attempt("clock-skew", skewDeadline);
      await expect(secondManager.acquire(skewAttempt)).resolves.toMatchObject({ state: "WAITING" });
      await first.$executeRaw`
        UPDATE admission_request SET "deadlineAt" = NULL
         WHERE "attemptId" = ${skewAttempt.attemptId}`;
      await first.$executeRaw`
        UPDATE capacity_waiter SET "deadlineAt" = NULL
         WHERE "admissionRequestId" = (
           SELECT id FROM admission_request WHERE "attemptId" = ${skewAttempt.attemptId}
         )`;
      await expect(
        secondManager.terminalizeAttempt(skewAttempt.attemptId, "EXPIRED"),
      ).resolves.toMatchObject({ state: "WAITING" });
      await expect(
        secondManager.acquire({ ...skewAttempt, candidates: [] }),
      ).resolves.toMatchObject({ state: "WAITING" });
      await expect(
        first.admissionRequest.findUniqueOrThrow({ where: { attemptId: skewAttempt.attemptId } }),
      ).resolves.toMatchObject({ state: "WAITING", deadlineAt: skewDeadline });
      await first.$executeRaw`
        UPDATE admission_request
           SET "deadlineAt" = clock_timestamp() + interval '250 milliseconds'
         WHERE "attemptId" = ${skewAttempt.attemptId}`;
      const skewRuntime = new StoreCapacityAdmissionRuntime(
        secondManager,
        10,
        5_000,
        undefined,
        () => skewDeadline.getTime() + 60_000,
      );
      await expect(skewRuntime.acquire(skewAttempt)).resolves.toEqual({ state: "EXPIRED" });
      await expect(
        first.admissionRequest.findUniqueOrThrow({ where: { attemptId: skewAttempt.attemptId } }),
      ).resolves.toMatchObject({ state: "EXPIRED" });

      let locked!: () => void;
      let unlock!: () => void;
      const hasLock = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const releaseLock = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      let shortenedDeadline!: Date;
      const lockHolder = first.$transaction(async (tx) => {
        await acquireFences(tx, [fences.capacity(capacity.id)]);
        // Shorten only the persisted candidate deadline after setup has
        // completed. The competing manager must re-read it after obtaining the
        // advisory lock instead of trusting its pre-lock view or process clock.
        const [shortened] = await tx.$queryRaw<Array<{ deadlineAt: Date }>>`
          UPDATE capacity_waiter
             SET "deadlineAt" = clock_timestamp() + interval '150 milliseconds'
           WHERE "admissionRequestId" = (
             SELECT id FROM admission_request WHERE "attemptId" = ${deadlineAttempt.attemptId}
           )
       RETURNING "deadlineAt"`;
        if (!shortened) throw new Error("Shortened waiter deadline unavailable.");
        shortenedDeadline = shortened.deadlineAt;
        locked();
        await releaseLock;
      });
      await hasLock;
      const delayedPoll = secondManager.acquire({ ...deadlineAttempt, candidates: [] });
      // Deterministic ordering instead of a fixed sleep: the competing manager is
      // provably queued behind the lock holder's fences, and the database clock is
      // provably past the shortened deadline, before the lock is released.
      for (let poll = 0; ; poll++) {
        const [row] = await first.$queryRaw<Array<{ queued: boolean }>>`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
             WHERE datname = current_database()
               AND wait_event_type = 'Lock'
               AND cardinality(pg_blocking_pids(pid)) > 0
          ) AS queued`;
        if (row?.queued) break;
        if (poll >= 500) throw new Error("Competing manager never queued behind the lock holder.");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      while ((await databaseNow()).getTime() <= shortenedDeadline.getTime()) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      unlock();
      await lockHolder;
      await expect(delayedPoll).resolves.toEqual({ state: "EXPIRED" });
      expect(
        await first.capacityLease.count({ where: { attemptId: deadlineAttempt.attemptId } }),
      ).toBe(0);

      await firstManager.release(blocker.lease);
      const live = await firstManager.acquire(
        attempt("clock-live", new Date((await databaseNow()).getTime() + 60_000)),
      );
      if (live.state !== "ADMITTED") throw new Error("Expected live database-clock lease.");
      const beforeHeartbeat = await databaseNow();
      // F2-CAP-1: renewal must not wait for an unrelated admission/reclaim
      // transaction's capacity fences and capacity row lock. This file is
      // already registered in test:postgres.
      await first.$transaction(async (tx) => {
        await acquireFences(tx, [fences.capacity(capacity.id)]);
        await tx.$queryRaw`SELECT id FROM inference_capacity WHERE id = ${capacity.id} FOR UPDATE`;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          const renewal = await Promise.race([
            secondManager.heartbeat(live.lease, 2_000),
            new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(
                () => reject(new Error("heartbeat waited on admission locks")),
                1_000,
              );
            }),
          ]);
          expect(renewal).toBe(true);
        } finally {
          clearTimeout(timeout);
        }
      });
      const [heartbeated, afterHeartbeat] = await Promise.all([
        first.capacityLease.findUniqueOrThrow({ where: { id: live.lease.leaseId } }),
        databaseNow(),
      ]);
      expect(heartbeated.expiresAt.getTime() - heartbeated.heartbeatAt.getTime()).toBe(2_000);
      expect(heartbeated.heartbeatAt.getTime()).toBeGreaterThanOrEqual(beforeHeartbeat.getTime());
      expect(heartbeated.heartbeatAt.getTime()).toBeLessThanOrEqual(afterHeartbeat.getTime());
      expect(heartbeated.expiresAt.getTime()).toBeGreaterThan(afterHeartbeat.getTime());

      // A wildly future application clock cannot reclaim a lease whose database
      // expiry is still live; reclaimExpired deliberately ignores its legacy input.
      await expect(
        firstManager.reclaimExpired(new Date("9999-12-31T23:59:59.999Z"), 10_000),
      ).resolves.toEqual(expect.any(Number));
      expect(
        await first.capacityLease.findUniqueOrThrow({ where: { id: live.lease.leaseId } }),
      ).toMatchObject({ state: "ACTIVE" });

      await first.$executeRaw`
        UPDATE capacity_lease
           SET "expiresAt" = clock_timestamp() - interval '1 millisecond'
         WHERE id = ${live.lease.leaseId}`;
      await expect(secondManager.heartbeat(live.lease, 60_000)).resolves.toBe(false);
      // A wildly past application clock cannot suppress database-expired cleanup.
      await expect(
        firstManager.reclaimExpired(new Date("1900-01-01T00:00:00.000Z"), 10_000),
      ).resolves.toEqual(expect.any(Number));
      await expect(secondManager.heartbeat(live.lease, 60_000)).resolves.toBe(false);
      expect(
        await first.capacityLease.findUniqueOrThrow({ where: { id: live.lease.leaseId } }),
      ).toMatchObject({ state: "RECLAIMED", releaseReason: "expired" });
    } finally {
      await cleanupCapacityFixture(first, user.id);
      await Promise.all([first.$disconnect(), second.$disconnect()]);
    }
  });

  it("admits a zero wait budget only when a slot is free right now (database clock)", async () => {
    if (!databaseUrl) return;
    const db = createFixturePrismaClient(databaseUrl);
    const suffix = crypto.randomUUID();
    const user = await db.user.create({
      data: { name: "Zero budget proof", email: `zero-budget-${suffix}@example.test` },
    });
    try {
      const capacity = await db.inferenceCapacity.create({
        data: {
          userId: user.id,
          label: `zero-budget-${suffix}`,
          runtimeIdentityKey: `zero-budget-${suffix}`,
          runtimeModel: "zero-budget-proof",
          hardConcurrencyLimit: 1,
        },
      });
      const account = await db.providerAccount.create({
        data: {
          userId: user.id,
          providerType: "proof",
          label: `zero-budget-${suffix}`,
          baseUrl: "https://example.test",
          endpointIdentity: "https://example.test",
          authType: "BEARER",
        },
      });
      const model = await db.providerModel.create({
        data: { userId: user.id, providerAccountId: account.id, upstreamModelId: suffix },
      });
      const target = await db.executionTarget.create({
        data: {
          userId: user.id,
          kind: "PROVIDER_MODEL",
          providerModelId: model.id,
          inferenceCapacityId: capacity.id,
        },
      });
      const { PostgresCapacityAdmissionStore } = await import("./postgres-store.js");
      const store = new PostgresCapacityAdmissionStore(db, `zero-budget-${suffix}`);
      // The process-side deadline is far away: only the zero database-clock
      // budget may decide these outcomes.
      const attempt = (name: string) => ({
        requestId: `${name}-${suffix}`,
        attemptId: `${name}-${suffix}`,
        ownerId: user.id,
        sourceKind: "DIRECT" as const,
        basePriority: 16,
        connectionOwner: name,
        deadlineAt: new Date(Date.now() + 10 * 60_000),
        candidates: [
          {
            capacityId: capacity.id,
            executionTargetId: target.id,
            candidateOrder: 0,
            waitBudgetMs: 0,
          },
        ],
      });

      // Idle capacity: a zero budget admits in the creating transaction.
      const idle = await store.acquire(attempt("zero-idle"));
      expect(idle.state).toBe("ADMITTED");
      if (idle.state !== "ADMITTED") throw new Error("Expected zero-budget admission.");

      // Busy capacity: a zero budget expires at once instead of queueing.
      await expect(store.acquire(attempt("zero-busy"))).resolves.toEqual({ state: "EXPIRED" });
      const busy = await db.admissionRequest.findUniqueOrThrow({
        where: { attemptId: `zero-busy-${suffix}` },
        include: { Waiters: true },
      });
      expect(busy.state).toBe("EXPIRED");
      expect(busy.Waiters.map((waiter) => waiter.state)).toEqual(["EXPIRED"]);

      // Releasing the slot never admits the expired zero-budget attempt later.
      await store.release(idle.lease);
      expect(
        await db.capacityLease.count({
          where: { attemptId: `zero-busy-${suffix}`, state: "ACTIVE" },
        }),
      ).toBe(0);
    } finally {
      await cleanupCapacityFixture(db, user.id);
      await db.$disconnect();
    }
  });

  it("persists FIFO and weighted WDRR state across independent-client restart", async () => {
    if (!databaseUrl) return;
    let client = createFixturePrismaClient(databaseUrl);
    const cleanup = createFixturePrismaClient(databaseUrl);
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
          await acquireFences(tx, [fences.capacity(capacity.id)]);
          const row = await tx.capacityRuntime.upsert({
            where: { capacityId: capacity.id },
            create: { capacityId: capacity.id, userId: capacity.userId },
            update: {},
          });
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
          await tx.capacityRuntime.update({
            where: { capacityId: capacity.id },
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
          client = createFixturePrismaClient(databaseUrl);
        }
      }
      expect(firstLowRound).toBeGreaterThanOrEqual(0);
      expect(firstLowRound).toBeLessThan(bound);
      expect(winners.filter((priority) => priority === 31).length).toBeGreaterThan(
        winners.filter((priority) => priority === 0).length,
      );
      const persisted = await cleanup.capacityRuntime.findUniqueOrThrow({
        where: { capacityId: capacity.id },
      });
      expect(persisted.schedulerVersion).toBe(1);
      expect(persisted.schedulerDeficits).not.toEqual({});
    } finally {
      await client.$disconnect();
      await cleanupCapacityFixture(cleanup, user.id);
      await cleanup.$disconnect();
    }
  });

  it("recovers from a notification missed while disconnected by bounded polling", async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    const db = createFixturePrismaClient(databaseUrl);
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
      await db.capacityRuntime.create({
        data: { capacityId: capacity.id, userId: user.id, schedulerVersion: 2 },
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
          const row = await db.capacityRuntime.findUnique({ where: { capacityId: capacity.id } });
          return row?.schedulerVersion === 2
            ? { state: "CANCELLED" as const }
            : { state: "WAITING" as const, requestId: "notify-proof" };
        },
      });
      expect(result).toEqual({ state: "CANCELLED" });
      expect(polls).toBeGreaterThan(0);
      await listener.close();
    } finally {
      await cleanupCapacityFixture(db, user.id);
      await db.$disconnect();
    }
  });

  it("atomically chooses one pool candidate, cancels siblings, fences, and enforces the shared cap", async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    const db = createFixturePrismaClient(databaseUrl);
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
      const device = await db.cliDevice.create({
        data: {
          userId: user.id,
          slug: `device-${suffix}`,
        },
      });
      const endpoint = await db.endpoint.create({
        data: {
          userId: user.id,
          cliDeviceId: device.id,
          slug: `endpoint-${suffix}`,
          label: "Capacity endpoint",
        },
      });
      const targets: Array<{ id: string }> = [];
      for (const upstreamModelId of ["proof-a", "proof-b"]) {
        const model = await db.discoveredModel.create({
          data: {
            userId: user.id,
            endpointId: endpoint.id,
            upstreamModelId,
            encodedModelId: `${upstreamModelId}-${suffix}`,
          },
        });
        targets.push(
          await db.executionTarget.update({
            where: { discoveredModelId: model.id },
            data: { inferenceCapacityId: capacity.id },
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
      let rejectNotification = true;
      const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const firstManager = new PostgresCapacityAdmissionStore(db, "proof-server-a", {
        notify: async (capacityIds) => {
          if (rejectNotification) throw new Error("secret notifier detail");
          notifications.push([...capacityIds]);
        },
      });
      const secondClient = createFixturePrismaClient(databaseUrl);
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
      expect(warning).toHaveBeenCalledWith("[capacity] wake notification failed", {
        errorClass: "Error",
        capacityCount: 1,
      });
      expect(JSON.stringify(warning.mock.calls)).not.toContain("secret notifier detail");
      rejectNotification = false;
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
      const admittedWaiter = waiters.find((waiter) => waiter.state === "ADMITTED");
      expect(admittedWaiter).toBeDefined();
      expect(
        await db.capacityLease.findUnique({ where: { attemptId: `attempt-1-${suffix}` } }),
      ).toMatchObject({ poolMemberId: admittedWaiter!.poolMemberId });

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
      rejectNotification = true;
      await expect(firstManager.release(first.lease)).resolves.toBe(true);
      expect(
        await db.capacityLease.findUniqueOrThrow({ where: { id: first.lease.leaseId } }),
      ).toMatchObject({ state: "RELEASED", releaseReason: "released" });
      rejectNotification = false;
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
        await expect(firstManager.heartbeat(first.lease, 60_000)).resolves.toBe(false);
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
        rejectNotification = true;
        await expect(firstManager.cancelAttempt(lowAttempt.attemptId)).resolves.toBe(true);
        expect(
          await db.admissionRequest.findUniqueOrThrow({
            where: { attemptId: lowAttempt.attemptId },
          }),
        ).toMatchObject({ state: "CANCELLED", terminalReason: "cancelled" });
        rejectNotification = false;
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
          secondManager.heartbeat(borrowed.lease, 60_000),
        ]);
        expect(heartbeatWon).toBe(reclaimed === 0);
        if (reclaimed > 0) expect(notifications.flat()).toContain(capacity.id);
        const releasedAfterRace = await firstManager.release(borrowed.lease);
        if (heartbeatWon) expect(releasedAfterRace).toBe(true);
        await expect(firstManager.heartbeat(borrowed.lease, 60_000)).resolves.toBe(false);

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

        const [deadlineClock] = await db.$queryRaw<Array<{ now: Date }>>`
          SELECT clock_timestamp() AS now
        `;
        if (!deadlineClock) throw new Error("Database clock unavailable in integration test.");
        const deadlineAttempt = {
          ...lowAttempt,
          requestId: `request-deadline-${suffix}`,
          attemptId: `attempt-deadline-${suffix}`,
          deadlineAt: new Date(deadlineClock.now.getTime() + 60_000),
        };
        await expect(firstManager.acquire(deadlineAttempt)).resolves.toMatchObject({
          state: "WAITING",
        });
        await db.$executeRaw`
          UPDATE admission_request
             SET "deadlineAt" = clock_timestamp() - interval '1 millisecond'
           WHERE "attemptId" = ${deadlineAttempt.attemptId}
        `;
        await db.$executeRaw`
          UPDATE capacity_waiter
             SET "deadlineAt" = clock_timestamp() - interval '1 millisecond'
           WHERE "admissionRequestId" = (
             SELECT id FROM admission_request WHERE "attemptId" = ${deadlineAttempt.attemptId}
           )
        `;
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
      warning.mockRestore();
      await secondClient.$disconnect();
    } finally {
      await cleanupCapacityFixture(db, user.id);
      await db.$disconnect();
    }
  });

  it("caps overcommitted shared-target reservations and distinguishes NEVER from WHEN_IDLE borrowing", async () => {
    if (!databaseUrl) return;
    const db = createFixturePrismaClient(databaseUrl);
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
      const device = await db.cliDevice.create({
        data: {
          userId: user.id,
          slug: `device-${suffix}`,
        },
      });
      const endpoint = await db.endpoint.create({
        data: {
          userId: user.id,
          cliDeviceId: device.id,
          slug: `endpoint-${suffix}`,
          label: "Reservation endpoint",
        },
      });
      const targets: Array<{ id: string }> = [];
      for (const name of ["shared", "direct"]) {
        const model = await db.discoveredModel.create({
          data: {
            userId: user.id,
            endpointId: endpoint.id,
            upstreamModelId: `${name}-${suffix}`,
            encodedModelId: `${name}-${suffix}`,
          },
        });
        targets.push(
          await db.executionTarget.update({
            where: { discoveredModelId: model.id },
            data: {
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
            data: {
              poolId: pool.id,
              executionTargetId: targets[0]!.id,
            },
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
      const secondModel = await db.discoveredModel.create({
        data: {
          userId: user.id,
          endpointId: endpoint.id,
          upstreamModelId: `second-${suffix}`,
          encodedModelId: `second-${suffix}`,
        },
      });
      const secondTarget = await db.executionTarget.update({
        where: { discoveredModelId: secondModel.id },
        data: { inferenceCapacityId: secondCapacity.id },
      });
      const inheritedMember = await db.poolMember.create({
        data: {
          poolId: members[0]!.pool.id,
          executionTargetId: secondTarget.id,
        },
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
      const raceClient = createFixturePrismaClient(databaseUrl);
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
            // Reclaim is global. A high limit prevents unrelated older test
            // fixtures from excluding this lease, while the row state below
            // determines which side of this exact reclaim/heartbeat race won.
            manager.reclaimExpired(new Date(), 10_000),
            raceManager.heartbeat(admitted.lease, 60_000),
          ]);
          expect(reclaimed).toBeGreaterThanOrEqual(0);
          const racedLease = await db.capacityLease.findUniqueOrThrow({
            where: { id: admitted.lease.leaseId },
          });
          expect([racedLease.state, heartbeated]).toEqual(
            heartbeated ? ["ACTIVE", true] : ["RECLAIMED", false],
          );
          if (heartbeated) await raceManager.release(admitted.lease);
          await expect(manager.heartbeat(admitted.lease, 60_000)).resolves.toBe(false);
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
      await db.capacityRuntime.upsert({
        where: { capacityId: capacity.id },
        create: {
          capacityId: capacity.id,
          userId: capacity.userId,
          schedulerCursor: 31,
          schedulerDeficits: Array(32).fill(0),
        },
        update: { schedulerCursor: 31, schedulerDeficits: Array(32).fill(0) },
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
      await cleanupCapacityFixture(db, user.id);
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

    const [{ default: shared }, security, routes, storeModule, runtimeModule, apiRouters, orpc] =
      await Promise.all([
        import("@ws-model-proxy/db"),
        import("@ws-model-proxy/db/forwarder-security"),
        import("../routes.js"),
        import("./postgres-store.js"),
        import("./runtime.js"),
        import("@ws-model-proxy/api/routers/index"),
        import("@orpc/server"),
      ]);
    // Fixture writes bypass the graph-write fences; the store under test runs
    // on the shared production client.
    const prisma = createFixturePrismaClient(databaseUrl);
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

    const store = new storeModule.PostgresCapacityAdmissionStore(shared, `route-proof-${suffix}`);
    const runtime = new runtimeModule.StoreCapacityAdmissionRuntime(store, 5, 60_000);
    const app = routes.createModelApiRoutes({
      manager: manager as never,
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
        const retryRelay = await prisma.relayRequest.findFirst({
          where: { userId: user.id, requestedModelPoolId: pool.id },
        });
        return retryRelay?.status === "SUCCEEDED" && retryRelay.attemptCount === 2
          ? retryRelay
          : undefined;
      });
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
      expect(relays.find((relay) => relay.requestedModelPoolId === pool.id)).toMatchObject({
        status: "SUCCEEDED",
        attemptCount: 2,
        admissionBorrowed: expect.any(Boolean),
        admissionReservationClass: expect.any(Number),
      });
    } finally {
      await cleanupCapacityFixture(prisma, user.id);
      await prisma.$disconnect();
      await shared.$disconnect();
    }
  }, 20_000);
});

/**
 * Saturation S-A: spill-over `notBefore`, deadlines from the spill instant,
 * and the grant-time routability re-check, all on the database clock.
 */
integration("PostgreSQL cache-holder spill-over and grant-time routability", () => {
  type Db = ReturnType<typeof createFixturePrismaClient>;
  type Store = import("./postgres-store.js").PostgresCapacityAdmissionStore;

  /**
   * One pool whose members each sit on their own capacity (single-slot unless
   * `limits[index]` says otherwise; `null` = an unlimited capacity).
   */
  async function spillFixture(
    db: Db,
    memberCount: number,
    limits: readonly (number | null)[] = [],
  ) {
    const suffix = crypto.randomUUID();
    const user = await db.user.create({
      data: { name: "Spill proof", email: `spill-${suffix}@example.test`, slug: `spill-${suffix}` },
    });
    const device = await db.cliDevice.create({
      data: { userId: user.id, slug: `device-${suffix}` },
    });
    const endpoint = await db.endpoint.create({
      data: { userId: user.id, cliDeviceId: device.id, slug: `endpoint-${suffix}`, label: "Spill" },
    });
    const pool = await db.modelPool.create({
      data: { userId: user.id, slug: `pool-${suffix}`, name: "Spill pool" },
    });
    const members: Array<{ capacityId: string; executionTargetId: string; poolMemberId: string }> =
      [];
    for (let index = 0; index < memberCount; index++) {
      const capacity = await db.inferenceCapacity.create({
        data: {
          userId: user.id,
          label: `spill-${index}-${suffix}`,
          runtimeIdentityKey: `spill-${index}-${suffix}`,
          runtimeModel: "spill-proof",
          hardConcurrencyLimit: index < limits.length ? limits[index]! : 1,
        },
      });
      const model = await db.discoveredModel.create({
        data: {
          userId: user.id,
          endpointId: endpoint.id,
          upstreamModelId: `spill-${index}`,
          encodedModelId: `spill-${index}-${suffix}`,
        },
      });
      const target = await db.executionTarget.update({
        where: { discoveredModelId: model.id },
        data: { inferenceCapacityId: capacity.id },
      });
      const member = await db.poolMember.create({
        data: { poolId: pool.id, executionTargetId: target.id },
      });
      members.push({
        capacityId: capacity.id,
        executionTargetId: target.id,
        poolMemberId: member.id,
      });
    }
    const attempt = (
      name: string,
      candidates: Array<{ member: number; notBeforeMs?: number; waitBudgetMs?: number | null }>,
    ) => ({
      requestId: `${name}-${suffix}`,
      attemptId: `${name}-${suffix}`,
      ownerId: user.id,
      sourceKind: "POOL" as const,
      poolId: pool.id,
      basePriority: 16,
      connectionOwner: "spill-proof",
      deadlineAt: new Date(Date.now() + 10 * 60_000),
      candidates: candidates.map((candidate, candidateOrder) => ({
        ...members[candidate.member]!,
        candidateOrder,
        ...(candidate.notBeforeMs !== undefined ? { notBeforeMs: candidate.notBeforeMs } : {}),
        ...(candidate.waitBudgetMs !== undefined ? { waitBudgetMs: candidate.waitBudgetMs } : {}),
      })),
    });
    return { suffix, user, pool, members, attempt };
  }

  const poll = (store: Store, attempt: Parameters<Store["acquire"]>[0]) =>
    store.acquire({ ...attempt, candidates: [] });
  const dbNow = async (db: Db) =>
    (await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`)[0]!.now;
  const sleep = (milliseconds: number) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));

  it("keeps a free cold member ineligible until notBefore, then spills to it", async () => {
    if (!databaseUrl) return;
    const db = createFixturePrismaClient(databaseUrl);
    const { PostgresCapacityAdmissionStore } = await import("./postgres-store.js");
    const store = new PostgresCapacityAdmissionStore(db, "spill-proof");
    const fixture = await spillFixture(db, 2);
    try {
      const blocker = await store.acquire(fixture.attempt("blocker", [{ member: 0 }]));
      expect(blocker.state).toBe("ADMITTED");
      const before = await dbNow(db);
      const request = fixture.attempt("continuation", [
        { member: 0 },
        { member: 1, notBeforeMs: 1_200 },
      ]);
      // Member 1 is FREE, but it is not the cache holder: no grant yet.
      await expect(store.acquire(request)).resolves.toMatchObject({ state: "WAITING" });
      await expect(poll(store, request)).resolves.toMatchObject({ state: "WAITING" });
      const waiters = await db.capacityWaiter.findMany({
        where: { attemptId: request.attemptId },
        orderBy: { candidateOrder: "asc" },
      });
      expect(waiters[0]!.notBefore).toBeNull();
      const notBefore = waiters[1]!.notBefore!;
      // Database clock: notBefore = clock_timestamp() + 1200 ms at enqueue.
      expect(notBefore.getTime() - before.getTime()).toBeGreaterThanOrEqual(1_200);
      expect(notBefore.getTime() - before.getTime()).toBeLessThan(1_200 + 5_000);
      for (const waiter of waiters)
        expect(waiter.deadlineAt!.getTime()).toBeGreaterThanOrEqual(notBefore.getTime());

      await sleep(Math.max(0, notBefore.getTime() - (await dbNow(db)).getTime()) + 50);
      const spilled = await poll(store, request);
      expect(spilled.state).toBe("ADMITTED");
      if (spilled.state !== "ADMITTED") throw new Error("Expected spill admission.");
      expect(spilled.lease.poolMemberId).toBe(fixture.members[1]!.poolMemberId);
      if (blocker.state === "ADMITTED") await store.release(blocker.lease);
    } finally {
      await cleanupCapacityFixture(db, fixture.user.id);
      await db.$disconnect();
    }
  });

  it("grants the cache holder when it frees inside the window, never the deferred member", async () => {
    if (!databaseUrl) return;
    const db = createFixturePrismaClient(databaseUrl);
    const { PostgresCapacityAdmissionStore } = await import("./postgres-store.js");
    const store = new PostgresCapacityAdmissionStore(db, "spill-holder-proof");
    const fixture = await spillFixture(db, 2);
    try {
      const blocker = await store.acquire(fixture.attempt("blocker", [{ member: 0 }]));
      if (blocker.state !== "ADMITTED") throw new Error("Expected blocker admission.");
      const request = fixture.attempt("continuation", [
        { member: 0 },
        { member: 1, notBeforeMs: 20_000 },
      ]);
      await expect(store.acquire(request)).resolves.toMatchObject({ state: "WAITING" });
      // The holder frees: release's fill admits the continuation on it.
      await store.release(blocker.lease);
      const admitted = await poll(store, request);
      expect(admitted.state).toBe("ADMITTED");
      if (admitted.state !== "ADMITTED") throw new Error("Expected holder admission.");
      expect(admitted.lease.poolMemberId).toBe(fixture.members[0]!.poolMemberId);
      await store.release(admitted.lease);
    } finally {
      await cleanupCapacityFixture(db, fixture.user.id);
      await db.$disconnect();
    }
  });

  it("counts every budget from the spill instant and keeps a zero budget checkable once", async () => {
    if (!databaseUrl) return;
    const db = createFixturePrismaClient(databaseUrl);
    const { DEFERRED_MIN_ELIGIBLE_WINDOW_MS, PostgresCapacityAdmissionStore } = await import(
      "./postgres-store.js"
    );
    const store = new PostgresCapacityAdmissionStore(db, "spill-budget-proof");
    const fixture = await spillFixture(db, 2);
    try {
      const blockers = [
        await store.acquire(fixture.attempt("blocker-0", [{ member: 0 }])),
        await store.acquire(fixture.attempt("blocker-1", [{ member: 1 }])),
      ];
      const request = fixture.attempt("external", [
        { member: 0, waitBudgetMs: 0 },
        { member: 1, waitBudgetMs: 400, notBeforeMs: 800 },
      ]);
      await expect(store.acquire(request)).resolves.toMatchObject({ state: "WAITING" });
      const [holder, cold] = await db.capacityWaiter.findMany({
        where: { attemptId: request.attemptId },
        orderBy: { candidateOrder: "asc" },
      });
      const spillAt = cold!.notBefore!.getTime();
      // External deadline = max(notBefore) + E for every candidate; a zero
      // budget still gets one short eligible window at the spill instant.
      expect(cold!.deadlineAt!.getTime()).toBe(spillAt + 400);
      expect(holder!.deadlineAt!.getTime()).toBe(spillAt + DEFERRED_MIN_ELIGIBLE_WINDOW_MS);
      await sleep(Math.max(0, spillAt + 400 - (await dbNow(db)).getTime()) + 50);
      await expect(poll(store, request)).resolves.toEqual({ state: "EXPIRED" });
      for (const blocker of blockers)
        if (blocker.state === "ADMITTED") await store.release(blocker.lease);
    } finally {
      await cleanupCapacityFixture(db, fixture.user.id);
      await db.$disconnect();
    }
  });

  it("checks a deferred waiter once even when its owner's poll is delayed past its deadline", async () => {
    if (!databaseUrl) return;
    const db = createFixturePrismaClient(databaseUrl);
    const { PostgresCapacityAdmissionStore } = await import("./postgres-store.js");
    const store = new PostgresCapacityAdmissionStore(db, "spill-last-chance-proof");
    const fixture = await spillFixture(db, 2);
    try {
      const blocker = await store.acquire(fixture.attempt("blocker", [{ member: 0 }]));
      if (blocker.state !== "ADMITTED") throw new Error("Expected blocker admission.");
      // externalAfterWaitMs = 0: "go external unless a local member is free
      // at the spill instant". The cold member stays free throughout.
      const request = fixture.attempt("external", [
        { member: 0, waitBudgetMs: 0 },
        { member: 1, waitBudgetMs: 0, notBeforeMs: 300 },
      ]);
      await expect(store.acquire(request)).resolves.toMatchObject({ state: "WAITING" });
      const cold = await db.capacityWaiter.findFirstOrThrow({
        where: { attemptId: request.attemptId, candidateOrder: 1 },
      });
      // The owner's next poll is delayed past the cold waiter's deadline (as
      // by a contended capacity lock), while ANOTHER admitter's pass runs on
      // the cold capacity after that deadline: neither may expire the waiter
      // before it had one admission check.
      await sleep(Math.max(0, cold.deadlineAt!.getTime() - (await dbNow(db)).getTime()) + 100);
      await expect(
        store.acquire(fixture.attempt("other", [{ member: 1, notBeforeMs: 20_000 }])),
      ).resolves.toMatchObject({ state: "WAITING" });
      await expect(
        db.capacityWaiter.findUniqueOrThrow({ where: { id: cold.id } }),
      ).resolves.toMatchObject({ state: "WAITING" });
      const admitted = await poll(store, request);
      expect(admitted.state).toBe("ADMITTED");
      if (admitted.state !== "ADMITTED") throw new Error("Expected last-chance admission.");
      expect(admitted.lease.poolMemberId).toBe(fixture.members[1]!.poolMemberId);
      await store.release(admitted.lease);
      await store.release(blocker.lease);
    } finally {
      await cleanupCapacityFixture(db, fixture.user.id);
      await db.$disconnect();
    }
  });

  /**
   * Design pass (C1a-1 -> C2a-1): the polling/creating request is offered
   * EVERY free slot of its capacity before any of its waiters expire, even
   * when an older eligible waiter of another request takes a slot first.
   * Member 0 (the holder) is always busy; member 1 is the cold capacity.
   */
  type OfferRow = {
    name: string;
    /** Cold capacity limit (null = unlimited). */
    coldSlots: number | null;
    /** An older request deferred to the cold member, eligible when R1 is checked. */
    olderDeferred: boolean;
    /** How many older deferred requests (default 1). */
    olderCount?: number;
    cancelOlder?: boolean;
    occupyCold?: boolean;
    /** How R1 gets its check. */
    check: "last-chance" | "in-window" | "new-zero-budget";
    expected: "ADMITTED" | "EXPIRED";
  };
  const offerRows: OfferRow[] = [
    {
      name: "last chance, older waiter takes one of two slots",
      coldSlots: 2,
      olderDeferred: true,
      check: "last-chance",
      expected: "ADMITTED",
    },
    {
      name: "in-window poll, older waiter takes one of two slots",
      coldSlots: 2,
      olderDeferred: true,
      check: "in-window",
      expected: "ADMITTED",
    },
    {
      name: "new zero budget, older waiter takes one of two slots",
      coldSlots: 2,
      olderDeferred: true,
      check: "new-zero-budget",
      expected: "ADMITTED",
    },
    {
      name: "last chance, the only slot goes to the older waiter",
      coldSlots: 1,
      olderDeferred: true,
      check: "last-chance",
      expected: "EXPIRED",
    },
    {
      name: "last chance, the older waiter was cancelled",
      coldSlots: 1,
      olderDeferred: true,
      cancelOlder: true,
      check: "last-chance",
      expected: "ADMITTED",
    },
    {
      name: "last chance, cold capacity full",
      coldSlots: 1,
      olderDeferred: false,
      occupyCold: true,
      check: "last-chance",
      expected: "EXPIRED",
    },
    {
      name: "new zero budget, cold capacity full",
      coldSlots: 1,
      olderDeferred: false,
      occupyCold: true,
      check: "new-zero-budget",
      expected: "EXPIRED",
    },
    {
      // C3-1: a constant loop bound left an unlimited capacity unserved.
      name: "unlimited cold capacity, 70 older eligible waiters, last chance",
      coldSlots: null,
      olderDeferred: true,
      olderCount: 70,
      check: "last-chance",
      expected: "ADMITTED",
    },
    {
      name: "unlimited cold capacity, 70 older eligible waiters, new zero budget",
      coldSlots: null,
      olderDeferred: true,
      olderCount: 70,
      check: "new-zero-budget",
      expected: "ADMITTED",
    },
  ];

  it.each(offerRows)(
    "offers every free slot before expiry: $name",
    async (row) => {
      if (!databaseUrl) return;
      const db = createFixturePrismaClient(databaseUrl);
      const { PostgresCapacityAdmissionStore } = await import("./postgres-store.js");
      const store = new PostgresCapacityAdmissionStore(db, "spill-offer-proof");
      const fixture = await spillFixture(db, 2, [1, row.coldSlots]);
      const leases: CapacityLeaseHandle[] = [];
      const admit = async (attempt: Parameters<Store["acquire"]>[0]) => {
        const result = await store.acquire(attempt);
        if (result.state === "ADMITTED") leases.push(result.lease);
        return result;
      };
      try {
        await expect(admit(fixture.attempt("holder-busy", [{ member: 0 }]))).resolves.toMatchObject(
          {
            state: "ADMITTED",
          },
        );
        if (row.occupyCold)
          await expect(admit(fixture.attempt("cold-busy", [{ member: 1 }]))).resolves.toMatchObject(
            {
              state: "ADMITTED",
            },
          );
        const olderCount = row.olderDeferred ? (row.olderCount ?? 1) : 0;
        const olders = Array.from({ length: olderCount }, (_, index) =>
          fixture.attempt(`older-${index}`, [
            { member: 0, waitBudgetMs: 10_000 },
            // Far in the future while the fixture is built (SQL re-times it below),
            // so no creating pass grants an older waiter early.
            { member: 1, waitBudgetMs: 10_000, notBeforeMs: 30_000 },
          ]),
        );
        for (let start = 0; start < olders.length; start += 4)
          await Promise.all(
            olders
              .slice(start, start + 4)
              .map(async (older) =>
                expect(admit(older)).resolves.toMatchObject({ state: "WAITING" }),
              ),
          );
        const r1 =
          row.check === "new-zero-budget"
            ? fixture.attempt("r1", [
                { member: 0, waitBudgetMs: 0 },
                { member: 1, waitBudgetMs: 0 },
              ])
            : fixture.attempt("r1", [
                { member: 0, waitBudgetMs: 0 },
                { member: 1, waitBudgetMs: 0, notBeforeMs: 300 },
              ]);
        if (row.check !== "new-zero-budget")
          await expect(admit(r1)).resolves.toMatchObject({ state: "WAITING" });
        if (row.cancelOlder)
          for (const older of olders) await store.terminalizeAttempt(older.attemptId, "CANCELLED");
        const olderLeases = () =>
          db.capacityLease.count({
            where: { attemptId: { in: olders.map((older) => older.attemptId) }, state: "ACTIVE" },
          });
        let result: Awaited<ReturnType<Store["acquire"]>>;
        if (row.check === "new-zero-budget") {
          // Make the older requests' deferred waiters eligible (SQL) first.
          await db.$executeRaw`UPDATE capacity_waiter
          SET "notBefore" = clock_timestamp() - interval '100 milliseconds'
          WHERE "attemptId" = ANY(${olders.map((older) => older.attemptId)}::text[])
            AND "candidateOrder" = 1 AND state = 'WAITING'`;
          // No pass has touched the cold capacity since: the older requests hold
          // no lease, so R1's creating pass is the first to see them eligible.
          expect(await olderLeases()).toBe(0);
          result = await admit(r1);
        } else {
          const cold = await db.capacityWaiter.findFirstOrThrow({
            where: { attemptId: r1.attemptId, candidateOrder: 1 },
          });
          // Re-time the older requests' cold waiters (SQL) so they become
          // eligible just before R1's check, however long R1's creating pass took
          // (its own notBefore is 300 ms after its creation instant).
          await db.$executeRaw`UPDATE capacity_waiter
          SET "notBefore" = ${new Date(cold.notBefore!.getTime() - 100)}
          WHERE "attemptId" = ANY(${olders.map((older) => older.attemptId)}::text[])
            AND "candidateOrder" = 1 AND state = 'WAITING'`;
          const target =
            row.check === "in-window"
              ? cold.notBefore!.getTime() + 60
              : cold.deadlineAt!.getTime() + 100;
          await sleep(Math.max(0, target - (await dbNow(db)).getTime()));
          // The discrimination of this row: R1's check is the FIRST pass on the
          // cold capacity after the older waiters became eligible.
          expect(await olderLeases()).toBe(0);
          result = await admit({ ...r1, candidates: [] });
        }
        expect(result.state).toBe(row.expected);
        if (result.state === "ADMITTED")
          expect(result.lease.poolMemberId).toBe(fixture.members[1]!.poolMemberId);
        // Fairness is unchanged: every older eligible waiter was served first.
        if (row.olderDeferred && !row.cancelOlder) {
          expect(await olderLeases()).toBe(olderCount);
          // Batched write: each winner's waiter is ADMITTED, its sibling on the
          // holder's capacity is CANCELLED (sibling_lost), none stays WAITING.
          const olderWaiters = await db.capacityWaiter.findMany({
            where: { attemptId: { in: olders.map((older) => older.attemptId) } },
            select: { state: true, terminalReason: true, capacityId: true },
          });
          expect(olderWaiters).toHaveLength(2 * olderCount);
          expect(
            olderWaiters.filter(
              (waiter) =>
                waiter.state === "ADMITTED" && waiter.capacityId === fixture.members[1]!.capacityId,
            ),
          ).toHaveLength(olderCount);
          expect(
            olderWaiters.filter(
              (waiter) => waiter.state === "CANCELLED" && waiter.terminalReason === "sibling_lost",
            ),
          ).toHaveLength(olderCount);
        }
      } finally {
        for (const lease of leases) await store.release(lease).catch(() => false);
        await cleanupCapacityFixture(db, fixture.user.id);
        await db.$disconnect();
      }
    },
    120_000,
  );

  /**
   * C3-2: one transaction that serves k eligible waiters must stay far below
   * the 15 s transaction timeout (read once, plan in memory, batched writes).
   */
  describe("volume: k eligible deferred waiters are granted by ONE transaction", () => {
    const K = 256;
    const BUDGET_MS = 10_000;

    /** A busy holder (member 0) and K deferred waiters on the cold member 1. */
    async function volumeSetup(db: Db, store: Store, coldLimit: number | null) {
      const fixture = await spillFixture(db, 2, [1, coldLimit]);
      const holder = await store.acquire(fixture.attempt("holder", [{ member: 0 }]));
      if (holder.state !== "ADMITTED") throw new Error("Expected the holder to be admitted.");
      const attempts = Array.from({ length: K }, (_, index) =>
        fixture.attempt(`w-${String(index).padStart(3, "0")}`, [
          { member: 0 },
          { member: 1, notBeforeMs: 30_000 },
        ]),
      );
      // Building K waiters takes longer than the 30 s notBefore cap, so push
      // every cold waiter's notBefore out again (SQL) after each chunk.
      const deferAll = () =>
        db.$executeRaw`UPDATE capacity_waiter
          SET "notBefore" = clock_timestamp() + interval '5 minutes'
          WHERE "userId" = ${fixture.user.id} AND "capacityId" = ${fixture.members[1]!.capacityId}
            AND state = 'WAITING'`;
      for (let start = 0; start < attempts.length; start += 4) {
        await Promise.all(
          attempts.slice(start, start + 4).map(async (attempt) => {
            const created = await store.acquire(attempt);
            expect(created.state).toBe("WAITING");
          }),
        );
        await deferAll();
      }
      const makeEligible = () =>
        db.$executeRaw`UPDATE capacity_waiter
          SET "notBefore" = clock_timestamp() - interval '100 milliseconds'
          WHERE "userId" = ${fixture.user.id} AND "capacityId" = ${fixture.members[1]!.capacityId}
            AND state = 'WAITING'`;
      const coldLeases = () =>
        db.capacityLease.count({
          where: {
            capacityId: fixture.members[1]!.capacityId,
            attemptId: { in: attempts.map((attempt) => attempt.attemptId) },
            state: "ACTIVE",
          },
        });
      return { fixture, holder, attempts, makeEligible, coldLeases };
    }

    it(`grants ${K} eligible waiters on an unlimited capacity in ONE poll`, async () => {
      if (!databaseUrl) return;
      const db = createFixturePrismaClient(databaseUrl);
      const { PostgresCapacityAdmissionStore } = await import("./postgres-store.js");
      const store = new PostgresCapacityAdmissionStore(db, "spill-volume-poll-proof");
      const setup = await volumeSetup(db, store, null);
      try {
        await setup.makeEligible();
        expect(await setup.coldLeases()).toBe(0);
        // The youngest request polls: it is served last, after all older ones.
        // (Chunks are created concurrently, so "youngest" is by durable sequence.)
        const youngestRow = await db.admissionRequest.findFirstOrThrow({
          where: {
            userId: setup.fixture.user.id,
            attemptId: { in: setup.attempts.map((a) => a.attemptId) },
          },
          orderBy: { enqueueSequence: "desc" },
        });
        const youngest = setup.attempts.find(
          (attempt) => attempt.attemptId === youngestRow.attemptId,
        )!;
        const started = performance.now();
        const result = await store.acquire({ ...youngest, candidates: [] });
        const elapsedMs = performance.now() - started;
        console.log(`[volume] one poll granted ${K} waiters in ${elapsedMs.toFixed(0)} ms`);
        expect(result.state).toBe("ADMITTED");
        expect(await setup.coldLeases()).toBe(K);
        expect(elapsedMs).toBeLessThan(BUDGET_MS);
        // Fencing tokens are unique per grant on the capacity.
        const tokens = await db.capacityLease.findMany({
          where: { capacityId: setup.fixture.members[1]!.capacityId },
          select: { fencingToken: true },
        });
        expect(new Set(tokens.map((lease) => lease.fencingToken)).size).toBe(K);
        // The token counter lives in capacity_runtime (writer class H).
        const capacity = await db.capacityRuntime.findUniqueOrThrow({
          where: { capacityId: setup.fixture.members[1]!.capacityId },
        });
        expect(capacity.nextFencingToken).toBe(BigInt(K) + 1n);
      } finally {
        await cleanupCapacityFixture(db, setup.fixture.user.id);
        await db.$disconnect();
      }
    }, 240_000);

    it(`grants ${K} eligible waiters in ONE release()`, async () => {
      if (!databaseUrl) return;
      const db = createFixturePrismaClient(databaseUrl);
      const { PostgresCapacityAdmissionStore } = await import("./postgres-store.js");
      const store = new PostgresCapacityAdmissionStore(db, "spill-volume-release-proof");
      // Limit K + 1: one occupant, K free slots once it is released.
      const setup = await volumeSetup(db, store, K + 1);
      try {
        const occupant = await store.acquire(setup.fixture.attempt("occupant", [{ member: 1 }]));
        if (occupant.state !== "ADMITTED") throw new Error("Expected the occupant to be admitted.");
        await setup.makeEligible();
        expect(await setup.coldLeases()).toBe(0);
        const started = performance.now();
        await expect(store.release(occupant.lease)).resolves.toBe(true);
        const elapsedMs = performance.now() - started;
        console.log(`[volume] one release granted ${K} waiters in ${elapsedMs.toFixed(0)} ms`);
        expect(await setup.coldLeases()).toBe(K);
        expect(elapsedMs).toBeLessThan(BUDGET_MS);
      } finally {
        await cleanupCapacityFixture(db, setup.fixture.user.id);
        await db.$disconnect();
      }
    }, 240_000);
  });

  it("fills 5000 waiting requests on one capacity in one release transaction", async () => {
    if (!databaseUrl) return;
    const db = createFixturePrismaClient(databaseUrl);
    const { PostgresCapacityAdmissionStore } = await import("./postgres-store.js");
    const store = new PostgresCapacityAdmissionStore(db, "volume-5000");
    const fixture = await spillFixture(db, 1, [1]);
    const member = fixture.members[0]!;
    const count = 5000;
    try {
      const holder = await store.acquire(fixture.attempt("holder", [{ member: 0 }]));
      if (holder.state !== "ADMITTED") throw new Error("Expected the holder lease.");
      const now = await dbNow(db);
      const deadlineAt = new Date(now.getTime() + 300_000);
      // Seed durable WAITING rows in parameter-bounded chunks. This avoids
      // measuring 5000 separate enqueue transactions instead of a single fill.
      for (let start = 0; start < count; start += 250) {
        const requests = Array.from({ length: Math.min(250, count - start) }, (_, offset) => {
          const id = `volume-${start + offset}-${fixture.suffix}`;
          return {
            id,
            userId: fixture.user.id,
            requestId: id,
            attemptId: id,
            sourceKind: "POOL" as const,
            poolId: fixture.pool.id,
            basePriority: 16,
            enqueueSequence: BigInt(start + offset + 1),
            connectionOwner: "volume-5000",
            heartbeatAt: now,
            deadlineAt,
          };
        });
        await db.admissionRequest.createMany({ data: requests });
        await db.capacityWaiter.createMany({
          data: requests.map((request) => ({
            userId: request.userId,
            admissionRequestId: request.id,
            requestId: request.id,
            attemptId: request.id,
            enqueueSequence: request.enqueueSequence,
            capacityId: member.capacityId,
            executionTargetId: member.executionTargetId,
            poolId: fixture.pool.id,
            poolMemberId: member.poolMemberId,
            candidateOrder: 0,
            deadlineAt,
            effectivePriority: 16,
            effectiveConcurrencyScope: "POOL",
            effectiveConcurrencyScopeId: fixture.pool.id,
          })),
        });
      }
      expect(
        await db.capacityWaiter.count({
          where: { capacityId: member.capacityId, state: "WAITING" },
        }),
      ).toBe(count);
      await db.inferenceCapacity.update({
        where: { id: member.capacityId },
        data: { hardConcurrencyLimit: null },
      });
      const started = performance.now();
      await expect(store.release(holder.lease)).resolves.toBe(true);
      const elapsed = performance.now() - started;
      console.log(`[volume-5000] one release: ${elapsed.toFixed(0)} ms`);
      // Loose bound (measured about 3-6 s on a loaded host) under the 15 s transaction ceiling.
      expect(elapsed).toBeLessThan(10_000);
      const leases = await db.capacityLease.findMany({
        where: { capacityId: member.capacityId, state: "ACTIVE" },
        select: { fencingToken: true, acquiredAt: true, heartbeatAt: true, expiresAt: true },
      });
      expect(leases).toHaveLength(count);
      expect(new Set(leases.map((lease) => lease.fencingToken)).size).toBe(count);
      // M-1: a swapped heartbeatAt/expiresAt would make every new lease
      // instantly stale (expiresAt = now), so heartbeat's
      // `expiresAt > clock_timestamp()` guard rejects renewals and the lease
      // dies at 30 s. Pin the column relationship on every row: heartbeatAt is
      // the acquisition instant, expiresAt is one 30 s TTL later, and
      // acquiredAt defaults to the insert's now.
      for (const lease of leases) {
        expect(lease.expiresAt.getTime() - lease.heartbeatAt.getTime()).toBe(30_000);
        expect(lease.expiresAt.getTime()).toBeGreaterThan(lease.acquiredAt.getTime());
        // heartbeatAt is the statement clock, acquiredAt the transaction
        // start; they land in the same window, not necessarily equal.
        expect(Math.abs(lease.heartbeatAt.getTime() - lease.acquiredAt.getTime())).toBeLessThan(
          5_000,
        );
      }
      expect(
        await db.admissionRequest.count({ where: { userId: fixture.user.id, state: "ADMITTED" } }),
      ).toBe(count);
      expect(
        await db.capacityWaiter.count({
          where: { capacityId: member.capacityId, state: "WAITING" },
        }),
      ).toBe(0);
      expect(
        await db.capacityRuntime.findUniqueOrThrow({ where: { capacityId: member.capacityId } }),
      ).toMatchObject({ nextFencingToken: BigInt(count) + 2n });
    } finally {
      await cleanupCapacityFixture(db, fixture.user.id);
      await db.$disconnect();
    }
  }, 60_000);

  /**
   * C4-2: scope limits (pool, member, direct target) are consumed by EACH grant
   * of one plan (the planner advances scope counts in memory through the
   * store's lease-scope keys). Three eligible deferred waiters on an unlimited
   * capacity, scope limit 2: one poll leaves exactly 2 ACTIVE and R WAITING.
   */
  it.each(["POOL", "MEMBER", "DIRECT_TARGET"] as const)(
    "a %s-scoped limit is consumed per grant of one plan",
    async (scope) => {
      if (!databaseUrl) return;
      const db = createFixturePrismaClient(databaseUrl);
      const { PostgresCapacityAdmissionStore } = await import("./postgres-store.js");
      const store = new PostgresCapacityAdmissionStore(db, `spill-scope-${scope}`);
      const fixture = await spillFixture(db, 2, [1, null]);
      const cold = fixture.members[1]!;
      try {
        if (scope === "POOL")
          await db.modelPool.update({
            where: { id: fixture.pool.id },
            data: { capacityConcurrencyLimit: 2 },
          });
        if (scope === "MEMBER")
          await db.poolMember.update({
            where: { id: cold.poolMemberId },
            data: { capacityConcurrencyMode: "LIMITED", capacityConcurrencyLimit: 2 },
          });
        if (scope === "DIRECT_TARGET")
          await db.executionTarget.update({
            where: { id: cold.executionTargetId },
            data: { directConcurrencyLimit: 2 },
          });
        const attempts = [0, 1, 2].map((index) => {
          const pooled = fixture.attempt(`scope-${index}`, [{ member: 1, notBeforeMs: 30_000 }]);
          if (scope !== "DIRECT_TARGET") return pooled;
          return {
            ...pooled,
            sourceKind: "DIRECT" as const,
            poolId: undefined,
            candidates: pooled.candidates.map(
              ({ poolMemberId: _member, ...candidate }) => candidate,
            ),
          };
        });
        for (const attempt of attempts)
          expect((await store.acquire(attempt)).state).toBe("WAITING");
        await db.$executeRaw`UPDATE capacity_waiter
          SET "notBefore" = clock_timestamp() - interval '100 milliseconds'
          WHERE "userId" = ${fixture.user.id} AND state = 'WAITING'`;
        const result = await store.acquire({ ...attempts[2]!, candidates: [] });
        expect(result.state).toBe("WAITING");
        expect(
          await db.capacityLease.count({ where: { capacityId: cold.capacityId, state: "ACTIVE" } }),
        ).toBe(2);
        await expect(
          db.capacityLease.findFirst({
            where: { attemptId: attempts[2]!.attemptId, state: "ACTIVE" },
          }),
        ).resolves.toBeNull();
      } finally {
        await cleanupCapacityFixture(db, fixture.user.id);
        await db.$disconnect();
      }
    },
    60_000,
  );

  it("expires a deferred waiter after its last-chance check when nothing is free", async () => {
    if (!databaseUrl) return;
    const db = createFixturePrismaClient(databaseUrl);
    const { PostgresCapacityAdmissionStore } = await import("./postgres-store.js");
    const store = new PostgresCapacityAdmissionStore(db, "spill-last-chance-expiry-proof");
    const fixture = await spillFixture(db, 2);
    try {
      const blockers = [
        await store.acquire(fixture.attempt("blocker-0", [{ member: 0 }])),
        await store.acquire(fixture.attempt("blocker-1", [{ member: 1 }])),
      ];
      const request = fixture.attempt("external", [
        { member: 0, waitBudgetMs: 0 },
        { member: 1, waitBudgetMs: 0, notBeforeMs: 300 },
      ]);
      await expect(store.acquire(request)).resolves.toMatchObject({ state: "WAITING" });
      const cold = await db.capacityWaiter.findFirstOrThrow({
        where: { attemptId: request.attemptId, candidateOrder: 1 },
      });
      await sleep(Math.max(0, cold.deadlineAt!.getTime() - (await dbNow(db)).getTime()) + 100);
      // One check, nothing free: the request expires on this same poll.
      await expect(poll(store, request)).resolves.toEqual({ state: "EXPIRED" });
      await expect(
        db.capacityWaiter.findUniqueOrThrow({ where: { id: cold.id } }),
      ).resolves.toMatchObject({ state: "EXPIRED", terminalReason: "candidate_deadline" });
      for (const blocker of blockers)
        if (blocker.state === "ADMITTED") await store.release(blocker.lease);
    } finally {
      await cleanupCapacityFixture(db, fixture.user.id);
      await db.$disconnect();
    }
  });

  it("re-anchors a retry round to the first attempt's database-clock schedule", async () => {
    if (!databaseUrl) return;
    const db = createFixturePrismaClient(databaseUrl);
    const { PostgresCapacityAdmissionStore } = await import("./postgres-store.js");
    const store = new PostgresCapacityAdmissionStore(db, "spill-anchor-proof");
    const fixture = await spillFixture(db, 2);
    try {
      const blockers = [
        await store.acquire(fixture.attempt("blocker-0", [{ member: 0 }])),
        await store.acquire(fixture.attempt("blocker-1", [{ member: 1 }])),
      ];
      const first = fixture.attempt("first", [
        { member: 0, waitBudgetMs: 2_000 },
        { member: 1, waitBudgetMs: 2_000, notBeforeMs: 1_000 },
      ]);
      await expect(store.acquire(first)).resolves.toMatchObject({ state: "WAITING" });
      await store.terminalizeAttempt(first.attemptId, "CANCELLED");
      const original = await db.capacityWaiter.findMany({
        where: { attemptId: first.attemptId },
        orderBy: { candidateOrder: "asc" },
      });
      // Time passes (a failed first dispatch, lock waits) before the retry.
      await sleep(400);
      const retry = {
        ...fixture.attempt("retry", [
          { member: 0, waitBudgetMs: 2_000 },
          { member: 1, waitBudgetMs: 2_000, notBeforeMs: 1_000 },
        ]),
        schedule: { anchorAttemptId: first.attemptId, spillDelayMs: 1_000 },
      };
      await expect(store.acquire(retry)).resolves.toMatchObject({ state: "WAITING" });
      const retried = await db.capacityWaiter.findMany({
        where: { attemptId: retry.attemptId },
        orderBy: { candidateOrder: "asc" },
      });
      // Same DB-clock instants as the first round, not restarted.
      expect(retried.map(({ deadlineAt }) => deadlineAt)).toEqual(
        original.map(({ deadlineAt }) => deadlineAt),
      );
      expect(retried[1]!.notBefore).toEqual(original[1]!.notBefore);
      await store.terminalizeAttempt(retry.attemptId, "CANCELLED");

      // Past the original external deadline, a retry only checks "free now".
      await sleep(
        Math.max(0, original[0]!.deadlineAt!.getTime() - (await dbNow(db)).getTime()) + 50,
      );
      const late = {
        ...fixture.attempt("late", [
          { member: 0, waitBudgetMs: 2_000 },
          { member: 1, waitBudgetMs: 2_000, notBeforeMs: 1_000 },
        ]),
        schedule: { anchorAttemptId: first.attemptId, spillDelayMs: 1_000 },
      };
      await expect(store.acquire(late)).resolves.toEqual({ state: "EXPIRED" });

      // An anchor of another owner is ignored: the schedule starts now.
      const foreign = await spillFixture(db, 1);
      try {
        const unrelated = {
          ...fixture.attempt("unrelated", [{ member: 0, waitBudgetMs: 2_000 }]),
          schedule: { anchorAttemptId: `blocker-0-${foreign.suffix}`, spillDelayMs: 0 },
        };
        await store.acquire(foreign.attempt("blocker-0", [{ member: 0 }]));
        const before = await dbNow(db);
        await expect(store.acquire(unrelated)).resolves.toMatchObject({ state: "WAITING" });
        const waiter = await db.capacityWaiter.findFirstOrThrow({
          where: { attemptId: unrelated.attemptId },
        });
        expect(waiter.deadlineAt!.getTime()).toBeGreaterThanOrEqual(before.getTime() + 2_000);
        await store.terminalizeAttempt(unrelated.attemptId, "CANCELLED");
      } finally {
        await cleanupCapacityFixture(db, foreign.user.id);
      }
      for (const blocker of blockers)
        if (blocker.state === "ADMITTED") await store.release(blocker.lease);
    } finally {
      await cleanupCapacityFixture(db, fixture.user.id);
      await db.$disconnect();
    }
  });

  it("ignores a deferred higher-priority reservation owner when arbitrating borrowing", async () => {
    if (!databaseUrl) return;
    const db = createFixturePrismaClient(databaseUrl);
    const { PostgresCapacityAdmissionStore } = await import("./postgres-store.js");
    const store = new PostgresCapacityAdmissionStore(db, "spill-borrow-proof");
    const suffix = crypto.randomUUID();
    const user = await db.user.create({
      data: { name: "Spill borrow", email: `spill-borrow-${suffix}@example.test`, slug: suffix },
    });
    try {
      const capacity = await db.inferenceCapacity.create({
        data: {
          userId: user.id,
          label: suffix,
          runtimeIdentityKey: suffix,
          runtimeModel: "spill-borrow",
          hardConcurrencyLimit: 1,
        },
      });
      const device = await db.cliDevice.create({ data: { userId: user.id, slug: `d-${suffix}` } });
      const endpoint = await db.endpoint.create({
        data: { userId: user.id, cliDeviceId: device.id, slug: `e-${suffix}`, label: "Borrow" },
      });
      const model = await db.discoveredModel.create({
        data: {
          userId: user.id,
          endpointId: endpoint.id,
          upstreamModelId: "borrow",
          encodedModelId: `borrow-${suffix}`,
        },
      });
      const target = await db.executionTarget.update({
        where: { discoveredModelId: model.id },
        data: { inferenceCapacityId: capacity.id },
      });
      const reserved = await db.modelPool.create({
        data: {
          userId: user.id,
          slug: `reserved-${suffix}`,
          name: "Reserved",
          capacityPriority: 20,
          capacityReservedSlots: 1,
        },
      });
      const borrower = await db.modelPool.create({
        data: {
          userId: user.id,
          slug: `borrower-${suffix}`,
          name: "Borrower",
          capacityPriority: 16,
          capacityBorrowPolicy: "WHEN_IDLE",
        },
      });
      const reservedMember = await db.poolMember.create({
        data: { poolId: reserved.id, executionTargetId: target.id },
      });
      const borrowerMember = await db.poolMember.create({
        data: { poolId: borrower.id, executionTargetId: target.id },
      });
      const attempt = (name: string, pool: { id: string }, member: { id: string }, delay = 0) => ({
        requestId: `${name}-${suffix}`,
        attemptId: `${name}-${suffix}`,
        ownerId: user.id,
        sourceKind: "POOL" as const,
        poolId: pool.id,
        basePriority: 16,
        connectionOwner: "spill-borrow",
        deadlineAt: new Date(Date.now() + 60_000),
        candidates: [
          {
            capacityId: capacity.id,
            executionTargetId: target.id,
            poolMemberId: member.id,
            candidateOrder: 0,
            ...(delay ? { notBeforeMs: delay } : {}),
          },
        ],
      });
      // Scheduler state lives in capacity_runtime, created on first admission.
      const deficitsBefore =
        (await db.capacityRuntime.findUnique({ where: { capacityId: capacity.id } }))
          ?.schedulerDeficits ?? null;
      // The reservation owner is deferred: it neither takes the free slot nor
      // blocks the lower-priority borrower from borrowing it.
      await expect(
        store.acquire(attempt("reserved", reserved, reservedMember, 20_000)),
      ).resolves.toMatchObject({ state: "WAITING" });
      const borrowed = await store.acquire(attempt("borrower", borrower, borrowerMember));
      expect(borrowed.state).toBe("ADMITTED");
      if (borrowed.state !== "ADMITTED") throw new Error("Expected borrowed admission.");
      expect(borrowed.lease.borrowed).toBe(true);
      // DRR state advanced only for the class that was actually granted.
      const after = await db.capacityRuntime.findUniqueOrThrow({
        where: { capacityId: capacity.id },
      });
      const deficits = after.schedulerDeficits as number[];
      expect(deficitsBefore === null || Array.isArray(deficitsBefore)).toBe(true);
      expect(deficits[20] ?? 0).toBe(0);
      expect(after.schedulerCursor).not.toBe(20);
      await store.release(borrowed.lease);
    } finally {
      await cleanupCapacityFixture(db, user.id);
      await db.$disconnect();
    }
  });

  it("terminalizes a queued waiter whose member is drained or disabled, without hanging", async () => {
    if (!databaseUrl) return;
    const db = createFixturePrismaClient(databaseUrl);
    const { MEMBER_UNROUTABLE_REASON, PostgresCapacityAdmissionStore } = await import(
      "./postgres-store.js"
    );
    const store = new PostgresCapacityAdmissionStore(db, "spill-route-proof");
    const fixture = await spillFixture(db, 2);
    try {
      const blockers = [
        await store.acquire(fixture.attempt("blocker-0", [{ member: 0 }])),
        await store.acquire(fixture.attempt("blocker-1", [{ member: 1 }])),
      ];
      if (blockers.some((blocker) => blocker.state !== "ADMITTED"))
        throw new Error("Expected blockers to be admitted.");
      const request = fixture.attempt("queued", [{ member: 0 }, { member: 1 }]);
      await expect(store.acquire(request)).resolves.toMatchObject({ state: "WAITING" });

      // Member 1 drains while queued; its slot frees: the drained member must
      // not be granted, and the request keeps waiting on member 0.
      await db.poolMember.update({
        where: { id: fixture.members[1]!.poolMemberId },
        data: { routingStatus: "DRAINING" },
      });
      if (blockers[1]!.state === "ADMITTED") await store.release(blockers[1]!.lease);
      await expect(poll(store, request)).resolves.toMatchObject({ state: "WAITING" });
      const drained = await db.capacityWaiter.findFirstOrThrow({
        where: { attemptId: request.attemptId, candidateOrder: 1 },
      });
      expect(drained).toMatchObject({
        state: "CANCELLED",
        terminalReason: MEMBER_UNROUTABLE_REASON,
      });
      expect(
        await db.capacityLease.count({ where: { attemptId: request.attemptId, state: "ACTIVE" } }),
      ).toBe(0);

      // Member 0 is disabled while its capacity is still FULL: the request
      // does not hang until its deadline; it expires on the next poll.
      await db.poolMember.update({
        where: { id: fixture.members[0]!.poolMemberId },
        data: { routingStatus: "DISABLED" },
      });
      await expect(poll(store, request)).resolves.toEqual({ state: "EXPIRED" });
      const terminal = await db.admissionRequest.findUniqueOrThrow({
        where: { attemptId: request.attemptId },
      });
      expect(terminal).toMatchObject({
        state: "EXPIRED",
        terminalReason: MEMBER_UNROUTABLE_REASON,
      });

      // A member in an UNHEALTHY cooldown is likewise not granted.
      await db.poolMember.update({
        where: { id: fixture.members[0]!.poolMemberId },
        data: {
          routingStatus: "ACTIVE",
          healthStatus: "UNHEALTHY",
          nextRetryAt: new Date(Date.now() + 60_000),
        },
      });
      if (blockers[0]!.state === "ADMITTED") await store.release(blockers[0]!.lease);
      await expect(store.acquire(fixture.attempt("cooldown", [{ member: 0 }]))).resolves.toEqual({
        state: "EXPIRED",
      });
    } finally {
      await cleanupCapacityFixture(db, fixture.user.id);
      await db.$disconnect();
    }
  });
});

/**
 * Saturation S-C: a grantee's `PoolGrant.queuePriority` replaces the
 * pool/member capacity priority of that grantee's waiters (the DRR scheduler
 * itself is unchanged). Null inherits; a grant of another pool is ignored.
 */
integration("PostgreSQL per-grant queue priority", () => {
  it("feeds the grant priority into the waiters and changes their DRR share", async () => {
    if (!databaseUrl) return;
    // The store module imports the default client, which validates DATABASE_URL.
    process.env.DATABASE_URL ??= databaseUrl;
    const db = createFixturePrismaClient(databaseUrl);
    const { PostgresCapacityAdmissionStore } = await import("./postgres-store.js");
    const store = new PostgresCapacityAdmissionStore(db, "grant-priority-proof");
    const suffix = crypto.randomUUID();
    const user = (label: string) =>
      db.user.create({
        data: {
          name: `Grant priority ${label}`,
          email: `grant-priority-${label}-${suffix}@example.test`,
          slug: `grant-priority-${label}-${suffix}`,
        },
      });
    const owner = await user("owner");
    const low = await user("low");
    const high = await user("high");
    const inherit = await user("inherit");
    try {
      const device = await db.cliDevice.create({
        data: { userId: owner.id, slug: `device-${suffix}` },
      });
      const endpoint = await db.endpoint.create({
        data: { userId: owner.id, cliDeviceId: device.id, slug: `endpoint-${suffix}`, label: "G" },
      });
      const pool = await db.modelPool.create({
        data: {
          userId: owner.id,
          slug: `pool-${suffix}`,
          name: "Grant pool",
          capacityPriority: 16,
        },
      });
      const otherPool = await db.modelPool.create({
        data: { userId: owner.id, slug: `other-${suffix}`, name: "Other pool" },
      });
      const capacity = await db.inferenceCapacity.create({
        data: {
          userId: owner.id,
          label: `grant-${suffix}`,
          runtimeIdentityKey: `grant-${suffix}`,
          runtimeModel: "grant-proof",
          hardConcurrencyLimit: 1,
        },
      });
      const model = await db.discoveredModel.create({
        data: {
          userId: owner.id,
          endpointId: endpoint.id,
          upstreamModelId: "grant",
          encodedModelId: `grant-${suffix}`,
        },
      });
      const target = await db.executionTarget.update({
        where: { discoveredModelId: model.id },
        data: { inferenceCapacityId: capacity.id },
      });
      const member = await db.poolMember.create({
        data: { poolId: pool.id, executionTargetId: target.id },
      });
      const grant = (granteeUserId: string, queuePriority: number | null, poolId = pool.id) =>
        db.poolGrant.create({
          data: { poolId, ownerUserId: owner.id, granteeUserId, queuePriority },
        });
      const lowGrant = await grant(low.id, 0);
      const highGrant = await grant(high.id, 31);
      const inheritGrant = await grant(inherit.id, null);
      // A grant of ANOTHER pool never applies (the store matches the pool).
      const foreignGrant = await grant(low.id, 31, otherPool.id);
      const attempt = (name: string, accessGrantId: string | null) => ({
        requestId: `${name}-${suffix}`,
        attemptId: `${name}-${suffix}`,
        ownerId: owner.id,
        sourceKind: "POOL" as const,
        poolId: pool.id,
        basePriority: 16,
        accessGrantId,
        // Only recorded on the request (S-C lease-to-session link), deduplicated.
        ...(name === "high-1" ? { warmSessionIds: ["session-1", "session-1", "session-2"] } : {}),
        connectionOwner: "grant-priority-proof",
        deadlineAt: new Date(Date.now() + 10 * 60_000),
        candidates: [
          {
            capacityId: capacity.id,
            executionTargetId: target.id,
            poolMemberId: member.id,
            candidateOrder: 0,
          },
        ],
      });
      const blocker = await store.acquire(attempt("blocker", null));
      if (blocker.state !== "ADMITTED") throw new Error("Expected blocker admission.");
      // FIFO alone would serve every low-grant request first: they queue first.
      const waiting = [
        attempt("low-1", lowGrant.id),
        attempt("low-2", lowGrant.id),
        attempt("low-3", lowGrant.id),
        attempt("high-1", highGrant.id),
        attempt("high-2", highGrant.id),
        attempt("high-3", highGrant.id),
      ];
      for (const request of waiting)
        await expect(store.acquire(request)).resolves.toMatchObject({ state: "WAITING" });
      const waiterPriority = async (name: string) =>
        (
          await db.capacityWaiter.findFirstOrThrow({
            where: { attemptId: `${name}-${suffix}` },
          })
        ).effectivePriority;
      expect(await waiterPriority("low-1")).toBe(0);
      expect(await waiterPriority("high-1")).toBe(31);
      expect(
        (await db.admissionRequest.findFirstOrThrow({ where: { attemptId: `high-1-${suffix}` } }))
          .basePriority,
      ).toBe(31);
      const warmIds = async (name: string) =>
        (await db.admissionRequest.findFirstOrThrow({ where: { attemptId: `${name}-${suffix}` } }))
          .warmSessionIds;
      expect((await warmIds("high-1")).sort()).toEqual(["session-1", "session-2"]);
      expect(await warmIds("low-1")).toEqual([]);

      // Inherit (null) and a foreign-pool grant both keep the pool priority.
      for (const [name, grantId] of [
        ["inherit", inheritGrant.id],
        ["foreign", foreignGrant.id],
      ] as const) {
        await expect(store.acquire(attempt(name, grantId))).resolves.toMatchObject({
          state: "WAITING",
        });
        expect(await waiterPriority(name)).toBe(16);
        await store.terminalizeAttempt(`${name}-${suffix}`, "CANCELLED");
      }

      // Drain the slot one grant at a time and record who is served.
      const served: string[] = [];
      let lease = blocker.lease;
      for (let step = 0; step < waiting.length; step++) {
        await store.release(lease);
        let next: typeof lease | undefined;
        for (const request of waiting) {
          if (served.includes(request.attemptId)) continue;
          const polled = await store.acquire({ ...request, candidates: [] });
          if (polled.state === "ADMITTED") {
            served.push(request.attemptId);
            next = polled.lease;
            break;
          }
        }
        if (!next) throw new Error("A queued grant must be served after each release.");
        lease = next;
      }
      await store.release(lease);
      const order = served.map((attemptId) => attemptId.replace(`-${suffix}`, ""));
      // DRR over 32 classes (quantum 1 + priority): class 0 is visited once,
      // then class 31 drains before the low grantee's later requests, even
      // though they were enqueued first.
      expect(order.slice(0, 4).filter((name) => name.startsWith("high"))).toHaveLength(3);
      expect(order.indexOf("high-3")).toBeLessThan(order.indexOf("low-2"));
    } finally {
      await cleanupCapacityFixture(db, owner.id);
      await db.$disconnect();
    }
  }, 30_000);
});
