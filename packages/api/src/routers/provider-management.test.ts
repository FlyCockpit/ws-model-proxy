import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createRouterClient, type RouterClient } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { Session } from "@ws-model-proxy/auth";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../context";
import { CATALOG_CHARGE_RULES } from "../lib/provider-catalog-model";

const envMock = { enabled: false };
const egressMock = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    get WMP_PUBLIC_PROVIDER_EGRESS_ENABLED() {
      return envMock.enabled;
    },
    WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS: false,
    WMP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS: "v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  },
}));
vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return {
    default: mockDeep(),
    Prisma: { TransactionIsolationLevel: { Serializable: "Serializable" } },
  };
});
vi.mock("../lib/provider-egress", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/provider-egress")>()),
  providerHttpsRequest: egressMock.request,
}));

const { providerManagementRouter } = await import("./provider-management");
const { default: prisma } = await import("@ws-model-proxy/db");
const db = prisma as unknown as {
  $transaction: MockInstance;
  $queryRaw: MockInstance;
  $executeRaw: MockInstance;
  providerAccount: {
    create: MockInstance;
    findMany: MockInstance;
    findFirst: MockInstance;
    update: MockInstance;
    updateMany: MockInstance;
  };
  providerModel: {
    count: MockInstance;
    create: MockInstance;
    findMany: MockInstance;
    findFirst: MockInstance;
    update: MockInstance;
    updateMany: MockInstance;
  };
  providerPricingVersion: {
    create: MockInstance;
    delete: MockInstance;
    findFirst: MockInstance;
    findMany: MockInstance;
    update: MockInstance;
    updateMany: MockInstance;
  };
  executionTarget: { create: MockInstance; findUnique: MockInstance };
  inferenceCapacity: { updateMany: MockInstance };
  modelPool: { findFirst: MockInstance; findMany: MockInstance };
  poolMember: { findMany: MockInstance };
  providerCredential: {
    count: MockInstance;
    create: MockInstance;
    findFirst: MockInstance;
    findMany: MockInstance;
    updateMany: MockInstance;
  };
  providerAuditEvent: { create: MockInstance; findMany: MockInstance };
  providerBudgetPolicy: {
    create: MockInstance;
    findMany: MockInstance;
    findFirst: MockInstance;
    updateMany: MockInstance;
  };
  providerUsageLedger: { findMany: MockInstance; groupBy: MockInstance; count: MockInstance };
  providerBudgetReservation: { findMany: MockInstance };
  providerBudgetSettlement: { findMany: MockInstance };
  publicProviderAttemptEvent: { findMany: MockInstance };
  providerAttempt: { findMany: MockInstance };
};

