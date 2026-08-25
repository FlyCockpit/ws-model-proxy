import { createPrismaClient } from "@ws-model-proxy/db/client-factory";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

if (!databaseUrl)
  console.warn("[cache-affinity] skipped: SCHEMA_VALIDATION_DATABASE_URL is not configured");

integration("cache affinity PostgreSQL concurrency and retention", () => {
  const db = databaseUrl ? createPrismaClient(databaseUrl) : undefined;
  let service: typeof import("./cache-affinity.js");

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    process.env.BETTER_AUTH_SECRET ??= "cache-affinity-integration-secret-32-bytes";
    process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
    service = await import("./cache-affinity.js");
  });

  afterAll(async () => db?.$disconnect());

  async function fixture() {
    if (!db) throw new Error("database unavailable");
    const suffix = crypto.randomUUID();
    const owner = await db.user.create({
      data: { name: "Affinity owner", email: `affinity-owner-${suffix}@example.test` },
    });
    const tenant = await db.user.create({
      data: { name: "Affinity tenant", email: `affinity-tenant-${suffix}@example.test` },
    });
    const otherTenant = await db.user.create({
      data: { name: "Other tenant", email: `affinity-other-${suffix}@example.test` },
    });
    const device = await db.cliDevice.create({
      data: { userId: owner.id, slug: `device-${suffix}`, label: "Device" },
    });
    const endpoint = await db.endpoint.create({
      data: {
        userId: owner.id,
        cliDeviceId: device.id,
        slug: `endpoint-${suffix}`,
        label: "Endpoint",
      },
    });
    const capacity = await db.inferenceCapacity.create({
      data: {
        userId: owner.id,
        label: `capacity-${suffix}`,
        runtimeIdentityKey: `runtime-${suffix}`,
        runtimeModel: "model",
      },
    });
    const targets = await Promise.all(
      ["a", "b"].map(async (label) => {
        const model = await db.discoveredModel.create({
          data: {
            userId: owner.id,
            endpointId: endpoint.id,
            upstreamModelId: `${label}-${suffix}`,
            encodedModelId: `${label}-${suffix}`,
          },
        });
        return db.executionTarget.update({
          where: { discoveredModelId: model.id },
          data: { inferenceCapacityId: capacity.id },
        });
      }),
    );
    const pool = await db.modelPool.create({
      data: { userId: owner.id, name: "Affinity pool", slug: `affinity-${suffix}` },
    });
    const target = (index: number) => ({
      poolMemberId: `member-${index}`,
      executionTargetId: targets[index]!.id,
      targetIdentity: `identity-${index}`,
      capacityId: capacity.id,
      hardConcurrencyLimit: null,
      healthPenalty: 0,
      publicEgressPenalty: 0,
      costPenalty: 0,
    });
    return { owner, tenant, otherTenant, pool, target };
  }

  const policy = {
    enabled: true,
    ttlSeconds: 60,
    maxRecords: 3,
    prefixWeight: 100,
    conversationWeight: 150,
    confirmedCacheWeight: 250,
    loadPenaltyWeight: 100,
  };

  it("serializes concurrent remembers and enforces a bound independently per target and tenant", async () => {
    if (!db) return;
    const row = await fixture();
    const remember = (tenantUserId: string, targetIndex: number, value: string) =>
      service.rememberAffinity({
        ownerId: tenantUserId,
        resourceOwnerId: row.owner.id,
        poolId: row.pool.id,
        policy,
        surface: "OPENAI_RESPONSES",
        payload: { input: value },
        target: row.target(targetIndex),
      });
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        remember(row.tenant.id, index % 2, `tenant request ${index}`),
      ),
    );
    await Promise.all([
      remember(row.otherTenant.id, 0, "isolated one"),
      remember(row.otherTenant.id, 0, "isolated two"),
    ]);
    const grouped = await db.cacheAffinityRecord.groupBy({
      by: ["tenantUserId", "executionTargetId"],
      where: { poolId: row.pool.id },
      _count: { _all: true },
    });
    expect(grouped.find((entry) => entry.tenantUserId === row.tenant.id)?._count._all).toBe(3);
    expect(grouped.filter((entry) => entry.tenantUserId === row.tenant.id)).toHaveLength(2);
    expect(grouped.find((entry) => entry.tenantUserId === row.otherTenant.id)?._count._all).toBe(2);
  });

  it("makes cleanup idempotent and safe against a concurrent refresh", async () => {
    if (!db) return;
    const row = await fixture();
    const args = {
      ownerId: row.tenant.id,
      resourceOwnerId: row.owner.id,
      poolId: row.pool.id,
      policy: { ...policy, ttlSeconds: 1 },
      surface: "OPENAI_RESPONSES",
      payload: { input: "same request" },
      target: row.target(0),
    };
    await service.rememberAffinity(args);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await Promise.all([
      service.sweepExpiredAffinity({ now: new Date(), limit: 1 }),
      service.rememberAffinity({ ...args, policy, now: new Date() }),
    ]);
    expect(
      await db.cacheAffinityRecord.count({
        where: { tenantUserId: row.tenant.id, poolId: row.pool.id, expiresAt: { gt: new Date() } },
      }),
    ).toBe(1);
    let swept = 1;
    for (let attempt = 0; attempt < 100 && swept > 0; attempt += 1) {
      swept = await service.sweepExpiredAffinity({ now: new Date(), limit: 10 });
    }
    expect(swept).toBe(0);
    expect(await service.sweepExpiredAffinity({ now: new Date(), limit: 1 })).toBe(0);
  });

  it("holds concurrent remember behind the pool row lock", async () => {
    if (!db || !databaseUrl) return;
    const row = await fixture();
    const blocker = createPrismaClient(databaseUrl);
    let releaseLock!: () => void;
    let signalLockAcquired!: () => void;
    const lockAcquired = new Promise<void>((resolve) => {
      signalLockAcquired = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const lock = blocker.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM model_pool WHERE id = ${row.pool.id} FOR UPDATE`;
      signalLockAcquired();
      await release;
    });
    await lockAcquired;
    let settled = false;
    const remembering = service
      .rememberAffinity({
        ownerId: row.tenant.id,
        resourceOwnerId: row.owner.id,
        poolId: row.pool.id,
        policy,
        surface: "OPENAI_RESPONSES",
        payload: { input: "blocked" },
        target: row.target(0),
      })
      .finally(() => {
        settled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(settled).toBe(false);
    releaseLock();
    await Promise.all([lock, remembering]);
    expect(settled).toBe(true);
    await blocker.$disconnect();
  });
});
