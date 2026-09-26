import { createRouterClient } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Context } from "../context";

// DL-1 lock-order regressions for API writers on real PostgreSQL. Each case
// runs a production procedure against a concurrent capacity-lock holder that
// follows the documented order (L1 -> L2 -> L3 -> L4 -> L5 -> L6). The test
// side sets a short deadlock_timeout, so a lock-order inversion is detected
// on the test side first and aborts it instead of being absorbed by the
// procedure's own retry loop.

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("SCHEMA_VALIDATION_DATABASE_URL is required for PostgreSQL integration tests");
const integration = databaseUrl ? describe : describe.skip;

type Client = ReturnType<typeof import("@ws-model-proxy/db/client-factory").createPrismaClient>;

function sessionFor(user: {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  role?: string | null;
}): Context {
  return {
    session: {
      user,
      session: {
        id: `session-${user.id}`,
        userId: user.id,
        token: `token-${user.id}`,
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date(),
        updatedAt: new Date(),
        ipAddress: "127.0.0.1",
        userAgent: "capacity-lock-order-test",
      },
    } as Session,
  };
}

async function backendPid(tx: Pick<Client, "$queryRaw">): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
  const pid = rows[0]?.pid;
  if (pid === undefined) throw new Error("Backend pid unavailable.");
  return pid;
}

async function waitUntilBlockedBy(inspector: Client, pid: number): Promise<void> {
  for (let poll = 0; poll < 1_000; poll++) {
    const rows = await inspector.$queryRaw<Array<{ blocked: bigint }>>`
      SELECT count(*) AS blocked FROM pg_stat_activity
       WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`;
    if (Number(rows[0]?.blocked ?? 0) >= 1) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`No backend queued behind ${pid}.`);
}

function isDeadlockOrSerialization(error: unknown): boolean {
  const text = String(error instanceof Error ? `${error.message} ${String(error.cause)}` : error);
  return /40P01|40001|P2034|deadlock|could not serialize|write conflict/i.test(text);
}

