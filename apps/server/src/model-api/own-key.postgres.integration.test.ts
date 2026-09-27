import type { VisibleModelPoolTarget } from "@ws-model-proxy/api/lib/model-api-token-access";
import { createPrismaClient } from "@ws-model-proxy/db/client-factory";
import { describe, expect, it, vi } from "vitest";
import type { PublicOverflowRequest, PublicProviderTarget } from "./public-overflow.js";

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("PostgreSQL integration requires SCHEMA_VALIDATION_DATABASE_URL");
const integration = databaseUrl ? describe : describe.skip;

integration("own-key preference integrity and requester capacity", () => {
  it("ties preferences to the exact grant/model owner, cascades revoke, and admits DIRECT for a cross-tenant pool", async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
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
      ).rejects.toThrow(/own-key preference requires the exact non-owner grant/);
      await expect(
        db.poolFallbackPreference.create({ data: { ...preference, userId: owner.id } }),
      ).rejects.toThrow(/own-key preference requires the exact non-owner grant/);
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
      ).rejects.toMatchObject({ code: "P2003" });
      // Both trigger branches with otherwise valid composite FK tuples.
      const selfGrant = await db.poolGrant.create({
        data: { poolId: pool.id, ownerUserId: owner.id, granteeUserId: owner.id },
      });
      await expect(
        db.poolFallbackPreference.create({
          data: {
            poolId: pool.id,
            poolGrantId: selfGrant.id,
            userId: owner.id,
            providerModelId: ownerModel.id,
          },
        }),
      ).rejects.toThrow(/own-key preference requires the exact non-owner grant/);
      await db.poolGrant.delete({ where: { id: selfGrant.id } });
      await db.poolGrant.update({ where: { id: grant.id }, data: { ownerUserId: requester.id } });
      await expect(db.poolFallbackPreference.create({ data: preference })).rejects.toThrow(
        /own-key preference requires the exact non-owner grant/,
      );
      await db.poolGrant.update({ where: { id: grant.id }, data: { ownerUserId: owner.id } });
      await db.poolFallbackPreference.create({ data: preference });
      await expect(db.poolFallbackPreference.create({ data: preference })).rejects.toMatchObject({
        code: "P2002",
      });
      await db.poolGrant.delete({ where: { id: grant.id } });
      expect(await db.poolFallbackPreference.count({ where: { poolId: pool.id } })).toBe(0);
      const replacement = await db.poolGrant.create({
        data: { poolId: pool.id, ownerUserId: owner.id, granteeUserId: requester.id },
      });
      await expect(db.poolFallbackPreference.create({ data: preference })).rejects.toThrow(
        /own-key preference requires the exact non-owner grant/,
      );
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
      // Exercise the HTTP routing path with real relay writes and PostgreSQL
      // admission; only authentication/listing and provider transport are fixtures.
      // On master this has no own-key tier and cannot acquire this DIRECT lease.
      vi.doMock("@ws-model-proxy/db", async () => {
        const actual =
          await vi.importActual<typeof import("@ws-model-proxy/db")>("@ws-model-proxy/db");
        return { ...actual, default: db };
      });
      vi.doMock("@ws-model-proxy/env/server", () => ({
        env: {
          NODE_ENV: "test",
          BETTER_AUTH_SECRET: "own-key-postgres-test-secret-value",
          WMP_PUBLIC_PROVIDER_EGRESS_ENABLED: true,
        },
      }));
      const visiblePool: VisibleModelPoolTarget = {
        target: "MODEL_POOL" as const,
        id: pool.id,
        modelId: "owner/shared",
        name: pool.name,
        description: null,
        ownerUserId: owner.id,
        ownerUserSlug: "owner",
        accessGrantId: replacement.id,
        poolSlug: pool.slug,
        maxAttachmentBytes: null,
        optimisticBasicTranscription: false,
        protocolAdaptationEnabled: false,
        fallbackEnabled: false,
        fallbackForGrantees: false,
        externalMemberCount: 0,
        effectiveProviderEgress: true,
        providerAccountLabels: [],
        providerTypes: [],
        allowLossyDeveloperRoleCollapse: false,
        recommendedSurfaceOverride: null,
        externalEquivalentModel: pool.externalEquivalentModel,
        ownKeyProviderModelId: model.id,
      };
      vi.doMock("@ws-model-proxy/api/lib/model-api-token-access", async () => {
        const actual = await vi.importActual<
          typeof import("@ws-model-proxy/api/lib/model-api-token-access")
        >("@ws-model-proxy/api/lib/model-api-token-access");
        return {
          ...actual,
          // CHAT_TEST avoids a synthetic token FK in real relay_request rows.
          listVisibleModelTargetsForUser: async () => ({
            directModels: [],
            modelPools: [visiblePool],
          }),
        };
      });
      const provider: PublicProviderTarget = {
        ownKey: true,
        poolMemberId: "",
        executionTargetId: target.id,
        inferenceCapacityId: capacity.id,
        publicOrder: 0,
        providerModelId: model.id,
        upstreamModelId: model.upstreamModelId,
        contextWindow: 10000,
        maxOutputTokens: 1000,
        protocol: "openai",
        providerAccountId: account.id,
        endpointIdentity: account.endpointIdentity,
        endpointVersion: account.endpointVersion,
        concurrencyLimit: 1,
        providerVersion: null,
        baseUrl: account.baseUrl,
        authType: "BEARER",
        healthStatus: "HEALTHY",
        nativeProtocols: ["openai"],
        nativeSurfaces: ["openai-chat"],
        supportsStreaming: true,
        supportedFeatures: [],
        credential: {
          id: "transport-fixture",
          credentialType: "BEARER",
          keyVersion: "test",
          aadVersion: 1,
          algorithm: "AES-256-GCM",
          ciphertext: new Uint8Array(),
          nonce: new Uint8Array(),
          authTag: new Uint8Array(),
        },
      };
      const sent = vi.fn(async (request: PublicOverflowRequest) => {
        expect(request).toMatchObject({
          userId: requester.id,
          ownKeyProviderModelId: model.id,
          admittedExecutionTargetId: target.id,
        });
        const lease = await db.capacityLease.findFirstOrThrow({
          where: { executionTargetId: target.id, state: "ACTIVE" },
        });
        expect(lease).toMatchObject({ userId: requester.id, poolId: null, poolMemberId: null });
        expect(
          await db.admissionRequest.findUniqueOrThrow({ where: { id: lease.admissionRequestId } }),
        ).toMatchObject({ sourceKind: "DIRECT" });
        await request.beforeProviderSend?.(provider);
        // The hardening trigger must allow a grantee selecting their OWN
        // execution target despite requestedModelPoolId belonging to the owner.
        expect(
          await db.relayRequest.findUniqueOrThrow({ where: { id: request.requestId } }),
        ).toMatchObject({
          userId: requester.id,
          requestedModelPoolId: pool.id,
          fallbackRoute: "own-key",
          selectedExecutionTargetId: target.id,
          selectedPoolMemberId: null,
        });
        return {
          dispatched: true,
          target: provider,
          response: new Response('{"model":"test-model"}', {
            headers: { "content-type": "application/json" },
          }),
          attemptId: "transport-fixture",
          fencingToken: 1n,
          nativeSurface: "openai-chat",
          attemptCount: 1,
          terminal: Promise.resolve({ ok: true, responseBytes: 22 }),
          markFirstClientByte: async () => undefined,
        };
      });
      vi.doMock("./public-overflow.js", async () => {
        const actual =
          await vi.importActual<typeof import("./public-overflow.js")>("./public-overflow.js");
        return {
          ...actual,
          dispatchPublicOverflow: sent,
          listPublicOverflowTargets: async () => ({
            enabled: true,
            fallbackForGrantees: true,
            affinityPolicy: { enabled: false },
            targets: [provider],
            coolingDown: [],
            unavailable: [],
          }),
        };
      });
      const { PostgresCapacityAdmissionStore } = await import("./capacity/postgres-store.js");
      const { StoreCapacityAdmissionRuntime } = await import("./capacity/runtime.js");
      const { chatTestCompletionsHandler } = await import("./routes.js");
      const { ModelApiConcurrencyLimiter } = await import("./limits.js");
      const { RelaySessionManager } = await import("../relay/session-manager.js");
      const runtime = new StoreCapacityAdmissionRuntime(
        new PostgresCapacityAdmissionStore(db, `own-key-${suffix}`),
      );
      try {
        const response = await chatTestCompletionsHandler({
          request: new Request("https://proxy.example.test/chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model: "owner/shared:external",
              messages: [{ role: "user", content: "test" }],
              max_tokens: 20,
            }),
          }),
          userId: requester.id,
          manager: new RelaySessionManager(),
          limiter: new ModelApiConcurrencyLimiter(),
          capacityRuntime: runtime,
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("x-wsmp-route")).toBe("own-key");
        await response.text();
        expect(sent).toHaveBeenCalledOnce();
        await vi.waitFor(async () => {
          expect(
            await db.relayRequest.findFirst({
              where: { userId: requester.id, status: "SUCCEEDED" },
            }),
          ).not.toBeNull();
        });
        expect(
          await db.usageRollupMinute.findFirst({
            where: { ownerUserId: requester.id, executionTargetId: target.id },
          }),
        ).toMatchObject({ poolId: "", poolMemberId: "", successes: 1 });
      } finally {
        await runtime.close();
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
      vi.doUnmock("@ws-model-proxy/db");
      vi.doUnmock("@ws-model-proxy/env/server");
      vi.doUnmock("@ws-model-proxy/api/lib/model-api-token-access");
      vi.doUnmock("./public-overflow.js");
      await db.$disconnect();
    }
  });
});
