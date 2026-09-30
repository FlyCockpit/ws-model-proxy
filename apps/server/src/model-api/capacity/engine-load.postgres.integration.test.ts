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
  it.each(["sequential", "delayed create", "rules control"])(
    "successor fence: %s restores candidate and queued admission",
    async (scenario) => {
      if (!databaseUrl) return;
      const db = createFixturePrismaClient(databaseUrl);
      const f = await fixture(db);
      let release: () => void = () => undefined;
      let entered: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let pending: Promise<void> | undefined;
      try {
        const { MetricRoutingEvaluator, createRoutingEvaluationState } = await import(
          "../../relay/metric-routing-evaluator.js"
        );
        const { PostgresCapacityAdmissionStore } = await import("./postgres-store.js");
        const { applyMetricRoutingVerdicts } = await import("../metric-routing-order.js");
        if (scenario === "rules control") {
          await db.modelPool.update({
            where: { id: f.pool.id },
            data: {
              routingRules: [
                { metric: "endpoint.waiting", op: ">=", threshold: 2, effect: "full" },
              ],
            },
          });
        }
        let now = new Date();
        const a = createRoutingEvaluationState(f.user.id, f.device.id);
        const b = createRoutingEvaluationState(f.user.id, f.device.id);
        // Pause before a real PostgreSQL CREATE through Prisma's query hook;
        // the successor uses its own client path and can publish meanwhile.
        const predecessorDb = db.$extends({
          query: {
            poolMemberRoutingVerdict: {
              async create({ args, query }) {
                if (scenario === "delayed create" && args.data.poolMemberId === f.a.id) {
                  entered();
                  await gate;
                }
                return query(args);
              },
            },
          },
        });
        const predecessor = new MetricRoutingEvaluator(predecessorDb as never, () => now);
        const successor = new MetricRoutingEvaluator(db as never, () => now);
        const store = new PostgresCapacityAdmissionStore(db, "successor-proof");
        const holdA = admitted(await store.acquire(f.attempt([f.a])));
        admitted(await store.acquire(f.attempt([f.b])));
        const queued = f.attempt([f.a, f.b]);
        expect((await store.acquire(queued)).state).toBe("WAITING");
        const hotInputs = {
          nodeMetrics: null,
          endpointLoad: [
            f.reading(f.a, { kvUsage: 0.99, receivedAt: now }),
            f.reading(f.b, { receivedAt: now }),
          ],
        };
        if (scenario === "delayed create") {
          pending = predecessor.evaluate(a, hotInputs);
          await started;
          expect(await verdictOf(db, f.a.id)).toBeNull();
        } else {
          await predecessor.evaluate(a, hotInputs);
          expect(await verdictOf(db, f.a.id)).toMatchObject({
            verdict: "FULL",
            engineState: "full_kv",
          });
          const blocked = await applyMetricRoutingVerdicts([
            { poolMemberId: f.a.id },
            { poolMemberId: f.b.id },
          ]);
          expect(blocked.candidates.map((candidate) => candidate.poolMemberId)).toEqual([f.b.id]);
        }
        predecessor.cancel(a);
        now = new Date(now.getTime() + 1_000);
        await successor.evaluate(b, {
          nodeMetrics: null,
          endpointLoad: [
            f.reading(f.a, { kvUsage: 0.2, receivedAt: now }),
            f.reading(f.b, { receivedAt: now }),
          ],
        });
        expect(await verdictOf(db, f.a.id)).toMatchObject({
          verdict: "NONE",
          engineState: "clear",
          publisherId: b.publisherId,
          evaluatedAt: now,
          ruleStates: scenario === "rules control" ? ["clear"] : [],
        });
        release();
        await pending;
        expect(await verdictOf(db, f.a.id)).toMatchObject({
          verdict: "NONE",
          publisherId: b.publisherId,
        });
        const built = await applyMetricRoutingVerdicts([
          { poolMemberId: f.a.id },
          { poolMemberId: f.b.id },
        ]);
        expect(built.candidates).toHaveLength(2);
        await store.release(holdA);
        expect(await requestState(db, queued.attemptId)).toEqual({
          state: "ADMITTED",
          poolMemberId: f.a.id,
        });
      } finally {
        release();
        await pending;
        await f.cleanup();
        await db.$disconnect();
      }
    },
  );

  it.each([0.2, 0.99])(
    "successor fence: KV %s obeys the idle and FULL refresh budgets",
    async (kvUsage) => {
      if (!databaseUrl) return;
      const db = createFixturePrismaClient(databaseUrl);
      const f = await fixture(db);
      const create = vi.spyOn(db.poolMemberRoutingVerdict, "create");
      const update = vi.spyOn(db.poolMemberRoutingVerdict, "updateMany");
      try {
        const { MetricRoutingEvaluator, createRoutingEvaluationState } = await import(
          "../../relay/metric-routing-evaluator.js"
        );
        let now = new Date();
        const evaluator = new MetricRoutingEvaluator(db as never, () => now);
        const state = createRoutingEvaluationState(f.user.id, f.device.id);
        for (let frame = 0; frame < 6; frame += 1) {
          await evaluator.evaluate(state, {
            nodeMetrics: null,
            endpointLoad: [f.reading(f.a, { kvUsage, receivedAt: now })],
          });
          expect(
            create.mock.calls.filter(([args]) => args.data.poolMemberId === f.a.id),
          ).toHaveLength(1);
          expect(
            update.mock.calls.filter(([args]) => args.where?.poolMemberId === f.a.id),
          ).toHaveLength(kvUsage === 0.99 && frame === 5 ? 2 : 1);
          now = new Date(now.getTime() + 1_000);
        }
      } finally {
        create.mockRestore();
        update.mockRestore();
        await f.cleanup();
        await db.$disconnect();
      }
    },
  );

  it("successor fence: another process's override edit restores an unchanged FULL at the next frame", async () => {
    if (!databaseUrl) return;
    const db = createFixturePrismaClient(databaseUrl);
    const f = await fixture(db);
    try {
      const { MetricRoutingEvaluator, createRoutingEvaluationState } = await import(
        "../../relay/metric-routing-evaluator.js"
      );
      let now = new Date();
      const evaluator = new MetricRoutingEvaluator(db as never, () => now);
      const state = createRoutingEvaluationState(f.user.id, f.device.id);
      await db.poolMember.update({ where: { id: f.a.id }, data: { kvFullThreshold: 0.95 } });
      await evaluator.evaluate(state, {
        nodeMetrics: null,
        endpointLoad: [f.reading(f.a, { kvUsage: 0.97, receivedAt: now })],
      });
      await db.poolMember.update({ where: { id: f.a.id }, data: { kvFullThreshold: 0.96 } });
      await new MetricRoutingEvaluator(db as never, () => now).clearPool(f.pool.id);
      expect(await verdictOf(db, f.a.id)).toBeNull();
      now = new Date(now.getTime() + 1_000);
      await evaluator.evaluate(state, {
        nodeMetrics: null,
        endpointLoad: [f.reading(f.a, { kvUsage: 0.97, receivedAt: now })],
      });
      expect(await verdictOf(db, f.a.id)).toMatchObject({
        verdict: "FULL",
        engineState: "full_kv",
        evaluatedAt: now,
      });
    } finally {
      await f.cleanup();
      await db.$disconnect();
    }
  });

  it.each(["member leaves", "local clear"])(
    "successor fence: %s resets the probe",
    async (event) => {
      if (!databaseUrl) return;
      const db = createFixturePrismaClient(databaseUrl);
      const f = await fixture(db);
      try {
        const { MetricRoutingEvaluator, createRoutingEvaluationState } = await import(
          "../../relay/metric-routing-evaluator.js"
        );
        let now = new Date();
        const evaluator = new MetricRoutingEvaluator(db as never, () => now);
        const state = createRoutingEvaluationState(f.user.id, f.device.id);
        const inputs = () => ({
          nodeMetrics: null,
          endpointLoad: [f.reading(f.a, { kvUsage: 0.2, receivedAt: now })],
        });
        await evaluator.evaluate(state, inputs());
        now = new Date(now.getTime() + 1_000);
        if (event === "member leaves") {
          const otherDevice = await db.cliDevice.create({
            data: { userId: f.user.id, slug: `other-${crypto.randomUUID()}` },
          });
          const endpoint = { userId: f.user.id, slug: f.a.endpointSlug };
          await db.endpoint.updateMany({ where: endpoint, data: { cliDeviceId: otherDevice.id } });
          await evaluator.evaluate(state, inputs());
          expect(state.probed.has(f.a.id)).toBe(false);
          await db.endpoint.updateMany({ where: endpoint, data: { cliDeviceId: f.device.id } });
        } else {
          await evaluator.clearPool(f.pool.id);
        }
        await evaluator.evaluate(state, inputs());
        expect(await verdictOf(db, f.a.id)).toMatchObject({ verdict: "NONE", evaluatedAt: now });
        now = new Date(now.getTime() + 1_000);
        await evaluator.evaluate(state, inputs());
        expect((await verdictOf(db, f.a.id))?.evaluatedAt.getTime()).toBe(now.getTime() - 1_000);
      } finally {
        await f.cleanup();
        await db.$disconnect();
      }
    },
  );

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
      // Idle B gets one successor fence, which never gates admission.
      expect(await verdictOf(db, f.b.id)).toMatchObject({ verdict: "NONE" });

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
      expect(await verdictOf(db, f.a.id)).toMatchObject({ verdict: "NONE", engineState: "stale" });
      expect(await verdictOf(db, f.b.id)).toMatchObject({ verdict: "NONE", engineState: "off" });
      // Lease counts decide: A takes the first request, B the second.
      expect(admitted(await store.acquire(f.attempt([f.a, f.b]))).poolMemberId).toBe(f.a.id);
      expect(admitted(await store.acquire(f.attempt([f.a, f.b]))).poolMemberId).toBe(f.b.id);

      // A single waiting frame (streak 1) is not "sustained".
      await evaluator.evaluate((await evaluatorFor(db, f.user.id, f.device.id)).state, {
        nodeMetrics: null,
        endpointLoad: [f.reading(f.a, { waiting: 5, waitingStreak: 1 })],
      });
      expect(await verdictOf(db, f.a.id)).toMatchObject({ verdict: "NONE" });
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
      // publish tries the conditional update once, then creates), one NONE
      // successor fence for B. Neither member writes on every frame.
      expect(create).toHaveBeenCalledTimes(2);
      expect(update).toHaveBeenCalledTimes(2);
    } finally {
      await f.cleanup();
      await db.$disconnect();
    }
  });
});
