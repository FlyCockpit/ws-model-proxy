import { appendFileSync } from "node:fs";
import { createRouterClient } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Context } from "../context";

// DL1-TXBOUND on real PostgreSQL: every ordered parent delete must succeed
// with a large request history, hold the capacity locks only for the graph,
// refuse retained history before changing anything, and (for users) never
// strand a user whose sessions and accounts are gone.
//
// History size per path is WMP_PARENT_DELETE_ROWS (default 20 000, the CI
// size). `pnpm --filter @ws-model-proxy/api test:postgres:volume` runs the same
// file at 1 400 000 rows, the size at which pass 6a's single 15 s transaction
// failed while HEAD's autocommit delete took 17.9 s. Measured phase times go
// to stdout and, when WMP_PARENT_DELETE_REPORT names a file, to that file.

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("SCHEMA_VALIDATION_DATABASE_URL is required for PostgreSQL integration tests");
const integration = databaseUrl ? describe : describe.skip;

const ROWS = Math.max(1, Number(process.env.WMP_PARENT_DELETE_ROWS ?? 20_000));
/** Terminal admission history and small history tables per fixture. */
const ADMISSIONS = Math.min(ROWS, 5_000);
const SMALL = 50;
// Inserting 1.4M rows takes ~45 s and a drain about as long; leave headroom.
const TIMEOUT = Math.max(120_000, Math.ceil(ROWS / 1_000) * 1_000);

function report(line: string) {
  const text = `[parent-deletion rows=${ROWS}] ${line}`;
  process.stdout.write(`${text}\n`);
  const file = process.env.WMP_PARENT_DELETE_REPORT;
  if (file) appendFileSync(file, `${text}\n`);
}

type Db = typeof import("@ws-model-proxy/db").default;

function sessionFor(user: { id: string; email: string; name: string }): Context {
  return {
    session: {
      user: { ...user, emailVerified: true, role: "admin" },
      session: {
        id: `session-${user.id}`,
        userId: user.id,
        token: `token-${user.id}`,
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date(),
        updatedAt: new Date(),
        ipAddress: "127.0.0.1",
        userAgent: "parent-deletion-test",
      },
    } as Session,
  } as Context;
}

