import { createFixturePrismaClient } from "@ws-model-proxy/db/test-fixture-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Real-PostgreSQL proof of the warm-session query (saturation S-C): one
 * bounded, non-locking read per request, grouped into sessions by the
 * `sessionId` the records of a conversation share across turns (newest turn
 * wins), with the owner/grant overrides and the active-lease link, and cheap
 * at the default retention bound (10 000 records per pool).
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

type Db = ReturnType<typeof createFixturePrismaClient>;

integration("warm-session protection with real PostgreSQL", () => {
  let db: Db;
  let warm: typeof import("./warm-protection.js");

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    db = createFixturePrismaClient(databaseUrl);
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

  it("groups a session's records by session id and reads overrides, in bounded time", async () => {
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
      }) => {
        // One request's records: one session.
        const sessionId = crypto.randomUUID();
        return input.tokens.map((estimatedTokens) => ({
          sessionId,
          userId: owner.id,
          tenantUserId: input.tenantUserId,
          poolId: input.poolId,
          executionTargetId: input.executionTargetId,
          targetIdentity: "identity",
          bindingDigest: "b".repeat(64),
          prefixDigest: null,
          conversationDigest: `snapshot-${String(sequence++).padStart(40, "0")}`,
          prefixDepth: 0,
          estimatedTokens,
          lastUsedAt: input.lastUsedAt,
          createdAt: ago(3_700 + 1_000),
          expiresAt: input.expiresAt ?? future,
        }));
      };
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
  it("keeps every user's sessions under the read bound and one session per session id", async () => {
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
        tokens: number | null;
        bindingDigest?: string;
        conversationDigest?: string;
        poolId?: string;
        sessionId?: string;
      }) => ({
        sessionId: input.sessionId ?? crypto.randomUUID(),
        userId: owner.id,
        tenantUserId: input.tenantUserId,
        poolId: input.poolId ?? pool.id,
        executionTargetId: target.id,
        targetIdentity: "identity",
        bindingDigest: input.bindingDigest ?? "b".repeat(64),
        prefixDigest: null,
        conversationDigest:
          input.conversationDigest ?? `snapshot-${String(sequence++).padStart(40, "0")}`,
        prefixDepth: 0,
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
          // One tenant: an explicit conversation and prefix-only requests at
          // different instants, each its own session.
          row({
            tenantUserId: mixed.id,
            lastUsedAt: ago(100),
            tokens: 10_000,
            conversationDigest: "e".repeat(40),
          }),
          row({ tenantUserId: mixed.id, lastUsedAt: ago(50), tokens: 13_000 }),
          row({ tenantUserId: mixed.id, lastUsedAt: ago(150), tokens: 14_000 }),
          // Two explicit conversations finishing in the same instant, each with
          // its conversation record and the prefix records of its own request.
          row({
            tenantUserId: owner.id,
            lastUsedAt: same,
            tokens: 15_000,
            conversationDigest: "c".repeat(40),
            sessionId: "session-c",
          }),
          row({
            tenantUserId: owner.id,
            lastUsedAt: same,
            tokens: 16_000,
            conversationDigest: "d".repeat(40),
            sessionId: "session-d",
          }),
          row({ tenantUserId: owner.id, lastUsedAt: same, tokens: 16_000, sessionId: "session-d" }),
          row({ tenantUserId: owner.id, lastUsedAt: same, tokens: 15_000, sessionId: "session-c" }),
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
      // Unbounded read: the mixed tenant's three requests are three sessions.
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

  it("keeps one identity across turns and marks sessions an active lease is serving", async () => {
    if (!databaseUrl) return;
    const suffix = crypto.randomUUID();
    const owner = await user("owner3");
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
      const capacity = async (label: string) =>
        db.inferenceCapacity.create({
          data: {
            userId: owner.id,
            label: `${label}-${suffix}`,
            runtimeIdentityKey: `${label}-${suffix}`,
            runtimeModel: "warm-proof",
            hardConcurrencyLimit: 4,
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
      const targetA = await target("a", capacityA.id);
      const targetB = await target("b", capacityB.id);
      const now = new Date("2026-09-29T12:00:00.000Z");
      const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);
      let sequence = 0;
      const record = (input: {
        sessionId: string | null;
        lastUsedAt: Date;
        tokens: number;
        targetId?: string;
        conversationDigest?: string;
        hint?: boolean;
        expiresAt?: Date;
      }) => ({
        sessionId: input.sessionId,
        userId: owner.id,
        tenantUserId: owner.id,
        poolId: pool.id,
        executionTargetId: input.targetId ?? targetA.id,
        targetIdentity: "identity",
        bindingDigest: "b".repeat(64),
        prefixDigest:
          input.sessionId === null || input.hint
            ? `prefix-${String(sequence++).padStart(40, "0")}`
            : null,
        conversationDigest:
          input.sessionId === null || input.hint
            ? null
            : (input.conversationDigest ?? `snapshot-${String(sequence++).padStart(40, "0")}`),
        prefixDepth: input.sessionId === null || input.hint ? 1 : 0,
        estimatedTokens: input.tokens,
        lastUsedAt: input.lastUsedAt,
        createdAt: ago(1_000),
        expiresAt: input.expiresAt ?? new Date(now.getTime() + 3_600_000),
      });
      await db.cacheAffinityRecord.createMany({
        data: [
          // "long": turn 1 at 200 s wrote deep prefixes (30k); turn 2 (edited
          // and shortened history) at 20 s wrote a shorter one (12k). One
          // session, dated and sized by its newest turn.
          record({ sessionId: "long", lastUsedAt: ago(200), tokens: 30_000 }),
          record({ sessionId: "long", lastUsedAt: ago(200), tokens: 30_000 }),
          record({ sessionId: "long", lastUsedAt: ago(20), tokens: 12_000 }),
          record({
            sessionId: "long",
            lastUsedAt: ago(20),
            tokens: 12_000,
            conversationDigest: "c".repeat(40),
          }),
          // Shared hints cannot move a session's age or size to the last writer.
          record({ sessionId: "long", lastUsedAt: ago(1), tokens: 90_000, hint: true }),
          // Same-instant duplicate snapshots choose the largest estimate.
          record({ sessionId: "long", lastUsedAt: ago(20), tokens: 9_000 }),
          // Expired evidence cannot supersede a live turn.
          record({ sessionId: "long", lastUsedAt: ago(2), tokens: 80_000, expiresAt: ago(1) }),
          // "shrunk": the newest turn fell below the floor; the older turn's
          // larger prefix is still what the engine holds.
          record({ sessionId: "shrunk", lastUsedAt: ago(90), tokens: 20_000 }),
          record({ sessionId: "shrunk", lastUsedAt: ago(10), tokens: 3_000 }),
          // Rows from before session ids existed are one session each.
          record({ sessionId: null, lastUsedAt: ago(40), tokens: 9_000 }),
          record({ sessionId: null, lastUsedAt: ago(40), tokens: 9_500 }),
          // Served by an active lease, by an ended one, by an expired one, by
          // a lease of ANOTHER member, and not served at all.
          record({ sessionId: "busy", lastUsedAt: ago(30), tokens: 15_000 }),
          record({ sessionId: "released", lastUsedAt: ago(31), tokens: 16_000 }),
          record({ sessionId: "expired", lastUsedAt: ago(32), tokens: 17_000 }),
          record({ sessionId: "on-other-member", lastUsedAt: ago(33), tokens: 18_000 }),
          record({ sessionId: "idle", lastUsedAt: ago(34), tokens: 19_000 }),
          record({
            sessionId: "b-only",
            lastUsedAt: ago(35),
            tokens: 14_000,
            targetId: targetB.id,
          }),
        ],
      });
      let fencing = 0n;
      const lease = async (input: {
        capacityId: string;
        targetId: string;
        warmSessionIds: string[];
        state?: "ACTIVE" | "RELEASED";
        expiresInSeconds?: number;
      }) => {
        fencing += 1n;
        const id = crypto.randomUUID();
        const request = await db.admissionRequest.create({
          data: {
            userId: owner.id,
            requestId: id,
            attemptId: id,
            sourceKind: "DIRECT",
            directExecutionTargetId: input.targetId,
            basePriority: 16,
            enqueueSequence: fencing,
            connectionOwner: "test",
            heartbeatAt: now,
            state: "ADMITTED",
            warmSessionIds: input.warmSessionIds,
          },
        });
        const released = input.state === "RELEASED";
        await db.capacityLease.create({
          data: {
            userId: owner.id,
            admissionRequestId: request.id,
            requestId: id,
            attemptId: id,
            capacityId: input.capacityId,
            executionTargetId: input.targetId,
            priority: 16,
            reservationClass: 0,
            fencingToken: fencing,
            state: input.state ?? "ACTIVE",
            ownerServerInstance: "test",
            acquiredAt: ago(60),
            heartbeatAt: now,
            expiresAt: new Date(now.getTime() + (input.expiresInSeconds ?? 30) * 1000),
            releasedAt: released ? ago(1) : null,
            releaseReason: released ? "test" : null,
          },
        });
      };
      await lease({ capacityId: capacityA.id, targetId: targetA.id, warmSessionIds: ["busy"] });
      await lease({
        capacityId: capacityA.id,
        targetId: targetA.id,
        warmSessionIds: ["released"],
        state: "RELEASED",
      });
      await lease({
        capacityId: capacityA.id,
        targetId: targetA.id,
        warmSessionIds: ["expired"],
        expiresInSeconds: -10,
      });
      // Active on B, but naming a session that lives on A: A's copy is idle.
      await lease({
        capacityId: capacityB.id,
        targetId: targetB.id,
        warmSessionIds: ["on-other-member"],
      });

      const sessions = await warm.loadWarmSessions({
        ownerId: owner.id,
        capacityIds: [capacityA.id, capacityB.id],
        policy: { windowSeconds: 300, minTokens: 8192 },
        now,
      });
      const summary = (capacityId: string) =>
        (sessions.get(capacityId) ?? [])
          .map(({ ageMs, tokens, inFlight }) => ({ age: ageMs / 1000, tokens, inFlight }))
          .sort((left, right) => left.age - right.age || left.tokens - right.tokens);
      expect(summary(capacityA.id)).toEqual([
        // "shrunk": newest activity, older eligible size.
        { age: 10, tokens: 20_000, inFlight: false },
        // "long": one session at its newest turn (not two, not 30k).
        { age: 20, tokens: 12_000, inFlight: false },
        // Only the active lease of the same member marks a session in flight.
        { age: 30, tokens: 15_000, inFlight: true },
        { age: 31, tokens: 16_000, inFlight: false },
        { age: 32, tokens: 17_000, inFlight: false },
        { age: 33, tokens: 18_000, inFlight: false },
        { age: 34, tokens: 19_000, inFlight: false },
        // Rows from before session ids existed: one session each.
        { age: 40, tokens: 9_000, inFlight: false },
        { age: 40, tokens: 9_500, inFlight: false },
      ]);
      expect(summary(capacityB.id)).toEqual([{ age: 35, tokens: 14_000, inFlight: false }]);
    } finally {
      // Leases restrict their target's and capacity's deletion.
      await db.capacityLease.deleteMany({ where: { userId: owner.id } });
      await db.user.deleteMany({ where: { id: owner.id } });
    }
  }, 60_000);
  type Turn = {
    age: number;
    tokens: number;
    expired?: boolean;
    legacy?: boolean;
    hint?: boolean;
    target?: number;
    binding?: string;
    ttlSeconds?: number;
    samples?: { age: number; tokens: number }[];
  };
  const cases: {
    name: string;
    turns: Turn[];
    windowSeconds?: number;
    expected: { target: number; ageMs: number; tokens: number }[];
  }[] = [
    {
      name: "sample window rejects an older in-TTL size after a sub-floor refresh",
      turns: [{ age: 10, tokens: 3000, ttlSeconds: 3600, samples: [{ age: 301, tokens: 20_000 }] }],
      expected: [],
    },
    {
      name: "sample window includes its exact boundary after a sub-floor refresh",
      turns: [{ age: 10, tokens: 3000, ttlSeconds: 3600, samples: [{ age: 300, tokens: 20_000 }] }],
      expected: [{ target: 0, ageMs: 10_000, tokens: 20_000 }],
    },
    {
      name: "sample TTL rejects expired size even with a longer protection window",
      windowSeconds: 7200,
      turns: [
        { age: 10, tokens: 3000, ttlSeconds: 3600, samples: [{ age: 3601, tokens: 20_000 }] },
      ],
      expected: [],
    },
    {
      name: "sample TTL rejects its exact expiry boundary",
      windowSeconds: 7200,
      turns: [
        { age: 10, tokens: 3000, ttlSeconds: 3600, samples: [{ age: 3600, tokens: 20_000 }] },
      ],
      expected: [],
    },
    {
      name: "sample TTL preserves live size with a longer protection window",
      windowSeconds: 7200,
      turns: [
        { age: 10, tokens: 3000, ttlSeconds: 3600, samples: [{ age: 3599, tokens: 20_000 }] },
      ],
      expected: [{ target: 0, ageMs: 10_000, tokens: 20_000 }],
    },
    {
      name: "conflicting sample sizes at one instant choose MAX regardless of array order",
      turns: [
        {
          age: 10,
          tokens: 3000,
          ttlSeconds: 3600,
          samples: [
            { age: 20, tokens: 9000 },
            { age: 20, tokens: 20_000 },
            { age: 30, tokens: 90_000 },
          ],
        },
      ],
      expected: [{ target: 0, ageMs: 10_000, tokens: 20_000 }],
    },
    {
      name: "nested snapshots choose newest size, independent of insertion order",
      turns: [
        { age: 10, tokens: 12_000 },
        { age: 90, tokens: 30_000 },
      ],
      expected: [{ target: 0, ageMs: 10_000, tokens: 12_000 }],
    },
    {
      name: "same-instant snapshots choose MAX size",
      turns: [
        { age: 10, tokens: 9_000 },
        { age: 10, tokens: 20_000 },
      ],
      expected: [{ target: 0, ageMs: 10_000, tokens: 20_000 }],
    },
    {
      name: "sub-floor latest turn refreshes age and retains previous eligible size",
      turns: [
        { age: 90, tokens: 20_000 },
        { age: 10, tokens: 3000 },
      ],
      expected: [{ target: 0, ageMs: 10_000, tokens: 20_000 }],
    },
    {
      name: "expired newer snapshots do not win",
      turns: [
        { age: 10, tokens: 90_000, expired: true },
        { age: 90, tokens: 20_000 },
      ],
      expected: [{ target: 0, ageMs: 90_000, tokens: 20_000 }],
    },
    {
      name: "shared hint refresh cannot change age or size",
      turns: [
        { age: 90, tokens: 20_000 },
        { age: 1, tokens: 90_000, hint: true },
      ],
      expected: [{ target: 0, ageMs: 90_000, tokens: 20_000 }],
    },
    {
      name: "legacy null ids are separate even at the same instant",
      turns: [
        { age: 10, tokens: 9000, legacy: true },
        { age: 10, tokens: 9500, legacy: true },
      ],
      expected: [
        { target: 0, ageMs: 10_000, tokens: 9000 },
        { target: 0, ageMs: 10_000, tokens: 9500 },
      ],
    },
    {
      name: "aliased session ids cannot cross KV pools",
      turns: [
        { age: 10, tokens: 9000 },
        { age: 20, tokens: 9500, target: 1 },
      ],
      expected: [
        { target: 0, ageMs: 10_000, tokens: 9000 },
        { target: 1, ageMs: 20_000, tokens: 9500 },
      ],
    },
    {
      name: "aliased session ids cannot cross bindings",
      turns: [
        { age: 10, tokens: 9000 },
        { age: 20, tokens: 9500, binding: "different" },
      ],
      expected: [
        { target: 0, ageMs: 10_000, tokens: 9000 },
        { target: 0, ageMs: 20_000, tokens: 9500 },
      ],
    },
  ];
  // Same-instant MAX, expiry and legacy cases preserve existing semantics;
  // ownership, scoping and sub-floor cases regress the first-pass reader.
  it.each(cases)("$name", async ({ turns, expected, windowSeconds = 300 }) => {
    if (!databaseUrl) return;
    const owner = await user("table");
    try {
      const slug = crypto.randomUUID();
      const device = await db.cliDevice.create({ data: { userId: owner.id, slug } });
      const endpoint = await db.endpoint.create({
        data: { userId: owner.id, cliDeviceId: device.id, slug, label: "Table" },
      });
      const pool = await db.modelPool.create({ data: { userId: owner.id, slug, name: "Table" } });
      const targets = await Promise.all(
        [0, 1].map(async (index) => {
          const key = `${slug}-${index}`;
          const capacity = await db.inferenceCapacity.create({
            data: { userId: owner.id, label: key, runtimeIdentityKey: key, runtimeModel: "m" },
          });
          const model = await db.discoveredModel.create({
            data: {
              userId: owner.id,
              endpointId: endpoint.id,
              upstreamModelId: key,
              encodedModelId: key,
            },
          });
          const target = await db.executionTarget.update({
            where: { discoveredModelId: model.id },
            data: { inferenceCapacityId: capacity.id },
          });
          return { id: target.id, capacityId: capacity.id };
        }),
      );
      const now = new Date("2026-09-29T12:00:00Z");
      await db.cacheAffinityRecord.createMany({
        data: turns.map((turn, index) => ({
          userId: owner.id,
          tenantUserId: owner.id,
          poolId: pool.id,
          executionTargetId: targets[turn.target ?? 0]!.id,
          targetIdentity: "identity",
          bindingDigest: (turn.binding ?? "binding").padEnd(43, "x"),
          sessionId: turn.legacy ? null : "same-aliased-session",
          prefixDigest: turn.hint ? `hint-${String(index).padStart(40, "0")}` : null,
          conversationDigest: turn.hint ? null : `snapshot-${String(index).padStart(40, "0")}`,
          prefixDepth: turn.hint ? 1 : 0,
          createdAt: new Date(now.getTime() - 3_600_000),
          lastUsedAt: new Date(now.getTime() - turn.age * 1000),
          expiresAt: new Date(
            now.getTime() +
              (turn.expired
                ? -1000
                : turn.ttlSeconds === undefined
                  ? 60_000
                  : (turn.ttlSeconds - turn.age) * 1000),
          ),
          estimatedTokens: turn.tokens,
          sessionTokenTimes: turn.samples?.map(({ age }) => new Date(now.getTime() - age * 1000)),
          sessionTokenEstimates: turn.samples?.map(({ tokens }) => tokens),
        })),
      });
      const result = await warm.loadWarmSessions({
        ownerId: owner.id,
        capacityIds: targets.map((t) => t.capacityId),
        policy: { windowSeconds, minTokens: 8192 },
        now,
      });
      const actual = targets.flatMap((t, target) =>
        (result.get(t.capacityId) ?? []).map(({ ageMs, tokens }) => ({ target, ageMs, tokens })),
      );
      const compare = (left: (typeof actual)[number], right: (typeof actual)[number]) =>
        left.target - right.target || left.ageMs - right.ageMs || left.tokens - right.tokens;
      expect(actual.sort(compare)).toEqual([...expected].sort(compare));
    } finally {
      await db.user.deleteMany({ where: { id: owner.id } });
    }
  });
});
