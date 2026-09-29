import { createRouterClient } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Context } from "../context";

// DL-1 regression cycles (#78). Each case stages, on real PostgreSQL, one of
// the lock cycles the issue lists (F2-02, the transformer SET NULL, user
// delete vs provider updateModel, the bulk capacity update vs admission, the
// endpoint-delete stale plan, relay route vs target delete) and asserts that
// it completes without a deadlock. On master every case deadlocks: the
// staging releases its blockers into the documented cycle.
//
// The file uses only APIs that exist before and after design (d) (routers,
// deleteUserDurably, the admission store, compactMinuteRollups), so the same
// file runs against both trees. Production transactions run with
// deadlock_timeout = 5 s (DATABASE_URL options), so a deadlock between two of
// them costs at least 5 s before PostgreSQL breaks it (and a retry loop then
// hides it): the cases assert the whole release completes within
// RELEASE_BUDGET_MS. A test-side participant runs with deadlock_timeout =
// 50 ms, so it is the victim of any cycle it is part of and its 40P01
// surfaces directly.

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("SCHEMA_VALIDATION_DATABASE_URL is required for PostgreSQL integration tests");
const integration = databaseUrl ? describe : describe.skip;

/** A cycle between two production transactions costs >= 5 s; a clean release is fast. */
const RELEASE_BUDGET_MS = 2_500;

type Client = ReturnType<typeof import("@ws-model-proxy/db/client-factory").createPrismaClient>;

function withOptions(url: string, options: string): string {
  const parsed = new URL(url);
  const existing = parsed.searchParams.get("options");
  parsed.searchParams.set("options", existing ? `${existing} ${options}` : options);
  parsed.search = parsed.searchParams.toString().replace(/\+/g, "%20");
  return parsed.toString();
}

function sessionFor(user: { id: string; email: string; name: string }): Context {
  return {
    session: {
      user: { ...user, emailVerified: true, role: "user" },
      session: {
        id: `session-${user.id}`,
        userId: user.id,
        token: `token-${user.id}`,
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date(),
        updatedAt: new Date(),
        ipAddress: "127.0.0.1",
        userAgent: "capacity-cycles-test",
      },
    } as Session,
  } as Context;
}

async function backendPid(tx: Pick<Client, "$queryRaw">): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
  const pid = rows[0]?.pid;
  if (pid === undefined) throw new Error("Backend pid unavailable.");
  return pid;
}

/** Backends of this database currently waiting on a lock. */
async function blockedBackends(inspector: Client): Promise<number> {
  const rows = await inspector.$queryRaw<Array<{ blocked: bigint }>>`
    SELECT count(*) AS blocked FROM pg_stat_activity
     WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`;
  return Number(rows[0]?.blocked ?? 0);
}

async function blockedBy(inspector: Client, pid: number): Promise<number> {
  const rows = await inspector.$queryRaw<Array<{ blocked: bigint }>>`
    SELECT count(*) AS blocked FROM pg_stat_activity
     WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`;
  return Number(rows[0]?.blocked ?? 0);
}

function tracked<T>(promise: Promise<T>) {
  const state = { settled: false };
  const settled = promise.then(
    (value) => {
      state.settled = true;
      return { ok: true as const, value };
    },
    (error: unknown) => {
      state.settled = true;
      return { ok: false as const, error };
    },
  );
  return { state, settled };
}

