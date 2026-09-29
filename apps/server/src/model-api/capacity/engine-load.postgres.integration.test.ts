import { createFixturePrismaClient } from "@ws-model-proxy/db/test-fixture-client";
import { describe, expect, it, vi } from "vitest";
import type { AdmissionAttempt, AdmissionResult, CapacityLeaseHandle } from "./types.js";

// Live engine load as FULL (S-D), end to end on PostgreSQL: a real
// `MetricRoutingEvaluator` turns `endpoint.load` readings into rows of the
// H-class `pool_member_routing_verdict` table, and `#admitOne` reads them with
// a plain SELECT at grant time. Members sit on their own single-slot vLLM
// capacity behind their own endpoint of one device.

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error(
    "PostgreSQL integration was required but SCHEMA_VALIDATION_DATABASE_URL is unset.",
  );
const integration = databaseUrl ? describe : describe.skip;

type Db = ReturnType<typeof createFixturePrismaClient>;

async function fixture(db: Db) {
  // The store module imports the default client, which validates the env.
  process.env.DATABASE_URL = databaseUrl;
  const suffix = crypto.randomUUID();
  const user = await db.user.create({
    data: {
      name: "Engine load proof",
      email: `engine-load-${suffix}@example.test`,
      slug: `engine-${suffix}`,
    },
  });
  const device = await db.cliDevice.create({ data: { userId: user.id, slug: `d-${suffix}` } });
  const pool = await db.modelPool.create({
    data: { userId: user.id, slug: `p-${suffix}`, name: "Engine pool" },
  });
  const members: Array<{
    id: string;
    targetId: string;
    capacityId: string;
    endpointSlug: string;
  }> = [];
  for (const name of ["a", "b"]) {
    const endpointSlug = `${name}-${suffix}`.slice(0, 60);
    const endpoint = await db.endpoint.create({
      data: { userId: user.id, cliDeviceId: device.id, slug: endpointSlug, label: name },
    });
    const capacity = await db.inferenceCapacity.create({
      data: {
        userId: user.id,
        label: `${name}-${suffix}`,
        runtimeIdentityKey: `${name}-${suffix}`,
        runtimeModel: name,
        hardConcurrencyLimit: 1,
        engineKind: "VLLM",
      },
    });
    const model = await db.discoveredModel.create({
      data: {
        userId: user.id,
        endpointId: endpoint.id,
        upstreamModelId: name,
        encodedModelId: `${name}-${suffix}`,
      },
    });
    const target = await db.executionTarget.update({
      where: { discoveredModelId: model.id },
      data: { inferenceCapacityId: capacity.id },
    });
    const member = await db.poolMember.create({
      data: { poolId: pool.id, executionTargetId: target.id },
    });
    members.push({ id: member.id, targetId: target.id, capacityId: capacity.id, endpointSlug });
  }
  const [a, b] = members as [(typeof members)[number], (typeof members)[number]];
  let sequence = 0;
  const attempt = (
    candidates: ReadonlyArray<typeof a>,
    overrides: Partial<AdmissionAttempt> = {},
  ): AdmissionAttempt => {
    sequence += 1;
    return {
      requestId: `request-${sequence}-${suffix}`,
      attemptId: `attempt-${sequence}-${suffix}`,
      ownerId: user.id,
      sourceKind: "POOL",
      poolId: pool.id,
      basePriority: 16,
      connectionOwner: "engine-load-proof",
      deadlineAt: new Date(Date.now() + 60_000),
      candidates: candidates.map((member, candidateOrder) => ({
        capacityId: member.capacityId,
        executionTargetId: member.targetId,
        poolMemberId: member.id,
        candidateOrder,
      })),
      ...overrides,
    };
  };
  const reading = (
    member: typeof a,
    overrides: Partial<{
      waiting: number;
      waitingStreak: number;
      kvUsage: number;
      receivedAt: Date;
    }> = {},
  ) => ({
    endpointSlug: member.endpointSlug,
    modelSlug: null,
    running: 4,
    waiting: 0,
    waitingStreak: 0,
    receivedAt: new Date(),
    ...overrides,
  });
  const cleanup = async () => {
    const terminalAt = new Date();
    await db.capacityLease.updateMany({
      where: { userId: user.id, state: "ACTIVE" },
      data: { state: "RELEASED", releasedAt: terminalAt, releaseReason: "test_cleanup" },
    });
    await db.capacityWaiter.updateMany({
      where: { userId: user.id, state: "WAITING" },
      data: { state: "CANCELLED", stateChangedAt: terminalAt, terminalReason: "test_cleanup" },
    });
    await db.admissionRequest.updateMany({
      where: { userId: user.id, state: { in: ["WAITING", "ADMITTED"] } },
      data: { state: "TERMINAL", terminalAt, terminalReason: "test_cleanup" },
    });
    await db.poolMemberRoutingVerdict.deleteMany({ where: { poolId: pool.id } });
  };
  return { user, device, pool, a, b, attempt, reading, cleanup };
}