integration("DL-1 capacity lock order for API writers", () => {
  let modules:
    | {
        prisma: typeof import("@ws-model-proxy/db").default;
        createPrismaClient: typeof import("@ws-model-proxy/db/client-factory").createPrismaClient;
        policy: typeof import("./capacity-policy-safety");
        forwarder: typeof import("../routers/forwarder-management");
        users: typeof import("../routers/users");
      }
    | undefined;

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    process.env.NODE_ENV = "test";
    const [db, factory, policy, forwarder, users] = await Promise.all([
      import("@ws-model-proxy/db"),
      import("@ws-model-proxy/db/client-factory"),
      import("./capacity-policy-safety"),
      import("../routers/forwarder-management"),
      import("../routers/users"),
    ]);
    modules = {
      prisma: db.default,
      createPrismaClient: factory.createPrismaClient,
      policy,
      forwarder,
      users,
    };
  });

  afterAll(async () => {
    // Lease rows keep RESTRICT history; unique fixture identities isolate runs.
  });

  async function capacityFixture(suffix: string, ownerEmail: string) {
    if (!modules) throw new Error("modules unavailable");
    const db = modules.prisma;
    const user = await db.user.create({
      data: {
        name: "Lock order owner",
        email: ownerEmail,
        slug: `dl1-api-${suffix}`,
        emailVerified: true,
      },
    });
    const capacity = await db.inferenceCapacity.create({
      data: {
        userId: user.id,
        label: `dl1-api-${suffix}`,
        runtimeIdentityKey: `dl1-api-${suffix}`,
        runtimeModel: "dl1-api",
        hardConcurrencyLimit: 1,
      },
    });
    const account = await db.providerAccount.create({
      data: {
        userId: user.id,
        providerType: "proof",
        label: `dl1-api-${suffix}`,
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
    const pools = [];
    for (const label of ["holder", "victim"]) {
      const pool = await db.modelPool.create({
        data: {
          userId: user.id,
          slug: `dl1-api-${label}-${suffix}`,
          name: label,
          capacityConcurrencyLimit: null,
          publicEgressAcknowledged: true,
        },
      });
      // Provider targets are external fallback members (PRIMARY is local-only).
      const member = await db.poolMember.create({
        data: {
          poolId: pool.id,
          executionTargetId: target.id,
          tier: "PUBLIC_OVERFLOW",
          publicOrder: 0,
          capacityConcurrencyMode: "INHERIT",
        },
      });
      pools.push({ pool, member });
    }
    // The holder pool owns the only slot, so the victim pool's request waits
    // without the victim pool ever gaining lease history.
    const [holder, victim] = pools as [(typeof pools)[number], (typeof pools)[number]];
    const insertWaiting = async (name: string, poolId: string, memberId: string) => {
      const request = await db.admissionRequest.create({
        data: {
          userId: user.id,
          requestId: `${name}-${suffix}`,
          attemptId: `${name}-${suffix}`,
          sourceKind: "POOL",
          poolId,
          basePriority: 16,
          enqueueSequence: BigInt(Date.now()),
          deadlineAt: new Date(Date.now() + 60_000),
          connectionOwner: name,
          heartbeatAt: new Date(),
          Waiters: {
            create: {
              userId: user.id,
              requestId: `${name}-${suffix}`,
              attemptId: `${name}-${suffix}`,
              enqueueSequence: BigInt(Date.now()),
              capacityId: capacity.id,
              executionTargetId: target.id,
              poolId,
              poolMemberId: memberId,
              candidateOrder: 0,
              deadlineAt: new Date(Date.now() + 60_000),
              effectivePriority: 16,
              effectiveConcurrencyLimit: null,
              effectiveConcurrencyScope: "POOL",
              effectiveConcurrencyScopeId: poolId,
              effectiveReservedSlots: 0,
              effectiveBorrowPolicy: "WHEN_IDLE",
            },
          },
        },
      });
      return request;
    };
    await insertWaiting("holder", holder.pool.id, holder.member.id);
    const waiting = await insertWaiting("victim", victim.pool.id, victim.member.id);
    return { user, capacity, target, holder, victim, waiting };
  }

  /**
   * The admitter side: capacity advisory lock (L4), capacity row (L5), the
   * winning admission_request row (L6), then a capacity_lease insert whose FK
   * checks take FOR KEY SHARE on the user, pool, member and target rows.
   */
  function startAdmitter(
    admitter: Client,
    fixture: Awaited<ReturnType<typeof capacityFixture>>,
    suffix: string,
  ) {
    let ready!: (pid: number) => void;
    const pid = new Promise<number>((resolve) => {
      ready = resolve;
    });
    let release!: () => void;
    const mayInsert = new Promise<void>((resolve) => {
      release = resolve;
    });
    const done = admitter.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL deadlock_timeout = '50ms'`;
        const own = await backendPid(tx);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${fixture.capacity.id}, 0))`;
        await tx.$queryRaw`SELECT id FROM inference_capacity WHERE id = ${fixture.capacity.id} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM admission_request WHERE id = ${fixture.waiting.id} FOR UPDATE`;
        ready(own);
        await mayInsert;
        await tx.capacityLease.create({
          data: {
            userId: fixture.user.id,
            requestId: fixture.waiting.requestId,
            attemptId: fixture.waiting.attemptId,
            admissionRequestId: fixture.waiting.id,
            capacityId: fixture.capacity.id,
            executionTargetId: fixture.target.id,
            poolId: fixture.victim.pool.id,
            poolMemberId: fixture.victim.member.id,
            priority: 16,
            reservationClass: 16,
            fencingToken: 1_000_000n,
            ownerServerInstance: `dl1-api-${suffix}`,
            heartbeatAt: new Date(),
            expiresAt: new Date(Date.now() + 30_000),
          },
        });
        await tx.admissionRequest.update({
          where: { id: fixture.waiting.id },
          data: { state: "ADMITTED" },
        });
      },
      { timeout: 20_000 },
    );
    return { pid, release, done };
  }

  it("deletes a model pool while an admitter inserts that pool's lease (no 40P01)", async () => {
    // Parent delete. DELETE model_pool holds the pool tuple exclusively while
    // its cascade waits on the admission_request row the admitter holds; the
    // admitter's lease insert then needs FOR KEY SHARE on that pool. The
    // delete must first take the capacity locks in L-order.
    if (!modules) throw new Error("modules unavailable");
    const suffix = crypto.randomUUID();
    const fixture = await capacityFixture(suffix, `dl1-pool-delete-${suffix}@example.test`);
    const admitter = modules.createPrismaClient(databaseUrl as string);
    const inspector = modules.createPrismaClient(databaseUrl as string);
    const side = startAdmitter(admitter, fixture, suffix);
    try {
      const pid = await side.pid;
      const client = createRouterClient(modules.forwarder.forwarderManagementRouter, {
        context: sessionFor(fixture.user),
      });
      const deletion = client.deleteModelPool({ id: fixture.victim.pool.id });
      await waitUntilBlockedBy(inspector, pid);
      side.release();
      const [admitted, deleted] = await Promise.allSettled([side.done, deletion]);
      expect(admitted.status === "fulfilled" ? "committed" : String(admitted.reason)).toBe(
        "committed",
      );
      // The admitted lease is retained history (RESTRICT), so the delete
      // either removes the pool or refuses it cleanly; it never deadlocks.
      if (deleted.status === "rejected")
        expect(isDeadlockOrSerialization(deleted.reason)).toBe(false);
    } finally {
      side.release();
      await Promise.allSettled([side.done]);
      await Promise.all([admitter.$disconnect(), inspector.$disconnect()]);
    }
  }, 60_000);

  it("deletes a user while an admitter inserts that user's lease (no 40P01)", async () => {
    // Parent delete through the user cascade (pool, member, target, capacity,
    // requests): the admitter's lease insert needs FOR KEY SHARE on the user
    // row and every capacity parent.
    if (!modules) throw new Error("modules unavailable");
    const suffix = crypto.randomUUID();
    const fixture = await capacityFixture(suffix, `dl1-user-delete-${suffix}@example.test`);
    const admin = await modules.prisma.user.create({
      data: {
        name: "Lock order admin",
        email: `dl1-admin-${suffix}@example.test`,
        role: "admin",
        emailVerified: true,
      },
    });
    const admitter = modules.createPrismaClient(databaseUrl as string);
    const inspector = modules.createPrismaClient(databaseUrl as string);
    const side = startAdmitter(admitter, fixture, suffix);
    try {
      const pid = await side.pid;
      const client = createRouterClient(modules.users.usersRouter, {
        context: sessionFor(admin),
      });
      const deletion = client.remove({ userId: fixture.user.id });
      await waitUntilBlockedBy(inspector, pid);
      side.release();
      const [admitted, deleted] = await Promise.allSettled([side.done, deletion]);
      expect(admitted.status === "fulfilled" ? "committed" : String(admitted.reason)).toBe(
        "committed",
      );
      if (deleted.status === "rejected")
        expect(isDeadlockOrSerialization(deleted.reason)).toBe(false);
    } finally {
      side.release();
      await Promise.allSettled([side.done]);
      await Promise.all([admitter.$disconnect(), inspector.$disconnect()]);
    }
  }, 60_000);

  it("attaches a discovered model whose target has no capacity while a policy writer holds it (no 40P01)", async () => {
    // L5-before-L2. addPoolMember adopts an existing auto capacity with a
    // null AUTO limit. The concurrent writer follows L2 -> L5: it holds the
    // target's policy lock and then locks that capacity row. addPoolMember
    // must take the target's L2 lock before it writes the capacity row.
    if (!modules) throw new Error("modules unavailable");
    const db = modules.prisma;
    const suffix = crypto.randomUUID();
    const user = await db.user.create({
      data: {
        name: "Null fill order",
        email: `dl1-fill-${suffix}@example.test`,
        slug: `dl1-fill-${suffix}`,
      },
    });
    const device = await db.cliDevice.create({ data: { userId: user.id, slug: `cli-${suffix}` } });
    const endpoint = await db.endpoint.create({
      data: {
        userId: user.id,
        cliDeviceId: device.id,
        slug: `endpoint-${suffix}`,
        label: "Endpoint",
        capabilityMetadata: {
          version: 1,
          protocol: "openai-compatible",
          chatCompletions: { supported: true, streaming: true },
        },
      },
    });
    const model = await db.discoveredModel.create({
      data: {
        userId: user.id,
        endpointId: endpoint.id,
        upstreamModelId: "dl1-fill",
        encodedModelId: `dl1-fill-${suffix}`,
      },
    });
    // Schema hardening attaches an auto capacity (null AUTO limit) to every
    // new discovered target. Detach it to reach the adopt-and-fill path.
    const created = await db.executionTarget.findUniqueOrThrow({
      where: { discoveredModelId: model.id },
    });
    const capacityId = created.inferenceCapacityId;
    if (!capacityId) throw new Error("Expected the hardening-created auto capacity.");
    const target = await db.executionTarget.update({
      where: { id: created.id },
      data: { inferenceCapacityId: null },
    });
    const capacity = await db.inferenceCapacity.update({
      where: { id: capacityId },
      data: { hardConcurrencyLimit: null, hardConcurrencyLimitSource: "AUTO" },
    });
    const pool = await db.modelPool.create({
      data: {
        userId: user.id,
        slug: `dl1-fill-${suffix}`,
        name: "Null fill",
        publicEgressAcknowledged: true,
      },
    });
    const writer = modules.createPrismaClient(databaseUrl as string);
    const inspector = modules.createPrismaClient(databaseUrl as string);
    const policy = modules.policy;
    let ready!: (pid: number) => void;
    const writerPid = new Promise<number>((resolve) => {
      ready = resolve;
    });
    let release!: () => void;
    const mayLockCapacity = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writerSide = writer.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL deadlock_timeout = '50ms'`;
        const own = await backendPid(tx);
        await policy.lockExecutionTargetPolicies(tx, [target.id]);
        ready(own);
        await mayLockCapacity;
        await tx.$queryRaw`SELECT id FROM inference_capacity WHERE id = ${capacity.id} FOR UPDATE`;
      },
      { timeout: 20_000 },
    );
    try {
      const pid = await writerPid;
      const client = createRouterClient(modules.forwarder.forwarderManagementRouter, {
        context: sessionFor({ ...user, emailVerified: true }),
      });
      const attach = client.addPoolMember({ poolId: pool.id, discoveredModelId: model.id });
      await waitUntilBlockedBy(inspector, pid);
      release();
      const [written, attached] = await Promise.allSettled([writerSide, attach]);
      expect(written.status === "fulfilled" ? "committed" : String(written.reason)).toBe(
        "committed",
      );
      expect(attached.status === "fulfilled" ? "committed" : String(attached.reason)).toBe(
        "committed",
      );
      expect(
        await db.executionTarget.findUniqueOrThrow({ where: { id: target.id } }),
      ).toMatchObject({ inferenceCapacityId: capacity.id });
      expect(
        await db.inferenceCapacity.findUniqueOrThrow({ where: { id: capacity.id } }),
      ).toMatchObject({ hardConcurrencyLimit: 1, hardConcurrencyLimitSource: "AUTO" });
    } finally {
      release();
      await Promise.allSettled([writerSide]);
      await Promise.all([writer.$disconnect(), inspector.$disconnect()]);
    }
  }, 60_000);
});