async function waitFor(condition: () => Promise<boolean> | boolean, label: string): Promise<void> {
  for (let poll = 0; poll < 1_500; poll++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

/**
 * A test-side transaction that takes its locks (`take`), reports its pid,
 * and holds them until `release()`; then runs `after` and commits.
 */
function openHolder(
  client: Client,
  take: (tx: Parameters<Parameters<Client["$transaction"]>[0]>[0]) => Promise<void>,
  after?: (tx: Parameters<Parameters<Client["$transaction"]>[0]>[0]) => Promise<void>,
) {
  let ready!: (pid: number) => void;
  const pid = new Promise<number>((resolve) => {
    ready = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const done = client.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET LOCAL deadlock_timeout = '50ms'`;
      const own = await backendPid(tx);
      await take(tx);
      ready(own);
      await released;
      await after?.(tx);
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
  return { pid, release, done: tracked(done) };
}

function isDeadlock(error: unknown): boolean {
  const text = String(error instanceof Error ? `${error.message} ${String(error.cause)}` : error);
  return /40P01|deadlock/i.test(text);
}

integration("DL-1 regression cycles on PostgreSQL (each deadlocks on master)", () => {
  let modules:
    | {
        prisma: typeof import("@ws-model-proxy/db").default;
        factory: typeof import("@ws-model-proxy/db/client-factory");
        deletion: typeof import("@ws-model-proxy/db/parent-deletion");
        forwarder: typeof import("../routers/forwarder-management");
        capacity: typeof import("../routers/capacity-management");
        provider: typeof import("../routers/provider-management");
        retention: typeof import("../../../../apps/server/src/model-api/usage-retention.js");
        store: typeof import("../../../../apps/server/src/model-api/capacity/postgres-store.js");
      }
    | undefined;
  let fixtures: Client;
  let side: Client;
  let inspector: Client;

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = withOptions(databaseUrl, "-c deadlock_timeout=5s");
    process.env.NODE_ENV = "test";
    process.env.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED = "true";
    const [db, factory, deletion, forwarder, capacity, provider, retention, store] =
      await Promise.all([
        import("@ws-model-proxy/db"),
        import("@ws-model-proxy/db/client-factory"),
        import("@ws-model-proxy/db/parent-deletion"),
        import("../routers/forwarder-management"),
        import("../routers/capacity-management"),
        import("../routers/provider-management"),
        import("../../../../apps/server/src/model-api/usage-retention.js"),
        import("../../../../apps/server/src/model-api/capacity/postgres-store.js"),
      ]);
    modules = {
      prisma: db.default,
      factory,
      deletion,
      forwarder,
      capacity,
      provider,
      retention,
      store,
    };
    // Fixture writes carry the deploy/fixture marker the graph-write fence
    // triggers accept (a harmless unknown setting before design (d)).
    fixtures = factory.createPrismaClient(withOptions(databaseUrl, "-c wsmp.fences=,*,"));
    side = factory.createPrismaClient(databaseUrl);
    inspector = factory.createPrismaClient(databaseUrl);
  });

  afterAll(async () => {
    await Promise.all([fixtures?.$disconnect(), side?.$disconnect(), inspector?.$disconnect()]);
  });

  function required() {
    if (!modules) throw new Error("modules unavailable");
    return modules;
  }

  async function userFixture(label: string) {
    const suffix = crypto.randomUUID();
    const user = await fixtures.user.create({
      data: {
        name: `Cycle ${label}`,
        email: `cycle-${label}-${suffix}@example.test`,
        slug: `cycle-${label}-${suffix}`,
        emailVerified: true,
      },
    });
    return { user, suffix };
  }

  /** Device -> endpoint -> discovered model; the insert trigger adds its target and capacity. */
  async function localModel(userId: string, suffix: string, name: string) {
    const device = await fixtures.cliDevice.create({
      data: { userId, slug: `dev-${name}-${suffix}`.slice(0, 60) },
    });
    const endpoint = await fixtures.endpoint.create({
      data: {
        userId,
        cliDeviceId: device.id,
        slug: `ep-${name}-${suffix}`.slice(0, 60),
        label: name,
        status: "ONLINE",
      },
    });
    const model = await fixtures.discoveredModel.create({
      data: {
        userId,
        endpointId: endpoint.id,
        upstreamModelId: `up-${name}`,
        encodedModelId: `enc-${name}-${suffix}`,
      },
    });
    const target = await fixtures.executionTarget.findUniqueOrThrow({
      where: { discoveredModelId: model.id },
    });
    if (!target.inferenceCapacityId) throw new Error("target without capacity");
    return { device, endpoint, model, target, capacityId: target.inferenceCapacityId };
  }

  it("F2-02: a user delete does not deadlock with a rollup compaction holding the owner's minute rows", async () => {
    const m = required();
    const { user: owner } = await userFixture("rollup-owner");
    const { user: requester } = await userFixture("rollup-requester");
    // Two minute rows past the 30-day window, in two hours: the first hour
    // already has an hourly row (held by the blocker), the second does not,
    // so compaction's second increment is an INSERT with the owner as key.
    const base = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    base.setUTCMinutes(0, 0, 0);
    const hourOne = new Date(base);
    const hourTwo = new Date(base.getTime() + 60 * 60 * 1000);
    const key = (bucketStart: Date) => ({
      bucketStart,
      ownerUserId: owner.id,
      requesterUserId: requester.id,
      poolId: "",
      poolMemberId: "",
      executionTargetId: "",
      source: "API_TOKEN" as const,
    });
    await fixtures.usageRollupMinute.create({
      data: { ...key(new Date(hourOne.getTime() + 5 * 60_000)), requests: 1 },
    });
    await fixtures.usageRollupMinute.create({
      data: { ...key(new Date(hourTwo.getTime() + 5 * 60_000)), requests: 1 },
    });
    await fixtures.usageRollupHour.create({ data: { ...key(hourOne), requests: 3 } });

    const blocker = openHolder(side, async (tx) => {
      await tx.$queryRaw`
        SELECT 1 FROM usage_rollup_hour
         WHERE "bucketStart" = ${hourOne} AND "ownerUserId" = ${owner.id}
         FOR UPDATE`;
    });
    const blockerPid = await blocker.pid;
    const compaction = tracked(
      m.retention.compactMinuteRollups({ prisma: m.prisma, now: new Date(), batch: 1_000 }),
    );
    await waitFor(
      async () => compaction.state.settled || (await blockedBy(inspector, blockerPid)) >= 1,
      "compaction queued behind the hourly row",
    );
    const deletion = tracked(m.deletion.deleteUserDurably(m.prisma, owner.id));
    await waitFor(
      async () => deletion.state.settled || (await blockedBackends(inspector)) >= 2,
      "the user delete settled or queued",
    );
    const releasedAt = Date.now();
    blocker.release();
    const [deleted, compacted, held] = await Promise.all([
      deletion.settled,
      compaction.settled,
      blocker.done.settled,
    ]);
    const elapsed = Date.now() - releasedAt;
    expect(held.ok).toBe(true);
    expect(compacted.ok ? "ok" : String(compacted.error)).toBe("ok");
    expect(deleted.ok ? deleted.value : String(deleted.error)).toBe("deleted");
    expect(elapsed).toBeLessThan(RELEASE_BUDGET_MS);
  }, 60_000);

  it("transformer SET NULL: deleting a pool's transformer model does not deadlock with an attach to that pool", async () => {
    const m = required();
    const { user, suffix } = await userFixture("transformer");
    const local = await localModel(user.id, suffix, "transformer");
    const pool = await fixtures.modelPool.create({
      data: {
        userId: user.id,
        slug: `transformer-${suffix}`,
        name: "Transformer pool",
        transformerDiscoveredModelId: local.model.id,
      },
    });
    const forwarder = createRouterClient(m.forwarder.forwarderManagementRouter, {
      context: sessionFor(user),
    });
    // Before design (d) the model delete takes the target's capacity-policy
    // lock and then the capacity's advisory lock (held here), and its cascade
    // rewrites the pool row (SET NULL) that the attach holds while it waits on
    // the target's policy lock.
    const blocker = openHolder(side, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${local.capacityId}, 0))`;
    });
    const blockerPid = await blocker.pid;
    const removal = tracked(forwarder.removeDiscoveredModelMetadata({ id: local.model.id }));
    await waitFor(
      async () => removal.state.settled || (await blockedBy(inspector, blockerPid)) >= 1,
      "the model delete settled or queued",
    );
    const attach = tracked(
      forwarder.addPoolMember({ poolId: pool.id, discoveredModelId: local.model.id }),
    );
    await waitFor(
      async () => attach.state.settled || (await blockedBackends(inspector)) >= 2,
      "the attach settled or queued",
    );
    const releasedAt = Date.now();
    blocker.release();
    const [removed, attached] = await Promise.all([removal.settled, attach.settled]);
    const elapsed = Date.now() - releasedAt;
    await blocker.done.settled;
    expect(removed.ok ? "ok" : String(removed.error)).toBe("ok");
    // The attach loses the race (the model is gone) or ran first; never a deadlock.
    if (!attached.ok) expect(isDeadlock(attached.error)).toBe(false);
    expect(elapsed).toBeLessThan(RELEASE_BUDGET_MS);
    const after = await fixtures.modelPool.findUniqueOrThrow({ where: { id: pool.id } });
    expect(after.transformerDiscoveredModelId).toBeNull();
  }, 60_000);

  it("a user delete does not deadlock with a provider model limit update", async () => {
    const m = required();
    const { user, suffix } = await userFixture("provider");
    const account = await fixtures.providerAccount.create({
      data: {
        userId: user.id,
        providerType: "openai",
        label: `cycle-${suffix}`,
        baseUrl: "https://provider.example.test",
        endpointIdentity: "https://provider.example.test",
        authType: "BEARER",
      },
    });
    const model = await fixtures.providerModel.create({
      data: { userId: user.id, providerAccountId: account.id, upstreamModelId: `m-${suffix}` },
    });
    const capacity = await fixtures.inferenceCapacity.create({
      data: {
        userId: user.id,
        label: `provider-${suffix}`,
        runtimeIdentityKey: `provider-model:${model.id}`,
        runtimeModel: model.upstreamModelId,
      },
    });
    await fixtures.executionTarget.create({
      data: {
        userId: user.id,
        kind: "PROVIDER_MODEL",
        providerModelId: model.id,
        inferenceCapacityId: capacity.id,
      },
    });
    const provider = createRouterClient(m.provider.providerManagementRouter, {
      context: sessionFor(user),
    });
    // The user row FOR KEY SHARE lets the deletion mark through (a non-key
    // UPDATE) but stops the delete at its user row lock, after (before design
    // (d)) its capacity locks on the provider target.
    const blocker = openHolder(side, async (tx) => {
      await tx.$queryRaw`SELECT id FROM "user" WHERE id = ${user.id} FOR KEY SHARE`;
    });
    const blockerPid = await blocker.pid;
    const deletion = tracked(m.deletion.deleteUserDurably(m.prisma, user.id));
    await waitFor(
      async () => deletion.state.settled || (await blockedBy(inspector, blockerPid)) >= 1,
      "the user delete settled or queued",
    );
    const update = tracked(provider.updateModel({ id: model.id, concurrencyLimit: 2 }));
    await waitFor(
      async () => update.state.settled || (await blockedBackends(inspector)) >= 2,
      "the model update settled or queued",
    );
    const releasedAt = Date.now();
    blocker.release();
    const [deleted, updated] = await Promise.all([deletion.settled, update.settled]);
    const elapsed = Date.now() - releasedAt;
    await blocker.done.settled;
    expect(deleted.ok ? deleted.value : String(deleted.error)).toBe("deleted");
    if (!updated.ok) expect(isDeadlock(updated.error)).toBe(false);
    expect(elapsed).toBeLessThan(RELEASE_BUDGET_MS);
  }, 60_000);

  it("a management writer that locks capacity rows out of order does not deadlock with admission terminalization", async () => {
    const m = required();
    const { user, suffix } = await userFixture("bulk-capacity");
    // B's row is created first and its id sorts after A's: a bulk UPDATE
    // (the guarded wizard's countStrategy updateMany) takes it first, while
    // admission (before design (d)) locked capacity rows in id order.
    const capacityB = await fixtures.inferenceCapacity.create({
      data: {
        id: `cap-b-${suffix}`,
        userId: user.id,
        label: `b-${suffix}`,
        runtimeIdentityKey: `b-${suffix}`,
        runtimeModel: "b",
      },
    });
    const capacityA = await fixtures.inferenceCapacity.create({
      data: {
        id: `cap-a-${suffix}`,
        userId: user.id,
        label: `a-${suffix}`,
        runtimeIdentityKey: `a-${suffix}`,
        runtimeModel: "a",
      },
    });
    // One pool request waiting on both capacities, through two members.
    const pool = await fixtures.modelPool.create({
      data: { userId: user.id, slug: `bulk-${suffix}`, name: "Bulk pool" },
    });
    const members = [];
    for (const capacity of [capacityA, capacityB]) {
      const local = await localModel(user.id, suffix, capacity.label);
      await fixtures.executionTarget.update({
        where: { id: local.target.id },
        data: { inferenceCapacityId: capacity.id },
      });
      const member = await fixtures.poolMember.create({
        data: { poolId: pool.id, executionTargetId: local.target.id, tier: "PRIMARY" },
      });
      members.push({ member, targetId: local.target.id, capacityId: capacity.id });
    }
    const attemptId = `bulk-${suffix}`;
    const request = await fixtures.admissionRequest.create({
      data: {
        userId: user.id,
        requestId: attemptId,
        attemptId,
        sourceKind: "POOL",
        poolId: pool.id,
        basePriority: 16,
        enqueueSequence: BigInt(Date.now()),
        deadlineAt: new Date(Date.now() + 60_000),
        connectionOwner: "bulk",
        heartbeatAt: new Date(),
      },
    });
    for (const [order, entry] of members.entries())
      await fixtures.capacityWaiter.create({
        data: {
          userId: user.id,
          admissionRequestId: request.id,
          requestId: attemptId,
          attemptId,
          enqueueSequence: request.enqueueSequence,
          capacityId: entry.capacityId,
          executionTargetId: entry.targetId,
          poolId: pool.id,
          poolMemberId: entry.member.id,
          candidateOrder: order,
          deadlineAt: new Date(Date.now() + 60_000),
          effectivePriority: 16,
          effectiveConcurrencyScope: "POOL",
          effectiveConcurrencyScopeId: pool.id,
        },
      });
    const store = new m.store.PostgresCapacityAdmissionStore(m.prisma);
    const blocker = openHolder(side, async (tx) => {
      await tx.$queryRaw`SELECT id FROM inference_capacity WHERE id = ${capacityA.id} FOR NO KEY UPDATE`;
    });
    const blockerPid = await blocker.pid;
    const terminalize = tracked(store.terminalizeAttempt(attemptId, "CANCELLED"));
    await waitFor(
      async () => terminalize.state.settled || (await blockedBy(inspector, blockerPid)) >= 1,
      "terminalization settled or queued",
    );
    // The out-of-order writer (test side, 50 ms deadlock_timeout): B first,
    // then A, queued behind the blocker (and, before design (d), behind
    // terminalization, which then waits on the writer's B).
    const writer = tracked(
      side.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET LOCAL deadlock_timeout = '50ms'`;
          await tx.$executeRaw`UPDATE inference_capacity SET "countStrategy" = 'TOKENIZER' WHERE id = ${capacityB.id}`;
          await tx.$executeRaw`UPDATE inference_capacity SET "countStrategy" = 'TOKENIZER' WHERE id = ${capacityA.id}`;
        },
        { timeout: 60_000 },
      ),
    );
    await waitFor(
      async () =>
        terminalize.state.settled
          ? (await blockedBy(inspector, blockerPid)) >= 1
          : // A second waiter on a row queues behind the first one, which
            // pg_blocking_pids then reports as its blocker.
            (await blockedBackends(inspector)) >= 2,
      "the out-of-order writer queued behind the blocker",
    );
    blocker.release();
    const [terminalized, wrote] = await Promise.all([terminalize.settled, writer.settled]);
    await blocker.done.settled;
    expect(wrote.ok ? "ok" : String(wrote.error)).toBe("ok");
    expect(terminalized.ok ? terminalized.value.state : String(terminalized.error)).toBe(
      "CANCELLED",
    );
  }, 60_000);

  it("an endpoint delete does not deadlock with an admitter on a model added to the endpoint meanwhile", async () => {
    const m = required();
    const { user, suffix } = await userFixture("endpoint-toctou");
    const local = await localModel(user.id, suffix, "toctou");
    const forwarder = createRouterClient(m.forwarder.forwarderManagementRouter, {
      context: sessionFor(user),
    });
    // Before design (d) the endpoint delete read its targets and only then
    // locked the device row (held here); a model added in between escaped its
    // lock plan.
    const blocker = openHolder(side, async (tx) => {
      await tx.$queryRaw`SELECT id FROM cli_device WHERE id = ${local.device.id} FOR NO KEY UPDATE`;
    });
    const blockerPid = await blocker.pid;
    const removal = tracked(forwarder.removeEndpointMetadata({ id: local.endpoint.id }));
    await waitFor(
      async () => removal.state.settled || (await blockedBy(inspector, blockerPid)) >= 1,
      "the endpoint delete settled or queued",
    );
    if (removal.state.settled) {
      // Design (d): the delete takes no device lock and plans under the owner
      // fence (writer-classes suite: "plans its cascade under the owner
      // fence"). The endpoint is gone; nothing can be added to it.
      blocker.release();
      await blocker.done.settled;
      const removed = await removal.settled;
      expect(removed.ok ? "ok" : String(removed.error)).toBe("ok");
      return;
    }
    const added = await fixtures.discoveredModel.create({
      data: {
        userId: user.id,
        endpointId: local.endpoint.id,
        upstreamModelId: "up-added",
        encodedModelId: `enc-added-${suffix}`,
      },
    });
    const addedTarget = await fixtures.executionTarget.findUniqueOrThrow({
      where: { discoveredModelId: added.id },
    });
    const addedCapacity = addedTarget.inferenceCapacityId!;
    const attemptId = `toctou-${suffix}`;
    const request = await fixtures.admissionRequest.create({
      data: {
        userId: user.id,
        requestId: attemptId,
        attemptId,
        sourceKind: "DIRECT",
        directExecutionTargetId: addedTarget.id,
        basePriority: 16,
        enqueueSequence: BigInt(Date.now()),
        deadlineAt: new Date(Date.now() + 60_000),
        connectionOwner: "toctou",
        heartbeatAt: new Date(),
      },
    });
    // The admitter (test side, 50 ms deadlock_timeout): capacity lock, then
    // the request row, then (after release) the lease insert.
    const admitter = openHolder(
      side,
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${addedCapacity}, 0))`;
        await tx.$queryRaw`SELECT id FROM admission_request WHERE id = ${request.id} FOR UPDATE`;
      },
      async (tx) => {
        await tx.capacityLease.create({
          data: {
            userId: user.id,
            requestId: attemptId,
            attemptId,
            admissionRequestId: request.id,
            capacityId: addedCapacity,
            executionTargetId: addedTarget.id,
            priority: 16,
            reservationClass: 16,
            fencingToken: 1_000_000n,
            ownerServerInstance: `toctou-${suffix}`,
            heartbeatAt: new Date(),
            expiresAt: new Date(Date.now() + 30_000),
          },
        });
      },
    );
    const admitterPid = await admitter.pid;
    blocker.release();
    await blocker.done.settled;
    await waitFor(
      async () => removal.state.settled || (await blockedBy(inspector, admitterPid)) >= 1,
      "the endpoint delete settled or queued behind the admitter",
    );
    admitter.release();
    const [removed, admitted] = await Promise.all([removal.settled, admitter.done.settled]);
    expect(admitted.ok ? "ok" : String(admitted.error)).toBe("ok");
    expect(removed.ok ? "ok" : String(removed.error)).toBe("ok");
  }, 60_000);

  it("a relay route's selection update does not deadlock with a delete of the selected target", async () => {
    const m = required();
    const { user, suffix } = await userFixture("relay-route");
    const local = await localModel(user.id, suffix, "relay");
    const relay = await fixtures.relayRequest.create({
      data: {
        userId: user.id,
        requestedDiscoveredModelId: local.model.id,
        requestedExecutionTargetId: local.target.id,
        status: "PENDING",
      },
    });
    const forwarder = createRouterClient(m.forwarder.forwarderManagementRouter, {
      context: sessionFor(user),
    });
    const blocker = openHolder(side, async (tx) => {
      await tx.$queryRaw`SELECT id FROM relay_request WHERE id = ${relay.id} FOR NO KEY UPDATE`;
    });
    const blockerPid = await blocker.pid;
    // The route (test side, 50 ms deadlock_timeout): the production statement
    // that records the selected target on the request row.
    const route = tracked(
      fixtures.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET LOCAL deadlock_timeout = '50ms'`;
          await tx.relayRequest.update({
            where: { id: relay.id },
            data: {
              selectedDiscoveredModelId: local.model.id,
              selectedExecutionTargetId: local.target.id,
            },
          });
        },
        { timeout: 60_000 },
      ),
    );
    await waitFor(
      async () => (await blockedBy(inspector, blockerPid)) >= 1,
      "the route queued behind the relay row",
    );
    const removal = tracked(forwarder.removeDiscoveredModelMetadata({ id: local.model.id }));
    await waitFor(
      async () => removal.state.settled || (await blockedBackends(inspector)) >= 2,
      "the delete settled or queued behind the relay row",
    );
    blocker.release();
    await blocker.done.settled;
    const [removed, routed] = await Promise.all([removal.settled, route.settled]);
    expect(routed.ok ? "ok" : String(routed.error)).toBe("ok");
    expect(removed.ok ? "ok" : String(removed.error)).toBe("ok");
  }, 60_000);
});