function admitted(result: AdmissionResult): CapacityLeaseHandle {
  if (result.state !== "ADMITTED") throw new Error(`expected ADMITTED, got ${result.state}`);
  return result.lease;
}

async function requestState(db: Db, attemptId: string) {
  const request = await db.admissionRequest.findUniqueOrThrow({
    where: { attemptId },
    include: { Lease: true },
  });
  return { state: request.state, poolMemberId: request.Lease?.poolMemberId ?? null };
}

async function evaluatorFor(db: Db, userId: string, cliDeviceId: string) {
  const { MetricRoutingEvaluator, createRoutingEvaluationState } = await import(
    "../../relay/metric-routing-evaluator.js"
  );
  return {
    evaluator: new MetricRoutingEvaluator(db as never),
    state: createRoutingEvaluationState(userId, cliDeviceId),
  };
}

async function verdictOf(db: Db, poolMemberId: string) {
  return db.poolMemberRoutingVerdict.findUnique({ where: { poolMemberId } });
}

integration("PostgreSQL live engine load at candidate build and grant time", () => {
  it("a sustained-waiting vLLM member is FULL: a queued waiter is not granted on it, only elsewhere", async () => {
    if (!databaseUrl) return;
    const db = createFixturePrismaClient(databaseUrl);
    const f = await fixture(db);
    try {
      const { PostgresCapacityAdmissionStore } = await import("./postgres-store.js");
      const { applyMetricRoutingVerdicts } = await import("../metric-routing-order.js");
      const store = new PostgresCapacityAdmissionStore(db, "engine-load-proof");
      const { evaluator, state } = await evaluatorFor(db, f.user.id, f.device.id);
      const holdA = admitted(await store.acquire(f.attempt([f.a])));
      const holdB = admitted(await store.acquire(f.attempt([f.b])));
      const queued = f.attempt([f.a, f.b]);
      expect((await store.acquire(queued)).state).toBe("WAITING");

      // A's engine has requests waiting for two frames in a row; B's is idle.
      await evaluator.evaluate(state, {
        nodeMetrics: null,
        endpointLoad: [
          f.reading(f.a, { waiting: 3, waitingStreak: 2 }),
          f.reading(f.b, { waiting: 0 }),
        ],
      });
      expect(await verdictOf(db, f.a.id)).toMatchObject({
        verdict: "FULL",
        engineState: "full_waiting",
        cliDeviceId: f.device.id,
      });
      // Idle B and rule-less members get no row at all.
      expect(await verdictOf(db, f.b.id)).toBeNull();

      // Candidate build drops A (B is free of engine pressure).
      const built = await applyMetricRoutingVerdicts([
        { poolMemberId: f.a.id },
        { poolMemberId: f.b.id },
      ]);
      expect(built.candidates.map((candidate) => candidate.poolMemberId)).toEqual([f.b.id]);

      // A frees up, but A is load-FULL and B is not: the waiter stays queued.
      await store.release(holdA);
      expect(await requestState(db, queued.attemptId)).toEqual({
        state: "WAITING",
        poolMemberId: null,
      });
      // B frees up: granted on B.
      await store.release(holdB);
      expect(await requestState(db, queued.attemptId)).toEqual({
        state: "ADMITTED",
        poolMemberId: f.b.id,
      });
    } finally {
      await f.cleanup();
      await db.$disconnect();
    }
  });

  it("a single waiting frame, a stale reading and the 'off' override do not make a member FULL", async () => {
    if (!databaseUrl) return;
    const db = createFixturePrismaClient(databaseUrl);
    const f = await fixture(db);
    try {
      const { PostgresCapacityAdmissionStore } = await import("./postgres-store.js");
      const store = new PostgresCapacityAdmissionStore(db, "engine-load-proof");
      const { evaluator, state } = await evaluatorFor(db, f.user.id, f.device.id);
      await db.poolMember.update({ where: { id: f.b.id }, data: { engineLoadMode: "OFF" } });
      await evaluator.evaluate(state, {
        nodeMetrics: null,
        endpointLoad: [
          // A: sustained waiting, but the reading is 20 s old.
          f.reading(f.a, {
            waiting: 5,
            waitingStreak: 5,
            kvUsage: 1,
            receivedAt: new Date(Date.now() - 20_000),
          }),
          // B: FULL by every measure, but engine load is off for it.
          f.reading(f.b, { waiting: 5, waitingStreak: 5, kvUsage: 1 }),
        ],
      });
      expect(await verdictOf(db, f.a.id)).toBeNull();
      expect(await verdictOf(db, f.b.id)).toBeNull();
      // Lease counts decide: A takes the first request, B the second.
      expect(admitted(await store.acquire(f.attempt([f.a, f.b]))).poolMemberId).toBe(f.a.id);
      expect(admitted(await store.acquire(f.attempt([f.a, f.b]))).poolMemberId).toBe(f.b.id);

      // A single waiting frame (streak 1) is not "sustained".
      await evaluator.evaluate((await evaluatorFor(db, f.user.id, f.device.id)).state, {
        nodeMetrics: null,
        endpointLoad: [f.reading(f.a, { waiting: 5, waitingStreak: 1 })],
      });
      expect(await verdictOf(db, f.a.id)).toBeNull();
    } finally {
      await f.cleanup();
      await db.$disconnect();
    }
  });

  it("fails open when every candidate is load-FULL, and logs it", async () => {
    if (!databaseUrl) return;
    const db = createFixturePrismaClient(databaseUrl);
    const f = await fixture(db);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { PostgresCapacityAdmissionStore } = await import("./postgres-store.js");
      const { applyMetricRoutingVerdicts } = await import("../metric-routing-order.js");
      const store = new PostgresCapacityAdmissionStore(db, "engine-load-proof");
      const { evaluator, state } = await evaluatorFor(db, f.user.id, f.device.id);
      const holdA = admitted(await store.acquire(f.attempt([f.a])));
      admitted(await store.acquire(f.attempt([f.b])));
      const queued = f.attempt([f.a, f.b]);
      expect((await store.acquire(queued)).state).toBe("WAITING");
      await evaluator.evaluate(state, {
        nodeMetrics: null,
        endpointLoad: [
          f.reading(f.a, { kvUsage: 0.97 }),
          f.reading(f.b, { waiting: 2, waitingStreak: 3 }),
        ],
      });
      expect((await verdictOf(db, f.a.id))?.engineState).toBe("full_kv");
      expect((await verdictOf(db, f.b.id))?.engineState).toBe("full_waiting");
      // Candidate build keeps everyone (all FULL): admission decides.
      const built = await applyMetricRoutingVerdicts([
        { poolMemberId: f.a.id },
        { poolMemberId: f.b.id },
      ]);
      expect(built.allFull).toBe(true);
      expect(built.candidates).toHaveLength(2);
      // The queued plain-name waiter is served by leases alone.
      await store.release(holdA);
      expect(await requestState(db, queued.attemptId)).toEqual({
        state: "ADMITTED",
        poolMemberId: f.a.id,
      });
      expect(warn).toHaveBeenCalledWith(
        "[capacity] every candidate is metric-FULL; admitting by leases only",
        expect.objectContaining({ admissionRequestId: expect.any(String) }),
      );
    } finally {
      warn.mockRestore();
      await f.cleanup();
      await db.$disconnect();
    }
  });

  it("clears the row when load calms down and expires it when the readings stop", async () => {
    if (!databaseUrl) return;
    const db = createFixturePrismaClient(databaseUrl);
    const f = await fixture(db);
    try {
      const { PostgresCapacityAdmissionStore } = await import("./postgres-store.js");
      const store = new PostgresCapacityAdmissionStore(db, "engine-load-proof");
      const { evaluator, state } = await evaluatorFor(db, f.user.id, f.device.id);
      await evaluator.evaluate(state, {
        nodeMetrics: null,
        endpointLoad: [f.reading(f.a, { kvUsage: 0.99 })],
      });
      const full = await verdictOf(db, f.a.id);
      expect(full?.verdict).toBe("FULL");
      // The row expires with the reading (<= 15 s), so a dead CLI cannot pin FULL.
      expect(full!.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(15_000);
      expect(full!.expiresAt.getTime() - Date.now()).toBeGreaterThan(5_000);
      // Calm again: one clearing write.
      await evaluator.evaluate(state, {
        nodeMetrics: null,
        endpointLoad: [f.reading(f.a, { kvUsage: 0.2 })],
      });
      expect(await verdictOf(db, f.a.id)).toMatchObject({ verdict: "NONE", engineState: "clear" });
      // An expired FULL row does not gate admission.
      await db.poolMemberRoutingVerdict.update({
        where: { poolMemberId: f.a.id },
        data: { verdict: "FULL", expiresAt: new Date(Date.now() - 1_000) },
      });
      expect(admitted(await store.acquire(f.attempt([f.a, f.b]))).poolMemberId).toBe(f.a.id);
    } finally {
      await f.cleanup();
      await db.$disconnect();
    }
  });

  it("bounds writes: many frames from many endpoints write only on change or refresh", async () => {
    if (!databaseUrl) return;
    const db = createFixturePrismaClient(databaseUrl);
    const f = await fixture(db);
    try {
      const { evaluator, state } = await evaluatorFor(db, f.user.id, f.device.id);
      const create = vi.spyOn(db.poolMemberRoutingVerdict, "create");
      const update = vi.spyOn(db.poolMemberRoutingVerdict, "updateMany");
      for (let frame = 0; frame < 30; frame += 1) {
        await evaluator.evaluate(state, {
          nodeMetrics: null,
          endpointLoad: [
            f.reading(f.a, { kvUsage: 0.99 }),
            f.reading(f.b, { waiting: 1, waitingStreak: 1 }),
          ],
        });
      }
      // 30 frames inside one refresh window: one write for A (the fenced
      // publish tries the conditional update once, then creates), none for B.
      expect(create).toHaveBeenCalledTimes(1);
      expect(update).toHaveBeenCalledTimes(1);
    } finally {
      await f.cleanup();
      await db.$disconnect();
    }
  });
});
