import { createPrismaClient } from "@ws-model-proxy/db/client-factory";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Real-PostgreSQL proof of the warm-session query (saturation S-C): one
 * bounded, non-locking read per request, grouped into sessions by the shared
 * `lastUsedAt` of one request's records, with the owner/grant overrides, and
 * cheap at the default retention bound (10 000 records per pool).
 */
const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error(
    "PostgreSQL integration was required but SCHEMA_VALIDATION_DATABASE_URL is unset.",
  );
const integration = databaseUrl ? describe : describe.skip;

if (!databaseUrl)
  console.warn(
    "[warm-protection-postgres] skipped: SCHEMA_VALIDATION_DATABASE_URL is not configured",
  );

type Db = ReturnType<typeof createPrismaClient>;

integration("warm-session protection with real PostgreSQL", () => {
  let db: Db;
  let warm: typeof import("./warm-protection.js");

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    db = createPrismaClient(databaseUrl);
    warm = await import("./warm-protection.js");
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  async function user(label: string) {
    const suffix = crypto.randomUUID();
    return db.user.create({
      data: {
        name: `Warm ${label}`,
        email: `warm-${label}-${suffix}@example.test`,
        slug: `warm-${label}-${suffix}`,
      },
    });
  }

  it("groups one request's records into a session and reads overrides, in bounded time", async () => {
    if (!databaseUrl) return;
    const suffix = crypto.randomUUID();
    const owner = await user("owner");
    const unprotected = await user("unprotected");
    const grantee = await user("grantee");
    try {
      const device = await db.cliDevice.create({
        data: { userId: owner.id, slug: `device-${suffix}` },
      });
      const endpoint = await db.endpoint.create({
        data: { userId: owner.id, cliDeviceId: device.id, slug: `endpoint-${suffix}`, label: "W" },
      });
      const pool = await db.modelPool.create({
        data: {
          userId: owner.id,
          slug: `pool-${suffix}`,
          name: "Warm pool",
          ownerProtectionPercent: 40,
        },
      });
      const otherPool = await db.modelPool.create({
        data: { userId: owner.id, slug: `other-${suffix}`, name: "Other pool" },
      });
      await db.poolGrant.create({
        data: {
          poolId: pool.id,
          ownerUserId: owner.id,
          granteeUserId: unprotected.id,
          protectionOverridePercent: 0,
        },
      });
      await db.poolGrant.create({
        data: { poolId: pool.id, ownerUserId: owner.id, granteeUserId: grantee.id },
      });
      const capacity = async (label: string) =>
        db.inferenceCapacity.create({
          data: {
            userId: owner.id,
            label: `${label}-${suffix}`,
            runtimeIdentityKey: `${label}-${suffix}`,
            runtimeModel: "warm-proof",
            hardConcurrencyLimit: 2,
          },
        });
      const target = async (label: string, capacityId: string) => {
        const model = await db.discoveredModel.create({
          data: {
            userId: owner.id,
            endpointId: endpoint.id,
            upstreamModelId: label,
            encodedModelId: `${label}-${suffix}`,
          },
        });
        return db.executionTarget.update({
          where: { discoveredModelId: model.id },
          data: { inferenceCapacityId: capacityId },
        });
      };
      const capacityA = await capacity("a");
      const capacityB = await capacity("b");
      const targetA1 = await target("a1", capacityA.id);
      // Same physical KV pool, served through another pool of the owner.
      const targetA2 = await target("a2", capacityA.id);
      const targetB = await target("b", capacityB.id);

      const now = new Date();
      const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);
      const future = new Date(now.getTime() + 3_600_000);
      let sequence = 0;
      const records = (input: {
        tenantUserId: string;
        poolId: string;
        executionTargetId: string;
        lastUsedAt: Date;
        tokens: number[];
        expiresAt?: Date;
      }) =>
        input.tokens.map((estimatedTokens, index) => ({
          userId: owner.id,
          tenantUserId: input.tenantUserId,
          poolId: input.poolId,
          executionTargetId: input.executionTargetId,
          targetIdentity: "identity",
          bindingDigest: "b".repeat(64),
          prefixDigest: `prefix-${String(sequence++).padStart(40, "0")}`,
          prefixDepth: index + 1,
          estimatedTokens,
          lastUsedAt: input.lastUsedAt,
          createdAt: ago(3_700 + 1_000),
          expiresAt: input.expiresAt ?? future,
        }));
      await db.cacheAffinityRecord.createMany({
        data: [
          // Owner session on A: three records of one request; size = the max.
          ...records({
            tenantUserId: owner.id,
            poolId: pool.id,
            executionTargetId: targetA1.id,
            lastUsedAt: ago(10),
            tokens: [20_000, 20_000, 12_000],
          }),
          // Unprotected grantee on A.
          ...records({
            tenantUserId: unprotected.id,
            poolId: pool.id,
            executionTargetId: targetA1.id,
            lastUsedAt: ago(20),
            tokens: [30_000],
          }),
          // Grantee on A through the other pool (no grant there: inherit).
          ...records({
            tenantUserId: grantee.id,
            poolId: otherPool.id,
            executionTargetId: targetA2.id,
            lastUsedAt: ago(30),
            tokens: [9_000, 9_000],
          }),
          // Too small, too old, expired: never read.
          ...records({
            tenantUserId: grantee.id,
            poolId: pool.id,
            executionTargetId: targetA1.id,
            lastUsedAt: ago(40),
            tokens: [4_000],
          }),
          ...records({
            tenantUserId: grantee.id,
            poolId: pool.id,
            executionTargetId: targetA1.id,
            lastUsedAt: ago(400),
            tokens: [50_000],
          }),
          ...records({
            tenantUserId: grantee.id,
            poolId: pool.id,
            executionTargetId: targetA1.id,
            lastUsedAt: ago(5),
            tokens: [50_000],
            expiresAt: ago(1),
          }),
          // Owner session on B.
          ...records({
            tenantUserId: owner.id,
            poolId: pool.id,
            executionTargetId: targetB.id,
            lastUsedAt: ago(5),
            tokens: [10_000],
          }),
        ],
      });
      // Realistic retention: 10 000 older records on the same targets.
      const bulk = Array.from({ length: 10_000 }, (_, index) => ({
        userId: owner.id,
        tenantUserId: index % 2 ? grantee.id : owner.id,
        poolId: pool.id,
        executionTargetId: index % 3 ? targetA1.id : targetB.id,
        targetIdentity: "identity",
        bindingDigest: "b".repeat(64),
        prefixDigest: `bulk-${String(index).padStart(40, "0")}`,
        prefixDepth: 1,
        estimatedTokens: 20_000,
        lastUsedAt: ago(3_600 + (index % 1_000)),
        createdAt: ago(3_700 + 1_000),
        expiresAt: future,
      }));
      for (let offset = 0; offset < bulk.length; offset += 2_000)
        await db.cacheAffinityRecord.createMany({ data: bulk.slice(offset, offset + 2_000) });
      await db.$executeRawUnsafe("ANALYZE cache_affinity_record");

      const policy = { windowSeconds: 300, minTokens: 8192 };
      const started = performance.now();
      const sessions = await warm.loadWarmSessions({
        ownerId: owner.id,
        capacityIds: [capacityA.id, capacityB.id],
        policy,
        now,
      });
      const elapsedMs = performance.now() - started;
      console.info(`[warm-protection-postgres] warm-set query over 10k records: ${elapsedMs} ms`);
      expect(elapsedMs).toBeLessThan(1_000);

      const summary = (capacityId: string) =>
        (sessions.get(capacityId) ?? [])
          .map(({ userId, ageMs, tokens, overridePercent }) => ({
            userId,
            ageSeconds: Math.round(ageMs / 1000),
            tokens,
            overridePercent,
          }))
          .sort((left, right) => left.ageSeconds - right.ageSeconds);
      // The UNPROTECTED grantee's session (override 0) is dropped in SQL.
      expect(summary(capacityA.id)).toEqual([
        { userId: owner.id, ageSeconds: 10, tokens: 20_000, overridePercent: 40 },
        { userId: grantee.id, ageSeconds: 30, tokens: 9_000, overridePercent: null },
      ]);
      expect(summary(capacityB.id)).toEqual([
        { userId: owner.id, ageSeconds: 5, tokens: 10_000, overridePercent: 40 },
      ]);
      // Another owner's id reads nothing.
      const stranger = await warm.loadWarmSessions({
        ownerId: grantee.id,
        capacityIds: [capacityA.id],
        policy,
        now,
      });
      expect(stranger.size).toBe(0);

      // The bound is per (capacity, user) and never spent on UNPROTECTED rows.
      const bounded = await warm.loadWarmSessions({
        ownerId: owner.id,
        capacityIds: [capacityA.id, capacityB.id],
        policy,
        now,
        limitPerUser: 1,
      });
      expect(bounded.get(capacityA.id)?.map(({ userId }) => userId)).toEqual([
        owner.id,
        grantee.id,
      ]);
      expect(bounded.get(capacityB.id)?.map(({ userId }) => userId)).toEqual([owner.id]);

      // The planner can use the (executionTargetId, lastUsedAt) index.
      const indexes = await db.$queryRaw<Array<{ indexdef: string }>>`
        SELECT indexdef FROM pg_indexes WHERE tablename = 'cache_affinity_record'`;
      expect(
        indexes.some(({ indexdef }) => /\("executionTargetId", "lastUsedAt"\)/.test(indexdef)),
      ).toBe(true);

      // End to end: the unprotected grantee is never shielded; the owner and
      // the grantee split capacity A's two slots, so with one active lease the
      // single idle slot holds a protected session.
      const verdicts = await warm.assessWarmProtection({
        ownerId: owner.id,
        policy: { enabled: true, share: "EQUAL_SHARE", fixedPercent: null, ...policy },
        members: [
          {
            poolMemberId: "a",
            capacityId: capacityA.id,
            slots: 2,
            kvBudgetTokens: null,
            affine: false,
            requestTokens: 1_000,
          },
        ],
        source: {
          load: async (input) => ({
            activeByCapacity: new Map([[capacityA.id, 1]]),
            sessionsByCapacity: await warm.loadWarmSessions({ ...input, now }),
          }),
        },
      });
      expect(verdicts.get("a")).toMatchObject({ state: "PROTECTED", protectedSessions: 2 });
    } finally {
      for (const id of [owner.id, unprotected.id, grantee.id])
        await db.user.deleteMany({ where: { id } });
    }
  }, 60_000);
  it("keeps every user's sessions under the read bound and one session per explicit conversation", async () => {
    if (!databaseUrl) return;
    const suffix = crypto.randomUUID();
    const owner = await user("owner2");
    const heavy = await user("heavy");
    const light = await user("light");
    const batch = await user("batch");
    const mixed = await user("mixed");
    try {
      const device = await db.cliDevice.create({
        data: { userId: owner.id, slug: `device-${suffix}` },
      });
      const endpoint = await db.endpoint.create({
        data: { userId: owner.id, cliDeviceId: device.id, slug: `endpoint-${suffix}`, label: "W" },
      });
      const pool = await db.modelPool.create({
        data: { userId: owner.id, slug: `pool-${suffix}`, name: "Warm pool" },
      });
      for (const [grantee, protectionOverridePercent] of [
        [heavy, null],
        [light, null],
        [batch, 0],
        [mixed, null],
      ] as const)
        await db.poolGrant.create({
          data: {
            poolId: pool.id,
            ownerUserId: owner.id,
            granteeUserId: grantee.id,
            protectionOverridePercent,
          },
        });
      const capacity = await db.inferenceCapacity.create({
        data: {
          userId: owner.id,
          label: `c-${suffix}`,
          runtimeIdentityKey: `c-${suffix}`,
          runtimeModel: "warm-proof",
          hardConcurrencyLimit: 4,
        },
      });
      const model = await db.discoveredModel.create({
        data: {
          userId: owner.id,
          endpointId: endpoint.id,
          upstreamModelId: "m",
          encodedModelId: `m-${suffix}`,
        },
      });
      const target = await db.executionTarget.update({
        where: { discoveredModelId: model.id },
        data: { inferenceCapacityId: capacity.id },
      });
      const now = new Date();
      const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);
      let sequence = 0;
      const row = (input: {
        tenantUserId: string;
        lastUsedAt: Date;
        tokens: number;
        bindingDigest?: string;
        conversationDigest?: string;
        poolId?: string;
      }) => ({
        userId: owner.id,
        tenantUserId: input.tenantUserId,
        poolId: input.poolId ?? pool.id,
        executionTargetId: target.id,
        targetIdentity: "identity",
        bindingDigest: input.bindingDigest ?? "b".repeat(64),
        prefixDigest: input.conversationDigest
          ? null
          : `prefix-${String(sequence++).padStart(40, "0")}`,
        conversationDigest: input.conversationDigest ?? null,
        prefixDepth: input.conversationDigest ? 0 : 1,
        estimatedTokens: input.tokens,
        lastUsedAt: input.lastUsedAt,
        createdAt: ago(1_000),
        expiresAt: new Date(now.getTime() + 3_600_000),
      });
      const bucketPool = await db.modelPool.create({
        data: {
          userId: owner.id,
          slug: `bucket-${suffix}`,
          name: "Bucket pool",
          ownerProtectionPercent: 100,
        },
      });
      const same = ago(3);
      await db.cacheAffinityRecord.createMany({
        data: [
          // A batch (UNPROTECTED) user with many newer sessions.
          ...Array.from({ length: 6 }, (_, index) =>
            row({ tenantUserId: batch.id, lastUsedAt: ago(1 + index / 10), tokens: 20_000 }),
          ),
          // A heavy user with many newer sessions than the light user's one.
          ...Array.from({ length: 6 }, (_, index) =>
            row({ tenantUserId: heavy.id, lastUsedAt: ago(2 + index), tokens: 20_000 }),
          ),
          row({ tenantUserId: light.id, lastUsedAt: ago(60), tokens: 12_000 }),
          // The owner's older session under another pool's override (its own
          // budget bucket): it survives the newer sessions of the default bucket.
          row({
            tenantUserId: owner.id,
            lastUsedAt: ago(200),
            tokens: 11_000,
            poolId: bucketPool.id,
          }),
          // One tenant, one binding: an explicit conversation and prefix-only
          // requests at DIFFERENT instants are separate sessions (both orders).
          row({
            tenantUserId: mixed.id,
            lastUsedAt: ago(100),
            tokens: 10_000,
            conversationDigest: "e".repeat(40),
          }),
          row({ tenantUserId: mixed.id, lastUsedAt: ago(50), tokens: 13_000 }),
          row({ tenantUserId: mixed.id, lastUsedAt: ago(150), tokens: 14_000 }),
          // Two explicit conversations finishing in the same instant, each with
          // its conversation record and the shared prefix records of the request.
          row({
            tenantUserId: owner.id,
            lastUsedAt: same,
            tokens: 15_000,
            conversationDigest: "c".repeat(40),
          }),
          row({
            tenantUserId: owner.id,
            lastUsedAt: same,
            tokens: 16_000,
            conversationDigest: "d".repeat(40),
          }),
          row({ tenantUserId: owner.id, lastUsedAt: same, tokens: 16_000 }),
          row({ tenantUserId: owner.id, lastUsedAt: same, tokens: 15_000 }),
        ],
      });
      const policy = { windowSeconds: 300, minTokens: 8192 };
      const sessions = await warm.loadWarmSessions({
        ownerId: owner.id,
        capacityIds: [capacity.id],
        policy,
        now,
        limitPerUser: 2,
      });
      const list = sessions.get(capacity.id) ?? [];
      const count = (userId: string) => list.filter((session) => session.userId === userId).length;
      // UNPROTECTED rows are dropped before ranking; the light user's only
      // session survives the heavy user's newer ones; the heavy user is cut.
      expect(count(batch.id)).toBe(0);
      expect(count(heavy.id)).toBe(2);
      expect(count(light.id)).toBe(1);
      // Distinct explicit conversations stay distinct at one timestamp, and
      // the prefix records of the same instant are not a third session.
      expect(
        list
          .filter((session) => session.userId === owner.id && session.overridePercent === null)
          .map((s) => s.tokens)
          .sort(),
      ).toEqual([15_000, 16_000]);
      // The bound is per override bucket: the 100% bucket's only session is kept.
      expect(
        list.filter((session) => session.userId === owner.id && session.overridePercent === 100),
      ).toHaveLength(1);
      // A conversation record only covers prefix records of ITS instant.
      const all = await warm.loadWarmSessions({
        ownerId: owner.id,
        capacityIds: [capacity.id],
        policy,
        now,
      });
      expect(
        (all.get(capacity.id) ?? [])
          .filter((session) => session.userId === mixed.id)
          .map((s) => s.tokens)
          .sort(),
      ).toEqual([10_000, 13_000, 14_000]);
    } finally {
      for (const id of [owner.id, heavy.id, light.id, batch.id, mixed.id])
        await db.user.deleteMany({ where: { id } });
    }
  }, 60_000);
});
