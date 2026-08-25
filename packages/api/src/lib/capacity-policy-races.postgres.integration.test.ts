import { createRouterClient } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Context } from "../context";
import {
  assertDirectCapacityPolicy,
  assertEffectiveConcurrencyPolicy,
  assertEffectiveContextPolicy,
} from "./capacity-policy-safety";

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("capacity policy production-router races", () => {
  let modules:
    | {
        prisma: typeof import("@ws-model-proxy/db").default;
        capacity: typeof import("../routers/capacity-management");
        forwarder: typeof import("../routers/forwarder-management");
        provider: typeof import("../routers/provider-management");
      }
    | undefined;
  let blocker: ReturnType<typeof import("@ws-model-proxy/db/client-factory").createPrismaClient>;
  let observer: ReturnType<typeof import("@ws-model-proxy/db/client-factory").createPrismaClient>;
  let context: Context;
  let userId = "";
  let capacityId = "";
  let providerCapacityId = "";
  let providerTargetId = "";
  let targetIds: [string, string];
  let providerModelId = "";
  let guardedProviderModelIds: [string, string];
  let poolId = "";
  let memberId = "";

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    process.env.NODE_ENV = "test";
    process.env.MODEL_API_GLOBAL_CAPACITY_ENABLED = "true";
    process.env.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED = "true";
    const [db, dbFactory, capacity, forwarder, provider] = await Promise.all([
      import("@ws-model-proxy/db"),
      import("@ws-model-proxy/db/client-factory"),
      import("../routers/capacity-management"),
      import("../routers/forwarder-management"),
      import("../routers/provider-management"),
    ]);
    blocker = dbFactory.createPrismaClient(databaseUrl);
    observer = dbFactory.createPrismaClient(databaseUrl);
    modules = { prisma: db.default, capacity, forwarder, provider };
    const suffix = crypto.randomUUID();
    const user = await modules.prisma.user.create({
      data: {
        name: "Capacity race",
        email: `capacity-race-${suffix}@example.test`,
        slug: `capacity-race-${suffix}`,
      },
    });
    userId = user.id;
    context = {
      session: {
        user,
        session: {
          id: `session-${suffix}`,
          userId,
          token: `token-${suffix}`,
          expiresAt: new Date(Date.now() + 60_000),
          createdAt: new Date(),
          updatedAt: new Date(),
          ipAddress: "127.0.0.1",
          userAgent: "capacity-race-test",
        },
      } as Session,
    };
    const physical = await modules.prisma.inferenceCapacity.create({
      data: {
        userId,
        label: `race-${suffix}`,
        runtimeIdentityKey: `race-${suffix}`,
        runtimeModel: "race-model",
        hardConcurrencyLimit: 8,
        physicalMaxContext: 16_384,
        countStrategy: "CONSERVATIVE_ESTIMATE",
      },
    });
    capacityId = physical.id;
    const account = await modules.prisma.providerAccount.create({
      data: {
        userId,
        providerType: "openai",
        label: `race-${suffix}`,
        baseUrl: "https://provider.example.test/v1",
        endpointIdentity: "https://provider.example.test/v1",
        authType: "BEARER",
      },
    });
    await modules.prisma.$transaction(async (transaction) => {
      const credential = await transaction.providerCredential.create({
        data: {
          userId,
          providerAccountId: account.id,
          credentialType: "BEARER",
          keyVersion: "race-test-v1",
          ciphertext: new Uint8Array([1]),
          nonce: crypto.getRandomValues(new Uint8Array(12)),
          authTag: new Uint8Array(16),
          displaySuffix: "test",
        },
      });
      await transaction.providerAccount.update({
        where: { id: account.id },
        data: { currentCredentialId: credential.id, enabled: true, status: "ACTIVE" },
      });
    });
    const providerModels = await Promise.all(
      ["attach", "a", "b"].map((name) =>
        modules!.prisma.providerModel.create({
          data: {
            userId,
            providerAccountId: account.id,
            upstreamModelId: `race-${name}`,
            enabled: true,
            concurrencyLimit: 8,
            contextWindow: 16_384,
            nativeCapabilities: {
              version: 1,
              protocol: "openai-compatible",
              chatCompletions: { supported: true, streaming: true },
            },
          },
        }),
      ),
    );
    providerModelId = providerModels[0]!.id;
    guardedProviderModelIds = [providerModels[1]!.id, providerModels[2]!.id];
    await Promise.all(
      providerModels.map((model) =>
        modules!.prisma.providerPricingVersion.create({
          data: {
            userId,
            providerAccountId: account.id,
            providerModelId: model.id,
            version: "race-v1",
            currency: "USD",
            pricing: { ratesPerMillion: { input: "1", output: "1" } },
            effectiveAt: new Date(Date.now() - 60_000),
          },
        }),
      ),
    );
    const providerCapacity = await modules.prisma.inferenceCapacity.create({
      data: {
        userId,
        label: `provider-${suffix}`,
        runtimeIdentityKey: `provider-model:${providerModelId}`,
        runtimeModel: providerModels[0]!.upstreamModelId,
        hardConcurrencyLimit: 8,
        physicalMaxContext: 16_384,
        countStrategy: "CONSERVATIVE_ESTIMATE",
      },
    });
    providerCapacityId = providerCapacity.id;
    const targets = await Promise.all(
      providerModels.map((model, index) =>
        modules!.prisma.executionTarget.create({
          data: {
            userId,
            kind: "PROVIDER_MODEL",
            providerModelId: model.id,
            inferenceCapacityId: index === 0 ? providerCapacity.id : physical.id,
          },
        }),
      ),
    );
    providerTargetId = targets[0]!.id;
    targetIds = [targets[1]!.id, targets[2]!.id];
    const pool = await modules.prisma.modelPool.create({
      data: {
        userId,
        slug: `race-${suffix}`,
        name: "Race pool",
        capacityConcurrencyLimit: 4,
        capacityReservedSlots: 1,
        capacityContextCeiling: 8_192,
        capacityContextMargin: 512,
      },
    });
    poolId = pool.id;
    const policy = await modules.prisma.providerBudgetPolicy.create({
      data: {
        userId,
        providerAccountId: account.id,
        providerModelId,
        poolId,
        scopeType: "POOL_PROVIDER_MODEL",
        active: true,
        activatedAt: new Date(),
        Rules: {
          create: {
            metric: "CONCURRENCY",
            period: "PER_ATTEMPT",
            mode: "LIMITED",
            limitValue: 8,
          },
        },
      },
    });
    await modules.prisma.providerAuditEvent.create({
      data: {
        userId,
        providerAccountId: account.id,
        action: "BUDGET_ACTIVATED",
        subjectId: policy.id,
      },
    });
    const member = await modules.prisma.poolMember.create({
      data: { poolId, executionTargetId: targetIds[1], tier: "PRIMARY", weight: 1 },
    });
    memberId = member.id;
  });

  beforeEach(async () => {
    if (!modules) return;
    await modules.prisma.poolMember.deleteMany({
      where: { poolId, executionTargetId: providerTargetId },
    });
    await modules.prisma.providerModel.update({
      where: { id: providerModelId },
      data: { concurrencyLimit: 8, contextWindow: 16_384 },
    });
    await modules.prisma.inferenceCapacity.update({
      where: { id: capacityId },
      data: { hardConcurrencyLimit: 8, physicalMaxContext: 16_384 },
    });
    await modules.prisma.inferenceCapacity.update({
      where: { id: providerCapacityId },
      data: { hardConcurrencyLimit: 8, physicalMaxContext: 16_384 },
    });
    await modules.prisma.executionTarget.updateMany({
      where: { id: { in: targetIds } },
      data: {
        directConcurrencyLimit: null,
        directReservedSlots: 0,
        directContextCeiling: null,
        directContextMargin: 0,
      },
    });
    await modules.prisma.modelPool.update({
      where: { id: poolId },
      data: {
        capacityConcurrencyLimit: 4,
        capacityReservedSlots: 1,
        capacityContextCeiling: 8_192,
        capacityContextMargin: 512,
      },
    });
    await modules.prisma.poolMember.update({
      where: { id: memberId },
      data: {
        capacityConcurrencyMode: "INHERIT",
        capacityConcurrencyLimit: null,
        capacityReservedSlots: 0,
        capacityContextCeilingMode: "INHERIT",
        capacityContextCeiling: null,
        capacityContextMargin: 0,
      },
    });
  });

  afterAll(async () => {
    // Provider audit history is intentionally append-only and retains its
    // owner. Unique fixture identities keep these rows isolated in shared CI.
    await Promise.all([blocker?.$disconnect(), observer?.$disconnect()]);
  });

  async function operationBehindIdentityFence(identity: string, operation: () => Promise<unknown>) {
    const lockKey = `execution-target:${identity}`;
    let releaseFence: (() => void) | undefined;
    let reportLocked: (() => void) | undefined;
    const release = new Promise<void>((resolve) => {
      releaseFence = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      reportLocked = resolve;
    });
    const blockerTransaction = blocker.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`execution-target:${identity}`}, 0))`;
      reportLocked?.();
      await release;
    });
    await locked;
    const outcomePromise = operation();
    let waiterCount = 0;
    for (let attempt = 0; attempt < 500; attempt++) {
      // Observe from a dedicated client: querying through the client that owns
      // the blocker transaction can reuse its pinned connection under Prisma's
      // adapter and make the barrier observation ambiguous.
      const rows = await observer.$queryRaw<Array<{ count: bigint }>>`
        WITH expected_lock AS (
          SELECT hashtextextended(${lockKey}, 0) AS lock_key
        )
        SELECT COUNT(*)::bigint AS count
        FROM pg_locks, expected_lock
        WHERE locktype = 'advisory'
          AND granted = false
          AND classid = (((lock_key >> 32) & 4294967295)::oid)
          AND objid = ((lock_key & 4294967295)::oid)
          AND objsubid = 1
      `;
      waiterCount = Number(rows[0]?.count ?? 0n);
      if (waiterCount >= 1) break;
    }
    releaseFence?.();
    await blockerTransaction;
    if (waiterCount < 1) throw new Error(`Expected a waiter on ${lockKey}, observed none.`);
    return outcomePromise;
  }

  function expectAllFulfilled(outcomes: readonly PromiseSettledResult<unknown>[]) {
    expect(
      outcomes.flatMap((outcome) =>
        outcome.status === "rejected" ? [String(outcome.reason)] : [],
      ),
    ).toEqual([]);
  }

  it("serializes provider limit updates against standard provider attachment", async () => {
    if (!modules) throw new Error("modules unavailable");
    const providerClient = createRouterClient(modules.provider.providerManagementRouter, {
      context,
    });
    const forwarderClient = createRouterClient(modules.forwarder.forwarderManagementRouter, {
      context,
    });
    await operationBehindIdentityFence(`provider-model:${providerModelId}`, () =>
      providerClient.updateModel({ id: providerModelId, concurrencyLimit: 8 }),
    );
    await operationBehindIdentityFence(`provider-model:${providerModelId}`, () =>
      forwarderClient.addProviderPoolMember({
        poolId,
        providerModelId,
        tier: "PRIMARY",
        weight: 1,
      }),
    );
    await modules.prisma.poolMember.deleteMany({
      where: { poolId, executionTargetId: providerTargetId },
    });
    const outcomes = await Promise.allSettled([
      providerClient.updateModel({ id: providerModelId, concurrencyLimit: 2 }),
      forwarderClient.addProviderPoolMember({
        poolId,
        providerModelId,
        tier: "PRIMARY",
        weight: 1,
      }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const [model, physical, attachment] = await Promise.all([
      modules.prisma.providerModel.findUniqueOrThrow({ where: { id: providerModelId } }),
      modules.prisma.inferenceCapacity.findUniqueOrThrow({ where: { id: providerCapacityId } }),
      modules.prisma.poolMember.findFirst({
        where: { poolId, executionTargetId: providerTargetId },
      }),
    ]);
    expect(physical.hardConcurrencyLimit).toBe(model.concurrencyLimit);
    expect(attachment === null || (model.concurrencyLimit ?? 0) >= 4).toBe(true);
  });

  it("orders the real multi-target capacity update against direct mutations", async () => {
    if (!modules) throw new Error("modules unavailable");
    const firstClient = createRouterClient(modules.capacity.capacityManagementRouter, { context });
    const secondClient = createRouterClient(modules.capacity.capacityManagementRouter, { context });
    const outcomes = await Promise.allSettled([
      firstClient.update({ id: capacityId, hardConcurrencyLimit: 6 }),
      Promise.all([
        secondClient.updateDirectPolicy({
          executionTargetId: targetIds[1],
          directConcurrencyLimit: 3,
        }),
        secondClient.updateDirectPolicy({
          executionTargetId: targetIds[0],
          directConcurrencyLimit: 3,
        }),
      ]),
    ]);
    expectAllFulfilled(outcomes);
    const targets = await modules.prisma.executionTarget.findMany({
      where: { id: { in: targetIds } },
      include: { InferenceCapacity: true },
    });
    expect(targets).toHaveLength(2);
    for (const target of targets)
      assertDirectCapacityPolicy({
        hardLimit: target.InferenceCapacity?.hardConcurrencyLimit,
        concurrencyLimit: target.directConcurrencyLimit,
        reservedSlots: target.directReservedSlots,
        physicalMaxContext: target.InferenceCapacity?.physicalMaxContext,
        contextCeiling: target.directContextCeiling,
        contextMargin: target.directContextMargin,
      });
  });

  it("serializes guarded multi-provider attachment in canonical identity order", async () => {
    if (!modules) throw new Error("modules unavailable");
    const firstClient = createRouterClient(modules.forwarder.forwarderManagementRouter, {
      context,
    });
    const secondClient = createRouterClient(modules.forwarder.forwarderManagementRouter, {
      context,
    });
    const suffix = crypto.randomUUID();
    const providerInput = (ids: readonly [string, string]) =>
      ids.map((id) => ({
        providerModelId: id,
        tier: "PRIMARY" as const,
        concurrencyLimit: 4,
        dailySpendLimit: "5",
      }));
    const guardedInput = (slug: string, ids: readonly [string, string]) => ({
      slug,
      name: `Guarded ${slug}`,
      localModelIds: [],
      recommendedSurface: "OPENAI_CHAT_COMPLETIONS" as const,
      memberConcurrencyLimit: 4,
      memberContextCeiling: 8_192,
      reservedSlots: 1,
      localWaitBudgetMs: 30_000,
      publicEgressAcknowledged: false,
      providerModels: providerInput(ids),
    });
    const ordered = [...guardedProviderModelIds].sort() as [string, string];
    await operationBehindIdentityFence(`provider-model:${ordered[0]}`, () =>
      firstClient.createGuardedModelPool(guardedInput(`guarded-probe-a-${suffix}`, ordered)),
    );
    await operationBehindIdentityFence(`provider-model:${ordered[0]}`, () =>
      secondClient.createGuardedModelPool(
        guardedInput(`guarded-probe-b-${suffix}`, [ordered[1], ordered[0]]),
      ),
    );
    const outcomes = await Promise.allSettled([
      firstClient.createGuardedModelPool(guardedInput(`guarded-a-${suffix}`, ordered)),
      secondClient.createGuardedModelPool(
        guardedInput(`guarded-b-${suffix}`, [ordered[1], ordered[0]]),
      ),
    ]);
    expectAllFulfilled(outcomes);
    const pools = await modules.prisma.modelPool.findMany({
      where: { userId, slug: { in: [`guarded-a-${suffix}`, `guarded-b-${suffix}`] } },
      include: { PoolMembers: true },
    });
    expect(pools).toHaveLength(2);
    expect(pools.every((pool) => pool.PoolMembers.length === 2)).toBe(true);
    expect(
      pools.flatMap((pool) => pool.PoolMembers).every((member) => member.tier === "PRIMARY"),
    ).toBe(true);
  });

  it("preserves cross-row invariants across real pool, member, and direct mutations", async () => {
    if (!modules) throw new Error("modules unavailable");
    const firstClient = createRouterClient(modules.capacity.capacityManagementRouter, { context });
    const secondClient = createRouterClient(modules.capacity.capacityManagementRouter, { context });
    const thirdClient = createRouterClient(modules.capacity.capacityManagementRouter, { context });
    const outcomes = await Promise.allSettled([
      firstClient.updatePoolPolicy({ modelPoolId: poolId, capacityReservedSlots: 2 }),
      secondClient.updateMemberPolicy({ poolMemberId: memberId, capacityReservedSlots: 1 }),
      thirdClient.updateDirectPolicy({
        executionTargetId: targetIds[1],
        directReservedSlots: 2,
      }),
    ]);
    expectAllFulfilled(outcomes);
    const [capacity, target, member] = await Promise.all([
      modules.prisma.inferenceCapacity.findUniqueOrThrow({ where: { id: capacityId } }),
      modules.prisma.executionTarget.findUniqueOrThrow({ where: { id: targetIds[1] } }),
      modules.prisma.poolMember.findUniqueOrThrow({
        where: { id: memberId },
        include: { ModelPool: true },
      }),
    ]);
    assertDirectCapacityPolicy({
      hardLimit: capacity.hardConcurrencyLimit,
      concurrencyLimit: target.directConcurrencyLimit,
      reservedSlots: target.directReservedSlots,
      physicalMaxContext: capacity.physicalMaxContext,
      contextCeiling: target.directContextCeiling,
      contextMargin: target.directContextMargin,
    });
    assertEffectiveConcurrencyPolicy({
      hardLimit: capacity.hardConcurrencyLimit,
      poolLimit: member.ModelPool.capacityConcurrencyLimit,
      poolReserved: member.ModelPool.capacityReservedSlots,
      memberMode: member.capacityConcurrencyMode,
      memberLimit: member.capacityConcurrencyLimit,
      memberReserved: member.capacityReservedSlots,
    });
    assertEffectiveContextPolicy({
      physicalMaxContext: capacity.physicalMaxContext,
      poolCeiling: member.ModelPool.capacityContextCeiling,
      poolMargin: member.ModelPool.capacityContextMargin,
      memberMode: member.capacityContextCeilingMode,
      memberCeiling: member.capacityContextCeiling,
      memberMargin: member.capacityContextMargin,
    });
  });
});
