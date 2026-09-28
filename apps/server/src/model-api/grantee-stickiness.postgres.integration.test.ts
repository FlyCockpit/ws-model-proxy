import type { VisibleModelPoolTarget } from "@ws-model-proxy/api/lib/model-api-token-access";
import { createPrismaClient } from "@ws-model-proxy/db/client-factory";
import { describe, expect, it, vi } from "vitest";
import type { ActiveRelayResponseHandlers } from "../relay/session-manager.js";

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
    const db = createPrismaClient(databaseUrl);
    const suffix = crypto.randomUUID();
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
      await db.responseStickinessRecord.delete({ where: { id: ownerBinding.id } });

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
      const { reconcileStaleLocalRelayTelemetry } = await import("./relay-telemetry-recovery.js");
      const { prepareParentDeletion } = await import("@ws-model-proxy/db/parent-deletion");
      const { lockCapacityGraphForDelete, runCapacityOrderedTransaction } = await import(
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
        await vi.waitFor(() => expect(sent).toHaveBeenCalledOnce());
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
      await vi.waitFor(async () =>
        expect(
          await db.responseStickinessRecord.findFirst({
            where: { userId: grantee.id, routingVersion: 2, NOT: { id: accepted.id } },
          }),
        ).toMatchObject({
          targetModelPoolId: pool.id,
          poolGrantId: grant.id,
          selectedExecutionTargetId: expect.any(String),
        }),
      );

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
        await vi.waitFor(async () =>
          expect(
            await db.responseStickinessRecord.count({
              where: { userId: grantee.id, poolGrantId: grant.id },
            }),
          ).toBe(index + 3),
        );
      }

      // 3. Revoking the grant removes every binding it created; the follow-up
      //    is then refused without reaching a member.
      await db.poolGrant.delete({ where: { id: grant.id } });
      expect(
        await db.responseStickinessRecord.count({
          where: { userId: grantee.id, targetModelPoolId: pool.id },
        }),
      ).toBe(0);
      const replacement = await db.poolGrant.create({
        data: { poolId: pool.id, ownerUserId: owner.id, granteeUserId: grantee.id },
      });
      visiblePool.accessGrantId = replacement.id;
      const revoked = await responses({ previous_response_id: "resp_grantee_3", input: "x" });
      expect(revoked.status).toBe(404);
      await revoked.text();
      expect(sent).not.toHaveBeenCalled();

      // 4. P3C-2: a grantee request in flight when its pool is deleted.
      const chat = () =>
        chatTestCompletionsHandler({
          request: new Request("https://proxy.example.test/chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model: "owner/shared",
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
        requestedModelPoolId: pool.id,
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
          requestedModelPoolId: pool.id,
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
          requestedModelPoolId: pool.id,
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

      // The production delete path: drain (terminal rows only), then the
      // ordered final delete whose SET NULL cascade detaches the PENDING rows.
      await prepareParentDeletion(db, { userId: owner.id, poolIds: [pool.id] });
      await runCapacityOrderedTransaction(db, async (tx) => {
        await lockCapacityGraphForDelete(tx, { userId: owner.id, poolIds: [pool.id] });
        await tx.modelPool.delete({ where: { id: pool.id } });
      });
      expect(
        await db.relayRequest.findUniqueOrThrow({ where: { id: inflight.relayRequestId } }),
      ).toMatchObject({
        requestedModelPoolId: null,
        resourceOwnerUserId: owner.id,
        selectedExecutionTargetId: null,
        selectedPoolMemberId: null,
        status: "PENDING",
      });

      // The late finalizer re-writes the owner's selection; it must commit
      // its status and counters (without persisting that selection).
      const warn = vi.spyOn(console, "warn");
      finishResponse(inflight.attemptId, JSON.stringify({ model: "member-model" }));
      await inflightResponse.text();
      await vi.waitFor(async () =>
        expect(
          await db.relayRequest.findUniqueOrThrow({ where: { id: inflight.relayRequestId } }),
        ).toMatchObject({
          status: "SUCCEEDED",
          requestedModelPoolId: null,
          resourceOwnerUserId: owner.id,
          selectedExecutionTargetId: null,
          selectedDiscoveredModelId: null,
          selectedPoolMemberId: null,
        }),
      );
      expect(warn).not.toHaveBeenCalledWith("[model-api] relay metadata update failed");
      warn.mockRestore();
      // Once terminal, the orphaned grantee row accepts no selection: neither
      // the pool owner's target nor a third party's.
      for (const target of [memberA.target.id, foreign.target.id])
        await expect(
          db.relayRequest.update({
            where: { id: inflight.relayRequestId },
            data: { selectedExecutionTargetId: target },
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
        requestedModelPoolId: null,
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
      expect(byOwner(owner.id)).toMatchObject({ successes: 4, errors: 1 });
      expect(
        rollups.find((row) => row.ownerUserId === owner.id && row.poolId === "")?.successes,
      ).toBe(1);
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
      expect(await db.relayRequest.findUniqueOrThrow({ where: { id: late.id } })).toMatchObject({
        requestedModelPoolId: null,
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
    } finally {
      await db.user.deleteMany({
        where: { id: { in: [owner.id, grantee.id, stranger.id, secondGrantee.id] } },
      });
      await db.$disconnect();
    }
  }, 60_000);
});
