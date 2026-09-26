import { createRouterClient } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../context";
import { catalogEntry } from "../lib/fixtures/openrouter-catalog";

const envMock = vi.hoisted(() => ({ enabled: true }));
vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    get WMP_PUBLIC_PROVIDER_EGRESS_ENABLED() {
      return envMock.enabled;
    },
    WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS: false,
  },
}));
vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep(), Prisma: {} };
});

const { createProviderCatalogRouter } = await import("./provider-catalog");
const { parseCatalog } = await import("../lib/provider-catalog-model");
const { default: prisma } = await import("@ws-model-proxy/db");
type ProviderCatalogResult = Awaited<
  ReturnType<import("../lib/provider-catalog").ProviderCatalog["get"]>
>;

const db = prisma as unknown as {
  $transaction: MockInstance;
  $queryRaw: MockInstance;
  $executeRaw: MockInstance;
  providerAccount: { findFirst: MockInstance };
  providerModel: { findFirst: MockInstance; create: MockInstance; update: MockInstance };
  providerPricingVersion: {
    findMany: MockInstance;
    updateMany: MockInstance;
    create: MockInstance;
  };
  providerAuditEvent: { create: MockInstance };
  executionTarget: { create: MockInstance; findUnique: MockInstance };
  modelPool: { findFirst: MockInstance; updateMany: MockInstance };
};

