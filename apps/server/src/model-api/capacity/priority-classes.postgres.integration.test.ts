import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AdmissionAttempt } from "./types.js";

// The limits-redesign scheduler (three priority classes, kept slots as a guarantee, the borrow
// switch, the share's class) on real PostgreSQL and the 0.4.0 graph (runtime instance =
// capacity, pool_routing). Ported from the limits-redesign store proofs onto the 0.4.0 schema;
// the planner and DRR logic themselves are unit-tested in admission-planner/scheduler tests.
// Routing changes mid-test go through the seeding (fixture) client, which skips the policy
// fences a real `pools.update` takes; the test runs alone, so nothing races them.

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("SCHEMA_VALIDATION_DATABASE_URL is required for PostgreSQL integration tests");
const integration = databaseUrl ? describe : describe.skip;

const hex = (text: string) => createHash("sha256").update(text).digest("hex");

type Fixture = Awaited<ReturnType<typeof seed>>;

async function seed(url: string) {
  const { createFixturePrismaClient } = await import("@ws-model-proxy/db/test-fixture-client");
  const db = createFixturePrismaClient(url);
  const suffix = randomUUID().slice(0, 8);
  const owner = await db.user.create({
    data: { id: `cap-owner-${suffix}`, name: "Owner", email: `cap-owner-${suffix}@example.test` },
  });
  const grantee = await db.user.create({
    data: {
      id: `cap-grantee-${suffix}`,
      name: "Grantee",
      email: `cap-grantee-${suffix}@example.test`,
    },
  });
  const spec = {
    api: "openai",
    engine: "vllm",
    modelType: "llm",
    models: [{ id: "m" }],
    launch: {
      management: "process",
      groupSize: 1,
      resources: [{ kind: "none" }],
      labels: [],
      commands: [{ start: "serve --port {{port}}", stop: "true" }],
      readiness: { path: "/v1/models", expectedStatus: 200, timeoutMs: 60_000 },
      health: { intervalMs: 15_000, failureThreshold: 3, successThreshold: 1 },
    },
  };
  const runtime = await db.runtime.create({
    data: {
      userId: owner.id,
      slug: `cap-${suffix}`,
      name: "Cap",
      kind: "STARTABLE",
      origin: "SERVER",
    },
  });
  const version = await db.runtimeVersion.create({
    data: {
      runtimeId: runtime.id,
      version: 1,
      editor: "USER",
      editorUserId: owner.id,
      contentHash: hex(`content-${suffix}`),
      launchHash: hex(`launch-${suffix}`),
      spec,
      api: "OPENAI",
      engine: "VLLM",
      modelType: "LLM",
      // Two requests at once on the instance.
      concurrencyLimit: 2,
    },
  });
  const model = await db.runtimeModel.create({
    data: { userId: owner.id, runtimeId: runtime.id, upstreamModelId: "m", type: "LLM" },
  });
  const instance = await db.runtimeInstance.create({
    data: {
      userId: owner.id,
      runtimeId: runtime.id,
      versionId: version.id,
      launchVersionId: version.id,
      handle: `i-${hex(suffix).slice(0, 12)}`,
      startedBy: "USER",
      desiredState: "RUNNING",
      phase: "READY",
    },
  });
  const target = await db.executionTarget.create({
    data: {
      userId: owner.id,
      kind: "INSTANCE_MODEL",
      instanceId: instance.id,
      runtimeModelId: model.id,
    },
  });
  const pools = [];
  for (const name of ["a", "b"]) {
    const pool = await db.pool.create({
      data: { userId: owner.id, slug: `cap-${name}-${suffix}`, name, modelType: "LLM" },
    });
    // The routing row comes with the pool (schema trigger).
    await db.poolRouting.update({
      where: { poolId: pool.id },
      data: { keptSlots: 1, borrowKept: false },
    });
    const member = await db.poolMember.create({
      data: { poolId: pool.id, kind: "LOCAL", runtimeModelId: model.id },
    });
    pools.push({ pool, member });
  }
  const share = await db.share.create({
    data: {
      poolId: pools[1]?.pool.id ?? "",
      ownerUserId: owner.id,
      granteeUserId: grantee.id,
      priorityClass: "HIGH",
    },
  });
  return { db, owner, grantee, instance, target, pools, share, suffix };
}

async function cleanup(fixture: Fixture) {
  const { db, owner, grantee, instance } = fixture;
  // Every row this run seeded, children first, each delete scoped (WHERE) to this run.
  try {
    await db.capacityLease.deleteMany({ where: { capacityId: instance.id } });
    await db.capacityWaiter.deleteMany({ where: { capacityId: instance.id } });
    await db.admissionRequest.deleteMany({ where: { userId: owner.id } });
    await db.capacityScheduler.deleteMany({ where: { capacityId: instance.id } });
    // The instance (its targets cascade), then the pools (members, routing, shares cascade),
    // then the users (runtime, versions and models cascade).
    await db.runtimeInstance.deleteMany({ where: { id: instance.id } });
    await db.pool.deleteMany({ where: { userId: owner.id } });
    await db.user.deleteMany({ where: { id: { in: [owner.id, grantee.id] } } });
    expect(await db.runtime.count({ where: { userId: owner.id } })).toBe(0);
  } finally {
    await db.$disconnect();
  }
}