integration("DL1-TXBOUND parent deletes with large request history", () => {
  let modules:
    | {
        prisma: Db;
        deletion: typeof import("@ws-model-proxy/db/parent-deletion");
        order: typeof import("@ws-model-proxy/db/capacity-lock-order");
        forwarder: typeof import("../routers/forwarder-management");
        capacity: typeof import("../routers/capacity-management");
        users: typeof import("../routers/users");
        auth: typeof import("@ws-model-proxy/auth");
        listeners: typeof import("@ws-model-proxy/auth/user-deletion-listeners");
      }
    | undefined;

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    process.env.NODE_ENV = "test";
    const [db, deletion, order, forwarder, capacity, users, auth, listeners] = await Promise.all([
      import("@ws-model-proxy/db"),
      import("@ws-model-proxy/db/parent-deletion"),
      import("@ws-model-proxy/db/capacity-lock-order"),
      import("../routers/forwarder-management"),
      import("../routers/capacity-management"),
      import("../routers/users"),
      import("@ws-model-proxy/auth"),
      import("@ws-model-proxy/auth/user-deletion-listeners"),
    ]);
    modules = {
      prisma: db.default,
      deletion,
      order,
      forwarder,
      capacity,
      users,
      auth,
      listeners,
    };
  });

  afterAll(async () => {
    // Fixtures use unique identities in a disposable database.
  });

  function required() {
    if (!modules) throw new Error("modules unavailable");
    return modules;
  }

  /** A user with a device, endpoint, model (-> target, capacity) and a pool. */
  async function graph(tag: string) {
    const db = required().prisma;
    const suffix = `${tag}-${crypto.randomUUID()}`;
    const user = await db.user.create({
      data: {
        name: tag,
        email: `${suffix}@example.test`,
        slug: `pd-${suffix}`,
        emailVerified: true,
      },
    });
    const device = await db.cliDevice.create({ data: { userId: user.id, slug: "device" } });
    const endpoint = await db.endpoint.create({
      data: { userId: user.id, cliDeviceId: device.id, slug: "endpoint", label: "endpoint" },
    });
    const model = await db.discoveredModel.create({
      data: { userId: user.id, endpointId: endpoint.id, upstreamModelId: "m", encodedModelId: "m" },
    });
    const target = await db.executionTarget.findUniqueOrThrow({
      where: { discoveredModelId: model.id },
    });
    const capacityId = target.inferenceCapacityId;
    if (!capacityId) throw new Error("target without capacity");
    const pool = await db.modelPool.create({
      data: { userId: user.id, slug: `pool-${suffix}`.slice(0, 60), name: "pool" },
    });
    const member = await db.poolMember.create({
      data: {
        poolId: pool.id,
        discoveredModelId: model.id,
        executionTargetId: target.id,
        tier: "PRIMARY",
        capacityConcurrencyMode: "INHERIT",
      },
    });
    return { suffix, user, device, endpoint, model, target, capacityId, pool, member };
  }

  type Graph = Awaited<ReturnType<typeof graph>>;
  type RelayShape = "own" | "pool" | "direct-model" | "member";

  /** `count` terminal relay rows in one of the shapes the routes write. */
  async function relayHistory(g: Graph, shape: RelayShape, count = ROWS) {
    const db = required().prisma;
    const columns: Record<RelayShape, [string, string]> = {
      own: ["", ""],
      pool: [`, "requestedModelPoolId"`, `, '${g.pool.id}'`],
      "direct-model": [
        `, "requestedDiscoveredModelId", "requestedExecutionTargetId", "selectedDiscoveredModelId", "selectedExecutionTargetId"`,
        `, '${g.model.id}', '${g.target.id}', '${g.model.id}', '${g.target.id}'`,
      ],
      member: [
        `, "requestedModelPoolId", "selectedPoolMemberId", "selectedDiscoveredModelId", "selectedExecutionTargetId"`,
        `, '${g.pool.id}', '${g.member.id}', '${g.model.id}', '${g.target.id}'`,
      ],
    };
    const [names, values] = columns[shape];
    const started = Date.now();
    await db.$executeRawUnsafe(
      `INSERT INTO relay_request (id, "userId", status${names})
       SELECT '${g.suffix}-rr-' || n, '${g.user.id}', 'SUCCEEDED'${values}
         FROM generate_series(1, ${count}) n`,
    );
    report(`fixture ${shape}: ${count} relay rows in ${Date.now() - started} ms`);
  }

  /** Terminal (cancelled) pool admissions with a waiter each, plus small history. */
  async function otherHistory(g: Graph) {
    const db = required().prisma;
    await db.$executeRawUnsafe(
      `INSERT INTO admission_request (id, "userId", "requestId", "attemptId", "sourceKind", "poolId",
         "basePriority", "enqueueSequence", "connectionOwner", "heartbeatAt", state, "terminalAt")
       SELECT '${g.suffix}-ar-' || n, '${g.user.id}', '${g.suffix}-r-' || n, '${g.suffix}-a-' || n,
              'POOL', '${g.pool.id}', 16, n, 'fixture', now(), 'CANCELLED', now()
         FROM generate_series(1, ${ADMISSIONS}) n`,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO capacity_waiter (id, "userId", "admissionRequestId", "requestId", "attemptId",
         "enqueueSequence", "capacityId", "executionTargetId", "poolId", "poolMemberId",
         "candidateOrder", "effectivePriority", "effectiveConcurrencyScope",
         "effectiveConcurrencyScopeId", "effectiveReservedSlots", "effectiveBorrowPolicy", state)
       SELECT '${g.suffix}-w-' || n, '${g.user.id}', '${g.suffix}-ar-' || n, '${g.suffix}-r-' || n,
              '${g.suffix}-a-' || n, n, '${g.capacityId}', '${g.target.id}', '${g.pool.id}',
              '${g.member.id}', 0, 16, 'POOL', '${g.pool.id}', 0, 'WHEN_IDLE', 'CANCELLED'
         FROM generate_series(1, ${ADMISSIONS}) n`,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO response_stickiness_record (id, "userId", "routingKeyDigest")
       SELECT '${g.suffix}-s-' || n, '${g.user.id}', '${g.suffix}-d-' || n
         FROM generate_series(1, ${SMALL}) n`,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO usage_rollup_minute ("bucketStart", "ownerUserId", "requesterUserId", source)
       SELECT timestamp '2026-01-01' + n * interval '1 minute', '${g.user.id}', '${g.user.id}', 'API_TOKEN'
         FROM generate_series(1, ${SMALL}) n`,
    );
  }

  /** A released capacity lease on the graph: RESTRICT-protected history. */
  async function leaseHistory(g: Graph) {
    const db = required().prisma;
    const request = await db.admissionRequest.create({
      data: {
        userId: g.user.id,
        requestId: `${g.suffix}-lease`,
        attemptId: `${g.suffix}-lease`,
        sourceKind: "DIRECT",
        directExecutionTargetId: g.target.id,
        basePriority: 16,
        enqueueSequence: 1n,
        connectionOwner: "fixture",
        heartbeatAt: new Date(),
        state: "TERMINAL",
        terminalAt: new Date(),
      },
    });
    await db.capacityLease.create({
      data: {
        userId: g.user.id,
        requestId: request.requestId,
        attemptId: request.attemptId,
        admissionRequestId: request.id,
        capacityId: g.capacityId,
        executionTargetId: g.target.id,
        priority: 16,
        reservationClass: 16,
        fencingToken: 1n,
        ownerServerInstance: "fixture",
        heartbeatAt: new Date(),
        expiresAt: new Date(Date.now() + 30_000),
        state: "RELEASED",
        releasedAt: new Date(),
      },
    });
  }

  async function count(sql: string): Promise<number> {
    const rows = await required().prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*) AS n FROM ${sql}`,
    );
    return Number(rows[0]?.n ?? 0);
  }

  async function timed<T>(label: string, work: () => Promise<T>): Promise<T> {
    const started = Date.now();
    const value = await work();
    report(`${label}: ${Date.now() - started} ms`);
    return value;
  }

  it(
    "users.remove deletes a user with a large history; the capacity-locked phase stays short",
    async () => {
      const { prisma, users } = required();
      const g = await graph("user");
      await relayHistory(g, "own");
      await otherHistory(g);
      const admin = await graph("admin");
      const client = createRouterClient(users.usersRouter, { context: sessionFor(admin.user) });
      await expect(
        timed("users.remove total", () => client.remove({ userId: g.user.id })),
      ).resolves.toEqual({ success: true, pending: false });
      expect(await prisma.user.findUnique({ where: { id: g.user.id } })).toBeNull();
      expect(await count(`relay_request WHERE "userId" = '${g.user.id}'`)).toBe(0);
      expect(await count(`admission_request WHERE "userId" = '${g.user.id}'`)).toBe(0);
      expect(await count(`usage_rollup_minute WHERE "ownerUserId" = '${g.user.id}'`)).toBe(0);
    },
    TIMEOUT,
  );

  it(
    "drains first, then holds the ordered delete's locks only briefly (phase timing)",
    async () => {
      const { prisma, deletion, order } = required();
      const g = await graph("phases");
      await relayHistory(g, "own");
      await otherHistory(g);
      const mark = await deletion.requestUserDeletion(prisma, g.user.id);
      expect(mark?.created).toBe(true);
      const parents = await deletion.resolveDeletedParents(prisma, {
        userId: g.user.id,
        wholeUser: true,
      });
      const drained = await timed("user drain (no capacity locks)", () =>
        deletion.drainParentDeletionHistory(prisma, parents),
      );
      expect(drained["relay_request.delete"]).toBe(ROWS);
      expect(drained["admission_request.delete"]).toBe(ADMISSIONS);
      const locked = Date.now();
      await expect(
        order.deleteUserInCapacityLockOrder(prisma, g.user.id, mark!.generation),
      ).resolves.toBe(true);
      const heldMs = Date.now() - locked;
      report(`user ordered delete (capacity locks held at most): ${heldMs} ms`);
      expect(heldMs).toBeLessThan(5_000);
    },
    TIMEOUT,
  );

  it(
    "Better Auth admin remove-user through the real endpoint: success, then notification",
    async () => {
      const { prisma, auth, listeners } = required();
      const admin = await graph("ba-admin");
      await prisma.user.update({ where: { id: admin.user.id }, data: { role: "admin" } });
      const password = "DisposableParentDeletePassword01!";
      const context = await auth.auth.$context;
      await prisma.account.create({
        data: {
          userId: admin.user.id,
          accountId: admin.user.id,
          providerId: "credential",
          password: await context.password.hash(password),
        },
      });
      const victim = await graph("ba-victim");
      await relayHistory(victim, "own");
      await otherHistory(victim);
      await prisma.session.create({
        data: {
          userId: victim.user.id,
          token: `victim-${victim.suffix}`,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      const login = await auth.auth.api.signInEmail({
        body: { email: admin.user.email, password },
        asResponse: true,
      });
      expect(login.status).toBe(200);
      const cookie = login.headers
        .getSetCookie()
        .map((line) => line.split(";")[0])
        .join("; ");
      let notified = "";
      let goneAtNotification = false;
      const unsubscribe = listeners.onUserDeleted(async (id) => {
        notified = id;
        goneAtNotification = (await prisma.user.findUnique({ where: { id } })) === null;
      });
      try {
        const response = await timed("Better Auth remove-user total", () =>
          auth.auth.api.removeUser({
            body: { userId: victim.user.id },
            headers: new Headers({ cookie }),
            asResponse: true,
          }),
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ success: true });
        expect(await prisma.user.findUnique({ where: { id: victim.user.id } })).toBeNull();
        expect(await count(`relay_request WHERE "userId" = '${victim.user.id}'`)).toBe(0);
        expect(notified).toBe(victim.user.id);
        expect(goneAtNotification).toBe(true);
      } finally {
        unsubscribe();
      }

      // Retained history: refused before Better Auth touches any session or
      // account, so the user is not stranded.
      const retained = await graph("ba-retained");
      await relayHistory(retained, "own", SMALL);
      await leaseHistory(retained);
      await prisma.session.create({
        data: {
          userId: retained.user.id,
          token: `retained-${retained.suffix}`,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      await prisma.account.create({
        data: {
          userId: retained.user.id,
          accountId: retained.user.id,
          providerId: "credential",
          password: "x",
        },
      });
      const refused = await auth.auth.api.removeUser({
        body: { userId: retained.user.id },
        headers: new Headers({ cookie }),
        asResponse: true,
      });
      expect(refused.status).toBe(409);
      expect(await prisma.session.count({ where: { userId: retained.user.id } })).toBe(1);
      expect(await prisma.account.count({ where: { userId: retained.user.id } })).toBe(1);
      expect(await count(`relay_request WHERE "userId" = '${retained.user.id}'`)).toBe(SMALL);
      const kept = await prisma.user.findUniqueOrThrow({ where: { id: retained.user.id } });
      expect(kept.deletionRequestedAt).toBeNull();
      expect(kept.banned).not.toBe(true);
    },
    TIMEOUT,
  );

  it("users.remove refuses retained history before draining or marking anything", async () => {
    const { prisma, users } = required();
    const g = await graph("retained");
    await relayHistory(g, "own", SMALL);
    await leaseHistory(g);
    const admin = await graph("admin2");
    const client = createRouterClient(users.usersRouter, { context: sessionFor(admin.user) });
    await expect(client.remove({ userId: g.user.id })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const kept = await prisma.user.findUniqueOrThrow({ where: { id: g.user.id } });
    expect(kept.deletionRequestedAt).toBeNull();
    expect(kept.banned).not.toBe(true);
    expect(await count(`relay_request WHERE "userId" = '${g.user.id}'`)).toBe(SMALL);
  });

  it(
    "a transient failure after the intent leaves a pending delete that completes later",
    async () => {
      const { prisma, deletion } = required();
      const g = await graph("pending");
      await relayHistory(g, "own", Math.min(ROWS, 20_000));
      await prisma.session.create({
        data: {
          userId: g.user.id,
          token: `pending-${g.suffix}`,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      // The ordered delete's transaction fails once, as a timeout would.
      let failed = false;
      const flaky = new Proxy(prisma, {
        get(target, property, receiver) {
          if (property !== "$transaction") return Reflect.get(target, property, receiver);
          return (work: unknown, options?: { isolationLevel?: string }) => {
            if (!failed && options?.isolationLevel === "ReadCommitted") {
              failed = true;
              return Promise.reject(Object.assign(new Error("expired"), { code: "P2028" }));
            }
            return Reflect.apply(target.$transaction, target, [work, options]);
          };
        },
      });
      await expect(deletion.deleteUserDurably(flaky, g.user.id)).resolves.toBe("pending");
      const marked = await prisma.user.findUniqueOrThrow({ where: { id: g.user.id } });
      expect(marked.deletionRequestedAt).not.toBeNull();
      expect(marked.banned).toBe(true);
      expect(await prisma.session.count({ where: { userId: g.user.id } })).toBe(0);
      const pending = await deletion.listPendingUserDeletions(prisma, { before: new Date() });
      const selected = pending.find((entry) => entry.userId === g.user.id);
      expect(selected?.generation).toBe(marked.deletionGeneration);
      // What the sweeper does on its next tick.
      await expect(
        deletion.completeUserDeletion(prisma, g.user.id, selected!.generation),
      ).resolves.toBe(true);
      expect(await prisma.user.findUnique({ where: { id: g.user.id } })).toBeNull();
    },
    TIMEOUT,
  );

  it("the drain never waits on a row another transaction holds", async () => {
    const { prisma, deletion } = required();
    const g = await graph("skip");
    await relayHistory(g, "own", 200);
    const holder = required().prisma;
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holding = holder.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe(
          `SELECT id FROM relay_request WHERE id = '${g.suffix}-rr-1' FOR UPDATE`,
        );
        locked();
        await released;
      },
      { timeout: 30_000 },
    );
    await isLocked;
    const parents = await deletion.resolveDeletedParents(prisma, {
      userId: g.user.id,
      wholeUser: true,
    });
    const drained = await deletion.drainParentDeletionHistory(prisma, parents, { batch: 50 });
    expect(drained["relay_request.delete"]).toBe(199);
    release();
    await holding;
    const mark = await deletion.requestUserDeletion(prisma, g.user.id);
    await expect(deletion.completeUserDeletion(prisma, g.user.id, mark!.generation)).resolves.toBe(
      true,
    );
  });

  it("drains requester usage rollups before the user row delete", async () => {
    const { prisma, deletion } = required();
    const owner = await graph("rollup-owner");
    const requester = await graph("rollup-requester");
    await prisma.usageRollupMinute.create({
      data: {
        bucketStart: new Date("2026-01-01T00:00:00.000Z"),
        ownerUserId: owner.user.id,
        requesterUserId: requester.user.id,
        poolId: "",
        poolMemberId: "",
        executionTargetId: "",
        source: "API_TOKEN",
        requests: 3,
      },
    });
    const mark = await deletion.requestUserDeletion(prisma, requester.user.id);
    await expect(
      deletion.completeUserDeletion(prisma, requester.user.id, mark!.generation),
    ).resolves.toBe(true);
    const sentinel = await prisma.usageRollupMinute.findFirst({
      where: {
        ownerUserId: owner.user.id,
        requesterUserId: "",
      },
    });
    expect(sentinel?.requests).toBe(3);
    expect(
      await count(`usage_rollup_minute WHERE "requesterUserId" = '${requester.user.id}'`),
    ).toBe(0);
  });

  it("does not delete a user after the deletion marker was cleared", async () => {
    const { prisma, deletion } = required();
    const g = await graph("abandon");
    const mark = await deletion.requestUserDeletion(prisma, g.user.id);
    await expect(deletion.abandonUserDeletion(prisma, g.user.id, mark!.generation)).resolves.toBe(
      true,
    );
    await expect(deletion.completeUserDeletion(prisma, g.user.id, mark!.generation)).resolves.toBe(
      false,
    );
    expect(await prisma.user.findUnique({ where: { id: g.user.id } })).not.toBeNull();
  });

  it("a stale abandon or backoff cannot touch a newer deletion generation (r2 P3)", async () => {
    const { prisma, deletion } = required();
    const g = await graph("generation");
    const first = await deletion.requestUserDeletion(prisma, g.user.id);
    // The first generation is abandoned and a new deletion is requested.
    await deletion.abandonUserDeletion(prisma, g.user.id, first!.generation);
    const second = await deletion.requestUserDeletion(prisma, g.user.id);
    expect(second?.created).toBe(true);
    expect(second?.generation).not.toBe(first?.generation);
    // A worker still holding the first generation acts on it.
    await expect(deletion.abandonUserDeletion(prisma, g.user.id, first!.generation)).resolves.toBe(
      false,
    );
    await deletion.recordUserDeletionSweepFailure(prisma, g.user.id, first!.generation, {
      now: new Date(),
      attempt: 1,
    });
    await expect(deletion.completeUserDeletion(prisma, g.user.id, first!.generation)).resolves.toBe(
      false,
    );
    const row = await prisma.user.findUniqueOrThrow({
      where: { id: g.user.id },
      select: {
        deletionRequestedAt: true,
        deletionGeneration: true,
        deletionSweepNextAttemptAt: true,
        deletionSweepAttempts: true,
      },
    });
    expect(row.deletionRequestedAt).not.toBeNull();
    expect(row.deletionGeneration).toBe(second?.generation);
    expect(row.deletionSweepNextAttemptAt).toBeNull();
    expect(row.deletionSweepAttempts).toBe(0);
    // The owner of the current generation completes it.
    await expect(
      deletion.completeUserDeletion(prisma, g.user.id, second!.generation),
    ).resolves.toBe(true);
  });

  it("an admission insert holding a target lock does not deadlock with a user delete (r2 P5)", async () => {
    const { prisma, deletion, order } = required();
    const g = await graph("delete-order");
    const mark = await deletion.requestUserDeletion(prisma, g.user.id);
    const deadlocks = async () =>
      Number(
        (
          await prisma.$queryRaw<[{ deadlocks: bigint }]>`
            SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`
        )[0].deadlocks,
      );
    const before = await deadlocks();
    let deleting: Promise<boolean> | undefined;
    const rolledBack = new Error("rollback");
    const holder = required()
      .prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe("SET LOCAL deadlock_timeout = '150ms'");
          // What admission holds (target, L2) before it inserts rows that
          // take FOR KEY SHARE on the user (L7).
          await tx.$queryRaw`SELECT id FROM execution_target WHERE id = ${g.target.id} FOR UPDATE`;
          deleting = order.deleteUserInCapacityLockOrder(prisma, g.user.id, mark!.generation);
          // Wait until the delete is blocked on the target lock.
          for (let attempt = 0; attempt < 200; attempt += 1) {
            const [{ waiting }] = await prisma.$queryRaw<[{ waiting: bigint }]>`
              SELECT count(*)::bigint AS waiting FROM pg_stat_activity
               WHERE wait_event_type = 'Lock' AND datname = current_database()`;
            if (Number(waiting) > 0) break;
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          // The user row must not be held by the waiting delete.
          await tx.$executeRawUnsafe(
            `INSERT INTO admission_request
               (id, "userId", "requestId", "attemptId", "sourceKind", "directExecutionTargetId",
                "basePriority", "enqueueSequence", "connectionOwner", "heartbeatAt", state)
             VALUES ('${g.suffix}-p5', '${g.user.id}', '${g.suffix}-p5-r', '${g.suffix}-p5-a',
                     'DIRECT', '${g.target.id}', 16, 1, 'p5', now(), 'WAITING')`,
          );
          throw rolledBack;
        },
        { timeout: 30_000 },
      )
      .catch((error: unknown) => error);
    expect(await holder).toBe(rolledBack);
    await expect(deleting).resolves.toBe(true);
    expect(await deadlocks()).toBe(before);
  });

  it("the L7 generation check waits for a concurrent abandon and then refuses (lock order)", async () => {
    const { prisma, deletion, order } = required();
    const g = await graph("l7-generation");
    const mark = await deletion.requestUserDeletion(prisma, g.user.id);
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held!: () => void;
    const isHeld = new Promise<void>((resolve) => {
      held = resolve;
    });
    // An abandon holding the user row (like a slow unarchive/ban writer).
    const abandoning = required().prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`
          UPDATE "user" SET "deletionRequestedAt" = NULL, "deletionGeneration" = NULL
           WHERE id = ${g.user.id}`;
        held();
        await released;
      },
      { timeout: 30_000 },
    );
    await isHeld;
    const deleting = order.deleteUserInCapacityLockOrder(prisma, g.user.id, mark!.generation);
    await new Promise((resolve) => setTimeout(resolve, 200));
    release();
    await abandoning;
    await expect(deleting).resolves.toBe(false);
    expect(await prisma.user.count({ where: { id: g.user.id } })).toBe(1);
  });

  it(
    "deleteModelPool detaches a large relay history and drains terminal admissions",
    async () => {
      const { forwarder } = required();
      const g = await graph("pool");
      await relayHistory(g, "pool");
      await otherHistory(g);
      const client = createRouterClient(forwarder.forwarderManagementRouter, {
        context: sessionFor(g.user),
      });
      await expect(
        timed("deleteModelPool total", () => client.deleteModelPool({ id: g.pool.id })),
      ).resolves.toEqual({ deleted: true });
      expect(await count(`relay_request WHERE "userId" = '${g.user.id}'`)).toBe(ROWS);
      expect(await count(`relay_request WHERE "requestedModelPoolId" = '${g.pool.id}'`)).toBe(0);
      expect(await count(`admission_request WHERE "poolId" = '${g.pool.id}'`)).toBe(0);
    },
    TIMEOUT * 2,
  );

  it(
    "removeEndpointMetadata detaches direct-model relay history (the route's shape)",
    async () => {
      const { forwarder } = required();
      const g = await graph("endpoint");
      await relayHistory(g, "direct-model");
      const client = createRouterClient(forwarder.forwarderManagementRouter, {
        context: sessionFor(g.user),
      });
      await expect(
        timed("removeEndpointMetadata total", () =>
          client.removeEndpointMetadata({ id: g.endpoint.id }),
        ),
      ).resolves.toEqual({ deleted: true });
      expect(await count(`relay_request WHERE "userId" = '${g.user.id}'`)).toBe(ROWS);
      expect(
        await count(`relay_request WHERE "selectedExecutionTargetId" = '${g.target.id}'`),
      ).toBe(0);
    },
    TIMEOUT * 2,
  );

  it(
    "device, model and member deletes and capacity removal drain their history too",
    async () => {
      const { prisma, forwarder, capacity } = required();
      const rows = Math.min(ROWS, 20_000);

      const device = await graph("device");
      await relayHistory(device, "direct-model", rows);
      const deviceClient = createRouterClient(forwarder.forwarderManagementRouter, {
        context: sessionFor(device.user),
      });
      await expect(
        timed("removeCliDeviceMetadata total", () =>
          deviceClient.removeCliDeviceMetadata({ id: device.device.id }),
        ),
      ).resolves.toEqual({ deleted: true });
      expect(await count(`relay_request WHERE "userId" = '${device.user.id}'`)).toBe(rows);

      const model = await graph("model");
      await relayHistory(model, "direct-model", rows);
      const modelClient = createRouterClient(forwarder.forwarderManagementRouter, {
        context: sessionFor(model.user),
      });
      await expect(
        timed("removeDiscoveredModelMetadata total", () =>
          modelClient.removeDiscoveredModelMetadata({ id: model.model.id }),
        ),
      ).resolves.toMatchObject({ deleted: true });

      const member = await graph("member");
      await relayHistory(member, "member", rows);
      await otherHistory(member);
      const memberClient = createRouterClient(forwarder.forwarderManagementRouter, {
        context: sessionFor(member.user),
      });
      await expect(
        timed("removePoolMember total", () =>
          memberClient.removePoolMember({ id: member.member.id }),
        ),
      ).resolves.toEqual({ deleted: true });
      expect(
        await count(`relay_request WHERE "selectedPoolMemberId" = '${member.member.id}'`),
      ).toBe(0);
      expect(await count(`capacity_waiter WHERE "poolMemberId" = '${member.member.id}'`)).toBe(0);

      const spare = await prisma.inferenceCapacity.create({
        data: {
          userId: member.user.id,
          label: `spare-${member.suffix}`,
          runtimeIdentityKey: `spare-${member.suffix}`,
          runtimeModel: "spare",
        },
      });
      const capacityClient = createRouterClient(capacity.capacityManagementRouter, {
        context: sessionFor(member.user),
      });
      await expect(capacityClient.remove({ id: spare.id })).resolves.toEqual({ success: true });
    },
    TIMEOUT * 2,
  );

  it("sweep fairness: the eleventh marked user is attempted after transient failures on the first ten", async () => {
    const { prisma, deletion } = required();
    const { sweepPendingUserDeletions } = await import(
      "../../../../apps/server/src/user-deletion-sweep.js"
    );
    const ids: string[] = [];
    const base = Date.now() - 1_000_000;
    for (let n = 0; n < 11; n++) {
      const g = await graph(`fair-${n}`);
      ids.push(g.user.id);
      await deletion.requestUserDeletion(prisma, g.user.id);
      await prisma.user.update({
        where: { id: g.user.id },
        data: { deletionRequestedAt: new Date(base + n * 1000) },
      });
    }
    const attempted = new Map<string, number>();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      for (let tick = 0; tick < 3; tick++) {
        await sweepPendingUserDeletions({
          prisma,
          now: new Date(),
          complete: async (_db: unknown, id: string, generation: string) => {
            attempted.set(id, (attempted.get(id) ?? 0) + 1);
            if (ids.slice(0, 10).includes(id)) {
              throw Object.assign(new Error("injected timeout"), { code: "P2028" });
            }
            return deletion.completeUserDeletion(prisma, id, generation);
          },
          notify: async () => undefined,
        });
      }
    } finally {
      errors.mockRestore();
    }
    expect(attempted.get(ids[10])).toBeGreaterThanOrEqual(1);
    expect(await prisma.user.count({ where: { id: ids[10] } })).toBe(0);
  });

  it("refuses unarchive while deletion is pending", async () => {
    const { prisma, users, deletion } = required();
    const g = await graph("unarchive-blocked");
    const admin = await graph("unarchive-admin");
    await deletion.requestUserDeletion(prisma, g.user.id);
    const client = createRouterClient(users.usersRouter, { context: sessionFor(admin.user) });
    await expect(client.unarchive({ userId: g.user.id })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(
      await prisma.user.findUniqueOrThrow({
        where: { id: g.user.id },
        select: { deletionRequestedAt: true, banned: true },
      }),
    ).toMatchObject({ deletionRequestedAt: expect.any(Date), banned: true });
  });

  it("concurrent durable deletes report missing, not pending, once the user is gone", async () => {
    const { prisma, deletion } = required();
    const g = await graph("duplicate");
    let readers = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const proxy = new Proxy(prisma, {
      get(target, property, receiver) {
        if (property !== "$transaction") return Reflect.get(target, property, receiver);
        return (work: unknown, ...rest: unknown[]) => {
          if (typeof work !== "function") return target.$transaction(work, ...rest);
          return target.$transaction(
            async (tx: object) => {
              const wrapped = new Proxy(tx, {
                get(actual, key, txReceiver) {
                  const value = Reflect.get(actual, key, txReceiver);
                  if (key !== "user") return value;
                  return new Proxy(value, {
                    get(delegate, method) {
                      if (method !== "findUnique") return Reflect.get(delegate, method);
                      return async (...args: unknown[]) => {
                        const result = await delegate.findUnique(...args);
                        readers += 1;
                        if (readers === 2) release();
                        await barrier;
                        return result;
                      };
                    },
                  });
                },
              });
              return work(wrapped);
            },
            ...rest,
          );
        };
      },
    });
    const outcomes = await Promise.all([
      deletion.deleteUserDurably(proxy, g.user.id),
      deletion.deleteUserDurably(proxy, g.user.id),
    ]);
    expect([...outcomes].sort()).toEqual(["deleted", "missing"]);
    expect(await prisma.user.count({ where: { id: g.user.id } })).toBe(0);
  });

  it(
    "Better Auth remove-user with retained history injected after account delete leaves a recoverable marker",
    async () => {
      const { prisma, auth, deletion } = required();
      const admin = await graph("race-admin");
      await prisma.user.update({ where: { id: admin.user.id }, data: { role: "admin" } });
      const password = `RaceAdmin-${crypto.randomUUID()}`;
      const context = await auth.auth.$context;
      await prisma.account.create({
        data: {
          userId: admin.user.id,
          accountId: admin.user.id,
          providerId: "credential",
          password: await context.password.hash(password),
        },
      });
      const victim = await graph("race-victim");
      await prisma.account.create({
        data: {
          userId: victim.user.id,
          accountId: victim.user.id,
          providerId: "credential",
          password: "fixture-only",
        },
      });
      await prisma.session.create({
        data: {
          userId: victim.user.id,
          token: `race-${victim.suffix}`,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      const device = await prisma.cliDevice.create({
        data: { userId: victim.user.id, slug: "race-device" },
      });
      const endpoint = await prisma.endpoint.create({
        data: {
          userId: victim.user.id,
          cliDeviceId: device.id,
          slug: "race-endpoint",
          label: "race",
        },
      });
      const model = await prisma.discoveredModel.create({
        data: {
          userId: victim.user.id,
          endpointId: endpoint.id,
          upstreamModelId: "race-model",
          encodedModelId: `race-${victim.suffix}`,
        },
      });
      const target = await prisma.executionTarget.findUniqueOrThrow({
        where: { discoveredModelId: model.id },
      });
      const login = await auth.auth.api.signInEmail({
        body: { email: admin.user.email, password },
        asResponse: true,
      });
      expect(login.status).toBe(200);
      const cookie = login.headers
        .getSetCookie()
        .map((line) => line.split(";")[0])
        .join("; ");
      const originalDeleteMany = context.adapter.deleteMany.bind(context.adapter);
      let inserted = false;
      const suffix = victim.suffix;
      context.adapter.deleteMany = async (args: { model: string }) => {
        const result = await originalDeleteMany(args);
        if (args.model === "account" && !inserted) {
          inserted = true;
          const request = await prisma.admissionRequest.create({
            data: {
              userId: victim.user.id,
              requestId: `race-request-${suffix}`,
              attemptId: `race-attempt-${suffix}`,
              sourceKind: "DIRECT",
              directExecutionTargetId: target.id,
              basePriority: 16,
              enqueueSequence: 1n,
              connectionOwner: "race-probe",
              heartbeatAt: new Date(),
              state: "TERMINAL",
              terminalAt: new Date(),
            },
          });
          await prisma.capacityLease.create({
            data: {
              userId: victim.user.id,
              requestId: request.requestId,
              attemptId: request.attemptId,
              admissionRequestId: request.id,
              capacityId: target.inferenceCapacityId!,
              executionTargetId: target.id,
              priority: 16,
              reservationClass: 16,
              fencingToken: 1n,
              ownerServerInstance: "race-probe",
              heartbeatAt: new Date(),
              expiresAt: new Date(Date.now() + 60_000),
              state: "RELEASED",
              releasedAt: new Date(),
            },
          });
        }
        return result;
      };
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        await auth.auth.handler(
          new Request("http://localhost:3000/api/auth/admin/remove-user", {
            method: "POST",
            headers: {
              cookie,
              origin: "http://localhost:3000",
              "content-type": "application/json",
            },
            body: JSON.stringify({ userId: victim.user.id }),
          }),
        );
      } finally {
        errors.mockRestore();
        context.adapter.deleteMany = originalDeleteMany;
      }
      expect(inserted).toBe(true);
      const sessions = await prisma.session.count({ where: { userId: victim.user.id } });
      const accounts = await prisma.account.count({ where: { userId: victim.user.id } });
      const row = await prisma.user.findUnique({
        where: { id: victim.user.id },
        select: { banned: true, deletionRequestedAt: true, deletionGeneration: true },
      });
      const stranded = row && row.deletionRequestedAt === null && sessions === 0 && accounts === 0;
      expect(stranded).toBe(false);
      if (row?.deletionGeneration) {
        await deletion.abandonUserDeletion(prisma, victim.user.id, row.deletionGeneration);
      }
    },
    TIMEOUT,
  );

  it("Better Auth restore routes cannot reopen a user whose deletion is pending (r2 P1)", async () => {
    const { prisma, auth, deletion } = required();
    const context = await auth.auth.$context;
    async function withPassword(tag: string) {
      const g = await graph(tag);
      const password = `Restore-${crypto.randomUUID()}`;
      await prisma.account.create({
        data: {
          userId: g.user.id,
          accountId: g.user.id,
          providerId: "credential",
          password: await context.password.hash(password),
        },
      });
      return { g, password };
    }
    const admin = await withPassword("restore-admin");
    await prisma.user.update({ where: { id: admin.g.user.id }, data: { role: "admin" } });
    const victim = await withPassword("restore-victim");
    const signIn = (email: string, password: string) =>
      auth.auth.api.signInEmail({ body: { email, password }, asResponse: true });
    const login = await signIn(admin.g.user.email, admin.password);
    expect(login.status).toBe(200);
    const cookie = login.headers
      .getSetCookie()
      .map((line) => line.split(";")[0])
      .join("; ");
    const adminCall = (path: string, body: unknown) =>
      auth.auth.handler(
        new Request(`http://localhost:3000/api/auth/admin/${path}`, {
          method: "POST",
          headers: { cookie, origin: "http://localhost:3000", "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    const mark = await deletion.requestUserDeletion(prisma, victim.g.user.id);
    expect(mark?.created).toBe(true);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      // Defense in depth: the admin restore routes refuse a pending user.
      expect((await adminCall("unban-user", { userId: victim.g.user.id })).status).toBe(409);
      expect(
        (await adminCall("update-user", { userId: victim.g.user.id, data: { banned: false } }))
          .status,
      ).toBe(409);
      expect(
        (await adminCall("ban-user", { userId: victim.g.user.id, banExpiresIn: 1 })).status,
      ).toBe(409);
      // The proof: whatever the ban fields hold, no session is minted.
      expect((await signIn(victim.g.user.email, victim.password)).status).toBe(403);
      await prisma.user.update({
        where: { id: victim.g.user.id },
        data: { banned: false, banReason: null, banExpires: null },
      });
      expect((await signIn(victim.g.user.email, victim.password)).status).toBe(403);
      // An expired temporary ban: the admin plugin clears it, the marker still refuses.
      await prisma.user.update({
        where: { id: victim.g.user.id },
        data: { banned: true, banExpires: new Date(Date.now() - 60_000) },
      });
      expect((await signIn(victim.g.user.email, victim.password)).status).toBe(403);
    } finally {
      errors.mockRestore();
    }
    const row = await prisma.user.findUniqueOrThrow({ where: { id: victim.g.user.id } });
    expect(row.deletionGeneration).toBe(mark!.generation);
    expect(await prisma.session.count({ where: { userId: victim.g.user.id } })).toBe(0);
  });

  it("merges requester rollups onto other owners without changing their totals", async () => {
    const { prisma, deletion } = required();
    const owner = await graph("rollup-total-owner");
    const requester = await graph("rollup-total-requester");
    const bucket = new Date("2026-02-01T00:00:00.000Z");
    await prisma.usageRollupMinute.create({
      data: {
        bucketStart: bucket,
        ownerUserId: owner.user.id,
        requesterUserId: requester.user.id,
        poolId: "",
        poolMemberId: "",
        executionTargetId: "",
        source: "API_TOKEN",
        requests: 4,
        successes: 3,
        inputTokens: 10,
      },
    });
    await prisma.usageRollupHour.create({
      data: {
        bucketStart: bucket,
        ownerUserId: owner.user.id,
        requesterUserId: requester.user.id,
        poolId: "",
        poolMemberId: "",
        executionTargetId: "",
        source: "API_TOKEN",
        requests: 7,
        errors: 1,
      },
    });
    const minuteBefore = await prisma.usageRollupMinute.aggregate({
      where: { ownerUserId: owner.user.id },
      _sum: { requests: true, inputTokens: true },
    });
    const hourBefore = await prisma.usageRollupHour.aggregate({
      where: { ownerUserId: owner.user.id },
      _sum: { requests: true, errors: true },
    });
    const mark = await deletion.requestUserDeletion(prisma, requester.user.id);
    await expect(
      deletion.completeUserDeletion(prisma, requester.user.id, mark!.generation),
    ).resolves.toBe(true);
    const minuteAfter = await prisma.usageRollupMinute.aggregate({
      where: { ownerUserId: owner.user.id },
      _sum: { requests: true, inputTokens: true },
    });
    const hourAfter = await prisma.usageRollupHour.aggregate({
      where: { ownerUserId: owner.user.id },
      _sum: { requests: true, errors: true },
    });
    expect(minuteAfter).toEqual(minuteBefore);
    expect(hourAfter).toEqual(hourBefore);
    expect(
      await count(`usage_rollup_minute WHERE "requesterUserId" = '${requester.user.id}'`),
    ).toBe(0);
    expect(await count(`usage_rollup_hour WHERE "requesterUserId" = '${requester.user.id}'`)).toBe(
      0,
    );
  });

  it(
    "counts live PENDING relay rows toward the final-phase bound for a user delete (r2 P2)",
    async () => {
      const { prisma, deletion } = required();
      const g = await graph("residual-user");
      const over = deletion.PARENT_DELETION_MAX_FINAL_PHASE_RESIDUAL_ROWS + 1;
      await prisma.$executeRawUnsafe(
        `INSERT INTO relay_request (id, "userId", status)
       SELECT '${g.suffix}-live-' || n, '${g.user.id}', 'PENDING'
         FROM generate_series(1, ${over}) n`,
      );
      const mark = await deletion.requestUserDeletion(prisma, g.user.id);
      await expect(
        deletion.completeUserDeletion(prisma, g.user.id, mark!.generation),
      ).rejects.toBeInstanceOf(deletion.ParentDeletionDrainPendingError);
      // Nothing was deleted under the capacity locks; the marker stays for the sweeper.
      expect(await count(`relay_request WHERE "userId" = '${g.user.id}'`)).toBe(over);
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: g.user.id } })).deletionGeneration,
      ).toBe(mark!.generation);
      // Once the live rows are gone (terminal and drained, or reaped) it completes.
      await prisma.$executeRawUnsafe(
        `UPDATE relay_request SET status = 'FAILED' WHERE "userId" = '${g.user.id}'`,
      );
      await expect(
        deletion.completeUserDeletion(prisma, g.user.id, mark!.generation),
      ).resolves.toBe(true);
    },
    TIMEOUT,
  );

  it("counts live rows for a non-user parent delete too (pool)", async () => {
    const { prisma, deletion } = required();
    const g = await graph("residual-pool");
    const parents = await deletion.resolveDeletedParents(prisma, {
      userId: g.user.id,
      poolIds: [g.pool.id],
    });
    await expect(deletion.countFinalPhaseResidualRows(prisma, parents)).resolves.toBe(0);
    await prisma.$executeRawUnsafe(
      `INSERT INTO relay_request (id, "userId", status, "requestedModelPoolId")
       SELECT '${g.suffix}-pool-live-' || n, '${g.user.id}', 'PENDING', '${g.pool.id}'
         FROM generate_series(1, 30) n`,
    );
    await expect(deletion.countFinalPhaseResidualRows(prisma, parents)).resolves.toBe(30);
    await expect(deletion.countFinalPhaseResidualRows(prisma, parents, 10)).resolves.toBe(10);
    await expect(
      deletion.prepareParentDeletion(prisma, { userId: g.user.id, poolIds: [g.pool.id] }),
    ).resolves.toBeDefined();
  });

  it("returns pending when relay history keeps arriving during the drain", async () => {
    const { prisma, deletion } = required();
    const g = await graph("arrival");
    await relayHistory(g, "own", 20);
    const parents = await deletion.resolveDeletedParents(prisma, {
      userId: g.user.id,
      wholeUser: true,
    });
    let scans = 0;
    const producer = new Proxy(prisma, {
      get(target, property, receiver) {
        if (property !== "$queryRaw") return Reflect.get(target, property, receiver);
        return async (...args: unknown[]) => {
          const strings = args[0];
          const text = Array.isArray(strings) ? strings.join("?") : "";
          if (text.includes('SELECT id, "createdAt" FROM relay_request')) {
            scans += 1;
            await target.relayRequest.create({
              data: {
                id: `arrival-${g.suffix}-${scans}`,
                userId: g.user.id,
                status: "SUCCEEDED",
                createdAt: new Date(Date.UTC(2026, 1, 1) + scans * 1000),
              },
            });
          }
          return target.$queryRaw(...args);
        };
      },
    });
    const { ParentDeletionDrainPendingError } = await import("@ws-model-proxy/db/parent-deletion");
    await expect(
      deletion.drainParentDeletionHistory(producer, parents, {
        batch: 1,
        maxRowsPerRun: 6,
        maxLoopIterations: 50,
      }),
    ).rejects.toBeInstanceOf(ParentDeletionDrainPendingError);
  });
});
