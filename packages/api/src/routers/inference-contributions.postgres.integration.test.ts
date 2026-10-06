import { randomUUID } from "node:crypto";
import { createRouterClient } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import { DEPLOYMENT_PROTOCOL_VERSION } from "@ws-model-proxy/config/deployment-protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Context } from "../context";

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("PostgreSQL fixture required");
const integration = databaseUrl ? describe : describe.skip;
type Client = ReturnType<typeof import("@ws-model-proxy/db/client-factory").createPrismaClient>;

integration("two-party inference contributions on PostgreSQL", () => {
  let fixture: Client;
  let strict: Client;
  let module: typeof import("./inference-contributions");
  let order: typeof import("@ws-model-proxy/db/capacity-lock-order");
  const users: string[] = [];
  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    process.env.NODE_ENV = "test";
    process.env.BETTER_AUTH_SECRET = "release-fixture-auth-secret-not-production";
    process.env.BETTER_AUTH_URL = "http://localhost:3000";
    const factory = await import("@ws-model-proxy/db/client-factory");
    const fixtureFactory = await import("@ws-model-proxy/db/test-fixture-client");
    fixture = fixtureFactory.createFixturePrismaClient(databaseUrl);
    strict = factory.createPrismaClient(databaseUrl);
    module = await import("./inference-contributions");
    order = await import("@ws-model-proxy/db/capacity-lock-order");
  });
  afterAll(async () => {
    await fixture.deploymentInstanceNode.updateMany({
      where: { Instance: { userId: { in: users } } },
      data: { claimHeld: false, stoppedAt: new Date() },
    });
    for (const id of users) await fixture.user.delete({ where: { id } });
    await Promise.all([fixture?.$disconnect(), strict?.$disconnect()]);
  });
  async function user(label: string) {
    const suffix = randomUUID();
    const row = await fixture.user.create({
      data: { name: label, email: `${suffix}@example.test`, slug: `u-${suffix}` },
    });
    users.push(row.id);
    return row;
  }
  function api(row: { id: string; email: string; name: string }) {
    return createRouterClient(module.inferenceContributionsRouter, {
      context: {
        session: {
          user: { ...row, emailVerified: true, role: "user" },
          session: {
            id: `s-${row.id}`,
            userId: row.id,
            token: "test",
            expiresAt: new Date(Date.now() + 60_000),
            createdAt: new Date(),
            updatedAt: new Date(),
            ipAddress: null,
            userAgent: null,
          },
        } as Session,
      } as Context,
    });
  }
  async function arrangement() {
    const owner = await user("pool-owner");
    const contributor = await user("contributor");
    const device = await fixture.cliDevice.create({
      data: { userId: contributor.id, slug: "friend-node", status: "CONNECTED" },
    });
    const endpoint = await fixture.endpoint.create({
      data: {
        userId: contributor.id,
        cliDeviceId: device.id,
        slug: "inference",
        label: "inference",
        status: "ONLINE",
        published: true,
        capabilityMetadata: {
          version: 1,
          protocol: "openai-compatible",
          chatCompletions: { supported: true, streaming: true },
        },
      },
    });
    const model = await fixture.discoveredModel.create({
      data: {
        userId: contributor.id,
        endpointId: endpoint.id,
        upstreamModelId: "qwen",
        encodedModelId: "qwen",
        published: true,
      },
    });
    const target = await fixture.executionTarget.findUniqueOrThrow({
      where: { discoveredModelId: model.id },
    });
    const pool = await fixture.modelPool.create({
      data: { userId: owner.id, slug: "pool", name: "pool" },
    });
    return { owner, contributor, device, endpoint, model, target, pool };
  }
  it("requires contributor offer and owner acceptance without cloning physical capacity", async () => {
    const f = await arrangement();
    const offer = await api(f.contributor).offer({
      poolId: f.pool.id,
      discoveredModelId: f.model.id,
    });
    expect(await fixture.poolMember.count({ where: { poolId: f.pool.id } })).toBe(0);
    await expect(api(f.contributor).accept({ id: offer.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const accepted = await api(f.owner).accept({ id: offer.id });
    const member = await fixture.poolMember.findUniqueOrThrow({
      where: { id: accepted.memberId },
      include: { ExecutionTarget: true },
    });
    expect(member.ExecutionTarget?.userId).toBe(f.contributor.id);
    expect(member.ExecutionTarget?.inferenceCapacityId).toBe(f.target.inferenceCapacityId);
    expect(await fixture.cliDevice.count({ where: { userId: f.owner.id } })).toBe(0);
    const otherPool = await fixture.modelPool.create({
      data: { userId: f.owner.id, slug: "other", name: "other" },
    });
    await expect(
      strict.$transaction(async (tx) => {
        await order.fenceOwners(tx, [f.owner.id]);
        await order.acquireFences(tx, [order.fences.capacityPolicy(f.target.id)]);
        return tx.poolMember.create({
          data: {
            poolId: otherPool.id,
            discoveredModelId: f.model.id,
            executionTargetId: f.target.id,
          },
        });
      }),
    ).rejects.toThrow("match its owner");
    await api(f.contributor).revoke({ id: offer.id });
    expect(await fixture.poolMember.findUnique({ where: { id: accepted.memberId } })).toBeNull();
    const reoffer = await api(f.contributor).offer({
      poolId: f.pool.id,
      discoveredModelId: f.model.id,
    });
    const reaccepted = await api(f.owner).accept({ id: reoffer.id });
    expect(reaccepted.memberId).not.toBe(accepted.memberId);
    await expect(api(f.owner).accept({ id: offer.id })).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("concurrent acceptance and contributor revocation cannot revive terminal consent", async () => {
    const f = await arrangement();
    const offer = await api(f.contributor).offer({
      poolId: f.pool.id,
      discoveredModelId: f.model.id,
    });
    const results = await Promise.allSettled([
      api(f.owner).accept({ id: offer.id }),
      api(f.contributor).revoke({ id: offer.id }),
    ]);
    expect(results[1]?.status).toBe("fulfilled");
    expect(
      (await fixture.inferenceContribution.findUniqueOrThrow({ where: { id: offer.id } })).state,
    ).toBe("REVOKED");
    expect(await fixture.poolMember.count({ where: { inferenceContributionId: offer.id } })).toBe(
      0,
    );
    await expect(
      strict.$transaction(async (tx) => {
        await order.fenceOwners(tx, [f.owner.id, f.contributor.id]);
        return tx.inferenceContribution.update({
          where: { id: offer.id },
          data: { state: "ACTIVE" },
        });
      }),
    ).rejects.toThrow("cannot be restored");
  });
  it("member deletion removes targeted rules, preserves excludes pool-wide, and roundtrips SQL NULL labels", async () => {
    const f = await arrangement();
    const offer = await api(f.contributor).offer({
      poolId: f.pool.id,
      discoveredModelId: f.model.id,
    });
    const accepted = await api(f.owner).accept({ id: offer.id });
    const { Prisma } = await import("@ws-model-proxy/db");
    await fixture.poolRoutingRule.createMany({
      data: [
        {
          poolId: f.pool.id,
          position: 0,
          memberId: accepted.memberId,
          exclude: false,
          metric: "node.cpu.usage_pct",
          op: ">",
          threshold: 80,
          effect: "full",
          labels: Prisma.DbNull,
        },
        {
          poolId: f.pool.id,
          position: 1,
          memberId: accepted.memberId,
          exclude: true,
          metric: "node.cpu.usage_pct",
          op: ">",
          threshold: 80,
          effect: "avoid",
          labels: Prisma.DbNull,
        },
      ],
    });
    expect(
      (await fixture.poolRoutingRule.findMany({ where: { poolId: f.pool.id } })).every(
        (rule) => rule.labels === null,
      ),
    ).toBe(true);
    await api(f.contributor).revoke({ id: offer.id });
    const rules = await fixture.poolRoutingRule.findMany({ where: { poolId: f.pool.id } });
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ position: 1, memberId: null, exclude: false, labels: null });
    const { routingRulesFromRows } = await import("../lib/metric-routing");
    expect(routingRulesFromRows(rules)).toHaveLength(1);
  });

  it("routes a friend's serving model through actual admission and blocks revocation after admission before any relay send", async () => {
    const f = await arrangement();
    const offer = await api(f.contributor).offer({
      poolId: f.pool.id,
      discoveredModelId: f.model.id,
    });
    const accepted = await api(f.owner).accept({ id: offer.id });
    await fixture.modelPool.update({
      where: { id: f.pool.id },
      data: { affinityEnabled: false, protectionEnabled: false, capacityWaitBudgetMs: 100 },
    });
    await fixture.inferenceCapacity.update({
      where: { id: f.target.inferenceCapacityId ?? "" },
      data: { hardConcurrencyLimit: 1, countStrategy: "CONSERVATIVE_ESTIMATE" },
    });
    const security = await import("@ws-model-proxy/db/forwarder-security");
    const rawToken = `wsmp_model_${randomUUID().replaceAll("-", "")}`;
    await fixture.modelApiToken.create({
      data: {
        userId: f.owner.id,
        name: "Inference consent test",
        lookupPrefix: security.credentialLookupPrefix(rawToken),
        secretDigest: security.hmacDigestForForwarderPurpose({
          purpose: "modelApiToken",
          value: rawToken,
        }),
      },
    });
    const routes = await import("../../../../apps/server/src/model-api/routes.js");
    const { StoreCapacityAdmissionRuntime } = await import(
      "../../../../apps/server/src/model-api/capacity/runtime.js"
    );
    const { PostgresCapacityAdmissionStore } = await import(
      "../../../../apps/server/src/model-api/capacity/postgres-store.js"
    );
    const identifiers = await import("@ws-model-proxy/config/forwarder-identifiers");
    const handlers = new Map<
      string,
      import("../../../../apps/server/src/relay/session-manager.js").ActiveRelayResponseHandlers
    >();
    let sends = 0;
    const manager: NonNullable<Parameters<typeof routes.createModelApiRoutes>[0]>["manager"] = {
      getActiveCliDeviceIds: () => [f.device.id],
      supportsCountContext: () => false,
      registerRelayResponseHandlers: ({ requestId, handlers: callback }) => {
        handlers.set(requestId, callback);
      },
      sendRelayRequest: ({ requestId }) => {
        sends++;
        queueMicrotask(() => {
          const callback = handlers.get(requestId);
          callback?.onHeaders({
            type: "relay.response.headers",
            requestId,
            status: 200,
            headers: { "content-type": "application/json" },
          });
          callback?.onBody(
            new TextEncoder().encode(
              JSON.stringify({
                id: "chat-test",
                object: "chat.completion",
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content: "fixture" },
                    finish_reason: "stop",
                  },
                ],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              }),
            ),
            { type: "relay.response.body", requestId, chunkId: "0" },
          );
          callback?.onComplete({
            type: "relay.complete",
            requestId,
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          });
        });
      },
      cancelRelayRequest: () => undefined,
      completeRelayRequest: () => undefined,
    };
    const modelId = identifiers.poolModelId({
      userSlug: f.owner.slug ?? "",
      poolSlug: f.pool.slug,
    });
    const request = {
      method: "POST",
      headers: { authorization: `Bearer ${rawToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "fixture" }],
        max_tokens: 1,
      }),
    };
    const runtime = new StoreCapacityAdmissionRuntime(new PostgresCapacityAdmissionStore(strict));
    try {
      const success = await routes
        .createModelApiRoutes({ manager, capacityRuntime: runtime })
        .request("/chat/completions", request);
      expect(success.status).toBe(200);
      await success.text();
      expect(sends).toBe(1);
      const selection = await fixture.relayRequest.findFirst({
        where: { requestedModelPoolId: f.pool.id },
        orderBy: { createdAt: "desc" },
      });
      expect(selection?.selectedPoolMemberId).toBe(accepted.memberId);
      const snapshot = await fixture.capacityRuntime.findUnique({
        where: { capacityId: f.target.inferenceCapacityId ?? "" },
      });
      expect(snapshot?.userId).toBe(f.contributor.id);
    } finally {
      await runtime.close();
    }
    sends = 0;
    class RevokeAfterAdmission extends StoreCapacityAdmissionRuntime {
      override async acquire(...args: Parameters<StoreCapacityAdmissionRuntime["acquire"]>) {
        const result = await super.acquire(...args);
        if (result.state === "ADMITTED") await api(f.contributor).revoke({ id: offer.id });
        return result;
      }
    }
    const revokedRuntime = new RevokeAfterAdmission(new PostgresCapacityAdmissionStore(strict));
    try {
      const denied = await routes
        .createModelApiRoutes({ manager, capacityRuntime: revokedRuntime })
        .request("/chat/completions", request);
      expect(denied.status).not.toBe(200);
      await denied.text();
      expect(sends).toBe(0);
      const terminal = await fixture.relayRequest.findFirstOrThrow({
        where: { requestedModelPoolId: f.pool.id },
        orderBy: { createdAt: "desc" },
      });
      expect(terminal.status).not.toBe("PENDING");
      expect(terminal.selectedPoolMemberId).toBe(accepted.memberId);
      expect(terminal.selectedExecutionTargetId).toBe(f.target.id);
      // Historical terminalization is not fresh authority, including a new
      // terminal-looking row without that exact request's admitted lease.
      await expect(
        strict.relayRequest.create({
          data: {
            userId: f.owner.id,
            requestedModelPoolId: f.pool.id,
            selectedDiscoveredModelId: f.model.id,
            selectedExecutionTargetId: f.target.id,
            selectedPoolMemberId: accepted.memberId,
            fallbackRoute: "local",
            status: "FAILED",
          },
        }),
      ).rejects.toThrow("selection must match");
      expect(
        (await fixture.inferenceContribution.findUniqueOrThrow({ where: { id: offer.id } })).state,
      ).toBe("REVOKED");
      expect(
        await fixture.capacityLease.count({
          where: { poolMemberId: accepted.memberId, state: "ACTIVE" },
        }),
      ).toBe(0);
    } finally {
      await revokedRuntime.close();
    }
  }, 30_000);

  it("concurrent account deletion and deployment application cannot strand claimed processes behind a deletion marker", async () => {
    const f = await arrangement();
    const node = await fixture.cliDevice.create({
      data: {
        userId: f.owner.id,
        slug: "owner-node",
        status: "CONNECTED",
        relayProtocolVersion: DEPLOYMENT_PROTOCOL_VERSION,
        allowDeployments: true,
        reportedDeployments: true,
        mcpCommandMode: "UNSUPERVISED",
        reportedMcpCommandMode: "UNSUPERVISED",
        nodeInfo: {
          nodeKind: "unified",
          memoryTotalMiB: 8192,
          executionMechanism: "systemd+linger",
        },
        usableMemoryGb: 7,
      },
    });
    const config = await fixture.deploymentConfig.create({
      data: { userId: f.owner.id, poolId: f.pool.id, name: "Race fixture", slug: "race" },
    });
    const { deploymentSpecSchema } = await import("../lib/deployment-spec");
    const spec = deploymentSpecSchema.parse({
      variants: [
        {
          key: "one",
          groupSize: 1,
          resources: [{ kind: "unified", memoryGb: 1 }],
          commands: [{ management: "ownedProcess", start: "true", stop: "true" }],
          readiness: {},
          models: ["qwen"],
          attachment: { type: "llm", poolId: f.pool.id },
          hardConcurrencyLimit: 1,
        },
      ],
    });
    const revision = await fixture.deploymentConfigRevision.create({
      data: {
        configId: config.id,
        revision: 1,
        editorId: f.owner.id,
        editorKind: "USER",
        contentHash: "c".repeat(64),
        spec,
      },
    });
    const service = await import("../lib/deployment-service");
    const actor = { userId: f.owner.id, id: f.owner.id, kind: "USER" as const };
    const plan = await service.createDeploymentPlan(actor, {
      start: { revisionId: revision.id, variantKey: "one", nodeIds: [node.id], groupCount: 1 },
    });
    const deletion = await import("@ws-model-proxy/db/parent-deletion");
    let release: () => void = () => undefined;
    let locked: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const unlock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = strict.$transaction(
      async (tx) => {
        await order.fenceOwners(tx, [f.owner.id]);
        locked();
        await unlock;
      },
      { timeout: 10_000 },
    );
    await held;
    const operations = [
      service.applyDeploymentPlan(actor, plan.id, false),
      deletion.requestUserDeletion(strict, f.owner.id),
    ];
    try {
      const deadline = Date.now() + 2000;
      let waiters = 0;
      while (Date.now() < deadline && waiters < 2) {
        const rows = await fixture.$queryRaw<
          Array<{ count: bigint }>
        >`SELECT count(*) AS count FROM pg_stat_activity WHERE wait_event = 'advisory' AND query LIKE '%wsmp_acquire_fences%'`;
        waiters = Number(rows[0]?.count ?? 0);
        if (waiters < 2) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiters).toBeGreaterThanOrEqual(2);
    } finally {
      release();
    }
    await blocker;
    const results = await Promise.allSettled(operations);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const owner = await fixture.user.findUniqueOrThrow({ where: { id: f.owner.id } });
    const heldClaims = await fixture.deploymentInstanceNode.count({
      where: { Instance: { userId: f.owner.id }, claimHeld: true },
    });
    expect(Boolean(owner.deletionRequestedAt) && heldClaims > 0).toBe(false);
    if (owner.deletionRequestedAt) {
      await expect(service.applyDeploymentPlan(actor, plan.id, false)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    } else {
      expect(heldClaims).toBe(1);
      await expect(deletion.requestUserDeletion(strict, f.owner.id)).rejects.toMatchObject({
        code: "RETAINED_HISTORY",
      });
    }
  }, 30_000);

  it("charges independent pool owners against the same contributor capacity and cancels queued revoked consent", async () => {
    const f = await arrangement();
    const secondOwner = await user("second-pool-owner");
    const secondPool = await fixture.modelPool.create({
      data: { userId: secondOwner.id, slug: "shared", name: "Shared engine" },
    });
    const firstOffer = await api(f.contributor).offer({
      poolId: f.pool.id,
      discoveredModelId: f.model.id,
    });
    const secondOffer = await api(f.contributor).offer({
      poolId: secondPool.id,
      discoveredModelId: f.model.id,
    });
    const firstMember = await api(f.owner).accept({ id: firstOffer.id });
    const secondMember = await api(secondOwner).accept({ id: secondOffer.id });
    await fixture.inferenceCapacity.update({
      where: { id: f.target.inferenceCapacityId ?? "" },
      data: { hardConcurrencyLimit: 1, countStrategy: "CONSERVATIVE_ESTIMATE" },
    });
    const { PostgresCapacityAdmissionStore } = await import(
      "../../../../apps/server/src/model-api/capacity/postgres-store.js"
    );
    const store = new PostgresCapacityAdmissionStore(strict);
    const attempt = (ownerId: string, poolId: string, memberId: string) => ({
      attemptId: randomUUID(),
      requestId: randomUUID(),
      ownerId,
      sourceKind: "POOL" as const,
      poolId,
      basePriority: 16,
      connectionOwner: randomUUID(),
      deadlineAt: new Date(Date.now() + 60_000),
      candidates: [
        {
          capacityId: f.target.inferenceCapacityId ?? "",
          executionTargetId: f.target.id,
          poolMemberId: memberId,
          candidateOrder: 0,
        },
      ],
    });
    const attempts = [
      attempt(f.owner.id, f.pool.id, firstMember.memberId),
      attempt(secondOwner.id, secondPool.id, secondMember.memberId),
    ];
    const results = await Promise.all(attempts.map((input) => store.acquire(input)));
    expect(results.filter((r) => r.state === "ADMITTED")).toHaveLength(1);
    expect(results.filter((r) => r.state === "WAITING")).toHaveLength(1);
    expect(
      await fixture.capacityLease.count({
        where: { capacityId: f.target.inferenceCapacityId ?? "", state: "ACTIVE" },
      }),
    ).toBe(1);
    const queuedIndex = results.findIndex((r) => r.state === "WAITING");
    const queuedOffer = queuedIndex === 0 ? firstOffer : secondOffer;
    await api(f.contributor).revoke({ id: queuedOffer.id });
    const admitted = results.find((r) => r.state === "ADMITTED");
    if (admitted?.state !== "ADMITTED") throw new Error("Missing physical-capacity lease");
    await store.release(admitted.lease);
    const queuedAttempt = attempts[queuedIndex];
    if (!queuedAttempt) throw new Error("Missing queued attempt");
    const afterRevocation = await store.acquire({ ...queuedAttempt, candidates: [] });
    expect(afterRevocation.state).not.toBe("ADMITTED");
    expect(
      await fixture.capacityLease.count({
        where: { capacityId: f.target.inferenceCapacityId ?? "", state: "ACTIVE" },
      }),
    ).toBe(0);
    expect(
      await fixture.capacityRuntime.findUnique({
        where: { capacityId: f.target.inferenceCapacityId ?? "" },
      }),
    ).toMatchObject({ userId: f.contributor.id });
  }, 30_000);

  it("gives a pool owner no reservation or priority over the contributor's own traffic", async () => {
    const f = await arrangement();
    const offer = await api(f.contributor).offer({
      poolId: f.pool.id,
      discoveredModelId: f.model.id,
    });
    const member = await api(f.owner).accept({ id: offer.id });
    const capacityId = f.target.inferenceCapacityId ?? "";
    await fixture.inferenceCapacity.update({
      where: { id: capacityId },
      data: { hardConcurrencyLimit: 1, countStrategy: "CONSERVATIVE_ESTIMATE" },
    });
    // The owner tries to claim the contributor's single slot for the pool.
    await fixture.modelPool.update({
      where: { id: f.pool.id },
      data: { capacityReservedSlots: 1, capacityPriority: 31, capacityBorrowPolicy: "NEVER" },
    });
    await fixture.poolMember.update({
      where: { id: member.memberId },
      data: { capacityReservedSlots: 1, capacityPriority: 31, capacityBorrowPolicy: "NEVER" },
    });
    const { PostgresCapacityAdmissionStore } = await import(
      "../../../../apps/server/src/model-api/capacity/postgres-store.js"
    );
    const store = new PostgresCapacityAdmissionStore(strict);
    // The contributor's own request on its own machine is admitted: the
    // pool's reservation does not apply to someone else's capacity.
    const own = await store.acquire({
      attemptId: randomUUID(),
      requestId: randomUUID(),
      ownerId: f.contributor.id,
      sourceKind: "DIRECT" as const,
      basePriority: 16,
      connectionOwner: randomUUID(),
      deadlineAt: new Date(Date.now() + 60_000),
      candidates: [{ capacityId, executionTargetId: f.target.id, candidateOrder: 0 }],
    });
    expect(own.state).toBe("ADMITTED");
    if (own.state === "ADMITTED") await store.release(own.lease);
  }, 30_000);
});