function session(userId: string) {
  return {
    user: {
      id: userId,
      email: `${userId}@example.com`,
      name: userId,
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
      id: `s-${userId}`,
      userId,
      token: "token",
      expiresAt: new Date(Date.now() + 60_000),
      ipAddress: null,
      userAgent: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  } as Session;
}
const context: Context = { session: session("owner") };

const models = parseCatalog({
  data: [
    catalogEntry(),
    catalogEntry({
      id: "vendor/no-tools",
      name: "No Tools",
      supported_parameters: [],
      context_length: 8_000,
    }),
    catalogEntry({
      id: "vendor/image-only",
      name: "Image Only",
      architecture: { input_modalities: ["text"], output_modalities: ["image"] },
    }),
    catalogEntry({
      id: "openrouter/auto",
      name: "Auto",
      pricing: { prompt: "-1", completion: "-1" },
    }),
  ],
});
const fetchedAt = new Date("2026-09-26T12:00:00Z");
let catalogResult: ProviderCatalogResult;
const catalog = { get: vi.fn(async () => catalogResult), reset: vi.fn() };

function client(ctx: Context = context) {
  return createRouterClient(createProviderCatalogRouter(catalog), { context: ctx });
}

beforeEach(() => {
  vi.clearAllMocks();
  envMock.enabled = true;
  catalogResult = { status: "ok", models, fetchedAt, stale: false };
  db.$transaction.mockImplementation(async (callback: (tx: typeof db) => unknown) => callback(db));
});

describe("providerCatalog.search", () => {
  it("requires a signed-in user", async () => {
    await expect(client({ session: null }).search({})).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(catalog.get).not.toHaveBeenCalled();
  });

  it("returns a stable disabled reason and makes no pool lookup or fetch when the switch is off", async () => {
    envMock.enabled = false;
    const expected = {
      status: "disabled",
      reason: "EXTERNAL_PROVIDERS_DISABLED",
      items: [],
      nextCursor: null,
      total: 0,
    };
    await expect(client().search({ query: "qwen" })).resolves.toEqual(expected);
    await expect(client().search({ poolId: "someone-elses-pool" })).resolves.toEqual(expected);
    expect(catalog.get).not.toHaveBeenCalled();
    expect(db.modelPool.findFirst).not.toHaveBeenCalled();
  });

  it("returns trimmed rows with pool-independent verdicts and pages with a cursor", async () => {
    const first = await client().search({ limit: 2 });
    expect(first).toMatchObject({ status: "ok", stale: false, total: 4, nextCursor: 2 });
    expect(first.items[0]).toEqual({
      id: "qwen/qwen3-coder",
      name: "Qwen: Qwen3 Coder",
      contextLength: 262_144,
      maxCompletionTokens: 65_536,
      pricing: {
        prompt: "0.0000002",
        completion: "0.0000008",
        cacheRead: "0.00000002",
        cacheWrite: null,
        variable: false,
      },
      supportsTools: true,
      supportsReasoning: true,
      inputModalities: ["text"],
      outputModalities: ["text"],
      expirationDate: null,
      moderated: false,
      free: false,
      compatibility: { verdict: "ok", block: [], warn: [] },
    });
    const second = await client().search({ limit: 2, cursor: 2 });
    expect(second.items.map((row) => row.id)).toEqual(["vendor/image-only", "openrouter/auto"]);
    expect(second.items[0]?.compatibility.verdict).toBe("block");
    expect(second.items[1]?.compatibility.warn).toEqual(["UNKNOWN_PRICE"]);
    expect(second.nextCursor).toBeNull();
  });

  it("filters by query and capabilities", async () => {
    const result = await client().search({ query: "vendor", filters: { tools: true } });
    expect(result.items.map((row) => row.id)).toEqual(["vendor/image-only"]);
  });

  it("rejects a limit above 50", async () => {
    await expect(client().search({ limit: 51 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("computes verdicts against a pool the caller can see (owner or grantee)", async () => {
    db.modelPool.findFirst.mockResolvedValue({
      capacityContextCeiling: null,
      PoolMembers: [
        {
          DiscoveredModel: null,
          ExecutionTarget: {
            DiscoveredModel: null,
            ProviderModel: {
              contextWindow: 131_072,
              nativeCapabilities: {
                version: 4,
                protocol: "openai-compatible",
                surfaces: {
                  openaiChatCompletions: {
                    source: "dashboard",
                    confidence: "exact",
                    operations: ["create"],
                    tools: true,
                  },
                },
              },
            },
            InferenceCapacity: null,
          },
        },
      ],
    });
    const result = await client(context).search({ poolId: "pool-1", query: "no-tools" });
    expect(result.items[0]?.compatibility).toEqual({
      verdict: "warn",
      block: [],
      warn: ["NO_TOOLS", "SMALLER_CONTEXT"],
    });
    expect(db.modelPool.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "pool-1",
          OR: [{ userId: "owner" }, { PoolGrants: { some: { granteeUserId: "owner" } } }],
        },
      }),
    );
  });

  it("answers NOT_FOUND identically for a missing or invisible pool, before any fetch", async () => {
    db.modelPool.findFirst.mockResolvedValue(null);
    const error = await client(context)
      .search({ poolId: "pool-x" })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "NOT_FOUND", message: "Not found" });
    expect(catalog.get).not.toHaveBeenCalled();
  });

  it("reports an unavailable catalog without throwing", async () => {
    catalogResult = { status: "unavailable", reason: "CATALOG_UNAVAILABLE" };
    await expect(client().search({})).resolves.toMatchObject({
      status: "unavailable",
      reason: "CATALOG_UNAVAILABLE",
      items: [],
    });
  });

  it("marks stale results", async () => {
    catalogResult = { status: "ok", models, fetchedAt, stale: true };
    await expect(client().search({})).resolves.toMatchObject({ status: "ok", stale: true });
  });
});

describe("providerCatalog.importModel", () => {
  const account = { id: "acct-1", providerType: "openrouter" };
  beforeEach(() => {
    db.providerAccount.findFirst.mockResolvedValue(account);
    db.providerModel.findFirst.mockImplementation(async (args: { select?: object }) =>
      args.select && "upstreamModelId" in args.select
        ? {
            id: "pm-1",
            providerAccountId: "acct-1",
            upstreamModelId: "qwen/qwen3-coder",
            displayName: "Qwen: Qwen3 Coder",
            contextWindow: 262_144,
            maxOutputTokens: 65_536,
            pricingVersion: "v",
            enabled: false,
          }
        : null,
    );
    db.providerModel.create.mockResolvedValue({ id: "pm-1" });
    db.providerPricingVersion.findMany.mockResolvedValue([]);
    db.providerPricingVersion.create.mockImplementation(
      async (args: { data: { version: string } }) => ({
        id: "price-1",
        version: args.data.version,
      }),
    );
  });

  it("is hidden when the switch is off", async () => {
    envMock.enabled = false;
    await expect(
      client().importModel({ providerAccountId: "acct-1", modelId: "qwen/qwen3-coder" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(catalog.get).not.toHaveBeenCalled();
  });

  it("cannot import into another user's account, and no fetch happens", async () => {
    db.providerAccount.findFirst.mockResolvedValue(null);
    await expect(
      client(context).importModel({
        providerAccountId: "someone-else",
        modelId: "qwen/qwen3-coder",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.providerAccount.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "someone-else", userId: "owner", deletedAt: null } }),
    );
    expect(catalog.get).not.toHaveBeenCalled();
    expect(db.providerModel.create).not.toHaveBeenCalled();
  });

  it("creates the model, its execution target, audit events and an ACTIVE catalog price", async () => {
    const result = await client().importModel({
      providerAccountId: "acct-1",
      modelId: "qwen/qwen3-coder",
    });
    expect(result).toMatchObject({
      created: true,
      restored: false,
      pricing: "created",
      contextWindowDrift: null,
      compatibility: { verdict: "ok" },
    });
    expect(db.$queryRaw).toHaveBeenCalled();
    expect(db.providerModel.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "owner",
        providerAccountId: "acct-1",
        upstreamModelId: "qwen/qwen3-coder",
        displayName: "Qwen: Qwen3 Coder",
        contextWindow: 262_144,
        maxOutputTokens: 65_536,
        enabled: false,
        nativeCapabilities: expect.objectContaining({
          version: 4,
          surfaces: { openaiChatCompletions: expect.objectContaining({ tools: true }) },
        }),
      }),
      select: { id: true },
    });
    expect(db.executionTarget.create).toHaveBeenCalledWith({
      data: { userId: "owner", kind: "PROVIDER_MODEL", providerModelId: "pm-1" },
    });
    expect(db.providerPricingVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "owner",
        providerAccountId: "acct-1",
        providerModelId: "pm-1",
        currency: "USD",
        status: "ACTIVE",
        confidence: "ESTIMATED",
        pricing: {
          ratesPerMillion: {
            input: "0.2",
            output: "0.8",
            cacheRead: "0.02",
            cacheWrite: "0.2",
            reasoning: "0.8",
          },
        },
        chargeRules: expect.objectContaining({ unknownCategories: "FAIL_CLOSED" }),
      }),
      select: { id: true, version: true },
    });
    expect(db.providerModel.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "pm-1" },
        data: expect.objectContaining({ pricingVersion: expect.stringMatching(/^openrouter-/u) }),
      }),
    );
    const actions = db.providerAuditEvent.create.mock.calls.map(
      ([args]: [{ data: { action: string; metadata: unknown } }]) => [
        args.data.action,
        args.data.metadata,
      ],
    );
    expect(actions).toEqual([
      ["MODEL_CREATED", { source: "OPENROUTER_CATALOG", catalogModelId: "qwen/qwen3-coder" }],
      [
        "PRICING_ACTIVATED",
        expect.objectContaining({
          source: "OPENROUTER_CATALOG",
          catalogModelId: "qwen/qwen3-coder",
        }),
      ],
    ]);
  });

  it("is idempotent: re-importing identical catalog data writes nothing", async () => {
    const first = await client().importModel({
      providerAccountId: "acct-1",
      modelId: "qwen/qwen3-coder",
    });
    expect(first.created).toBe(true);
    const createdModel = db.providerModel.create.mock.calls[0]?.[0].data;
    const createdPrice = db.providerPricingVersion.create.mock.calls[0]?.[0].data;
    vi.clearAllMocks();
    db.$transaction.mockImplementation(async (callback: (tx: typeof db) => unknown) =>
      callback(db),
    );
    db.providerAccount.findFirst.mockResolvedValue(account);
    // Postgres jsonb reorders keys; the comparison must not depend on order.
    const reversed = (value: object) =>
      JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(value).reverse())));
    db.providerModel.findFirst.mockImplementation(async (args: { select?: object }) => {
      if (args.select && "deletedAt" in args.select)
        return {
          deletedAt: null,
          displayName: createdModel.displayName,
          nativeCapabilities: reversed(createdModel.nativeCapabilities),
          contextWindow: createdModel.contextWindow,
          maxOutputTokens: createdModel.maxOutputTokens,
        };
      if (args.select && "upstreamModelId" in args.select) return { id: "pm-1" };
      return { id: "pm-1" };
    });
    db.executionTarget.findUnique.mockResolvedValue({ id: "et-1" });
    db.providerPricingVersion.findMany.mockResolvedValue([
      {
        id: "price-1",
        currency: "USD",
        accountingVersion: "provider-billable-v1",
        pricing: { ratesPerMillion: reversed(createdPrice.pricing.ratesPerMillion) },
        chargeRules: reversed(createdPrice.chargeRules),
        effectiveAt: new Date(Date.now() - 1_000),
      },
    ]);
    const again = await client().importModel({
      providerAccountId: "acct-1",
      modelId: "qwen/qwen3-coder",
    });
    expect(again).toMatchObject({ created: false, restored: false, pricing: "unchanged" });
    expect(db.providerModel.create).not.toHaveBeenCalled();
    expect(db.providerModel.update).not.toHaveBeenCalled();
    expect(db.executionTarget.create).not.toHaveBeenCalled();
    expect(db.providerPricingVersion.create).not.toHaveBeenCalled();
    expect(db.providerPricingVersion.updateMany).not.toHaveBeenCalled();
    expect(db.providerAuditEvent.create).not.toHaveBeenCalled();
  });

  it("retires the old ACTIVE version when the catalog price changed", async () => {
    db.providerModel.findFirst.mockImplementation(async (args: { select?: object }) =>
      args.select && "deletedAt" in args.select
        ? {
            deletedAt: null,
            displayName: "Qwen: Qwen3 Coder",
            nativeCapabilities: null,
            contextWindow: 131_072,
            maxOutputTokens: 65_536,
          }
        : { id: "pm-1" },
    );
    db.executionTarget.findUnique.mockResolvedValue(null);
    db.providerPricingVersion.findMany.mockResolvedValue([
      {
        id: "price-0",
        currency: "USD",
        accountingVersion: "provider-billable-v1",
        pricing: { ratesPerMillion: { input: "1", output: "2" } },
        chargeRules: {},
        effectiveAt: new Date(Date.now() - 60_000),
      },
    ]);
    const result = await client().importModel({
      providerAccountId: "acct-1",
      modelId: "qwen/qwen3-coder",
    });
    expect(result).toMatchObject({
      created: false,
      pricing: "created",
      // Context feeds capacity policy: reported, never silently rewritten.
      contextWindowDrift: { current: 131_072, catalog: 262_144 },
    });
    expect(db.providerPricingVersion.updateMany).toHaveBeenCalledWith({
      where: { userId: "owner", providerModelId: "pm-1", status: "ACTIVE" },
      data: { status: "RETIRED", retiredAt: expect.any(Date) },
    });
    expect(db.providerModel.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ contextWindow: expect.anything() }),
      }),
    );
    // A missing execution target (and so capacity) is created for the runtime.
    expect(db.executionTarget.create).toHaveBeenCalledWith({
      data: { userId: "owner", kind: "PROVIDER_MODEL", providerModelId: "pm-1" },
    });
  });

  it("never overrides a future-dated ACTIVE price the user scheduled", async () => {
    db.providerModel.findFirst.mockImplementation(async (args: { select?: object }) =>
      args.select && "deletedAt" in args.select ? null : { id: "pm-1" },
    );
    db.providerModel.findFirst.mockResolvedValueOnce(null);
    db.providerPricingVersion.findMany.mockResolvedValue([
      {
        id: "future",
        currency: "USD",
        accountingVersion: "provider-billable-v1",
        pricing: {},
        chargeRules: {},
        effectiveAt: new Date(Date.now() + 86_400_000),
      },
    ]);
    const result = await client().importModel({
      providerAccountId: "acct-1",
      modelId: "qwen/qwen3-coder",
    });
    expect(result.pricing).toBe("scheduledPricingExists");
    expect(db.providerPricingVersion.create).not.toHaveBeenCalled();
    expect(db.providerPricingVersion.updateMany).not.toHaveBeenCalled();
  });

  it("restores a soft-deleted model disabled", async () => {
    db.providerModel.findFirst.mockImplementation(async (args: { select?: object }) =>
      args.select && "deletedAt" in args.select
        ? {
            deletedAt: new Date(),
            displayName: "Qwen: Qwen3 Coder",
            nativeCapabilities: null,
            contextWindow: 262_144,
            maxOutputTokens: 65_536,
          }
        : { id: "pm-1" },
    );
    db.executionTarget.findUnique.mockResolvedValue({ id: "et-1" });
    const result = await client().importModel({
      providerAccountId: "acct-1",
      modelId: "qwen/qwen3-coder",
    });
    expect(result.restored).toBe(true);
    expect(db.providerModel.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ deletedAt: null, enabled: false }),
      }),
    );
  });

  it("skips pricing for a variable-price model", async () => {
    const result = await client().importModel({
      providerAccountId: "acct-1",
      modelId: "openrouter/auto",
    });
    expect(result.pricing).toBe("unknown");
    expect(db.providerPricingVersion.create).not.toHaveBeenCalled();
  });

  it("rejects a blocked model, an unknown model, and a non-OpenRouter account", async () => {
    await expect(
      client().importModel({ providerAccountId: "acct-1", modelId: "vendor/image-only" }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      data: { reason: "CATALOG_MODEL_INCOMPATIBLE" },
    });
    await expect(
      client().importModel({ providerAccountId: "acct-1", modelId: "vendor/missing" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", data: { reason: "CATALOG_MODEL_NOT_FOUND" } });
    db.providerAccount.findFirst.mockResolvedValue({ id: "acct-1", providerType: "openai" });
    await expect(
      client().importModel({ providerAccountId: "acct-1", modelId: "qwen/qwen3-coder" }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      data: { reason: "CATALOG_ACCOUNT_NOT_OPENROUTER" },
    });
    expect(db.providerModel.create).not.toHaveBeenCalled();
  });

  it("fails with SERVICE_UNAVAILABLE when the catalog cannot be fetched", async () => {
    catalogResult = { status: "unavailable", reason: "CATALOG_UNAVAILABLE" };
    await expect(
      client().importModel({ providerAccountId: "acct-1", modelId: "qwen/qwen3-coder" }),
    ).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      data: { reason: "CATALOG_UNAVAILABLE" },
    });
  });
});

