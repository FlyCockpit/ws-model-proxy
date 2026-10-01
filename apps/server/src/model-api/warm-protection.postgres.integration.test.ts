import {
  applyKvEvictionObservations,
  effectiveKvBudgetTokens,
  KV_EVICTION_RECOVERY_MS,
} from "@ws-model-proxy/api/lib/kv-eviction-budget";
import { createPrismaClient } from "@ws-model-proxy/db/client-factory";
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

  it.each([
    { linked: true, state: "FREE", idle: 0 },
    { linked: false, state: "PROTECTED", idle: 2 },
  ] as const)(
    "C1a-2 native continuations linked=$linked",
    async ({ linked, state, idle }) => {
      process.env.BETTER_AUTH_SECRET ??= "cache-affinity-integration-secret-32-bytes";
      process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
      const affinity = await import("./cache-affinity.js");
      const owner = await user("native-responses");
      const suffix = crypto.randomUUID();
      try {
        const device = await db.cliDevice.create({
          data: { userId: owner.id, slug: `device-${suffix}` },
        });
        const endpoint = await db.endpoint.create({
          data: {
            userId: owner.id,
            cliDeviceId: device.id,
            slug: `endpoint-${suffix}`,
            label: "Native",
          },
        });
        const pool = await db.modelPool.create({
          data: {
            userId: owner.id,
            slug: `pool-${suffix}`,
            name: "Native Responses",
            affinityEnabled: true,
          },
        });
        const capacity = await db.inferenceCapacity.create({
          data: {
            userId: owner.id,
            label: `capacity-${suffix}`,
            runtimeIdentityKey: `runtime-${suffix}`,
            runtimeModel: "native-responses",
            hardConcurrencyLimit: 4,
          },
        });
        const model = await db.discoveredModel.create({
          data: {
            userId: owner.id,
            endpointId: endpoint.id,
            upstreamModelId: "native-responses",
            encodedModelId: `native-${suffix}`,
          },
        });
        const target = await db.executionTarget.update({
          where: { discoveredModelId: model.id },
          data: { inferenceCapacityId: capacity.id },
        });
        const member = await db.poolMember.create({
          data: {
            poolId: pool.id,
            executionTargetId: target.id,
            discoveredModelId: model.id,
          },
        });
        const now = new Date();
        const policy = {
          enabled: true,
          ttlSeconds: 3600,
          maxRecords: 100,
          prefixWeight: 100,
          conversationWeight: 150,
          confirmedCacheWeight: 250,
          loadPenaltyWeight: 100,
        };
        const args = {
          ownerId: owner.id,
          resourceOwnerId: owner.id,
          poolId: pool.id,
          securityScope: owner.id,
          surface: "OPENAI_RESPONSES",
          policy,
          now,
          estimatedTokens: 20_000,
          target: {
            poolMemberId: member.id,
            executionTargetId: target.id,
            targetIdentity: `identity-${suffix}`,
            capacityId: capacity.id,
            hardConcurrencyLimit: 4,
            healthPenalty: 0,
            publicEgressPenalty: 0,
            costPenalty: 0,
          },
        };
        for (const index of [1, 2]) {
          const binding = await affinity.rememberAffinity({
            ...args,
            payload: { input: `conversation ${index}` },
          });
          expect(binding).toMatchObject({
            sessionId: expect.any(String),
            bindingDigest: expect.any(String),
          });
          const record = await db.responseStickinessRecord.create({
            data: {
              userId: owner.id,
              routingKeyDigest: `response-${index}-${suffix}`,
              routingVersion: 2,
              targetModelPoolId: pool.id,
              selectedExecutionTargetId: target.id,
              selectedDiscoveredModelId: model.id,
              warmSessionId: binding!.sessionId,
              warmBindingDigest: binding!.bindingDigest,
              warmRootDigest: binding!.rootDigest,
              warmTipDigest: binding!.tipDigest,
              warmTipDepth: binding!.tipDepth,
              warmCanonicalBytes: binding!.canonicalBytes,
              expiresAt: new Date(now.getTime() + 60_000),
            },
          });
          // Read the durable sticky row, as bound create does. No shared prefix
          // or body hint is needed when the next request carries only new input.
          const stored = await db.responseStickinessRecord.findUniqueOrThrow({
            where: { id: record.id },
          });
          const sessionBinding = {
            sessionId: stored.warmSessionId!,
            bindingDigest: stored.warmBindingDigest!,
            rootDigest: stored.warmRootDigest!,
            tipDigest: stored.warmTipDigest!,
            tipDepth: stored.warmTipDepth!,
            canonicalBytes: stored.warmCanonicalBytes!,
          };
          const payload = { input: `new input ${index}`, previous_response_id: `resp_${index}` };
          const material = affinity.affinityPrefixDigests({
            ...args,
            payload,
            runtimeIdentity: args.target.targetIdentity,
          });
          const sessionId = affinity.scopedAffinitySessionId(
            sessionBinding,
            material.bindingDigest,
          );
          expect(sessionId).toBe(binding!.sessionId);
          const refreshed = await affinity.rememberAffinity({ ...args, payload, sessionBinding });
          expect(refreshed).toMatchObject({
            sessionId: binding!.sessionId,
            rootDigest: binding!.rootDigest,
          });
          const id = crypto.randomUUID();
          const request = await db.admissionRequest.create({
            data: {
              userId: owner.id,
              requestId: id,
              attemptId: id,
              sourceKind: "POOL",
              poolId: pool.id,
              basePriority: 16,
              enqueueSequence: BigInt(index),
              connectionOwner: "native-responses-test",
              heartbeatAt: now,
              state: "ADMITTED",
              warmSessionIds: linked && sessionId ? [sessionId] : [],
            },
          });
          await db.capacityLease.create({
            data: {
              userId: owner.id,
              admissionRequestId: request.id,
              requestId: id,
              attemptId: id,
              capacityId: capacity.id,
              executionTargetId: target.id,
              poolId: pool.id,
              poolMemberId: member.id,
              priority: 16,
              reservationClass: 0,
              fencingToken: BigInt(index),
              ownerServerInstance: "native-responses-test",
              acquiredAt: now,
              heartbeatAt: now,
              expiresAt: new Date(now.getTime() + 60_000),
            },
          });
        }
        const snapshot = await warm.warmProtectionSource.load({
          ownerId: owner.id,
          capacityIds: [capacity.id],
          policy: {
            enabled: true,
            windowSeconds: 300,
            minTokens: 8192,
            share: "EQUAL_SHARE",
            fixedPercent: null,
          },
        });
        expect(snapshot.activeByCapacity.get(capacity.id)).toBe(2);
        const sessions = snapshot.sessionsByCapacity.get(capacity.id) ?? [];
        expect(sessions).toHaveLength(2);
        expect(sessions.map((session) => session.inFlight)).toEqual([linked, linked]);
        const load = { slots: 4, active: 2, kvBudgetTokens: null };
        const protection = {
          enabled: true,
          windowSeconds: 300,
          minTokens: 8192,
          share: "EQUAL_SHARE" as const,
          fixedPercent: null,
        };
        const verdict = warm.memberProtectionVerdict({
          load,
          protectedSessions: warm.protectedWarmSessions(sessions, load, protection),
          requestTokens: 20_000,
          affine: false,
        });
        expect(verdict).toMatchObject({ state, idleProtectedSessions: idle, protectedSessions: 2 });
      } finally {
        await db.capacityLease.deleteMany({ where: { userId: owner.id } });
        await db.user.deleteMany({ where: { id: owner.id } });
      }
    },
    60_000,
  );

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
        return input.tokens.map((estimatedTokens, index) => ({
          sessionId,
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
        sessionId: `bulk-session-${index}`,
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
            kvEvictionByCapacity: new Map(),
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
      // Same capacity as A: a sibling target's session is not served by A's lease.
      const targetA2 = await target("a2", capacityA.id);
      const targetB = await target("b", capacityB.id);
      const now = new Date("2026-09-29T12:00:00.000Z");
      const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);
      let sequence = 0;
      const record = (input: {
        sessionId: string;
        lastUsedAt: Date;
        tokens: number;
        targetId?: string;
        conversationDigest?: string;
      }) => ({
        sessionId: input.sessionId,
        userId: owner.id,
        tenantUserId: owner.id,
        poolId: pool.id,
        executionTargetId: input.targetId ?? targetA.id,
        targetIdentity: "identity",
        bindingDigest: "b".repeat(64),
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
          // "shrunk": the newest turn fell below the floor; the older turn's
          // larger prefix is still what the engine holds.
          record({ sessionId: "shrunk", lastUsedAt: ago(90), tokens: 20_000 }),
          record({ sessionId: "shrunk", lastUsedAt: ago(10), tokens: 3_000 }),
          // Two required session ids at the same instant remain separate.
          record({ sessionId: crypto.randomUUID(), lastUsedAt: ago(40), tokens: 9_000 }),
          record({ sessionId: crypto.randomUUID(), lastUsedAt: ago(40), tokens: 9_500 }),
          // Served by an active lease, by an ended one, by an expired one, by
          // a lease of ANOTHER member, and not served at all.
          record({ sessionId: "busy", lastUsedAt: ago(30), tokens: 15_000 }),
          record({ sessionId: "released", lastUsedAt: ago(31), tokens: 16_000 }),
          record({ sessionId: "expired", lastUsedAt: ago(32), tokens: 17_000 }),
          record({ sessionId: "on-other-member", lastUsedAt: ago(33), tokens: 18_000 }),
          record({ sessionId: "idle", lastUsedAt: ago(34), tokens: 19_000 }),
          record({
            sessionId: "shared-capacity-sibling",
            lastUsedAt: ago(36),
            tokens: 13_000,
            targetId: targetA2.id,
          }),
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
      // The request matched a session on each target of the capacity but its
      // lease serves target A only: the sibling target's session stays idle.
      await lease({
        capacityId: capacityA.id,
        targetId: targetA.id,
        warmSessionIds: ["busy", "shared-capacity-sibling"],
      });
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
        // "long": one session at its newest turn (not two, not 30k).
        { age: 20, tokens: 12_000, inFlight: false },
        // Only the active lease of the same member marks a session in flight.
        { age: 30, tokens: 15_000, inFlight: true },
        { age: 31, tokens: 16_000, inFlight: false },
        { age: 32, tokens: 17_000, inFlight: false },
        { age: 33, tokens: 18_000, inFlight: false },
        { age: 34, tokens: 19_000, inFlight: false },
        // Named by A's lease but living on a sibling target of the capacity.
        { age: 36, tokens: 13_000, inFlight: false },
        // Distinct committed session ids: one session each.
        { age: 40, tokens: 9_000, inFlight: false },
        { age: 40, tokens: 9_500, inFlight: false },
        // "shrunk": the older, larger turn stays its size.
        { age: 90, tokens: 20_000, inFlight: false },
      ]);
      expect(summary(capacityB.id)).toEqual([{ age: 35, tokens: 14_000, inFlight: false }]);
    } finally {
      // Leases restrict their target's and capacity's deletion.
      await db.capacityLease.deleteMany({ where: { userId: owner.id } });
      await db.user.deleteMany({ where: { id: owner.id } });
    }
  }, 60_000);
  describe("KV eviction feedback on PostgreSQL", () => {
    const now = new Date("2026-09-30T12:00:00Z");
    const ownedCapacityIds = new Set<string>();
    let feedback: typeof import("./kv-eviction-feedback.js");
    let retention: typeof import("./usage-retention.js");
    let writers: ReturnType<typeof createPrismaClient>[];
    beforeAll(async () => {
      feedback = await import("./kv-eviction-feedback.js");
      retention = await import("./usage-retention.js");
      if (!databaseUrl) throw new Error("database unavailable");
      writers = Array.from({ length: 4 }, () => createPrismaClient(databaseUrl));
    });
    afterAll(async () => {
      await db.capacityKvEviction.deleteMany({
        where: { capacityId: { in: [...ownedCapacityIds] } },
      });
      await Promise.all(writers?.map((writer) => writer.$disconnect()) ?? []);
      await (await import("@ws-model-proxy/db")).default.$disconnect();
    });
    function id() {
      const value = crypto.randomUUID();
      ownedCapacityIds.add(value);
      return value;
    }
    const row = (capacityId: string) =>
      db.capacityKvEviction.findUniqueOrThrow({ where: { capacityId } });

    it("a lower K flips FREE to PROTECTED, then exact recovery restores FREE with the same warm set", async () => {
      const owner = await user("eviction");
      const capacityId = id();
      const suffix = crypto.randomUUID();
      try {
        const capacity = await db.inferenceCapacity.create({
          data: {
            id: capacityId,
            userId: owner.id,
            label: `kv-${suffix}`,
            runtimeIdentityKey: `kv-${suffix}`,
            runtimeModel: "qwen",
            engineKind: "VLLM",
            kvBudgetTokens: 100_000,
            hardConcurrencyLimit: 4,
          },
        });
        const device = await db.cliDevice.create({
          data: { userId: owner.id, slug: `kv-${suffix}` },
        });
        const endpoint = await db.endpoint.create({
          data: { userId: owner.id, cliDeviceId: device.id, slug: `kv-${suffix}`, label: "KV" },
        });
        const model = await db.discoveredModel.create({
          data: {
            userId: owner.id,
            endpointId: endpoint.id,
            upstreamModelId: "qwen",
            encodedModelId: `kv-${suffix}`,
          },
        });
        const target = await db.executionTarget.update({
          where: { discoveredModelId: model.id },
          data: { inferenceCapacityId: capacity.id },
        });
        const pool = await db.modelPool.create({
          data: { userId: owner.id, slug: `kv-${suffix}`, name: "KV" },
        });
        await db.cacheAffinityRecord.create({
          data: {
            userId: owner.id,
            tenantUserId: owner.id,
            poolId: pool.id,
            executionTargetId: target.id,
            sessionId: suffix,
            createdAt: new Date(now.getTime() - 1000),
            targetIdentity: "identity",
            bindingDigest: "b".repeat(64),
            prefixDigest: "p".repeat(64),
            prefixDepth: 1,
            estimatedTokens: 30_000,
            engineCacheConfirmed: true,
            lastUsedAt: now,
            expiresAt: new Date(now.getTime() + 7_200_000),
          },
        });
        const policy = {
          enabled: true,
          windowSeconds: 3600,
          minTokens: 8192,
          share: "FIRST_COME" as const,
          fixedPercent: null,
        };
        const assess = async (at: Date) =>
          (
            await warm.assessWarmProtection({
              ownerId: owner.id,
              policy,
              now: at,
              members: [
                {
                  poolMemberId: "m",
                  capacityId,
                  slots: 4,
                  kvBudgetTokens: 100_000,
                  engineKind: "VLLM",
                  affine: false,
                  requestTokens: 25_000,
                },
              ],
              source: warm.warmProtectionSource,
            })
          ).get("m");
        expect(await assess(now)).toMatchObject({
          state: "FREE",
          protectedTokens: 30_000,
          effectiveKvBudgetTokens: 100_000,
        });
        for (let i = 0; i < 10; i++)
          await feedback.recordKvEvictionObservations(
            { capacityId, ownerId: owner.id, count: 1, now },
            writers[0],
          );
        expect(await assess(now)).toMatchObject({
          state: "PROTECTED",
          protectedTokens: 30_000,
          effectiveKvBudgetTokens: 50_000,
        });
        // Keep the row live beyond full recovery to prove read-time linear decay.
        await db.capacityKvEviction.update({
          where: { capacityId },
          data: { expiresAt: new Date(now.getTime() + 2 * KV_EVICTION_RECOVERY_MS) },
        });
        expect(await assess(new Date(now.getTime() + KV_EVICTION_RECOVERY_MS))).toMatchObject({
          state: "FREE",
          protectedTokens: 30_000,
          effectiveKvBudgetTokens: 100_000,
        });
      } finally {
        await db.cacheAffinityRecord.deleteMany({ where: { userId: owner.id } });
        await db.user.deleteMany({ where: { id: owner.id } });
      }
    });

    it.each([
      { cut: null, count: 1, dt: 0 },
      { cut: 0.1, count: 0, dt: 1000 },
      { cut: 0.1, count: -1, dt: 1000 },
      { cut: 0.05, count: 1, dt: 0 },
      { cut: 0.5, count: 1, dt: 900_000 },
      { cut: 0.5, count: 1, dt: 1_800_000 },
      { cut: 0.1, count: 1, dt: -1000 },
      { cut: 0.1, count: 100, dt: 0 },
      { cut: 0.9, count: 1, dt: 900_000 },
      { cut: 0.3, count: 3, dt: 1001 },
    ])("SQL equals pure state (cut=$cut count=$count dt=$dt)", async ({ cut, count, dt }) => {
      const capacityId = id();
      const state =
        cut === null ? null : { cutFraction: cut, observedAt: new Date(now.getTime() - dt) };
      const expiresAt = new Date(now.getTime() + 3_600_000);
      if (state)
        await db.capacityKvEviction.create({
          data: { capacityId, userId: "kv-owner", ...state, expiresAt },
        });
      await feedback.recordKvEvictionObservations(
        { capacityId, ownerId: "kv-owner", count, now },
        writers[0],
      );
      const actual = await row(capacityId);
      const expected = applyKvEvictionObservations(state, count, now);
      expect(actual.cutFraction).toBe(expected.cutFraction);
      expect(actual.observedAt).toEqual(expected.observedAt);
      expect(actual.expiresAt).toEqual(
        state ? expiresAt : new Date(now.getTime() + KV_EVICTION_RECOVERY_MS),
      );
      expect(effectiveKvBudgetTokens(100_001, actual, now)).toBe(
        effectiveKvBudgetTokens(100_001, expected, now),
      );
    });

    it.each([6, 32])(
      "%s concurrent upserts from independent clients commute and cap in one row",
      async (count) => {
        const capacityId = id();
        await Promise.all(
          Array.from({ length: count }, (_, i) =>
            feedback.recordKvEvictionObservations(
              { capacityId, ownerId: "kv-owner", count: 1, now },
              writers[i % writers.length],
            ),
          ),
        );
        const rows = await db.capacityKvEviction.findMany({ where: { capacityId } });
        expect(rows).toHaveLength(1);
        let expected = applyKvEvictionObservations(null, 0, now);
        for (let i = 0; i < count; i++) expected = applyKvEvictionObservations(expected, 1, now);
        expect(rows[0]?.cutFraction).toBe(expected.cutFraction);
      },
    );

    it("owner mismatch cannot modify a row", async () => {
      const capacityId = id();
      await feedback.recordKvEvictionObservations(
        { capacityId, ownerId: "kv-owner", count: 1, now },
        writers[0],
      );
      const before = await row(capacityId);
      await feedback.recordKvEvictionObservations(
        { capacityId, ownerId: "other-owner", count: 10, now: new Date(now.getTime() + 1000) },
        writers[1],
      );
      expect(await row(capacityId)).toEqual(before);
    });

    it("load ignores expired and other-owner rows", async () => {
      const expired = id();
      const other = id();
      const active = id();
      for (const capacityId of [expired, other, active])
        await db.capacityKvEviction.create({
          data: {
            capacityId,
            userId: capacityId === other ? "other-owner" : "kv-owner",
            cutFraction: 0.5,
            observedAt: new Date(now.getTime() - 2000),
            expiresAt: new Date(now.getTime() + (capacityId === expired ? 0 : 1000)),
          },
        });
      const snapshot = await warm.warmProtectionSource.load({
        ownerId: "kv-owner",
        capacityIds: [expired, other, active],
        policy: {
          enabled: true,
          windowSeconds: 300,
          minTokens: 8192,
          share: "FIRST_COME",
          fixedPercent: null,
        },
        now,
      });
      expect([...snapshot.kvEvictionByCapacity.keys()]).toEqual([active]);
    });

    it("retention deletes only rows expired more than one hour ago", async () => {
      const old = id();
      const boundary = id();
      const newer = id();
      for (const [capacityId, age] of [
        [old, 3_600_001],
        [boundary, 3_600_000],
        [newer, 1000],
      ] as const)
        await db.capacityKvEviction.create({
          data: {
            capacityId,
            userId: "kv-owner",
            cutFraction: 0.5,
            observedAt: new Date(now.getTime() - age - 1000),
            expiresAt: new Date(now.getTime() - age),
          },
        });
      await retention.deleteExpiredKvEvictions({ prisma: writers[0], now, batch: 1 });
      expect(await db.capacityKvEviction.findUnique({ where: { capacityId: old } })).toBeNull();
      expect((await row(boundary)).capacityId).toBe(boundary);
      expect((await row(newer)).capacityId).toBe(newer);
    });

    it("older application clocks do not decay or move timestamps backward", async () => {
      const capacityId = id();
      await feedback.recordKvEvictionObservations(
        { capacityId, ownerId: "kv-owner", count: 2, now },
        writers[0],
      );
      const initial = await row(capacityId);
      await feedback.recordKvEvictionObservations(
        { capacityId, ownerId: "kv-owner", count: 1, now: new Date(now.getTime() - 60_000) },
        writers[1],
      );
      const actual = await row(capacityId);
      expect(actual.cutFraction).toBeCloseTo(0.15, 12);
      expect(actual.observedAt).toEqual(now);
      expect(actual.expiresAt).toEqual(initial.expiresAt);
    });
  });
});
