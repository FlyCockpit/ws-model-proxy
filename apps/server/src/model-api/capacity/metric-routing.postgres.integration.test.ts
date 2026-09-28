import { createPrismaClient } from "@ws-model-proxy/db/client-factory";
import { describe, expect, it, vi } from "vitest";
import type { AdmissionAttempt, AdmissionResult, CapacityLeaseHandle } from "./types.js";

// Metric routing rules at grant time (S-B part 2): #admitOne reads the
// H-class `pool_member_routing_verdict` table with a plain SELECT and skips
// waiters whose member is fresh metric-FULL, failing open per request when
// every live candidate of that request is metric-FULL.

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error(
    "PostgreSQL integration was required but SCHEMA_VALIDATION_DATABASE_URL is unset.",
  );
const integration = databaseUrl ? describe : describe.skip;

type Db = ReturnType<typeof createPrismaClient>;

async function fixture(db: Db) {
  // The store module imports the default client, which validates the env.
  process.env.DATABASE_URL = databaseUrl;
  const suffix = crypto.randomUUID();
  const user = await db.user.create({
    data: {
      name: "Metric routing proof",
      email: `metric-routing-${suffix}@example.test`,
      slug: `metric-${suffix}`,
    },
  });
  const device = await db.cliDevice.create({ data: { userId: user.id, slug: `d-${suffix}` } });
  const endpoint = await db.endpoint.create({
    data: { userId: user.id, cliDeviceId: device.id, slug: `e-${suffix}`, label: "Endpoint" },
  });
  const pool = await db.modelPool.create({
    data: { userId: user.id, slug: `p-${suffix}`, name: "Metric pool" },
  });
  // Two members, each on its own single-slot capacity.
  const members: Array<{ id: string; targetId: string; capacityId: string }> = [];
  for (const name of ["a", "b"]) {
    const capacity = await db.inferenceCapacity.create({
      data: {
        userId: user.id,
        label: `${name}-${suffix}`,
        runtimeIdentityKey: `${name}-${suffix}`,
        runtimeModel: name,
        hardConcurrencyLimit: 1,
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
    members.push({ id: member.id, targetId: target.id, capacityId: capacity.id });
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
      connectionOwner: "metric-proof",
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
  const setVerdict = async (
    member: typeof a,
    verdict: "NONE" | "AVOID" | "FULL",
    expiresInMs = 60_000,
  ) => {
    const data = {
      userId: user.id,
      poolId: pool.id,
      cliDeviceId: device.id,
      verdict,
      ruleStates: ["triggered"],
      evaluatedAt: new Date(),
      expiresAt: new Date(Date.now() + expiresInMs),
    };
    await db.poolMemberRoutingVerdict.upsert({
      where: { poolMemberId: member.id },
      create: { poolMemberId: member.id, ...data },
      update: data,
    });
  };
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
  return { user, pool, a, b, attempt, setVerdict, cleanup };
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

integration("PostgreSQL metric routing at grant time", () => {
  it("does not grant a queued waiter on a metric-FULL member, and grants it elsewhere", async () => {
    if (!databaseUrl) return;
    const db = createPrismaClient(databaseUrl);
    const f = await fixture(db);
    try {
      const { PostgresCapacityAdmissionStore } = await import("./postgres-store.js");
      const store = new PostgresCapacityAdmissionStore(db, "metric-proof");
      const holdA = admitted(await store.acquire(f.attempt([f.a])));
      const holdB = admitted(await store.acquire(f.attempt([f.b])));
      const queued = f.attempt([f.a, f.b]);
      expect((await store.acquire(queued)).state).toBe("WAITING");

      await f.setVerdict(f.a, "FULL");
      // A frees up, but A is metric-FULL and B is not: no fail-open.
      await store.release(holdA);
      expect(await requestState(db, queued.attemptId)).toEqual({
        state: "WAITING",
        poolMemberId: null,
      });
      // Polling the request does not grant it on A either.
      expect((await store.acquire({ ...queued, candidates: [] })).state).toBe("WAITING");

      // B frees up: the waiter is granted on B.
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

  it("fails open when every candidate is metric-FULL, and logs it", async () => {
    if (!databaseUrl) return;
    const db = createPrismaClient(databaseUrl);
    const f = await fixture(db);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { PostgresCapacityAdmissionStore } = await import("./postgres-store.js");
      const store = new PostgresCapacityAdmissionStore(db, "metric-proof");
      const holdA = admitted(await store.acquire(f.attempt([f.a])));
      admitted(await store.acquire(f.attempt([f.b])));
      const queued = f.attempt([f.a, f.b]);
      expect((await store.acquire(queued)).state).toBe("WAITING");
      await f.setVerdict(f.a, "FULL");
      await f.setVerdict(f.b, "FULL");
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

  it("keeps an :external shortened-phase request waiting instead of failing open", async () => {
    if (!databaseUrl) return;
    const db = createPrismaClient(databaseUrl);
    const f = await fixture(db);
    try {
      const { PostgresCapacityAdmissionStore } = await import("./postgres-store.js");
      const store = new PostgresCapacityAdmissionStore(db, "metric-proof");
      await f.setVerdict(f.a, "FULL");
      await f.setVerdict(f.b, "FULL");
      // Both members have free slots, but the request must not fail open.
      const external = f.attempt([f.a, f.b], { metricFailOpen: false });
      expect((await store.acquire(external)).state).toBe("WAITING");
      expect(
        (await db.admissionRequest.findUniqueOrThrow({ where: { attemptId: external.attemptId } }))
          .metricFailOpen,
      ).toBe(false);
      // The resumed (plain) phase is a new attempt that fails open.
      const resumed = f.attempt([f.a, f.b]);
      expect(admitted(await store.acquire(resumed)).poolMemberId).toBe(f.a.id);
    } finally {
      await f.cleanup();
      await db.$disconnect();
    }
  });

  it("ignores an expired verdict and never gates on avoid", async () => {
    if (!databaseUrl) return;
    const db = createPrismaClient(databaseUrl);
    const f = await fixture(db);
    try {
      const { PostgresCapacityAdmissionStore } = await import("./postgres-store.js");
      const store = new PostgresCapacityAdmissionStore(db, "metric-proof");
      await f.setVerdict(f.a, "FULL", -1_000);
      expect(admitted(await store.acquire(f.attempt([f.a, f.b]))).poolMemberId).toBe(f.a.id);
      await f.cleanup();
      await f.setVerdict(f.a, "AVOID");
      expect(admitted(await store.acquire(f.attempt([f.a, f.b]))).poolMemberId).toBe(f.a.id);
    } finally {
      await f.cleanup();
      await db.$disconnect();
    }
  });

  it("skips a metric-FULL first candidate in the creating pass", async () => {
    if (!databaseUrl) return;
    const db = createPrismaClient(databaseUrl);
    const f = await fixture(db);
    try {
      const { PostgresCapacityAdmissionStore } = await import("./postgres-store.js");
      const store = new PostgresCapacityAdmissionStore(db, "metric-proof");
      await f.setVerdict(f.a, "FULL");
      expect(admitted(await store.acquire(f.attempt([f.a, f.b]))).poolMemberId).toBe(f.b.id);
    } finally {
      await f.cleanup();
      await db.$disconnect();
    }
  });

  it("reads verdicts without locks: a held verdict row lock does not block admission", async () => {
    if (!databaseUrl) return;
    const db = createPrismaClient(databaseUrl);
    const holder = createPrismaClient(databaseUrl);
    const f = await fixture(db);
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });
    try {
      await f.setVerdict(f.a, "FULL");
      const hold = holder.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT "poolMemberId" FROM pool_member_routing_verdict
            WHERE "poolMemberId" = ${f.a.id} FOR UPDATE`;
          locked();
          await released;
        },
        { timeout: 20_000 },
      );
      await holding;
      const { PostgresCapacityAdmissionStore } = await import("./postgres-store.js");
      const store = new PostgresCapacityAdmissionStore(db, "metric-proof");
      const result = await Promise.race([
        store.acquire(f.attempt([f.a, f.b])),
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 5_000)),
      ]);
      expect(result).not.toBe("blocked");
      expect(admitted(result as AdmissionResult).poolMemberId).toBe(f.b.id);
      release();
      await hold;
    } finally {
      release();
      await f.cleanup();
      await Promise.all([db.$disconnect(), holder.$disconnect()]);
    }
  });
});
