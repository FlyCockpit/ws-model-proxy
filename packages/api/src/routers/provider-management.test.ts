import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createRouterClient } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { Session } from "@ws-model-proxy/auth";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../context";

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
  executionTarget: { create: MockInstance };
  modelPool: { findFirst: MockInstance };
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
const context: Context = { session };

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
  return createORPCClient(link) as ReturnType<
    typeof createRouterClient<typeof providerManagementRouter>
  >;
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

  it("is hidden by default for authenticated callers and still requires authentication", async () => {
    const client = createRouterClient(providerManagementRouter, { context });
    await expect(client.listAccounts()).rejects.toMatchObject({ code: "NOT_FOUND" });
    const anonymous = createRouterClient(providerManagementRouter, { context: { session: null } });
    await expect(anonymous.listAccounts()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(db.providerAccount.findMany).not.toHaveBeenCalled();
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
    const client = createORPCClient(link) as ReturnType<
      typeof createRouterClient<typeof providerManagementRouter>
    >;
    await expect(client.listAccounts()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.providerAccount.findMany).not.toHaveBeenCalled();
  });

  it("enforces authentication through the HTTP RPC transport when provider egress is enabled", async () => {
    envMock.enabled = true;
    const handler = new RPCHandler(providerManagementRouter);
    const link = new RPCLink({
      url: "https://example.test/rpc",
      fetch: async (request, init) => {
        const result = await handler.handle(new Request(request, init), {
          prefix: "/rpc",
          context: { session: null },
        });
        if (!result.matched) return new Response(null, { status: 404 });
        return result.response;
      },
    });
    const client = createORPCClient(link) as ReturnType<
      typeof createRouterClient<typeof providerManagementRouter>
    >;
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
    const client = createORPCClient(link) as ReturnType<
      typeof createRouterClient<typeof providerManagementRouter>
    >;
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
    expect(db.$queryRaw).toHaveBeenCalledOnce();
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
    expect(db.$queryRaw).toHaveBeenCalledOnce();
    expect(db.providerModel.update).not.toHaveBeenCalled();
    expect(db.providerAccount.findFirst).not.toHaveBeenCalled();
  });

  it("creates owner-scoped draft pricing with explicit accounting rules and audit", async () => {
    envMock.enabled = true;
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
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
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
    });
    db.providerCredential.count.mockResolvedValue(1);
    const client = createRouterClient(providerManagementRouter, { context });
    await expect(
      client.updateAccount({ id: "account", authType: "API_KEY" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(db.$queryRaw).toHaveBeenCalledOnce();
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
    expect(db.$queryRaw).toHaveBeenCalledTimes(2);
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
    expect(db.$queryRaw).toHaveBeenCalledTimes(2);
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
    });
    expect(db.providerAuditEvent.create).not.toHaveBeenCalled();
    expect(db.providerAccount.updateMany).not.toHaveBeenCalled();
  });

  it.each(["REVOKED", "REPLACED"])(
    "refuses rotation when a concurrent operation has made the credential %s",
    async () => {
      envMock.enabled = true;
      db.providerCredential.findFirst
        .mockResolvedValueOnce({ id: "credential", providerAccountId: "account" })
        .mockResolvedValueOnce(null);
      db.$queryRaw.mockResolvedValue([{ id: "locked" }]);
      const client = createRouterClient(providerManagementRouter, { context });
      await expect(client.rotateCredential({ id: "credential" })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      expect(db.$queryRaw).toHaveBeenCalledTimes(2);
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
      statusCode: 204,
    });
    const audit = db.providerAuditEvent.create.mock.calls.at(-1)?.[0];
    expect(audit.data).toMatchObject({
      action: "CREDENTIAL_TESTED",
      subjectId: "credential",
      metadata: { outcome: "SUCCESS", statusCode: 204 },
    });
    expect(JSON.stringify(audit)).not.toContain("super-secret-value");
    expect(JSON.stringify(audit)).not.toContain("provider.example");
    expect(egressMock.request).toHaveBeenLastCalledWith(
      "https://provider.example/v1",
      { method: "GET", headers: { accept: "application/json" } },
      expect.objectContaining({ egressEnabled: true }),
      "openai",
      { type: "BEARER", token: "super-secret-value" },
    );

    egressMock.request.mockRejectedValueOnce(new Error("provider.example super-secret-value"));
    await expect(client.testCredential({ providerAccountId: "account" })).rejects.toMatchObject({
      code: "BAD_GATEWAY",
      message: "Provider request failed",
    });
    const failedAudit = db.providerAuditEvent.create.mock.calls.at(-1)?.[0];
    expect(failedAudit.data.metadata).toEqual({ outcome: "FAILURE", statusCode: null });
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
      statusCode: 204,
    });

    expect(db.$queryRaw).toHaveBeenCalledTimes(2);
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
});
