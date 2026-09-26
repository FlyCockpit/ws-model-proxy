import { appendFileSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { createRouterClient } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import { afterAll, beforeAll, describe, expect, it, type MockInstance, vi } from "vitest";
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
/** The production sweep client and its shutdown handle. */
type SweepHandle = ReturnType<
  typeof import("../../../../apps/server/src/user-deletion-sweep.js").createUserDeletionSweepClient
>;
type SweepClient = SweepHandle["prisma"];

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
        /** A second, unfenced client for pg_stat_activity probes and holders. */
        observer: Db;
        deletion: typeof import("@ws-model-proxy/db/parent-deletion");
        order: typeof import("@ws-model-proxy/db/capacity-lock-order");
        forwarder: typeof import("../routers/forwarder-management");
        capacity: typeof import("../routers/capacity-management");
        users: typeof import("../routers/users");
        auth: typeof import("@ws-model-proxy/auth");
        listeners: typeof import("@ws-model-proxy/auth/user-deletion-listeners");
        fence: typeof import("@ws-model-proxy/db/shutdown-fence");
        clientFactory: typeof import("@ws-model-proxy/db/client-factory");
        deadline: typeof import("../../../../apps/server/src/graceful-shutdown.js");
        timeouts: typeof import("../../../../apps/server/src/shutdown-timeouts.js");
      }
    | undefined;

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    process.env.NODE_ENV = "test";
    const [db, deletion, order, forwarder, capacity, users, auth, listeners, fence, deadline] =
      await Promise.all([
        import("@ws-model-proxy/db"),
        import("@ws-model-proxy/db/parent-deletion"),
        import("@ws-model-proxy/db/capacity-lock-order"),
        import("../routers/forwarder-management"),
        import("../routers/capacity-management"),
        import("../routers/users"),
        import("@ws-model-proxy/auth"),
        import("@ws-model-proxy/auth/user-deletion-listeners"),
        import("@ws-model-proxy/db/shutdown-fence"),
        import("../../../../apps/server/src/graceful-shutdown.js"),
      ]);
    const clientFactory = await import("@ws-model-proxy/db/client-factory");
    const timeouts = await import("../../../../apps/server/src/shutdown-timeouts.js");
    modules = {
      prisma: db.default,
      observer: clientFactory.createPrismaClient(databaseUrl),
      deletion,
      order,
      forwarder,
      capacity,
      users,
      auth,
      listeners,
      fence,
      clientFactory,
      deadline,
      timeouts,
    };
  });

  afterAll(async () => {
    // Fixtures use unique identities in a disposable database.
    modules?.fence.disarmDbShutdownFence();
    await modules?.observer.$disconnect();
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
        deletion.drainParentDeletionHistory(prisma, parents, {
          owner: { userId: g.user.id, generation: mark!.generation },
        }),
      );
      expect(drained["relay_request.delete"]).toBe(ROWS);
      // The delete label counts only rows actually deleted; the scan label
      // counts candidates (busy ones included) and drives loop termination.
      expect(drained["admission_request.delete"]).toBe(ADMISSIONS);
      expect(drained["admission_request.scan"]).toBeGreaterThanOrEqual(ADMISSIONS);
      expect(drained["admission_request.passed"]).toBe(0);
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
      const { pending } = await deletion.listPendingUserDeletions(prisma, {
        before: new Date(),
        limit: 1_000,
      });
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
    const mark = await deletion.requestUserDeletion(prisma, g.user.id);
    // A whole-user drain must name the generation it works for (R2-17-2: the
    // typed error, by class and code, not a message match).
    const ownerless = await settle(
      deletion.drainParentDeletionHistory(prisma, parents, { batch: 50 }),
    );
    expect(ownerless.ok).toBe(false);
    if (ownerless.ok) throw new Error("an ownerless whole-user drain ran");
    expect(ownerless.error).toBeInstanceOf(deletion.ParentDeletionOwnerRequiredError);
    expect(ownerless.error).toMatchObject({ code: "PARENT_DELETION_OWNER_REQUIRED" });
    expect(await count(`relay_request WHERE "userId" = '${g.user.id}'`)).toBe(200);
    const drained = await deletion.drainParentDeletionHistory(prisma, parents, {
      batch: 50,
      owner: { userId: g.user.id, generation: mark!.generation },
    });
    expect(drained["relay_request.delete"]).toBe(199);
    release();
    await holding;
    await expect(deletion.completeUserDeletion(prisma, g.user.id, mark!.generation)).resolves.toBe(
      true,
    );
  });

  /**
   * `prisma` whose `pauseAt`-th interactive transaction (1-based) waits for
   * `release()`. A user-deletion worker's first transaction is its
   * impersonation-session batch, right after its unlocked generation read.
   */
  function pausingBeforeTransaction(pauseAt: number) {
    const prisma = required().prisma;
    let calls = 0;
    let reached!: () => void;
    const isReached = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const db = new Proxy(prisma, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (property !== "$transaction" || typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          calls += 1;
          if (calls === pauseAt) {
            reached();
            await released;
          }
          return Reflect.apply(value, target, args);
        };
      },
    });
    return { db, reached: isReached, release: () => release() };
  }

  async function settle<T>(work: Promise<T>) {
    return work.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Waits until a backend whose statement contains `fragment` is waiting on a
   * lock held by one of `holderPids`, and returns that holder's pid. Matching
   * the waiting statement's text — not `pg_locks.relation` — is required: a
   * waiter for a row another transaction holds waits on a `transactionid`
   * lock, whose `pg_locks` entry names no relation. `observer` is a second,
   * unfenced client: the shared (fenced) client cannot carry a probe once the
   * shutdown fence arms. Keying the release on the exact holder that blocks the
   * drain makes the four sequential waits deterministic (a row the drain has
   * already acquired would otherwise make a fixed release schedule release too
   * early or too late).
   */
  async function waitForBlocker(
    fragment: string,
    holderPids: ReadonlySet<number>,
    timeoutMs = 10_000,
  ): Promise<number> {
    const observer = required().observer;
    const started = Date.now();
    for (;;) {
      const rows = await observer.$queryRaw<Array<{ pid: number }>>`
        SELECT unnest(pg_blocking_pids(pid)) AS pid
          FROM pg_stat_activity
         WHERE datname = current_database()
           AND wait_event_type = 'Lock'
           AND query LIKE ${`%${fragment}%`}`;
      const pid = rows.map((row) => Number(row.pid)).find((candidate) => holderPids.has(candidate));
      if (pid !== undefined) return pid;
      if (Date.now() - started > timeoutMs)
        throw new Error(`no holder blocked a ${fragment} waiter within ${timeoutMs} ms`);
      await sleep(10);
    }
  }

  /**
   * Starts the production sweep on `worker` (no wait on the general
   * interval) and returns its stop function: stopping resolves when the tick
   * in flight finishes, exactly the promise shutdown joins. Production passes
   * `createUserDeletionSweepClient(DATABASE_URL).prisma` (apps/server/src/index.ts);
   * the start function hands the same client to every tick.
   */
  async function startSweep(worker: SweepClient): Promise<() => Promise<void>> {
    const sweep = await import("../../../../apps/server/src/user-deletion-sweep.js");
    return sweep.startUserDeletionSweep({
      prisma: worker,
      intervalMs: 3_600_000,
      sweep: (options) =>
        sweep.sweepPendingUserDeletions({ ...options, notify: async () => undefined }),
    });
  }

  /** The production sweep client with its shutdown handle. */
  async function productionSweepHandle(url = databaseUrl!): Promise<SweepHandle> {
    const sweep = await import("../../../../apps/server/src/user-deletion-sweep.js");
    return sweep.createUserDeletionSweepClient(url);
  }

  /** The production sweep client (fenced, server-side statement_timeout). */
  async function productionSweepClient(): Promise<SweepClient> {
    return (await productionSweepHandle()).prisma;
  }

  it.each([
    ["right after its first generation read", 1],
    ["between drain batches", 6],
  ])(
    "a stale deletion worker paused %s deletes nothing after an abandon and a restore (F2-03)",
    async (_label, pauseAt) => {
      const { prisma, deletion } = required();
      const g = await graph("stale-generation");
      const victim = await graph("stale-generation-victim");
      await prisma.user.update({ where: { id: g.user.id }, data: { role: "admin" } });
      await relayHistory(g, "own", 40);
      const mark = await deletion.requestUserDeletion(prisma, g.user.id);
      const worker = pausingBeforeTransaction(pauseAt);
      const stale = settle(
        deletion.completeUserDeletion(worker.db, g.user.id, mark!.generation, { batch: 5 }),
      );
      await worker.reached;

      // Another worker's permanent refusal abandons the generation; an admin
      // restores the archived user, who then works again.
      await expect(deletion.abandonUserDeletion(prisma, g.user.id, mark!.generation)).resolves.toBe(
        true,
      );
      const restored = await prisma.user.updateMany({
        where: { id: g.user.id, deletionRequestedAt: null },
        data: { banned: false, banReason: null, banExpires: null },
      });
      expect(restored.count).toBe(1);
      const history = await prisma.relayRequest.create({
        data: { id: `${g.suffix}-post-restore`, userId: g.user.id, status: "SUCCEEDED" },
      });
      const rollup = await prisma.usageRollupMinute.create({
        data: {
          bucketStart: new Date("2026-02-01T00:00:00.000Z"),
          ownerUserId: g.user.id,
          requesterUserId: g.user.id,
          poolId: "",
          poolMemberId: "",
          executionTargetId: "",
          source: "API_TOKEN",
          requests: 1,
        },
      });
      const impersonation = await prisma.session.create({
        data: {
          token: `${g.suffix}-impersonation`,
          userId: victim.user.id,
          impersonatedBy: g.user.id,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });

      worker.release();
      expect(await stale).toEqual({ ok: true, value: false });
      expect(await prisma.relayRequest.count({ where: { id: history.id } })).toBe(1);
      expect(
        await prisma.usageRollupMinute.count({
          where: { ownerUserId: g.user.id, bucketStart: rollup.bucketStart },
        }),
      ).toBe(1);
      expect(await prisma.session.count({ where: { id: impersonation.id } })).toBe(1);
      expect(
        await prisma.user.findUniqueOrThrow({
          where: { id: g.user.id },
          select: { banned: true, deletionRequestedAt: true, deletionGeneration: true },
        }),
      ).toEqual({ banned: false, deletionRequestedAt: null, deletionGeneration: null });
    },
  );

  it("a stale deletion worker leaves a newer generation's intent and history alone (F2-03)", async () => {
    const { prisma, deletion } = required();
    const g = await graph("stale-remark");
    await relayHistory(g, "own", 40);
    const first = await deletion.requestUserDeletion(prisma, g.user.id);
    const worker = pausingBeforeTransaction(6);
    const stale = settle(
      deletion.completeUserDeletion(worker.db, g.user.id, first!.generation, { batch: 5 }),
    );
    await worker.reached;
    await deletion.abandonUserDeletion(prisma, g.user.id, first!.generation);
    const second = await deletion.requestUserDeletion(prisma, g.user.id);
    expect(second?.created).toBe(true);
    // A request that was in flight when the new mark committed.
    const inFlight = await prisma.relayRequest.create({
      data: { id: `${g.suffix}-in-flight`, userId: g.user.id, status: "SUCCEEDED" },
    });

    worker.release();
    expect(await stale).toEqual({ ok: true, value: false });
    expect(await prisma.relayRequest.count({ where: { id: inFlight.id } })).toBe(1);
    expect(
      await prisma.user.findUniqueOrThrow({
        where: { id: g.user.id },
        select: { deletionGeneration: true, deletionSweepAttempts: true },
      }),
    ).toEqual({ deletionGeneration: second?.generation, deletionSweepAttempts: 0 });
    // The owner of the new generation still completes it.
    await expect(
      deletion.completeUserDeletion(prisma, g.user.id, second!.generation),
    ).resolves.toBe(true);
    expect(await prisma.user.count({ where: { id: g.user.id } })).toBe(0);
  });

  it("an abandon does not wait on a deletion worker that died holding the user row", async () => {
    const { prisma, deletion } = required();
    const g = await graph("dead-worker");
    const mark = await deletion.requestUserDeletion(prisma, g.user.id);
    let reportPid!: (pid: number) => void;
    const pid = new Promise<number>((resolve) => {
      reportPid = resolve;
    });
    let terminated!: () => void;
    const isTerminated = new Promise<void>((resolve) => {
      terminated = resolve;
    });
    // What a drain batch holds: the user row FOR SHARE on its generation.
    const dying = settle(
      prisma.$transaction(
        async (tx) => {
          const [backend] = await tx.$queryRaw<[{ pid: number }]>`SELECT pg_backend_pid() AS pid`;
          await tx.$queryRaw`
            SELECT id FROM "user"
             WHERE id = ${g.user.id} AND "deletionGeneration" = ${mark!.generation}
               FOR SHARE`;
          reportPid(backend.pid);
          await isTerminated;
          // The connection is gone: this worker cannot go on.
          await tx.$queryRaw`SELECT 1`;
        },
        { timeout: 30_000 },
      ),
    );
    const holder = await pid;
    const abandoning = deletion.abandonUserDeletion(prisma, g.user.id, mark!.generation);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await prisma.$queryRaw`SELECT pg_terminate_backend(${holder}::int)`;
    terminated();
    await expect(abandoning).resolves.toBe(true);
    expect((await dying).ok).toBe(false);
  });

  /** Terminal pool admissions, each with one waiter on the graph's capacity. */
  async function terminalAdmissions(g: Graph, count: number) {
    const db = required().prisma;
    await db.$executeRawUnsafe(
      `INSERT INTO admission_request (id, "userId", "requestId", "attemptId", "sourceKind", "poolId",
         "basePriority", "enqueueSequence", "connectionOwner", "heartbeatAt", state, "terminalAt")
       SELECT '${g.suffix}-tar-' || n, '${g.user.id}', '${g.suffix}-tr-' || n, '${g.suffix}-ta-' || n,
              'POOL', '${g.pool.id}', 16, n, 'fixture', now(), 'CANCELLED', now()
         FROM generate_series(1, ${count}) n`,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO capacity_waiter (id, "userId", "admissionRequestId", "requestId", "attemptId",
         "enqueueSequence", "capacityId", "executionTargetId", "poolId", "poolMemberId",
         "candidateOrder", "effectivePriority", "effectiveConcurrencyScope",
         "effectiveConcurrencyScopeId", "effectiveReservedSlots", "effectiveBorrowPolicy", state)
       SELECT '${g.suffix}-tw-' || n, '${g.user.id}', '${g.suffix}-tar-' || n, '${g.suffix}-tr-' || n,
              '${g.suffix}-ta-' || n, n, '${g.capacityId}', '${g.target.id}', '${g.pool.id}',
              '${g.member.id}', 0, 16, 'POOL', '${g.pool.id}', 0, 'WHEN_IDLE', 'CANCELLED'
         FROM generate_series(1, ${count}) n`,
    );
  }

  /**
   * Holds `sql` (a row-locking SELECT) in its own transaction until released.
   * Returns the holder's backend pid so a caller can tell which waiter it
   * blocks (`pg_blocking_pids`).
   */
  async function holdRowLock(sql: string) {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    let pid = 0;
    const holding = required().observer.$transaction(
      async (tx) => {
        const rows = await tx.$queryRawUnsafe<Array<{ pid: number }>>(
          "SELECT pg_backend_pid() AS pid",
        );
        pid = Number(rows[0]!.pid);
        await tx.$queryRawUnsafe(sql);
        locked();
        await released;
      },
      { timeout: 60_000 },
    );
    await isLocked;
    return {
      pid,
      release: async () => {
        release();
        await holding;
      },
    };
  }

  it("the drain passes a terminal admission whose waiter another transaction holds (F2-07)", async () => {
    const { prisma, deletion } = required();
    const g = await graph("held-waiter");
    await terminalAdmissions(g, 3);
    // The retention sweeper or an admitter holding one waiter row.
    const held = await holdRowLock(
      `SELECT id FROM capacity_waiter WHERE id = '${g.suffix}-tw-1' FOR UPDATE`,
    );
    try {
      const started = Date.now();
      const draining = settle(
        deletion.prepareParentDeletion(prisma, { userId: g.user.id, poolIds: [g.pool.id] }),
      );
      // Without waiting on the held waiter, nor timing out on it.
      const outcome = await Promise.race([
        draining,
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 1_500)),
      ]);
      expect(outcome).not.toBe("blocked");
      expect(Date.now() - started).toBeLessThan(deletion.PARENT_DELETION_DRAIN_LOCK_TIMEOUT_MS);
      if (outcome === "blocked" || !outcome.ok) throw new Error("drain did not finish");
      expect(outcome.value["admission_request.passed"]).toBe(1);
      expect(await count(`admission_request WHERE id = '${g.suffix}-tar-1'`)).toBe(1);
      expect(await count(`capacity_waiter WHERE id = '${g.suffix}-tw-1'`)).toBe(1);
      expect(await count(`admission_request WHERE "poolId" = '${g.pool.id}'`)).toBe(1);
    } finally {
      await held.release();
    }
    // Once the row is free the next run takes it.
    await deletion.prepareParentDeletion(prisma, { userId: g.user.id, poolIds: [g.pool.id] });
    expect(await count(`admission_request WHERE "poolId" = '${g.pool.id}'`)).toBe(0);
  });

  it("the drain reports pending once it has passed more busy admissions than its bound (g1-M1)", async () => {
    const { prisma, deletion } = required();
    const g = await graph("many-held-waiters");
    const over = deletion.PARENT_DELETION_MAX_PASSED_ADMISSIONS + 1;
    await terminalAdmissions(g, over);
    // Every waiter held by one other transaction: each request is passed.
    const held = await holdRowLock(
      `SELECT id FROM capacity_waiter WHERE "poolId" = '${g.pool.id}' FOR UPDATE`,
    );
    try {
      const outcome = await settle(
        deletion.prepareParentDeletion(prisma, { userId: g.user.id, poolIds: [g.pool.id] }),
      );
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("the drain carried an unbounded passed list");
      expect(outcome.error).toBeInstanceOf(deletion.ParentDeletionDrainPendingError);
      // Nothing busy was deleted.
      expect(await count(`admission_request WHERE "poolId" = '${g.pool.id}'`)).toBe(over);
    } finally {
      await held.release();
    }
    // Inverse: once the waiters are free the next run drains every request.
    await deletion.prepareParentDeletion(prisma, { userId: g.user.id, poolIds: [g.pool.id] });
    expect(await count(`admission_request WHERE "poolId" = '${g.pool.id}'`)).toBe(0);
  }, 120_000);

  it("a lock wait past the drain bound reports pending, keeps the marker and lets the sweep go on (F2-07)", async () => {
    const { prisma, deletion } = required();
    const { sweepPendingUserDeletions } = await import(
      "../../../../apps/server/src/user-deletion-sweep.js"
    );
    const blocked = await graph("bounded-wait");
    const next = await graph("bounded-wait-next");
    const relay = await prisma.relayRequest.create({
      data: { id: `${blocked.suffix}-held`, userId: blocked.user.id, status: "SUCCEEDED" },
    });
    const event = await prisma.relayExecutionEvent.create({
      data: {
        userId: blocked.user.id,
        relayRequestId: relay.id,
        attemptId: `${blocked.suffix}-attempt`,
        eventType: "ATTEMPT_STARTED",
        requestedSurface: "OPENAI_CHAT_COMPLETIONS",
      },
    });
    // Older than any other marked user in the database, so both are selected.
    const base = Date.now() - 100_000_000;
    const marks = [];
    for (const [index, g] of [blocked, next].entries()) {
      marks.push(await deletion.requestUserDeletion(prisma, g.user.id));
      await prisma.user.update({
        where: { id: g.user.id },
        data: { deletionRequestedAt: new Date(base + index * 1000) },
      });
    }
    // The sweep below completes whatever it selects: only these two are due.
    await hideOtherMarkers([blocked.user.id, next.user.id]);
    // A writer of the terminal request's execution rows (the cascade child).
    const held = await holdRowLock(
      `SELECT id FROM relay_execution_event WHERE id = '${event.id}' FOR SHARE`,
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const started = Date.now();
      await expect(
        deletion.completeUserDeletion(prisma, blocked.user.id, marks[0]!.generation),
      ).rejects.toBeInstanceOf(deletion.ParentDeletionDrainPendingError);
      expect(Date.now() - started).toBeLessThan(
        deletion.PARENT_DELETION_DRAIN_LOCK_TIMEOUT_MS + 3_000,
      );
      // Nothing live was deleted to force progress; the marker stands.
      expect(await prisma.relayRequest.count({ where: { id: relay.id } })).toBe(1);
      expect(
        (
          await prisma.user.findUniqueOrThrow({
            where: { id: blocked.user.id },
            select: { deletionGeneration: true },
          })
        ).deletionGeneration,
      ).toBe(marks[0]!.generation);

      const result = await sweepPendingUserDeletions({
        prisma,
        now: new Date(),
        notify: async () => undefined,
        shouldStop: () => false,
      });
      expect(result.deleted).toBeGreaterThanOrEqual(1);
      expect(await prisma.user.count({ where: { id: next.user.id } })).toBe(0);
      const still = await prisma.user.findUniqueOrThrow({
        where: { id: blocked.user.id },
        select: {
          deletionGeneration: true,
          deletionSweepAttempts: true,
          deletionSweepNextAttemptAt: true,
        },
      });
      expect(still.deletionGeneration).toBe(marks[0]!.generation);
      expect(still.deletionSweepAttempts).toBe(1);
      expect(still.deletionSweepNextAttemptAt).not.toBeNull();
    } finally {
      errors.mockRestore();
      await held.release();
    }
    await expect(
      deletion.completeUserDeletion(prisma, blocked.user.id, marks[0]!.generation),
    ).resolves.toBe(true);
    // Two 2 s waits plus fixture/sweep work exceed vitest's 5 s default.
  }, 20_000);

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
    // Only this test's users are due: the sweep below completes for real
    // whatever it selects, so it must not reach other tests' marked users.
    await hideOtherMarkers(ids);
    const attempted = new Map<string, number>();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const now = new Date();
    const tick = () =>
      sweepPendingUserDeletions({
        prisma,
        now,
        complete: async (_db: unknown, id: string, generation: string) => {
          if (!ids.includes(id)) throw new Error(`the sweep selected a foreign user ${id}`);
          attempted.set(id, (attempted.get(id) ?? 0) + 1);
          if (ids.slice(0, 10).includes(id)) {
            throw Object.assign(new Error("injected timeout"), { code: "P2028" });
          }
          return deletion.completeUserDeletion(prisma, id, generation);
        },
        notify: async () => undefined,
      });
    try {
      for (let n = 0; n < 3; n++) await tick();
      expect(attempted.get(ids[10])).toBeGreaterThanOrEqual(1);
    } finally {
      errors.mockRestore();
      await retireMarkedUsers(ids);
    }
    expect(await prisma.user.count({ where: { id: ids[10] } })).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // G2-01: the sweep's queue is a round-robin over the immutable key
  // (deletionRequestedAt, id), so no page of failing users (not even one
  // whose backoff writes fail too) holds back the users after it. Each test
  // marks its users inside its own window before 1970, each older than the
  // previous test's, and sweeps with `now` just past that window: every other
  // fixture in this database is marked later, so only the test's own users are
  // eligible. Leftovers are made not due afterwards.
  // ---------------------------------------------------------------------------

  let roundRobinWindows = 0;
  /** Start of a fresh window, older than every earlier one. */
  function roundRobinWindow(): number {
    roundRobinWindows += 1;
    return -1_000_000_000_000 - roundRobinWindows * 100_000_000;
  }

  /** The sweep's `now` that makes exactly the window's first `count` seconds eligible. */
  async function roundRobinNow(base: number, count: number): Promise<Date> {
    const { USER_DELETION_SWEEP_GRACE_MS } = await import(
      "../../../../apps/server/src/user-deletion-sweep.js"
    );
    return new Date(base + count * 1000 + USER_DELETION_SWEEP_GRACE_MS);
  }

  /** A marked user with a chosen id and `deletionRequestedAt`. */
  async function markedAt(id: string, at: Date) {
    const { prisma, deletion } = required();
    await prisma.user.create({
      data: { id, name: "round-robin", email: `${id}@example.test`, slug: id, emailVerified: true },
    });
    const mark = await deletion.requestUserDeletion(prisma, id);
    if (!mark) throw new Error("mark failed");
    await prisma.user.update({ where: { id }, data: { deletionRequestedAt: at } });
    return { id, generation: mark.generation };
  }

  /**
   * A sweeping test's leftovers: still-marked users among `ids` become not
   * due for every later sweep (none in these suites runs at 2099 or later).
   */
  async function retireMarkedUsers(ids: string[]) {
    await required().observer.user.updateMany({
      where: { id: { in: ids }, deletionRequestedAt: { not: null } },
      data: { deletionSweepNextAttemptAt: new Date("2099-01-01T00:00:00.000Z") },
    });
  }

  it("G2-01: a locked full page whose completion and recovery writes fail does not starve later users", async () => {
    const { observer } = required();
    const sweep = await import("../../../../apps/server/src/user-deletion-sweep.js");
    const base = roundRobinWindow();
    const tag = crypto.randomUUID().replaceAll("-", "");
    const ids: string[] = [];
    for (let n = 0; n < 12; n++)
      ids.push(
        (await markedAt(`rrpage${tag}${String(n).padStart(2, "0")}`, new Date(base + n * 1000))).id,
      );
    const blocked = ids.slice(0, 10);
    const healthy = ids.slice(10);
    const now = await roundRobinNow(base, ids.length);
    // Another session holds the ten oldest user rows: their drain's owner
    // lock and their backoff UPDATE both time out, so nothing about them
    // changes (the durable queue keys stay as they were).
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holding = observer.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe(
          `SELECT id FROM "user" WHERE id IN (${blocked.map((id) => `'${id}'`).join(", ")}) ORDER BY id FOR UPDATE`,
        );
        locked();
        await released;
      },
      { timeout: 300_000 },
    );
    await isLocked;
    const handle = await productionSweepHandle();
    const queue: import("@ws-model-proxy/db/parent-deletion").UserDeletionSweepQueue = {};
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const tick = () =>
      sweep.sweepPendingUserDeletions({
        prisma: handle.prisma,
        now,
        queue,
        notify: async () => undefined,
      });
    try {
      try {
        await expect(tick()).resolves.toEqual({ deleted: 0, abandoned: 0, failed: 10 });
        expect(await observer.user.count({ where: { id: { in: healthy } } })).toBe(2);
        // Tick 2 continues after the page (then wraps to eight of the ten).
        await expect(tick()).resolves.toEqual({ deleted: 2, abandoned: 0, failed: 8 });
        expect(await observer.user.count({ where: { id: { in: healthy } } })).toBe(0);
        // Every recovery write failed: no backoff was recorded for the ten.
        const recoveryFailures = errors.mock.calls.filter(
          (call) => call[0] === "[auth] user deletion sweep could not record the outcome:",
        );
        expect(recoveryFailures).toHaveLength(18);
        expect(
          await observer.user.count({
            where: {
              id: { in: blocked },
              deletionSweepAttempts: 0,
              deletionSweepNextAttemptAt: null,
            },
          }),
        ).toBe(10);
      } finally {
        release();
        await holding;
      }
      // Released: the next tick reaches all ten (nobody is skipped forever).
      await expect(tick()).resolves.toEqual({ deleted: 10, abandoned: 0, failed: 0 });
      expect(await observer.user.count({ where: { id: { in: ids } } })).toBe(0);
    } finally {
      errors.mockRestore();
      release();
      await handle.prisma.$disconnect();
      await retireMarkedUsers(ids);
    }
  }, 240_000);

  it("G2-01: a short page wraps to the oldest without repeating a user; a lone user is attempted every tick", async () => {
    const { prisma } = required();
    const sweep = await import("../../../../apps/server/src/user-deletion-sweep.js");
    const base = roundRobinWindow();
    const tag = crypto.randomUUID().replaceAll("-", "");
    const users = [];
    for (const [n, letter] of ["a", "b", "c"].entries())
      users.push(await markedAt(`rrwrap${tag}${letter}`, new Date(base + n * 1000)));
    const [a, b, c] = users.map((user) => user.id);
    const now = await roundRobinNow(base, users.length);
    const ids = users.map((user) => user.id);
    const attempted: string[] = [];
    const complete = async (_db: unknown, id: string) => {
      attempted.push(id);
      return false;
    };
    const tick = async (queue: { after?: { requestedAt: Date; userId: string } }, at: Date) => {
      attempted.length = 0;
      await sweep.sweepPendingUserDeletions({ prisma, now: at, complete, queue });
      return [...attempted];
    };
    try {
      const queue: { after?: { requestedAt: Date; userId: string } } = {};
      expect(await tick(queue, now)).toEqual([a, b, c]);
      // Nothing after c: the page wraps, each user once.
      expect(await tick(queue, now)).toEqual([a, b, c]);
      queue.after = { requestedAt: new Date(base), userId: a! };
      expect(await tick(queue, now)).toEqual([b, c, a]);
      expect(queue.after).toEqual({ requestedAt: new Date(base), userId: a });

      // A window older than a, b and c (made after them: `now` below
      // excludes the newer window).
      const lone = roundRobinWindow();
      const loneUser = await markedAt(`rrlone${tag}`, new Date(lone));
      ids.push(loneUser.id);
      const loneNow = await roundRobinNow(lone, 1);
      const loneQueue: { after?: { requestedAt: Date; userId: string } } = {};
      for (let n = 0; n < 3; n++) expect(await tick(loneQueue, loneNow)).toEqual([loneUser.id]);
    } finally {
      await retireMarkedUsers(ids);
    }
  });

  it("G2-01: users marked at the same instant are taken in id order", async () => {
    const { prisma, deletion } = required();
    const base = roundRobinWindow();
    const tag = crypto.randomUUID().replaceAll("-", "");
    const at = new Date(base);
    // Created in reverse: the order is by id, not by insertion.
    const ids = [];
    for (const letter of ["c", "b", "a"]) ids.push((await markedAt(`rreq${tag}${letter}`, at)).id);
    const [c, b, a] = ids;
    const now = await roundRobinNow(base, 1);
    const before = new Date(base + 1000);
    try {
      const first = await deletion.listPendingUserDeletions(prisma, { before, now });
      expect(first.pending.map((entry) => entry.userId)).toEqual([a, b, c]);
      expect(first.next).toEqual({ requestedAt: at, userId: c });
      const second = await deletion.listPendingUserDeletions(prisma, {
        before,
        now,
        after: { requestedAt: at, userId: a! },
      });
      expect(second.pending.map((entry) => entry.userId)).toEqual([b, c, a]);
      expect(second.next).toEqual({ requestedAt: at, userId: a });
    } finally {
      await retireMarkedUsers(ids);
    }
  });

  it.each(["deleted", "abandoned", "re-marked"] as const)(
    "G2-01: a position at a user since %s still continues the round-robin",
    async (change) => {
      const { prisma, deletion } = required();
      const sweep = await import("../../../../apps/server/src/user-deletion-sweep.js");
      const base = roundRobinWindow();
      const tag = crypto.randomUUID().replaceAll("-", "");
      const users = [];
      for (const [n, letter] of ["a", "b", "c"].entries())
        users.push(await markedAt(`rrgone${tag}${letter}`, new Date(base + n * 1000)));
      const [a, b, c] = users;
      const now = await roundRobinNow(base, 4);
      const queue = { after: { requestedAt: new Date(base + 1000), userId: b!.id } };
      let remarked: string | undefined;
      if (change === "deleted") {
        await expect(deletion.completeUserDeletion(prisma, b!.id, b!.generation)).resolves.toBe(
          true,
        );
      } else {
        await expect(deletion.abandonUserDeletion(prisma, b!.id, b!.generation)).resolves.toBe(
          true,
        );
        if (change === "re-marked") {
          const mark = await deletion.requestUserDeletion(prisma, b!.id);
          remarked = mark?.generation;
          // Marked again later: a new key, after c.
          await prisma.user.update({
            where: { id: b!.id },
            data: { deletionRequestedAt: new Date(base + 3000) },
          });
        }
      }
      const attempted: Array<[string, string]> = [];
      try {
        await sweep.sweepPendingUserDeletions({
          prisma,
          now,
          queue,
          complete: async (_db: unknown, id: string, generation: string) => {
            attempted.push([id, generation]);
            return false;
          },
        });
        expect(attempted).toEqual(
          change === "re-marked"
            ? [
                [c!.id, c!.generation],
                [b!.id, remarked],
                [a!.id, a!.generation],
              ]
            : [
                [c!.id, c!.generation],
                [a!.id, a!.generation],
              ],
        );
        expect(remarked).not.toBe(b!.generation);
      } finally {
        await retireMarkedUsers(users.map((user) => user!.id));
      }
    },
  );

  it("G2-01: a user whose backoff has not expired is not selected, not even by the wrap", async () => {
    const { prisma, deletion } = required();
    const base = roundRobinWindow();
    const tag = crypto.randomUUID().replaceAll("-", "");
    const waiting = await markedAt(`rrwait${tag}a`, new Date(base));
    const due = await markedAt(`rrwait${tag}b`, new Date(base + 1000));
    const now = await roundRobinNow(base, 2);
    const before = new Date(base + 2000);
    await prisma.user.update({
      where: { id: waiting.id },
      data: { deletionSweepNextAttemptAt: new Date(now.getTime() + 60_000) },
    });
    try {
      const fromStart = await deletion.listPendingUserDeletions(prisma, { before, now });
      expect(fromStart.pending.map((entry) => entry.userId)).toEqual([due.id]);
      const wrapped = await deletion.listPendingUserDeletions(prisma, {
        before,
        now,
        after: { requestedAt: new Date(base + 1000), userId: due.id },
      });
      expect(wrapped.pending.map((entry) => entry.userId)).toEqual([due.id]);
      // Once expired it is due again.
      const later = await deletion.listPendingUserDeletions(prisma, {
        before,
        now: new Date(now.getTime() + 60_000),
      });
      expect(later.pending.map((entry) => entry.userId)).toEqual([waiting.id, due.id]);
    } finally {
      await retireMarkedUsers([waiting.id, due.id]);
    }
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
    const mark = await deletion.requestUserDeletion(prisma, g.user.id);
    let scans = 0;
    // Each relay scan runs inside its drain batch's transaction; a request
    // arrives (committed on another connection) right before every scan.
    const withArrivals = (tx: object) =>
      new Proxy(tx, {
        get(target, property, receiver) {
          const value: unknown = Reflect.get(target, property, receiver);
          if (property !== "$queryRaw" || typeof value !== "function") return value;
          return async (...args: unknown[]) => {
            const strings = args[0];
            const text = Array.isArray(strings) ? strings.join("?") : "";
            if (text.includes('SELECT id, "createdAt" FROM relay_request')) {
              scans += 1;
              await prisma.relayRequest.create({
                data: {
                  id: `arrival-${g.suffix}-${scans}`,
                  userId: g.user.id,
                  status: "SUCCEEDED",
                  createdAt: new Date(Date.UTC(2026, 1, 1) + scans * 1000),
                },
              });
            }
            return Reflect.apply(value, target, args);
          };
        },
      });
    const producer = new Proxy(prisma, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (property !== "$transaction" || typeof value !== "function") return value;
        return (work: unknown, ...rest: unknown[]) =>
          Reflect.apply(value, target, [
            typeof work === "function" ? (tx: object) => work(withArrivals(tx)) : work,
            ...rest,
          ]);
      },
    });
    const { ParentDeletionDrainPendingError } = await import("@ws-model-proxy/db/parent-deletion");
    await expect(
      deletion.drainParentDeletionHistory(producer, parents, {
        batch: 1,
        maxRowsPerRun: 6,
        maxLoopIterations: 50,
        owner: { userId: g.user.id, generation: mark!.generation },
      }),
    ).rejects.toBeInstanceOf(ParentDeletionDrainPendingError);
  });

  // F2-07 remainder: a DELETE whose ON DELETE CASCADE waits on several locked
  // rows in turn outlasts any single `lock_timeout`, so the batch's
  // `statement_timeout` is what bounds it; on the sweep's own client the
  // connection-level `statement_timeout` bounds every other tick statement.
  it("four sub-lock-timeout cascade waits are stopped by the statement bound, not the lock bound (F2-07)", async () => {
    const { prisma, deletion, order, fence, deadline, timeouts } = required();
    const g = await graph("multiwait");
    const relay = await prisma.relayRequest.create({
      data: { id: `${g.suffix}-multiwait`, userId: g.user.id, status: "SUCCEEDED" },
    });
    // Four execution events of the terminal relay row, each held by another
    // transaction. A DELETE that cascades into them waits once per row.
    const events = await Promise.all(
      [0, 1, 2, 3].map((index) =>
        prisma.relayExecutionEvent.create({
          data: {
            userId: g.user.id,
            relayRequestId: relay.id,
            attemptId: `${g.suffix}-attempt-${index}`,
            eventType: "ATTEMPT_STARTED",
            requestedSurface: "OPENAI_CHAT_COMPLETIONS",
          },
        }),
      ),
    );
    const holders = await Promise.all(
      events.map((event) =>
        holdRowLock(`SELECT id FROM relay_execution_event WHERE id = '${event.id}' FOR UPDATE`),
      ),
    );
    // Release each held row 1.45 s after the DELETE is confirmed to be
    // waiting on that holder, so the DB sees four sequential waits each
    // below the 2 s lock timeout: their sum (5.8 s) exceeds the 3 s
    // statement bound, so only the statement bound stops the batch (a
    // `lock_timeout`-only batch waits all 5.8 s and then succeeds, which the
    // outcome and the upper bound below both reject).
    const started = Date.now();
    const batchStarted = settle(
      deletion.runParentDeletionDrainBatch(prisma, undefined, (tx) =>
        order.deleteTerminalRelayRequestsWithoutWaiting(tx, [relay.id]),
      ),
    );
    const released = batchStarted.then(() => null);
    const holderByPid = new Map(holders.map((holder) => [holder.pid, holder]));
    const releasing = (async () => {
      const remaining = new Set(holderByPid.keys());
      while (remaining.size > 0) {
        // Release each holder the DELETE is actually waiting on 1.45 s after
        // the wait starts, so every individual wait stays below the 2 s lock
        // timeout while the running total passes the 3 s statement bound.
        // Racing the batch's own completion stops the loop once the
        // statement timeout cancels the DELETE (the later holders then never
        // block, so a wait keyed only on blockers would hang).
        const pid = await Promise.race([
          waitForBlocker("DELETE FROM relay_request", remaining, 20_000).catch(() => null),
          released,
        ]);
        if (pid === null) return;
        await sleep(1_450);
        await holderByPid.get(pid)!.release();
        remaining.delete(pid);
      }
    })();
    const outcome = await batchStarted;
    const elapsed = Date.now() - started;
    try {
      // A statement bound, not a single lock wait: the batch is cancelled at
      // the statement bound (R2-17-5: a 55P03 after one 2 s wait would end
      // near 2 s, so it cannot pass this), well below the join deadline.
      expect(elapsed).toBeGreaterThanOrEqual(
        deletion.PARENT_DELETION_DRAIN_STATEMENT_TIMEOUT_MS - 100,
      );
      expect(elapsed).toBeLessThan(deletion.PARENT_DELETION_DRAIN_STATEMENT_TIMEOUT_MS + 1_000);
      expect(elapsed).toBeLessThan(timeouts.USER_DELETION_SWEEP_JOIN_TIMEOUT_MS);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("the batch was not stopped");
      expect(outcome.error).toBeInstanceOf(deletion.ParentDeletionDrainPendingError);
      // The whole batch rolled back: the relay row and every event survive.
      expect(await prisma.relayRequest.count({ where: { id: relay.id } })).toBe(1);
      expect(await prisma.relayExecutionEvent.count({ where: { relayRequestId: relay.id } })).toBe(
        4,
      );
    } finally {
      await releasing;
      for (const holder of holders) await holder.release();
    }

    // The same contention, driven through the production sweep on its
    // production client (fenced, statement-bounded) and the real shutdown
    // order (stop, arm the fence, bounded join, disconnect; R2-17-4): the join
    // finishes before its deadline, `$disconnect` is quick, and the marker,
    // relay row and events are unchanged. The fence refuses the backoff write
    // that follows the cancelled batch, so the attempt count stays 0 (the
    // state production reaches); a later sweep then completes the delete.
    // The marker is backdated past the sweep's grace period (its own tick
    // skips younger markers).
    const mark = await deletion.requestUserDeletion(prisma, g.user.id);
    await prisma.user.update({
      where: { id: g.user.id },
      data: { deletionRequestedAt: new Date(0) },
    });
    await hideOtherMarkers([g.user.id]);
    const waiters = await Promise.all(
      events.map((event) =>
        holdRowLock(`SELECT id FROM relay_execution_event WHERE id = '${event.id}' FOR UPDATE`),
      ),
    );
    const worker = await productionSweepClient();
    let stop: (() => Promise<void>) | undefined;
    let stopped = false;
    const warnings: string[] = [];
    // Releases are keyed on the holder the tick's DELETE is actually waiting
    // on (each 1.45 s, below the 2 s lock timeout). Once the statement bound
    // cancels the DELETE the wait ends, and `stopSettled` (the join's own
    // signal) ends this loop: the later holders' rows are simply no longer
    // contended, so waiting for them to block would hang.
    const waiterByPid = new Map(waiters.map((holder) => [holder.pid, holder]));
    const waiterPids = new Set(waiterByPid.keys());
    let signalStop!: () => void;
    const stopSettled = new Promise<void>((resolve) => {
      signalStop = resolve;
    });
    const releaseWorkers = (async () => {
      const remaining = new Set(waiterPids);
      while (remaining.size > 0) {
        const pid = await Promise.race([
          waitForBlocker("DELETE FROM relay_request", remaining, 20_000).catch(() => null),
          stopSettled.then(() => null),
        ]);
        if (pid === null) return;
        await sleep(1_450);
        await waiterByPid.get(pid)!.release();
        remaining.delete(pid);
      }
    })();
    try {
      stop = await startSweep(worker);
      // The sweep's terminal-relay DELETE must be waiting on the held rows
      // BEFORE the fence arms: the fence stops a NEW statement starting, so
      // arming it before the DELETE would leave the tick to finish between
      // statements and never exercise an in-flight statement.
      await waitForBlocker(
        "DELETE FROM relay_request",
        waiterPids,
        timeouts.USER_DELETION_SWEEP_JOIN_TIMEOUT_MS + 10_000,
      );
      const joinStart = Date.now();
      const stopping = stop().then(() => {
        stopped = true;
        signalStop();
      });
      fence.armDbShutdownFence();
      await deadline.runWithDeadline(
        () => stopping,
        timeouts.USER_DELETION_SWEEP_JOIN_TIMEOUT_MS,
        "test join",
        { warn: (message) => warnings.push(message) },
      );
      expect(stopped).toBe(true);
      expect(warnings).toEqual([]);
      // One statement bound plus the rollback margin: a `lock_timeout`-only
      // DELETE would wait all four holders (5.8 s).
      expect(Date.now() - joinStart).toBeLessThan(
        deletion.PARENT_DELETION_DRAIN_STATEMENT_TIMEOUT_MS +
          timeouts.USER_DELETION_SWEEP_ROLLBACK_MARGIN_MS,
      );
      expect(Date.now() - joinStart).toBeLessThan(timeouts.USER_DELETION_SWEEP_JOIN_TIMEOUT_MS);
      const disconnectStart = Date.now();
      await worker.$disconnect();
      expect(Date.now() - disconnectStart).toBeLessThan(1_000);
    } finally {
      fence.disarmDbShutdownFence();
      signalStop();
      await releaseWorkers;
      for (const holder of waiters) await holder.release();
      await stop?.();
    }
    const src = await prisma.user.findUniqueOrThrow({
      where: { id: g.user.id },
      select: { deletionGeneration: true, deletionSweepAttempts: true },
    });
    expect(src.deletionGeneration).toBe(mark!.generation);
    expect(src.deletionSweepAttempts).toBe(0);
    expect(await prisma.relayRequest.count({ where: { id: relay.id } })).toBe(1);
    expect(await prisma.relayExecutionEvent.count({ where: { relayRequestId: relay.id } })).toBe(4);
    // The next process's sweep finishes the delete.
    await expect(sweepOnce()).resolves.toMatchObject({ deleted: 1 });
    expect(await prisma.user.count({ where: { id: g.user.id } })).toBe(0);
    expect(await prisma.relayExecutionEvent.count({ where: { relayRequestId: relay.id } })).toBe(0);
  }, 60_000);

  // F2-07: SQLSTATE 57014 (statement timeout) must map to the recoverable
  // pending error exactly like 55P03, so a slow cascade answers `delete_pending`
  // rather than failing as a 500, and a user is never abandoned for it.
  it("a statement timeout (57014) becomes pending like a lock timeout (F2-07)", async () => {
    const { prisma, deletion, order, forwarder } = required();

    // (1) A statement that runs past the batch's statement bound with no
    // single lock wait reaching the lock bound: the real server cancels it
    // with 57014, and the batch reports pending rather than throwing the raw
    // Prisma error.
    await expect(
      deletion.runParentDeletionDrainBatch(prisma, undefined, async (tx) => {
        await tx.$executeRawUnsafe(
          `SELECT pg_sleep(${deletion.PARENT_DELETION_DRAIN_STATEMENT_TIMEOUT_MS / 1000 + 2})`,
        );
      }),
    ).rejects.toBeInstanceOf(deletion.ParentDeletionDrainPendingError);

    // (2) A single DELETE whose ON DELETE CASCADE waits on several locked
    // rows in turn: five waits each below the 2 s lock timeout sum past the
    // 3 s statement timeout, so the cascade is cancelled with 57014 and the
    // batch reports pending (the row and its events survive the rollback).
    const g = await graph("cascade-timeout");
    const relay = await prisma.relayRequest.create({
      data: { id: `${g.suffix}-cascade`, userId: g.user.id, status: "SUCCEEDED" },
    });
    const events = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        prisma.relayExecutionEvent.create({
          data: {
            userId: g.user.id,
            relayRequestId: relay.id,
            attemptId: `${g.suffix}-cascade-${index}`,
            eventType: "ATTEMPT_STARTED",
            requestedSurface: "OPENAI_CHAT_COMPLETIONS",
          },
        }),
      ),
    );
    const holders = await Promise.all(
      events.map((event) =>
        holdRowLock(`SELECT id FROM relay_execution_event WHERE id = '${event.id}' FOR UPDATE`),
      ),
    );
    // Release, 1 s after the cascade starts waiting on it, whichever holder
    // pg_blocking_pids() reports for the cascade backend: each wait stays
    // under the lock timeout while the running total passes the statement
    // timeout. The cascade visits the rows in heap order, not creation order,
    // so a fixed release order could leave it waiting 2 s on one row and end
    // it with 55P03 instead (g2-T1).
    const cascadeStarted = Date.now();
    const cascade = settle(
      deletion.runParentDeletionDrainBatch(prisma, undefined, (tx) =>
        order.deleteTerminalRelayRequestsWithoutWaiting(tx, [relay.id]),
      ),
    );
    const cascadeSettled = cascade.then(() => null);
    const holderByPid = new Map(holders.map((holder) => [holder.pid, holder]));
    const releasing = (async () => {
      const remaining = new Set(holderByPid.keys());
      while (remaining.size > 0) {
        // Racing the batch stops the loop once the statement timeout cancels
        // the DELETE (the later holders then never block).
        const pid = await Promise.race([
          waitForBlocker("DELETE FROM relay_request", remaining, 20_000).catch(() => null),
          cascadeSettled,
        ]);
        if (pid === null) return;
        await sleep(1_000);
        await holderByPid.get(pid)!.release();
        remaining.delete(pid);
      }
    })();
    try {
      const outcome = await cascade;
      const cascadeMs = Date.now() - cascadeStarted;
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("the cascade was not stopped");
      expect(outcome.error).toBeInstanceOf(deletion.ParentDeletionDrainPendingError);
      // Cancelled by the statement bound (R2-17-5), not a 2 s lock wait.
      expect(cascadeMs).toBeGreaterThanOrEqual(
        deletion.PARENT_DELETION_DRAIN_STATEMENT_TIMEOUT_MS - 100,
      );
      expect(cascadeMs).toBeLessThan(deletion.PARENT_DELETION_DRAIN_STATEMENT_TIMEOUT_MS + 1_000);
    } finally {
      await releasing;
      for (const holder of holders) await holder.release();
    }
    expect(await prisma.relayRequest.count({ where: { id: relay.id } })).toBe(1);
    expect(await prisma.relayExecutionEvent.count({ where: { relayRequestId: relay.id } })).toBe(5);

    // (3) The pending error's route mapping, not a 57014: a non-user parent
    // delete whose drain reports pending (here through the residual bound,
    // which raises the same ParentDeletionDrainPendingError that (1) and (2)
    // show a 57014 becomes) answers CONFLICT with data.reason
    // "delete_pending", leaving the pool intact.
    const pool = await graph("pending-pool");
    const over = deletion.PARENT_DELETION_MAX_FINAL_PHASE_RESIDUAL_ROWS + 1;
    await prisma.$executeRawUnsafe(
      `INSERT INTO relay_request (id, "userId", status, "requestedModelPoolId")
       SELECT '${pool.suffix}-live-' || n, '${pool.user.id}', 'PENDING', '${pool.pool.id}'
         FROM generate_series(1, ${over}) n`,
    );
    const client = createRouterClient(forwarder.forwarderManagementRouter, {
      context: sessionFor(pool.user),
    });
    await expect(client.deleteModelPool({ id: pool.pool.id })).rejects.toMatchObject({
      code: "CONFLICT",
      data: { reason: "delete_pending" },
    });
    expect(await prisma.modelPool.count({ where: { id: pool.pool.id } })).toBe(1);
  }, 30_000);

  // ---------------------------------------------------------------------------
  // F2-07 (design A): every statement of a sweep tick runs on the sweep's own
  // client, whose connections carry a server-side statement_timeout, so the
  // tick in flight at shutdown settles inside the join whatever statement it
  // is blocked in. Each schedule blocks a statement outside the drain batches
  // (the backoff write, the abandon write, the queue read) and runs the
  // production shutdown order: stop, arm the fence, bounded join, disconnect.
  // Holders release on a timer past the join so a regression fails the
  // assertions instead of hanging the disconnect.
  // ---------------------------------------------------------------------------

  /** Keeps the sweep's queue to `keep`: other marked users become not due. */
  async function hideOtherMarkers(keep: string[]) {
    await required().observer.user.updateMany({
      where: { deletionRequestedAt: { not: null }, id: { notIn: keep } },
      data: { deletionSweepNextAttemptAt: new Date("2099-01-01T00:00:00.000Z") },
    });
  }

  /** One production sweep tick on a fresh production sweep client (a restart). */
  async function sweepOnce() {
    const sweep = await import("../../../../apps/server/src/user-deletion-sweep.js");
    const client = sweep.createUserDeletionSweepClient(databaseUrl!).prisma;
    try {
      return await sweep.sweepPendingUserDeletions({
        prisma: client,
        notify: async () => undefined,
      });
    } finally {
      await client.$disconnect();
    }
  }

  /** A user marked for deletion, backdated past the sweep's grace period. */
  async function markedUser(tag: string, at = new Date(0)) {
    const { prisma, deletion } = required();
    const id = `pd-${tag}-${crypto.randomUUID()}`;
    await prisma.user.create({
      data: { id, name: tag, email: `${id}@example.test`, slug: id, emailVerified: true },
    });
    const mark = await deletion.requestUserDeletion(prisma, id);
    if (!mark) throw new Error("mark failed");
    await prisma.user.update({ where: { id }, data: { deletionRequestedAt: at } });
    return { id, generation: mark.generation };
  }

  /**
   * Waits until a statement containing `fragment` is blocked by `holderPid`
   * and returns that backend's application_name: the sweep's statements must
   * run on the sweep's own client, never the shared one.
   */
  async function waitForSweepWaiter(fragment: string, holderPid: number, timeoutMs = 15_000) {
    const observer = required().observer;
    const started = Date.now();
    for (;;) {
      const rows = await observer.$queryRaw<Array<{ application_name: string }>>`
        SELECT application_name FROM pg_stat_activity
         WHERE datname = current_database()
           AND wait_event_type = 'Lock'
           AND query LIKE ${`%${fragment}%`}
           AND ${holderPid}::int = ANY(pg_blocking_pids(pid))`;
      if (rows[0]) return rows[0].application_name;
      if (Date.now() - started > timeoutMs)
        throw new Error(`no ${fragment} waiter blocked by ${holderPid} within ${timeoutMs} ms`);
      await sleep(10);
    }
  }

  /**
   * The production shutdown order around a started sweep on `handle`: stop
   * (index.ts `stopPeriodicJobs`), arm the fence (`closeMcpHandler`), then
   * the production sweep shutdown (`shutDownUserDeletionSweep`, called from
   * index.ts `disconnectPrisma`): join bounded, quarantine if the join ran
   * out, disconnect bounded.
   */
  async function shutDownSweep(label: string, stop: () => Promise<void>, handle: SweepHandle) {
    const { fence } = required();
    const sweep = await import("../../../../apps/server/src/user-deletion-sweep.js");
    const warnings: string[] = [];
    let stoppedAt: number | undefined;
    let joinDeadlineAt: number | undefined;
    const start = Date.now();
    const stopping = stop().then(() => {
      stoppedAt = Date.now();
    });
    fence.armDbShutdownFence();
    const outcome = await sweep.shutDownUserDeletionSweep({
      stopped: () => stopping,
      client: handle,
      warn: (message) => {
        warnings.push(message);
        if (message.includes("user deletion sweep join")) joinDeadlineAt = Date.now();
      },
    });
    const totalMs = Date.now() - start;
    // The join phase ends when the tick settled, or at its deadline.
    const joinEnd = outcome.joined ? stoppedAt : joinDeadlineAt;
    const joinMs = joinEnd === undefined ? totalMs : joinEnd - start;
    const disconnectMs = totalMs - joinMs;
    report(
      `shutdown with ${label} blocked: join ${joinMs} ms (settled ${outcome.joined}), quarantined ${outcome.quarantined}, total ${totalMs} ms`,
    );
    return {
      joinMs,
      stoppedAtJoin: outcome.joined,
      warnings,
      disconnectMs,
      totalMs,
      outcome,
      stopping,
    };
  }

  /**
   * The join settled, within `boundMs`: by default one statement bound plus
   * the rollback margin (the statement in flight at the fence; the sweep's
   * client dispatches nothing after it); a connect in flight at the fence is
   * the alternative remainder (connect bound plus margin).
   */
  function expectSettledInsideJoin(
    result: Awaited<ReturnType<typeof shutDownSweep>>,
    boundMs = required().timeouts.USER_DELETION_SWEEP_STATEMENT_TIMEOUT_MS +
      required().timeouts.USER_DELETION_SWEEP_ROLLBACK_MARGIN_MS,
  ) {
    const { timeouts } = required();
    expect(result.stoppedAtJoin).toBe(true);
    expect(result.warnings).toEqual([]);
    // Settled in time: no quarantine, a graceful disconnect.
    expect(result.outcome).toEqual({ joined: true, quarantined: null, disconnected: true });
    expect(result.joinMs).toBeLessThan(boundMs);
    // Inside the join with the rollback margin to spare.
    expect(result.joinMs).toBeLessThan(
      timeouts.USER_DELETION_SWEEP_JOIN_TIMEOUT_MS -
        timeouts.USER_DELETION_SWEEP_ROLLBACK_MARGIN_MS,
    );
    expect(result.disconnectMs).toBeLessThan(1_000);
  }

  async function deletionState(userId: string) {
    return required().prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        deletionRequestedAt: true,
        deletionGeneration: true,
        deletionSweepAttempts: true,
        deletionSweepNextAttemptAt: true,
        banned: true,
        banReason: true,
      },
    });
  }

  it("the production sweep client carries the statement bound on every connection (F2-07)", async () => {
    const { timeouts } = required();
    const sweep = await import("../../../../apps/server/src/user-deletion-sweep.js");
    const client = sweep.createUserDeletionSweepClient(databaseUrl!).prisma;
    try {
      const [shown] = await client.$queryRaw<
        Array<{ statement_timeout: string; application_name: string }>
      >`SELECT current_setting('statement_timeout') AS statement_timeout,
               current_setting('application_name') AS application_name`;
      expect(shown).toEqual({
        statement_timeout: `${timeouts.USER_DELETION_SWEEP_STATEMENT_TIMEOUT_MS / 1000}s`,
        application_name: sweep.USER_DELETION_SWEEP_APPLICATION_NAME,
      });
      // Inside an interactive transaction too (the ordered final delete).
      const inside = await client.$transaction(
        (tx) =>
          tx.$queryRaw<Array<{ s: string }>>`SELECT current_setting('statement_timeout') AS s`,
      );
      expect(inside).toEqual([
        { s: `${timeouts.USER_DELETION_SWEEP_STATEMENT_TIMEOUT_MS / 1000}s` },
      ]);
      // The shared client is untouched: request paths keep their behavior.
      const [shared] = await required().prisma.$queryRaw<Array<{ s: string }>>`
        SELECT current_setting('statement_timeout') AS s`;
      expect(shared).toEqual({ s: "0" });
    } finally {
      await client.$disconnect();
    }
  });

  // R1-18-1: the sweep's client is built from the deployment's DATABASE_URL,
  // whose parameters node-postgres merges over the ones the factory passes.
  // The bound and the name must hold on every connection whatever the URL
  // says (plain parameters, the `options=-c` form, or a larger value).
  it.each([
    [
      "statement_timeout and application_name parameters",
      { statement_timeout: "0", application_name: "deployment-name" },
      { s: "0", a: "deployment-name" },
    ],
    [
      "the options -c form",
      { options: "-c statement_timeout=0 -c application_name=deployment-name" },
      { s: "0", a: "deployment-name" },
    ],
    ["a larger statement_timeout", { statement_timeout: "600000" }, { s: "10min", a: "" }],
  ])(
    "the sweep client keeps its statement bound and name over a DATABASE_URL with %s (R1-18-1)",
    async (_label, params, plainSees) => {
      const { timeouts, clientFactory } = required();
      const sweep = await import("../../../../apps/server/src/user-deletion-sweep.js");
      const url = new URL(databaseUrl!);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      type Shown = { pid: number; s: string; a: string };
      // The URL really overrides a plain client's settings (the probe is live).
      const plain = clientFactory.createPrismaClient(url.toString());
      try {
        const [shown] = await plain.$queryRaw<Shown[]>`
          SELECT current_setting('statement_timeout') AS s,
                 current_setting('application_name') AS a`;
        expect(shown).toEqual(plainSees);
      } finally {
        await plain.$disconnect();
      }
      const client = sweep.createUserDeletionSweepClient(url.toString()).prisma;
      const expected = `${timeouts.USER_DELETION_SWEEP_STATEMENT_TIMEOUT_MS / 1000}s`;
      try {
        // Two connections at once: the transaction holds the first, so the
        // plain read opens the second (each new connection is checked).
        const [inside, outside] = await Promise.all([
          client.$transaction(async (tx) => {
            const [row] = await tx.$queryRaw<Shown[]>`
              SELECT pg_backend_pid() AS pid, current_setting('statement_timeout') AS s,
                     current_setting('application_name') AS a`;
            await sleep(400);
            return row!;
          }),
          sleep(100).then(async () => {
            const [row] = await client.$queryRaw<Shown[]>`
              SELECT pg_backend_pid() AS pid, current_setting('statement_timeout') AS s,
                     current_setting('application_name') AS a`;
            return row!;
          }),
        ]);
        expect(Number(inside.pid)).not.toBe(Number(outside.pid));
        for (const row of [inside, outside]) {
          expect({ s: row.s, a: row.a }).toEqual({
            s: expected,
            a: sweep.USER_DELETION_SWEEP_APPLICATION_NAME,
          });
        }
        // And the bound really cuts a long statement off.
        const started = Date.now();
        await expect(client.$queryRaw`SELECT pg_sleep(10)`).rejects.toThrow();
        const elapsed = Date.now() - started;
        expect(elapsed).toBeGreaterThanOrEqual(
          timeouts.USER_DELETION_SWEEP_STATEMENT_TIMEOUT_MS - 100,
        );
        expect(elapsed).toBeLessThan(timeouts.USER_DELETION_SWEEP_STATEMENT_TIMEOUT_MS + 1_500);
      } finally {
        await client.$disconnect();
      }
    },
    60_000,
  );

  // ---------------------------------------------------------------------------
  // F2-07d: the sweep keeps its connection between ticks (the tick interval is
  // far longer than pg-pool's default 10 s idle timeout) and tolerates a slow
  // cold connect (a remote TLS + SCRAM handshake), while that connect stays
  // inside the shutdown join.
  // ---------------------------------------------------------------------------

  /** pg-pool's default `idleTimeoutMillis` (pg-pool index.js). */
  const PG_POOL_DEFAULT_IDLE_MS = 10_000;

  /**
   * A loopback TCP proxy to the test database that holds every new
   * connection for `delayMs` before connecting it upstream: the client's
   * startup (and so its connect) takes at least that long, like a slow remote
   * handshake. Returns a connection string through it.
   */
  async function delayingProxy(delayMs: number) {
    const upstream = new URL(databaseUrl!);
    const sockets = new Set<Socket>();
    const track = (socket: Socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => socket.destroy());
    };
    let accepted = 0;
    const server = createServer((downstream) => {
      accepted += 1;
      track(downstream);
      downstream.pause();
      const timer = setTimeout(() => {
        if (downstream.destroyed) return;
        const up = connect(Number(upstream.port || 5432), upstream.hostname);
        track(up);
        up.on("close", () => downstream.destroy());
        downstream.on("close", () => up.destroy());
        downstream.pipe(up);
        up.pipe(downstream);
        downstream.resume();
      }, delayMs);
      downstream.on("close", () => clearTimeout(timer));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no proxy port");
    const url = new URL(databaseUrl!);
    url.hostname = "127.0.0.1";
    url.port = String(address.port);
    return {
      url: url.toString(),
      /** Client connections the proxy has accepted so far. */
      accepted: () => accepted,
      close: async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }

  /** Backends of the sweep's `application_name`, excluding `except`. */
  async function sweepBackends(except: ReadonlySet<number> = new Set()) {
    const sweep = await import("../../../../apps/server/src/user-deletion-sweep.js");
    const rows = await required().observer.$queryRaw<Array<{ pid: number }>>`
      SELECT pid FROM pg_stat_activity
       WHERE datname = current_database()
         AND application_name = ${sweep.USER_DELETION_SWEEP_APPLICATION_NAME}`;
    return rows
      .map((row) => Number(row.pid))
      .filter((pid) => !except.has(pid))
      .sort((a, b) => a - b);
  }

  it("the sweep client keeps its connection across ticks longer apart than pg-pool's idle timeout, and recovers when the server closes it (F2-07d)", async () => {
    const sweep = await import("../../../../apps/server/src/user-deletion-sweep.js");
    await hideOtherMarkers([]);
    const before = new Set(await sweepBackends());
    const client = sweep.createUserDeletionSweepClient(databaseUrl!).prisma;
    const tick = () =>
      sweep.sweepPendingUserDeletions({ prisma: client, notify: async () => undefined });
    const backendPid = async () => {
      const [row] = await client.$queryRaw<Array<{ pid: number }>>`
          SELECT pg_backend_pid() AS pid`;
      return Number(row!.pid);
    };
    try {
      await expect(tick()).resolves.toEqual({ deleted: 0, abandoned: 0, failed: 0 });
      const held = await backendPid();
      expect(await sweepBackends(before)).toEqual([held]);
      // Longer than pg-pool's default idle timeout (the 5-minute interval
      // exceeds it by far): the connection is still open, and the next tick
      // runs on it without connecting.
      await sleep(PG_POOL_DEFAULT_IDLE_MS + 1_500);
      expect(await sweepBackends(before)).toEqual([held]);
      await expect(tick()).resolves.toEqual({ deleted: 0, abandoned: 0, failed: 0 });
      expect(await backendPid()).toBe(held);
      report(`sweep tick after ${PG_POOL_DEFAULT_IDLE_MS + 1_500} ms idle reused backend ${held}`);

      // Inverse: the server (or a proxy) closes the held connection. The
      // pool drops it, and the next tick connects again and succeeds.
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        await required().observer.$queryRaw`SELECT pg_terminate_backend(${held}::int)`;
        const started = Date.now();
        while ((await sweepBackends(before)).includes(held)) {
          if (Date.now() - started > 5_000) throw new Error("backend not terminated");
          await sleep(20);
        }
        await sleep(100);
        await expect(tick()).resolves.toEqual({ deleted: 0, abandoned: 0, failed: 0 });
      } finally {
        errors.mockRestore();
      }
      const replacement = await backendPid();
      expect(replacement).not.toBe(held);
      expect(await sweepBackends(before)).toEqual([replacement]);
    } finally {
      await client.$disconnect();
    }
  }, 60_000);

  it("a sweep tick survives a cold connect slower than 500 ms but inside the connect bound (F2-07d)", async () => {
    const sweep = await import("../../../../apps/server/src/user-deletion-sweep.js");
    await hideOtherMarkers([]);
    // A slow remote handshake: well above the old 500 ms bound, well inside
    // the connect bound (shutdown-timeouts.test.ts pins it at 2 s or more).
    const delayMs = 1_500;
    const proxy = await delayingProxy(delayMs);
    const client = sweep.createUserDeletionSweepClient(proxy.url).prisma;
    try {
      const started = Date.now();
      await expect(
        sweep.sweepPendingUserDeletions({ prisma: client, notify: async () => undefined }),
      ).resolves.toEqual({ deleted: 0, abandoned: 0, failed: 0 });
      const elapsed = Date.now() - started;
      report(`sweep tick with a ${delayMs} ms connect took ${elapsed} ms`);
      expect(elapsed).toBeGreaterThanOrEqual(delayMs);
    } finally {
      await client.$disconnect();
      await proxy.close();
    }
  }, 30_000);

  it("a connect slower than the connect bound fails the tick within that bound (F2-07d inverse)", async () => {
    const { timeouts } = required();
    const sweep = await import("../../../../apps/server/src/user-deletion-sweep.js");
    const proxy = await delayingProxy(timeouts.USER_DELETION_SWEEP_CONNECT_TIMEOUT_MS + 5_000);
    const client = sweep.createUserDeletionSweepClient(proxy.url).prisma;
    try {
      const started = Date.now();
      await expect(
        sweep.sweepPendingUserDeletions({ prisma: client, notify: async () => undefined }),
      ).rejects.toThrow();
      const elapsed = Date.now() - started;
      report(`sweep tick with a hung connect failed after ${elapsed} ms`);
      expect(elapsed).toBeGreaterThanOrEqual(timeouts.USER_DELETION_SWEEP_CONNECT_TIMEOUT_MS - 50);
      expect(elapsed).toBeLessThan(timeouts.USER_DELETION_SWEEP_CONNECT_TIMEOUT_MS + 1_000);
    } finally {
      await client.$disconnect();
      await proxy.close();
    }
  }, 30_000);

  /**
   * Records, until stopped, every backend of the sweep's `application_name`
   * (other than `except`) with its current or last statement and the pids
   * blocking it: what the sweep's client dispatched while it ran.
   */
  function watchSweepActivity(except: ReadonlySet<number> = new Set()) {
    type Seen = { pid: number; query: string; blockedBy: number[] };
    const seen: Seen[] = [];
    let watching = true;
    const done = (async () => {
      const sweep = await import("../../../../apps/server/src/user-deletion-sweep.js");
      while (watching) {
        const rows = await required().observer.$queryRaw<
          Array<{ pid: number; query: string; blocked_by: number[] }>
        >`
          SELECT pid, query, pg_blocking_pids(pid) AS blocked_by FROM pg_stat_activity
           WHERE datname = current_database()
             AND application_name = ${sweep.USER_DELETION_SWEEP_APPLICATION_NAME}`;
        for (const row of rows) {
          if (except.has(Number(row.pid))) continue;
          seen.push({
            pid: Number(row.pid),
            query: row.query,
            blockedBy: row.blocked_by.map(Number),
          });
        }
        await sleep(10);
      }
    })();
    return {
      stop: async () => {
        watching = false;
        await done;
        return seen;
      },
    };
  }

  it("a connect in flight when the fence arms runs to completion, and its connection then dispatches nothing (F2-07e)", async () => {
    const { timeouts } = required();
    const user = await markedUser("cold-blocked-queue");
    await hideOtherMarkers([user.id]);
    const connectMs = timeouts.USER_DELETION_SWEEP_CONNECT_TIMEOUT_MS - 500;
    const proxy = await delayingProxy(connectMs);
    // A queue read dispatched after the connect would block here, visibly.
    const held = await holdRowLock(`LOCK TABLE "user" IN ACCESS EXCLUSIVE MODE`);
    let releasing: Promise<void> = Promise.resolve();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const before = new Set(await sweepBackends());
    const watch = watchSweepActivity(before);
    const sweep = await import("../../../../apps/server/src/user-deletion-sweep.js");
    const handle = sweep.createUserDeletionSweepClient(proxy.url);
    const client = handle.prisma;
    const stop = await startSweep(client);
    let seen: Awaited<ReturnType<typeof watch.stop>> = [];
    try {
      // The tick's queue read passed the method fence and its connection is
      // being opened (the proxy holds it) when shutdown arms the fence.
      const started = Date.now();
      while (proxy.accepted() === 0) {
        if (Date.now() - started > 5_000) throw new Error("the sweep never connected");
        await sleep(5);
      }
      const connectingSince = Date.now();
      const result = await shutDownSweep("connect in flight", stop, handle);
      releasing = sleep(1_000).then(() => held.release());
      await sleep(200);
      seen = await watch.stop();
      // The connect was not cut short: it ran on to the proxy's delay.
      expect(Date.now() - connectingSince).toBeGreaterThanOrEqual(connectMs - 100);
      // Then nothing followed it: the connect is the whole remainder.
      expectSettledInsideJoin(
        result,
        timeouts.USER_DELETION_SWEEP_CONNECT_TIMEOUT_MS +
          timeouts.USER_DELETION_SWEEP_ROLLBACK_MARGIN_MS,
      );
      // No statement at all reached the new connection: neither the session
      // settings nor the queue read (which would wait on the held table).
      expect(seen.filter((row) => row.query !== "")).toEqual([]);
      expect(seen.filter((row) => row.blockedBy.includes(held.pid))).toEqual([]);
      // A shutdown stop, not a failed tick.
      expect(errors).not.toHaveBeenCalledWith(
        "[auth] user deletion sweep failed:",
        expect.anything(),
      );
      expect(logs).toHaveBeenCalledWith(expect.stringContaining("stopped by shutdown"));
    } finally {
      await watch.stop();
      required().fence.disarmDbShutdownFence();
      errors.mockRestore();
      logs.mockRestore();
      await releasing;
      await held.release();
      await stop();
      await proxy.close();
    }
    report(
      `connect in flight at the fence: ${seen.length} sweep backend samples, none with a statement`,
    );
    const after = await deletionState(user.id);
    expect(after.deletionGeneration).toBe(user.generation);
    expect(after.deletionSweepAttempts).toBe(0);
    expect(after.deletionSweepNextAttemptAt).toBeNull();
    await expect(sweepOnce()).resolves.toMatchObject({ deleted: 1 });
  }, 60_000);

  it("a sweep backoff write blocked on the user row settles inside the shutdown join (F2-07)", async () => {
    const { timeouts } = required();
    const user = await markedUser("blocked-backoff");
    await hideOtherMarkers([user.id]);
    // The owner FOR SHARE of the first batch waits 2 s (lock_timeout) and the
    // tick reports pending; its backoff UPDATE then waits on the same row.
    const held = await holdRowLock(
      `SELECT id FROM "user" WHERE id = '${user.id}' FOR NO KEY UPDATE`,
    );
    // Released only after the join deadline has passed, counted from when the
    // blocked statement is observed (just before the join starts), so a
    // regression overruns the join instead of being rescued by the release.
    let releasing: Promise<void> = Promise.resolve();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const handle = await productionSweepHandle();
    const client = handle.prisma;
    const stop = await startSweep(client);
    try {
      const applicationName = await waitForSweepWaiter(
        '"deletionSweepAttempts" = "deletionSweepAttempts" + 1',
        held.pid,
      );
      releasing = sleep(timeouts.USER_DELETION_SWEEP_JOIN_TIMEOUT_MS + 1_500).then(() =>
        held.release(),
      );
      const sweep = await import("../../../../apps/server/src/user-deletion-sweep.js");
      expect(applicationName).toBe(sweep.USER_DELETION_SWEEP_APPLICATION_NAME);
      const result = await shutDownSweep("backoff write", stop, handle);
      // The write was cancelled at the statement bound (it was in flight when
      // the fence armed, so it ran until then) and rolled back.
      expect(result.joinMs).toBeGreaterThanOrEqual(
        timeouts.USER_DELETION_SWEEP_STATEMENT_TIMEOUT_MS - 1_000,
      );
      expectSettledInsideJoin(result);
      // Logged as a shutdown stop, not as a failed recovery write.
      expect(errors).not.toHaveBeenCalledWith(
        "[auth] user deletion sweep could not record the outcome:",
        expect.anything(),
      );
      expect(logs).toHaveBeenCalledWith(expect.stringContaining("stopped by shutdown"));
    } finally {
      required().fence.disarmDbShutdownFence();
      errors.mockRestore();
      logs.mockRestore();
      await releasing;
      await held.release();
      await stop();
    }
    const after = await deletionState(user.id);
    expect(after.deletionGeneration).toBe(user.generation);
    expect(after.deletionRequestedAt).not.toBeNull();
    expect(after.deletionSweepAttempts).toBe(0);
    expect(after.deletionSweepNextAttemptAt).toBeNull();
    // The next process completes it.
    await expect(sweepOnce()).resolves.toMatchObject({ deleted: 1 });
    expect(await required().prisma.user.count({ where: { id: user.id } })).toBe(0);
  }, 60_000);

  it("a sweep abandon write blocked on the user row settles inside the shutdown join (F2-07)", async () => {
    const { prisma, deletion, timeouts } = required();
    const user = await markedUser("blocked-abandon");
    // Retained provider history: the preflight refuses and the sweep abandons.
    await prisma.providerAuditEvent.create({
      data: { userId: user.id, action: "ACCOUNT_CREATED", subjectId: user.id },
    });
    await hideOtherMarkers([user.id]);
    const held = await holdRowLock(`SELECT id FROM "user" WHERE id = '${user.id}' FOR SHARE`);
    // Released only after the join deadline has passed, counted from when the
    // blocked statement is observed (just before the join starts), so a
    // regression overruns the join instead of being rescued by the release.
    let releasing: Promise<void> = Promise.resolve();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handle = await productionSweepHandle();
    const client = handle.prisma;
    const stop = await startSweep(client);
    try {
      const applicationName = await waitForSweepWaiter(
        'SET "deletionRequestedAt" = NULL',
        held.pid,
      );
      releasing = sleep(timeouts.USER_DELETION_SWEEP_JOIN_TIMEOUT_MS + 1_500).then(() =>
        held.release(),
      );
      const sweep = await import("../../../../apps/server/src/user-deletion-sweep.js");
      expect(applicationName).toBe(sweep.USER_DELETION_SWEEP_APPLICATION_NAME);
      expectSettledInsideJoin(await shutDownSweep("abandon write", stop, handle));
    } finally {
      required().fence.disarmDbShutdownFence();
      errors.mockRestore();
      await releasing;
      await held.release();
      await stop();
    }
    // The cancelled abandon changed nothing: still marked, same generation.
    const after = await deletionState(user.id);
    expect(after.deletionGeneration).toBe(user.generation);
    expect(after.deletionRequestedAt).not.toBeNull();
    expect(after.banReason).toBe(deletion.USER_DELETION_BAN_REASON);
    // The next process archives it, as the refusal recommends.
    const errorsAgain = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(sweepOnce()).resolves.toMatchObject({ abandoned: 1 });
    } finally {
      errorsAgain.mockRestore();
    }
    const archived = await deletionState(user.id);
    expect(archived.deletionGeneration).toBeNull();
    expect(archived.banned).toBe(true);
    expect(archived.banReason).toBe(deletion.USER_DELETION_FAILED_BAN_REASON);
  }, 60_000);

  it("a sweep queue read blocked by a table lock settles inside the shutdown join (F2-07)", async () => {
    const { timeouts } = required();
    const user = await markedUser("blocked-queue");
    await hideOtherMarkers([user.id]);
    const held = await holdRowLock(`LOCK TABLE "user" IN ACCESS EXCLUSIVE MODE`);
    // Released only after the join deadline has passed, counted from when the
    // blocked statement is observed (just before the join starts), so a
    // regression overruns the join instead of being rescued by the release.
    let releasing: Promise<void> = Promise.resolve();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handle = await productionSweepHandle();
    const client = handle.prisma;
    const stop = await startSweep(client);
    try {
      const applicationName = await waitForSweepWaiter("deletionSweepNextAttemptAt", held.pid);
      releasing = sleep(timeouts.USER_DELETION_SWEEP_JOIN_TIMEOUT_MS + 1_500).then(() =>
        held.release(),
      );
      const sweep = await import("../../../../apps/server/src/user-deletion-sweep.js");
      expect(applicationName).toBe(sweep.USER_DELETION_SWEEP_APPLICATION_NAME);
      expectSettledInsideJoin(await shutDownSweep("queue read", stop, handle));
    } finally {
      required().fence.disarmDbShutdownFence();
      errors.mockRestore();
      await releasing;
      await held.release();
      await stop();
    }
    const after = await deletionState(user.id);
    expect(after.deletionGeneration).toBe(user.generation);
    expect(after.deletionSweepAttempts).toBe(0);
    await expect(sweepOnce()).resolves.toMatchObject({ deleted: 1 });
    expect(await required().prisma.user.count({ where: { id: user.id } })).toBe(0);
  }, 60_000);

  /**
   * `client` whose first READ COMMITTED transaction (the sweep's ordered
   * final delete; the drain batches before it use other options) first runs
   * `before`. Only the boundary between the drain and the final transaction is
   * coordinated: the transaction's arguments, the completion code, Prisma's
   * SQL, the driver, the timeouts and the fence are all unchanged.
   */
  function beforeFinalTransaction(client: SweepClient, before: () => Promise<void>) {
    let staged = false;
    let reached!: () => void;
    const isReached = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const instrumented = new Proxy(client, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (property !== "$transaction" || typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          const options = args[1];
          if (
            !staged &&
            typeof options === "object" &&
            options !== null &&
            Reflect.get(options, "isolationLevel") === "ReadCommitted"
          ) {
            staged = true;
            await before();
            reached();
          }
          return Reflect.apply(value, target, args);
        };
      },
    });
    return { client: instrumented, reached: isReached };
  }

  // F2-07e (Codex round 18, E6): one admitted Prisma call can dispatch
  // several statements. The final delete's admission read selects its
  // `Waiters` and `Lease` relations as separate queries, so with each
  // relation table held by another transaction the call waits twice. The
  // fence arms during the first wait; the second query must never be
  // dispatched, so the join waits for one statement, not two.
  it("an admitted Prisma call dispatches none of its later queries once the fence arms (F2-07e)", async () => {
    const { prisma, timeouts } = required();
    const user = await markedUser("relation-expansion");
    await hideOtherMarkers([user.id]);
    // A live admission of the user's pool: the final delete reads it with its
    // waiter and lease relations.
    const pool = await prisma.modelPool.create({
      data: { userId: user.id, slug: `pool-${crypto.randomUUID()}`, name: "empty pool" },
    });
    await prisma.admissionRequest.create({
      data: {
        userId: user.id,
        requestId: `r-${crypto.randomUUID()}`,
        attemptId: `a-${crypto.randomUUID()}`,
        sourceKind: "POOL",
        poolId: pool.id,
        basePriority: 16,
        enqueueSequence: 1n,
        connectionOwner: "f2-07e",
        heartbeatAt: new Date(),
        state: "WAITING",
      },
    });
    const holders: Array<Awaited<ReturnType<typeof holdRowLock>>> = [];
    const tables = ["capacity_waiter", "capacity_lease"] as const;
    const handle = await productionSweepHandle();
    const production = handle.prisma;
    const { client, reached } = beforeFinalTransaction(production, async () => {
      for (const table of tables)
        holders.push(await holdRowLock(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`));
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const before = new Set(await sweepBackends());
    const stop = await startSweep(client);
    let releasing: Promise<void> = Promise.resolve();
    const watch = watchSweepActivity(before);
    let seen: Awaited<ReturnType<typeof watch.stop>> = [];
    try {
      await reached;
      // The first relation query waits on its table's holder.
      const firstPid = await waitForBlocker("SELECT", new Set(holders.map((h) => h.pid)), 15_000);
      const first = holders.find((holder) => holder.pid === firstPid)!;
      const second = holders.find((holder) => holder.pid !== firstPid)!;
      // It is released inside the statement bound, so that query completes
      // after the fence arms; the other table stays held past the join.
      const releaseFirstMs = timeouts.USER_DELETION_SWEEP_STATEMENT_TIMEOUT_MS - 300;
      releasing = Promise.all([
        sleep(releaseFirstMs).then(() => first.release()),
        sleep(timeouts.USER_DELETION_SWEEP_JOIN_TIMEOUT_MS + 1_500).then(() => second.release()),
      ]).then(() => undefined);
      const result = await shutDownSweep("relation expansion", stop, handle);
      seen = await watch.stop();
      // The first query ran on after the fence (it was in flight)...
      expect(result.joinMs).toBeGreaterThanOrEqual(releaseFirstMs - 200);
      // ...and nothing followed it: one statement bound plus the margin, not
      // two statements.
      expectSettledInsideJoin(result);
      // The other relation's query was never dispatched: no sweep backend
      // ever waited on the second table's holder.
      expect(seen.filter((row) => row.blockedBy.includes(second.pid))).toEqual([]);
      expect(seen.some((row) => row.blockedBy.includes(first.pid))).toBe(true);
      expect(errors).not.toHaveBeenCalledWith(
        "[auth] user deletion sweep will retry:",
        expect.anything(),
      );
      expect(logs).toHaveBeenCalledWith(expect.stringContaining("stopped by shutdown"));
    } finally {
      await watch.stop();
      required().fence.disarmDbShutdownFence();
      errors.mockRestore();
      logs.mockRestore();
      await releasing;
      for (const holder of holders) await holder.release();
      await stop();
    }
    report(`relation expansion at the fence: ${seen.length} sweep backend samples`);
    const after = await deletionState(user.id);
    expect(after.deletionGeneration).toBe(user.generation);
    expect(after.deletionRequestedAt).not.toBeNull();
    expect(after.deletionSweepAttempts).toBe(0);
    expect(after.deletionSweepNextAttemptAt).toBeNull();
    // The next process completes it.
    await expect(sweepOnce()).resolves.toMatchObject({ deleted: 1 });
    expect(await prisma.user.count({ where: { id: user.id } })).toBe(0);
  }, 60_000);

  // F2-07e inverse: the dispatch fence must not refuse the COMMIT of the
  // statement in flight. The final delete's `DELETE FROM "user"` waits on a
  // SHARE lock of a table its cascade writes; the fence arms, the lock goes,
  // and the delete commits.
  it("the statement in flight at the fence commits: COMMIT is not refused (F2-07e inverse)", async () => {
    const { prisma, timeouts } = required();
    const user = await markedUser("commit-after-fence");
    await hideOtherMarkers([user.id]);
    const holders: Array<Awaited<ReturnType<typeof holdRowLock>>> = [];
    const handle = await productionSweepHandle();
    const production = handle.prisma;
    const { client, reached } = beforeFinalTransaction(production, async () => {
      holders.push(await holdRowLock("LOCK TABLE session IN SHARE MODE"));
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const stop = await startSweep(client);
    let releasing: Promise<void> = Promise.resolve();
    try {
      await reached;
      const held = holders[0]!;
      await waitForSweepWaiter("DELETE", held.pid);
      const releaseMs = 1_500;
      releasing = sleep(releaseMs).then(() => held.release());
      const result = await shutDownSweep("final delete, committing", stop, handle);
      expect(result.joinMs).toBeGreaterThanOrEqual(releaseMs - 200);
      expectSettledInsideJoin(result);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      required().fence.disarmDbShutdownFence();
      errors.mockRestore();
      logs.mockRestore();
      await releasing;
      for (const held of holders) await held.release();
      await stop();
    }
    // Committed: the user is gone.
    expect(await prisma.user.count({ where: { id: user.id } })).toBe(0);
    report(
      `commit after fence: user deleted (bound ${timeouts.USER_DELETION_SWEEP_STATEMENT_TIMEOUT_MS} ms)`,
    );
  }, 60_000);

  // ---------------------------------------------------------------------------
  // F2-07 (design e): no server-side setting bounds the end of a transaction
  // (PostgreSQL disarms statement_timeout before a COMMIT runs deferred
  // triggers or waits for synchronous replication). Shutdown therefore waits
  // on the sweep for at most the join deadline plus the disconnect deadline:
  // past the join deadline the production shutdown (shutDownUserDeletionSweep,
  // via shutDownSweep above) quarantines the sweep's pool. The server work in
  // flight outlives it and resolves by commit or rollback; either outcome is
  // recoverable from the durable marker and generation.
  // ---------------------------------------------------------------------------

  type SweepBackend = {
    pid: number;
    state: string | null;
    query: string;
    wait_event: string | null;
    in_tx: boolean;
  };

  /** The sweep's backends (other than `except`) as pg_stat_activity shows them. */
  async function sweepActivity(except: ReadonlySet<number> = new Set()) {
    const sweep = await import("../../../../apps/server/src/user-deletion-sweep.js");
    const rows = await required().observer.$queryRaw<SweepBackend[]>`
      SELECT pid, state, query, wait_event, xact_start IS NOT NULL AS in_tx
        FROM pg_stat_activity
       WHERE datname = current_database()
         AND application_name = ${sweep.USER_DELETION_SWEEP_APPLICATION_NAME}`;
    return rows
      .map((row) => ({ ...row, pid: Number(row.pid) }))
      .filter((row) => !except.has(row.pid));
  }

  async function waitForSweepActivity(
    predicate: (row: SweepBackend) => boolean,
    except: ReadonlySet<number>,
    timeoutMs = 20_000,
  ): Promise<SweepBackend> {
    const started = Date.now();
    for (;;) {
      const match = (await sweepActivity(except)).find(predicate);
      if (match) return match;
      if (Date.now() - started > timeoutMs)
        throw new Error(`no matching sweep backend within ${timeoutMs} ms`);
      await sleep(10);
    }
  }

  async function waitForBackendGone(pid: number, timeoutMs = 20_000) {
    const started = Date.now();
    while ((await sweepActivity()).some((row) => row.pid === pid)) {
      if (Date.now() - started > timeoutMs) throw new Error(`backend ${pid} still alive`);
      await sleep(20);
    }
  }

  /**
   * Sets `synchronous_standby_names` on the disposable test server only (and
   * waits until a new statement sees it). A named standby that never
   * connects makes every COMMIT that wrote WAL wait in SyncRep.
   */
  async function setSynchronousStandbys(names: string | null) {
    const { observer } = required();
    if (names === null)
      await observer.$executeRawUnsafe("ALTER SYSTEM RESET synchronous_standby_names");
    else
      await observer.$executeRawUnsafe(`ALTER SYSTEM SET synchronous_standby_names = '${names}'`);
    await observer.$queryRaw`SELECT pg_reload_conf()`;
    const started = Date.now();
    for (;;) {
      const [row] = await observer.$queryRaw<Array<{ s: string }>>`
        SELECT current_setting('synchronous_standby_names') AS s`;
      if (row?.s === (names ?? "")) return;
      if (Date.now() - started > 10_000) throw new Error("setting not applied");
      await sleep(20);
    }
  }

  /**
   * Checks the shutdown returned by the quarantine path inside J + D, and the
   * tick settled as a shutdown stop.
   */
  async function expectQuarantinedInsideDeadlines(
    result: Awaited<ReturnType<typeof shutDownSweep>>,
    logs: MockInstance,
    errors: MockInstance,
  ) {
    const { timeouts } = required();
    // The join really ran out (the stall was live).
    expect(result.outcome.joined).toBe(false);
    expect(result.joinMs).toBeGreaterThanOrEqual(timeouts.USER_DELETION_SWEEP_JOIN_TIMEOUT_MS - 50);
    // The disconnect then finished on its own, well inside its deadline
    // (the quarantine had already closed the stalled connection).
    expect(result.outcome.disconnected).toBe(true);
    expect(result.disconnectMs).toBeLessThan(timeouts.USER_DELETION_SWEEP_DISCONNECT_TIMEOUT_MS);
    expect(result.outcome.quarantined).toBeGreaterThanOrEqual(1);
    // Join plus disconnect inside J + D, whatever the server still does.
    expect(result.totalMs).toBeLessThan(
      timeouts.USER_DELETION_SWEEP_JOIN_TIMEOUT_MS +
        timeouts.USER_DELETION_SWEEP_DISCONNECT_TIMEOUT_MS,
    );
    // The tick itself settled right after the quarantine: a shutdown stop,
    // no backoff or abandon write attempted.
    let settled = false;
    await Promise.race([result.stopping.then(() => (settled = true)), sleep(1_000)]);
    expect(settled).toBe(true);
    expect(logs).toHaveBeenCalledWith(expect.stringContaining("stopped by shutdown"));
    expect(errors).not.toHaveBeenCalledWith(
      "[auth] user deletion sweep will retry:",
      expect.anything(),
    );
    expect(errors).not.toHaveBeenCalledWith(
      "[auth] user deletion sweep could not record the outcome:",
      expect.anything(),
    );
  }

  /**
   * After the abandoned server work resolved: either its commit deleted the
   * user, or the user keeps its marker and generation (no backoff was
   * written) and the next process's sweep deletes it.
   */
  async function expectRecoverableOutcome(user: { id: string; generation: string }) {
    const { prisma } = required();
    const row = await prisma.user.findUnique({
      where: { id: user.id },
      select: { deletionGeneration: true, deletionSweepAttempts: true, deletionRequestedAt: true },
    });
    if (row === null) {
      report("quarantined work committed: the user is deleted");
      return "committed";
    }
    expect(row.deletionGeneration).toBe(user.generation);
    expect(row.deletionRequestedAt).not.toBeNull();
    expect(row.deletionSweepAttempts).toBe(0);
    await expect(sweepOnce()).resolves.toMatchObject({ deleted: 1 });
    expect(await prisma.user.count({ where: { id: user.id } })).toBe(0);
    report("quarantined work left the marker: a fresh sweep deleted the user");
    return "resumed";
  }

  it("a sweep COMMIT stalled on synchronous replication is quarantined: shutdown takes at most join + disconnect (F2-07)", async () => {
    const user = await markedUser("syncrep-commit");
    await hideOtherMarkers([user.id]);
    const before = new Set(await sweepBackends());
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warns = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const handle = await productionSweepHandle();
    let stop: (() => Promise<void>) | undefined;
    let stalledPid = 0;
    try {
      // Disposable server only: a synchronous standby that never connects.
      await setSynchronousStandbys("wsmp_test_missing_standby");
      stop = await startSweep(handle.prisma);
      // The tick's first COMMIT that wrote anything waits for the standby.
      const stalled = await waitForSweepActivity(
        (row) => row.query === "COMMIT" && row.wait_event === "SyncRep",
        before,
      );
      stalledPid = stalled.pid;
      const result = await shutDownSweep("COMMIT in SyncRep", stop, handle);
      await expectQuarantinedInsideDeadlines(result, logs, errors);
      // The quarantine did not (and cannot) end the server's work: the
      // backend still waits in its COMMIT after the process let go of it.
      const after = await sweepActivity(before);
      expect(after.find((row) => row.pid === stalledPid)).toMatchObject({
        query: "COMMIT",
        wait_event: "SyncRep",
      });
    } finally {
      await setSynchronousStandbys(null);
      required().fence.disarmDbShutdownFence();
      if (stalledPid !== 0) await waitForBackendGone(stalledPid);
      await stop?.();
      await handle.prisma.$disconnect();
      errors.mockRestore();
      logs.mockRestore();
      warns.mockRestore();
    }
    await expectRecoverableOutcome(user);
  }, 90_000);

  it("a sweep COMMIT running a slow deferred trigger is quarantined: shutdown takes at most join + disconnect (F2-07)", async () => {
    const { observer, timeouts } = required();
    const user = await markedUser("slow-commit");
    await hideOtherMarkers([user.id]);
    // A fixture deferred trigger on the disposable server: it runs inside the
    // final delete's COMMIT, where statement_timeout no longer applies, and
    // outlasts the join and the disconnect deadlines.
    const triggerSleepS =
      (timeouts.USER_DELETION_SWEEP_JOIN_TIMEOUT_MS +
        timeouts.USER_DELETION_SWEEP_DISCONNECT_TIMEOUT_MS +
        2_000) /
      1_000;
    await observer.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION wsmp_test_slow_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.id = '${user.id}' THEN PERFORM pg_sleep(${triggerSleepS}); END IF;
        RETURN NULL;
      END $$`);
    await observer.$executeRawUnsafe(`
      CREATE CONSTRAINT TRIGGER wsmp_test_slow_commit AFTER DELETE ON "user"
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wsmp_test_slow_commit()`);
    const before = new Set(await sweepBackends());
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warns = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const handle = await productionSweepHandle();
    let stop: (() => Promise<void>) | undefined;
    let slowPid = 0;
    try {
      stop = await startSweep(handle.prisma);
      const slow = await waitForSweepActivity(
        (row) => row.query === "COMMIT" && row.wait_event === "PgSleep",
        before,
      );
      slowPid = slow.pid;
      const result = await shutDownSweep("COMMIT in a deferred trigger", stop, handle);
      await expectQuarantinedInsideDeadlines(result, logs, errors);
    } finally {
      required().fence.disarmDbShutdownFence();
      if (slowPid !== 0) await waitForBackendGone(slowPid, 30_000);
      await observer.$executeRawUnsafe(`DROP TRIGGER IF EXISTS wsmp_test_slow_commit ON "user"`);
      await observer.$executeRawUnsafe("DROP FUNCTION IF EXISTS wsmp_test_slow_commit()");
      await stop?.();
      await handle.prisma.$disconnect();
      errors.mockRestore();
      logs.mockRestore();
      warns.mockRestore();
    }
    await expectRecoverableOutcome(user);
  }, 90_000);

  it("a healthy shutdown does not quarantine: the warm connection is reused across ticks and transactions, then closed gracefully (F2-07 inverse)", async () => {
    const user = await markedUser("healthy-shutdown");
    await hideOtherMarkers([user.id]);
    const before = new Set(await sweepBackends());
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warns = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const handle = await productionSweepHandle();
    const stop = await startSweep(handle.prisma);
    try {
      // The first tick (started by startSweep) deletes the user: drain
      // batches and the ordered final delete, each a transaction.
      const started = Date.now();
      while ((await required().prisma.user.count({ where: { id: user.id } })) > 0) {
        if (Date.now() - started > 20_000) throw new Error("the sweep did not delete the user");
        await sleep(20);
      }
      await sleep(100);
      const held = await sweepBackends(before);
      expect(held).toHaveLength(1);
      // The release guard kept the clean connection after those COMMITs,
      // and the next tick runs on it without connecting.
      await expect(
        (
          await import("../../../../apps/server/src/user-deletion-sweep.js")
        ).sweepPendingUserDeletions({ prisma: handle.prisma, notify: async () => undefined }),
      ).resolves.toEqual({ deleted: 0, abandoned: 0, failed: 0 });
      const [row] = await handle.prisma.$queryRaw<Array<{ pid: number }>>`
        SELECT pg_backend_pid() AS pid`;
      expect(Number(row!.pid)).toBe(held[0]);
      expect(await sweepBackends(before)).toEqual(held);
      const result = await shutDownSweep("nothing (healthy)", stop, handle);
      expectSettledInsideJoin(result);
      // Closed by the graceful disconnect.
      await waitForBackendGone(held[0]!, 5_000);
      expect(warns).not.toHaveBeenCalledWith(expect.stringContaining("quarantined"));
      expect(warns).not.toHaveBeenCalledWith(expect.stringContaining("released with an open"));
    } finally {
      required().fence.disarmDbShutdownFence();
      await stop();
      logs.mockRestore();
      warns.mockRestore();
    }
  }, 60_000);

  // R2-19-2: an operation that passed the method fence before it armed and
  // reaches a cold pool checkout after it is refused at the connect: fast,
  // and without opening a connection.
  it("an operation admitted before the fence that checks out a cold connection after it is refused without connecting (R2-19-2)", async () => {
    const { fence } = required();
    const proxy = await delayingProxy(0);
    const sweep = await import("../../../../apps/server/src/user-deletion-sweep.js");
    const handle = sweep.createUserDeletionSweepClient(proxy.url);
    const before = new Set(await sweepBackends());
    try {
      // Prisma operations are lazy: the method fence admits it here...
      const admitted = handle.prisma.$queryRaw`SELECT 1 AS one`;
      fence.armDbShutdownFence();
      // ...and it runs (and needs a connection) only now.
      const started = Date.now();
      await expect(admitted).rejects.toThrow();
      const elapsed = Date.now() - started;
      report(`admitted-before-fence cold checkout refused after ${elapsed} ms`);
      expect(elapsed).toBeLessThan(500);
      expect(proxy.accepted()).toBe(0);
      expect(await sweepBackends(before)).toEqual([]);
      // Inverse: without the fence the same client connects (through the
      // same proxy) and runs it.
      fence.disarmDbShutdownFence();
      await expect(handle.prisma.$queryRaw`SELECT 1 AS one`).resolves.toEqual([{ one: 1 }]);
      expect(proxy.accepted()).toBe(1);
    } finally {
      fence.disarmDbShutdownFence();
      await handle.prisma.$disconnect();
      await proxy.close();
    }
  }, 30_000);

  // R1-19-1: pg's client-side read timeout (`query_timeout`, which the
  // deployment's DATABASE_URL can set) fails a query's callback while the
  // statement keeps running and drops the ROLLBACK queued behind it; the
  // adapter then released the connection with its transaction open, and the
  // warm pool kept it. The sweep client switches the read timeout off, and
  // its release guard closes any connection that is not idle. Both are
  // exercised: production (normalized), and the guard alone (the test seam
  // keeps the read timeout).
  it.each([
    ["the production client (read timeout switched off)", false],
    ["the release guard alone (read timeout kept)", true],
  ])(
    "a DATABASE_URL query_timeout cannot strand a sweep transaction in the pool: %s (R1-19-1)",
    async (_label, keepReadTimeout) => {
      const { prisma, clientFactory } = required();
      const sweep = await import("../../../../apps/server/src/user-deletion-sweep.js");
      const user = await markedUser(`read-timeout-${keepReadTimeout ? "guard" : "prod"}`);
      await hideOtherMarkers([user.id]);
      const url = new URL(databaseUrl!);
      url.searchParams.set("query_timeout", "250");
      const warns = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const handle = keepReadTimeout
        ? clientFactory.createStatementBoundedPrismaClient(url.toString(), {
            ...sweep.USER_DELETION_SWEEP_CLIENT_OPTIONS,
            keepClientReadTimeoutForTest: true,
          })
        : sweep.createUserDeletionSweepClient(url.toString());
      const holders: Array<Awaited<ReturnType<typeof holdRowLock>>> = [];
      const { client, reached } = beforeFinalTransaction(handle.prisma, async () => {
        holders.push(await holdRowLock("LOCK TABLE session IN SHARE MODE"));
      });
      const before = new Set(await sweepBackends());
      let releasing: Promise<void> = Promise.resolve();
      try {
        const ticking = sweep.sweepPendingUserDeletions({
          prisma: client,
          notify: async () => undefined,
        });
        await reached;
        const held = holders[0]!;
        await waitForSweepWaiter("DELETE", held.pid);
        if (keepReadTimeout) {
          // The read timeouts fire (DELETE, then the queued ROLLBACK) and the
          // connection is released; the holder lets go while the recovery
          // write waits on the abandoned transaction's row lock.
          releasing = sleep(1_000).then(() => held.release());
        }
        const result = await ticking;
        report(`read-timeout tick (${_label}): ${JSON.stringify(result)}`);
        expect(result).toEqual({ deleted: 0, abandoned: 0, failed: 1 });
        await releasing;
        await held.release();
        await sleep(200);
        // No sweep backend is left inside a transaction, now or after idling.
        expect((await sweepActivity(before)).filter((row) => row.in_tx)).toEqual([]);
        await sleep(1_500);
        expect((await sweepActivity(before)).filter((row) => row.in_tx)).toEqual([]);
        // The backoff is durable (seen from another session).
        const state = await deletionState(user.id);
        expect(state.deletionGeneration).toBe(user.generation);
        expect(state.deletionSweepAttempts).toBe(1);
        expect(state.deletionSweepNextAttemptAt).not.toBeNull();
        if (keepReadTimeout) {
          expect(warns).toHaveBeenCalledWith(expect.stringContaining("released with an open"));
        } else {
          expect(warns).toHaveBeenCalledWith(expect.stringContaining("query_timeout"));
          expect(warns).not.toHaveBeenCalledWith(expect.stringContaining("released with an open"));
        }
        // The next tick on the same client (its retained pool) completes it.
        await prisma.user.update({
          where: { id: user.id },
          data: { deletionSweepNextAttemptAt: null },
        });
        await expect(
          sweep.sweepPendingUserDeletions({ prisma: handle.prisma, notify: async () => undefined }),
        ).resolves.toEqual({ deleted: 1, abandoned: 0, failed: 0 });
        expect(await prisma.user.count({ where: { id: user.id } })).toBe(0);
      } finally {
        await releasing;
        for (const holder of holders) await holder.release();
        await handle.prisma.$disconnect();
        warns.mockRestore();
        errors.mockRestore();
      }
    },
    60_000,
  );

  it("one user's failing backoff write does not stop another user's deletion in the same tick (F2-07)", async () => {
    const { deletion } = required();
    const stuck = await markedUser("isolation-stuck", new Date(0));
    const next = await markedUser("isolation-next", new Date(1_000));
    await hideOtherMarkers([stuck.id, next.id]);
    const held = await holdRowLock(
      `SELECT id FROM "user" WHERE id = '${stuck.id}' FOR NO KEY UPDATE`,
    );
    const releaseAtMs = 15_000;
    const releasing = sleep(releaseAtMs).then(() => held.release());
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const client = await productionSweepClient();
    const started = Date.now();
    try {
      const result = await (
        await import("../../../../apps/server/src/user-deletion-sweep.js")
      ).sweepPendingUserDeletions({ prisma: client, notify: async () => undefined });
      const elapsed = Date.now() - started;
      report(`isolation tick (one backoff write cancelled): ${elapsed} ms`);
      expect(result).toEqual({ deleted: 1, abandoned: 0, failed: 1 });
      // Owner lock timeout, then the statement bound on the backoff write:
      // well before the holder lets go.
      expect(elapsed).toBeLessThan(releaseAtMs - 5_000);
      expect(await required().prisma.user.count({ where: { id: next.id } })).toBe(0);
      expect(errors).toHaveBeenCalledWith(
        "[auth] user deletion sweep could not record the outcome:",
        expect.any(String),
      );
    } finally {
      errors.mockRestore();
      await releasing;
      await client.$disconnect();
    }
    // The cancelled backoff rolled back: still marked and due, attempts 0.
    const after = await deletionState(stuck.id);
    expect(after.deletionGeneration).toBe(stuck.generation);
    expect(after.deletionSweepAttempts).toBe(0);
    expect(after.deletionSweepNextAttemptAt).toBeNull();
    expect(after.banReason).toBe(deletion.USER_DELETION_BAN_REASON);
    await expect(sweepOnce()).resolves.toMatchObject({ deleted: 1 });
    expect(await required().prisma.user.count({ where: { id: stuck.id } })).toBe(0);
  }, 60_000);

  it("a capacity-ordered final delete cancelled by the sweep's statement bound backs off once, without retries or archiving (F2-07)", async () => {
    const { prisma, deletion, timeouts } = required();
    const g = await graph("final-timeout");
    const mark = await deletion.requestUserDeletion(prisma, g.user.id);
    await prisma.user.update({
      where: { id: g.user.id },
      data: { deletionRequestedAt: new Date(0) },
    });
    await hideOtherMarkers([g.user.id]);
    // L0: the ordered delete takes the device FOR NO KEY UPDATE first.
    const held = await holdRowLock(
      `SELECT id FROM cli_device WHERE id = '${g.device.id}' FOR UPDATE`,
    );
    const releaseAtMs = 25_000;
    const releasing = sleep(releaseAtMs).then(() => held.release());
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const client = await productionSweepClient();
    const started = Date.now();
    try {
      const result = await (
        await import("../../../../apps/server/src/user-deletion-sweep.js")
      ).sweepPendingUserDeletions({ prisma: client, notify: async () => undefined });
      const elapsed = Date.now() - started;
      report(`sweep tick with the final delete cancelled: ${elapsed} ms`);
      expect(result).toEqual({ deleted: 0, abandoned: 0, failed: 1 });
      // Cancelled at the statement bound (not a lock wait of 2 s), once: not
      // retried (five attempts would take 15 s), not held to Prisma's 15 s
      // transaction cap.
      expect(elapsed).toBeGreaterThanOrEqual(
        timeouts.USER_DELETION_SWEEP_STATEMENT_TIMEOUT_MS - 100,
      );
      expect(elapsed).toBeLessThan(2 * timeouts.USER_DELETION_SWEEP_STATEMENT_TIMEOUT_MS);
      expect(errors).toHaveBeenCalledWith(
        "[auth] user deletion sweep will retry:",
        expect.any(String),
      );
    } finally {
      errors.mockRestore();
      await releasing;
      await client.$disconnect();
    }
    const after = await deletionState(g.user.id);
    expect(after.deletionGeneration).toBe(mark!.generation);
    expect(after.deletionRequestedAt).not.toBeNull();
    expect(after.banReason).toBe(deletion.USER_DELETION_BAN_REASON);
    expect(after.deletionSweepAttempts).toBe(1);
    expect(after.deletionSweepNextAttemptAt).not.toBeNull();
    // Once due again (and the device free), the sweep completes it.
    await prisma.user.update({
      where: { id: g.user.id },
      data: { deletionSweepNextAttemptAt: null },
    });
    await expect(sweepOnce()).resolves.toMatchObject({ deleted: 1 });
    expect(await prisma.user.count({ where: { id: g.user.id } })).toBe(0);
  }, 60_000);

  it(
    "the sweep client deletes a user with a large history without a spurious statement timeout (F2-07 inverse)",
    async () => {
      const { prisma, deletion } = required();
      const g = await graph("sweep-volume");
      await relayHistory(g, "own");
      await otherHistory(g);
      await deletion.requestUserDeletion(prisma, g.user.id);
      await prisma.user.update({
        where: { id: g.user.id },
        data: { deletionRequestedAt: new Date(0) },
      });
      await hideOtherMarkers([g.user.id]);
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        await expect(
          timed("sweep (sweep client) user delete total", () => sweepOnce()),
        ).resolves.toEqual({
          deleted: 1,
          abandoned: 0,
          failed: 0,
        });
        expect(errors).not.toHaveBeenCalled();
      } finally {
        errors.mockRestore();
      }
      expect(await prisma.user.count({ where: { id: g.user.id } })).toBe(0);
      expect(await count(`relay_request WHERE "userId" = '${g.user.id}'`)).toBe(0);
      expect(await count(`admission_request WHERE "userId" = '${g.user.id}'`)).toBe(0);
    },
    TIMEOUT,
  );

  it("the ordered delete refuses a whole-user scope without a generation with the typed error (R2-17-1)", async () => {
    const { prisma, deletion, order } = required();
    const g = await graph("co-owner");
    const outcome = await settle(
      order.runCapacityOrderedTransaction(prisma, (tx) =>
        order.lockCapacityGraphForDelete(tx, { userId: g.user.id, wholeUser: true }),
      ),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("an ownerless whole-user delete ran");
    expect(outcome.error).toBeInstanceOf(deletion.ParentDeletionOwnerRequiredError);
    expect(outcome.error).toMatchObject({ code: "PARENT_DELETION_OWNER_REQUIRED" });
    expect(await prisma.user.count({ where: { id: g.user.id } })).toBe(1);
  });

  // F2-07 (process level): the database step is `disconnectDatabaseClients`
  // (apps/server/src/graceful-shutdown.ts, called from index.ts
  // `disconnectPrisma`). A request admitted before the fence (users.setRole on
  // the real shared singleton) waits on the user row the sweep's final delete
  // holds while that COMMIT runs a slow deferred trigger. pg-pool's end()
  // waits for the request's checked-out client, so an unbounded shared
  // disconnect waited on the sweep's COMMIT (18 s measured by the final
  // review); the shared disconnect now ends at SHARED_DISCONNECT_TIMEOUT_MS.
  // These two tests run last: the first abandons the shared client's
  // disconnect (it finishes once the blocked request does).
  it("a shared disconnect waiting behind a quarantined sweep COMMIT is abandoned at its deadline: the database step takes at most J + D + D_shared (F2-07)", async () => {
    const { prisma, observer, fence, deadline, timeouts, users } = required();
    const user = await markedUser("shared-shutdown");
    const admin = await graph("shared-shutdown-admin");
    await hideOtherMarkers([user.id]);
    const stepBoundMs =
      timeouts.USER_DELETION_SWEEP_JOIN_TIMEOUT_MS +
      timeouts.USER_DELETION_SWEEP_DISCONNECT_TIMEOUT_MS +
      timeouts.SHARED_DISCONNECT_TIMEOUT_MS;
    // Outlasts the whole database step, so the COMMIT is still running when
    // it returns.
    const triggerSleepS = (stepBoundMs + 5_000) / 1_000;
    await observer.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION wsmp_test_shared_slow_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.id = '${user.id}' THEN PERFORM pg_sleep(${triggerSleepS}); END IF;
        RETURN NULL;
      END $$`);
    await observer.$executeRawUnsafe(`
      CREATE CONSTRAINT TRIGGER wsmp_test_shared_slow_commit AFTER DELETE ON "user"
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wsmp_test_shared_slow_commit()`);
    const sweep = await import("../../../../apps/server/src/user-deletion-sweep.js");
    const before = new Set(await sweepBackends());
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warns = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const handle = await productionSweepHandle();
    const stop = await startSweep(handle.prisma);
    const warnings: string[] = [];
    let writer: ReturnType<typeof settle> | undefined;
    let sharedDisconnect: Promise<void> | undefined;
    let slowPid = 0;
    try {
      const slow = await waitForSweepActivity(
        (row) => row.query === "COMMIT" && row.wait_event === "PgSleep",
        before,
      );
      slowPid = slow.pid;
      // A request admitted before shutdown, on the shared singleton.
      const client = createRouterClient(users.usersRouter, { context: sessionFor(admin.user) });
      writer = settle(client.setRole({ userId: user.id, role: "user" }));
      await waitForBlocker("UPDATE", new Set([slowPid]));

      let stopping: Promise<void> | undefined;
      let teardown:
        | Awaited<ReturnType<typeof deadline.disconnectDatabaseClients<unknown>>>
        | undefined;
      const started = Date.now();
      await deadline.runGracefulShutdownSequence({
        stopPeriodicJobs: () => {
          stopping = stop();
        },
        closeBrowserSockets: () => undefined,
        drainHttp: async () => undefined,
        closeRelaySessions: () => undefined,
        closeMcpHandler: async () => {
          fence.armDbShutdownFence();
        },
        // index.ts disconnectPrisma, with the warnings captured.
        disconnectPrisma: async () => {
          teardown = await deadline.disconnectDatabaseClients({
            shutDownSweep: () =>
              sweep.shutDownUserDeletionSweep({
                stopped: () => stopping ?? stop(),
                client: handle,
                warn: (message) => warnings.push(message),
              }),
            shared: {
              // The real shared singleton; the promise is kept only so the
              // test can await the abandoned disconnect afterwards.
              $disconnect: () => {
                sharedDisconnect = prisma.$disconnect();
                return sharedDisconnect;
              },
            },
            warn: (message) => warnings.push(message),
          });
        },
        log: () => undefined,
        logError: () => undefined,
      });
      const elapsedMs = Date.now() - started;
      const commitRunning = (await sweepActivity(before)).some(
        (row) => row.pid === slowPid && row.query === "COMMIT",
      );
      report(
        `shared disconnect behind a quarantined sweep COMMIT: database step ${elapsedMs} ms (bound ${stepBoundMs} ms), shared ${teardown?.shared}, sweep COMMIT still running ${commitRunning}`,
      );
      // The sweep's join ran out (the stall was live) and its pool was
      // quarantined; the shared disconnect then hit its own deadline.
      expect(teardown?.sweep).toMatchObject({ joined: false });
      expect(teardown?.shared).toBe("timeout");
      expect(elapsedMs).toBeLessThan(stepBoundMs + 500);
      // The join really ran out and the shared disconnect waited its deadline.
      expect(elapsedMs).toBeGreaterThanOrEqual(
        timeouts.USER_DELETION_SWEEP_JOIN_TIMEOUT_MS + timeouts.SHARED_DISCONNECT_TIMEOUT_MS - 100,
      );
      expect(warnings).toContain(
        "[server] shared database client disconnect did not finish before its deadline.",
      );
      // The process did not wait on the server: the sweep COMMIT still runs.
      expect(commitRunning).toBe(true);
    } finally {
      fence.disarmDbShutdownFence();
      if (slowPid !== 0) await waitForBackendGone(slowPid, 30_000);
      await writer;
      await sharedDisconnect;
      await observer.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS wsmp_test_shared_slow_commit ON "user"`,
      );
      await observer.$executeRawUnsafe("DROP FUNCTION IF EXISTS wsmp_test_shared_slow_commit()");
      await stop();
      await handle.prisma.$disconnect();
      errors.mockRestore();
      logs.mockRestore();
      warns.mockRestore();
    }
    // After the trigger ended: the user is gone, or it keeps its marker and
    // generation and a fresh sweep deletes it.
    await expectRecoverableOutcome(user);
  }, 90_000);

  it("a healthy shared disconnect finishes at once without a warning (F2-07 inverse)", async () => {
    const { prisma, deadline } = required();
    const handle = await productionSweepHandle();
    const stop = await startSweep(handle.prisma);
    // The shared client holds live connections (a query ran on it).
    await prisma.user.count();
    const warnings: string[] = [];
    try {
      const started = Date.now();
      const teardown = await deadline.disconnectDatabaseClients({
        shutDownSweep: () => shutDownSweep("nothing (healthy shared)", stop, handle),
        shared: prisma,
        warn: (message) => warnings.push(message),
      });
      const elapsedMs = Date.now() - started;
      report(`healthy database step: ${elapsedMs} ms, shared ${teardown.shared}`);
      expect(teardown.shared).toBe("done");
      expect(teardown.sweep?.outcome).toEqual({
        joined: true,
        quarantined: null,
        disconnected: true,
      });
      expect(warnings).toEqual([]);
      expect(elapsedMs).toBeLessThan(1_000);
    } finally {
      required().fence.disarmDbShutdownFence();
      await stop();
    }
    // The shared client reconnects on its next query after the disconnect.
    expect(await prisma.user.count()).toBeGreaterThan(0);
  }, 60_000);
});