const session = {
  user: {
    id: "owner",
    email: "owner@example.com",
    name: "Owner",
    emailVerified: true,
    role: "user",
    twoFactorEnabled: false,
    image: null,
    banned: false,
    banReason: null,
    banExpires: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  session: {
    id: "session",
    userId: "owner",
    token: "token",
    expiresAt: new Date(Date.now() + 60_000),
    ipAddress: null,
    userAgent: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
} as Session;
const context: Context = { session, services: undefined };

function createHttpClient(
  rpcContext: Context = context,
  captures?: Array<{ status: number; body: string }>,
) {
  const handler = new RPCHandler(providerManagementRouter);
  const link = new RPCLink({
    url: "https://example.test/rpc",
    fetch: async (request, init) => {
      const result = await handler.handle(new Request(request, init), {
        prefix: "/rpc",
        context: rpcContext,
      });
      if (!result.matched) return new Response(null, { status: 404 });
      if (captures)
        captures.push({
          status: result.response.status,
          body: await result.response.clone().text(),
        });
      return result.response;
    },
  });
  return createORPCClient(link) as RouterClient<typeof providerManagementRouter>;
}

const isFenceCall = (call: unknown[]) =>
  (call[0] as readonly string[]).join("?").includes("wsmp_acquire_fences");

/**
 * Writer class M: the first `$queryRaw` takes the caller's owner fence, every
 * further fence (`laterFences`, in call order) precedes the first row lock,
 * and `rowLocks` row-lock statements follow.
 */
function expectOwnerFenceThenRowLocks(rowLocks: number, laterFences: string[][] = []) {
  const calls = db.$queryRaw.mock.calls as unknown[][];
  expect(calls[0] && isFenceCall(calls[0])).toBe(true);
  const fenceArrays = calls.filter(isFenceCall).map((call) => call[1]);
  expect(fenceArrays).toEqual([["00:owner:owner"], ...laterFences]);
  const firstRowLock = calls.findIndex((call) => !isFenceCall(call));
  const lastFence = calls.findLastIndex(isFenceCall);
  if (firstRowLock !== -1) expect(lastFence).toBeLessThan(firstRowLock);
  expect(calls.filter((call) => !isFenceCall(call))).toHaveLength(rowLocks);
  // No advisory lock outside wsmp_acquire_fences.
  expect(db.$executeRaw).not.toHaveBeenCalled();
}

describe("providerManagementRouter security boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envMock.enabled = false;
    egressMock.request.mockReset();
    db.$transaction.mockImplementation(async (callback: (tx: typeof db) => unknown) =>
      callback(db),
    );
  });

  const newAccount = {
    providerType: "openai",
    label: "Provider",
    baseUrl: "https://api.example.test/v1",
    authType: "BEARER" as const,
  };

  it("hides provider creation and credential tests while the switch is off and still requires authentication", async () => {
    const client = createRouterClient(providerManagementRouter, { context });
    await expect(client.createAccount(newAccount)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(client.testCredential({ providerAccountId: "account" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const anonymous = createRouterClient(providerManagementRouter, {
      context: { session: null, services: undefined },
    });
    await expect(anonymous.listAccounts()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(egressMock.request).not.toHaveBeenCalled();
  });

  it("keeps stored provider keys viewable, revocable, and deletable while the switch is off", async () => {
    db.providerAccount.findMany.mockResolvedValue([]);
    const client = createRouterClient(providerManagementRouter, { context });
    await expect(client.listAccounts()).resolves.toEqual([]);
    expect(db.providerAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "owner", deletedAt: null } }),
    );
    // Revoke and delete are not hidden behind the switch: an unknown account
    // is a plain owner-scoped NOT_FOUND from the procedure itself.
    db.providerAccount.findFirst.mockResolvedValue(null);
    await expect(client.deleteAccount({ id: "missing-account" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(db.$transaction).toHaveBeenCalled();
    expect(egressMock.request).not.toHaveBeenCalled();
  });

  it("enforces the same disabled gate through the HTTP RPC transport", async () => {
    const handler = new RPCHandler(providerManagementRouter);
    const link = new RPCLink({
      url: "https://example.test/rpc",
      fetch: async (request, init) => {
        const result = await handler.handle(new Request(request, init), {
          prefix: "/rpc",
          context,
        });
        if (!result.matched) return new Response(null, { status: 404 });
        return result.response;
      },
    });
    const client = createORPCClient(link) as RouterClient<typeof providerManagementRouter>;
    await expect(client.createAccount(newAccount)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.providerAccount.create).not.toHaveBeenCalled();
  });

  it("enforces authentication through the HTTP RPC transport when provider egress is enabled", async () => {
    envMock.enabled = true;
    const handler = new RPCHandler(providerManagementRouter);
    const link = new RPCLink({
      url: "https://example.test/rpc",
      fetch: async (request, init) => {
        const result = await handler.handle(new Request(request, init), {
          prefix: "/rpc",
          context: { session: null, services: undefined },
        });
        if (!result.matched) return new Response(null, { status: 404 });
        return result.response;
      },
    });
    const client = createORPCClient(link) as RouterClient<typeof providerManagementRouter>;
    await expect(client.listAccounts()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(db.providerAccount.findMany).not.toHaveBeenCalled();
  });

  it("returns a generic HTTP NOT_FOUND for guessed owner and pool report filters", async () => {
    envMock.enabled = true;
    db.providerAccount.findFirst.mockResolvedValue(null);
    db.modelPool.findFirst.mockResolvedValue(null);
    const handler = new RPCHandler(providerManagementRouter);
    const link = new RPCLink({
      url: "https://example.test/rpc",
      fetch: async (request, init) => {
        const result = await handler.handle(new Request(request, init), {
          prefix: "/rpc",
          context,
        });
        if (!result.matched) return new Response(null, { status: 404 });
        return result.response;
      },
    });
    const client = createORPCClient(link) as RouterClient<typeof providerManagementRouter>;
    await expect(
      client.listUsageReportPage({ providerAccountId: "foreign-account" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Not found" });
    await expect(client.listProviderAttempts({ poolId: "foreign-pool" })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Not found",
    });
    expect(db.providerUsageLedger.findMany).not.toHaveBeenCalled();
    expect(db.providerAttempt.findMany).not.toHaveBeenCalled();
  });

  it("returns non-enumerating HTTP errors for guessed provider graph resources", async () => {
    envMock.enabled = true;
    db.providerAccount.findFirst.mockResolvedValue(null);
    db.providerModel.findFirst.mockResolvedValue(null);
    db.providerPricingVersion.findFirst.mockResolvedValue(null);
    db.providerCredential.findFirst.mockResolvedValue(null);
    db.providerBudgetPolicy.findFirst.mockResolvedValue(null);
    db.modelPool.findFirst.mockResolvedValue(null);
    const captures: Array<{ status: number; body: string }> = [];
    const client = createHttpClient(context, captures);
    const credential = "must-not-appear-in-an-error-body";
    const limitedRule = {
      metric: "CONCURRENCY" as const,
      period: "PER_ATTEMPT" as const,
      mode: "LIMITED" as const,
      limitValue: "1",
      currency: null,
    };
    const attempts = [
      client.updateAccount({ id: "foreign-account", label: "guess" }),
      client.setAccountEnabled({ id: "foreign-account", enabled: true }),
      client.deleteAccount({ id: "foreign-account" }),
      client.listModels({ providerAccountId: "foreign-account" }),
      client.createModel({
        providerAccountId: "foreign-account",
        upstreamModelId: "foreign-model",
        enabled: false,
      }),
      client.updateModel({ id: "foreign-model", displayName: "guess" }),
      client.deleteModel({ id: "foreign-model" }),
      client.listPricingVersions({ providerModelId: "foreign-model" }),
      client.createPricingVersion({
        providerModelId: "foreign-model",
        version: "v1",
        currency: "USD",
        accountingVersion: "v1",
        confidence: "CALCULATED",
        ratesPerMillion: { input: "1", output: "1" },
        chargeRules: {
          inputIncludesCacheRead: false,
          inputIncludesCacheWrite: false,
          outputIncludesReasoning: false,
          outputIncludesTool: false,
          reasoningAllowanceTokens: 0,
          toolAllowanceTokens: 0,
          cacheReadAllowanceTokens: 0,
          cacheWriteAllowanceTokens: 0,
          additionalAllowanceTokens: 0,
          unknownCategories: "FAIL_CLOSED",
        },
        effectiveAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
      client.updatePricingVersion({ id: "foreign-pricing", currency: "EUR" }),
      client.activatePricingVersion({ id: "foreign-pricing" }),
      client.retirePricingVersion({ id: "foreign-pricing" }),
      client.deletePricingVersion({ id: "foreign-pricing" }),
      client.listCredentials({ providerAccountId: "foreign-account" }),
      client.createCredential({ providerAccountId: "foreign-account", credential }),
      client.replaceCredential({ providerAccountId: "foreign-account", credential }),
      client.revokeCredential({ id: "foreign-credential" }),
      client.rotateCredential({ id: "foreign-credential" }),
      client.testCredential({ providerAccountId: "foreign-account" }),
      client.repairExpiredAttempts({ providerAccountId: "foreign-account" }),
      client.listAuditEvents({ providerAccountId: "foreign-account", limit: 10 }),
      client.listAuditEvents({ poolId: "foreign-pool", limit: 10 }),
      client.listUsageReport({ providerAccountId: "foreign-account", limit: 10 }),
      client.listBudgetActivity({ providerAccountId: "foreign-account", limit: 10 }),
      client.listProviderAttemptEvents({ providerAccountId: "foreign-account", limit: 10 }),
      client.listUsageReportPage({ providerAccountId: "foreign-account", limit: 10 }),
      client.getUsageTotals({ providerAccountId: "foreign-account", limit: 10 }),
      client.listProviderAttempts({ providerAccountId: "foreign-account", limit: 10 }),
      client.createBudgetPolicy({
        scopeType: "POOL_PROVIDER_MODEL",
        providerAccountId: "foreign-account",
        providerModelId: "foreign-model",
        poolId: "foreign-pool",
        active: false,
        rules: [limitedRule],
      }),
      client.replaceBudgetPolicy({
        id: "foreign-budget",
        active: false,
        rules: [limitedRule],
      }),
      client.deactivateBudgetPolicy({ id: "foreign-budget" }),
    ];
    const results = await Promise.allSettled(attempts);
    expect(results).toHaveLength(attempts.length);
    for (const [index, result] of results.entries()) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected")
        expect(result.reason, `request ${index}`).toMatchObject({
          code: "NOT_FOUND",
          message: "Not found",
        });
    }
    expect(captures).toHaveLength(attempts.length);
    for (const capture of captures) {
      expect(capture.status).toBe(404);
      expect(capture.body).toContain("NOT_FOUND");
      for (const forbidden of [
        credential,
        "foreign-account",
        "foreign-model",
        "foreign-pricing",
        "foreign-credential",
        "foreign-budget",
      ])
        expect(capture.body).not.toContain(forbidden);
    }
    expect(db.executionTarget.create).not.toHaveBeenCalled();
  });

  it("rechecks the locked account inside createModel and loses a race with account deletion", async () => {
    envMock.enabled = true;
    db.$queryRaw.mockResolvedValue([]);
    db.providerAccount.findFirst.mockResolvedValue(null);
    const client = createRouterClient(providerManagementRouter, { context });
    await expect(
      client.createModel({
        providerAccountId: "deleted-account",
        upstreamModelId: "model",
        enabled: false,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expectOwnerFenceThenRowLocks(1);
    expect(db.providerModel.create).not.toHaveBeenCalled();
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
      maxWait: 5_000,
      timeout: 10_000,
    });
  });

  it("locks the owning account first and denies updateModel after account deletion", async () => {
    envMock.enabled = true;
    db.$queryRaw.mockResolvedValue([]);
    db.providerModel.findFirst.mockResolvedValue(null);
    const client = createRouterClient(providerManagementRouter, { context });
    await expect(client.updateModel({ id: "model", enabled: true })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    // Owner fence, then the provider-model identity fence (no policy edit,
    // so no capacity fences), then the account and model rows.
    expectOwnerFenceThenRowLocks(2, [["02:execution-target:provider-model:model"]]);
    expect(db.providerModel.update).not.toHaveBeenCalled();
    expect(db.providerAccount.findFirst).not.toHaveBeenCalled();
  });

  it("updates a full owner-scoped v4 capability inventory", async () => {
    envMock.enabled = true;
    db.$queryRaw.mockResolvedValue([]);
    db.providerModel.findFirst.mockResolvedValue({ id: "model", providerAccountId: "account" });
    db.providerAccount.findFirst.mockResolvedValue({ id: "account", providerType: "openai" });
    db.providerModel.update.mockResolvedValue({ id: "model" });
    db.providerAuditEvent.create.mockResolvedValue({ id: "audit" });
    const nativeCapabilities = {
      version: 4 as const,
      protocol: "openai-compatible" as const,
      surfaces: {
        openaiChatCompletions: {
          source: "dashboard" as const,
          confidence: "exact" as const,
          operations: ["create" as const],
          tools: true,
          parallelTools: true,
        },
        openaiResponses: {
          source: "dashboard" as const,
          confidence: "exact" as const,
          operations: ["create" as const, "retrieve" as const, "countTokens" as const],
          structuredOutput: true,
          reasoning: true,
          hostedTools: true,
          maxContextTokens: 128_000,
        },
      },
    };
    const client = createRouterClient(providerManagementRouter, { context });
    await client.updateModel({ id: "model", nativeCapabilities });
    expect(db.providerModel.update).toHaveBeenCalledWith({
      where: { id: "model" },
      data: { nativeCapabilities },
      select: expect.any(Object),
    });
  });

  it("atomically synchronizes attached provider concurrency and context capacity", async () => {
    envMock.enabled = true;
    db.$queryRaw.mockResolvedValue([]);
    db.providerModel.findFirst.mockResolvedValue({
      id: "model",
      providerAccountId: "account",
      concurrencyLimit: 4,
      contextWindow: 32_768,
    });
    db.providerAccount.findFirst.mockResolvedValue({ id: "account", providerType: "openai" });
    db.executionTarget.findUnique.mockResolvedValue({
      id: "target",
      inferenceCapacityId: "capacity",
      directConcurrencyLimit: 2,
      directReservedSlots: 1,
      directContextCeiling: 16_000,
      directContextMargin: 384,
      PoolMembers: [],
    });
    db.providerModel.update.mockResolvedValue({ id: "model" });
    db.inferenceCapacity.updateMany.mockResolvedValue({ count: 1 });
    db.providerAuditEvent.create.mockResolvedValue({ id: "audit" });
    const client = createRouterClient(providerManagementRouter, { context });

    await client.updateModel({ id: "model", concurrencyLimit: 8, contextWindow: 65_536 });

    // A limit edit: owner fence, then identity, target capacity-policy and
    // capacity fences in one ascending call, all before the account row (no
    // inference_capacity row lock).
    const calls = db.$queryRaw.mock.calls as unknown[][];
    expect(calls.filter(isFenceCall).map((call) => call[1])).toEqual([
      ["00:owner:owner"],
      [
        "02:execution-target:provider-model:model",
        "06:capacity-policy:target",
        "08:capacity:capacity",
      ],
    ]);
    expect(calls.findLastIndex(isFenceCall)).toBeLessThan(
      calls.findIndex((call) => !isFenceCall(call)),
    );
    expect(
      calls.some((call) => (call[0] as readonly string[]).join("?").includes("inference_capacity")),
    ).toBe(false);
    expect(db.inferenceCapacity.updateMany).toHaveBeenCalledWith({
      where: { id: "capacity", userId: "owner" },
      data: {
        hardConcurrencyLimit: 8,
        hardConcurrencyLimitSource: "USER",
        physicalMaxContext: 65_536,
      },
    });
    expect(db.providerAuditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "MODEL_UPDATED",
          metadata: expect.objectContaining({
            previousConcurrencyLimit: 4,
            nextConcurrencyLimit: 8,
            previousContextWindow: 32_768,
            nextContextWindow: 65_536,
          }),
        }),
      }),
    );
  });

  it("rejects provider reductions below inherited pool concurrency or context policy", async () => {
    envMock.enabled = true;
    db.$queryRaw.mockResolvedValue([]);
    db.providerModel.findFirst.mockResolvedValue({
      id: "model",
      providerAccountId: "account",
      concurrencyLimit: 8,
      contextWindow: 65_536,
    });
    db.providerAccount.findFirst.mockResolvedValue({ id: "account", providerType: "openai" });
    db.executionTarget.findUnique.mockResolvedValue({
      id: "target",
      inferenceCapacityId: "capacity",
      directConcurrencyLimit: null,
      directReservedSlots: 0,
      directContextCeiling: null,
      directContextMargin: 0,
      PoolMembers: [
        {
          capacityConcurrencyMode: "INHERIT",
          capacityConcurrencyLimit: null,
          capacityReservedSlots: null,
          capacityContextCeilingMode: "INHERIT",
          capacityContextCeiling: null,
          capacityContextMargin: null,
          ModelPool: {
            capacityConcurrencyLimit: 6,
            capacityReservedSlots: 2,
            capacityContextCeiling: 48_000,
            capacityContextMargin: 1_000,
          },
        },
      ],
    });
    const client = createRouterClient(providerManagementRouter, { context });

    await expect(client.updateModel({ id: "model", concurrencyLimit: 5 })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    await expect(client.updateModel({ id: "model", contextWindow: 48_000 })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect(db.providerModel.update).not.toHaveBeenCalled();
    expect(db.inferenceCapacity.updateMany).not.toHaveBeenCalled();
  });

  it("allows unattached provider capacity edits without creating a capacity snapshot", async () => {
    envMock.enabled = true;
    db.$queryRaw.mockResolvedValue([]);
    db.providerModel.findFirst.mockResolvedValue({
      id: "model",
      providerAccountId: "account",
      concurrencyLimit: null,
      contextWindow: null,
    });
    db.providerAccount.findFirst.mockResolvedValue({ id: "account", providerType: "openai" });
    db.executionTarget.findUnique.mockResolvedValue({
      id: "target",
      inferenceCapacityId: null,
      PoolMembers: [],
    });
    db.providerModel.update.mockResolvedValue({ id: "model" });
    db.providerAuditEvent.create.mockResolvedValue({ id: "audit" });
    const client = createRouterClient(providerManagementRouter, { context });

    await client.updateModel({ id: "model", concurrencyLimit: 3, contextWindow: 8_192 });
    expect(db.inferenceCapacity.updateMany).not.toHaveBeenCalled();
  });

  it("rejects reducing provider concurrency below active database leases", async () => {
    envMock.enabled = true;
    db.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 3n }]);
    db.providerModel.findFirst.mockResolvedValue({
      id: "model",
      providerAccountId: "account",
      concurrencyLimit: 4,
      contextWindow: 32_768,
    });
    db.providerAccount.findFirst.mockResolvedValue({ id: "account", providerType: "openai" });
    db.executionTarget.findUnique.mockResolvedValue({
      id: "target",
      inferenceCapacityId: "capacity",
      directConcurrencyLimit: null,
      directReservedSlots: 0,
      directContextCeiling: null,
      directContextMargin: 0,
      PoolMembers: [],
    });
    const client = createRouterClient(providerManagementRouter, { context });

    await expect(client.updateModel({ id: "model", concurrencyLimit: 2 })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect(db.inferenceCapacity.updateMany).not.toHaveBeenCalled();
    expect(db.providerModel.update).not.toHaveBeenCalled();
  });

  it("rejects create and update inventories whose protocol disagrees with provider type", async () => {
    envMock.enabled = true;
    db.$queryRaw.mockResolvedValue([]);
    db.providerAccount.findFirst.mockResolvedValue({ id: "account", providerType: "anthropic" });
    db.providerModel.findFirst.mockResolvedValue({ id: "model", providerAccountId: "account" });
    const nativeCapabilities = {
      version: 4 as const,
      protocol: "openai-compatible" as const,
      surfaces: {
        openaiResponses: {
          source: "dashboard" as const,
          confidence: "exact" as const,
          operations: ["create" as const],
        },
      },
    };
    const client = createRouterClient(providerManagementRouter, { context });
    await expect(
      client.createModel({
        providerAccountId: "account",
        upstreamModelId: "model",
        nativeCapabilities,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(client.updateModel({ id: "model", nativeCapabilities })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(db.providerModel.create).not.toHaveBeenCalled();
    expect(db.providerModel.update).not.toHaveBeenCalled();

    db.providerAccount.findFirst.mockResolvedValue({
      id: "account",
      providerType: "unknown-provider",
    });
    await expect(
      client.createModel({ providerAccountId: "account", upstreamModelId: "model" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      client.updateModel({ id: "model", nativeCapabilities: null }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("creates, reads, updates, and clears an owner capability inventory", async () => {
    envMock.enabled = true;
    db.$queryRaw.mockResolvedValue([]);
    db.providerAccount.findFirst.mockResolvedValue({ id: "account", providerType: "openai" });
    const nativeCapabilities = {
      version: 4 as const,
      protocol: "openai-compatible" as const,
      surfaces: {
        openaiResponses: {
          source: "dashboard" as const,
          confidence: "exact" as const,
          operations: ["create" as const, "retrieve" as const],
        },
      },
    };
    db.providerModel.create.mockResolvedValue({ id: "model", nativeCapabilities });
    db.executionTarget.create.mockResolvedValue({ id: "target" });
    db.providerAuditEvent.create.mockResolvedValue({ id: "audit" });
    const client = createRouterClient(providerManagementRouter, { context });
    await client.createModel({
      providerAccountId: "account",
      upstreamModelId: "model",
      nativeCapabilities,
    });
    expect(db.providerModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ nativeCapabilities }) }),
    );

    db.providerModel.findMany.mockResolvedValue([{ id: "model", nativeCapabilities }]);
    await expect(client.listModels({ providerAccountId: "account" })).resolves.toEqual([
      { id: "model", nativeCapabilities },
    ]);

    db.providerModel.findFirst.mockResolvedValue({ id: "model", providerAccountId: "account" });
    db.providerModel.update.mockResolvedValue({ id: "model", nativeCapabilities: null });
    await client.updateModel({ id: "model", nativeCapabilities: null });
    expect(db.providerModel.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { nativeCapabilities: null } }),
    );
  });

  it("creates owner-scoped draft pricing with explicit accounting rules and audit", async () => {
    envMock.enabled = true;
    db.$queryRaw.mockResolvedValue([{ id: "locked-parent" }]);
    db.providerModel.findFirst.mockResolvedValue({ id: "model", providerAccountId: "account" });
    db.providerPricingVersion.create.mockResolvedValue({
      id: "price",
      version: "price-v1",
      status: "DRAFT",
    });
    db.providerAuditEvent.create.mockResolvedValue({ id: "audit" });
    const client = createRouterClient(providerManagementRouter, { context });
    await client.createPricingVersion({
      providerModelId: "model",
      version: "price-v1",
      currency: "USD",
      accountingVersion: "provider-billable-v2",
      confidence: "CALCULATED",
      ratesPerMillion: { input: "1", output: "4", cacheRead: "0.25" },
      chargeRules: {
        inputIncludesCacheRead: false,
        inputIncludesCacheWrite: false,
        outputIncludesReasoning: false,
        outputIncludesTool: false,
        cacheReadAllowanceTokens: 1000,
        cacheWriteAllowanceTokens: 0,
        additionalAllowanceTokens: 0,
        reasoningAllowanceTokens: 0,
        toolAllowanceTokens: 0,
        unknownCategories: "FAIL_CLOSED",
      },
      effectiveAt: new Date("2026-08-25T00:00:00Z"),
    });
    expect(db.providerModel.findFirst).toHaveBeenCalledWith({
      where: {
        id: "model",
        userId: "owner",
        deletedAt: null,
        ProviderAccount: { deletedAt: null },
      },
      select: { id: true, providerAccountId: true },
    });
    expect(db.providerPricingVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "owner",
        providerAccountId: "account",
        providerModelId: "model",
        accountingVersion: "provider-billable-v2",
        chargeRules: expect.objectContaining({ unknownCategories: "FAIL_CLOSED" }),
      }),
      select: expect.any(Object),
    });
    expect(db.providerAuditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "PRICING_CREATED", subjectId: "price" }),
    });
  });

  it("does not allow activated pricing billing fields through the draft update API", async () => {
    envMock.enabled = true;
    db.providerPricingVersion.findFirst.mockResolvedValue(null);
    const client = createRouterClient(providerManagementRouter, { context });
    await expect(
      client.updatePricingVersion({ id: "active-price", currency: "EUR" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.providerPricingVersion.findFirst).toHaveBeenCalledWith({
      where: {
        id: "active-price",
        userId: "owner",
        status: "DRAFT",
        ProviderModel: { deletedAt: null, ProviderAccount: { deletedAt: null } },
      },
    });
    expect(db.providerPricingVersion.update).not.toHaveBeenCalled();
  });

  it("denies retiring or deleting pricing below a deleted provider graph", async () => {
    envMock.enabled = true;
    db.providerPricingVersion.findFirst.mockResolvedValue(null);
    const client = createRouterClient(providerManagementRouter, { context });
    await expect(client.retirePricingVersion({ id: "orphaned-active" })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Not found",
    });
    await expect(client.deletePricingVersion({ id: "orphaned-draft" })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Not found",
    });
    expect(db.providerPricingVersion.findFirst).toHaveBeenNthCalledWith(1, {
      where: {
        id: "orphaned-active",
        userId: "owner",
        status: "ACTIVE",
        ProviderModel: { deletedAt: null, ProviderAccount: { deletedAt: null } },
      },
    });
    expect(db.providerPricingVersion.findFirst).toHaveBeenNthCalledWith(2, {
      where: {
        id: "orphaned-draft",
        userId: "owner",
        status: "DRAFT",
        ProviderModel: { deletedAt: null, ProviderAccount: { deletedAt: null } },
      },
    });
    expect(db.providerPricingVersion.update).not.toHaveBeenCalled();
    expect(db.providerPricingVersion.delete).not.toHaveBeenCalled();
  });

  it("denies a budget policy whose model is deleted or belongs to another account", async () => {
    envMock.enabled = true;
    db.$queryRaw.mockResolvedValue([{ id: "account" }]);
    db.providerAccount.findFirst.mockResolvedValue({ id: "account" });
    db.providerModel.findFirst.mockResolvedValue(null);
    const client = createRouterClient(providerManagementRouter, { context });
    await expect(
      client.createBudgetPolicy({
        scopeType: "POOL_PROVIDER_MODEL",
        providerAccountId: "account",
        providerModelId: "foreign-or-deleted-model",
        poolId: "pool",
        active: false,
        rules: [
          {
            metric: "CONCURRENCY",
            period: "PER_ATTEMPT",
            mode: "LIMITED",
            limitValue: "1",
            currency: null,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.providerModel.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "foreign-or-deleted-model",
        userId: "owner",
        providerAccountId: "account",
        deletedAt: null,
      }),
      select: { id: true },
    });
    expect(db.modelPool.findFirst).not.toHaveBeenCalled();
    expect(db.providerBudgetPolicy.create).not.toHaveBeenCalled();
  });

  it("audits an explicit UNLIMITED choice with only safe rule identity", async () => {
    envMock.enabled = true;
    db.$queryRaw.mockResolvedValue([{ id: "account" }]);
    db.providerAccount.findFirst.mockResolvedValue({ id: "account" });
    db.providerBudgetPolicy.create.mockResolvedValue({ id: "policy", Rules: [] });
    db.providerAuditEvent.create.mockResolvedValue({ id: "audit" });
    const client = createRouterClient(providerManagementRouter, { context });
    await client.createBudgetPolicy({
      scopeType: "PROVIDER_ACCOUNT",
      providerAccountId: "account",
      providerModelId: null,
      poolId: null,
      active: true,
      rules: [
        {
          metric: "CONCURRENCY",
          period: "PER_ATTEMPT",
          mode: "UNLIMITED",
          limitValue: null,
          currency: null,
        },
      ],
    });
    expect(db.providerAuditEvent.create).toHaveBeenCalledWith({
      data: {
        userId: "owner",
        providerAccountId: "account",
        action: "BUDGET_CREATED",
        subjectId: "policy",
        metadata: {
          unlimitedRules: [{ metric: "CONCURRENCY", period: "PER_ATTEMPT" }],
        },
      },
    });
  });

  it("owner-scopes audit history and never returns credential envelopes", async () => {
    envMock.enabled = true;
    db.providerAuditEvent.findMany.mockResolvedValue([
      { id: "audit", action: "CREDENTIAL_CREATED" },
    ]);
    const client = createRouterClient(providerManagementRouter, { context });
    await expect(client.listAuditEvents({ limit: 25 })).resolves.toEqual([
      { id: "audit", action: "CREDENTIAL_CREATED" },
    ]);
    expect(db.providerAuditEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "owner" },
        select: expect.not.objectContaining({ ciphertext: true, nonce: true, authTag: true }),
      }),
    );
  });

  it("lists one owned pool's fallback history (pool events carry no provider account)", async () => {
    envMock.enabled = false;
    db.modelPool.findFirst.mockResolvedValue({ id: "pool" });
    db.providerAuditEvent.findMany.mockResolvedValue([
      { id: "audit", action: "POOL_FALLBACK_UPDATED" },
    ]);
    const client = createRouterClient(providerManagementRouter, { context });
    await expect(client.listAuditEvents({ poolId: "pool", limit: 10 })).resolves.toEqual([
      { id: "audit", action: "POOL_FALLBACK_UPDATED" },
    ]);
    expect(db.modelPool.findFirst).toHaveBeenCalledWith({
      where: { id: "pool", userId: "owner" },
      select: { id: true },
    });
    expect(db.providerAuditEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "owner", action: "POOL_FALLBACK_UPDATED", subjectId: "pool" },
        take: 10,
      }),
    );
  });

  it("owner-scopes usage reports, validates nested filters, and excludes provider payloads", async () => {
    envMock.enabled = true;
    db.providerAccount.findFirst.mockResolvedValue({ id: "account" });
    db.providerModel.findFirst.mockResolvedValue({ id: "model" });
    db.modelPool.findFirst.mockResolvedValue({ id: "pool" });
    db.providerUsageLedger.findMany.mockResolvedValue([{ id: "usage" }]);
    const client = createRouterClient(providerManagementRouter, { context });
    await expect(
      client.listUsageReport({
        providerAccountId: "account",
        providerModelId: "model",
        poolId: "pool",
        from: new Date("2026-08-01T00:00:00Z"),
        to: new Date("2026-09-01T00:00:00Z"),
        limit: 25,
      }),
    ).resolves.toEqual([{ id: "usage" }]);
    expect(db.providerModel.findFirst).toHaveBeenCalledWith({
      where: {
        id: "model",
        userId: "owner",
        providerAccountId: "account",
      },
      select: { id: true },
    });
    expect(db.modelPool.findFirst).toHaveBeenCalledWith({
      where: { id: "pool", userId: "owner" },
      select: { id: true },
    });
    expect(db.providerUsageLedger.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "owner",
          providerAccountId: "account",
          providerModelId: "model",
          poolId: "pool",
        }),
        select: expect.not.objectContaining({
          rawUsage: true,
          credentialId: true,
          payloadHash: true,
        }),
        take: 25,
      }),
    );
  });

  it("fails closed before reporting when a nested model belongs to another account", async () => {
    envMock.enabled = true;
    db.providerAccount.findFirst.mockResolvedValue({ id: "account" });
    db.providerModel.findFirst.mockResolvedValue(null);
    const client = createRouterClient(providerManagementRouter, { context });
    await expect(
      client.listUsageReport({
        providerAccountId: "account",
        providerModelId: "foreign-model",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Not found" });
    expect(db.providerUsageLedger.findMany).not.toHaveBeenCalled();
  });

  it("keeps deleted-account audit and accounting history owner-accessible", async () => {
    envMock.enabled = true;
    db.providerAccount.findFirst.mockResolvedValue({ id: "deleted-account" });
    db.providerAuditEvent.findMany.mockResolvedValue([]);
    db.providerUsageLedger.findMany.mockResolvedValue([]);
    const client = createRouterClient(providerManagementRouter, { context });
    await expect(
      client.listAuditEvents({ providerAccountId: "deleted-account", limit: 10 }),
    ).resolves.toEqual([]);
    await expect(
      client.listUsageReport({ providerAccountId: "deleted-account", limit: 10 }),
    ).resolves.toEqual([]);
    expect(db.providerAccount.findFirst).toHaveBeenCalledWith({
      where: { id: "deleted-account", userId: "owner" },
      select: { id: true },
    });
  });

  it("returns owner-scoped budget reporting with the invoice caveat and no credential IDs", async () => {
    envMock.enabled = true;
    db.providerBudgetReservation.findMany.mockResolvedValue([{ id: "reservation" }]);
    db.providerBudgetSettlement.findMany.mockResolvedValue([{ id: "settlement" }]);
    const client = createRouterClient(providerManagementRouter, { context });
    const result = await client.listBudgetActivity({ limit: 10 });
    expect(result).toEqual({
      reservations: [{ id: "reservation" }],
      settlements: [{ id: "settlement" }],
      caveats: [
        "FAILED_OR_CANCELLED_MAY_BILL",
        "USAGE_CATEGORIES_MAY_BE_OMITTED",
        "STREAM_FINAL_USAGE_MAY_BE_MISSING",
        "PRICING_MAY_CHANGE",
        "FX_IS_INEXACT_AND_NOT_CONVERTED",
        "INVOICES_ARE_AUTHORITATIVE",
        "BUDGETS_ARE_NOT_GUARANTEED_CAPS",
      ],
    });
    for (const call of [
      db.providerBudgetReservation.findMany.mock.calls[0]?.[0],
      db.providerBudgetSettlement.findMany.mock.calls[0]?.[0],
    ]) {
      expect(call.where).toEqual({ userId: "owner" });
      expect(call.select).not.toEqual(expect.objectContaining({ credentialId: true }));
      expect(call.take).toBe(10);
    }
  });

  it("reports only safe owner-scoped attempt telemetry", async () => {
    envMock.enabled = true;
    db.publicProviderAttemptEvent.findMany.mockResolvedValue([{ id: "event" }]);
    const client = createRouterClient(providerManagementRouter, { context });
    await expect(client.listProviderAttemptEvents({ limit: 5 })).resolves.toEqual([
      { id: "event" },
    ]);
    expect(db.publicProviderAttemptEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "owner" },
        select: expect.not.objectContaining({
          usage: true,
          metadata: true,
          reservationIds: true,
        }),
        take: 5,
      }),
    );
  });

  it("serializes credential creation on the account and never reflects plaintext", async () => {
    envMock.enabled = true;
    db.$queryRaw.mockResolvedValue([{ id: "account" }]);
    db.providerAccount.findFirst.mockResolvedValue({
      id: "account",
      userId: "owner",
      deletedAt: null,
      authType: "BEARER",
      currentCredentialId: null,
    });
    db.providerCredential.create.mockResolvedValue({
      id: "credential",
      createdAt: new Date(0),
      credentialType: "BEARER",
      keyVersion: "v1",
      displaySuffix: "alue",
      status: "ACTIVE",
    });
    db.providerAccount.update.mockResolvedValue({ id: "account" });
    db.providerAuditEvent.create.mockResolvedValue({ id: "audit" });
    const client = createRouterClient(providerManagementRouter, { context });
    const result = await client.createCredential({
      providerAccountId: "account",
      credential: "super-secret-value",
    });
    expectOwnerFenceThenRowLocks(1);
    expect(JSON.stringify(result)).not.toContain("super-secret-value");
    const write = db.providerCredential.create.mock.calls[0]?.[0];
    expect(JSON.stringify(write)).not.toContain("super-secret-value");
    expect(write.data.ciphertext).toBeInstanceOf(Uint8Array);
  });

  it("lists only credential lifecycle metadata for a live owned account", async () => {
    envMock.enabled = true;
    db.providerAccount.findFirst.mockResolvedValue({ id: "account" });
    db.providerCredential.findMany.mockResolvedValue([{ id: "credential" }]);
    const client = createRouterClient(providerManagementRouter, { context });
    await expect(client.listCredentials({ providerAccountId: "account" })).resolves.toEqual([
      { id: "credential" },
    ]);
    expect(db.providerCredential.findMany).toHaveBeenCalledWith({
      where: { userId: "owner", providerAccountId: "account" },
      select: expect.not.objectContaining({
        ciphertext: true,
        nonce: true,
        authTag: true,
      }),
    });
  });

  it("requires credential cleanup before an authentication-type change", async () => {
    envMock.enabled = true;
    db.providerAccount.findFirst.mockResolvedValue({
      id: "account",
      userId: "owner",
      deletedAt: null,
      authType: "BEARER",
      providerType: "openai",
    });
    db.providerCredential.count.mockResolvedValue(1);
    const client = createRouterClient(providerManagementRouter, { context });
    await expect(
      client.updateAccount({ id: "account", authType: "API_KEY" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expectOwnerFenceThenRowLocks(1);
    expect(db.providerCredential.count).toHaveBeenCalledWith({
      where: { userId: "owner", providerAccountId: "account" },
    });
    expect(db.providerAccount.updateMany).not.toHaveBeenCalled();
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
      maxWait: 5_000,
      timeout: 10_000,
    });
  });

  it("rechecks updateAccount ownership and liveness after locking", async () => {
    envMock.enabled = true;
    db.$queryRaw.mockResolvedValue([]);
    db.providerAccount.findFirst.mockResolvedValue(null);
    const client = createRouterClient(providerManagementRouter, { context });
    await expect(client.updateAccount({ id: "deleted", label: "changed" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(db.providerAccount.updateMany).not.toHaveBeenCalled();
    expect(db.providerAuditEvent.create).not.toHaveBeenCalled();
  });

  it("conditionally updates a live account and emits exactly one audit", async () => {
    envMock.enabled = true;
    db.providerAccount.findFirst
      .mockResolvedValueOnce({
        id: "account",
        userId: "owner",
        authType: "BEARER",
        baseUrl: "https://old.example",
        providerType: "openai",
      })
      .mockResolvedValueOnce({ id: "account", label: "changed" });
    db.providerAccount.updateMany.mockResolvedValue({ count: 1 });
    db.providerAuditEvent.create.mockResolvedValue({ id: "audit" });
    const client = createRouterClient(providerManagementRouter, { context });
    await expect(client.updateAccount({ id: "account", label: "changed" })).resolves.toEqual({
      id: "account",
      label: "changed",
    });
    expect(db.providerAccount.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "account", userId: "owner", deletedAt: null } }),
    );
    expect(db.providerAuditEvent.create).toHaveBeenCalledOnce();
  });

  it("rejects a literal private provider URL with a stable reason", async () => {
    envMock.enabled = true;
    const client = createRouterClient(providerManagementRouter, { context });
    await expect(
      client.createAccount({
        providerType: "openai",
        label: "Loopback",
        baseUrl: "https://127.0.0.1/v1",
        authType: "BEARER",
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      data: { reason: "PROVIDER_PRIVATE_NETWORK_REJECTED" },
    });
    expect(db.providerAccount.create).not.toHaveBeenCalled();

    await expect(
      client.updateAccount({ id: "account", baseUrl: "https://10.0.0.8/v1" }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      data: { reason: "PROVIDER_PRIVATE_NETWORK_REJECTED" },
    });
    expect(db.providerAccount.updateMany).not.toHaveBeenCalled();
  });

  it("fails closed for unknown provider types on account create and update", async () => {
    envMock.enabled = true;
    const client = createRouterClient(providerManagementRouter, { context });
    await expect(
      client.createAccount({
        providerType: "unknown-provider",
        label: "Unknown",
        baseUrl: "https://provider.example",
        authType: "BEARER",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.providerAccount.create).not.toHaveBeenCalled();

    db.providerAccount.findFirst.mockResolvedValue({
      id: "account",
      userId: "owner",
      providerType: "openai",
      authType: "BEARER",
      baseUrl: "https://provider.example",
    });
    await expect(
      client.updateAccount({ id: "account", providerType: "unknown-provider" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.providerAccount.updateMany).not.toHaveBeenCalled();
  });

  it("locks the account and rejects a provider-type change conflicting with any model", async () => {
    envMock.enabled = true;
    db.providerAccount.findFirst.mockResolvedValue({
      id: "account",
      userId: "owner",
      providerType: "openai",
      authType: "BEARER",
      baseUrl: "https://provider.example",
    });
    db.providerModel.findMany.mockResolvedValue([
      { id: "without-inventory", nativeCapabilities: null },
      {
        id: "openai-model",
        nativeCapabilities: {
          version: 4,
          protocol: "openai-compatible",
          surfaces: {},
        },
      },
    ]);
    const client = createRouterClient(providerManagementRouter, { context });
    await expect(
      client.updateAccount({ id: "account", providerType: "anthropic-compatible" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expectOwnerFenceThenRowLocks(1);
    expect(db.providerModel.findMany).toHaveBeenCalledWith({
      where: { userId: "owner", providerAccountId: "account", deletedAt: null },
      select: { id: true, nativeCapabilities: true },
    });
    expect(db.providerAccount.updateMany).not.toHaveBeenCalled();
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
      maxWait: 5_000,
      timeout: 10_000,
    });
  });

  it("allows an alias-only provider-type change after validating every model", async () => {
    envMock.enabled = true;
    db.providerAccount.findFirst
      .mockResolvedValueOnce({
        id: "account",
        userId: "owner",
        providerType: "openai",
        authType: "BEARER",
        baseUrl: "https://provider.example",
      })
      .mockResolvedValueOnce({ id: "account", providerType: "openai-compatible" });
    db.providerModel.findMany.mockResolvedValue([
      { id: "without-inventory", nativeCapabilities: null },
      {
        id: "openai-model",
        nativeCapabilities: {
          version: 4,
          protocol: "openai-compatible",
          surfaces: {},
        },
      },
    ]);
    db.providerAccount.updateMany.mockResolvedValue({ count: 1 });
    db.providerAuditEvent.create.mockResolvedValue({ id: "audit" });
    const client = createRouterClient(providerManagementRouter, { context });
    await expect(
      client.updateAccount({ id: "account", providerType: "openai-compatible" }),
    ).resolves.toMatchObject({ providerType: "openai-compatible" });
    expect(db.providerModel.findMany).toHaveBeenCalledOnce();
    expect(db.providerAccount.updateMany).toHaveBeenCalledOnce();
  });

  it("enables an owned account only with active credentials and enabled models", async () => {
    envMock.enabled = true;
    db.providerAccount.findFirst
      .mockResolvedValueOnce({
        id: "account",
        currentCredentialId: "credential",
        enabled: false,
      })
      .mockResolvedValueOnce({ id: "account", enabled: true, status: "ACTIVE" });
    db.providerCredential.findFirst.mockResolvedValue({ id: "credential" });
    db.providerModel.count.mockResolvedValue(1);
    db.providerAccount.updateMany.mockResolvedValue({ count: 1 });
    db.providerAuditEvent.create.mockResolvedValue({ id: "audit" });
    const client = createRouterClient(providerManagementRouter, { context });
    await expect(client.setAccountEnabled({ id: "account", enabled: true })).resolves.toEqual({
      id: "account",
      enabled: true,
      status: "ACTIVE",
    });
    expect(db.providerCredential.findFirst).toHaveBeenCalledWith({
      where: {
        id: "credential",
        userId: "owner",
        providerAccountId: "account",
        status: "ACTIVE",
      },
      select: { id: true },
    });
    expect(db.providerAuditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ metadata: { enabled: true } }),
    });
  });

  it("returns exact per-currency totals and stable report cursors", async () => {
    envMock.enabled = true;
    const createdAt = new Date("2026-08-25T00:00:00Z");
    db.providerUsageLedger.findMany.mockResolvedValue([
      { id: "b", createdAt },
      { id: "a", createdAt },
    ]);
    db.providerUsageLedger.groupBy.mockResolvedValue([
      { currency: "EUR", _sum: { settledCost: "1.25" }, _count: { _all: 2 } },
      { currency: "USD", _sum: { settledCost: "3.5" }, _count: { _all: 4 } },
    ]);
    db.providerUsageLedger.count.mockResolvedValue(3);
    const client = createRouterClient(providerManagementRouter, { context });
    await expect(client.listUsageReportPage({ limit: 1 })).resolves.toEqual({
      items: [{ id: "b", createdAt }],
      nextCursor: { id: "b", createdAt },
    });
    await expect(client.getUsageTotals({ limit: 50 })).resolves.toEqual({
      totals: [
        { currency: "EUR", settledCost: "1.25", rowCount: 2, from: null, to: null },
        { currency: "USD", settledCost: "3.5", rowCount: 4, from: null, to: null },
      ],
      excludedRowCount: 3,
    });
    expect(db.providerUsageLedger.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "owner" }, take: 2 }),
    );
    expect(db.providerUsageLedger.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: "owner",
          costKnown: true,
          currency: { not: null },
          settledCost: { not: null },
        },
      }),
    );
    expect(db.providerUsageLedger.count).toHaveBeenCalledWith({
      where: {
        userId: "owner",
        OR: [{ costKnown: false }, { currency: null }, { settledCost: null }],
      },
    });
  });

  it("reports stale and unreconciled attempts without credential material", async () => {
    envMock.enabled = true;
    db.providerAttempt.findMany.mockResolvedValue([
      {
        id: "attempt-row",
        createdAt: new Date("2026-08-24T00:00:00Z"),
        attemptId: "attempt",
        fencingToken: 2n,
        state: "ACTIVE",
        expiresAt: new Date("2026-08-24T00:01:00Z"),
      },
    ]);
    db.providerUsageLedger.groupBy.mockResolvedValue([
      { attemptId: "attempt", fencingToken: 1n, _count: { _all: 1 } },
    ]);
    const client = createRouterClient(providerManagementRouter, { context });
    const result = await client.listProviderAttempts({ limit: 10 });
    expect(result.items[0]).toMatchObject({ stale: true, reconciliationStatus: "PENDING" });
    expect(db.providerAttempt.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "owner" },
        select: expect.not.objectContaining({ credentialId: true }),
      }),
    );
    expect(db.providerUsageLedger.groupBy).toHaveBeenCalledWith({
      by: ["attemptId", "fencingToken"],
      where: { userId: "owner", OR: [{ attemptId: "attempt", fencingToken: 2n }] },
      _count: { _all: true },
    });
  });

  it("runs server-owned repair only for the authenticated account and audits the result", async () => {
    envMock.enabled = true;
    db.providerAccount.findFirst.mockResolvedValue({ id: "account", userId: "owner" });
    db.providerAuditEvent.create.mockResolvedValue({ id: "audit" });
    const repair = vi.fn().mockResolvedValue(2);
    const client = createRouterClient(providerManagementRouter, {
      context: { session, services: { repairExpiredProviderBudgets: repair } },
    });
    await expect(client.repairExpiredAttempts({ providerAccountId: "account" })).resolves.toEqual({
      repaired: 2,
    });
    expect(repair).toHaveBeenCalledWith({ userId: "owner", providerAccountId: "account" });
    expect(db.providerAuditEvent.create).toHaveBeenCalledWith({
      data: {
        userId: "owner",
        providerAccountId: "account",
        action: "ACCOUNTING_REPAIR_REQUESTED",
        subjectId: "account",
      },
    });
  });

  it("fails closed when the server repair service is unavailable", async () => {
    envMock.enabled = true;
    db.providerAccount.findFirst.mockResolvedValue({ id: "account", userId: "owner" });
    const client = createRouterClient(providerManagementRouter, { context });
    await expect(
      client.repairExpiredAttempts({ providerAccountId: "account" }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(db.providerAuditEvent.create).not.toHaveBeenCalled();
  });

  it("does not invoke repair for a missing or cross-owner account", async () => {
    envMock.enabled = true;
    db.providerAccount.findFirst.mockResolvedValue(null);
    const repair = vi.fn();
    const client = createRouterClient(providerManagementRouter, {
      context: { session, services: { repairExpiredProviderBudgets: repair } },
    });
    await expect(
      client.repairExpiredAttempts({ providerAccountId: "foreign-account" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Not found" });
    expect(repair).not.toHaveBeenCalled();
    expect(db.providerAuditEvent.create).not.toHaveBeenCalled();
  });

  it("locks account then model and audits deleteModel exactly once", async () => {
    envMock.enabled = true;
    db.providerModel.findFirst.mockResolvedValue({
      id: "model",
      userId: "owner",
      providerAccountId: "account",
      deletedAt: null,
    });
    db.providerModel.updateMany.mockResolvedValue({ count: 1 });
    db.providerAuditEvent.create.mockResolvedValue({ id: "audit" });
    const client = createRouterClient(providerManagementRouter, { context });
    await expect(client.deleteModel({ id: "model" })).resolves.toEqual({ success: true });
    expectOwnerFenceThenRowLocks(2);
    expect(db.providerModel.updateMany).toHaveBeenCalledWith({
      where: {
        id: "model",
        userId: "owner",
        providerAccountId: "account",
        deletedAt: null,
      },
      data: { deletedAt: expect.any(Date), enabled: false },
    });
    expect(db.providerAuditEvent.create).toHaveBeenCalledOnce();
  });

  it("does not duplicate deleteModel writes or audits after deletion", async () => {
    envMock.enabled = true;
    db.providerModel.findFirst.mockResolvedValue(null);
    const client = createRouterClient(providerManagementRouter, { context });
    await expect(client.deleteModel({ id: "model" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.providerModel.updateMany).not.toHaveBeenCalled();
    expect(db.providerAuditEvent.create).not.toHaveBeenCalled();
  });

  it("serializes credential revocation against replacement and remains idempotent", async () => {
    envMock.enabled = true;
    db.providerCredential.findFirst.mockResolvedValue({
      id: "credential",
      userId: "owner",
      providerAccountId: "account",
      status: "REVOKED",
      ProviderAccount: { deletedAt: null },
    });
    db.providerCredential.updateMany.mockResolvedValue({ count: 0 });
    const client = createRouterClient(providerManagementRouter, { context });
    await expect(client.revokeCredential({ id: "credential" })).resolves.toEqual({ success: true });
    expectOwnerFenceThenRowLocks(2);
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
    });
    expect(db.providerAuditEvent.create).not.toHaveBeenCalled();
    expect(db.providerAccount.updateMany).not.toHaveBeenCalled();
  });

  it.each(["REVOKED", "REPLACED"] as const)(
    "refuses rotation when a concurrent operation has made the credential %s",
    async (status) => {
      envMock.enabled = true;
      db.providerCredential.findFirst
        .mockResolvedValueOnce({ id: "credential", providerAccountId: "account" })
        // Locked re-read: a status-aware row store matching the real
        // database, so THIS run's terminal status is the row's own state —
        // the read only yields the row while it still satisfies the query's
        // ACTIVE filter (which the assertion below pins). Returning the row
        // unconditionally would let the product proceed and blow up on the
        // missing ciphertext, i.e. a false NOT_FOUND.
        .mockImplementationOnce(async ({ where }: { where: { status?: string } }) =>
          where.status === "ACTIVE"
            ? null
            : { id: "credential", providerAccountId: "account", status },
        );
      db.$queryRaw.mockResolvedValue([{ id: "locked" }]);
      const client = createRouterClient(providerManagementRouter, { context });
      await expect(client.rotateCredential({ id: "credential" })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      // Status-specific handling: the locked re-read demands ACTIVE, so a
      // REVOKED or REPLACED row is refused without any write.
      expect(db.providerCredential.findFirst).toHaveBeenLastCalledWith({
        where: {
          id: "credential",
          userId: "owner",
          status: "ACTIVE",
          ProviderAccount: { deletedAt: null, currentCredentialId: "credential" },
        },
      });
      expectOwnerFenceThenRowLocks(2);
      expect(db.providerCredential.updateMany).not.toHaveBeenCalled();
      expect(db.providerAuditEvent.create).not.toHaveBeenCalled();
    },
  );

  it("hides budget policies owned by soft-deleted provider accounts", async () => {
    envMock.enabled = true;
    db.providerBudgetPolicy.findMany.mockResolvedValue([]);
    const client = createRouterClient(providerManagementRouter, { context });
    await expect(client.listBudgetPolicies()).resolves.toEqual([]);
    expect(db.providerBudgetPolicy.findMany).toHaveBeenCalledWith({
      where: { userId: "owner", ProviderAccount: { deletedAt: null } },
      include: { Rules: true },
    });
  });

  it("audits successful and failed credential tests without secrets or endpoint data", async () => {
    envMock.enabled = true;
    const { encryptProviderCredential, parseProviderCredentialKeyring } = await import(
      "../lib/provider-credential-crypto"
    );
    const identity = {
      userId: "owner",
      providerAccountId: "account",
      credentialId: "credential",
      credentialType: "BEARER" as const,
      aadVersion: 1,
    };
    const encrypted = encryptProviderCredential(
      "super-secret-value",
      identity,
      parseProviderCredentialKeyring("v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="),
    );
    db.providerAccount.findFirst.mockResolvedValue({
      id: "account",
      userId: "owner",
      deletedAt: null,
      currentCredentialId: "credential",
      providerType: "openai",
      baseUrl: "https://provider.example/v1",
    });
    db.providerCredential.findFirst.mockResolvedValue({
      id: "credential",
      providerAccountId: "account",
      credentialType: "BEARER",
      aadVersion: 1,
      status: "ACTIVE",
      ...encrypted,
    });
    db.providerCredential.updateMany.mockResolvedValue({ count: 1 });
    db.providerAuditEvent.create.mockResolvedValue({ id: "audit" });
    egressMock.request.mockResolvedValue({ statusCode: 204, resume: vi.fn() });
    const client = createRouterClient(providerManagementRouter, { context });
    await expect(client.testCredential({ providerAccountId: "account" })).resolves.toEqual({
      ok: true,
      outcome: "SUCCESS",
      statusCode: 204,
      reason: null,
    });
    const audit = db.providerAuditEvent.create.mock.calls.at(-1)?.[0];
    expect(audit.data).toMatchObject({
      action: "CREDENTIAL_TESTED",
      subjectId: "credential",
      metadata: { outcome: "SUCCESS", statusCode: 204 },
    });
    expect(JSON.stringify(audit)).not.toContain("super-secret-value");
    expect(JSON.stringify(audit)).not.toContain("provider.example");
    // An OpenAI account stored with the old `/v1` default probes `/v1/models`
    // once, not `/v1/v1/models` or the API root.
    expect(egressMock.request).toHaveBeenLastCalledWith(
      "https://provider.example/v1/models",
      { method: "GET", headers: { accept: "application/json" } },
      expect.objectContaining({ egressEnabled: true }),
      "openai",
      { type: "BEARER", token: "super-secret-value" },
    );

    db.providerAccount.findFirst.mockResolvedValue({
      id: "account",
      userId: "owner",
      deletedAt: null,
      currentCredentialId: "credential",
      providerType: "anthropic",
      baseUrl: "https://provider.example",
    });
    await expect(client.testCredential({ providerAccountId: "account" })).resolves.toMatchObject({
      ok: true,
    });
    expect(egressMock.request).toHaveBeenLastCalledWith(
      "https://provider.example/v1/models",
      {
        method: "GET",
        headers: { accept: "application/json", "anthropic-version": "2023-06-01" },
      },
      expect.objectContaining({ egressEnabled: true }),
      "anthropic",
      { type: "BEARER", token: "super-secret-value" },
    );

    for (const [providerType, protocol] of [
      ["openai-compatible", "openai"],
      ["anthropic-compatible", "anthropic"],
    ] as const) {
      db.providerAccount.findFirst.mockResolvedValue({
        id: "account",
        userId: "owner",
        deletedAt: null,
        currentCredentialId: "credential",
        providerType,
        baseUrl: "https://provider.example/v1",
      });
      // A 2xx from a compatible gateway's model list cannot prove the key
      // was checked: inconclusive, never a pass.
      await expect(client.testCredential({ providerAccountId: "account" })).resolves.toEqual({
        ok: false,
        outcome: "INCONCLUSIVE",
        reason: "UNVERIFIED",
        statusCode: 204,
      });
      expect(egressMock.request).toHaveBeenLastCalledWith(
        "https://provider.example/v1/models",
        {
          method: "GET",
          headers:
            protocol === "anthropic"
              ? { accept: "application/json", "anthropic-version": "2023-06-01" }
              : { accept: "application/json" },
        },
        expect.objectContaining({ egressEnabled: true }),
        protocol,
        { type: "BEARER", token: "super-secret-value" },
      );
      expect(db.providerAuditEvent.create.mock.calls.at(-1)?.[0].data.metadata).toEqual({
        outcome: "INCONCLUSIVE",
        statusCode: 204,
        reason: "UNVERIFIED",
      });
    }

    db.providerAccount.findFirst.mockResolvedValue({
      id: "account",
      userId: "owner",
      deletedAt: null,
      currentCredentialId: "credential",
      providerType: "unknown-provider",
      baseUrl: "https://provider.example/v1",
    });
    egressMock.request.mockClear();
    await expect(client.testCredential({ providerAccountId: "account" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(egressMock.request).not.toHaveBeenCalled();

    db.providerAccount.findFirst.mockResolvedValue({
      id: "account",
      userId: "owner",
      deletedAt: null,
      currentCredentialId: "credential",
      providerType: "openai",
      baseUrl: "https://provider.example/v1",
    });
    egressMock.request.mockRejectedValueOnce(new Error("provider.example super-secret-value"));
    await expect(client.testCredential({ providerAccountId: "account" })).rejects.toMatchObject({
      code: "BAD_GATEWAY",
      message: "Provider request failed",
    });
    const failedAudit = db.providerAuditEvent.create.mock.calls.at(-1)?.[0];
    expect(failedAudit.data.metadata).toEqual({
      outcome: "FAILURE",
      statusCode: null,
      reason: "REQUEST_FAILED",
    });
    expect(JSON.stringify(failedAudit)).not.toContain("super-secret-value");
    expect(JSON.stringify(failedAudit)).not.toContain("provider.example");
  });

  it("records a successful test exactly once when revocation wins during egress", async () => {
    envMock.enabled = true;
    const { encryptProviderCredential, parseProviderCredentialKeyring } = await import(
      "../lib/provider-credential-crypto"
    );
    const encrypted = encryptProviderCredential(
      "concurrent-secret",
      {
        userId: "owner",
        providerAccountId: "account",
        credentialId: "credential",
        credentialType: "BEARER",
        aadVersion: 1,
      },
      parseProviderCredentialKeyring("v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="),
    );
    db.providerAccount.findFirst.mockResolvedValue({
      id: "account",
      userId: "owner",
      deletedAt: null,
      currentCredentialId: "credential",
      providerType: "openai",
      baseUrl: "https://provider.example/v1",
    });
    db.providerCredential.findFirst.mockResolvedValue({
      id: "credential",
      providerAccountId: "account",
      credentialType: "BEARER",
      aadVersion: 1,
      status: "ACTIVE",
      ...encrypted,
    });
    // The request selected an active credential, but revokeCredential committed
    // before the post-egress transaction acquired its lifecycle locks.
    db.providerCredential.updateMany.mockResolvedValue({ count: 0 });
    db.providerAuditEvent.create.mockResolvedValue({ id: "audit" });
    egressMock.request.mockResolvedValue({ statusCode: 204, resume: vi.fn() });

    const client = createRouterClient(providerManagementRouter, { context });
    await expect(client.testCredential({ providerAccountId: "account" })).resolves.toEqual({
      ok: true,
      outcome: "SUCCESS",
      statusCode: 204,
      reason: null,
    });

    expectOwnerFenceThenRowLocks(2);
    expect(db.providerCredential.updateMany).toHaveBeenCalledWith({
      where: { id: "credential", userId: "owner", status: "ACTIVE" },
      data: { lastUsedAt: expect.any(Date) },
    });
    expect(db.providerAuditEvent.create).toHaveBeenCalledOnce();
    expect(db.providerAuditEvent.create).toHaveBeenCalledWith({
      data: {
        userId: "owner",
        providerAccountId: "account",
        action: "CREDENTIAL_TESTED",
        subjectId: "credential",
        metadata: { outcome: "SUCCESS", statusCode: 204 },
      },
    });
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
      maxWait: 5_000,
      timeout: 10_000,
    });
  });

  describe("updateModel capability impact advisory", () => {
    // The advisory is computed with the shared prisma client AFTER the
    // updateModel transaction commits (the tx mock passes `db` as the
    // client), so these mocks target bare-prisma reads, not tx-scoped ones.
    const chatInventory = {
      version: 3 as const,
      protocol: "openai-compatible" as const,
      surfaces: {
        openaiChatCompletions: {
          source: "dashboard" as const,
          confidence: "exact" as const,
          supported: true,
          streaming: true,
        },
      },
    };

    function primeUpdateModel() {
      db.$queryRaw.mockResolvedValue([]);
      db.providerModel.findFirst.mockResolvedValue({ id: "model", providerAccountId: "account" });
      db.providerAccount.findFirst.mockResolvedValue({ id: "account", providerType: "openai" });
      db.providerModel.update.mockResolvedValue({ id: "model" });
      db.providerAuditEvent.create.mockResolvedValue({ id: "audit" });
    }

    function mockImpactMembers(rows: Array<Record<string, unknown>>) {
      db.poolMember.findMany.mockImplementation(
        async ({ where }: { where?: { poolId?: { in?: string[] } } } = {}) =>
          where?.poolId ? rows : [{ poolId: "pool-p" }],
      );
    }

    it("succeeds non-blocking and reports pools the post-edit inventory cannot serve", async () => {
      envMock.enabled = true;
      primeUpdateModel();
      db.modelPool.findMany.mockResolvedValue([
        {
          id: "pool-p",
          slug: "prov",
          recommendedSurfaceOverride: "OPENAI_RESPONSES",
          protocolAdaptationEnabled: false,
        },
      ]);
      // Post-edit member state: the provider member serves chat only.
      mockImpactMembers([
        {
          id: "m-p",
          poolId: "pool-p",
          tier: "PRIMARY",
          discoveredModelId: null,
          DiscoveredModel: null,
          ExecutionTarget: {
            DiscoveredModel: null,
            ProviderModel: { nativeCapabilities: chatInventory },
          },
        },
      ]);
      const client = createRouterClient(providerManagementRouter, { context });

      const result = await client.updateModel({ id: "model", nativeCapabilities: chatInventory });
      expect(db.providerModel.update).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        id: "model",
        impactedPools: [{ id: "pool-p", slug: "prov", surface: "OPENAI_RESPONSES" }],
      });
    });

    it("reports a non-responses violated surface such as ANTHROPIC_MESSAGES", async () => {
      envMock.enabled = true;
      primeUpdateModel();
      db.modelPool.findMany.mockResolvedValue([
        {
          id: "pool-c",
          slug: "anthro",
          recommendedSurfaceOverride: "ANTHROPIC_MESSAGES",
          protocolAdaptationEnabled: false,
        },
      ]);
      // Post-edit member state: the provider member serves chat only, and a
      // stored anthropic-messages override with adaptation off is unservable.
      mockImpactMembers([
        {
          id: "m-c",
          poolId: "pool-c",
          tier: "PRIMARY",
          discoveredModelId: null,
          DiscoveredModel: null,
          ExecutionTarget: {
            DiscoveredModel: null,
            ProviderModel: { nativeCapabilities: chatInventory },
          },
        },
      ]);
      const client = createRouterClient(providerManagementRouter, { context });

      const result = await client.updateModel({ id: "model", nativeCapabilities: chatInventory });
      expect(result).toMatchObject({
        impactedPools: [{ id: "pool-c", slug: "anthro", surface: "ANTHROPIC_MESSAGES" }],
      });
    });

    it("returns an empty advisory when the impacted pool stays servable", async () => {
      envMock.enabled = true;
      primeUpdateModel();
      db.modelPool.findMany.mockResolvedValue([
        {
          id: "pool-p",
          slug: "prov",
          recommendedSurfaceOverride: "OPENAI_CHAT_COMPLETIONS",
          protocolAdaptationEnabled: false,
        },
      ]);
      mockImpactMembers([
        {
          id: "m-p",
          poolId: "pool-p",
          tier: "PRIMARY",
          discoveredModelId: null,
          DiscoveredModel: null,
          ExecutionTarget: {
            DiscoveredModel: null,
            ProviderModel: { nativeCapabilities: chatInventory },
          },
        },
      ]);
      const client = createRouterClient(providerManagementRouter, { context });

      await expect(
        client.updateModel({ id: "model", nativeCapabilities: chatInventory }),
      ).resolves.toMatchObject({ impactedPools: [] });
    });

    it("omits the advisory entirely when nativeCapabilities is not edited", async () => {
      envMock.enabled = true;
      primeUpdateModel();
      const client = createRouterClient(providerManagementRouter, { context });

      const result = await client.updateModel({ id: "model", enabled: true });
      expect(db.poolMember.findMany).not.toHaveBeenCalled();
      expect(result).toEqual({ id: "model" });
    });
  });

  it("G1: an aborted caller signal prevents the external HTTPS probe and the audit transaction", async () => {
    envMock.enabled = true;
    const { encryptProviderCredential, parseProviderCredentialKeyring } = await import(
      "../lib/provider-credential-crypto"
    );
    const encrypted = encryptProviderCredential(
      "aborted-caller-secret",
      {
        userId: "owner",
        providerAccountId: "account",
        credentialId: "credential",
        credentialType: "BEARER",
        aadVersion: 1,
      },
      parseProviderCredentialKeyring("v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="),
    );
    db.providerAccount.findFirst.mockResolvedValue({
      id: "account",
      userId: "owner",
      deletedAt: null,
      currentCredentialId: "credential",
      providerType: "openai",
      baseUrl: "https://provider.example/v1",
    });
    db.providerCredential.findFirst.mockResolvedValue({
      id: "credential",
      providerAccountId: "account",
      credentialType: "BEARER",
      aadVersion: 1,
      status: "ACTIVE",
      ...encrypted,
    });
    const controller = new AbortController();
    controller.abort();
    const client = createRouterClient(providerManagementRouter, {
      context: { ...context, services: { signal: controller.signal } },
    });
    await expect(client.testCredential({ providerAccountId: "account" })).rejects.toMatchObject({
      code: "CLIENT_CLOSED_REQUEST",
    });
    // The cost-incurring external request NEVER started, and neither did
    // the audit write transaction.
    expect(egressMock.request).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.providerAuditEvent.create).not.toHaveBeenCalled();
  });
});

// All pricing mutations must acquire their FK parents before touching pricing
// rows. Recording writes as well as SELECT locks catches the implicit audit /
// pricing FK inversions, including create's database-dependent RI trigger order.
describe("provider pricing writer lock order", () => {
  const trace: string[] = [];
  let missingParent: "account" | "model" | null = null;
  let pricingFenceError: Error | null = null;
  const ownerFence = "fences 00:owner:owner";
  const pricingFences = "fences 00:owner:owner 05:provider-pricing:owner:model";
  const pricing = {
    id: "price",
    providerAccountId: "account",
    providerModelId: "model",
    version: "v1",
    effectiveAt: new Date("2026-01-01T00:00:00Z"),
    pricing: { ratesPerMillion: { input: "1", output: "2" } },
  };
  const client = createRouterClient(providerManagementRouter, { context });
  const writers = [
    [
      "create",
      () =>
        client.createPricingVersion({
          providerModelId: "model",
          version: "v1",
          currency: "USD",
          accountingVersion: "provider-billable-v1",
          confidence: "CALCULATED",
          ratesPerMillion: { input: "1", output: "2" },
          chargeRules: CATALOG_CHARGE_RULES,
          effectiveAt: pricing.effectiveAt,
        }),
    ],
    ["update", () => client.updatePricingVersion({ id: "price", currency: "EUR" })],
    ["activate", () => client.activatePricingVersion({ id: "price" })],
    ["retire", () => client.retirePricingVersion({ id: "price" })],
    ["delete", () => client.deletePricingVersion({ id: "price" })],
  ] as const;

  beforeEach(() => {
    vi.resetAllMocks();
    envMock.enabled = true;
    trace.length = 0;
    db.$transaction.mockImplementation(async (callback: (tx: typeof db) => unknown) =>
      callback(db),
    );
    missingParent = null;
    pricingFenceError = null;
    db.$queryRaw.mockImplementation(async (sql: TemplateStringsArray, ...values: unknown[]) => {
      if (sql.join("?").includes("wsmp_acquire_fences")) {
        const names = values[0] as string[];
        if (pricingFenceError && names.some((name) => name.startsWith("05:")))
          throw pricingFenceError;
        trace.push(`fences ${names.join(" ")}`);
        return [{ acquired: true }];
      }
      expect(values).toContain("owner");
      const table = sql.join("?").match(/FROM (provider_\w+)/u)?.[1];
      expect(sql.join("?")).toContain(
        table === "provider_account" ? "FOR UPDATE" : "FOR NO KEY UPDATE",
      );
      trace.push(String(table));
      if (missingParent === "account" && table === "provider_account") return [];
      if (missingParent === "model" && table === "provider_model") return [];
      return [{ id: table === "provider_account" ? "account" : "model" }];
    });
    // Every advisory lock goes through wsmp_acquire_fences ($queryRaw).
    db.$executeRaw.mockImplementation(async () => {
      trace.push("executeRaw");
      return 1;
    });
    db.providerModel.findFirst.mockResolvedValue({ id: "model", providerAccountId: "account" });
    db.providerPricingVersion.findFirst.mockResolvedValue(pricing);
    db.providerPricingVersion.findMany.mockResolvedValue([]);
    for (const method of ["create", "update", "updateMany", "delete"] as const) {
      db.providerPricingVersion[method].mockImplementation(async () => {
        trace.push(`pricing.${method}`);
        return pricing;
      });
    }
    for (const mock of [db.providerModel.update, db.providerModel.updateMany]) {
      mock.mockImplementation(async () => {
        trace.push("model.write");
        return { count: 1 };
      });
    }
    db.providerAuditEvent.create.mockImplementation(async () => {
      trace.push("audit.insert");
      return { id: "audit" };
    });
  });

  it.each(writers)(
    "%s takes the owner and pricing fences, then account and model, before pricing and audit writes",
    async (_name, write) => {
      await write();
      // Writer class M: the owner fence first, then the pricing fence (the
      // owner fence is already held and skipped), then the account row and
      // the model row.
      expect(trace.slice(0, 4)).toEqual([
        ownerFence,
        pricingFences,
        "provider_account",
        "provider_model",
      ]);
      expect(trace[4]).toMatch(/^pricing\./u);
      expect(trace).not.toContain("executeRaw");
      expect(trace.at(-1)).toBe("audit.insert");
      expect(trace.filter((entry) => entry === "audit.insert")).toHaveLength(1);
      expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: "Serializable",
        maxWait: 5_000,
        timeout: 10_000,
      });
    },
  );

  it.each(writers)(
    "%s refuses an absent or foreign pricing graph before locking",
    async (_name, write) => {
      db.providerModel.findFirst.mockResolvedValue(null);
      db.providerPricingVersion.findFirst.mockResolvedValue(null);
      await expect(write()).rejects.toMatchObject({ code: "NOT_FOUND" });
      // Only the owner fence: no pricing fence, no row lock.
      expect(trace).toEqual([ownerFence]);
    },
  );

  for (const missing of ["account", "model"] as const) {
    it.each(writers)(
      `%s refuses a missing/deleted ${missing} under its lock`,
      async (_name, write) => {
        missingParent = missing;
        await expect(write()).rejects.toMatchObject({ code: "NOT_FOUND" });
        expect(db.providerAuditEvent.create).not.toHaveBeenCalled();
        expect(trace.some((entry) => entry.startsWith("pricing."))).toBe(false);
      },
    );
  }

  it.each(writers)(
    "%s stops on a pricing-fence timeout before any row lock, pricing or audit write",
    async (_name, write) => {
      const timeout = new Error("lock timeout");
      pricingFenceError = timeout;
      await expect(write()).rejects.toThrow(timeout);
      expect(trace).toEqual([ownerFence]);
      expect(db.providerAuditEvent.create).not.toHaveBeenCalled();
    },
  );

  it("locks the model even when scheduled activation does not update its pointer", async () => {
    db.providerPricingVersion.findFirst.mockResolvedValue({
      ...pricing,
      effectiveAt: new Date(Date.now() + 60_000),
    });
    await client.activatePricingVersion({ id: "price" });
    expect(trace.slice(0, 4)).toEqual([
      ownerFence,
      pricingFences,
      "provider_account",
      "provider_model",
    ]);
    expect(db.providerModel.update).not.toHaveBeenCalled();
    expect(trace.at(-1)).toBe("audit.insert");
  });
});