integration("PostgreSQL priority classes and kept slots (0.4.0 graph)", () => {
  async function store(name: string) {
    // The store module loads the shared client, which validates DATABASE_URL.
    process.env.DATABASE_URL = databaseUrl;
    const [{ createPrismaClient }, { PostgresCapacityAdmissionStore }] = await Promise.all([
      import("@ws-model-proxy/db/client-factory"),
      import("./postgres-store.js"),
    ]);
    const client = createPrismaClient(databaseUrl ?? "");
    return { client, store: new PostgresCapacityAdmissionStore(client, name) };
  }

  function attempt(
    fixture: Fixture,
    poolIndex: 0 | 1,
    label: string,
    extra: Partial<AdmissionAttempt> = {},
  ): AdmissionAttempt {
    const entry = fixture.pools[poolIndex];
    if (!entry) throw new Error("no pool");
    const attemptId = `${label}-${fixture.suffix}`;
    return {
      requestId: attemptId,
      attemptId,
      ownerId: fixture.owner.id,
      sourceKind: "POOL",
      poolId: entry.pool.id,
      basePriority: 1,
      connectionOwner: "classes-proof",
      deadlineAt: new Date(Date.now() + 60_000),
      candidates: [
        {
          capacityId: fixture.instance.id,
          executionTargetId: fixture.target.id,
          poolMemberId: entry.member.id,
          candidateOrder: 0,
        },
      ],
      ...extra,
    };
  }

  it("keeps kept slots as a guarantee and honours the borrow switch", async () => {
    if (!databaseUrl) return;
    const { client, store: admission } = await store("classes-proof");
    const fixture = await seed(databaseUrl);
    try {
      const { db, pools } = fixture;
      const [a, b] = pools;
      if (!a || !b) throw new Error("pools");
      // Two slots, each pool keeps one; borrowing is off for both.
      const a1 = await admission.acquire(attempt(fixture, 0, "a1"));
      expect(a1.state).toBe("ADMITTED");
      // A second request of pool A would take B's kept slot: it waits.
      await expect(admission.acquire(attempt(fixture, 0, "a2"))).resolves.toMatchObject({
        state: "WAITING",
      });
      await admission.cancelAttempt(`a2-${fixture.suffix}`);

      // With the borrow switch on, A borrows B's idle kept slot.
      await db.poolRouting.update({ where: { poolId: a.pool.id }, data: { borrowKept: true } });
      const a3 = await admission.acquire(attempt(fixture, 0, "a3"));
      expect(a3.state).toBe("ADMITTED");
      expect(
        await db.capacityLease.findUnique({ where: { attemptId: `a3-${fixture.suffix}` } }),
      ).toMatchObject({ borrowed: true, state: "ACTIVE" });

      // Now B wants its kept slot while a HIGH-class A borrower also waits: when a slot frees,
      // the owner with an unmet kept slot gets it, whatever the classes.
      await db.poolRouting.update({
        where: { poolId: a.pool.id },
        data: { priorityClass: "HIGH" },
      });
      await db.poolRouting.update({
        where: { poolId: b.pool.id },
        data: { priorityClass: "BACKGROUND" },
      });
      await expect(admission.acquire(attempt(fixture, 0, "a4"))).resolves.toMatchObject({
        state: "WAITING",
      });
      await expect(admission.acquire(attempt(fixture, 1, "b1"))).resolves.toMatchObject({
        state: "WAITING",
      });
      if (a1.state !== "ADMITTED") throw new Error("a1");
      await admission.release(a1.lease);
      expect(
        await db.capacityLease.findUnique({ where: { attemptId: `b1-${fixture.suffix}` } }),
      ).toMatchObject({ state: "ACTIVE", borrowed: false });
      expect(
        await db.admissionRequest.findUnique({ where: { attemptId: `a4-${fixture.suffix}` } }),
      ).toMatchObject({ state: "WAITING" });
    } finally {
      await client.$disconnect();
      await cleanup(fixture);
    }
  });

  it("gives a share holder's waiters the share's class, and a pool's waiters the pool's", async () => {
    if (!databaseUrl) return;
    const { client, store: admission } = await store("share-class-proof");
    const fixture = await seed(databaseUrl);
    try {
      const { db } = fixture;
      // Fill both slots (each pool's kept slot), then queue one of each.
      for (const [index, label] of [
        [0, "fill-a"],
        [1, "fill-b"],
      ] as const)
        expect((await admission.acquire(attempt(fixture, index, label))).state).toBe("ADMITTED");
      await admission.acquire(attempt(fixture, 1, "pool-class"));
      await admission.acquire(
        attempt(fixture, 1, "share-class", { priorityShareId: fixture.share.id }),
      );
      const waiters = await db.capacityWaiter.findMany({
        where: { capacityId: fixture.instance.id, state: "WAITING" },
        select: { effectivePriority: true, AdmissionRequest: { select: { attemptId: true } } },
      });
      const byAttempt = new Map(
        waiters.map((waiter) => [waiter.AdmissionRequest.attemptId, waiter.effectivePriority]),
      );
      // NORMAL = 1 (the pool's class), HIGH = 2 (the share's).
      expect(byAttempt.get(`pool-class-${fixture.suffix}`)).toBe(1);
      expect(byAttempt.get(`share-class-${fixture.suffix}`)).toBe(2);
    } finally {
      await client.$disconnect();
      await cleanup(fixture);
    }
  });
});
