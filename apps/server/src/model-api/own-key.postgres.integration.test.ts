import type { VisibleModelPoolTarget } from "@ws-model-proxy/api/lib/model-api-token-access";
import { createPrismaClient } from "@ws-model-proxy/db/client-factory";
import { describe, expect, it, vi } from "vitest";
import type { ActiveRelayResponseHandlers } from "../relay/session-manager.js";
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
      // Exercise routes, metadata/terminal writers, rollups and real PostgreSQL
      // capacity admission. Visibility and the ENTIRE provider dispatcher are
      // fixtures: this does not test provider budget, send claim, network I/O or
      // the dispatcher's beforeProviderSend ordering (covered by dispatch tests).
      // On master this has no own-key tier and cannot acquire this DIRECT lease.
      vi.doMock("@ws-model-proxy/db", async () => {
        const actual =
          await vi.importActual<typeof import("@ws-model-proxy/db")>("@ws-model-proxy/db");
        return { ...actual, default: db };
      });
      // This JSON-only path needs no multipart limits. Relay limits/timeouts
      // are constants in limits.ts; the capacity runtime supplies constructor
      // defaults and reads no env. The stubbed dispatcher bypasses transport env.
      // Undefined optional settings use the production helpers' defaults; this
      // fixture intentionally does not assert real provider transport behavior.
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
        externalRoutes: [],
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
      const sent = vi.fn<
        (
          request: PublicOverflowRequest,
        ) => Promise<import("./public-overflow.js").PublicOverflowResult>
      >(async (request) => {
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
          affinity: undefined,
        };
      });
      const list = vi.fn(async (_owner: string, _pool: string, _ownKey?: unknown) => ({
        enabled: true,
        fallbackForGrantees: true,
        affinityPolicy: { enabled: false },
        targets: [provider],
        coolingDown: [],
        unavailable: [],
      }));
      vi.doMock("./public-overflow.js", async () => {
        const actual =
          await vi.importActual<typeof import("./public-overflow.js")>("./public-overflow.js");
        return {
          ...actual,
          dispatchPublicOverflow: sent,
          listPublicOverflowTargets: list,
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
        // Reuse the real routing/metadata stack for both owner and grantee
        // local requests, a failed owner-paid stream, and own-key restoration
        // AFTER a real local attempt selected an owner-owned target.
        const cli = await db.cliDevice.create({
          data: { userId: owner.id, slug: `local-${suffix}`, status: "CONNECTED" },
        });
        const endpoint = await db.endpoint.create({
          data: {
            userId: owner.id,
            cliDeviceId: cli.id,
            slug: `local-${suffix}`,
            label: "Local",
            status: "ONLINE",
            capabilityMetadata: {
              version: 3,
              protocol: "openai-compatible",
              surfaces: {
                openaiChatCompletions: {
                  source: "declared",
                  confidence: "exact",
                  supported: true,
                  streaming: true,
                },
              },
            },
          },
        });
        const localModel = await db.discoveredModel.create({
          data: {
            userId: owner.id,
            endpointId: endpoint.id,
            upstreamModelId: "local-model",
            encodedModelId: "local-model",
          },
        });
        const localTarget = await db.executionTarget.findUniqueOrThrow({
          where: { discoveredModelId: localModel.id },
        });
        const localMember = await db.poolMember.create({
          data: {
            poolId: pool.id,
            executionTargetId: localTarget.id,
            healthStatus: "HEALTHY",
          },
        });
        const manager = new RelaySessionManager();
        vi.spyOn(manager, "getActiveCliDeviceIds").mockReturnValue([cli.id]);
        const handlers = new Map<string, ActiveRelayResponseHandlers>();
        vi.spyOn(manager, "registerRelayResponseHandlers").mockImplementation((input) => {
          handlers.set(input.requestId, input.handlers);
        });
        const localSent = vi.spyOn(manager, "sendRelayRequest").mockImplementation(() => undefined);
        vi.spyOn(manager, "cancelRelayRequest").mockImplementation(() => undefined);
        const invoke = (modelName: string, userId = requester.id) =>
          chatTestCompletionsHandler({
            request: new Request("https://proxy.example.test/chat/completions", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                model: modelName,
                messages: [{ role: "user", content: "test" }],
                max_tokens: 20,
              }),
            }),
            userId,
            manager,
            limiter: new ModelApiConcurrencyLimiter(),
            capacityRuntime: runtime,
          });
        const localTuple = {
          fallbackRoute: "local",
          selectedExecutionTargetId: localTarget.id,
          selectedDiscoveredModelId: localModel.id,
          selectedPoolMemberId: localMember.id,
        };
        const successfulLocalRows: string[] = [];
        for (const caller of [owner.id, requester.id]) {
          localSent.mockClear();
          const responsePromise = invoke("owner/shared", caller);
          await vi.waitFor(() => expect(localSent).toHaveBeenCalledOnce());
          const attemptId = localSent.mock.calls[0]![0].requestId;
          const attempt = await db.relayExecutionAttempt.findUniqueOrThrow({
            where: { attemptId },
          });
          expect(
            await db.relayRequest.findUniqueOrThrow({ where: { id: attempt.relayRequestId } }),
          ).toMatchObject({
            ...localTuple,
            userId: caller,
            requestedModelPoolId: pool.id,
            status: "PENDING",
          });
          const handler = handlers.get(attemptId)!;
          handler.onHeaders({
            type: "relay.response.headers",
            requestId: attemptId,
            status: 200,
            headers: { "content-type": "application/json" },
          });
          handler.onBody(new TextEncoder().encode('{"model":"local-model"}'), {
            type: "relay.response.body",
            requestId: attemptId,
            chunkId: "0",
          });
          handler.onComplete({ type: "relay.complete", requestId: attemptId });
          const response = await responsePromise;
          expect(response.status).toBe(200);
          await response.text();
          await vi.waitFor(async () =>
            expect(
              await db.relayRequest.findUniqueOrThrow({ where: { id: attempt.relayRequestId } }),
            ).toMatchObject({
              ...localTuple,
              userId: caller,
              status: "SUCCEEDED",
              httpStatusCode: 200,
            }),
          );
          successfulLocalRows.push(attempt.relayRequestId);
        }

        // Make the owner-paid target real. The dispatcher is still a fixture;
        // its committed failure drives the production metadata/rollup writers.
        const ownerCapacity = await db.inferenceCapacity.create({
          data: {
            userId: owner.id,
            label: "Owner capacity",
            runtimeIdentityKey: `owner-${suffix}`,
            runtimeModel: "owner-model",
            hardConcurrencyLimit: 1,
          },
        });
        const ownerTarget = await db.executionTarget.create({
          data: {
            userId: owner.id,
            providerModelId: ownerModel.id,
            kind: "PROVIDER_MODEL",
            inferenceCapacityId: ownerCapacity.id,
          },
        });
        const paidMember = await db.poolMember.create({
          data: {
            poolId: pool.id,
            executionTargetId: ownerTarget.id,
            tier: "PUBLIC_OVERFLOW",
            publicOrder: 0,
          },
        });
        const paid: PublicProviderTarget = {
          ...provider,
          ownKey: false,
          poolMemberId: paidMember.id,
          executionTargetId: ownerTarget.id,
          inferenceCapacityId: ownerCapacity.id,
          providerModelId: ownerModel.id,
          providerAccountId: ownerAccount.id,
          upstreamModelId: ownerModel.upstreamModelId,
        };
        await db.modelPool.update({
          where: { id: pool.id },
          data: { fallbackEnabled: true, fallbackForGrantees: true },
        });
        visiblePool.fallbackEnabled = true;
        visiblePool.fallbackForGrantees = true;
        visiblePool.ownKeyProviderModelId = model.id;
        visiblePool.externalMemberCount = 1;
        vi.mocked(manager.getActiveCliDeviceIds).mockReturnValue([]);
        list.mockImplementation(async (_owner, _pool, ownKey) => ({
          enabled: true,
          fallbackForGrantees: true,
          affinityPolicy: { enabled: false },
          targets: [ownKey ? provider : paid],
          coolingDown: [],
          unavailable: [],
        }));
        sent.mockImplementationOnce(async (request) => {
          await request.beforeProviderSend?.(provider);
          return {
            dispatched: false,
            reason: "PROVIDER_UNAVAILABLE",
            providerIoStarted: true,
            providerFailure: { target: provider, status: 503 },
          };
        });
        let paidRequestId = "";
        sent.mockImplementationOnce(async (request) => {
          paidRequestId = request.requestId;
          expect(request.userId).toBe(owner.id);
          expect(
            await db.relayRequest.findUniqueOrThrow({ where: { id: request.requestId } }),
          ).toMatchObject({
            fallbackRoute: "local",
            selectedExecutionTargetId: null,
            selectedPoolMemberId: null,
          });
          return {
            dispatched: true,
            target: paid,
            response: new Response('{"error":"upstream failure"}', {
              status: 502,
              headers: { "content-type": "application/json" },
            }),
            attemptId: "paid-fixture",
            fencingToken: 1n,
            nativeSurface: "openai-chat",
            attemptCount: 1,
            terminal: Promise.resolve({ ok: false, responseBytes: 28 }),
            markFirstClientByte: async () => undefined,
            affinity: undefined,
          };
        });
        const paidResponse = await invoke("owner/shared:external");
        expect(paidResponse.status).toBe(502);
        await paidResponse.text();
        await vi.waitFor(async () =>
          expect(
            await db.relayRequest.findUniqueOrThrow({ where: { id: paidRequestId } }),
          ).toMatchObject({
            userId: requester.id,
            requestedModelPoolId: pool.id,
            fallbackRoute: "pool-external",
            selectedExecutionTargetId: ownerTarget.id,
            selectedDiscoveredModelId: null,
            selectedPoolMemberId: paidMember.id,
            status: "FAILED",
            httpStatusCode: 502,
          }),
        );

        visiblePool.ownKeyProviderModelId = model.id;
        vi.mocked(manager.getActiveCliDeviceIds).mockReturnValue([cli.id]);
        list.mockImplementation(async (_owner, _pool, ownKey) => ({
          enabled: Boolean(ownKey),
          fallbackForGrantees: false,
          affinityPolicy: { enabled: false },
          targets: ownKey ? [provider] : [],
          coolingDown: [],
          unavailable: [],
        }));
        const updateSpy = vi.spyOn(db.relayRequest, "update");
        sent.mockImplementationOnce(async (request) => {
          expect(request.reason).toBe("RETRYABLE_PRECOMMIT_PRIMARY_FAILURE");
          expect(
            await db.relayRequest.findUniqueOrThrow({ where: { id: request.requestId } }),
          ).toMatchObject(localTuple);
          await request.beforeProviderSend?.(provider);
          expect(
            await db.relayRequest.findUniqueOrThrow({ where: { id: request.requestId } }),
          ).toMatchObject({
            fallbackRoute: "own-key",
            selectedExecutionTargetId: target.id,
            selectedDiscoveredModelId: null,
            selectedPoolMemberId: null,
          });
          return {
            dispatched: false,
            reason: "PROVIDER_UNAVAILABLE",
            providerIoStarted: true,
            providerFailure: { target: provider, status: 503 },
          };
        });
        localSent.mockClear();
        const restoreResponsePromise = invoke("owner/shared:external");
        await vi.waitFor(() => expect(localSent).toHaveBeenCalledOnce());
        const failedAttemptId = localSent.mock.calls[0]![0].requestId;
        handlers
          .get(failedAttemptId)!
          .onError({ type: "relay.error", requestId: failedAttemptId, failure: "transport" });
        const restoredResponse = await restoreResponsePromise;
        // Local members fix this request's failure contract: an uncommitted
        // own-key 503 cannot replace the local transport error (502).
        expect(restoredResponse.status).toBe(502);
        await expect(restoredResponse.json()).resolves.toMatchObject({
          error: { code: "transport" },
        });
        const intentIndex = updateSpy.mock.calls.findIndex(
          ([args]) => args.data.fallbackRoute === "own-key",
        );
        expect(intentIndex).toBeGreaterThanOrEqual(0);
        const restoreIndex = updateSpy.mock.calls.findIndex(
          ([args], index) =>
            index > intentIndex &&
            args.data.fallbackRoute === "local" &&
            args.data.selectedDiscoveredModelId === localModel.id &&
            !args.data.status,
        );
        expect(restoreIndex).toBeGreaterThan(intentIndex);
        expect(await updateSpy.mock.results[restoreIndex]!.value).toMatchObject({
          ...localTuple,
          userId: requester.id,
          status: "PENDING",
        });
        const failedAttempt = await db.relayExecutionAttempt.findUniqueOrThrow({
          where: { attemptId: failedAttemptId },
        });
        expect(failedAttempt).toMatchObject({ state: "FAILED", terminalState: "FAILED" });
        expect(
          await db.relayRequest.findUniqueOrThrow({ where: { id: failedAttempt.relayRequestId } }),
        ).toMatchObject({
          ...localTuple,
          status: "FAILED",
          httpStatusCode: 502,
          upstreamStatusCode: null,
          errorClass: "transport",
        });
        updateSpy.mockRestore();

        // Ownership enforcement still rejects foreign direct targets, wrong
        // pool owners, own-key pointing at owner targets, and model mismatches.
        const granteeRowId = successfulLocalRows[1]!;
        await expect(
          db.relayRequest.update({
            where: { id: granteeRowId },
            data: { requestedModelPoolId: null, selectedExecutionTargetId: ownerTarget.id },
          }),
        ).rejects.toThrow(/relay request selection must match/);
        await expect(
          db.relayRequest.update({
            where: { id: granteeRowId },
            data: { fallbackRoute: "own-key" },
          }),
        ).rejects.toThrow(/relay request selection must match/);
        const requesterPool = await db.modelPool.create({
          data: { userId: requester.id, name: "Requester pool", slug: `requester-${suffix}` },
        });
        await expect(
          db.relayRequest.update({
            where: { id: granteeRowId },
            data: { requestedModelPoolId: requesterPool.id },
          }),
        ).rejects.toThrow(/relay request selection must match/);
        await expect(
          db.relayRequest.create({
            data: {
              userId: requester.id,
              requestedModelPoolId: pool.id,
              selectedExecutionTargetId: ownerTarget.id,
              selectedDiscoveredModelId: localModel.id,
            },
          }),
        ).rejects.toThrow(/relay request selection must match/);
        await expect(
          db.relayRequest.create({
            data: { userId: requester.id, requestedExecutionTargetId: ownerTarget.id },
          }),
        ).rejects.toThrow(/relay request target must match/);
        // No live grant is required to finish historical telemetry.
        // Parent cascade is checked after the binding/revoke assertions below.
      } finally {
        await runtime.close();
        vi.restoreAllMocks();
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
      // Real admissions above retain RESTRICT-protected capacity leases. The
      // app must refuse deleting this graph; deletion behavior is exercised
      // below with history that has no retained leases or provider accounting.
      const { prepareParentDeletion, RetainedHistoryError } = await import(
        "@ws-model-proxy/db/parent-deletion"
      );
      await expect(
        prepareParentDeletion(db, { userId: owner.id, poolIds: [pool.id] }),
      ).rejects.toBeInstanceOf(RetainedHistoryError);
      // Immutable capacity history intentionally remains in the disposable CI database.
    } finally {
      vi.doUnmock("@ws-model-proxy/db");
      vi.doUnmock("@ws-model-proxy/env/server");
      vi.doUnmock("@ws-model-proxy/api/lib/model-api-token-access");
      vi.doUnmock("./public-overflow.js");
      await db.$disconnect();
    }
  });

  it.each(["pool", "owner"] as const)(
    "drains grantee local and owner-paid history before deleting its %s through the app path",
    async (parent) => {
      if (!databaseUrl) return;
      const db = createPrismaClient(databaseUrl);
      const { prepareParentDeletion, requestUserDeletion, completeUserDeletion } = await import(
        "@ws-model-proxy/db/parent-deletion"
      );
      const { lockCapacityGraphForDelete, runCapacityOrderedTransaction } = await import(
        "@ws-model-proxy/db/capacity-lock-order"
      );
      const suffix = crypto.randomUUID();
      try {
        // No admissions/leases or provider accounting: those correctly block
        // parent deletion before the drain, as the route fixture above proves.
        const owner = await db.user.create({
          data: { name: "History owner", email: `history-owner-${suffix}@example.test` },
        });
        const requester = await db.user.create({
          data: { name: "History grantee", email: `history-grantee-${suffix}@example.test` },
        });
        const pool = await db.modelPool.create({
          data: { userId: owner.id, name: "History", slug: `history-${suffix}` },
        });
        const scope = { userId: owner.id, poolIds: [pool.id] };
        // Empty/default history is a no-op, including repeated preparation.
        expect((await prepareParentDeletion(db, scope))["relay_request.detach"]).toBe(0);
        const grant = await db.poolGrant.create({
          data: { poolId: pool.id, ownerUserId: owner.id, granteeUserId: requester.id },
        });
        const cli = await db.cliDevice.create({ data: { userId: owner.id, slug: "history" } });
        const endpoint = await db.endpoint.create({
          data: { userId: owner.id, cliDeviceId: cli.id, slug: "history", label: "History" },
        });
        const localModel = await db.discoveredModel.create({
          data: {
            userId: owner.id,
            endpointId: endpoint.id,
            upstreamModelId: "history-local",
            encodedModelId: "history-local",
          },
        });
        const localTarget = await db.executionTarget.findUniqueOrThrow({
          where: { discoveredModelId: localModel.id },
        });
        const localMember = await db.poolMember.create({
          data: { poolId: pool.id, executionTargetId: localTarget.id, tier: "PRIMARY" },
        });
        const providerTarget = async (userId: string) => {
          const account = await db.providerAccount.create({
            data: {
              userId,
              providerType: "openai",
              label: "History provider",
              baseUrl: "https://provider.example",
              endpointIdentity: "https://provider.example",
              authType: "BEARER",
              enabled: false,
            },
          });
          const model = await db.providerModel.create({
            data: { userId, providerAccountId: account.id, upstreamModelId: "history-paid" },
          });
          // Production backfill supplies a same-owner capacity on insert.
          return db.executionTarget.create({
            data: { userId, kind: "PROVIDER_MODEL", providerModelId: model.id },
          });
        };
        const paidTarget = await providerTarget(owner.id);
        const ownTarget = await providerTarget(requester.id);
        const paidMember = await db.poolMember.create({
          data: {
            poolId: pool.id,
            executionTargetId: paidTarget.id,
            tier: "PUBLIC_OVERFLOW",
            publicOrder: 0,
          },
        });
        const selections = [
          {
            fallbackRoute: "local",
            selectedExecutionTargetId: localTarget.id,
            selectedPoolMemberId: localMember.id,
          },
          {
            fallbackRoute: "pool-external",
            selectedExecutionTargetId: paidTarget.id,
            selectedPoolMemberId: paidMember.id,
          },
        ];
        const history = [];
        for (const selection of selections) {
          for (const status of ["SUCCEEDED", "FAILED", "CANCELED"] as const) {
            history.push(
              await db.relayRequest.create({
                data: { userId: requester.id, requestedModelPoolId: pool.id, ...selection, status },
              }),
            );
          }
        }
        const ownerRow = await db.relayRequest.create({
          data: {
            userId: owner.id,
            requestedModelPoolId: pool.id,
            ...selections[0]!,
            status: "SUCCEEDED",
          },
        });
        const ownRow = await db.relayRequest.create({
          data: {
            userId: requester.id,
            requestedModelPoolId: pool.id,
            fallbackRoute: "own-key",
            selectedExecutionTargetId: ownTarget.id,
            status: "SUCCEEDED",
          },
        });
        const pending = await db.relayRequest.create({
          data: { userId: requester.id, requestedModelPoolId: pool.id, ...selections[0]! },
        });
        // No grant is needed to detach historical identity after revocation.
        await db.poolGrant.delete({ where: { id: grant.id } });
        for (const data of [
          { requestedModelPoolId: null, selectedExecutionTargetId: paidTarget.id },
          { requestedModelPoolId: null, selectedPoolMemberId: paidMember.id },
          { requestedModelPoolId: null, fallbackRoute: "pool-external" },
          { requestedModelPoolId: null, status: "PENDING" as const },
        ]) {
          await expect(
            db.relayRequest.update({ where: { id: history[0]!.id }, data }),
          ).rejects.toThrow(/relay request selection must match/);
        }
        await expect(
          db.relayRequest.update({
            where: { id: history[3]!.id },
            data: { requestedModelPoolId: null, selectedDiscoveredModelId: localModel.id },
          }),
        ).rejects.toThrow(/relay request selection must match/);
        await expect(
          db.relayRequest.update({
            where: { id: pending.id },
            data: { requestedModelPoolId: null },
          }),
        ).rejects.toThrow(/relay request selection must match/);
        await expect(
          db.relayRequest.create({
            data: { userId: requester.id, selectedExecutionTargetId: paidTarget.id },
          }),
        ).rejects.toThrow(/relay request selection must match/);

        const mark = parent === "owner" ? await requestUserDeletion(db, owner.id) : null;
        const deleteScope = parent === "owner" ? { userId: owner.id, wholeUser: true } : scope;
        const options = {
          batch: 1,
          ...(mark ? { owner: { userId: owner.id, generation: mark.generation } } : {}),
        };
        // Same prepare/drain used by drainBeforeParentDelete and the user
        // sweeper. Crucially the pool still exists when every batch runs.
        const report = await prepareParentDeletion(db, deleteScope, options);
        expect(report["relay_request.detach"]).toBeGreaterThanOrEqual(history.length + 1);
        expect(await db.modelPool.findUnique({ where: { id: pool.id } })).not.toBeNull();
        for (const row of history) {
          expect(await db.relayRequest.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
            requestedModelPoolId: null,
            selectedExecutionTargetId: null,
            selectedDiscoveredModelId: null,
            selectedPoolMemberId: null,
            userId: requester.id,
            status: row.status,
            fallbackRoute: row.fallbackRoute,
          });
        }
        expect(await db.relayRequest.findUniqueOrThrow({ where: { id: ownRow.id } })).toMatchObject(
          {
            requestedModelPoolId: null,
            selectedExecutionTargetId: ownTarget.id,
          },
        );
        expect(
          await db.relayRequest.findUniqueOrThrow({ where: { id: pending.id } }),
        ).toMatchObject({
          requestedModelPoolId: pool.id,
          selectedExecutionTargetId: localTarget.id,
          status: "PENDING",
        });
        if (parent === "pool") {
          expect(
            await db.relayRequest.findUniqueOrThrow({ where: { id: ownerRow.id } }),
          ).toMatchObject({
            requestedModelPoolId: null,
            selectedExecutionTargetId: localTarget.id,
            selectedDiscoveredModelId: localModel.id,
            selectedPoolMemberId: null,
          });
        }
        // A retry after a partial drain must be safe; detached rows cannot
        // be used to reattach a foreign target once their pool anchor is gone.
        expect(
          (await prepareParentDeletion(db, deleteScope, options))["relay_request.detach"],
        ).toBe(0);
        await expect(
          db.relayRequest.update({
            where: { id: history[0]!.id },
            data: { selectedExecutionTargetId: localTarget.id },
          }),
        ).rejects.toThrow(/relay request selection must match/);
        if (parent === "owner") {
          expect(mark).not.toBeNull();
          expect(await completeUserDeletion(db, owner.id, mark!.generation, { batch: 1 })).toBe(
            true,
          );
          expect(await db.user.findUnique({ where: { id: owner.id } })).toBeNull();
          expect(await db.relayRequest.findUnique({ where: { id: ownerRow.id } })).toBeNull();
        } else {
          // Exact final transaction used by deleteModelPool, after preparation.
          await runCapacityOrderedTransaction(db, async (tx) => {
            await lockCapacityGraphForDelete(tx, scope);
            await tx.modelPool.delete({ where: { id: pool.id } });
          });
          expect(
            await db.executionTarget.findUnique({ where: { id: localTarget.id } }),
          ).not.toBeNull();
        }
        expect(await db.modelPool.findUnique({ where: { id: pool.id } })).toBeNull();
        // PENDING rows are deliberately skipped by the drain; the final FK
        // cascade still erases their cross-tenant selection. P3C-2's later
        // in-flight finalizer/attribution policy is a separate deferred issue.
        expect(
          await db.relayRequest.findUniqueOrThrow({ where: { id: pending.id } }),
        ).toMatchObject({
          requestedModelPoolId: null,
          selectedExecutionTargetId: null,
          selectedDiscoveredModelId: null,
          selectedPoolMemberId: null,
          status: "PENDING",
        });
        expect(await db.relayRequest.findUniqueOrThrow({ where: { id: ownRow.id } })).toMatchObject(
          {
            requestedModelPoolId: null,
            selectedExecutionTargetId: ownTarget.id,
          },
        );
      } finally {
        await db.$disconnect();
      }
    },
  );
});
