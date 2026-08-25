import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createRouterClient } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { Session } from "@ws-model-proxy/auth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Context } from "../context";

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("guarded pool setup with real PostgreSQL", () => {
  let modules:
    | {
        prisma: typeof import("@ws-model-proxy/db").default;
        router: typeof import("./forwarder-management");
      }
    | undefined;
  const userIds: string[] = [];

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    process.env.NODE_ENV = "test";
    const [db, router] = await Promise.all([
      import("@ws-model-proxy/db"),
      import("./forwarder-management"),
    ]);
    modules = { prisma: db.default, router };
  });

  afterAll(async () => {
    if (!modules) return;
    modules.router.setGuardedSetupTestFailureInjector(undefined);
    await modules.prisma.user.deleteMany({ where: { id: { in: userIds } } });
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
    userIds.push(user.id);
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
    await modules.prisma.executionTarget.create({
      data: {
        userId: user.id,
        kind: "DISCOVERED_MODEL",
        discoveredModelId: local.id,
        inferenceCapacityId: capacity.id,
      },
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
    const credential = await modules.prisma.providerCredential.create({
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
    await modules.prisma.providerAccount.update({
      where: { id: account.id },
      data: { currentCredentialId: credential.id, enabled: true },
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
        providerModels: [
          { providerModelId: provider.id, concurrencyLimit: 1, dailySpendLimit: "5" },
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
  });
});