describe("providerCatalog pool external equivalent", () => {
  it("reads only the caller's own pool", async () => {
    db.modelPool.findFirst.mockResolvedValue(null);
    await expect(client().getPoolExternalEquivalent({ poolId: "p" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(db.modelPool.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "p", userId: "owner" } }),
    );
    db.modelPool.findFirst.mockResolvedValue({ externalEquivalentModel: "qwen/qwen3-coder" });
    envMock.enabled = false;
    await expect(client().getPoolExternalEquivalent({ poolId: "p" })).resolves.toEqual({
      externalEquivalentModel: "qwen/qwen3-coder",
      providerEgressEnabled: false,
    });
  });

  it("rejects a grantee or stranger before any fetch", async () => {
    db.modelPool.findFirst.mockResolvedValue(null);
    await expect(
      client({ session: session("grantee") }).setPoolExternalEquivalent({
        poolId: "p",
        modelId: "qwen/qwen3-coder",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(catalog.get).not.toHaveBeenCalled();
    expect(db.modelPool.updateMany).not.toHaveBeenCalled();
  });

  it("sets a catalog model with pool verdicts", async () => {
    db.modelPool.findFirst
      .mockResolvedValueOnce({ id: "p" })
      .mockResolvedValueOnce({ capacityContextCeiling: 100_000, PoolMembers: [] });
    db.modelPool.updateMany.mockResolvedValue({ count: 1 });
    await expect(
      client().setPoolExternalEquivalent({ poolId: "p", modelId: "vendor/no-tools" }),
    ).resolves.toEqual({
      externalEquivalentModel: "vendor/no-tools",
      compatibility: { verdict: "warn", block: [], warn: ["SMALLER_CONTEXT"] },
    });
    expect(db.modelPool.updateMany).toHaveBeenCalledWith({
      where: { id: "p", userId: "owner" },
      data: { externalEquivalentModel: "vendor/no-tools" },
    });
  });

  it("always allows clearing, even with the switch off, without a fetch", async () => {
    envMock.enabled = false;
    db.modelPool.findFirst.mockResolvedValue({ id: "p" });
    db.modelPool.updateMany.mockResolvedValue({ count: 1 });
    await expect(
      client().setPoolExternalEquivalent({ poolId: "p", modelId: null }),
    ).resolves.toEqual({ externalEquivalentModel: null, compatibility: null });
    expect(catalog.get).not.toHaveBeenCalled();
  });

  it("refuses to set a model when disabled, missing, blocked or malformed", async () => {
    db.modelPool.findFirst.mockResolvedValue({ id: "p" });
    catalogResult = { status: "disabled", reason: "EXTERNAL_PROVIDERS_DISABLED" };
    await expect(
      client().setPoolExternalEquivalent({ poolId: "p", modelId: "qwen/qwen3-coder" }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      data: { reason: "EXTERNAL_PROVIDERS_DISABLED" },
    });
    catalogResult = { status: "ok", models, fetchedAt, stale: false };
    await expect(
      client().setPoolExternalEquivalent({ poolId: "p", modelId: "vendor/missing" }),
    ).rejects.toMatchObject({ data: { reason: "CATALOG_MODEL_NOT_FOUND" } });
    await expect(
      client().setPoolExternalEquivalent({ poolId: "p", modelId: "vendor/image-only" }),
    ).rejects.toMatchObject({ data: { reason: "CATALOG_MODEL_INCOMPATIBLE" } });
    await expect(
      client().setPoolExternalEquivalent({ poolId: "p", modelId: "not a slug" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.modelPool.updateMany).not.toHaveBeenCalled();
  });
});
