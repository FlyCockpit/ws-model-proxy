import type { VisibleModelPoolTarget } from "@ws-model-proxy/api/lib/model-api-token-access";
// Fixture writes need no owner fences (the graph-write fence triggers accept
// this client); production code under test uses its own clients.
import { createFixturePrismaClient } from "@ws-model-proxy/db/test-fixture-client";
import { describe, expect, it, vi } from "vitest";
import type { ActiveRelayResponseHandlers } from "../relay/session-manager.js";
import type { StoreCapacityAdmissionRuntime } from "./capacity/runtime.js";

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("PostgreSQL integration requires SCHEMA_VALIDATION_DATABASE_URL");
const integration = databaseUrl ? describe : describe.skip;

const localCapabilities = {
  version: 1,
  protocol: "openai-compatible",
  chatCompletions: { supported: true, streaming: true },
  responses: {
    supported: true,
    streaming: true,
    statefulFollowUps: true,
    retrieve: true,
    delete: true,
    cancel: true,
    listInputItems: true,
    countTokens: true,
    compact: true,
  },
};

integration("grantee local Responses stickiness and owner attribution (#66)", () => {
  it("binds grantee follow-ups to the served member through the exact grant, and attributes a request whose pool was deleted in flight to the owner", async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    const db = createFixturePrismaClient(databaseUrl);
    const suffix = crypto.randomUUID();
    let runtime: StoreCapacityAdmissionRuntime | undefined;
    const user = (label: string) =>
      db.user.create({ data: { name: label, email: `${label}-${suffix}@example.test` } });
    const owner = await user("stick-owner");
    const grantee = await user("stick-grantee");
    const stranger = await user("stick-stranger");
    const secondGrantee = await user("stick-grantee-2");
    try {
      const pool = await db.modelPool.create({
        data: { userId: owner.id, name: "Shared", slug: `shared-${suffix}` },
      });
      const otherPool = await db.modelPool.create({
        data: { userId: owner.id, name: "Other", slug: `other-${suffix}` },
      });
      const grant = await db.poolGrant.create({
        data: { poolId: pool.id, ownerUserId: owner.id, granteeUserId: grantee.id },
      });
      const otherGrant = await db.poolGrant.create({
        data: { poolId: otherPool.id, ownerUserId: owner.id, granteeUserId: grantee.id },
      });
      const secondGrant = await db.poolGrant.create({
        data: { poolId: pool.id, ownerUserId: owner.id, granteeUserId: secondGrantee.id },
      });
      const localModel = async (userId: string, label: string) => {
        const cli = await db.cliDevice.create({
          data: { userId, slug: `${label}-${suffix}`, status: "CONNECTED" },
        });
        const endpoint = await db.endpoint.create({
          data: {
            userId,
            cliDeviceId: cli.id,
            slug: `${label}-${suffix}`,
            label,
            status: "ONLINE",
            capabilityMetadata: localCapabilities,
          },
        });
        const model = await db.discoveredModel.create({
          data: {
            userId,
            endpointId: endpoint.id,
            upstreamModelId: `${label}-model`,
            encodedModelId: `${label}-model`,
          },
        });
        const target = await db.executionTarget.findUniqueOrThrow({
          where: { discoveredModelId: model.id },
        });
        return { cli, model, target };
      };
      const memberA = await localModel(owner.id, "member-a");
      const memberB = await localModel(owner.id, "member-b");
      const outsider = await localModel(owner.id, "outsider");
      const foreign = await localModel(stranger.id, "foreign");
      const poolMembers = new Map<string, string>();
      for (const local of [memberA, memberB]) {
        const member = await db.poolMember.create({
          data: { poolId: pool.id, executionTargetId: local.target.id, healthStatus: "HEALTHY" },
        });
        poolMembers.set(local.cli.id, member.id);
      }

      // Database rule for local (v2) bindings: the pool owner's graph through
      // the owner or the exact grant; direct bindings stay with the requester.
      const binding = (data: Record<string, unknown>) =>
        db.responseStickinessRecord.create({
          data: {
            userId: grantee.id,
            routingKeyDigest: `db-rule-${crypto.randomUUID()}`,
            routingVersion: 2,
            targetModelPoolId: pool.id,
            poolGrantId: grant.id,
            selectedExecutionTargetId: memberA.target.id,
            expiresAt: new Date(Date.now() + 60_000),
            ...data,
          },
        });
      const accepted = await binding({});
      expect(accepted).toMatchObject({
        selectedDiscoveredModelId: memberA.model.id,
        poolGrantId: grant.id,
      });
      await expect(binding({ poolGrantId: null })).rejects.toThrow(
        /stickiness pool binding requires the pool owner or the exact grant/,
      );
      await expect(binding({ poolGrantId: otherGrant.id })).rejects.toThrow(
        /stickiness pool binding requires the pool owner or the exact grant/,
      );
      await expect(binding({ userId: owner.id })).rejects.toThrow(
        /stickiness pool binding requires the pool owner or the exact grant/,
      );
      // Another grantee's grant on the same pool is not the requester's grant.
      await expect(binding({ poolGrantId: secondGrant.id })).rejects.toThrow(
        /stickiness pool binding requires the pool owner or the exact grant/,
      );
      await expect(binding({ userId: secondGrantee.id })).rejects.toThrow(
        /stickiness pool binding requires the pool owner or the exact grant/,
      );
      // A live grantee binding cannot be re-homed to another requester, with
      // or without a grant of their own on the pool.
      for (const userId of [stranger.id, secondGrantee.id])
        await expect(
          db.responseStickinessRecord.update({ where: { id: accepted.id }, data: { userId } }),
        ).rejects.toThrow(/stickiness pool binding requires the pool owner or the exact grant/);
      // A foreign target without a pool (or grant) is still rejected.
      await expect(binding({ targetModelPoolId: null, poolGrantId: null })).rejects.toThrow(
        /stickiness selection must match its owner and discovered model/,
      );
      await expect(binding({ selectedExecutionTargetId: foreign.target.id })).rejects.toThrow(
        /stickiness selection must match its owner and discovered model/,
      );
      await expect(
        binding({ targetModelPoolId: null, selectedExecutionTargetId: foreign.target.id }),
      ).rejects.toThrow(/stickiness pool binding requires the pool owner or the exact grant/);
      // Identity changes on a live binding are always re-checked: another
      // grantee's grant, the grantee's grant on another pool, another pool,
      // or a foreign direct target.
      for (const data of [
        { poolGrantId: secondGrant.id },
        { poolGrantId: otherGrant.id },
        { targetModelPoolId: otherPool.id },
      ])
        await expect(
          db.responseStickinessRecord.update({ where: { id: accepted.id }, data }),
        ).rejects.toThrow(/stickiness pool binding requires the pool owner or the exact grant/);
      await expect(
        db.responseStickinessRecord.update({
          where: { id: accepted.id },
          data: { targetExecutionTargetId: foreign.target.id },
        }),
      ).rejects.toThrow(/stickiness binding targets either a pool or a direct model/);
      await expect(
        db.responseStickinessRecord.update({
          where: { id: accepted.id },
          data: {
            targetModelPoolId: null,
            poolGrantId: null,
            targetExecutionTargetId: foreign.target.id,
          },
        }),
      ).rejects.toThrow(/stickiness target must match its owner and discovered model/);
      // Setting a target and clearing its paired column in one statement
      // (which bypasses canonicalization) is re-checked too.
      const direct = await binding({
        userId: owner.id,
        targetModelPoolId: null,
        poolGrantId: null,
        targetExecutionTargetId: memberA.target.id,
      });
      await expect(
        db.responseStickinessRecord.update({
          where: { id: direct.id },
          data: { targetExecutionTargetId: foreign.target.id, targetDiscoveredModelId: null },
        }),
      ).rejects.toThrow(/stickiness target must match its owner and discovered model/);
      await db.responseStickinessRecord.delete({ where: { id: direct.id } });
      await expect(
        db.responseStickinessRecord.update({
          where: { id: accepted.id },
          data: { selectedExecutionTargetId: foreign.target.id, selectedDiscoveredModelId: null },
        }),
      ).rejects.toThrow(/stickiness selection must match its owner and discovered model/);
      // A pool binding never also names a direct target (routing would take
      // the direct branch and skip the pool's checks).
      await expect(
        binding({
          userId: owner.id,
          poolGrantId: null,
          targetExecutionTargetId: memberA.target.id,
        }),
      ).rejects.toThrow(/stickiness binding targets either a pool or a direct model/);
      // The owner's target must be a local member of the pool when written.
      await expect(binding({ selectedExecutionTargetId: outsider.target.id })).rejects.toThrow(
        /stickiness selection must be a local member of its pool/,
      );
      await expect(
        db.responseStickinessRecord.update({
          where: { id: accepted.id },
          data: { selectedExecutionTargetId: outsider.target.id, selectedDiscoveredModelId: null },
        }),
      ).rejects.toThrow(/stickiness selection must be a local member of its pool/);
      // The owner binds without a grant.
      const ownerBinding = await binding({
        userId: owner.id,
        poolGrantId: null,
        selectedExecutionTargetId: memberB.target.id,
      });
      // Membership is checked when a selection is written, not re-checked on
      // UPDATEs that keep it (cascades, the deletion drain): after the member
      // is removed, such updates still succeed, while selecting that target
      // anew fails. The application's writer is INSERT ... ON CONFLICT, whose
      // BEFORE INSERT check runs in full, so it re-checks membership too.
      await db.poolMember.delete({ where: { id: poolMembers.get(memberB.cli.id)! } });
      await db.responseStickinessRecord.update({
        where: { id: ownerBinding.id },
        data: {
          routingVersion: 2,
          targetModelPoolId: pool.id,
          poolGrantId: null,
          selectedExecutionTargetId: memberB.target.id,
        },
      });
      await db.responseStickinessRecord.update({
        where: { id: ownerBinding.id },
        data: { routingVersion: 1 },
      });
      await expect(
        db.responseStickinessRecord.upsert({
          where: {
            userId_routingKeyDigest: {
              userId: owner.id,
              routingKeyDigest: ownerBinding.routingKeyDigest,
            },
          },
          create: {
            userId: owner.id,
            routingKeyDigest: ownerBinding.routingKeyDigest,
            routingVersion: 2,
            targetModelPoolId: pool.id,
            selectedExecutionTargetId: memberB.target.id,
            expiresAt: new Date(Date.now() + 60_000),
          },
          update: { routingVersion: 2, selectedExecutionTargetId: memberB.target.id },
        }),
      ).rejects.toThrow(/stickiness selection must be a local member of its pool/);
      await expect(
        binding({
          userId: owner.id,
          poolGrantId: null,
          selectedExecutionTargetId: memberB.target.id,
        }),
      ).rejects.toThrow(/stickiness selection must be a local member of its pool/);
      await db.responseStickinessRecord.delete({ where: { id: ownerBinding.id } });
      const readdedB = await db.poolMember.create({
        data: { poolId: pool.id, executionTargetId: memberB.target.id, healthStatus: "HEALTHY" },
      });
      poolMembers.set(memberB.cli.id, readdedB.id);

      vi.doMock("@ws-model-proxy/db", async () => {
        const actual =
          await vi.importActual<typeof import("@ws-model-proxy/db")>("@ws-model-proxy/db");
        return { ...actual, default: db };
      });
      vi.doMock("@ws-model-proxy/env/server", () => ({
        env: {
          NODE_ENV: "test",
          BETTER_AUTH_SECRET: "grantee-stickiness-postgres-test-secret",
          WMP_PUBLIC_PROVIDER_EGRESS_ENABLED: false,
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
        accessGrantId: grant.id,
        poolSlug: pool.slug,
        maxAttachmentBytes: null,
        optimisticBasicTranscription: false,
        protocolAdaptationEnabled: false,
        fallbackEnabled: false,
        fallbackForGrantees: false,
        externalMemberCount: 0,
        effectiveProviderEgress: false,
        externalRoutes: [],
        providerAccountLabels: [],
        providerTypes: [],
        allowLossyDeveloperRoleCollapse: false,
        recommendedSurfaceOverride: null,
      };
      let visiblePools: VisibleModelPoolTarget[] = [visiblePool];
      vi.doMock("@ws-model-proxy/api/lib/model-api-token-access", async () => {
        const actual = await vi.importActual<
          typeof import("@ws-model-proxy/api/lib/model-api-token-access")
        >("@ws-model-proxy/api/lib/model-api-token-access");
        return {
          ...actual,
          // CHAT_TEST avoids a synthetic token FK in real relay_request rows.
          listVisibleModelTargetsForUser: async () => ({
            directModels: [],
            modelPools: visiblePools,
          }),
        };
      });
      const { chatTestCompletionsHandler, responsesCreateHandler } = await import("./routes.js");
      const { ModelApiConcurrencyLimiter } = await import("./limits.js");
      const { RelaySessionManager } = await import("../relay/session-manager.js");
      const { PostgresCapacityAdmissionStore } = await import("./capacity/postgres-store.js");
      const { StoreCapacityAdmissionRuntime } = await import("./capacity/runtime.js");
      // The production admission runtime: pool follow-ups must name their pool.
      const capacityRuntime = new StoreCapacityAdmissionRuntime(
        new PostgresCapacityAdmissionStore(db, `grantee-stickiness-${suffix}`),
      );
      runtime = capacityRuntime;
      const { reconcileStaleLocalRelayTelemetry } = await import("./relay-telemetry-recovery.js");
      const { prepareParentDeletion } = await import("@ws-model-proxy/db/parent-deletion");
      const { fenceParentDelete, runCapacityOrderedTransaction } = await import(
        "@ws-model-proxy/db/capacity-lock-order"
      );

      const manager = new RelaySessionManager();
      vi.spyOn(manager, "getActiveCliDeviceIds").mockReturnValue([memberA.cli.id, memberB.cli.id]);
      const handlers = new Map<string, ActiveRelayResponseHandlers>();
      vi.spyOn(manager, "registerRelayResponseHandlers").mockImplementation((input) => {
        handlers.set(input.requestId, input.handlers);
      });
      const sent = vi.spyOn(manager, "sendRelayRequest").mockImplementation(() => undefined);
      vi.spyOn(manager, "cancelRelayRequest").mockImplementation(() => undefined);
      const limiter = new ModelApiConcurrencyLimiter();
      const startResponse = (attemptId: string) =>
        handlers.get(attemptId)!.onHeaders({
          type: "relay.response.headers",
          requestId: attemptId,
          status: 200,
          headers: { "content-type": "application/json" },
        });
      const finishResponse = (attemptId: string, body: string) => {
        const handler = handlers.get(attemptId)!;
        handler.onBody(new TextEncoder().encode(body), {
          type: "relay.response.body",
          requestId: attemptId,
          chunkId: "0",
        });
        handler.onComplete({ type: "relay.complete", requestId: attemptId });
      };
      const serve = (attemptId: string, body: string) => {
        startResponse(attemptId);
        finishResponse(attemptId, body);
      };
      const nextSend = async () => {
        await vi.waitFor(() => expect(sent).toHaveBeenCalledOnce(), { timeout: 10_000 });
        const call = sent.mock.calls[0]![0];
        sent.mockClear();
        const attempt = await db.relayExecutionAttempt.findUniqueOrThrow({
          where: { attemptId: call.requestId },
        });
        return { attemptId: call.requestId, relayRequestId: attempt.relayRequestId };
      };
      const responses = (body: Record<string, unknown>) =>
        responsesCreateHandler({
          request: new Request("https://proxy.example.test/responses", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "owner/shared", ...body }),
          }),
          manager,
          limiter,
          chatTestUserId: grantee.id,
          capacityRuntime,
        });
      const servedMember = async (relayRequestId: string) =>
        (await db.relayRequest.findUniqueOrThrow({ where: { id: relayRequestId } }))
          .selectedPoolMemberId;

      // 1. A grantee's locally served Responses create writes its binding.
      const createPromise = responses({ input: "first" });
      const created = await nextSend();
      const firstMember = await servedMember(created.relayRequestId);
      expect([...poolMembers.values()]).toContain(firstMember);
      serve(created.attemptId, JSON.stringify({ id: "resp_grantee_1", object: "response" }));
      const createResponse = await createPromise;
      expect(createResponse.status).toBe(200);
      await createResponse.text();
      // The binding exists once the response is read (the EOF-before-durable
      // ordering itself is pinned by the routes unit tests).
      expect(
        await db.responseStickinessRecord.findFirst({
          where: { userId: grantee.id, routingVersion: 2, NOT: { id: accepted.id } },
        }),
      ).toMatchObject({
        targetModelPoolId: pool.id,
        poolGrantId: grant.id,
        selectedExecutionTargetId: expect.any(String),
      });

      // 2. Its follow-ups stick to the member (and backend) that stored it.
      for (const [index, previous] of ["resp_grantee_1", "resp_grantee_2"].entries()) {
        const followPromise = responses({ previous_response_id: previous, input: "next" });
        const follow = await nextSend();
        expect(await servedMember(follow.relayRequestId)).toBe(firstMember);
        serve(
          follow.attemptId,
          JSON.stringify({ id: `resp_grantee_${index + 2}`, object: "response" }),
        );
        const followResponse = await followPromise;
        expect(followResponse.status).toBe(200);
        expect(followResponse.headers.get("x-wsmp-route")).toBe("local");
        await followResponse.text();
        await vi.waitFor(async () =>
          expect(
            await db.relayRequest.findUniqueOrThrow({ where: { id: follow.relayRequestId } }),
          ).toMatchObject({ status: "SUCCEEDED", resourceOwnerUserId: owner.id }),
        );
        expect(
          await db.responseStickinessRecord.count({
            where: { userId: grantee.id, poolGrantId: grant.id },
          }),
        ).toBe(index + 3);
      }

      // 3. Revoking the grant leaves its bindings as hot-path history naming
      //    the revoked grant (DL-1 (d): no foreign key, no cascade). A
      //    follow-up resolved before the revoke and admitted after it is
      //    refused at the send boundary (exact-grant re-check), without
      //    reaching a member.
      const acquire = capacityRuntime.acquire.bind(capacityRuntime);
      vi.spyOn(capacityRuntime, "acquire").mockImplementationOnce(async (attempt, signal) => {
        const admitted = await acquire(attempt, signal);
        expect(admitted.state).toBe("ADMITTED");
        await db.poolGrant.delete({ where: { id: grant.id } });
        return admitted;
      });
      const revokedInFlight = await responses({
        previous_response_id: "resp_grantee_3",
        input: "during admission",
      });
      expect(revokedInFlight.status).toBe(404);
      await revokedInFlight.text();
      expect(sent).not.toHaveBeenCalled();
      expect(
        await db.responseStickinessRecord.count({
          where: { userId: grantee.id, targetModelPoolId: pool.id, poolGrantId: { not: grant.id } },
        }),
      ).toBe(0);
      const replacement = await db.poolGrant.create({
        data: { poolId: pool.id, ownerUserId: owner.id, granteeUserId: grantee.id },
      });
      visiblePool.accessGrantId = replacement.id;
      const revoked = await responses({ previous_response_id: "resp_grantee_3", input: "x" });
      // access_denied: the binding survives its revoked grant as history and
      // is no longer reachable through the replacement grant.
      expect(revoked.status).toBe(401);
      await revoked.text();
      expect(sent).not.toHaveBeenCalled();

      // 4. P3C-2: a grantee request in flight when its pool is deleted (a
      //    fresh pool; under DL-1 (d) lease history would not block it either).
      const inflightPool = await db.modelPool.create({
        data: { userId: owner.id, name: "Inflight", slug: `inflight-${suffix}` },
      });
      const inflightGrant = await db.poolGrant.create({
        data: { poolId: inflightPool.id, ownerUserId: owner.id, granteeUserId: grantee.id },
      });
      for (const local of [memberA, memberB])
        await db.poolMember.create({
          data: {
            poolId: inflightPool.id,
            executionTargetId: local.target.id,
            healthStatus: "HEALTHY",
          },
        });
      visiblePools = [
        {
          ...visiblePool,
          id: inflightPool.id,
          modelId: "owner/inflight",
          name: inflightPool.name,
          poolSlug: inflightPool.slug,
          accessGrantId: inflightGrant.id,
        },
      ];
      const chat = () =>
        chatTestCompletionsHandler({
          request: new Request("https://proxy.example.test/chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model: "owner/inflight",
              messages: [{ role: "user", content: "test" }],
            }),
          }),
          userId: grantee.id,
          manager,
          limiter,
        });
      const inflightPromise = chat();
      const inflight = await nextSend();
      // Headers reach the client; the body and terminal come after the delete.
      startResponse(inflight.attemptId);
      const inflightResponse = await inflightPromise;
      expect(inflightResponse.status).toBe(200);
      const pending = await db.relayRequest.findUniqueOrThrow({
        where: { id: inflight.relayRequestId },
      });
      expect(pending).toMatchObject({
        userId: grantee.id,
        requestedModelPoolId: inflightPool.id,
        resourceOwnerUserId: owner.id,
        status: "PENDING",
        selectedPoolMemberId: expect.any(String),
        selectedExecutionTargetId: expect.any(String),
      });
      // A crash-recovery candidate on the same pool: its process is gone.
      const orphan = await db.relayRequest.create({
        data: {
          userId: grantee.id,
          source: "CHAT_TEST",
          requestedModelPoolId: inflightPool.id,
          fallbackRoute: "local",
          status: "PENDING",
        },
      });
      expect(orphan.resourceOwnerUserId).toBe(owner.id);
      await db.relayExecutionAttempt.create({
        data: {
          attemptId: `orphan-${suffix}`,
          userId: grantee.id,
          relayRequestId: orphan.id,
          ownerEpoch: "dead-process-epoch",
          heartbeatAt: new Date(Date.now() - 600_000),
          expiresAt: new Date(Date.now() - 300_000),
          requestedSurface: "OPENAI_CHAT_COMPLETIONS",
        },
      });
      // Own-key traffic on the same pool keeps requester attribution.
      const ownKey = await db.relayRequest.create({
        data: {
          userId: grantee.id,
          source: "CHAT_TEST",
          requestedModelPoolId: inflightPool.id,
          fallbackRoute: "own-key",
          status: "PENDING",
        },
      });
      // A writer cannot forge the attribution.
      await db.relayRequest.update({
        where: { id: ownKey.id },
        data: { resourceOwnerUserId: stranger.id },
      });
      expect(
        (await db.relayRequest.findUniqueOrThrow({ where: { id: ownKey.id } })).resourceOwnerUserId,
      ).toBe(owner.id);

      // The production delete path (DL-1 (d)): nothing to drain for a pool,
      // and the final delete touches no hot-path row. The in-flight request
      // keeps its (now dangling) pool and selection ids and its owner.
      expect(
        await prepareParentDeletion(db, { userId: owner.id, poolIds: [inflightPool.id] }),
      ).toEqual({});
      await runCapacityOrderedTransaction(db, async (tx) => {
        await fenceParentDelete(tx, { userId: owner.id, poolIds: [inflightPool.id] });
        await tx.modelPool.delete({ where: { id: inflightPool.id } });
      });
      expect(
        await db.relayRequest.findUniqueOrThrow({ where: { id: inflight.relayRequestId } }),
      ).toMatchObject({
        requestedModelPoolId: inflightPool.id,
        resourceOwnerUserId: owner.id,
        selectedExecutionTargetId: pending.selectedExecutionTargetId,
        selectedPoolMemberId: pending.selectedPoolMemberId,
        status: "PENDING",
      });

      // The late finalizer commits its status and counters on the orphaned row.
      const warn = vi.spyOn(console, "warn");
      finishResponse(inflight.attemptId, JSON.stringify({ model: "member-model" }));
      await inflightResponse.text();
      await vi.waitFor(async () =>
        expect(
          await db.relayRequest.findUniqueOrThrow({ where: { id: inflight.relayRequestId } }),
        ).toMatchObject({
          status: "SUCCEEDED",
          requestedModelPoolId: inflightPool.id,
          resourceOwnerUserId: owner.id,
        }),
      );
      expect(warn).not.toHaveBeenCalledWith("[model-api] relay metadata update failed");
      warn.mockRestore();
      // The orphaned grantee row still accepts no third party's target: the
      // durable resource owner stands in for the deleted pool's owner.
      await expect(
        db.relayRequest.update({
          where: { id: inflight.relayRequestId },
          data: { selectedExecutionTargetId: foreign.target.id },
        }),
      ).rejects.toThrow(/relay request selection must match its owner and discovered model/);

      // A PENDING orphan still rejects a third party's target.
      await expect(
        db.relayRequest.update({
          where: { id: orphan.id },
          data: { selectedExecutionTargetId: foreign.target.id },
        }),
      ).rejects.toThrow(/relay request selection must match its owner and discovered model/);
      // Crash recovery attributes the orphaned request to the owner too.
      await reconcileStaleLocalRelayTelemetry();
      expect(await db.relayRequest.findUniqueOrThrow({ where: { id: orphan.id } })).toMatchObject({
        status: "FAILED",
        requestedModelPoolId: inflightPool.id,
        resourceOwnerUserId: owner.id,
      });
      await db.$transaction(async (tx) => {
        const { transitionRelayRequestTerminal } = await import("./usage-rollup.js");
        expect(
          await transitionRelayRequestTerminal(tx, ownKey.id, {
            status: "SUCCEEDED",
            completedAt: new Date(),
          }),
        ).toBe(true);
      });

      const rollups = await db.usageRollupMinute.findMany({
        where: { requesterUserId: grantee.id, source: "CHAT_TEST" },
      });
      const byOwner = (ownerUserId: string) =>
        rollups
          .filter((row) => row.ownerUserId === ownerUserId)
          .reduce(
            (sum, row) => ({
              requests: sum.requests + row.requests,
              successes: sum.successes + row.successes,
              errors: sum.errors + row.errors,
            }),
            { requests: 0, successes: 0, errors: 0 },
          );
      // Pool deleted in flight (success) and crash-recovered (failure): owner.
      // Responses traffic before the delete also belongs to the owner.
      // The follow-up refused at the send boundary is a failure on the owner.
      expect(byOwner(owner.id)).toMatchObject({ successes: 4, errors: 2 });
      // DL-1 (d): the requests keep the deleted pool's id, so every owner row
      // (before and after the delete) is keyed by it; none falls back to "".
      expect(rollups.filter((row) => row.ownerUserId === owner.id && row.poolId === "")).toEqual(
        [],
      );
      // Own-key: the requester.
      expect(byOwner(grantee.id)).toEqual({ requests: 1, successes: 1, errors: 0 });

      // A request whose owner was deleted meanwhile keeps a dangling durable
      // owner (not a foreign key): it still finalizes, and its increment is
      // skipped with the rest of that owner's history.
      const lateOwner = await user("late-owner");
      const latePool = await db.modelPool.create({
        data: { userId: lateOwner.id, name: "Late", slug: `late-${suffix}` },
      });
      const late = await db.relayRequest.create({
        data: {
          userId: grantee.id,
          source: "CHAT_TEST",
          requestedModelPoolId: latePool.id,
          status: "PENDING",
        },
      });
      await db.user.delete({ where: { id: lateOwner.id } });
      // DL-1 (d): nothing cascades into the request; it keeps both ids.
      expect(await db.relayRequest.findUniqueOrThrow({ where: { id: late.id } })).toMatchObject({
        requestedModelPoolId: latePool.id,
        resourceOwnerUserId: lateOwner.id,
      });
      await db.$transaction(async (tx) => {
        const { transitionRelayRequestTerminal } = await import("./usage-rollup.js");
        expect(
          await transitionRelayRequestTerminal(tx, late.id, {
            status: "SUCCEEDED",
            completedAt: new Date(),
          }),
        ).toBe(true);
      });
      expect(await db.usageRollupMinute.count({ where: { ownerUserId: lateOwner.id } })).toBe(0);
      // No live admission state leaks from this test's capacities (checked
      // before the runtime is closed, which would release any leak).
      await vi.waitFor(async () =>
        expect(
          await db.capacityLease.count({
            where: {
              state: "ACTIVE",
              executionTargetId: { in: [memberA.target.id, memberB.target.id] },
            },
          }),
        ).toBe(0),
      );
    } finally {
      await runtime?.close();
      // Capacity lease rows keep immutable target history through RESTRICT
      // foreign keys, so these users stay in the disposable validation
      // database (as in the capacity PG suites).
      await db.$disconnect();
    }
  }, 60_000);

  it("deletes a pool owner's account while a grantee binding and an in-flight grantee request remain", async () => {
    if (!databaseUrl) return;
    const db = createFixturePrismaClient(databaseUrl);
    const suffix = crypto.randomUUID();
    const user = (label: string) =>
      db.user.create({ data: { name: label, email: `${label}-${suffix}@example.test` } });
    const owner = await user("delete-owner");
    const grantee = await user("delete-grantee");
    try {
      const { requestUserDeletion, prepareParentDeletion } = await import(
        "@ws-model-proxy/db/parent-deletion"
      );
      const { deleteUserUnderOwnerFences } = await import("@ws-model-proxy/db/capacity-lock-order");
      const pool = await db.modelPool.create({
        data: { userId: owner.id, name: "Doomed", slug: `doomed-${suffix}` },
      });
      const grant = await db.poolGrant.create({
        data: { poolId: pool.id, ownerUserId: owner.id, granteeUserId: grantee.id },
      });
      const cli = await db.cliDevice.create({
        data: { userId: owner.id, slug: `doomed-${suffix}`, status: "CONNECTED" },
      });
      const endpoint = await db.endpoint.create({
        data: {
          userId: owner.id,
          cliDeviceId: cli.id,
          slug: `doomed-${suffix}`,
          label: "doomed",
          status: "ONLINE",
          capabilityMetadata: localCapabilities,
        },
      });
      const model = await db.discoveredModel.create({
        data: {
          userId: owner.id,
          endpointId: endpoint.id,
          upstreamModelId: "doomed-model",
          encodedModelId: "doomed-model",
        },
      });
      const target = await db.executionTarget.findUniqueOrThrow({
        where: { discoveredModelId: model.id },
      });
      const member = await db.poolMember.create({
        data: { poolId: pool.id, executionTargetId: target.id, healthStatus: "HEALTHY" },
      });
      // A grantee request in flight, served by the owner's member.
      const inflight = await db.relayRequest.create({
        data: {
          userId: grantee.id,
          source: "CHAT_TEST",
          requestedModelPoolId: pool.id,
          fallbackRoute: "local",
          status: "PENDING",
          selectedDiscoveredModelId: model.id,
          selectedExecutionTargetId: target.id,
          selectedPoolMemberId: member.id,
        },
      });
      expect(inflight.resourceOwnerUserId).toBe(owner.id);

      // The production whole-account deletion: mark, drain, final delete. A
      // grantee binding committed after the drain is hot-path history (DL-1
      // (d)): the final delete does not reach it; it stays behind naming the
      // deleted grant and pool, never served again, until it expires.
      const mark = await requestUserDeletion(db, owner.id);
      if (!mark) throw new Error("deletion mark was not taken");
      await prepareParentDeletion(
        db,
        { userId: owner.id, wholeUser: true },
        { owner: { userId: owner.id, generation: mark.generation } },
      );
      await db.responseStickinessRecord.create({
        data: {
          userId: grantee.id,
          routingKeyDigest: `late-${suffix}`,
          routingVersion: 2,
          targetModelPoolId: pool.id,
          poolGrantId: grant.id,
          selectedExecutionTargetId: target.id,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      expect(await deleteUserUnderOwnerFences(db, owner.id, mark.generation)).toBe(true);
      expect(await db.user.count({ where: { id: owner.id } })).toBe(0);
      expect(await db.poolGrant.count({ where: { id: grant.id } })).toBe(0);
      expect(
        await db.responseStickinessRecord.findMany({
          where: { userId: grantee.id },
          select: { poolGrantId: true, targetModelPoolId: true },
        }),
      ).toEqual([{ poolGrantId: grant.id, targetModelPoolId: pool.id }]);

      // The late finalizer re-writes the owner's (now deleted) selection: the
      // status commits with the durable owner kept. The ids stay as dangling
      // history (no live parent to check them against); readers show a
      // deleted owner's identities to nobody else.
      await db.relayRequest.update({
        where: { id: inflight.id },
        data: {
          status: "SUCCEEDED",
          completedAt: new Date(),
          selectedDiscoveredModelId: model.id,
          selectedExecutionTargetId: target.id,
          selectedPoolMemberId: member.id,
        },
      });
      expect(await db.relayRequest.findUniqueOrThrow({ where: { id: inflight.id } })).toMatchObject(
        {
          status: "SUCCEEDED",
          requestedModelPoolId: pool.id,
          resourceOwnerUserId: owner.id,
        },
      );
    } finally {
      await db.user.deleteMany({ where: { id: { in: [owner.id, grantee.id] } } });
      await db.$disconnect();
    }
  }, 60_000);
});
