import { createPrismaClient } from "@ws-model-proxy/db/client-factory";
import { describe, expect, it } from "vitest";

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("PostgreSQL integration requires SCHEMA_VALIDATION_DATABASE_URL");
const integration = databaseUrl ? describe : describe.skip;

integration("own-key preference integrity and requester capacity", () => {
  it("ties preferences to the exact grant/model owner, cascades revoke, and admits DIRECT for a cross-tenant pool", async () => {
    if (!databaseUrl) return;
    const db = createPrismaClient(databaseUrl);
    const suffix = crypto.randomUUID();
    const owner = await db.user.create({
      data: { name: "Owner", email: `own-key-owner-${suffix}@example.test` },
    });
    const requester = await db.user.create({
      data: { name: "Requester", email: `own-key-requester-${suffix}@example.test` },
    });
    try {
      const pool = await db.modelPool.create({
        data: {
          userId: owner.id,
          name: "Shared",
          slug: `shared-${suffix}`,
          externalEquivalentModel: "vendor/model",
        },
      });
      const otherPool = await db.modelPool.create({
        data: { userId: owner.id, name: "Other", slug: `other-${suffix}` },
      });
      const grant = await db.poolGrant.create({
        data: { poolId: pool.id, ownerUserId: owner.id, granteeUserId: requester.id },
      });
      const account = await db.providerAccount.create({
        data: {
          userId: requester.id,
          providerType: "openai",
          label: "Own key",
          baseUrl: "https://provider.example",
          endpointIdentity: "https://provider.example",
          authType: "BEARER",
        },
      });
      const model = await db.providerModel.create({
        data: {
          userId: requester.id,
          providerAccountId: account.id,
          upstreamModelId: "test-model",
        },
      });
      const preference = {
        poolId: pool.id,
        userId: requester.id,
        poolGrantId: grant.id,
        providerModelId: model.id,
      };
      await expect(
        db.poolFallbackPreference.create({ data: { ...preference, poolId: otherPool.id } }),
      ).rejects.toBeDefined();
      await expect(
        db.poolFallbackPreference.create({ data: { ...preference, userId: owner.id } }),
      ).rejects.toBeDefined();
      const ownerAccount = await db.providerAccount.create({
        data: {
          userId: owner.id,
          providerType: "openai",
          label: "Owner key",
          baseUrl: "https://provider.example",
          endpointIdentity: "https://provider.example",
          authType: "BEARER",
        },
      });
      const ownerModel = await db.providerModel.create({
        data: {
          userId: owner.id,
          providerAccountId: ownerAccount.id,
          upstreamModelId: "owner-model",
        },
      });
      await expect(
        db.poolFallbackPreference.create({
          data: { ...preference, providerModelId: ownerModel.id },
        }),
      ).rejects.toBeDefined();
      await db.poolFallbackPreference.create({ data: preference });
      await expect(db.poolFallbackPreference.create({ data: preference })).rejects.toBeDefined();
      await db.poolGrant.delete({ where: { id: grant.id } });
      expect(await db.poolFallbackPreference.count({ where: { poolId: pool.id } })).toBe(0);
      const replacement = await db.poolGrant.create({
        data: { poolId: pool.id, ownerUserId: owner.id, granteeUserId: requester.id },
      });
      await expect(db.poolFallbackPreference.create({ data: preference })).rejects.toBeDefined();
      await db.poolFallbackPreference.create({
        data: { ...preference, poolGrantId: replacement.id },
      });
      const capacity = await db.inferenceCapacity.create({
        data: {
          userId: requester.id,
          label: "Own capacity",
          runtimeIdentityKey: `own-key-${suffix}`,
          runtimeModel: "test-model",
          hardConcurrencyLimit: 1,
        },
      });
      const target = await db.executionTarget.create({
        data: {
          userId: requester.id,
          providerModelId: model.id,
          kind: "PROVIDER_MODEL",
          inferenceCapacityId: capacity.id,
        },
      });
      const relay = await db.relayRequest.create({
        data: {
          userId: requester.id,
          requestedModelPoolId: pool.id,
          selectedExecutionTargetId: target.id,
          fallbackRoute: "own-key",
          requestedSurface: "OPENAI_CHAT_COMPLETIONS",
        },
      });
      const { PostgresCapacityAdmissionStore } = await import("./capacity/postgres-store.js");
      const store = new PostgresCapacityAdmissionStore(db, `own-key-${suffix}`);
      const result = await store.acquire({
        requestId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        relayRequestId: relay.id,
        ownerId: requester.id,
        sourceKind: "DIRECT",
        basePriority: 16,
        connectionOwner: "own-key-test",
        deadlineAt: new Date(Date.now() + 30_000),
        candidates: [
          {
            capacityId: capacity.id,
            executionTargetId: target.id,
            candidateOrder: 0,
            waitBudgetMs: 0,
          },
        ],
      });
      expect(result.state).toBe("ADMITTED");
      if (result.state === "ADMITTED") {
        expect(
          await db.capacityLease.findUnique({ where: { id: result.lease.leaseId } }),
        ).toMatchObject({ userId: requester.id, poolId: null, poolMemberId: null });
        await store.release(result.lease);
      }
      // Native Responses bindings preserve cross-tenant pool visibility without
      // requiring an owner-owned pool member for the requester's own target.
      const binding = await db.responseStickinessRecord.create({
        data: {
          userId: requester.id,
          routingKeyDigest: suffix,
          routingVersion: 3,
          targetModelPoolId: pool.id,
          selectedExecutionTargetId: target.id,
          providerAccountId: account.id,
          providerModelId: model.id,
          providerEndpointIdentity: account.endpointIdentity,
          providerEndpointVersion: account.endpointVersion,
          providerUpstreamModelId: model.upstreamModelId,
          poolGrantId: replacement.id,
          nativeSurface: "OPENAI_RESPONSES",
          upstreamResponseIdDigest: suffix,
          fallbackRoute: "own-key",
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      expect(binding.fallbackRoute).toBe("own-key");
      await db.poolGrant.delete({ where: { id: replacement.id } });
      expect(await db.poolFallbackPreference.count({ where: { poolId: pool.id } })).toBe(0);
      expect(
        await db.responseStickinessRecord.findUnique({ where: { id: binding.id } }),
      ).toBeNull();
      // Immutable capacity history intentionally remains in the disposable CI database.
    } finally {
      await db.$disconnect();
    }
  });
});
