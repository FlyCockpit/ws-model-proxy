import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createRouterClient } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { Session } from "@ws-model-proxy/auth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Context } from "../context";

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("SCHEMA_VALIDATION_DATABASE_URL is required for PostgreSQL integration tests");
const integration = databaseUrl ? describe : describe.skip;

integration("guarded pool setup with real PostgreSQL", () => {
  let modules:
    | {
        prisma: typeof import("@ws-model-proxy/db").default;
        router: typeof import("./forwarder-management");
      }
    | undefined;

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    process.env.NODE_ENV = "test";
    process.env.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED = "true";
    const [db, router] = await Promise.all([
      import("@ws-model-proxy/db"),
      import("./forwarder-management"),
    ]);
    modules = { prisma: db.default, router };
  });

  afterAll(async () => {
    if (!modules) return;
    modules.router.setGuardedSetupTestFailureInjector(undefined);
    // Successful guarded setup writes append-only provider audit history.
    // Unique fixture identities keep retained rows isolated in shared CI.
  });

  it("rolls back every durable guarded-setup row after a deterministic late failure", async () => {
    if (!modules) throw new Error("modules unavailable");
    const suffix = crypto.randomUUID();
    const user = await modules.prisma.user.create({
      data: {
        name: "Guarded router rollback",
        email: `guarded-router-${suffix}@example.test`,
        slug: `guarded-router-${suffix}`,
      },
    });
    const cli = await modules.prisma.cliDevice.create({
      data: { userId: user.id, slug: `cli-${suffix}`, label: "CLI" },
    });
    const endpoint = await modules.prisma.endpoint.create({
      data: {
        userId: user.id,
        cliDeviceId: cli.id,
        slug: `endpoint-${suffix}`,
        label: "Endpoint",
        capabilityMetadata: {
          version: 1,
          protocol: "openai-compatible",
          responses: { supported: true, streaming: true },
        },
      },
    });
    const local = await modules.prisma.discoveredModel.create({
      data: {
        userId: user.id,
        endpointId: endpoint.id,
        upstreamModelId: "local-model",
        encodedModelId: "local-model",
      },
    });
    const capacity = await modules.prisma.inferenceCapacity.create({
      data: {
        userId: user.id,
        label: `capacity-${suffix}`,
        runtimeIdentityKey: `runtime-${suffix}`,
        runtimeModel: "local-model",
        hardConcurrencyLimit: 2,
        physicalMaxContext: 65_536,
      },
    });
    const localTarget = await modules.prisma.executionTarget.findUniqueOrThrow({
      where: { discoveredModelId: local.id },
    });
    await modules.prisma.executionTarget.update({
      where: { id: localTarget.id },
      data: { inferenceCapacityId: capacity.id },
    });
    const account = await modules.prisma.providerAccount.create({
      data: {
        userId: user.id,
        providerType: "openai",
        label: `provider-${suffix}`,
        baseUrl: "https://provider.example.test/v1",
        endpointIdentity: "https://provider.example.test/v1",
        authType: "BEARER",
        status: "ACTIVE",
        enabled: false,
      },
    });
    await modules.prisma.$transaction(async (transaction) => {
      const credential = await transaction.providerCredential.create({
        data: {
          userId: user.id,
          providerAccountId: account.id,
          credentialType: "BEARER",
          keyVersion: "test-v1",
          ciphertext: new Uint8Array([1]),
          nonce: crypto.getRandomValues(new Uint8Array(12)),
          authTag: new Uint8Array(16),
          displaySuffix: "test",
        },
      });
      await transaction.providerAccount.update({
        where: { id: account.id },
        data: { currentCredentialId: credential.id, enabled: true },
      });
    });
    const provider = await modules.prisma.providerModel.create({
      data: {
        userId: user.id,
        providerAccountId: account.id,
        upstreamModelId: "provider-model",
        enabled: true,
        nativeCapabilities: { surfaces: ["openai-responses"], streaming: true },
      },
    });
    await modules.prisma.providerPricingVersion.create({
      data: {
        userId: user.id,
        providerAccountId: account.id,
        providerModelId: provider.id,
        version: "test-v1",
        currency: "USD",
        pricing: { ratesPerMillion: { input: "1", output: "1" } },
        effectiveAt: new Date(Date.now() - 60_000),
      },
    });

    const session = {
      user,
      session: {
        id: `session-${suffix}`,
        userId: user.id,
        token: `token-${suffix}`,
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date(),
        updatedAt: new Date(),
        ipAddress: "127.0.0.1",
        userAgent: "integration",
      },
    } as Session;
    const handler = new RPCHandler(modules.router.forwarderManagementRouter);
    const link = new RPCLink({
      url: "http://integration.test/rpc",
      fetch: async (request, init) => {
        const result = await handler.handle(new Request(request, init), {
          prefix: "/rpc",
          context: { session } satisfies Context,
        });
        return result.matched ? result.response : new Response(null, { status: 404 });
      },
    });
    const client = createORPCClient(link) as ReturnType<
      typeof createRouterClient<typeof modules.router.forwarderManagementRouter>
    >;
    modules.router.setGuardedSetupTestFailureInjector(() => {
      throw new Error("injected after guarded audit writes");
    });

    await expect(
      client.createGuardedModelPool({
        slug: `guarded-${suffix}`,
        name: "Guarded rollback",
        localModelIds: [local.id],
        recommendedSurface: "OPENAI_RESPONSES",
        memberConcurrencyLimit: 1,
        memberContextCeiling: 32_768,
        reservedSlots: 0,
        localWaitBudgetMs: 30_000,
        publicEgressAcknowledged: true,
        advanced: {
          physicalCountStrategy: "ENGINE_REPORTED",
          contextMargin: 1_024,
          borrowPolicy: "NEVER",
          protocolAdaptationEnabled: false,
          allowLossyDeveloperRoleCollapse: true,
          affinity: {
            enabled: true,
            ttlSeconds: 7_200,
            maxRecords: 20_000,
            prefixWeight: 110,
            conversationWeight: 160,
            confirmedCacheWeight: 260,
            loadPenaltyWeight: 120,
          },
          memberOverrides: [
            {
              discoveredModelId: local.id,
              concurrency: { mode: "LIMITED", limitValue: 1 },
              reservedSlots: 0,
              borrowPolicy: "NEVER",
              waitBudget: { mode: "LIMITED", limitValue: 15_000 },
              contextCeiling: { mode: "LIMITED", limitValue: 31_744 },
              contextMargin: 1_024,
            },
          ],
        },
        providerModels: [
          {
            providerModelId: provider.id,
            concurrencyLimit: 1,
            dailySpendLimit: "5",
            budgetRules: {
              concurrency: { mode: "LIMITED", limitValue: 1 },
              tokensPerAttempt: { mode: "LIMITED", limitValue: 100_000 },
              tokensPerDay: { mode: "LIMITED", limitValue: 1_000_000 },
              tokensPerMonth: { mode: "LIMITED", limitValue: 10_000_000 },
              tokensLifetime: { mode: "UNLIMITED", limitValue: null },
              spendPerDay: { mode: "LIMITED", limitValue: "5" },
              spendPerMonth: { mode: "LIMITED", limitValue: "100" },
            },
          },
        ],
      }),
    ).rejects.toThrow();
    modules.router.setGuardedSetupTestFailureInjector(undefined);

    const pool = await modules.prisma.modelPool.findFirst({
      where: { userId: user.id, slug: `guarded-${suffix}` },
    });
    expect(pool).toBeNull();
    expect(
      await modules.prisma.poolMember.count({
        where: { poolId: { not: "" }, ModelPool: { userId: user.id } },
      }),
    ).toBe(0);
    expect(await modules.prisma.providerBudgetPolicy.count({ where: { userId: user.id } })).toBe(0);
    expect(
      await modules.prisma.providerBudgetRule.count({ where: { Policy: { userId: user.id } } }),
    ).toBe(0);
    expect(await modules.prisma.providerAuditEvent.count({ where: { userId: user.id } })).toBe(0);
    expect(await modules.prisma.capacityAuditEvent.count({ where: { userId: user.id } })).toBe(0);
    expect(await modules.prisma.executionTarget.count({ where: { userId: user.id } })).toBe(1);
    expect(
      await modules.prisma.inferenceCapacity.findUnique({
        where: { id: capacity.id },
        select: { countStrategy: true },
      }),
    ).toEqual({ countStrategy: "CONSERVATIVE_ESTIMATE" });

    await client.createGuardedModelPool({
      slug: `guarded-success-${suffix}`,
      name: "Guarded success",
      localModelIds: [local.id],
      recommendedSurface: "OPENAI_RESPONSES",
      memberConcurrencyLimit: 1,
      memberContextCeiling: 32_768,
      reservedSlots: 0,
      localWaitBudgetMs: 30_000,
      publicEgressAcknowledged: true,
      advanced: {
        physicalCountStrategy: "ENGINE_REPORTED",
        contextMargin: 1_024,
        borrowPolicy: "NEVER",
        protocolAdaptationEnabled: false,
        allowLossyDeveloperRoleCollapse: true,
        affinity: {
          enabled: true,
          ttlSeconds: 7_200,
          maxRecords: 20_000,
          prefixWeight: 110,
          conversationWeight: 160,
          confirmedCacheWeight: 260,
          loadPenaltyWeight: 120,
        },
        memberOverrides: [
          {
            discoveredModelId: local.id,
            concurrency: { mode: "LIMITED", limitValue: 1 },
            reservedSlots: 0,
            borrowPolicy: "NEVER",
            waitBudget: { mode: "LIMITED", limitValue: 15_000 },
            contextCeiling: { mode: "LIMITED", limitValue: 31_744 },
            contextMargin: 1_024,
          },
        ],
      },
      providerModels: [
        {
          providerModelId: provider.id,
          concurrencyLimit: 1,
          dailySpendLimit: "5",
          budgetRules: {
            concurrency: { mode: "LIMITED", limitValue: 1 },
            tokensPerAttempt: { mode: "LIMITED", limitValue: 100_000 },
            tokensPerDay: { mode: "LIMITED", limitValue: 1_000_000 },
            tokensPerMonth: { mode: "LIMITED", limitValue: 10_000_000 },
            tokensLifetime: { mode: "UNLIMITED", limitValue: null },
            spendPerDay: { mode: "LIMITED", limitValue: "5" },
            spendPerMonth: { mode: "LIMITED", limitValue: "100" },
          },
        },
      ],
    });
    const persisted = await modules.prisma.modelPool.findFirstOrThrow({
      where: { userId: user.id, slug: `guarded-success-${suffix}` },
      include: {
        PoolMembers: { orderBy: { tier: "asc" } },
        ProviderBudgetPolicies: { include: { Rules: true } },
      },
    });
    expect(persisted).toMatchObject({
      protocolAdaptationEnabled: false,
      allowLossyDeveloperRoleCollapse: true,
      capacityContextMargin: 1_024,
      capacityBorrowPolicy: "NEVER",
      affinityEnabled: true,
      affinityTtlSeconds: 7_200,
      affinityMaxRecords: 20_000,
      affinityPrefixWeight: 110,
      affinityConversationWeight: 160,
      affinityConfirmedCacheWeight: 260,
      affinityLoadPenaltyWeight: 120,
    });
    expect(persisted.PoolMembers.find((member) => member.tier === "PRIMARY")).toMatchObject({
      capacityConcurrencyMode: "LIMITED",
      capacityConcurrencyLimit: 1,
      capacityReservedSlots: 0,
      capacityBorrowPolicy: "NEVER",
      capacityWaitBudgetMode: "LIMITED",
      capacityWaitBudgetMs: 15_000,
      capacityContextCeilingMode: "LIMITED",
      capacityContextCeiling: 31_744,
      capacityContextMargin: 1_024,
    });
    expect(persisted.ProviderBudgetPolicies).toHaveLength(1);
    expect(persisted.ProviderBudgetPolicies[0]?.Rules).toHaveLength(7);
    expect(
      persisted.ProviderBudgetPolicies[0]?.Rules.map((rule) => [
        rule.metric,
        rule.period,
        rule.mode,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ["CONCURRENCY", "PER_ATTEMPT", "LIMITED"],
        ["TOKENS", "PER_ATTEMPT", "LIMITED"],
        ["TOKENS", "UTC_DAY", "LIMITED"],
        ["TOKENS", "UTC_MONTH", "LIMITED"],
        ["TOKENS", "LIFETIME", "UNLIMITED"],
        ["SPEND", "UTC_DAY", "LIMITED"],
        ["SPEND", "UTC_MONTH", "LIMITED"],
      ]),
    );
    expect(
      await modules.prisma.inferenceCapacity.findUnique({
        where: { id: capacity.id },
        select: { countStrategy: true },
      }),
    ).toEqual({ countStrategy: "ENGINE_REPORTED" });
  });
});
